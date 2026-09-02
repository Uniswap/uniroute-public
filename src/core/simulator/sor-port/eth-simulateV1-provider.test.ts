import {describe, beforeEach, it, expect, vi, afterEach} from 'vitest';
import {JsonRpcProvider} from '@ethersproject/providers';
import {SwapOptionsUniversalRouter, SwapType} from './simulation-provider';
import {EthEstimateGasSimulator} from './eth-estimate-gas-provider';
import {ChainId} from '../../../lib/config';
import {Context} from '@uniswap/lib-uni/context';
import {QuoteSplit} from '../../../models/quote/QuoteSplit';
import {TradeType} from '../../../models/quote/TradeType';
import {GasConverter} from '../../gas/converter/GasConverter';
import {
  TokenTransferMode,
  UniversalRouterVersion,
} from '@uniswap/universal-router-sdk';
import {Percent} from '@uniswap/sdk-core';
import {SimulationStatus} from '../ISimulator';
import {ResolvedStateOverride} from '../ResolvedStateOverride';
import {Erc20Token} from '../../../models/token/Erc20Token';
import {RouteBasic} from 'src/models/route/RouteBasic';
import {GasDetails} from 'src/models/gas/GasDetails';
import {Address} from 'src/models/address/Address';
import {MethodParameters} from 'src/lib/methodParameters';
import {EthSimulateV1Simulator} from './eth-simulateV1-provider';
import {Protocol} from '../../../models/pool/Protocol';

// Mock the ERC20 and Permit2 factories
vi.mock('../../../../abis/src/generated/contracts', () => ({
  ERC20__factory: {
    connect: vi.fn(),
    createInterface: vi.fn(() => ({
      encodeFunctionData: vi.fn(() => '0xapprovePermit2Calldata'),
    })),
  },
  Permit2__factory: {
    connect: vi.fn(),
    createInterface: vi.fn(() => ({
      encodeFunctionData: vi.fn(() => '0xapproveUniversalRouterCalldata'),
    })),
  },
}));

// Mock the breakDownSimulationError function
vi.mock('./simulationErrorBreakDown', () => ({
  breakDownSimulationError: vi.fn(() => SimulationStatus.FAILED),
}));

