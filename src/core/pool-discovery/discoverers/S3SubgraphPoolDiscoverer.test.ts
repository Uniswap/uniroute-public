import {
  S3SubgraphPoolDiscovererV2,
  S3SubgraphPoolDiscovererV3,
  S3SubgraphPoolDiscovererV4,
} from './S3SubgraphPoolDiscoverer';
import {buildTestContext} from '@uniswap/lib-testhelpers';
import {S3Client} from '@aws-sdk/client-s3';
import {IRedisCache} from '@uniswap/lib-cache';
import {
  getUniRouteTestConfig,
  IUniRouteServiceConfig,
} from '../../../lib/config';
import {ChainId} from '../../../lib/config';
import {Protocol} from '../../../models/pool/Protocol';
import {Context} from '@uniswap/lib-uni/context';
import {readFileSync} from 'fs';
import {join} from 'path';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  ITopPoolsSelector,
  PoolsForTokensCacheDirective,
  V2PoolInfo,
  V4PoolInfo,
} from '../interface';
import {sdkStreamMixin} from '@smithy/util-stream';
import {Readable} from 'stream';
import {FeatureGatedTokensRepository} from '../../../stores/compliance/FeatureGatedTokensRepository';
import {
  CcaScheduledActivePool,
  CcaScheduledPoolsRepository,
} from '../CcaScheduledPoolsRepository';
import {Address} from '../../../models/address/Address';
import {HooksOptions} from '../../../models/hooks/HooksOptions';
import {
  EMPTY_NAMESPACE_CONTEXT,
  RouteNamespaceContext,
} from '../../../models/hooks/namespaces';
import {AggHooksTopPoolsSelector} from '../TopPoolsSelector';
import {aggHooksPoolSelectionPerChainConfig} from '../../../lib/config';

const mockConfig: IUniRouteServiceConfig = getUniRouteTestConfig();
const mockContext: Context = buildTestContext();

class PassthroughTopPoolsSelector implements ITopPoolsSelector<V4PoolInfo> {
  async filterPools(
    pools: V4PoolInfo[],

    _chainId: ChainId,

    _tokenIn: Address,

    _tokenOut: Address,

    _protocol: Protocol,

    _hooksOptions: HooksOptions | undefined,

    _nsCtx: RouteNamespaceContext,

    _ctx: Context,

    _cacheDirective: PoolsForTokensCacheDirective
  ): Promise<V4PoolInfo[]> {
    return pools;
  }
}

// Helper to read test data
const readTestData = (filename: string): Buffer => {
  const testDataPath = join(process.cwd(), 'tests/data', filename);
  return readFileSync(testDataPath);
};

// Helper to create a mock S3 response with stream body
const createMockResponse = (body?: Buffer) => ({
  Body: body ? sdkStreamMixin(Readable.from(body)) : undefined,
  $metadata: {},
});

