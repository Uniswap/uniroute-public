import {describe, beforeEach, it, expect, vi, afterEach, Mock} from 'vitest';
import {JsonRpcProvider} from '@ethersproject/providers';
import {utils} from 'ethers';
import {
  SwapOptionsUniversalRouter,
  SwapType,
  UserBalanceCheck,
} from './simulation-provider';
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
import {BEACON_CHAIN_DEPOSIT_ADDRESS} from '../../../lib/helpers';
import {hasNativeToken} from '../../../lib/tokenUtils';

import {
  captureEthersRpcError,
  UNIRPC_ALL_PROVIDERS_FAILED,
  UNIRPC_BALANCE_OVERRIDE_REFUSED,
} from '../../../../tests/test-utils/ethersRpcErrors';
import {
  NATIVE_BALANCE_OVERRIDE_ASSET,
  SeededProviderFactory,
} from './balanceOverride';

import {buildTestContext} from '@uniswap/lib-testhelpers';
import {Pool} from '../../../models/pool/Pool';
import {QuoteBasic} from '../../../models/quote/QuoteBasic';
import {SwapInfo} from '../../../models/quote/SwapInfo';
import {IPoolsRepository} from '../../../stores/pool/IPoolsRepository';
import fixture from './deliveryProbe.fixtures.json';
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

const UNIVERSAL_ROUTER_ERRORS = new utils.Interface([
  'error InsufficientToken()',
  'error InsufficientETH()',
  'error V3TooLittleReceived()',
]);

