import {
  gasRegimeForChain,
  V2_BASE_SWAP_COST,
  V2_COST_PER_EXTRA_HOP,
} from '../gas-costs';
import {IChainFeatures} from '@uniswap/lib-chain-features';
import {ChainId} from '../../../lib/config';
import {CurrencyAmount} from '@uniswap/sdk-core';
import {getGasToken} from '../../../lib/tokenUtils';
import {GasDetails} from '../../../models/gas/GasDetails';
import {JsonRpcProvider} from '@ethersproject/providers';
import {QuoteBasic} from '../../../models/quote/QuoteBasic';
import {BaseGasEstimator} from './BaseGasEstimator';
import {IFreshPoolDetailsWrapper} from '../../../stores/pool/FreshPoolDetailsWrapper';

export class V2GasEstimator extends BaseGasEstimator {
  constructor(
    protected readonly rpcProviderMap: Map<ChainId, JsonRpcProvider>,
    protected readonly freshPoolDetailsWrapper: IFreshPoolDetailsWrapper,
    protected readonly chainFeatures: IChainFeatures
  ) {
    super(rpcProviderMap, freshPoolDetailsWrapper);
  }

  public async estimateRouteGas(
    quote: QuoteBasic,
    chainId: ChainId,
    gasPriceWei: number
  ): Promise<GasDetails> {
    const regime = gasRegimeForChain(chainId, this.chainFeatures);
    const hops = quote.route.path.length;

    const gasUse = BigInt(
      V2_BASE_SWAP_COST(regime)
        .add(V2_COST_PER_EXTRA_HOP(regime).mul(hops - 1))
        .toString()
    );
    const totalGasCostWei = BigInt(gasPriceWei) * gasUse;
    const weth = getGasToken(chainId);
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
