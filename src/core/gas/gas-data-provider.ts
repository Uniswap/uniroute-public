// Ported from SOR
import {BigNumber} from '@ethersproject/bignumber';
import {BaseProvider} from '@ethersproject/providers';
import {Context} from '@uniswap/lib-uni/context';

import {GasDataArbitrum__factory} from '../../../abis/src/generated/contracts/factories/GasDataArbitrum__factory';
import {ARB_GASINFO_ADDRESS} from './gas-helpers';
import {
  buildMetricKey,
  buildStatusTags,
  MetricFailureReason,
} from '../../lib/config';

const METRIC_ARBITRUM_GAS_DATA_RPC_CALL = buildMetricKey(
  'ArbitrumGasData.RpcCall'
);
const METRIC_ARBITRUM_GAS_DATA_RPC_CALL_LATENCY = buildMetricKey(
  'ArbitrumGasData.RpcCall.Latency.dist'
);

/**
 * Provider for getting gas constants on L2s.
 *
 * @export
 * @interface IL2GasDataProvider
 */
export interface IL2GasDataProvider<T> {
  /**
   * Gets the data constants needed to calculate the l1 security fee on L2s like arbitrum and optimism.
   * @returns An object that includes the data necessary for the off chain estimations.
   */
  getGasData(ctx: Context): Promise<T>;
}

/**
 * perL2TxFee is the base fee in wei for an l2 transaction.
 * perL2CalldataFee is the fee in wei per byte of calldata the swap uses. Multiply by the total bytes of the calldata.
 * perArbGasTotal is the fee in wei per unit of arbgas. Multiply this by the estimate we calculate based on ticks/hops in the gasModel.
 */
export type ArbitrumGasData = {
  perL2TxFee: BigNumber;
  perL1CalldataFee: BigNumber;
  perArbGasTotal: BigNumber;
};

export class ArbitrumGasDataProvider
  implements IL2GasDataProvider<ArbitrumGasData>
{
  protected gasFeesAddress: string;

  constructor(protected provider: BaseProvider) {
    this.gasFeesAddress = ARB_GASINFO_ADDRESS;
  }

  public async getGasData(ctx: Context) {
    const gasDataContract = GasDataArbitrum__factory.connect(
      this.gasFeesAddress,
      this.provider
    );
    const startTime = Date.now();
    let gasData;
    try {
      gasData = await gasDataContract.getPricesInWei();
    } catch (error) {
      await this.emitGasDataMetrics(ctx, startTime, false);
      throw error;
    }
    await this.emitGasDataMetrics(ctx, startTime, true);
    const perL1CalldataByte = gasData[1];
    return {
      perL2TxFee: gasData[0],
      perL1CalldataFee: perL1CalldataByte.div(16),
      perArbGasTotal: gasData[5],
    };
  }

  private async emitGasDataMetrics(
    ctx: Context,
    startTime: number,
    succeeded: boolean
  ): Promise<void> {
    const tags = buildStatusTags(succeeded, MetricFailureReason.RPC_ERROR);
    await ctx.metrics.count(METRIC_ARBITRUM_GAS_DATA_RPC_CALL, 1, {
      tags,
    });
    await ctx.metrics.dist(
      METRIC_ARBITRUM_GAS_DATA_RPC_CALL_LATENCY,
      Date.now() - startTime,
      {tags}
    );
  }
}
