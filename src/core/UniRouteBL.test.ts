import {describe, expect, it, beforeEach, vi} from 'vitest';
import {UniRouteBL} from './UniRouteBL';
import {
  getUniRouteTestConfig,
  IUniRouteServiceConfig,
  LambdaType,
} from '../lib/config';
import {HardcodedChainRepository} from '../stores/chain/hardcoded/HardcodedChainRepository';
import {QuoteRequestValidator} from './QuoteRequestValidator';
import {
  QuoteRequest,
  GetCachedRoutesRequest,
  DeleteCachedRoutesRequest,
  MethodParameters,
} from '../../gen/uniroute/v1/api_pb';

import {buildTestContext} from '@uniswap/lib-testhelpers';
import {ITokenHandler} from '../stores/token/ITokenHandler';
import {Chain} from '../models/chain/Chain';
import {Address} from '../models/address/Address';
import {Erc20Token} from '../models/token/Erc20Token';
import {Context as UniContext} from '@uniswap/lib-uni/context';
import {IQuoteFetcher} from '../stores/quote/IQuoteFetcher';
import {QuoteBasic} from '../models/quote/QuoteBasic';
import {RouteBasic} from '../models/route/RouteBasic';
import {TradeType} from '../models/quote/TradeType';
import {UniProtocol} from '../models/pool/UniProtocol';
import {SimpleQuoteSelector} from './quote/selector/SimpleQuoteSelector';
import {IRoutesRepository} from '../stores/route/IRoutesRepository';
import {UniPool} from '../models/pool/UniPool';
import {V2Pool} from '../models/pool/V2Pool';
import {V4Pool} from '../models/pool/V4Pool';
import {GasEstimateProvider} from './gas/estimator/GasEstimateProvider';
import {NoGasEstimator} from './gas/estimator/IGasEstimator';
import {ChainId} from '../lib/config';
import {JsonRpcProvider} from '@ethersproject/providers';
import {PoolDiscoverer} from './pool-discovery/PoolDiscoverer';
import {
  EmptyPoolDiscovererV2,
  EmptyPoolDiscovererV3,
  EmptyPoolDiscovererV4,
} from './pool-discovery/discoverers/EmptyPoolDiscoverer';
import {InMemoryRedisCache} from '@uniswap/lib-cache/redis';
import {IFreshPoolDetailsWrapper} from '../stores/pool/FreshPoolDetailsWrapper';
import {CachedRoutesBucketedRepositoryECS} from '../stores/route/uniroutes/CachedRoutesBucketedRepositoryECS';
import {RouteQuoteAllocator} from './route/RouteQuoteAllocator';
import {Context} from '@uniswap/lib-uni/context';
import {NoGasConverter} from './gas/converter/IGasConverter';
import {IGasConverter} from './gas/converter/IGasConverter';
import {QuoteSplit} from '../models/quote/QuoteSplit';
import {SwapInfo} from '../models/quote/SwapInfo';
import {BaseQuoteStrategy} from './strategy/BaseQuoteStrategy';
import {DummySimulator} from './simulator/DummySimulator';
import {ISimulator, SimulationStatus} from './simulator/ISimulator';
import {CurrencyInfo} from '../models/currency/CurrencyInfo';
import {ArbitrumGasDataProvider} from './gas/gas-data-provider';
import {BaseProvider} from '@ethersproject/providers';
import {ICachedRoutesRepository} from 'src/stores/route/uniroutes/ICachedRoutesRepository';
import {NoOpMessageQueue} from 'src/lib/queue';
import {HooksOptions} from '../models/hooks/HooksOptions';
import {TokenProvider} from 'src/stores/token/provider/TokenProvider';
import {TokenList} from '@uniswap/token-lists';
import {UsdBucket} from '../stores/route/uniroutes/usdBucketUtils';
import {Trade} from '@uniswap/router-sdk';
import {Currency, TradeType as SdkTradeType} from '@uniswap/sdk-core';
import {BigNumber} from '@ethersproject/bignumber';

class TestTokenHandler implements ITokenHandler {
  public async getToken(
    chain: Chain,
    address: Address,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ctx: UniContext
  ): Promise<Erc20Token | null> {
    return new Erc20Token(address, 18, 'TEST', 'TestToken', undefined, 1.0);
  }
  public async getTokens(
    chain: Chain,
    addresses: Address[],
    ctx: UniContext
  ): Promise<Map<string, Erc20Token | null>> {
    const tokens = new Map<string, Erc20Token | null>();
    for (const address of addresses) {
      tokens.set(address.toString(), await this.getToken(chain, address, ctx));
    }
    return tokens;
  }
}

class TestQuoteFetcher implements IQuoteFetcher {
  public async fetchQuotes(
    chain: Chain,
    tokenInCurrencyInfo: CurrencyInfo,
    tokenOutCurrencyInfo: CurrencyInfo,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    amount: bigint,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    routes: RouteBasic[],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    tradeType: TradeType,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ctx: UniContext
  ): Promise<QuoteBasic[]> {
    return [
      new QuoteBasic(
        new RouteBasic(UniProtocol.V2, [
          new V2Pool(
            tokenInCurrencyInfo.wrappedAddress,
            tokenOutCurrencyInfo.wrappedAddress,
            new Address('0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640'),
            BigInt('1000000000000'),
            BigInt('1000000000000')
          ),
        ]),
        BigInt(1234567890),
        undefined
      ),
    ];
  }
}

class TestRoutesRepository implements IRoutesRepository<UniPool> {
  public async fetchRoutesForTokens(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    chain: Chain,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    tokenInAddress: Address,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    tokenOutAddress: Address,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    protocols: UniProtocol[],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    generateMixedRoutes: boolean,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    hooksOptions: HooksOptions | undefined,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    skipPoolsForTokensCache: boolean,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ctx: UniContext
  ): Promise<RouteBasic<UniPool>[]> {
    return [];
  }

  public async getRoutes(
    chain: Chain,
    tokenInCurrencyInfo: CurrencyInfo,
    tokenOutCurrencyInfo: CurrencyInfo,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    protocols: UniProtocol[],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    tradeType: TradeType,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    fotInDirectSwap: boolean,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    hooksOptions: HooksOptions | undefined,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    skipPoolsForTokensCache: boolean,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ctx: UniContext
  ): Promise<RouteBasic[]> {
    return [
      new RouteBasic(UniProtocol.V2, [
        new V2Pool(
          tokenInCurrencyInfo.wrappedAddress,
          tokenOutCurrencyInfo.wrappedAddress,
          new Address('0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640'),
          BigInt('1000000000000'),
          BigInt('1000000000000')
        ),
      ]),
    ];
  }
}

class TestFreshPoolDetailsWrapper implements IFreshPoolDetailsWrapper {
  public async getPoolDetailsForRoute(
    ctx: UniContext,
    quotes: QuoteBasic[],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    chain: Chain
  ): Promise<Map<string, UniPool>> {
    const poolMap = new Map<string, UniPool>();
    for (const quote of quotes) {
      for (const pool of quote.route.path) {
        poolMap.set(pool.address.toString(), pool);
      }
    }
    return poolMap;
  }

  public async getPoolsDetails(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ctx: Context,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    pools: UniPool[],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    chain: Chain
  ): Promise<Map<string, UniPool>> {
    return new Map();
  }
}

class OnDemandGasEstimateProvider extends GasEstimateProvider {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async getCurrentGasPrice(chainId: ChainId): Promise<number> {
    return 0;
  }
}

// Create a simulator that always fails simulation
class FailingSimulator implements ISimulator {
  async simulate(
    chainId: ChainId,

    swapOptions: unknown,

    quoteSplit: QuoteSplit,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    tokenInCurrencyInfo: CurrencyInfo,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    tokenOutCurrencyInfo: CurrencyInfo,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    amountIn: bigint,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    expectedAmountOut: bigint,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ctx: Context
  ): Promise<QuoteSplit> {
    // Always return a failed simulation
    return {
      ...quoteSplit,
      simulationResult: {
        estimatedGasUsed: 0n,
        estimatedGasUsedInQuoteToken: 0n,
        status: SimulationStatus.FAILED,
        description: 'Simulation failed for testing',
      },
    };
  }
}

// Mock the buildTrade function to return a successful trade
const mockBuildTrade = vi.fn().mockImplementation(() => {
  return {
    priceImpact: {
      toFixed: () => '0.01', // 1% price impact
    },
  } as unknown as Trade<Currency, Currency, SdkTradeType>;
});

// Mock the buildSwapMethodParameters function to return successful method parameters
const mockBuildSwapMethodParameters = vi.fn().mockImplementation(() => {
  return {
    to: '0x1234567890123456789012345678901234567890',
    calldata: '0x1234567890abcdef',
    value: '0x0',
  };
});

// Create a mocked quote strategy that returns predefined quotes
class MockedQuoteStrategy extends BaseQuoteStrategy {
  private readonly bestQuote?: QuoteSplit | null;

  constructor(bestQuote?: QuoteSplit | null) {
    super(
      {} as IQuoteFetcher,
      {} as GasEstimateProvider,
      {} as IGasConverter,
      {} as RouteQuoteAllocator<UniPool>,
      {} as SimpleQuoteSelector,
      {} as ITokenHandler,
      new ArbitrumGasDataProvider({} as BaseProvider),
      {} as IFreshPoolDetailsWrapper
    );
    this.bestQuote = bestQuote;
  }

  async findBestQuoteCandidates(
    ctx: Context,
    chain: Chain,
    tokenInCurrencyInfo: CurrencyInfo,
    tokenOutCurrencyInfo: CurrencyInfo,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    amount: bigint,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    tradeType: TradeType,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    protocols: UniProtocol[],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    serviceConfig: IUniRouteServiceConfig,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    routes: RouteBasic<UniPool>[],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    tokensInfo: Map<string, Erc20Token | null>,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    metricTags: string[]
  ): Promise<QuoteSplit[]> {
    // If bestQuote is explicitly set to null, return empty array to simulate no routes
    if (this.bestQuote === null) {
      return [];
    }

    // If bestQuote is provided, return it in an array
    if (this.bestQuote) {
      return [this.bestQuote];
    }

    // Default quote if nothing was specified
    return [
      new QuoteSplit([
        new QuoteBasic(
          new RouteBasic(UniProtocol.V2, [
            new V2Pool(
              tokenInCurrencyInfo.wrappedAddress,
              tokenOutCurrencyInfo.wrappedAddress,
              new Address('0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640'),
              BigInt('1000000000000'),
              BigInt('1000000000000')
            ),
          ]),
          BigInt('1234567890'),
          undefined,
          {
            gasUse: BigInt('150000'),
            gasPriceInWei: BigInt('30000000000'),
            gasCostInWei: BigInt('4500000000000000'),
            gasCostInEth: 0.0045,
          }
        ),
      ]),
    ];
  }

