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
import {V2PoolInfo, V4PoolInfo} from '../interface';
import {sdkStreamMixin} from '@smithy/util-stream';
import {Readable} from 'stream';
import {FeatureGatedTokensRepository} from '../../../stores/compliance/FeatureGatedTokensRepository';

const mockConfig: IUniRouteServiceConfig = getUniRouteTestConfig();
const mockContext: Context = buildTestContext();

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
