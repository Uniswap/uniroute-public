import {
  S3SubgraphPoolDiscovererV2,
  S3SubgraphPoolDiscovererV3,
  S3SubgraphPoolDiscovererV4,
} from './S3SubgraphPoolDiscoverer';
import {buildTestContext} from '@uniswap/lib-testhelpers';
import {GetObjectCommand, S3Client} from '@aws-sdk/client-s3';
import {InMemoryRedisCache, IRedisCache} from '@uniswap/lib-cache';
import {
  getUniRouteTestConfig,
  IUniRouteServiceConfig,
} from '../../../lib/config';
import {ChainId} from '../../../lib/config';
import {Protocol} from '../../../models/pool/Protocol';
import {Context} from '@uniswap/lib-uni/context';
import {readFileSync} from 'fs';
import {join} from 'path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  ITopPoolsSelector,
  PoolsForTokensCacheDirective,
  UniPoolInfo,
  V4PoolInfo,
} from '../interface';
import {sdkStreamMixin} from '@smithy/util-stream';
import {Readable} from 'stream';
import {FeatureGatedTokensRepository} from '../../../stores/compliance/FeatureGatedTokensRepository';
import {
  CanonicalPools,
  REGISTRY_COVERAGE_METRIC,
} from '../../../lib/CanonicalPools';
import {
  CcaScheduledActivePool,
  CcaScheduledPoolsRepository,
} from '../CcaScheduledPoolsRepository';
import {Address} from '../../../models/address/Address';
import {HOOKS_ADDRESSES_DENYLIST} from '../../../lib/poolCaching/util/hooksAddressesDenylist';
import {HooksOptions} from '../../../models/hooks/HooksOptions';
import {
  EMPTY_NAMESPACE_CONTEXT,
  RouteNamespaceContext,
} from '../../../models/hooks/namespaces';
import {AggHooksTopPoolsSelector} from '../TopPoolsSelector';
import {aggHooksPoolSelectionPerChainConfig} from '../../../lib/config';
import {
  ISnapshotParseOffloader,
  MainThreadSnapshotParseOffloader,
  SnapshotParseOffloadError,
  SnapshotParseOffloadFailureReason,
} from './SnapshotParseOffloader';
import {
  SnapshotTransformParams,
  SnapshotTransformResult,
  transformSnapshotPoolBytes,
} from './s3SnapshotTransform';
import {WorkerThreadSnapshotParseOffloader} from './WorkerThreadSnapshotParseOffloader';
import {FakeSnapshotParseWorkerHandle} from '../../../../tests/test-utils/FakeSnapshotParseWorkerHandle';
import {TestMetric} from '@uniswap/lib-testhelpers/testMetrics';
import {MetricOptions} from '@uniswap/lib-uni';
import {deflateSync, inflateSync} from 'zlib';