describe('S3SubgraphPoolDiscoverer', () => {
  let s3Client: S3Client;

  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();

    // Mock S3 client
    s3Client = {
      send: vi.fn().mockResolvedValue(createMockResponse()),
    } as unknown as S3Client;
  });

  describe('V2 Pool Discovery', () => {
    let discoverer: S3SubgraphPoolDiscovererV2;
    let getPoolsCache: IRedisCache<string, string>;
    let getPoolsForTokensCache: IRedisCache<string, string>;

    beforeEach(() => {
      getPoolsCache = {
        get: vi.fn().mockResolvedValue(undefined),
        set: vi.fn().mockResolvedValue(undefined),
      } as unknown as IRedisCache<string, string>;

      getPoolsForTokensCache = {
        get: vi.fn().mockResolvedValue(undefined),
        set: vi.fn().mockResolvedValue(undefined),
      } as unknown as IRedisCache<string, string>;

      discoverer = new S3SubgraphPoolDiscovererV2(
        mockConfig,
        getPoolsCache,
        getPoolsForTokensCache,
        FeatureGatedTokensRepository.empty(),
        s3Client
      );
    });

    it('should correctly parse V2 pools from gzipped data', async () => {
      const gzippedData = readTestData('v2-pools.json.gz');
      vi.mocked(s3Client.send).mockResolvedValue(
        createMockResponse(gzippedData) as never
      );
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore - protected method access for testing
      const pools = await discoverer._getPools(
        ChainId.MAINNET,
        Protocol.V2,
        mockContext
      );

      expect(pools.length).toBeGreaterThan(0);
      expect(pools[0]).toHaveProperty('id');
      expect(pools[0]).toHaveProperty('token0');
      expect(pools[0]).toHaveProperty('token1');
      expect(pools[0]).toHaveProperty('supply');
      expect(pools[0]).toHaveProperty('reserve');
      expect(pools[0]).toHaveProperty('reserveUSD');
    });

    it('should force select special pools', () => {
      const poolVirtual = {
        id: '1',
        token0: {id: '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b'},
        token1: {id: '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b'},
      };
      const poolFEI = {
        id: '2',
        token0: {id: '0x956f47f50a910163d8bf957cf5846d573e7f87ca'},
        token1: {id: '0x0000000000000000000000000000000000000000'},
      };

      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore - protected method access for testing
      const forceSelectSpecialPoolsVirtual = discoverer.forceSelectSpecialPools(
        poolVirtual as V2PoolInfo,
        ChainId.BASE
      );
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore - protected method access for testing
      const forceSelectSpecialPoolsFEI = discoverer.forceSelectSpecialPools(
        poolFEI as V2PoolInfo,
        ChainId.MAINNET
      );

      expect(forceSelectSpecialPoolsVirtual).toEqual(true);
      expect(forceSelectSpecialPoolsFEI).toEqual(true);
    });
  });

  describe('V3 Pool Discovery', () => {
    let discoverer: S3SubgraphPoolDiscovererV3;
    let getPoolsCache: IRedisCache<string, string>;
    let getPoolsForTokensCache: IRedisCache<string, string>;

    beforeEach(() => {
      getPoolsCache = {
        get: vi.fn().mockResolvedValue(undefined),
        set: vi.fn().mockResolvedValue(undefined),
      } as unknown as IRedisCache<string, string>;

      getPoolsForTokensCache = {
        get: vi.fn().mockResolvedValue(undefined),
        set: vi.fn().mockResolvedValue(undefined),
      } as unknown as IRedisCache<string, string>;

      discoverer = new S3SubgraphPoolDiscovererV3(
        mockConfig,
        getPoolsCache,
        getPoolsForTokensCache,
        FeatureGatedTokensRepository.empty(),
        s3Client
      );
    });

    it('should correctly parse V3 pools from gzipped data', async () => {
      const gzippedData = readTestData('v3-pools.json.gz');
      vi.mocked(s3Client.send).mockResolvedValue(
        createMockResponse(gzippedData) as never
      );
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore - protected method access for testing
      const pools = await discoverer._getPools(
        ChainId.MAINNET,
        Protocol.V3,
        mockContext
      );

      expect(pools.length).toBeGreaterThan(0);
      expect(pools[0]).toHaveProperty('id');
      expect(pools[0]).toHaveProperty('feeTier');
      expect(pools[0]).toHaveProperty('liquidity');
      expect(pools[0]).toHaveProperty('token0');
      expect(pools[0]).toHaveProperty('token1');
      expect(pools[0]).toHaveProperty('tvlETH');
      expect(pools[0]).toHaveProperty('tvlUSD');
    });
  });

  describe('V4 Pool Discovery', () => {
    let discoverer: S3SubgraphPoolDiscovererV4;
    let getPoolsCache: IRedisCache<string, string>;
    let getPoolsForTokensCache: IRedisCache<string, string>;

    beforeEach(() => {
      getPoolsCache = {
        get: vi.fn().mockResolvedValue(undefined),
        set: vi.fn().mockResolvedValue(undefined),
      } as unknown as IRedisCache<string, string>;

      getPoolsForTokensCache = {
        get: vi.fn().mockResolvedValue(undefined),
        set: vi.fn().mockResolvedValue(undefined),
      } as unknown as IRedisCache<string, string>;

      discoverer = new S3SubgraphPoolDiscovererV4(
        mockConfig,
        getPoolsCache,
        getPoolsForTokensCache,
        FeatureGatedTokensRepository.empty(),
        s3Client
      );
    });

    it('should correctly parse V4 pools from gzipped data', async () => {
      const gzippedData = readTestData('v4-pools.json.gz');
      vi.mocked(s3Client.send).mockResolvedValue(
        createMockResponse(gzippedData) as never
      );
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore - protected method access for testing
      const pools = await discoverer._getPools(
        ChainId.MAINNET,
        Protocol.V4,
        mockContext
      );

      expect(pools.length).toBeGreaterThan(0);
      expect(pools[0]).toHaveProperty('id');
      expect(pools[0]).toHaveProperty('feeTier');
      expect(pools[0]).toHaveProperty('liquidity');
      expect(pools[0]).toHaveProperty('tickSpacing');
      expect(pools[0]).toHaveProperty('hooks');
      expect(pools[0]).toHaveProperty('token0');
      expect(pools[0]).toHaveProperty('token1');
      expect(pools[0]).toHaveProperty('tvlETH');
      expect(pools[0]).toHaveProperty('tvlUSD');
    });

    it('does not materialize an undefined-valued isExternalLiquidity key', async () => {
      // The base-layer memo normalization mass-deletes undefined-valued keys
      // across the snapshot (and `delete` degrades V8 object shapes on the
      // served pools), so the converter must omit the key when the S3 field
      // is absent rather than emit `isExternalLiquidity: undefined`.
      const gzippedData = readTestData('v4-pools.json.gz');
      vi.mocked(s3Client.send).mockResolvedValue(
        createMockResponse(gzippedData) as never
      );
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore - protected method access for testing
      const pools = await discoverer._getPools(
        ChainId.MAINNET,
        Protocol.V4,
        mockContext
      );

      for (const pool of pools) {
        if ('isExternalLiquidity' in pool) {
          expect(pool.isExternalLiquidity).not.toBeUndefined();
        }
      }
    });

    it('should force select ZLCA Hook pools despite zero liquidity and zero TVL', () => {
      const zlcaPool = {
        id: '1',
        feeTier: '3000',
        liquidity: '0',
        tickSpacing: '60',
        hooks: '0x958A0904940f744f8c6b72c043CeeE3EA34AE888', // LitePSM USDS (mixed case)
        token0: {id: '0x6b175474e89094c44da98b954eedeac495271d0f'},
        token1: {id: '0xdc035d45d973e3ec169d2276ddab16f1e407384f'},
        tvlETH: 0,
        tvlUSD: 0,
      };
      const nonZlcaPool = {
        ...zlcaPool,
        id: '2',
        hooks: '0x0000000000000000000000000000000000000001',
      };
      const dualpoolPool = {
        ...zlcaPool,
        id: '3',
        hooks: '0x00000078BD49D5279a99b5F4011a5C61eE8caaC0', // dualpool (mixed case)
      };

      const forceSelectZlca = discoverer['forceSelectSpecialPools'](
        zlcaPool as V4PoolInfo,
        ChainId.MAINNET
      );
      const forceSelectNonZlca = discoverer['forceSelectSpecialPools'](
        nonZlcaPool as V4PoolInfo,
        ChainId.MAINNET
      );
      const forceSelectDualpool = discoverer['forceSelectSpecialPools'](
        dualpoolPool as V4PoolInfo,
        ChainId.MAINNET
      );
      const forceSelectWrongChain = discoverer['forceSelectSpecialPools'](
        zlcaPool as V4PoolInfo,
        ChainId.ARBITRUM
      );

      expect(forceSelectZlca).toEqual(true);
      expect(forceSelectNonZlca).toEqual(false);
      expect(forceSelectDualpool).toEqual(true);
      expect(forceSelectWrongChain).toEqual(false);
    });
  });

  describe('Error Handling', () => {
    let discoverer: S3SubgraphPoolDiscovererV2;
    let getPoolsCache: IRedisCache<string, string>;
    let getPoolsForTokensCache: IRedisCache<string, string>;

    beforeEach(() => {
      getPoolsCache = {
        get: vi.fn().mockResolvedValue(undefined),
        set: vi.fn().mockResolvedValue(undefined),
      } as unknown as IRedisCache<string, string>;

      getPoolsForTokensCache = {
        get: vi.fn().mockResolvedValue(undefined),
        set: vi.fn().mockResolvedValue(undefined),
      } as unknown as IRedisCache<string, string>;

      discoverer = new S3SubgraphPoolDiscovererV2(
        mockConfig,
        getPoolsCache,
        getPoolsForTokensCache,
        FeatureGatedTokensRepository.empty(),
        s3Client
      );
    });

    it('should handle missing S3 data gracefully', async () => {
      vi.mocked(s3Client.send).mockResolvedValue(
        createMockResponse(undefined) as never
      );
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore - protected method access for testing
      const pools = await discoverer._getPools(
        ChainId.MAINNET,
        Protocol.V2,
        mockContext
      );

      expect(pools).toEqual([]);
    });

    it('should handle S3 errors gracefully', async () => {
      vi.mocked(s3Client.send).mockRejectedValue(new Error('S3 error'));

      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore - protected method access for testing
      const pools = await discoverer._getPools(
        ChainId.MAINNET,
        Protocol.V2,
        mockContext
      );

      expect(pools).toEqual([]);
    });
  });

  describe('External Protocol Pool Discovery', () => {
    let discoverer: S3SubgraphPoolDiscovererV4;
    let getPoolsCache: IRedisCache<string, string>;
    let getPoolsForTokensCache: IRedisCache<string, string>;

    beforeEach(() => {
      getPoolsCache = {
        get: vi.fn().mockResolvedValue(undefined),
        set: vi.fn().mockResolvedValue(undefined),
      } as unknown as IRedisCache<string, string>;

      getPoolsForTokensCache = {
        get: vi.fn().mockResolvedValue(undefined),
        set: vi.fn().mockResolvedValue(undefined),
      } as unknown as IRedisCache<string, string>;

      discoverer = new S3SubgraphPoolDiscovererV4(
        mockConfig,
        getPoolsCache,
        getPoolsForTokensCache,
        FeatureGatedTokensRepository.empty(),
        s3Client
      );
    });

    // External (agg hook) protocols are no longer accepted by S3SubgraphPoolDiscoverer.
    // UniRoutesRepository always passes Protocol.V4 when fetching pools for external protocols.
    it.each([
      Protocol.CURVESTABLESWAPNG,
      Protocol.FLUIDDEXT1,
      Protocol.FLUIDDEXLITE,
    ])(
      'should throw for external protocol %s since UniRoutesRepository passes Protocol.V4 instead',
      async protocol => {
        await expect(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (discoverer as any)._getPools(ChainId.MAINNET, protocol, mockContext)
        ).rejects.toThrow('Unsupported protocol');
      }
    );
  });
});

