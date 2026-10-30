import {afterEach, describe, beforeEach, it, expect, vi} from 'vitest';
import {
  BaseCachingPoolDiscoverer,
  EMPTY_POOLS_FOR_TOKENS_CACHE_TTL_SECONDS,
  POOLS_FOR_TOKENS_CACHE_VALUE_MAX_BYTES,
  SnapshotLoad,
  SnapshotLoadStatus,
} from './BaseCachingPoolDiscoverer';
import {ChainId} from '../../lib/config';
import {Protocol} from '../../models/pool/Protocol';
import {Context} from '@uniswap/lib-uni/context';
import {
  IPoolSnapshotWarmer,
  isPoolsArrayMemoStable,
  ITopPoolsSelector,
  markPoolsForTokensUncacheable,
  PoolsForTokensCacheDirective,
  PoolsForTokensCacheSkipReason,
  UniPoolInfo,
} from './interface';
import {IRedisCache, InMemoryRedisCache, SetOpts} from '@uniswap/lib-cache';
import {Address} from '../../models/address/Address';
import {
  buildMetricKey,
  getUniRouteTestConfig,
  IUniRouteServiceConfig,
} from '../../lib/config';
import {HooksOptions} from '../../models/hooks/HooksOptions';
import {FeatureGatedTokensRepository} from '../../stores/compliance/FeatureGatedTokensRepository';
import {CanonicalPools} from '../../lib/CanonicalPools';
import {
  EMPTY_NAMESPACE_CONTEXT,
  RouteNamespaceContext,
} from '../../models/hooks/namespaces';
import {buildTestContext} from '@uniswap/lib-testhelpers';

class TestTopPoolsSelector implements ITopPoolsSelector<UniPoolInfo> {
  async filterPools(
    pools: UniPoolInfo[],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    chainId: ChainId,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    tokenIn: Address,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    tokenOut: Address,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    protocol: Protocol,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    hooksOptions: HooksOptions | undefined,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    nsCtx: RouteNamespaceContext,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ctx: Context,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    cacheDirective: PoolsForTokensCacheDirective
  ): Promise<UniPoolInfo[]> {
    return Promise.resolve(pools);
  }
}

/**
 * Selector that flips cacheDirective.shouldUseCache to false with the
 * permissioned-hook reason. Stands in for the BasicTopPoolsSelector
 * branch where maybeDropPermissionedPools flips the directive when the
 * namespace is inactive but a permissioned-hook pool was encountered.
 */
class CacheSuppressingTopPoolsSelector implements ITopPoolsSelector<UniPoolInfo> {
  async filterPools(
    pools: UniPoolInfo[],
    _chainId: ChainId,
    _tokenIn: Address,
    _tokenOut: Address,
    _protocol: Protocol,
    _hooksOptions: HooksOptions | undefined,
    _nsCtx: RouteNamespaceContext,
    _ctx: Context,
    cacheDirective: PoolsForTokensCacheDirective
  ): Promise<UniPoolInfo[]> {
    markPoolsForTokensUncacheable(
      cacheDirective,
      PoolsForTokensCacheSkipReason.PermissionedHookInactiveNamespace
    );
    return Promise.resolve(pools);
  }
}

class TestPoolDiscoverer extends BaseCachingPoolDiscoverer<UniPoolInfo> {
  constructor(
    protected serviceConfig: IUniRouteServiceConfig,
    protected getPoolsCache: IRedisCache<string, string>,
    protected getPoolsForTokensCache: IRedisCache<string, string>,
    protected featureGatedTokensRepository: FeatureGatedTokensRepository = FeatureGatedTokensRepository.empty()
  ) {
    super(
      serviceConfig,
      getPoolsCache,
      getPoolsForTokensCache,
      featureGatedTokensRepository,
      'TestPoolDiscoverer'
    );
  }

  protected getDiscovererName(): string {
    return 'TestPoolDiscoverer';
  }

  protected async _getPools(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    chainId: ChainId,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    protocol: Protocol,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ctx: Context
  ): Promise<UniPoolInfo[]> {
    return [
      {
        id: 'test-pool',
        feeTier: '3000',
        tickSpacing: '1',
        hooks: '0x1111111111111111111111111111111111111111',
        liquidity: '1000',
        token0: {id: '0x1111111111111111111111111111111111111111'},
        token1: {id: '0x2222222222222222222222222222222222222222'},
        tvlETH: 1000,
        tvlUSD: 1000,
      },
    ];
  }

  protected async _getPoolsForTokens(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    chainId: ChainId,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    protocol: Protocol,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    tokenIn: Address,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    tokenOut: Address,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ctx: Context
  ): Promise<UniPoolInfo[]> {
    return [
      {
        id: 'test-pool-for-tokens',
        feeTier: '3000',
        tickSpacing: '1',
        hooks: '0x1111111111111111111111111111111111111111',
        liquidity: '1000',
        token0: {id: '0x1111111111111111111111111111111111111111'},
        token1: {id: '0x2222222222222222222222222222222222222222'},
        tvlETH: 1000,
        tvlUSD: 1000,
      },
    ];
  }
}

class ClosurePoolDiscoverer extends BaseCachingPoolDiscoverer<UniPoolInfo> {
  constructor(
    protected serviceConfig: IUniRouteServiceConfig,
    protected getPoolsCache: IRedisCache<string, string>,
    protected getPoolsForTokensCache: IRedisCache<string, string>,
    private readonly loadPools: () => Promise<UniPoolInfo[]>,
    protected featureGatedTokensRepository: FeatureGatedTokensRepository = FeatureGatedTokensRepository.empty()
  ) {
    super(
      serviceConfig,
      getPoolsCache,
      getPoolsForTokensCache,
      featureGatedTokensRepository,
      'ClosurePoolDiscoverer'
    );
  }

  protected getDiscovererName(): string {
    return 'ClosurePoolDiscoverer';
  }

  protected async _getPools(): Promise<UniPoolInfo[]> {
    return this.loadPools();
  }

  protected async _getPoolsForTokens(): Promise<UniPoolInfo[]> {
    return [];
  }
}

// Answers `unchanged` when asked about the version it currently serves, the
// way S3 answers 304 to If-None-Match on the same ETag, and records what it
// was asked about.
class VersionedPoolDiscoverer extends ClosurePoolDiscoverer {
  public readonly knownVersions: (string | undefined)[] = [];
  public conditionalLoadGate: Promise<void> | undefined;

  constructor(
    serviceConfig: IUniRouteServiceConfig,
    getPoolsCache: IRedisCache<string, string>,
    getPoolsForTokensCache: IRedisCache<string, string>,
    loadPools: () => Promise<UniPoolInfo[]>,
    public sourceVersion: string | undefined,
    featureGatedTokensRepository?: FeatureGatedTokensRepository
  ) {
    super(
      serviceConfig,
      getPoolsCache,
      getPoolsForTokensCache,
      loadPools,
      featureGatedTokensRepository
    );
  }

  protected override async loadSnapshot(
    _chainId: ChainId,
    _protocol: Protocol,
    knownVersion: string | undefined,
    _ctx: Context
  ): Promise<SnapshotLoad<UniPoolInfo>> {
    this.knownVersions.push(knownVersion);
    if (knownVersion !== undefined && knownVersion === this.sourceVersion) {
      if (this.conditionalLoadGate !== undefined) {
        await this.conditionalLoadGate;
      }
      return {status: SnapshotLoadStatus.UNCHANGED};
    }
    return {
      status: SnapshotLoadStatus.LOADED,
      pools: await this._getPools(),
      sourceVersion: this.sourceVersion,
    };
  }
}

// Hands out the same deny-list payload until `globalSet` is reassigned, the
// way the real repository shares one content-addressed payload per list.
class SwitchableDenyListRepository extends FeatureGatedTokensRepository {
  public globalSet = new Set<string>();

  constructor() {
    super(
      {fetchAll: async () => ({tokens: [], skippedUnsupportedChains: 0})},
      {fetch: async () => []}
    );
  }

  override async getSnapshot(snapshotCtx: Context) {
    const base = await super.getSnapshot(snapshotCtx);
    return {...base, globalSet: this.globalSet};
  }
}

const createDeferred = <T>() => {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return {promise, resolve, reject};
};

// Applies each write immediately, then holds the write's promise open while
// `gate` is set, so a test can observe state while a cache write is in flight.
class GatedRedisCache extends InMemoryRedisCache<string, string> {
  public gate: Promise<void> | undefined;
  public writeCount = 0;

  override async set(
    key: string,
    value: string,
    opts?: Partial<SetOpts>
  ): Promise<void> {
    this.writeCount += 1;
    await super.set(key, value, opts);
    if (this.gate !== undefined) {
      await this.gate;
    }
  }
}