describe('eth-simulateV1-provider', () => {
  describe('EthSimulateV1Simulator', () => {
    let provider: JsonRpcProvider;
    let seededProvider: JsonRpcProvider;
    let seededProviderFor: Mock<SeededProviderFactory>;
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
      seededProvider = new JsonRpcProvider();
      seededProvider.send = vi.fn();
      seededProviderFor = vi.fn<SeededProviderFactory>(() => seededProvider);

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
        [ChainId.MAINNET],
        seededProviderFor,
        true
      );

      ctx = {
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        },
        metrics: {
          dist: vi.fn(),
          count: vi.fn().mockResolvedValue(undefined),
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
        // Reported verbatim — the swap call's simulated gasUsed, unpadded.
        expect(result.simulationResult?.estimatedGasUsed).toBe(150000n);
        expect(result.simulationResult?.estimatedGasUsedInQuoteToken).toBe(
          2000n
        );

        expect(ctx.metrics.dist).toHaveBeenCalledWith(
          'UniRpcV2.Simulation.Latency.dist',
          expect.any(Number),
          {
            tags: [
              'chain:1',
              'status:success',
              'simType:eth_simulateV1',
              'seeded:false',
            ],
          }
        );

        expect(ctx.metrics.count).toHaveBeenCalledWith(
          'UniRpcV2.Simulation.Request',
          1,
          {
            tags: [
              'chain:1',
              'status:success',
              'simType:eth_simulateV1',
              'seeded:false',
            ],
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
              'seeded:false',
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
          seededProviderFor,
          true,
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
              'seeded:false',
            ],
          }
        );
        expect(result.simulationResult?.status).toBe(SimulationStatus.SUCCESS);
        expect(result.simulationResult?.description).toBe(
          'Simulation succeeded via unirpc_simulateV0'
        );
        // The polyfill's gasUsed is already whole-transaction (it reconstructs
        // the per-call intrinsic native simulateV1 charges), and like the
        // native path it is reported unscaled.
        expect(result.simulationResult?.estimatedGasUsed).toBe(100000n);
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
            tags: [
              'chain:1',
              'status:failure',
              'simType:eth_simulateV1',
              'seeded:false',
            ],
          }
        );
      });

      it.each([
        ['InsufficientToken', SimulationStatus.FAILED, true],
        ['InsufficientETH', SimulationStatus.FAILED, true],
        ['V3TooLittleReceived', SimulationStatus.SLIPPAGE_TOO_LOW, undefined],
      ])(
        'reports a %s swap revert as %s with routerBalanceFloorReverted %s',
        async (errorName, status, flagged) => {
          vi.mocked(provider.send).mockResolvedValue([
            {
              calls: [
                {returnData: '0x', logs: [], gasUsed: '50000', status: '0x1'},
                {returnData: '0x', logs: [], gasUsed: '60000', status: '0x1'},
                {
                  error: {
                    code: -32000,
                    message: 'execution reverted',
                    data: UNIVERSAL_ROUTER_ERRORS.encodeErrorResult(errorName),
                  },
                },
              ],
            },
          ]);

          const result = await simulator.ethSimulateV1(
            USER_ADDRESS,
            swapOptions,
            createQuoteSplit(),
            ctx
          );

          expect(result.simulationResult?.status).toBe(status);
          expect(result.simulationResult?.routerBalanceFloorReverted).toBe(
            flagged
          );
        }
      );

      it('flags a thrown SWEEP-minimum revert as a router balance floor', async () => {
        vi.mocked(provider.send).mockRejectedValue(
          await captureEthersRpcError(
            {
              httpStatus: 200,
              code: 3,
              message: 'execution reverted',
              data: UNIVERSAL_ROUTER_ERRORS.encodeErrorResult(
                'InsufficientToken'
              ),
            },
            rpc => rpc.send('eth_simulateV1', [{}])
          )
        );

        const result = await simulator.ethSimulateV1(
          USER_ADDRESS,
          swapOptions,
          createQuoteSplit(),
          ctx
        );

        expect(result.simulationResult?.status).toBe(SimulationStatus.FAILED);
        expect(result.simulationResult?.routerBalanceFloorReverted).toBe(true);
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
          {e: expect.any(Error)}
        );
        expect(ctx.metrics.count).toHaveBeenCalledWith(
          'UniRpcV2.Simulation.Request',
          1,
          {
            tags: [
              'chain:1',
              'status:failure',
              'simType:eth_simulateV1',
              'seeded:false',
            ],
          }
        );
      });

      it('returns SYSTEM_DOWN when the RPC backend returns a 502', async () => {
        vi.mocked(provider.send).mockRejectedValue(
          Object.assign(new Error('bad gateway'), {
            code: utils.Logger.errors.SERVER_ERROR,
            status: 502,
          })
        );

        const result = await simulator.ethSimulateV1(
          USER_ADDRESS,
          swapOptions,
          createQuoteSplit(),
          ctx
        );

        expect(result.simulationResult?.status).toBe(
          SimulationStatus.SYSTEM_DOWN
        );
        expect(result.simulationResult?.description).toBe(
          'Simulation backend unavailable via eth_simulateV1'
        );
        expect(ctx.logger.error).toHaveBeenCalledWith(
          'Error simulating with eth_simulateV1',
          expect.objectContaining({
            errorCode: utils.Logger.errors.SERVER_ERROR,
            errorName: 'Error',
          })
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
            estimatedGasUsed: '140000',
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
          stateOverrides?: ResolvedStateOverride[],
          fundSenderAsset?: string
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

      it('should use executed bundle gas for native input on a supported chain', async () => {
        const quoteSplit = createQuoteSplit(true, {
          calldata: '0xswapCalldata',
          value: '0x0de0b6b3a7640000',
          to: '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD',
        });
        vi.mocked(ethEstimateGasSimulator.ethEstimateGas).mockResolvedValue({
          ...quoteSplit,
          simulationResult: {
            estimatedGasUsed: 119923n,
            estimatedGasUsedInQuoteToken: 2000n,
            estimatedGasUsedInUSD: 3.88,
            status: SimulationStatus.SUCCESS,
          },
        });
        vi.mocked(provider.send).mockResolvedValue([
          {
            calls: [
              ...successBundleResult[0].calls.slice(0, 2),
              {returnData: '0x', logs: [], gasUsed: '117821', status: '0x1'},
            ],
          },
        ]);

        const result = await simulator.simulateTransaction(
          USER_ADDRESS,
          swapOptions,
          quoteSplit,
          ctx,
          undefined,
          12345678
        );

        expect(ethEstimateGasSimulator.ethEstimateGas).not.toHaveBeenCalled();
        expect(provider.send).toHaveBeenCalledWith('eth_simulateV1', [
          {
            blockStateCalls: [
              {
                calls: [
                  expect.any(Object),
                  expect.any(Object),
                  {
                    from: BEACON_CHAIN_DEPOSIT_ADDRESS,
                    to: quoteSplit.swapInfo?.methodParameters?.to,
                    data: '0xswapCalldata',
                    value: '0xde0b6b3a7640000',
                  },
                ],
              },
            ],
          },
          '0xbc614e',
        ]);
        expect(result.simulationResult?.estimatedGasUsed).toBe(117821n);
        expect(result.simulationResult?.status).toBe(SimulationStatus.SUCCESS);
      });

      it('should take the eth_estimateGas fast path for native input without a simulation backend', async () => {
        expect(hasNativeToken(ChainId.ZKSYNC)).toBe(true);
        const unsupportedChainSimulator = new EthSimulateV1Simulator(
          ChainId.ZKSYNC,
          provider,
          gasConverter,
          ethEstimateGasSimulator,
          [ChainId.MAINNET],
          seededProviderFor,
          true
        );
        const quoteSplit = createQuoteSplit(true);
        vi.mocked(ethEstimateGasSimulator.ethEstimateGas).mockResolvedValue(
          quoteSplit
        );

        const result = await unsupportedChainSimulator.simulateTransaction(
          USER_ADDRESS,
          swapOptions,
          quoteSplit,
          ctx
        );

        expect(ethEstimateGasSimulator.ethEstimateGas).toHaveBeenCalledOnce();
        expect(provider.send).not.toHaveBeenCalled();
        expect(result).toBe(quoteSplit);
      });

      it.each([
        ['0x39d35496', SimulationStatus.SLIPPAGE_TOO_LOW],
        ['0x08c379a0', SimulationStatus.FAILED],
      ])(
        'should return native swap revert %s without estimating gas',
        async (data, status) => {
          vi.mocked(provider.send).mockResolvedValue([
            {
              calls: [
                ...successBundleResult[0].calls.slice(0, 2),
                {error: {code: -32000, message: 'execution reverted', data}},
              ],
            },
          ]);

          const result = await simulator.simulateTransaction(
            USER_ADDRESS,
            swapOptions,
            createQuoteSplit(true),
            ctx
          );

          expect(ethEstimateGasSimulator.ethEstimateGas).not.toHaveBeenCalled();
          expect(result.simulationResult?.status).toBe(status);
        }
      );

      it.each([
        SimulationStatus.SUCCESS,
        SimulationStatus.FAILED,
        SimulationStatus.SYSTEM_DOWN,
      ])(
        'should fall back once for a native bundle outage and return estimateGas status %s',
        async status => {
          const quoteSplit = createQuoteSplit(true);
          const estimateResult: QuoteSplit = {
            ...quoteSplit,
            simulationResult: {
              estimatedGasUsed:
                status === SimulationStatus.SUCCESS ? 119923n : 0n,
              estimatedGasUsedInQuoteToken: 0n,
              estimatedGasUsedInUSD: 0,
              status,
            },
          };
          vi.mocked(provider.send).mockRejectedValue(
            Object.assign(new Error('bad gateway'), {
              code: utils.Logger.errors.SERVER_ERROR,
              status: 502,
            })
          );
          vi.mocked(ethEstimateGasSimulator.ethEstimateGas).mockResolvedValue(
            estimateResult
          );

          const result = await simulator.simulateTransaction(
            USER_ADDRESS,
            swapOptions,
            quoteSplit,
            ctx,
            undefined,
            12345678
          );

          expect(provider.send).toHaveBeenCalledOnce();
          expect(
            ethEstimateGasSimulator.ethEstimateGas
          ).toHaveBeenCalledExactlyOnceWith(
            USER_ADDRESS,
            swapOptions,
            quoteSplit,
            ctx,
            12345678
          );
          expect(result).toBe(estimateResult);
          expect(ctx.metrics.count).toHaveBeenCalledWith(
            'UniRpcV2.Simulation.NativeEstimateGasFallback',
            1,
            {
              tags: [
                'chain:1',
                'status:failure',
                'reason:simulation_backend_unavailable',
              ],
            }
          );
        }
      );

      it.each([
        {chainId: ChainId.MAINNET, nativeInput: true, withOverrides: true},
        {chainId: ChainId.MAINNET, nativeInput: false, withOverrides: false},
        {chainId: ChainId.TEMPO, nativeInput: true, withOverrides: false},
      ])(
        'should not use the outage fallback for $chainId with nativeInput=$nativeInput and withOverrides=$withOverrides',
        async ({chainId, nativeInput, withOverrides}) => {
          const guardedSimulator = new EthSimulateV1Simulator(
            chainId,
            provider,
            gasConverter,
            ethEstimateGasSimulator,
            [chainId],
            seededProviderFor,
            true
          );
          mockTokenApproved(guardedSimulator, false);
          vi.mocked(provider.send).mockRejectedValue(
            Object.assign(new Error('bad gateway'), {
              code: utils.Logger.errors.SERVER_ERROR,
              status: 502,
            })
          );

          const result = await guardedSimulator.simulateTransaction(
            USER_ADDRESS,
            {...swapOptions, urVersion: UniversalRouterVersion.V2_0},
            createQuoteSplit(nativeInput),
            ctx,
            undefined,
            undefined,
            withOverrides
              ? [{contractAddress: USDC_ADDRESS, balance: 1000000n}]
              : []
          );

          expect(result.simulationResult?.status).toBe(
            SimulationStatus.SYSTEM_DOWN
          );
          expect(ethEstimateGasSimulator.ethEstimateGas).not.toHaveBeenCalled();
          expect(ctx.metrics.count).not.toHaveBeenCalledWith(
            'UniRpcV2.Simulation.NativeEstimateGasFallback',
            expect.anything(),
            expect.anything()
          );
        }
      );

      it('should still fall back when the fallback counter rejects', async () => {
        const quoteSplit = createQuoteSplit(true);
        vi.mocked(provider.send).mockRejectedValue(
          Object.assign(new Error('bad gateway'), {
            code: utils.Logger.errors.SERVER_ERROR,
            status: 502,
          })
        );
        vi.mocked(ctx.metrics.count).mockImplementation(name =>
          name === 'UniRpcV2.Simulation.NativeEstimateGasFallback'
            ? Promise.reject(new Error('metrics unavailable'))
            : Promise.resolve()
        );
        vi.mocked(ethEstimateGasSimulator.ethEstimateGas).mockResolvedValue(
          quoteSplit
        );

        const result = await simulator.simulateTransaction(
          USER_ADDRESS,
          swapOptions,
          quoteSplit,
          ctx
        );

        expect(result).toBe(quoteSplit);
        expect(provider.send).toHaveBeenCalledOnce();
        expect(ethEstimateGasSimulator.ethEstimateGas).toHaveBeenCalledOnce();
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
        const quoteSplit = createQuoteSplit(false);
        mockTokenApproved(simulator, true);
        vi.mocked(ethEstimateGasSimulator.ethEstimateGas).mockRejectedValue(
          new Error('estimateGas boom')
        );
        vi.mocked(provider.send).mockResolvedValue(successBundleResult);

        const result = await (
          simulator as unknown as SimulateTransaction
        ).simulateTransaction(USER_ADDRESS, swapOptions, quoteSplit, ctx);

        expect(ethEstimateGasSimulator.ethEstimateGas).toHaveBeenCalledOnce();
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
        // A funded, approved ERC-20 reaches the estimateGas fast path,
        // whose throw falls through to the simulateV1 bundle.
        mockTokenApproved(simulator, true);
        vi.spyOn(
          simulator as unknown as {
            checkUserBalance: () => Promise<UserBalanceCheck>;
          },
          'checkUserBalance'
        ).mockResolvedValue(UserBalanceCheck.Sufficient);
        vi.mocked(ethEstimateGasSimulator.ethEstimateGas).mockRejectedValue(
          new Error('estimateGas down')
        );
        const quoteSplit = createQuoteSplit(false);

        const result = await simulator.simulate(
          USER_ADDRESS,
          swapOptions,
          quoteSplit,
          {isNative: false} as never,
          {isNative: false} as never,
          1000000n,
          1000000n,
          ctx
        );

        expect(ethEstimateGasSimulator.ethEstimateGas).toHaveBeenCalledOnce();
        expect(provider.send).toHaveBeenCalledOnce();
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
          [ChainId.MAINNET],
          seededProviderFor,
          true
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

      describe('seeded sender (fundSenderAsset)', () => {
        const okCall = {
          returnData: '0x',
          logs: [],
          gasUsed: '50000',
          status: '0x1',
        };
        const successBundleResult = [
          {
            calls: [
              okCall,
              {...okCall, gasUsed: '60000'},
              {...okCall, gasUsed: '150000'},
            ],
          },
        ];
        const revertBundleResult = [
          {
            calls: [
              okCall,
              okCall,
              {
                error: {
                  code: 3,
                  message: 'execution reverted',
                  data: `0x8b063d73${'0'.repeat(128)}`,
                },
              },
            ],
          },
        ];

        const simulateSeeded = (
          fundSenderAsset: string | undefined,
          tokenInIsNative = false
        ) =>
          simulator.simulateTransaction(
            USER_ADDRESS,
            swapOptions,
            createQuoteSplit(tokenInIsNative),
            ctx,
            undefined,
            undefined,
            undefined,
            fundSenderAsset
          );

        it('runs the bundle on the provider for the asset and skips the fast path', async () => {
          // Approved, so an unseeded run would take the eth_estimateGas fast path
          mockTokenApproved(simulator, true);
          vi.mocked(seededProvider.send).mockResolvedValue(successBundleResult);

          const result = await simulateSeeded(USDC_ADDRESS);

          expect(seededProviderFor).toHaveBeenCalledWith(USDC_ADDRESS);
          expect(seededProvider.send).toHaveBeenCalledWith('eth_simulateV1', [
            expect.anything(),
            'latest',
          ]);
          expect(provider.send).not.toHaveBeenCalled();
          expect(ethEstimateGasSimulator.ethEstimateGas).not.toHaveBeenCalled();
          expect(result.simulationResult?.status).toBe(
            SimulationStatus.SUCCESS
          );
          expect(result.simulationResult?.estimatedGasUsed).toBe(150000n);
          expect(ctx.metrics.count).toHaveBeenCalledWith(
            'UniRpcV2.Simulation.Request',
            1,
            {
              tags: [
                'chain:1',
                'status:success',
                'simType:eth_simulateV1',
                'seeded:true',
              ],
            }
          );
        });

        it('stays on the injected provider without a seed', async () => {
          mockTokenApproved(simulator, true);
          vi.mocked(ethEstimateGasSimulator.ethEstimateGas).mockRejectedValue(
            new Error('estimateGas down')
          );
          vi.mocked(provider.send).mockResolvedValue(successBundleResult);

          await simulateSeeded(undefined);

          expect(seededProviderFor).not.toHaveBeenCalled();
          expect(provider.send).toHaveBeenCalled();
        });

        it('counts a seeded failure and rethrows it unclassified, refusal included', async () => {
          const refusal = await captureEthersRpcError(
            UNIRPC_BALANCE_OVERRIDE_REFUSED,
            rpcProvider =>
              rpcProvider.send('eth_simulateV1', [{blockStateCalls: []}])
          );
          vi.mocked(seededProvider.send).mockRejectedValue(refusal);

          await expect(simulateSeeded(USDC_ADDRESS)).rejects.toBe(refusal);

          expect(ctx.metrics.count).toHaveBeenCalledWith(
            'UniRpcV2.Simulation.Request',
            1,
            {
              tags: [
                'chain:1',
                'status:failure',
                'simType:eth_simulateV1',
                'seeded:true',
              ],
            }
          );
          expect(ctx.logger.error).not.toHaveBeenCalled();
        });

        it('does not fall back to eth_estimateGas for a seeded native input when the backend is down', async () => {
          const outage = await captureEthersRpcError(
            UNIRPC_ALL_PROVIDERS_FAILED,
            rpcProvider =>
              rpcProvider.send('eth_simulateV1', [{blockStateCalls: []}])
          );
          vi.mocked(seededProvider.send).mockRejectedValue(outage);

          await expect(
            simulateSeeded(NATIVE_BALANCE_OVERRIDE_ASSET, true)
          ).rejects.toBe(outage);

          expect(ethEstimateGasSimulator.ethEstimateGas).not.toHaveBeenCalled();
        });

        it('tags a seeded revert seeded:true and logs it at warn', async () => {
          vi.mocked(seededProvider.send).mockResolvedValue(revertBundleResult);

          const result = await simulateSeeded(USDC_ADDRESS);

          expect(result.simulationResult?.status).toBe(
            SimulationStatus.SLIPPAGE_TOO_LOW
          );
          expect(ctx.metrics.count).toHaveBeenCalledWith(
            'UniRpcV2.Simulation.Request',
            1,
            {
              tags: [
                'chain:1',
                'status:failure',
                'simType:eth_simulateV1',
                'seeded:true',
              ],
            }
          );
          expect(ctx.logger.warn).toHaveBeenCalledWith(
            'eth_simulateV1 returned error',
            expect.objectContaining({seeded: true})
          );
          expect(ctx.logger.error).not.toHaveBeenCalled();
        });

        it('keeps a -32602 on an unseeded run as a FAILED simulation', async () => {
          mockTokenApproved(simulator, true);
          vi.mocked(ethEstimateGasSimulator.ethEstimateGas).mockRejectedValue(
            new Error('estimateGas down')
          );
          vi.mocked(provider.send).mockRejectedValue(
            await captureEthersRpcError(
              UNIRPC_BALANCE_OVERRIDE_REFUSED,
              rpcProvider =>
                rpcProvider.send('eth_simulateV1', [{blockStateCalls: []}])
            )
          );

          const result = await simulateSeeded(undefined);

          expect(result.simulationResult?.status).toBe(SimulationStatus.FAILED);
        });
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
        expect(result.simulationResult?.estimatedGasUsed).toBe(150000n);

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
      it('should default to eth_simulateV1 when no rpc method is given', () => {
        const sim = new EthSimulateV1Simulator(
          ChainId.MAINNET,
          provider,
          gasConverter,
          ethEstimateGasSimulator,
          [ChainId.MAINNET],
          seededProviderFor,
          true
        );

        expect(sim).toBeInstanceOf(EthSimulateV1Simulator);
      });
    });
  });
});

// The recorded bundle: [Permit2 approve, router approve, balanceOf, swap, balanceOf]
const RECORDED_CALLS = fixture.blockStateCalls[0].calls;
const RECORDED_RESULT = fixture.response[0];
const SWAP_INDEX = 3;
// The WETH balance the recording funded the sender with. Any override also
// keeps the simulation off the eth_estimateGas fast path, which reads no
// balances, so the bundle runs as it did in the recording.
const [[RECORDED_WETH_TOKEN, RECORDED_WETH_DIFF]] = Object.entries(
  fixture.blockStateCalls[0].stateOverrides
);
const RECORDED_WETH_FUNDING: ResolvedStateOverride = {
  contractAddress: RECORDED_WETH_TOKEN,
  stateDiff: new Map(Object.entries(RECORDED_WETH_DIFF.stateDiff)),
};
const BALANCE_READ_INDEXES = [2, 4];

/** Answers eth_simulateV1 with a recorded response and keeps what it was sent */
class RecordedSimulateProvider extends JsonRpcProvider {
  readonly sent: {method: string; params: unknown[]}[] = [];

  constructor(private readonly response: unknown) {
    super();
  }

  override async send(method: string, params: unknown[]): Promise<unknown> {
    this.sent.push({method, params});
    if (method === 'eth_simulateV1') return this.response;
    throw new Error(`RecordedSimulateProvider got unexpected ${method}`);
  }
}

class EmptyPoolsRepository<
  TPool extends Pool,
> implements IPoolsRepository<TPool> {
  async probePools() {
    return {pools: [], failedProbeCount: 0};
  }
  async getPools() {
    return [];
  }
}

/** Prices gas at zero so the test exercises the simulation, not gas pricing */
class ZeroGasConverter extends GasConverter {
  constructor() {
    super(
      new EmptyPoolsRepository(),
      new EmptyPoolsRepository(),
      new EmptyPoolsRepository()
    );
  }
  override async getGasCostInQuoteTokenBasedOnGasCostInWei(): Promise<bigint> {
    return 0n;
  }
  override getGasCostInUSDBasedOnGasCostInWei(): number {
    return 0;
  }
}

const buildSimulator = (provider: JsonRpcProvider) => {
  const gasConverter = new ZeroGasConverter();
  return new EthSimulateV1Simulator(
    ChainId.ROBINHOOD,
    provider,
    gasConverter,
    new EthEstimateGasSimulator(ChainId.ROBINHOOD, provider, gasConverter),
    [ChainId.ROBINHOOD],
    () => provider,
    false
  );
};

const quoteSplit = new QuoteSplit(
  [
    new QuoteBasic(
      new RouteBasic(Protocol.V3, [], 100),
      BigInt(fixture.quotedAmountOut),
      undefined,
      new GasDetails(1n, 0n, 0, 0n)
    ),
  ],
  new SwapInfo(
    fixture.tokenIn,
    fixture.tokenOut,
    false,
    false,
    BigInt(fixture.amountIn),
    TradeType.ExactIn,
    0,
    {
      calldata: RECORDED_CALLS[SWAP_INDEX].data,
      value: '0x0',
      to: RECORDED_CALLS[SWAP_INDEX].to,
    }
  ),
  undefined,
  new Map([
    [
      fixture.tokenOut,
      new Erc20Token(new Address(fixture.tokenOut), 18, 'ORBIO', 'ORBIO'),
    ],
  ])
);

const swapOptions: SwapOptionsUniversalRouter = {
  type: SwapType.UNIVERSAL_ROUTER,
  urVersion: UniversalRouterVersion.V2_1_2,
  simulate: {fromAddress: fixture.sender},
  recipient: fixture.sender,
  slippageTolerance: new Percent(5, 100),
  tokenTransferMode: TokenTransferMode.Permit2,
};

interface SentCall {
  to: string;
  data: string;
}

function isSentCall(value: unknown): value is SentCall {
  return (
    typeof value === 'object' &&
    value !== null &&
    'to' in value &&
    typeof value.to === 'string' &&
    'data' in value &&
    typeof value.data === 'string'
  );
}

/** The calls of the first eth_simulateV1 block the provider was sent */
function sentCalls(provider: RecordedSimulateProvider): SentCall[] {
  const request = provider.sent.find(({method}) => method === 'eth_simulateV1');
  const [payload] = request?.params ?? [];
  const firstBlock =
    typeof payload === 'object' &&
    payload !== null &&
    'blockStateCalls' in payload &&
    Array.isArray(payload.blockStateCalls)
      ? payload.blockStateCalls[0]
      : undefined;
  const calls: unknown =
    typeof firstBlock === 'object' &&
    firstBlock !== null &&
    'calls' in firstBlock
      ? firstBlock.calls
      : undefined;
  if (!Array.isArray(calls) || !calls.every(isSentCall)) {
    throw new Error('no eth_simulateV1 block of calls was sent');
  }
  return calls;
}

describe('EthSimulateV1Simulator delivery measurement', () => {
  it('brackets the swap with balance reads and reports the recorded KGDS shortfall', async () => {
    const provider = new RecordedSimulateProvider(fixture.response);
    const simulator = buildSimulator(provider);

    const result = await simulator.simulateTransaction(
      fixture.sender,
      {...swapOptions, measureDelivery: true},
      quoteSplit,
      buildTestContext(),
      undefined,
      undefined,
      [RECORDED_WETH_FUNDING]
    );

    expect(provider.sent.map(({method}) => method)).toEqual(['eth_simulateV1']);
    const calls = sentCalls(provider);
    expect(calls.map(call => call.to.toLowerCase())).toEqual(
      RECORDED_CALLS.map(call => call.to.toLowerCase())
    );
    for (const index of BALANCE_READ_INDEXES) {
      expect(calls[index].data).toBe(RECORDED_CALLS[index].data);
    }
    expect(result.simulationResult).toMatchObject({
      status: SimulationStatus.SUCCESS,
      estimatedGasUsed: BigInt(RECORDED_RESULT.calls[SWAP_INDEX].gasUsed),
      delivery: {
        kind: 'measured',
        amount: 7746655602286305109580n,
      },
    });
  });

  it('sends the plain bundle and reports no delivery when the call does not ask to measure', async () => {
    const withoutReads = [
      {
        ...RECORDED_RESULT,
        calls: RECORDED_RESULT.calls.filter(
          (_, index) => !BALANCE_READ_INDEXES.includes(index)
        ),
      },
    ];
    const provider = new RecordedSimulateProvider(withoutReads);
    const simulator = buildSimulator(provider);

    const result = await simulator.simulateTransaction(
      fixture.sender,
      {...swapOptions, measureDelivery: false},
      quoteSplit,
      buildTestContext(),
      undefined,
      undefined,
      [RECORDED_WETH_FUNDING]
    );

    expect(sentCalls(provider)).toHaveLength(3);
    expect(result.simulationResult?.status).toBe(SimulationStatus.SUCCESS);
    expect(result.simulationResult?.delivery).toBeUndefined();
  });

  it('reports an unmeasured delivery when a balance read errors, and keeps the swap result', async () => {
    const readFailed = [
      {
        ...RECORDED_RESULT,
        calls: RECORDED_RESULT.calls.map((call, index) =>
          index === BALANCE_READ_INDEXES[1]
            ? {error: {code: 3, message: 'execution reverted'}}
            : call
        ),
      },
    ];
    const provider = new RecordedSimulateProvider(readFailed);
    const simulator = buildSimulator(provider);

    const result = await simulator.simulateTransaction(
      fixture.sender,
      {...swapOptions, measureDelivery: true},
      quoteSplit,
      buildTestContext(),
      undefined,
      undefined,
      [RECORDED_WETH_FUNDING]
    );

    expect(result.simulationResult).toMatchObject({
      status: SimulationStatus.SUCCESS,
      delivery: {kind: 'unmeasured', reason: 'balance_read_failed'},
    });
  });
});
