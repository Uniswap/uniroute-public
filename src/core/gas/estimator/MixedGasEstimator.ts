import {ChainId} from '../../../lib/config';
import {GasDetails} from '../../../models/gas/GasDetails';
import {JsonRpcProvider} from '@ethersproject/providers';
import {BigNumber} from '@ethersproject/bignumber';
import {
  BASE_SWAP_COST,
  COST_PER_HOP,
  COST_PER_INIT_TICK,
  COST_PER_UNINIT_TICK,
  SINGLE_HOP_OVERHEAD,
  TOKEN_OVERHEAD,
} from '../gas-costs';
import {getGasToken} from '../../../lib/tokenUtils';
import {CurrencyAmount} from '@uniswap/sdk-core';
import {QuoteBasic} from '../../../models/quote/QuoteBasic';
import {RouteBasic} from '../../../models/route/RouteBasic';
import {BaseGasEstimator} from './BaseGasEstimator';
import {IFreshPoolDetailsWrapper} from '../../../stores/pool/FreshPoolDetailsWrapper';
import {Protocol} from '../../../models/pool/Protocol';
import {Pool} from '../../../models/pool/Pool';
import {aggHookGasCalibrationAdjustment} from '../aggHookGasCalibration';

// V2-specific constants
const COST_PER_EXTRA_HOP_V2 = BigNumber.from(50000);
const BASE_SWAP_COST_V2 = BigNumber.from(135000);

export class MixedGasEstimator extends BaseGasEstimator {
  /**
   * Kill-switch for the per-agg-hook-protocol gas calibration. When
   * true, the estimator adds `aggHookGasCalibrationAdjustment(...)`
   * to the route's base gas use, correcting V4Quoter's view-call
   * under-estimate of production tx gas for routes that hop through
   * registered agg-hook pools. Default false; prod reads via env
   * var `AGG_HOOK_GAS_CALIBRATION_ENABLED` wired in
   * `dependencies.ts`.
   */
  private readonly AGG_HOOK_GAS_CALIBRATION_ENABLED: boolean;

  /**
   * Kill-switch for using the MixedQuoter view-call return value as
   * the base gas use instead of summing the V3-style heuristic across
   * sections. Mirrors `V4GasEstimator.V4_USE_QUOTER_GAS_AS_BASE` —
   * the agg-hook calibration constants were measured against the
   * quoter's view-call gas, so applying them on top of the heuristic
   * sum leaves a material under-correction.
   *
   * When this flag and `AGG_HOOK_GAS_CALIBRATION_ENABLED` are both
   * true on a mixed route that includes an agg-hook V4 leg, gas use
   * is `mixedQuoterGas + calibration`, matching simulator-vs-quoter
   * deltas to within the universal-router coordination overhead.
   *
   * Default false; prod reads via env var `V4_USE_QUOTER_GAS_AS_BASE`
   * wired in `dependencies.ts`. The shared env var name reflects
   * that this and `V4GasEstimator` should flip in lockstep — agg-hook
   * routes can land as pure-V4 or mixed depending on routing
   * decisions, and the gas baseline must be consistent across both
   * estimators or the comparison shifts in either direction.
   */
  private readonly V4_USE_QUOTER_GAS_AS_BASE: boolean;

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
    // When V4_USE_QUOTER_GAS_AS_BASE is on AND the mixed quote
    // carries a positive `gasEstimate` (from MixedQuoter V1 or V2),
    // use that as the base gas use for the whole route. It already
    // accounts for tick crossings and hook callbacks at the quoter
    // level, so we skip the per-section heuristic and tick math.
    // Falls back to the heuristic path below when the flag is off
    // or the quoter return is missing — preserves today's behavior
    // for SDK-quoted / cached mixed routes that lost the quoter
    // detail. Agg-hook calibration still composes on top regardless
    // of which base was used.
    //
    // We do still add `TOKEN_OVERHEAD` per V3/V4 section on this
    // path: the heuristic adds 150k for mainnet AAVE/LDO transfers,
    // and a mixed route quoted via the V4Quoter base should land at
    // the same total or it would unfairly outscore an otherwise
    // identical V2/V3 route in the gas-adjusted comparison. The
    // MixedQuoter view call exercises the swap, but
    // `TOKEN_OVERHEAD` was tuned as a heuristic correction on top of
    // the heuristic — we carry it forward so the relative ranking
    // with V2/V3 routes stays stable when the flag flips.
    const quoterGas = quote.v3QuoterResponseDetails?.gasEstimate;
    if (
      this.V4_USE_QUOTER_GAS_AS_BASE &&
      quoterGas !== undefined &&
      quoterGas > 0n
    ) {
      const sectionsForOverhead = this.partitionRouteByProtocol(
        quote.route.path
      );
      let tokenOverheadSum = BigNumber.from(0);
      for (const section of sectionsForOverhead) {
        if (section.length === 0) continue;
        const protocol = section[0].protocol;
        if (protocol !== Protocol.V3 && protocol !== Protocol.V4) continue;
        const sectionRoute = new RouteBasic(protocol, section);
        tokenOverheadSum = tokenOverheadSum.add(
          TOKEN_OVERHEAD(chainId, sectionRoute)
        );
      }
      return this.buildGasDetailsWithCalibration(
        quote,
        chainId,
        gasPriceWei,
        BigNumber.from(quoterGas.toString()).add(tokenOverheadSum)
      );
    }

