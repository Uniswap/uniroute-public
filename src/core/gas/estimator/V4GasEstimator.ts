import {ChainId} from '../../../lib/config';
import {GasDetails} from '../../../models/gas/GasDetails';
import {JsonRpcProvider} from '@ethersproject/providers';
import {QuoteBasic} from '../../../models/quote/QuoteBasic';
import {V3GasEstimator} from './V3GasEstimator';
import {IFreshPoolDetailsWrapper} from '../../../stores/pool/FreshPoolDetailsWrapper';

export class V4GasEstimator extends V3GasEstimator {
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
    // TODO: implement additional gas estimator logic for V4
    return super.estimateRouteGas(quote, chainId, gasPriceWei);
  }
}
