import {describe, beforeEach, it, expect, vi} from 'vitest';
import {
  BaseCachingPoolDiscoverer,
  POOLS_FOR_TOKENS_CACHE_VALUE_MAX_BYTES,
} from './BaseCachingPoolDiscoverer';
import {ChainId} from '../../lib/config';
import {Protocol} from '../../models/pool/Protocol';
import {Context} from '@uniswap/lib-uni/context';
import {
  isPoolsArrayMemoStable,
  ITopPoolsSelector,
  markPoolsForTokensUncacheable,
  PoolsForTokensCacheDirective,
  PoolsForTokensCacheSkipReason,
  UniPoolInfo,
} from './interface';
import {IRedisCache} from '@uniswap/lib-cache';
import {Address} from '../../models/address/Address';
import {getUniRouteTestConfig, IUniRouteServiceConfig} from '../../lib/config';
import {HooksOptions} from '../../models/hooks/HooksOptions';
import {FeatureGatedTokensRepository} from '../../stores/compliance/FeatureGatedTokensRepository';
import {
  EMPTY_NAMESPACE_CONTEXT,
  RouteNamespaceContext,
} from '../../models/hooks/namespaces';

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
class CacheSuppressingTopPoolsSelector
  implements ITopPoolsSelector<UniPoolInfo>
{
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

const createDeferred = <T>() => {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return {promise, resolve, reject};
};

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
      tags: ['result', 'hit'],
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
    expect(ctx.metrics.count).toHaveBeenCalledWith(expect.any(String), 1, {
      tags: ['result', 'miss'],
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
});
