import {GasDetails} from '../../../models/gas/GasDetails';
import {ChainId, IUniRouteServiceConfig} from '../../../lib/config';
import {QuoteBasic} from '../../../models/quote/QuoteBasic';
import {Erc20Token} from '../../../models/token/Erc20Token';
import {BaseProvider} from '@ethersproject/providers';
import {Context} from '@uniswap/lib-uni/context';
import {ArbitrumGasData} from '../gas-data-provider';
import {CurrencyInfo} from '../../../models/currency/CurrencyInfo';
import {TradeType} from '../../../models/quote/TradeType';

// TODO: implement gas estimators
// - fsee SOR implementation of gas estimators:
// - https://github.com/Uniswap/smart-order-router/blob/324386405e979ff209137b7f48e1f1ed558baaa2/src/routers/alpha-router/functions/best-swap-route.ts#L46
export interface IGasEstimator {
  // Estimates total gas (route + l1/l2)
  estimateGas(
    serviceConfig: IUniRouteServiceConfig,
    tokenInCurrencyInfo: CurrencyInfo,
    tokenOutCurrencyInfo: CurrencyInfo,
    amountIn: bigint,
    chainId: ChainId,
    tokensInfo: Map<string, Erc20Token | null>,
    tradeType: TradeType,
    quote: QuoteBasic,
    provider: BaseProvider,
    gasPriceWei: number,
    ctx: Context,
    l2GasData?: ArbitrumGasData
  ): Promise<GasDetails>;

  // Estimates gas for the route only
  estimateRouteGas(
    quote: QuoteBasic,
    chainId: ChainId,
    gasPriceWei: number
  ): Promise<GasDetails>;

  // Estimates L1 and L2 gas costs if applicable (op stack + arbitrum)
  estimateL1L2Gas(
    serviceConfig: IUniRouteServiceConfig,
    tokenInCurrencyInfo: CurrencyInfo,
    tokenOutCurrencyInfo: CurrencyInfo,
    amountIn: bigint,
    chainId: ChainId,
    tokensInfo: Map<string, Erc20Token | null>,
    tradeType: TradeType,
    quote: QuoteBasic,
    provider: BaseProvider,
    gasPriceWei: number,
    ctx: Context,
    l2GasData?: ArbitrumGasData
  ): Promise<GasDetails>;
}

export class NoGasEstimator implements IGasEstimator {
  async estimateGas(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    serviceConfig: IUniRouteServiceConfig,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    tokenInCurrencyInfo: CurrencyInfo,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    tokenOutCurrencyInfo: CurrencyInfo,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    amountIn: bigint,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    chainId: ChainId,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    tokensInfo: Map<string, Erc20Token | null>,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    tradeType: TradeType
  ): Promise<GasDetails> {
    return new GasDetails(BigInt(0), BigInt(0), 0, BigInt(0));
  }

  async estimateRouteGas(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    quote: QuoteBasic,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    chainId: ChainId,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    gasPriceWei: number
  ): Promise<GasDetails> {
    return new GasDetails(BigInt(0), BigInt(0), 0, BigInt(0));
  }

  async estimateL1L2Gas(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    serviceConfig: IUniRouteServiceConfig,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    tokenInCurrencyInfo: CurrencyInfo,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    tokenOutCurrencyInfo: CurrencyInfo,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    amountIn: bigint,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    chainId: ChainId,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    tokensInfo: Map<string, Erc20Token | null>,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    tradeType: TradeType,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    quote: QuoteBasic,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    provider: BaseProvider,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    gasPriceWei: number,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ctx: Context,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    l2GasData?: ArbitrumGasData
  ): Promise<GasDetails> {
    return new GasDetails(BigInt(0), BigInt(0), 0, BigInt(0));
  }
}