const mockConfig: IUniRouteServiceConfig = getUniRouteTestConfig();
// Real pure-transform implementation (no I/O, no mocking) — exactly what
// production uses when the worker-thread offload is disabled, and what every
// test in this file exercised implicitly before the offloader existed.
const snapshotParseOffloader = new MainThreadSnapshotParseOffloader();
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
        s3Client,
        snapshotParseOffloader
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
        s3Client,
        snapshotParseOffloader
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
        s3Client,
        snapshotParseOffloader
      );
    });

    describe('snapshot refresh over an unchanged object', () => {
      const memoConfig: IUniRouteServiceConfig = {
        ...mockConfig,
        PoolDiscovery: {
          ...mockConfig.PoolDiscovery,
          SnapshotMemoEnabled: true,
        },
      };
      const gzippedData = readTestData('v4-pools.json.gz');
      // The SDK surfaces S3's 304 as a thrown error carrying the status.
      const notModified = () =>
        Object.assign(new Error('Not Modified'), {
          $metadata: {httpStatusCode: 304},
        });
      // Serves the object under `etag()`, answering 304 to a matching
      // If-None-Match the way S3 does, and counts the full downloads.
      const serveObject = (etag: () => string, failing: () => boolean) => {
        let downloads = 0;
        vi.mocked(s3Client.send).mockImplementation((async (
          command: unknown
        ) => {
          if (failing()) {
            throw new Error('s3 down');
          }
          if (
            command instanceof GetObjectCommand &&
            command.input.IfNoneMatch === etag()
          ) {
            throw notModified();
          }
          downloads += 1;
          return {...createMockResponse(gzippedData), ETag: etag()};
        }) as never);
        return {downloads: () => downloads};
      };
      const ifNoneMatchSent = () =>
        vi
          .mocked(s3Client.send)
          .mock.calls.flatMap(([command]) =>
            command instanceof GetObjectCommand
              ? [command.input.IfNoneMatch]
              : []
          );
      const cacheWrites = () =>
        vi.mocked(getPoolsCache.set).mock.calls.map(([, value]) => value);

      it('keeps the parsed snapshot while a conditional GET answers 304 on the same ETag', async () => {
        let etag = '"etag-1"';
        const {downloads} = serveObject(
          () => etag,
          () => false
        );
        const memoDiscoverer = new S3SubgraphPoolDiscovererV4(
          memoConfig,
          getPoolsCache,
          getPoolsForTokensCache,
          FeatureGatedTokensRepository.empty(),
          s3Client,
          snapshotParseOffloader
        );

        await memoDiscoverer.prewarm(ChainId.MAINNET, Protocol.V4, mockContext);
        await memoDiscoverer.prewarm(ChainId.MAINNET, Protocol.V4, mockContext);
        // The cold load is unconditional; the refresh asks about its ETag.
        expect(ifNoneMatchSent()).toEqual([undefined, '"etag-1"']);
        expect(downloads()).toBe(1);
        expect(cacheWrites()).toHaveLength(2);

        etag = '"etag-2"';
        await memoDiscoverer.prewarm(ChainId.MAINNET, Protocol.V4, mockContext);
        expect(ifNoneMatchSent()).toEqual([undefined, '"etag-1"', '"etag-1"']);
        expect(downloads()).toBe(2);
      });

      it('counts downloads and errors but excludes 304s from download metrics', async () => {
        let failing = false;
        serveObject(
          () => '"etag-1"',
          () => failing
        );
        const memoDiscoverer = new S3SubgraphPoolDiscovererV4(
          memoConfig,
          getPoolsCache,
          getPoolsForTokensCache,
          FeatureGatedTokensRepository.empty(),
          s3Client,
          snapshotParseOffloader
        );
        const countSpy = vi.spyOn(mockContext.metrics, 'count');
        const distSpy = vi.spyOn(mockContext.metrics, 'dist');
        const downloadCalls = () =>
          countSpy.mock.calls.filter(([key]) =>
            String(key).includes('S3SubgraphPoolDiscoverer.Call')
          );
        const downloadLatencies = () =>
          distSpy.mock.calls.filter(([key]) =>
            String(key).includes('S3SubgraphPoolDiscoverer.Latency.dist')
          );

        try {
          await memoDiscoverer.prewarm(
            ChainId.MAINNET,
            Protocol.V4,
            mockContext
          );
          expect(downloadCalls()).toHaveLength(1);
          expect(downloadCalls()[0][2]).toEqual({
            tags: ['chain:MAINNET', 'protocol:v4', 'status:success'],
          });
          expect(downloadLatencies()).toHaveLength(1);
          expect(downloadLatencies()[0][2]).toEqual({
            tags: ['chain:MAINNET', 'protocol:v4', 'status:success'],
          });
          expect(
            countSpy.mock.calls.filter(([key]) =>
              String(key).includes('NotModified.Latency')
            )
          ).toHaveLength(0);

          countSpy.mockClear();
          distSpy.mockClear();
          await memoDiscoverer.prewarm(
            ChainId.MAINNET,
            Protocol.V4,
            mockContext
          );
          expect(downloadCalls()).toHaveLength(0);
          expect(downloadLatencies()).toHaveLength(0);
          const notModifiedLatencies = countSpy.mock.calls.filter(([key]) =>
            String(key).includes('S3SubgraphPoolDiscoverer.NotModified.Latency')
          );
          expect(notModifiedLatencies).toHaveLength(1);
          expect(notModifiedLatencies[0][2]).toEqual({
            tags: ['chain:MAINNET', 'protocol:v4'],
          });

          failing = true;
          await memoDiscoverer.prewarm(
            ChainId.MAINNET,
            Protocol.V4,
            mockContext
          );
          expect(downloadCalls()).toHaveLength(1);
          expect(downloadCalls()[0][2]).toEqual({
            tags: ['chain:MAINNET', 'protocol:v4', 'status:error'],
          });
          expect(downloadLatencies()).toHaveLength(1);
          expect(downloadLatencies()[0][2]).toEqual({
            tags: ['chain:MAINNET', 'protocol:v4', 'status:error'],
          });
        } finally {
          countSpy.mockRestore();
          distSpy.mockRestore();
        }
      });

      it('reloads unconditionally after a failed fetch instead of re-arming the empty snapshot', async () => {
        let failing = true;
        const {downloads} = serveObject(
          () => '"etag-1"',
          () => failing
        );
        const memoDiscoverer = new S3SubgraphPoolDiscovererV4(
          memoConfig,
          getPoolsCache,
          getPoolsForTokensCache,
          FeatureGatedTokensRepository.empty(),
          s3Client,
          snapshotParseOffloader
        );

        await memoDiscoverer.prewarm(ChainId.MAINNET, Protocol.V4, mockContext);
        expect(cacheWrites()).toEqual(['[]']);

        failing = false;
        await memoDiscoverer.prewarm(ChainId.MAINNET, Protocol.V4, mockContext);
        expect(ifNoneMatchSent()).toEqual([undefined, undefined]);
        expect(downloads()).toBe(1);
        expect(JSON.parse(cacheWrites()[1]).length).toBeGreaterThan(0);

        await memoDiscoverer.prewarm(ChainId.MAINNET, Protocol.V4, mockContext);
        expect(ifNoneMatchSent()).toEqual([undefined, undefined, '"etag-1"']);
        expect(downloads()).toBe(1);
      });

      it('re-filters an unchanged object when the load-time filter inputs change', async () => {
        class FilterVersionedDiscoverer extends S3SubgraphPoolDiscovererV4 {
          public filterVersion = 'hooks-a';
          protected override snapshotFilterVersion(): string {
            return this.filterVersion;
          }
        }
        const {downloads} = serveObject(
          () => '"etag-1"',
          () => false
        );
        const memoDiscoverer = new FilterVersionedDiscoverer(
          memoConfig,
          getPoolsCache,
          getPoolsForTokensCache,
          FeatureGatedTokensRepository.empty(),
          s3Client,
          snapshotParseOffloader
        );

        await memoDiscoverer.prewarm(ChainId.MAINNET, Protocol.V4, mockContext);
        await memoDiscoverer.prewarm(ChainId.MAINNET, Protocol.V4, mockContext);
        memoDiscoverer.filterVersion = 'hooks-b';
        await memoDiscoverer.prewarm(ChainId.MAINNET, Protocol.V4, mockContext);

        expect(ifNoneMatchSent()).toEqual([undefined, '"etag-1"', undefined]);
        expect(downloads()).toBe(2);
      });

      it('caches a version token under skip-reparse and keeps serving its snapshot across a 304', async () => {
        const {downloads} = serveObject(
          () => '"etag-1"',
          () => false
        );
        const cache = new InMemoryRedisCache<string, string>();
        const skipReparseDiscoverer = new S3SubgraphPoolDiscovererV4(
          {
            ...memoConfig,
            PoolDiscovery: {
              ...memoConfig.PoolDiscovery,
              SnapshotSkipReparseEnabled: true,
            },
          },
          cache,
          getPoolsForTokensCache,
          FeatureGatedTokensRepository.empty(),
          s3Client,
          snapshotParseOffloader
        );
        const cacheKey = skipReparseDiscoverer.getPoolsCacheKey(
          ChainId.MAINNET,
          Protocol.V4
        );

        const served = await skipReparseDiscoverer.getPools(
          ChainId.MAINNET,
          Protocol.V4,
          mockContext
        );
        const token = await cache.get(cacheKey);
        await skipReparseDiscoverer.prewarm(
          ChainId.MAINNET,
          Protocol.V4,
          mockContext
        );

        expect(served.length).toBeGreaterThan(0);
        expect(token).toMatch(/^snapshot-version:\d+$/);
        expect(ifNoneMatchSent()).toEqual([undefined, '"etag-1"']);
        expect(downloads()).toBe(1);
        expect(await cache.get(cacheKey)).toBe(token);
        expect(
          await skipReparseDiscoverer.getPools(
            ChainId.MAINNET,
            Protocol.V4,
            mockContext
          )
        ).toBe(served);
      });
    });

    describe('snapshot age gauge', () => {
      const gzippedData = readTestData('v4-pools.json.gz');
      const ageMetric =
        'UniRouteService.Metric.S3SubgraphPoolDiscoverer.SnapshotAgeSeconds';
      const laneTags = ['chain:MAINNET', 'protocol:v4', 'chainid:1'];
      const now = new Date('2026-10-23T14:00:00Z');
      const minutesAgo = (minutes: number) =>
        new Date(now.getTime() - minutes * 60_000);
      const spyOnGauge = () => vi.spyOn(mockContext.metrics, 'gauge');
      let gaugeSpy: ReturnType<typeof spyOnGauge>;

      beforeEach(() => {
        vi.useFakeTimers({toFake: ['Date']});
        vi.setSystemTime(now);
        gaugeSpy = spyOnGauge();
      });

      afterEach(() => {
        gaugeSpy.mockRestore();
        vi.useRealTimers();
      });

      // The fields S3 returns beside the body, as GetObject reports them.
      const serveObject = (object: {
        Metadata?: Record<string, string>;
        LastModified?: Date;
      }) =>
        vi.mocked(s3Client.send).mockResolvedValue({
          ...createMockResponse(gzippedData),
          ETag: '"etag-1"',
          ...object,
        } as never);
      const emittedAges = () =>
        gaugeSpy.mock.calls
          .filter(([name]) => name === ageMetric)
          .map(([, value, opts]) => ({value, tags: opts?.tags}));

      it('reports the age from the fetch start the cron recorded on the object', async () => {
        serveObject({
          Metadata: {'fetch-start-time': minutesAgo(10).toISOString()},
          LastModified: minutesAgo(1),
        });
        await discoverer.getPools(ChainId.MAINNET, Protocol.V4, mockContext);
        expect(emittedAges()).toEqual([{value: 600, tags: laneTags}]);
      });

      it('falls back to LastModified for an object written without the metadata', async () => {
        serveObject({LastModified: minutesAgo(120)});
        await discoverer.getPools(ChainId.MAINNET, Protocol.V4, mockContext);
        expect(emittedAges()).toEqual([{value: 7200, tags: laneTags}]);
      });

      it('ignores an unparseable fetch start and uses LastModified', async () => {
        serveObject({
          Metadata: {'fetch-start-time': 'yesterday'},
          LastModified: minutesAgo(30),
        });
        await discoverer.getPools(ChainId.MAINNET, Protocol.V4, mockContext);
        expect(emittedAges()).toEqual([{value: 1800, tags: laneTags}]);
      });

      it('emits no age and warns when the object carries neither timestamp', async () => {
        const warnContext = buildTestContext();
        serveObject({});
        await discoverer.getPools(ChainId.MAINNET, Protocol.V4, warnContext);
        expect(warnContext.metrics.gaugeStore[ageMetric]).toBeUndefined();
        expect(
          warnContext.logger.outputs.filter(
            ({prefix, msg}) =>
              prefix === 'WARN:' &&
              msg ===
                'Pool snapshot carries neither a fetch start nor LastModified'
          )
        ).toHaveLength(1);
      });

      it('keeps reporting a growing age across 304 refreshes without downloading again', async () => {
        const memoDiscoverer = new S3SubgraphPoolDiscovererV4(
          {
            ...mockConfig,
            PoolDiscovery: {
              ...mockConfig.PoolDiscovery,
              SnapshotMemoEnabled: true,
            },
          },
          getPoolsCache,
          getPoolsForTokensCache,
          FeatureGatedTokensRepository.empty(),
          s3Client,
          snapshotParseOffloader
        );
        let downloads = 0;
        vi.mocked(s3Client.send).mockImplementation((async (
          command: unknown
        ) => {
          if (
            command instanceof GetObjectCommand &&
            command.input.IfNoneMatch === '"etag-1"'
          ) {
            throw Object.assign(new Error('Not Modified'), {
              $metadata: {httpStatusCode: 304},
            });
          }
          downloads += 1;
          return {
            ...createMockResponse(gzippedData),
            ETag: '"etag-1"',
            Metadata: {'fetch-start-time': minutesAgo(5).toISOString()},
          };
        }) as never);

        await memoDiscoverer.prewarm(ChainId.MAINNET, Protocol.V4, mockContext);
        vi.setSystemTime(new Date(now.getTime() + 20 * 60_000));
        await memoDiscoverer.prewarm(ChainId.MAINNET, Protocol.V4, mockContext);

        expect(downloads).toBe(1);
        expect(emittedAges().map(({value}) => value)).toEqual([300, 1500]);
      });
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

    it('checks canonical-pool coverage against the loaded snapshot', async () => {
      // First pool of the fixture, and an id no snapshot contains.
      const token = '0x588ce4f028d8e7b53b687865d6a67b3a54c75518';
      const presentPool =
        '0x009e4bec17909bd85bfa66980a06b4f74f1b6d2ddb28ce8882055e81af14ac8f';
      const missingPool = `0x${'ee'.repeat(32)}`;
      CanonicalPools.__TEST_ONLY__injectTestData({
        [ChainId.MAINNET]: {[token]: [presentPool, missingPool]},
      });
      const gzippedData = readTestData('v4-pools.json.gz');
      vi.mocked(s3Client.send).mockResolvedValue(
        createMockResponse(gzippedData) as never
      );
      const countSpy = vi.spyOn(mockContext.metrics, 'count');

      try {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore - protected method access for testing
        await discoverer._getPools(ChainId.MAINNET, Protocol.V4, mockContext);

        expect(countSpy).toHaveBeenCalledWith(REGISTRY_COVERAGE_METRIC, 1, {
          tags: [
            'chain:MAINNET',
            'protocol:v4',
            `token:${token}`,
            'status:success',
          ],
        });
        expect(countSpy).toHaveBeenCalledWith(REGISTRY_COVERAGE_METRIC, 1, {
          tags: [
            'chain:MAINNET',
            'protocol:v4',
            `token:${token}`,
            'status:failure',
            'reason:no_canonical_pool_present',
          ],
        });
      } finally {
        countSpy.mockRestore();
        CanonicalPools.__TEST_ONLY__injectTestData();
      }
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
        s3Client,
        snapshotParseOffloader
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
        s3Client,
        snapshotParseOffloader
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
    // These tests deliver the base pool through a pair-cache HIT, and the
    // NO_HOOKS cases only read the cache when the variant rollout flag is
    // on (the discoverer-level backstop suppresses it otherwise) — matching
    // the deployed configuration.
    discoverer = new S3SubgraphPoolDiscovererV4(
      {
        ...mockConfig,
        PoolDiscovery: {
          ...mockConfig.PoolDiscovery,
          PoolsForTokensHooksVariantCacheEnabled: true,
        },
      },
      makeCache(),
      pairCache,
      FeatureGatedTokensRepository.empty(),
      s3Client,
      snapshotParseOffloader,
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

  it('skips scheduled pools with non-inert hooks (swap/accounting bits need selector-path support)', async () => {
    vi.mocked(repository.getActivePools).mockResolvedValue([
      activePool({hooks: '0x9999999999999999999999999999999999999999'}),
    ]);

    const pools = await getPoolsForTokens();

    expect(pools.map(pool => pool.id)).not.toContain('0xccapool');
  });

  it('skips scheduled pools above the static-fee sanity ceiling (confiscatory-fee registry entry)', async () => {
    vi.mocked(repository.getActivePools).mockResolvedValue([
      activePool({feeTier: '999000'}),
    ]);

    const pools = await getPoolsForTokens();

    expect(pools.map(pool => pool.id)).not.toContain('0xccapool');
  });

  it('merges scheduled pools at the static-fee sanity ceiling', async () => {
    vi.mocked(repository.getActivePools).mockResolvedValue([
      activePool({feeTier: '110000'}),
    ]);

    const pools = await getPoolsForTokens();

    expect(pools.map(pool => pool.id)).toContain('0xccapool');
  });

  it('merges scheduled pools with routing-inert hooks (LBP strategy-as-hook fallback)', async () => {
    // beforeInitialize-only permission bits (low 14 bits = 0x2000): the shape
    // migrate()'s front-run fallback rewrites key.hooks to.
    vi.mocked(repository.getActivePools).mockResolvedValue([
      activePool({hooks: '0xb98766a35cdc28415be0767d4ea41e39fba3e000'}),
    ]);

    const pools = await getPoolsForTokens();

    expect(pools.map(pool => pool.id)).toContain('0xccapool');
  });

  it('skips inert-hooked entries whose hook is denylisted (kill switch binds this path)', async () => {
    const inertHook = '0xb98766a35cdc28415be0767d4ea41e39fba3e000';
    HOOKS_ADDRESSES_DENYLIST[ChainId.MAINNET]!.push(inertHook);
    try {
      vi.mocked(repository.getActivePools).mockResolvedValue([
        activePool({hooks: inertHook}),
      ]);

      const pools = await getPoolsForTokens();

      expect(pools.map(pool => pool.id)).not.toContain('0xccapool');
    } finally {
      HOOKS_ADDRESSES_DENYLIST[ChainId.MAINNET]!.pop();
    }
  });

  it('skips inert-hooked entries with a dynamic fee (hook controls the LP fee)', async () => {
    vi.mocked(repository.getActivePools).mockResolvedValue([
      activePool({
        hooks: '0xb98766a35cdc28415be0767d4ea41e39fba3e000',
        feeTier: '8388608', // DYNAMIC_FEE_FLAG
      }),
    ]);

    const pools = await getPoolsForTokens();

    expect(pools.map(pool => pool.id)).not.toContain('0xccapool');
  });

  it('keeps NO_HOOKS fetches strictly hookless (inert-hooked entries excluded)', async () => {
    vi.mocked(repository.getActivePools).mockResolvedValue([
      activePool({hooks: '0xb98766a35cdc28415be0767d4ea41e39fba3e000'}),
    ]);

    const pools = await getPoolsForTokens(HooksOptions.NO_HOOKS);

    expect(pools.map(pool => pool.id)).not.toContain('0xccapool');
  });

  it('still merges hookless entries on NO_HOOKS fetches', async () => {
    const pools = await getPoolsForTokens(HooksOptions.NO_HOOKS);

    expect(pools.map(pool => pool.id)).toContain('0xccapool');
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
      snapshotParseOffloader,
      repository
    );

    const pools = await getPoolsForTokens();

    expect(pools.map(pool => pool.id)).not.toContain('0xccapool');
  });

  it('drops merged scheduled pools that are not canonical for the launched token', async () => {
    // The launched token's canonical pool is a different (hooked) pool, so
    // the registry's migration pool must not be re-appended around the
    // selector's filter.
    CanonicalPools.__TEST_ONLY__injectTestData({
      [ChainId.MAINNET]: {[NEW_TOKEN]: ['0xhookedcanonicalpool']},
    });

    try {
      const pools = await getPoolsForTokens();

      expect(pools.map(pool => pool.id)).not.toContain('0xccapool');
      expect(pools.map(pool => pool.id)).toContain('0xbasepool');
    } finally {
      CanonicalPools.__TEST_ONLY__injectTestData();
    }
  });

  it("keeps merged scheduled pools that are the launched token's canonical pool", async () => {
    CanonicalPools.__TEST_ONLY__injectTestData({
      [ChainId.MAINNET]: {[NEW_TOKEN]: ['0xccapool']},
    });

    try {
      const pools = await getPoolsForTokens();

      expect(pools.map(pool => pool.id)).toContain('0xccapool');
    } finally {
      CanonicalPools.__TEST_ONLY__injectTestData();
    }
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

describe('S3SubgraphPoolDiscoverer snapshot-parse offload wiring', () => {
  // Records every call it receives and returns a fixed, distinguishable
  // result, so these tests prove fetchSnapshot actually routes through the
  // injected offloader (and with what inputs) rather than parsing inline.
  class RecordingSnapshotParseOffloader implements ISnapshotParseOffloader {
    public calls: Array<{
      poolBytes: Uint8Array;
      params: SnapshotTransformParams;
    }> = [];
    constructor(
      private readonly result: {pools: UniPoolInfo[]} | {error: Error}
    ) {}

    async parseAndFilterSnapshot(
      poolBytes: Uint8Array,
      params: SnapshotTransformParams
    ) {
      this.calls.push({poolBytes, params});
      if ('error' in this.result) {
        throw this.result.error;
      }
      return {pools: this.result.pools, skippedRecords: {}};
    }

    async close(): Promise<void> {}
  }

  const gzippedData = readTestData('v4-pools.json.gz');
  let s3Client: S3Client;

  beforeEach(() => {
    s3Client = {
      send: vi.fn().mockResolvedValue(createMockResponse(gzippedData) as never),
    } as unknown as S3Client;
  });

  it('delegates the parse+filter to the injected offloader and serves exactly its result', async () => {
    const recordedPool = {
      id: '0xrecorded',
      feeTier: '3000',
      tickSpacing: '60',
      hooks: '0x0000000000000000000000000000000000000000',
      liquidity: '1',
      token0: {id: '0xaaa'},
      token1: {id: '0xbbb'},
      tvlETH: 1,
      tvlUSD: 1,
    };
    const offloader = new RecordingSnapshotParseOffloader({
      pools: [recordedPool],
    });
    const discoverer = new S3SubgraphPoolDiscovererV4(
      mockConfig,
      {
        get: vi.fn().mockResolvedValue(undefined),
        set: vi.fn().mockResolvedValue(undefined),
      } as unknown as IRedisCache<string, string>,
      {
        get: vi.fn().mockResolvedValue(undefined),
        set: vi.fn().mockResolvedValue(undefined),
      } as unknown as IRedisCache<string, string>,
      FeatureGatedTokensRepository.empty(),
      s3Client,
      offloader
    );

    const pools = await discoverer['_getPools'](
      ChainId.MAINNET,
      Protocol.V4,
      mockContext
    );

    expect(pools).toEqual([recordedPool]);
    expect(offloader.calls).toHaveLength(1);
    expect(offloader.calls[0].params.chainId).toBe(ChainId.MAINNET);
    expect(offloader.calls[0].params.protocol).toBe(Protocol.V4);
    expect(offloader.calls[0].poolBytes).toBeInstanceOf(Uint8Array);
    const decoded = Buffer.from(offloader.calls[0].poolBytes).toString('utf-8');
    expect(JSON.parse(decoded).length).toBeGreaterThan(0);
  });

  it('degrades to an empty pool list (and logs) when the offloader throws, matching the pre-existing inline-parse failure behavior (failure path)', async () => {
    const offloader = new RecordingSnapshotParseOffloader({
      error: new Error('boom'),
    });
    const discoverer = new S3SubgraphPoolDiscovererV4(
      mockConfig,
      {
        get: vi.fn().mockResolvedValue(undefined),
        set: vi.fn().mockResolvedValue(undefined),
      } as unknown as IRedisCache<string, string>,
      {
        get: vi.fn().mockResolvedValue(undefined),
        set: vi.fn().mockResolvedValue(undefined),
      } as unknown as IRedisCache<string, string>,
      FeatureGatedTokensRepository.empty(),
      s3Client,
      offloader
    );
    const testCtx = buildTestContext();

    const pools = await discoverer['_getPools'](
      ChainId.MAINNET,
      Protocol.V4,
      testCtx
    );

    expect(pools).toEqual([]);
    expect(
      testCtx.logger.outputs.some(
        entry =>
          entry.prefix === 'ERROR:' &&
          entry.msg === 'Error fetching pools from S3'
      )
    ).toBe(true);
  });
});

describe('S3SubgraphPoolDiscoverer when the snapshot parse offload fails', () => {
  const gzippedData = readTestData('v4-pools.json.gz');
  const params = {chainId: ChainId.MAINNET, protocol: Protocol.V4};
  const expectedPools = () =>
    transformSnapshotPoolBytes(inflateSync(gzippedData), params).pools;
  const swrConfig = (maxStaleSeconds = 2700): IUniRouteServiceConfig => ({
    ...mockConfig,
    PoolDiscovery: {
      ...mockConfig.PoolDiscovery,
      SnapshotMemoEnabled: true,
      SnapshotSwrEnabled: true,
      SnapshotMaxStaleSeconds: maxStaleSeconds,
    },
  });

  // Parses with the real transform until `fail` is set, then rejects the way
  // the worker pool does.
  class SwitchableOffloader implements ISnapshotParseOffloader {
    public fail = false;
    async parseAndFilterSnapshot(
      poolBytes: Uint8Array,
      transformParams: SnapshotTransformParams
    ): Promise<SnapshotTransformResult> {
      if (this.fail) {
        throw new SnapshotParseOffloadError(
          SnapshotParseOffloadFailureReason.TIMEOUT,
          'Snapshot parse worker job timed out'
        );
      }
      return transformSnapshotPoolBytes(poolBytes, transformParams);
    }
    async close(): Promise<void> {}
  }

  /** TestMetric, but keeping each count's tags. */
  class FakeRecordingMetrics extends TestMetric {
    public readonly counts: {name: string; val: number; tags: string[]}[] = [];
    override async count(
      metric_name: string,
      val: number,
      opts?: MetricOptions
    ): Promise<void> {
      this.counts.push({name: metric_name, val, tags: [...(opts?.tags ?? [])]});
      await super.count(metric_name, val, opts);
    }
  }
  const recordingContext = () => {
    const ctx = buildTestContext();
    const metrics = new FakeRecordingMetrics();
    ctx.metrics = metrics;
    return {ctx, metrics};
  };
  const fallbackTags = (metrics: FakeRecordingMetrics) =>
    metrics.counts
      .filter(
        count =>
          count.name ===
          'UniRouteService.Metric.S3SubgraphPoolDiscoverer.SnapshotParseFallback'
      )
      .map(count => count.tags);

  const s3Serving = (gzipped: Buffer): S3Client =>
    ({
      send: vi.fn().mockImplementation(async () => createMockResponse(gzipped)),
    }) as unknown as S3Client;

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps serving the held snapshot when a refresh cannot be parsed off the event loop (failure path)', async () => {
    const offloader = new SwitchableOffloader();
    const cache = new InMemoryRedisCache<string, string>();
    const discoverer = new S3SubgraphPoolDiscovererV4(
      swrConfig(),
      cache,
      new InMemoryRedisCache<string, string>(),
      FeatureGatedTokensRepository.empty(),
      s3Serving(gzippedData),
      offloader
    );
    await discoverer.prewarm(ChainId.MAINNET, Protocol.V4, mockContext);
    const held = await discoverer.getPools(
      ChainId.MAINNET,
      Protocol.V4,
      mockContext
    );
    expect(held).toEqual(expectedPools());

    offloader.fail = true;
    const {ctx, metrics} = recordingContext();
    await discoverer.prewarm(ChainId.MAINNET, Protocol.V4, ctx);
    const served = await discoverer.getPools(ChainId.MAINNET, Protocol.V4, ctx);

    expect(served).toBe(held);
    expect(fallbackTags(metrics)).toEqual([
      [
        'chain:MAINNET',
        'protocol:v4',
        'status:failure',
        'reason:timeout',
        'fallback:kept_held_snapshot',
      ],
    ]);
  });

  it('parses on the main thread when there is no held snapshot to keep (failure path)', async () => {
    const offloader = new SwitchableOffloader();
    offloader.fail = true;
    const discoverer = new S3SubgraphPoolDiscovererV4(
      swrConfig(),
      new InMemoryRedisCache<string, string>(),
      new InMemoryRedisCache<string, string>(),
      FeatureGatedTokensRepository.empty(),
      s3Serving(gzippedData),
      offloader
    );
    const {ctx, metrics} = recordingContext();

    const served = await discoverer.getPools(ChainId.MAINNET, Protocol.V4, ctx);

    expect(served).toEqual(expectedPools());
    expect(fallbackTags(metrics)).toEqual([
      [
        'chain:MAINNET',
        'protocol:v4',
        'status:failure',
        'reason:timeout',
        'fallback:main_thread_parse',
      ],
    ]);
  });

  it('parses on the main thread once the held snapshot is past the stale-serve bound (failure path)', async () => {
    vi.useFakeTimers({toFake: ['Date']});
    const offloader = new SwitchableOffloader();
    const discoverer = new S3SubgraphPoolDiscovererV4(
      swrConfig(60),
      new InMemoryRedisCache<string, string>(),
      new InMemoryRedisCache<string, string>(),
      FeatureGatedTokensRepository.empty(),
      s3Serving(gzippedData),
      offloader
    );
    await discoverer.prewarm(ChainId.MAINNET, Protocol.V4, mockContext);

    vi.setSystemTime(Date.now() + 61_000);
    offloader.fail = true;
    const {ctx, metrics} = recordingContext();
    await discoverer.prewarm(ChainId.MAINNET, Protocol.V4, ctx);

    expect(fallbackTags(metrics)).toEqual([
      [
        'chain:MAINNET',
        'protocol:v4',
        'status:failure',
        'reason:timeout',
        'fallback:main_thread_parse',
      ],
    ]);
  });

  it('never defers a direct _getPools load (failure path)', async () => {
    const offloader = new SwitchableOffloader();
    const discoverer = new S3SubgraphPoolDiscovererV4(
      swrConfig(),
      new InMemoryRedisCache<string, string>(),
      new InMemoryRedisCache<string, string>(),
      FeatureGatedTokensRepository.empty(),
      s3Serving(gzippedData),
      offloader
    );
    await discoverer.prewarm(ChainId.MAINNET, Protocol.V4, mockContext);
    offloader.fail = true;

    const pools = await discoverer['_getPools'](
      ChainId.MAINNET,
      Protocol.V4,
      mockContext
    );

    expect(pools).toEqual(expectedPools());
  });
});

describe('S3SubgraphPoolDiscoverer with a malformed snapshot record', () => {
  const params = {chainId: ChainId.MAINNET, protocol: Protocol.V4};
  const fixtureRecords = (): unknown[] => {
    const records: unknown = JSON.parse(
      inflateSync(readTestData('v4-pools.json.gz')).toString('utf-8')
    );
    if (!Array.isArray(records)) {
      throw new Error('fixture is not an array');
    }
    return records;
  };

  it.each([
    {
      name: 'flag off (main-thread parse)',
      offloader: () => new MainThreadSnapshotParseOffloader(),
    },
    {
      name: 'flag on (worker pool)',
      offloader: () =>
        new WorkerThreadSnapshotParseOffloader(
          () => new FakeSnapshotParseWorkerHandle(),
          1,
          10_000,
          10_000
        ),
    },
  ])(
    '$name: skips only that record and serves the rest of the snapshot (failure path)',
    async ({offloader}) => {
      const records = fixtureRecords();
      const intact = transformSnapshotPoolBytes(
        new TextEncoder().encode(JSON.stringify(records)),
        params
      ).pools;
      const [first, ...rest] = records;
      if (
        typeof first !== 'object' ||
        first === null ||
        !('id' in first) ||
        typeof first.id !== 'string'
      ) {
        throw new Error('fixture record has no string id');
      }
      const corruptedId = first.id.toLowerCase();
      const corrupted = deflateSync(
        Buffer.from(
          JSON.stringify([{...first, liquidity: {unexpected: true}}, ...rest])
        )
      );
      const discoverer = new S3SubgraphPoolDiscovererV4(
        mockConfig,
        new InMemoryRedisCache<string, string>(),
        new InMemoryRedisCache<string, string>(),
        FeatureGatedTokensRepository.empty(),
        {
          send: vi
            .fn()
            .mockImplementation(async () => createMockResponse(corrupted)),
        } as unknown as S3Client,
        offloader()
      );
      const ctx = buildTestContext();

      const pools = await discoverer.getPools(
        ChainId.MAINNET,
        Protocol.V4,
        ctx
      );

      expect(pools.length).toBeGreaterThan(0);
      expect(pools).toEqual(intact.filter(pool => pool.id !== corruptedId));
      expect(
        ctx.metrics.countStore[
          'UniRouteService.Metric.S3SubgraphPoolDiscoverer.SkippedSnapshotRecord'
        ]
      ).toBe(1);
    }
  );
});
