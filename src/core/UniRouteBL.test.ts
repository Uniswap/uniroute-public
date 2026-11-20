import {FakeTokenHandler} from '../../tests/test-utils/FakeTokenHandler';
import {create, fromJson, toJson} from '@bufbuild/protobuf';
import {getGasToken} from '../lib/tokenUtils';
import {IQuoteStrategy} from './strategy/IQuoteStrategy';
import {OnChainQuoteFetchError} from '../stores/quote/OnChainQuoteFetchError';
import {OnChainQuoteFetcher} from '../stores/quote/OnChainQuoteFetcher';
import {IPermissionedQuoteOverrideSource} from '../stores/quote/permissionedQuoteOverrides';
import {DeepQuoteStrategy} from './strategy/DeepQuoteStrategy';
import {
  captureEthersRpcError,
  ethersCallTimeoutError,
  MALFORMED_RESULT,
  MULTICALL_TRANSACTION,
  NODE_HEADER_NOT_FOUND,
  serveRpcReply,
} from '../../tests/test-utils/ethersRpcErrors';
import {IChainRepository} from '../stores/chain/IChainRepository';
import {MAINNET} from '../stores/chain/hardcoded/chains/Mainnet';
import {constants} from 'ethers';
import {IQuoteSelector} from './quote/selector/IQuoteSelector';
import {describe, expect, it, beforeEach, vi} from 'vitest';
import {UniRouteBL} from './UniRouteBL';
import {TokenMetadataChainSelection} from '../stores/token/storage/tokenMetadataChainSelection';
import {
  buildMetricKey,
  getUniRouteTestConfig,
  getUniRouteSyncCacheMissRouteFinderOverrides,
  IUniRouteServiceConfig,
  LambdaType,
  MIN_REQUEST_ROUTING_TIME_BUDGET_MS,
  QuoteService,
} from '../lib/config';
import {HardcodedChainRepository} from '../stores/chain/hardcoded/HardcodedChainRepository';
import {QuoteRequestValidator} from './QuoteRequestValidator';
import {QuoteType} from '../models/quote/QuoteType';
import {QuoteOptions} from './IUniRouteBL';
import {
  QuoteRequest,
  PerHopSlippage,
  DeleteCachedRoutesRequestSchema,
  GetCachedRoutesRequestSchema,
  MethodParametersSchema,
  QuoteRequestSchema,
  QuoteResponseSchema,
} from '../../gen/uniroute/v1/api_pb';

import {buildTestContext, TestMetric} from '@uniswap/lib-testhelpers';
import {IMetrics, MetricOptions} from '@uniswap/lib-uni';
import {ITokenHandler} from '../stores/token/ITokenHandler';
import {Chain} from '../models/chain/Chain';
import {Address} from '../models/address/Address';
import {Erc20Token} from '../models/token/Erc20Token';
import {FeeOnTransfer} from '../models/token/FeeOnTransfer';
import {Context as UniContext} from '@uniswap/lib-uni/context';
import {IQuoteFetcher} from '../stores/quote/IQuoteFetcher';
import {QuoteBasic} from '../models/quote/QuoteBasic';
import {RouteBasic} from '../models/route/RouteBasic';
import {TradeType} from '../models/quote/TradeType';
import {SimpleQuoteSelector} from './quote/selector/SimpleQuoteSelector';
import {
  IRoutesRepository,
  RouteDiscoveryResult,
} from '../stores/route/IRoutesRepository';
import {V2Pool} from '../models/pool/V2Pool';
import {V3Pool} from '../models/pool/V3Pool';
import {V4Pool} from '../models/pool/V4Pool';
import {XSTOCK_WRAP_HOOKS_ON_MONAD} from '../lib/poolCaching/util/xStockWrapHooks';
import {
  FEW_V2_SHELL_HOOK_ON_MAINNET_2,
  isZlcaHookSettleBeforeSwap,
  LOOPER_ORIGIN_ARM_HOOK_ON_MAINNET,
} from '../lib/poolCaching/util/hooksAddressesAllowlist';
import {GasEstimateProvider} from './gas/estimator/GasEstimateProvider';
import {NoGasEstimator} from './gas/estimator/IGasEstimator';
import {ChainId} from '../lib/config';
import {QuoteErrorReason, quoteErrorReasonOf} from '../lib/quoteErrorReason';
import {JsonRpcProvider} from '@ethersproject/providers';
import {PoolDiscoverer} from './pool-discovery/PoolDiscoverer';
import {
  EmptyPoolDiscovererV2,
  EmptyPoolDiscovererV3,
  EmptyPoolDiscovererV4,
} from './pool-discovery/discoverers/EmptyPoolDiscoverer';
import {InMemoryRedisCache} from '@uniswap/lib-cache/redis';
import {IFreshPoolDetailsWrapper} from '../stores/pool/FreshPoolDetailsWrapper';
import {CachedRoutesRepository} from '../stores/route/uniroutes/CachedRoutesRepository';
import {RouteQuoteAllocator} from './route/RouteQuoteAllocator';
import {Context} from '@uniswap/lib-uni/context';
import {NoGasConverter} from './gas/converter/IGasConverter';
import {IGasConverter} from './gas/converter/IGasConverter';
import {QuoteSplit} from '../models/quote/QuoteSplit';
import {SwapInfo} from '../models/quote/SwapInfo';
import {BaseQuoteStrategy} from './strategy/BaseQuoteStrategy';
import {DummySimulator} from './simulator/DummySimulator';
import {ISimulator, SimulationStatus} from './simulator/ISimulator';
import {StateOverrideResolver} from './simulator/StateOverrideResolver';
import {CurrencyInfo} from '../models/currency/CurrencyInfo';
import {
  CachedRoutesReadResult,
  ICachedRoutesRepository,
} from 'src/stores/route/uniroutes/ICachedRoutesRepository';
import {
  INoRouteCacheRepository,
  NoRouteCacheRepository,
} from 'src/stores/route/uniroutes/NoRouteCacheRepository';
import {NoOpMessageQueue} from 'src/lib/queue';
import {HooksOptions} from '../models/hooks/HooksOptions';
import {TokenProvider} from 'src/stores/token/provider/TokenProvider';
import {TokenList} from '@uniswap/token-lists';
import {UsdBucket} from '../stores/route/uniroutes/usdBucketUtils';
import {ADDRESS_ZERO} from '@uniswap/v3-sdk';
import {HandlerContext, createHandlerContext} from '@connectrpc/connect';
import {unirouteService} from '../../gen/uniroute/v1/api_pb';
import {Trade} from '@uniswap/router-sdk';
import {
  Currency,
  CurrencyAmount,
  Ether,
  Token,
  TradeType as SdkTradeType,
} from '@uniswap/sdk-core';
import {BigNumber} from '@ethersproject/bignumber';
import {Protocol} from '../models/pool/Protocol';
import {Pool} from '../models/pool/Pool';
import {
  SWAP_PROXY_ADDRESS,
  TokenTransferMode,
  UniversalRouterVersion,
} from '@uniswap/universal-router-sdk';
import {Percent} from '@uniswap/sdk-core';
import {SwapOptionsFactory} from './swap/SwapOptionsFactory';
import {IPoolTransferProbe} from '../stores/fee-on-transfer/pool-probe/PoolTransferProbe';
import {
  PoolProbeTarget,
  poolProbeTargetKey,
  TransferMeasurement,
  TransferVerdict,
} from '../stores/fee-on-transfer/pool-probe/TransferSimulationSource';
import {
  SwapOptionsUniversalRouter,
  SwapType,
} from './simulator/sor-port/simulation-provider';
import {
  EMPTY_NAMESPACE_CONTEXT,
  RouteNamespaceContext,
} from '../models/hooks/namespaces';
import {FeatureGatedTokensRepository} from '../stores/compliance/FeatureGatedTokensRepository';
import {DiscoveryDegradedReason} from './pool-discovery/discoveryDegraded';
// Stub AGG_HOOKS_PER_CHAIN so the BestQuote leak-detection logic in UniRouteBL
// has a stable, non-empty allow-list for MAINNET without depending on which hook
// addresses are actually deployed in production.
vi.mock(
  'src/lib/poolCaching/util/hooksAddressesAllowlist',
  async importOriginal => {
    const actual =
      await importOriginal<
        typeof import('../lib/poolCaching/util/hooksAddressesAllowlist')
      >();
    return {
      isZlcaHookSettleBeforeSwap: actual.isZlcaHookSettleBeforeSwap,
      getSettleBeforeSwapHooks: actual.getSettleBeforeSwapHooks,
      LOOPER_ORIGIN_ARM_HOOK_ON_MAINNET:
        actual.LOOPER_ORIGIN_ARM_HOOK_ON_MAINNET,
      FEW_V2_SHELL_HOOK_ON_MAINNET_2: actual.FEW_V2_SHELL_HOOK_ON_MAINNET_2,
      getHookMinQuoteGasPerCall: actual.getHookMinQuoteGasPerCall,
      getHookMinSwapGasLimit: actual.getHookMinSwapGasLimit,
      MAX_HOOK_MIN_SWAP_GAS_LIMIT: actual.MAX_HOOK_MIN_SWAP_GAS_LIMIT,
      AGG_HOOKS_PER_CHAIN: {},
      AGG_HOOKS_PROTOCOL_CACHED_ROUTES_FILTER_OUT_LIST: new Set(),
      UNISWAP_AGG_HOOK_ON_TEMPO: '0x0000000000000000000000000000000000000000',
      getAggHooksForChain: (chainId: number) =>
        chainId === 1 ? ['0xaaaa000000000000000000000000000000000001'] : [],
      // MAINNET_AGG_HOOK – must match the literal used in the tests below.
      // Returns a non-undefined Protocol string so callers treat it as an agg hook.
      getProtocolForAggHookAddress: (hookAddress: string, chainId: number) =>
        chainId === 1 &&
        hookAddress.toLowerCase() ===
          '0xaaaa000000000000000000000000000000000001'
          ? 'CurveStableSwapNG'
          : undefined,
    };
  }
);

class FakeQuoteStrategy implements IQuoteStrategy {
  constructor(
    public findBestQuoteCandidates: IQuoteStrategy['findBestQuoteCandidates']
  ) {}

  name(): string {
    return 'FakeQuoteStrategy';
  }
}

class FakeQuoteSelector implements IQuoteSelector {
  constructor(public getBestQuotes: IQuoteSelector['getBestQuotes']) {}
}

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

class FotTokenHandler implements ITokenHandler {
  constructor(private readonly fotAddresses: Set<string>) {}

