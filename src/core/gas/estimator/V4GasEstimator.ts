import {ChainId} from '../../../lib/config';
import {GasDetails} from '../../../models/gas/GasDetails';
import {JsonRpcProvider} from '@ethersproject/providers';
import {BigNumber} from '@ethersproject/bignumber';
import {QuoteBasic} from '../../../models/quote/QuoteBasic';
import {V3GasEstimator} from './V3GasEstimator';
import {IFreshPoolDetailsWrapper} from '../../../stores/pool/FreshPoolDetailsWrapper';
import {aggHookGasCalibrationAdjustment} from '../aggHookGasCalibration';
import {getGasToken} from '../../../lib/tokenUtils';
import {CurrencyAmount} from '@uniswap/sdk-core';

export class V4GasEstimator extends V3GasEstimator {
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
    aggHookGasCalibrationEnabled = false
  ) {
    super(rpcProviderMap, freshPoolDetailsWrapper);
    this.AGG_HOOK_GAS_CALIBRATION_ENABLED = aggHookGasCalibrationEnabled;
  }

  public async estimateRouteGas(
    quote: QuoteBasic,
    chainId: ChainId,
    gasPriceWei: number
  ): Promise<GasDetails> {
    const baseGasDetails = await super.estimateRouteGas(
      quote,
      chainId,
      gasPriceWei
    );

    if (!this.AGG_HOOK_GAS_CALIBRATION_ENABLED) {
      return baseGasDetails;
    }

    const adjustment = aggHookGasCalibrationAdjustment(
      quote.route.path,
      chainId
    );
    if (adjustment === 0n) {
      return baseGasDetails;
    }

    // Add the adjustment to gas use and recompute downstream cost
    // fields so the GasDetails stays internally consistent.
    const adjustedGasUse = baseGasDetails.gasUse + adjustment;
    const adjustedGasCostWei = BigNumber.from(gasPriceWei).mul(
      BigNumber.from(adjustedGasUse.toString())
    );
    const wrappedCurrency = getGasToken(chainId);
    const adjustedGasCostNative = CurrencyAmount.fromRawAmount(
      wrappedCurrency,
      adjustedGasCostWei.toString()
    );

    return new GasDetails(
      baseGasDetails.gasPriceInWei,
      BigInt(adjustedGasCostWei.toString()),
      Number(adjustedGasCostNative.toExact()),
      adjustedGasUse,
      baseGasDetails.gasCostInQuoteToken,
      baseGasDetails.gasCostInUSD
    );
  }
}
