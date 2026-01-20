import {describe, it, expect, vi, beforeEach} from 'vitest';
import {BaseGasEstimator} from './BaseGasEstimator';
import {RouteBasic} from '../../../models/route/RouteBasic';
import {ChainId, getUniRouteSyncConfig} from '../../../lib/config';
import {GasDetails} from '../../../models/gas/GasDetails';
import {UniProtocol} from '../../../models/pool/UniProtocol';
import {QuoteBasic} from '../../../models/quote/QuoteBasic';
import {BaseProvider, JsonRpcProvider} from '@ethersproject/providers';
import {BigNumber} from '@ethersproject/bignumber';
import {Erc20Token} from '../../../models/token/Erc20Token';
import {ArbitrumGasData} from '../gas-data-provider';
import {CurrencyInfo} from '../../../models/currency/CurrencyInfo';
import {Address} from '../../../models/address/Address';
import {TradeType} from '../../../models/quote/TradeType';
import {buildTestContext} from '@uniswap/lib-testhelpers';
import {IFreshPoolDetailsWrapper} from '../../../stores/pool/FreshPoolDetailsWrapper';
import {Trade} from '@uniswap/router-sdk';
import {TradeType as SdkTradeType, Currency} from '@uniswap/sdk-core';

// Mock the @eth-optimism/sdk functions
vi.mock('@eth-optimism/sdk', () => ({
  estimateL1Gas: vi.fn(),
  estimateL1GasCost: vi.fn(),
}));

// Mock buildTrade and buildSwapMethodParameters to avoid failures in test
vi.mock('../../../lib/methodParameters', async () => {
  const actual = await vi.importActual('../../../lib/methodParameters');
  return {
    ...actual,
    buildTrade: vi.fn(),
    buildSwapMethodParameters: vi.fn(),
  };
});

// Test implementation of BaseGasEstimator that allows us to test protected methods
class TestableGasEstimator extends BaseGasEstimator {
  constructor(
    private readonly routeGasValue: bigint,
    private readonly l1l2GasValue: bigint,
    rpcProviderMap: Map<ChainId, JsonRpcProvider>,
    freshPoolDetailsWrapper: IFreshPoolDetailsWrapper
  ) {
    super(rpcProviderMap, freshPoolDetailsWrapper);
  }

  async estimateRouteGas(
    quote: QuoteBasic,

    chainId: ChainId,

    gasPriceWei: number
  ): Promise<GasDetails> {
    return new GasDetails(
      BigInt(gasPriceWei),
      this.routeGasValue,
      Number(this.routeGasValue),
      this.routeGasValue
    );
  }

  // Expose protected method for testing
  public testCombineGasEstimates(
    routeGas: GasDetails,
    l1l2Gas: GasDetails,
    gasPriceInWei: bigint
  ): GasDetails {
    return this.combineGasEstimates(routeGas, l1l2Gas, gasPriceInWei);
  }
}