  public async getToken(
    chain: Chain,
    address: Address,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ctx: UniContext
  ): Promise<Erc20Token | null> {
    const isFot = this.fotAddresses.has(address.toString().toLowerCase());
    return new Erc20Token(
      address,
      18,
      'TEST',
      'TestToken',
      isFot ? new FeeOnTransfer(100, 100) : undefined,
      1.0
    );
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
        new RouteBasic(Protocol.V2, [
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

class TestRoutesRepository implements IRoutesRepository {
  public async fetchRoutesForTokens(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    chain: Chain,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    tokenInAddress: Address,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    tokenOutAddress: Address,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    protocols: Protocol[],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    generateMixedRoutes: boolean,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    hooksOptions: HooksOptions | undefined,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    skipPoolsForTokensCache: boolean,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    nsCtx: RouteNamespaceContext,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ctx: UniContext
  ): Promise<RouteDiscoveryResult> {
    return {routes: [], degradedReasons: []};
  }

  public async getRoutes(
    chain: Chain,
    tokenInCurrencyInfo: CurrencyInfo,
    tokenOutCurrencyInfo: CurrencyInfo,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    protocols: Protocol[],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    tradeType: TradeType,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    fotInDirectSwap: boolean,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    hooksOptions: HooksOptions | undefined,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    skipPoolsForTokensCache: boolean,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    nsCtx: RouteNamespaceContext,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ctx: UniContext
  ): Promise<RouteDiscoveryResult> {
    return {
      routes: [
        new RouteBasic(Protocol.V2, [
          new V2Pool(
            tokenInCurrencyInfo.wrappedAddress,
            tokenOutCurrencyInfo.wrappedAddress,
            new Address('0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640'),
            BigInt('1000000000000'),
            BigInt('1000000000000')
          ),
        ]),
      ],
      degradedReasons: [],
    };
  }
}

class TestFreshPoolDetailsWrapper implements IFreshPoolDetailsWrapper {
  public async getPoolDetailsForRoute(
    ctx: UniContext,
    quotes: QuoteBasic[],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    chain: Chain
  ): Promise<Map<string, Pool>> {
    const poolMap = new Map<string, Pool>();
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
    pools: Pool[],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    chain: Chain
  ): Promise<Map<string, Pool>> {
    return new Map();
  }
}

class OnDemandGasEstimateProvider extends GasEstimateProvider {
  async getCurrentGasPrice(_ctx: Context, _chainId: ChainId): Promise<number> {
    return 0;
  }
}

// Create a simulator that always fails simulation, with FAILED unless told otherwise
class FailingSimulator implements ISimulator {
  constructor(
    private readonly status: SimulationStatus = SimulationStatus.FAILED
  ) {}

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
        estimatedGasUsedInUSD: 0,
        status: this.status,
        description: 'Simulation failed for testing',
      },
    };
  }
}

// INSUFFICIENT_BALANCE from a seeded run that executed and measured gas
class SeededBalanceSimulator implements ISimulator {
  async simulate(
    chainId: ChainId,
    swapOptions: unknown,
    quoteSplit: QuoteSplit
  ): Promise<QuoteSplit> {
    return {
      ...quoteSplit,
      simulationResult: {
        estimatedGasUsed: 170000n,
        estimatedGasUsedInQuoteToken: 2000000n,
        estimatedGasUsedInUSD: 1.5,
        status: SimulationStatus.INSUFFICIENT_BALANCE,
        description:
          'Simulation succeeded with a seeded balance; user does not have sufficient balance.',
      },
    };
  }
}

// Records the quoteSplit (incl. swapInfo.methodParameters) it was asked to
// simulate, then returns a successful result.
class CapturingSimulator implements ISimulator {
  public captured: QuoteSplit | undefined;
  async simulate(
    _chainId: ChainId,
    _swapOptions: SwapOptionsUniversalRouter,
    quoteSplit: QuoteSplit
  ): Promise<QuoteSplit> {
    this.captured = quoteSplit;
    return {
      ...quoteSplit,
      simulationResult: {
        estimatedGasUsed: 100000n,
        estimatedGasUsedInQuoteToken: 0n,
        estimatedGasUsedInUSD: 0,
        status: SimulationStatus.SUCCESS,
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
      {} as RouteQuoteAllocator<Pool>,
      {} as SimpleQuoteSelector,
      {} as ITokenHandler,
      new Map(),
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
    protocols: Protocol[],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    serviceConfig: IUniRouteServiceConfig,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    routes: RouteBasic<Pool>[],
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
          new RouteBasic(Protocol.V2, [
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

class NoPermissionedQuoteOverrides implements IPermissionedQuoteOverrideSource {
  routeTouchesPermissionedPool(): boolean {
    return false;
  }

  async build(): Promise<undefined> {
    return undefined;
  }
}

// A mainnet RPC that answers the block number and gas price itself, so only
// the quote calls reach its endpoint. Built with its network so ethers never
// probes the endpoint.
class PinnedBlockRpcProvider extends JsonRpcProvider {
  constructor(url = 'http://127.0.0.1:1') {
    super(url, {name: 'mainnet', chainId: ChainId.MAINNET});
  }

  override getBlockNumber(): Promise<number> {
    return Promise.resolve(12345678);
  }

  override getGasPrice(): Promise<BigNumber> {
    return Promise.resolve(BigNumber.from(0));
  }
}

// An RPC whose every eth_call fails the same way.
class FailingRpcProvider extends PinnedBlockRpcProvider {
  constructor(private readonly failure: Error) {
    super();
  }

  override call(): Promise<string> {
    return Promise.reject(this.failure);
  }
}

class FixedRoutesRepository extends TestRoutesRepository {
  constructor(private readonly routes: readonly RouteBasic[]) {
    super();
  }

  override async getRoutes(): Promise<RouteDiscoveryResult> {
    return {routes: [...this.routes], degradedReasons: []};
  }
}

class FixedChainRepository implements IChainRepository {
  constructor(private readonly chain: Chain) {}

  async getChain(): Promise<Chain> {
    return this.chain;
  }
}

// A deep search whose quote fetch dropped routes and built no split.
class IncompleteQuoteStrategy extends MockedQuoteStrategy {
  constructor(private readonly batchError: Error) {
    super(null);
  }

  override async findBestQuoteCandidates(): Promise<QuoteSplit[]> {
    throw new OnChainQuoteFetchError('incomplete', [this.batchError]);
  }

  override name(): string {
    return 'IncompleteQuoteStrategy';
  }
}

describe('UniRouteBL', () => {
  let redisCache: InMemoryRedisCache<string, string>;
  let cachedRoutesRepository: ICachedRoutesRepository;
  let noRouteCacheRepository: INoRouteCacheRepository;

  beforeEach(() => {
    redisCache = new InMemoryRedisCache<string, string>();
    cachedRoutesRepository = new CachedRoutesRepository(
      redisCache,
      serviceConfig,
      new NoOpMessageQueue(),
      FeatureGatedTokensRepository.empty()
    );
    noRouteCacheRepository = new NoRouteCacheRepository(
      redisCache,
      serviceConfig
    );
  });

  // `tokenIn>tokenOut:bucket` for every route-cache key of these legs that
  // holds a no-route refresh cooldown.
  const noRouteCooldownKeys = async (
    legs: {tokenIn: Address; tokenOut: Address}[],
    protocols: Protocol[]
  ): Promise<string[]> => {
    const keyBuilder = new CachedRoutesRepository(
      redisCache,
      serviceConfig,
      new NoOpMessageQueue(),
      FeatureGatedTokensRepository.empty()
    );
    const present: string[] = [];
    for (const {tokenIn, tokenOut} of legs) {
      for (const usdBucket of Object.values(UsdBucket)) {
        const key = keyBuilder.constructNoRouteCooldownKey(
          EMPTY_NAMESPACE_CONTEXT,
          protocols,
          ChainId.MAINNET,
          tokenIn,
          tokenOut,
          TradeType.ExactIn,
          0n,
          usdBucket
        );
        if (await redisCache.contains(key)) {
          present.push(
            `${tokenIn.toString()}>${tokenOut.toString()}:${usdBucket}`
          );
        }
      }
    }
    return present;
  };

  const serviceConfig: IUniRouteServiceConfig = {
    ...getUniRouteTestConfig(LambdaType.Sync),
    CachedRoutes: {
      ...getUniRouteTestConfig(LambdaType.Sync).CachedRoutes,
      HitDiscoveryEnabled: true,
    },
  };
  const serviceConfigAsync: IUniRouteServiceConfig = {
    ...getUniRouteTestConfig(LambdaType.Async),
    CachedRoutes: {
      ...getUniRouteTestConfig(LambdaType.Async).CachedRoutes,
      HitDiscoveryEnabled: true,
    },
  };
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
    new EmptyPoolDiscovererV2(
      serviceConfig,
      localPoolCache,
      localPoolCache,
      FeatureGatedTokensRepository.empty()
    ),
    new EmptyPoolDiscovererV3(
      serviceConfig,
      localPoolCache,
      localPoolCache,
      FeatureGatedTokensRepository.empty()
    ),
    new EmptyPoolDiscovererV4(
      serviceConfig,
      localPoolCache,
      localPoolCache,
      FeatureGatedTokensRepository.empty()
    ),
    new EmptyPoolDiscovererV2(
      serviceConfig,
      localPoolCache,
      localPoolCache,
      FeatureGatedTokensRepository.empty()
    ),
    new EmptyPoolDiscovererV3(
      serviceConfig,
      localPoolCache,
      localPoolCache,
      FeatureGatedTokensRepository.empty()
    ),
    new EmptyPoolDiscovererV4(
      serviceConfig,
      localPoolCache,
      localPoolCache,
      FeatureGatedTokensRepository.empty()
    )
  );
  const freshPoolDetailsWrapper = new TestFreshPoolDetailsWrapper();
  const dummySimulator = new DummySimulator();
  const ctx = buildTestContext();

  // Create a mock fetcher that handles test lambda names
  ctx.fetcher = (
    ctx: Context,
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    // If the input is a test lambda name (not a valid URL), return a mock response
    if (typeof input === 'string' && input === 'test-lambda-name') {
      return Promise.resolve(new Response('OK', {status: 200}));
    }
    // Otherwise, use the real fetch
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
  const stateOverrideResolver = new StateOverrideResolver();

  // Add a mock provider for MAINNET to prevent undefined errors
  const mockProvider = {
    getBlockNumber: vi.fn().mockResolvedValue(12345678),
    getGasPrice: vi.fn().mockResolvedValue(BigNumber.from('0')),
  } as unknown as JsonRpcProvider;
  mockedRpcProviderMap.set(ChainId.MAINNET, mockProvider);

  describe('minGasLimit for routes through a hook with a gasleft() floor', () => {
    // HOOKR_ROOT on Robinhood, checksummed as pool data carries it while the
    // registry keys are lowercase; the expected floor is written out, not read
    // from the registry.
    const hookrRoot = '0x89c9FB50d1f03192230FFB1c279BB6E7d3Fe6aCc';
    const hookrModularV6 = '0xb3ca29cf721380cee8b8e4755f3865ebc68fe8cc';
    const tokenOutOnRobinhood = '0x1111111111111111111111111111111111111111';
    const providers = new Map<ChainId, JsonRpcProvider>([
      [ChainId.MAINNET, mockProvider],
      [ChainId.ROBINHOOD, mockProvider],
    ]);

    const intermediate = '0x2222222222222222222222222222222222222222';
    let poolCount = 0;

    function v4Pool(tokenIn: string, tokenOut: string, hooks: string): V4Pool {
      return new V4Pool(
        new Address(tokenIn),
        new Address(tokenOut),
        3000,
        60,
        hooks,
        BigInt('1000000000000'),
        `0x${(++poolCount).toString(16).padStart(64, '0')}`,
        BigInt('79228162514264337593543950336'),
        BigInt('0')
      );
    }

    // One leg; one pool per hook, chained ETH -> intermediate... -> tokenOut.
    function v4Route(
      chainTokenOut: string,
      ...hooksPerHop: string[]
    ): QuoteBasic {
      const tokens = [
        'ETH',
        ...hooksPerHop.slice(1).map(() => intermediate),
        chainTokenOut,
      ];
      return new QuoteBasic(
        new RouteBasic(
          Protocol.V4,
          hooksPerHop.map((hooks, hop) =>
            v4Pool(tokens[hop], tokens[hop + 1], hooks)
          )
        ),
        BigInt('1234567890'),
        undefined,
        {
          gasUse: BigInt('97000'),
          gasPriceInWei: BigInt('10000000'),
          gasCostInWei: BigInt('970000000000'),
          gasCostInEth: 0.00000097,
          gasCostInQuoteToken: BigInt('1000'),
        }
      );
    }

    async function quoteThrough(
      chainId: ChainId,
      tokenOut: string,
      quotes: QuoteBasic[]
    ) {
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
        noRouteCacheRepository,
        new MockedQuoteStrategy(new QuoteSplit(quotes)),
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        providers,
        stateOverrideResolver
      );
      return uniRouteBL.quote(
        ctx,
        create(QuoteRequestSchema, {
          ...baseRequest,
          tokenInChainId: chainId,
          tokenOutChainId: chainId,
          tokenOutAddress: tokenOut,
          tradeType: 'EXACT_IN',
        })
      );
    }

    it('sets the hook swap floor on a Robinhood route through HOOKR_ROOT', async () => {
      const response = await quoteThrough(
        ChainId.ROBINHOOD,
        tokenOutOnRobinhood,
        [v4Route(tokenOutOnRobinhood, hookrRoot)]
      );

      expect(response.minGasLimit).toBe('10000000');
      expect(response.gasUseEstimate).toBe('97000');
      expect(toJson(QuoteResponseSchema, response)).toHaveProperty(
        'minGasLimit',
        '10000000'
      );
    });

    it('sets it when only one leg of a split crosses the hook', async () => {
      const response = await quoteThrough(
        ChainId.ROBINHOOD,
        tokenOutOnRobinhood,
        [
          v4Route(tokenOutOnRobinhood, ADDRESS_ZERO),
          v4Route(tokenOutOnRobinhood, hookrRoot),
        ]
      );

      expect(response.minGasLimit).toBe('10000000');
    });

    it('adds a floor per swap through the hook, across legs and hops', async () => {
      const twoLegs = await quoteThrough(
        ChainId.ROBINHOOD,
        tokenOutOnRobinhood,
        [
          v4Route(tokenOutOnRobinhood, hookrRoot),
          v4Route(tokenOutOnRobinhood, ADDRESS_ZERO, hookrRoot),
        ]
      );
      const twoHops = await quoteThrough(
        ChainId.ROBINHOOD,
        tokenOutOnRobinhood,
        [v4Route(tokenOutOnRobinhood, hookrRoot, hookrRoot)]
      );

      expect(twoLegs.minGasLimit).toBe('20000000');
      expect(twoHops.minGasLimit).toBe('20000000');
    });

    it('caps the summed floor at 30M', async () => {
      const response = await quoteThrough(
        ChainId.ROBINHOOD,
        tokenOutOnRobinhood,
        [
          v4Route(tokenOutOnRobinhood, hookrRoot, hookrRoot),
          v4Route(tokenOutOnRobinhood, hookrRoot, hookrRoot),
        ]
      );

      expect(response.minGasLimit).toBe('30000000');
    });

    it('leaves it unset for hookless and other-hook routes on Robinhood', async () => {
      const response = await quoteThrough(
        ChainId.ROBINHOOD,
        tokenOutOnRobinhood,
        [
          v4Route(tokenOutOnRobinhood, ADDRESS_ZERO),
          v4Route(tokenOutOnRobinhood, hookrModularV6),
        ]
      );

      expect(response.minGasLimit).toBeUndefined();
      expect(toJson(QuoteResponseSchema, response)).not.toHaveProperty(
        'minGasLimit'
      );
    });

    it('leaves it unset for the same hook address on another chain', async () => {
      const response = await quoteThrough(
        ChainId.MAINNET,
        baseRequest.tokenOutAddress,
        [v4Route(baseRequest.tokenOutAddress, hookrRoot)]
      );

      expect(response.minGasLimit).toBeUndefined();
    });
  });

  describe('gas conversion trust passed through quote()', () => {
    it.each([
      {quotePriceUSD: 1, gasEnabled: true, expected: true},
      {quotePriceUSD: undefined, gasEnabled: true, expected: false},
      {quotePriceUSD: 10, gasEnabled: true, expected: false},
      {quotePriceUSD: 1, gasEnabled: false, expected: false},
    ])(
      'passes trust $expected with quote price $quotePriceUSD and gas enabled $gasEnabled',
      async ({quotePriceUSD, gasEnabled, expected}) => {
        const fifa = new Address('0x66641fcfca7d919629d5e4a72d9f13787fcaf304');
        const usdt = new Address('0xdac17f958d2ee523a2206206994597c13d831ec7');
        const native = getGasToken(ChainId.MAINNET);
        const tokens = new Map<string, Erc20Token | null>([
          [
            fifa.toString(),
            new Erc20Token(fifa, 18, 'FIFA', 'FIFA', undefined, 3.9787e-9),
          ],
          [
            usdt.toString(),
            new Erc20Token(
              usdt,
              6,
              'USDT',
              'Tether USD',
              undefined,
              quotePriceUSD
            ),
          ],
          [
            native.address,
            new Erc20Token(
              new Address(native.address),
              native.decimals,
              'WETH',
              'Wrapped Ether',
              undefined,
              2500
            ),
          ],
        ]);
        const pricedTokenHandler = new FakeTokenHandler(
          async (_chain, address) => tokens.get(address.toString()) ?? null,
          async () => tokens
        );
        const passedTrust: (boolean | undefined)[] = [];
        const capturingSelector = new FakeQuoteSelector(
          async (quotes, _tradeType, _topN, _metricTags, _ctx, options) => {
            passedTrust.push(options?.gasConversionTrusted);
            return quotes.slice(0, 1);
          }
        );
        const route = new RouteBasic(Protocol.V2, [
          new V2Pool(
            fifa,
            usdt,
            new Address('0x0000000000000000000000000000000000000001'),
            19200000000000000000000000n,
            76035n
          ),
        ]);
        // The best output is last and split so using the first candidate or a
        // single leg cannot accidentally confirm the measured exchange rate.
        const strategy = new FakeQuoteStrategy(async () => [
          new QuoteSplit([new QuoteBasic(route, 1n)]),
          new QuoteSplit([
            new QuoteBasic(new RouteBasic(Protocol.V2, route.path, 25), 19009n),
            new QuoteBasic(new RouteBasic(Protocol.V2, route.path, 35), 26612n),
            new QuoteBasic(new RouteBasic(Protocol.V2, route.path, 40), 30414n),
          ]),
        ]);
        const config = {
          ...serviceConfig,
          GasEstimation: {...serviceConfig.GasEstimation, Enabled: gasEnabled},
        };
        const bl = new UniRouteBL(
          config,
          redisCache,
          chainRepository,
          poolDiscoverer,
          freshPoolDetailsWrapper,
          pricedTokenHandler,
          quoteFetcher,
          capturingSelector,
          routeQuoteAllocator,
          gasEstimateProvider,
          noGasConverter,
          routeRepository,
          cachedRoutesRepository,
          noRouteCacheRepository,
          strategy,
          dummySimulator,
          quoteRequestValidator,
          tokenProvider,
          mockedRpcProviderMap,
          stateOverrideResolver
        );
        await bl.quote(
          ctx,
          create(QuoteRequestSchema, {
            ...baseRequest,
            tokenInAddress: fifa.toString().toLowerCase(),
            tokenOutAddress: usdt.toString().toLowerCase(),
            amount: '19200000000000000000000000',
            tradeType: 'EXACT_IN',
            blockNumber: 26186720,
          })
        );
        expect(passedTrust).toEqual([expected]);
      }
    );
  });

  describe('quote caching behavior', () => {
    it('should not use cached routes for FAST quote type in sync mode (start with empty cache)', async () => {
      // First call to cache routes
      const request = create(QuoteRequestSchema, {
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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      // First call should not use cached routes because cache is empty
      const firstResponse = await uniRouteBL.quote(ctx, request);
      expect(firstResponse.hitsCachedRoutes).toBe(false);

      // Second call should not use cached routes because sync/FAST shouldn't update cache
      const secondResponse = await uniRouteBL.quote(ctx, request);
      expect(secondResponse.hitsCachedRoutes).toBe(false);
    });

    it('should not use cached routes for FRESH quote type in sync mode (start with empty cache)', async () => {
      const request = create(QuoteRequestSchema, {
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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      const firstResponse = await uniRouteBL.quote(ctx, request);
      expect(firstResponse.hitsCachedRoutes).toBe(false);

      const secondResponse = await uniRouteBL.quote(ctx, request);
      expect(secondResponse.hitsCachedRoutes).toBe(false);
    });

    it('reads the cache on a second FAST async quote while fresh discovery replaces its path', async () => {
      const request = create(QuoteRequestSchema, {
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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      // First call should not use cached routes because cache is empty
      const firstResponse = await uniRouteBL.quote(ctx, request);
      expect(firstResponse.hitsCachedRoutes).toBe(false);

      // The cache read still counts as a hit when fresh finds the same path.
      const secondResponse = await uniRouteBL.quote(ctx, request);
      expect(secondResponse.hitsCachedRoutes).toBe(true);
    });

    it('should not use cached routes for FRESH quote type in async mode (start with empty cache)', async () => {
      const request = create(QuoteRequestSchema, {
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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      const firstResponse = await uniRouteBL.quote(ctx, request);
      expect(firstResponse.hitsCachedRoutes).toBe(false);

      const secondResponse = await uniRouteBL.quote(ctx, request);
      expect(secondResponse.hitsCachedRoutes).toBe(false);
    });
  });

  // The parallel-cache-reads refactor short-circuits with a 404 only when
  // BOTH the no-route cliff cache hits AND the positive cached-routes
  // cache returned nothing. If positive cached routes exist, they win
  // because they're keyed on the USD bucket (finer-grained than the
  // amount-cliff scalar) and represent affirmative evidence.
  describe('no-route cache short-circuit interaction with cached routes', () => {
    const allProtocols = [
      Protocol.V2,
      Protocol.V3,
      Protocol.V4,
      Protocol.MIXED,
    ];
    const wrappedEth = new Address(
      '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
    );
    const usdc = new Address('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
    const amount = BigInt(baseRequest.amount);

    const buildBL = (
      strategy: MockedQuoteStrategy = new MockedQuoteStrategy(),
      config: IUniRouteServiceConfig = serviceConfig,
      selector: SimpleQuoteSelector = quoteSelector
    ) =>
      new UniRouteBL(
        config,
        redisCache,
        chainRepository,
        poolDiscoverer,
        freshPoolDetailsWrapper,
        tokenHandler,
        quoteFetcher,
        selector,
        routeQuoteAllocator,
        gasEstimateProvider,
        noGasConverter,
        routeRepository,
        cachedRoutesRepository,
        noRouteCacheRepository,
        strategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

    // Minimal Headers stand-in to avoid the lint warning about the
    // Headers global (Node < 21). The cache-check path only uses
    // `set`/`get` so a Map-backed shim is sufficient.
    const buildHandlerContextWithHeaders = (): {
      handlerContext: HandlerContext;
      headers: Map<string, string>;
    } => {
      const headers = new Map<string, string>();
      const responseHeader = {
        set: (k: string, v: string) => headers.set(k, v),
        get: (k: string) => headers.get(k) ?? null,
      };
      const handlerContext = {
        responseHeader,
      } as unknown as HandlerContext;
      return {handlerContext, headers};
    };

    it('short-circuits with 404 + x-no-route-cache-hit header when cliff hits and route cache is empty', async () => {
      await noRouteCacheRepository.setAmountCliff(
        EMPTY_NAMESPACE_CONTEXT,
        allProtocols,
        ChainId.MAINNET,
        wrappedEth,
        usdc,
        TradeType.ExactIn,
        amount,
        buildTestContext()
      );

      const {handlerContext, headers} = buildHandlerContextWithHeaders();
      const testCtx = buildTestContext(handlerContext);
      const response = await buildBL().quote(
        testCtx,
        create(QuoteRequestSchema, {...baseRequest, tradeType: 'EXACT_IN'})
      );

      expect(response.error?.code).toBe(404);
      expect(response.hitsCachedRoutes).toBe(false);
      expect(headers.get('x-no-route-cache-hit')).toBe('true');
    });

    it('does not short-circuit when the cliff and a positive route cache hit coexist', async () => {
      // Seed positive route cache for the EXACT_IN / USDC pair / ETH input.
      const dummyRoute = new RouteBasic(Protocol.V2, [
        new V2Pool(
          wrappedEth,
          usdc,
          new Address('0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640'),
          BigInt('1000000000000'),
          BigInt('1000000000000')
        ),
      ]);

      // The cache check inside quote() runs with a USD bucket derived
      // from the request amount; saving for every bucket covers it.
      for (const usdBucket of Object.values(UsdBucket)) {
        // Save both wrapped+wrapped and ADDRESS_ZERO+wrapped to cover the
        // native+V4 fan-out (request uses 'ETH' as input).
        await cachedRoutesRepository.saveCachedRoutes(
          EMPTY_NAMESPACE_CONTEXT,
          allProtocols,
          dummyRoute,
          ChainId.MAINNET,
          wrappedEth,
          usdc,
          TradeType.ExactIn,
          amount,
          usdBucket
        );
        await cachedRoutesRepository.saveCachedRoutes(
          EMPTY_NAMESPACE_CONTEXT,
          allProtocols,
          dummyRoute,
          ChainId.MAINNET,
          new Address(ADDRESS_ZERO),
          usdc,
          TradeType.ExactIn,
          amount,
          usdBucket
        );
      }

      await noRouteCacheRepository.setAmountCliff(
        EMPTY_NAMESPACE_CONTEXT,
        allProtocols,
        ChainId.MAINNET,
        wrappedEth,
        usdc,
        TradeType.ExactIn,
        amount,
        buildTestContext()
      );

      const {handlerContext, headers} = buildHandlerContextWithHeaders();
      const testCtx = buildTestContext(handlerContext);
      const response = await buildBL().quote(
        testCtx,
        create(QuoteRequestSchema, {...baseRequest, tradeType: 'EXACT_IN'})
      );

      // The positive cache prevents a short circuit and supplies a candidate.
      expect(response.error?.code).not.toBe(404);
      expect(response.hitsCachedRoutes).toBe(true);
      expect(headers.get('x-no-route-cache-hit')).toBeUndefined();
    });

    describe('no-route refresh cooldown', () => {
      const nativeEth = new Address(ADDRESS_ZERO);
      type Leg = {tokenIn: Address; tokenOut: Address};
      // An ETH-input and an ETH-output request: each reads (and refreshes) a
      // wrapped leg and a native V4 leg, the native side keyed under
      // ADDRESS_ZERO on whichever side of the pair the ETH is.
      const cases: {
        name: string;
        request: typeof baseRequest & {tradeType: string};
        legs: Leg[];
      }[] = [
        {
          name: 'native input',
          request: {...baseRequest, tradeType: 'EXACT_IN'},
          legs: [
            {tokenIn: wrappedEth, tokenOut: usdc},
            {tokenIn: nativeEth, tokenOut: usdc},
          ],
        },
        {
          name: 'native output',
          request: {
            ...baseRequest,
            tokenInAddress: usdc.toString(),
            tokenOutAddress: 'ETH',
            tradeType: 'EXACT_IN',
          },
          legs: [
            {tokenIn: usdc, tokenOut: wrappedEth},
            {tokenIn: usdc, tokenOut: nativeEth},
          ],
        },
      ];
      const [nativeInput] = cases;
      const legKey = ({tokenIn, tokenOut}: Leg) =>
        `${tokenIn.toString()}>${tokenOut.toString()}`;
      let queue: NoOpMessageQueue;
      let repository: CachedRoutesRepository;

      beforeEach(() => {
        queue = new NoOpMessageQueue();
        repository = new CachedRoutesRepository(
          redisCache,
          serviceConfig,
          queue,
          FeatureGatedTokensRepository.empty()
        );
        cachedRoutesRepository = repository;
      });

      const legKeysPerBucket = (
        legs: Leg[],
        keyOf: (leg: Leg, usdBucket: UsdBucket) => string
      ) =>
        legs.flatMap(leg =>
          Object.values(UsdBucket).map(usdBucket => ({
            leg,
            usdBucket,
            key: keyOf(leg, usdBucket),
          }))
        );

      const cachedRouteKey = ({tokenIn, tokenOut}: Leg, usdBucket: UsdBucket) =>
        repository.constructCachedRouteKey(
          EMPTY_NAMESPACE_CONTEXT,
          allProtocols,
          ChainId.MAINNET,
          tokenIn,
          tokenOut,
          TradeType.ExactIn,
          amount,
          usdBucket
        );
      const pendingKey = ({tokenIn, tokenOut}: Leg, usdBucket: UsdBucket) =>
        repository.constructPendingCachedRouteKey(
          EMPTY_NAMESPACE_CONTEXT,
          allProtocols,
          ChainId.MAINNET,
          tokenIn,
          tokenOut,
          TradeType.ExactIn,
          amount,
          usdBucket
        );
      const cooldownKey = ({tokenIn, tokenOut}: Leg, usdBucket: UsdBucket) =>
        repository.constructNoRouteCooldownKey(
          EMPTY_NAMESPACE_CONTEXT,
          allProtocols,
          ChainId.MAINNET,
          tokenIn,
          tokenOut,
          TradeType.ExactIn,
          amount,
          usdBucket
        );

      // Every bucket of every leg holds a route whose refresh is overdue.
      const seedStaleRoutes = async (legs: Leg[]) => {
        const overdueMs =
          (serviceConfig.CachedRoutes.RouteCacheEntryRefreshSeconds + 60) *
          1000;
        for (const {leg, usdBucket, key} of legKeysPerBucket(
          legs,
          cachedRouteKey
        )) {
          await repository.saveCachedRoutes(
            EMPTY_NAMESPACE_CONTEXT,
            allProtocols,
            new RouteBasic(Protocol.V2, [
              new V2Pool(
                leg.tokenIn,
                leg.tokenOut,
                new Address('0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640'),
                BigInt('1000000000000'),
                BigInt('1000000000000')
              ),
            ]),
            ChainId.MAINNET,
            leg.tokenIn,
            leg.tokenOut,
            TradeType.ExactIn,
            amount,
            usdBucket
          );
          for (const [member, expiresAtMs] of await redisCache.zrange(
            key,
            0,
            -1
          )) {
            await redisCache.zadd(key, expiresAtMs - overdueMs, member);
          }
        }
      };

      const pendingMarkerLegs = async (legs: Leg[]): Promise<string[]> => {
        const present: string[] = [];
        for (const {leg, key} of legKeysPerBucket(legs, pendingKey)) {
          if (await redisCache.contains(key)) {
            present.push(legKey(leg));
          }
        }
        return present;
      };

      const fastQuote = async (
        request: typeof baseRequest & {tradeType: string}
      ) => {
        const testCtx = buildTestContext(
          buildHandlerContextWithHeaders().handlerContext
        );
        const response = await buildBL().quote(
          testCtx,
          create(QuoteRequestSchema, request)
        );
        return {response, testCtx};
      };

      it.each(cases)(
        '$name: stops a FAST cliff-override hit re-enqueueing the refresh that just found no route',
        async ({request, legs}) => {
          await seedStaleRoutes(legs);

          // A stale hit with no cliff yet refreshes both legs.
          await fastQuote(request);
          const refreshes: {payload: Record<string, unknown>}[] =
            queue.messages.map(message => JSON.parse(message));
          expect(
            refreshes
              .map(
                ({payload}) =>
                  `${payload.tokenInAddress}>${payload.tokenOutAddress}`
              )
              .sort()
          ).toEqual(legs.map(legKey).sort());
          expect((await pendingMarkerLegs(legs)).sort()).toEqual(
            legs.map(legKey).sort()
          );
          queue.clearMessages();

          // The worker runs each refresh and finds no route.
          for (const refresh of refreshes) {
            const response = await buildBL(
              new MockedQuoteStrategy(null),
              serviceConfigAsync
            ).quote(
              buildTestContext(),
              create(QuoteRequestSchema, refresh.payload)
            );
            expect(response.error?.code).toBe(404);
          }
          expect(await pendingMarkerLegs(legs)).toEqual([]);
          expect(await noRouteCooldownKeys(legs, allProtocols)).toHaveLength(2);

          // The next FAST request overrides the cliff with the cached routes.
          const overrideHit = await fastQuote(request);
          expect(overrideHit.response.hitsCachedRoutes).toBe(true);
          expect(queue.messages).toHaveLength(0);
          expect(
            overrideHit.testCtx.metrics.countStore[
              buildMetricKey('CachedRoutes.RefreshEnqueueSkipped')
            ]
          ).toBe(2);

          // Without the cooldown the same hit re-enqueues both refreshes.
          for (const {key} of legKeysPerBucket(legs, cooldownKey)) {
            await redisCache.delete(key);
          }
          await fastQuote(request);
          expect(queue.messages).toHaveLength(2);
        }
      );

      it('keys the cooldown to the leg the refresh ran for', async () => {
        await buildBL(new MockedQuoteStrategy(null), serviceConfigAsync).quote(
          buildTestContext(),
          create(QuoteRequestSchema, nativeInput.request)
        );

        const cooldowns = await noRouteCooldownKeys(
          nativeInput.legs,
          allProtocols
        );
        expect(cooldowns).toHaveLength(1);
        expect(
          cooldowns[0].startsWith(`${nativeEth.toString()}>${usdc.toString()}:`)
        ).toBe(true);
      });

      it('sets no cooldown after an incomplete search or a found route', async () => {
        for (const strategy of [
          new IncompleteQuoteStrategy(
            new Error('missing revert data in call exception')
          ),
          new MockedQuoteStrategy(),
        ]) {
          await buildBL(strategy, serviceConfigAsync).quote(
            buildTestContext(),
            create(QuoteRequestSchema, nativeInput.request)
          );
        }

        expect(
          await noRouteCooldownKeys(nativeInput.legs, allProtocols)
        ).toEqual([]);
      });
    });

    describe('incomplete search', () => {
      const readCliff = (ctx: UniContext) =>
        noRouteCacheRepository.getAmountCliff(
          EMPTY_NAMESPACE_CONTEXT,
          allProtocols,
          ChainId.MAINNET,
          wrappedEth,
          usdc,
          TradeType.ExactIn,
          ctx
        );
      const batchError = new Error('missing revert data in call exception');

      it('async: a complete search with no route writes the no-route cliff', async () => {
        const testCtx = buildTestContext();

        const response = await buildBL(
          new MockedQuoteStrategy(null),
          serviceConfigAsync
        ).quote(
          testCtx,
          create(QuoteRequestSchema, {...baseRequest, tradeType: 'EXACT_IN'})
        );

        expect(response.error?.code).toBe(404);
        expect(await readCliff(testCtx)).toBe(amount);
      });

      it('async: an incomplete search is served as no route but never cached as one', async () => {
        const testCtx = buildTestContext();

        const response = await buildBL(
          new IncompleteQuoteStrategy(batchError),
          serviceConfigAsync
        ).quote(
          testCtx,
          create(QuoteRequestSchema, {...baseRequest, tradeType: 'EXACT_IN'})
        );

        expect(response.error?.code).toBe(404);
        expect(await readCliff(testCtx)).toBeUndefined();
        expect(
          testCtx.metrics.countStore[buildMetricKey('IncompleteSearch')]
        ).toBe(1);
        expect(
          testCtx.metrics.countStore[
            buildMetricKey('NoRouteCache.WriteSkipped')
          ]
        ).toBe(1);
        expect(
          testCtx.metrics.countStore[buildMetricKey('UnhandledError')]
        ).toBeUndefined();
      });

      it('async: a search the caller abandoned writes no route cache', async () => {
        const request = create(QuoteRequestSchema, {
          ...baseRequest,
          tradeType: 'EXACT_IN',
        });
        const bl = buildBL(new MockedQuoteStrategy(), serviceConfigAsync);

        const abortedCtx = buildTestContext();
        const controller = new AbortController();
        controller.abort();
        const abortedResponse = await bl.quote(abortedCtx, request, {
          abortSignal: controller.signal,
        });

        expect(abortedResponse.error).toBeUndefined();
        expect(
          abortedCtx.metrics.countStore[
            buildMetricKey('CachedRoutes.WriteBestQuote')
          ]
        ).toBeUndefined();
        expect(
          abortedCtx.metrics.countStore[
            buildMetricKey('QuoteCache.WriteSkipped')
          ]
        ).toBe(1);

        // Control: the same request, not abandoned, misses the cache the
        // abandoned search left empty and writes it.
        const controlCtx = buildTestContext();
        const controlResponse = await bl.quote(controlCtx, request);
        expect(controlResponse.hitsCachedRoutes).toBe(false);
        expect(
          controlCtx.metrics.countStore[
            buildMetricKey('CachedRoutes.WriteBestQuote')
          ]
        ).toBe(1);
      });

      it('async: a fetch the caller abandoned before any quote is served as no route, not as an unhandled error', async () => {
        class AbandonedQuoteStrategy extends MockedQuoteStrategy {
          override async findBestQuoteCandidates(): Promise<QuoteSplit[]> {
            throw new OnChainQuoteFetchError('caller_aborted', [
              new Error('caller disconnected'),
            ]);
          }
        }
        const testCtx = buildTestContext();
        const controller = new AbortController();
        controller.abort();

        const response = await buildBL(
          new AbandonedQuoteStrategy(),
          serviceConfigAsync
        ).quote(
          testCtx,
          create(QuoteRequestSchema, {...baseRequest, tradeType: 'EXACT_IN'}),
          {abortSignal: controller.signal}
        );

        expect(response.error?.code).toBe(404);
        expect(await readCliff(testCtx)).toBeUndefined();
        expect(
          testCtx.metrics.countStore[buildMetricKey('IncompleteSearch')]
        ).toBe(1);
        expect(
          testCtx.metrics.countStore[buildMetricKey('UnhandledError')]
        ).toBeUndefined();
      });

      it('async: a search that finished before the caller left is still cached', async () => {
        const controller = new AbortController();
        class AbortAfterSearchSelector extends SimpleQuoteSelector {
          override async getBestQuotes(
            ...args: Parameters<SimpleQuoteSelector['getBestQuotes']>
          ): Promise<QuoteSplit[]> {
            controller.abort();
            return super.getBestQuotes(...args);
          }
        }
        const testCtx = buildTestContext();

        const response = await buildBL(
          new MockedQuoteStrategy(),
          serviceConfigAsync,
          new AbortAfterSearchSelector()
        ).quote(
          testCtx,
          create(QuoteRequestSchema, {...baseRequest, tradeType: 'EXACT_IN'}),
          {abortSignal: controller.signal}
        );

        expect(controller.signal.aborted).toBe(true);
        expect(response.error).toBeUndefined();
        expect(
          testCtx.metrics.countStore[
            buildMetricKey('CachedRoutes.WriteBestQuote')
          ]
        ).toBe(1);
        expect(
          testCtx.metrics.countStore[buildMetricKey('QuoteCache.WriteSkipped')]
        ).toBeUndefined();
      });

      it('sync: an incomplete search keeps the 200 no-route contract', async () => {
        const testCtx = buildTestContext();

        const response = await buildBL(
          new IncompleteQuoteStrategy(batchError)
        ).quote(
          testCtx,
          create(QuoteRequestSchema, {...baseRequest, tradeType: 'EXACT_IN'})
        );

        expect(response.error?.code).toBe(404);
        expect(
          testCtx.metrics.countStore[buildMetricKey('IncompleteSearch')]
        ).toBe(1);
        expect(
          testCtx.metrics.countStore[buildMetricKey('UnhandledError')]
        ).toBeUndefined();
      });

      it('rethrows a quote fetch failure that is not an incomplete search', async () => {
        class FailingQuoteStrategy extends MockedQuoteStrategy {
          override async findBestQuoteCandidates(): Promise<QuoteSplit[]> {
            throw new OnChainQuoteFetchError('generic', [batchError]);
          }
        }
        const testCtx = buildTestContext();

        await expect(
          buildBL(new FailingQuoteStrategy()).quote(
            testCtx,
            create(QuoteRequestSchema, {...baseRequest, tradeType: 'EXACT_IN'})
          )
        ).rejects.toBeInstanceOf(OnChainQuoteFetchError);
        expect(
          testCtx.metrics.countStore[buildMetricKey('UnhandledError')]
        ).toBe(1);
      });

      // The deep search over the real quote fetcher, so the request sees
      // what its batches threw rather than a strategy's verdict on them.
      describe('over the on-chain quote fetcher', () => {
        const UNIRPC_TIMEOUT_MS = 6000;
        const v4Route = new RouteBasic(Protocol.V4, [
          new V4Pool(
            wrappedEth,
            usdc,
            500,
            10,
            '0x0000000000000000000000000000000000000000',
            BigInt('1000000000000'),
            '0x11b815efB8f581194ae79006d24E0d814B7697F6',
            BigInt('79228162514264337593543950336'),
            BigInt('0')
          ),
        ]);

        const v2Route = new RouteBasic(Protocol.V2, [
          new V2Pool(
            wrappedEth,
            usdc,
            new Address('0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640'),
            BigInt('1000000000000'),
            BigInt('1000000000000')
          ),
        ]);
        // A V4 pool whose hook the chain replaces with its own bytecode, so
        // the multicall takes the state-override path: a raw eth_call whose
        // result the fetcher decodes itself.
        const overriddenHook = '0x1111111111111111111111111111111111110080';
        const hookedV4Route = new RouteBasic(Protocol.V4, [
          new V4Pool(
            wrappedEth,
            usdc,
            500,
            10,
            overriddenHook,
            BigInt('1000000000000'),
            '0x22b815efb8f581194ae79006d24e0d814b7697f6',
            BigInt('79228162514264337593543950336'),
            BigInt('0')
          ),
        ]);
        const hookOverrideChainRepository = new FixedChainRepository(
          Chain.create({
            ...MAINNET,
            hookCodeOverrides: {[overriddenHook]: '0x600160005260206000f3'},
          })
        );

        const buildOnChainBL = (
          config: IUniRouteServiceConfig,
          rpcProvider: JsonRpcProvider,
          routes: readonly RouteBasic[] = [v4Route],
          chains: IChainRepository = chainRepository
        ) => {
          const rpcProviderMap = new Map([[ChainId.MAINNET, rpcProvider]]);
          const onChainQuoteFetcher = new OnChainQuoteFetcher(
            rpcProviderMap,
            config,
            new NoPermissionedQuoteOverrides()
          );
          return new UniRouteBL(
            config,
            redisCache,
            chains,
            poolDiscoverer,
            freshPoolDetailsWrapper,
            tokenHandler,
            onChainQuoteFetcher,
            quoteSelector,
            routeQuoteAllocator,
            gasEstimateProvider,
            noGasConverter,
            new FixedRoutesRepository(routes),
            cachedRoutesRepository,
            noRouteCacheRepository,
            new DeepQuoteStrategy(
              onChainQuoteFetcher,
              gasEstimateProvider,
              noGasConverter,
              routeQuoteAllocator,
              quoteSelector,
              tokenHandler,
              new Map(),
              freshPoolDetailsWrapper,
              rpcProviderMap
            ),
            dummySimulator,
            quoteRequestValidator,
            tokenProvider,
            rpcProviderMap,
            stateOverrideResolver
          );
        };

        it('async: a V4 route the ABI coder rejects fails the batch it shares with a V2 route rather than caching no route', async () => {
          // The V4 quoter's exactAmount is a uint128, so this amount never
          // leaves the encoder, and the V2 route in the same batch (a
          // uint256 amount) is never evaluated. Were a batch to reach the
          // RPC, it would time out.
          const amountAboveUint128 = constants.MaxUint256.toBigInt();
          const testCtx = buildTestContext();
          const batchLogSpy = vi.spyOn(testCtx.logger, 'error');

          const thrown = await buildOnChainBL(
            serviceConfigAsync,
            new FailingRpcProvider(ethersCallTimeoutError(UNIRPC_TIMEOUT_MS)),
            [v2Route, v4Route]
          )
            .quote(
              testCtx,
              create(QuoteRequestSchema, {
                ...baseRequest,
                amount: amountAboveUint128.toString(),
                tradeType: 'EXACT_IN',
              })
            )
            .then(
              () => undefined,
              (error: unknown) => error
            );

          expect(thrown).toBeInstanceOf(OnChainQuoteFetchError);
          if (!(thrown instanceof OnChainQuoteFetchError)) return;
          expect(thrown.kind).toBe('generic');
          expect(thrown.cause).toMatchObject({
            code: 'INVALID_ARGUMENT',
            argument: 'exactAmount',
          });
          expect(await readCliff(testCtx)).toBeUndefined();
          const batchFailure = batchLogSpy.mock.calls.find(
            ([message]) => message === 'Batch failed with non-out-of-gas error'
          );
          // Both routes at every split percentage, in the one batch.
          const splitsPerRoute =
            100 / serviceConfigAsync.RouteFinder.RouteSplitPercentage;
          expect(batchFailure?.[1]).toMatchObject({
            batchSize: 2 * splitsPerRoute,
            error: {code: 'INVALID_ARGUMENT', argument: 'exactAmount'},
          });
          expect(
            testCtx.metrics.countStore[
              buildMetricKey('OnChainQuoteFetch.GenericError')
            ]
          ).toBe(1);
          expect(
            testCtx.metrics.countStore[
              buildMetricKey('OnChainQuoteFetch.TransientRetry')
            ]
          ).toBeUndefined();
          expect(
            testCtx.metrics.countStore[buildMetricKey('IncompleteSearch')]
          ).toBeUndefined();
          expect(
            testCtx.metrics.countStore[buildMetricKey('UnhandledError')]
          ).toBe(1);
        });

        it('async: a malformed result on the state-override path in every batch fails the search rather than caching no route', async () => {
          const testCtx = buildTestContext();

          const thrown = await serveRpcReply(MALFORMED_RESULT, url =>
            buildOnChainBL(
              serviceConfigAsync,
              new PinnedBlockRpcProvider(url),
              [hookedV4Route],
              hookOverrideChainRepository
            )
              .quote(
                testCtx,
                create(QuoteRequestSchema, {
                  ...baseRequest,
                  tradeType: 'EXACT_IN',
                })
              )
              .then(
                () => undefined,
                (error: unknown) => error
              )
          );

          expect(thrown).toBeInstanceOf(OnChainQuoteFetchError);
          if (!(thrown instanceof OnChainQuoteFetchError)) return;
          expect(thrown.kind).toBe('generic');
          expect(thrown.cause).toMatchObject({
            code: 'INVALID_ARGUMENT',
            reason: 'invalid arrayify value',
            value: MALFORMED_RESULT.result,
          });
          expect(await readCliff(testCtx)).toBeUndefined();
          expect(
            testCtx.metrics.distStore
              .filter(
                ({metric_name}) =>
                  metric_name === buildMetricKey('OnChainQuoteFetch.BatchSize')
              )
              .map(({opts}) => opts?.tags)
          ).toEqual([['chain:MAINNET', 'with_state_overrides:true']]);
          expect(
            testCtx.metrics.countStore[
              buildMetricKey('OnChainQuoteFetch.GenericError')
            ]
          ).toBe(1);
          expect(
            testCtx.metrics.countStore[
              buildMetricKey('OnChainQuoteFetch.TransientRetry')
            ]
          ).toBeUndefined();
          expect(
            testCtx.metrics.countStore[buildMetricKey('UnhandledError')]
          ).toBe(1);
        });

        it('async: a search whose every batch timed out is resent once, then fails rather than caching no route', async () => {
          const testCtx = buildTestContext();

          await expect(
            buildOnChainBL(
              serviceConfigAsync,
              new FailingRpcProvider(ethersCallTimeoutError(UNIRPC_TIMEOUT_MS))
            ).quote(
              testCtx,
              create(QuoteRequestSchema, {
                ...baseRequest,
                tradeType: 'EXACT_IN',
              })
            )
          ).rejects.toBeInstanceOf(OnChainQuoteFetchError);

          expect(await readCliff(testCtx)).toBeUndefined();
          expect(
            testCtx.metrics.countStore[
              buildMetricKey('OnChainQuoteFetch.TransientRetry')
            ]
          ).toBe(1);
          expect(
            testCtx.metrics.countStore[buildMetricKey('UnhandledError')]
          ).toBe(1);
        });

        it('async: a search whose every batch the node answered with header not found fails rather than caching no route', async () => {
          const testCtx = buildTestContext();
          const headerNotFound = await captureEthersRpcError(
            NODE_HEADER_NOT_FOUND,
            provider => provider.call(MULTICALL_TRANSACTION)
          );
          if (!(headerNotFound instanceof Error)) {
            throw new Error('expected ethers to throw an Error');
          }

          const thrown = await buildOnChainBL(
            serviceConfigAsync,
            new FailingRpcProvider(headerNotFound)
          )
            .quote(
              testCtx,
              create(QuoteRequestSchema, {
                ...baseRequest,
                tradeType: 'EXACT_IN',
              })
            )
            .then(
              () => undefined,
              (error: unknown) => error
            );

          expect(thrown).toBeInstanceOf(OnChainQuoteFetchError);
          if (!(thrown instanceof OnChainQuoteFetchError)) return;
          expect(thrown.kind).toBe('generic');
          expect(thrown.cause).toBe(headerNotFound);
          expect(await readCliff(testCtx)).toBeUndefined();
          expect(
            testCtx.metrics.countStore[
              buildMetricKey('OnChainQuoteFetch.TransientRetry')
            ]
          ).toBeUndefined();
          expect(
            testCtx.metrics.countStore[
              buildMetricKey('OnChainQuoteFetch.GenericError')
            ]
          ).toBe(1);
          expect(
            testCtx.metrics.countStore[buildMetricKey('UnhandledError')]
          ).toBe(1);
        });

        it('sync: a search whose every batch timed out fails without a resend', async () => {
          const testCtx = buildTestContext();

          await expect(
            buildOnChainBL(
              serviceConfig,
              new FailingRpcProvider(ethersCallTimeoutError(UNIRPC_TIMEOUT_MS))
            ).quote(
              testCtx,
              create(QuoteRequestSchema, {
                ...baseRequest,
                tradeType: 'EXACT_IN',
              })
            )
          ).rejects.toBeInstanceOf(OnChainQuoteFetchError);

          expect(
            testCtx.metrics.countStore[
              buildMetricKey('OnChainQuoteFetch.TransientRetry')
            ]
          ).toBeUndefined();
          expect(
            testCtx.metrics.countStore[buildMetricKey('UnhandledError')]
          ).toBe(1);
        });
      });
    });
  });

  // The empty-cache fresh-discovery fallback keys on the PRE-filter route
  // count, so a cached read whose routes are all structurally invalid for
  // the request's shape used to skip discovery and then 404 after
  // filterInvalidRoutes emptied the set, despite routable liquidity
  // existing (ROUTE-1695: the dual-key read serves a cached WETH-input
  // wrap route to a native-ETH-input request, and isValidRoute drops
  // ETH/WETH -> ETH/* paths for native input). These tests pin the
  // fallback: all-invalid cached routes must re-run fresh discovery,
  // while surviving cached routes must not.
  describe('fresh-discovery fallback when cached routes are all invalid', () => {
    const allProtocols = [
      Protocol.V2,
      Protocol.V3,
      Protocol.V4,
      Protocol.MIXED,
    ];
    const wrappedEth = new Address(
      '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
    );
    const usdc = new Address('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
    const amount = BigInt(baseRequest.amount);
    const fallbackMetric = buildMetricKey(
      'CachedRoutes.AllInvalidFreshFallback'
    );

    // Invalid for a native-ETH input: first pool is ETH/WETH and the
    // second is ETH/* — the shape isValidRoute rejects, mirroring the
    // cached wrap route served under the wrapped pair key.
    const invalidForNativeInputRoute = new RouteBasic(Protocol.V2, [
      new V2Pool(
        new Address(ADDRESS_ZERO),
        wrappedEth,
        new Address('0x1111111111111111111111111111111111111111'),
        BigInt('1000000000000'),
        BigInt('1000000000000')
      ),
      new V2Pool(
        new Address(ADDRESS_ZERO),
        usdc,
        new Address('0x2222222222222222222222222222222222222222'),
        BigInt('1000000000000'),
        BigInt('1000000000000')
      ),
    ]);

    const validCachedRoute = new RouteBasic(Protocol.V2, [
      new V2Pool(
        wrappedEth,
        usdc,
        new Address('0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640'),
        BigInt('1000000000000'),
        BigInt('1000000000000')
      ),
    ]);

    // The cache check inside quote() runs with a USD bucket derived from
    // the request amount; saving for every bucket covers it. Saved under
    // the wrapped pair key only — the native key stays empty, matching
    // the live poisoning shape.
    const seedCachedRoute = async (route: RouteBasic) => {
      for (const usdBucket of Object.values(UsdBucket)) {
        await cachedRoutesRepository.saveCachedRoutes(
          EMPTY_NAMESPACE_CONTEXT,
          allProtocols,
          route,
          ChainId.MAINNET,
          wrappedEth,
          usdc,
          TradeType.ExactIn,
          amount,
          usdBucket
        );
      }
    };

    // Unlike MockedQuoteStrategy, produces quotes from the routes it is
    // handed — empty routes must yield no candidates, so the test can
    // tell a served-from-fresh-routes quote apart from a fabricated one.
    class RoutesAwareQuoteStrategy extends BaseQuoteStrategy {
      constructor() {
        super(
          {} as IQuoteFetcher,
          {} as GasEstimateProvider,
          {} as IGasConverter,
          {} as RouteQuoteAllocator<Pool>,
          {} as SimpleQuoteSelector,
          {} as ITokenHandler,
          new Map(),
          {} as IFreshPoolDetailsWrapper
        );
      }

      async findBestQuoteCandidates(
        _ctx: Context,
        _chain: Chain,
        _tokenInCurrencyInfo: CurrencyInfo,
        _tokenOutCurrencyInfo: CurrencyInfo,
        _amount: bigint,
        _tradeType: TradeType,
        _protocols: Protocol[],
        _serviceConfig: IUniRouteServiceConfig,
        routes: RouteBasic<Pool>[]
      ): Promise<QuoteSplit[]> {
        if (routes.length === 0) {
          return [];
        }
        return [
          new QuoteSplit([
            new QuoteBasic(routes[0], BigInt('1234567890'), undefined, {
              gasUse: BigInt('150000'),
              gasPriceInWei: BigInt('30000000000'),
              gasCostInWei: BigInt('4500000000000000'),
              gasCostInEth: 0.0045,
            }),
          ]),
        ];
      }

      name(): string {
        return 'RoutesAwareQuoteStrategy';
      }
    }

    class CountingRoutesRepository extends TestRoutesRepository {
      public getRoutesCalls = 0;

      public async getRoutes(
        ...args: Parameters<TestRoutesRepository['getRoutes']>
      ): Promise<RouteDiscoveryResult> {
        this.getRoutesCalls++;
        return super.getRoutes(...args);
      }
    }

    const legacyConfig: IUniRouteServiceConfig = {
      ...serviceConfig,
      CachedRoutes: {...serviceConfig.CachedRoutes, HitDiscoveryEnabled: false},
    };
    const buildBL = (routesRepository: IRoutesRepository) =>
      new UniRouteBL(
        legacyConfig,
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
        routesRepository,
        cachedRoutesRepository,
        noRouteCacheRepository,
        new RoutesAwareQuoteStrategy(),
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

    it('falls back to fresh discovery when every cached route is invalid for the request shape', async () => {
      await seedCachedRoute(invalidForNativeInputRoute);
      const countingRepository = new CountingRoutesRepository();

      const testCtx = buildTestContext();
      const response = await buildBL(countingRepository).quote(
        testCtx,
        create(QuoteRequestSchema, {...baseRequest, tradeType: 'EXACT_IN'})
      );

      // The fallback (not a plain cache miss) fired, invoked fresh
      // discovery exactly once, and its routes served the quote.
      expect(testCtx.metrics.countStore[fallbackMetric]).toBe(1);
      expect(countingRepository.getRoutesCalls).toBe(1);
      expect(response.error).toBeUndefined();
      expect(response.hitsCachedRoutes).toBe(false);
    });

    it('does not re-run discovery when cached routes survive the validity filter', async () => {
      await seedCachedRoute(validCachedRoute);
      const countingRepository = new CountingRoutesRepository();

      const testCtx = buildTestContext();
      const response = await buildBL(countingRepository).quote(
        testCtx,
        create(QuoteRequestSchema, {...baseRequest, tradeType: 'EXACT_IN'})
      );

      expect(testCtx.metrics.countStore[fallbackMetric]).toBeUndefined();
      expect(countingRepository.getRoutesCalls).toBe(0);
      expect(response.error).toBeUndefined();
      expect(response.hitsCachedRoutes).toBe(true);
    });
  });

  // getCachedRoutes/saveCachedRoutes is only enabled for the all-Uniswap-protocols case
  // (V2 + V3 + V4 + MIXED). Any request that includes an external protocol must never
  // read from or write to the route cache regardless of sync/async mode.
  describe('external protocol caching behavior', () => {
    it('should NOT cache routes for external-only protocol in sync mode (second call still misses)', async () => {
      const request = create(QuoteRequestSchema, {
        ...baseRequest,
        tradeType: 'EXACT_IN',
        protocols: Protocol.CURVESTABLESWAPNG,
      });

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
        noRouteCacheRepository,
        new MockedQuoteStrategy(),
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      const firstResponse = await uniRouteBL.quote(ctx, request);
      expect(firstResponse.hitsCachedRoutes).toBe(false);

      // External protocol must never write to the cache — second call still misses
      const secondResponse = await uniRouteBL.quote(ctx, request);
      expect(secondResponse.hitsCachedRoutes).toBe(false);
    });

    it('should NOT cache routes for external-only protocol in async mode (second call still misses)', async () => {
      const request = create(QuoteRequestSchema, {
        ...baseRequest,
        tradeType: 'EXACT_IN',
        protocols: Protocol.CURVESTABLESWAPNG,
      });

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
        noRouteCacheRepository,
        new MockedQuoteStrategy(),
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      const firstResponse = await uniRouteBL.quote(ctx, request);
      expect(firstResponse.hitsCachedRoutes).toBe(false);

      // External protocol must never write to the cache even in async mode
      const secondResponse = await uniRouteBL.quote(ctx, request);
      expect(secondResponse.hitsCachedRoutes).toBe(false);
    });

    it('should NOT cache routes when uniswap + external protocols are mixed and AggHooks flags are off (second call still misses)', async () => {
      const noAggHooksConfig = {
        ...getUniRouteTestConfig(LambdaType.Async),
        CachedRoutes: {
          ...getUniRouteTestConfig(LambdaType.Async).CachedRoutes,
          AggHooksReadEnabled: false,
          AggHooksWriteEnabled: false,
        },
      };
      const request = create(QuoteRequestSchema, {
        ...baseRequest,
        tradeType: 'EXACT_IN',
        protocols: `${Protocol.V2},${Protocol.V3},${Protocol.V4},${Protocol.MIXED},${Protocol.CURVESTABLESWAPNG}`,
      });

      const uniRouteBL = new UniRouteBL(
        noAggHooksConfig,
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
        noRouteCacheRepository,
        new MockedQuoteStrategy(),
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      const firstResponse = await uniRouteBL.quote(ctx, request);
      expect(firstResponse.hitsCachedRoutes).toBe(false);

      // Any external protocol in the set disables the cache entirely
      const secondResponse = await uniRouteBL.quote(ctx, request);
      expect(secondResponse.hitsCachedRoutes).toBe(false);
    });

    it('should cache routes for all-Uniswap protocols in async mode (second call reads cache)', async () => {
      const request = create(QuoteRequestSchema, {
        ...baseRequest,
        tradeType: 'EXACT_IN',
        // defaults to v2,v3,v4,mixed — all Uniswap, no external
      });

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
        noRouteCacheRepository,
        new MockedQuoteStrategy(),
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      const firstResponse = await uniRouteBL.quote(ctx, request);
      expect(firstResponse.hitsCachedRoutes).toBe(false);

      // Async saves routes after first call; the second read supplies a candidate.
      const secondResponse = await uniRouteBL.quote(ctx, request);
      expect(secondResponse.hitsCachedRoutes).toBe(true);
    });

    it('should NOT cross-contaminate: external protocol request must not hit the Uniswap route cache', async () => {
      const uniswapRequest = create(QuoteRequestSchema, {
        ...baseRequest,
        tradeType: 'EXACT_IN',
        // defaults to v2,v3,v4,mixed
      });
      const externalRequest = create(QuoteRequestSchema, {
        ...baseRequest,
        tradeType: 'EXACT_IN',
        protocols: Protocol.CURVESTABLESWAPNG,
      });

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
        noRouteCacheRepository,
        new MockedQuoteStrategy(),
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      // Populate the Uniswap cache
      await uniRouteBL.quote(ctx, uniswapRequest);

      // External protocol request must not read from the Uniswap cache
      const externalFirstResponse = await uniRouteBL.quote(
        ctx,
        externalRequest
      );
      expect(externalFirstResponse.hitsCachedRoutes).toBe(false);

      // External protocol never writes to any cache — subsequent call still misses
      const externalSecondResponse = await uniRouteBL.quote(
        ctx,
        externalRequest
      );
      expect(externalSecondResponse.hitsCachedRoutes).toBe(false);
    });
  });

  describe('AggHooksReadEnabled / AggHooksWriteEnabled feature flags', () => {
    const uniswapOnlyRequest = create(QuoteRequestSchema, {
      ...baseRequest,
      tradeType: 'EXACT_IN',
      // defaults to v2,v3,v4,mixed
    });
    const mixedRequest = create(QuoteRequestSchema, {
      ...baseRequest,
      tradeType: 'EXACT_IN',
      protocols: `${Protocol.V2},${Protocol.V3},${Protocol.V4},${Protocol.MIXED},${Protocol.CURVESTABLESWAPNG}`,
    });

    it('uniswap-only protocols read and save cached routes regardless of AggHooks flags', async () => {
      // Default config: AggHooksReadEnabled=false, AggHooksWriteEnabled=false
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
        noRouteCacheRepository,
        new MockedQuoteStrategy(),
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      // First call: cache miss → async saves
      const firstResponse = await uniRouteBL.quote(ctx, uniswapOnlyRequest);
      expect(firstResponse.hitsCachedRoutes).toBe(false);

      // Second call reads a cached candidate even if fresh finds the same path.
      const secondResponse = await uniRouteBL.quote(ctx, uniswapOnlyRequest);
      expect(secondResponse.hitsCachedRoutes).toBe(true);
    });

    it('mixed protocols do NOT hit getCachedRoutes or saveCachedRoutes when both flags are false', async () => {
      const noAggHooksConfig = {
        ...getUniRouteTestConfig(LambdaType.Async),
        CachedRoutes: {
          ...getUniRouteTestConfig(LambdaType.Async).CachedRoutes,
          AggHooksReadEnabled: false,
          AggHooksWriteEnabled: false,
        },
      };
      const uniRouteBL = new UniRouteBL(
        noAggHooksConfig,
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
        noRouteCacheRepository,
        new MockedQuoteStrategy(),
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      const firstResponse = await uniRouteBL.quote(ctx, mixedRequest);
      expect(firstResponse.hitsCachedRoutes).toBe(false);

      // No save occurred → second call still misses
      const secondResponse = await uniRouteBL.quote(ctx, mixedRequest);
      expect(secondResponse.hitsCachedRoutes).toBe(false);
    });

    it('mixed protocols hit getCachedRoutes but NOT saveCachedRoutes when AggHooksReadEnabled=true only', async () => {
      const readOnlyConfig = {
        ...getUniRouteTestConfig(LambdaType.Async),
        CachedRoutes: {
          ...getUniRouteTestConfig(LambdaType.Async).CachedRoutes,
          AggHooksReadEnabled: true,
          AggHooksWriteEnabled: false,
        },
      };

      // First: populate the uniswap-only cache with an async call
      const uniRouteBLAsync = new UniRouteBL(
        readOnlyConfig,
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
        noRouteCacheRepository,
        new MockedQuoteStrategy(),
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      // Mixed protocol first call: cache miss (nothing saved yet for this key)
      const firstResponse = await uniRouteBLAsync.quote(ctx, mixedRequest);
      expect(firstResponse.hitsCachedRoutes).toBe(false);

      // AggHooksWriteEnabled=false → no save → second call still misses
      const secondResponse = await uniRouteBLAsync.quote(ctx, mixedRequest);
      expect(secondResponse.hitsCachedRoutes).toBe(false);
    });

    it('mixed protocols hit getCachedRoutes and saveCachedRoutes when both AggHooksReadEnabled and AggHooksWriteEnabled are true', async () => {
      const readWriteConfig = {
        ...getUniRouteTestConfig(LambdaType.Async),
        CachedRoutes: {
          ...getUniRouteTestConfig(LambdaType.Async).CachedRoutes,
          AggHooksReadEnabled: true,
          AggHooksWriteEnabled: true,
          HitDiscoveryEnabled: false,
        },
      };

      const uniRouteBL = new UniRouteBL(
        readWriteConfig,
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
        noRouteCacheRepository,
        new MockedQuoteStrategy(),
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      // First call: cache miss → async saves with mixed protocols
      const firstResponse = await uniRouteBL.quote(ctx, mixedRequest);
      expect(firstResponse.hitsCachedRoutes).toBe(false);

      // Second call: cache hit from the save above
      const secondResponse = await uniRouteBL.quote(ctx, mixedRequest);
      expect(secondResponse.hitsCachedRoutes).toBe(true);
    });
  });

  describe('response formatting', () => {
    it('flags a V4 pool through a settle-before-swap hook and no other pool', async () => {
      const [{hook: wrapHook}] = XSTOCK_WRAP_HOOKS_ON_MONAD;
      const xStock = new Address('0x90A2a4c76b5D8c0bc892A69EA28Aa775a8f2dD48');
      const wxStock = new Address('0xE7E553Cd128F0011777323A0b44a7b96EA1CB540');
      const monadRequest = create(QuoteRequestSchema, {
        ...baseRequest,
        tokenInAddress: xStock.address,
        tokenInChainId: ChainId.MONAD,
        tokenOutAddress: wxStock.address,
        tokenOutChainId: ChainId.MONAD,
        protocols: 'v4',
        tradeType: 'EXACT_IN',
      });
      const v4PoolWithHook = (hooks: string): V4Pool =>
        new V4Pool(
          xStock,
          wxStock,
          0,
          60,
          hooks,
          0n,
          V4Pool.computePoolId(xStock, wxStock, 0, 60, hooks),
          BigInt('79228162514264337593543950336'),
          0n
        );
      const gasDetails = {
        gasUse: BigInt('150000'),
        gasPriceInWei: BigInt('30000000000'),
        gasCostInWei: BigInt('4500000000000000'),
        gasCostInEth: 0.0045,
      };
      const splitQuote = new QuoteSplit([
        new QuoteBasic(
          new RouteBasic(Protocol.V4, [v4PoolWithHook(wrapHook)], 50),
          BigInt('500000000000000000'),
          undefined,
          gasDetails
        ),
        new QuoteBasic(
          new RouteBasic(Protocol.V4, [v4PoolWithHook(ADDRESS_ZERO)], 50),
          BigInt('500000000000000000'),
          undefined,
          gasDetails
        ),
      ]);
      mockedRpcProviderMap.set(ChainId.MONAD, mockProvider);
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
        noRouteCacheRepository,
        new MockedQuoteStrategy(splitQuote),
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      const response = await uniRouteBL.quote(ctx, monadRequest);

      expect(
        response.route.map(route =>
          route.pools.map(pool => [pool.hooks, pool.settleBeforeSwap])
        )
      ).toEqual([[[wrapHook, true]], [[ADDRESS_ZERO, undefined]]]);
    });

    it('should correctly format single route response', async () => {
      const request = create(QuoteRequestSchema, {
        ...baseRequest,
        tradeType: 'EXACT_IN',
      });

      const singleQuote = new QuoteSplit([
        new QuoteBasic(
          new RouteBasic(Protocol.V2, [
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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
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
      // No portion in request, so gas-and-portion adjusted fields are undefined
      expect(response.quoteGasAndPortionAdjusted).toBeUndefined();
      expect(response.quoteGasAndPortionAdjustedDecimals).toBeUndefined();
    });

    it('should handle error response when no routes found', async () => {
      const request = create(QuoteRequestSchema, {
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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      const response = await uniRouteBL.quote(ctx, request);

      expect(response.error).toBeDefined();
      expect(response.error?.code).equals(404);
      expect(response.error?.message).contains('No valid quotes found');
      expect(quoteErrorReasonOf(response.error)).equals(
        QuoteErrorReason.NO_ROUTE
      );
    });

    it('should correctly adjust gas for EXACT_IN trade type', async () => {
      const request = create(QuoteRequestSchema, {
        ...baseRequest,
        tradeType: 'EXACT_IN',
      });

      const singleQuote = new QuoteSplit([
        new QuoteBasic(
          new RouteBasic(Protocol.V2, [
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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      const response = await uniRouteBL.quote(ctx, request);

      // For EXACT_IN, gas should be subtracted from quote amount
      expect(response.quoteAmount).equals('1234567890');
      expect(response.quoteGasAdjusted).equals('1233567890'); // 1234567890 - 1000000
      expect(response.quoteGasAndPortionAdjusted).toBeUndefined();
      expect(response.quoteGasAndPortionAdjustedDecimals).toBeUndefined();
    });

    it('should correctly adjust gas for EXACT_OUT trade type', async () => {
      const request = create(QuoteRequestSchema, {
        ...baseRequest,
        tradeType: 'EXACT_OUT',
      });

      const singleQuote = new QuoteSplit([
        new QuoteBasic(
          new RouteBasic(Protocol.V2, [
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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      const response = await uniRouteBL.quote(ctx, request);

      // For EXACT_OUT, gas should be added to quote amount
      expect(response.quoteAmount).equals('1234567890');
      expect(response.quoteGasAdjusted).equals('1235567890'); // 1234567890 + 1000000
      expect(response.quoteGasAndPortionAdjusted).toBeUndefined();
      expect(response.quoteGasAndPortionAdjustedDecimals).toBeUndefined();
    });

    it('should include portion fields in response when portion parameters are provided', async () => {
      const request = create(QuoteRequestSchema, {
        ...baseRequest,
        tradeType: 'EXACT_IN',
        portionBips: 50, // 0.5%
        portionRecipient: '0x1234567890123456789012345678901234567890',
      });

      const singleQuote = new QuoteSplit([
        new QuoteBasic(
          new RouteBasic(Protocol.V2, [
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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
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
      // EXACT_IN with portion: quoteGasAndPortionAdjusted = quoteGasAdjusted - portionAmount = 1233567890 - 6172839
      expect(response.quoteGasAndPortionAdjusted).equals('1227395051');
      expect(response.quoteGasAndPortionAdjustedDecimals).equals(
        '0.000000001227395051'
      );
    });

    it('should include portion fields in response when portion parameters are provided with 2 routes split 60/40', async () => {
      const request = create(QuoteRequestSchema, {
        ...baseRequest,
        tradeType: 'EXACT_IN',
        portionBips: 50, // 0.5%
        portionRecipient: '0x1234567890123456789012345678901234567890',
      });

      // Create a quote with 2 routes, split 60/40
      const twoRouteQuote = new QuoteSplit([
        new QuoteBasic(
          new RouteBasic(
            Protocol.V2,
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
            Protocol.V4,
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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
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
      // EXACT_IN with portion: quoteGasAndPortionAdjusted = quoteGasAdjusted - portionAmount = 1233567890 - 6172839
      expect(response.quoteGasAndPortionAdjusted).equals('1227395051');
      expect(response.quoteGasAndPortionAdjustedDecimals).equals(
        '0.000000001227395051'
      );
    });

    it('should correctly distribute large amounts across multiple routes using BigInt arithmetic', async () => {
      // Test with large amount that exceeds Number.MAX_SAFE_INTEGER to verify BigInt conversion fix
      const largeAmount = '1000000000000000000000000'; // 1e24, exceeds MAX_SAFE_INTEGER
      const request = create(QuoteRequestSchema, {
        ...baseRequest,
        amount: largeAmount,
        tradeType: 'EXACT_IN',
      });

      // Create a quote with 3 routes: 33%, 34%, 33% (doesn't divide evenly)
      const threeRouteQuote = new QuoteSplit([
        new QuoteBasic(
          new RouteBasic(
            Protocol.V2,
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
            Protocol.V3,
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
            Protocol.V4,
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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
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
      const request = create(QuoteRequestSchema, {
        ...baseRequest,
        tradeType: 'EXACT_OUT',
        portionBips: 50, // 0.5%
        portionRecipient: '0x1234567890123456789012345678901234567890',
      });

      const singleQuote = new QuoteSplit([
        new QuoteBasic(
          new RouteBasic(Protocol.V2, [
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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
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
      // EXACT_OUT with portion: quoteGasAndPortionAdjusted = quoteGasAdjusted (1234567890 + 1000000)
      expect(response.quoteGasAndPortionAdjusted).equals('1235567890');
      expect(response.quoteGasAndPortionAdjustedDecimals).equals(
        '0.00000000123556789'
      );
    });

    it('should suppress portion fields and return raw quote on EXACT_IN when universalRouterSwapsteps is true', async () => {
      // Same fixture as the EXACT_IN portion test above, but with the
      // swapsteps flag on. UniRoute should leave amounts raw and not emit
      // any portion fields — Trading owns the fee math in this mode.
      const request = create(QuoteRequestSchema, {
        ...baseRequest,
        tradeType: 'EXACT_IN',
        portionBips: 50, // 0.5% — would normally be applied
        portionRecipient: '0x1234567890123456789012345678901234567890',
      });

      const singleQuote = new QuoteSplit([
        new QuoteBasic(
          new RouteBasic(Protocol.V2, [
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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      const response = await uniRouteBL.quote(ctx, request, {
        universalRouterSwapsteps: true,
      });

      // No portion fields should appear in the response.
      expect(response.portionBips).toBeUndefined();
      expect(response.portionRecipient).toBeUndefined();
      expect(response.portionAmount).toBeUndefined();
      expect(response.portionAmountDecimals).toBeUndefined();
      expect(response.quoteGasAndPortionAdjusted).toBeUndefined();
      expect(response.quoteGasAndPortionAdjustedDecimals).toBeUndefined();

      // Last pool's amountOut is the raw quote (no portion subtraction).
      expect(response.route[0].pools[0].amountIn).equals('1000000000000000000');
      expect(response.route[0].pools[0].amountOut).equals('1234567890');

      // quoteAmount is the raw quote; quoteGasAdjusted = 1234567890 - 1000000.
      expect(response.quoteAmount).equals('1234567890');
      expect(response.quoteGasAdjusted).equals('1233567890');
    });

    it('should attach swapSteps to QuoteResponse when universalRouterSwapsteps is true (V2 EXACT_IN)', async () => {
      // Use a non-native ERC20 input (USDT) so the factory does not need to
      // resolve native-vs-wrapped sentinels — that orthogonal concern is
      // covered by the SwapStepsFactory unit tests.
      const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
      const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
      const request = create(QuoteRequestSchema, {
        ...baseRequest,
        tradeType: 'EXACT_IN',
        tokenInAddress: USDT,
        tokenOutAddress: USDC,
      });

      const singleQuote = new QuoteSplit([
        new QuoteBasic(
          new RouteBasic(Protocol.V2, [
            new V2Pool(
              new Address(USDT),
              new Address(USDC),
              new Address('0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640'),
              BigInt('1000000000000'),
              BigInt('1000000000000')
            ),
          ]),
          BigInt('1234567890')
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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      const response = await uniRouteBL.quote(ctx, request, {
        universalRouterSwapsteps: true,
      });

      // swapSteps populated; one V2_SWAP_EXACT_IN step covering the whole input.
      // Carried as Struct -> toJson() yields the flat {type,...} SDK shape.
      expect(response.perHopSlippage).toBe(PerHopSlippage.OFF);
      expect(toJson(QuoteResponseSchema, response)).toMatchObject({
        perHopSlippage: 'PER_HOP_SLIPPAGE_OFF',
      });
      expect(response.swapSteps).toHaveLength(1);
      const step = response.swapSteps[0] as Record<string, unknown>;
      expect(step.type).toBe('V2_SWAP_EXACT_IN');
      expect(step.recipient).toBe('0x0000000000000000000000000000000000000002');
      expect(step.amountIn).toBe('1000000000000000000');
      expect(step.amountOutMin).toBe('0');
      expect(step.path).toEqual([USDT, USDC]);
    });

    it('should leave swapSteps empty when universalRouterSwapsteps is false (or absent)', async () => {
      const request = create(QuoteRequestSchema, {
        ...baseRequest,
        tradeType: 'EXACT_IN',
      });
      const singleQuote = new QuoteSplit([
        new QuoteBasic(
          new RouteBasic(Protocol.V2, [
            new V2Pool(
              new Address(baseRequest.tokenInAddress),
              new Address(baseRequest.tokenOutAddress),
              new Address('0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640'),
              BigInt('1000000000000'),
              BigInt('1000000000000')
            ),
          ]),
          BigInt('1234567890')
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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      const response = await uniRouteBL.quote(ctx, request);

      expect(response.swapSteps).toEqual([]);
    });

    it('should not increase routed amount on EXACT_OUT when universalRouterSwapsteps is true', async () => {
      // EXACT_OUT normally adds the portion to amountIn before routing. In
      // swapsteps mode that adjustment must be skipped — the route should
      // serve the raw user-requested output amount.
      const request = create(QuoteRequestSchema, {
        ...baseRequest,
        tradeType: 'EXACT_OUT',
        portionBips: 50, // 0.5% — would add 5e15 to amountIn under legacy path
        portionRecipient: '0x1234567890123456789012345678901234567890',
      });

      const singleQuote = new QuoteSplit([
        new QuoteBasic(
          new RouteBasic(Protocol.V2, [
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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      const response = await uniRouteBL.quote(ctx, request, {
        universalRouterSwapsteps: true,
      });

      // No portion fields should appear in the response.
      expect(response.portionBips).toBeUndefined();
      expect(response.portionRecipient).toBeUndefined();
      expect(response.portionAmount).toBeUndefined();
      expect(response.portionAmountDecimals).toBeUndefined();
      expect(response.quoteGasAndPortionAdjusted).toBeUndefined();
      expect(response.quoteGasAndPortionAdjustedDecimals).toBeUndefined();

      // Last pool's amountOut is the raw user-requested amount — not
      // increased by the portion.
      expect(response.route[0].pools[0].amountOut).equals(
        '1000000000000000000'
      );
      // quoteAmount is the raw quote.
      expect(response.quoteAmount).equals('1234567890');
    });
  });

  describe('route candidates (includeRouteCandidates)', () => {
    // Strategy variant returning multiple candidate splits.
    class MockedMultiQuoteStrategy extends BaseQuoteStrategy {
      constructor(private readonly candidates: QuoteSplit[]) {
        super(
          {} as IQuoteFetcher,
          {} as GasEstimateProvider,
          {} as IGasConverter,
          {} as RouteQuoteAllocator<Pool>,
          {} as SimpleQuoteSelector,
          {} as ITokenHandler,
          new Map(),
          {} as IFreshPoolDetailsWrapper
        );
      }

      async findBestQuoteCandidates(): Promise<QuoteSplit[]> {
        return this.candidates;
      }

      name(): string {
        return 'MockedMultiQuoteStrategy';
      }
    }

    const buildSplit = (
      poolAddress: string,
      amount: bigint,
      gasCostInQuoteToken?: bigint
    ): QuoteSplit =>
      new QuoteSplit([
        new QuoteBasic(
          new RouteBasic(Protocol.V2, [
            new V2Pool(
              new Address(baseRequest.tokenInAddress),
              new Address(baseRequest.tokenOutAddress),
              new Address(poolAddress),
              BigInt('1000000000000'),
              BigInt('1000000000000')
            ),
          ]),
          amount,
          undefined,
          {
            gasUse: BigInt('150000'),
            gasPriceInWei: BigInt('30000000000'),
            gasCostInWei: BigInt('4500000000000000'),
            gasCostInEth: 0.0045,
            gasCostInQuoteToken,
          }
        ),
      ]);

    const poolAddresses = [
      '0x1111111111111111111111111111111111111111',
      '0x2222222222222222222222222222222222222222',
      '0x3333333333333333333333333333333333333333',
      '0x4444444444444444444444444444444444444444',
      '0x5555555555555555555555555555555555555555',
      '0x6666666666666666666666666666666666666666',
      '0x7777777777777777777777777777777777777777',
    ];

    // Fails simulation for splits routing through the given pool address,
    // succeeds for everything else.
    class SelectiveFailingSimulator implements ISimulator {
      constructor(private readonly failPoolAddress: string) {}

      async simulate(
        chainId: ChainId,
        swapOptions: unknown,
        quoteSplit: QuoteSplit
      ): Promise<QuoteSplit> {
        const fails = quoteSplit.quotes
          .map(quote => quote.route.toString())
          .join(', ')
          .includes(this.failPoolAddress);
        return {
          ...quoteSplit,
          simulationResult: {
            estimatedGasUsed: 0n,
            estimatedGasUsedInQuoteToken: 0n,
            estimatedGasUsedInUSD: 0,
            status: fails ? SimulationStatus.FAILED : SimulationStatus.SUCCESS,
            description: 'Selective simulation for testing',
          },
        };
      }
    }

    const buildBL = (
      strategy: MockedMultiQuoteStrategy,
      config = serviceConfig,
      simulator: ISimulator = dummySimulator
    ) =>
      new UniRouteBL(
        config,
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
        noRouteCacheRepository,
        strategy,
        simulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

    it('omits routeCandidates when the flag is not set', async () => {
      const request = create(QuoteRequestSchema, {
        ...baseRequest,
        tradeType: 'EXACT_IN',
      });
      const uniRouteBL = buildBL(
        new MockedMultiQuoteStrategy([
          buildSplit(poolAddresses[0], BigInt('100')),
        ])
      );

      const response = await uniRouteBL.quote(ctx, request);

      expect(response.error).toBeUndefined();
      expect(response.routeCandidates).length(0);
    });

    it('excludes the served route and caps alternatives at 5 for EXACT_IN', async () => {
      const request = create(QuoteRequestSchema, {
        ...baseRequest,
        tradeType: 'EXACT_IN',
        includeRouteCandidates: true,
      });
      // 7 candidates with shuffled amounts; EXACT_IN best = highest output.
      // The 700 split is served and therefore excluded from the candidates.
      const amounts = [300n, 700n, 100n, 500n, 200n, 600n, 400n];
      const uniRouteBL = buildBL(
        new MockedMultiQuoteStrategy(
          amounts.map((amount, i) => buildSplit(poolAddresses[i], amount))
        )
      );

      const response = await uniRouteBL.quote(ctx, request);

      expect(response.error).toBeUndefined();
      expect(response.quoteAmount).equals('700');
      expect(response.routeCandidates).length(5);
      expect(response.routeCandidates.map(c => c.quoteAmount)).deep.equals([
        '600',
        '500',
        '400',
        '300',
        '200',
      ]);
      // The served route (pool 1) never appears as an alternative
      for (const candidate of response.routeCandidates) {
        expect(candidate.routeString).not.contains(poolAddresses[1]);
      }
    });

    it('sorts ascending for EXACT_OUT (lowest required input first)', async () => {
      const request = create(QuoteRequestSchema, {
        ...baseRequest,
        tradeType: 'EXACT_OUT',
        includeRouteCandidates: true,
      });
      // 200 is the lowest required input, gets served, and is excluded.
      const amounts = [500n, 200n, 800n];
      const uniRouteBL = buildBL(
        new MockedMultiQuoteStrategy(
          amounts.map((amount, i) => buildSplit(poolAddresses[i], amount))
        )
      );

      const response = await uniRouteBL.quote(ctx, request);

      expect(response.error).toBeUndefined();
      expect(response.routeCandidates.map(c => c.quoteAmount)).deep.equals([
        '500',
        '800',
      ]);
    });

    it('ranks by gas-adjusted amount when every candidate has gas details', async () => {
      const request = create(QuoteRequestSchema, {
        ...baseRequest,
        tradeType: 'EXACT_IN',
        includeRouteCandidates: true,
      });
      // 1000 is served and excluded. Raw order would be [950, 920] but
      // gas-adjusted order is [920-20=900, 950-100=850].
      const uniRouteBL = buildBL(
        new MockedMultiQuoteStrategy([
          buildSplit(poolAddresses[0], 1000n, 40n),
          buildSplit(poolAddresses[1], 950n, 100n),
          buildSplit(poolAddresses[2], 920n, 20n),
        ])
      );

      const response = await uniRouteBL.quote(ctx, request);

      expect(response.error).toBeUndefined();
      expect(response.routeCandidates).length(2);
      expect(response.routeCandidates[0].quoteAmount).equals('920');
      expect(response.routeCandidates[0].quoteGasAdjusted).equals('900');
      expect(response.routeCandidates[1].quoteAmount).equals('950');
      expect(response.routeCandidates[1].quoteGasAdjusted).equals('850');
    });

    it('ranks all candidates by raw amount when any lacks gas details', async () => {
      const request = create(QuoteRequestSchema, {
        ...baseRequest,
        tradeType: 'EXACT_IN',
        includeRouteCandidates: true,
      });
      // 1000 is served and excluded. One alternative lacks gas details, so
      // ranking falls back to raw amounts for ALL candidates on one scale:
      // [900, 800]. A per-candidate fallback would compare 900-200=700
      // against raw 800 and rank the gas-details-missing 800 artificially
      // high. Displayed quoteGasAdjusted stays set where available.
      const uniRouteBL = buildBL(
        new MockedMultiQuoteStrategy([
          buildSplit(poolAddresses[0], 1000n, 10n),
          buildSplit(poolAddresses[1], 900n, 200n),
          buildSplit(poolAddresses[2], 800n),
        ])
      );

      const response = await uniRouteBL.quote(ctx, request);

      expect(response.error).toBeUndefined();
      expect(response.routeCandidates).length(2);
      expect(response.routeCandidates[0].quoteAmount).equals('900');
      expect(response.routeCandidates[0].quoteGasAdjusted).equals('700');
      expect(response.routeCandidates[1].quoteAmount).equals('800');
      expect(response.routeCandidates[1].quoteGasAdjusted).toBeUndefined();
    });

    it('excludes simulation-failed candidates', async () => {
      const request = create(QuoteRequestSchema, {
        ...baseRequest,
        tradeType: 'EXACT_IN',
        includeRouteCandidates: true,
        simulateFromAddress: '0x1234567890123456789012345678901234567890',
        recipient: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
        slippageTolerance: 5,
      });

      const buildTradeSpy = vi
        .spyOn(await import('../lib/methodParameters'), 'buildTrade')
        .mockImplementation(mockBuildTrade);
      const buildSwapMethodParametersSpy = vi
        .spyOn(
          await import('../lib/methodParameters'),
          'buildSwapMethodParameters'
        )
        .mockImplementation(mockBuildSwapMethodParameters);

      const simulationEnabledConfig = {
        ...serviceConfig,
        Simulation: {
          ...serviceConfig.Simulation,
          Enabled: true,
          TopNQuotes: 3,
        },
      };

      // Best split (pool 0) fails simulation; pool 1 passes and is served;
      // pool 2 is never simulated and remains the only alternative.
      const uniRouteBL = buildBL(
        new MockedMultiQuoteStrategy([
          buildSplit(poolAddresses[0], 1000n),
          buildSplit(poolAddresses[1], 900n),
          buildSplit(poolAddresses[2], 800n),
        ]),
        simulationEnabledConfig,
        new SelectiveFailingSimulator(poolAddresses[0])
      );

      const response = await uniRouteBL.quote(ctx, request);

      expect(response.error).toBeUndefined();
      expect(response.quoteAmount).equals('900');
      expect(response.routeCandidates.map(c => c.quoteAmount)).deep.equals([
        '800',
      ]);
      expect(response.routeCandidates[0].routeString).contains(
        poolAddresses[2]
      );

      buildTradeSpy.mockRestore();
      buildSwapMethodParametersSpy.mockRestore();
    });

    it('stops simulating candidates after MaxSeededAttempts seeded reverts', async () => {
      const request = create(QuoteRequestSchema, {
        ...baseRequest,
        tradeType: 'EXACT_IN',
        simulateFromAddress: '0x1234567890123456789012345678901234567890',
        recipient: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
        slippageTolerance: 5,
      });

      const buildTradeSpy = vi
        .spyOn(await import('../lib/methodParameters'), 'buildTrade')
        .mockImplementation(mockBuildTrade);
      const buildSwapMethodParametersSpy = vi
        .spyOn(
          await import('../lib/methodParameters'),
          'buildSwapMethodParameters'
        )
        .mockImplementation(mockBuildSwapMethodParameters);

      const cappedConfig = {
        ...serviceConfig,
        Simulation: {
          ...serviceConfig.Simulation,
          Enabled: true,
          TopNQuotes: 3,
          MaxSeededAttempts: 2,
        },
      };

      let attempts = 0;
      // Every candidate reverts on a seeded run, three candidates are available
      const seededRevertSimulator: ISimulator = {
        simulate: async (chainId, swapOptions, quoteSplit) => {
          attempts++;
          return {
            ...quoteSplit,
            simulationResult: {
              estimatedGasUsed: 0n,
              estimatedGasUsedInQuoteToken: 0n,
              estimatedGasUsedInUSD: 0,
              status: SimulationStatus.FAILED,
              description: 'seeded revert',
              seeded: true,
            },
          };
        },
      };

      const uniRouteBL = buildBL(
        new MockedMultiQuoteStrategy([
          buildSplit(poolAddresses[0], 1000n),
          buildSplit(poolAddresses[1], 900n),
          buildSplit(poolAddresses[2], 800n),
        ]),
        cappedConfig,
        seededRevertSimulator
      );

      const response = await uniRouteBL.quote(ctx, request);

      expect(attempts).toBe(2);
      expect(response.simulationStatus).equals(SimulationStatus.FAILED);

      buildTradeSpy.mockRestore();
      buildSwapMethodParametersSpy.mockRestore();
    });

    it('excludes candidates whose trade build failed', async () => {
      const request = create(QuoteRequestSchema, {
        ...baseRequest,
        tradeType: 'EXACT_IN',
        includeRouteCandidates: true,
        simulateFromAddress: '0x1234567890123456789012345678901234567890',
        recipient: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
        slippageTolerance: 5,
      });

      // Best split (pool 0, first in selector order) fails buildTrade;
      // pool 1 builds + simulates and is served; pool 2 is the only
      // remaining alternative.
      const buildTradeSpy = vi
        .spyOn(await import('../lib/methodParameters'), 'buildTrade')
        .mockImplementationOnce(() => {
          throw new Error('buildTrade failed for testing');
        })
        .mockImplementation(mockBuildTrade);
      const buildSwapMethodParametersSpy = vi
        .spyOn(
          await import('../lib/methodParameters'),
          'buildSwapMethodParameters'
        )
        .mockImplementation(mockBuildSwapMethodParameters);

      const simulationEnabledConfig = {
        ...serviceConfig,
        Simulation: {
          ...serviceConfig.Simulation,
          Enabled: true,
          TopNQuotes: 3,
        },
      };

      const uniRouteBL = buildBL(
        new MockedMultiQuoteStrategy([
          buildSplit(poolAddresses[0], 1000n),
          buildSplit(poolAddresses[1], 900n),
          buildSplit(poolAddresses[2], 800n),
        ]),
        simulationEnabledConfig,
        // Simulator that never fails — only the build failure is under test.
        new SelectiveFailingSimulator(
          '0x000000000000000000000000000000000000dEaD'
        )
      );

      const response = await uniRouteBL.quote(ctx, request);

      expect(response.error).toBeUndefined();
      expect(response.quoteAmount).equals('900');
      expect(response.routeCandidates.map(c => c.quoteAmount)).deep.equals([
        '800',
      ]);

      buildTradeSpy.mockRestore();
      buildSwapMethodParametersSpy.mockRestore();
    });

    it('keeps debugLogs routeCandidates output unchanged (desc, uncapped)', async () => {
      const request = create(QuoteRequestSchema, {
        ...baseRequest,
        tradeType: 'EXACT_OUT',
        debugLogs: true,
      });
      const amounts = [300n, 700n, 100n, 500n, 200n, 600n, 400n];
      const uniRouteBL = buildBL(
        new MockedMultiQuoteStrategy(
          amounts.map((amount, i) => buildSplit(poolAddresses[i], amount))
        )
      );

      const response = await uniRouteBL.quote(ctx, request);

      expect(response.error).toBeUndefined();
      expect(response.routeCandidates).length(0);
      // Debug candidates keep historical descending order even for EXACT_OUT,
      // are uncapped, and carry no quoteGasAdjusted.
      expect(
        response.debugInfo?.routeCandidates.map(c => c.quoteAmount)
      ).deep.equals(['700', '600', '500', '400', '300', '200', '100']);
      expect(response.debugInfo?.routeCandidates[0].quoteGasAdjusted).equals(
        ''
      );
    });
  });

  describe('pool details updates', () => {
    it('should update pool details in response', async () => {
      const request = create(QuoteRequestSchema, {
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
        ): Promise<Map<string, Pool>> {
          const poolMap = new Map<string, Pool>();
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
          pools: Pool[],
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          chain: Chain
        ): Promise<Map<string, Pool>> {
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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
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

    it('should skip MainUpdateBestQuotePoolsWithFreshDetails when simulation already ran (SUCCESS)', async () => {
      const request = create(QuoteRequestSchema, {
        ...baseRequest,
        tradeType: 'EXACT_IN',
        simulateFromAddress: '0x1234567890123456789012345678901234567890',
        recipient: '0x1234567890123456789012345678901234567890',
        slippageTolerance: 20,
      });

      const singleQuote = new QuoteSplit([
        new QuoteBasic(
          new RouteBasic(Protocol.V2, [
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

      const buildTradeSpy = vi
        .spyOn(await import('../lib/methodParameters'), 'buildTrade')
        .mockImplementation(mockBuildTrade);
      const buildSwapMethodParametersSpy = vi
        .spyOn(
          await import('../lib/methodParameters'),
          'buildSwapMethodParameters'
        )
        .mockImplementation(mockBuildSwapMethodParameters);

      // Spy on getPoolDetailsForRoute to count how many times it's called
      const getPoolDetailsForRouteSpy = vi.spyOn(
        freshPoolDetailsWrapper,
        'getPoolDetailsForRoute'
      );

      const simulationEnabledConfig = {
        ...serviceConfig,
        Simulation: {
          ...serviceConfig.Simulation,
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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        // Use the failing simulator so simulation status is FAILED (pools already refreshed inside simulate loop)
        new FailingSimulator(),
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      await uniRouteBL.quote(ctx, request);

      // getPoolDetailsForRoute should have been called exactly once (inside simulateAndPopulateBestQuote),
      // and NOT a second time in the MainUpdateBestQuotePoolsWithFreshDetails block.
      expect(getPoolDetailsForRouteSpy).toHaveBeenCalledTimes(1);

      getPoolDetailsForRouteSpy.mockRestore();
      buildTradeSpy.mockRestore();
      buildSwapMethodParametersSpy.mockRestore();
    });

    it('should call MainUpdateBestQuotePoolsWithFreshDetails when simulation is disabled (UNATTEMPTED)', async () => {
      const request = create(QuoteRequestSchema, {
        ...baseRequest,
        tradeType: 'EXACT_IN',
        // No simulateFromAddress → simulation disabled → status will be UNATTEMPTED
      });

      const getPoolDetailsForRouteSpy = vi.spyOn(
        freshPoolDetailsWrapper,
        'getPoolDetailsForRoute'
      );

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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      await uniRouteBL.quote(ctx, request);

      // When simulation is disabled (UNATTEMPTED), pools were never refreshed so
      // MainUpdateBestQuotePoolsWithFreshDetails must still run.
      expect(getPoolDetailsForRouteSpy).toHaveBeenCalledTimes(1);

      getPoolDetailsForRouteSpy.mockRestore();
    });
  });

  describe('getCachedRoutes', () => {
    it('should return not found if no routes are cached', async () => {
      const request = create(GetCachedRoutesRequestSchema, {
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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      const response = await uniRouteBL.getCachedRoutes(ctx, request);

      expect(response.buckets).toBeDefined();
      expect(response.buckets.length).toBe(0);
    });

    it('should return cached routes when they exist', async () => {
      const request = create(GetCachedRoutesRequestSchema, {
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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      // Manually create a dummy route and cache it
      const dummyRoute = new RouteBasic(Protocol.V2, [
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
        EMPTY_NAMESPACE_CONTEXT,
        [Protocol.V2, Protocol.V3, Protocol.V4, Protocol.MIXED],
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
        EMPTY_NAMESPACE_CONTEXT,
        [Protocol.V2, Protocol.V3, Protocol.V4, Protocol.MIXED],
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
    it('should skip pools for tokens cache for non-inclusive hooks when variant caching is disabled', async () => {
      // Create a spy to track the getRoutes call
      const getRoutesSpy = vi.spyOn(routeRepository, 'getRoutes');

      const request = create(QuoteRequestSchema, {
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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      await uniRouteBL.quote(ctx, request);

      // Verify that getRoutes was called with skipPoolsForTokensCache = true
      expect(getRoutesSpy).toHaveBeenCalledTimes(1);
      const callArgs = getRoutesSpy.mock.calls[0];
      expect(callArgs[6]).toBe(HooksOptions.NO_HOOKS); // hooksOptions
      expect(callArgs[7]).toBe(true); // skipPoolsForTokensCache should be true

      getRoutesSpy.mockRestore();
    });

    it('should use pools for tokens cache for NO_HOOKS when variant caching is enabled', async () => {
      const getRoutesSpy = vi.spyOn(routeRepository, 'getRoutes');
      const variantCacheConfig = {
        ...serviceConfig,
        PoolDiscovery: {
          ...serviceConfig.PoolDiscovery,
          PoolsForTokensHooksVariantCacheEnabled: true,
        },
      };
      const request = create(QuoteRequestSchema, {
        ...baseRequest,
        tradeType: 'EXACT_IN',
        hooksOptions: HooksOptions.NO_HOOKS,
      });

      const uniRouteBL = new UniRouteBL(
        variantCacheConfig,
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
        noRouteCacheRepository,
        new MockedQuoteStrategy(),
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      await uniRouteBL.quote(ctx, request);

      expect(getRoutesSpy).toHaveBeenCalledTimes(1);
      const callArgs = getRoutesSpy.mock.calls[0];
      expect(callArgs[6]).toBe(HooksOptions.NO_HOOKS);
      expect(callArgs[7]).toBe(false);

      getRoutesSpy.mockRestore();
    });

    it('should still skip pools for tokens cache for HOOKS_ONLY even when variant caching is enabled', async () => {
      // HOOKS_ONLY pool lists are namespace-dependent (experiment hooks are
      // force-appended without marking the entry uncacheable), so caching
      // them would leak candidates across experiment contexts.
      const getRoutesSpy = vi.spyOn(routeRepository, 'getRoutes');
      const variantCacheConfig = {
        ...serviceConfig,
        PoolDiscovery: {
          ...serviceConfig.PoolDiscovery,
          PoolsForTokensHooksVariantCacheEnabled: true,
        },
      };
      const request = create(QuoteRequestSchema, {
        ...baseRequest,
        tradeType: 'EXACT_IN',
        hooksOptions: HooksOptions.HOOKS_ONLY,
      });

      const uniRouteBL = new UniRouteBL(
        variantCacheConfig,
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
        noRouteCacheRepository,
        new MockedQuoteStrategy(),
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      await uniRouteBL.quote(ctx, request);

      expect(getRoutesSpy).toHaveBeenCalledTimes(1);
      const callArgs = getRoutesSpy.mock.calls[0];
      expect(callArgs[6]).toBe(HooksOptions.HOOKS_ONLY);
      expect(callArgs[7]).toBe(true);

      getRoutesSpy.mockRestore();
    });

    it('should not skip pools for tokens cache when hooksOptions is HOOKS_INCLUSIVE', async () => {
      // Create a spy to track the getRoutes call
      const getRoutesSpy = vi.spyOn(routeRepository, 'getRoutes');

      const request = create(QuoteRequestSchema, {
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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
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

      const request = create(QuoteRequestSchema, {
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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
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

  describe('single-route quotes into a transfer-locked output token', () => {
    const FWA = '0xa0df17b5ac76ababa36e1450e2cbcd18a620c845';
    // Captures the RouteFinder config the pipeline hands the strategy.
    class ConfigCapturingStrategy extends MockedQuoteStrategy {
      maxSplitsSeen: number | undefined;
      override async findBestQuoteCandidates(
        ctx: Context,
        chain: Chain,
        tokenInCurrencyInfo: CurrencyInfo,
        tokenOutCurrencyInfo: CurrencyInfo,
        amount: bigint,
        tradeType: TradeType,
        protocols: Protocol[],
        config: IUniRouteServiceConfig,
        routes: RouteBasic<Pool>[],
        tokensInfo: Map<string, Erc20Token | null>,
        metricTags: string[]
      ): Promise<QuoteSplit[]> {
        this.maxSplitsSeen = config.RouteFinder.MaxSplits;
        return super.findBestQuoteCandidates(
          ctx,
          chain,
          tokenInCurrencyInfo,
          tokenOutCurrencyInfo,
          amount,
          tradeType,
          protocols,
          config,
          routes,
          tokensInfo,
          metricTags
        );
      }
    }
    const quoteInto = async (tokenOutAddress: string) => {
      const strategy = new ConfigCapturingStrategy();
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
        noRouteCacheRepository,
        strategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );
      await uniRouteBL.quote(
        ctx,
        create(QuoteRequestSchema, {
          ...baseRequest,
          tradeType: 'EXACT_IN',
          tokenOutAddress,
        })
      );
      return strategy.maxSplitsSeen;
    };

    it('caps the split search at one route when the output token has a canonical-pools entry', async () => {
      expect(serviceConfig.RouteFinder.MaxSplits).toBeGreaterThan(1);
      expect(await quoteInto(FWA)).toBe(1);
    });

    it('keeps the configured split cap for any other output token', async () => {
      expect(await quoteInto(baseRequest.tokenOutAddress)).toBe(
        serviceConfig.RouteFinder.MaxSplits
      );
    });
  });

  describe('swapsteps simulation calldata (Fork A)', () => {
    const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
    const DAI = '0x6B175474E89094C44Da98b954EedeAC495271d0F';
    const POOL_A = '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640';
    const POOL_B = '0x0000000000000000000000000000000000002222';
    const gasDetails = {
      gasUse: BigInt('150000'),
      gasPriceInWei: BigInt('30000000000'),
      gasCostInWei: BigInt('4500000000000000'),
      gasCostInEth: 0.0045,
      gasCostInQuoteToken: BigInt('1000000'),
    };
    const simConfig = {
      ...serviceConfigAsync,
      Simulation: {...serviceConfigAsync.Simulation, Enabled: true},
    };

    it('simulates encodeSwaps calldata (not legacy) and tags sim metrics with swapSteps:true', async () => {
      const request = create(QuoteRequestSchema, {
        ...baseRequest, // ETH in, USDC out
        tradeType: 'EXACT_IN',
        simulateFromAddress: '0x1234567890123456789012345678901234567890',
        recipient: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
        slippageTolerance: 5,
      });

      // Native ETH in -> USDC out via a WETH/USDC V3 pool.
      const singleQuote = new QuoteSplit([
        new QuoteBasic(
          new RouteBasic(Protocol.V3, [
            new V3Pool(
              new Address(WETH),
              new Address(baseRequest.tokenOutAddress),
              500,
              new Address(POOL_A),
              1_000_000_000_000n,
              79228162514264337593543950336n,
              0n
            ),
          ]),
          BigInt('1000000'),
          undefined,
          gasDetails
        ),
      ]);

      const tradeMock = {
        tradeType: SdkTradeType.EXACT_INPUT,
        inputAmount: CurrencyAmount.fromRawAmount(
          Ether.onChain(1),
          baseRequest.amount
        ),
        outputAmount: CurrencyAmount.fromRawAmount(
          new Token(1, baseRequest.tokenOutAddress, 6),
          '1000000'
        ),
        priceImpact: {toFixed: () => '0.01'},
      } as unknown as Trade<Currency, Currency, SdkTradeType>;

      const buildTradeSpy = vi
        .spyOn(await import('../lib/methodParameters'), 'buildTrade')
        .mockImplementation(() => tradeMock);
      const legacySpy = vi
        .spyOn(
          await import('../lib/methodParameters'),
          'buildSwapMethodParameters'
        )
        .mockImplementation(mockBuildSwapMethodParameters);
      const metricsSpy = vi.spyOn(ctx.metrics, 'count');
      const capturing = new CapturingSimulator();

      const uniRouteBL = new UniRouteBL(
        simConfig,
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
        noRouteCacheRepository,
        new MockedQuoteStrategy(singleQuote),
        capturing,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      await uniRouteBL.quote(ctx, request, {
        universalRouterSwapsteps: true,
        universalRouterVersion: UniversalRouterVersion.V2_0,
      });

      // Fork A used encodeSwaps, not the legacy builder.
      expect(legacySpy).not.toHaveBeenCalled();
      const calldata = capturing.captured?.swapInfo?.methodParameters?.calldata;
      expect(calldata?.startsWith('0x')).toBe(true);
      expect(calldata).not.toBe('0x1234567890abcdef'); // legacy mock value
      expect(calldata!.length).toBeGreaterThan(20);

      // Comment #3: simulation metrics carry the swapSteps tag.
      expect(metricsSpy).toHaveBeenCalledWith(
        expect.stringContaining('SimulationAttempts'),
        expect.anything(),
        expect.objectContaining({
          tags: expect.arrayContaining(['swapSteps:true']),
        })
      );

      buildTradeSpy.mockRestore();
      legacySpy.mockRestore();
      metricsSpy.mockRestore();
    });

    it('funds the sim with the raw amountIn on split routes, not the floored trade.inputAmount', async () => {
      // Chosen so Σ floor(amountIn·pctᵢ/100) = amountIn - 1: the funding side
      // must still match the legs, which allocateAmounts sums to the raw
      // amountIn (last leg absorbs the remainder).
      const amountIn = 1_000_000_000_000_000_001n;
      const request = create(QuoteRequestSchema, {
        ...baseRequest, // ETH in, USDC out
        amount: amountIn.toString(),
        tradeType: 'EXACT_IN',
        simulateFromAddress: '0x1234567890123456789012345678901234567890',
        recipient: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
        slippageTolerance: 5,
      });

      const v3WethUsdcPool = (addr: string) =>
        new V3Pool(
          new Address(WETH),
          new Address(baseRequest.tokenOutAddress),
          500,
          new Address(addr),
          1_000_000_000_000n,
          79228162514264337593543950336n,
          0n
        );
      // Native ETH in -> USDC out, split 15/85 across two V3 pools.
      const splitQuote = new QuoteSplit([
        new QuoteBasic(
          new RouteBasic(Protocol.V3, [v3WethUsdcPool(POOL_A)], 15),
          BigInt('150000'),
          undefined,
          gasDetails
        ),
        new QuoteBasic(
          new RouteBasic(Protocol.V3, [v3WethUsdcPool(POOL_B)], 85),
          BigInt('850000'),
          undefined,
          gasDetails
        ),
      ]);

      // Mirror buildTrade's per-route flooring: its inputAmount is 1 wei short
      // of the raw amountIn for this split.
      const flooredInput = (amountIn * 15n) / 100n + (amountIn * 85n) / 100n;
      expect(flooredInput).toBe(amountIn - 1n);
      const tradeMock = {
        tradeType: SdkTradeType.EXACT_INPUT,
        inputAmount: CurrencyAmount.fromRawAmount(
          Ether.onChain(1),
          flooredInput.toString()
        ),
        outputAmount: CurrencyAmount.fromRawAmount(
          new Token(1, baseRequest.tokenOutAddress, 6),
          '1000000'
        ),
        priceImpact: {toFixed: () => '0.01'},
      } as unknown as Trade<Currency, Currency, SdkTradeType>;

      const buildTradeSpy = vi
        .spyOn(await import('../lib/methodParameters'), 'buildTrade')
        .mockImplementation(() => tradeMock);
      const capturing = new CapturingSimulator();

      const uniRouteBL = new UniRouteBL(
        simConfig,
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
        noRouteCacheRepository,
        new MockedQuoteStrategy(splitQuote),
        capturing,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      await uniRouteBL.quote(ctx, request, {
        universalRouterSwapsteps: true,
        universalRouterVersion: UniversalRouterVersion.V2_0,
      });

      // Native input: msg.value is the spec's funding amount and must equal
      // the raw amountIn (= Σ leg amounts), not the floored trade.inputAmount.
      const mp = capturing.captured?.swapInfo?.methodParameters;
      expect(mp).toBeDefined();
      expect(BigInt(mp!.value)).toBe(amountIn);

      buildTradeSpy.mockRestore();
    });

    it('falls back to legacy calldata when the factory throws (MIXED EXACT_OUT)', async () => {
      const request = create(QuoteRequestSchema, {
        ...baseRequest,
        tradeType: 'EXACT_OUT',
        simulateFromAddress: '0x1234567890123456789012345678901234567890',
        recipient: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
        slippageTolerance: 5,
      });

      // MIXED routes reject EXACT_OUT in the factory -> Fork A must fall back.
      const mixedQuote = new QuoteSplit([
        new QuoteBasic(
          new RouteBasic(Protocol.MIXED, [
            new V3Pool(
              new Address(WETH),
              new Address(DAI),
              500,
              new Address(POOL_A),
              1_000_000_000_000n,
              79228162514264337593543950336n,
              0n
            ),
            new V2Pool(
              new Address(DAI),
              new Address(baseRequest.tokenOutAddress),
              new Address(POOL_B),
              1_000_000_000_000n,
              1_000_000_000_000n
            ),
          ]),
          BigInt('1000000000000000000'),
          undefined,
          gasDetails
        ),
      ]);

      const buildTradeSpy = vi
        .spyOn(await import('../lib/methodParameters'), 'buildTrade')
        .mockImplementation(mockBuildTrade);
      const legacySpy = vi
        .spyOn(
          await import('../lib/methodParameters'),
          'buildSwapMethodParameters'
        )
        .mockImplementation(mockBuildSwapMethodParameters);

      const capturing = new CapturingSimulator();
      const uniRouteBL = new UniRouteBL(
        simConfig,
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
        noRouteCacheRepository,
        new MockedQuoteStrategy(mixedQuote),
        capturing,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      await uniRouteBL.quote(ctx, request, {
        universalRouterSwapsteps: true,
        universalRouterVersion: UniversalRouterVersion.V2_0,
      });

      // Factory threw -> legacy builder used for the simulated calldata.
      expect(legacySpy).toHaveBeenCalled();
      expect(capturing.captured?.swapInfo?.methodParameters?.calldata).toBe(
        '0x1234567890abcdef'
      );

      buildTradeSpy.mockRestore();
      legacySpy.mockRestore();
    });
  });

  describe('permit2-disabled route-cache refresh through the real encoder', () => {
    const usdc = new Address('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
    const wrappedEth = new Address(
      '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
    );
    const simulateFromAddress = '0x1234567890123456789012345678901234567890';
    const allProtocols = [
      Protocol.V2,
      Protocol.V3,
      Protocol.V4,
      Protocol.MIXED,
    ];
    const amountIn = BigInt('1000000000000000000');
    const simConfig = {
      ...serviceConfigAsync,
      Simulation: {...serviceConfigAsync.Simulation, Enabled: true},
    };

    class RefreshEnqueuingRepository extends CachedRoutesRepository {
      enqueueRefresh(
        request: QuoteRequest,
        ctx: Context,
        quoteOptions: QuoteOptions
      ): void {
        this.sendFreshQuoteUniRouteEvent(
          allProtocols,
          ChainId.MAINNET,
          usdc,
          wrappedEth,
          TradeType.ExactIn,
          amountIn,
          request,
          ctx,
          quoteOptions
        );
      }
    }

    // The SQS message a sync FAST request enqueues, as JSON, so a test can
    // tamper with it before the refresh worker reads it.
    const enqueuedRefreshMessage = (universalRouterSwapsteps: boolean) => {
      const messageQueue = new NoOpMessageQueue();
      new RefreshEnqueuingRepository(
        new InMemoryRedisCache(),
        serviceConfig,
        messageQueue,
        FeatureGatedTokensRepository.empty()
      ).enqueueRefresh(
        create(QuoteRequestSchema, {
          tokenInAddress: usdc.toString(),
          tokenInChainId: 1,
          tokenOutAddress: wrappedEth.toString(),
          tokenOutChainId: 1,
          amount: amountIn.toString(),
          tradeType: 'EXACT_IN',
          quoteType: 'FAST',
          protocols: 'v2,v3,v4,mixed',
          simulateFromAddress,
          recipient: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
        }),
        buildTestContext(),
        {permit2Disabled: true, universalRouterSwapsteps}
      );
      expect(messageQueue.messages).toHaveLength(1);
      return JSON.parse(messageQueue.messages[0]);
    };

    // Decodes the message the way freshRequestsQueue.processMessage does and
    // runs the async BL with the real trade builder and calldata encoders.
    const runRefreshWorker = async (message: {
      payload: Record<string, unknown>;
      headers: Record<string, string | undefined>;
    }) => {
      const testCtx = buildTestContext();
      const metricsSpy = vi.spyOn(testCtx.metrics, 'count');
      const capturing = new CapturingSimulator();
      const response = await new UniRouteBL(
        simConfig,
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
        noRouteCacheRepository,
        new MockedQuoteStrategy(
          new QuoteSplit([
            new QuoteBasic(
              new RouteBasic(Protocol.V3, [
                new V3Pool(
                  usdc,
                  wrappedEth,
                  500,
                  new Address('0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640'),
                  1_000_000_000_000n,
                  79228162514264337593543950336n,
                  0n
                ),
              ]),
              BigInt('990000000000000000'),
              undefined,
              {
                gasUse: BigInt('150000'),
                gasPriceInWei: BigInt('30000000000'),
                gasCostInWei: BigInt('4500000000000000'),
                gasCostInEth: 0.0045,
                gasCostInQuoteToken: BigInt('1000000'),
              }
            ),
          ])
        ),
        capturing,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      ).quote(testCtx, create(QuoteRequestSchema, message.payload), {
        permit2Disabled: message.headers['x-permit2-disabled'] === 'true',
        universalRouterSwapsteps:
          message.headers['x-universal-router-swapsteps'] === 'true',
      });
      const counted = (metric: string) =>
        metricsSpy.mock.calls.some(([key]) => key.endsWith(`.${metric}`));
      const cliff = await noRouteCacheRepository.getAmountCliff(
        EMPTY_NAMESPACE_CONTEXT,
        allProtocols,
        ChainId.MAINNET,
        usdc,
        wrappedEth,
        TradeType.ExactIn,
        testCtx
      );
      return {response, counted, cliff, capturing};
    };

    it('builds SwapProxy calldata and caches no cliff', async () => {
      const run = await runRefreshWorker(enqueuedRefreshMessage(false));

      expect(run.response.error).toBeUndefined();
      expect(run.counted('buildSwapMethodParametersFailed')).toBe(false);
      expect(run.capturing.captured?.swapInfo?.methodParameters?.to).toBe(
        SWAP_PROXY_ADDRESS(ChainId.MAINNET)
      );
      expect(run.cliff).toBeUndefined();
    });

    it('builds swapsteps calldata and caches no cliff', async () => {
      const legacy = await runRefreshWorker(enqueuedRefreshMessage(false));
      const legacyBuilderSpy = vi.spyOn(
        await import('../lib/methodParameters'),
        'buildSwapMethodParameters'
      );

      const run = await runRefreshWorker(enqueuedRefreshMessage(true));

      expect(run.response.error).toBeUndefined();
      expect(run.counted('buildSwapStepsCalldataFailed')).toBe(false);
      expect(legacyBuilderSpy).not.toHaveBeenCalled();
      const swapInfo = run.capturing.captured?.swapInfo;
      expect(swapInfo?.methodParameters?.to).toBe(
        SWAP_PROXY_ADDRESS(ChainId.MAINNET)
      );
      // The encodeSwaps calldata differs from the legacy calldata for the
      // same route, so this fails if the swapsteps flag were ignored.
      expect(swapInfo?.methodParameters?.calldata).toMatch(/^0x[0-9a-f]+$/);
      expect(swapInfo?.methodParameters?.calldata).not.toBe(
        legacy.capturing.captured?.swapInfo?.methodParameters?.calldata
      );
      expect(run.cliff).toBeUndefined();
      legacyBuilderSpy.mockRestore();
    });

    it('answers no-route and writes a cliff when the refresh carries no recipient', async () => {
      const message = enqueuedRefreshMessage(false);
      delete message.payload.recipient;

      const run = await runRefreshWorker(message);

      expect(run.response.error).toBeDefined();
      expect(run.counted('buildSwapMethodParametersFailed')).toBe(true);
      expect(run.cliff).toBe(amountIn);
    });
  });

  describe('simulation fallback behavior', () => {
    const quoteWithSimulator = async (
      simulator: ISimulator,
      quoteCtx: Context
    ) => {
      // Create a custom service config that enables simulation
      const simulationEnabledConfig = {
        ...serviceConfigAsync,
        Simulation: {
          ...serviceConfigAsync.Simulation,
          Enabled: true,
        },
      };

      const request = create(QuoteRequestSchema, {
        ...baseRequest,
        tradeType: 'EXACT_IN',
        simulateFromAddress: '0x1234567890123456789012345678901234567890', // Enable simulation
        recipient: '0x1234567890123456789012345678901234567890', // Enable simulation
        slippageTolerance: 20, // Enable simulation
      });

      // Create a quote with swapInfo that would be captured
      const singleQuote = new QuoteSplit([
        new QuoteBasic(
          new RouteBasic(Protocol.V2, [
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

      const swapOptionsSpy = vi
        .spyOn(SwapOptionsFactory, 'createUniversalRouterOptions_2_0')

        .mockReturnValue({
          simulate: {fromAddress: request.simulateFromAddress},
        } as unknown as SwapOptionsUniversalRouter);

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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        simulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      try {
        return await uniRouteBL.quote(quoteCtx, request, {
          universalRouterVersion: UniversalRouterVersion.V2_0,
        });
      } finally {
        swapOptionsSpy.mockRestore();
        buildTradeSpy.mockRestore();
        buildSwapMethodParametersSpy.mockRestore();
      }
    };

    it('should return populated quote with Failed status when all simulations fail', async () => {
      // When simulation is enabled but all attempts fail, we still return a
      // populated quote with Failed status and the swapInfo from the first attempt
      const response = await quoteWithSimulator(new FailingSimulator(), ctx);

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
    });

    it('counts a SYSTEM_DOWN simulation as a failure, not a success', async () => {
      const testCtx = buildTestContext();
      const response = await quoteWithSimulator(
        new FailingSimulator(SimulationStatus.SYSTEM_DOWN),
        testCtx
      );

      expect(response.error).toBeUndefined();
      expect(response.simulationStatus).equals(SimulationStatus.SYSTEM_DOWN);
      expect(
        testCtx.metrics.countStore[buildMetricKey('SimulationFailures')]
      ).toBe(1);
      expect(
        testCtx.metrics.countStore[buildMetricKey('SimulationSuccesses')]
      ).toBe(0);
      expect(
        testCtx.metrics.countStore[buildMetricKey('SimulationAttempts')]
      ).toBe(1);
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

      const request = create(QuoteRequestSchema, {
        ...baseRequest,
        tradeType: 'EXACT_IN',
        simulateFromAddress: '0x1234567890123456789012345678901234567890', // Enable simulation
        recipient: '0x1234567890123456789012345678901234567890', // Enable simulation
        slippageTolerance: 20, // Enable simulation
      });

      // Create a quote with swapInfo that would be captured
      const singleQuote = new QuoteSplit([
        new QuoteBasic(
          new RouteBasic(Protocol.V2, [
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

      const swapOptionsSpy = vi
        .spyOn(SwapOptionsFactory, 'createUniversalRouterOptions_2_0')

        .mockReturnValue({
          simulate: {fromAddress: request.simulateFromAddress},
        } as unknown as SwapOptionsUniversalRouter);

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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        failingSimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      const response = await uniRouteBL.quote(ctx, request, {
        universalRouterVersion: UniversalRouterVersion.V2_0,
      });

      // Should return an error response (404) because buildTrade failed and no fallback is available
      expect(response.error).toBeDefined();
      expect(response.error?.code).equals(404);
      expect(response.error?.message).contains('No valid quotes found');
      expect(quoteErrorReasonOf(response.error)).equals(
        QuoteErrorReason.NO_ROUTE
      );
      swapOptionsSpy.mockRestore();
    });

    it('should return populated quote with Failed status when simulation is disabled but quote building fails', async () => {
      const request = create(QuoteRequestSchema, {
        ...baseRequest,
        tradeType: 'EXACT_IN',
        // No simulateFromAddress - simulation disabled
      });

      const singleQuote = new QuoteSplit([
        new QuoteBasic(
          new RouteBasic(Protocol.V2, [
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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
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

    it('should scale gasUseEstimateQuote proportionally with CHAIN_TO_GAS_LIMIT_MAP when simulation FAILS (EXACT_IN)', async () => {
      // When simulation fails, populateQuoteResponse overrides:
      //   finalGasUseEstimate      <- CHAIN_TO_GAS_LIMIT_MAP[chainId]  (200000 for MAINNET)
      //   finalGasUseEstimateQuote <- gasCostInQuoteToken * finalGasUseEstimate / totalGasUse
      //                              = 1000000 * 200000 / 150000 = 1333333 (integer division)
      //   finalGasUseEstimateUSD   <- gasCostInUSD * finalGasUseEstimate / totalGasUse
      //                              = 0 * 200000 / 150000 = 0 (gasCostInUSD not set in test data)
      // quoteGasAdjusted is then computed from the scaled finalGasUseEstimateQuote.

      const simulationEnabledConfig = {
        ...serviceConfigAsync,
        Simulation: {
          ...serviceConfigAsync.Simulation,
          Enabled: true,
        },
      };

      const request = create(QuoteRequestSchema, {
        ...baseRequest,
        tradeType: 'EXACT_IN',
        simulateFromAddress: '0x1234567890123456789012345678901234567890',
        recipient: '0x1234567890123456789012345678901234567890',
        slippageTolerance: 20,
      });

      // gasCostInQuoteToken and gasUse are intentionally different from the chain limit
      // so we can verify which value ends up in each response field.
      const singleQuote = new QuoteSplit([
        new QuoteBasic(
          new RouteBasic(Protocol.V2, [
            new V2Pool(
              new Address(baseRequest.tokenInAddress),
              new Address(baseRequest.tokenOutAddress),
              new Address('0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640'),
              BigInt('1000000000000'),
              BigInt('1000000000000')
            ),
          ]),
          BigInt('1234567890'), // totalQuoteAmount
          undefined,
          {
            gasUse: BigInt('150000'), // differs from chain limit (200000) to confirm override
            gasPriceInWei: BigInt('30000000000'),
            gasCostInWei: BigInt('4500000000000000'),
            gasCostInEth: 0.0045,
            gasCostInQuoteToken: BigInt('1000000'), // used for quoteGasAdjusted calc before override
          }
        ),
      ]);

      const mockedQuoteStrategy = new MockedQuoteStrategy(singleQuote);
      const failingSimulator = new FailingSimulator();

      const buildTradeSpy = vi
        .spyOn(await import('../lib/methodParameters'), 'buildTrade')
        .mockImplementation(mockBuildTrade);
      const buildSwapMethodParametersSpy = vi
        .spyOn(
          await import('../lib/methodParameters'),
          'buildSwapMethodParameters'
        )
        .mockImplementation(mockBuildSwapMethodParameters);

      const swapOptionsSpy = vi
        .spyOn(SwapOptionsFactory, 'createUniversalRouterOptions_2_0')

        .mockReturnValue({
          simulate: {fromAddress: request.simulateFromAddress},
        } as unknown as SwapOptionsUniversalRouter);

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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        failingSimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      const response = await uniRouteBL.quote(ctx, request, {
        universalRouterVersion: UniversalRouterVersion.V2_0,
      });

      expect(response.simulationStatus).equals(SimulationStatus.FAILED);
      expect(response.simulationError).toBe(true);

      // gasUseEstimate must come from CHAIN_TO_GAS_LIMIT_MAP[MAINNET] = 200000
      // (not 150000 from the quote's gasUse)
      expect(response.gasUseEstimate).equals('200000');

      // gasUseEstimateQuote scaled: gasCostInQuoteToken * chainLimit / totalGasUse
      // = 1000000 * 200000 / 150000 = 1333333 (BigInt integer division)
      expect(response.gasUseEstimateQuote).equals('1333333');

      // gasUseEstimateUSD scaled: 0 (gasCostInUSD not provided in test data)
      expect(response.gasUseEstimateUSD).equals('0');

      // quoteGasAdjusted uses the scaled finalGasUseEstimateQuote
      // EXACT_IN: totalQuoteAmount - finalGasUseEstimateQuote = 1234567890 - 1333333 = 1233234557
      expect(response.quoteGasAdjusted).equals('1233234557');

      swapOptionsSpy.mockRestore();
      buildTradeSpy.mockRestore();
      buildSwapMethodParametersSpy.mockRestore();
    });

    it('should scale gasUseEstimateQuote proportionally with CHAIN_TO_GAS_LIMIT_MAP when simulation FAILS (EXACT_OUT)', async () => {
      // Same as the EXACT_IN test above, but verifies that quoteGasAdjusted *adds*
      // the scaled finalGasUseEstimateQuote for EXACT_OUT trades.

      const simulationEnabledConfig = {
        ...serviceConfigAsync,
        Simulation: {
          ...serviceConfigAsync.Simulation,
          Enabled: true,
        },
      };

      const request = create(QuoteRequestSchema, {
        ...baseRequest,
        tradeType: 'EXACT_OUT',
        simulateFromAddress: '0x1234567890123456789012345678901234567890',
        recipient: '0x1234567890123456789012345678901234567890',
        slippageTolerance: 20,
      });

      const singleQuote = new QuoteSplit([
        new QuoteBasic(
          new RouteBasic(Protocol.V2, [
            new V2Pool(
              new Address(baseRequest.tokenInAddress),
              new Address(baseRequest.tokenOutAddress),
              new Address('0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640'),
              BigInt('1000000000000'),
              BigInt('1000000000000')
            ),
          ]),
          BigInt('1234567890'), // totalQuoteAmount
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

      const buildTradeSpy = vi
        .spyOn(await import('../lib/methodParameters'), 'buildTrade')
        .mockImplementation(mockBuildTrade);
      const buildSwapMethodParametersSpy = vi
        .spyOn(
          await import('../lib/methodParameters'),
          'buildSwapMethodParameters'
        )
        .mockImplementation(mockBuildSwapMethodParameters);

      const swapOptionsSpy = vi
        .spyOn(SwapOptionsFactory, 'createUniversalRouterOptions_2_0')

        .mockReturnValue({
          simulate: {fromAddress: request.simulateFromAddress},
        } as unknown as SwapOptionsUniversalRouter);

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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        failingSimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      const response = await uniRouteBL.quote(ctx, request, {
        universalRouterVersion: UniversalRouterVersion.V2_0,
      });

      expect(response.simulationStatus).equals(SimulationStatus.FAILED);
      expect(response.simulationError).toBe(true);

      // gasUseEstimate overridden to CHAIN_TO_GAS_LIMIT_MAP[MAINNET] = 200000
      expect(response.gasUseEstimate).equals('200000');

      // gasUseEstimateQuote scaled: 1000000 * 200000 / 150000 = 1333333
      expect(response.gasUseEstimateQuote).equals('1333333');

      // gasUseEstimateUSD scaled: 0 (gasCostInUSD not provided in test data)
      expect(response.gasUseEstimateUSD).equals('0');

      // EXACT_OUT: totalQuoteAmount + finalGasUseEstimateQuote = 1234567890 + 1333333 = 1235901223
      expect(response.quoteGasAdjusted).equals('1235901223');

      swapOptionsSpy.mockRestore();
      buildTradeSpy.mockRestore();
      buildSwapMethodParametersSpy.mockRestore();
    });

    describe('INSUFFICIENT_BALANCE gas handling', () => {
      const singleQuoteWithHeuristicGas = () =>
        new QuoteSplit([
          new QuoteBasic(
            new RouteBasic(Protocol.V2, [
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

      const quoteWithSimulator = async (simulator: ISimulator) => {
        const simulationEnabledConfig = {
          ...serviceConfigAsync,
          Simulation: {
            ...serviceConfigAsync.Simulation,
            Enabled: true,
          },
        };
        const SEEDED_SWAPPER = '0x1234567890123456789012345678901234567890';
        const request = create(QuoteRequestSchema, {
          ...baseRequest,
          tradeType: 'EXACT_IN',
          simulateFromAddress: SEEDED_SWAPPER,
          recipient: SEEDED_SWAPPER,
          slippageTolerance: 20,
        });
        const buildTradeSpy = vi
          .spyOn(await import('../lib/methodParameters'), 'buildTrade')
          .mockImplementation(mockBuildTrade);
        const buildSwapMethodParametersSpy = vi
          .spyOn(
            await import('../lib/methodParameters'),
            'buildSwapMethodParameters'
          )
          .mockImplementation(mockBuildSwapMethodParameters);
        const seededSwapOptions: SwapOptionsUniversalRouter = {
          type: SwapType.UNIVERSAL_ROUTER,
          urVersion: UniversalRouterVersion.V2_0,
          simulate: {fromAddress: SEEDED_SWAPPER},
          slippageTolerance: new Percent(20, 100),
          tokenTransferMode: TokenTransferMode.Permit2,
        };
        const swapOptionsSpy = vi
          .spyOn(SwapOptionsFactory, 'createUniversalRouterOptions_2_0')
          .mockReturnValue(seededSwapOptions);
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
          noRouteCacheRepository,
          new MockedQuoteStrategy(singleQuoteWithHeuristicGas()),
          simulator,
          quoteRequestValidator,
          tokenProvider,
          mockedRpcProviderMap,
          stateOverrideResolver
        );
        try {
          return await uniRouteBL.quote(ctx, request, {
            universalRouterVersion: UniversalRouterVersion.V2_0,
          });
        } finally {
          swapOptionsSpy.mockRestore();
          buildTradeSpy.mockRestore();
          buildSwapMethodParametersSpy.mockRestore();
        }
      };

      it('applies the gas of a seeded-balance run to the response like a SUCCESS', async () => {
        const response = await quoteWithSimulator(new SeededBalanceSimulator());

        expect(response.simulationStatus).equals(
          SimulationStatus.INSUFFICIENT_BALANCE
        );
        expect(response.simulationError).toBe(true);
        expect(response.gasUseEstimate).equals('170000');
        expect(response.gasUseEstimateQuote).equals('2000000');
        expect(response.gasUseEstimateUSD).equals('1.5');
        // EXACT_IN subtracts the simulated gas in quote token from totalQuoteAmount
        expect(response.quoteGasAdjusted).equals('1232567890');
      });

      it('keeps the heuristic gas when INSUFFICIENT_BALANCE carries none (the run did not execute)', async () => {
        const response = await quoteWithSimulator(
          new FailingSimulator(SimulationStatus.INSUFFICIENT_BALANCE)
        );

        expect(response.simulationStatus).equals(
          SimulationStatus.INSUFFICIENT_BALANCE
        );
        expect(response.gasUseEstimate).equals('150000');
        expect(response.gasUseEstimateQuote).equals('1000000');
        expect(response.quoteGasAdjusted).equals('1233567890');
      });
    });

    it('should scale gasUseEstimateUSD proportionally with CHAIN_TO_GAS_LIMIT_MAP when simulation FAILS', async () => {
      // Verifies that gasUseEstimateUSD is also scaled proportionally, not left as the
      // raw gasCostInUSD from the original gas estimate.
      // totalGasUse = 150000, chain limit = 200000
      // finalGasUseEstimateUSD = 1.5 * 200000 / 150000 = 2.0

      const simulationEnabledConfig = {
        ...serviceConfigAsync,
        Simulation: {
          ...serviceConfigAsync.Simulation,
          Enabled: true,
        },
      };

      const request = create(QuoteRequestSchema, {
        ...baseRequest,
        tradeType: 'EXACT_IN',
        simulateFromAddress: '0x1234567890123456789012345678901234567890',
        recipient: '0x1234567890123456789012345678901234567890',
        slippageTolerance: 20,
      });

      const singleQuote = new QuoteSplit([
        new QuoteBasic(
          new RouteBasic(Protocol.V2, [
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
            gasCostInUSD: 1.5, // $1.50 original estimate
          }
        ),
      ]);

      const mockedQuoteStrategy = new MockedQuoteStrategy(singleQuote);
      const failingSimulator = new FailingSimulator();

      const buildTradeSpy = vi
        .spyOn(await import('../lib/methodParameters'), 'buildTrade')
        .mockImplementation(mockBuildTrade);
      const buildSwapMethodParametersSpy = vi
        .spyOn(
          await import('../lib/methodParameters'),
          'buildSwapMethodParameters'
        )
        .mockImplementation(mockBuildSwapMethodParameters);

      const swapOptionsSpy = vi
        .spyOn(SwapOptionsFactory, 'createUniversalRouterOptions_2_0')

        .mockReturnValue({
          simulate: {fromAddress: request.simulateFromAddress},
        } as unknown as SwapOptionsUniversalRouter);

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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        failingSimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      const response = await uniRouteBL.quote(ctx, request, {
        universalRouterVersion: UniversalRouterVersion.V2_0,
      });

      expect(response.simulationStatus).equals(SimulationStatus.FAILED);
      expect(response.gasUseEstimate).equals('200000');

      // gasUseEstimateQuote: 1000000 * 200000 / 150000 = 1333333
      expect(response.gasUseEstimateQuote).equals('1333333');

      // gasUseEstimateUSD: 1.5 * 200000 / 150000 = 2.0
      expect(response.gasUseEstimateUSD).equals('2');

      swapOptionsSpy.mockRestore();
      buildTradeSpy.mockRestore();
      buildSwapMethodParametersSpy.mockRestore();
    });

    it('should correctly set gasUseEstimateQuoteDecimals when simulation FAILS', async () => {
      // gasUseEstimateQuoteDecimals is CurrencyAmount.fromRawAmount(token, finalGasUseEstimateQuote)
      // TestTokenHandler returns tokens with 18 decimals.
      // finalGasUseEstimateQuote = 1333333 → toExact() = "0.000000000001333333"

      const simulationEnabledConfig = {
        ...serviceConfigAsync,
        Simulation: {
          ...serviceConfigAsync.Simulation,
          Enabled: true,
        },
      };

      const request = create(QuoteRequestSchema, {
        ...baseRequest,
        tradeType: 'EXACT_IN',
        simulateFromAddress: '0x1234567890123456789012345678901234567890',
        recipient: '0x1234567890123456789012345678901234567890',
        slippageTolerance: 20,
      });

      const singleQuote = new QuoteSplit([
        new QuoteBasic(
          new RouteBasic(Protocol.V2, [
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

      const buildTradeSpy = vi
        .spyOn(await import('../lib/methodParameters'), 'buildTrade')
        .mockImplementation(mockBuildTrade);
      const buildSwapMethodParametersSpy = vi
        .spyOn(
          await import('../lib/methodParameters'),
          'buildSwapMethodParameters'
        )
        .mockImplementation(mockBuildSwapMethodParameters);

      const swapOptionsSpy = vi
        .spyOn(SwapOptionsFactory, 'createUniversalRouterOptions_2_0')

        .mockReturnValue({
          simulate: {fromAddress: request.simulateFromAddress},
        } as unknown as SwapOptionsUniversalRouter);

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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        failingSimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      const response = await uniRouteBL.quote(ctx, request, {
        universalRouterVersion: UniversalRouterVersion.V2_0,
      });

      expect(response.simulationStatus).equals(SimulationStatus.FAILED);

      // finalGasUseEstimateQuote = 1333333 (18 decimal token → 0.000000000001333333)
      expect(response.gasUseEstimateQuote).equals('1333333');
      expect(response.gasUseEstimateQuoteDecimals).equals(
        '0.000000000001333333'
      );

      swapOptionsSpy.mockRestore();
      buildTradeSpy.mockRestore();
      buildSwapMethodParametersSpy.mockRestore();
    });
  });

  describe('universalRouterVersion option', () => {
    // Base simulation config & request reused across tests
    const simulationEnabledConfig = {
      ...getUniRouteTestConfig(LambdaType.Async),
      Simulation: {
        TopNQuotes: 3,
        Enabled: true,
        MaxSeededAttempts: 2,
      },
    };

    const simulationRequest = create(QuoteRequestSchema, {
      ...{
        tokenInAddress: 'ETH',
        tokenInChainId: 1,
        tokenOutAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        tokenOutChainId: 1,
        amount: '1000000000000000000',
        quoteType: 'FAST',
        protocols: 'v2,v3,v4,mixed',
      },
      tradeType: 'EXACT_IN',
      simulateFromAddress: '0x1234567890123456789012345678901234567890',
      recipient: '0x1234567890123456789012345678901234567890',
      slippageTolerance: 20,
    });

    it('should skip simulation when universalRouterVersion is V1_2, even if simulateFromAddress is set', async () => {
      let simulateCalled = false;
      const trackingSimulator: ISimulator = {
        simulate: async (...args: Parameters<ISimulator['simulate']>) => {
          simulateCalled = true;
          return (dummySimulator as ISimulator).simulate(...args);
        },
      };

      const mockedQuoteStrategy = new MockedQuoteStrategy();
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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        trackingSimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      const response = await uniRouteBL.quote(ctx, simulationRequest, {
        universalRouterVersion: UniversalRouterVersion.V1_2,
      });

      expect(response.error).toBeUndefined();
      // swapOptions is undefined for V1_2, so simulation block is never entered
      expect(simulateCalled).toBe(false);
      expect(response.simulationStatus).equals(SimulationStatus.UNATTEMPTED);
    });

    it('should default to V2_0 and run simulation when universalRouterVersion is absent and simulateFromAddress is set', async () => {
      const failingSimulator = new FailingSimulator();

      const buildTradeSpy = vi
        .spyOn(await import('../lib/methodParameters'), 'buildTrade')
        .mockImplementation(mockBuildTrade);
      const buildSwapMethodParametersSpy = vi
        .spyOn(
          await import('../lib/methodParameters'),
          'buildSwapMethodParameters'
        )
        .mockImplementation(mockBuildSwapMethodParameters);

      const swapOptionsSpy = vi
        .spyOn(SwapOptionsFactory, 'createUniversalRouterOptions_2_0')
        .mockReturnValue({
          simulate: {fromAddress: simulationRequest.simulateFromAddress},
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);

      const mockedQuoteStrategy = new MockedQuoteStrategy();
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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        failingSimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      // No universalRouterVersion in options → defaults to V2_0 → simulation runs
      const response = await uniRouteBL.quote(ctx, simulationRequest, {});

      expect(response.error).toBeUndefined();
      expect(response.simulationStatus).equals(SimulationStatus.FAILED);

      swapOptionsSpy.mockRestore();
      buildTradeSpy.mockRestore();
      buildSwapMethodParametersSpy.mockRestore();
    });

    it('should run simulation when universalRouterVersion is V2_0 and simulateFromAddress is set', async () => {
      const failingSimulator = new FailingSimulator();

      const buildTradeSpy = vi
        .spyOn(await import('../lib/methodParameters'), 'buildTrade')
        .mockImplementation(mockBuildTrade);
      const buildSwapMethodParametersSpy = vi
        .spyOn(
          await import('../lib/methodParameters'),
          'buildSwapMethodParameters'
        )
        .mockImplementation(mockBuildSwapMethodParameters);

      const swapOptionsSpy = vi
        .spyOn(SwapOptionsFactory, 'createUniversalRouterOptions_2_0')

        .mockReturnValue({
          simulate: {fromAddress: simulationRequest.simulateFromAddress},
        } as unknown as SwapOptionsUniversalRouter);

      const mockedQuoteStrategy = new MockedQuoteStrategy();
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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        failingSimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      const response = await uniRouteBL.quote(ctx, simulationRequest, {
        universalRouterVersion: UniversalRouterVersion.V2_0,
      });

      expect(response.error).toBeUndefined();
      // swapOptions is created for V2_0 → simulation block is entered → FailingSimulator fires
      expect(response.simulationStatus).equals(SimulationStatus.FAILED);

      swapOptionsSpy.mockRestore();
      buildTradeSpy.mockRestore();
      buildSwapMethodParametersSpy.mockRestore();
    });

    it('should run simulation when universalRouterVersion is V2_1_1 and simulateFromAddress is set', async () => {
      const failingSimulator = new FailingSimulator();

      const buildTradeSpy = vi
        .spyOn(await import('../lib/methodParameters'), 'buildTrade')
        .mockImplementation(mockBuildTrade);
      const buildSwapMethodParametersSpy = vi
        .spyOn(
          await import('../lib/methodParameters'),
          'buildSwapMethodParameters'
        )
        .mockImplementation(mockBuildSwapMethodParameters);
      const swapOptionsSpy = vi
        .spyOn(SwapOptionsFactory, 'createUniversalRouterOptions_2_1_1')

        .mockReturnValue({
          simulate: {fromAddress: simulationRequest.simulateFromAddress},
        } as unknown as SwapOptionsUniversalRouter);

      const mockedQuoteStrategy = new MockedQuoteStrategy();
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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        failingSimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      const response = await uniRouteBL.quote(ctx, simulationRequest, {
        universalRouterVersion: UniversalRouterVersion.V2_1_1,
      });

      expect(response.error).toBeUndefined();
      // swapOptions is created for V2_1_1 → simulation block is entered → FailingSimulator fires
      expect(response.simulationStatus).equals(SimulationStatus.FAILED);

      swapOptionsSpy.mockRestore();
      buildTradeSpy.mockRestore();
      buildSwapMethodParametersSpy.mockRestore();
    });

    it('should run simulation when universalRouterVersion is V2_2_0 and simulateFromAddress is set', async () => {
      const failingSimulator = new FailingSimulator();

      const buildTradeSpy = vi
        .spyOn(await import('../lib/methodParameters'), 'buildTrade')
        .mockImplementation(mockBuildTrade);
      const buildSwapMethodParametersSpy = vi
        .spyOn(
          await import('../lib/methodParameters'),
          'buildSwapMethodParameters'
        )
        .mockImplementation(mockBuildSwapMethodParameters);
      const swapOptionsSpy = vi
        .spyOn(SwapOptionsFactory, 'createUniversalRouterOptions_2_2_0')

        .mockReturnValue({
          simulate: {fromAddress: simulationRequest.simulateFromAddress},
        } as unknown as SwapOptionsUniversalRouter);

      const mockedQuoteStrategy = new MockedQuoteStrategy();
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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        failingSimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      const response = await uniRouteBL.quote(ctx, simulationRequest, {
        universalRouterVersion: UniversalRouterVersion.V2_2_0,
      });

      expect(response.error).toBeUndefined();
      // swapOptions is created for V2_2_0 → simulation block is entered → FailingSimulator fires
      expect(response.simulationStatus).equals(SimulationStatus.FAILED);

      swapOptionsSpy.mockRestore();
      buildTradeSpy.mockRestore();
      buildSwapMethodParametersSpy.mockRestore();
    });

    it('should run simulation when universalRouterVersion is V2_1_2 and simulateFromAddress is set', async () => {
      const failingSimulator = new FailingSimulator();

      const buildTradeSpy = vi
        .spyOn(await import('../lib/methodParameters'), 'buildTrade')
        .mockImplementation(mockBuildTrade);
      const buildSwapMethodParametersSpy = vi
        .spyOn(
          await import('../lib/methodParameters'),
          'buildSwapMethodParameters'
        )
        .mockImplementation(mockBuildSwapMethodParameters);
      // 2.1.2 must dispatch to its own factory entry, not the 2.1.1 one:
      // the two differ only in router address, which the factory owns.
      const swapOptions2_1_1Spy = vi.spyOn(
        SwapOptionsFactory,
        'createUniversalRouterOptions_2_1_1'
      );
      const swapOptionsSpy = vi
        .spyOn(SwapOptionsFactory, 'createUniversalRouterOptions_2_1_2')
        .mockReturnValue({
          simulate: {fromAddress: simulationRequest.simulateFromAddress},
        } as unknown as SwapOptionsUniversalRouter);

      const mockedQuoteStrategy = new MockedQuoteStrategy();
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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        failingSimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      const response = await uniRouteBL.quote(ctx, simulationRequest, {
        universalRouterVersion: UniversalRouterVersion.V2_1_2,
      });

      expect(response.error).toBeUndefined();
      // swapOptions is created for V2_1_2 → simulation block is entered → FailingSimulator fires
      expect(response.simulationStatus).equals(SimulationStatus.FAILED);
      expect(swapOptionsSpy).toHaveBeenCalled();
      expect(swapOptions2_1_1Spy).not.toHaveBeenCalled();

      swapOptions2_1_1Spy.mockRestore();
      swapOptionsSpy.mockRestore();
      buildTradeSpy.mockRestore();
      buildSwapMethodParametersSpy.mockRestore();
    });

    it('should skip simulation when universalRouterVersion is V2_1_1 but simulateFromAddress is not set', async () => {
      let simulateCalled = false;
      const trackingSimulator: ISimulator = {
        simulate: async (...args: Parameters<ISimulator['simulate']>) => {
          simulateCalled = true;
          return (dummySimulator as ISimulator).simulate(...args);
        },
      };

      const requestWithoutSimulate = create(QuoteRequestSchema, {
        ...{
          tokenInAddress: 'ETH',
          tokenInChainId: 1,
          tokenOutAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          tokenOutChainId: 1,
          amount: '1000000000000000000',
          quoteType: 'FAST',
          protocols: 'v2,v3,v4,mixed',
        },
        tradeType: 'EXACT_IN',
        recipient: '0x1234567890123456789012345678901234567890',
        slippageTolerance: 20,
      });

      const mockedQuoteStrategy = new MockedQuoteStrategy();
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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        trackingSimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      const response = await uniRouteBL.quote(ctx, requestWithoutSimulate, {
        universalRouterVersion: UniversalRouterVersion.V2_1_1,
      });

      expect(response.error).toBeUndefined();
      expect(simulateCalled).toBe(false);
      expect(response.simulationStatus).equals(SimulationStatus.UNATTEMPTED);
    });
  });

  describe('deleteCachedRoutes', () => {
    it('should return success true even if no routes are cached to delete', async () => {
      const request = create(DeleteCachedRoutesRequestSchema, {
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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      const response = await uniRouteBL.deleteCachedRoutes(ctx, request);

      expect(response.success).toBe(true);
      expect(response.message).toContain('deleted successfully');
    });

    it('should successfully delete cached routes when they exist', async () => {
      const request = create(DeleteCachedRoutesRequestSchema, {
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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      // First, manually create a dummy route and cache it
      const dummyRoute = new RouteBasic(Protocol.V2, [
        new V2Pool(
          new Address('0x0000000000000000000000000000000000000000'),
          new Address('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
          new Address('0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640'),
          BigInt('1000000000000'),
          BigInt('1000000000000')
        ),
      ]);

      await cachedRoutesRepository.saveCachedRoutes(
        EMPTY_NAMESPACE_CONTEXT,
        [Protocol.V2, Protocol.V3, Protocol.V4, Protocol.MIXED],
        dummyRoute,
        1, // chainId
        new Address('0x0000000000000000000000000000000000000000'),
        new Address('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
        TradeType.ExactIn,
        BigInt('1000000000000000000'),
        UsdBucket.USD_1_000_000
      );

      // Verify the route exists before deletion
      const getRequest = create(GetCachedRoutesRequestSchema, {
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
      const request = create(QuoteRequestSchema, {
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
      const mixedRoute = new RouteBasic(Protocol.MIXED, [
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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
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

    it('should re-assign amountIn to new first pool when fake pool was first (ExactIn)', async () => {
      const request = create(QuoteRequestSchema, {
        ...baseRequest,
        tradeType: 'EXACT_IN',
      });

      const fakeV4Pool = new V4Pool(
        new Address('0x0000000000000000000000000000000000000000'),
        new Address('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'),
        0,
        0, // FAKE_TICK_SPACING
        '0x0000000000000000000000000000000000000000',
        0n,
        '0x0000000000000000000000000000000000000001',
        79228162514264337593543950336n,
        0n
      );

      const realV4Pool = new V4Pool(
        new Address('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'),
        new Address('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
        500,
        10, // real tick spacing
        '0x0000000000000000000000000000000000000000',
        1000000n,
        '0x0000000000000000000000000000000000000002',
        79228162514264337593543950336n,
        0n
      );

      // Route: [fake (index=0, gets amountIn), real (index=1=last, gets amountOut)]
      // After filter: [real] → real needs amountIn re-assigned by the bug fix
      const singleQuote = new QuoteSplit([
        new QuoteBasic(
          new RouteBasic(Protocol.V4, [fakeV4Pool, realV4Pool]),
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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      const response = await uniRouteBL.quote(ctx, request);

      expect(response.error).toBeUndefined();
      expect(response.route[0].pools.length).toBe(1);
      const pool = response.route[0].pools[0];
      expect(pool.type).toBe('v4-pool');
      expect(pool.tickSpacing).toBe('10');
      // amountIn re-assigned by bug fix to quoteAmountsIn[0] = request amount
      expect(pool.amountIn).toBe('1000000000000000000');
      // amountOut was already set (real was last in original route)
      expect(pool.amountOut).toBe('1234567890');
    });

    it('should re-assign amountOut to new last pool when fake pool was last (ExactIn)', async () => {
      const request = create(QuoteRequestSchema, {
        ...baseRequest,
        tradeType: 'EXACT_IN',
      });

      const realV4Pool = new V4Pool(
        new Address('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'),
        new Address('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
        500,
        10,
        '0x0000000000000000000000000000000000000000',
        1000000n,
        '0x0000000000000000000000000000000000000002',
        79228162514264337593543950336n,
        0n
      );

      const fakeV4Pool = new V4Pool(
        new Address('0x0000000000000000000000000000000000000000'),
        new Address('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'),
        0,
        0, // FAKE_TICK_SPACING
        '0x0000000000000000000000000000000000000000',
        0n,
        '0x0000000000000000000000000000000000000001',
        79228162514264337593543950336n,
        0n
      );

      // Route: [real (index=0, gets amountIn), fake (index=1=last, gets amountOut)]
      // After filter: [real] → real needs amountOut re-assigned by the bug fix
      const singleQuote = new QuoteSplit([
        new QuoteBasic(
          new RouteBasic(Protocol.V4, [realV4Pool, fakeV4Pool]),
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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      const response = await uniRouteBL.quote(ctx, request);

      expect(response.error).toBeUndefined();
      expect(response.route[0].pools.length).toBe(1);
      const pool = response.route[0].pools[0];
      expect(pool.type).toBe('v4-pool');
      expect(pool.tickSpacing).toBe('10');
      // amountIn was already set (real was first in original route)
      expect(pool.amountIn).toBe('1000000000000000000');
      // amountOut re-assigned by bug fix to (quote.amount - portionAmount) = '1234567890'
      expect(pool.amountOut).toBe('1234567890');
    });

    it('should re-assign amountIn to new first pool when fake pool was first (ExactOut)', async () => {
      const request = create(QuoteRequestSchema, {
        ...baseRequest,
        tradeType: 'EXACT_OUT',
      });

      const fakeV4Pool = new V4Pool(
        new Address('0x0000000000000000000000000000000000000000'),
        new Address('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'),
        0,
        0, // FAKE_TICK_SPACING
        '0x0000000000000000000000000000000000000000',
        0n,
        '0x0000000000000000000000000000000000000001',
        79228162514264337593543950336n,
        0n
      );

      const realV4Pool = new V4Pool(
        new Address('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'),
        new Address('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
        500,
        10,
        '0x0000000000000000000000000000000000000000',
        1000000n,
        '0x0000000000000000000000000000000000000002',
        79228162514264337593543950336n,
        0n
      );

      // Route: [fake (index=0, gets amountIn=quote.amount), real (index=1=last, gets amountOut=quoteAmountsIn[0])]
      // After filter: [real] → real needs amountIn re-assigned to quote.amount
      const singleQuote = new QuoteSplit([
        new QuoteBasic(
          new RouteBasic(Protocol.V4, [fakeV4Pool, realV4Pool]),
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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      const response = await uniRouteBL.quote(ctx, request);

      expect(response.error).toBeUndefined();
      expect(response.route[0].pools.length).toBe(1);
      const pool = response.route[0].pools[0];
      expect(pool.type).toBe('v4-pool');
      expect(pool.tickSpacing).toBe('10');
      // amountIn re-assigned by bug fix to quote.amount (computed input for ExactOut)
      expect(pool.amountIn).toBe('1234567890');
      // amountOut was already set (real was last) = quoteAmountsIn[0] = request amount
      expect(pool.amountOut).toBe('1000000000000000000');
    });

    it('should re-assign amountOut to new last pool when fake pool was last (ExactOut)', async () => {
      const request = create(QuoteRequestSchema, {
        ...baseRequest,
        tradeType: 'EXACT_OUT',
      });

      const realV4Pool = new V4Pool(
        new Address('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'),
        new Address('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
        500,
        10,
        '0x0000000000000000000000000000000000000000',
        1000000n,
        '0x0000000000000000000000000000000000000002',
        79228162514264337593543950336n,
        0n
      );

      const fakeV4Pool = new V4Pool(
        new Address('0x0000000000000000000000000000000000000000'),
        new Address('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'),
        0,
        0, // FAKE_TICK_SPACING
        '0x0000000000000000000000000000000000000000',
        0n,
        '0x0000000000000000000000000000000000000001',
        79228162514264337593543950336n,
        0n
      );

      // Route: [real (index=0, gets amountIn=quote.amount), fake (index=1=last, gets amountOut=quoteAmountsIn[0])]
      // After filter: [real] → real needs amountOut re-assigned to quoteAmountsIn[0]
      const singleQuote = new QuoteSplit([
        new QuoteBasic(
          new RouteBasic(Protocol.V4, [realV4Pool, fakeV4Pool]),
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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      const response = await uniRouteBL.quote(ctx, request);

      expect(response.error).toBeUndefined();
      expect(response.route[0].pools.length).toBe(1);
      const pool = response.route[0].pools[0];
      expect(pool.type).toBe('v4-pool');
      expect(pool.tickSpacing).toBe('10');
      // amountIn was already set (real was first) = quote.amount (computed input for ExactOut)
      expect(pool.amountIn).toBe('1234567890');
      // amountOut re-assigned by bug fix to quoteAmountsIn[0] = request amount
      expect(pool.amountOut).toBe('1000000000000000000');
    });
  });

  describe('formatPriceImpact', () => {
    it('should return "0" when priceImpact is undefined', async () => {
      const request = create(QuoteRequestSchema, {
        ...baseRequest,
        tradeType: 'EXACT_IN',
      });

      // Create a quote without swapInfo (priceImpact will be undefined)
      const singleQuote = new QuoteSplit([
        new QuoteBasic(
          new RouteBasic(Protocol.V2, [
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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      const response = await uniRouteBL.quote(ctx, request);

      expect(response.priceImpact).equals('0');
    });

    it('should return the value as string when priceImpact is within -100 to 100', async () => {
      const request = create(QuoteRequestSchema, {
        ...baseRequest,
        tradeType: 'EXACT_IN',
      });

      // Create a quote with swapInfo that has priceImpact = 5.5
      const singleQuote = new QuoteSplit(
        [
          new QuoteBasic(
            new RouteBasic(Protocol.V2, [
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
          create(MethodParametersSchema, {
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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      const response = await uniRouteBL.quote(ctx, request);

      expect(response.priceImpact).equals('5.5');
    });

    it('should clamp priceImpact to 100 when value exceeds 100', async () => {
      const request = create(QuoteRequestSchema, {
        ...baseRequest,
        tradeType: 'EXACT_IN',
      });

      // Create a quote with swapInfo that has priceImpact = 150 (exceeds 100)
      const singleQuote = new QuoteSplit(
        [
          new QuoteBasic(
            new RouteBasic(Protocol.V2, [
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
          create(MethodParametersSchema, {
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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      const response = await uniRouteBL.quote(ctx, request);

      expect(response.priceImpact).equals('100');
    });

    it('should clamp priceImpact to -100 when value is less than -100', async () => {
      const request = create(QuoteRequestSchema, {
        ...baseRequest,
        tradeType: 'EXACT_IN',
      });

      // Create a quote with swapInfo that has priceImpact = -150 (less than -100)
      const singleQuote = new QuoteSplit(
        [
          new QuoteBasic(
            new RouteBasic(Protocol.V2, [
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
          create(MethodParametersSchema, {
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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      const response = await uniRouteBL.quote(ctx, request);

      expect(response.priceImpact).equals('-100');
    });

    it('should handle edge cases: exactly 100, exactly -100, and 0', async () => {
      const request = create(QuoteRequestSchema, {
        ...baseRequest,
        tradeType: 'EXACT_IN',
      });

      // Test exactly 100
      const quoteAt100 = new QuoteSplit(
        [
          new QuoteBasic(
            new RouteBasic(Protocol.V2, [
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
          create(MethodParametersSchema, {
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
        noRouteCacheRepository,
        mockedQuoteStrategyAt100,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      const responseAt100 = await uniRouteBL.quote(ctx, request);
      expect(responseAt100.priceImpact).equals('100');

      // Test exactly -100
      const quoteAtNeg100 = new QuoteSplit(
        [
          new QuoteBasic(
            new RouteBasic(Protocol.V2, [
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
          create(MethodParametersSchema, {
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
        noRouteCacheRepository,
        mockedQuoteStrategyAtNeg100,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      const responseAtNeg100 = await uniRouteBLNeg100.quote(ctx, request);
      expect(responseAtNeg100.priceImpact).equals('-100');

      // Test exactly 0
      const quoteAt0 = new QuoteSplit(
        [
          new QuoteBasic(
            new RouteBasic(Protocol.V2, [
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
          create(MethodParametersSchema, {
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
        noRouteCacheRepository,
        mockedQuoteStrategyAt0,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      const responseAt0 = await uniRouteBL0.quote(ctx, request);
      expect(responseAt0.priceImpact).equals('0');
    });

    it('should handle priceImpact calculation errors gracefully and default to 0', async () => {
      const request = create(QuoteRequestSchema, {
        ...baseRequest,
        tradeType: 'EXACT_IN',
        simulateFromAddress: '0x1234567890123456789012345678901234567890',
        recipient: '0x1234567890123456789012345678901234567890',
        slippageTolerance: 20,
      });

      // Create a quote that will be used for building the trade
      const singleQuote = new QuoteSplit([
        new QuoteBasic(
          new RouteBasic(Protocol.V2, [
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
          const estimatedGasUsedInUSD = quoteSplit.quotes.reduce(
            (sum, q) => sum + (q.gasDetails?.gasCostInUSD ?? 0),
            0
          );

          return new QuoteSplit(
            quoteSplit.quotes,
            quoteSplit.swapInfo,
            {
              estimatedGasUsed: estimatedGasUsed,
              estimatedGasUsedInQuoteToken: gasCostInQuoteToken,
              estimatedGasUsedInUSD: estimatedGasUsedInUSD,
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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        preservingSimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
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

  describe('gas estimation', () => {
    it('should not call updateQuotesGasDetails when GasEstimation is disabled', async () => {
      const request = create(QuoteRequestSchema, {
        ...baseRequest,
        tradeType: 'EXACT_IN',
      });

      const updateGasSpy = vi.fn().mockResolvedValue(undefined);
      const gasConverter: IGasConverter = {
        updateQuotesGasDetails: updateGasSpy,
        updateQuoteBasicsGasDetails: vi.fn().mockResolvedValue(undefined),
      };

      // Config with GasEstimation disabled
      const gasDisabledConfig = {
        ...serviceConfig,
        GasEstimation: {Enabled: false},
      };

      const mockedQuoteStrategy = new MockedQuoteStrategy();
      const uniRouteBL = new UniRouteBL(
        gasDisabledConfig,
        redisCache,
        chainRepository,
        poolDiscoverer,
        freshPoolDetailsWrapper,
        tokenHandler,
        quoteFetcher,
        quoteSelector,
        routeQuoteAllocator,
        gasEstimateProvider,
        gasConverter,
        routeRepository,
        cachedRoutesRepository,
        noRouteCacheRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      await uniRouteBL.quote(ctx, request);

      expect(updateGasSpy).not.toHaveBeenCalled();
    });
  });

  describe('sync cache miss reduced config', () => {
    const cacheMissOverrides = getUniRouteSyncCacheMissRouteFinderOverrides();

    // Request with a subset of protocols (not all) to trigger reduced config
    const partialProtocolsRequest = {
      ...baseRequest,
      protocols: 'v2,v3',
      tradeType: 'EXACT_IN',
    };

    function expectReducedConfig(passedConfig: IUniRouteServiceConfig): void {
      expect(passedConfig.RouteFinder.MaxRoutes).toBe(
        cacheMissOverrides.MaxRoutes
      );
      expect(passedConfig.RouteFinder.MaxSplits).toBe(
        cacheMissOverrides.MaxSplits
      );
      expect(passedConfig.RouteFinder.RouteSplitPercentage).toBe(
        cacheMissOverrides.RouteSplitPercentage
      );
      expect(passedConfig.RouteFinder.RouteSplitTimeoutMs).toBe(
        cacheMissOverrides.RouteSplitTimeoutMs
      );
      expect(passedConfig.RouteFinder.MaxSplitRoutes).toBe(
        cacheMissOverrides.MaxSplitRoutes
      );
    }

    function expectOriginalConfig(
      passedConfig: IUniRouteServiceConfig,
      expectedConfig: IUniRouteServiceConfig
    ): void {
      expect(passedConfig.RouteFinder.MaxRoutes).toBe(
        expectedConfig.RouteFinder.MaxRoutes
      );
      expect(passedConfig.RouteFinder.MaxSplits).toBe(
        expectedConfig.RouteFinder.MaxSplits
      );
      expect(passedConfig.RouteFinder.RouteSplitPercentage).toBe(
        expectedConfig.RouteFinder.RouteSplitPercentage
      );
      expect(passedConfig.RouteFinder.RouteSplitTimeoutMs).toBe(
        expectedConfig.RouteFinder.RouteSplitTimeoutMs
      );
      expect(passedConfig.RouteFinder.MaxSplitRoutes).toBe(
        expectedConfig.RouteFinder.MaxSplitRoutes
      );
    }

    it('should use reduced RouteFinder config on sync cache miss with partial protocols', async () => {
      const request = create(QuoteRequestSchema, partialProtocolsRequest);

      const mockedQuoteStrategy = new MockedQuoteStrategy();
      const strategySpy = vi.spyOn(
        mockedQuoteStrategy,
        'findBestQuoteCandidates'
      );

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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      const response = await uniRouteBL.quote(ctx, request);
      expect(response.hitsCachedRoutes).toBe(false);

      expect(strategySpy).toHaveBeenCalledTimes(1);
      expectReducedConfig(strategySpy.mock.calls[0][7]);
    });

    it('should use original RouteFinder config on sync cache miss with all protocols', async () => {
      // baseRequest already has protocols: 'v2,v3,v4,mixed' (all protocols)
      const request = create(QuoteRequestSchema, {
        ...baseRequest,
        tradeType: 'EXACT_IN',
      });

      const mockedQuoteStrategy = new MockedQuoteStrategy();
      const strategySpy = vi.spyOn(
        mockedQuoteStrategy,
        'findBestQuoteCandidates'
      );

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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      // Sync + cache miss + all protocols = should NOT use reduced config
      const response = await uniRouteBL.quote(ctx, request);
      expect(response.hitsCachedRoutes).toBe(false);

      expect(strategySpy).toHaveBeenCalledTimes(1);
      expectOriginalConfig(strategySpy.mock.calls[0][7], serviceConfig);
    });

    it('should use original RouteFinder config on sync cache miss when all uniswap protocols are present alongside external protocols', async () => {
      // Full uniswap-native set + external protocols (e.g. CurveStableSwap) — the agg-hooks shadow shape.
      // Should NOT trigger the reduced config: with all uniswap natives available, the
      // search space is rich enough to warrant the full RouteFinder budget.
      const request = create(QuoteRequestSchema, {
        ...baseRequest,
        protocols: 'v2,v3,v4,mixed,CurveStableSwap',
        tradeType: 'EXACT_IN',
      });

      const mockedQuoteStrategy = new MockedQuoteStrategy();
      const strategySpy = vi.spyOn(
        mockedQuoteStrategy,
        'findBestQuoteCandidates'
      );

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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      const response = await uniRouteBL.quote(ctx, request);
      expect(response.hitsCachedRoutes).toBe(false);

      expect(strategySpy).toHaveBeenCalledTimes(1);
      expectOriginalConfig(strategySpy.mock.calls[0][7], serviceConfig);
    });

    it('should use original RouteFinder config on sync cache hit', async () => {
      const request = create(QuoteRequestSchema, {
        ...baseRequest,
        tradeType: 'EXACT_IN',
      });

      const mockedQuoteStrategy = new MockedQuoteStrategy();

      // First, populate cache via async call
      const asyncBL = new UniRouteBL(
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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );
      await asyncBL.quote(ctx, request);

      // Now sync should get a cache hit
      const strategySpy = vi.spyOn(
        mockedQuoteStrategy,
        'findBestQuoteCandidates'
      );

      const syncBL = new UniRouteBL(
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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      const response = await syncBL.quote(ctx, request);
      expect(response.hitsCachedRoutes).toBe(true);

      expect(strategySpy).toHaveBeenCalledTimes(1);
      expectOriginalConfig(strategySpy.mock.calls[0][7], serviceConfig);
    });

    it('should use original RouteFinder config on async cache miss with partial protocols', async () => {
      const request = create(QuoteRequestSchema, partialProtocolsRequest);

      const mockedQuoteStrategy = new MockedQuoteStrategy();
      const strategySpy = vi.spyOn(
        mockedQuoteStrategy,
        'findBestQuoteCandidates'
      );

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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      // Async + cache miss should NOT use reduced config even with partial protocols
      const response = await uniRouteBL.quote(ctx, request);
      expect(response.hitsCachedRoutes).toBe(false);

      expect(strategySpy).toHaveBeenCalledTimes(1);
      expectOriginalConfig(strategySpy.mock.calls[0][7], serviceConfigAsync);
    });

    it('should not apply reduced config for quickroute service', async () => {
      const quickRouteConfig: IUniRouteServiceConfig = {
        ...serviceConfig,
        QuoteService: QuoteService.QuickRoute,
      };

      const request = create(QuoteRequestSchema, partialProtocolsRequest);

      const mockedQuoteStrategy = new MockedQuoteStrategy();
      const strategySpy = vi.spyOn(
        mockedQuoteStrategy,
        'findBestQuoteCandidates'
      );

      const uniRouteBL = new UniRouteBL(
        quickRouteConfig,
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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      // QuickRoute sync + cache miss + partial protocols should NOT use reduced config
      const response = await uniRouteBL.quote(ctx, request);
      expect(response.hitsCachedRoutes).toBe(false);

      expect(strategySpy).toHaveBeenCalledTimes(1);
      expectOriginalConfig(strategySpy.mock.calls[0][7], quickRouteConfig);
    });
  });

  describe('request priorityFeePerGasWei', () => {
    // Names every parameter, so a parameter added before the tip changes the
    // type at its position and fails to compile instead of shifting an index.
    class TipRecordingQuoteStrategy extends MockedQuoteStrategy {
      public readonly receivedTips: (bigint | undefined)[] = [];

      override async findBestQuoteCandidates(
        ctx: Context,
        chain: Chain,
        tokenInCurrencyInfo: CurrencyInfo,
        tokenOutCurrencyInfo: CurrencyInfo,
        amount: bigint,
        tradeType: TradeType,
        protocols: Protocol[],
        serviceConfig: IUniRouteServiceConfig,
        routes: RouteBasic<Pool>[],
        tokensInfo: Map<string, Erc20Token | null>,
        metricTags: string[],
        _blockNumber?: number,
        _testAggHooks?: boolean,
        _supplementalHookCodeOverrides?: Readonly<Record<string, string>>,
        priorityFeePerGasWei?: bigint
      ): Promise<QuoteSplit[]> {
        this.receivedTips.push(priorityFeePerGasWei);
        return super.findBestQuoteCandidates(
          ctx,
          chain,
          tokenInCurrencyInfo,
          tokenOutCurrencyInfo,
          amount,
          tradeType,
          protocols,
          serviceConfig,
          routes,
          tokensInfo,
          metricTags
        );
      }
    }

    async function quoteFromJson(requestJson: Record<string, unknown>) {
      const strategy = new TipRecordingQuoteStrategy();
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
        noRouteCacheRepository,
        strategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );
      // Decoded the way the HTTP handler decodes a TAPI request body.
      const response = await uniRouteBL.quote(
        ctx,
        fromJson(
          QuoteRequestSchema,
          {...baseRequest, tradeType: 'EXACT_IN', ...requestJson},
          {ignoreUnknownFields: true}
        )
      );
      return {response, receivedTips: strategy.receivedTips};
    }

    it('passes the JSON request tip to the quote strategy as wei', async () => {
      const {response, receivedTips} = await quoteFromJson({
        priorityFeePerGasWei: '2050000000',
      });

      expect(response.error).toBeUndefined();
      expect(receivedTips).toEqual([2_050_000_000n]);
    });

    it('passes no tip when the request omits the field', async () => {
      const {receivedTips} = await quoteFromJson({});

      expect(receivedTips).toEqual([undefined]);
    });

    it('rejects a malformed tip with a 400 before routing', async () => {
      const {response, receivedTips} = await quoteFromJson({
        priorityFeePerGasWei: '2.05 gwei',
      });

      expect(response.error?.code).toBe(400);
      expect(quoteErrorReasonOf(response.error)).toBe(
        QuoteErrorReason.PRIORITY_FEE_INVALID
      );
      expect(receivedTips).toEqual([]);
    });
  });

  describe('request maxRoutingTimeMs budget', () => {
    // Returns the RouteFinder config the strategy was invoked with.
    async function routeFinderConfigForRequest(
      requestOverrides: Record<string, unknown>,
      config: IUniRouteServiceConfig = serviceConfig
    ): Promise<IUniRouteServiceConfig['RouteFinder']> {
      const request = create(QuoteRequestSchema, {
        ...baseRequest,
        tradeType: 'EXACT_IN',
        ...requestOverrides,
      });

      const mockedQuoteStrategy = new MockedQuoteStrategy();
      const strategySpy = vi.spyOn(
        mockedQuoteStrategy,
        'findBestQuoteCandidates'
      );

      const uniRouteBL = new UniRouteBL(
        config,
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
        noRouteCacheRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      await uniRouteBL.quote(ctx, request);
      expect(strategySpy).toHaveBeenCalledTimes(1);
      return strategySpy.mock.calls[0][7].RouteFinder;
    }

    it('caps the sync split-search budget at the request maxRoutingTimeMs', async () => {
      const routeFinder = await routeFinderConfigForRequest({
        maxRoutingTimeMs: 300,
      });
      expect(routeFinder.RouteSplitTimeoutMs).toBe(300);
      // Cap-only: everything else keeps the service config values.
      expect(routeFinder.MaxRoutes).toBe(serviceConfig.RouteFinder.MaxRoutes);
      expect(routeFinder.MaxSplits).toBe(serviceConfig.RouteFinder.MaxSplits);
    });

    it('never raises the budget above the configured timeout', async () => {
      const routeFinder = await routeFinderConfigForRequest({
        maxRoutingTimeMs:
          serviceConfig.RouteFinder.RouteSplitTimeoutMs + 10_000,
      });
      expect(routeFinder.RouteSplitTimeoutMs).toBe(
        serviceConfig.RouteFinder.RouteSplitTimeoutMs
      );
    });

    it('leaves the config unchanged when maxRoutingTimeMs is unset', async () => {
      const routeFinder = await routeFinderConfigForRequest({});
      expect(routeFinder.RouteSplitTimeoutMs).toBe(
        serviceConfig.RouteFinder.RouteSplitTimeoutMs
      );
    });

    it('caps the reduced sync cache-miss config too', async () => {
      const cacheMissOverrides = getUniRouteSyncCacheMissRouteFinderOverrides();
      const routeFinder = await routeFinderConfigForRequest({
        protocols: 'v2,v3',
        maxRoutingTimeMs: 300,
      });
      expect(routeFinder.RouteSplitTimeoutMs).toBe(300);
      expect(routeFinder.MaxRoutes).toBe(cacheMissOverrides.MaxRoutes);
    });

    it('ignores a budget below the floor', async () => {
      const routeFinder = await routeFinderConfigForRequest({
        maxRoutingTimeMs: MIN_REQUEST_ROUTING_TIME_BUDGET_MS - 1,
      });
      expect(routeFinder.RouteSplitTimeoutMs).toBe(
        serviceConfig.RouteFinder.RouteSplitTimeoutMs
      );
    });

    it('applies a budget at the floor', async () => {
      const routeFinder = await routeFinderConfigForRequest({
        maxRoutingTimeMs: MIN_REQUEST_ROUTING_TIME_BUDGET_MS,
      });
      expect(routeFinder.RouteSplitTimeoutMs).toBe(
        MIN_REQUEST_ROUTING_TIME_BUDGET_MS
      );
    });

    it('ignores the budget for a quickroute deployment', async () => {
      // Same gating as selectEffectiveConfig: RouteFinder overrides are
      // UniRoute-only semantics.
      const routeFinder = await routeFinderConfigForRequest(
        {maxRoutingTimeMs: 300},
        {...serviceConfig, QuoteService: QuoteService.QuickRoute}
      );
      expect(routeFinder.RouteSplitTimeoutMs).toBe(
        serviceConfig.RouteFinder.RouteSplitTimeoutMs
      );
    });

    it('ignores the budget on the async deep-search path', async () => {
      // The async deep search populates the shared route cache, so it keeps
      // its full budget even if a caller budget reaches it.
      const routeFinder = await routeFinderConfigForRequest(
        {maxRoutingTimeMs: 300},
        serviceConfigAsync
      );
      expect(routeFinder.RouteSplitTimeoutMs).toBe(
        serviceConfigAsync.RouteFinder.RouteSplitTimeoutMs
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // BestQuote agg-hook pool leak detection
  //
  // UniRouteBL checks every quote in bestQuote.quotes for V4 pools whose hooks
  // address is in AGG_HOOKS_PER_CHAIN.  When a leak is detected it must:
  //   • log a warning
  //   • emit UniRouteService.Metric.BestQuote.AggHookPoolLeak
  //   • tag the metric with hitsCachedRoutes:<bool>
  // ─────────────────────────────────────────────────────────────────────────
  describe('BestQuote agg-hook pool leak detection', () => {
    // The address mocked in AGG_HOOKS_PER_CHAIN above.
    const MAINNET_AGG_HOOK = '0xaaaa000000000000000000000000000000000001';
    const LEAK_METRIC = 'UniRouteService.Metric.BestQuote.AggHookPoolLeak';

    /** Build a QuoteSplit whose single leg goes through an agg-hook V4 pool. */
    function makeAggHookQuote(tokenIn: Address, tokenOut: Address): QuoteSplit {
      const aggHookPool = new V4Pool(
        tokenIn,
        tokenOut,
        3000,
        60,
        MAINNET_AGG_HOOK,
        BigInt('1000000000000'),
        '0x' + 'ab'.repeat(20), // fake poolId (bytes32-like)
        BigInt('1000000000000000000'),
        BigInt('0')
      );
      return new QuoteSplit([
        new QuoteBasic(
          new RouteBasic(Protocol.V4, [aggHookPool]),
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
    }

    /**
     * A fake ICachedRoutesRepository whose readCachedRoutes returns one
     * dummy route, making usedCachedRoutes = true in UniRouteBL.
     */
    class FakeCachedRoutesRepositoryWithHit implements ICachedRoutesRepository {
      constructCachedRouteKey(): string {
        return 'fake-key';
      }

      private buildDummyRoute(
        tokenInCurrencyInfo: CurrencyInfo,
        tokenOutCurrencyInfo: CurrencyInfo
      ): RouteBasic {
        return new RouteBasic(Protocol.V2, [
          new V2Pool(
            tokenInCurrencyInfo.wrappedAddress,
            tokenOutCurrencyInfo.wrappedAddress,
            new Address('0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640'),
            BigInt('1000000000000'),
            BigInt('1000000000000')
          ),
        ]);
      }

      async readCachedRoutes(
        _nsCtx: RouteNamespaceContext,
        _chainId: number,
        tokenInCurrencyInfo: CurrencyInfo,
        tokenOutCurrencyInfo: CurrencyInfo
      ): Promise<CachedRoutesReadResult> {
        const route = this.buildDummyRoute(
          tokenInCurrencyInfo,
          tokenOutCurrencyInfo
        );
        return {
          perKeyReads: [
            {
              cachedRouteKey: 'fake-key',
              tokenInAddress: tokenInCurrencyInfo.wrappedAddress,
              tokenOutAddress: tokenOutCurrencyInfo.wrappedAddress,
              rawCachedRoutes: [],
              expiredRawRouteCount: 0,
              candidateRouteCount: 1,
              aggHookExcludedCount: 0,
              staticFeeCapExcludedCount: 0,
              denylistedHookExcludedCount: 0,
              unadmittedHookExcludedCount: 0,
              validRoutes: [{route, expiresAtMs: Date.now() + 60_000}],
            },
          ],
          totalValidRouteCount: 1,
        };
      }

      async readCachedRoutesAtBucket(
        nsCtx: RouteNamespaceContext,
        chainId: number,
        tokenInCurrencyInfo: CurrencyInfo,
        tokenOutCurrencyInfo: CurrencyInfo
      ): Promise<CachedRoutesReadResult> {
        return this.readCachedRoutes(
          nsCtx,
          chainId,
          tokenInCurrencyInfo,
          tokenOutCurrencyInfo
        );
      }

      async processCachedRoutesResult(
        readResult: CachedRoutesReadResult,
        _nsCtx: RouteNamespaceContext,
        _chainId: number,
        _tradeType: TradeType,
        _amountIn: bigint,
        _usdBucket: UsdBucket,
        _quoteType: QuoteType,
        _protocols: Protocol[],
        _request: QuoteRequest,
        _ctx: Context,
        _quoteOptions?: QuoteOptions
      ): Promise<RouteBasic[]> {
        return readResult.perKeyReads.flatMap(p =>
          p.validRoutes.map(v => v.route)
        );
      }

      async maybeEnqueueAsyncRefresh(): Promise<void> {}

      async saveCachedRoutes(): Promise<void> {}

      async setNoRouteRefreshCooldown(): Promise<void> {}

      async deletePendingRefresh(): Promise<void> {}

      async deleteCachedRoutes(): Promise<boolean> {
        return false;
      }

      async scoreFetchedRoutes(
        routes: {route: RouteBasic; expiresAtMs: number}[]
      ): Promise<{route: RouteBasic; score: number}[]> {
        return routes.map(r => ({route: r.route, score: 1}));
      }
    }

    it('emits metric and logs warning when best quote contains an agg-hook V4 pool for native protocols', async () => {
      const testCtx = buildTestContext();

      const tokenIn = new Address('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2');
      const tokenOut = new Address(
        '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
      );
      const aggHookQuote = makeAggHookQuote(tokenIn, tokenOut);

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
        noRouteCacheRepository,
        new MockedQuoteStrategy(aggHookQuote),
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      await uniRouteBL.quote(
        testCtx,
        create(QuoteRequestSchema, {...baseRequest, tradeType: 'EXACT_IN'})
      );

      expect(testCtx.metrics.countStore[LEAK_METRIC]).toBe(1);
      expect(testCtx.logger.outputs).toContainEqual(
        expect.objectContaining({
          prefix: 'WARN:',
          msg: 'Best quote route contains unexpected agg hook pool',
        })
      );
    });

    it('does not emit metric when best quote has no agg-hook pool', async () => {
      const testCtx = buildTestContext();

      // Default MockedQuoteStrategy returns a plain V2 route.
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
        noRouteCacheRepository,
        new MockedQuoteStrategy(),
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      await uniRouteBL.quote(
        testCtx,
        create(QuoteRequestSchema, {...baseRequest, tradeType: 'EXACT_IN'})
      );

      expect(testCtx.metrics.countStore[LEAK_METRIC]).toBeUndefined();
    });

    it('tags metric with hitsCachedRoutes:true when leak comes from a stale cached route', async () => {
      const testCtx = buildTestContext();
      const countSpy = vi.spyOn(testCtx.metrics, 'count');

      const tokenIn = new Address('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2');
      const tokenOut = new Address(
        '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
      );
      const aggHookQuote = makeAggHookQuote(tokenIn, tokenOut);

      // Use the fake repo that returns cached routes (usedCachedRoutes → true)
      // while the strategy still returns the agg-hook quote.
      const fakeRepo = new FakeCachedRoutesRepositoryWithHit();
      const cacheOnlyConfig: IUniRouteServiceConfig = {
        ...serviceConfig,
        CachedRoutes: {
          ...serviceConfig.CachedRoutes,
          HitDiscoveryEnabled: false,
        },
      };
      const uniRouteBL = new UniRouteBL(
        cacheOnlyConfig,
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
        fakeRepo,
        noRouteCacheRepository,
        new MockedQuoteStrategy(aggHookQuote),
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      await uniRouteBL.quote(
        testCtx,
        create(QuoteRequestSchema, {...baseRequest, tradeType: 'EXACT_IN'})
      );

      const leakCall = countSpy.mock.calls.find(
        ([metricName]) => metricName === LEAK_METRIC
      );
      expect(leakCall).toBeDefined();
      expect(leakCall?.[2]?.tags).toContain('hitsCachedRoutes:true');
    });

    it('tags metric with hitsCachedRoutes:false when leak comes from live routing', async () => {
      const testCtx = buildTestContext();
      const countSpy = vi.spyOn(testCtx.metrics, 'count');

      const tokenIn = new Address('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2');
      const tokenOut = new Address(
        '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
      );
      const aggHookQuote = makeAggHookQuote(tokenIn, tokenOut);

      // Empty cache → usedCachedRoutes = false.
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
        noRouteCacheRepository,
        new MockedQuoteStrategy(aggHookQuote),
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      await uniRouteBL.quote(
        testCtx,
        create(QuoteRequestSchema, {...baseRequest, tradeType: 'EXACT_IN'})
      );

      const leakCall = countSpy.mock.calls.find(
        ([metricName]) => metricName === LEAK_METRIC
      );
      expect(leakCall).toBeDefined();
      expect(leakCall?.[2]?.tags).toContain('hitsCachedRoutes:false');
    });

    it('tags metric and log with testAggHooks:true when options.testAggHooks is true', async () => {
      const testCtx = buildTestContext();
      const countSpy = vi.spyOn(testCtx.metrics, 'count');
      const warnSpy = vi.spyOn(testCtx.logger, 'warn');

      const tokenIn = new Address('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2');
      const tokenOut = new Address(
        '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
      );
      const aggHookQuote = makeAggHookQuote(tokenIn, tokenOut);

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
        noRouteCacheRepository,
        new MockedQuoteStrategy(aggHookQuote),
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      await uniRouteBL.quote(
        testCtx,
        create(QuoteRequestSchema, {...baseRequest, tradeType: 'EXACT_IN'}),
        {testAggHooks: true}
      );

      const leakCall = countSpy.mock.calls.find(
        ([metricName]) => metricName === LEAK_METRIC
      );
      expect(leakCall).toBeDefined();
      expect(leakCall?.[2]?.tags).toContain('testAggHooks:true');

      const warnCall = warnSpy.mock.calls.find(
        ([msg]) => msg === 'Best quote route contains unexpected agg hook pool'
      );
      expect(warnCall).toBeDefined();
      expect(warnCall?.[1]).toMatchObject({testAggHooks: true});
    });

    it('tags metric and log with testAggHooks:false when options.testAggHooks is false', async () => {
      const testCtx = buildTestContext();
      const countSpy = vi.spyOn(testCtx.metrics, 'count');
      const warnSpy = vi.spyOn(testCtx.logger, 'warn');

      const tokenIn = new Address('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2');
      const tokenOut = new Address(
        '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
      );
      const aggHookQuote = makeAggHookQuote(tokenIn, tokenOut);

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
        noRouteCacheRepository,
        new MockedQuoteStrategy(aggHookQuote),
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      await uniRouteBL.quote(
        testCtx,
        create(QuoteRequestSchema, {...baseRequest, tradeType: 'EXACT_IN'}),
        {testAggHooks: false}
      );

      const leakCall = countSpy.mock.calls.find(
        ([metricName]) => metricName === LEAK_METRIC
      );
      expect(leakCall).toBeDefined();
      expect(leakCall?.[2]?.tags).toContain('testAggHooks:false');

      const warnCall = warnSpy.mock.calls.find(
        ([msg]) => msg === 'Best quote route contains unexpected agg hook pool'
      );
      expect(warnCall).toBeDefined();
      expect(warnCall?.[1]).toMatchObject({testAggHooks: false});
    });

    it('tags metric and log with testAggHooks:undefined when options is not provided', async () => {
      const testCtx = buildTestContext();
      const countSpy = vi.spyOn(testCtx.metrics, 'count');
      const warnSpy = vi.spyOn(testCtx.logger, 'warn');

      const tokenIn = new Address('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2');
      const tokenOut = new Address(
        '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
      );
      const aggHookQuote = makeAggHookQuote(tokenIn, tokenOut);

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
        noRouteCacheRepository,
        new MockedQuoteStrategy(aggHookQuote),
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      await uniRouteBL.quote(
        testCtx,
        create(QuoteRequestSchema, {...baseRequest, tradeType: 'EXACT_IN'})
        // no options passed
      );

      const leakCall = countSpy.mock.calls.find(
        ([metricName]) => metricName === LEAK_METRIC
      );
      expect(leakCall).toBeDefined();
      expect(leakCall?.[2]?.tags).toContain('testAggHooks:undefined');

      const warnCall = warnSpy.mock.calls.find(
        ([msg]) => msg === 'Best quote route contains unexpected agg hook pool'
      );
      expect(warnCall).toBeDefined();
      expect(warnCall?.[1]).toMatchObject({testAggHooks: undefined});
    });

    it('emits AggHookPoolLeak for external protocol without testAggHooks', async () => {
      const testCtx = buildTestContext();
      const countSpy = vi.spyOn(testCtx.metrics, 'count');
      const warnSpy = vi.spyOn(testCtx.logger, 'warn');

      const tokenIn = new Address('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2');
      const tokenOut = new Address(
        '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
      );
      const aggHookQuote = makeAggHookQuote(tokenIn, tokenOut);

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
        noRouteCacheRepository,
        new MockedQuoteStrategy(aggHookQuote),
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      // External protocol without testAggHooks — treated as unexpected.
      await uniRouteBL.quote(
        testCtx,
        create(QuoteRequestSchema, {
          ...baseRequest,
          tradeType: 'EXACT_IN',
          protocols: Protocol.CURVESTABLESWAPNG,
        })
      );

      const leakCall = countSpy.mock.calls.find(
        ([metricName]) => metricName === LEAK_METRIC
      );
      expect(leakCall).toBeDefined();
      expect(leakCall?.[2]?.tags).toContain('testAggHooks:undefined');

      const warnCall = warnSpy.mock.calls.find(
        ([msg]) => msg === 'Best quote route contains unexpected agg hook pool'
      );
      expect(warnCall).toBeDefined();
    });

    it('emits AggHookPoolExpected (not Leak, no warn) for external protocol with testAggHooks=true', async () => {
      const EXPECTED_METRIC =
        'UniRouteService.Metric.BestQuote.AggHookPoolExpected';
      const testCtx = buildTestContext();
      const countSpy = vi.spyOn(testCtx.metrics, 'count');
      const warnSpy = vi.spyOn(testCtx.logger, 'warn');

      const tokenIn = new Address('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2');
      const tokenOut = new Address(
        '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
      );
      const aggHookQuote = makeAggHookQuote(tokenIn, tokenOut);

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
        noRouteCacheRepository,
        new MockedQuoteStrategy(aggHookQuote),
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      // External protocol + testAggHooks=true — this is the expected path.
      await uniRouteBL.quote(
        testCtx,
        create(QuoteRequestSchema, {
          ...baseRequest,
          tradeType: 'EXACT_IN',
          protocols: Protocol.CURVESTABLESWAPNG,
        }),
        {testAggHooks: true}
      );

      const expectedCall = countSpy.mock.calls.find(
        ([metricName]) => metricName === EXPECTED_METRIC
      );
      expect(expectedCall).toBeDefined();
      expect(expectedCall?.[2]?.tags).toContain('testAggHooks:true');

      const leakCall = countSpy.mock.calls.find(
        ([metricName]) => metricName === LEAK_METRIC
      );
      expect(leakCall).toBeUndefined();

      const warnCall = warnSpy.mock.calls.find(
        ([msg]) => msg === 'Best quote route contains unexpected agg hook pool'
      );
      expect(warnCall).toBeUndefined();
    });
  });

  describe('FOT token EXACT_OUT exclusion', () => {
    // tokenOut is a FOT token (USDC address lowercased for matching)
    const fotTokenOut = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    const fotHandler = new FotTokenHandler(
      new Set([fotTokenOut.toLowerCase()])
    );

    it('should return error for FOT token with EXACT_OUT trade type', async () => {
      const request = create(QuoteRequestSchema, {
        ...baseRequest,
        tradeType: 'EXACT_OUT',
      });

      const mockedQuoteStrategy = new MockedQuoteStrategy();
      const uniRouteBL = new UniRouteBL(
        serviceConfig,
        redisCache,
        chainRepository,
        poolDiscoverer,
        freshPoolDetailsWrapper,
        fotHandler,
        quoteFetcher,
        quoteSelector,
        routeQuoteAllocator,
        gasEstimateProvider,
        noGasConverter,
        routeRepository,
        cachedRoutesRepository,
        noRouteCacheRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      const response = await uniRouteBL.quote(ctx, request);
      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(400);
      expect(response.error!.message).toContain('FOT');
      expect(response.error!.message).toContain('EXACT_OUT');
    });

    it('should still return a quote for FOT token with EXACT_IN trade type', async () => {
      const request = create(QuoteRequestSchema, {
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
        fotHandler,
        quoteFetcher,
        quoteSelector,
        routeQuoteAllocator,
        gasEstimateProvider,
        noGasConverter,
        routeRepository,
        cachedRoutesRepository,
        noRouteCacheRepository,
        mockedQuoteStrategy,
        dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );

      const response = await uniRouteBL.quote(ctx, request);
      // EXACT_IN with FOT should succeed (not error)
      expect(response.error).toBeUndefined();
    });

    describe('intermediary FOT tokens', () => {
      // OCTAA on Monad: a 10% FOT token that UniRoute routed through on an
      // EXACT_IN WMON -> OCTAA -> USDC quote, producing an unreachable minimum.
      // Checksummed here while the token handler keys on lowercase, so a
      // casing mismatch in the filter fails these tests.
      const intermediaryFotToken = '0xBB848dAC056e385d2f7c750eC839157dccf4cfF3';
      const fotHandlerWithIntermediary = new FotTokenHandler(
        new Set([intermediaryFotToken.toLowerCase()])
      );
      const fotFilteredMetric = buildMetricKey('FotIntermediaryRoutesFiltered');
      const directPoolAddress = '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640';

      const directRoute = (
        tokenInCurrencyInfo: CurrencyInfo,
        tokenOutCurrencyInfo: CurrencyInfo
      ): RouteBasic =>
        new RouteBasic(Protocol.V2, [
          new V2Pool(
            tokenInCurrencyInfo.wrappedAddress,
            tokenOutCurrencyInfo.wrappedAddress,
            new Address(directPoolAddress),
            BigInt('1000000000000'),
            BigInt('1000000000000')
          ),
        ]);

      const fotIntermediaryRoute = (
        tokenInCurrencyInfo: CurrencyInfo,
        tokenOutCurrencyInfo: CurrencyInfo
      ): RouteBasic =>
        new RouteBasic(Protocol.V2, [
          new V2Pool(
            tokenInCurrencyInfo.wrappedAddress,
            new Address(intermediaryFotToken),
            new Address('0x2222222222222222222222222222222222222222'),
            BigInt('1000000000000'),
            BigInt('1000000000000')
          ),
          new V2Pool(
            new Address(intermediaryFotToken),
            tokenOutCurrencyInfo.wrappedAddress,
            new Address('0x3333333333333333333333333333333333333333'),
            BigInt('1000000000000'),
            BigInt('1000000000000')
          ),
        ]);

      class FotIntermediaryRoutesRepository extends TestRoutesRepository {
        constructor(private readonly includeDirectRoute: boolean) {
          super();
        }

        public async getRoutes(
          chain: Chain,
          tokenInCurrencyInfo: CurrencyInfo,
          tokenOutCurrencyInfo: CurrencyInfo
        ): Promise<RouteDiscoveryResult> {
          const fotRoute = fotIntermediaryRoute(
            tokenInCurrencyInfo,
            tokenOutCurrencyInfo
          );
          return {
            routes: this.includeDirectRoute
              ? [
                  directRoute(tokenInCurrencyInfo, tokenOutCurrencyInfo),
                  fotRoute,
                ]
              : [fotRoute],
            degradedReasons: [],
          };
        }
      }

      class RecordingQuoteStrategy extends MockedQuoteStrategy {
        public readonly receivedRoutes: RouteBasic<Pool>[][] = [];

        async findBestQuoteCandidates(
          ctx: Context,
          chain: Chain,
          tokenInCurrencyInfo: CurrencyInfo,
          tokenOutCurrencyInfo: CurrencyInfo,
          amount: bigint,
          tradeType: TradeType,
          protocols: Protocol[],
          serviceConfig: IUniRouteServiceConfig,
          routes: RouteBasic<Pool>[],
          tokensInfo: Map<string, Erc20Token | null>,
          metricTags: string[]
        ): Promise<QuoteSplit[]> {
          this.receivedRoutes.push(routes);
          return super.findBestQuoteCandidates(
            ctx,
            chain,
            tokenInCurrencyInfo,
            tokenOutCurrencyInfo,
            amount,
            tradeType,
            protocols,
            serviceConfig,
            routes,
            tokensInfo,
            metricTags
          );
        }
      }

      const buildFotIntermediaryBL = (
        routesRepository: FotIntermediaryRoutesRepository,
        quoteStrategy: MockedQuoteStrategy
      ): UniRouteBL =>
        new UniRouteBL(
          serviceConfig,
          redisCache,
          chainRepository,
          poolDiscoverer,
          freshPoolDetailsWrapper,
          fotHandlerWithIntermediary,
          quoteFetcher,
          quoteSelector,
          routeQuoteAllocator,
          gasEstimateProvider,
          noGasConverter,
          routesRepository,
          cachedRoutesRepository,
          noRouteCacheRepository,
          quoteStrategy,
          dummySimulator,
          quoteRequestValidator,
          tokenProvider,
          mockedRpcProviderMap,
          stateOverrideResolver
        );

      it.each(['EXACT_IN', 'EXACT_OUT'])(
        'drops routes through an intermediary FOT token for %s',
        async tradeType => {
          const quoteStrategy = new RecordingQuoteStrategy();
          const testCtx = buildTestContext();

          const response = await buildFotIntermediaryBL(
            new FotIntermediaryRoutesRepository(true),
            quoteStrategy
          ).quote(
            testCtx,
            create(QuoteRequestSchema, {...baseRequest, tradeType})
          );

          expect(response.error).toBeUndefined();
          expect(quoteStrategy.receivedRoutes).toHaveLength(1);
          const servedRoutes = quoteStrategy.receivedRoutes[0];
          expect(servedRoutes).toHaveLength(1);
          expect(
            servedRoutes[0].path.map(pool => pool.address.toString())
          ).toEqual([directPoolAddress]);
          expect(testCtx.metrics.countStore[fotFilteredMetric]).toBe(1);
        }
      );

      it('hands the quote strategy no routes for EXACT_IN when every route passes through an intermediary FOT token', async () => {
        const quoteStrategy = new RecordingQuoteStrategy();
        const testCtx = buildTestContext();

        await buildFotIntermediaryBL(
          new FotIntermediaryRoutesRepository(false),
          quoteStrategy
        ).quote(
          testCtx,
          create(QuoteRequestSchema, {...baseRequest, tradeType: 'EXACT_IN'})
        );

        expect(quoteStrategy.receivedRoutes).toEqual([[]]);
        expect(testCtx.metrics.countStore[fotFilteredMetric]).toBe(1);
      });

      describe('intermediary pools refused by the pool transfer probe', () => {
        // The same routes, but the intermediary carries no per-token fee:
        // only the pool it is routed through refuses it, as BTCs' BTCB pair
        // does on BSC.
        const plainHandler = new FotTokenHandler(new Set());
        const refusingPool = new Address(
          '0x3333333333333333333333333333333333333333'
        );
        const poolFilteredMetric = buildMetricKey('FotPoolRoutesFiltered');

        class FakePoolTransferProbe implements IPoolTransferProbe {
          readonly requests: PoolProbeTarget[][] = [];
          constructor(
            private readonly chains: ReadonlySet<number>,
            private readonly answers: Map<string, TransferMeasurement>
          ) {}

          appliesTo(chainId: number): boolean {
            return this.chains.has(chainId);
          }

          async measurements(
            _chain: Chain,
            targets: readonly PoolProbeTarget[]
          ): Promise<Map<string, TransferMeasurement>> {
            this.requests.push([...targets]);
            return this.answers;
          }
        }

        const buildProbedBL = (
          probe: IPoolTransferProbe,
          quoteStrategy: MockedQuoteStrategy
        ): UniRouteBL =>
          new UniRouteBL(
            serviceConfig,
            redisCache,
            chainRepository,
            poolDiscoverer,
            freshPoolDetailsWrapper,
            plainHandler,
            quoteFetcher,
            quoteSelector,
            routeQuoteAllocator,
            gasEstimateProvider,
            noGasConverter,
            new FotIntermediaryRoutesRepository(true),
            cachedRoutesRepository,
            noRouteCacheRepository,
            quoteStrategy,
            dummySimulator,
            quoteRequestValidator,
            tokenProvider,
            mockedRpcProviderMap,
            stateOverrideResolver,
            undefined,
            probe
          );

        const clean = {verdict: 'clean' as const, lossBps: 0};
        // The route sends the intermediary INTO the refusing pool.
        const refusedBy = (
          verdict: TransferVerdict,
          direction: 'out' | 'into' = 'into'
        ): Map<string, TransferMeasurement> =>
          new Map([
            [
              poolProbeTargetKey(
                new Address(intermediaryFotToken),
                refusingPool
              ),
              {
                out: clean,
                into: clean,
                [direction]: {verdict, lossBps: 0},
              },
            ],
          ]);

        it.each(['fee', 'blocked'] as const)(
          'drops the route whose intermediary pool is %s',
          async verdict => {
            const probe = new FakePoolTransferProbe(
              new Set([ChainId.MAINNET]),
              refusedBy(verdict)
            );
            const quoteStrategy = new RecordingQuoteStrategy();
            const testCtx = buildTestContext();

            const response = await buildProbedBL(probe, quoteStrategy).quote(
              testCtx,
              create(QuoteRequestSchema, {
                ...baseRequest,
                tradeType: 'EXACT_IN',
              })
            );

            expect(response.error).toBeUndefined();
            expect(
              quoteStrategy.receivedRoutes[0].map(route =>
                route.path.map(pool => pool.address.toString())
              )
            ).toEqual([[directPoolAddress]]);
            expect(testCtx.metrics.countStore[poolFilteredMetric]).toBe(1);
            // Both hops of the intermediary route, holder by holder.
            expect(
              probe.requests[0].map(target => target.holder.lowerCased)
            ).toEqual([
              '0x2222222222222222222222222222222222222222',
              refusingPool.lowerCased,
            ]);
          }
        );

        it('keeps the route when the pool refuses only the direction the route does not use', async () => {
          const probe = new FakePoolTransferProbe(
            new Set([ChainId.MAINNET]),
            refusedBy('fee', 'out')
          );
          const quoteStrategy = new RecordingQuoteStrategy();

          await buildProbedBL(probe, quoteStrategy).quote(
            buildTestContext(),
            create(QuoteRequestSchema, {...baseRequest, tradeType: 'EXACT_IN'})
          );

          expect(quoteStrategy.receivedRoutes[0]).toHaveLength(2);
        });

        it('keeps every route when the probe has no verdict', async () => {
          const probe = new FakePoolTransferProbe(
            new Set([ChainId.MAINNET]),
            new Map()
          );
          const quoteStrategy = new RecordingQuoteStrategy();
          const testCtx = buildTestContext();

          await buildProbedBL(probe, quoteStrategy).quote(
            testCtx,
            create(QuoteRequestSchema, {...baseRequest, tradeType: 'EXACT_IN'})
          );

          expect(quoteStrategy.receivedRoutes[0]).toHaveLength(2);
          expect(
            testCtx.metrics.countStore[poolFilteredMetric]
          ).toBeUndefined();
        });

        it('does not consult the probe on a chain outside its selection', async () => {
          const probe = new FakePoolTransferProbe(
            new Set([ChainId.BNB]),
            refusedBy('fee')
          );
          const quoteStrategy = new RecordingQuoteStrategy();

          await buildProbedBL(probe, quoteStrategy).quote(
            buildTestContext(),
            create(QuoteRequestSchema, {...baseRequest, tradeType: 'EXACT_IN'})
          );

          expect(probe.requests).toEqual([]);
          expect(quoteStrategy.receivedRoutes[0]).toHaveLength(2);
        });
      });
    });
  });

  describe('advisory route cache on FAST quotes', () => {
    class FakeDiscoveryRoutesRepository implements IRoutesRepository {
      constructor(public getRoutes: IRoutesRepository['getRoutes']) {}

      async fetchRoutesForTokens(): Promise<RouteDiscoveryResult> {
        return {routes: [], degradedReasons: []};
      }
    }

    class FakeRepricingQuoteFetcher implements IQuoteFetcher {
      constructor(public fetchQuotes: IQuoteFetcher['fetchQuotes']) {}
    }

    class FakeUnfilteredCachedRoutesRepository
      extends CachedRoutesRepository
      implements ICachedRoutesRepository
    {
      constructor(
        private readonly unfilteredRoutes: RouteBasic<Pool>[],
        private readonly readGate?: Promise<void>,
        private readonly onRead?: () => void
      ) {
        super(
          redisCache,
          serviceConfig,
          new NoOpMessageQueue(),
          FeatureGatedTokensRepository.empty()
        );
      }

      override async readCachedRoutes(): Promise<CachedRoutesReadResult> {
        this.onRead?.();
        await this.readGate;
        return {
          perKeyReads: [],
          totalValidRouteCount: this.unfilteredRoutes.length,
        };
      }

      override async processCachedRoutesResult(): Promise<RouteBasic<Pool>[]> {
        return this.unfilteredRoutes;
      }
    }

    class FakeGatedNoRouteCacheRepository implements INoRouteCacheRepository {
      constructor(
        public getAmountCliff: INoRouteCacheRepository['getAmountCliff'],
        public setAmountCliff: INoRouteCacheRepository['setAmountCliff']
      ) {}
    }

    class FakeTaggedMetrics extends TestMetric {
      readonly calls: {name: string; tags: string[]}[] = [];

      override async count(
        name: string,
        value: number,
        options?: MetricOptions
      ): Promise<void> {
        this.calls.push({name, tags: options?.tags ?? []});
        await super.count(name, value, options);
      }

      has(name: string, ...tags: string[]): boolean {
        return this.calls.some(
          call =>
            call.name === buildMetricKey(name) &&
            tags.every(tag => call.tags.includes(tag))
        );
      }
    }

    class FakeRejectingAdvisoryMetrics
      extends FakeTaggedMetrics
      implements IMetrics
    {
      constructor(private readonly shouldReject: (name: string) => boolean) {
        super();
      }

      override async count(
        name: string,
        value: number,
        options?: MetricOptions
      ): Promise<void> {
        if (this.shouldReject(name)) {
          throw new Error('advisory count unavailable');
        }
        await super.count(name, value, options);
      }

      override async dist(
        name: string,
        value: number,
        options?: MetricOptions
      ): Promise<void> {
        if (this.shouldReject(name)) {
          throw new Error('advisory distribution unavailable');
        }
        await super.dist(name, value, options);
      }
    }

    const wrappedEth = new Address(
      '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
    );
    const usdc = new Address('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
    const allProtocols = [
      Protocol.V2,
      Protocol.V3,
      Protocol.V4,
      Protocol.MIXED,
    ];
    const amount = BigInt(baseRequest.amount);
    const makeRoute = (id: number, percentage = 100) =>
      new RouteBasic(
        Protocol.V2,
        [
          new V2Pool(
            wrappedEth,
            usdc,
            new Address(`0x${id.toString(16).padStart(40, '0')}`),
            1000000000000n,
            1000000000000n
          ),
        ],
        percentage
      );

    const seedRoutes = async (
      routes: RouteBasic<Pool>[],
      tokenIn = wrappedEth,
      tradeType = TradeType.ExactIn
    ) => {
      for (const bucket of Object.values(UsdBucket)) {
        for (const route of routes) {
          await cachedRoutesRepository.saveCachedRoutes(
            EMPTY_NAMESPACE_CONTEXT,
            allProtocols,
            route,
            ChainId.MAINNET,
            tokenIn,
            usdc,
            tradeType,
            amount,
            bucket
          );
        }
      }
    };

    const runCase = async (params: {
      cached: RouteBasic<Pool>[];
      fresh: RouteBasic<Pool>[];
      amounts?: Map<string, bigint>;
      gasCosts?: Map<string, bigint>;
      degradedReasons?: DiscoveryDegradedReason[];
      error?: Error;
      hitDiscoveryEnabled?: boolean;
      hitDiscoveryChains?: TokenMetadataChainSelection;
      maxRoutes?: number;
      nativeCached?: RouteBasic<Pool>[];
      candidates?: (routes: RouteBasic<Pool>[]) => QuoteSplit[];
      cliff?: boolean;
      unfilteredCached?: boolean;
      cacheReadGate?: Promise<void>;
      cliffReadGate?: Promise<void>;
      onCacheRead?: () => void;
      discoveryResult?: Promise<RouteDiscoveryResult>;
      tradeType?: 'EXACT_IN' | 'EXACT_OUT';
      rejectAdvisoryMetrics?: boolean;
      useRealStrategy?: boolean;
      routeSplitPercentage?: number;
      droppedRoutes?: number;
      droppedRoutePoolPathKeys?: string[];
      fetcherDrop?: (route: RouteBasic<Pool>) => boolean;
      fetcherQuotes?: (route: RouteBasic<Pool>) => boolean;
      scaleQuoteByPercentage?: boolean;
      simulator?: ISimulator;
      simulate?: boolean;
      forceMixed?: boolean;
      asyncMode?: boolean;
    }) => {
      const tradeType =
        params.tradeType === 'EXACT_OUT'
          ? TradeType.ExactOut
          : TradeType.ExactIn;
      await seedRoutes(params.cached, wrappedEth, tradeType);
      if (params.nativeCached)
        await seedRoutes(
          params.nativeCached,
          new Address(ADDRESS_ZERO),
          tradeType
        );
      const seenRoutes: RouteBasic<Pool>[][] = [];
      const seenConfigs: IUniRouteServiceConfig[] = [];
      let discoveryCalls = 0;
      const discovery = new FakeDiscoveryRoutesRepository(async () => {
        discoveryCalls++;
        if (params.error) throw params.error;
        if (params.discoveryResult) return params.discoveryResult;
        return {
          routes: params.fresh,
          degradedReasons: params.degradedReasons ?? [],
        };
      });
      const strategy = new FakeQuoteStrategy(async (...args) => {
        const config = args[7];
        const routes = args[8];
        const fetchReport = args[15];
        if (params.droppedRoutes !== undefined && fetchReport) {
          fetchReport.droppedRoutes = params.droppedRoutes;
          fetchReport.droppedRoutePoolPathKeys =
            params.droppedRoutePoolPathKeys;
          if (params.droppedRoutePoolPathKeys) {
            fetchReport.quotedRoutePoolPathKeys = routes
              .filter(
                route =>
                  params.droppedRoutePoolPathKeys?.includes(
                    route.poolPathKey()
                  ) === false
              )
              .map(route => route.poolPathKey());
          }
        }
        seenConfigs.push(config);
        seenRoutes.push(routes);
        return (
          params.candidates?.(routes) ??
          routes.map(
            route =>
              new QuoteSplit([
                new QuoteBasic(
                  route,
                  params.amounts?.get(route.poolPathKey()) ?? 1234567890n,
                  undefined,
                  {
                    gasUse: 150000n,
                    gasPriceInWei: 30000000000n,
                    gasCostInWei: 4500000000000000n,
                    gasCostInEth: 0.0045,
                    gasCostInQuoteToken:
                      params.gasCosts?.get(route.poolPathKey()) ?? 0n,
                  }
                ),
              ])
          )
        );
      });
      const config: IUniRouteServiceConfig = {
        ...serviceConfig,
        Lambda: params.asyncMode
          ? serviceConfigAsync.Lambda
          : serviceConfig.Lambda,
        RouteFinder: {
          ...serviceConfig.RouteFinder,
          MaxRoutes: params.maxRoutes ?? serviceConfig.RouteFinder.MaxRoutes,
          MaxSplits: params.simulate ? 7 : serviceConfig.RouteFinder.MaxSplits,
          RouteSplitPercentage:
            params.routeSplitPercentage ??
            (params.useRealStrategy
              ? 100
              : serviceConfig.RouteFinder.RouteSplitPercentage),
        },
        GasEstimation: {
          ...serviceConfig.GasEstimation,
          Enabled: params.useRealStrategy
            ? false
            : serviceConfig.GasEstimation.Enabled,
        },
        Simulation: {
          ...serviceConfig.Simulation,
          Enabled: params.simulate ?? serviceConfig.Simulation.Enabled,
          TopNQuotes: params.simulate ? 3 : serviceConfig.Simulation.TopNQuotes,
        },
        CachedRoutes: {
          ...serviceConfig.CachedRoutes,
          HitDiscoveryEnabled: params.hitDiscoveryEnabled ?? true,
          HitDiscoveryChains: params.hitDiscoveryChains ?? 'all',
        },
      };
      const repricingFetcher = new FakeRepricingQuoteFetcher(
        async (
          _chain,
          _tokenIn,
          _tokenOut,
          _amount,
          routes,
          _tradeType,
          _ctx,
          _metricTags,
          _blockNumber,
          _tokensInfo,
          _supplementalHookCodeOverrides,
          report
        ) => {
          const survivors = routes.filter(
            route => !(params.fetcherDrop?.(route) ?? false)
          );
          const dropped = routes.length - survivors.length;
          if (report && dropped > 0) {
            report.droppedRoutes += dropped;
            report.batchErrors.push(new Error('simulated dropped route'));
            report.droppedRoutePoolPathKeys = routes
              .filter(route => params.fetcherDrop?.(route) ?? false)
              .map(route => route.poolPathKey());
          }
          return survivors
            .filter(route => params.fetcherQuotes?.(route) ?? true)
            .map(
              route =>
                new QuoteBasic(
                  route,
                  ((params.amounts?.get(route.poolPathKey()) ?? 1000000000n) *
                    BigInt(
                      params.scaleQuoteByPercentage ? route.percentage : 100
                    )) /
                    100n
                )
            );
        }
      );
      const bl = new UniRouteBL(
        config,
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
        discovery,
        params.unfilteredCached || params.cacheReadGate || params.onCacheRead
          ? new FakeUnfilteredCachedRoutesRepository(
              params.cached,
              params.cacheReadGate,
              params.onCacheRead
            )
          : cachedRoutesRepository,
        params.cliffReadGate
          ? new FakeGatedNoRouteCacheRepository(
              async (...args) => {
                await params.cliffReadGate;
                return noRouteCacheRepository.getAmountCliff(...args);
              },
              (...args) => noRouteCacheRepository.setAmountCliff(...args)
            )
          : noRouteCacheRepository,
        params.useRealStrategy
          ? new DeepQuoteStrategy(
              repricingFetcher,
              gasEstimateProvider,
              noGasConverter,
              routeQuoteAllocator,
              quoteSelector,
              tokenHandler,
              new Map(),
              freshPoolDetailsWrapper
            )
          : strategy,
        params.simulator ?? dummySimulator,
        quoteRequestValidator,
        tokenProvider,
        mockedRpcProviderMap,
        stateOverrideResolver
      );
      const handlerContext = createHandlerContext({
        service: unirouteService,
        method: unirouteService.method.quote,
        protocolName: 'connect',
        requestMethod: 'POST',
        url: 'http://localhost/quote',
      });
      const ctx = buildTestContext(handlerContext);
      if (params.cliff) {
        await noRouteCacheRepository.setAmountCliff(
          EMPTY_NAMESPACE_CONTEXT,
          allProtocols,
          ChainId.MAINNET,
          wrappedEth,
          usdc,
          TradeType.ExactIn,
          amount,
          ctx
        );
      }
      const metrics = params.rejectAdvisoryMetrics
        ? new FakeRejectingAdvisoryMetrics(name =>
            [
              buildMetricKey('CachedRoutes.HitDiscovery'),
              buildMetricKey('CachedRoutes.HitDiscovery.Latency.dist'),
              buildMetricKey('CachedRoutes.FreshContribution'),
            ].includes(name)
          )
        : new FakeTaggedMetrics();
      ctx.metrics = metrics;
      const quote = () =>
        bl.quote(
          ctx,
          create(QuoteRequestSchema, {
            ...baseRequest,
            tradeType: params.tradeType ?? 'EXACT_IN',
            forceMixed: params.forceMixed ?? false,
            ...(params.simulate
              ? {
                  simulateFromAddress:
                    '0x1234567890123456789012345678901234567890',
                  recipient: '0x1234567890123456789012345678901234567890',
                  slippageTolerance: 20,
                }
              : {}),
          }),
          params.simulate
            ? {universalRouterVersion: UniversalRouterVersion.V2_0}
            : undefined
        );
      return {
        quote,
        seenRoutes,
        seenConfigs,
        metrics,
        logs: ctx.logger.outputs,
        getDiscoveryCalls: () => discoveryCalls,
        readCliff: () =>
          noRouteCacheRepository.getAmountCliff(
            EMPTY_NAMESPACE_CONTEXT,
            allProtocols,
            ChainId.MAINNET,
            wrappedEth,
            usdc,
            tradeType,
            ctx
          ),
      };
    };

    it('runs discovery on a hit, appends unique cached routes, and keeps the fresh instance on collision', async () => {
      const cached = makeRoute(1);
      const freshDuplicate = makeRoute(1, 10);
      const freshOther = makeRoute(2);
      const extraCached = makeRoute(3);
      const run = await runCase({
        cached: [cached, extraCached],
        fresh: [freshDuplicate, freshOther],
      });
      await run.quote();
      expect(run.getDiscoveryCalls()).toBe(1);
      expect(run.seenRoutes[0][0]).toBe(freshDuplicate);
      expect(run.seenRoutes[0].map(route => route.poolPathKey())).toEqual(
        [freshDuplicate, freshOther, extraCached].map(route =>
          route.poolPathKey()
        )
      );
      expect(run.seenConfigs[0].RouteFinder).toEqual(serviceConfig.RouteFinder);
      expect(
        run.metrics.has(
          'CachedRoutes.HitDiscovery',
          'status:success',
          'outcome:routes'
        )
      ).toBe(true);
      expect(
        run.metrics.distStore.filter(
          item =>
            item.metric_name ===
            buildMetricKey('CachedRoutes.HitDiscovery.Latency.dist')
        )
      ).toHaveLength(1);
    });

    it('chooses a repriced fresh two-hop route and counts a greater than 500 bps contribution', async () => {
      const cached = makeRoute(4);
      const fresh = new RouteBasic(Protocol.V2, [
        new V2Pool(
          wrappedEth,
          new Address('0x1111111111111111111111111111111111111111'),
          new Address('0x0000000000000000000000000000000000000005'),
          1n,
          1n
        ),
        new V2Pool(
          new Address('0x1111111111111111111111111111111111111111'),
          usdc,
          new Address('0x0000000000000000000000000000000000000006'),
          1n,
          1n
        ),
      ]);
      const amounts = new Map([
        [cached.poolPathKey(), 1000000000n],
        [fresh.poolPathKey(), 2000000000n],
      ]);
      const run = await runCase({cached: [cached], fresh: [fresh], amounts});
      const response = await run.quote();
      expect(response.quoteAmount).toBe('2000000000');
      expect(
        run.metrics.has('CachedRoutes.FreshContribution', 'band:gt500')
      ).toBe(true);
    });

    it('chooses one fresh route over a cached two-route split', async () => {
      const cached = [makeRoute(21, 50), makeRoute(22, 50)];
      const fresh = makeRoute(23);
      const run = await runCase({
        cached,
        fresh: [fresh],
        candidates: routes => {
          const first = routes.find(
            route => route.poolPathKey() === cached[0].poolPathKey()
          );
          const second = routes.find(
            route => route.poolPathKey() === cached[1].poolPathKey()
          );
          const honest = routes.find(
            route => route.poolPathKey() === fresh.poolPathKey()
          );
          if (!first || !second || !honest) return [];
          return [
            new QuoteSplit([
              new QuoteBasic(first, 500000000n),
              new QuoteBasic(second, 500000000n),
            ]),
            new QuoteSplit([new QuoteBasic(honest, 2000000000n)]),
          ];
        },
      });
      const response = await run.quote();
      expect(response.quoteAmount).toBe('2000000000');
      expect(response.route).toHaveLength(1);
    });

    it('finds an honest route when the cache contains only one repriced route', async () => {
      const cached = makeRoute(24);
      const fresh = makeRoute(25);
      const run = await runCase({
        cached: [cached],
        fresh: [fresh],
        amounts: new Map([
          [cached.poolPathKey(), 1000000000n],
          [fresh.poolPathKey(), 2000000000n],
        ]),
      });
      const response = await run.quote();
      expect(response.quoteAmount).toBe('2000000000');
      expect(run.seenRoutes[0]).toHaveLength(2);
    });

    it('uses gas-adjusted amounts when a cached raw winner loses to fresh', async () => {
      const cached = makeRoute(26);
      const fresh = makeRoute(27);
      const run = await runCase({
        cached: [cached],
        fresh: [fresh],
        amounts: new Map([
          [cached.poolPathKey(), 2000000000n],
          [fresh.poolPathKey(), 1900000000n],
        ]),
        gasCosts: new Map([
          [cached.poolPathKey(), 200000000n],
          [fresh.poolPathKey(), 0n],
        ]),
      });
      const response = await run.quote();
      expect(response.quoteAmount).toBe('1900000000');
      expect(
        run.metrics.has('CachedRoutes.FreshContribution', 'band:gt500')
      ).toBe(true);
    });

    it('does not mark a split winner with a cached ten-percent leg as all-cached', async () => {
      const cached = makeRoute(28, 10);
      const fresh = makeRoute(29, 90);
      const run = await runCase({
        cached: [cached],
        fresh: [fresh],
        candidates: routes => {
          const cachedRoute = routes.find(
            route => route.poolPathKey() === cached.poolPathKey()
          );
          const freshRoute = routes.find(
            route => route.poolPathKey() === fresh.poolPathKey()
          );
          if (!cachedRoute || !freshRoute) return [];
          return [
            new QuoteSplit([new QuoteBasic(cachedRoute, 1000000000n)]),
            new QuoteSplit([
              new QuoteBasic(cachedRoute, 100000000n),
              new QuoteBasic(freshRoute, 1900000000n),
            ]),
          ];
        },
      });
      const response = await run.quote();
      expect(response.route).toHaveLength(2);
      expect(
        run.metrics.has('CachedRoutes.FreshContribution', 'band:none')
      ).toBe(false);
      expect(
        run.metrics.has('CachedRoutes.FreshContribution', 'band:gt500')
      ).toBe(true);
    });

    it('d1: propagates discovery error on a cache hit', async () => {
      const run = await runCase({
        cached: [makeRoute(7)],
        fresh: [],
        error: new Error('probe failed'),
      });
      await expect(run.quote()).rejects.toThrow('probe failed');
      expect(
        run.metrics.has(
          'CachedRoutes.HitDiscovery',
          'status:failure',
          'reason:discovery_error'
        )
      ).toBe(true);
    });

    it('d2: degraded-empty discovery on a hit answers no-route without caching it', async () => {
      const run = await runCase({
        cached: [makeRoute(7)],
        fresh: [],
        degradedReasons: [DiscoveryDegradedReason.PROBE_ERROR],
        asyncMode: true,
      });
      const response = await run.quote();
      expect(response.error?.code).toBe(404);
      expect(response.hitsCachedRoutes).toBe(false);
      expect(await run.readCliff()).toBeUndefined();
      expect(
        run.metrics.has(
          'CachedRoutes.HitDiscovery',
          'status:failure',
          'reason:discovery_degraded'
        )
      ).toBe(true);
      expect(
        run.metrics.has(
          'NoRouteCache.WriteSkipped',
          'reason:degraded_discovery'
        )
      ).toBe(true);
    });

    it('a degraded-empty discovery on a miss does not write the negative cache', async () => {
      const run = await runCase({
        cached: [],
        fresh: [],
        degradedReasons: [DiscoveryDegradedReason.PROBE_ERROR],
        asyncMode: true,
      });
      const response = await run.quote();
      expect(response.error?.code).toBe(404);
      expect(await run.readCliff()).toBeUndefined();
      expect(
        await noRouteCooldownKeys(
          [
            {tokenIn: wrappedEth, tokenOut: usdc},
            {tokenIn: new Address(ADDRESS_ZERO), tokenOut: usdc},
          ],
          allProtocols
        )
      ).toEqual([]);
      expect(
        run.metrics.has(
          'NoRouteCache.WriteSkipped',
          'reason:degraded_discovery'
        )
      ).toBe(true);
    });

    it('w1: skips the negative cache after degraded routes quote to nothing on a miss', async () => {
      const run = await runCase({
        cached: [],
        fresh: [makeRoute(989)],
        degradedReasons: [DiscoveryDegradedReason.PROBE_ERROR],
        candidates: () => [],
        asyncMode: true,
      });
      const response = await run.quote();
      expect(run.seenRoutes[0]).toHaveLength(1);
      expect(response.error?.code).toBe(404);
      expect(await run.readCliff()).toBeUndefined();
      expect(
        run.metrics.has(
          'NoRouteCache.WriteSkipped',
          'reason:degraded_discovery'
        )
      ).toBe(true);
    });

    it('w2: writes the negative cache after clean empty discovery', async () => {
      const run = await runCase({cached: [], fresh: [], asyncMode: true});
      const response = await run.quote();
      expect(response.error?.code).toBe(404);
      expect(await run.readCliff()).toBe(amount);
      expect(
        await noRouteCooldownKeys(
          [
            {tokenIn: wrappedEth, tokenOut: usdc},
            {tokenIn: new Address(ADDRESS_ZERO), tokenOut: usdc},
          ],
          allProtocols
        )
      ).toHaveLength(1);
      expect(run.metrics.has('NoRouteCache.WriteSkipped')).toBe(false);
    });

    it.each([
      DiscoveryDegradedReason.PROBE_ERROR,
      DiscoveryDegradedReason.PRIMARY_DISCOVERER_ERROR,
    ])('serves a degraded non-empty fresh arm with %s', async reason => {
      const fresh = makeRoute(990);
      const cached = makeRoute(991);
      const run = await runCase({
        cached: [cached],
        fresh: [fresh],
        degradedReasons: [reason],
      });
      const response = await run.quote();
      expect(response.error).toBeUndefined();
      expect(run.seenRoutes[0].map(route => route.poolPathKey())).toEqual(
        [fresh, cached].map(route => route.poolPathKey())
      );
      expect(
        run.metrics.calls.filter(
          call => call.name === buildMetricKey('CachedRoutes.HitDiscovery')
        )
      ).toHaveLength(1);
      expect(
        run.metrics.has(
          'CachedRoutes.HitDiscovery',
          'status:success',
          'outcome:routes_degraded'
        )
      ).toBe(true);
      expect(
        run.metrics.has('CachedRoutes.HitDiscovery', 'status:failure')
      ).toBe(false);
    });

    describe('quote fetch drops routes on a cache hit', () => {
      // These run through the real DeepQuoteStrategy and report quote-fetch
      // provenance independently of which splits survive stitching.
      const routeA = makeRoute(980);
      const routeB = makeRoute(981);

      it('q1: answers no-route when quoting drops the only fresh route and the cached route wins', async () => {
        const run = await runCase({
          cached: [routeA],
          fresh: [routeB],
          useRealStrategy: true,
          fetcherDrop: route => route.poolPathKey() === routeB.poolPathKey(),
          asyncMode: true,
        });
        const response = await run.quote();
        expect(response.error?.code).toBe(404);
        expect(response.hitsCachedRoutes).toBe(false);
        expect(await run.readCliff()).toBeUndefined();
        expect(
          run.metrics.has(
            'CachedRoutes.HitDiscovery',
            'status:failure',
            'reason:quote_degraded'
          )
        ).toBe(true);
        expect(
          run.metrics.calls.filter(
            call => call.name === buildMetricKey('CachedRoutes.HitDiscovery')
          )
        ).toHaveLength(1);
        expect(
          run.metrics.calls.some(
            call =>
              call.name === buildMetricKey('CachedRoutes.FreshContribution')
          )
        ).toBe(false);
      });

      it('q2: serves the surviving fresh route when it wins, counting outcome:routes', async () => {
        const routeC = makeRoute(982);
        const run = await runCase({
          cached: [routeA],
          fresh: [routeB, routeC],
          useRealStrategy: true,
          fetcherDrop: route => route.poolPathKey() === routeB.poolPathKey(),
          amounts: new Map([
            [routeA.poolPathKey(), 1000000000n],
            [routeC.poolPathKey(), 2000000000n],
          ]),
        });
        const response = await run.quote();
        expect(response.error).toBeUndefined();
        expect(response.quoteAmount).toBe('2000000000');
        expect(
          run.metrics.has(
            'CachedRoutes.HitDiscovery',
            'status:success',
            'outcome:routes'
          )
        ).toBe(true);
        expect(
          run.metrics.calls.some(
            call =>
              call.name === buildMetricKey('CachedRoutes.FreshContribution')
          )
        ).toBe(true);
      });

      it('q3: no drops, the cached route legitimately wins', async () => {
        const run = await runCase({
          cached: [routeA],
          fresh: [routeB],
          useRealStrategy: true,
          amounts: new Map([
            [routeA.poolPathKey(), 2000000000n],
            [routeB.poolPathKey(), 1000000000n],
          ]),
        });
        const response = await run.quote();
        expect(response.error).toBeUndefined();
        expect(response.quoteAmount).toBe('2000000000');
        expect(
          run.metrics.has('CachedRoutes.FreshContribution', 'band:none')
        ).toBe(true);
        expect(
          run.metrics.has(
            'CachedRoutes.HitDiscovery',
            'status:failure',
            'reason:quote_degraded'
          )
        ).toBe(false);
      });

      it('q4: a miss with dropped routes is unaffected (no HitDiscovery count)', async () => {
        const run = await runCase({
          cached: [],
          fresh: [routeA, routeB],
          droppedRoutes: 1,
        });
        const response = await run.quote();
        expect(response.error).toBeUndefined();
        expect(
          run.metrics.calls.some(
            call => call.name === buildMetricKey('CachedRoutes.HitDiscovery')
          )
        ).toBe(false);
      });

      it('q5: a fresh-verified winner on a full-overlap hit counts a partial drop', async () => {
        const routeAFresh = makeRoute(980);
        const run = await runCase({
          cached: [routeA],
          fresh: [routeAFresh, routeB],
          useRealStrategy: true,
          fetcherDrop: route => route.poolPathKey() === routeB.poolPathKey(),
        });
        const response = await run.quote();
        expect(response.error).toBeUndefined();
        expect(
          run.metrics.has(
            'CachedRoutes.HitDiscovery',
            'status:success',
            'outcome:routes'
          )
        ).toBe(true);
        const partialDrops = run.metrics.calls.filter(
          call =>
            call.name ===
            buildMetricKey('CachedRoutes.HitDiscovery.PartialDrop')
        );
        expect(partialDrops).toHaveLength(1);
        expect(partialDrops[0].tags).toContain('winner:fresh');
      });

      it('q6: a drop on a clean-empty cached batch stays outcome:empty, no quote_degraded', async () => {
        const routeC = makeRoute(983);
        const run = await runCase({
          cached: [routeA, routeC],
          fresh: [],
          useRealStrategy: true,
          fetcherDrop: route => route.poolPathKey() === routeC.poolPathKey(),
        });
        const response = await run.quote();
        expect(response.error).toBeUndefined();
        expect(
          run.metrics.has(
            'CachedRoutes.HitDiscovery',
            'status:success',
            'outcome:empty'
          )
        ).toBe(true);
        expect(
          run.metrics.has(
            'CachedRoutes.HitDiscovery',
            'status:failure',
            'reason:quote_degraded'
          )
        ).toBe(false);
      });

      it('q7: fresh quotes lose fairly while another fresh batch drops', async () => {
        const routeC = makeRoute(984);
        const run = await runCase({
          cached: [routeA],
          fresh: [routeB, routeC],
          useRealStrategy: true,
          fetcherDrop: route => route.poolPathKey() === routeC.poolPathKey(),
          amounts: new Map([
            [routeA.poolPathKey(), 2000000000n],
            [routeB.poolPathKey(), 1000000000n],
          ]),
        });
        const response = await run.quote();
        expect(response.error).toBeUndefined();
        expect(response.quoteAmount).toBe('2000000000');
        expect(
          run.metrics.has('CachedRoutes.HitDiscovery', 'outcome:routes')
        ).toBe(true);
        expect(
          run.metrics.calls.filter(
            call => call.name === buildMetricKey('CachedRoutes.HitDiscovery')
          )
        ).toHaveLength(1);
        expect(
          run.metrics.has('CachedRoutes.HitDiscovery', 'reason:quote_degraded')
        ).toBe(false);
        expect(
          run.metrics.has(
            'CachedRoutes.HitDiscovery.PartialDrop',
            'winner:cached'
          )
        ).toBe(true);
        expect(
          run.metrics.calls.filter(
            call =>
              call.name ===
              buildMetricKey('CachedRoutes.HitDiscovery.PartialDrop')
          )
        ).toHaveLength(1);
      });

      it('q8: every fresh route drops while cached wins', async () => {
        const run = await runCase({
          cached: [routeA],
          fresh: [routeB],
          useRealStrategy: true,
          fetcherDrop: route => route.poolPathKey() === routeB.poolPathKey(),
          asyncMode: true,
        });
        const response = await run.quote();
        expect(response.error?.code).toBe(404);
        expect(await run.readCliff()).toBeUndefined();
        expect(
          run.metrics.has('CachedRoutes.HitDiscovery', 'reason:quote_degraded')
        ).toBe(true);
      });

      it('q9: cached batch drops while fresh receives no quote', async () => {
        const routeC = makeRoute(985);
        const run = await runCase({
          cached: [routeA, routeC],
          fresh: [routeB],
          useRealStrategy: true,
          fetcherDrop: route => route.poolPathKey() === routeC.poolPathKey(),
          fetcherQuotes: route => route.poolPathKey() !== routeB.poolPathKey(),
        });
        const response = await run.quote();
        expect(response.error).toBeUndefined();
        expect(
          run.metrics.has('CachedRoutes.HitDiscovery', 'reason:quote_degraded')
        ).toBe(false);
        expect(run.metrics.has('CachedRoutes.HitDiscovery.PartialDrop')).toBe(
          false
        );
        expect(
          run.metrics.calls.some(
            call =>
              call.name === buildMetricKey('CachedRoutes.FreshContribution')
          )
        ).toBe(true);
      });

      it('t1: partial fresh quotes without a retained split do not fail the hit', async () => {
        const run = await runCase({
          cached: [routeA],
          fresh: [routeB],
          useRealStrategy: true,
          routeSplitPercentage:
            serviceConfigAsync.RouteFinder.RouteSplitPercentage,
          fetcherQuotes: route =>
            route.poolPathKey() === routeA.poolPathKey()
              ? route.percentage === 100
              : route.percentage ===
                serviceConfigAsync.RouteFinder.RouteSplitPercentage,
        });
        const response = await run.quote();
        expect(response.error).toBeUndefined();
        expect(
          run.metrics.has('CachedRoutes.FreshContribution', 'band:none')
        ).toBe(true);
        expect(
          run.metrics.has('CachedRoutes.HitDiscovery', 'status:failure')
        ).toBe(false);
      });

      it('t2: simulation falls through from a fresh candidate to cached', async () => {
        class SelectiveSimulator implements ISimulator {
          async simulate(
            _chainId: ChainId,
            _swapOptions: unknown,
            quoteSplit: QuoteSplit
          ): Promise<QuoteSplit> {
            const hasFresh = quoteSplit.quotes.some(
              quote => quote.route.poolPathKey() === routeB.poolPathKey()
            );
            return {
              ...quoteSplit,
              simulationResult: {
                estimatedGasUsed: 0n,
                estimatedGasUsedInQuoteToken: 0n,
                estimatedGasUsedInUSD: 0,
                status: hasFresh
                  ? SimulationStatus.FAILED
                  : SimulationStatus.SUCCESS,
              },
            };
          }
        }
        const buildTradeSpy = vi
          .spyOn(await import('../lib/methodParameters'), 'buildTrade')
          .mockImplementation(mockBuildTrade);
        const buildSwapMethodParametersSpy = vi
          .spyOn(
            await import('../lib/methodParameters'),
            'buildSwapMethodParameters'
          )
          .mockImplementation(mockBuildSwapMethodParameters);
        const run = await runCase({
          cached: [routeA],
          fresh: [routeB],
          useRealStrategy: true,
          routeSplitPercentage:
            serviceConfigAsync.RouteFinder.RouteSplitPercentage,
          scaleQuoteByPercentage: true,
          fetcherQuotes: route => route.percentage === 100,
          amounts: new Map([
            [routeA.poolPathKey(), 1000000000n],
            [routeB.poolPathKey(), 2000000000n],
          ]),
          simulator: new SelectiveSimulator(),
          simulate: true,
        });
        const response = await run.quote();
        buildTradeSpy.mockRestore();
        buildSwapMethodParametersSpy.mockRestore();
        expect(response.error).toBeUndefined();
        expect(response.simulationStatus).toBe(SimulationStatus.SUCCESS);
        expect(response.quoteAmount).toBe('1000000000');
        expect(
          run.metrics.has('CachedRoutes.FreshContribution', 'band:none')
        ).toBe(true);
        expect(
          run.metrics.has('CachedRoutes.HitDiscovery', 'status:failure')
        ).toBe(false);
      });

      it('t3: a dropped fresh route and a quoted fresh loser count a cached-winner partial drop', async () => {
        const routeC = makeRoute(986);
        const run = await runCase({
          cached: [routeA],
          fresh: [routeB, routeC],
          useRealStrategy: true,
          routeSplitPercentage:
            serviceConfigAsync.RouteFinder.RouteSplitPercentage,
          scaleQuoteByPercentage: true,
          fetcherDrop: route => route.poolPathKey() === routeC.poolPathKey(),
          amounts: new Map([
            [routeA.poolPathKey(), 2000000000n],
            [routeB.poolPathKey(), 1000000000n],
          ]),
        });
        const response = await run.quote();
        expect(response.error).toBeUndefined();
        expect(response.quoteAmount).toBe('2000000000');
        expect(
          run.metrics.has(
            'CachedRoutes.HitDiscovery.PartialDrop',
            'winner:cached'
          )
        ).toBe(true);
        expect(
          run.metrics.has('CachedRoutes.HitDiscovery', 'reason:quote_degraded')
        ).toBe(false);
      });
    });

    it('serves cached routes on a clean-empty discovery', async () => {
      const run = await runCase({cached: [makeRoute(8)], fresh: []});
      const response = await run.quote();
      expect(response.hitsCachedRoutes).toBe(true);
      expect(
        run.metrics.has(
          'CachedRoutes.HitDiscovery',
          'status:success',
          'outcome:empty'
        )
      ).toBe(true);
      expect(
        run.metrics.has('Call', 'cachedRoutesStatus:hitWithDiscovery')
      ).toBe(true);
    });

    it('does not append a cached route containing an aggregator-hook pool', async () => {
      const cached = new RouteBasic(Protocol.V4, [
        new V4Pool(
          wrappedEth,
          usdc,
          3000,
          60,
          '0xaaaa000000000000000000000000000000000001',
          1n,
          `0x${'a'.repeat(64)}`,
          1n,
          0n
        ),
      ]);
      const fresh = makeRoute(33);
      const run = await runCase({
        cached: [cached],
        fresh: [fresh],
        unfilteredCached: true,
      });
      await run.quote();
      expect(run.seenRoutes[0].map(route => route.poolPathKey())).toEqual([
        fresh.poolPathKey(),
      ]);
      expect(
        run.metrics.has('CachedRoutes.HitDiscovery', 'outcome:routes')
      ).toBe(true);
    });

    describe('EXACT_OUT routes through a settle-before-swap hook', () => {
      const settleBeforeSwapRoute = (
        hooks: string = LOOPER_ORIGIN_ARM_HOOK_ON_MAINNET
      ) =>
        new RouteBasic(Protocol.V4, [
          new V4Pool(
            wrappedEth,
            usdc,
            3000,
            60,
            hooks,
            1n,
            V4Pool.computePoolId(wrappedEth, usdc, 3000, 60, hooks),
            BigInt('79228162514264337593543950336'),
            0n
          ),
        ]);
      const droppedMetric = 'SettleBeforeSwapHooks.exactOutRouteDropped';

      it('uses a hook flagged settle-before-swap on mainnet', () => {
        expect(
          isZlcaHookSettleBeforeSwap(
            ChainId.MAINNET,
            LOOPER_ORIGIN_ARM_HOOK_ON_MAINNET
          )
        ).toBe(true);
      });

      it('drops a fresh route through the hook for EXACT_OUT and counts it', async () => {
        const hooked = settleBeforeSwapRoute();
        const plain = makeRoute(41);
        const run = await runCase({
          cached: [],
          fresh: [hooked, plain],
          tradeType: 'EXACT_OUT',
        });
        await run.quote();
        expect(run.seenRoutes[0].map(route => route.poolPathKey())).toEqual([
          plain.poolPathKey(),
        ]);
        expect(
          run.metrics.has(droppedMetric, 'status:success', 'chain:MAINNET')
        ).toBe(true);
      });

      it('drops a cached route through the hook for EXACT_OUT', async () => {
        const hooked = settleBeforeSwapRoute();
        const plain = makeRoute(42);
        const run = await runCase({
          cached: [hooked],
          fresh: [plain],
          tradeType: 'EXACT_OUT',
          unfilteredCached: true,
        });
        await run.quote();
        expect(run.seenRoutes[0].map(route => route.poolPathKey())).toEqual([
          plain.poolPathKey(),
        ]);
        expect(run.metrics.has(droppedMetric, 'status:success')).toBe(true);
      });

      it('falls back to fresh discovery when hit discovery is off and every cached route uses the hook', async () => {
        const hooked = settleBeforeSwapRoute();
        const hookless = makeRoute(44);
        const run = await runCase({
          cached: [hooked],
          fresh: [hookless],
          tradeType: 'EXACT_OUT',
          hitDiscoveryEnabled: false,
          unfilteredCached: true,
        });
        const response = await run.quote();
        expect(response.error).toBeUndefined();
        expect(response.hitsCachedRoutes).toBe(false);
        expect(run.getDiscoveryCalls()).toBe(1);
        expect(run.seenRoutes[0].map(route => route.poolPathKey())).toEqual([
          hookless.poolPathKey(),
        ]);
        expect(run.metrics.has(droppedMetric, 'status:success')).toBe(true);
        expect(run.metrics.has('CachedRoutes.AllInvalidFreshFallback')).toBe(
          true
        );
        expect(
          run.logs.some(
            log =>
              log.msg ===
              'ExactOut settle-before-swap hook filter left no routes'
          )
        ).toBe(false);
      });

      it('warns when the hook filter leaves no route to quote', async () => {
        const run = await runCase({
          cached: [],
          fresh: [settleBeforeSwapRoute()],
          tradeType: 'EXACT_OUT',
        });
        await run.quote();
        expect(run.seenRoutes.flat()).toEqual([]);
        expect(
          run.logs.find(
            log =>
              log.msg ===
              'ExactOut settle-before-swap hook filter left no routes'
          )
        ).toMatchObject({
          prefix: 'WARN:',
          extra: {
            chainId: ChainId.MAINNET,
            tradeType: TradeType.ExactOut,
            routesDropped: 1,
          },
        });
      });

      it('keeps the route for EXACT_IN and counts nothing', async () => {
        const hooked = settleBeforeSwapRoute();
        const plain = makeRoute(43);
        const run = await runCase({
          cached: [],
          fresh: [hooked, plain],
          tradeType: 'EXACT_IN',
        });
        await run.quote();
        expect(
          run.seenRoutes[0].map(route => route.poolPathKey()).sort()
        ).toEqual([hooked.poolPathKey(), plain.poolPathKey()].sort());
        expect(run.metrics.has(droppedMetric)).toBe(false);
      });

      it('drops a FewV2 Shell (WETH mode) route for EXACT_OUT and counts it', async () => {
        const fewV2 = settleBeforeSwapRoute(FEW_V2_SHELL_HOOK_ON_MAINNET_2);
        const plain = makeRoute(45);
        const run = await runCase({
          cached: [],
          fresh: [fewV2, plain],
          tradeType: 'EXACT_OUT',
        });
        await run.quote();
        expect(run.seenRoutes[0].map(route => route.poolPathKey())).toEqual([
          plain.poolPathKey(),
        ]);
        expect(
          run.metrics.has(droppedMetric, 'status:success', 'chain:MAINNET')
        ).toBe(true);
      });

      it('keeps a FewV2 Shell (WETH mode) route for EXACT_IN', async () => {
        const fewV2 = settleBeforeSwapRoute(FEW_V2_SHELL_HOOK_ON_MAINNET_2);
        const plain = makeRoute(46);
        const run = await runCase({
          cached: [],
          fresh: [fewV2, plain],
          tradeType: 'EXACT_IN',
        });
        await run.quote();
        expect(
          run.seenRoutes[0].map(route => route.poolPathKey()).sort()
        ).toEqual([fewV2.poolPathKey(), plain.poolPathKey()].sort());
        expect(run.metrics.has(droppedMetric)).toBe(false);
      });

      it('keeps a hookless V4 route for EXACT_OUT and counts nothing', async () => {
        const hookless = new RouteBasic(Protocol.V4, [
          new V4Pool(
            wrappedEth,
            usdc,
            3000,
            60,
            ADDRESS_ZERO,
            1n,
            V4Pool.computePoolId(wrappedEth, usdc, 3000, 60, ADDRESS_ZERO),
            BigInt('79228162514264337593543950336'),
            0n
          ),
        ]);
        const run = await runCase({
          cached: [],
          fresh: [hookless],
          tradeType: 'EXACT_OUT',
        });
        await run.quote();
        expect(run.seenRoutes[0].map(route => route.poolPathKey())).toEqual([
          hookless.poolPathKey(),
        ]);
        expect(run.metrics.has(droppedMetric)).toBe(false);
      });
    });

    it('collapses a cached V4 route with the same pool id but a different fee', async () => {
      const poolId = `0x${'b'.repeat(64)}`;
      const cached = new RouteBasic(Protocol.V4, [
        new V4Pool(
          wrappedEth,
          usdc,
          3000,
          60,
          ADDRESS_ZERO,
          1n,
          poolId,
          1n,
          0n
        ),
      ]);
      const fresh = new RouteBasic(Protocol.V4, [
        new V4Pool(wrappedEth, usdc, 500, 10, ADDRESS_ZERO, 1n, poolId, 1n, 0n),
      ]);
      const run = await runCase({cached: [cached], fresh: [fresh]});
      await run.quote();
      expect(run.seenRoutes[0]).toHaveLength(1);
      expect(run.seenRoutes[0][0]).toBe(fresh);
      expect(
        run.metrics.distStore.some(
          item =>
            item.metric_name ===
            buildMetricKey('CachedRoutes.HitDiscovery.Latency.dist')
        )
      ).toBe(true);
    });

    it('signals when validity filters remove every fresh route on a hit', async () => {
      const cached = makeRoute(970);
      // Invalid for a native-ETH input (baseRequest's tokenIn): first pool
      // is ETH/WETH and the second touches ETH directly, the ROUTE-1695
      // shape `isValidRoute` rejects.
      const freshInvalidForNativeInput = new RouteBasic(Protocol.V2, [
        new V2Pool(
          new Address(ADDRESS_ZERO),
          wrappedEth,
          new Address('0x3333333333333333333333333333333333333333'),
          1000000000000n,
          1000000000000n
        ),
        new V2Pool(
          new Address(ADDRESS_ZERO),
          usdc,
          new Address('0x4444444444444444444444444444444444444444'),
          1000000000000n,
          1000000000000n
        ),
      ]);
      const run = await runCase({
        cached: [cached],
        fresh: [freshInvalidForNativeInput],
      });
      const response = await run.quote();
      expect(response.error).toBeUndefined();
      expect(
        run.metrics.has(
          'CachedRoutes.FreshFilteredOut',
          'status:failure',
          'reason:validity_filters'
        )
      ).toBe(true);
      expect(
        run.metrics.calls.filter(
          call => call.name === buildMetricKey('CachedRoutes.FreshFilteredOut')
        )
      ).toHaveLength(1);
    });

    it('counts outcome:routes once on a union hit that force-mixed 404s', async () => {
      const cached = makeRoute(971);
      const fresh = makeRoute(972);
      const run = await runCase({
        cached: [cached],
        fresh: [fresh],
        forceMixed: true,
      });
      const response = await run.quote();
      expect(response.error?.code).toBe(404);
      expect(
        run.metrics.calls.filter(
          call =>
            call.name === buildMetricKey('CachedRoutes.HitDiscovery') &&
            call.tags.includes('outcome:routes')
        )
      ).toHaveLength(1);
    });

    it('does not start discovery when the no-route cliff short-circuits', async () => {
      const run = await runCase({cached: [], fresh: [], cliff: true});
      const response = await run.quote();
      expect(response.error?.code).toBe(404);
      expect(run.getDiscoveryCalls()).toBe(0);
      expect(run.metrics.has('CachedRoutes.HitDiscovery')).toBe(false);
      expect(
        run.metrics.has('Call', 'cachedRoutesStatus:noRouteCacheHit')
      ).toBe(true);
    });

    it('c1: discovers and serves the union when a cliff hit has cached routes', async () => {
      const cached = makeRoute(973);
      const fresh = makeRoute(974);
      const run = await runCase({
        cached: [cached],
        fresh: [fresh],
        cliff: true,
      });
      const response = await run.quote();
      expect(response.error).toBeUndefined();
      expect(run.getDiscoveryCalls()).toBe(1);
      expect(run.seenRoutes[0].map(route => route.poolPathKey())).toEqual(
        [fresh, cached].map(route => route.poolPathKey())
      );
      expect(
        run.metrics.has('Call', 'cachedRoutesStatus:hitWithDiscovery')
      ).toBe(true);
    });

    it('p1: starts both cache reads before the cliff resolves', async () => {
      let releaseCliff: () => void = () => undefined;
      const cliffReadGate = new Promise<void>(resolve => {
        releaseCliff = resolve;
      });
      let routesReadRequested = false;
      const run = await runCase({
        cached: [],
        fresh: [],
        cliff: true,
        cliffReadGate,
        onCacheRead: () => {
          routesReadRequested = true;
          releaseCliff();
        },
      });
      const response = await run.quote();
      expect(routesReadRequested).toBe(true);
      expect(response.error?.code).toBe(404);
      expect(run.getDiscoveryCalls()).toBe(0);
    });

    it('keeps all eight cached routes after 100 fresh routes', async () => {
      const cached = Array.from({length: 8}, (_, index) =>
        makeRoute(index + 11)
      );
      const fresh = Array.from({length: 100}, (_, index) =>
        makeRoute(index + 101)
      );
      const run = await runCase({cached, fresh});
      await run.quote();
      expect(run.seenRoutes[0]).toHaveLength(108);
      // The cache repository scores and sorts routes; equal scores retain
      // the Redis read order, which is not fixed across runs.
      expect(
        run.seenRoutes[0]
          .slice(-8)
          .map(route => route.poolPathKey())
          .sort()
      ).toEqual(cached.map(route => route.poolPathKey()).sort());
    });

    it('appends a cached match beyond the fresh cap and lets it win', async () => {
      const fresh = Array.from({length: 101}, (_, index) =>
        makeRoute(index + 1300)
      );
      const cached = makeRoute(1400);
      const run = await runCase({
        cached: [cached],
        fresh,
        maxRoutes: 100,
        unfilteredCached: true,
        droppedRoutes: 1,
        droppedRoutePoolPathKeys: [fresh[0].poolPathKey()],
        amounts: new Map([[cached.poolPathKey(), 2000000000n]]),
      });
      const response = await run.quote();
      expect(run.seenRoutes[0]).toHaveLength(101);
      expect(run.seenRoutes[0][100]).toBe(cached);
      expect(response.quoteAmount).toBe('2000000000');
      expect(
        run.metrics.has(
          'CachedRoutes.HitDiscovery.PartialDrop',
          'winner:cached'
        )
      ).toBe(true);
    });

    it('quotes one fresh instance when a cached match survives the cap', async () => {
      const cached = makeRoute(1401);
      const freshMatch = makeRoute(1401);
      const run = await runCase({
        cached: [cached],
        fresh: [freshMatch, makeRoute(1402)],
        unfilteredCached: true,
        amounts: new Map([[cached.poolPathKey(), 2000000000n]]),
      });
      const response = await run.quote();
      expect(run.seenRoutes[0]).toHaveLength(2);
      expect(run.seenRoutes[0][0]).toBe(freshMatch);
      expect(response.quoteAmount).toBe('2000000000');
      expect(response.hitsCachedRoutes).toBe(true);
      expect(
        run.metrics.has('CachedRoutes.FreshContribution', 'band:none')
      ).toBe(true);
    });

    it('passes one overlapping route into the real quote strategy', async () => {
      const cached = makeRoute(1403);
      const freshMatch = makeRoute(1403);
      const run = await runCase({
        cached: [cached],
        fresh: [freshMatch],
        unfilteredCached: true,
        useRealStrategy: true,
      });
      const response = await run.quote();
      expect(response.error).toBeUndefined();
      expect(
        run.logs.some(
          log =>
            log.msg === 'Starting fetchQuotes' && log.extra.totalPctRoutes === 1
        )
      ).toBe(true);
      expect(
        run.logs.some(
          log => log.msg === 'DeepQuoteStrategy deduped duplicate quotes'
        )
      ).toBe(false);
    });

    it('bounds appended routes when a cache read returns more than both keys allow', async () => {
      const bound =
        serviceConfig.CachedRoutes.CachedRoutesToKeepAfterScoring * 2;
      const cached = Array.from({length: bound + 3}, (_, index) =>
        makeRoute(index + 1100)
      );
      const run = await runCase({
        cached,
        fresh: [makeRoute(1200)],
        unfilteredCached: true,
      });
      await run.quote();
      expect(run.seenRoutes[0]).toHaveLength(bound + 1);
      expect(
        run.seenRoutes[0].slice(1).map(route => route.poolPathKey())
      ).toEqual(cached.slice(0, bound).map(route => route.poolPathKey()));
    });

    it('caps 100 fresh aggregator-hook routes before appending an ordinary cached route', async () => {
      const cached = makeRoute(501);
      const fresh = Array.from(
        {length: 100},
        (_, index) =>
          new RouteBasic(Protocol.V4, [
            new V4Pool(
              wrappedEth,
              usdc,
              3000,
              60,
              '0xaaaa000000000000000000000000000000000001',
              1n,
              `0x${(index + 1).toString(16).padStart(64, '0')}`,
              1n,
              0n
            ),
          ])
      );
      const run = await runCase({cached: [cached], fresh});
      await run.quote();
      expect(run.seenRoutes[0]).toHaveLength(101);
      expect(
        run.seenRoutes[0].slice(0, 100).map(route => route.poolPathKey())
      ).toEqual(fresh.map(route => route.poolPathKey()));
      expect(run.seenRoutes[0][100].poolPathKey()).toBe(cached.poolPathKey());
    });

    it('caps a flag-on miss with 120 fresh routes at 100', async () => {
      const fresh = Array.from({length: 120}, (_, index) =>
        makeRoute(index + 601)
      );
      const run = await runCase({cached: [], fresh, maxRoutes: 100});
      await run.quote();
      expect(run.seenRoutes[0]).toHaveLength(100);
    });

    it('still caps a flag-off hit with 12 cached routes at eight', async () => {
      const cached = Array.from({length: 12}, (_, index) =>
        makeRoute(index + 801)
      );
      const run = await runCase({
        cached,
        fresh: [],
        hitDiscoveryEnabled: false,
        maxRoutes: 8,
      });
      await run.quote();
      expect(run.seenRoutes[0]).toHaveLength(8);
    });

    it('starts discovery while the cache read is pending', async () => {
      let releaseCache: () => void = () => undefined;
      const cacheReadGate = new Promise<void>(resolve => {
        releaseCache = resolve;
      });
      const run = await runCase({
        cached: [makeRoute(901)],
        fresh: [makeRoute(902)],
        cacheReadGate,
      });
      const responsePromise = run.quote();
      await vi.waitFor(() => expect(run.getDiscoveryCalls()).toBe(1));
      expect(run.seenRoutes).toHaveLength(0);
      releaseCache();
      await responsePromise;
    });

    it('does not start rejected discovery when a pending cache read short-circuits', async () => {
      let releaseCache: () => void = () => undefined;
      const cacheReadGate = new Promise<void>(resolve => {
        releaseCache = resolve;
      });
      const run = await runCase({
        cached: [],
        fresh: [],
        error: new Error('discovery failed'),
        cliff: true,
        cacheReadGate,
      });
      const responsePromise = run.quote();
      await Promise.resolve();
      releaseCache();
      const response = await responsePromise;
      expect(response.error?.code).toBe(404);
      expect(run.getDiscoveryCalls()).toBe(0);
    });

    it('returns a negative-cache short circuit without calling discovery', async () => {
      const run = await runCase({
        cached: [],
        fresh: [],
        cliff: true,
      });
      const response = await run.quote();
      expect(response.error?.code).toBe(404);
      expect(run.getDiscoveryCalls()).toBe(0);
      expect(run.metrics.has('CachedRoutes.HitDiscovery')).toBe(false);
    });

    it('propagates a rejected fresh arm on a flag-on miss', async () => {
      const run = await runCase({
        cached: [],
        fresh: [],
        error: new Error('miss discovery failed'),
      });
      await expect(run.quote()).rejects.toThrow('miss discovery failed');
    });

    it('serves degraded fresh routes on a flag-on miss without a hit counter', async () => {
      const run = await runCase({
        cached: [],
        fresh: [makeRoute(903)],
        degradedReasons: [DiscoveryDegradedReason.PROBE_ERROR],
      });
      const response = await run.quote();
      expect(response.error).toBeUndefined();
      expect(run.seenRoutes[0]).toHaveLength(1);
      expect(
        run.metrics.calls.filter(
          call => call.name === buildMetricKey('CachedRoutes.HitDiscovery')
        )
      ).toHaveLength(0);
    });

    it.each([
      {improvementBps: 49, band: 'lt50'},
      {improvementBps: 50, band: '50_500'},
      {improvementBps: 500, band: '50_500'},
      {improvementBps: 501, band: 'gt500'},
    ])(
      'counts the $band contribution at $improvementBps bps once',
      async ({improvementBps, band}) => {
        const cached = makeRoute(910);
        const fresh = makeRoute(911);
        const run = await runCase({
          cached: [cached],
          fresh: [fresh],
          amounts: new Map([
            [cached.poolPathKey(), 1000000000n],
            [
              fresh.poolPathKey(),
              1000000000n + BigInt(improvementBps) * 100000n,
            ],
          ]),
        });
        await run.quote();
        const counts = run.metrics.calls.filter(
          call => call.name === buildMetricKey('CachedRoutes.FreshContribution')
        );
        expect(counts).toHaveLength(1);
        expect(counts[0].tags).toContain(`band:${band}`);
      }
    );

    it('counts none once when the cached candidate wins', async () => {
      const cached = makeRoute(912);
      const fresh = makeRoute(913);
      const run = await runCase({
        cached: [cached],
        fresh: [fresh],
        amounts: new Map([
          [cached.poolPathKey(), 1000000000n],
          [fresh.poolPathKey(), 900000000n],
        ]),
      });
      await run.quote();
      const counts = run.metrics.calls.filter(
        call => call.name === buildMetricKey('CachedRoutes.FreshContribution')
      );
      expect(counts).toHaveLength(1);
      expect(counts[0].tags).toContain('band:none');
    });

    it('counts a route that is both cached and fresh as cached for FreshContribution', async () => {
      // The capped fresh instance covers the cached key, while provenance
      // still records the cache read for FreshContribution.
      const cachedDuplicate = makeRoute(950);
      const extraCached = makeRoute(951);
      const freshDuplicate = makeRoute(950, 10);
      const run = await runCase({
        cached: [cachedDuplicate, extraCached],
        fresh: [freshDuplicate],
        amounts: new Map([
          [cachedDuplicate.poolPathKey(), 2000000000n],
          [extraCached.poolPathKey(), 1000000000n],
        ]),
      });
      const response = await run.quote();
      expect(response.quoteAmount).toBe('2000000000');
      expect(
        run.metrics.has('CachedRoutes.FreshContribution', 'band:none')
      ).toBe(true);
    });

    it('counts a band on a full-overlap hit', async () => {
      // The cached candidate marks the call as a hit even though the capped
      // fresh instance covers it. Provenance still measures fresh uplift.
      const cachedAndFresh = makeRoute(952);
      const freshOverlap = makeRoute(952);
      const freshOnly = makeRoute(953);
      const run = await runCase({
        cached: [cachedAndFresh],
        fresh: [freshOverlap, freshOnly],
        amounts: new Map([
          [cachedAndFresh.poolPathKey(), 1000000000n],
          [freshOnly.poolPathKey(), 1600000000n],
        ]),
      });
      const response = await run.quote();
      expect(response.quoteAmount).toBe('1600000000');
      expect(
        run.metrics.has('Call', 'cachedRoutesStatus:hitWithDiscovery')
      ).toBe(true);
      const counts = run.metrics.calls.filter(
        call => call.name === buildMetricKey('CachedRoutes.FreshContribution')
      );
      expect(counts).toHaveLength(1);
      expect(counts[0].tags).toContain('band:gt500');
    });

    it('counts unavailable once without an all-cached quote candidate', async () => {
      const cached = makeRoute(914);
      const fresh = makeRoute(915);
      const run = await runCase({
        cached: [cached],
        fresh: [fresh],
        candidates: () => [
          new QuoteSplit([new QuoteBasic(fresh, 1000000000n)]),
        ],
      });
      await run.quote();
      const counts = run.metrics.calls.filter(
        call => call.name === buildMetricKey('CachedRoutes.FreshContribution')
      );
      expect(counts).toHaveLength(1);
      expect(counts[0].tags).toContain('band:unavailable');
      // `unavailable` is a failure to observe a comparison, not a successful
      // measurement of "no uplift" — it must not carry status:success.
      expect(counts[0].tags).toContain('status:failure');
      expect(counts[0].tags).toContain('reason:unavailable');
      expect(counts[0].tags).not.toContain('status:success');
    });

    it('uses the lower input for EXACT_OUT contribution', async () => {
      const cached = makeRoute(916);
      const fresh = makeRoute(917);
      const run = await runCase({
        cached: [cached],
        fresh: [fresh],
        tradeType: 'EXACT_OUT',
        amounts: new Map([
          [cached.poolPathKey(), 1000000000n],
          [fresh.poolPathKey(), 950000000n],
        ]),
      });
      const response = await run.quote();
      expect(response.quoteAmount).toBe('950000000');
      const counts = run.metrics.calls.filter(
        call => call.name === buildMetricKey('CachedRoutes.FreshContribution')
      );
      expect(counts).toHaveLength(1);
      expect(counts[0].tags).toContain('band:50_500');
    });

    it('contains rejected advisory telemetry writes', async () => {
      const cached = makeRoute(918);
      const fresh = makeRoute(919);
      const run = await runCase({
        cached: [cached],
        fresh: [fresh],
        rejectAdvisoryMetrics: true,
      });
      const response = await run.quote();
      expect(response.error).toBeUndefined();
    });

    it('reprices cached and fresh pools through the real quote strategy', async () => {
      const cached = makeRoute(920);
      const fresh = makeRoute(921);
      const run = await runCase({
        cached: [cached],
        fresh: [fresh],
        useRealStrategy: true,
        amounts: new Map([
          [cached.poolPathKey(), 900000000n],
          [fresh.poolPathKey(), 1100000000n],
        ]),
      });
      const response = await run.quote();
      expect(response.quoteAmount).toBe('1100000000');
      expect(response.route[0].pools[0].address).toBe(
        fresh.path[0].address.toString()
      );
    });

    it('appends routes read from both native-token cache keys', async () => {
      const wrapped = makeRoute(30);
      const native = makeRoute(31);
      const fresh = makeRoute(32);
      const run = await runCase({
        cached: [wrapped],
        nativeCached: [native],
        fresh: [fresh],
      });
      await run.quote();
      expect(run.seenRoutes[0].map(route => route.poolPathKey())).toEqual(
        [fresh, wrapped, native].map(route => route.poolPathKey())
      );
    });

    it('keeps the cached-only path when hit discovery is disabled', async () => {
      const cached = makeRoute(19);
      const run = await runCase({
        cached: [cached],
        fresh: [makeRoute(20)],
        hitDiscoveryEnabled: false,
      });
      await run.quote();
      expect(run.getDiscoveryCalls()).toBe(0);
      expect(run.seenRoutes[0].map(route => route.poolPathKey())).toEqual([
        cached.poolPathKey(),
      ]);
    });

    it('runs discovery on a hit when the chain is in the allowlist', async () => {
      const cached = makeRoute(21);
      const fresh = makeRoute(22);
      const run = await runCase({
        cached: [cached],
        fresh: [fresh],
        hitDiscoveryChains: new Set([ChainId.MAINNET, ChainId.ROBINHOOD]),
      });
      await run.quote();
      expect(run.getDiscoveryCalls()).toBe(1);
      expect(run.seenRoutes[0].map(route => route.poolPathKey())).toEqual([
        fresh.poolPathKey(),
        cached.poolPathKey(),
      ]);
      expect(
        run.metrics.has('Call', 'cachedRoutesStatus:hitWithDiscovery')
      ).toBe(true);
      expect(
        run.metrics.has('CachedRoutes.HitDiscovery', 'outcome:routes')
      ).toBe(true);
    });

    it('keeps the cached-only hit path when the chain is outside the allowlist', async () => {
      const cached = makeRoute(23);
      const run = await runCase({
        cached: [cached],
        fresh: [makeRoute(24)],
        hitDiscoveryChains: new Set([ChainId.ROBINHOOD]),
      });
      await run.quote();
      expect(run.getDiscoveryCalls()).toBe(0);
      expect(run.seenRoutes[0].map(route => route.poolPathKey())).toEqual([
        cached.poolPathKey(),
      ]);
      expect(run.metrics.has('Call', 'cachedRoutesStatus:hit')).toBe(true);
      expect(run.metrics.has('CachedRoutes.HitDiscovery')).toBe(false);
    });

    it('keeps the cached-only hit path when the boolean is off even on a listed chain', async () => {
      const cached = makeRoute(25);
      const run = await runCase({
        cached: [cached],
        fresh: [makeRoute(26)],
        hitDiscoveryEnabled: false,
        hitDiscoveryChains: new Set([ChainId.MAINNET]),
      });
      await run.quote();
      expect(run.getDiscoveryCalls()).toBe(0);
      expect(run.metrics.has('CachedRoutes.HitDiscovery')).toBe(false);
    });
  });
});