    // Partition the route by protocol sections
    const sections = this.partitionRouteByProtocol(quote.route.path);

    let baseGasUse = BigNumber.from(0);
    let totalInitializedTicksCrossed = 0;

    // Process each section based on its protocol
    sections.forEach(section => {
      if (section.length === 0) return;

      const protocol = section[0].protocol;
      const hops = BigNumber.from(section.length);

      // Prepare variables used in multiple cases
      let hopsGasUse: BigNumber;
      let sectionRoute: RouteBasic<Pool>;
      let tokenOverhead: BigNumber;

      switch (protocol) {
        case Protocol.V2:
          // V2 gas calculation
          baseGasUse = baseGasUse
            .add(COST_PER_EXTRA_HOP_V2.mul(section.length - 1))
            .add(BASE_SWAP_COST_V2);
          break;

        case Protocol.V3:
        case Protocol.V4:
          // V3/V4 gas calculation
          hopsGasUse = COST_PER_HOP(chainId).mul(hops);

          // Add single hop overhead if section is single hop
          if (hops.eq(1)) {
            hopsGasUse = hopsGasUse.add(SINGLE_HOP_OVERHEAD(chainId));
          }

          // Create a route object for the section for token overhead calculation
          sectionRoute = new RouteBasic(protocol, section);

          // Add token overhead for known expensive tokens
          tokenOverhead = TOKEN_OVERHEAD(chainId, sectionRoute);

          // Count initialized ticks crossed for V3 sections
          if (protocol === Protocol.V3) {
            const sectionTicksCrossed =
              this.getInitializedTicksCrossedForSection(
                quote.v3QuoterResponseDetails?.initializedTicksCrossedList ||
                  [],
                section
              );
            totalInitializedTicksCrossed += sectionTicksCrossed;
          }

          baseGasUse = baseGasUse
            .add(hopsGasUse)
            .add(tokenOverhead)
            .add(BASE_SWAP_COST(chainId));
          break;
      }
    });

    // Add tick crossing costs
    const tickGasUse = COST_PER_INIT_TICK(chainId).mul(
      totalInitializedTicksCrossed
    );
    const uninitializedTickGasUse = COST_PER_UNINIT_TICK.mul(0);

    baseGasUse = baseGasUse.add(tickGasUse).add(uninitializedTickGasUse);

    return this.buildGasDetailsWithCalibration(
      quote,
      chainId,
      gasPriceWei,
      baseGasUse
    );
  }

  /**
   * Composes the final `GasDetails` from a base gas use plus the
   * agg-hook calibration when enabled. Shared by both the
   * quoter-return base path and the per-section heuristic path so
   * the calibration semantics stay identical regardless of which
   * baseline was chosen.
   */
  private buildGasDetailsWithCalibration(
    quote: QuoteBasic,
    chainId: ChainId,
    gasPriceWei: number,
    baseGasUseBn: BigNumber
  ): GasDetails {
    let gasUseBn = baseGasUseBn;
    if (this.AGG_HOOK_GAS_CALIBRATION_ENABLED) {
      const adjustment = aggHookGasCalibrationAdjustment(
        quote.route.path,
        chainId
      );
      if (adjustment > 0n) {
        gasUseBn = gasUseBn.add(BigNumber.from(adjustment.toString()));
      }
    }

    const gasCostWei = BigNumber.from(gasPriceWei).mul(gasUseBn);
    const wrappedCurrency = getGasToken(chainId);
    const gasCostNativeCurrency = CurrencyAmount.fromRawAmount(
      wrappedCurrency,
      gasCostWei.toString()
    );

    return new GasDetails(
      BigInt(gasPriceWei),
      BigInt(gasCostWei.toString()),
      Number(gasCostNativeCurrency.toExact()),
      BigInt(gasUseBn.toString())
    );
  }

  private partitionRouteByProtocol(path: Pool[]): Pool[][] {
    if (path.length === 0) return [];

    const sections: Pool[][] = [];
    let currentSection: Pool[] = [path[0]];
    let currentProtocol = path[0].protocol;

    for (let i = 1; i < path.length; i++) {
      if (path[i].protocol === currentProtocol) {
        currentSection.push(path[i]);
      } else {
        sections.push(currentSection);
        currentSection = [path[i]];
        currentProtocol = path[i].protocol;
      }
    }
    sections.push(currentSection);

    return sections;
  }

  private getInitializedTicksCrossedForSection(
    initializedTicksCrossedList: number[],
    section: Pool[]
  ): number {
    let ticksCrossed = 0;
    let v3PoolCount = 0;

    // Count how many V3 pools we've seen before this section
    for (const pool of section) {
      if (pool.protocol === Protocol.V3) {
        // The quoter returns Array<number of calls to crossTick + 1>, so subtract 1
        if (initializedTicksCrossedList[v3PoolCount]) {
          ticksCrossed += Math.max(
            0,
            initializedTicksCrossedList[v3PoolCount]! - 1
          );
        }
        v3PoolCount++;
      }
    }

    return ticksCrossed;
  }
}
