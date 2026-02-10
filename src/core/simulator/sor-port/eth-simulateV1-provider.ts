import {JsonRpcProvider} from '@ethersproject/providers';
import {ChainId} from '../../../lib/config';

import {
  ERC20__factory,
  Permit2__factory,
} from '../../../../abis/src/generated/contracts';

import {
  Simulator,
  SwapOptionsUniversalRouter,
  SwapType,
} from './simulation-provider';
import {Context} from '@uniswap/lib-uni/context';
import {BEACON_CHAIN_DEPOSIT_ADDRESS, MAX_UINT160} from '../../../lib/helpers';
import {QuoteSplit} from '../../../models/quote/QuoteSplit';
import {TradeType} from '../../../models/quote/TradeType';
import {GasConverter} from '../../gas/converter/GasConverter';
import {SimulationStatus} from '../ISimulator';
import {permit2Address} from '@uniswap/permit2-sdk';
import {constants} from 'ethers';
import {UNIVERSAL_ROUTER_ADDRESS} from '@uniswap/universal-router-sdk';

// Types for eth_simulateV1 RPC request
interface BlockStateCalls {
  blockStateCalls: BlockStateCall[];
}

interface BlockStateCall {
  calls: SimulateV1Call[];
}

interface SimulateV1Call {
  from: string;
  to: string;
  data: string;
  value?: string;
  gas?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
}

interface Log {
  address: string;
  topics: string[];
  data: string;
  blockHash: string;
  blockNumber: number;
  transactionHash: string;
  transactionIndex: string;
  logIndex: string;
  removed: boolean;
}

interface ReturnData {
  returnData: string;
  logs: Log[];
  gasUsed: string;
  status: string;
}

interface JsonRpcError {
  error: {
    code: number;
    message: string;
    data?: string;
  };
}

interface ResultCall {
  calls: Array<ReturnData | JsonRpcError>;
}

// We multiply eth_simulateV1 gas limit by this to overestimate gas limit
const DEFAULT_ESTIMATE_MULTIPLIER = 1.3;

export class EthSimulateV1Simulator extends Simulator {
  private gasConverter: GasConverter;
  private overrideEstimateMultiplier: {[chainId in ChainId]?: number};

  constructor(
    chainId: ChainId,
    provider: JsonRpcProvider,
    gasConverter: GasConverter,
    overrideEstimateMultiplier?: {[chainId in ChainId]?: number}
  ) {
    super(provider, chainId);
    this.gasConverter = gasConverter;
    this.overrideEstimateMultiplier = overrideEstimateMultiplier ?? {};
  }

