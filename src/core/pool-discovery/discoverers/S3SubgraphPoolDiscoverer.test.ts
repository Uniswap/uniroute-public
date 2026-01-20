import {
  S3SubgraphPoolDiscovererV2,
  S3SubgraphPoolDiscovererV3,
  S3SubgraphPoolDiscovererV4,
} from './S3SubgraphPoolDiscoverer';
import {buildTestContext} from '@uniswap/lib-testhelpers';
import AWS from 'aws-sdk';
import {AWSError} from 'aws-sdk';
import {IRedisCache} from '@uniswap/lib-cache';
import {
  getUniRouteTestConfig,
  IUniRouteServiceConfig,
} from '../../../lib/config';
import {ChainId} from '../../../lib/config';
import {UniProtocol} from '../../../models/pool/UniProtocol';
import {Context} from '@uniswap/lib-uni/context';
import {readFileSync} from 'fs';
import {join} from 'path';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {Request} from 'aws-sdk/lib/request';
import {GetObjectOutput} from 'aws-sdk/clients/s3';
import {V2PoolInfo} from '../interface';

const mockConfig: IUniRouteServiceConfig = getUniRouteTestConfig();
const mockContext: Context = buildTestContext();

// Helper to read test data
const readTestData = (filename: string): Buffer => {
  return readFileSync(join(process.cwd(), 'tests/data', filename));
};

// Helper to create a mock S3 request
const createMockRequest = (responseData: GetObjectOutput) =>
  ({
    promise: vi.fn().mockResolvedValue(responseData),
    abort: vi.fn(),
    createReadStream: vi.fn(),
    eachPage: vi.fn(),
    isPageable: vi.fn(),
    send: vi.fn(),
    on: vi.fn(),
  }) as unknown as Request<GetObjectOutput, AWSError>;

describe('S3SubgraphPoolDiscoverer', () => {
  let s3Client: AWS.S3;

  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();

    // Mock S3 client
    s3Client = {
      getObject: vi.fn().mockReturnValue(createMockRequest({})),
    } as unknown as AWS.S3;
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
        new Set<string>(),
        s3Client
      );
    });

    it('should correctly parse V2 pools from gzipped data', async () => {
      const gzippedData = readTestData('v2-pools.json.gz');
      vi.mocked(s3Client.getObject).mockReturnValue(
        createMockRequest({Body: gzippedData})
      );
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore - protected method access for testing
      const pools = await discoverer._getPools(
        ChainId.MAINNET,
        UniProtocol.V2,
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
        new Set<string>(),
        s3Client
      );
    });

    it('should correctly parse V3 pools from gzipped data', async () => {
      const gzippedData = readTestData('v3-pools.json.gz');
      vi.mocked(s3Client.getObject).mockReturnValue(
        createMockRequest({Body: gzippedData})
      );
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore - protected method access for testing
      const pools = await discoverer._getPools(
        ChainId.MAINNET,
        UniProtocol.V3,
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
        new Set<string>(),
        s3Client
      );
    });

    it('should correctly parse V4 pools from gzipped data', async () => {
      const gzippedData = readTestData('v4-pools.json.gz');
      vi.mocked(s3Client.getObject).mockReturnValue(
        createMockRequest({Body: gzippedData})
      );
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore - protected method access for testing
      const pools = await discoverer._getPools(
        ChainId.MAINNET,
        UniProtocol.V4,
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
        new Set<string>(),
        s3Client
      );
    });

    it('should handle missing S3 data gracefully', async () => {
      vi.mocked(s3Client.getObject).mockReturnValue(
        createMockRequest({Body: undefined})
      );
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore - protected method access for testing
      const pools = await discoverer._getPools(
        ChainId.MAINNET,
        UniProtocol.V2,
        mockContext
      );

      expect(pools).toEqual([]);
    });

    it('should handle S3 errors gracefully', async () => {
      vi.mocked(s3Client.getObject).mockReturnValue({
        promise: vi.fn().mockRejectedValue(new Error('S3 error')),
        abort: vi.fn(),
        createReadStream: vi.fn(),
        eachPage: vi.fn(),
        isPageable: vi.fn(),
        send: vi.fn(),
        on: vi.fn(),
      } as unknown as Request<GetObjectOutput, AWSError>);

      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore - protected method access for testing
      const pools = await discoverer._getPools(
        ChainId.MAINNET,
        UniProtocol.V2,
        mockContext
      );

      expect(pools).toEqual([]);
    });
  });
});
