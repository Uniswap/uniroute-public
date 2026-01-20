import http from 'http';
import https from 'https';

import {JsonRpcProvider} from '@ethersproject/providers';
import {constants} from 'ethers';
import {permit2Address} from '@uniswap/permit2-sdk';
import {UNIVERSAL_ROUTER_ADDRESS} from '@uniswap/universal-router-sdk';
import axios, {AxiosRequestConfig} from 'axios';

import {
  ERC20__factory,
  Permit2__factory,
} from '../../../../abis/src/generated/contracts';

import {EthEstimateGasSimulator} from './eth-estimate-gas-provider';
import {
  Simulator,
  SwapOptionsUniversalRouter,
  SwapType,
} from './simulation-provider';
import {Context} from '@uniswap/lib-uni/context';
import {BEACON_CHAIN_DEPOSIT_ADDRESS, MAX_UINT160} from '../../../lib/helpers';
import {breakDownTenderlySimulationError} from './tenderlySimulationErrorBreakDown';
import {QuoteSplit} from '../../../models/quote/QuoteSplit';
import {ChainId} from '../../../lib/config';
import {GasConverter} from '../../gas/converter/GasConverter';
import {TradeType} from '../../../models/quote/TradeType';
import {SimulationStatus} from '../ISimulator';

export type GasBody = {
  gas: string;
  gasUsed: string;
};

// Standard JSON RPC error response https://www.jsonrpc.org/specification#error_object
export type JsonRpcError = {
  error: {
    code: number;
    message: string;
    data: string;
  };
};

export type TenderlyResponseEstimateGasBundle = {
  id: number;
  jsonrpc: string;
  result: Array<JsonRpcError | GasBody>;
};

// Simulation API response types
export type SimulationResult = {
  transaction: {
    gas: number;
    gas_used: number;
    error_message?: string;
  };
  simulation: {
    id: string;
    status: boolean;
  };
};

export type TenderlyResponseUniversalRouter = {
  config: {
    url: string;
    method: string;
    data: string;
  };
  simulation_results: [SimulationResult, SimulationResult, SimulationResult];
};

export type TenderlySimulationBody = {
  simulations: TenderlySimulationRequest[];
  estimate_gas: boolean;
};

enum TenderlySimulationType {
  QUICK = 'quick',
  FULL = 'full',
  ABI = 'abi',
}

type TenderlySimulationRequest = {
  network_id: ChainId;
  estimate_gas: boolean;
  input: string;
  to: string;
  value: string;
  from: string;
  simulation_type: TenderlySimulationType;
  block_number?: number;
  save_if_fails?: boolean;
  gas_price?: string; // hex
};

type EthJsonRpcRequestBody = {
  from: string;
  to: string;
  data: string;
  gasPrice?: string;
};

type blockNumber =
  | number
  | string
  | 'latest'
  | 'pending'
  | 'earliest'
  | 'finalized'
  | 'safe';

type TenderlyNodeEstimateGasBundleBody = {
  id: number;
  jsonrpc: string;
  method: string;
  params: Array<Array<EthJsonRpcRequestBody> | blockNumber>;
};

const TENDERLY_BATCH_SIMULATE_API = (
  tenderlyBaseUrl: string,
  tenderlyUser: string,
  tenderlyProject: string
) =>
  `${tenderlyBaseUrl}/api/v1/account/${tenderlyUser}/project/${tenderlyProject}/simulate-batch`;

