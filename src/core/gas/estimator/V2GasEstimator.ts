import {ChainId} from '../../../lib/config';
import {CurrencyAmount} from '@uniswap/sdk-core';
import {WRAPPED_NATIVE_CURRENCY} from '../../../lib/tokenUtils';
import {GasDetails} from '../../../models/gas/GasDetails';
import {JsonRpcProvider} from '@ethersproject/providers';
import {QuoteBasic} from '../../../models/quote/QuoteBasic';
import {BaseGasEstimator} from './BaseGasEstimator';
import {IFreshPoolDetailsWrapper} from '../../../stores/pool/FreshPoolDetailsWrapper';

export class V2GasEstimator extends BaseGasEstimator {
  // Constant cost for doing any swap regardless of pools.
  protected readonly BASE_SWAP_COST = BigInt(135000);

  // Constant per extra hop in the route.
  protected readonly COST_PER_EXTRA_HOP = BigInt(50000);

  constructor(
    protected readonly rpcProviderMap: Map<ChainId, JsonRpcProvider>,
    protected readonly freshPoolDetailsWrapper: IFreshPoolDetailsWrapper
  ) {
    super(rpcProviderMap, freshPoolDetailsWrapper);
  }

  public async estimateRouteGas(
    quote: QuoteBasic,
    chainId: ChainId,
    gasPriceWei: number
  ): Promise<GasDetails> {
    const hops = quote.route.path.length;

    const gasUse =
      this.BASE_SWAP_COST + this.COST_PER_EXTRA_HOP * BigInt(hops - 1);
    const totalGasCostWei = BigInt(gasPriceWei) * gasUse;
    const weth = WRAPPED_NATIVE_CURRENCY[chainId]!;
    const gasCostInEth = CurrencyAmount.fromRawAmount(
      weth,
      totalGasCostWei.toString()
    );

    return new GasDetails(
      BigInt(gasPriceWei),
      totalGasCostWei,
      Number(gasCostInEth.toExact()),
      gasUse
    );
  }
}