describe('S3SubgraphPoolDiscovererV4 CCA scheduled pools merge', () => {
  const ZERO = '0x0000000000000000000000000000000000000000';
  const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
  const NEW_TOKEN = '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984';
  const OTHER_TOKEN = '0x2222222222222222222222222222222222222222';

  const scheduledPool = (overrides: Partial<V4PoolInfo> = {}): V4PoolInfo => ({
    id: '0xccapool',
    feeTier: '10000',
    liquidity: '1',
    tickSpacing: '200',
    hooks: ZERO,
    token0: {id: ZERO},
    token1: {id: NEW_TOKEN},
    tvlETH: 0,
    tvlUSD: 0,
    ...overrides,
  });

  const activePool = (
    poolOverrides: Partial<V4PoolInfo> = {},
    launchedToken: string = NEW_TOKEN
  ): CcaScheduledActivePool => ({
    pool: scheduledPool(poolOverrides),
    launchedToken,
  });

  // Unrelated base pool: the merge only runs when the base result is
  // non-empty (an empty primary result must keep triggering the
  // Direct/Static fallback chain).
  const basePool: V4PoolInfo = {
    id: '0xbasepool',
    feeTier: '500',
    liquidity: '1000',
    tickSpacing: '10',
    hooks: ZERO,
    token0: {id: ZERO},
    token1: {id: WETH.toLowerCase()},
    tvlETH: 100,
    tvlUSD: 100,
  };

  let s3Client: S3Client;
  let repository: CcaScheduledPoolsRepository;
  let pairCache: IRedisCache<string, string>;
  let discoverer: S3SubgraphPoolDiscovererV4;

  const makeCache = (): IRedisCache<string, string> =>
    ({
      get: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockResolvedValue(undefined),
    }) as unknown as IRedisCache<string, string>;

  const getPoolsForTokens = (
    hooksOptions?: HooksOptions
  ): Promise<V4PoolInfo[]> =>
    discoverer.getPoolsForTokens(
      ChainId.MAINNET,
      Protocol.V4,
      new Address(WETH),
      new Address(NEW_TOKEN),
      new PassthroughTopPoolsSelector(),
      hooksOptions,
      false,
      EMPTY_NAMESPACE_CONTEXT,
      mockContext
    );

  beforeEach(() => {
    s3Client = {
      send: vi.fn().mockResolvedValue(createMockResponse()),
    } as unknown as S3Client;
    repository = {
      isEnabled: vi.fn().mockReturnValue(true),
      getActivePools: vi.fn().mockResolvedValue([activePool()]),
    } as unknown as CcaScheduledPoolsRepository;
    pairCache = makeCache();
    vi.mocked(pairCache.get).mockResolvedValue(JSON.stringify([basePool]));
    discoverer = new S3SubgraphPoolDiscovererV4(
      mockConfig,
      makeCache(),
      pairCache,
      FeatureGatedTokensRepository.empty(),
      s3Client,
      repository
    );
  });

  it('appends active pair-relevant scheduled pools after the pair cache, without caching them', async () => {
    // Cache miss with real S3 pool data: exercises the miss path so the
    // no-cache-write assertion below is meaningful.
    vi.mocked(pairCache.get).mockResolvedValue(undefined as unknown as string);
    vi.mocked(s3Client.send).mockResolvedValue(
      createMockResponse(readTestData('v4-pools.json.gz')) as never
    );

    const pools = await getPoolsForTokens();

    expect(pools.map(pool => pool.id)).toContain('0xccapool');
    // The scheduled pool must not be written into the pair cache — retiring
    // an entry has to take effect on the next request, not a TTL later.
    const cachedWrites = vi
      .mocked(pairCache.set)
      .mock.calls.map(call => call[1] as string);
    expect(cachedWrites.length).toBeGreaterThan(0);
    for (const written of cachedWrites) {
      expect(written).not.toContain('0xccapool');
    }
  });

  it('does not merge into an empty base result (preserves the fallback-discoverer trigger)', async () => {
    vi.mocked(pairCache.get).mockResolvedValue(undefined as unknown as string);
    // S3 returns nothing → base result is empty → fallback semantics apply.
    const pools = await getPoolsForTokens();

    expect(pools).toEqual([]);
    expect(repository.getActivePools).not.toHaveBeenCalled();
  });

  it('fails open when the repository throws (merge is strictly additive)', async () => {
    vi.mocked(repository.getActivePools).mockRejectedValue(
      new Error('malformed registry')
    );

    const pools = await getPoolsForTokens();

    expect(pools.map(pool => pool.id)).toEqual(['0xbasepool']);
  });

  it('matches on the launched token only — the paired currency must not drag pools into unrelated quotes', async () => {
    vi.mocked(repository.getActivePools).mockResolvedValue([
      // Launched token IS the quote's tokenOut: merged.
      activePool(),
      // Shares the quote's native/WETH side (token0 = 0x0) but its launched
      // token is unrelated: must NOT be merged.
      activePool({id: '0xothereth', token1: {id: OTHER_TOKEN}}, OTHER_TOKEN),
    ]);

    const ids = (await getPoolsForTokens()).map(pool => pool.id);

    expect(ids).toContain('0xccapool');
    expect(ids).not.toContain('0xothereth');
  });

  it('skips hooked scheduled pools (hooked launches need selector-path support)', async () => {
    vi.mocked(repository.getActivePools).mockResolvedValue([
      activePool({hooks: '0x9999999999999999999999999999999999999999'}),
    ]);

    const pools = await getPoolsForTokens();

    expect(pools.map(pool => pool.id)).not.toContain('0xccapool');
  });

  it('drops merged scheduled pools whose token is on the restricted list', async () => {
    const restrictedRepo = new FeatureGatedTokensRepository(
      {
        fetchAll: async () => ({
          tokens: [{chainId: ChainId.MAINNET, address: NEW_TOKEN}],
          skippedUnsupportedChains: 0,
        }),
      },
      {fetch: async () => []}
    );
    discoverer = new S3SubgraphPoolDiscovererV4(
      mockConfig,
      makeCache(),
      pairCache,
      restrictedRepo,
      s3Client,
      repository
    );

    const pools = await getPoolsForTokens();

    expect(pools.map(pool => pool.id)).not.toContain('0xccapool');
  });

  it('prefers the real (cached) subgraph entry over a scheduled duplicate', async () => {
    const realPool = scheduledPool({liquidity: '123456789'});
    vi.mocked(pairCache.get).mockResolvedValue(JSON.stringify([realPool]));

    const pools = await getPoolsForTokens();

    const matches = pools.filter(pool => pool.id === '0xccapool');
    expect(matches).toHaveLength(1);
    expect(matches[0].liquidity).toBe('123456789');
  });

  it('dedups against cached subgraph ids case-insensitively', async () => {
    const realPool = scheduledPool({liquidity: '123456789'});
    vi.mocked(pairCache.get).mockResolvedValue(JSON.stringify([realPool]));
    vi.mocked(repository.getActivePools).mockResolvedValue([
      activePool({id: '0xCCAPOOL'}),
    ]);

    const pools = await getPoolsForTokens();

    const matches = pools.filter(pool => pool.id.toLowerCase() === '0xccapool');
    expect(matches).toHaveLength(1);
    expect(matches[0].liquidity).toBe('123456789');
  });

  it('is a no-op when the repository is disabled', async () => {
    vi.mocked(repository.isEnabled).mockReturnValue(false);

    const pools = await getPoolsForTokens();

    expect(pools.map(pool => pool.id)).not.toContain('0xccapool');
    expect(repository.getActivePools).not.toHaveBeenCalled();
  });

  it('skips hookless scheduled pools when hooksOptions is HOOKS_ONLY', async () => {
    const pools = await getPoolsForTokens(HooksOptions.HOOKS_ONLY);

    expect(pools.map(pool => pool.id)).not.toContain('0xccapool');
  });

  it('never merges into an agg-hooks selector fetch (would leak a V4 route into an agg-hooks-only request)', async () => {
    const aggSelector = new AggHooksTopPoolsSelector(
      aggHooksPoolSelectionPerChainConfig,
      FeatureGatedTokensRepository.empty()
    );
    // Replicate PoolDiscoverer's anonymous adapter: the gate must read the
    // aggHooksOnly marker THROUGH the wrapper — an instanceof check is
    // defeated by exactly this production call path.
    const wrappedLikePoolDiscoverer: ITopPoolsSelector<V4PoolInfo> = {
      aggHooksOnly: aggSelector.aggHooksOnly,
      filterPools: async (...args) =>
        (await aggSelector.filterPools(...args)) as V4PoolInfo[],
    };

    const pools = await discoverer.getPoolsForTokens(
      ChainId.MAINNET,
      Protocol.V4,
      new Address(WETH),
      new Address(NEW_TOKEN),
      wrappedLikePoolDiscoverer,
      HooksOptions.HOOKS_INCLUSIVE,
      true,
      EMPTY_NAMESPACE_CONTEXT,
      mockContext
    );

    expect(pools.map(pool => pool.id)).not.toContain('0xccapool');
    expect(repository.getActivePools).not.toHaveBeenCalled();
  });
});
