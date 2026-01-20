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
import {SimulationStatus} from '../ISimulator';

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
  protected async simulateTransaction(
    fromAddress: string,
    swapOptions: SwapOptionsUniversalRouter,
    quoteSplit: QuoteSplit,
    ctx: Context,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    gasPrice?: bigint,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    blockNumber?: number
  ): Promise<QuoteSplit> {
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

  beforeEach(() => {
    provider = new JsonRpcProvider();
    simulator = new TestSimulator(provider, ChainId.MAINNET);
    ctx = {
      logger: {
        info: vi.fn(),
        error: vi.fn(),
      },
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
      version: UniversalRouterVersion.V1_2,
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
    });

    it('should not simulate when user has insufficient balance', async () => {
      vi.mocked(mockTokenContract.balanceOf).mockResolvedValue(
        BigNumber.from(500)
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
      const nonMainnetSimulator = new TestSimulator(provider, ChainId.OPTIMISM);

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
      expect(ctx.logger.error).toHaveBeenCalled();
    });
  });
});
