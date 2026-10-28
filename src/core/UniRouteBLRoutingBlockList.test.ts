import {describe, expect, it} from 'vitest';
import {InMemoryRedisCache} from '@uniswap/lib-cache/redis';
import {buildTestContext} from '@uniswap/lib-testhelpers';
import {Context} from '@uniswap/lib-uni/context';
import {TokenList} from '@uniswap/token-lists';
import {JsonRpcProvider} from '@ethersproject/providers';
import {UniRouteBL} from './UniRouteBL';
import {QuoteRequestValidator} from './QuoteRequestValidator';
import {IQuoteStrategy} from './strategy/IQuoteStrategy';
import {IGasEstimateProvider} from './gas/estimator/GasEstimateProvider';
import {NoGasConverter} from './gas/converter/IGasConverter';
import {SimpleQuoteSelector} from './quote/selector/SimpleQuoteSelector';
import {RouteQuoteAllocator} from './route/RouteQuoteAllocator';
import {RouteFinder} from './route/RouteFinder';
import {DummySimulator} from './simulator/DummySimulator';
import {StateOverrideResolver} from './simulator/StateOverrideResolver';
import {
  AggHooksTopPoolsSelector,
  BasicTopPoolsSelector,
} from './pool-discovery/TopPoolsSelector';
import {
  IPoolDiscoverer,
  ITopPoolsSelector,
  UniPoolInfo,
  V3PoolInfo,
} from './pool-discovery/interface';
import {
  aggHooksPoolSelectionPerChainConfig,
  ChainId,
  getUniRouteTestConfig,
  LambdaType,
  poolSelectionConfig,
} from '../lib/config';
import {NoOpMessageQueue} from '../lib/queue';
import {Address} from '../models/address/Address';
import {Chain} from '../models/chain/Chain';
import {RouteNamespaceContext} from '../models/hooks/namespaces';
import {HooksOptions} from '../models/hooks/HooksOptions';
import {Pool} from '../models/pool/Pool';
import {Protocol} from '../models/pool/Protocol';
import {QuoteBasic} from '../models/quote/QuoteBasic';
import {QuoteSplit} from '../models/quote/QuoteSplit';
import {RouteBasic} from '../models/route/RouteBasic';
import {Erc20Token} from '../models/token/Erc20Token';
import {HardcodedChainRepository} from '../stores/chain/hardcoded/HardcodedChainRepository';
import {FeatureGatedTokensRepository} from '../stores/compliance/FeatureGatedTokensRepository';
import {IFreshPoolDetailsWrapper} from '../stores/pool/FreshPoolDetailsWrapper';
import {IQuoteFetcher} from '../stores/quote/IQuoteFetcher';
import {CachedRoutesRepository} from '../stores/route/uniroutes/CachedRoutesRepository';
import {NoRouteCacheRepository} from '../stores/route/uniroutes/NoRouteCacheRepository';
import {UniRoutesRepository} from '../stores/route/uniroutes/UniRoutesRepository';
import {TokenProvider} from '../stores/token/provider/TokenProvider';
import {FakeTokenHandler} from '../../tests/test-utils/FakeTokenHandler';
import {QuoteRequest} from '../../gen/uniroute/v1/api_pb';
import {QuoteErrorReason, quoteErrorReasonOf} from '../lib/quoteErrorReason';

class FakePoolDiscoverer implements IPoolDiscoverer<UniPoolInfo> {
  constructor(
    public getPools: IPoolDiscoverer<UniPoolInfo>['getPools'],
    public getPoolsForTokens: IPoolDiscoverer<UniPoolInfo>['getPoolsForTokens']
  ) {}
}

class FakeQuoteStrategy implements IQuoteStrategy {
  constructor(
    public findBestQuoteCandidates: IQuoteStrategy['findBestQuoteCandidates']
  ) {}

  name(): string {
    return 'FakeQuoteStrategy';
  }
}

class FakeQuoteFetcher implements IQuoteFetcher {
  constructor(public fetchQuotes: IQuoteFetcher['fetchQuotes']) {}
}