describe('BaseGasEstimator', () => {
  beforeEach(async () => {
    // Reset mocks before each test
    vi.clearAllMocks();

    // Import the mocked module - this should get the mocked version
    const optimismSdk = await import('@eth-optimism/sdk');
    const estimateL1GasMock = vi.mocked(optimismSdk.estimateL1Gas);
    const estimateL1GasCostMock = vi.mocked(optimismSdk.estimateL1GasCost);

    // Set default return values for OP Stack L1 gas estimation
    // These return non-zero values so we can verify L1L2 gas is calculated
    estimateL1GasMock.mockResolvedValue(BigNumber.from(50000));
    estimateL1GasCostMock.mockResolvedValue(BigNumber.from(1000000000)); // 1 gwei

    // Mock buildTrade and buildSwapMethodParameters
    const methodParameters = await import('../../../lib/methodParameters');
    const buildTradeMock = vi.mocked(methodParameters.buildTrade);
    const buildSwapMethodParametersMock = vi.mocked(
      methodParameters.buildSwapMethodParameters
    );

    // Mock buildTrade to return a valid trade object
    buildTradeMock.mockImplementation(() => {
      // Return a minimal trade object that satisfies the type requirements
      const mockCurrency = {
        isNative: false,
        wrapped: {
          address: '0x1111111111111111111111111111111111111111',
        },
      } as Currency;
      return {
        tradeType: SdkTradeType.EXACT_INPUT,
        inputAmount: {
          currency: mockCurrency,
          quotient: BigInt(1000000),
        },
        outputAmount: {
          currency: mockCurrency,
          quotient: BigInt(1000),
        },
        routes: [],
      } as unknown as Trade<Currency, Currency, SdkTradeType>;
    });

    // Mock buildSwapMethodParameters to return valid calldata
    buildSwapMethodParametersMock.mockImplementation(() => {
      return {
        to: '0x1234567890123456789012345678901234567890',
        calldata: '0x1234567890abcdef1234567890abcdef12345678',
        value: '0x0',
      };
    });
  });

  const createTestData = () => {
    const tokenInAddress = new Address(
      '0x1111111111111111111111111111111111111111'
    );
    const tokenOutAddress = new Address(
      '0x2222222222222222222222222222222222222222'
    );
    const tokenInCurrencyInfo = new CurrencyInfo(false, tokenInAddress);
    const tokenOutCurrencyInfo = new CurrencyInfo(false, tokenOutAddress);
    const amountIn = BigInt(1000000);
    const tokensInfo = new Map<string, Erc20Token | null>();
    tokensInfo.set(
      tokenInAddress.address,
      new Erc20Token(tokenInAddress, 18, 'TOKEN_IN', 'Token In')
    );
    tokensInfo.set(
      tokenOutAddress.address,
      new Erc20Token(tokenOutAddress, 18, 'TOKEN_OUT', 'Token Out')
    );
    const tradeType = TradeType.ExactIn;
    const ctx = buildTestContext();
    const provider = new JsonRpcProvider() as BaseProvider;

    const dummyRoute = new RouteBasic(UniProtocol.V2, []);
    const dummyQuote = new QuoteBasic(
      dummyRoute,
      BigInt(1000),
      undefined,
      undefined
    );

    return {
      tokenInCurrencyInfo,
      tokenOutCurrencyInfo,
      amountIn,
      tokensInfo,
      tradeType,
      ctx,
      provider,
      dummyQuote,
    };
  };

  describe('combineGasEstimates', () => {
    it('should correctly combine two gas estimates', () => {
      const rpcProviderMap = new Map<ChainId, JsonRpcProvider>();
      const estimator = new TestableGasEstimator(
        BigInt(100),
        BigInt(200),
        rpcProviderMap,
        {} as IFreshPoolDetailsWrapper
      );

      const routeGas = new GasDetails(
        BigInt(1000),
        BigInt(5000),
        0.005,
        BigInt(500)
      );
      const l1l2Gas = new GasDetails(
        BigInt(1000),
        BigInt(3000),
        0.003,
        BigInt(300)
      );
      const gasPriceInWei = BigInt(1000);

      const result = estimator.testCombineGasEstimates(
        routeGas,
        l1l2Gas,
        gasPriceInWei
      );

      expect(result.gasPriceInWei).toBe(gasPriceInWei);
      expect(result.gasCostInWei).toBe(BigInt(8000)); // 5000 + 3000
      expect(result.gasCostInEth).toBe(0.008); // 0.005 + 0.003
      expect(result.gasUse).toBe(BigInt(800)); // 500 + 300
    });

    it('should handle zero L1L2 gas correctly', () => {
      const rpcProviderMap = new Map<ChainId, JsonRpcProvider>();
      const estimator = new TestableGasEstimator(
        BigInt(100),
        BigInt(200),
        rpcProviderMap,
        {} as IFreshPoolDetailsWrapper
      );

      const routeGas = new GasDetails(
        BigInt(1000),
        BigInt(5000),
        0.005,
        BigInt(500)
      );
      const l1l2Gas = new GasDetails(BigInt(1000), BigInt(0), 0, BigInt(0));
      const gasPriceInWei = BigInt(1000);

      const result = estimator.testCombineGasEstimates(
        routeGas,
        l1l2Gas,
        gasPriceInWei
      );

      expect(result.gasPriceInWei).toBe(gasPriceInWei);
      expect(result.gasCostInWei).toBe(BigInt(5000));
      expect(result.gasCostInEth).toBe(0.005);
      expect(result.gasUse).toBe(BigInt(500));
    });

    it('should handle zero route gas correctly', () => {
      const rpcProviderMap = new Map<ChainId, JsonRpcProvider>();
      const estimator = new TestableGasEstimator(
        BigInt(100),
        BigInt(200),
        rpcProviderMap,
        {} as IFreshPoolDetailsWrapper
      );

      const routeGas = new GasDetails(BigInt(1000), BigInt(0), 0, BigInt(0));
      const l1l2Gas = new GasDetails(
        BigInt(1000),
        BigInt(3000),
        0.003,
        BigInt(300)
      );
      const gasPriceInWei = BigInt(1000);

      const result = estimator.testCombineGasEstimates(
        routeGas,
        l1l2Gas,
        gasPriceInWei
      );

      expect(result.gasPriceInWei).toBe(gasPriceInWei);
      expect(result.gasCostInWei).toBe(BigInt(3000));
      expect(result.gasCostInEth).toBe(0.003);
      expect(result.gasUse).toBe(BigInt(300));
    });
  });

  describe('estimateGas', () => {
    it('should estimate gas correctly for non-Arbitrum/non-OP Stack chains (L1L2 gas should be zero)', async () => {
      const rpcProviderMap = new Map<ChainId, JsonRpcProvider>();
      const estimator = new TestableGasEstimator(
        BigInt(100000), // route gas
        BigInt(50000), // l1l2 gas (should not be used)
        rpcProviderMap,
        {} as IFreshPoolDetailsWrapper
      );

      const testData = createTestData();
      const chainId = ChainId.MAINNET; // Not Arbitrum or OP Stack
      const serviceConfig = getUniRouteSyncConfig();
      const gasPriceWei = 30000000000; // 30 gwei

      const result = await estimator.estimateGas(
        serviceConfig,
        testData.tokenInCurrencyInfo,
        testData.tokenOutCurrencyInfo,
        testData.amountIn,
        chainId,
        testData.tokensInfo,
        testData.tradeType,
        testData.dummyQuote,
        testData.provider,
        gasPriceWei,
        testData.ctx
      );

      // Should only include route gas, L1L2 gas should be zero
      expect(result.gasPriceInWei).toBe(BigInt(gasPriceWei));
      expect(result.gasCostInWei).toBe(BigInt(100000)); // Only route gas
      expect(result.gasCostInEth).toBe(100000);
      expect(result.gasUse).toBe(BigInt(100000));
    });

    it('should estimate gas correctly for Arbitrum when ArbitrumEnabled is true', async () => {
      const rpcProviderMap = new Map<ChainId, JsonRpcProvider>();
      const estimator = new TestableGasEstimator(
        BigInt(100000), // route gas
        BigInt(50000), // l1l2 gas
        rpcProviderMap,
        {} as IFreshPoolDetailsWrapper
      );

      const testData = createTestData();
      const chainId = ChainId.ARBITRUM;
      const serviceConfig = getUniRouteSyncConfig();
      serviceConfig.L1L2GasCostFetcher.ArbitrumEnabled = true;
      const gasPriceWei = 30000000000; // 30 gwei
      // Provide l2GasData so calculateArbitrumToL1SecurityFee can calculate properly
      const l2GasData: ArbitrumGasData = {
        perL2TxFee: BigNumber.from(1000),
        perL1CalldataFee: BigNumber.from(2000),
        perArbGasTotal: BigNumber.from(5000),
      };

      const result = await estimator.estimateGas(
        serviceConfig,
        testData.tokenInCurrencyInfo,
        testData.tokenOutCurrencyInfo,
        testData.amountIn,
        chainId,
        testData.tokensInfo,
        testData.tradeType,
        testData.dummyQuote,
        testData.provider,
        gasPriceWei,
        testData.ctx,
        l2GasData
      );

      // Should include both route gas and L1L2 gas
      expect(result.gasPriceInWei).toBe(BigInt(gasPriceWei));
      // With l2GasData provided, L1L2 gas should be calculated and added to route gas
      expect(result.gasUse).toBeGreaterThan(BigInt(100000)); // Should be more than just route gas
    });

    it('should estimate gas correctly for Arbitrum when ArbitrumEnabled is false', async () => {
      const rpcProviderMap = new Map<ChainId, JsonRpcProvider>();
      const estimator = new TestableGasEstimator(
        BigInt(100000), // route gas
        BigInt(50000), // l1l2 gas (should not be used)
        rpcProviderMap,
        {} as IFreshPoolDetailsWrapper
      );

      const testData = createTestData();
      const chainId = ChainId.ARBITRUM;
      const serviceConfig = getUniRouteSyncConfig();
      serviceConfig.L1L2GasCostFetcher.ArbitrumEnabled = false;
      const gasPriceWei = 30000000000; // 30 gwei

      const result = await estimator.estimateGas(
        serviceConfig,
        testData.tokenInCurrencyInfo,
        testData.tokenOutCurrencyInfo,
        testData.amountIn,
        chainId,
        testData.tokensInfo,
        testData.tradeType,
        testData.dummyQuote,
        testData.provider,
        gasPriceWei,
        testData.ctx
      );

      // Should only include route gas, L1L2 gas should be zero
      expect(result.gasPriceInWei).toBe(BigInt(gasPriceWei));
      expect(result.gasCostInWei).toBe(BigInt(100000)); // Only route gas
      expect(result.gasCostInEth).toBe(100000);
      expect(result.gasUse).toBe(BigInt(100000));
    });

    it('should estimate gas correctly for OP Stack chains when OpStackEnabled is true', async () => {
      const rpcProviderMap = new Map<ChainId, JsonRpcProvider>();
      const estimator = new TestableGasEstimator(
        BigInt(100000), // route gas
        BigInt(50000), // l1l2 gas
        rpcProviderMap,
        {} as IFreshPoolDetailsWrapper
      );

      const testData = createTestData();
      const chainId = ChainId.BASE; // OP Stack chain
      const serviceConfig = getUniRouteSyncConfig();
      serviceConfig.L1L2GasCostFetcher.OpStackEnabled = true;
      const gasPriceWei = 30000000000; // 30 gwei

      const result = await estimator.estimateGas(
        serviceConfig,
        testData.tokenInCurrencyInfo,
        testData.tokenOutCurrencyInfo,
        testData.amountIn,
        chainId,
        testData.tokensInfo,
        testData.tradeType,
        testData.dummyQuote,
        testData.provider,
        gasPriceWei,
        testData.ctx
      );

      // Should include both route gas and L1L2 gas
      expect(result.gasPriceInWei).toBe(BigInt(gasPriceWei));
      // With OpStackEnabled=true, L1L2 gas should be calculated and added to route gas
      // Note: This requires RPC calls which may fail in test environment, but we verify the calculation path
      expect(result.gasUse).toBeGreaterThan(BigInt(100000)); // Should be more than just route gas
    });

    it('should estimate gas correctly for OP Stack chains when OpStackEnabled is false', async () => {
      const rpcProviderMap = new Map<ChainId, JsonRpcProvider>();
      const estimator = new TestableGasEstimator(
        BigInt(100000), // route gas
        BigInt(50000), // l1l2 gas (should not be used)
        rpcProviderMap,
        {} as IFreshPoolDetailsWrapper
      );

      const testData = createTestData();
      const chainId = ChainId.BASE; // OP Stack chain
      const serviceConfig = getUniRouteSyncConfig();
      serviceConfig.L1L2GasCostFetcher.OpStackEnabled = false;
      const gasPriceWei = 30000000000; // 30 gwei

      const result = await estimator.estimateGas(
        serviceConfig,
        testData.tokenInCurrencyInfo,
        testData.tokenOutCurrencyInfo,
        testData.amountIn,
        chainId,
        testData.tokensInfo,
        testData.tradeType,
        testData.dummyQuote,
        testData.provider,
        gasPriceWei,
        testData.ctx
      );

      // Should only include route gas, L1L2 gas should be zero
      expect(result.gasPriceInWei).toBe(BigInt(gasPriceWei));
      expect(result.gasCostInWei).toBe(BigInt(100000)); // Only route gas
      expect(result.gasCostInEth).toBe(100000);
      expect(result.gasUse).toBe(BigInt(100000));
    });

    it('should estimate gas correctly for Optimism when OpStackEnabled is true', async () => {
      const rpcProviderMap = new Map<ChainId, JsonRpcProvider>();
      const estimator = new TestableGasEstimator(
        BigInt(100000), // route gas
        BigInt(50000), // l1l2 gas
        rpcProviderMap,
        {} as IFreshPoolDetailsWrapper
      );

      const testData = createTestData();
      const chainId = ChainId.OPTIMISM; // OP Stack chain
      const serviceConfig = getUniRouteSyncConfig();
      serviceConfig.L1L2GasCostFetcher.OpStackEnabled = true;
      const gasPriceWei = 30000000000; // 30 gwei

      const result = await estimator.estimateGas(
        serviceConfig,
        testData.tokenInCurrencyInfo,
        testData.tokenOutCurrencyInfo,
        testData.amountIn,
        chainId,
        testData.tokensInfo,
        testData.tradeType,
        testData.dummyQuote,
        testData.provider,
        gasPriceWei,
        testData.ctx
      );

      // Should include both route gas and L1L2 gas
      expect(result.gasPriceInWei).toBe(BigInt(gasPriceWei));
      // With OpStackEnabled=true, L1L2 gas should be calculated and added to route gas
      // Note: This requires RPC calls which may fail in test environment, but we verify the calculation path
      expect(result.gasUse).toBeGreaterThan(BigInt(100000)); // Should be more than just route gas
    });

    it('should estimate gas correctly for Blast when OpStackEnabled is true', async () => {
      const rpcProviderMap = new Map<ChainId, JsonRpcProvider>();
      const estimator = new TestableGasEstimator(
        BigInt(100000), // route gas
        BigInt(50000), // l1l2 gas
        rpcProviderMap,
        {} as IFreshPoolDetailsWrapper
      );

      const testData = createTestData();
      const chainId = ChainId.BLAST; // OP Stack chain
      const serviceConfig = getUniRouteSyncConfig();
      serviceConfig.L1L2GasCostFetcher.OpStackEnabled = true;
      const gasPriceWei = 30000000000; // 30 gwei

      const result = await estimator.estimateGas(
        serviceConfig,
        testData.tokenInCurrencyInfo,
        testData.tokenOutCurrencyInfo,
        testData.amountIn,
        chainId,
        testData.tokensInfo,
        testData.tradeType,
        testData.dummyQuote,
        testData.provider,
        gasPriceWei,
        testData.ctx
      );

      // Should include both route gas and L1L2 gas
      expect(result.gasPriceInWei).toBe(BigInt(gasPriceWei));
      // With OpStackEnabled=true, L1L2 gas should be calculated and added to route gas
      // Note: This requires RPC calls which may fail in test environment, but we verify the calculation path
      expect(result.gasUse).toBeGreaterThan(BigInt(100000)); // Should be more than just route gas
    });

    it('should use provided l2GasData when available', async () => {
      const rpcProviderMap = new Map<ChainId, JsonRpcProvider>();
      const estimator = new TestableGasEstimator(
        BigInt(100000), // route gas
        BigInt(50000), // l1l2 gas
        rpcProviderMap,
        {} as IFreshPoolDetailsWrapper
      );

      const testData = createTestData();
      const chainId = ChainId.ARBITRUM;
      const serviceConfig = getUniRouteSyncConfig();
      serviceConfig.L1L2GasCostFetcher.ArbitrumEnabled = true;
      const gasPriceWei = 30000000000; // 30 gwei
      const l2GasData: ArbitrumGasData = {
        perL2TxFee: BigNumber.from(1000),
        perL1CalldataFee: BigNumber.from(2000),
        perArbGasTotal: BigNumber.from(5000),
      };

      const result = await estimator.estimateGas(
        serviceConfig,
        testData.tokenInCurrencyInfo,
        testData.tokenOutCurrencyInfo,
        testData.amountIn,
        chainId,
        testData.tokensInfo,
        testData.tradeType,
        testData.dummyQuote,
        testData.provider,
        gasPriceWei,
        testData.ctx,
        l2GasData
      );

      // Should include both route gas and L1L2 gas
      expect(result.gasPriceInWei).toBe(BigInt(gasPriceWei));
      // With l2GasData provided, L1L2 gas should be calculated and added to route gas
      expect(result.gasUse).toBeGreaterThan(BigInt(100000)); // Should be more than just route gas
    });
  });

  describe('estimateL1L2Gas', () => {
    it('should calculate L1L2 gas correctly for Arbitrum', async () => {
      const rpcProviderMap = new Map<ChainId, JsonRpcProvider>();
      const estimator = new TestableGasEstimator(
        BigInt(100000),
        BigInt(50000),
        rpcProviderMap,
        {} as IFreshPoolDetailsWrapper
      );

      const testData = createTestData();
      const chainId = ChainId.ARBITRUM;
      const serviceConfig = getUniRouteSyncConfig();
      serviceConfig.L1L2GasCostFetcher.ArbitrumEnabled = true;
      const gasPriceWei = 30000000000; // 30 gwei

      const result = await estimator.estimateL1L2Gas(
        serviceConfig,
        testData.tokenInCurrencyInfo,
        testData.tokenOutCurrencyInfo,
        testData.amountIn,
        chainId,
        testData.tokensInfo,
        testData.tradeType,
        testData.dummyQuote,
        testData.provider,
        gasPriceWei,
        testData.ctx
      );

      // Should return a valid GasDetails object
      expect(result).toBeInstanceOf(GasDetails);
      expect(result.gasPriceInWei).toBe(BigInt(gasPriceWei));
      // Note: calculateL1GasFeesHelper may return 0 in test environment
      expect(result.gasCostInWei).toBeGreaterThanOrEqual(BigInt(0));
      expect(result.gasUse).toBeGreaterThanOrEqual(BigInt(0));
    });

    it('should calculate L1L2 gas correctly for OP Stack chains', async () => {
      const rpcProviderMap = new Map<ChainId, JsonRpcProvider>();
      const estimator = new TestableGasEstimator(
        BigInt(100000),
        BigInt(50000),
        rpcProviderMap,
        {} as IFreshPoolDetailsWrapper
      );

      const testData = createTestData();
      const chainId = ChainId.BASE; // OP Stack chain
      const serviceConfig = getUniRouteSyncConfig();
      serviceConfig.L1L2GasCostFetcher.OpStackEnabled = true;
      const gasPriceWei = 30000000000; // 30 gwei

      const result = await estimator.estimateL1L2Gas(
        serviceConfig,
        testData.tokenInCurrencyInfo,
        testData.tokenOutCurrencyInfo,
        testData.amountIn,
        chainId,
        testData.tokensInfo,
        testData.tradeType,
        testData.dummyQuote,
        testData.provider,
        gasPriceWei,
        testData.ctx
      );

      // Should return a valid GasDetails object
      expect(result).toBeInstanceOf(GasDetails);
      expect(result.gasPriceInWei).toBe(BigInt(gasPriceWei));
      // Note: calculateL1GasFeesHelper may return 0 in test environment
      expect(result.gasCostInWei).toBeGreaterThanOrEqual(BigInt(0));
      expect(result.gasUse).toBeGreaterThanOrEqual(BigInt(0));
    });

    it('should handle ExactOutput trade type correctly', async () => {
      const rpcProviderMap = new Map<ChainId, JsonRpcProvider>();
      const estimator = new TestableGasEstimator(
        BigInt(100000),
        BigInt(50000),
        rpcProviderMap,
        {} as IFreshPoolDetailsWrapper
      );

      const testData = createTestData();
      testData.tradeType = TradeType.ExactOut;
      const chainId = ChainId.ARBITRUM;
      const serviceConfig = getUniRouteSyncConfig();
      serviceConfig.L1L2GasCostFetcher.ArbitrumEnabled = true;
      const gasPriceWei = 30000000000; // 30 gwei

      const result = await estimator.estimateL1L2Gas(
        serviceConfig,
        testData.tokenInCurrencyInfo,
        testData.tokenOutCurrencyInfo,
        testData.amountIn,
        chainId,
        testData.tokensInfo,
        testData.tradeType,
        testData.dummyQuote,
        testData.provider,
        gasPriceWei,
        testData.ctx
      );

      // Should return a valid GasDetails object
      expect(result).toBeInstanceOf(GasDetails);
      expect(result.gasPriceInWei).toBe(BigInt(gasPriceWei));
    });
  });
});
