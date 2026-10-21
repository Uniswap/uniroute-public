import {describe, beforeEach, it, expect, vi} from 'vitest';
import {JsonRpcProvider} from '@ethersproject/providers';
import {
  Simulator,
  SwapOptionsUniversalRouter,
  SwapType,
} from './simulation-provider';
import {ChainId} from '../../../lib/config';
import {Context} from '@uniswap/lib-uni/context';
import {QuoteSplit} from '../../../models/quote/QuoteSplit';
import {TradeType} from '../../../models/quote/TradeType';
import {ERC20__factory} from '../../../../abis/src/generated/contracts';
import {Permit2__factory} from '../../../../abis/src/generated/contracts';
import {UniversalRouterVersion} from '@uniswap/universal-router-sdk';
import {Percent} from '@uniswap/sdk-core';
import {CurrencyInfo} from '../../../models/currency/CurrencyInfo';
import {Address} from '../../../models/address/Address';
import {BigNumber} from '@ethersproject/bignumber';
import {utils} from 'ethers';
import {SimulationStatus} from '../ISimulator';
import {Contract} from 'ethers';
import {
  captureEthersRpcError,
  NODE_HEADER_NOT_FOUND,
  UNIRPC_ALL_PROVIDERS_FAILED,
  UNIRPC_BALANCE_OVERRIDE_REFUSED,
} from '../../../../tests/test-utils/ethersRpcErrors';
import {ResolvedStateOverride} from '../ResolvedStateOverride';
import {TAG_STATUS_FAILURE, TAG_STATUS_SUCCESS} from '../../../lib/config';
import {
  BalanceOverrideRefusalReason,
  NATIVE_BALANCE_OVERRIDE_ASSET,
} from './balanceOverride';

// Mock the ERC20 and Permit2 factories
vi.mock('../../../../abis/src/generated/contracts', () => ({
  ERC20__factory: {
    connect: vi.fn(),
  },
  Permit2__factory: {
    connect: vi.fn(),
  },
}));

// Create a concrete implementation of Simulator for testing
class TestSimulator extends Simulator {
  private simulationException: Error | undefined;
  private scriptedStatus: SimulationStatus | undefined;
  /** The fundSenderAsset of every simulateTransaction call in order */
  public readonly fundSenderAssets: Array<string | undefined> = [];

  public throwSimulationException(error: Error): void {
    this.simulationException = error;
  }

  /** Makes the next runs answer with this status and no gas */
  public answerWithStatus(status: SimulationStatus): void {
    this.scriptedStatus = status;
  }

  protected supportsSimulation(): boolean {
    return true;
  }

  protected async simulateTransaction(
    fromAddress: string,
    swapOptions: SwapOptionsUniversalRouter,
    quoteSplit: QuoteSplit,
    ctx: Context,
    gasPrice?: bigint,
    blockNumber?: number,
    stateOverrides?: ResolvedStateOverride[],
    fundSenderAsset?: string
  ): Promise<QuoteSplit> {
    this.fundSenderAssets.push(fundSenderAsset);
    if (this.simulationException) {
      throw this.simulationException;
    }
    if (this.scriptedStatus !== undefined) {
      return {
        ...quoteSplit,
        simulationResult: {
          estimatedGasUsed: 0n,
          estimatedGasUsedInQuoteToken: 0n,
          estimatedGasUsedInUSD: 0,
          status: this.scriptedStatus,
          description: `Scripted ${this.scriptedStatus}`,
        },
      };
    }
    ctx.logger.info('Simulating transaction');

    // Check token approval
    const isApproved = await this.checkTokenApproved(
      fromAddress,
      quoteSplit.swapInfo!.tokenInWrappedAddress,
      quoteSplit.swapInfo!.inputAmount,
      swapOptions,
      this.provider,
      ctx
    );

    if (!isApproved) {
      return {
        ...quoteSplit,
        simulationResult: {
          estimatedGasUsed: 0n,
          estimatedGasUsedInQuoteToken: 0n,
          estimatedGasUsedInUSD: 0,
          status: SimulationStatus.NOT_APPROVED,
          description: 'Token not approved',
        },
      };
    }

    return {
      ...quoteSplit,
      simulationResult: {
        estimatedGasUsed: 100n,
        estimatedGasUsedInQuoteToken: 100n,
        estimatedGasUsedInUSD: 0.5,
        status: SimulationStatus.SUCCESS,
        description: 'Test simulation succeeded',
      },
    };
  }
}