  name(): string {
    return 'MockedQuoteStrategy';
  }
}

describe('UniRouteBL', () => {
  let redisCache: InMemoryRedisCache<string, string>;
  let cachedRoutesRepository: ICachedRoutesRepository;

  beforeEach(() => {
    redisCache = new InMemoryRedisCache<string, string>();
    cachedRoutesRepository = new CachedRoutesBucketedRepositoryECS(
      redisCache,
      serviceConfig,
      'test-lambda-name',
      new NoOpMessageQueue()
    );
  });

  const serviceConfig = getUniRouteTestConfig(LambdaType.Sync);
  const serviceConfigAsync = getUniRouteTestConfig(LambdaType.Async);
  const chainRepository = new HardcodedChainRepository();
  const tokenProvider = new TokenProvider(
    new InMemoryRedisCache<string, TokenList>()
  );
  const quoteRequestValidator = new QuoteRequestValidator(
    chainRepository,
    tokenProvider
  );
  const tokenHandler = new TestTokenHandler();
  const quoteFetcher = new TestQuoteFetcher();
  const quoteSelector = new SimpleQuoteSelector();
  const routeQuoteAllocator = new RouteQuoteAllocator();
  const routeRepository = new TestRoutesRepository();
  const noGasConverter = new NoGasConverter();
  const gasEstimateProvider = new OnDemandGasEstimateProvider(
    new Map<ChainId, JsonRpcProvider>(),
    new NoGasEstimator(),
    new NoGasEstimator(),
    new NoGasEstimator(),
    new NoGasEstimator()
  );
  const localPoolCache = new InMemoryRedisCache<string, string>();
  const poolDiscoverer = new PoolDiscoverer(
    new EmptyPoolDiscovererV2(serviceConfig, localPoolCache, localPoolCache),
    new EmptyPoolDiscovererV3(serviceConfig, localPoolCache, localPoolCache),
    new EmptyPoolDiscovererV4(serviceConfig, localPoolCache, localPoolCache),
    new EmptyPoolDiscovererV2(serviceConfig, localPoolCache, localPoolCache),
    new EmptyPoolDiscovererV3(serviceConfig, localPoolCache, localPoolCache),
    new EmptyPoolDiscovererV4(serviceConfig, localPoolCache, localPoolCache)
  );
  const freshPoolDetailsWrapper = new TestFreshPoolDetailsWrapper();
  const dummySimulator = new DummySimulator();
  const ctx = buildTestContext();

  // Create a mock fetcher that handles test lambda names
  ctx.fetcher = (
    ctx: Context,
    // eslint-disable-next-line n/no-unsupported-features/node-builtins
    input: string | URL | Request,
    init?: RequestInit
    // eslint-disable-next-line n/no-unsupported-features/node-builtins
  ): Promise<Response> => {
    // If the input is a test lambda name (not a valid URL), return a mock response
    if (typeof input === 'string' && input === 'test-lambda-name') {
      // eslint-disable-next-line n/no-unsupported-features/node-builtins
      return Promise.resolve(new Response('OK', {status: 200}));
    }
    // Otherwise, use the real fetch
    // eslint-disable-next-line n/no-unsupported-features/node-builtins
    return fetch(input, init);
  };

  const baseRequest = {
    tokenInAddress: 'ETH',
    tokenInChainId: 1,
    tokenOutAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    tokenOutChainId: 1,
    amount: '1000000000000000000',
    quoteType: 'FAST',
    protocols: 'v2,v3,v4,mixed',
  };

  const mockedRpcProviderMap = new Map<ChainId, JsonRpcProvider>();

  // Add a mock provider for MAINNET to prevent undefined errors
  const mockProvider = {
    getBlockNumber: vi.fn().mockResolvedValue(12345678),
    getGasPrice: vi.fn().mockResolvedValue(BigNumber.from('0')),
  } as unknown as JsonRpcProvider;
  mockedRpcProviderMap.set(ChainId.MAINNET, mockProvider);

  describe('quote caching behavior', () => {
    it('should not use cached routes for FAST quote type in sync mode (start with empty cache)', async () => {
      // First call to cache routes
      const request = new QuoteRequest({
        ...baseRequest,
        tradeType: 'EXACT_IN',
      });

      const mockedQuoteStrategy = new MockedQuoteStrategy();
      const uniRouteBL = new UniRouteBL(
        serviceConfig,
        redisCache,
        chainRepository,
        poolDiscoverer,
        freshPoolDetailsWrapper,
        tokenHandler,
        quoteFetcher,
        quoteSelector,
        routeQuoteAllocator,
        gasEstimateProvider,
        noGasConverter,
        routeRepository,
        cachedRoutesRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap
      );

      // First call should not use cached routes because cache is empty
      const firstResponse = await uniRouteBL.quote(ctx, request);
      expect(firstResponse.hitsCachedRoutes).toBe(false);

      // Second call should not use cached routes because sync/FAST shouldn't update cache
      const secondResponse = await uniRouteBL.quote(ctx, request);
      expect(secondResponse.hitsCachedRoutes).toBe(false);
    });

    it('should not use cached routes for FRESH quote type in sync mode (start with empty cache)', async () => {
      const request = new QuoteRequest({
        ...baseRequest,
        tradeType: 'EXACT_IN',
        quoteType: 'FRESH',
      });

      const mockedQuoteStrategy = new MockedQuoteStrategy();
      const uniRouteBL = new UniRouteBL(
        serviceConfig,
        redisCache,
        chainRepository,
        poolDiscoverer,
        freshPoolDetailsWrapper,
        tokenHandler,
        quoteFetcher,
        quoteSelector,
        routeQuoteAllocator,
        gasEstimateProvider,
        noGasConverter,
        routeRepository,
        cachedRoutesRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap
      );

      const firstResponse = await uniRouteBL.quote(ctx, request);
      expect(firstResponse.hitsCachedRoutes).toBe(false);

      const secondResponse = await uniRouteBL.quote(ctx, request);
      expect(secondResponse.hitsCachedRoutes).toBe(false);
    });

    it('should use cached routes for FAST quote type in async mode (start with empty cache)', async () => {
      const request = new QuoteRequest({
        ...baseRequest,
        tradeType: 'EXACT_IN',
      });

      const mockedQuoteStrategy = new MockedQuoteStrategy();
      const uniRouteBL = new UniRouteBL(
        serviceConfigAsync,
        redisCache,
        chainRepository,
        poolDiscoverer,
        freshPoolDetailsWrapper,
        tokenHandler,
        quoteFetcher,
        quoteSelector,
        routeQuoteAllocator,
        gasEstimateProvider,
        noGasConverter,
        routeRepository,
        cachedRoutesRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap
      );

      // First call should not use cached routes because cache is empty
      const firstResponse = await uniRouteBL.quote(ctx, request);
      expect(firstResponse.hitsCachedRoutes).toBe(false);

      // Second call should use cached routes because async/FAST should update cache
      const secondResponse = await uniRouteBL.quote(ctx, request);
      expect(secondResponse.hitsCachedRoutes).toBe(true);
    });

    it('should not use cached routes for FRESH quote type in async mode (start with empty cache)', async () => {
      const request = new QuoteRequest({
        ...baseRequest,
        tradeType: 'EXACT_IN',
        quoteType: 'FRESH',
      });

      const mockedQuoteStrategy = new MockedQuoteStrategy();
      const uniRouteBL = new UniRouteBL(
        serviceConfigAsync,
        redisCache,
        chainRepository,
        poolDiscoverer,
        freshPoolDetailsWrapper,
        tokenHandler,
        quoteFetcher,
        quoteSelector,
        routeQuoteAllocator,
        gasEstimateProvider,
        noGasConverter,
        routeRepository,
        cachedRoutesRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap
      );

      const firstResponse = await uniRouteBL.quote(ctx, request);
      expect(firstResponse.hitsCachedRoutes).toBe(false);

      const secondResponse = await uniRouteBL.quote(ctx, request);
      expect(secondResponse.hitsCachedRoutes).toBe(false);
    });
  });

  describe('response formatting', () => {
    it('should correctly format single route response', async () => {
      const request = new QuoteRequest({
        ...baseRequest,
        tradeType: 'EXACT_IN',
      });

      const singleQuote = new QuoteSplit([
        new QuoteBasic(
          new RouteBasic(UniProtocol.V2, [
            new V2Pool(
              new Address(baseRequest.tokenInAddress),
              new Address(baseRequest.tokenOutAddress),
              new Address('0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640'),
              BigInt('1000000000000'),
              BigInt('1000000000000')
            ),
          ]),
          BigInt('1234567890'),
          undefined,
          {
            gasUse: BigInt('150000'),
            gasPriceInWei: BigInt('30000000000'),
            gasCostInWei: BigInt('4500000000000000'),
            gasCostInEth: 0.0045,
          }
        ),
      ]);

      const mockedQuoteStrategy = new MockedQuoteStrategy(singleQuote);
      const uniRouteBL = new UniRouteBL(
        serviceConfig,
        redisCache,
        chainRepository,
        poolDiscoverer,
        freshPoolDetailsWrapper,
        tokenHandler,
        quoteFetcher,
        quoteSelector,
        routeQuoteAllocator,
        gasEstimateProvider,
        noGasConverter,
        routeRepository,
        cachedRoutesRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap
      );

      const response = await uniRouteBL.quote(ctx, request);

      expect(response.quoteAmount).equals('1234567890');
      expect(response.route).length(1);
      expect(response.route[0].pools).length(1);
      expect(response.route[0].pools[0].type).equals('v2-pool');
      expect(response.route[0].pools[0].address).equals(
        '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640'
      );
      expect(response.route[0].pools[0].amountIn).equals('1000000000000000000');
      expect(response.route[0].pools[0].amountOut).equals('1234567890');
    });

    it('should handle error response when no routes found', async () => {
      const request = new QuoteRequest({
        ...baseRequest,
        tradeType: 'EXACT_IN',
      });

      const mockedQuoteStrategy = new MockedQuoteStrategy(null); // Use null to indicate no routes
      const uniRouteBL = new UniRouteBL(
        serviceConfig,
        redisCache,
        chainRepository,
        poolDiscoverer,
        freshPoolDetailsWrapper,
        tokenHandler,
        quoteFetcher,
        quoteSelector,
        routeQuoteAllocator,
        gasEstimateProvider,
        noGasConverter,
        routeRepository,
        cachedRoutesRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap
      );

      const response = await uniRouteBL.quote(ctx, request);

      expect(response.error).toBeDefined();
      expect(response.error?.code).equals(404);
      expect(response.error?.message).contains('No valid quotes found');
    });

    it('should correctly adjust gas for EXACT_IN trade type', async () => {
      const request = new QuoteRequest({
        ...baseRequest,
        tradeType: 'EXACT_IN',
      });

      const singleQuote = new QuoteSplit([
        new QuoteBasic(
          new RouteBasic(UniProtocol.V2, [
            new V2Pool(
              new Address(baseRequest.tokenInAddress),
              new Address(baseRequest.tokenOutAddress),
              new Address('0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640'),
              BigInt('1000000000000'),
              BigInt('1000000000000')
            ),
          ]),
          BigInt('1234567890'), // quote amount
          undefined,
          {
            gasUse: BigInt('150000'),
            gasPriceInWei: BigInt('30000000000'),
            gasCostInWei: BigInt('4500000000000000'),
            gasCostInEth: 0.0045,
            gasCostInQuoteToken: BigInt('1000000'), // gas cost in quote token
          }
        ),
      ]);

      const mockedQuoteStrategy = new MockedQuoteStrategy(singleQuote);
      const uniRouteBL = new UniRouteBL(
        serviceConfig,
        redisCache,
        chainRepository,
        poolDiscoverer,
        freshPoolDetailsWrapper,
        tokenHandler,
        quoteFetcher,
        quoteSelector,
        routeQuoteAllocator,
        gasEstimateProvider,
        noGasConverter,
        routeRepository,
        cachedRoutesRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap
      );

      const response = await uniRouteBL.quote(ctx, request);

      // For EXACT_IN, gas should be subtracted from quote amount
      expect(response.quoteAmount).equals('1234567890');
      expect(response.quoteGasAdjusted).equals('1233567890'); // 1234567890 - 1000000
    });

    it('should correctly adjust gas for EXACT_OUT trade type', async () => {
      const request = new QuoteRequest({
        ...baseRequest,
        tradeType: 'EXACT_OUT',
      });

      const singleQuote = new QuoteSplit([
        new QuoteBasic(
          new RouteBasic(UniProtocol.V2, [
            new V2Pool(
              new Address(baseRequest.tokenInAddress),
              new Address(baseRequest.tokenOutAddress),
              new Address('0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640'),
              BigInt('1000000000000'),
              BigInt('1000000000000')
            ),
          ]),
          BigInt('1234567890'), // quote amount
          undefined,
          {
            gasUse: BigInt('150000'),
            gasPriceInWei: BigInt('30000000000'),
            gasCostInWei: BigInt('4500000000000000'),
            gasCostInEth: 0.0045,
            gasCostInQuoteToken: BigInt('1000000'), // gas cost in quote token
          }
        ),
      ]);

      const mockedQuoteStrategy = new MockedQuoteStrategy(singleQuote);
      const uniRouteBL = new UniRouteBL(
        serviceConfig,
        redisCache,
        chainRepository,
        poolDiscoverer,
        freshPoolDetailsWrapper,
        tokenHandler,
        quoteFetcher,
        quoteSelector,
        routeQuoteAllocator,
        gasEstimateProvider,
        noGasConverter,
        routeRepository,
        cachedRoutesRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap
      );

      const response = await uniRouteBL.quote(ctx, request);

      // For EXACT_OUT, gas should be added to quote amount
      expect(response.quoteAmount).equals('1234567890');
      expect(response.quoteGasAdjusted).equals('1235567890'); // 1234567890 + 1000000
    });

    it('should include portion fields in response when portion parameters are provided', async () => {
      const request = new QuoteRequest({
        ...baseRequest,
        tradeType: 'EXACT_IN',
        portionBips: 50, // 0.5%
        portionRecipient: '0x1234567890123456789012345678901234567890',
      });

      const singleQuote = new QuoteSplit([
        new QuoteBasic(
          new RouteBasic(UniProtocol.V2, [
            new V2Pool(
              new Address(baseRequest.tokenInAddress),
              new Address(baseRequest.tokenOutAddress),
              new Address('0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640'),
              BigInt('1000000000000'),
              BigInt('1000000000000')
            ),
          ]),
          BigInt('1234567890'), // quote amount
          undefined,
          {
            gasUse: BigInt('150000'),
            gasPriceInWei: BigInt('30000000000'),
            gasCostInWei: BigInt('4500000000000000'),
            gasCostInEth: 0.0045,
            gasCostInQuoteToken: BigInt('1000000'),
          }
        ),
      ]);

      const mockedQuoteStrategy = new MockedQuoteStrategy(singleQuote);
      const uniRouteBL = new UniRouteBL(
        serviceConfig,
        redisCache,
        chainRepository,
        poolDiscoverer,
        freshPoolDetailsWrapper,
        tokenHandler,
        quoteFetcher,
        quoteSelector,
        routeQuoteAllocator,
        gasEstimateProvider,
        noGasConverter,
        routeRepository,
        cachedRoutesRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap
      );

      const response = await uniRouteBL.quote(ctx, request);

      // Verify portion-related fields are present in response
      expect(response.portionBips).equals(50);
      expect(response.portionRecipient).equals(
        '0x1234567890123456789012345678901234567890'
      );
      expect(response.portionAmount).toBeDefined();
      expect(response.portionAmountDecimals).toBeDefined();

      // For EXACT_IN, portion amount should be 0.5% of the quote amount
      // 1234567890 * 0.005 = 6172839.45, rounded down to 6172839
      expect(response.portionAmount).equals('6172839');
      // With 18 decimals, this should be 0.000000000006172839
      expect(response.portionAmountDecimals).equals('0.000000000006172839');
      // Make sure gasUseEstimateQuote is included and not adjusted by mistake
      expect(response.gasUseEstimateQuote).equals('1000000');

      // For EXACT_IN, the pool's amountIn should be the original amount
      expect(response.route[0].pools[0].amountIn).equals('1000000000000000000');
      // And amountOut should be the quote amount minus portionAmount (1234567890 - 6172839 = 1228395051)
      expect(response.route[0].pools[0].amountOut).equals('1228395051');
      expect(response.route[0].pools[0].amountOut).equals(
        (1234567890n - BigInt(response.portionAmount || 0)).toString()
      );
    });

    it('should include portion fields in response when portion parameters are provided with 2 routes split 60/40', async () => {
      const request = new QuoteRequest({
        ...baseRequest,
        tradeType: 'EXACT_IN',
        portionBips: 50, // 0.5%
        portionRecipient: '0x1234567890123456789012345678901234567890',
      });

      // Create a quote with 2 routes, split 60/40
      const twoRouteQuote = new QuoteSplit([
        new QuoteBasic(
          new RouteBasic(
            UniProtocol.V2,
            [
              new V2Pool(
                new Address(baseRequest.tokenInAddress),
                new Address(baseRequest.tokenOutAddress),
                new Address('0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640'),
                BigInt('1000000000000'),
                BigInt('1000000000000')
              ),
            ],
            60
          ), // 60% of the route
          BigInt('740740734'), // 60% of 1234567890
          undefined,
          {
            gasUse: BigInt('90000'),
            gasPriceInWei: BigInt('30000000000'),
            gasCostInWei: BigInt('2700000000000000'),
            gasCostInEth: 0.0027,
            gasCostInQuoteToken: BigInt('600000'),
          }
        ),
        new QuoteBasic(
          new RouteBasic(
            UniProtocol.V4,
            [
              new V4Pool(
                new Address(baseRequest.tokenInAddress),
                new Address(baseRequest.tokenOutAddress),
                500, // fee
                10, // tickSpacing
                '0x0000000000000000000000000000000000000000', // hooks
                BigInt('1000000000000'), // liquidity
                '0x11b815efB8f581194ae79006d24E0d814B7697F6', // poolId
                BigInt('79228162514264337593543950336'), // sqrtPriceX96
                BigInt('0') // tickCurrent
              ),
            ],
            40
          ), // 40% of the route
          BigInt('493827156'), // 40% of 1234567890
          undefined,
          {
            gasUse: BigInt('60000'),
            gasPriceInWei: BigInt('30000000000'),
            gasCostInWei: BigInt('1800000000000000'),
            gasCostInEth: 0.0018,
            gasCostInQuoteToken: BigInt('400000'),
          }
        ),
      ]);

      const mockedQuoteStrategy = new MockedQuoteStrategy(twoRouteQuote);
      const uniRouteBL = new UniRouteBL(
        serviceConfig,
        redisCache,
        chainRepository,
        poolDiscoverer,
        freshPoolDetailsWrapper,
        tokenHandler,
        quoteFetcher,
        quoteSelector,
        routeQuoteAllocator,
        gasEstimateProvider,
        noGasConverter,
        routeRepository,
        cachedRoutesRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap
      );

      const response = await uniRouteBL.quote(ctx, request);

      // Verify portion-related fields are present in response
      expect(response.portionBips).equals(50);
      expect(response.portionRecipient).equals(
        '0x1234567890123456789012345678901234567890'
      );
      expect(response.portionAmount).toBeDefined();
      expect(response.portionAmountDecimals).toBeDefined();

      // For EXACT_IN, portion amount should be 0.5% of the total quote amount
      // Total quote amount: 740740734 + 493827156 = 1234567890
      // 1234567890 * 0.005 = 6172839.45, rounded down to 6172839
      expect(response.portionAmount).equals('6172839');
      // With 18 decimals, this should be 0.000000000006172839
      expect(response.portionAmountDecimals).equals('0.000000000006172839');
      // Total gas cost should be sum of both routes: 600000 + 400000 = 1000000
      expect(response.gasUseEstimateQuote).equals('1000000');

      // Verify we have 2 routes in the response
      expect(response.route).toHaveLength(2);

      // For EXACT_IN, each route's amountIn should be proportional to the route percentage
      expect(response.route[0].pools[0].amountIn).equals('600000000000000000'); // 60% of 1000000000000000000
      expect(response.route[1].pools[0].amountIn).equals('400000000000000000'); // 40% of 1000000000000000000

      // Each route's amountOut should be proportional to the route percentage minus proportional portion
      // Route 1 (60%): 740740734 - 3703703 = 737037031
      // Route 2 (40%): 493827156 - 2469135 = 491358021
      expect(response.route[0].pools[0].amountOut).equals('737037031');
      expect(response.route[1].pools[0].amountOut).equals('491358021');

      // Verify the portion is split proportionally between routes
      const totalPortionAmount = BigInt(response.portionAmount || 0);
      const portionRoute1 = BigInt(
        Math.floor(Number(totalPortionAmount) * 0.6)
      ); // 60% of portion
      const portionRoute2 = BigInt(
        Math.floor(Number(totalPortionAmount) * 0.4)
      ); // 40% of portion
      expect(response.route[0].pools[0].amountOut).equals(
        (740740734n - portionRoute1).toString()
      );
      expect(response.route[1].pools[0].amountOut).equals(
        (493827156n - portionRoute2).toString()
      );
    });

    it('should correctly distribute large amounts across multiple routes using BigInt arithmetic', async () => {
      // Test with large amount that exceeds Number.MAX_SAFE_INTEGER to verify BigInt conversion fix
      const largeAmount = '1000000000000000000000000'; // 1e24, exceeds MAX_SAFE_INTEGER
      const request = new QuoteRequest({
        ...baseRequest,
        amount: largeAmount,
        tradeType: 'EXACT_IN',
      });

      // Create a quote with 3 routes: 33%, 34%, 33% (doesn't divide evenly)
      const threeRouteQuote = new QuoteSplit([
        new QuoteBasic(
          new RouteBasic(
            UniProtocol.V2,
            [
              new V2Pool(
                new Address(baseRequest.tokenInAddress),
                new Address(baseRequest.tokenOutAddress),
                new Address('0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640'),
                BigInt('1000000000000'),
                BigInt('1000000000000')
              ),
            ],
            33
          ),
          BigInt('330000000000000000000000'), // 33% of 1e24
          undefined,
          {
            gasUse: BigInt('50000'),
            gasPriceInWei: BigInt('30000000000'),
            gasCostInWei: BigInt('1500000000000000'),
            gasCostInEth: 0.0015,
            gasCostInQuoteToken: BigInt('330000'),
          }
        ),
        new QuoteBasic(
          new RouteBasic(
            UniProtocol.V3,
            [
              new V2Pool(
                new Address(baseRequest.tokenInAddress),
                new Address(baseRequest.tokenOutAddress),
                new Address('0x1234567890123456789012345678901234567891'),
                BigInt('1000000000000'),
                BigInt('1000000000000')
              ),
            ],
            34
          ),
          BigInt('340000000000000000000000'), // 34% of 1e24
          undefined,
          {
            gasUse: BigInt('50000'),
            gasPriceInWei: BigInt('30000000000'),
            gasCostInWei: BigInt('1500000000000000'),
            gasCostInEth: 0.0015,
            gasCostInQuoteToken: BigInt('340000'),
          }
        ),
        new QuoteBasic(
          new RouteBasic(
            UniProtocol.V4,
            [
              new V4Pool(
                new Address(baseRequest.tokenInAddress),
                new Address(baseRequest.tokenOutAddress),
                500,
                10,
                '0x0000000000000000000000000000000000000000',
                BigInt('1000000000000'),
                '0x11b815efB8f581194ae79006d24E0d814B7697F6',
                BigInt('79228162514264337593543950336'),
                BigInt('0')
              ),
            ],
            33
          ),
          BigInt('330000000000000000000000'), // 33% of 1e24 (last route gets remainder)
          undefined,
          {
            gasUse: BigInt('50000'),
            gasPriceInWei: BigInt('30000000000'),
            gasCostInWei: BigInt('1500000000000000'),
            gasCostInEth: 0.0015,
            gasCostInQuoteToken: BigInt('330000'),
          }
        ),
      ]);

      const mockedQuoteStrategy = new MockedQuoteStrategy(threeRouteQuote);
      const uniRouteBL = new UniRouteBL(
        serviceConfig,
        redisCache,
        chainRepository,
        poolDiscoverer,
        freshPoolDetailsWrapper,
        tokenHandler,
        quoteFetcher,
        quoteSelector,
        routeQuoteAllocator,
        gasEstimateProvider,
        noGasConverter,
        routeRepository,
        cachedRoutesRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap
      );

      const response = await uniRouteBL.quote(ctx, request);

      // Verify we have 3 routes
      expect(response.route).toHaveLength(3);

      // Calculate expected amounts using BigInt (safe)
      const amountInBigInt = BigInt(largeAmount);
      const expectedRoute0 = (amountInBigInt * 33n) / 100n; // 33%
      const expectedRoute1 = (amountInBigInt * 34n) / 100n; // 34%
      // Last route gets remainder: amountIn - route0 - route1
      const expectedRoute2 = amountInBigInt - expectedRoute0 - expectedRoute1;

      // Verify each route's amountIn is correctly calculated using BigInt
      expect(response.route[0].pools[0].amountIn).equals(
        expectedRoute0.toString()
      );
      expect(response.route[1].pools[0].amountIn).equals(
        expectedRoute1.toString()
      );
      expect(response.route[2].pools[0].amountIn).equals(
        expectedRoute2.toString()
      );

      // Verify the sum equals the original amountIn (no precision loss)
      const sum =
        BigInt(response.route[0].pools[0].amountIn) +
        BigInt(response.route[1].pools[0].amountIn) +
        BigInt(response.route[2].pools[0].amountIn);
      expect(sum).toBe(amountInBigInt);

      // Verify the amounts are exact (no precision loss from Number conversion)
      // If we had used Number conversion, we'd see precision loss
      expect(response.route[0].pools[0].amountIn).equals(
        '330000000000000000000000'
      );
      expect(response.route[1].pools[0].amountIn).equals(
        '340000000000000000000000'
      );
      expect(response.route[2].pools[0].amountIn).equals(
        '330000000000000000000000'
      );
    });

    it('should include portion fields in response for EXACT_OUT trade type', async () => {
      const request = new QuoteRequest({
        ...baseRequest,
        tradeType: 'EXACT_OUT',
        portionBips: 50, // 0.5%
        portionRecipient: '0x1234567890123456789012345678901234567890',
      });

      const singleQuote = new QuoteSplit([
        new QuoteBasic(
          new RouteBasic(UniProtocol.V2, [
            new V2Pool(
              new Address(baseRequest.tokenInAddress),
              new Address(baseRequest.tokenOutAddress),
              new Address('0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640'),
              BigInt('1000000000000'),
              BigInt('1000000000000')
            ),
          ]),
          BigInt('1234567890'), // quote amount
          undefined,
          {
            gasUse: BigInt('150000'),
            gasPriceInWei: BigInt('30000000000'),
            gasCostInWei: BigInt('4500000000000000'),
            gasCostInEth: 0.0045,
            gasCostInQuoteToken: BigInt('1000000'),
          }
        ),
      ]);

      const mockedQuoteStrategy = new MockedQuoteStrategy(singleQuote);
      const uniRouteBL = new UniRouteBL(
        serviceConfig,
        redisCache,
        chainRepository,
        poolDiscoverer,
        freshPoolDetailsWrapper,
        tokenHandler,
        quoteFetcher,
        quoteSelector,
        routeQuoteAllocator,
        gasEstimateProvider,
        noGasConverter,
        routeRepository,
        cachedRoutesRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap
      );

      const response = await uniRouteBL.quote(ctx, request);

      // Verify portion-related fields are present in response
      expect(response.portionBips).equals(50);
      expect(response.portionRecipient).equals(
        '0x1234567890123456789012345678901234567890'
      );
      expect(response.portionAmount).toBeDefined();
      expect(response.portionAmountDecimals).toBeDefined();

      // For EXACT_OUT, portion amount should be 0.5% of the input amount
      // 1000000000000000000 (1 ETH) * 0.005 = 5000000000000000 (0.005 ETH)
      expect(response.portionAmount).equals('5000000000000000');
      // With 18 decimals, this should be 0.005
      expect(response.portionAmountDecimals).equals('0.005');

      // For EXACT_OUT, the pool's amountIn should be the quote amount
      expect(response.route[0].pools[0].amountIn).equals('1234567890');
      // And amountOut should be the original amount plus the portion
      // 1000000000000000000 + 5000000000000000 = 1005000000000000000
      expect(response.route[0].pools[0].amountOut).equals(
        '1005000000000000000'
      );
    });
  });

  describe('pool details updates', () => {
    it('should update pool details in response', async () => {
      const request = new QuoteRequest({
        ...baseRequest,
        tradeType: 'EXACT_IN',
      });

      const poolAddress = '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640';
      const updatedReserve0 = BigInt('2000000000000');
      const updatedReserve1 = BigInt('3000000000000');

      // Create a custom FreshPoolDetailsWrapper that updates pool details
      const customFreshPoolDetailsWrapper: IFreshPoolDetailsWrapper = {
        async getPoolDetailsForRoute(
          ctx: UniContext,
          quotes: QuoteBasic[],
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          chain: Chain
        ): Promise<Map<string, UniPool>> {
          const poolMap = new Map<string, UniPool>();
          for (const quote of quotes) {
            for (const pool of quote.route.path) {
              if (pool instanceof V2Pool) {
                poolMap.set(
                  pool.address.toString(),
                  new V2Pool(
                    pool.token0,
                    pool.token1,
                    pool.address,
                    updatedReserve0,
                    updatedReserve1
                  )
                );
              }
            }
          }
          return poolMap;
        },
        async getPoolsDetails(
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          ctx: Context,
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          pools: UniPool[],
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          chain: Chain
        ): Promise<Map<string, UniPool>> {
          return new Map();
        },
      };

      const mockedQuoteStrategy = new MockedQuoteStrategy();
      const uniRouteBL = new UniRouteBL(
        serviceConfig,
        redisCache,
        chainRepository,
        poolDiscoverer,
        customFreshPoolDetailsWrapper,
        tokenHandler,
        quoteFetcher,
        quoteSelector,
        routeQuoteAllocator,
        gasEstimateProvider,
        noGasConverter,
        routeRepository,
        cachedRoutesRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap
      );

      const response = await uniRouteBL.quote(ctx, request);

      expect(response.route[0].pools[0].address).equals(poolAddress);
      expect(response.route[0].pools[0].reserve0?.quotient).equals(
        updatedReserve0.toString()
      );
      expect(response.route[0].pools[0].reserve1?.quotient).equals(
        updatedReserve1.toString()
      );
    });
  });

  describe('getCachedRoutes', () => {
    it('should return not found if no routes are cached', async () => {
      const request = new GetCachedRoutesRequest({
        chainId: 1,
        tokenInAddress: 'ETH',
        tokenOutAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        tradeType: 'EXACT_IN',
      });

      const mockedQuoteStrategy = new MockedQuoteStrategy();
      const uniRouteBL = new UniRouteBL(
        serviceConfig,
        redisCache,
        chainRepository,
        poolDiscoverer,
        freshPoolDetailsWrapper,
        tokenHandler,
        quoteFetcher,
        quoteSelector,
        routeQuoteAllocator,
        gasEstimateProvider,
        noGasConverter,
        routeRepository,
        cachedRoutesRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap
      );

      const response = await uniRouteBL.getCachedRoutes(ctx, request);

      expect(response.buckets).toBeDefined();
      expect(response.buckets.length).toBe(0);
    });

    it('should return cached routes when they exist', async () => {
      const request = new GetCachedRoutesRequest({
        chainId: 1,
        tokenInAddress: '0x0000000000000000000000000000000000000000',
        tokenOutAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        tradeType: 'EXACT_IN',
      });

      const mockedQuoteStrategy = new MockedQuoteStrategy();
      const uniRouteBL = new UniRouteBL(
        serviceConfig,
        redisCache,
        chainRepository,
        poolDiscoverer,
        freshPoolDetailsWrapper,
        tokenHandler,
        quoteFetcher,
        quoteSelector,
        routeQuoteAllocator,
        gasEstimateProvider,
        noGasConverter,
        routeRepository,
        cachedRoutesRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap
      );

      // Manually create a dummy route and cache it
      const dummyRoute = new RouteBasic(UniProtocol.V2, [
        new V2Pool(
          new Address('0x0000000000000000000000000000000000000000'),
          new Address('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
          new Address('0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640'),
          BigInt('1000000000000'),
          BigInt('1000000000000')
        ),
      ]);

      // Cache the route using the repository directly
      await cachedRoutesRepository.saveCachedRoutes(
        dummyRoute,
        1, // chainId
        new Address('0x0000000000000000000000000000000000000000'),
        new Address('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
        TradeType.ExactIn,
        BigInt('1000000000000000000'),
        UsdBucket.USD_1_000_000
      );

      // Let's check what's actually in the cache
      const cacheKey = cachedRoutesRepository.constructCachedRouteKey(
        1,
        new Address('0x0000000000000000000000000000000000000000'),
        new Address('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
        TradeType.ExactIn,
        BigInt('1000000000000000000'),
        UsdBucket.USD_1_000_000
      );

      console.log('Cache key:', cacheKey);
      const cachedData = await redisCache.zrange(cacheKey, 0, -1);
      console.log('Cached data:', cachedData);

      const response = await uniRouteBL.getCachedRoutes(ctx, request);

      console.log('Response:', {
        bucketsCount: response.buckets?.length || 0,
      });

      expect(response.buckets).toBeDefined();
      expect(response.buckets.length).toBeGreaterThan(0);

      // Verify the bucket structure
      const bucket = response.buckets[0];
      expect(bucket.found).toBe(true);
      expect(bucket.routes).toBeDefined();
      expect(bucket.routes.length).toBeGreaterThan(0);
      expect(bucket.message).toContain('Found');

      // Verify the route structure
      const route = bucket.routes[0];
      expect(route.pools).toBeDefined();
      expect(route.pools.length).toBe(1);

      const pool = route.pools[0];
      expect(pool.type).toBe('v2-pool');
      expect(pool.address).toBe('0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640');
      expect(pool.tokenIn).toBeDefined();
      expect(pool.tokenOut).toBeDefined();
    });
  });

  describe('skipPoolsForTokensCache behavior', () => {
    it('should skip pools for tokens cache when hooksOptions is not HOOKS_INCLUSIVE', async () => {
      // Create a spy to track the getRoutes call
      const getRoutesSpy = vi.spyOn(routeRepository, 'getRoutes');

      const request = new QuoteRequest({
        ...baseRequest,
        tradeType: 'EXACT_IN',
        hooksOptions: HooksOptions.NO_HOOKS, // Not HOOKS_INCLUSIVE
      });

      const mockedQuoteStrategy = new MockedQuoteStrategy();
      const uniRouteBL = new UniRouteBL(
        serviceConfig,
        redisCache,
        chainRepository,
        poolDiscoverer,
        freshPoolDetailsWrapper,
        tokenHandler,
        quoteFetcher,
        quoteSelector,
        routeQuoteAllocator,
        gasEstimateProvider,
        noGasConverter,
        routeRepository,
        cachedRoutesRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap
      );

      await uniRouteBL.quote(ctx, request);

      // Verify that getRoutes was called with skipPoolsForTokensCache = true
      expect(getRoutesSpy).toHaveBeenCalledTimes(1);
      const callArgs = getRoutesSpy.mock.calls[0];
      expect(callArgs[6]).toBe(HooksOptions.NO_HOOKS); // hooksOptions
      expect(callArgs[7]).toBe(true); // skipPoolsForTokensCache should be true

      getRoutesSpy.mockRestore();
    });

    it('should not skip pools for tokens cache when hooksOptions is HOOKS_INCLUSIVE', async () => {
      // Create a spy to track the getRoutes call
      const getRoutesSpy = vi.spyOn(routeRepository, 'getRoutes');

      const request = new QuoteRequest({
        ...baseRequest,
        tradeType: 'EXACT_IN',
        hooksOptions: HooksOptions.HOOKS_INCLUSIVE,
      });

      const mockedQuoteStrategy = new MockedQuoteStrategy();
      const uniRouteBL = new UniRouteBL(
        serviceConfig,
        redisCache,
        chainRepository,
        poolDiscoverer,
        freshPoolDetailsWrapper,
        tokenHandler,
        quoteFetcher,
        quoteSelector,
        routeQuoteAllocator,
        gasEstimateProvider,
        noGasConverter,
        routeRepository,
        cachedRoutesRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap
      );

      await uniRouteBL.quote(ctx, request);

      // Verify that getRoutes was called with skipPoolsForTokensCache = false
      expect(getRoutesSpy).toHaveBeenCalledTimes(1);
      const callArgs = getRoutesSpy.mock.calls[0];
      expect(callArgs[6]).toBe(HooksOptions.HOOKS_INCLUSIVE); // hooksOptions
      expect(callArgs[7]).toBe(false); // skipPoolsForTokensCache should be false

      getRoutesSpy.mockRestore();
    });

    it('should not skip pools for tokens cache when hooksOptions is undefined (defaults to HOOKS_INCLUSIVE)', async () => {
      // Create a spy to track the getRoutes call
      const getRoutesSpy = vi.spyOn(routeRepository, 'getRoutes');

      const request = new QuoteRequest({
        ...baseRequest,
        tradeType: 'EXACT_IN',
        // hooksOptions is undefined by default, but gets defaulted to HOOKS_INCLUSIVE
      });

      const mockedQuoteStrategy = new MockedQuoteStrategy();
      const uniRouteBL = new UniRouteBL(
        serviceConfig,
        redisCache,
        chainRepository,
        poolDiscoverer,
        freshPoolDetailsWrapper,
        tokenHandler,
        quoteFetcher,
        quoteSelector,
        routeQuoteAllocator,
        gasEstimateProvider,
        noGasConverter,
        routeRepository,
        cachedRoutesRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap
      );

      await uniRouteBL.quote(ctx, request);

      // Verify that getRoutes was called with skipPoolsForTokensCache = false
      expect(getRoutesSpy).toHaveBeenCalledTimes(1);
      const callArgs = getRoutesSpy.mock.calls[0];
      expect(callArgs[6]).toBe(HooksOptions.HOOKS_INCLUSIVE); // hooksOptions defaults to HOOKS_INCLUSIVE
      expect(callArgs[7]).toBe(false); // skipPoolsForTokensCache should be false

      getRoutesSpy.mockRestore();
    });
  });

  describe('simulation fallback behavior', () => {
    it('should return populated quote with Failed status when all simulations fail', async () => {
      // This test verifies that when simulation is enabled but all attempts fail,
      // we still return a populated quote with Failed status and the swapInfo from the first attempt

      // Create a custom service config that enables simulation
      const simulationEnabledConfig = {
        ...serviceConfigAsync,
        Simulation: {
          ...serviceConfigAsync.Simulation,
          Enabled: true,
        },
      };

      const request = new QuoteRequest({
        ...baseRequest,
        tradeType: 'EXACT_IN',
        simulateFromAddress: '0x1234567890123456789012345678901234567890', // Enable simulation
        recipient: '0x1234567890123456789012345678901234567890', // Enable simulation
        slippageTolerance: 20, // Enable simulation
      });

      // Create a quote with swapInfo that would be captured
      const singleQuote = new QuoteSplit([
        new QuoteBasic(
          new RouteBasic(UniProtocol.V2, [
            new V2Pool(
              new Address(baseRequest.tokenInAddress),
              new Address(baseRequest.tokenOutAddress),
              new Address('0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640'),
              BigInt('1000000000000'),
              BigInt('1000000000000')
            ),
          ]),
          BigInt('1234567890'),
          undefined,
          {
            gasUse: BigInt('150000'),
            gasPriceInWei: BigInt('30000000000'),
            gasCostInWei: BigInt('4500000000000000'),
            gasCostInEth: 0.0045,
            gasCostInQuoteToken: BigInt('1000000'),
          }
        ),
      ]);

      const mockedQuoteStrategy = new MockedQuoteStrategy(singleQuote);
      const failingSimulator = new FailingSimulator();

      // Mock the buildTrade and buildSwapMethodParameters functions
      const buildTradeSpy = vi
        .spyOn(await import('../lib/methodParameters'), 'buildTrade')
        .mockImplementation(mockBuildTrade);
      const buildSwapMethodParametersSpy = vi
        .spyOn(
          await import('../lib/methodParameters'),
          'buildSwapMethodParameters'
        )
        .mockImplementation(mockBuildSwapMethodParameters);

      // Use the custom config that enables simulation
      const uniRouteBL = new UniRouteBL(
        simulationEnabledConfig,
        redisCache,
        chainRepository,
        poolDiscoverer,
        freshPoolDetailsWrapper,
        tokenHandler,
        quoteFetcher,
        quoteSelector,
        routeQuoteAllocator,
        gasEstimateProvider,
        noGasConverter,
        routeRepository,
        cachedRoutesRepository,
        mockedQuoteStrategy,
        failingSimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap
      );

      const response = await uniRouteBL.quote(ctx, request);

      // Should return a successful response (not an error)
      expect(response.error).toBeUndefined();

      // Should have the quote amount
      expect(response.quoteAmount).equals('1234567890');

      // Should have simulation status as Failed (since our FailingSimulator always fails)
      expect(response.simulationStatus).equals(SimulationStatus.FAILED);
      expect(response.simulationError).toBe(true);
      expect(response.simulationDescription).equals(
        'All simulation attempts failed'
      );

      // Should have method parameters (from the captured swapInfo)
      expect(response.methodParameters).toBeDefined();
      expect(response.methodParameters?.to).toBeDefined();
      expect(response.methodParameters?.calldata).toBeDefined();

      // Should have route information
      expect(response.route).toBeDefined();
      expect(response.route.length).toBe(1);
      expect(response.route[0].pools.length).toBe(1);

      // Clean up spies
      buildTradeSpy.mockRestore();
      buildSwapMethodParametersSpy.mockRestore();
    });

    it('should return 404 error when buildTrade fails and no firstSwapInfo is available', async () => {
      // This test verifies that when buildTrade fails legitimately (not mocked),
      // and we don't have firstSwapInfo to fall back to, we return a 404 error

      // Create a custom service config that enables simulation
      const simulationEnabledConfig = {
        ...serviceConfigAsync,
        Simulation: {
          ...serviceConfigAsync.Simulation,
          Enabled: true,
        },
      };

      const request = new QuoteRequest({
        ...baseRequest,
        tradeType: 'EXACT_IN',
        simulateFromAddress: '0x1234567890123456789012345678901234567890', // Enable simulation
        recipient: '0x1234567890123456789012345678901234567890', // Enable simulation
        slippageTolerance: 20, // Enable simulation
      });

      // Create a quote with swapInfo that would be captured
      const singleQuote = new QuoteSplit([
        new QuoteBasic(
          new RouteBasic(UniProtocol.V2, [
            new V2Pool(
              new Address(baseRequest.tokenInAddress),
              new Address(baseRequest.tokenOutAddress),
              new Address('0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640'),
              BigInt('1000000000000'),
              BigInt('1000000000000')
            ),
          ]),
          BigInt('1234567890'),
          undefined,
          {
            gasUse: BigInt('150000'),
            gasPriceInWei: BigInt('30000000000'),
            gasCostInWei: BigInt('4500000000000000'),
            gasCostInEth: 0.0045,
            gasCostInQuoteToken: BigInt('1000000'),
          }
        ),
      ]);

      const mockedQuoteStrategy = new MockedQuoteStrategy(singleQuote);
      const failingSimulator = new FailingSimulator();

      // DON'T mock buildTrade - let it fail naturally
      // This will cause buildTrade to throw an error, so firstSwapInfo won't be populated

      // Use the custom config that enables simulation
      const uniRouteBL = new UniRouteBL(
        simulationEnabledConfig,
        redisCache,
        chainRepository,
        poolDiscoverer,
        freshPoolDetailsWrapper,
        tokenHandler,
        quoteFetcher,
        quoteSelector,
        routeQuoteAllocator,
        gasEstimateProvider,
        noGasConverter,
        routeRepository,
        cachedRoutesRepository,
        mockedQuoteStrategy,
        failingSimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap
      );

      const response = await uniRouteBL.quote(ctx, request);

      // Should return an error response (404) because buildTrade failed and no fallback is available
      expect(response.error).toBeDefined();
      expect(response.error?.code).equals(404);
      expect(response.error?.message).contains('No valid quotes found');
    });

    it('should return populated quote with Failed status when simulation is disabled but quote building fails', async () => {
      const request = new QuoteRequest({
        ...baseRequest,
        tradeType: 'EXACT_IN',
        // No simulateFromAddress - simulation disabled
      });

      const singleQuote = new QuoteSplit([
        new QuoteBasic(
          new RouteBasic(UniProtocol.V2, [
            new V2Pool(
              new Address(baseRequest.tokenInAddress),
              new Address(baseRequest.tokenOutAddress),
              new Address('0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640'),
              BigInt('1000000000000'),
              BigInt('1000000000000')
            ),
          ]),
          BigInt('1234567890'),
          undefined,
          {
            gasUse: BigInt('150000'),
            gasPriceInWei: BigInt('30000000000'),
            gasCostInWei: BigInt('4500000000000000'),
            gasCostInEth: 0.0045,
            gasCostInQuoteToken: BigInt('1000000'),
          }
        ),
      ]);

      const mockedQuoteStrategy = new MockedQuoteStrategy(singleQuote);

      // Use sync config (simulation disabled)
      const uniRouteBL = new UniRouteBL(
        serviceConfig,
        redisCache,
        chainRepository,
        poolDiscoverer,
        freshPoolDetailsWrapper,
        tokenHandler,
        quoteFetcher,
        quoteSelector,
        routeQuoteAllocator,
        gasEstimateProvider,
        noGasConverter,
        routeRepository,
        cachedRoutesRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap
      );

      const response = await uniRouteBL.quote(ctx, request);

      // Should return a successful response (not an error)
      expect(response.error).toBeUndefined();

      // Should have the quote amount
      expect(response.quoteAmount).equals('1234567890');

      // Should have simulation status as Unattempted (since simulation was disabled)
      expect(response.simulationStatus).equals(SimulationStatus.UNATTEMPTED);
      expect(response.simulationError).toBe(false);
      expect(response.simulationDescription).equals('Simulation skipped');

      // Should have route information
      expect(response.route).toBeDefined();
      expect(response.route.length).toBe(1);
      expect(response.route[0].pools.length).toBe(1);
    });
  });

  describe('deleteCachedRoutes', () => {
    it('should return success true even if no routes are cached to delete', async () => {
      const request = new DeleteCachedRoutesRequest({
        chainId: 1,
        tokenInAddress: '0x0000000000000000000000000000000000000000',
        tokenOutAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        tradeType: 'EXACT_IN',
        usdBucket: UsdBucket.USD_1_000_000,
      });

      const mockedQuoteStrategy = new MockedQuoteStrategy();
      const uniRouteBL = new UniRouteBL(
        serviceConfig,
        redisCache,
        chainRepository,
        poolDiscoverer,
        freshPoolDetailsWrapper,
        tokenHandler,
        quoteFetcher,
        quoteSelector,
        routeQuoteAllocator,
        gasEstimateProvider,
        noGasConverter,
        routeRepository,
        cachedRoutesRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap
      );

      const response = await uniRouteBL.deleteCachedRoutes(ctx, request);

      expect(response.success).toBe(true);
      expect(response.message).toContain('deleted successfully');
    });

    it('should successfully delete cached routes when they exist', async () => {
      const request = new DeleteCachedRoutesRequest({
        chainId: 1,
        tokenInAddress: '0x0000000000000000000000000000000000000000',
        tokenOutAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        tradeType: 'EXACT_IN',
        usdBucket: UsdBucket.USD_1_000_000,
      });

      const mockedQuoteStrategy = new MockedQuoteStrategy();
      const uniRouteBL = new UniRouteBL(
        serviceConfig,
        redisCache,
        chainRepository,
        poolDiscoverer,
        freshPoolDetailsWrapper,
        tokenHandler,
        quoteFetcher,
        quoteSelector,
        routeQuoteAllocator,
        gasEstimateProvider,
        noGasConverter,
        routeRepository,
        cachedRoutesRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap
      );

      // First, manually create a dummy route and cache it
      const dummyRoute = new RouteBasic(UniProtocol.V2, [
        new V2Pool(
          new Address('0x0000000000000000000000000000000000000000'),
          new Address('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
          new Address('0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640'),
          BigInt('1000000000000'),
          BigInt('1000000000000')
        ),
      ]);

      await cachedRoutesRepository.saveCachedRoutes(
        dummyRoute,
        1, // chainId
        new Address('0x0000000000000000000000000000000000000000'),
        new Address('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
        TradeType.ExactIn,
        BigInt('1000000000000000000'),
        UsdBucket.USD_1_000_000
      );

      // Verify the route exists before deletion
      const getRequest = new GetCachedRoutesRequest({
        chainId: 1,
        tokenInAddress: '0x0000000000000000000000000000000000000000',
        tokenOutAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        tradeType: 'EXACT_IN',
      });

      const getResponse = await uniRouteBL.getCachedRoutes(ctx, getRequest);
      expect(getResponse.buckets.length).toBeGreaterThan(0);

      // Now delete the cached routes
      const deleteResponse = await uniRouteBL.deleteCachedRoutes(ctx, request);

      expect(deleteResponse.success).toBe(true);
      expect(deleteResponse.message).toContain('deleted successfully');

      // Verify the route no longer exists
      const getResponseAfterDelete = await uniRouteBL.getCachedRoutes(
        ctx,
        getRequest
      );
      expect(getResponseAfterDelete.buckets.length).toBe(0);
    });
  });

  describe('V4 fake tick spacing filtering', () => {
    it('should filter out V4 pools with fake tick spacing from response', async () => {
      const request = new QuoteRequest({
        ...baseRequest,
        tradeType: 'EXACT_IN',
      });

      // Create a quote with both a fake V4 pool (tickSpacing = 0) and a real V4 pool (tickSpacing = 10)
      const fakeV4Pool = new V4Pool(
        new Address('0x0000000000000000000000000000000000000000'),
        new Address('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'),
        0, // fee
        0, // FAKE_TICK_SPACING
        '0x0000000000000000000000000000000000000000', // hooks
        0n, // liquidity
        '0x0000000000000000000000000000000000000001', // poolId
        79228162514264337593543950336n, // sqrtPriceX96
        0n // tickCurrent
      );

      const realV4Pool = new V4Pool(
        new Address('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'),
        new Address('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
        500, // fee
        10, // real tick spacing
        '0x0000000000000000000000000000000000000000', // hooks
        1000000n, // liquidity
        '0x0000000000000000000000000000000000000002', // poolId
        79228162514264337593543950336n, // sqrtPriceX96
        0n // tickCurrent
      );

      const v2Pool = new V2Pool(
        new Address('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'),
        new Address('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
        new Address('0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640'),
        BigInt('1000000000000'),
        BigInt('1000000000000')
      );

      // Create a route with fake V4 pool, real V4 pool, and V2 pool
      const mixedRoute = new RouteBasic(UniProtocol.MIXED, [
        fakeV4Pool,
        realV4Pool,
        v2Pool,
      ]);

      const singleQuote = new QuoteSplit([
        new QuoteBasic(mixedRoute, BigInt('1234567890'), undefined, {
          gasUse: BigInt('150000'),
          gasPriceInWei: BigInt('30000000000'),
          gasCostInWei: BigInt('4500000000000000'),
          gasCostInEth: 0.0045,
          gasCostInQuoteToken: BigInt('1000000'),
        }),
      ]);

      const mockedQuoteStrategy = new MockedQuoteStrategy(singleQuote);
      const uniRouteBL = new UniRouteBL(
        serviceConfig,
        redisCache,
        chainRepository,
        poolDiscoverer,
        freshPoolDetailsWrapper,
        tokenHandler,
        quoteFetcher,
        quoteSelector,
        routeQuoteAllocator,
        gasEstimateProvider,
        noGasConverter,
        routeRepository,
        cachedRoutesRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap
      );

      const response = await uniRouteBL.quote(ctx, request);

      // Should return a successful response
      expect(response.error).toBeUndefined();
      expect(response.quoteAmount).equals('1234567890');

      // Should have only 2 pools in the response (fake V4 pool should be filtered out)
      expect(response.route).toBeDefined();
      expect(response.route.length).toBe(1);
      expect(response.route[0].pools.length).toBe(2); // Only real V4 pool and V2 pool

      // Verify the remaining pools are correct
      const pools = response.route[0].pools;

      // First pool should be the real V4 pool
      expect(pools[0].type).toBe('v4-pool');
      expect(pools[0].tickSpacing).toBe('10'); // Real tick spacing

      // Second pool should be the V2 pool
      expect(pools[1].type).toBe('v2-pool');
      expect(pools[1].address).toBe(
        '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640'
      );

      // Verify that no pool has tickSpacing = 0 (fake tick spacing)
      pools.forEach(pool => {
        if (pool.type === 'v4-pool') {
          expect(pool.tickSpacing).not.toBe('0');
        }
      });
    });
  });

  describe('formatPriceImpact', () => {
    it('should return "0" when priceImpact is undefined', async () => {
      const request = new QuoteRequest({
        ...baseRequest,
        tradeType: 'EXACT_IN',
      });

      // Create a quote without swapInfo (priceImpact will be undefined)
      const singleQuote = new QuoteSplit([
        new QuoteBasic(
          new RouteBasic(UniProtocol.V2, [
            new V2Pool(
              new Address(baseRequest.tokenInAddress),
              new Address(baseRequest.tokenOutAddress),
              new Address('0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640'),
              BigInt('1000000000000'),
              BigInt('1000000000000')
            ),
          ]),
          BigInt('1234567890'),
          undefined,
          {
            gasUse: BigInt('150000'),
            gasPriceInWei: BigInt('30000000000'),
            gasCostInWei: BigInt('4500000000000000'),
            gasCostInEth: 0.0045,
            gasCostInQuoteToken: BigInt('1000000'),
          }
        ),
      ]);
      // No swapInfo, so priceImpact will be undefined

      const mockedQuoteStrategy = new MockedQuoteStrategy(singleQuote);
      const uniRouteBL = new UniRouteBL(
        serviceConfig,
        redisCache,
        chainRepository,
        poolDiscoverer,
        freshPoolDetailsWrapper,
        tokenHandler,
        quoteFetcher,
        quoteSelector,
        routeQuoteAllocator,
        gasEstimateProvider,
        noGasConverter,
        routeRepository,
        cachedRoutesRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap
      );

      const response = await uniRouteBL.quote(ctx, request);

      expect(response.priceImpact).equals('0');
    });

    it('should return the value as string when priceImpact is within -100 to 100', async () => {
      const request = new QuoteRequest({
        ...baseRequest,
        tradeType: 'EXACT_IN',
      });

      // Create a quote with swapInfo that has priceImpact = 5.5
      const singleQuote = new QuoteSplit(
        [
          new QuoteBasic(
            new RouteBasic(UniProtocol.V2, [
              new V2Pool(
                new Address(baseRequest.tokenInAddress),
                new Address(baseRequest.tokenOutAddress),
                new Address('0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640'),
                BigInt('1000000000000'),
                BigInt('1000000000000')
              ),
            ]),
            BigInt('1234567890'),
            undefined,
            {
              gasUse: BigInt('150000'),
              gasPriceInWei: BigInt('30000000000'),
              gasCostInWei: BigInt('4500000000000000'),
              gasCostInEth: 0.0045,
              gasCostInQuoteToken: BigInt('1000000'),
            }
          ),
        ],
        new SwapInfo(
          baseRequest.tokenInAddress,
          baseRequest.tokenOutAddress,
          false,
          false,
          BigInt('1000000000000000000'),
          TradeType.ExactIn,
          5.5, // priceImpact within range
          new MethodParameters({
            to: '0x1234567890123456789012345678901234567890',
            calldata: '0x1234567890abcdef',
            value: '0x0',
          })
        )
      );

      const mockedQuoteStrategy = new MockedQuoteStrategy(singleQuote);
      const uniRouteBL = new UniRouteBL(
        serviceConfig,
        redisCache,
        chainRepository,
        poolDiscoverer,
        freshPoolDetailsWrapper,
        tokenHandler,
        quoteFetcher,
        quoteSelector,
        routeQuoteAllocator,
        gasEstimateProvider,
        noGasConverter,
        routeRepository,
        cachedRoutesRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap
      );

      const response = await uniRouteBL.quote(ctx, request);

      expect(response.priceImpact).equals('5.5');
    });

    it('should clamp priceImpact to 100 when value exceeds 100', async () => {
      const request = new QuoteRequest({
        ...baseRequest,
        tradeType: 'EXACT_IN',
      });

      // Create a quote with swapInfo that has priceImpact = 150 (exceeds 100)
      const singleQuote = new QuoteSplit(
        [
          new QuoteBasic(
            new RouteBasic(UniProtocol.V2, [
              new V2Pool(
                new Address(baseRequest.tokenInAddress),
                new Address(baseRequest.tokenOutAddress),
                new Address('0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640'),
                BigInt('1000000000000'),
                BigInt('1000000000000')
              ),
            ]),
            BigInt('1234567890'),
            undefined,
            {
              gasUse: BigInt('150000'),
              gasPriceInWei: BigInt('30000000000'),
              gasCostInWei: BigInt('4500000000000000'),
              gasCostInEth: 0.0045,
              gasCostInQuoteToken: BigInt('1000000'),
            }
          ),
        ],
        new SwapInfo(
          baseRequest.tokenInAddress,
          baseRequest.tokenOutAddress,
          false,
          false,
          BigInt('1000000000000000000'),
          TradeType.ExactIn,
          150, // priceImpact exceeds 100
          new MethodParameters({
            to: '0x1234567890123456789012345678901234567890',
            calldata: '0x1234567890abcdef',
            value: '0x0',
          })
        )
      );

      const mockedQuoteStrategy = new MockedQuoteStrategy(singleQuote);
      const uniRouteBL = new UniRouteBL(
        serviceConfig,
        redisCache,
        chainRepository,
        poolDiscoverer,
        freshPoolDetailsWrapper,
        tokenHandler,
        quoteFetcher,
        quoteSelector,
        routeQuoteAllocator,
        gasEstimateProvider,
        noGasConverter,
        routeRepository,
        cachedRoutesRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap
      );

      const response = await uniRouteBL.quote(ctx, request);

      expect(response.priceImpact).equals('100');
    });

    it('should clamp priceImpact to -100 when value is less than -100', async () => {
      const request = new QuoteRequest({
        ...baseRequest,
        tradeType: 'EXACT_IN',
      });

      // Create a quote with swapInfo that has priceImpact = -150 (less than -100)
      const singleQuote = new QuoteSplit(
        [
          new QuoteBasic(
            new RouteBasic(UniProtocol.V2, [
              new V2Pool(
                new Address(baseRequest.tokenInAddress),
                new Address(baseRequest.tokenOutAddress),
                new Address('0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640'),
                BigInt('1000000000000'),
                BigInt('1000000000000')
              ),
            ]),
            BigInt('1234567890'),
            undefined,
            {
              gasUse: BigInt('150000'),
              gasPriceInWei: BigInt('30000000000'),
              gasCostInWei: BigInt('4500000000000000'),
              gasCostInEth: 0.0045,
              gasCostInQuoteToken: BigInt('1000000'),
            }
          ),
        ],
        new SwapInfo(
          baseRequest.tokenInAddress,
          baseRequest.tokenOutAddress,
          false,
          false,
          BigInt('1000000000000000000'),
          TradeType.ExactIn,
          -150, // priceImpact less than -100
          new MethodParameters({
            to: '0x1234567890123456789012345678901234567890',
            calldata: '0x1234567890abcdef',
            value: '0x0',
          })
        )
      );

      const mockedQuoteStrategy = new MockedQuoteStrategy(singleQuote);
      const uniRouteBL = new UniRouteBL(
        serviceConfig,
        redisCache,
        chainRepository,
        poolDiscoverer,
        freshPoolDetailsWrapper,
        tokenHandler,
        quoteFetcher,
        quoteSelector,
        routeQuoteAllocator,
        gasEstimateProvider,
        noGasConverter,
        routeRepository,
        cachedRoutesRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap
      );

      const response = await uniRouteBL.quote(ctx, request);

      expect(response.priceImpact).equals('-100');
    });

    it('should handle edge cases: exactly 100, exactly -100, and 0', async () => {
      const request = new QuoteRequest({
        ...baseRequest,
        tradeType: 'EXACT_IN',
      });

      // Test exactly 100
      const quoteAt100 = new QuoteSplit(
        [
          new QuoteBasic(
            new RouteBasic(UniProtocol.V2, [
              new V2Pool(
                new Address(baseRequest.tokenInAddress),
                new Address(baseRequest.tokenOutAddress),
                new Address('0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640'),
                BigInt('1000000000000'),
                BigInt('1000000000000')
              ),
            ]),
            BigInt('1234567890'),
            undefined,
            {
              gasUse: BigInt('150000'),
              gasPriceInWei: BigInt('30000000000'),
              gasCostInWei: BigInt('4500000000000000'),
              gasCostInEth: 0.0045,
              gasCostInQuoteToken: BigInt('1000000'),
            }
          ),
        ],
        new SwapInfo(
          baseRequest.tokenInAddress,
          baseRequest.tokenOutAddress,
          false,
          false,
          BigInt('1000000000000000000'),
          TradeType.ExactIn,
          100, // exactly 100
          new MethodParameters({
            to: '0x1234567890123456789012345678901234567890',
            calldata: '0x1234567890abcdef',
            value: '0x0',
          })
        )
      );

      const mockedQuoteStrategyAt100 = new MockedQuoteStrategy(quoteAt100);
      const uniRouteBL = new UniRouteBL(
        serviceConfig,
        redisCache,
        chainRepository,
        poolDiscoverer,
        freshPoolDetailsWrapper,
        tokenHandler,
        quoteFetcher,
        quoteSelector,
        routeQuoteAllocator,
        gasEstimateProvider,
        noGasConverter,
        routeRepository,
        cachedRoutesRepository,
        mockedQuoteStrategyAt100,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap
      );

      const responseAt100 = await uniRouteBL.quote(ctx, request);
      expect(responseAt100.priceImpact).equals('100');

      // Test exactly -100
      const quoteAtNeg100 = new QuoteSplit(
        [
          new QuoteBasic(
            new RouteBasic(UniProtocol.V2, [
              new V2Pool(
                new Address(baseRequest.tokenInAddress),
                new Address(baseRequest.tokenOutAddress),
                new Address('0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640'),
                BigInt('1000000000000'),
                BigInt('1000000000000')
              ),
            ]),
            BigInt('1234567890'),
            undefined,
            {
              gasUse: BigInt('150000'),
              gasPriceInWei: BigInt('30000000000'),
              gasCostInWei: BigInt('4500000000000000'),
              gasCostInEth: 0.0045,
              gasCostInQuoteToken: BigInt('1000000'),
            }
          ),
        ],
        new SwapInfo(
          baseRequest.tokenInAddress,
          baseRequest.tokenOutAddress,
          false,
          false,
          BigInt('1000000000000000000'),
          TradeType.ExactIn,
          -100, // exactly -100
          new MethodParameters({
            to: '0x1234567890123456789012345678901234567890',
            calldata: '0x1234567890abcdef',
            value: '0x0',
          })
        )
      );

      const mockedQuoteStrategyAtNeg100 = new MockedQuoteStrategy(
        quoteAtNeg100
      );
      const uniRouteBLNeg100 = new UniRouteBL(
        serviceConfig,
        redisCache,
        chainRepository,
        poolDiscoverer,
        freshPoolDetailsWrapper,
        tokenHandler,
        quoteFetcher,
        quoteSelector,
        routeQuoteAllocator,
        gasEstimateProvider,
        noGasConverter,
        routeRepository,
        cachedRoutesRepository,
        mockedQuoteStrategyAtNeg100,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap
      );

      const responseAtNeg100 = await uniRouteBLNeg100.quote(ctx, request);
      expect(responseAtNeg100.priceImpact).equals('-100');

      // Test exactly 0
      const quoteAt0 = new QuoteSplit(
        [
          new QuoteBasic(
            new RouteBasic(UniProtocol.V2, [
              new V2Pool(
                new Address(baseRequest.tokenInAddress),
                new Address(baseRequest.tokenOutAddress),
                new Address('0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640'),
                BigInt('1000000000000'),
                BigInt('1000000000000')
              ),
            ]),
            BigInt('1234567890'),
            undefined,
            {
              gasUse: BigInt('150000'),
              gasPriceInWei: BigInt('30000000000'),
              gasCostInWei: BigInt('4500000000000000'),
              gasCostInEth: 0.0045,
              gasCostInQuoteToken: BigInt('1000000'),
            }
          ),
        ],
        new SwapInfo(
          baseRequest.tokenInAddress,
          baseRequest.tokenOutAddress,
          false,
          false,
          BigInt('1000000000000000000'),
          TradeType.ExactIn,
          0, // exactly 0
          new MethodParameters({
            to: '0x1234567890123456789012345678901234567890',
            calldata: '0x1234567890abcdef',
            value: '0x0',
          })
        )
      );

      const mockedQuoteStrategyAt0 = new MockedQuoteStrategy(quoteAt0);
      const uniRouteBL0 = new UniRouteBL(
        serviceConfig,
        redisCache,
        chainRepository,
        poolDiscoverer,
        freshPoolDetailsWrapper,
        tokenHandler,
        quoteFetcher,
        quoteSelector,
        routeQuoteAllocator,
        gasEstimateProvider,
        noGasConverter,
        routeRepository,
        cachedRoutesRepository,
        mockedQuoteStrategyAt0,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap
      );

      const responseAt0 = await uniRouteBL0.quote(ctx, request);
      expect(responseAt0.priceImpact).equals('0');
    });

    it('should handle priceImpact calculation errors gracefully and default to 0', async () => {
      const request = new QuoteRequest({
        ...baseRequest,
        tradeType: 'EXACT_IN',
        simulateFromAddress: '0x1234567890123456789012345678901234567890',
        recipient: '0x1234567890123456789012345678901234567890',
        slippageTolerance: 20,
      });

      // Create a quote that will be used for building the trade
      const singleQuote = new QuoteSplit([
        new QuoteBasic(
          new RouteBasic(UniProtocol.V2, [
            new V2Pool(
              new Address(baseRequest.tokenInAddress),
              new Address(baseRequest.tokenOutAddress),
              new Address('0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640'),
              BigInt('1000000000000'),
              BigInt('1000000000000')
            ),
          ]),
          BigInt('1234567890'),
          undefined,
          {
            gasUse: BigInt('150000'),
            gasPriceInWei: BigInt('30000000000'),
            gasCostInWei: BigInt('4500000000000000'),
            gasCostInEth: 0.0045,
            gasCostInQuoteToken: BigInt('1000000'),
          }
        ),
      ]);

      const mockedQuoteStrategy = new MockedQuoteStrategy(singleQuote);

      // Create a simulator that preserves tokensInfo and swapInfo
      class PreservingSimulator implements ISimulator {
        async simulate(
          chainId: ChainId,
          swapOptions: unknown,
          quoteSplit: QuoteSplit,
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          tokenInCurrencyInfo: CurrencyInfo,
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          tokenOutCurrencyInfo: CurrencyInfo,
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          amountIn: bigint,
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          expectedAmountOut: bigint,
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          ctx: Context
        ): Promise<QuoteSplit> {
          const gasCostInQuoteToken = quoteSplit.quotes.reduce(
            (sum, q) => sum + (q.gasDetails?.gasCostInQuoteToken ?? 0n),
            0n
          );
          const estimatedGasUsed = quoteSplit.quotes.reduce(
            (sum, q) => sum + (q.gasDetails?.gasUse ?? 0n),
            0n
          );

          // Preserve tokensInfo and swapInfo from input quote
          return new QuoteSplit(
            quoteSplit.quotes,
            quoteSplit.swapInfo,
            {
              estimatedGasUsed: estimatedGasUsed,
              estimatedGasUsedInQuoteToken: gasCostInQuoteToken,
              status: SimulationStatus.SUCCESS,
              description: 'Simulation completed successfully',
            },
            quoteSplit.tokensInfo
          );
        }
      }

      const preservingSimulator = new PreservingSimulator();

      // Mock buildTrade to return a trade where priceImpact.toFixed() throws an error
      const buildTradeSpy = vi
        .spyOn(await import('../lib/methodParameters'), 'buildTrade')
        .mockImplementation(() => {
          return {
            priceImpact: {
              toFixed: () => {
                throw new Error('Price impact calculation failed (ROUTE-886)');
              },
            },
            routes: [
              {
                input: {symbol: 'ETH'},
                output: {symbol: 'USDC'},
                pools: [
                  {
                    token0: {
                      symbol: 'ETH',
                      wrapped: {address: baseRequest.tokenInAddress},
                      decimals: 18,
                      isNative: true,
                    },
                    token1: {
                      symbol: 'USDC',
                      wrapped: {address: baseRequest.tokenOutAddress},
                      decimals: 6,
                      isNative: false,
                    },
                    chainId: 1,
                  },
                ],
              },
            ],
          } as unknown as Trade<Currency, Currency, SdkTradeType>;
        });

      const buildSwapMethodParametersSpy = vi
        .spyOn(
          await import('../lib/methodParameters'),
          'buildSwapMethodParameters'
        )
        .mockImplementation(mockBuildSwapMethodParameters);

      // Use config with simulation enabled
      const simulationEnabledConfig = {
        ...serviceConfigAsync,
        Simulation: {
          ...serviceConfigAsync.Simulation,
          Enabled: true,
        },
      };

      const uniRouteBL = new UniRouteBL(
        simulationEnabledConfig,
        redisCache,
        chainRepository,
        poolDiscoverer,
        freshPoolDetailsWrapper,
        tokenHandler,
        quoteFetcher,
        quoteSelector,
        routeQuoteAllocator,
        gasEstimateProvider,
        noGasConverter,
        routeRepository,
        cachedRoutesRepository,
        mockedQuoteStrategy,
        preservingSimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap
      );

      const response = await uniRouteBL.quote(ctx, request);

      // Should still return a successful response (not crash)
      expect(response.error).toBeUndefined();

      // Should have priceImpact defaulted to 0 when calculation fails
      expect(response.priceImpact).equals('0');

      // Should have method parameters (quote should still be usable)
      expect(response.methodParameters).toBeDefined();

      // Clean up spies
      buildTradeSpy.mockRestore();
      buildSwapMethodParametersSpy.mockRestore();
    });
  });
});
