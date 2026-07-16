import {IGasEstimator} from './IGasEstimator';
import {GasDetails} from '../../../models/gas/GasDetails';
import {
  buildMetricKey,
  buildStatusTags,
  ChainId,
  IUniRouteServiceConfig,
  MetricFailureReason,
} from '../../../lib/config';
import {Protocol} from '../../../models/pool/Protocol';
import {QuoteBasic} from '../../../models/quote/QuoteBasic';
import {JsonRpcProvider} from '@ethersproject/providers';
import {Erc20Token} from '../../../models/token/Erc20Token';
import {Context} from '@uniswap/lib-uni/context';
import {ArbitrumGasData} from '../gas-data-provider';
import {CurrencyInfo} from 'src/models/currency/CurrencyInfo';
import {TradeType} from '../../../models/quote/TradeType';

const METRIC_GAS_ORACLE_RPC_CALL = buildMetricKey('GasOracle.RpcCall');
const METRIC_GAS_ORACLE_RPC_CALL_LATENCY = buildMetricKey(
  'GasOracle.RpcCall.Latency.dist'
);

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
  getCurrentGasPrice(
    ctx: Context,
    chainId: ChainId,
    blockNumber?: number
  ): Promise<number>;
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
        : await this.getCurrentGasPrice(ctx, chainId);
    const provider = this.rpcProviderMap.get(chainId)!;

    switch (quote.route.protocol) {
      case Protocol.V2:
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
      case Protocol.V3:
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
      case Protocol.V4:
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
      case Protocol.MIXED:
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

  public async getCurrentGasPrice(
    ctx: Context,
    chainId: ChainId,
    blockNumber?: number
  ): Promise<number> {
    const provider = this.rpcProviderMap.get(chainId)!;

    if (blockNumber !== undefined) {
      const blockHex = '0x' + blockNumber.toString(16);
      const feeHistory = await this.timedRpcSend(
        ctx,
        chainId,
        provider,
        'eth_feeHistory',
        ['0x1', blockHex, []]
      );
      const baseFeePerGas = feeHistory.baseFeePerGas?.[0];
      if (baseFeePerGas) {
        return parseInt(baseFeePerGas, 16);
      }
    }

    const gasPrice = await this.timedRpcSend(
      ctx,
      chainId,
      provider,
      'eth_gasPrice',
      []
    );
    return parseInt(gasPrice, 16);
  }

  private async timedRpcSend(
    ctx: Context,
    chainId: ChainId,
    provider: JsonRpcProvider,
    method: 'eth_feeHistory' | 'eth_gasPrice',
    params: unknown[]
  ) {
    const startTime = Date.now();
    const baseTags = [`chain:${ChainId[chainId]}`, `rpc:${method}`];
    try {
      const result = await provider.send(method, params);
      await this.emitGasOracleMetrics(
        ctx,
        [...baseTags, ...buildStatusTags(true, MetricFailureReason.RPC_ERROR)],
        startTime
      );
      return result;
    } catch (error) {
      await this.emitGasOracleMetrics(
        ctx,
        [...baseTags, ...buildStatusTags(false, MetricFailureReason.RPC_ERROR)],
        startTime
      );
      throw error;
    }
  }

  private async emitGasOracleMetrics(
    ctx: Context,
    tags: string[],
    startTime: number
  ): Promise<void> {
    await ctx.metrics.count(METRIC_GAS_ORACLE_RPC_CALL, 1, {tags});
    await ctx.metrics.dist(
      METRIC_GAS_ORACLE_RPC_CALL_LATENCY,
      Date.now() - startTime,
      {tags}
    );
  }
}
