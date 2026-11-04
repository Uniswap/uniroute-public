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
const METRIC_GAS_ORACLE_PRIORITY_FEE = buildMetricKey('GasOracle.PriorityFee');
const HEX_QUANTITY = /^0x[0-9a-fA-F]+$/;
// eth_feeHistory with blockCount 1 returns two base fees: the newest
// block's, then the one after it.
const FEE_HISTORY_NEWEST_BLOCK_INDEX = 0;
const FEE_HISTORY_NEXT_BLOCK_INDEX = 1;

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
    blockNumber?: number,
    priorityFeePerGasWei?: bigint
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
    blockNumber?: number,
    priorityFeePerGasWei?: bigint
  ): Promise<number> {
    const provider = this.rpcProviderMap.get(chainId)!;

    if (priorityFeePerGasWei !== undefined) {
      // A failed eth_feeHistory is already counted on GasOracle.RpcCall.
      const baseFeePerGas = await this.getBaseFeePerGas(
        ctx,
        chainId,
        provider,
        blockNumber
      ).catch(() => undefined);
      void ctx.metrics
        .count(METRIC_GAS_ORACLE_PRIORITY_FEE, 1, {
          tags: [
            `chain:${ChainId[chainId]}`,
            ...buildStatusTags(
              baseFeePerGas !== undefined,
              MetricFailureReason.BASE_FEE_UNAVAILABLE
            ),
          ],
        })
        .catch(() => {});
      if (baseFeePerGas !== undefined) {
        return Number(baseFeePerGas + priorityFeePerGasWei);
      }
      // Without a base fee the tip has nothing to add to: eth_gasPrice
      // already holds a full price on legacy chains, so the tip is dropped.
      ctx.logger.warn(
        'Priority fee ignored: base fee unavailable, using eth_gasPrice',
        {chain: ChainId[chainId]}
      );
    } else if (blockNumber !== undefined) {
      const baseFeePerGas = await this.getBaseFeePerGas(
        ctx,
        chainId,
        provider,
        blockNumber
      );
      if (baseFeePerGas !== undefined) {
        return Number(baseFeePerGas);
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

  /**
   * The pinned block's own base fee, or the next block's when quoting at the
   * latest block. Undefined when the response has no usable base fee. Throws
   * when the eth_feeHistory call fails.
   */
  private async getBaseFeePerGas(
    ctx: Context,
    chainId: ChainId,
    provider: JsonRpcProvider,
    blockNumber?: number
  ): Promise<bigint | undefined> {
    const newestBlock =
      blockNumber !== undefined ? '0x' + blockNumber.toString(16) : 'latest';
    const feeHistory: unknown = await this.timedRpcSend(
      ctx,
      chainId,
      provider,
      'eth_feeHistory',
      ['0x1', newestBlock, []]
    );
    if (
      typeof feeHistory !== 'object' ||
      feeHistory === null ||
      !('baseFeePerGas' in feeHistory) ||
      !Array.isArray(feeHistory.baseFeePerGas)
    ) {
      return undefined;
    }
    const baseFeePerGas: unknown =
      feeHistory.baseFeePerGas[
        blockNumber !== undefined
          ? FEE_HISTORY_NEWEST_BLOCK_INDEX
          : FEE_HISTORY_NEXT_BLOCK_INDEX
      ];
    return typeof baseFeePerGas === 'string' && HEX_QUANTITY.test(baseFeePerGas)
      ? BigInt(baseFeePerGas)
      : undefined;
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