const TENDERLY_NODE_API = (chainId: ChainId, tenderlyNodeApiKey: string) => {
  switch (chainId) {
    case ChainId.MAINNET:
      return `https://mainnet.gateway.tenderly.co/${tenderlyNodeApiKey}`;
    case ChainId.BASE:
      return `https://base.gateway.tenderly.co/${tenderlyNodeApiKey}`;
    case ChainId.ARBITRUM:
      return `https://arbitrum.gateway.tenderly.co/${tenderlyNodeApiKey}`;
    case ChainId.OPTIMISM:
      return `https://optimism.gateway.tenderly.co/${tenderlyNodeApiKey}`;
    case ChainId.POLYGON:
      return `https://polygon.gateway.tenderly.co/${tenderlyNodeApiKey}`;
    case ChainId.AVAX:
      return `https://avalanche.gateway.tenderly.co/${tenderlyNodeApiKey}`;
    case ChainId.BLAST:
      return `https://blast.gateway.tenderly.co/${tenderlyNodeApiKey}`;
    case ChainId.WORLDCHAIN:
      return `https://worldchain-mainnet.gateway.tenderly.co/${tenderlyNodeApiKey}`;
    case ChainId.UNICHAIN:
      return `https://unichain.gateway.tenderly.co/${tenderlyNodeApiKey}`;
    case ChainId.SONEIUM:
      return `https://soneium.gateway.tenderly.co/${tenderlyNodeApiKey}`;
    case ChainId.MONAD:
      return `https://omega-14.gateway.tenderly.co/${tenderlyNodeApiKey}`;
    case ChainId.XLAYER:
      return `https://xlayer.gateway.tenderly.co/${tenderlyNodeApiKey}`;
    default:
      throw new Error(
        `ChainId ${chainId} does not correspond to a tenderly node endpoint`
      );
  }
};

export const TENDERLY_NOT_SUPPORTED_CHAINS = [
  ChainId.CELO,
  ChainId.ZKSYNC,
  // tenderly node RPC supports BNB and ZORA upon request, we will make them available
  ChainId.BNB,
  ChainId.ZORA,
  ChainId.MONAD_TESTNET,
];

// Chains that don't support Tenderly Node API but support Simulation API
export const TENDERLY_SIMULATION_API_ONLY_CHAINS = [ChainId.XLAYER];

// We multiply tenderly gas limit by this to overestimate gas limit
const DEFAULT_ESTIMATE_MULTIPLIER = 1.3;

export class FallbackTenderlySimulator extends Simulator {
  private tenderlySimulator: TenderlySimulator;
  private ethEstimateGasSimulator: EthEstimateGasSimulator;
  constructor(
    chainId: ChainId,
    provider: JsonRpcProvider,
    tenderlySimulator: TenderlySimulator,
    ethEstimateGasSimulator: EthEstimateGasSimulator
  ) {
    super(provider, chainId);
    this.tenderlySimulator = tenderlySimulator;
    this.ethEstimateGasSimulator = ethEstimateGasSimulator;
  }

  protected async simulateTransaction(
    fromAddress: string,
    swapOptions: SwapOptionsUniversalRouter,
    quoteSplit: QuoteSplit,
    ctx: Context,
    gasPrice?: bigint,
    blockNumber?: number
  ): Promise<QuoteSplit> {
    // Make call to eth estimate gas if possible
    // For erc20s, we must check if the token allowance is sufficient
    if (
      quoteSplit.swapInfo!.tokenInIsNative ||
      (await this.checkTokenApproved(
        fromAddress,
        quoteSplit.swapInfo!.tokenInWrappedAddress,
        quoteSplit.swapInfo!.inputAmount,
        swapOptions,
        this.provider,
        ctx
      ))
    ) {
      ctx.logger.info(
        'Simulating with eth_estimateGas since token is native or approved.'
      );

      try {
        return await this.ethEstimateGasSimulator.ethEstimateGas(
          fromAddress,
          swapOptions,
          quoteSplit,
          ctx
        );
      } catch (err) {
        ctx.logger.info('Error simulating using eth_estimateGas', {err: err});
        // If it fails, we should still try to simulate using Tenderly
        // return { ...swapRoute, simulationStatus: SimulationStatus.FAILED };
      }
    }

    try {
      return await this.tenderlySimulator.simulateTransaction(
        fromAddress,
        swapOptions,
        quoteSplit,
        ctx,
        gasPrice,
        blockNumber
      );
    } catch (err) {
      ctx.logger.error('Failed to simulate via Tenderly', {err: err});

      if (err instanceof Error && err.message.includes('timeout')) {
        await ctx.metrics.count('Tenderly.Simulation.Timeout', 1, {
          tags: [`chain:${this.chainId}`],
        });
      }
      return {
        ...quoteSplit,
        simulationResult: {
          estimatedGasUsed: 0n,
          estimatedGasUsedInQuoteToken: 0n,
          status: SimulationStatus.FAILED,
          description: 'Error simulating transaction',
        },
      };
    }
  }
}

