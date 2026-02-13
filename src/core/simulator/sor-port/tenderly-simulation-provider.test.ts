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
import {EthSimulateV1Simulator} from './eth-simulateV1-provider';

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
    let ethSimulateV1Simulator: EthSimulateV1Simulator;
    let useEthSimulateV1: boolean;
    let localNodeSupportedChains: ChainId[];
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

      ethSimulateV1Simulator = {
        ethSimulateV1: vi.fn(),
      } as unknown as EthSimulateV1Simulator;

      useEthSimulateV1 = true;
      localNodeSupportedChains = [ChainId.MAINNET];

      fallbackSimulator = new FallbackTenderlySimulator(
        ChainId.MAINNET,
        provider,
        tenderlySimulator,
        ethEstimateGasSimulator,
        ethSimulateV1Simulator,
        useEthSimulateV1,
        localNodeSupportedChains
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
      vi.mocked(ethSimulateV1Simulator.ethSimulateV1).mockRejectedValue(
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
      vi.mocked(ethSimulateV1Simulator.ethSimulateV1).mockRejectedValue(
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

  describe('EthSimulateV1Simulator', () => {
    let provider: JsonRpcProvider;
    let gasConverter: GasConverter;
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
      provider.send = vi.fn();

      gasConverter = {
        getGasCostInQuoteTokenBasedOnGasCostInWei: vi
          .fn()
          .mockResolvedValue(2000n),
      } as unknown as GasConverter;

      simulator = new EthSimulateV1Simulator(
        ChainId.MAINNET,
        provider,
        gasConverter
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

        expect(ctx.metrics.timer).toHaveBeenCalledWith(
          'UniRpcV2.Simulation.Latency',
          expect.any(Number),
          {
            tags: ['chain:1', 'simType:eth_simulateV1'],
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

      it('should use custom gas multiplier when provided', async () => {
        const customSimulator = new EthSimulateV1Simulator(
          ChainId.MAINNET,
          provider,
          gasConverter,
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

    describe('simulateTransaction', () => {
      it('should return NOT_APPROVED status when token is not approved', async () => {
        // Mock checkTokenApproved to return false
        vi.spyOn(
          simulator as unknown as {
            checkTokenApproved: () => Promise<boolean>;
          },
          'checkTokenApproved'
        ).mockResolvedValue(false);

        const quoteSplit = createQuoteSplit(false);
        const result = await (
          simulator as unknown as {
            simulateTransaction: (
              fromAddress: string,
              swapOptions: SwapOptionsUniversalRouter,
              quoteSplit: QuoteSplit,
              ctx: Context
            ) => Promise<QuoteSplit>;
          }
        ).simulateTransaction(USER_ADDRESS, swapOptions, quoteSplit, ctx);

        expect(result.simulationResult?.status).toBe(
          SimulationStatus.NOT_APPROVED
        );
        expect(result.simulationResult?.description).toBe(
          'Token not approved, skipping simulation'
        );
        expect(ctx.logger.info).toHaveBeenCalledWith(
          'Token not approved, skipping simulation'
        );
      });

      it('should simulate when token is native', async () => {
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

        const quoteSplit = createQuoteSplit(true);
        const result = await (
          simulator as unknown as {
            simulateTransaction: (
              fromAddress: string,
              swapOptions: SwapOptionsUniversalRouter,
              quoteSplit: QuoteSplit,
              ctx: Context
            ) => Promise<QuoteSplit>;
          }
        ).simulateTransaction(USER_ADDRESS, swapOptions, quoteSplit, ctx);

        expect(result.simulationResult?.status).toBe(SimulationStatus.SUCCESS);
        expect(provider.send).toHaveBeenCalled();
      });

      it('should simulate when token is approved', async () => {
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

        // Mock checkTokenApproved to return true
        vi.spyOn(
          simulator as unknown as {
            checkTokenApproved: () => Promise<boolean>;
          },
          'checkTokenApproved'
        ).mockResolvedValue(true);

        const quoteSplit = createQuoteSplit(false);
        const result = await (
          simulator as unknown as {
            simulateTransaction: (
              fromAddress: string,
              swapOptions: SwapOptionsUniversalRouter,
              quoteSplit: QuoteSplit,
              ctx: Context
            ) => Promise<QuoteSplit>;
          }
        ).simulateTransaction(USER_ADDRESS, swapOptions, quoteSplit, ctx);

        expect(result.simulationResult?.status).toBe(SimulationStatus.SUCCESS);
        expect(provider.send).toHaveBeenCalled();
      });
    });

    describe('constructor', () => {
      it('should use default multiplier when not provided', () => {
        const sim = new EthSimulateV1Simulator(
          ChainId.MAINNET,
          provider,
          gasConverter
        );

        expect(sim).toBeInstanceOf(EthSimulateV1Simulator);
      });

      it('should use provided multiplier override', () => {
        const sim = new EthSimulateV1Simulator(
          ChainId.MAINNET,
          provider,
          gasConverter,
          {[ChainId.MAINNET]: 2.0, [ChainId.ARBITRUM]: 1.5}
        );

        expect(sim).toBeInstanceOf(EthSimulateV1Simulator);
      });
    });
  });
});
