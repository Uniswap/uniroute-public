import {IGasEstimator} from './IGasEstimator';
import {GasDetails} from '../../../models/gas/GasDetails';
import {ChainId, IUniRouteServiceConfig} from '../../../lib/config';
import {UniProtocol} from '../../../models/pool/UniProtocol';
import {QuoteBasic} from '../../../models/quote/QuoteBasic';
import {JsonRpcProvider} from '@ethersproject/providers';
import {Erc20Token} from '../../../models/token/Erc20Token';
import {Context} from '@uniswap/lib-uni/context';
import {ArbitrumGasData} from '../gas-data-provider';
import {CurrencyInfo} from 'src/models/currency/CurrencyInfo';
import {TradeType} from '../../../models/quote/TradeType';

export interface IGasEstimateProvider {
  estimateGas(
    serviceConfig: IUniRouteServiceConfig,
    tokenInCurrencyInfo: CurrencyInfo,
    tokenOutCurrencyInfo: CurrencyInfo,
    amountIn: bigint,
    chainId: ChainId,
    tokensInfo: Map<string, Erc20Token | null>,
    tradeType: TradeType,
    quote: QuoteBasic,
    ctx: Context,
    gasPriceWei?: number,
    l2GasData?: ArbitrumGasData
  ): Promise<GasDetails>;
  getCurrentGasPrice(chainId: ChainId): Promise<number>;
}

export class GasEstimateProvider implements IGasEstimateProvider {
  constructor(
    private readonly rpcProviderMap: Map<ChainId, JsonRpcProvider>,
    private readonly v2GasEstimator: IGasEstimator,
    private readonly v3GasEstimator: IGasEstimator,
    private readonly v4GasEstimator: IGasEstimator,
    private readonly mixedGasEstimator: IGasEstimator
  ) {}

  public async estimateGas(
    serviceConfig: IUniRouteServiceConfig,
    tokenInCurrencyInfo: CurrencyInfo,
    tokenOutCurrencyInfo: CurrencyInfo,
    amountIn: bigint,
    chainId: ChainId,
    tokensInfo: Map<string, Erc20Token | null>,
    tradeType: TradeType,
    quote: QuoteBasic,
    ctx: Context,
    gasPriceWei?: number,
    l2GasData?: ArbitrumGasData
  ): Promise<GasDetails> {
    if (!serviceConfig.GasEstimation.Enabled) {
      return new GasDetails(0n, 0n, 0, 0n);
    }

    const gasPriceWeiToUse =
      gasPriceWei !== undefined
        ? gasPriceWei
        : await this.getCurrentGasPrice(chainId);
    const provider = this.rpcProviderMap.get(chainId)!;

    switch (quote.route.protocol) {
      case UniProtocol.V2:
        return this.v2GasEstimator.estimateGas(
          serviceConfig,
          tokenInCurrencyInfo,
          tokenOutCurrencyInfo,
          amountIn,
          chainId,
          tokensInfo,
          tradeType,
          quote,
          provider,
          gasPriceWeiToUse,
          ctx,
          l2GasData
        );
      case UniProtocol.V3:
        return this.v3GasEstimator.estimateGas(
          serviceConfig,
          tokenInCurrencyInfo,
          tokenOutCurrencyInfo,
          amountIn,
          chainId,
          tokensInfo,
          tradeType,
          quote,
          provider,
          gasPriceWeiToUse,
          ctx,
          l2GasData
        );
      case UniProtocol.V4:
        return this.v4GasEstimator.estimateGas(
          serviceConfig,
          tokenInCurrencyInfo,
          tokenOutCurrencyInfo,
          amountIn,
          chainId,
          tokensInfo,
          tradeType,
          quote,
          provider,
          gasPriceWeiToUse,
          ctx,
          l2GasData
        );
      case UniProtocol.MIXED:
        return this.mixedGasEstimator.estimateGas(
          serviceConfig,
          tokenInCurrencyInfo,
          tokenOutCurrencyInfo,
          amountIn,
          chainId,
          tokensInfo,
          tradeType,
          quote,
          provider,
          gasPriceWeiToUse,
          ctx,
          l2GasData
        );
      default:
        throw new Error(`Unsupported protocol: ${quote.route.protocol}`);
    }
  }

  public async getCurrentGasPrice(chainId: ChainId): Promise<number> {
    const gasPrice = await this.rpcProviderMap
      .get(chainId)!
      .send('eth_gasPrice', []);
    return parseInt(gasPrice, 16);
  }
}