export class TenderlySimulator extends Simulator {
  private tenderlyNodeApiKey: string;
  private tenderlyBaseUrl: string;
  private tenderlyUser: string;
  private tenderlyProject: string;
  private tenderlyAccessKey: string;
  private gasConverter: GasConverter;
  private overrideEstimateMultiplier: {[chainId in ChainId]?: number};
  private tenderlyRequestTimeout?: number;
  private tenderlyServiceInstance = axios.create({
    // keep connections alive,
    // maxSockets default is Infinity, so Infinity is read as 50 sockets
    httpAgent: new http.Agent({keepAlive: true}),
    httpsAgent: new https.Agent({keepAlive: true}),
  });

  constructor(
    chainId: ChainId,
    tenderlyNodeApiKey: string,
    gasConverter: GasConverter,
    provider: JsonRpcProvider,
    overrideEstimateMultiplier?: {[chainId in ChainId]?: number},
    tenderlyRequestTimeout?: number,
    tenderlyBaseUrl?: string,
    tenderlyUser?: string,
    tenderlyProject?: string,
    tenderlyAccessKey?: string
  ) {
    super(provider, chainId);
    this.tenderlyNodeApiKey = tenderlyNodeApiKey;
    this.tenderlyBaseUrl = tenderlyBaseUrl ?? 'https://api.tenderly.co';
    this.tenderlyUser = tenderlyUser ?? '';
    this.tenderlyProject = tenderlyProject ?? '';
    this.tenderlyAccessKey = tenderlyAccessKey ?? '';
    this.gasConverter = gasConverter;
    this.overrideEstimateMultiplier = overrideEstimateMultiplier ?? {};
    this.tenderlyRequestTimeout = tenderlyRequestTimeout;
  }