describe('Simulator', () => {
  let provider: JsonRpcProvider;
  let simulator: TestSimulator;
  let ctx: Context;
  let mockTokenContract: ReturnType<typeof ERC20__factory.connect>;
  let mockPermit2Contract: ReturnType<typeof Permit2__factory.connect>;

  // Real addresses for testing
  const USDC_ADDRESS = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
  const WETH_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
  const USER_ADDRESS = '0x1234567890123456789012345678901234567890';
  // Sepolia mPerm1 from PERMISSION_TOKENS_BY_CHAIN, adapter and the underlying the wallet holds
  const SEPOLIA_PERMISSIONED_ADAPTER =
    '0xc6f4b10e842d16a35dd49853a9d3f3169442bfd0';
  const SEPOLIA_PERMISSIONED_UNDERLYING =
    '0x3a93b81ab30b45dc2b394144efac142832cc360d';
  // The V4TooLittleReceived selector followed by two zero uint256 arguments
  const V4_TOO_LITTLE_RECEIVED_REVERT_DATA = `0x8b063d73${'0'.repeat(128)}`;

  beforeEach(() => {
    provider = new JsonRpcProvider();
    simulator = new TestSimulator(provider, ChainId.MAINNET, true);
    ctx = {
      logger: {
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      metrics: {count: vi.fn(), dist: vi.fn()},
    } as unknown as Context;

    // Setup mock token contract
    mockTokenContract = {
      balanceOf: vi.fn(),
      allowance: vi
        .fn()
        .mockImplementation(() => Promise.resolve(BigNumber.from(2000))),
    } as unknown as ReturnType<typeof ERC20__factory.connect>;
    vi.mocked(ERC20__factory.connect).mockReturnValue(mockTokenContract);

    // Setup mock permit2 contract
    mockPermit2Contract = {
      allowance: vi.fn().mockImplementation(() => {
        const response = [
          BigNumber.from(2000),
          Number(Math.floor(Date.now() / 1000) + 1000),
          0,
        ] as [BigNumber, number, number] & {
          amount: BigNumber;
          expiration: number;
          nonce: number;
        };
        response.amount = BigNumber.from(2000);
        response.expiration = Number(Math.floor(Date.now() / 1000) + 1000);
        response.nonce = 0;
        return Promise.resolve(response);
      }),
    } as unknown as ReturnType<typeof Permit2__factory.connect>;
    vi.mocked(Permit2__factory.connect).mockReturnValue(mockPermit2Contract);
  });

  describe('simulate', () => {
    const swapOptions: SwapOptionsUniversalRouter = {
      type: SwapType.UNIVERSAL_ROUTER,
      urVersion: UniversalRouterVersion.V1_2,
      simulate: {fromAddress: USER_ADDRESS},
      slippageTolerance: new Percent(5, 100),
    };

    const tokenInCurrencyInfo = new CurrencyInfo(
      false,
      new Address(USDC_ADDRESS)
    );
    const tokenOutCurrencyInfo = new CurrencyInfo(
      false,
      new Address(WETH_ADDRESS)
    );

    const quoteSplit: QuoteSplit = {
      quotes: [],
      swapInfo: {
        tradeType: TradeType.ExactIn,
        tokenInWrappedAddress: USDC_ADDRESS,
        tokenOutWrappedAddress: WETH_ADDRESS,
        tokenInIsNative: false,
        tokenOutIsNative: false,
        inputAmount: 1000n,
        priceImpact: 0.01,
        methodParameters: {
          calldata: '0x',
          value: '0x0',
          to: '0x0',
        },
      },
    };

    it('should simulate when user has sufficient balance', async () => {
      vi.mocked(mockTokenContract.balanceOf).mockResolvedValue(
        BigNumber.from(2000)
      );
      vi.mocked(mockTokenContract.allowance).mockResolvedValue(
        BigNumber.from(2000)
      );
      vi.mocked(mockPermit2Contract.allowance).mockImplementation(() => {
        const response = [
          BigNumber.from(2000),
          Number(Math.floor(Date.now() / 1000) + 1000),
          0,
        ] as [BigNumber, number, number] & {
          amount: BigNumber;
          expiration: number;
          nonce: number;
        };
        response.amount = BigNumber.from(2000);
        response.expiration = Number(Math.floor(Date.now() / 1000) + 1000);
        response.nonce = 0;
        return Promise.resolve(response);
      });

      const result = await simulator.simulate(
        USER_ADDRESS,
        swapOptions,
        quoteSplit,
        tokenInCurrencyInfo,
        tokenOutCurrencyInfo,
        1000n,
        1000n,
        ctx
      );

      expect(result.simulationResult?.status).toBe(SimulationStatus.SUCCESS);
      expect(result.simulationResult?.estimatedGasUsed).toBe(100n);
      // A funded sender simulates against its real state without a seed
      expect(simulator.fundSenderAssets).toEqual([undefined]);
      expect(result.simulationResult?.seeded).toBeUndefined();
      expect(ctx.metrics.count).not.toHaveBeenCalledWith(
        'SimulationSeededBalance',
        expect.anything(),
        expect.anything()
      );
    });

    it('returns SYSTEM_DOWN when the simulator times out', async () => {
      vi.mocked(mockTokenContract.balanceOf).mockResolvedValue(
        BigNumber.from(2000)
      );
      simulator.throwSimulationException(
        Object.assign(new Error('timed out'), {
          code: utils.Logger.errors.TIMEOUT,
        })
      );

      const result = await simulator.simulate(
        USER_ADDRESS,
        swapOptions,
        quoteSplit,
        tokenInCurrencyInfo,
        tokenOutCurrencyInfo,
        1000n,
        1000n,
        ctx
      );

      expect(result.simulationResult?.status).toBe(
        SimulationStatus.SYSTEM_DOWN
      );
      expect(result.simulationResult?.description).toBe(
        'Simulation backend unavailable'
      );
    });

    describe('with an insufficient balance', () => {
      beforeEach(() => {
        vi.mocked(mockTokenContract.balanceOf).mockResolvedValue(
          BigNumber.from(500)
        );
      });

      /** The error ethers throws when unirpc answers a seeded bundle with its refusal */
      const seedRefusedByUnirpc = async () =>
        (await captureEthersRpcError(
          UNIRPC_BALANCE_OVERRIDE_REFUSED,
          rpcProvider =>
            rpcProvider.send('eth_simulateV1', [{blockStateCalls: []}])
        )) as Error;

      const simulateInsufficient = () =>
        simulator.simulate(
          USER_ADDRESS,
          swapOptions,
          quoteSplit,
          tokenInCurrencyInfo,
          tokenOutCurrencyInfo,
          1000n,
          1000n,
          ctx
        );

      it('simulates with tokenIn seeded and reports INSUFFICIENT_BALANCE with the simulated gas', async () => {
        const result = await simulateInsufficient();

        expect(simulator.fundSenderAssets).toEqual([USDC_ADDRESS]);
        expect(result.simulationResult).toEqual({
          estimatedGasUsed: 100n,
          estimatedGasUsedInQuoteToken: 100n,
          estimatedGasUsedInUSD: 0.5,
          status: SimulationStatus.INSUFFICIENT_BALANCE,
          description:
            'Simulation succeeded with a seeded balance; user does not have sufficient balance.',
          seeded: true,
        });
        expect(ctx.metrics.count).toHaveBeenCalledWith(
          'SimulationSeededBalance',
          1,
          {tags: ['chain:1', TAG_STATUS_SUCCESS, 'outcome:SUCCESS']}
        );
      });

      it('seeds the native coin with the zero address off mainnet', async () => {
        const optimismSimulator = new TestSimulator(
          provider,
          ChainId.OPTIMISM,
          true
        );
        vi.spyOn(provider, 'getBalance').mockResolvedValue(BigNumber.from(1));

        const result = await optimismSimulator.simulate(
          USER_ADDRESS,
          swapOptions,
          {
            ...quoteSplit,
            swapInfo: {...quoteSplit.swapInfo!, tokenInIsNative: true},
          },
          new CurrencyInfo(true, new Address(WETH_ADDRESS)),
          tokenOutCurrencyInfo,
          1000n,
          1000n,
          ctx
        );

        expect(optimismSimulator.fundSenderAssets).toEqual([
          NATIVE_BALANCE_OVERRIDE_ASSET,
        ]);
        expect(result.simulationResult?.status).toBe(
          SimulationStatus.INSUFFICIENT_BALANCE
        );
      });

      it('never seeds a mainnet ETH input, which the sim funds from the beacon address', async () => {
        const getBalanceSpy = vi.spyOn(provider, 'getBalance');

        const result = await simulator.simulate(
          USER_ADDRESS,
          swapOptions,
          {
            ...quoteSplit,
            swapInfo: {...quoteSplit.swapInfo!, tokenInIsNative: true},
          },
          new CurrencyInfo(true, new Address(WETH_ADDRESS)),
          tokenOutCurrencyInfo,
          1000n,
          1000n,
          ctx
        );

        expect(getBalanceSpy).not.toHaveBeenCalled();
        expect(simulator.fundSenderAssets).toEqual([undefined]);
        expect(result.simulationResult?.status).toBe(SimulationStatus.SUCCESS);
      });

      it.each([
        SimulationStatus.FAILED,
        SimulationStatus.SLIPPAGE_TOO_LOW,
        SimulationStatus.TRANSFER_FROM_FAILED,
      ])('reports a seeded run that reverted as %s', async status => {
        simulator.answerWithStatus(status);

        const result = await simulateInsufficient();

        expect(result.simulationResult?.status).toBe(status);
        expect(ctx.metrics.count).toHaveBeenCalledWith(
          'SimulationSeededBalance',
          1,
          {tags: ['chain:1', TAG_STATUS_SUCCESS, `outcome:${status}`]}
        );
      });

      it.each([SimulationStatus.NOT_SUPPORTED, SimulationStatus.SYSTEM_DOWN])(
        'passes through a seeded run that never executed (%s) and counts it as a failure',
        async status => {
          simulator.answerWithStatus(status);

          const result = await simulateInsufficient();

          expect(result.simulationResult?.status).toBe(status);
          expect(ctx.metrics.count).toHaveBeenCalledWith(
            'SimulationSeededBalance',
            1,
            {tags: ['chain:1', TAG_STATUS_FAILURE, `reason:${status}`]}
          );
        }
      );

      it('reports NOT_SUPPORTED without gas when unirpc refuses the seed', async () => {
        simulator.throwSimulationException(await seedRefusedByUnirpc());

        const result = await simulateInsufficient();

        expect(result.simulationResult).toEqual({
          estimatedGasUsed: 0n,
          estimatedGasUsedInQuoteToken: 0n,
          estimatedGasUsedInUSD: 0,
          status: SimulationStatus.NOT_SUPPORTED,
          description:
            'User does not have sufficient balance and the simulation could not seed it.',
          seeded: true,
        });
        expect(ctx.metrics.count).toHaveBeenCalledWith(
          'SimulationSeededBalance',
          1,
          {
            tags: [
              'chain:1',
              TAG_STATUS_FAILURE,
              `reason:${BalanceOverrideRefusalReason.REFUSED}`,
            ],
          }
        );
        expect(ctx.logger.warn).toHaveBeenCalledWith(
          'Balance override refused; simulation not supported',
          {
            reason: BalanceOverrideRefusalReason.REFUSED,
            upstreamMessage: 'balance override is not available for this token',
          }
        );
        expect(ctx.logger.error).not.toHaveBeenCalled();
      });

      it('seeds the underlying of a permissioned token, which the bundle pulls', async () => {
        const sepoliaSimulator = new TestSimulator(
          provider,
          ChainId.SEPOLIA,
          true
        );

        const result = await sepoliaSimulator.simulate(
          USER_ADDRESS,
          swapOptions,
          {
            ...quoteSplit,
            swapInfo: {
              ...quoteSplit.swapInfo!,
              tokenInWrappedAddress: SEPOLIA_PERMISSIONED_ADAPTER,
            },
          },
          new CurrencyInfo(false, new Address(SEPOLIA_PERMISSIONED_ADAPTER)),
          tokenOutCurrencyInfo,
          1000n,
          1000n,
          ctx
        );

        expect(sepoliaSimulator.fundSenderAssets).toEqual([
          SEPOLIA_PERMISSIONED_UNDERLYING,
        ]);
        expect(result.simulationResult?.status).toBe(
          SimulationStatus.INSUFFICIENT_BALANCE
        );
      });

      it('keeps the plain INSUFFICIENT_BALANCE answer when seeding is disabled', async () => {
        const disabledSimulator = new TestSimulator(
          provider,
          ChainId.MAINNET,
          false
        );

        const result = await disabledSimulator.simulate(
          USER_ADDRESS,
          swapOptions,
          quoteSplit,
          tokenInCurrencyInfo,
          tokenOutCurrencyInfo,
          1000n,
          1000n,
          ctx
        );

        expect(disabledSimulator.fundSenderAssets).toEqual([]);
        expect(result.simulationResult).toEqual({
          estimatedGasUsed: 0n,
          estimatedGasUsedInQuoteToken: 0n,
          estimatedGasUsedInUSD: 0,
          status: SimulationStatus.INSUFFICIENT_BALANCE,
          description: 'User does not have sufficient balance to simulate.',
        });
        expect(ctx.metrics.count).toHaveBeenCalledWith(
          'SimulationSeededBalanceSkipped',
          1,
          {tags: ['chain:1', 'reason:disabled']}
        );
      });

      it('keeps the plain INSUFFICIENT_BALANCE answer on a chain without a simulation backend', async () => {
        class UnsupportedChainSimulator extends TestSimulator {
          protected supportsSimulation(): boolean {
            return false;
          }
        }
        const unsupportedSimulator = new UnsupportedChainSimulator(
          provider,
          ChainId.MAINNET,
          true
        );

        const result = await unsupportedSimulator.simulate(
          USER_ADDRESS,
          swapOptions,
          quoteSplit,
          tokenInCurrencyInfo,
          tokenOutCurrencyInfo,
          1000n,
          1000n,
          ctx
        );

        expect(unsupportedSimulator.fundSenderAssets).toEqual([]);
        expect(result.simulationResult?.status).toBe(
          SimulationStatus.INSUFFICIENT_BALANCE
        );
        expect(result.simulationResult?.seeded).toBeUndefined();
        expect(ctx.metrics.count).toHaveBeenCalledWith(
          'SimulationSeededBalanceSkipped',
          1,
          {tags: ['chain:1', 'reason:chain_unsupported']}
        );
      });

      it.each([
        [
          'a throw after the run',
          async () => new Error('gas conversion failed'),
        ],
        [
          'a node error that is not a revert',
          () =>
            captureEthersRpcError(NODE_HEADER_NOT_FOUND, rpcProvider =>
              rpcProvider.send('eth_simulateV1', [{blockStateCalls: []}])
            ),
        ],
      ])(
        'answers INSUFFICIENT_BALANCE and logs at warn when the seeded run throws without revert data (%s)',
        async (_label, makeError) => {
          simulator.throwSimulationException((await makeError()) as Error);

          const result = await simulateInsufficient();

          expect(result.simulationResult).toEqual({
            estimatedGasUsed: 0n,
            estimatedGasUsedInQuoteToken: 0n,
            estimatedGasUsedInUSD: 0,
            status: SimulationStatus.INSUFFICIENT_BALANCE,
            description: 'User does not have sufficient balance to simulate.',
            seeded: true,
          });
          expect(ctx.metrics.count).toHaveBeenCalledWith(
            'SimulationSeededBalance',
            1,
            {tags: ['chain:1', TAG_STATUS_FAILURE, 'reason:exception']}
          );
          expect(ctx.logger.warn).toHaveBeenCalledWith(
            'Seeded simulation threw before executing; route unverified',
            expect.anything()
          );
          expect(ctx.logger.error).not.toHaveBeenCalled();
        }
      );

      it('reports a seeded run that threw with revert data as that revert', async () => {
        simulator.throwSimulationException(
          Object.assign(new Error('call revert exception'), {
            data: V4_TOO_LITTLE_RECEIVED_REVERT_DATA,
          })
        );

        const result = await simulateInsufficient();

        expect(result.simulationResult?.status).toBe(
          SimulationStatus.SLIPPAGE_TOO_LOW
        );
        expect(result.simulationResult?.seeded).toBe(true);
        expect(ctx.metrics.count).toHaveBeenCalledWith(
          'SimulationSeededBalance',
          1,
          {
            tags: [
              'chain:1',
              TAG_STATUS_SUCCESS,
              `outcome:${SimulationStatus.SLIPPAGE_TOO_LOW}`,
            ],
          }
        );
      });

      it('still answers when the metrics sink rejects', async () => {
        vi.mocked(ctx.metrics.count).mockRejectedValue(
          new Error('statsd down')
        );
        simulator.throwSimulationException(await seedRefusedByUnirpc());

        const result = await simulateInsufficient();

        expect(result.simulationResult?.status).toBe(
          SimulationStatus.NOT_SUPPORTED
        );
      });

      it('reports a seeded run that could not reach the backend as SYSTEM_DOWN', async () => {
        simulator.throwSimulationException(
          Object.assign(new Error('timed out'), {
            code: utils.Logger.errors.TIMEOUT,
          })
        );

        const result = await simulateInsufficient();

        expect(result.simulationResult?.status).toBe(
          SimulationStatus.SYSTEM_DOWN
        );
        expect(ctx.metrics.count).toHaveBeenCalledWith(
          'SimulationSeededBalance',
          1,
          {
            tags: [
              'chain:1',
              TAG_STATUS_FAILURE,
              `reason:${SimulationStatus.SYSTEM_DOWN}`,
            ],
          }
        );
      });
    });

    it('should not simulate when token is not approved', async () => {
      vi.mocked(mockTokenContract.balanceOf).mockResolvedValue(
        BigNumber.from(2000)
      );
      vi.mocked(mockTokenContract.allowance).mockResolvedValue(
        BigNumber.from(0)
      );
      vi.mocked(mockPermit2Contract.allowance).mockImplementation(() => {
        const response = [
          BigNumber.from(0),
          Number(Math.floor(Date.now() / 1000) + 1000),
          0,
        ] as [BigNumber, number, number] & {
          amount: BigNumber;
          expiration: number;
          nonce: number;
        };
        response.amount = BigNumber.from(0);
        response.expiration = Number(Math.floor(Date.now() / 1000) + 1000);
        response.nonce = 0;
        return Promise.resolve(response);
      });

      const result = await simulator.simulate(
        USER_ADDRESS,
        swapOptions,
        quoteSplit,
        tokenInCurrencyInfo,
        tokenOutCurrencyInfo,
        1000n,
        1000n,
        ctx
      );

      expect(result.simulationResult?.status).toBe(
        SimulationStatus.NOT_APPROVED
      );
    });

    it('should handle native token balance check', async () => {
      // Create a new simulator with a non-mainnet chain ID
      const nonMainnetSimulator = new TestSimulator(
        provider,
        ChainId.OPTIMISM,
        true
      );

      const nativeQuoteSplit = {
        ...quoteSplit,
        swapInfo: {
          ...quoteSplit.swapInfo!,
          tokenInIsNative: true,
          tradeType: TradeType.ExactIn,
        },
      };

      const nativeTokenInCurrencyInfo = new CurrencyInfo(
        true,
        new Address(WETH_ADDRESS)
      );

      // Mock getBalance to return sufficient balance
      vi.mocked(mockTokenContract.allowance).mockResolvedValue(
        BigNumber.from(2000)
      );
      const getBalanceSpy = vi
        .spyOn(provider, 'getBalance')
        .mockResolvedValue(BigNumber.from(2000));

      const result = await nonMainnetSimulator.simulate(
        USER_ADDRESS,
        swapOptions,
        nativeQuoteSplit,
        nativeTokenInCurrencyInfo,
        tokenOutCurrencyInfo,
        1000n,
        1000n,
        ctx
      );

      expect(result.simulationResult?.status).toBe(SimulationStatus.SUCCESS);
      expect(getBalanceSpy).toHaveBeenCalledWith(USER_ADDRESS);
    });

    it('skips the live ERC-20 balance check when an override has a matching balanceTarget on tokenIn', async () => {
      const balanceOfSpy = vi.mocked(mockTokenContract.balanceOf);
      // Live check would say 0 → INSUFFICIENT_BALANCE; overrides must rescue it.
      balanceOfSpy.mockResolvedValue(BigNumber.from(0));
      vi.mocked(mockTokenContract.allowance).mockResolvedValue(
        BigNumber.from(2000)
      );

      const metricsCtx = {
        logger: ctx.logger,
        metrics: {count: vi.fn(), dist: vi.fn()},
      } as unknown as Context;

      const result = await simulator.simulate(
        USER_ADDRESS,
        swapOptions,
        quoteSplit,
        tokenInCurrencyInfo,
        tokenOutCurrencyInfo,
        1000n,
        1000n,
        metricsCtx,
        undefined,
        undefined,
        [
          {
            contractAddress: USDC_ADDRESS,
            stateDiff: new Map([
              [
                '0x0000000000000000000000000000000000000000000000000000000000000001',
                '0x0000000000000000000000000000000000000000000000000000000000000064',
              ],
            ]),
            balanceTarget: {account: USER_ADDRESS, amount: 5000n},
          },
        ]
      );

      expect(result.simulationResult?.status).toBe(SimulationStatus.SUCCESS);
      expect(balanceOfSpy).not.toHaveBeenCalled();
      expect(metricsCtx.metrics.count).toHaveBeenCalledWith(
        'SimulationBalanceCheckSkipped',
        1,
        expect.objectContaining({tags: ['chain:1']})
      );
    });

    it('still runs the live balance check when overrides do not cover (from, tokenIn)', async () => {
      vi.mocked(mockTokenContract.balanceOf).mockResolvedValue(
        BigNumber.from(0)
      );

      const metricsCtx = {
        logger: ctx.logger,
        metrics: {count: vi.fn(), dist: vi.fn()},
      } as unknown as Context;

      const result = await simulator.simulate(
        USER_ADDRESS,
        swapOptions,
        quoteSplit,
        tokenInCurrencyInfo,
        tokenOutCurrencyInfo,
        1000n,
        1000n,
        metricsCtx,
        undefined,
        undefined,
        [
          {
            contractAddress: '0x9999999999999999999999999999999999999999',
            stateDiff: new Map([
              [
                '0x0000000000000000000000000000000000000000000000000000000000000001',
                '0x0000000000000000000000000000000000000000000000000000000000000064',
              ],
            ]),
            balanceTarget: {account: USER_ADDRESS, amount: 5000n},
          },
        ]
      );

      expect(result.simulationResult?.status).toBe(
        SimulationStatus.INSUFFICIENT_BALANCE
      );
      expect(metricsCtx.metrics.count).not.toHaveBeenCalledWith(
        'SimulationBalanceCheckSkipped',
        expect.anything(),
        expect.anything()
      );
    });

    it('does NOT skip the live balance check for a bare RawStateOverride on tokenIn (no balanceTarget)', async () => {
      const balanceOfSpy = vi.mocked(mockTokenContract.balanceOf);
      balanceOfSpy.mockResolvedValue(BigNumber.from(0));

      const metricsCtx = {
        logger: ctx.logger,
        metrics: {count: vi.fn(), dist: vi.fn()},
      } as unknown as Context;

      const result = await simulator.simulate(
        USER_ADDRESS,
        swapOptions,
        quoteSplit,
        tokenInCurrencyInfo,
        tokenOutCurrencyInfo,
        1000n,
        1000n,
        metricsCtx,
        undefined,
        undefined,
        [
          {
            contractAddress: USDC_ADDRESS,
            // stateDiff on tokenIn but NO balanceTarget — e.g. a RawStateOverride
            // touching an allowance/totalSupply slot. Must not suppress the live check.
            stateDiff: new Map([
              [
                '0x0000000000000000000000000000000000000000000000000000000000000007',
                '0x0000000000000000000000000000000000000000000000000000000000000064',
              ],
            ]),
          },
        ]
      );

      expect(result.simulationResult?.status).toBe(
        SimulationStatus.INSUFFICIENT_BALANCE
      );
      expect(balanceOfSpy).toHaveBeenCalled();
    });

    // Duplicate same-slot writes are rejected upstream at the BL via
    // `detectDuplicateResolvedWrites` (covered in StateOverrideResolver
    // tests), so the simulator never sees colliding bundles. No
    // simulator-side conflict test is needed.

    it('DOES skip when other overrides on the same contract touch only codeOverride or unrelated slots', async () => {
      const balanceOfSpy = vi.mocked(mockTokenContract.balanceOf);
      balanceOfSpy.mockResolvedValue(BigNumber.from(0));
      vi.mocked(mockTokenContract.allowance).mockResolvedValue(
        BigNumber.from(2000)
      );

      const metricsCtx = {
        logger: ctx.logger,
        metrics: {count: vi.fn(), dist: vi.fn()},
      } as unknown as Context;

      const balanceSlot =
        '0x0000000000000000000000000000000000000000000000000000000000000001';
      const result = await simulator.simulate(
        USER_ADDRESS,
        swapOptions,
        quoteSplit,
        tokenInCurrencyInfo,
        tokenOutCurrencyInfo,
        1000n,
        1000n,
        metricsCtx,
        undefined,
        undefined,
        [
          {
            contractAddress: USDC_ADDRESS,
            stateDiff: new Map([
              [
                balanceSlot,
                '0x0000000000000000000000000000000000000000000000000000000000001388',
              ],
            ]),
            balanceTarget: {
              account: USER_ADDRESS,
              amount: 5000n,
              slot: balanceSlot,
            },
          },
          {
            // Same contract, but ONLY a codeOverride — doesn't touch storage.
            contractAddress: USDC_ADDRESS,
            codeOverride: '0xdead',
          },
          {
            // Same contract, stateDiff but DIFFERENT slot (e.g. allowance).
            contractAddress: USDC_ADDRESS,
            stateDiff: new Map([
              [
                '0x000000000000000000000000000000000000000000000000000000000000beef',
                '0x000000000000000000000000000000000000000000000000000000000000cafe',
              ],
            ]),
          },
        ]
      );

      expect(result.simulationResult?.status).toBe(SimulationStatus.SUCCESS);
      expect(balanceOfSpy).not.toHaveBeenCalled();
      expect(metricsCtx.metrics.count).toHaveBeenCalledWith(
        'SimulationBalanceCheckSkipped',
        1,
        expect.objectContaining({tags: ['chain:1']})
      );
    });

    it('returns INSUFFICIENT_BALANCE directly when balanceTarget amount is below needed (no live check, no sim)', async () => {
      // An authoritative override below the needed amount is answered as is, the live balance is not read and nothing is seeded
      const balanceOfSpy = vi.mocked(mockTokenContract.balanceOf);
      balanceOfSpy.mockResolvedValue(BigNumber.from(99999)); // live would say plenty

      const metricsCtx = {
        logger: ctx.logger,
        metrics: {count: vi.fn(), dist: vi.fn()},
      } as unknown as Context;

      const result = await simulator.simulate(
        USER_ADDRESS,
        swapOptions,
        quoteSplit,
        tokenInCurrencyInfo,
        tokenOutCurrencyInfo,
        1000n,
        1000n,
        metricsCtx,
        undefined,
        undefined,
        [
          {
            contractAddress: USDC_ADDRESS,
            stateDiff: new Map([
              [
                '0x0000000000000000000000000000000000000000000000000000000000000001',
                '0x0000000000000000000000000000000000000000000000000000000000000001',
              ],
            ]),
            balanceTarget: {
              account: USER_ADDRESS,
              amount: 1n,
              slot: '0x0000000000000000000000000000000000000000000000000000000000000001',
            }, // < 1000
          },
        ]
      );

      expect(result.simulationResult).toEqual({
        estimatedGasUsed: 0n,
        estimatedGasUsedInQuoteToken: 0n,
        estimatedGasUsedInUSD: 0,
        status: SimulationStatus.INSUFFICIENT_BALANCE,
        description: 'State override sets account balance below needed amount.',
      });
      expect(simulator.fundSenderAssets).toEqual([]);
      expect(metricsCtx.metrics.count).toHaveBeenCalledWith(
        'SimulationSeededBalanceSkipped',
        1,
        {tags: ['chain:1', 'reason:override_insufficient']}
      );
      // Live RPC should NOT have been consulted — override is authoritative.
      expect(balanceOfSpy).not.toHaveBeenCalled();
    });

    it('returns SYSTEM_DOWN when the balance read cannot reach the RPC backend', async () => {
      const balanceReadOutage = await captureEthersRpcError(
        UNIRPC_ALL_PROVIDERS_FAILED,
        rpcProvider =>
          new Contract(
            USDC_ADDRESS,
            ['function balanceOf(address) view returns (uint256)'],
            rpcProvider
          ).balanceOf(USER_ADDRESS)
      );
      vi.mocked(mockTokenContract.balanceOf).mockRejectedValue(
        balanceReadOutage
      );

      const result = await simulator.simulate(
        USER_ADDRESS,
        swapOptions,
        quoteSplit,
        tokenInCurrencyInfo,
        tokenOutCurrencyInfo,
        1000n,
        1000n,
        ctx
      );

      expect(result.simulationResult?.status).toBe(
        SimulationStatus.SYSTEM_DOWN
      );
      expect(result.simulationResult?.description).toBe(
        'Simulation backend unavailable during balance check'
      );
    });

    it('should handle errors during balance check', async () => {
      vi.mocked(mockTokenContract.balanceOf).mockRejectedValue(
        new Error('Balance check failed')
      );

      const result = await simulator.simulate(
        USER_ADDRESS,
        swapOptions,
        quoteSplit,
        tokenInCurrencyInfo,
        tokenOutCurrencyInfo,
        1000n,
        1000n,
        ctx
      );

      expect(result.simulationResult?.status).toBe(
        SimulationStatus.INSUFFICIENT_BALANCE
      );
      // A read error says nothing about the wallet, so nothing is seeded on it
      expect(simulator.fundSenderAssets).toEqual([]);
      expect(ctx.metrics.count).toHaveBeenCalledWith(
        'SimulationSeededBalanceSkipped',
        1,
        {tags: ['chain:1', 'reason:balance_unknown']}
      );
      expect(ctx.logger.error).toHaveBeenCalled();
    });
  });
});