class FakeGasEstimateProvider implements IGasEstimateProvider {
  constructor(
    public estimateGas: IGasEstimateProvider['estimateGas'],
    public getCurrentGasPrice: IGasEstimateProvider['getCurrentGasPrice']
  ) {}
}

class FakeFreshPoolDetailsWrapper implements IFreshPoolDetailsWrapper {
  constructor(
    public getPoolDetailsForRoute: IFreshPoolDetailsWrapper['getPoolDetailsForRoute'],
    public getPoolsDetails: IFreshPoolDetailsWrapper['getPoolsDetails']
  ) {}
}

// HOOKR -> WETH on Robinhood through the real UniRoutesRepository, selector
// and RouteFinder. The strategy prices the wHOOKR route above the direct
// pool, as QuoterV2 does, so the quote only avoids it if the route never
// reaches the strategy.
describe('UniRouteBL.quote routing block list', () => {
  const hookr = '0x18e674231a58c239dc7daedcffe15ec3a24cff5c';
  const wHookrChecksummed = '0x0cB7b36476d577C683f7Ec03994ddC0e006a97bd';
  const weth = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
  const hookrWHookrPool = '0xdd0ebece3c0cca47a21e552da73a8a0a1f14f613';
  const wHookrWethPool = '0x7aa37359d6d6ed87f6762b91ba3d57bcac91dac3';
  const hookrWethPool = '0xd8b750f564321ce68b4b3d8498616da96fad798d';
  const wrapperPools = new Set([hookrWHookrPool, wHookrWethPool]);

  const v3Pool = (
    id: string,
    token0: string,
    token1: string,
    tvlUSD: number
  ): V3PoolInfo => ({
    id,
    token0: {id: token0},
    token1: {id: token1},
    feeTier: '100',
    liquidity: '1000000',
    tvlETH: tvlUSD,
    tvlUSD,
  });
  // wHOOKR is checksummed in one pool and lowercase in the other, and its
  // pools outrank the direct pool on TVL.
  const v3Universe: UniPoolInfo[] = [
    v3Pool(hookrWHookrPool, hookr, wHookrChecksummed, 1_000_000),
    v3Pool(wHookrWethPool, wHookrChecksummed.toLowerCase(), weth, 1_000_000),
    v3Pool(hookrWethPool, weth.toLowerCase(), hookr, 1_000),
  ];

  const universeFor = (protocol: Protocol) =>
    protocol === Protocol.V3 ? v3Universe : [];

  const poolDiscoverer = new FakePoolDiscoverer(
    async (_chainId, protocol) => universeFor(protocol),
    async (
      chainId: ChainId,
      protocol: Protocol,
      tokenIn: Address,
      tokenOut: Address,
      topPoolSelector: ITopPoolsSelector<UniPoolInfo>,
      hooksOptions: HooksOptions | undefined,
      _skipPoolsForTokensCache: boolean,
      nsCtx: RouteNamespaceContext,
      ctx: Context
    ) =>
      topPoolSelector.filterPools(
        universeFor(protocol),
        chainId,
        tokenIn,
        tokenOut,
        protocol,
        hooksOptions,
        nsCtx,
        ctx,
        {shouldUseCache: false}
      )
  );

  const routesSeenByStrategy: RouteBasic<Pool>[] = [];
  const isWrapperRoute = (route: RouteBasic<Pool>) =>
    route.path.some(pool =>
      wrapperPools.has(pool.address.toString().toLowerCase())
    );
  const quoteStrategy = new FakeQuoteStrategy(
    async (
      _ctx,
      _chain,
      _tokenIn,
      _tokenOut,
      _amount,
      _tradeType,
      _protocols,
      _serviceConfig,
      routes
    ) => {
      routesSeenByStrategy.push(...routes);
      return routes
        .map(
          route =>
            new QuoteSplit([
              new QuoteBasic(route, isWrapperRoute(route) ? 2_000n : 1_000n),
            ])
        )
        .sort((a, b) => Number(b.quotes[0].amount - a.quotes[0].amount));
    }
  );

  const buildBL = () => {
    const serviceConfig = getUniRouteTestConfig(LambdaType.Sync);
    const config = {
      ...serviceConfig,
      GasEstimation: {...serviceConfig.GasEstimation, Enabled: false},
    };
    const redisCache = new InMemoryRedisCache<string, string>();
    const chainRepository = new HardcodedChainRepository();
    const tokenProvider = new TokenProvider(
      new InMemoryRedisCache<string, TokenList>()
    );
    const routeRepository = new UniRoutesRepository(
      new RouteFinder(config),
      poolDiscoverer,
      new BasicTopPoolsSelector(
        chainRepository,
        poolSelectionConfig,
        FeatureGatedTokensRepository.empty()
      ),
      new AggHooksTopPoolsSelector(
        aggHooksPoolSelectionPerChainConfig,
        FeatureGatedTokensRepository.empty()
      ),
      config
    );
    const tokenHandler = new FakeTokenHandler(
      async (_chain: Chain, address: Address) =>
        new Erc20Token(address, 18, 'TKN', 'Token', undefined, 1),
      async (_chain: Chain, addresses: Address[]) =>
        new Map(
          addresses.map(address => [
            address.toString(),
            new Erc20Token(address, 18, 'TKN', 'Token', undefined, 1),
          ])
        )
    );
    return new UniRouteBL(
      config,
      redisCache,
      chainRepository,
      poolDiscoverer,
      new FakeFreshPoolDetailsWrapper(
        async (_ctx, quotes) =>
          new Map(
            quotes.flatMap(quote =>
              quote.route.path.map(pool => [pool.address.toString(), pool])
            )
          ),
        async () => new Map()
      ),
      tokenHandler,
      new FakeQuoteFetcher(async () => []),
      new SimpleQuoteSelector(),
      new RouteQuoteAllocator(),
      new FakeGasEstimateProvider(
        async () => {
          throw new Error('gas estimation is disabled in this test');
        },
        async () => 0
      ),
      new NoGasConverter(),
      routeRepository,
      new CachedRoutesRepository(
        redisCache,
        config,
        new NoOpMessageQueue(),
        FeatureGatedTokensRepository.empty()
      ),
      new NoRouteCacheRepository(redisCache, config),
      quoteStrategy,
      new DummySimulator(),
      new QuoteRequestValidator(chainRepository, tokenProvider),
      tokenProvider,
      new Map<ChainId, JsonRpcProvider>(),
      new StateOverrideResolver()
    );
  };

  const quoteRequest = (tokenInAddress: string) =>
    new QuoteRequest({
      tokenInAddress,
      tokenInChainId: ChainId.ROBINHOOD,
      tokenOutAddress: weth,
      tokenOutChainId: ChainId.ROBINHOOD,
      amount: '1000000000000000000',
      tradeType: 'EXACT_IN',
      quoteType: 'FAST',
      protocols: 'v2,v3,v4,mixed',
      blockNumber: 99_000_000,
    });

  it('answers a wHOOKR input with the no-route 404', async () => {
    const response = await buildBL().quote(
      buildTestContext(),
      quoteRequest(wHookrChecksummed)
    );

    expect(response.error?.code).toBe(404);
    expect(quoteErrorReasonOf(response.error)).toBe(QuoteErrorReason.NO_ROUTE);
    expect(response.route).toEqual([]);
    expect(routesSeenByStrategy.filter(isWrapperRoute)).toEqual([]);
  });

  it('quotes HOOKR -> WETH through the direct pool, never through wHOOKR', async () => {
    const response = await buildBL().quote(
      buildTestContext(),
      quoteRequest(hookr)
    );

    expect(routesSeenByStrategy.length).toBeGreaterThan(0);
    expect(routesSeenByStrategy.filter(isWrapperRoute)).toEqual([]);
    expect(response.quoteAmount).toBe('1000');
    expect(
      response.route.map(leg => leg.pools.map(pool => pool.address))
    ).toEqual([[new Address(hookrWethPool).toString()]]);
  });
});