  public async simulateTransaction(
    fromAddress: string,
    swapOptions: SwapOptionsUniversalRouter,
    quoteSplit: QuoteSplit,
    ctx: Context,
    gasPrice?: bigint,
    blockNumber?: number
  ): Promise<QuoteSplit> {
    const chainId = this.chainId;

    if (TENDERLY_NOT_SUPPORTED_CHAINS.includes(chainId)) {
      const msg = `${TENDERLY_NOT_SUPPORTED_CHAINS.toString()} not supported by Tenderly!`;
      ctx.logger.info(msg);
      return {
        ...quoteSplit,
        simulationResult: {
          estimatedGasUsed: 0n,
          estimatedGasUsedInQuoteToken: 0n,
          status: SimulationStatus.NOT_SUPPORTED,
          description: msg,
        },
      };
    }

    if (!quoteSplit.swapInfo!.methodParameters) {
      const msg = 'No calldata provided to simulate transaction';
      ctx.logger.info(msg);
      throw new Error(msg);
    }

    const {calldata} = quoteSplit.swapInfo!.methodParameters;

    ctx.logger.info('Simulating transaction on Tenderly', {
      calldata: quoteSplit.swapInfo!.methodParameters.calldata,
      fromAddress: fromAddress,
      chainId: chainId,
      tokenInAddress: quoteSplit.swapInfo!.tokenInWrappedAddress,
      router: swapOptions.type,
    });

    let estimatedGasUsed: bigint;
    const estimateMultiplier =
      this.overrideEstimateMultiplier[chainId] ?? DEFAULT_ESTIMATE_MULTIPLIER;

    if (swapOptions.type === SwapType.UNIVERSAL_ROUTER) {
      // simulating from beacon chain deposit address that should always hold **enough balance**
      if (
        quoteSplit.swapInfo!.tokenInIsNative &&
        this.chainId === ChainId.MAINNET
      ) {
        fromAddress = BEACON_CHAIN_DEPOSIT_ADDRESS;
      }
      // Do initial onboarding approval of Permit2.
      const erc20Interface = ERC20__factory.createInterface();
      const approvePermit2Calldata = erc20Interface.encodeFunctionData(
        'approve',
        [permit2Address(this.chainId), constants.MaxUint256]
      );

      // We are unsure if the users calldata contains a permit or not. We just
      // max approve the Universal Router from Permit2 instead, which will cover both cases.
      const permit2Interface = Permit2__factory.createInterface();
      const approveUniversalRouterCallData =
        permit2Interface.encodeFunctionData('approve', [
          quoteSplit.swapInfo!.tokenInWrappedAddress,
          UNIVERSAL_ROUTER_ADDRESS(swapOptions.version, this.chainId),
          MAX_UINT160,
          Math.floor(new Date().getTime() / 1000) + 10000000,
        ]);

      const approvePermit2: TenderlySimulationRequest = {
        network_id: chainId,
        estimate_gas: true,
        input: approvePermit2Calldata,
        to: quoteSplit.swapInfo!.tokenInWrappedAddress,
        value: '0',
        from: fromAddress,
        block_number: blockNumber,
        simulation_type: TenderlySimulationType.QUICK,
        save_if_fails: false,
      };

      const approveUniversalRouter: TenderlySimulationRequest = {
        network_id: chainId,
        estimate_gas: true,
        input: approveUniversalRouterCallData,
        to: permit2Address(this.chainId),
        value: '0',
        from: fromAddress,
        block_number: blockNumber,
        simulation_type: TenderlySimulationType.QUICK,
        save_if_fails: false,
      };

      const swapGasPrice =
        TenderlySimulator.formatGasPriceForTenderly(gasPrice);
      const swap: TenderlySimulationRequest = {
        network_id: chainId,
        input: calldata,
        estimate_gas: true,
        to: UNIVERSAL_ROUTER_ADDRESS(swapOptions.version, this.chainId),
        value: quoteSplit.swapInfo!.tokenInIsNative
          ? quoteSplit.swapInfo!.methodParameters.value
          : '0',
        from: fromAddress,
        block_number: blockNumber,
        simulation_type: TenderlySimulationType.QUICK,
        save_if_fails: false,
        gas_price: swapGasPrice,
      };

      const before = Date.now();

      // Use Simulation API for chains that don't support Node API (e.g., XLayer)
      const useSimulationApi =
        TENDERLY_SIMULATION_API_ONLY_CHAINS.includes(chainId);

      if (useSimulationApi) {
        // Use Tenderly Simulation API
        const {data: resp, status: httpStatus} =
          await this.requestSimulationApi(
            approvePermit2,
            approveUniversalRouter,
            swap,
            ctx
          );

        const simulationLatency = Date.now() - before;

        await ctx.metrics.timer(
          'Tenderly.Simulation.Latency',
          simulationLatency,
          {
            tags: [`chain:${chainId}`, 'simType:SimApi'],
          }
        );

        await ctx.metrics.count('Tenderly.Simulation.Request', 1, {
          tags: [
            `chain:${chainId}`,
            `http_status:${httpStatus}`,
            `status:${httpStatus === 200 ? 'success' : 'failure'}`,
            'simType:SimApi',
          ],
        });

        // Validate tenderly simulation API response body
        if (
          !resp ||
          resp.simulation_results.length < 3 ||
          !resp.simulation_results[2].transaction ||
          resp.simulation_results[2].transaction.error_message
        ) {
          ctx.logger.error('Failed to Simulate Via Tenderly Simulation API', {
            resp,
            chainId,
            error: resp?.simulation_results?.[2]?.transaction?.error_message,
          });
          return {
            ...quoteSplit,
            simulationResult: {
              estimatedGasUsed: 0n,
              estimatedGasUsedInQuoteToken: 0n,
              status: SimulationStatus.FAILED,
              description: 'Error simulating transaction via Simulation API',
            },
          };
        }

        // Parse the gas used in the simulation response object, and then pad it so that we overestimate.
        estimatedGasUsed = BigInt(
          (
            resp.simulation_results[2].transaction.gas * estimateMultiplier
          ).toFixed(0)
        );

        ctx.logger.info(
          'Successfully Simulated Approvals + Swap via Tenderly Simulation API for Universal Router. Gas used.',
          {
            approvePermit2GasUsed:
              resp.simulation_results[0].transaction.gas_used,
            approveUniversalRouterGasUsed:
              resp.simulation_results[1].transaction.gas_used,
            swapGasUsed: resp.simulation_results[2].transaction.gas_used,
            approvePermit2Gas: resp.simulation_results[0].transaction.gas,
            approveUniversalRouterGas:
              resp.simulation_results[1].transaction.gas,
            swapGas: resp.simulation_results[2].transaction.gas,
            swapWithMultiplier: estimatedGasUsed.toString(),
          }
        );
      } else {
        // Use Tenderly Node API
        const {data: resp, status: httpStatus} =
          await this.requestNodeSimulation(
            approvePermit2,
            approveUniversalRouter,
            swap,
            ctx
          );

        const simulationLatency = Date.now() - before;

        await ctx.metrics.timer(
          'Tenderly.Simulation.Latency',
          simulationLatency,
          {
            tags: [`chain:${chainId}`, 'simType:Node'],
          }
        );

        await ctx.metrics.count('Tenderly.Simulation.Request', 1, {
          tags: [
            `chain:${chainId}`,
            `http_status:${httpStatus}`,
            `status:${httpStatus === 200 ? 'success' : 'failure'}`,
            'simType:Node',
          ],
        });

        // Validate tenderly response body
        if (
          !resp ||
          !resp.result ||
          resp.result.length < 3 ||
          (resp.result[2] as JsonRpcError).error
        ) {
          // Logging out the request body for easier debugging on failure.
          try {
            const body = {
              id: 1,
              jsonrpc: '2.0',
              method: 'tenderly_estimateGasBundle',
              params: [
                [
                  {
                    from: approvePermit2.from,
                    to: approvePermit2.to,
                    data: approvePermit2.input,
                  },
                  {
                    from: approveUniversalRouter.from,
                    to: approveUniversalRouter.to,
                    data: approveUniversalRouter.input,
                  },
                  {
                    from: swap.from,
                    to: swap.to,
                    data: swap.input,
                    gasPrice: swap.gas_price,
                  },
                ],
                blockNumber,
              ],
            };
            ctx.logger.error(
              'Failed to invoke Tenderly Node Endpoint for gas estimation bundle.',
              {resp, chainId, body: JSON.stringify(body)}
            );
          } catch {
            ctx.logger.error(
              'Failed to invoke Tenderly Node Endpoint for gas estimation bundle.',
              {resp, chainId}
            );
          }

          if (
            resp &&
            resp.result &&
            resp.result.length >= 3 &&
            (resp.result[2] as JsonRpcError).error &&
            (resp.result[2] as JsonRpcError).error.data
          ) {
            return {
              ...quoteSplit,
              simulationResult: {
                estimatedGasUsed: 0n,
                estimatedGasUsedInQuoteToken: 0n,
                status: breakDownTenderlySimulationError(
                  quoteSplit.swapInfo!.tokenInWrappedAddress,
                  quoteSplit.swapInfo!.tokenOutWrappedAddress,
                  (resp.result[2] as JsonRpcError).error.data
                ),
                description: 'Error simulating transaction',
              },
            };
          }

          return {
            ...quoteSplit,
            simulationResult: {
              estimatedGasUsed: 0n,
              estimatedGasUsedInQuoteToken: 0n,
              status: SimulationStatus.FAILED,
              description: 'Error simulating transaction',
            },
          };
        }

        // Parse the gas used in the simulation response object, and then pad it so that we overestimate.
        estimatedGasUsed = BigInt(
          (
            Number((resp.result[2] as GasBody).gas) * estimateMultiplier
          ).toFixed(0)
        );

        ctx.logger.info(
          'Successfully Simulated Approvals + Swap via Tenderly node endpoint for Universal Router. Gas used.',
          {
            approvePermit2GasUsed: (resp.result[0] as GasBody).gasUsed,
            approveUniversalRouterGasUsed: (resp.result[1] as GasBody).gasUsed,
            swapGasUsed: (resp.result[2] as GasBody).gasUsed,
            approvePermit2Gas: (resp.result[0] as GasBody).gas,
            approveUniversalRouterGas: (resp.result[1] as GasBody).gas,
            swapGas: (resp.result[2] as GasBody).gas,
            swapWithMultiplier: estimatedGasUsed.toString(),
          }
        );
      }
    } else {
      throw new Error(`Unsupported swap type: ${swapOptions}`);
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
        chainId,
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
        description: 'Simulation succeeded via Tenderly',
      },
    };
  }

  /**
   * Formats gasPrice for Tenderly API.
   * Tenderly expects gasPrice in 0x.. format, without leading zeroes.
   * @param gasPrice The gas price as bigint, or undefined
   * @returns The formatted hex string, or undefined if gasPrice is undefined or <= 0
   */
  private static formatGasPriceForTenderly(
    gasPrice?: bigint
  ): string | undefined {
    if (!gasPrice || gasPrice <= 0n) {
      return undefined;
    }
    return '0x' + gasPrice.toString(16);
  }

  private async requestNodeSimulation(
    approvePermit2: TenderlySimulationRequest,
    approveUniversalRouter: TenderlySimulationRequest,
    swap: TenderlySimulationRequest,
    ctx: Context
  ): Promise<{data: TenderlyResponseEstimateGasBundle; status: number}> {
    const nodeEndpoint = TENDERLY_NODE_API(
      this.chainId,
      this.tenderlyNodeApiKey
    );
    // TODO: ROUTE-362 - Revisit tenderly node simulation hardcode latest block number
    // https://linear.app/uniswap/issue/ROUTE-362/revisit-tenderly-node-simulation-hardcode-latest-block-number
    const blockNumber = 'latest';
    // if (swap.block_number !== undefined) {
    //   blockNumber = swap.block_number.toString();
    // }
    const body: TenderlyNodeEstimateGasBundleBody = {
      id: 1,
      jsonrpc: '2.0',
      method: 'tenderly_estimateGasBundle',
      params: [
        [
          {
            from: approvePermit2.from,
            to: approvePermit2.to,
            data: approvePermit2.input,
          },
          {
            from: approveUniversalRouter.from,
            to: approveUniversalRouter.to,
            data: approveUniversalRouter.input,
          },
          {
            from: swap.from,
            to: swap.to,
            data: swap.input,
            gasPrice: swap.gas_price,
          },
        ],
        blockNumber,
      ],
    };

    const opts: AxiosRequestConfig = {
      timeout: this.tenderlyRequestTimeout,
    };

    try {
      ctx.logger.debug('Tenderly simulation request', {
        endpoint: nodeEndpoint,
        body: body,
      });

      // For now, we don't timeout tenderly node endpoint, but we should before we live switch to node endpoint
      const {data: resp, status: httpStatus} =
        await this.tenderlyServiceInstance.post<TenderlyResponseEstimateGasBundle>(
          nodeEndpoint,
          body,
          opts
        );

      if (httpStatus !== 200) {
        ctx.logger.error(
          `Failed to invoke Tenderly Node Endpoint for gas estimation bundle ${JSON.stringify(
            body,
            null,
            2
          )}. HTTP Status: ${httpStatus}`,
          {resp}
        );
        return {data: resp, status: httpStatus};
      }

      return {data: resp, status: httpStatus};
    } catch (err) {
      ctx.logger.error(
        `Failed to invoke Tenderly Node Endpoint for gas estimation bundle ${JSON.stringify(
          body,
          null,
          2
        )}. Error: ${err}`,
        {err}
      );

      // we will have to re-throw the error, so that simulation-provider can catch the error, and return simulation status = failed
      throw err;
    }
  }

  private async requestSimulationApi(
    approvePermit2: TenderlySimulationRequest,
    approveUniversalRouter: TenderlySimulationRequest,
    swap: TenderlySimulationRequest,
    ctx: Context
  ): Promise<{data: TenderlyResponseUniversalRouter; status: number}> {
    const url = TENDERLY_BATCH_SIMULATE_API(
      this.tenderlyBaseUrl,
      this.tenderlyUser,
      this.tenderlyProject
    );

    const body: TenderlySimulationBody = {
      simulations: [approvePermit2, approveUniversalRouter, swap],
      estimate_gas: true,
    };

    const opts: AxiosRequestConfig = {
      headers: {
        'X-Access-Key': this.tenderlyAccessKey,
      },
      timeout: this.tenderlyRequestTimeout,
    };

    try {
      ctx.logger.debug('Tenderly simulation API request', {
        endpoint: url,
        body: body,
      });

      const {data: resp, status: httpStatus} =
        await this.tenderlyServiceInstance.post<TenderlyResponseUniversalRouter>(
          url,
          body,
          opts
        );

      if (httpStatus !== 200) {
        ctx.logger.error(
          `Failed to invoke Tenderly Simulation API ${JSON.stringify(
            body,
            null,
            2
          )}. HTTP Status: ${httpStatus}`,
          {resp}
        );
        return {data: resp, status: httpStatus};
      }

      return {data: resp, status: httpStatus};
    } catch (err) {
      ctx.logger.error(
        `Failed to invoke Tenderly Simulation API ${JSON.stringify(
          body,
          null,
          2
        )}. Error: ${err}`,
        {err}
      );

      throw err;
    }
  }
}