describe('eth-simulateV1-provider', () => {
  describe('EthSimulateV1Simulator', () => {
    let provider: JsonRpcProvider;
    let gasConverter: GasConverter;
    let ethEstimateGasSimulator: EthEstimateGasSimulator;
    let simulator: EthSimulateV1Simulator;
    let ctx: Context;

    const USDC_ADDRESS = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
    const WETH_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
    const USER_ADDRESS = '0x1234567890123456789012345678901234567890';

    const createQuoteSplit = (
      tokenInIsNative = false,
      methodParameters: MethodParameters = {
        calldata: '0xswapCalldata',
        value: '0x0',
        to: '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD',
      }
    ): QuoteSplit => ({
      quotes: [
        {
          route: new RouteBasic(Protocol.V3, [], 100),
          amount: 1000000n,
          gasDetails: new GasDetails(50000000000n, 150000n, 0.001, 150000n),
        },
      ],
      swapInfo: {
        tradeType: TradeType.ExactIn,
        tokenInWrappedAddress: USDC_ADDRESS,
        tokenOutWrappedAddress: WETH_ADDRESS,
        tokenInIsNative,
        tokenOutIsNative: false,
        inputAmount: 1000000n,
        priceImpact: 0.01,
        methodParameters,
      },
      tokensInfo: new Map<string, Erc20Token>([
        [
          USDC_ADDRESS.toLowerCase(),
          {
            address: new Address(USDC_ADDRESS),
            decimals: 6,
            symbol: 'USDC',
            name: 'USD Coin',
            toSdkToken: vi.fn(),
          } as unknown as Erc20Token,
        ],
        [
          WETH_ADDRESS.toLowerCase(),
          {
            address: new Address(WETH_ADDRESS),
            decimals: 18,
            symbol: 'WETH',
            name: 'Wrapped Ether',
          } as Erc20Token,
        ],
      ]),
    });

    const swapOptions: SwapOptionsUniversalRouter = {
      type: SwapType.UNIVERSAL_ROUTER,
      urVersion: UniversalRouterVersion.V1_2,
      simulate: {fromAddress: USER_ADDRESS},
      slippageTolerance: new Percent(5, 100),
      tokenTransferMode: TokenTransferMode.Permit2,
    };

    beforeEach(() => {
      provider = new JsonRpcProvider();
      provider.send = vi.fn();

      gasConverter = {
        getGasCostInQuoteTokenBasedOnGasCostInWei: vi
          .fn()
          .mockResolvedValue(2000n),
        getGasCostInUSDBasedOnGasCostInWei: vi.fn().mockReturnValue(3.88),
      } as unknown as GasConverter;

      ethEstimateGasSimulator = {
        ethEstimateGas: vi.fn(),
      } as unknown as EthEstimateGasSimulator;

      simulator = new EthSimulateV1Simulator(
        ChainId.MAINNET,
        provider,
        gasConverter,
        ethEstimateGasSimulator,
        [ChainId.MAINNET]
      );

      ctx = {
        logger: {
          info: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        },
        metrics: {
          dist: vi.fn(),
          count: vi.fn(),
        },
      } as unknown as Context;
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    describe('ethSimulateV1', () => {
      it('should successfully simulate a swap and return correct gas estimate', async () => {
        const mockResult = [
          {
            calls: [
              {
                returnData: '0x',
                logs: [],
                gasUsed: '50000',
                status: '0x1',
              },
              {
                returnData: '0x',
                logs: [],
                gasUsed: '60000',
                status: '0x1',
              },
              {
                returnData: '0x',
                logs: [],
                gasUsed: '150000',
                status: '0x1',
              },
            ],
          },
        ];

        vi.mocked(provider.send).mockResolvedValue(mockResult);

        const quoteSplit = createQuoteSplit();
        const result = await simulator.ethSimulateV1(
          USER_ADDRESS,
          swapOptions,
          quoteSplit,
          ctx
        );

        expect(provider.send).toHaveBeenCalledWith('eth_simulateV1', [
          {
            blockStateCalls: [
              {
                calls: expect.arrayContaining([
                  expect.objectContaining({
                    from: USER_ADDRESS,
                    to: USDC_ADDRESS,
                    data: '0xapprovePermit2Calldata',
                    value: '0x0',
                  }),
                  expect.objectContaining({
                    from: USER_ADDRESS,
                    data: '0xapproveUniversalRouterCalldata',
                    value: '0x0',
                  }),
                  expect.objectContaining({
                    from: USER_ADDRESS,
                    to: '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD',
                    data: '0xswapCalldata',
                    value: '0x0',
                  }),
                ]),
              },
            ],
          },
          'latest',
        ]);

        expect(result.simulationResult?.status).toBe(SimulationStatus.SUCCESS);
        // 150000 * 1.3 = 195000
        expect(result.simulationResult?.estimatedGasUsed).toBe(195000n);
        expect(result.simulationResult?.estimatedGasUsedInQuoteToken).toBe(
          2000n
        );

        expect(ctx.metrics.dist).toHaveBeenCalledWith(
          'UniRpcV2.Simulation.Latency.dist',
          expect.any(Number),
          {
            tags: ['chain:1', 'status:success', 'simType:eth_simulateV1'],
          }
        );

        expect(ctx.metrics.count).toHaveBeenCalledWith(
          'UniRpcV2.Simulation.Request',
          1,
          {
            tags: ['chain:1', 'status:success', 'simType:eth_simulateV1'],
          }
        );
      });

      it('tags UniRpcV2.Simulation.Request with swapSteps:true in swapsteps mode', async () => {
        const mockResult = [
          {
            calls: [
              {returnData: '0x', logs: [], gasUsed: '50000', status: '0x1'},
              {returnData: '0x', logs: [], gasUsed: '60000', status: '0x1'},
              {returnData: '0x', logs: [], gasUsed: '150000', status: '0x1'},
            ],
          },
        ];
        vi.mocked(provider.send).mockResolvedValue(mockResult);

        await simulator.ethSimulateV1(
          USER_ADDRESS,
          {...swapOptions, universalRouterSwapsteps: true},
          createQuoteSplit(),
          ctx
        );

        expect(ctx.metrics.count).toHaveBeenCalledWith(
          'UniRpcV2.Simulation.Request',
          1,
          {
            tags: [
              'chain:1',
              'status:success',
              'simType:eth_simulateV1',
              'swapSteps:true',
            ],
          }
        );
      });

      it('should send unirpc_simulateV0 with a matching simType tag when configured', async () => {
        const polyfillSimulator = new EthSimulateV1Simulator(
          ChainId.AVAX,
          provider,
          gasConverter,
          ethEstimateGasSimulator,
          [ChainId.AVAX],
          undefined,
          'unirpc_simulateV0'
        );

        const mockResult = [
          {
            calls: [
              {returnData: '0x', logs: [], gasUsed: '50000', status: '0x1'},
              {returnData: '0x', logs: [], gasUsed: '60000', status: '0x1'},
              {returnData: '0x', logs: [], gasUsed: '100000', status: '0x1'},
            ],
          },
        ];
        vi.mocked(provider.send).mockResolvedValue(mockResult);

        const result = await polyfillSimulator.ethSimulateV1(
          USER_ADDRESS,
          swapOptions,
          createQuoteSplit(),
          ctx
        );

        expect(provider.send).toHaveBeenCalledWith(
          'unirpc_simulateV0',
          expect.anything()
        );
        expect(ctx.metrics.count).toHaveBeenCalledWith(
          'UniRpcV2.Simulation.Request',
          1,
          {
            tags: [
              `chain:${ChainId.AVAX}`,
              'status:success',
              'simType:unirpc_simulateV0',
            ],
          }
        );
        expect(result.simulationResult?.status).toBe(SimulationStatus.SUCCESS);
        expect(result.simulationResult?.description).toBe(
          'Simulation succeeded via unirpc_simulateV0'
        );
      });

      it('should use custom gas multiplier when provided', async () => {
        const customSimulator = new EthSimulateV1Simulator(
          ChainId.MAINNET,
          provider,
          gasConverter,
          ethEstimateGasSimulator,
          [ChainId.MAINNET],
          {[ChainId.MAINNET]: 1.5}
        );

        const mockResult = [
          {
            calls: [
              {returnData: '0x', logs: [], gasUsed: '50000', status: '0x1'},
              {returnData: '0x', logs: [], gasUsed: '60000', status: '0x1'},
              {returnData: '0x', logs: [], gasUsed: '100000', status: '0x1'},
            ],
          },
        ];

        vi.mocked(provider.send).mockResolvedValue(mockResult);

        const quoteSplit = createQuoteSplit();
        const result = await customSimulator.ethSimulateV1(
          USER_ADDRESS,
          swapOptions,
          quoteSplit,
          ctx
        );

        // 100000 * 1.5 = 150000
        expect(result.simulationResult?.estimatedGasUsed).toBe(150000n);
      });

      it('should handle native token swaps on mainnet by using BEACON_CHAIN_DEPOSIT_ADDRESS', async () => {
        const mockResult = [
          {
            calls: [
              {returnData: '0x', logs: [], gasUsed: '50000', status: '0x1'},
              {returnData: '0x', logs: [], gasUsed: '60000', status: '0x1'},
              {returnData: '0x', logs: [], gasUsed: '150000', status: '0x1'},
            ],
          },
        ];

        vi.mocked(provider.send).mockResolvedValue(mockResult);

        const quoteSplit = createQuoteSplit(true, {
          calldata: '0xswapCalldata',
          value: '0x1000000',
          to: '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD',
        });

        await simulator.ethSimulateV1(
          USER_ADDRESS,
          swapOptions,
          quoteSplit,
          ctx
        );

        // Should use BEACON_CHAIN_DEPOSIT_ADDRESS for native swaps on mainnet
        expect(provider.send).toHaveBeenCalledWith(
          'eth_simulateV1',
          expect.arrayContaining([
            expect.objectContaining({
              blockStateCalls: [
                {
                  calls: expect.arrayContaining([
                    expect.objectContaining({
                      from: '0x00000000219ab540356cBB839Cbe05303d7705Fa',
                      value: '0x0',
                    }),
                  ]),
                },
              ],
            }),
          ])
        );
      });

      it('normalizes a leading-zero native value for geth hex parsing', async () => {
        const mockResult = [
          {
            calls: [
              {returnData: '0x', logs: [], gasUsed: '50000', status: '0x1'},
              {returnData: '0x', logs: [], gasUsed: '60000', status: '0x1'},
              {returnData: '0x', logs: [], gasUsed: '150000', status: '0x1'},
            ],
          },
        ];
        vi.mocked(provider.send).mockResolvedValue(mockResult);

        // ethers' toHexString pads to an even digit count, so 1e18 arrives
        // as 0x0de0b6b3a7640000 — geth rejects the leading zero.
        const quoteSplit = createQuoteSplit(true, {
          calldata: '0xswapCalldata',
          value: '0x0de0b6b3a7640000',
          to: '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD',
        });
        await simulator.ethSimulateV1(
          USER_ADDRESS,
          swapOptions,
          quoteSplit,
          ctx
        );

        const [payload] = vi.mocked(provider.send).mock.calls[0]![1] as [
          {blockStateCalls: [{calls: {value?: string}[]}]},
        ];
        const swapCall = payload.blockStateCalls[0].calls.at(-1)!;
        expect(swapCall.value).toBe('0xde0b6b3a7640000');
      });

      it('should use specified block number when provided', async () => {
        const mockResult = [
          {
            calls: [
              {returnData: '0x', logs: [], gasUsed: '50000', status: '0x1'},
              {returnData: '0x', logs: [], gasUsed: '60000', status: '0x1'},
              {returnData: '0x', logs: [], gasUsed: '150000', status: '0x1'},
            ],
          },
        ];

        vi.mocked(provider.send).mockResolvedValue(mockResult);

        const quoteSplit = createQuoteSplit();
        await simulator.ethSimulateV1(
          USER_ADDRESS,
          swapOptions,
          quoteSplit,
          ctx,
          undefined,
          12345678
        );

        expect(provider.send).toHaveBeenCalledWith(
          'eth_simulateV1',
          expect.arrayContaining([expect.any(Object), '0xbc614e'])
        );
      });

      it('should return FAILED status when simulation returns error in result', async () => {
        const mockResult = [
          {
            calls: [
              {returnData: '0x', logs: [], gasUsed: '50000', status: '0x1'},
              {returnData: '0x', logs: [], gasUsed: '60000', status: '0x1'},
              {
                error: {
                  code: -32000,
                  message: 'execution reverted',
                  data: '0x08c379a0',
                },
              },
            ],
          },
        ];

        vi.mocked(provider.send).mockResolvedValue(mockResult);

        const quoteSplit = createQuoteSplit();
        const result = await simulator.ethSimulateV1(
          USER_ADDRESS,
          swapOptions,
          quoteSplit,
          ctx
        );

        expect(result.simulationResult?.status).toBe(SimulationStatus.FAILED);
        expect(result.simulationResult?.estimatedGasUsed).toBe(0n);
        expect(ctx.logger.error).toHaveBeenCalledWith(
          'eth_simulateV1 returned error',
          expect.objectContaining({
            error: {
              code: -32000,
              message: 'execution reverted',
              data: '0x08c379a0',
            },
          })
        );
        expect(ctx.metrics.count).toHaveBeenCalledWith(
          'UniRpcV2.Simulation.Request',
          1,
          {
            tags: ['chain:1', 'status:failure', 'simType:eth_simulateV1'],
          }
        );
      });

      it('should return FAILED status when result is empty', async () => {
        vi.mocked(provider.send).mockResolvedValue([]);

        const quoteSplit = createQuoteSplit();
        const result = await simulator.ethSimulateV1(
          USER_ADDRESS,
          swapOptions,
          quoteSplit,
          ctx
        );

        expect(result.simulationResult?.status).toBe(SimulationStatus.FAILED);
        expect(result.simulationResult?.description).toBe(
          'Error simulating transaction via eth_simulateV1'
        );
      });

      it('should return FAILED status when result has insufficient calls', async () => {
        const mockResult = [
          {
            calls: [
              {returnData: '0x', logs: [], gasUsed: '50000', status: '0x1'},
              {returnData: '0x', logs: [], gasUsed: '60000', status: '0x1'},
            ],
          },
        ];

        vi.mocked(provider.send).mockResolvedValue(mockResult);

        const quoteSplit = createQuoteSplit();
        const result = await simulator.ethSimulateV1(
          USER_ADDRESS,
          swapOptions,
          quoteSplit,
          ctx
        );

        expect(result.simulationResult?.status).toBe(SimulationStatus.FAILED);
      });

      it('should return FAILED status and handle exception during RPC call', async () => {
        vi.mocked(provider.send).mockRejectedValue(
          new Error('RPC provider error')
        );

        const quoteSplit = createQuoteSplit();
        const result = await simulator.ethSimulateV1(
          USER_ADDRESS,
          swapOptions,
          quoteSplit,
          ctx
        );

        expect(result.simulationResult?.status).toBe(SimulationStatus.FAILED);
        expect(result.simulationResult?.description).toBe(
          'Error simulating transaction via eth_simulateV1'
        );
        expect(ctx.logger.error).toHaveBeenCalledWith(
          'Error simulating with eth_simulateV1',
          expect.any(Error)
        );
        expect(ctx.metrics.count).toHaveBeenCalledWith(
          'UniRpcV2.Simulation.Request',
          1,
          {
            tags: ['chain:1', 'status:failure', 'simType:eth_simulateV1'],
          }
        );
      });

      it('should throw error for unsupported swap type', async () => {
        const quoteSplit = createQuoteSplit();
        const invalidSwapOptions = {
          ...swapOptions,
          type: 'INVALID_TYPE',
        } as unknown as SwapOptionsUniversalRouter;

        await expect(
          simulator.ethSimulateV1(
            USER_ADDRESS,
            invalidSwapOptions,
            quoteSplit,
            ctx
          )
        ).rejects.toThrow('Unsupported swap type');
      });

      it('should log detailed gas information on success', async () => {
        const mockResult = [
          {
            calls: [
              {returnData: '0x', logs: [], gasUsed: '45000', status: '0x1'},
              {returnData: '0x', logs: [], gasUsed: '55000', status: '0x1'},
              {returnData: '0x', logs: [], gasUsed: '140000', status: '0x1'},
            ],
          },
        ];

        vi.mocked(provider.send).mockResolvedValue(mockResult);

        const quoteSplit = createQuoteSplit();
        await simulator.ethSimulateV1(
          USER_ADDRESS,
          swapOptions,
          quoteSplit,
          ctx
        );

        expect(ctx.logger.info).toHaveBeenCalledWith(
          'Successfully Simulated Approvals + Swap via eth_simulateV1 for Universal Router. Gas used.',
          {
            approvePermit2GasUsed: '45000',
            approveUniversalRouterGasUsed: '55000',
            swapGasUsed: '140000',
            swapWithMultiplier: '182000', // 140000 * 1.3
          }
        );
      });
    });

    describe('simulateTransaction routing', () => {
      type SimulateTransaction = {
        simulateTransaction: (
          fromAddress: string,
          swapOptions: SwapOptionsUniversalRouter,
          quoteSplit: QuoteSplit,
          ctx: Context,
          gasPrice?: bigint,
          blockNumber?: number,
          stateOverrides?: ResolvedStateOverride[]
        ) => Promise<QuoteSplit>;
      };

      const mockTokenApproved = (
        target: EthSimulateV1Simulator,
        approved: boolean
      ) =>
        vi
          .spyOn(
            target as unknown as {
              checkTokenApproved: () => Promise<boolean>;
            },
            'checkTokenApproved'
          )
          .mockResolvedValue(approved);

      const successBundleResult = [
        {
          calls: [
            {returnData: '0x', logs: [], gasUsed: '50000', status: '0x1'},
            {returnData: '0x', logs: [], gasUsed: '60000', status: '0x1'},
            {returnData: '0x', logs: [], gasUsed: '150000', status: '0x1'},
          ],
        },
      ];

      it('should take the eth_estimateGas fast path for native input', async () => {
        const quoteSplit = createQuoteSplit(true);
        vi.mocked(ethEstimateGasSimulator.ethEstimateGas).mockResolvedValue({
          ...quoteSplit,
          simulationResult: {
            estimatedGasUsed: 150000n,
            estimatedGasUsedInQuoteToken: 2000n,
            estimatedGasUsedInUSD: 3.88,
            status: SimulationStatus.SUCCESS,
          },
        });

        const result = await (
          simulator as unknown as SimulateTransaction
        ).simulateTransaction(USER_ADDRESS, swapOptions, quoteSplit, ctx);

        expect(ethEstimateGasSimulator.ethEstimateGas).toHaveBeenCalled();
        expect(provider.send).not.toHaveBeenCalled();
        expect(result.simulationResult?.status).toBe(SimulationStatus.SUCCESS);
      });

      it('should take the eth_estimateGas fast path when the token is approved', async () => {
        const quoteSplit = createQuoteSplit(false);
        mockTokenApproved(simulator, true);
        vi.mocked(ethEstimateGasSimulator.ethEstimateGas).mockResolvedValue({
          ...quoteSplit,
          simulationResult: {
            estimatedGasUsed: 150000n,
            estimatedGasUsedInQuoteToken: 2000n,
            estimatedGasUsedInUSD: 3.88,
            status: SimulationStatus.SUCCESS,
          },
        });

        const result = await (
          simulator as unknown as SimulateTransaction
        ).simulateTransaction(USER_ADDRESS, swapOptions, quoteSplit, ctx);

        expect(ethEstimateGasSimulator.ethEstimateGas).toHaveBeenCalled();
        expect(result.simulationResult?.status).toBe(SimulationStatus.SUCCESS);
      });

      it('should route unapproved tokens to the simulateV1 bundle', async () => {
        const quoteSplit = createQuoteSplit(false);
        mockTokenApproved(simulator, false);
        vi.mocked(provider.send).mockResolvedValue(successBundleResult);

        const result = await (
          simulator as unknown as SimulateTransaction
        ).simulateTransaction(USER_ADDRESS, swapOptions, quoteSplit, ctx);

        expect(ethEstimateGasSimulator.ethEstimateGas).not.toHaveBeenCalled();
        expect(provider.send).toHaveBeenCalled();
        expect(result.simulationResult?.status).toBe(SimulationStatus.SUCCESS);
      });

      it('should skip the fast path when state overrides are present', async () => {
        const quoteSplit = createQuoteSplit(true);
        vi.mocked(provider.send).mockResolvedValue(successBundleResult);

        const result = await (
          simulator as unknown as SimulateTransaction
        ).simulateTransaction(
          USER_ADDRESS,
          swapOptions,
          quoteSplit,
          ctx,
          undefined,
          undefined,
          [
            {
              contractAddress: USDC_ADDRESS,
              balance: 1000000000000000000n,
            },
          ]
        );

        expect(ethEstimateGasSimulator.ethEstimateGas).not.toHaveBeenCalled();
        expect(provider.send).toHaveBeenCalled();
        expect(result.simulationResult?.status).toBe(SimulationStatus.SUCCESS);
      });

      it('should fall through to the bundle when eth_estimateGas throws', async () => {
        const quoteSplit = createQuoteSplit(true);
        vi.mocked(ethEstimateGasSimulator.ethEstimateGas).mockRejectedValue(
          new Error('estimateGas boom')
        );
        vi.mocked(provider.send).mockResolvedValue(successBundleResult);

        const result = await (
          simulator as unknown as SimulateTransaction
        ).simulateTransaction(USER_ADDRESS, swapOptions, quoteSplit, ctx);

        expect(provider.send).toHaveBeenCalled();
        expect(result.simulationResult?.status).toBe(SimulationStatus.SUCCESS);
      });

      it('should surface a post-sim gas-conversion throw as FAILED via the base simulate() catch', async () => {
        // The inner try in ethSimulateV1 covers the RPC + result parsing;
        // the gas conversion afterwards can still throw (pool fetch,
        // missing quote-token price). The base Simulator.simulate() wrapper
        // is what catches that and degrades to FAILED — pin it so the
        // whole quote request never fails on a transient conversion error.
        vi.mocked(provider.send).mockResolvedValue([
          {
            calls: [
              {returnData: '0x', logs: [], gasUsed: '50000', status: '0x1'},
              {returnData: '0x', logs: [], gasUsed: '60000', status: '0x1'},
              {returnData: '0x', logs: [], gasUsed: '150000', status: '0x1'},
            ],
          },
        ]);
        vi.mocked(
          gasConverter.getGasCostInQuoteTokenBasedOnGasCostInWei
        ).mockRejectedValue(new Error('pool fetch failed'));
        // Native input on MAINNET skips both the balance check and the
        // approval check; the estimateGas fast path throwing falls through
        // to the simulateV1 bundle.
        vi.mocked(ethEstimateGasSimulator.ethEstimateGas).mockRejectedValue(
          new Error('estimateGas down')
        );
        const quoteSplit = createQuoteSplit(true);

        const result = await simulator.simulate(
          USER_ADDRESS,
          swapOptions,
          quoteSplit,
          {isNative: true} as never,
          {isNative: false} as never,
          1000000n,
          1000000n,
          ctx
        );

        expect(result.simulationResult?.status).toBe(SimulationStatus.FAILED);
        expect(result.simulationResult?.description).toBe(
          'Error simulating transaction'
        );
      });

      it('should return NOT_SUPPORTED on chains without a simulation backend', async () => {
        const unsupportedChainSimulator = new EthSimulateV1Simulator(
          ChainId.ZKSYNC,
          provider,
          gasConverter,
          ethEstimateGasSimulator,
          [ChainId.MAINNET]
        );
        const quoteSplit = createQuoteSplit(false);
        mockTokenApproved(unsupportedChainSimulator, false);

        const result = await (
          unsupportedChainSimulator as unknown as SimulateTransaction
        ).simulateTransaction(USER_ADDRESS, swapOptions, quoteSplit, ctx);

        expect(ethEstimateGasSimulator.ethEstimateGas).not.toHaveBeenCalled();
        expect(provider.send).not.toHaveBeenCalled();
        expect(result.simulationResult?.status).toBe(
          SimulationStatus.NOT_SUPPORTED
        );
      });
    });

    describe('ethSimulateV1 proxy flow (ApproveProxy)', () => {
      it('should simulate 2-call proxy flow and parse gas from index 1', async () => {
        const mockResult = [
          {
            calls: [
              {
                returnData: '0x',
                logs: [],
                gasUsed: '50000',
                status: '0x1',
              },
              {
                returnData: '0x',
                logs: [],
                gasUsed: '150000',
                status: '0x1',
              },
            ],
          },
        ];

        vi.mocked(provider.send).mockResolvedValue(mockResult);

        const proxySwapOptions: SwapOptionsUniversalRouter = {
          ...swapOptions,
          tokenTransferMode: TokenTransferMode.ApproveProxy,
        };

        const quoteSplit = createQuoteSplit();
        const result = await simulator.ethSimulateV1(
          USER_ADDRESS,
          proxySwapOptions,
          quoteSplit,
          ctx
        );

        expect(result.simulationResult?.status).toBe(SimulationStatus.SUCCESS);
        expect(result.simulationResult?.estimatedGasUsed).toBe(195000n); // 150000 * 1.3

        const sendArgs = vi.mocked(provider.send).mock.calls[0];
        const blockStateCalls = sendArgs[1][0];
        expect(blockStateCalls.blockStateCalls[0].calls).toHaveLength(2);
      });

      it('should return FAILED for 2-call proxy flow when swap has error', async () => {
        const mockResult = [
          {
            calls: [
              {
                returnData: '0x',
                logs: [],
                gasUsed: '50000',
                status: '0x1',
              },
              {
                error: {
                  code: -32000,
                  message: 'execution reverted',
                },
              },
            ],
          },
        ];

        vi.mocked(provider.send).mockResolvedValue(mockResult);

        const proxySwapOptions: SwapOptionsUniversalRouter = {
          ...swapOptions,
          tokenTransferMode: TokenTransferMode.ApproveProxy,
        };

        const quoteSplit = createQuoteSplit();
        const result = await simulator.ethSimulateV1(
          USER_ADDRESS,
          proxySwapOptions,
          quoteSplit,
          ctx
        );

        expect(result.simulationResult?.status).toBe(SimulationStatus.FAILED);
      });
    });

    describe('constructor', () => {
      it('should use default multiplier when not provided', () => {
        const sim = new EthSimulateV1Simulator(
          ChainId.MAINNET,
          provider,
          gasConverter,
          ethEstimateGasSimulator,
          [ChainId.MAINNET]
        );

        expect(sim).toBeInstanceOf(EthSimulateV1Simulator);
      });

      it('should use provided multiplier override', () => {
        const sim = new EthSimulateV1Simulator(
          ChainId.MAINNET,
          provider,
          gasConverter,
          ethEstimateGasSimulator,
          [ChainId.MAINNET],
          {[ChainId.MAINNET]: 2.0, [ChainId.ARBITRUM]: 1.5}
        );

        expect(sim).toBeInstanceOf(EthSimulateV1Simulator);
      });
    });
  });
});
