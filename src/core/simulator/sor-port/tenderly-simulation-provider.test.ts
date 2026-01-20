import {describe, beforeEach, it, expect, vi, afterEach} from 'vitest';
import {JsonRpcProvider} from '@ethersproject/providers';
import axios from 'axios';
import {
  TenderlySimulator,
  FallbackTenderlySimulator,
  TENDERLY_NOT_SUPPORTED_CHAINS,
  TENDERLY_SIMULATION_API_ONLY_CHAINS,
  TenderlyResponseEstimateGasBundle,
  TenderlyResponseUniversalRouter,
  GasBody,
} from './tenderly-simulation-provider';
import {SwapOptionsUniversalRouter, SwapType} from './simulation-provider';
import {EthEstimateGasSimulator} from './eth-estimate-gas-provider';
import {ChainId} from '../../../lib/config';
import {Context} from '@uniswap/lib-uni/context';
import {QuoteSplit} from '../../../models/quote/QuoteSplit';
import {TradeType} from '../../../models/quote/TradeType';
import {GasConverter} from '../../gas/converter/GasConverter';
import {UniversalRouterVersion} from '@uniswap/universal-router-sdk';
import {Percent} from '@uniswap/sdk-core';
import {SimulationStatus} from '../ISimulator';
import {Erc20Token} from '../../../models/token/Erc20Token';
import {UniProtocol} from 'src/models/pool/UniProtocol';
import {RouteBasic} from 'src/models/route/RouteBasic';
import {GasDetails} from 'src/models/gas/GasDetails';
import {Address} from 'src/models/address/Address';
import {MethodParameters} from 'src/lib/methodParameters';

// Mock axios
vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => ({
      post: vi.fn(),
    })),
  },
}));

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

// Mock the breakDownTenderlySimulationError function
vi.mock('./tenderlySimulationErrorBreakDown', () => ({
  breakDownTenderlySimulationError: vi.fn(() => SimulationStatus.FAILED),
}));

