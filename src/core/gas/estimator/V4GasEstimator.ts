import {ChainId} from '../../../lib/config';
import {GasDetails} from '../../../models/gas/GasDetails';
import {JsonRpcProvider} from '@ethersproject/providers';
import {BigNumber} from '@ethersproject/bignumber';
import {QuoteBasic} from '../../../models/quote/QuoteBasic';
import {V3GasEstimator} from './V3GasEstimator';
import {IFreshPoolDetailsWrapper} from '../../../stores/pool/FreshPoolDetailsWrapper';
import {
  aggHookGasCalibrationAdjustment,
  aggHookQuoterGasFallback,
} from '../aggHookGasCalibration';
import {getGasToken} from '../../../lib/tokenUtils';
import {CurrencyAmount} from '@uniswap/sdk-core';
import {TOKEN_OVERHEAD} from '../gas-costs';

export class V4GasEstimator extends V3GasEstimator {
  /**
   * Kill-switch for using the V4Quoter view-call return value as the
   * base gas use instead of the V3-style heuristic inherited from
   * `super.estimateRouteGas`.
   *
   * The V4Quoter return (~250k for FluidDexT1 routes, ~162k for no-
   * hook V4 routes) is materially closer to production transaction
   * gas than the heuristic (~97k for single-hop V4). It is also the
   * baseline the per-protocol agg-hook calibration constants
   * (`aggHookGasCalibration.ts`) were measured against — applying
   * the calibration on top of the heuristic instead leaves a
   * material under-correction (see PR #8587 review feedback).
   *
   * When this flag and `AGG_HOOK_GAS_CALIBRATION_ENABLED` are both
   * true, the V4 route's gas use is `quoterGas + calibration`, which
   * matches simulator-vs-quoter trace deltas to within the
   * universal-router coordination overhead (~160k) that is the same
   * for all V4 routes and therefore cancels in V4-vs-V4 comparisons.
   *
   * Quotes from `fetchAggHookQuotes` (the direct hook-ABI path) ship
   * without a `v3QuoterResponseDetails.gasEstimate`, so this path
   * falls back to the per-protocol `aggHookQuoterGasFallback` table
   * to keep the kill-switch effective on the actual production
   * agg-hook routes. See `aggHookGasCalibration.ts` for the
   * derivation of those constants.
   *
   * Default false; prod reads via env var
   * `V4_USE_QUOTER_GAS_AS_BASE` wired in `dependencies.ts`.
   */
  private readonly V4_USE_QUOTER_GAS_AS_BASE: boolean;

  /**
   * Kill-switch for the per-agg-hook-protocol gas calibration. Same
   * mechanism as `MixedGasEstimator.AGG_HOOK_GAS_CALIBRATION_ENABLED`
   * — pure-V4 routes that hop through registered agg-hook pools get
   * a calibrated post-quoter adjustment for the hook's router-side
   * overhead. See `aggHookGasCalibration.ts` for constants + source.
   */
  private readonly AGG_HOOK_GAS_CALIBRATION_ENABLED: boolean;

  constructor(
    protected readonly rpcProviderMap: Map<ChainId, JsonRpcProvider>,
    protected readonly freshPoolDetailsWrapper: IFreshPoolDetailsWrapper,
    aggHookGasCalibrationEnabled = false,
    v4UseQuoterGasAsBase = false
  ) {
    super(rpcProviderMap, freshPoolDetailsWrapper);
    this.AGG_HOOK_GAS_CALIBRATION_ENABLED = aggHookGasCalibrationEnabled;
    this.V4_USE_QUOTER_GAS_AS_BASE = v4UseQuoterGasAsBase;
  }

  public async estimateRouteGas(
    quote: QuoteBasic,
    chainId: ChainId,
    gasPriceWei: number
  ): Promise<GasDetails> {
    // Determine the base gas use when the quoter-base kill-switch is
    // on. Priority order:
    //   1. `V3QuoterResponseDetails.gasEstimate` — present on quotes
    //      routed through `OnChainQuoteFetcher.fetchV4Quote` (single
    //      V4Quoter view call for the whole route).
    //   2. Per-protocol agg-hook fallback — used when the quote came
    //      from `fetchAggHookQuotes`, which calls the hook ABI
    //      directly and does not populate `gasEstimate`. Without
    //      this fallback the kill-switch is silently a no-op on the
    //      actual production agg-hook routes.
    //   3. Fall back to the inherited V3 heuristic (today's
    //      behavior) for any path that produces a V4 quote with
    //      neither a quoter `gasEstimate` nor a registered agg hook
    //      (e.g. SDK-quoted V4, cached routes that lost the quoter
    //      detail).
    //
    // On the quoter-base path we still need to add `TOKEN_OVERHEAD`
    // to stay consistent with the heuristic — V3 routes that go
    // through the heuristic include the AAVE/LDO 150k mainnet
    // adjustment, so a V4 quote of a route containing those tokens
    // must include it too or the gas-adjusted comparison unfairly
    // favors V4 routes that touch expensive tokens.
    const quoterGas = quote.v3QuoterResponseDetails?.gasEstimate;
    let quoterBase: bigint | undefined;
    if (this.V4_USE_QUOTER_GAS_AS_BASE) {
      if (quoterGas !== undefined && quoterGas > 0n) {
        quoterBase = quoterGas;
      } else {
        const fallback = aggHookQuoterGasFallback(quote.route.path, chainId);
        if (fallback > 0n) {
          quoterBase = fallback;
        }
      }
    }

    if (quoterBase !== undefined) {
      const tokenOverhead = TOKEN_OVERHEAD(chainId, quote.route);
      const calibration = this.AGG_HOOK_GAS_CALIBRATION_ENABLED
        ? aggHookGasCalibrationAdjustment(quote.route.path, chainId)
        : 0n;
      const gasUse =
        quoterBase + BigInt(tokenOverhead.toString()) + calibration;
      return this.buildGasDetails(gasUse, gasPriceWei, chainId);
    }

    // Heuristic path — current behavior. Calibration still composes
    // on top when enabled (preserves the legacy PR #8587 behavior
    // for the no-quoter-base case).
    const heuristicGasDetails = await super.estimateRouteGas(
      quote,
      chainId,
      gasPriceWei
    );

    const calibration = this.AGG_HOOK_GAS_CALIBRATION_ENABLED
      ? aggHookGasCalibrationAdjustment(quote.route.path, chainId)
      : 0n;

    if (calibration === 0n) {
      return heuristicGasDetails;
    }

    return this.buildGasDetails(
      heuristicGasDetails.gasUse + calibration,
      gasPriceWei,
      chainId,
      heuristicGasDetails.gasCostInQuoteToken,
      heuristicGasDetails.gasCostInUSD
    );
  }

  private buildGasDetails(
    gasUse: bigint,
    gasPriceWei: number,
    chainId: ChainId,
    gasCostInQuoteToken?: bigint,
    gasCostInUSD?: number
  ): GasDetails {
    const gasCostWei = BigNumber.from(gasPriceWei).mul(
      BigNumber.from(gasUse.toString())
    );
    const wrappedCurrency = getGasToken(chainId);
    const gasCostNative = CurrencyAmount.fromRawAmount(
      wrappedCurrency,
      gasCostWei.toString()
    );
    return new GasDetails(
      BigInt(gasPriceWei),
      BigInt(gasCostWei.toString()),
      Number(gasCostNative.toExact()),
      gasUse,
      gasCostInQuoteToken,
      gasCostInUSD
    );
  }
}