  async ethSimulateV1(
    fromAddress: string,
    swapOptions: SwapOptionsUniversalRouter,
    quoteSplit: QuoteSplit,
    ctx: Context,
    gasPrice?: bigint,
    blockNumber?: number
  ): Promise<QuoteSplit> {
    let estimatedGasUsed: bigint;
    const estimateMultiplier =
      this.overrideEstimateMultiplier[this.chainId] ??
      DEFAULT_ESTIMATE_MULTIPLIER;

    if (swapOptions.type === SwapType.UNIVERSAL_ROUTER) {
      if (
        quoteSplit.swapInfo!.tokenInIsNative &&
        this.chainId === ChainId.MAINNET
      ) {
        // w/o this gas estimate differs by a lot depending on if user holds enough native balance
        // always estimate gas as if user holds enough balance
        // so that gas estimate is consistent for UniswapX
        fromAddress = BEACON_CHAIN_DEPOSIT_ADDRESS;
      }
      // Do initial onboarding approval of Permit2.
      const erc20Interface = ERC20__factory.createInterface();
      const approvePermit2Calldata = erc20Interface.encodeFunctionData(
        'approve',
        [permit2Address(this.chainId), constants.MaxUint256]
      );

      const permit2Interface = Permit2__factory.createInterface();
      const approveUniversalRouterCallData =
        permit2Interface.encodeFunctionData('approve', [
          quoteSplit.swapInfo!.tokenInWrappedAddress,
          UNIVERSAL_ROUTER_ADDRESS(swapOptions.version, this.chainId),
          MAX_UINT160,
          Math.floor(new Date().getTime() / 1000) + 10000000,
        ]);

      const approvePermit2: SimulateV1Call = {
        from: fromAddress,
        to: quoteSplit.swapInfo!.tokenInWrappedAddress,
        data: approvePermit2Calldata,
        value: '0',
      };
      const approveUniversalRouter: SimulateV1Call = {
        from: fromAddress,
        to: permit2Address(this.chainId),
        data: approveUniversalRouterCallData,
        value: '0',
      };
      const swap: SimulateV1Call = {
        from: fromAddress,
        to: quoteSplit.swapInfo!.methodParameters!.to,
        data: quoteSplit.swapInfo!.methodParameters!.calldata,
        value: quoteSplit.swapInfo!.tokenInIsNative
          ? quoteSplit.swapInfo!.methodParameters!.value
          : '0',
      };

      ctx.logger.info('Simulating using eth_simulateV1 on Universal Router', {
        addr: fromAddress,
        methodParameters: quoteSplit.swapInfo!.methodParameters,
      });
      try {
        const blockStateCall: BlockStateCall = {
          calls: [approvePermit2, approveUniversalRouter, swap],
        };
        const blockStateCalls: BlockStateCalls = {
          blockStateCalls: [blockStateCall],
        };

        const before = Date.now();

        // Call eth_simulateV1 RPC method
        const result = (await this.provider.send('eth_simulateV1', [
          blockStateCalls,
          blockNumber?.toString() ?? 'latest',
        ])) as Array<ResultCall>;

        const simulationLatency = Date.now() - before;

        if (
          !result ||
          !result[0] ||
          result.length < 1 ||
          !result[0].calls ||
          result[0].calls.length < 3 ||
          'error' in result[0].calls[2]
        ) {
          if ('error' in result[0].calls[2]) {
            ctx.logger.error('eth_simulateV1 returned error', {
              result,
              error: (result[0].calls[2] as JsonRpcError).error,
            });
          }

          await ctx.metrics.count('UniRpcV2.Simulation.Request', 1, {
            tags: [
              `chain:${this.chainId}`,
              'status:failure',
              'simType:eth_simulateV1',
            ],
          });

          return {
            ...quoteSplit,
            simulationResult: {
              estimatedGasUsed: 0n,
              estimatedGasUsedInQuoteToken: 0n,
              status: SimulationStatus.FAILED,
              description: 'Error simulating transaction via eth_simulateV1',
            },
          };
        }

        // swapResult is ReturnData
        estimatedGasUsed = BigInt(
          (
            Number((result[0].calls[2] as ReturnData).gasUsed) *
            estimateMultiplier
          ).toFixed(0)
        );

        await ctx.metrics.timer(
          'UniRpcV2.Simulation.Latency',
          simulationLatency,
          {
            tags: [`chain:${this.chainId}`, 'simType:eth_simulateV1'],
          }
        );

        await ctx.metrics.count('UniRpcV2.Simulation.Request', 1, {
          tags: [
            `chain:${this.chainId}`,
            'status:success',
            'simType:eth_simulateV1',
          ],
        });

        ctx.logger.info(
          'Successfully Simulated Approvals + Swap via eth_simulateV1 for Universal Router. Gas used.',
          {
            approvePermit2GasUsed: (result[0].calls[0] as ReturnData).gasUsed,
            approveUniversalRouterGasUsed: (result[0].calls[1] as ReturnData)
              .gasUsed,
            swapGasUsed: (result[0].calls[2] as ReturnData).gasUsed,
            swapWithMultiplier: estimatedGasUsed.toString(),
          }
        );
      } catch (e) {
        ctx.logger.error('Error simulating with eth_simulateV1', e);

        await ctx.metrics.count('UniRpcV2.Simulation.Request', 1, {
          tags: [
            `chain:${this.chainId}`,
            'status:failure',
            'simType:eth_simulateV1',
          ],
        });
        return {
          ...quoteSplit,
          simulationResult: {
            estimatedGasUsed: 0n,
            estimatedGasUsedInQuoteToken: 0n,
            status: SimulationStatus.FAILED,
            description: 'Error simulating transaction via eth_simulateV1',
          },
        };
      }
    } else {
      throw new Error(`Unsupported swap type ${swapOptions}`);
    }

    // Get the gas cost in terms of the quote token based on the estimatedGasUsed
    const quoteTokenAddress =
      quoteSplit.swapInfo!.tradeType === TradeType.ExactIn
        ? quoteSplit.swapInfo!.tokenOutWrappedAddress
        : quoteSplit.swapInfo!.tokenInWrappedAddress;

    // Use gas price from first quote since it should be the same for all quotes
    const gasPriceWei = quoteSplit.quotes[0]!.gasDetails!.gasPriceInWei;
    const gasCostInQuoteToken =
      await this.gasConverter.getGasCostInQuoteTokenBasedOnGasCostInWei(
        this.chainId,
        quoteTokenAddress,
        quoteSplit.tokensInfo!,
        estimatedGasUsed * gasPriceWei,
        ctx
      );

    return {
      ...quoteSplit,
      simulationResult: {
        estimatedGasUsed: estimatedGasUsed,
        estimatedGasUsedInQuoteToken: gasCostInQuoteToken,
        status: SimulationStatus.SUCCESS,
        description: 'Simulation succeeded via eth_simulateV1',
      },
    };
  }

  public async simulateTransaction(
    fromAddress: string,
    swapOptions: SwapOptionsUniversalRouter,
    quoteSplit: QuoteSplit,
    ctx: Context,

    gasPrice?: bigint,

    blockNumber?: number
  ): Promise<QuoteSplit> {
    const inputAmount = quoteSplit.swapInfo!.inputAmount;
    if (
      quoteSplit.swapInfo!.tokenInIsNative ||
      (await this.checkTokenApproved(
        fromAddress,
        quoteSplit.swapInfo!.tokenInWrappedAddress,
        inputAmount,
        swapOptions,
        this.provider,
        ctx
      ))
    ) {
      return await this.ethSimulateV1(
        fromAddress,
        swapOptions,
        quoteSplit,
        ctx,
        gasPrice,
        blockNumber
      );
    } else {
      ctx.logger.info('Token not approved, skipping simulation');
      return {
        ...quoteSplit,
        simulationResult: {
          estimatedGasUsed: 0n,
          estimatedGasUsedInQuoteToken: 0n,
          status: SimulationStatus.NOT_APPROVED,
          description: 'Token not approved, skipping simulation',
        },
      };
    }
  }
}