describe('BaseCachingPoolDiscoverer', () => {
  let getPoolsCache: IRedisCache<string, string>;
  let getPoolsForTokensCache: IRedisCache<string, string>;
  let poolDiscoverer: TestPoolDiscoverer;
  let ctx: Context;
  const serviceConfig = getUniRouteTestConfig();
  const topPoolSelector = new TestTopPoolsSelector();

  beforeEach(() => {
    getPoolsCache = {
      get: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockResolvedValue(undefined),
    } as unknown as IRedisCache<string, string>;

    getPoolsForTokensCache = {
      get: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockResolvedValue(undefined),
    } as unknown as IRedisCache<string, string>;

    poolDiscoverer = new TestPoolDiscoverer(
      serviceConfig,
      getPoolsCache,
      getPoolsForTokensCache
    );

    ctx = {
      metrics: {
        count: vi.fn(),
        dist: vi.fn(),
      },
      logger: {
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    } as unknown as Context;
  });

  it('should return pools from cache if available', async () => {
    const chainId = ChainId.MAINNET;
    const protocol = Protocol.V2;
    const cachedPools = [
      {
        id: 'cached-pool',
        feeTier: '3000',
        tickSpacing: '1',
        hooks: '0x1111111111111111111111111111111111111111',
        liquidity: '1000',
        token0: {id: '0x1111111111111111111111111111111111111111'},
        token1: {id: '0x2222222222222222222222222222222222222222'},
        tvlETH: 1000,
        tvlUSD: 1000,
      },
    ];

    getPoolsCache.get = vi.fn().mockResolvedValue(JSON.stringify(cachedPools));

    const pools = await poolDiscoverer.getPools(chainId, protocol, ctx);

    expect(pools).toEqual(cachedPools);
    expect(ctx.metrics.count).toHaveBeenCalledWith(expect.any(String), 1, {
      tags: ['result', 'hit'],
    });
  });

  it('should fetch pools and cache them if not available in cache', async () => {
    const chainId = ChainId.MAINNET;
    const protocol = Protocol.V2;
    const expectedPools = [
      {
        id: 'test-pool',
        feeTier: '3000',
        tickSpacing: '1',
        hooks: '0x1111111111111111111111111111111111111111',
        liquidity: '1000',
        token0: {id: '0x1111111111111111111111111111111111111111'},
        token1: {id: '0x2222222222222222222222222222222222222222'},
        tvlETH: 1000,
        tvlUSD: 1000,
      },
    ];

    const pools = await poolDiscoverer.getPools(chainId, protocol, ctx);

    expect(pools).toEqual(expectedPools);
    expect(getPoolsCache.set).toHaveBeenCalledWith(
      expect.any(String),
      JSON.stringify(expectedPools),
      expect.any(Object)
    );
    expect(ctx.metrics.count).toHaveBeenCalledWith(expect.any(String), 1, {
      tags: ['result', 'miss'],
    });
  });

  it('should return pools for tokens from cache if available', async () => {
    const chainId = ChainId.MAINNET;
    const protocol = Protocol.V2;
    const tokenIn = new Address('0x1111111111111111111111111111111111111111');
    const tokenOut = new Address('0x2222222222222222222222222222222222222222');
    const cachedPools = [
      {
        id: 'cached-pool-for-tokens',
        feeTier: '3000',
        tickSpacing: '1',
        hooks: '0x1111111111111111111111111111111111111111',
        liquidity: '1000',
        token0: {id: '0x1111111111111111111111111111111111111111'},
        token1: {id: '0x2222222222222222222222222222222222222222'},
        tvlETH: 1000,
        tvlUSD: 1000,
      },
    ];

    getPoolsForTokensCache.get = vi
      .fn()
      .mockResolvedValue(JSON.stringify(cachedPools));

    const pools = await poolDiscoverer.getPoolsForTokens(
      chainId,
      protocol,
      tokenIn,
      tokenOut,
      topPoolSelector,
      undefined,
      false,
      EMPTY_NAMESPACE_CONTEXT,
      ctx
    );

    expect(pools).toEqual(cachedPools);
    expect(ctx.metrics.count).toHaveBeenCalledWith(expect.any(String), 1, {
      tags: [
        'result:hit',
        `protocol:${protocol}`,
        `hooksOptions:${HooksOptions.HOOKS_INCLUSIVE}`,
      ],
    });
  });

  it('re-applies the canonical-pools rule to a cached pools-for-tokens hit', async () => {
    // The cached list predates the token's entry: only the canonical pool
    // may come back, without waiting for the TTL.
    const chainId = ChainId.MAINNET;
    const tokenIn = new Address('0x1111111111111111111111111111111111111111');
    const tokenOut = new Address('0x2222222222222222222222222222222222222222');
    const canonicalPool = {
      id: 'canonical-pool',
      feeTier: '3000',
      tickSpacing: '1',
      hooks: '0x1111111111111111111111111111111111111111',
      liquidity: '1000',
      token0: {id: tokenIn.address},
      token1: {id: tokenOut.address},
      tvlETH: 1000,
      tvlUSD: 1000,
    };
    const nonCanonicalPool = {...canonicalPool, id: 'hookless-pool'};
    getPoolsForTokensCache.get = vi
      .fn()
      .mockResolvedValue(JSON.stringify([nonCanonicalPool, canonicalPool]));
    CanonicalPools.__TEST_ONLY__injectTestData({
      [chainId]: {[tokenIn.address]: [canonicalPool.id]},
    });

    try {
      const pools = await poolDiscoverer.getPoolsForTokens(
        chainId,
        Protocol.V4,
        tokenIn,
        tokenOut,
        topPoolSelector,
        undefined,
        false,
        EMPTY_NAMESPACE_CONTEXT,
        ctx
      );

      expect(pools).toEqual([canonicalPool]);
    } finally {
      CanonicalPools.__TEST_ONLY__injectTestData();
    }
  });

  describe('routing block list on a cached pools-for-tokens hit', () => {
    const hookr = new Address('0x18e674231a58c239dc7daedcffe15ec3a24cff5c');
    const weth = new Address('0x0bd7d308f8e1639fab988df18a8011f41eacad73');
    const cachedPool = (id: string, token0: string, token1: string) => ({
      id,
      feeTier: '100',
      tickSpacing: '1',
      hooks: '0x0000000000000000000000000000000000000000',
      liquidity: '1000',
      token0: {id: token0},
      token1: {id: token1},
      tvlETH: 1000,
      tvlUSD: 1000,
    });
    // wHOOKR appears checksummed in one pool and lowercase in the other.
    const wrapperPools = [
      cachedPool(
        '0xdd0ebece3c0cca47a21e552da73a8a0a1f14f613',
        hookr.address,
        '0x0cB7b36476d577C683f7Ec03994ddC0e006a97bd'
      ),
      cachedPool(
        '0x7aa37359d6d6ed87f6762b91ba3d57bcac91dac3',
        '0x0cb7b36476d577c683f7ec03994ddc0e006a97bd',
        weth.address
      ),
    ];
    const directPool = cachedPool(
      '0xd8b750f564321ce68b4b3d8498616da96fad798d',
      hookr.address,
      weth.address
    );
    const blockedMetric = buildMetricKey(
      'PoolDiscoverer.getPoolsForTokens.BlockedRoutingTokenPool'
    );
    const readCachedHit = (chainId: ChainId) =>
      poolDiscoverer.getPoolsForTokens(
        chainId,
        Protocol.V3,
        hookr,
        weth,
        topPoolSelector,
        undefined,
        false,
        EMPTY_NAMESPACE_CONTEXT,
        ctx
      );

    beforeEach(() => {
      getPoolsForTokensCache.get = vi
        .fn()
        .mockResolvedValue(JSON.stringify([...wrapperPools, directPool]));
      // The drop counter is fire-and-forget and chains .catch on the result.
      vi.mocked(ctx.metrics.count).mockResolvedValue(undefined);
    });

    it('drops pools through wHOOKR on Robinhood and counts them', async () => {
      const pools = await readCachedHit(ChainId.ROBINHOOD);

      expect(pools).toEqual([directPool]);
      expect(ctx.metrics.count).toHaveBeenCalledWith(blockedMetric, 2, {
        tags: ['chain:ROBINHOOD', 'status:success'],
      });
    });

    it('serves the same cached pools on a chain where wHOOKR is not listed', async () => {
      const pools = await readCachedHit(ChainId.MAINNET);

      expect(pools).toEqual([...wrapperPools, directPool]);
      expect(ctx.metrics.count).not.toHaveBeenCalledWith(
        blockedMetric,
        expect.anything(),
        expect.anything()
      );
    });
  });

  it('should fetch pools for tokens and cache them if not available in cache', async () => {
    const chainId = ChainId.MAINNET;
    const protocol = Protocol.V2;
    const tokenIn = new Address('0x1111111111111111111111111111111111111111');
    const tokenOut = new Address('0x2222222222222222222222222222222222222222');
    const expectedPools = [
      {
        id: 'test-pool-for-tokens',
        feeTier: '3000',
        tickSpacing: '1',
        hooks: '0x1111111111111111111111111111111111111111',
        liquidity: '1000',
        token0: {id: '0x1111111111111111111111111111111111111111'},
        token1: {id: '0x2222222222222222222222222222222222222222'},
        tvlETH: 1000,
        tvlUSD: 1000,
      },
    ];

    const pools = await poolDiscoverer.getPoolsForTokens(
      chainId,
      protocol,
      tokenIn,
      tokenOut,
      topPoolSelector,
      undefined,
      false,
      EMPTY_NAMESPACE_CONTEXT,
      ctx
    );

    expect(pools).toEqual(expectedPools);
    expect(getPoolsForTokensCache.set).toHaveBeenCalledWith(
      expect.any(String),
      JSON.stringify(expectedPools),
      expect.any(Object)
    );
    expect(ctx.metrics.dist).toHaveBeenCalledWith(
      expect.stringContaining('TopPoolsSelector.filterPools.Latency.dist'),
      expect.any(Number),
      {tags: ['chain:MAINNET', `protocol:${protocol}`]}
    );
    expect(ctx.metrics.count).toHaveBeenCalledWith(expect.any(String), 1, {
      tags: [
        'result:miss',
        `protocol:${protocol}`,
        `hooksOptions:${HooksOptions.HOOKS_INCLUSIVE}`,
      ],
    });
  });

  it('should throw when getPools is called with an unsupported protocol', async () => {
    const chainId = ChainId.MAINNET;

    await expect(
      poolDiscoverer.getPools(chainId, Protocol.CURVESTABLESWAP, ctx)
    ).rejects.toThrow('Unsupported protocol');
  });

  it('should throw when getPoolsForTokens is called with an unsupported protocol', async () => {
    const chainId = ChainId.MAINNET;
    const tokenIn = new Address('0x1111111111111111111111111111111111111111');
    const tokenOut = new Address('0x2222222222222222222222222222222222222222');

    await expect(
      poolDiscoverer.getPoolsForTokens(
        chainId,
        Protocol.FLUIDDEXT1,
        tokenIn,
        tokenOut,
        topPoolSelector,
        undefined,
        false,
        EMPTY_NAMESPACE_CONTEXT,
        ctx
      )
    ).rejects.toThrow('Unsupported protocol');
  });

  it('should skip cache write, debug-log, and emit SkipWrite metric when getPoolsForTokens cache value exceeds size limit', async () => {
    const chainId = ChainId.MAINNET;
    const protocol = Protocol.V2;
    const tokenIn = new Address('0x1111111111111111111111111111111111111111');
    const tokenOut = new Address('0x2222222222222222222222222222222222222222');

    // Build a payload large enough to exceed the limit when JSON.stringify'd.
    const padding = 'x'.repeat(POOLS_FOR_TOKENS_CACHE_VALUE_MAX_BYTES + 1024);
    const oversizedPool = {
      id: padding,
      feeTier: '3000',
      tickSpacing: '1',
      hooks: '0x1111111111111111111111111111111111111111',
      liquidity: '1000',
      token0: {id: '0x1111111111111111111111111111111111111111'},
      token1: {id: '0x2222222222222222222222222222222222222222'},
      tvlETH: 1000,
      tvlUSD: 1000,
    };

    class OversizedPoolDiscoverer extends TestPoolDiscoverer {
      protected async _getPoolsForTokens(): Promise<UniPoolInfo[]> {
        return [oversizedPool];
      }
    }
    const oversizedDiscoverer = new OversizedPoolDiscoverer(
      serviceConfig,
      getPoolsCache,
      getPoolsForTokensCache
    );

    const pools = await oversizedDiscoverer.getPoolsForTokens(
      chainId,
      protocol,
      tokenIn,
      tokenOut,
      topPoolSelector,
      undefined,
      false,
      EMPTY_NAMESPACE_CONTEXT,
      ctx
    );

    // The pools are still returned to the caller — the user-facing quote
    // is unaffected; only the cache write is skipped.
    expect(pools).toEqual([oversizedPool]);
    expect(getPoolsForTokensCache.set).not.toHaveBeenCalled();
    expect(ctx.logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('Skipping getPoolsForTokens cache write'),
      expect.objectContaining({
        chainId,
        protocol,
        reason: PoolsForTokensCacheSkipReason.ValueTooLarge,
      })
    );
    expect(ctx.metrics.count).toHaveBeenCalledWith(
      expect.stringContaining(
        'PoolDiscoverer.getPoolsForTokens.Cache.SkipWrite'
      ),
      1,
      {
        tags: [
          `chain:${chainId}`,
          `protocol:${protocol}`,
          `reason:${PoolsForTokensCacheSkipReason.ValueTooLarge}`,
        ],
      }
    );
  });

  it('should not emit SkipWrite metric when getPoolsForTokens cache value is within size limit', async () => {
    const chainId = ChainId.MAINNET;
    const protocol = Protocol.V2;
    const tokenIn = new Address('0x1111111111111111111111111111111111111111');
    const tokenOut = new Address('0x2222222222222222222222222222222222222222');

    await poolDiscoverer.getPoolsForTokens(
      chainId,
      protocol,
      tokenIn,
      tokenOut,
      topPoolSelector,
      undefined,
      false,
      EMPTY_NAMESPACE_CONTEXT,
      ctx
    );

    expect(getPoolsForTokensCache.set).toHaveBeenCalledTimes(1);
    expect(ctx.metrics.count).not.toHaveBeenCalledWith(
      expect.stringContaining(
        'PoolDiscoverer.getPoolsForTokens.Cache.SkipWrite'
      ),
      expect.anything(),
      expect.anything()
    );
  });

  it('should skip cache write and emit SkipWrite metric with permissioned-hook reason when selector flips cacheDirective.shouldUseCache to false', async () => {
    const chainId = ChainId.MAINNET;
    const protocol = Protocol.V4;
    const tokenIn = new Address('0x1111111111111111111111111111111111111111');
    const tokenOut = new Address('0x2222222222222222222222222222222222222222');

    const suppressingSelector = new CacheSuppressingTopPoolsSelector();
    const pools = await poolDiscoverer.getPoolsForTokens(
      chainId,
      protocol,
      tokenIn,
      tokenOut,
      suppressingSelector,
      undefined,
      false,
      EMPTY_NAMESPACE_CONTEXT,
      ctx
    );

    // Pools are still returned to the caller — only the cache write is skipped.
    expect(pools.length).toBeGreaterThan(0);
    expect(getPoolsForTokensCache.set).not.toHaveBeenCalled();
    expect(ctx.metrics.count).toHaveBeenCalledWith(
      expect.stringContaining(
        'PoolDiscoverer.getPoolsForTokens.Cache.SkipWrite'
      ),
      1,
      {
        tags: [
          `chain:${chainId}`,
          `protocol:${protocol}`,
          `reason:${PoolsForTokensCacheSkipReason.PermissionedHookInactiveNamespace}`,
        ],
      }
    );
  });

  it('should skip both read and write when caller passes skipPoolsForTokensCache=true and not emit SkipWrite metric', async () => {
    const chainId = ChainId.MAINNET;
    const protocol = Protocol.V2;
    const tokenIn = new Address('0x1111111111111111111111111111111111111111');
    const tokenOut = new Address('0x2222222222222222222222222222222222222222');

    await poolDiscoverer.getPoolsForTokens(
      chainId,
      protocol,
      tokenIn,
      tokenOut,
      topPoolSelector,
      undefined,
      true, // skipPoolsForTokensCache
      EMPTY_NAMESPACE_CONTEXT,
      ctx
    );

    // Caller-opt-out is by design: no read, no write, no SkipWrite metric noise.
    expect(getPoolsForTokensCache.get).not.toHaveBeenCalled();
    expect(getPoolsForTokensCache.set).not.toHaveBeenCalled();
    expect(ctx.metrics.count).not.toHaveBeenCalledWith(
      expect.stringContaining(
        'PoolDiscoverer.getPoolsForTokens.Cache.SkipWrite'
      ),
      expect.anything(),
      expect.anything()
    );
  });

  it('does not read or write HOOKS_ONLY cache entries when the variant cache flag is enabled', async () => {
    const chainId = ChainId.MAINNET;
    const protocol = Protocol.V4;
    const tokenIn = new Address('0x1111111111111111111111111111111111111111');
    const tokenOut = new Address('0x2222222222222222222222222222222222222222');
    const hooksVariantCacheEnabledConfig: IUniRouteServiceConfig = {
      ...serviceConfig,
      PoolDiscovery: {
        ...serviceConfig.PoolDiscovery,
        PoolsForTokensHooksVariantCacheEnabled: true,
      },
    };
    const hooksOnlyDiscoverer = new TestPoolDiscoverer(
      hooksVariantCacheEnabledConfig,
      getPoolsCache,
      getPoolsForTokensCache
    );

    // A stale HOOKS_ONLY entry must never be served: these lists are
    // experiment-namespace-dependent even when the NO_HOOKS rollout is on.
    getPoolsForTokensCache.get = vi
      .fn()
      .mockResolvedValue(JSON.stringify([{id: 'hooks-only-cache-entry'}]));
    await hooksOnlyDiscoverer.getPoolsForTokens(
      chainId,
      protocol,
      tokenIn,
      tokenOut,
      topPoolSelector,
      HooksOptions.HOOKS_ONLY,
      false,
      EMPTY_NAMESPACE_CONTEXT,
      ctx
    );

    expect(getPoolsForTokensCache.get).not.toHaveBeenCalled();
    expect(getPoolsForTokensCache.set).not.toHaveBeenCalled();
    expect(ctx.metrics.count).toHaveBeenCalledWith(
      expect.stringContaining(
        'PoolDiscoverer.getPoolsForTokens.Cache.SkipWrite'
      ),
      1,
      {
        tags: [
          `chain:${chainId}`,
          `protocol:${protocol}`,
          `reason:${PoolsForTokensCacheSkipReason.HooksOptionsUncacheable}`,
        ],
      }
    );
  });

  it('does not write NO_HOOKS cache entries when the variant cache flag is disabled', async () => {
    const chainId = ChainId.MAINNET;
    const protocol = Protocol.V4;
    const tokenIn = new Address('0x1111111111111111111111111111111111111111');
    const tokenOut = new Address('0x2222222222222222222222222222222222222222');
    const hooksVariantCacheDisabledConfig: IUniRouteServiceConfig = {
      ...serviceConfig,
      PoolDiscovery: {
        ...serviceConfig.PoolDiscovery,
        PoolsForTokensHooksVariantCacheEnabled: false,
      },
    };
    const noHooksDiscoverer = new TestPoolDiscoverer(
      hooksVariantCacheDisabledConfig,
      getPoolsCache,
      getPoolsForTokensCache
    );

    await noHooksDiscoverer.getPoolsForTokens(
      chainId,
      protocol,
      tokenIn,
      tokenOut,
      topPoolSelector,
      HooksOptions.NO_HOOKS,
      false,
      EMPTY_NAMESPACE_CONTEXT,
      ctx
    );

    expect(getPoolsForTokensCache.set).not.toHaveBeenCalled();
  });

  // Regression for the cross-namespace cache-poisoning hazard called out in
  // canIncludePermissionedPool: an inactive-namespace request must not seed a
  // stripped pool list under the namespace-independent POOLSFORTOKENS key, or
  // a later active-namespace request for the same pair gets served the
  // stale-stripped list until the entry expires (~2.5 min, hard ceiling 7 days).
  it('does not poison the namespace-independent POOLSFORTOKENS cache for a later active-namespace request', async () => {
    const chainId = ChainId.MAINNET;
    const protocol = Protocol.V4;
    const tokenIn = new Address('0x1111111111111111111111111111111111111111');
    const tokenOut = new Address('0x2222222222222222222222222222222222222222');

    // Request 1: namespace inactive, selector flags shouldCache=false.
    // Stand-in for the permissioned-hook-drop-while-inactive case.
    const suppressingSelector = new CacheSuppressingTopPoolsSelector();
    await poolDiscoverer.getPoolsForTokens(
      chainId,
      protocol,
      tokenIn,
      tokenOut,
      suppressingSelector,
      undefined,
      false,
      EMPTY_NAMESPACE_CONTEXT,
      ctx
    );

    // No write means the second request for the same pair will miss the cache
    // and be re-evaluated (rather than being served the stripped list).
    expect(getPoolsForTokensCache.set).not.toHaveBeenCalled();

    // Request 2: same pair, default selector that doesn't suppress caching.
    // The cache miss path runs again — this is the desired behaviour.
    await poolDiscoverer.getPoolsForTokens(
      chainId,
      protocol,
      tokenIn,
      tokenOut,
      topPoolSelector,
      undefined,
      false,
      EMPTY_NAMESPACE_CONTEXT,
      ctx
    );

    // Now the second request, which did not suppress caching, performs the write.
    expect(getPoolsForTokensCache.set).toHaveBeenCalledTimes(1);
  });

  it('should generate different cache keys for different discoverer implementations', () => {
    const chainId = ChainId.MAINNET;
    const protocol = Protocol.V2;
    const tokenIn = new Address('0x1111111111111111111111111111111111111111');
    const tokenOut = new Address('0x2222222222222222222222222222222222222222');

    // Test that cache keys include the discoverer name as prefix
    const poolsCacheKey = poolDiscoverer.getPoolsCacheKey(chainId, protocol);
    const poolsForTokensCacheKey = poolDiscoverer.getPoolsForTokensCacheKey(
      chainId,
      protocol,
      tokenIn,
      tokenOut
    );

    expect(poolsCacheKey).toContain('TestPoolDiscoverer#POOLS#');
    expect(poolsForTokensCacheKey).toContain(
      'TestPoolDiscoverer#POOLSFORTOKENS#'
    );

    // Verify the full cache key format
    expect(poolsCacheKey).toBe('TestPoolDiscoverer#POOLS#1#v2');
    expect(poolsForTokensCacheKey).toBe(
      'TestPoolDiscoverer#POOLSFORTOKENS#1#v2#0x1111111111111111111111111111111111111111#0x2222222222222222222222222222222222222222'
    );
  });

  it('keeps inclusive cache keys stable and separates hook-filtered variants', () => {
    const chainId = ChainId.MAINNET;
    const protocol = Protocol.V4;
    const tokenIn = new Address('0x2222222222222222222222222222222222222222');
    const tokenOut = new Address('0x1111111111111111111111111111111111111111');
    const inclusiveKey =
      'TestPoolDiscoverer#POOLSFORTOKENS#1#v4#0x1111111111111111111111111111111111111111#0x2222222222222222222222222222222222222222';

    expect(
      poolDiscoverer.getPoolsForTokensCacheKey(
        chainId,
        protocol,
        tokenIn,
        tokenOut
      )
    ).toBe(inclusiveKey);
    expect(
      poolDiscoverer.getPoolsForTokensCacheKey(
        chainId,
        protocol,
        tokenIn,
        tokenOut,
        HooksOptions.HOOKS_INCLUSIVE
      )
    ).toBe(inclusiveKey);
    expect(
      poolDiscoverer.getPoolsForTokensCacheKey(
        chainId,
        protocol,
        tokenIn,
        tokenOut,
        HooksOptions.NO_HOOKS
      )
    ).toBe(`${inclusiveKey}#${HooksOptions.NO_HOOKS}`);
    expect(
      poolDiscoverer.getPoolsForTokensCacheKey(
        chainId,
        protocol,
        tokenIn,
        tokenOut,
        HooksOptions.HOOKS_ONLY
      )
    ).toBe(`${inclusiveKey}#${HooksOptions.HOOKS_ONLY}`);
    // Filtered variants use suffixed keys for every protocol because NO_HOOKS
    // uses an empty namespace context that bypasses the selector's
    // fail-closed ERC4626 cache guard.
    expect(
      poolDiscoverer.getPoolsForTokensCacheKey(
        chainId,
        Protocol.V3,
        tokenIn,
        tokenOut,
        HooksOptions.NO_HOOKS
      )
    ).toBe(
      'TestPoolDiscoverer#POOLSFORTOKENS#1#v3#0x1111111111111111111111111111111111111111#0x2222222222222222222222222222222222222222#NO_HOOKS'
    );
  });

  it('does not share hook-filtered and inclusive pool-cache entries', async () => {
    const chainId = ChainId.MAINNET;
    const protocol = Protocol.V4;
    const tokenIn = new Address('0x1111111111111111111111111111111111111111');
    const tokenOut = new Address('0x2222222222222222222222222222222222222222');
    // NO_HOOKS only reaches the cache at all when the variant rollout flag
    // is on — the discoverer-level backstop suppresses it otherwise.
    const poolDiscoverer = new TestPoolDiscoverer(
      {
        ...serviceConfig,
        PoolDiscovery: {
          ...serviceConfig.PoolDiscovery,
          PoolsForTokensHooksVariantCacheEnabled: true,
        },
      },
      getPoolsCache,
      getPoolsForTokensCache
    );
    const inclusiveKey = poolDiscoverer.getPoolsForTokensCacheKey(
      chainId,
      protocol,
      tokenIn,
      tokenOut
    );
    const noHooksKey = poolDiscoverer.getPoolsForTokensCacheKey(
      chainId,
      protocol,
      tokenIn,
      tokenOut,
      HooksOptions.NO_HOOKS
    );
    const inclusivePools = [{id: 'inclusive-entry'}];
    const noHooksPools = [{id: 'no-hooks-entry'}];

    getPoolsForTokensCache.get = vi
      .fn()
      .mockImplementation(async (key: string) =>
        key === inclusiveKey ? JSON.stringify(inclusivePools) : undefined
      );
    const noHooksResult = await poolDiscoverer.getPoolsForTokens(
      chainId,
      protocol,
      tokenIn,
      tokenOut,
      topPoolSelector,
      HooksOptions.NO_HOOKS,
      false,
      EMPTY_NAMESPACE_CONTEXT,
      ctx
    );

    expect(noHooksResult).not.toEqual(inclusivePools);
    expect(getPoolsForTokensCache.get).toHaveBeenCalledWith(noHooksKey);
    expect(getPoolsForTokensCache.set).toHaveBeenCalledWith(
      noHooksKey,
      expect.any(String),
      expect.any(Object)
    );

    getPoolsForTokensCache.get = vi
      .fn()
      .mockImplementation(async (key: string) =>
        key === noHooksKey ? JSON.stringify(noHooksPools) : undefined
      );
    const inclusiveResult = await poolDiscoverer.getPoolsForTokens(
      chainId,
      protocol,
      tokenIn,
      tokenOut,
      topPoolSelector,
      HooksOptions.HOOKS_INCLUSIVE,
      false,
      EMPTY_NAMESPACE_CONTEXT,
      ctx
    );

    expect(inclusiveResult).not.toEqual(noHooksPools);
    expect(getPoolsForTokensCache.get).toHaveBeenCalledWith(inclusiveKey);
    expect(getPoolsForTokensCache.set).toHaveBeenCalledWith(
      inclusiveKey,
      expect.any(String),
      expect.any(Object)
    );
  });

  describe('snapshot parse + compliance memoization', () => {
    const memoConfig: IUniRouteServiceConfig = {
      ...serviceConfig,
      PoolDiscovery: {
        ...serviceConfig.PoolDiscovery,
        SnapshotMemoEnabled: true,
      },
    };
    const swrConfig: IUniRouteServiceConfig = {
      ...serviceConfig,
      PoolDiscovery: {
        ...serviceConfig.PoolDiscovery,
        SnapshotMemoEnabled: true,
        SnapshotSwrEnabled: true,
        SnapshotMaxStaleSeconds: 2700,
      },
    };
    const chainId = ChainId.MAINNET;
    const protocol = Protocol.V4;

    const makeSnapshotPools = (ids: string[]): UniPoolInfo[] =>
      ids.map(
        id =>
          ({
            id,
            feeTier: '3000',
            tickSpacing: '1',
            hooks: '0x1111111111111111111111111111111111111111',
            liquidity: '1000',
            token0: {id: `0xaaa${id.replace('0x', '')}`},
            token1: {id: `0xbbb${id.replace('0x', '')}`},
            tvlETH: 1000,
            tvlUSD: 1000,
          }) as unknown as UniPoolInfo
      );

    const snapshotParseResults = () =>
      vi
        .mocked(ctx.metrics.count)
        .mock.calls.filter(([key]) =>
          String(key).includes('SnapshotParse.Cache')
        )
        .flatMap(([, , options]) =>
          (options?.tags ?? []).filter(tag => tag.startsWith('result:'))
        );

    let memoDiscoverer: TestPoolDiscoverer;

    beforeEach(() => {
      memoDiscoverer = new TestPoolDiscoverer(
        memoConfig,
        getPoolsCache,
        getPoolsForTokensCache
      );
    });

    it('returns a stable array reference across getPools calls while the snapshot is unchanged', async () => {
      const cachedPools = makeSnapshotPools(['0x1', '0x2']);
      getPoolsCache.get = vi
        .fn()
        .mockResolvedValue(JSON.stringify(cachedPools));

      const first = await memoDiscoverer.getPools(chainId, protocol, ctx);
      const second = await memoDiscoverer.getPools(chainId, protocol, ctx);

      expect(first).toEqual(cachedPools);
      expect(second).toBe(first);
      // The stable output is what unlocks the selector's view memo.
      expect(isPoolsArrayMemoStable(first)).toBe(true);
    });

    it('re-parses when the cached snapshot string changes', async () => {
      const snapshotA = makeSnapshotPools(['0x1']);
      const snapshotB = makeSnapshotPools(['0x1', '0x2']);
      getPoolsCache.get = vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify(snapshotA))
        .mockResolvedValueOnce(JSON.stringify(snapshotB));

      const first = await memoDiscoverer.getPools(chainId, protocol, ctx);
      const second = await memoDiscoverer.getPools(chainId, protocol, ctx);

      expect(first).toEqual(snapshotA);
      expect(second).toEqual(snapshotB);
      expect(second).not.toBe(first);
    });

    it('re-filters when the deny-list payload changes between calls', async () => {
      const cachedPools = makeSnapshotPools(['0x1', '0x2']);
      let snapshot = {globalSet: new Set<string>()};
      const denyRepo = {
        getSnapshot: async () => snapshot,
      } as unknown as FeatureGatedTokensRepository;
      const discoverer = new TestPoolDiscoverer(
        memoConfig,
        getPoolsCache,
        getPoolsForTokensCache,
        denyRepo
      );
      getPoolsCache.get = vi
        .fn()
        .mockResolvedValue(JSON.stringify(cachedPools));

      const first = await discoverer.getPools(chainId, protocol, ctx);
      expect(first).toHaveLength(2);

      // New payload object denying pool 0x2's token0.
      snapshot = {globalSet: new Set(['0xaaa2'])};
      const second = await discoverer.getPools(chainId, protocol, ctx);

      expect(second.map(p => p.id)).toEqual(['0x1']);
      expect(second).not.toBe(first);
    });

    it('produces the same content as the flag-off path', async () => {
      const cachedPools = makeSnapshotPools(['0x1', '0x2', '0x3']);
      getPoolsCache.get = vi
        .fn()
        .mockResolvedValue(JSON.stringify(cachedPools));

      const legacyFirst = await poolDiscoverer.getPools(chainId, protocol, ctx);
      const legacySecond = await poolDiscoverer.getPools(
        chainId,
        protocol,
        ctx
      );
      const memoized = await memoDiscoverer.getPools(chainId, protocol, ctx);

      expect(memoized).toEqual(legacyFirst);
      // Flag-off keeps today's fresh-array-per-call behavior.
      expect(legacySecond).not.toBe(legacyFirst);
    });

    it('seeds the parse memo on the getPools miss path', async () => {
      // Miss (cache empty) → _getPools result cached + memo seeded with the
      // exact string written; the next hit must reuse the same array.
      let stored: string | undefined = undefined;
      getPoolsCache.get = vi.fn().mockImplementation(async () => stored);
      getPoolsCache.set = vi.fn().mockImplementation(async (_k, v) => {
        stored = v;
      });

      const first = await memoDiscoverer.getPools(chainId, protocol, ctx);
      const second = await memoDiscoverer.getPools(chainId, protocol, ctx);

      expect(second).toBe(first);
    });

    describe('memo re-parse skip', () => {
      const skipReparseConfig: IUniRouteServiceConfig = {
        ...serviceConfig,
        PoolDiscovery: {
          ...serviceConfig.PoolDiscovery,
          SnapshotMemoEnabled: true,
          SnapshotSkipReparseEnabled: true,
        },
      };

      // Explicit undefined-valued keys (top-level AND nested): visible via
      // `in` on the in-memory object but dropped by a JSON round-trip — the
      // exact difference the memo re-parse exists to normalize.
      const makePoolsWithUndefinedValuedKeys = (): UniPoolInfo[] => [
        {
          id: 'pool-with-undefined-keys',
          feeTier: '3000',
          tickSpacing: '1',
          hooks: '0x1111111111111111111111111111111111111111',
          liquidity: '1000',
          token0: {
            id: '0x1111111111111111111111111111111111111111',
            symbol: undefined,
          },
          token1: {id: '0x2222222222222222222222222222222222222222'},
          tvlETH: 1000,
          tvlUSD: undefined,
          isExternalLiquidity: undefined,
        } as unknown as UniPoolInfo,
      ];

      it('serves the loaded objects without a JSON round-trip on the miss path', async () => {
        const sourcePools = makePoolsWithUndefinedValuedKeys();
        const discoverer = new ClosurePoolDiscoverer(
          skipReparseConfig,
          getPoolsCache,
          getPoolsForTokensCache,
          async () => sourcePools
        );

        const result = await discoverer.getPools(chainId, protocol, ctx);

        // No re-parse: the served objects ARE the loaded objects.
        expect(result[0]).toBe(sourcePools[0]);
      });

      it('normalizes undefined-valued keys so served objects match a JSON round-trip', async () => {
        const discoverer = new ClosurePoolDiscoverer(
          skipReparseConfig,
          getPoolsCache,
          getPoolsForTokensCache,
          async () => makePoolsWithUndefinedValuedKeys()
        );

        const result = await discoverer.getPools(chainId, protocol, ctx);
        const pool = result[0] as unknown as Record<string, unknown>;

        expect('tvlUSD' in pool).toBe(false);
        expect('isExternalLiquidity' in pool).toBe(false);
        expect('symbol' in (pool.token0 as Record<string, unknown>)).toBe(
          false
        );
        // Full-fidelity check: nothing else diverges from the round-trip.
        // toStrictEqual, NOT toEqual — toEqual treats {a: undefined} as
        // equal to {}, i.e. it is blind to exactly the present-but-
        // undefined-key divergence this normalization exists to remove.
        expect(result).toStrictEqual(JSON.parse(JSON.stringify(result)));
      });

      it('rewrites undefined array elements to null (round-trip parity)', async () => {
        // No UniPoolInfo field is an array today, but the helper walks the
        // whole graph generically — pin the array branch so a regression
        // (e.g. leaving undefined in place, which JSON.stringify would
        // serialize as null while the memoized object diverges) is caught.
        const poolWithArray = {
          ...makePoolsWithUndefinedValuedKeys()[0],
          tags: ['stable', undefined, 'v4'],
        } as unknown as UniPoolInfo;
        const discoverer = new ClosurePoolDiscoverer(
          skipReparseConfig,
          getPoolsCache,
          getPoolsForTokensCache,
          async () => [poolWithArray]
        );

        const result = await discoverer.getPools(chainId, protocol, ctx);
        const pool = result[0] as unknown as Record<string, unknown>;

        expect(pool.tags).toStrictEqual(['stable', null, 'v4']);
        expect(result).toStrictEqual(JSON.parse(JSON.stringify(result)));
      });

      it('writes a version token with skip-reparse on and the serialized snapshot with it off', async () => {
        const stored: string[] = [];
        const captureCache = () =>
          ({
            get: vi.fn().mockResolvedValue(undefined),
            set: vi.fn().mockImplementation(async (_k: string, v: string) => {
              stored.push(v);
            }),
          }) as unknown as IRedisCache<string, string>;

        const flagOn = new ClosurePoolDiscoverer(
          skipReparseConfig,
          captureCache(),
          getPoolsForTokensCache,
          async () => makePoolsWithUndefinedValuedKeys()
        );
        const flagOff = new ClosurePoolDiscoverer(
          memoConfig,
          captureCache(),
          getPoolsForTokensCache,
          async () => makePoolsWithUndefinedValuedKeys()
        );

        const servedOn = await flagOn.getPools(chainId, protocol, ctx);
        await flagOff.getPools(chainId, protocol, ctx);

        expect(stored).toHaveLength(2);
        expect(stored[0]).toMatch(/^snapshot-version:\d+$/);
        // The kill switch keeps the serialized snapshot, which is exactly
        // what the skip-reparse path serves.
        expect(stored[1]).toBe(JSON.stringify(servedOn));
      });

      it('serves the memo for its own version token without parsing', async () => {
        const cache = new InMemoryRedisCache<string, string>();
        const load = vi.fn(async () => makeSnapshotPools(['0x1', '0x2']));
        const discoverer = new ClosurePoolDiscoverer(
          skipReparseConfig,
          cache,
          getPoolsForTokensCache,
          load
        );
        const parseSpy = vi.spyOn(JSON, 'parse');

        try {
          const first = await discoverer.getPools(chainId, protocol, ctx);
          const second = await discoverer.getPools(chainId, protocol, ctx);

          expect(second).toBe(first);
          expect(load).toHaveBeenCalledTimes(1);
          expect(parseSpy).not.toHaveBeenCalled();
          expect(snapshotParseResults()).toEqual(['result:hit']);
        } finally {
          parseSpy.mockRestore();
        }
      });

      it('mints a distinct token for every load, across discoverers sharing a cache', async () => {
        const cache = new InMemoryRedisCache<string, string>();
        const load = async () => makeSnapshotPools(['0x1']);
        const first = new ClosurePoolDiscoverer(
          skipReparseConfig,
          cache,
          getPoolsForTokensCache,
          load
        );
        const second = new ClosurePoolDiscoverer(
          skipReparseConfig,
          cache,
          getPoolsForTokensCache,
          load
        );
        const cacheKey = first.getPoolsCacheKey(chainId, protocol);

        await first.prewarm(chainId, protocol, ctx);
        const firstToken = await cache.get(cacheKey);
        await second.prewarm(chainId, protocol, ctx);
        const secondToken = await cache.get(cacheKey);
        await first.prewarm(chainId, protocol, ctx);
        const thirdToken = await cache.get(cacheKey);

        expect(new Set([firstToken, secondToken, thirdToken]).size).toBe(3);
      });

      it('treats a version token the memo does not hold as absent instead of parsing it', async () => {
        const cache = new InMemoryRedisCache<string, string>();
        const discoverer = new ClosurePoolDiscoverer(
          skipReparseConfig,
          cache,
          getPoolsForTokensCache,
          async () => makeSnapshotPools(['0x1'])
        );
        const cacheKey = discoverer.getPoolsCacheKey(chainId, protocol);
        await cache.set(cacheKey, 'snapshot-version:unknown');

        const result = await discoverer.getPools(chainId, protocol, ctx);

        // Loaded instead: a parse of the token would have thrown.
        expect(result.map(pool => pool.id)).toEqual(['0x1']);
        expect(await cache.get(cacheKey)).not.toBe('snapshot-version:unknown');
        expect(snapshotParseResults()).toEqual(['result:version_mismatch']);
        expect(ctx.logger.warn).toHaveBeenCalledWith(
          '[ClosurePoolDiscoverer] Pool snapshot cache entry names a version the memo does not hold; treating it as absent',
          {cacheKey, chainId, protocol}
        );
      });

      it('serves the stale memo and refreshes when the cache names a version the memo does not hold', async () => {
        const cache = new InMemoryRedisCache<string, string>();
        const load = vi.fn(async () => makeSnapshotPools(['0x1']));
        const discoverer = new ClosurePoolDiscoverer(
          {
            ...skipReparseConfig,
            PoolDiscovery: {
              ...skipReparseConfig.PoolDiscovery,
              SnapshotSwrEnabled: true,
              SnapshotMaxStaleSeconds: 2700,
            },
          },
          cache,
          getPoolsForTokensCache,
          load
        );
        const cacheKey = discoverer.getPoolsCacheKey(chainId, protocol);
        const served = await discoverer.getPools(chainId, protocol, ctx);
        await cache.set(cacheKey, 'snapshot-version:unknown');

        expect(await discoverer.getPools(chainId, protocol, ctx)).toBe(served);
        await vi.waitFor(() => {
          expect(load).toHaveBeenCalledTimes(2);
        });
      });

      it('publishes the memo before the cache write', async () => {
        const cache = new GatedRedisCache();
        const writeGate = createDeferred<void>();
        cache.gate = writeGate.promise;
        const load = vi.fn(async () => makeSnapshotPools(['0x1']));
        const discoverer = new ClosurePoolDiscoverer(
          skipReparseConfig,
          cache,
          getPoolsForTokensCache,
          load
        );
        const cacheKey = discoverer.getPoolsCacheKey(chainId, protocol);

        const refresh = discoverer.prewarm(chainId, protocol, ctx);
        await vi.waitFor(async () => {
          expect(await cache.contains(cacheKey)).toBe(true);
        });
        cache.gate = undefined;

        // The write is still in flight, and the token it wrote already
        // names the memo's entry.
        const served = await discoverer.getPools(chainId, protocol, ctx);
        expect(served.map(pool => pool.id)).toEqual(['0x1']);
        expect(load).toHaveBeenCalledTimes(1);
        expect(snapshotParseResults()).toEqual(['result:hit']);

        writeGate.resolve(undefined);
        await refresh;
      });

      it('flag off keeps the round-trip (fresh objects served)', async () => {
        const sourcePools = makePoolsWithUndefinedValuedKeys();
        const discoverer = new ClosurePoolDiscoverer(
          memoConfig,
          getPoolsCache,
          getPoolsForTokensCache,
          async () => sourcePools
        );

        const result = await discoverer.getPools(chainId, protocol, ctx);

        expect(result[0]).not.toBe(sourcePools[0]);
        expect(
          'tvlUSD' in (result[0] as unknown as Record<string, unknown>)
        ).toBe(false);
      });
    });

    it('does not mark per-request _getPoolsForTokens arrays as memo-stable', async () => {
      // Direct/Static discoverers return fresh arrays per pair; stability
      // must not leak onto them via the compliance-filter self-seed, or the
      // selector-side gate is defeated (round-2 adversarial finding).
      const observed: boolean[] = [];
      const recordingSelector = {
        filterPools: async (pools: UniPoolInfo[]) => {
          observed.push(isPoolsArrayMemoStable(pools));
          return pools;
        },
      } as unknown as ITopPoolsSelector<UniPoolInfo>;

      await memoDiscoverer.getPoolsForTokens(
        chainId,
        protocol,
        new Address('0x1111111111111111111111111111111111111111'),
        new Address('0x2222222222222222222222222222222222222222'),
        recordingSelector,
        undefined,
        false,
        EMPTY_NAMESPACE_CONTEXT,
        ctx
      );

      expect(observed).toEqual([false]);
    });

    it('getPoolsForTokens miss path behaves identically with the flag on', async () => {
      const first = await memoDiscoverer.getPoolsForTokens(
        chainId,
        protocol,
        new Address('0x1111111111111111111111111111111111111111'),
        new Address('0x2222222222222222222222222222222222222222'),
        topPoolSelector,
        undefined,
        false,
        EMPTY_NAMESPACE_CONTEXT,
        ctx
      );

      expect(first.map(p => p.id)).toEqual(['test-pool-for-tokens']);
      expect(getPoolsForTokensCache.set).toHaveBeenCalledWith(
        expect.any(String),
        JSON.stringify(first),
        expect.any(Object)
      );
    });

    it('coalesces concurrent getPools misses when snapshot SWR is enabled', async () => {
      const noMemoSwrConfig: IUniRouteServiceConfig = {
        ...serviceConfig,
        PoolDiscovery: {
          ...serviceConfig.PoolDiscovery,
          SnapshotMemoEnabled: false,
          SnapshotSwrEnabled: true,
        },
      };
      let loadCount = 0;
      const deferred = createDeferred<UniPoolInfo[]>();
      const discoverer = new ClosurePoolDiscoverer(
        noMemoSwrConfig,
        getPoolsCache,
        getPoolsForTokensCache,
        async () => {
          loadCount += 1;
          return deferred.promise;
        }
      );

      const requests = Array.from({length: 5}, () =>
        discoverer.getPools(chainId, protocol, ctx)
      );
      await Promise.resolve();
      expect(loadCount).toBe(1);

      const freshPools = makeSnapshotPools(['0xfresh']);
      deferred.resolve(freshPools);
      const results = await Promise.all(requests);

      expect(results).toEqual([
        freshPools,
        freshPools,
        freshPools,
        freshPools,
        freshPools,
      ]);
      expect(getPoolsCache.set).toHaveBeenCalledTimes(1);
    });

    it('serves fresh-enough stale memo data and refreshes cache in the background', async () => {
      let cacheAvailable = true;
      let storedSnapshot: string | undefined;
      getPoolsCache.get = vi.fn().mockImplementation(async () => {
        return cacheAvailable ? storedSnapshot : undefined;
      });
      getPoolsCache.set = vi.fn().mockImplementation(async (_key, value) => {
        storedSnapshot = value;
      });

      const stalePools = makeSnapshotPools(['0xstale']);
      const freshPools = makeSnapshotPools(['0xfresh']);
      const backgroundRefresh = createDeferred<UniPoolInfo[]>();
      let loadCount = 0;
      const discoverer = new ClosurePoolDiscoverer(
        swrConfig,
        getPoolsCache,
        getPoolsForTokensCache,
        async () => {
          loadCount += 1;
          if (loadCount === 1) {
            return stalePools;
          }
          return backgroundRefresh.promise;
        }
      );

      const first = await discoverer.getPools(chainId, protocol, ctx);
      expect(first).toEqual(stalePools);

      cacheAvailable = false;
      const second = await discoverer.getPools(chainId, protocol, ctx);

      expect(second).toBe(first);
      expect(loadCount).toBe(2);
      expect(ctx.metrics.count).toHaveBeenCalledWith(expect.any(String), 1, {
        tags: ['result', 'stale'],
      });

      backgroundRefresh.resolve(freshPools);
      await vi.waitFor(() => {
        expect(getPoolsCache.set).toHaveBeenCalledTimes(2);
      });
      await vi.waitFor(() => {
        expect(ctx.metrics.count).toHaveBeenCalledWith(
          expect.stringContaining('PoolDiscoverer.SnapshotRefresh'),
          1,
          {
            tags: [
              `chain:${ChainId[chainId]}`,
              `protocol:${protocol}`,
              'status:success',
            ],
          }
        );
      });

      cacheAvailable = true;
      const third = await discoverer.getPools(chainId, protocol, ctx);
      expect(third).toEqual(freshPools);
    });

    it('blocks on fetch when the memo entry is older than SnapshotMaxStaleSeconds', async () => {
      vi.useFakeTimers({toFake: ['Date']});
      try {
        vi.setSystemTime(new Date(0));
        const maxStaleConfig: IUniRouteServiceConfig = {
          ...swrConfig,
          PoolDiscovery: {
            ...swrConfig.PoolDiscovery,
            SnapshotMaxStaleSeconds: 1,
          },
        };
        const stalePools = makeSnapshotPools(['0xstale']);
        const freshPools = makeSnapshotPools(['0xfresh']);
        const refresh = createDeferred<UniPoolInfo[]>();
        let loadCount = 0;
        const discoverer = new ClosurePoolDiscoverer(
          maxStaleConfig,
          getPoolsCache,
          getPoolsForTokensCache,
          async () => {
            loadCount += 1;
            return loadCount === 1 ? stalePools : refresh.promise;
          }
        );

        await discoverer.getPools(chainId, protocol, ctx);
        vi.setSystemTime(new Date(2000));

        let settled = false;
        const secondRequest = discoverer
          .getPools(chainId, protocol, ctx)
          .then(pools => {
            settled = true;
            return pools;
          });
        await Promise.resolve();

        expect(loadCount).toBe(2);
        expect(settled).toBe(false);

        refresh.resolve(freshPools);
        const second = await secondRequest;

        expect(second).toEqual(freshPools);
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps pre-SWR concurrent miss behavior when the flag is off', async () => {
      let loadCount = 0;
      const discoverer = new ClosurePoolDiscoverer(
        memoConfig,
        getPoolsCache,
        getPoolsForTokensCache,
        async () => {
          loadCount += 1;
          return makeSnapshotPools([`0x${loadCount}`]);
        }
      );

      await Promise.all(
        Array.from({length: 3}, () =>
          discoverer.getPools(chainId, protocol, ctx)
        )
      );

      expect(loadCount).toBe(3);
      expect(getPoolsCache.set).toHaveBeenCalledTimes(3);
    });

    it('catches background refresh failures and retries on the next miss', async () => {
      const stalePools = makeSnapshotPools(['0xstale']);
      const retriedPools = makeSnapshotPools(['0xretried']);
      const failedRefresh = createDeferred<UniPoolInfo[]>();
      const retryRefresh = createDeferred<UniPoolInfo[]>();
      let loadCount = 0;
      const discoverer = new ClosurePoolDiscoverer(
        swrConfig,
        getPoolsCache,
        getPoolsForTokensCache,
        async () => {
          loadCount += 1;
          if (loadCount === 1) {
            return stalePools;
          }
          if (loadCount === 2) {
            return failedRefresh.promise;
          }
          return retryRefresh.promise;
        }
      );

      const first = await discoverer.getPools(chainId, protocol, ctx);
      const second = await discoverer.getPools(chainId, protocol, ctx);

      expect(second).toBe(first);
      failedRefresh.reject(new Error('refresh failed'));
      await vi.waitFor(() => {
        expect(ctx.metrics.count).toHaveBeenCalledWith(
          expect.stringContaining('PoolDiscoverer.SnapshotRefresh'),
          1,
          {
            tags: [
              `chain:${ChainId[chainId]}`,
              `protocol:${protocol}`,
              'status:failure',
              'reason:fetch_error',
            ],
          }
        );
      });

      const third = await discoverer.getPools(chainId, protocol, ctx);
      expect(third).toBe(first);
      expect(loadCount).toBe(3);

      retryRefresh.resolve(retriedPools);
      await vi.waitFor(() => {
        expect(getPoolsCache.set).toHaveBeenCalledTimes(2);
      });
    });

    it('serves stale data when the snapshot cache read fails', async () => {
      const stalePools = makeSnapshotPools(['0xstale']);
      const refresh = createDeferred<UniPoolInfo[]>();
      let loadCount = 0;
      const discoverer = new ClosurePoolDiscoverer(
        swrConfig,
        getPoolsCache,
        getPoolsForTokensCache,
        async () => {
          loadCount += 1;
          return loadCount === 1 ? stalePools : refresh.promise;
        }
      );

      const first = await discoverer.getPools(chainId, protocol, ctx);

      getPoolsCache.get = vi.fn().mockRejectedValue(new Error('redis down'));
      const second = await discoverer.getPools(chainId, protocol, ctx);

      expect(second).toBe(first);
      expect(loadCount).toBe(2);
      expect(ctx.metrics.count).toHaveBeenCalledWith(expect.any(String), 1, {
        tags: ['result', 'stale'],
      });
    });

    it('rethrows snapshot cache read failures when SWR is off', async () => {
      const discoverer = new ClosurePoolDiscoverer(
        memoConfig,
        getPoolsCache,
        getPoolsForTokensCache,
        async () => makeSnapshotPools(['0xfresh'])
      );
      await discoverer.getPools(chainId, protocol, ctx);

      getPoolsCache.get = vi.fn().mockRejectedValue(new Error('redis down'));

      await expect(discoverer.getPools(chainId, protocol, ctx)).rejects.toThrow(
        'redis down'
      );
    });

    it('starts a new fetch instead of joining an in-flight refresh older than the join max age', async () => {
      vi.useFakeTimers({toFake: ['Date']});
      try {
        vi.setSystemTime(new Date(0));
        const hungFetch = createDeferred<UniPoolInfo[]>();
        const freshPools = makeSnapshotPools(['0xfresh']);
        let loadCount = 0;
        const discoverer = new ClosurePoolDiscoverer(
          swrConfig,
          getPoolsCache,
          getPoolsForTokensCache,
          async () => {
            loadCount += 1;
            return loadCount === 1 ? hungFetch.promise : freshPools;
          }
        );

        const hungRequest = discoverer.getPools(chainId, protocol, ctx);
        const joinedRequest = discoverer.getPools(chainId, protocol, ctx);
        await Promise.resolve();
        expect(loadCount).toBe(1);

        vi.setSystemTime(new Date(61_000));
        const second = await discoverer.getPools(chainId, protocol, ctx);

        expect(loadCount).toBe(2);
        expect(second).toEqual(freshPools);

        hungFetch.resolve(makeSnapshotPools(['0xlate']));
        await Promise.all([hungRequest, joinedRequest]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('refresh over an unchanged source', () => {
    const memoConfig: IUniRouteServiceConfig = {
      ...serviceConfig,
      PoolDiscovery: {
        ...serviceConfig.PoolDiscovery,
        SnapshotMemoEnabled: true,
      },
    };
    const chainId = ChainId.MAINNET;
    const protocol = Protocol.V4;
    const pools = [
      {
        id: 'pool',
        feeTier: '3000',
        tickSpacing: '1',
        hooks: '0x1111111111111111111111111111111111111111',
        liquidity: '1000',
        token0: {id: '0x1111111111111111111111111111111111111111'},
        token1: {id: '0x2222222222222222222222222222222222222222'},
        tvlETH: 1000,
        tvlUSD: 1000,
      },
    ];

    const buildDiscoverer = (
      sourceVersion: string | undefined,
      config: IUniRouteServiceConfig = memoConfig,
      featureGatedTokensRepository?: FeatureGatedTokensRepository
    ) => {
      const load = vi.fn(async () => structuredClone(pools));
      const discoverer = new VersionedPoolDiscoverer(
        config,
        getPoolsCache,
        getPoolsForTokensCache,
        load,
        sourceVersion,
        featureGatedTokensRepository
      );
      return {discoverer, load};
    };

    const sourceCheckResults = () =>
      vi
        .mocked(ctx.metrics.count)
        .mock.calls.filter(([key]) =>
          String(key).includes('SnapshotSourceCheck')
        )
        .map(([, , options]) => options);

    it('keeps the memoized snapshot while the source version and deny list are unchanged', async () => {
      const {discoverer, load} = buildDiscoverer('"etag-1"');

      await discoverer.prewarm(chainId, protocol, ctx);
      await discoverer.prewarm(chainId, protocol, ctx);

      expect(load).toHaveBeenCalledTimes(1);
      // The cold load has nothing to compare against, so it is unconditional.
      expect(discoverer.knownVersions).toEqual([undefined, '"etag-1"']);
      const writes = vi.mocked(getPoolsCache.set).mock.calls;
      expect(writes).toHaveLength(2);
      // The same string object, so the next read is a parse-memo hit.
      expect(writes[1][1]).toBe(writes[0][1]);
      await discoverer.prewarm(chainId, protocol, ctx);
      expect(load).toHaveBeenCalledTimes(1);
      expect(vi.mocked(getPoolsCache.set)).toHaveBeenCalledTimes(3);
      expect(sourceCheckResults()).toEqual([
        expect.objectContaining({
          tags: expect.arrayContaining([
            'status:success',
            'result:unchanged',
            `chain:${ChainId[chainId]}`,
            `protocol:${protocol}`,
          ]),
        }),
        expect.objectContaining({
          tags: expect.arrayContaining(['status:success', 'result:unchanged']),
        }),
      ]);
    });

    it('keeps a newer memo and cache entry when an older conditional refresh answers unchanged', async () => {
      const newerPools = [{...pools[0], id: 'newer-pool'}];
      let loadedPools = pools;
      const gate = createDeferred<void>();
      const discoverer = new VersionedPoolDiscoverer(
        memoConfig,
        getPoolsCache,
        getPoolsForTokensCache,
        async () => structuredClone(loadedPools),
        '"etag-1"'
      );

      await discoverer.prewarm(chainId, protocol, ctx);
      discoverer.conditionalLoadGate = gate.promise;
      const olderRefresh = discoverer.getPools(chainId, protocol, ctx);
      await vi.waitFor(() => {
        expect(discoverer.knownVersions).toEqual([undefined, '"etag-1"']);
      });

      discoverer.sourceVersion = '"etag-2"';
      loadedPools = newerPools;
      const newerResult = await discoverer.getPools(chainId, protocol, ctx);
      expect(newerResult).toEqual(newerPools);

      gate.resolve(undefined);
      expect(await olderRefresh).toBe(newerResult);
      const writes = vi.mocked(getPoolsCache.set).mock.calls;
      expect(writes).toHaveLength(2);
      expect(writes[1][1]).toBe(JSON.stringify(newerPools));
      expect(ctx.logger.warn).toHaveBeenCalledWith(
        '[ClosurePoolDiscoverer] Snapshot unchanged, but a newer refresh replaced the memo; keeping the newer entry',
        {
          cacheKey: discoverer.getPoolsCacheKey(chainId, protocol),
          chainId,
          protocol,
        }
      );
      expect(sourceCheckResults()).toEqual([
        expect.objectContaining({
          tags: expect.arrayContaining(['status:success', 'result:changed']),
        }),
        expect.objectContaining({
          tags: expect.arrayContaining(['status:success', 'result:superseded']),
        }),
      ]);

      discoverer.conditionalLoadGate = undefined;
      await discoverer.prewarm(chainId, protocol, ctx);
      expect(discoverer.knownVersions).toEqual([
        undefined,
        '"etag-1"',
        '"etag-1"',
        '"etag-2"',
      ]);
      expect(vi.mocked(getPoolsCache.set).mock.calls[2][1]).toBe(
        JSON.stringify(newerPools)
      );
    });

    it('keeps a newer full load when an older 304 resumes while its cache write is in flight', async () => {
      const newerPools = [{...pools[0], id: 'newer-pool'}];
      let loadedPools = pools;
      const gate = createDeferred<void>();
      const newerCacheWrite = createDeferred<void>();
      const discoverer = new VersionedPoolDiscoverer(
        memoConfig,
        getPoolsCache,
        getPoolsForTokensCache,
        async () => structuredClone(loadedPools),
        '"etag-1"'
      );

      await discoverer.prewarm(chainId, protocol, ctx);
      discoverer.conditionalLoadGate = gate.promise;
      const olderRefresh = discoverer.getPools(chainId, protocol, ctx);
      await vi.waitFor(() => {
        expect(discoverer.knownVersions).toEqual([undefined, '"etag-1"']);
      });

      discoverer.sourceVersion = '"etag-2"';
      loadedPools = newerPools;
      vi.mocked(getPoolsCache.set).mockImplementationOnce(
        () => newerCacheWrite.promise
      );
      const newerRefresh = discoverer.getPools(chainId, protocol, ctx);
      await vi.waitFor(() => {
        expect(vi.mocked(getPoolsCache.set)).toHaveBeenCalledTimes(2);
      });

      gate.resolve(undefined);
      const olderResult = await olderRefresh;
      newerCacheWrite.resolve(undefined);
      expect(olderResult).toBe(await newerRefresh);
      expect(olderResult).toEqual(newerPools);
      const writes = vi.mocked(getPoolsCache.set).mock.calls;
      expect(writes).toHaveLength(2);
      expect(writes[1][1]).toBe(JSON.stringify(newerPools));
    });

    it('keeps the newer version when an older 304 confirms the same content', async () => {
      const gate = createDeferred<void>();
      const {discoverer, load} = buildDiscoverer('"etag-1"');

      await discoverer.prewarm(chainId, protocol, ctx);
      discoverer.conditionalLoadGate = gate.promise;
      const olderRefresh = discoverer.getPools(chainId, protocol, ctx);
      await vi.waitFor(() => {
        expect(discoverer.knownVersions).toEqual([undefined, '"etag-1"']);
      });

      // The object is rewritten with identical bytes under a new ETag.
      discoverer.sourceVersion = '"etag-2"';
      await discoverer.getPools(chainId, protocol, ctx);
      expect(load).toHaveBeenCalledTimes(2);

      gate.resolve(undefined);
      await olderRefresh;
      discoverer.conditionalLoadGate = undefined;
      await discoverer.prewarm(chainId, protocol, ctx);
      expect(discoverer.knownVersions).toEqual([
        undefined,
        '"etag-1"',
        '"etag-1"',
        '"etag-2"',
      ]);
      expect(load).toHaveBeenCalledTimes(2);
    });

    it('re-arms the snapshot without a warning when two conditional refreshes both answer unchanged', async () => {
      const gate = createDeferred<void>();
      const {discoverer, load} = buildDiscoverer('"etag-1"');

      await discoverer.prewarm(chainId, protocol, ctx);
      discoverer.conditionalLoadGate = gate.promise;
      const firstRefresh = discoverer.getPools(chainId, protocol, ctx);
      const secondRefresh = discoverer.getPools(chainId, protocol, ctx);
      await vi.waitFor(() => {
        expect(discoverer.knownVersions).toEqual([
          undefined,
          '"etag-1"',
          '"etag-1"',
        ]);
      });

      gate.resolve(undefined);
      const [firstResult, secondResult] = await Promise.all([
        firstRefresh,
        secondRefresh,
      ]);
      expect(secondResult).toBe(firstResult);
      expect(load).toHaveBeenCalledTimes(1);
      const writes = vi.mocked(getPoolsCache.set).mock.calls;
      expect(writes).toHaveLength(3);
      expect(writes[2][1]).toBe(writes[0][1]);
      expect(ctx.logger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining('a newer refresh replaced the memo'),
        expect.anything()
      );
    });

    it('restores the confirmed snapshot when a newer refresh failed and recorded no version', async () => {
      let loadedPools = pools;
      const gate = createDeferred<void>();
      const discoverer = new VersionedPoolDiscoverer(
        memoConfig,
        getPoolsCache,
        getPoolsForTokensCache,
        async () => structuredClone(loadedPools),
        '"etag-1"'
      );

      await discoverer.prewarm(chainId, protocol, ctx);
      discoverer.conditionalLoadGate = gate.promise;
      const olderRefresh = discoverer.getPools(chainId, protocol, ctx);
      await vi.waitFor(() => {
        expect(discoverer.knownVersions).toEqual([undefined, '"etag-1"']);
      });

      // A failed fetch loads an empty list and records no version.
      discoverer.sourceVersion = undefined;
      loadedPools = [];
      expect(await discoverer.getPools(chainId, protocol, ctx)).toEqual([]);

      gate.resolve(undefined);
      expect(await olderRefresh).toEqual(pools);
      const writes = vi.mocked(getPoolsCache.set).mock.calls;
      expect(writes).toHaveLength(3);
      expect(writes[1][1]).toBe('[]');
      expect(writes[2][1]).toBe(writes[0][1]);
      expect(ctx.logger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining('a newer refresh replaced the memo'),
        expect.anything()
      );
    });

    describe('with skip-reparse (version-token cache values)', () => {
      const skipReparseConfig: IUniRouteServiceConfig = {
        ...memoConfig,
        PoolDiscovery: {
          ...memoConfig.PoolDiscovery,
          SnapshotSkipReparseEnabled: true,
        },
      };

      it('re-arms with the version token the memo holds', async () => {
        const {discoverer, load} = buildDiscoverer(
          '"etag-1"',
          skipReparseConfig
        );

        const served = await discoverer.getPools(chainId, protocol, ctx);
        await discoverer.prewarm(chainId, protocol, ctx);

        expect(load).toHaveBeenCalledTimes(1);
        expect(discoverer.knownVersions).toEqual([undefined, '"etag-1"']);
        const writes = vi.mocked(getPoolsCache.set).mock.calls;
        expect(writes).toHaveLength(2);
        expect(writes[0][1]).toMatch(/^snapshot-version:\d+$/);
        expect(writes[1][1]).toBe(writes[0][1]);

        vi.mocked(getPoolsCache.get).mockResolvedValue(writes[1][1]);
        expect(await discoverer.getPools(chainId, protocol, ctx)).toBe(served);
        expect(load).toHaveBeenCalledTimes(1);
      });

      it('leaves memo and cache on the newer version when a load lands while a 304 re-arm write is in flight', async () => {
        const newerPools = [{...pools[0], id: 'newer-pool'}];
        let loadedPools = pools;
        const cache = new GatedRedisCache();
        const load = vi.fn(async () => structuredClone(loadedPools));
        const discoverer = new VersionedPoolDiscoverer(
          skipReparseConfig,
          cache,
          getPoolsForTokensCache,
          load,
          '"etag-1"'
        );
        const cacheKey = discoverer.getPoolsCacheKey(chainId, protocol);
        const parseResults = () =>
          vi
            .mocked(ctx.metrics.count)
            .mock.calls.filter(([key]) =>
              String(key).includes('SnapshotParse.Cache')
            )
            .flatMap(([, , options]) =>
              (options?.tags ?? []).filter(tag => tag.startsWith('result:'))
            );

        await discoverer.prewarm(chainId, protocol, ctx);
        const gate = createDeferred<void>();
        cache.gate = gate.promise;
        const rearm = discoverer.prewarm(chainId, protocol, ctx);
        await vi.waitFor(() => {
          expect(cache.writeCount).toBe(2);
        });
        cache.gate = undefined;

        // The entry expires and the object changes while the re-arm write
        // is in flight, so the next read loads the newer snapshot.
        await cache.delete(cacheKey);
        discoverer.sourceVersion = '"etag-2"';
        loadedPools = newerPools;
        const newer = await discoverer.getPools(chainId, protocol, ctx);
        expect(newer.map(pool => pool.id)).toEqual(['newer-pool']);

        gate.resolve(undefined);
        await rearm;

        expect(await discoverer.getPools(chainId, protocol, ctx)).toBe(newer);
        expect(load).toHaveBeenCalledTimes(2);
        expect(parseResults()).toEqual(['result:hit']);
      });
    });

    it('reloads when the source version changes', async () => {
      const {discoverer, load} = buildDiscoverer('"etag-1"');

      await discoverer.prewarm(chainId, protocol, ctx);
      discoverer.sourceVersion = '"etag-2"';
      await discoverer.prewarm(chainId, protocol, ctx);

      expect(load).toHaveBeenCalledTimes(2);
      expect(discoverer.knownVersions).toEqual([undefined, '"etag-1"']);
      expect(sourceCheckResults()).toEqual([
        expect.objectContaining({
          tags: expect.arrayContaining(['status:success', 'result:changed']),
        }),
      ]);
    });

    it('counts a conditional load that came back without a version as unavailable, then reloads unconditionally', async () => {
      const {discoverer, load} = buildDiscoverer('"etag-1"');

      await discoverer.prewarm(chainId, protocol, ctx);
      // The source stops reporting a version, as a failed fetch does.
      discoverer.sourceVersion = undefined;
      await discoverer.prewarm(chainId, protocol, ctx);
      await discoverer.prewarm(chainId, protocol, ctx);

      expect(load).toHaveBeenCalledTimes(3);
      expect(discoverer.knownVersions).toEqual([
        undefined,
        '"etag-1"',
        undefined,
      ]);
      expect(sourceCheckResults()).toEqual([
        expect.objectContaining({
          tags: expect.arrayContaining([
            'status:failure',
            'result:unavailable',
            'reason:source_unavailable',
          ]),
        }),
      ]);
    });

    it('never offers an entry loaded without a version for reuse', async () => {
      const {discoverer, load} = buildDiscoverer(undefined);

      await discoverer.prewarm(chainId, protocol, ctx);
      await discoverer.prewarm(chainId, protocol, ctx);

      expect(load).toHaveBeenCalledTimes(2);
      expect(discoverer.knownVersions).toEqual([undefined, undefined]);
      expect(sourceCheckResults()).toHaveLength(0);
    });

    it('reloads unconditionally after a load that recorded no version, then reuses the next one', async () => {
      // A failed S3 fetch loads an empty snapshot with no version; the next
      // refresh must not re-arm it.
      const {discoverer, load} = buildDiscoverer(undefined);

      await discoverer.prewarm(chainId, protocol, ctx);
      discoverer.sourceVersion = '"etag-1"';
      await discoverer.prewarm(chainId, protocol, ctx);
      await discoverer.prewarm(chainId, protocol, ctx);

      expect(load).toHaveBeenCalledTimes(2);
      expect(discoverer.knownVersions).toEqual([
        undefined,
        undefined,
        '"etag-1"',
      ]);
    });

    it('reloads unconditionally when the deny list changes under the same source version', async () => {
      const denyList = new SwitchableDenyListRepository();
      const {discoverer, load} = buildDiscoverer(
        '"etag-1"',
        memoConfig,
        denyList
      );

      await discoverer.prewarm(chainId, protocol, ctx);
      denyList.globalSet = new Set(['0xdead']);
      await discoverer.prewarm(chainId, protocol, ctx);

      expect(load).toHaveBeenCalledTimes(2);
      expect(discoverer.knownVersions).toEqual([undefined, undefined]);
    });

    it('never offers a version when the snapshot memo is off', async () => {
      const {discoverer, load} = buildDiscoverer('"etag-1"', serviceConfig);

      await discoverer.prewarm(chainId, protocol, ctx);
      await discoverer.prewarm(chainId, protocol, ctx);

      expect(load).toHaveBeenCalledTimes(2);
      expect(discoverer.knownVersions).toEqual([undefined, undefined]);
    });
  });

  describe('prewarm', () => {
    it('populates the cache for the given (chainId, protocol) via the same load path getPools() would take', async () => {
      const chainId = ChainId.BASE;
      const protocol = Protocol.V4;
      const pools = [
        {
          id: 'prewarmed-pool',
          feeTier: '3000',
          tickSpacing: '1',
          hooks: '0x1111111111111111111111111111111111111111',
          liquidity: '1000',
          token0: {id: '0x1111111111111111111111111111111111111111'},
          token1: {id: '0x2222222222222222222222222222222222222222'},
          tvlETH: 1000,
          tvlUSD: 1000,
        },
      ];
      const discoverer = new ClosurePoolDiscoverer(
        serviceConfig,
        getPoolsCache,
        getPoolsForTokensCache,
        async () => pools
      );

      await discoverer.prewarm(chainId, protocol, ctx);

      expect(getPoolsCache.set).toHaveBeenCalledWith(
        discoverer.getPoolsCacheKey(chainId, protocol),
        JSON.stringify(pools),
        expect.any(Object)
      );
    });

    it('is fail-open: logs a warning and never throws when the underlying load fails', async () => {
      const chainId = ChainId.BASE;
      const protocol = Protocol.V3;
      const discoverer = new ClosurePoolDiscoverer(
        serviceConfig,
        getPoolsCache,
        getPoolsForTokensCache,
        async () => {
          throw new Error('S3 unavailable');
        }
      );

      await expect(
        discoverer.prewarm(chainId, protocol, ctx)
      ).resolves.toBeUndefined();
      expect(ctx.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Snapshot prewarm failed'),
        expect.objectContaining({chainId, protocol})
      );
      expect(ctx.metrics.count).toHaveBeenCalledWith(
        expect.stringContaining('SnapshotPrewarm'),
        1,
        expect.objectContaining({
          tags: expect.arrayContaining(['status:failure']),
        })
      );
    });

    it('emits a success status metric on the same (chainId, protocol) tags', async () => {
      const chainId = ChainId.MAINNET;
      const protocol = Protocol.V2;
      const discoverer = new ClosurePoolDiscoverer(
        serviceConfig,
        getPoolsCache,
        getPoolsForTokensCache,
        async () => []
      );

      await discoverer.prewarm(chainId, protocol, ctx);

      expect(ctx.metrics.count).toHaveBeenCalledWith(
        expect.stringContaining('SnapshotPrewarm'),
        1,
        expect.objectContaining({
          tags: expect.arrayContaining([
            'status:success',
            `chain:${ChainId[chainId]}`,
            `protocol:${protocol}`,
          ]),
        })
      );
    });

    it('rejects an unsupported protocol before attempting any fetch', async () => {
      const load = vi.fn(async () => []);
      const discoverer = new ClosurePoolDiscoverer(
        serviceConfig,
        getPoolsCache,
        getPoolsForTokensCache,
        load
      );

      await expect(
        discoverer.prewarm(
          ChainId.BASE,
          'unsupported-protocol' as Protocol,
          ctx
        )
      ).rejects.toThrow('Unsupported protocol');
      expect(load).not.toHaveBeenCalled();
    });
  });
});

// Pair discovery driven by a closure; counts how often discovery actually runs.
class PairClosurePoolDiscoverer extends BaseCachingPoolDiscoverer<UniPoolInfo> {
  public pairLoads = 0;
  constructor(
    serviceConfig: IUniRouteServiceConfig,
    getPoolsForTokensCache: IRedisCache<string, string>,
    private readonly loadPairPools: () => UniPoolInfo[]
  ) {
    super(
      serviceConfig,
      new InMemoryRedisCache<string, string>(),
      getPoolsForTokensCache,
      FeatureGatedTokensRepository.empty(),
      'PairClosurePoolDiscoverer'
    );
  }

  protected getDiscovererName(): string {
    return 'PairClosurePoolDiscoverer';
  }

  protected async _getPools(): Promise<UniPoolInfo[]> {
    return [];
  }

  protected async _getPoolsForTokens(): Promise<UniPoolInfo[]> {
    this.pairLoads += 1;
    return this.loadPairPools();
  }
}

describe('BaseCachingPoolDiscoverer empty pools-for-tokens entries', () => {
  const T0 = 1_760_000_000_000;
  const TOKEN_A = new Address('0x1111111111111111111111111111111111111111');
  const TOKEN_B = new Address('0x2222222222222222222222222222222222222222');
  const POOL: UniPoolInfo = {
    id: '0x3333333333333333333333333333333333333333',
    feeTier: '3000',
    liquidity: '1000',
    token0: {id: TOKEN_A.address},
    token1: {id: TOKEN_B.address},
    tvlETH: 1000,
    tvlUSD: 1000,
  };
  const baseConfig = getUniRouteTestConfig();
  const normalTtlSeconds =
    baseConfig.RedisCache.TokenInOutPoolsCacheEntryTtlSeconds;

  const lookup = (
    discoverer: PairClosurePoolDiscoverer,
    selector: ITopPoolsSelector<UniPoolInfo> = new TestTopPoolsSelector(),
    chainId: ChainId = ChainId.MAINNET
  ) =>
    discoverer.getPoolsForTokens(
      chainId,
      Protocol.V3,
      TOKEN_A,
      TOKEN_B,
      selector,
      undefined,
      false,
      EMPTY_NAMESPACE_CONTEXT,
      buildTestContext()
    );

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the normal TTL longer than the empty-entry TTL', () => {
    expect(normalTtlSeconds).toBeGreaterThan(
      EMPTY_POOLS_FOR_TOKENS_CACHE_TTL_SECONDS
    );
  });

  it('serves an empty result from cache within the empty TTL and re-discovers after it', async () => {
    vi.useFakeTimers({toFake: ['Date'], now: T0});
    let pairPools: UniPoolInfo[] = [];
    const discoverer = new PairClosurePoolDiscoverer(
      baseConfig,
      new InMemoryRedisCache<string, string>(),
      () => pairPools
    );

    expect(await lookup(discoverer)).toEqual([]);
    expect(discoverer.pairLoads).toBe(1);

    // A pool appears, but the empty entry is still within its TTL.
    pairPools = [POOL];
    vi.setSystemTime(
      T0 + (EMPTY_POOLS_FOR_TOKENS_CACHE_TTL_SECONDS - 1) * 1000
    );
    expect(await lookup(discoverer)).toEqual([]);
    expect(discoverer.pairLoads).toBe(1);

    vi.setSystemTime(
      T0 + (EMPTY_POOLS_FOR_TOKENS_CACHE_TTL_SECONDS + 1) * 1000
    );
    expect(await lookup(discoverer)).toEqual([POOL]);
    expect(discoverer.pairLoads).toBe(2);
  });

  it('keeps the normal TTL for non-empty results', async () => {
    vi.useFakeTimers({toFake: ['Date'], now: T0});
    let pairPools: UniPoolInfo[] = [POOL];
    const discoverer = new PairClosurePoolDiscoverer(
      baseConfig,
      new InMemoryRedisCache<string, string>(),
      () => pairPools
    );
    expect(await lookup(discoverer)).toEqual([POOL]);

    pairPools = [];
    vi.setSystemTime(
      T0 + (EMPTY_POOLS_FOR_TOKENS_CACHE_TTL_SECONDS + 1) * 1000
    );
    expect(await lookup(discoverer)).toEqual([POOL]);
    expect(discoverer.pairLoads).toBe(1);

    vi.setSystemTime(T0 + (normalTtlSeconds + 1) * 1000);
    expect(await lookup(discoverer)).toEqual([]);
    expect(discoverer.pairLoads).toBe(2);
  });

  it('caps the empty TTL at a shorter per-chain TTL', async () => {
    vi.useFakeTimers({toFake: ['Date'], now: T0});
    const perChainTtlSeconds = 10;
    const config: IUniRouteServiceConfig = {
      ...baseConfig,
      RedisCache: {
        ...baseConfig.RedisCache,
        PoolsCacheEntryTtlSecondsByChain: {
          [ChainId.MAINNET]: perChainTtlSeconds,
        },
      },
    };
    let pairPools: UniPoolInfo[] = [];
    const discoverer = new PairClosurePoolDiscoverer(
      config,
      new InMemoryRedisCache<string, string>(),
      () => pairPools
    );
    expect(await lookup(discoverer)).toEqual([]);
    pairPools = [POOL];
    vi.setSystemTime(T0 + (perChainTtlSeconds + 1) * 1000);
    expect(await lookup(discoverer)).toEqual([POOL]);
    expect(discoverer.pairLoads).toBe(2);
  });

  it('does not cache an empty result the selector marks uncacheable', async () => {
    const discoverer = new PairClosurePoolDiscoverer(
      baseConfig,
      new InMemoryRedisCache<string, string>(),
      () => []
    );
    const selector = new CacheSuppressingTopPoolsSelector();
    await lookup(discoverer, selector);
    await lookup(discoverer, selector);
    expect(discoverer.pairLoads).toBe(2);
  });

  it('re-discovers when a non-empty entry is filtered to empty on read', async () => {
    const cache = new InMemoryRedisCache<string, string>();
    const discoverer = new PairClosurePoolDiscoverer(baseConfig, cache, () => [
      POOL,
    ]);
    expect(await lookup(discoverer)).toEqual([POOL]);
    expect(discoverer.pairLoads).toBe(1);

    // TOKEN_A gains a canonical-pools entry that POOL is not part of, so the
    // cached list filters to empty: that is not a stored negative entry.
    CanonicalPools.__TEST_ONLY__injectTestData({
      [ChainId.MAINNET]: {[TOKEN_A.address]: ['0xcanonical']},
    });
    try {
      await lookup(discoverer);
      expect(discoverer.pairLoads).toBe(2);
    } finally {
      CanonicalPools.__TEST_ONLY__injectTestData();
    }
  });
});

describe('BaseCachingPoolDiscoverer snapshot warmer', () => {
  const baseConfig = getUniRouteTestConfig();
  const chainId = ChainId.MAINNET;
  const protocol = Protocol.V3;
  const configWith = (skipReparse: boolean): IUniRouteServiceConfig => ({
    ...baseConfig,
    PoolDiscovery: {
      ...baseConfig.PoolDiscovery,
      SnapshotMemoEnabled: true,
      SnapshotSkipReparseEnabled: skipReparse,
    },
  });
  const pools: UniPoolInfo[] = [
    {
      id: '0x1',
      feeTier: '3000',
      liquidity: '1000',
      token0: {id: '0xaaa1'},
      token1: {id: '0xbbb1'},
      tvlETH: 1000,
      tvlUSD: 1000,
    },
  ];

  class RecordingWarmer implements IPoolSnapshotWarmer {
    public warmed: UniPoolInfo[][] = [];
    constructor(private readonly fail = false) {}
    async warmSnapshot(snapshot: UniPoolInfo[]): Promise<void> {
      if (this.fail) {
        throw new Error('warm failed');
      }
      this.warmed.push(snapshot);
    }
  }

  class WarmedDiscoverer extends BaseCachingPoolDiscoverer<UniPoolInfo> {
    constructor(config: IUniRouteServiceConfig, warmer: IPoolSnapshotWarmer) {
      super(
        config,
        new InMemoryRedisCache<string, string>(),
        new InMemoryRedisCache<string, string>(),
        FeatureGatedTokensRepository.empty(),
        'WarmedDiscoverer',
        [Protocol.V3],
        warmer
      );
    }
    protected getDiscovererName(): string {
      return 'WarmedDiscoverer';
    }
    protected async _getPools(): Promise<UniPoolInfo[]> {
      return pools.map(pool => ({...pool}));
    }
    protected async _getPoolsForTokens(): Promise<UniPoolInfo[]> {
      return [];
    }
  }

  it.each([true, false])(
    'warms exactly the array it serves (skip-reparse %s)',
    async skipReparse => {
      const warmer = new RecordingWarmer();
      const discoverer = new WarmedDiscoverer(configWith(skipReparse), warmer);

      const served = await discoverer.getPools(
        chainId,
        protocol,
        buildTestContext()
      );

      expect(warmer.warmed).toHaveLength(1);
      expect(warmer.warmed[0]).toBe(served);
      expect(isPoolsArrayMemoStable(served)).toBe(true);
    }
  );

  it('serves the snapshot and reports a failure when the warmer throws', async () => {
    const discoverer = new WarmedDiscoverer(
      configWith(true),
      new RecordingWarmer(true)
    );
    const testCtx = buildTestContext();

    const served = await discoverer.getPools(chainId, protocol, testCtx);

    expect(served.map(pool => pool.id)).toEqual(['0x1']);
    expect(
      testCtx.metrics.countStore[buildMetricKey('PoolDiscoverer.SnapshotWarm')]
    ).toBe(1);
  });
});

describe('BaseCachingPoolDiscoverer snapshot TTL jitter', () => {
  const baseConfig = getUniRouteTestConfig();
  const configuredTtlSeconds = 300;
  const jitterPool: UniPoolInfo = {
    id: '0x3333333333333333333333333333333333333333',
    feeTier: '3000',
    liquidity: '1000',
    token0: {id: '0x1111111111111111111111111111111111111111'},
    token1: {id: '0x2222222222222222222222222222222222222222'},
    tvlETH: 1000,
    tvlUSD: 1000,
  };

  class TtlRecordingCache extends InMemoryRedisCache<string, string> {
    public readonly ttls: (number | undefined)[] = [];

    override async set(
      key: string,
      value: string,
      opts?: Partial<SetOpts>
    ): Promise<void> {
      this.ttls.push(opts?.ttl);
      return super.set(key, value, opts);
    }
  }

  class PinnedJitterPoolDiscoverer extends ClosurePoolDiscoverer {
    protected override readonly snapshotTtlJitterRandom = () => 0.5;
  }

  const configWithJitter = (jitterPercent: number): IUniRouteServiceConfig => ({
    ...baseConfig,
    RedisCache: {
      ...baseConfig.RedisCache,
      PoolsCacheEntryTtlSecondsByChain: {
        [ChainId.MAINNET]: configuredTtlSeconds,
      },
    },
    PoolDiscovery: {
      ...baseConfig.PoolDiscovery,
      SnapshotRefreshJitterPercent: jitterPercent,
    },
  });

  const loadSnapshotTtls = async (
    jitterPercent: number
  ): Promise<(number | undefined)[]> => {
    const getPoolsCache = new TtlRecordingCache();
    const discoverer = new PinnedJitterPoolDiscoverer(
      configWithJitter(jitterPercent),
      getPoolsCache,
      new InMemoryRedisCache<string, string>(),
      async () => [jitterPool]
    );
    await discoverer.getPools(ChainId.MAINNET, Protocol.V3, buildTestContext());
    return getPoolsCache.ttls;
  };

  it('shortens the snapshot cache TTL by the drawn jitter', async () => {
    expect(await loadSnapshotTtls(20)).toEqual([270]);
  });

  it('writes the configured snapshot cache TTL without jitter', async () => {
    expect(await loadSnapshotTtls(0)).toEqual([configuredTtlSeconds]);
  });
});