describe('tenderly-simulation-provider', () => {
  describe('Constants', () => {
    it('TENDERLY_NOT_SUPPORTED_CHAINS should contain expected chains', () => {
      expect(TENDERLY_NOT_SUPPORTED_CHAINS).toContain(ChainId.CELO);
      expect(TENDERLY_NOT_SUPPORTED_CHAINS).toContain(ChainId.ZKSYNC);
      expect(TENDERLY_NOT_SUPPORTED_CHAINS).toContain(ChainId.BNB);
      expect(TENDERLY_NOT_SUPPORTED_CHAINS).toContain(ChainId.ZORA);
      expect(TENDERLY_NOT_SUPPORTED_CHAINS).toContain(ChainId.MONAD_TESTNET);
    });

    it('TENDERLY_SIMULATION_API_ONLY_CHAINS should contain XLayer', () => {
      expect(TENDERLY_SIMULATION_API_ONLY_CHAINS).toContain(ChainId.XLAYER);
      expect(TENDERLY_SIMULATION_API_ONLY_CHAINS).toHaveLength(1);
    });
  });

  describe('TenderlySimulator', () => {
    let provider: JsonRpcProvider;
    let gasConverter: GasConverter;
    let simulator: TenderlySimulator;
    let ctx: Context;
    let mockAxiosInstance: {post: ReturnType<typeof vi.fn>};

    const USDC_ADDRESS = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
    const WETH_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
    const USER_ADDRESS = '0x1234567890123456789012345678901234567890';

    const createQuoteSplit = (
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      chainId: ChainId = ChainId.MAINNET,
      tokenInIsNative = false,
      methodParameters: MethodParameters = {
        calldata: '0xswapCalldata',
        value: '0x0',
        to: '0x0',
      }
    ): QuoteSplit => ({
      quotes: [
        {
          route: new RouteBasic(UniProtocol.V3, [], 100),
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
      version: UniversalRouterVersion.V1_2,
      simulate: {fromAddress: USER_ADDRESS},
      slippageTolerance: new Percent(5, 100),
    };

    beforeEach(() => {
      provider = new JsonRpcProvider();
      gasConverter = {
        getGasCostInQuoteTokenBasedOnGasCostInWei: vi
          .fn()
          .mockResolvedValue(1000n),
      } as unknown as GasConverter;

      mockAxiosInstance = {
        post: vi.fn(),
      };
      vi.mocked(axios.create).mockReturnValue(
        mockAxiosInstance as unknown as ReturnType<typeof axios.create>
      );

      ctx = {
        logger: {
          info: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        },
        metrics: {
          timer: vi.fn(),
          count: vi.fn(),
        },
      } as unknown as Context;
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    describe('formatGasPriceForTenderly', () => {
      it('should return undefined for undefined gasPrice', () => {
        // Access private static method via class
        const result = (
          TenderlySimulator as unknown as {
            formatGasPriceForTenderly: (
              gasPrice?: bigint
            ) => string | undefined;
          }
        ).formatGasPriceForTenderly(undefined);

        expect(result).toBeUndefined();
      });

      it('should return undefined for zero gasPrice', () => {
        const result = (
          TenderlySimulator as unknown as {
            formatGasPriceForTenderly: (
              gasPrice?: bigint
            ) => string | undefined;
          }
        ).formatGasPriceForTenderly(0n);

        expect(result).toBeUndefined();
      });

      it('should return undefined for negative gasPrice', () => {
        const result = (
          TenderlySimulator as unknown as {
            formatGasPriceForTenderly: (
              gasPrice?: bigint
            ) => string | undefined;
          }
        ).formatGasPriceForTenderly(-1n);

        expect(result).toBeUndefined();
      });

      it('should format positive gasPrice as hex string', () => {
        const result = (
          TenderlySimulator as unknown as {
            formatGasPriceForTenderly: (
              gasPrice?: bigint
            ) => string | undefined;
          }
        ).formatGasPriceForTenderly(50000000000n);

        expect(result).toBe('0xba43b7400');
      });
    });

    describe('simulateTransaction with Node API', () => {
      beforeEach(() => {
        simulator = new TenderlySimulator(
          ChainId.MAINNET,
          'test-node-api-key',
          gasConverter,
          provider,
          undefined,
          2500,
          'https://api.tenderly.co',
          'test-user',
          'test-project',
          'test-access-key'
        );
      });

      it('should return NOT_SUPPORTED for unsupported chains', async () => {
        const celoSimulator = new TenderlySimulator(
          ChainId.CELO,
          'test-node-api-key',
          gasConverter,
          provider
        );

        const quoteSplit = createQuoteSplit(ChainId.CELO);
        const result = await celoSimulator.simulateTransaction(
          USER_ADDRESS,
          swapOptions,
          quoteSplit,
          ctx
        );

        expect(result.simulationResult?.status).toBe(
          SimulationStatus.NOT_SUPPORTED
        );
      });

      it('should throw error when no calldata provided', async () => {
        const quoteSplit: QuoteSplit = {
          quotes: [
            {
              route: new RouteBasic(UniProtocol.V3, [], 100),
              amount: 1000000n,
              gasDetails: new GasDetails(50000000000n, 150000n, 0.001, 150000n),
            },
          ],
          swapInfo: {
            tradeType: TradeType.ExactIn,
            tokenInWrappedAddress: USDC_ADDRESS,
            tokenOutWrappedAddress: WETH_ADDRESS,
            tokenInIsNative: false,
            tokenOutIsNative: false,
            inputAmount: 1000000n,
            priceImpact: 0.01,
            methodParameters: undefined,
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
        };

        await expect(
          simulator.simulateTransaction(
            USER_ADDRESS,
            swapOptions,
            quoteSplit,
            ctx
          )
        ).rejects.toThrow('No calldata provided to simulate transaction');
      });

      it('should successfully simulate via Node API', async () => {
        const mockResponse: TenderlyResponseEstimateGasBundle = {
          id: 1,
          jsonrpc: '2.0',
          result: [
            {gas: '50000', gasUsed: '45000'} as GasBody,
            {gas: '60000', gasUsed: '55000'} as GasBody,
            {gas: '150000', gasUsed: '140000'} as GasBody,
          ],
        };

        mockAxiosInstance.post.mockResolvedValue({
          data: mockResponse,
          status: 200,
        });

        const quoteSplit = createQuoteSplit();
        const result = await simulator.simulateTransaction(
          USER_ADDRESS,
          swapOptions,
          quoteSplit,
          ctx
        );

        expect(result.simulationResult?.status).toBe(SimulationStatus.SUCCESS);
        expect(result.simulationResult?.estimatedGasUsed).toBe(195000n); // 150000 * 1.3
        expect(ctx.metrics.timer).toHaveBeenCalledWith(
          'Tenderly.Simulation.Latency',
          expect.any(Number),
          {tags: ['chain:1', 'simType:Node']}
        );
        expect(ctx.metrics.count).toHaveBeenCalledWith(
          'Tenderly.Simulation.Request',
          1,
          {
            tags: [
              'chain:1',
              'http_status:200',
              'status:success',
              'simType:Node',
            ],
          }
        );
      });

      it('should return FAILED when Node API response is invalid', async () => {
        mockAxiosInstance.post.mockResolvedValue({
          data: {id: 1, jsonrpc: '2.0', result: []},
          status: 200,
        });

        const quoteSplit = createQuoteSplit();
        const result = await simulator.simulateTransaction(
          USER_ADDRESS,
          swapOptions,
          quoteSplit,
          ctx
        );

        expect(result.simulationResult?.status).toBe(SimulationStatus.FAILED);
        expect(ctx.logger.error).toHaveBeenCalled();
      });

      it('should return FAILED when Node API returns error in result', async () => {
        const mockResponse: TenderlyResponseEstimateGasBundle = {
          id: 1,
          jsonrpc: '2.0',
          result: [
            {gas: '50000', gasUsed: '45000'} as GasBody,
            {gas: '60000', gasUsed: '55000'} as GasBody,
            {
              error: {
                code: -32000,
                message: 'execution reverted',
                data: '0x08c379a0...',
              },
            },
          ],
        };

        mockAxiosInstance.post.mockResolvedValue({
          data: mockResponse,
          status: 200,
        });

        const quoteSplit = createQuoteSplit();
        const result = await simulator.simulateTransaction(
          USER_ADDRESS,
          swapOptions,
          quoteSplit,
          ctx
        );

        expect(result.simulationResult?.status).toBe(SimulationStatus.FAILED);
      });

      it('should throw error for unsupported swap type', async () => {
        const quoteSplit = createQuoteSplit();
        const invalidSwapOptions = {
          ...swapOptions,
          type: 'INVALID_TYPE',
        } as unknown as SwapOptionsUniversalRouter;

        await expect(
          simulator.simulateTransaction(
            USER_ADDRESS,
            invalidSwapOptions,
            quoteSplit,
            ctx
          )
        ).rejects.toThrow('Unsupported swap type');
      });
    });

    describe('simulateTransaction with Simulation API (XLayer)', () => {
      beforeEach(() => {
        simulator = new TenderlySimulator(
          ChainId.XLAYER,
          'test-node-api-key',
          gasConverter,
          provider,
          undefined,
          2500,
          'https://api.tenderly.co',
          'test-user',
          'test-project',
          'test-access-key'
        );
      });

      it('should use Simulation API for XLayer chain', async () => {
        const mockResponse: TenderlyResponseUniversalRouter = {
          config: {url: '', method: '', data: ''},
          simulation_results: [
            {
              transaction: {gas: 50000, gas_used: 45000},
              simulation: {id: '1', status: true},
            },
            {
              transaction: {gas: 60000, gas_used: 55000},
              simulation: {id: '2', status: true},
            },
            {
              transaction: {gas: 150000, gas_used: 140000},
              simulation: {id: '3', status: true},
            },
          ],
        };

        mockAxiosInstance.post.mockResolvedValue({
          data: mockResponse,
          status: 200,
        });

        const quoteSplit = createQuoteSplit(ChainId.XLAYER);
        const result = await simulator.simulateTransaction(
          USER_ADDRESS,
          swapOptions,
          quoteSplit,
          ctx
        );

        expect(result.simulationResult?.status).toBe(SimulationStatus.SUCCESS);
        expect(result.simulationResult?.estimatedGasUsed).toBe(195000n); // 150000 * 1.3
        expect(ctx.metrics.timer).toHaveBeenCalledWith(
          'Tenderly.Simulation.Latency',
          expect.any(Number),
          {tags: ['chain:196', 'simType:SimApi']}
        );
        expect(ctx.metrics.count).toHaveBeenCalledWith(
          'Tenderly.Simulation.Request',
          1,
          {
            tags: [
              'chain:196',
              'http_status:200',
              'status:success',
              'simType:SimApi',
            ],
          }
        );

        // Verify the correct endpoint was called (Simulation API, not Node API)
        expect(mockAxiosInstance.post).toHaveBeenCalledWith(
          'https://api.tenderly.co/api/v1/account/test-user/project/test-project/simulate-batch',
          expect.objectContaining({
            simulations: expect.any(Array),
            estimate_gas: true,
          }),
          expect.objectContaining({
            headers: {'X-Access-Key': 'test-access-key'},
          })
        );
      });

      it('should return FAILED when Simulation API returns error message', async () => {
        const mockResponse: TenderlyResponseUniversalRouter = {
          config: {url: '', method: '', data: ''},
          simulation_results: [
            {
              transaction: {gas: 50000, gas_used: 45000},
              simulation: {id: '1', status: true},
            },
            {
              transaction: {gas: 60000, gas_used: 55000},
              simulation: {id: '2', status: true},
            },
            {
              transaction: {
                gas: 0,
                gas_used: 0,
                error_message: 'execution reverted',
              },
              simulation: {id: '3', status: false},
            },
          ],
        };

        mockAxiosInstance.post.mockResolvedValue({
          data: mockResponse,
          status: 200,
        });

        const quoteSplit = createQuoteSplit(ChainId.XLAYER);
        const result = await simulator.simulateTransaction(
          USER_ADDRESS,
          swapOptions,
          quoteSplit,
          ctx
        );

        expect(result.simulationResult?.status).toBe(SimulationStatus.FAILED);
        expect(result.simulationResult?.description).toBe(
          'Error simulating transaction via Simulation API'
        );
      });

      it('should return FAILED when Simulation API response is incomplete', async () => {
        const mockResponse: TenderlyResponseUniversalRouter = {
          config: {url: '', method: '', data: ''},
          simulation_results: [
            {
              transaction: {gas: 50000, gas_used: 45000},
              simulation: {id: '1', status: true},
            },
          ] as unknown as [
            {
              transaction: {gas: number; gas_used: number};
              simulation: {id: string; status: boolean};
            },
            {
              transaction: {gas: number; gas_used: number};
              simulation: {id: string; status: boolean};
            },
            {
              transaction: {gas: number; gas_used: number};
              simulation: {id: string; status: boolean};
            },
          ],
        };

        mockAxiosInstance.post.mockResolvedValue({
          data: mockResponse,
          status: 200,
        });

        const quoteSplit = createQuoteSplit(ChainId.XLAYER);
        const result = await simulator.simulateTransaction(
          USER_ADDRESS,
          swapOptions,
          quoteSplit,
          ctx
        );

        expect(result.simulationResult?.status).toBe(SimulationStatus.FAILED);
      });
    });

    describe('constructor defaults', () => {
      it('should use default values when optional params not provided', () => {
        const sim = new TenderlySimulator(
          ChainId.MAINNET,
          'test-key',
          gasConverter,
          provider
        );

        // Verify the simulator was created (we can't easily check private fields)
        expect(sim).toBeInstanceOf(TenderlySimulator);
      });

      it('should use provided values when all params given', () => {
        const sim = new TenderlySimulator(
          ChainId.MAINNET,
          'test-key',
          gasConverter,
          provider,
          {[ChainId.MAINNET]: 1.5},
          5000,
          'https://custom.tenderly.co',
          'custom-user',
          'custom-project',
          'custom-access-key'
        );

        expect(sim).toBeInstanceOf(TenderlySimulator);
      });
    });
  });

  describe('FallbackTenderlySimulator', () => {
    let provider: JsonRpcProvider;
    let tenderlySimulator: TenderlySimulator;
    let ethEstimateGasSimulator: EthEstimateGasSimulator;
    let fallbackSimulator: FallbackTenderlySimulator;
    let ctx: Context;

    const USER_ADDRESS = '0x1234567890123456789012345678901234567890';
    const USDC_ADDRESS = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
    const WETH_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

    const swapOptions: SwapOptionsUniversalRouter = {
      type: SwapType.UNIVERSAL_ROUTER,
      version: UniversalRouterVersion.V1_2,
      simulate: {fromAddress: USER_ADDRESS},
      slippageTolerance: new Percent(5, 100),
    };

    const createQuoteSplit = (tokenInIsNative = false): QuoteSplit => ({
      quotes: [
        {
          route: new RouteBasic(UniProtocol.V3, [], 100),
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
        methodParameters: {
          calldata: '0xswapCalldata',
          value: '0x0',
          to: '0x0',
        },
      },
    });

    beforeEach(() => {
      provider = new JsonRpcProvider();

      tenderlySimulator = {
        simulateTransaction: vi.fn(),
      } as unknown as TenderlySimulator;

      ethEstimateGasSimulator = {
        ethEstimateGas: vi.fn(),
      } as unknown as EthEstimateGasSimulator;

      fallbackSimulator = new FallbackTenderlySimulator(
        ChainId.MAINNET,
        provider,
        tenderlySimulator,
        ethEstimateGasSimulator
      );

      ctx = {
        logger: {
          info: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        },
        metrics: {
          timer: vi.fn(),
          count: vi.fn(),
        },
      } as unknown as Context;
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    it('should return FAILED status when Tenderly simulation throws timeout error', async () => {
      const quoteSplit = createQuoteSplit();

      // Mock checkTokenApproved to return false (so it goes to Tenderly)
      vi.spyOn(
        fallbackSimulator as unknown as {
          checkTokenApproved: () => Promise<boolean>;
        },
        'checkTokenApproved'
      ).mockResolvedValue(false);

      // Make Tenderly throw a timeout error
      vi.mocked(tenderlySimulator.simulateTransaction).mockRejectedValue(
        new Error('timeout')
      );

      const result = await (
        fallbackSimulator as unknown as {
          simulateTransaction: (
            fromAddress: string,
            swapOptions: SwapOptionsUniversalRouter,
            quoteSplit: QuoteSplit,
            ctx: Context
          ) => Promise<QuoteSplit>;
        }
      ).simulateTransaction(USER_ADDRESS, swapOptions, quoteSplit, ctx);

      expect(result.simulationResult?.status).toBe(SimulationStatus.FAILED);
      expect(ctx.metrics.count).toHaveBeenCalledWith(
        'Tenderly.Simulation.Timeout',
        1,
        {tags: ['chain:1']}
      );
    });

    it('should return FAILED status when Tenderly simulation throws non-timeout error', async () => {
      const quoteSplit = createQuoteSplit();

      vi.spyOn(
        fallbackSimulator as unknown as {
          checkTokenApproved: () => Promise<boolean>;
        },
        'checkTokenApproved'
      ).mockResolvedValue(false);

      vi.mocked(tenderlySimulator.simulateTransaction).mockRejectedValue(
        new Error('some other error')
      );

      const result = await (
        fallbackSimulator as unknown as {
          simulateTransaction: (
            fromAddress: string,
            swapOptions: SwapOptionsUniversalRouter,
            quoteSplit: QuoteSplit,
            ctx: Context
          ) => Promise<QuoteSplit>;
        }
      ).simulateTransaction(USER_ADDRESS, swapOptions, quoteSplit, ctx);

      expect(result.simulationResult?.status).toBe(SimulationStatus.FAILED);
      expect(ctx.logger.error).toHaveBeenCalled();
    });
  });
});
