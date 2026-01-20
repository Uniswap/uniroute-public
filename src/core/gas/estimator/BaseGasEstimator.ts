import {
  ChainId,
  IUniRouteServiceConfig,
  OPTIMISM_STACK_CHAINS,
} from '../../../lib/config';
import {IGasEstimator} from './IGasEstimator';
import {CurrencyAmount, TradeType as SdkTradeType} from '@uniswap/sdk-core';
import {WRAPPED_NATIVE_CURRENCY} from '../../../lib/tokenUtils';
import {GasDetails} from '../../../models/gas/GasDetails';
import {BaseProvider, JsonRpcProvider} from '@ethersproject/providers';
import {QuoteBasic} from '../../../models/quote/QuoteBasic';
import {calculateL1GasFeesHelper} from '../gas-costs';
import {Erc20Token} from '../../../models/token/Erc20Token';
import {QuoteSplit} from '../../../models/quote/QuoteSplit';
import {ArbitrumGasData} from '../gas-data-provider';
import {Context} from '@uniswap/lib-uni/context';
import {TradeType} from '../../../models/quote/TradeType';
import {convertCurrencyInfoToSdkCurrency} from '../../../lib/helpers';
import {CurrencyInfo} from '../../../models/currency/CurrencyInfo';
import {IFreshPoolDetailsWrapper} from '../../../stores/pool/FreshPoolDetailsWrapper';

export abstract class BaseGasEstimator implements IGasEstimator {
  constructor(
    protected readonly rpcProviderMap: Map<ChainId, JsonRpcProvider>,
    protected readonly freshPoolDetailsWrapper: IFreshPoolDetailsWrapper
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
    provider: BaseProvider,
    gasPriceWei: number,
    ctx: Context,
    l2GasData?: ArbitrumGasData
  ): Promise<GasDetails> {
    const routeGas = await this.estimateRouteGas(quote, chainId, gasPriceWei);

    const calculateL1L2Gas =
      (chainId === ChainId.ARBITRUM &&
        serviceConfig.L1L2GasCostFetcher.ArbitrumEnabled) ||
      (OPTIMISM_STACK_CHAINS.includes(chainId) &&
        serviceConfig.L1L2GasCostFetcher.OpStackEnabled);

    const l1l2Gas = calculateL1L2Gas
      ? await this.estimateL1L2Gas(
          serviceConfig,
          tokenInCurrencyInfo,
          tokenOutCurrencyInfo,
          amountIn,
          chainId,
          tokensInfo,
          tradeType,
          quote,
          provider,
          gasPriceWei,
          ctx,
          l2GasData
        )
      : new GasDetails(BigInt(gasPriceWei), BigInt(0), 0, BigInt(0));

    return this.combineGasEstimates(routeGas, l1l2Gas, BigInt(gasPriceWei));
  }

  protected combineGasEstimates(
    routeGas: GasDetails,
    l1l2Gas: GasDetails,
    gasPriceInWei: bigint
  ): GasDetails {
    const totalGasCostInWei = routeGas.gasCostInWei + l1l2Gas.gasCostInWei;
    const totalGasCostInEth = routeGas.gasCostInEth + l1l2Gas.gasCostInEth;
    const totalGasUse = routeGas.gasUse + l1l2Gas.gasUse;

    return new GasDetails(
      gasPriceInWei,
      totalGasCostInWei,
      totalGasCostInEth,
      totalGasUse
    );
  }

  public abstract estimateRouteGas(
    quote: QuoteBasic,
    chainId: ChainId,
    gasPriceWei: number
  ): Promise<GasDetails>;

  public async estimateL1L2Gas(
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
  ): Promise<GasDetails> {
    const sdkTradeType =
      tradeType === TradeType.ExactIn
        ? SdkTradeType.EXACT_INPUT
        : SdkTradeType.EXACT_OUTPUT;

    const {tokenInCurrency, tokenOutCurrency} =
      convertCurrencyInfoToSdkCurrency(
        tokenInCurrencyInfo,
        tokenOutCurrencyInfo,
        chainId,
        tokensInfo
      );

    const l1gasFees = await calculateL1GasFeesHelper(
      serviceConfig,
      tokenInCurrency,
      tokenOutCurrency,
      amountIn,
      chainId,
      tokensInfo,
      sdkTradeType,
      new QuoteSplit([quote]),
      provider,
      ctx,
      l2GasData
    );

    const gasUse =
      l1gasFees.gasUsedL1.toBigInt() + l1gasFees.gasUsedL1OnL2.toBigInt();
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
