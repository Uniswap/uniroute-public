import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import * as zlib from 'zlib';
import {
  cacheAllPools,
  CachePoolsConfig,
  ExtraPoolSourceUnavailableError,
  withExtraPoolSource,
} from './cachePools';
import {AuroraSourcedExtraPoolsProvider} from './auroraExtraPoolSources';
import {AuroraSourcedProvider} from './auroraPoolsSource';
import {
  POOL_ACTIVITY_SIGNAL_MAX_STALENESS_MS,
  POOL_ACTIVITY_WINDOW_MS,
} from './util/poolActivityFilter';
import {
  ExtraPoolSourceName,
  type ExtraPoolsSource,
  MAINNET_V3_MANUAL_POOL_IDS,
  V4_EXTRA_POOL_SOURCE_MEMORY,
  extraSourceKey,
  resetExtraPoolSourceMemoryForTesting,
} from './extraPoolSources';
import {
  EXTRA_POOL_SOURCE_LAST_GOOD_MAX_AGE_MS,
  ExtraPoolSourceMemory,
} from './extraPoolSourceMemory';
import type {Logger} from './sor-providers/util/log';
import {IMetric, MetricLoggerUnit} from './sor-providers/util/metric';
import type {
  EulerSwapHooks,
  IAggHooksSubgraphProvider,
  IEulerSwapHooksSubgraphProvider,
  ProviderConfig,
  V3SubgraphPool,
  V4SubgraphPool,
} from './sor-providers';
import {Protocol} from '@uniswap/router-sdk';
import {ChainId} from '@uniswap/sdk-core';

// Mock @aws-sdk/client-s3
const sendMock = vi.fn().mockResolvedValue({});
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class MockS3Client {
    send = sendMock;
  },
  PutObjectCommand: class MockPutObjectCommand {
    readonly commandType = 'PutObject';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(public readonly input: any) {}
  },
  HeadObjectCommand: class MockHeadObjectCommand {
    readonly commandType = 'HeadObject';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(public readonly input: any) {}
  },
}));

// Each successful write is a HeadObject (freshness guard) then a PutObject.
const putObjectCalls = () =>
  sendMock.mock.calls
    .map(call => call[0])
    .filter(cmd => cmd.commandType === 'PutObject');

// We need a mutable reference so each test can override the return value
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockChainProtocols: any[] = [];

vi.mock('./cacheConfig', async importOriginal => {
  const original = await importOriginal<typeof import('./cacheConfig')>();
  return {
    ...original,
    createChainProtocols: () => mockChainProtocols,
  };
});

// Mock v4HooksPoolsFiltering to pass through pools (avoids importing full dependency chain)
vi.mock('./util/v4HooksPoolsFiltering', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  v4HooksPoolsFiltering: (_chainId: any, pools: any[]) => pools,
}));

// Lets a test make the inline mainnet V3 extra fetch throw.
const v3ManualFetch = vi.hoisted((): {error?: Error} => ({}));

// Mock V2SubgraphProvider and V3SubgraphProvider constructors used inside cachePoolsForChainProtocol
vi.mock('./sor-providers', () => ({
  V2SubgraphProvider: class {
    async getPools() {
      return [];
    }
  },
  V3SubgraphProvider: class {
    async getPools() {
      if (v3ManualFetch.error) throw v3ManualFetch.error;
      return [];
    }
  },
  V4SubgraphProvider: class {
    async getPools() {
      return [];
    }
  },
  EulerSwapHooksSubgraphProvider: class {
    async getHooks() {
      return [];
    }
    async getPoolByHook() {
      return null;
    }
  },
}));

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
  };
}

class MockMetric extends IMetric {
  readonly calls: Array<{
    key: string;
    value: number;
    unit: MetricLoggerUnit;
    tags?: Record<string, string>;
  }> = [];
  setProperty(_key: string, _value: unknown): void {}
  putDimensions(_dimensions: Record<string, string>): void {}
  putMetric(
    key: string,
    value: number,
    unit: MetricLoggerUnit,
    tags?: Record<string, string>
  ): void {
    this.calls.push({key, value, unit, tags});
  }
}

// Closure-based fakes for the extra V4 pool sources (implements their real
// interfaces, so a signature drift fails the compile rather than staying
// silently stale).
class FakeEulerSwapHooksSubgraphProvider
  implements IEulerSwapHooksSubgraphProvider
{
  constructor(
    private readonly hooks: EulerSwapHooks[] = [],
    private readonly poolByHook: Record<
      string,
      V4SubgraphPool | undefined
    > = {},
    private readonly error?: Error
  ) {}

  async getHooks(_providerConfig?: ProviderConfig): Promise<EulerSwapHooks[]> {
    if (this.error) {
      throw this.error;
    }
    return this.hooks;
  }

  async getPoolByHook(
    hook: string,
    _providerConfig?: ProviderConfig
  ): Promise<V4SubgraphPool | undefined> {
    return this.poolByHook[hook];
  }
}

class FakeAggHooksSubgraphProvider implements IAggHooksSubgraphProvider {
  constructor(
    private readonly pools: V4SubgraphPool[] = [],
    private readonly error?: Error
  ) {}

  async getPools(_providerConfig?: ProviderConfig): Promise<V4SubgraphPool[]> {
    if (this.error) {
      throw this.error;
    }
    return this.pools;
  }
}

// Inflates a written snapshot back into its pool ids, so tests assert on
// the snapshot the job wrote rather than on "S3 was called".
function writtenPoolIds(body: Buffer): string[] {
  const parsed: unknown = JSON.parse(zlib.inflateSync(body).toString('utf8'));
  if (!Array.isArray(parsed)) throw new Error('snapshot is not an array');
  return parsed.map((pool: unknown) => {
    if (
      typeof pool !== 'object' ||
      pool === null ||
      !('id' in pool) ||
      typeof pool.id !== 'string'
    ) {
      throw new Error('snapshot pool has no string id');
    }
    return pool.id;
  });
}

function makePool(id: string, token0Id: string, token1Id: string) {
  return {
    id,
    token0: {id: token0Id},
    token1: {id: token1Id},
    supply: 1000,
    reserve: 100,
    reserveUSD: 50000,
  };
}

function makeV3Pool(id: string, token0Id: string, token1Id: string) {
  return {
    id,
    feeTier: '3000',
    liquidity: '1000000',
    token0: {id: token0Id, symbol: 'A', name: 'A', decimals: '18'},
    token1: {id: token1Id, symbol: 'B', name: 'B', decimals: '18'},
    tvlETH: 10,
    tvlUSD: 20000,
  };
}

function makeV4Pool(
  id: string,
  hooks: string,
  token0Id: string,
  token1Id: string
) {
  return {
    id,
    feeTier: '3000',
    tickSpacing: '60',
    hooks,
    liquidity: '1000000',
    token0: {id: token0Id, symbol: 'A', name: 'A', decimals: '18'},
    token1: {id: token1Id, symbol: 'B', name: 'B', decimals: '18'},
    tvlETH: 10,
    tvlUSD: 20000,
  };
}

describe('cacheAllPools', () => {
  let mockLogger: Logger;
  let mockMetric: MockMetric;
  const config: CachePoolsConfig = {
    s3Bucket: 'test-bucket',
    s3CacheKey: 'poolCacheGzip.json',
  };

  beforeEach(() => {
    mockLogger = createMockLogger();
    mockMetric = new MockMetric();
    mockChainProtocols = [];
    v3ManualFetch.error = undefined;
    resetExtraPoolSourceMemoryForTesting();
    sendMock.mockClear();
    sendMock.mockResolvedValue({});
  });

  it('completes successfully with empty chainProtocols', async () => {
    await expect(
      cacheAllPools(mockLogger, mockMetric, config)
    ).resolves.toMatchObject({succeeded: 0, failed: 0});
  });

  it('completes with custom batch size', async () => {
    await expect(
      cacheAllPools(mockLogger, mockMetric, config, 3)
    ).resolves.toMatchObject({succeeded: 0, failed: 0});
  });

  it('processes only the matching chain+protocol when `only` is set', async () => {
    const CHAIN_ID_ROBINHOOD = 4663 as ChainId;
    const robinhoodGetPools = vi.fn().mockResolvedValue([]);
    const mainnetGetPools = vi.fn().mockResolvedValue([]);
    mockChainProtocols = [
      {
        protocol: Protocol.V4,
        chainId: CHAIN_ID_ROBINHOOD,
        timeout: 90000,
        provider: {getPools: robinhoodGetPools},
      },
      {
        protocol: Protocol.V2,
        chainId: ChainId.MAINNET,
        timeout: 90000,
        provider: {getPools: mainnetGetPools},
      },
    ];

    await cacheAllPools(mockLogger, mockMetric, config, 5, 300000, [
      {chainId: CHAIN_ID_ROBINHOOD, protocol: Protocol.V4},
    ]);

    expect(robinhoodGetPools).toHaveBeenCalled();
    expect(mainnetGetPools).not.toHaveBeenCalled();
  });

  it('logs an error when `only` matches no configured chain+protocols', async () => {
    mockChainProtocols = [
      {
        protocol: Protocol.V2,
        chainId: ChainId.MAINNET,
        timeout: 90000,
        provider: {getPools: vi.fn().mockResolvedValue([])},
      },
    ];

    // e.g. the target chain was removed from createChainProtocols — the run
    // must be self-reporting, not a silent success-shaped no-op.
    await expect(
      cacheAllPools(mockLogger, mockMetric, config, 5, 300000, [
        {chainId: 999999 as ChainId, protocol: Protocol.V4},
      ])
    ).resolves.toMatchObject({succeeded: 0, failed: 0});
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('matched no configured chain+protocols')
    );
    expect(putObjectCalls()).toHaveLength(0);
  });

  it('processes everything when `only` is undefined or empty', async () => {
    const getPoolsA = vi.fn().mockResolvedValue([]);
    const getPoolsB = vi.fn().mockResolvedValue([]);
    mockChainProtocols = [
      {
        protocol: Protocol.V4,
        chainId: ChainId.UNICHAIN,
        timeout: 90000,
        provider: {getPools: getPoolsA},
      },
      {
        protocol: Protocol.V2,
        chainId: ChainId.MAINNET,
        timeout: 90000,
        provider: {getPools: getPoolsB},
      },
    ];

    await cacheAllPools(mockLogger, mockMetric, config, 5, 300000, []);

    expect(getPoolsA).toHaveBeenCalled();
    expect(getPoolsB).toHaveBeenCalled();
  });

  // --- V2 MAINNET special case ---
  describe('V2 mainnet special case', () => {
    it('processes V2 mainnet pools with manually included pools and filterOut list', async () => {
      const pools = [
        makePool('0xabc123', '0x1111', '0x2222'),
        // Include a pool address that should be filtered out
        makePool(
          '0x029c9f16d219486305716f8c623739f9c75ceabd',
          '0x3333',
          '0x4444'
        ),
      ];
      mockChainProtocols = [
        {
          protocol: Protocol.V2,
          chainId: ChainId.MAINNET,
          timeout: 90000,
          provider: {getPools: vi.fn().mockResolvedValue(pools)},
        },
      ];

      await cacheAllPools(mockLogger, mockMetric, config);

      // S3 putObject should have been called (pools exist after filtering)
      expect(sendMock).toHaveBeenCalled();
      // The filtered out pool log message should have been emitted
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Filtering out pool')
      );
    });
  });

  // --- V3 MAINNET special case ---
  describe('V3 mainnet special case', () => {
    it('processes V3 mainnet pools, filters by token and pool id', async () => {
      const pools = [
        makeV3Pool('0xgoodpool', '0x1111', '0x2222'),
        // Pool with filtered token0
        makeV3Pool(
          '0xbadtoken',
          '0xd46ba6d942050d489dbd938a2c909a5d5039a161',
          '0x2222'
        ),
        // Pool with filtered pool id
        makeV3Pool(
          '0x0f681f10ab1aa1cde04232a199fe3c6f2652a80c',
          '0x1111',
          '0x2222'
        ),
      ];
      mockChainProtocols = [
        {
          protocol: Protocol.V3,
          chainId: ChainId.MAINNET,
          timeout: 90000,
          provider: {getPools: vi.fn().mockResolvedValue(pools)},
        },
      ];

      await cacheAllPools(mockLogger, mockMetric, config);

      expect(sendMock).toHaveBeenCalled();
      // Should log filtering messages for the 2 filtered pools
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const filterCalls = (mockLogger.info as any).mock.calls.filter(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (c: any[]) =>
          typeof c[0] === 'string' && c[0].includes('Filtering out pool')
      );
      expect(filterCalls.length).toBe(2);
    });
  });

  // --- V4 special cases ---
  describe('V4 protocol', () => {
    it('processes V4 UNICHAIN pools with manually included ETH/WETH pool', async () => {
      const pools = [
        makeV4Pool(
          '0xsomeid',
          '0x0000000000000000000000000000000000000000',
          '0x1111',
          '0x2222'
        ),
      ];
      mockChainProtocols = [
        {
          protocol: Protocol.V4,
          chainId: ChainId.UNICHAIN,
          timeout: 90000,
          provider: {getPools: vi.fn().mockResolvedValue(pools)},
        },
      ];

      await cacheAllPools(mockLogger, mockMetric, config);
      expect(sendMock).toHaveBeenCalled();
    });

    it('processes V4 OPTIMISM pools with manually included ETH/WETH pool', async () => {
      const pools = [
        makeV4Pool(
          '0xsomeid',
          '0x0000000000000000000000000000000000000000',
          '0x1111',
          '0x2222'
        ),
      ];
      mockChainProtocols = [
        {
          protocol: Protocol.V4,
          chainId: ChainId.OPTIMISM,
          timeout: 90000,
          provider: {getPools: vi.fn().mockResolvedValue(pools)},
        },
      ];

      await cacheAllPools(mockLogger, mockMetric, config);
      expect(sendMock).toHaveBeenCalled();
    });

    it('processes V4 BASE pools with manually included ETH/WETH and graduation hooks', async () => {
      const pools = [
        makeV4Pool(
          '0xsomeid',
          '0x0000000000000000000000000000000000000000',
          '0x1111',
          '0x2222'
        ),
      ];
      mockChainProtocols = [
        {
          protocol: Protocol.V4,
          chainId: ChainId.BASE,
          timeout: 90000,
          provider: {getPools: vi.fn().mockResolvedValue(pools)},
        },
      ];

      await cacheAllPools(mockLogger, mockMetric, config);
      // Should have pools: 1 from subgraph + 1 ETH/WETH + 3 graduation hooks = 5
      expect(sendMock).toHaveBeenCalled();
    });

    it('processes V4 ARBITRUM_ONE pools with manually included ETH/WETH pool', async () => {
      const pools = [
        makeV4Pool(
          '0xsomeid',
          '0x0000000000000000000000000000000000000000',
          '0x1111',
          '0x2222'
        ),
      ];
      mockChainProtocols = [
        {
          protocol: Protocol.V4,
          chainId: ChainId.ARBITRUM_ONE,
          timeout: 90000,
          provider: {getPools: vi.fn().mockResolvedValue(pools)},
        },
      ];

      await cacheAllPools(mockLogger, mockMetric, config);
      expect(sendMock).toHaveBeenCalled();
    });

    it('processes V4 MAINNET pools with manually included ETH/WETH pool', async () => {
      const pools = [
        makeV4Pool(
          '0xsomeid',
          '0x0000000000000000000000000000000000000000',
          '0x1111',
          '0x2222'
        ),
      ];
      mockChainProtocols = [
        {
          protocol: Protocol.V4,
          chainId: ChainId.MAINNET,
          timeout: 90000,
          provider: {getPools: vi.fn().mockResolvedValue(pools)},
        },
      ];

      await cacheAllPools(mockLogger, mockMetric, config);
      expect(sendMock).toHaveBeenCalled();
    });

    it('processes V4 MONAD pools with manually included MON/WMON pool', async () => {
      const pools = [
        makeV4Pool(
          '0xsomeid',
          '0x0000000000000000000000000000000000000000',
          '0x1111',
          '0x2222'
        ),
      ];
      mockChainProtocols = [
        {
          protocol: Protocol.V4,
          chainId: ChainId.MONAD,
          timeout: 90000,
          provider: {getPools: vi.fn().mockResolvedValue(pools)},
        },
      ];

      await cacheAllPools(mockLogger, mockMetric, config);
      expect(sendMock).toHaveBeenCalled();
    });

    it('processes V4 with eulerHooksProvider that returns hooks and pools', async () => {
      const pools = [
        makeV4Pool(
          '0xsomeid',
          '0x0000000000000000000000000000000000000000',
          '0x1111',
          '0x2222'
        ),
      ];
      const eulerPool = makeV4Pool(
        '0xeuler',
        '0x0000000000000000000000000000000000000000',
        '0xaaaa',
        '0xbbbb'
      );
      mockChainProtocols = [
        {
          protocol: Protocol.V4,
          chainId: ChainId.MAINNET,
          timeout: 90000,
          provider: {getPools: vi.fn().mockResolvedValue(pools)},
          eulerHooksProvider: {
            getHooks: vi.fn().mockResolvedValue([{hook: '0xeulerhook1'}]),
            getPoolByHook: vi.fn().mockResolvedValue(eulerPool),
          },
        },
      ];

      await cacheAllPools(mockLogger, mockMetric, config);
      expect(sendMock).toHaveBeenCalled();
    });

    it('processes V4 with eulerHooksProvider that returns null pool for a hook', async () => {
      const pools = [
        makeV4Pool(
          '0xsomeid',
          '0x0000000000000000000000000000000000000000',
          '0x1111',
          '0x2222'
        ),
      ];
      mockChainProtocols = [
        {
          protocol: Protocol.V4,
          chainId: ChainId.MAINNET,
          timeout: 90000,
          provider: {getPools: vi.fn().mockResolvedValue(pools)},
          eulerHooksProvider: {
            getHooks: vi.fn().mockResolvedValue([{hook: '0xeulerhook1'}]),
            getPoolByHook: vi.fn().mockResolvedValue(null),
          },
        },
      ];

      await cacheAllPools(mockLogger, mockMetric, config);
      expect(sendMock).toHaveBeenCalled();
    });

    it('processes V4 with eulerHooksProvider that returns null hooks', async () => {
      const pools = [
        makeV4Pool(
          '0xsomeid',
          '0x0000000000000000000000000000000000000000',
          '0x1111',
          '0x2222'
        ),
      ];
      mockChainProtocols = [
        {
          protocol: Protocol.V4,
          chainId: ChainId.MAINNET,
          timeout: 90000,
          provider: {getPools: vi.fn().mockResolvedValue(pools)},
          eulerHooksProvider: {
            getHooks: vi.fn().mockResolvedValue(null),
            getPoolByHook: vi.fn(),
          },
        },
      ];

      await cacheAllPools(mockLogger, mockMetric, config);
      expect(sendMock).toHaveBeenCalled();
    });
  });

  // --- Empty pools early return ---
  describe('empty pools early return', () => {
    it('returns early and does not upload to S3 when getPools returns empty array', async () => {
      mockChainProtocols = [
        {
          protocol: Protocol.V2,
          chainId: ChainId.POLYGON,
          timeout: 90000,
          provider: {getPools: vi.fn().mockResolvedValue([])},
        },
      ];

      await cacheAllPools(mockLogger, mockMetric, config);
      expect(putObjectCalls()).toHaveLength(0);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('No pools found from the subgraph')
      );
    });

    it('returns early when getPools returns null', async () => {
      mockChainProtocols = [
        {
          protocol: Protocol.V3,
          chainId: ChainId.POLYGON,
          timeout: 90000,
          provider: {getPools: vi.fn().mockResolvedValue(null)},
        },
      ];

      await cacheAllPools(mockLogger, mockMetric, config);
      expect(putObjectCalls()).toHaveLength(0);
    });
  });

  // --- Error handling in getPools ---
  describe('error handling', () => {
    it('logs error and continues when getPools throws', async () => {
      mockChainProtocols = [
        {
          protocol: Protocol.V2,
          chainId: ChainId.POLYGON,
          timeout: 90000,
          provider: {
            getPools: vi.fn().mockRejectedValue(new Error('subgraph down')),
          },
        },
      ];

      // Should not throw because Promise.allSettled is used
      await expect(
        cacheAllPools(mockLogger, mockMetric, config)
      ).resolves.toMatchObject({succeeded: 0, failed: 1});
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to cache pools'),
        expect.anything()
      );
    });

    it('keeps the previous snapshot when an Aurora-primary read is rejected', async () => {
      let subgraphCalls = 0;
      const subgraph = {
        getPools: async (): Promise<V3SubgraphPool[]> => {
          subgraphCalls++;
          return [];
        },
      };
      const aurora = {
        getPools: async (): Promise<V3SubgraphPool[]> => {
          throw new Error('statement timeout');
        },
      };
      mockChainProtocols = [
        {
          protocol: Protocol.V3,
          chainId: ChainId.POLYGON,
          timeout: 90000,
          provider: new AuroraSourcedProvider(
            'primary',
            aurora,
            subgraph,
            ChainId.POLYGON,
            Protocol.V3,
            0.5,
            0,
            mockLogger,
            mockMetric
          ),
        },
      ];

      await expect(
        cacheAllPools(mockLogger, mockMetric, config)
      ).resolves.toMatchObject({succeeded: 0, failed: 1});
      expect(subgraphCalls).toBe(0);
      expect(putObjectCalls()).toEqual([]);
    });
  });

  // --- S3 upload path ---
  describe('S3 upload', () => {
    it('compresses and uploads pools to S3 with correct bucket and key', async () => {
      const pools = [makePool('0xaaa', '0x1111', '0x2222')];
      mockChainProtocols = [
        {
          protocol: Protocol.V2,
          chainId: ChainId.POLYGON,
          timeout: 90000,
          provider: {getPools: vi.fn().mockResolvedValue(pools)},
        },
      ];

      await cacheAllPools(mockLogger, mockMetric, config);
      expect(putObjectCalls()).toHaveLength(1);
      const cmd = putObjectCalls()[0];
      expect(cmd.input.Bucket).toBe('test-bucket');
      expect(cmd.input.Key).toContain('poolCacheGzip.json');
      expect(cmd.input.Body).toBeInstanceOf(Buffer);
    });
  });

  // --- Batch processing with rejected promises ---
  describe('batch processing', () => {
    it('handles mixed success and failure in a batch', async () => {
      mockChainProtocols = [
        {
          protocol: Protocol.V2,
          chainId: ChainId.POLYGON,
          timeout: 90000,
          provider: {
            getPools: vi
              .fn()
              .mockResolvedValue([makePool('0xaaa', '0x1111', '0x2222')]),
          },
        },
        {
          protocol: Protocol.V3,
          chainId: ChainId.POLYGON,
          timeout: 90000,
          provider: {getPools: vi.fn().mockRejectedValue(new Error('timeout'))},
        },
        {
          protocol: Protocol.V2,
          chainId: ChainId.ARBITRUM_ONE,
          timeout: 90000,
          provider: {
            getPools: vi
              .fn()
              .mockResolvedValue([makePool('0xbbb', '0x3333', '0x4444')]),
          },
        },
      ];

      await expect(
        cacheAllPools(mockLogger, mockMetric, config, 2)
      ).resolves.toMatchObject({succeeded: 2, failed: 1});
      // First batch: polygon V2 succeeds, polygon V3 fails
      // Second batch: arbitrum V2 succeeds
      expect(putObjectCalls()).toHaveLength(2);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to cache pools'),
        expect.anything()
      );
    });

    it('skips the write when the existing snapshot was fetched more recently (metadata arbitration)', async () => {
      sendMock.mockImplementation(async cmd => {
        if (cmd.commandType === 'HeadObject') {
          // Another writer's snapshot records a FRESHER fetch start than
          // this run's — even if it was written earlier, its data wins.
          return {
            LastModified: new Date('2020-01-01T00:00:00Z'), // write time is irrelevant
            Metadata: {
              'fetch-start-time': new Date(Date.now() + 60_000).toISOString(),
            },
          };
        }
        return {};
      });
      mockChainProtocols = [
        {
          protocol: Protocol.V2,
          chainId: ChainId.POLYGON,
          timeout: 90000,
          provider: {
            getPools: vi
              .fn()
              .mockResolvedValue([makePool('0xaaa', '0x1111', '0x2222')]),
          },
        },
      ];

      await expect(
        cacheAllPools(mockLogger, mockMetric, config)
      ).resolves.toMatchObject({succeeded: 1, failed: 0});
      expect(putObjectCalls()).toHaveLength(0);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Skipping S3 write')
      );
    });

    it('writes (and records its fetch start) when the existing snapshot was fetched earlier', async () => {
      sendMock.mockImplementation(async cmd => {
        if (cmd.commandType === 'HeadObject') {
          return {
            LastModified: new Date(Date.now() + 60_000), // late write of OLD data
            Metadata: {
              'fetch-start-time': new Date(
                '2026-01-01T00:00:00Z'
              ).toISOString(),
            },
          };
        }
        return {};
      });
      mockChainProtocols = [
        {
          protocol: Protocol.V2,
          chainId: ChainId.POLYGON,
          timeout: 90000,
          provider: {
            getPools: vi
              .fn()
              .mockResolvedValue([makePool('0xaaa', '0x1111', '0x2222')]),
          },
        },
      ];

      await expect(
        cacheAllPools(mockLogger, mockMetric, config)
      ).resolves.toMatchObject({succeeded: 1, failed: 0});
      const puts = putObjectCalls();
      expect(puts).toHaveLength(1);
      expect(puts[0].input.Metadata['fetch-start-time']).toBeTypeOf('string');
    });

    it('falls back to LastModified when the existing object predates the metadata scheme', async () => {
      sendMock.mockImplementation(async cmd => {
        if (cmd.commandType === 'HeadObject') {
          // Legacy object, no fetch-start metadata, written after this
          // run's fetch started — conservatively treated as fresher.
          return {LastModified: new Date(Date.now() + 60_000)};
        }
        return {};
      });
      mockChainProtocols = [
        {
          protocol: Protocol.V2,
          chainId: ChainId.POLYGON,
          timeout: 90000,
          provider: {
            getPools: vi
              .fn()
              .mockResolvedValue([makePool('0xaaa', '0x1111', '0x2222')]),
          },
        },
      ];

      await expect(
        cacheAllPools(mockLogger, mockMetric, config)
      ).resolves.toMatchObject({succeeded: 1, failed: 0});
      expect(putObjectCalls()).toHaveLength(0);
    });

    it('conditions the put on the pre-write ETag (IfMatch)', async () => {
      sendMock.mockImplementation(async cmd => {
        if (cmd.commandType === 'HeadObject') {
          return {
            LastModified: new Date('2026-01-01T00:00:00Z'),
            ETag: '"abc123"',
          };
        }
        return {};
      });
      mockChainProtocols = [
        {
          protocol: Protocol.V2,
          chainId: ChainId.POLYGON,
          timeout: 90000,
          provider: {
            getPools: vi
              .fn()
              .mockResolvedValue([makePool('0xaaa', '0x1111', '0x2222')]),
          },
        },
      ];

      await expect(
        cacheAllPools(mockLogger, mockMetric, config)
      ).resolves.toMatchObject({succeeded: 1, failed: 0});
      const puts = putObjectCalls();
      expect(puts).toHaveLength(1);
      expect(puts[0].input.IfMatch).toBe('"abc123"');
    });

    it('uses IfNoneMatch for the first-ever write (head NotFound)', async () => {
      sendMock.mockImplementation(async cmd => {
        if (cmd.commandType === 'HeadObject') {
          const err = new Error('no such key');
          err.name = 'NotFound';
          throw err;
        }
        return {};
      });
      mockChainProtocols = [
        {
          protocol: Protocol.V2,
          chainId: ChainId.POLYGON,
          timeout: 90000,
          provider: {
            getPools: vi
              .fn()
              .mockResolvedValue([makePool('0xaaa', '0x1111', '0x2222')]),
          },
        },
      ];

      await expect(
        cacheAllPools(mockLogger, mockMetric, config)
      ).resolves.toMatchObject({succeeded: 1, failed: 0});
      const puts = putObjectCalls();
      expect(puts).toHaveLength(1);
      expect(puts[0].input.IfNoneMatch).toBe('*');
    });

    it('re-arbitrates on a conditional-put conflict and skips when the winner is fresher', async () => {
      let headCalls = 0;
      let putCalls = 0;
      sendMock.mockImplementation(async cmd => {
        if (cmd.commandType === 'HeadObject') {
          headCalls += 1;
          if (headCalls === 1) {
            // Stale snapshot at first check — we decide to write.
            return {
              ETag: '"v1"',
              Metadata: {
                'fetch-start-time': new Date(
                  '2026-01-01T00:00:00Z'
                ).toISOString(),
              },
            };
          }
          // After the conflict: a competing writer landed FRESHER data.
          return {
            ETag: '"v2"',
            Metadata: {
              'fetch-start-time': new Date(Date.now() + 60_000).toISOString(),
            },
          };
        }
        putCalls += 1;
        // First put loses the conditional race.
        const err = new Error('pre-condition did not hold');
        err.name = 'PreconditionFailed';
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (err as any).$metadata = {httpStatusCode: 412};
        throw err;
      });
      mockChainProtocols = [
        {
          protocol: Protocol.V2,
          chainId: ChainId.POLYGON,
          timeout: 90000,
          provider: {
            getPools: vi
              .fn()
              .mockResolvedValue([makePool('0xaaa', '0x1111', '0x2222')]),
          },
        },
      ];

      await expect(
        cacheAllPools(mockLogger, mockMetric, config)
      ).resolves.toMatchObject({succeeded: 1, failed: 0});
      expect(putCalls).toBe(1);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Skipping S3 write')
      );
      expect(mockLogger.error).not.toHaveBeenCalled();
    });

    it('re-arbitrates on a conditional-put conflict and retries when its own data is still fresher', async () => {
      let putCalls = 0;
      sendMock.mockImplementation(async cmd => {
        if (cmd.commandType === 'HeadObject') {
          // The competing writer holds OLDER data both times (e.g. a late
          // orphan write) — our snapshot should still land.
          return {
            ETag: `"v${putCalls + 1}"`,
            Metadata: {
              'fetch-start-time': new Date(
                '2026-01-01T00:00:00Z'
              ).toISOString(),
            },
          };
        }
        putCalls += 1;
        if (putCalls === 1) {
          const err = new Error('pre-condition did not hold');
          err.name = 'PreconditionFailed';
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (err as any).$metadata = {httpStatusCode: 412};
          throw err;
        }
        return {};
      });
      mockChainProtocols = [
        {
          protocol: Protocol.V2,
          chainId: ChainId.POLYGON,
          timeout: 90000,
          provider: {
            getPools: vi
              .fn()
              .mockResolvedValue([makePool('0xaaa', '0x1111', '0x2222')]),
          },
        },
      ];

      await expect(
        cacheAllPools(mockLogger, mockMetric, config)
      ).resolves.toMatchObject({succeeded: 1, failed: 0});
      expect(putCalls).toBe(2);
      expect(mockLogger.error).not.toHaveBeenCalled();
    });

    it('retries via the first-write path when the key is deleted between head and put (404)', async () => {
      let headCalls = 0;
      let putCalls = 0;
      sendMock.mockImplementation(async cmd => {
        if (cmd.commandType === 'HeadObject') {
          headCalls += 1;
          if (headCalls === 1) {
            return {
              ETag: '"v1"',
              Metadata: {
                'fetch-start-time': new Date(
                  '2026-01-01T00:00:00Z'
                ).toISOString(),
              },
            };
          }
          // Object was deleted before our conditional put landed.
          const notFound = new Error('no such key');
          notFound.name = 'NotFound';
          throw notFound;
        }
        putCalls += 1;
        if (putCalls === 1) {
          const err = new Error('key deleted');
          err.name = 'NoSuchKey';
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (err as any).$metadata = {httpStatusCode: 404};
          throw err;
        }
        return {};
      });
      mockChainProtocols = [
        {
          protocol: Protocol.V2,
          chainId: ChainId.POLYGON,
          timeout: 90000,
          provider: {
            getPools: vi
              .fn()
              .mockResolvedValue([makePool('0xaaa', '0x1111', '0x2222')]),
          },
        },
      ];

      await expect(
        cacheAllPools(mockLogger, mockMetric, config)
      ).resolves.toMatchObject({succeeded: 1, failed: 0});
      expect(putCalls).toBe(2);
      const puts = putObjectCalls();
      expect(puts[1].input.IfNoneMatch).toBe('*');
      expect(mockLogger.error).not.toHaveBeenCalled();
    });

    it('fails closed when the freshness HeadObject fails with a non-404 error', async () => {
      let headCalls = 0;
      sendMock.mockImplementation(async cmd => {
        if (cmd.commandType === 'HeadObject') {
          headCalls += 1;
          // Transient S3 error (throttle / 503) — NOT a missing object.
          throw new Error('ServiceUnavailable');
        }
        return {};
      });
      mockChainProtocols = [
        {
          protocol: Protocol.V2,
          chainId: ChainId.POLYGON,
          timeout: 90000,
          provider: {
            getPools: vi
              .fn()
              .mockResolvedValue([makePool('0xaaa', '0x1111', '0x2222')]),
          },
        },
      ];

      // Without seeing the incumbent we cannot arbitrate — never write
      // unconditionally (a stale orphan could clobber fresher data);
      // retry then surface the task as failed.
      await expect(
        cacheAllPools(mockLogger, mockMetric, config)
      ).resolves.toMatchObject({succeeded: 0, failed: 1});
      expect(headCalls).toBe(3);
      expect(putObjectCalls()).toHaveLength(0);
    });

    it('ignores corrupt far-future fetch-start metadata instead of freezing the key', async () => {
      sendMock.mockImplementation(async cmd => {
        if (cmd.commandType === 'HeadObject') {
          return {
            ETag: '"v1"',
            LastModified: new Date('2026-01-01T00:00:00Z'),
            Metadata: {
              // A writer with a broken clock recorded a fetch start far in
              // the future; trusting it would block every write until then.
              'fetch-start-time': new Date(
                Date.now() + 24 * 60 * 60_000
              ).toISOString(),
            },
          };
        }
        return {};
      });
      mockChainProtocols = [
        {
          protocol: Protocol.V2,
          chainId: ChainId.POLYGON,
          timeout: 90000,
          provider: {
            getPools: vi
              .fn()
              .mockResolvedValue([makePool('0xaaa', '0x1111', '0x2222')]),
          },
        },
      ];

      await expect(
        cacheAllPools(mockLogger, mockMetric, config)
      ).resolves.toMatchObject({succeeded: 1, failed: 0});
      expect(putObjectCalls()).toHaveLength(1);
    });

    it('processes multiple batches correctly', async () => {
      const makeEntry = (chainId: ChainId) => ({
        protocol: Protocol.V2,
        chainId,
        timeout: 90000,
        provider: {
          getPools: vi
            .fn()
            .mockResolvedValue([makePool('0x' + chainId, '0x1111', '0x2222')]),
        },
      });
      mockChainProtocols = [
        makeEntry(ChainId.MAINNET),
        makeEntry(ChainId.POLYGON),
        makeEntry(ChainId.ARBITRUM_ONE),
        makeEntry(ChainId.OPTIMISM),
        makeEntry(ChainId.BASE),
      ];

      // Note: V2 mainnet will trigger the special filtering path but still succeed
      await cacheAllPools(mockLogger, mockMetric, config, 2);
      // All 5 entries should produce S3 uploads
      expect(putObjectCalls()).toHaveLength(5);
    });
  });

  // --- Extra (best-effort) V4 pool sources ---
  // These sources are additions on top of the main pool set. A failure in
  // any one of them must cost only its own pools, never the snapshot built
  // from the main set.
  describe('extra pool source carry-forward', () => {
    const mainPool = makeV4Pool(
      '0xmainpool',
      '0x0000000000000000000000000000000000000000',
      '0x1111',
      '0x2222'
    );
    const aggPool = makeV4Pool(
      '0xaggpool',
      '0x3333333333333333333333333333333333333333',
      '0x5555',
      '0x6666'
    );
    const aggChainProtocol = (aggHooksProvider: IAggHooksSubgraphProvider) => ({
      protocol: Protocol.V4,
      chainId: ChainId.MAINNET,
      timeout: 90000,
      provider: {getPools: async () => [mainPool]},
      aggHooksProvider,
    });
    const carryForwardTags = (outcome: string) => ({
      key: 'CachePools.extraPoolSource.carryForward',
      value: 1,
      unit: MetricLoggerUnit.Count,
      tags: {
        chainId: String(ChainId.MAINNET),
        protocol: String(Protocol.V4),
        source: 'agg_hooks',
        outcome,
      },
    });

    it('serves the last good agg hook pools when a later sweep fails', async () => {
      mockChainProtocols = [
        aggChainProtocol(new FakeAggHooksSubgraphProvider([aggPool])),
      ];
      await cacheAllPools(mockLogger, mockMetric, config);

      sendMock.mockClear();
      mockMetric = new MockMetric();
      mockChainProtocols = [
        aggChainProtocol(
          new FakeAggHooksSubgraphProvider([], new Error('subgraph shut off'))
        ),
      ];
      await cacheAllPools(mockLogger, mockMetric, config);

      const puts = putObjectCalls();
      expect(puts).toHaveLength(1);
      expect(writtenPoolIds(puts[0].input.Body)).toContain(aggPool.id);
      expect(mockMetric.calls).toContainEqual(carryForwardTags('served'));
      expect(mockMetric.calls).toContainEqual({
        key: 'CachePools.extraPoolSource',
        value: 1,
        unit: MetricLoggerUnit.Count,
        tags: {
          chainId: String(ChainId.MAINNET),
          protocol: String(Protocol.V4),
          source: 'agg_hooks',
          status: 'failure',
          reason: 'fetch_error',
        },
      });
    });

    it('drops the pools once the last good result is past the max age', async () => {
      V4_EXTRA_POOL_SOURCE_MEMORY.recordGood(
        extraSourceKey(ExtraPoolSourceName.AGG_HOOKS, ChainId.MAINNET),
        [aggPool],
        Date.now() - EXTRA_POOL_SOURCE_LAST_GOOD_MAX_AGE_MS - 60_000
      );
      mockChainProtocols = [
        aggChainProtocol(
          new FakeAggHooksSubgraphProvider([], new Error('subgraph shut off'))
        ),
      ];
      await cacheAllPools(mockLogger, mockMetric, config);

      const puts = putObjectCalls();
      expect(puts).toHaveLength(1);
      expect(writtenPoolIds(puts[0].input.Body)).not.toContain(aggPool.id);
      expect(mockMetric.calls).toContainEqual(carryForwardTags('expired'));
    });
  });

  describe('withExtraPoolSource', () => {
    const NOW_MS = Date.UTC(2026, 9, 13, 12);
    const key = extraSourceKey(ExtraPoolSourceName.AGG_HOOKS, ChainId.MAINNET);
    const tags = {chainId: String(ChainId.MAINNET), protocol: 'V4'};
    const pool = makeV4Pool('0xaggpool', '0x3333', '0x5555', '0x6666');

    function run(
      memory: ExtraPoolSourceMemory<V4SubgraphPool>,
      fn: () => Promise<V4SubgraphPool[]>,
      timeoutMs?: number,
      failClosedWithoutLastGood?: boolean
    ) {
      return withExtraPoolSource(
        ExtraPoolSourceName.AGG_HOOKS,
        ChainId.MAINNET,
        tags,
        mockMetric,
        mockLogger,
        memory,
        fn,
        () => NOW_MS,
        timeoutMs,
        failClosedWithoutLastGood
      );
    }

    it('fails closed for an Aurora-primary source with no last good result', async () => {
      await expect(
        run(
          new ExtraPoolSourceMemory<V4SubgraphPool>(),
          async () => {
            throw new Error('statement timeout');
          },
          undefined,
          true
        )
      ).rejects.toBeInstanceOf(ExtraPoolSourceUnavailableError);
      expect(statusOf()).toEqual([
        {
          ...tags,
          source: 'agg_hooks',
          status: 'failure',
          reason: 'fetch_error',
        },
      ]);
    });

    it('stops skipping the write once the first skip is older than the last-good window', async () => {
      const memory = new ExtraPoolSourceMemory<V4SubgraphPool>();
      const failingRead = async (): Promise<V4SubgraphPool[]> => {
        throw new Error('statement timeout');
      };
      const at = (nowMs: number) =>
        withExtraPoolSource(
          ExtraPoolSourceName.AGG_HOOKS,
          ChainId.MAINNET,
          tags,
          mockMetric,
          mockLogger,
          memory,
          failingRead,
          () => nowMs,
          undefined,
          true
        );

      await expect(at(NOW_MS)).rejects.toBeInstanceOf(
        ExtraPoolSourceUnavailableError
      );
      await expect(
        at(NOW_MS + EXTRA_POOL_SOURCE_LAST_GOOD_MAX_AGE_MS)
      ).rejects.toBeInstanceOf(ExtraPoolSourceUnavailableError);
      // Past the window the combo writes without the source's pools.
      await expect(
        at(NOW_MS + EXTRA_POOL_SOURCE_LAST_GOOD_MAX_AGE_MS + 1)
      ).resolves.toBeUndefined();
    });

    it('fails closed on a timed-out Aurora-primary read with no last good result', async () => {
      await expect(
        run(
          new ExtraPoolSourceMemory<V4SubgraphPool>(),
          () => new Promise(() => {}),
          10,
          true
        )
      ).rejects.toBeInstanceOf(ExtraPoolSourceUnavailableError);
    });

    it('still carries forward for an Aurora-primary source with a last good result', async () => {
      const memory = new ExtraPoolSourceMemory<V4SubgraphPool>();
      memory.recordGood(key, [pool], NOW_MS - 20 * 60_000);

      const result = await run(
        memory,
        async () => {
          throw new Error('statement timeout');
        },
        undefined,
        true
      );

      expect(result).toEqual([pool]);
    });

    it('serves an empty Aurora-primary read with no last good result as success', async () => {
      const result = await run(
        new ExtraPoolSourceMemory<V4SubgraphPool>(),
        async () => [],
        undefined,
        true
      );

      expect(result).toEqual([]);
    });
    const statusOf = () =>
      mockMetric.calls
        .filter(call => call.key === 'CachePools.extraPoolSource')
        .map(call => call.tags);

    it('treats a read that outlives its timeout as a failure and carries forward', async () => {
      const memory = new ExtraPoolSourceMemory<V4SubgraphPool>();
      memory.recordGood(key, [pool], NOW_MS - 20 * 60_000);

      const result = await run(memory, () => new Promise(() => {}), 10);

      expect(result).toEqual([pool]);
      expect(statusOf()).toEqual([
        {...tags, source: 'agg_hooks', status: 'failure', reason: 'timeout'},
      ]);
    });

    it('carries forward over an empty read when a recent read had pools', async () => {
      const memory = new ExtraPoolSourceMemory<V4SubgraphPool>();
      memory.recordGood(key, [pool], NOW_MS - 20 * 60_000);

      const result = await run(memory, async () => []);

      expect(result).toEqual([pool]);
      expect(statusOf()).toEqual([
        {
          ...tags,
          source: 'agg_hooks',
          status: 'failure',
          reason: 'empty_result',
        },
      ]);
    });

    it('serves an empty read as success when the source has no recent pools', async () => {
      const result = await run(
        new ExtraPoolSourceMemory<V4SubgraphPool>(),
        async () => []
      );

      expect(result).toEqual([]);
      expect(statusOf()).toEqual([
        {...tags, source: 'agg_hooks', status: 'success'},
      ]);
    });

    it('serves nothing on a failure with no good result since the process started', async () => {
      const result = await run(
        new ExtraPoolSourceMemory<V4SubgraphPool>(),
        async () => {
          throw new Error('aurora down');
        }
      );

      expect(result).toBeUndefined();
      expect(mockMetric.calls).toContainEqual({
        key: 'CachePools.extraPoolSource.carryForward',
        value: 1,
        unit: MetricLoggerUnit.Count,
        tags: {...tags, source: 'agg_hooks', outcome: 'none'},
      });
    });
  });

  describe('extra pool sources (best-effort)', () => {
    const mainPool = makeV4Pool(
      '0xmainpool',
      '0x0000000000000000000000000000000000000000',
      '0x1111',
      '0x2222'
    );

    it('writes the snapshot without euler hook pools when eulerHooksProvider fails, and tags the failure', async () => {
      mockChainProtocols = [
        {
          protocol: Protocol.V4,
          chainId: ChainId.MAINNET,
          timeout: 90000,
          provider: {getPools: vi.fn().mockResolvedValue([mainPool])},
          eulerHooksProvider: new FakeEulerSwapHooksSubgraphProvider(
            [],
            {},
            new Error('euler subgraph unreachable')
          ),
        },
      ];

      await cacheAllPools(mockLogger, mockMetric, config);

      const puts = putObjectCalls();
      expect(puts).toHaveLength(1);
      expect(writtenPoolIds(puts[0].input.Body)).toContain(mainPool.id);

      expect(mockMetric.calls).toContainEqual({
        key: 'CachePools.extraPoolSource',
        value: 1,
        unit: MetricLoggerUnit.Count,
        tags: {
          chainId: String(ChainId.MAINNET),
          protocol: String(Protocol.V4),
          source: 'euler_hooks',
          status: 'failure',
          reason: 'fetch_error',
        },
      });

      const warnMessages = vi
        .mocked(mockLogger.warn)
        .mock.calls.map(call => call[0]);
      expect(
        warnMessages.some(
          msg =>
            typeof msg === 'string' &&
            msg.includes(
              'Extra pool source failed: source=euler_hooks reason=fetch_error error=Error'
            )
        )
      ).toBe(true);
      expect(
        warnMessages.some(
          msg => typeof msg === 'string' && msg.includes('unreachable')
        )
      ).toBe(false);
    });

    it('writes the snapshot without agg hook pools when aggHooksProvider fails, and tags the failure', async () => {
      mockChainProtocols = [
        {
          protocol: Protocol.V4,
          chainId: ChainId.MAINNET,
          timeout: 90000,
          provider: {getPools: vi.fn().mockResolvedValue([mainPool])},
          aggHooksProvider: new FakeAggHooksSubgraphProvider(
            [],
            new Error('agg hooks subgraph unreachable')
          ),
        },
      ];

      await cacheAllPools(mockLogger, mockMetric, config);

      const puts = putObjectCalls();
      expect(puts).toHaveLength(1);
      expect(writtenPoolIds(puts[0].input.Body)).toContain(mainPool.id);

      expect(mockMetric.calls).toContainEqual({
        key: 'CachePools.extraPoolSource',
        value: 1,
        unit: MetricLoggerUnit.Count,
        tags: {
          chainId: String(ChainId.MAINNET),
          protocol: String(Protocol.V4),
          source: 'agg_hooks',
          status: 'failure',
          reason: 'fetch_error',
        },
      });

      const warnMessages = vi
        .mocked(mockLogger.warn)
        .mock.calls.map(call => call[0]);
      expect(
        warnMessages.some(
          msg =>
            typeof msg === 'string' &&
            msg.includes(
              'Extra pool source failed: source=agg_hooks reason=fetch_error error=Error'
            )
        )
      ).toBe(true);
      expect(
        warnMessages.some(
          msg => typeof msg === 'string' && msg.includes('unreachable')
        )
      ).toBe(false);
    });

    it('emits status:success and includes the pool when aggHooksProvider succeeds', async () => {
      const aggPool = makeV4Pool(
        '0xaggpool',
        '0x3333333333333333333333333333333333333333',
        '0x5555',
        '0x6666'
      );
      mockChainProtocols = [
        {
          protocol: Protocol.V4,
          chainId: ChainId.MAINNET,
          timeout: 90000,
          provider: {getPools: vi.fn().mockResolvedValue([mainPool])},
          aggHooksProvider: new FakeAggHooksSubgraphProvider([aggPool]),
        },
      ];

      await cacheAllPools(mockLogger, mockMetric, config);

      const puts = putObjectCalls();
      expect(puts).toHaveLength(1);
      expect(writtenPoolIds(puts[0].input.Body)).toContain(aggPool.id);

      expect(mockMetric.calls).toContainEqual({
        key: 'CachePools.extraPoolSource',
        value: 1,
        unit: MetricLoggerUnit.Count,
        tags: {
          chainId: String(ChainId.MAINNET),
          protocol: String(Protocol.V4),
          source: 'agg_hooks',
          status: 'success',
        },
      });
    });

    it('writes the mainnet V3 snapshot without the manual pool when its fetch fails, and tags the failure', async () => {
      const mainV3Pool = makeV3Pool('0xmainv3pool', '0x1111', '0x2222');
      v3ManualFetch.error = new Error('v3 subgraph unreachable');
      mockChainProtocols = [
        {
          protocol: Protocol.V3,
          chainId: ChainId.MAINNET,
          timeout: 90000,
          provider: {getPools: vi.fn().mockResolvedValue([mainV3Pool])},
        },
      ];

      await cacheAllPools(mockLogger, mockMetric, config);

      const puts = putObjectCalls();
      expect(puts).toHaveLength(1);
      expect(writtenPoolIds(puts[0].input.Body)).toEqual([mainV3Pool.id]);
      expect(mockMetric.calls).toContainEqual({
        key: 'CachePools.extraPoolSource',
        value: 1,
        unit: MetricLoggerUnit.Count,
        tags: {
          chainId: String(ChainId.MAINNET),
          protocol: String(Protocol.V3),
          source: 'v3_mainnet_manual',
          status: 'failure',
          reason: 'fetch_error',
        },
      });
      const warnMessages = vi
        .mocked(mockLogger.warn)
        .mock.calls.map(call => call[0]);
      expect(warnMessages).toContainEqual(
        expect.stringContaining(
          'Extra pool source failed: source=v3_mainnet_manual reason=fetch_error error=Error'
        )
      );
      expect(
        warnMessages.some(
          msg => typeof msg === 'string' && msg.includes('unreachable')
        )
      ).toBe(false);
    });

    // The Aurora wrappers applyAuroraPoolSources installs: cachePools hands
    // each its subgraph source, so after the subgraph shutoff the snapshot
    // still carries the extra pools from Aurora.
    it('serves EulerSwap pools through an installed Aurora override when the subgraph source fails', async () => {
      const auroraEulerPool = makeV4Pool(
        '0xauroraeulerpool',
        '0x0222155e00e159a6a12613ee7c7b1021f9f568a8',
        '0x078d782b760474a361dda0af3839290b0ef57ad6',
        '0x4200000000000000000000000000000000000006'
      );
      mockChainProtocols = [
        {
          protocol: Protocol.V4,
          chainId: ChainId.UNICHAIN,
          timeout: 90000,
          provider: {getPools: vi.fn().mockResolvedValue([mainPool])},
          eulerHooksProvider: new FakeEulerSwapHooksSubgraphProvider(
            [],
            {},
            new Error('subgraph shut off')
          ),
          extraPoolSourceOverrides: {
            euler: (subgraph: ExtraPoolsSource<V4SubgraphPool>) =>
              new AuroraSourcedExtraPoolsProvider<V4SubgraphPool>(
                'primary',
                ExtraPoolSourceName.EULER_HOOKS,
                ChainId.UNICHAIN,
                {getPools: async () => [auroraEulerPool]},
                subgraph,
                mockLogger,
                mockMetric
              ),
          },
        },
      ];

      await cacheAllPools(mockLogger, mockMetric, config);

      const puts = putObjectCalls();
      expect(puts).toHaveLength(1);
      expect(writtenPoolIds(puts[0].input.Body)).toEqual(
        expect.arrayContaining([mainPool.id, auroraEulerPool.id])
      );
      expect(mockMetric.calls).toContainEqual({
        key: 'CachePools.extraPoolSource',
        value: 1,
        unit: MetricLoggerUnit.Count,
        tags: {
          chainId: String(ChainId.UNICHAIN),
          protocol: String(Protocol.V4),
          source: 'euler_hooks',
          status: 'success',
        },
      });
    });

    it('serves the mainnet manual V3 pool through an installed Aurora override, carries it forward when both reads fail, and keeps the previous snapshot after a restart', async () => {
      const mainV3Pool = makeV3Pool('0xmainv3pool', '0x1111', '0x2222');
      const manualPool = makeV3Pool(
        MAINNET_V3_MANUAL_POOL_IDS[0] ?? '',
        '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0',
        '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
      );
      v3ManualFetch.error = new Error('subgraph shut off');
      let auroraResult: Error | V3SubgraphPool[] = [manualPool];
      const chainProtocol = {
        protocol: Protocol.V3,
        chainId: ChainId.MAINNET,
        timeout: 90000,
        // A fresh array per run: cachePools appends the extra pools to it.
        provider: {getPools: async () => [mainV3Pool]},
        extraPoolSourceOverrides: {
          v3Manual: (subgraph: ExtraPoolsSource<V3SubgraphPool>) =>
            new AuroraSourcedExtraPoolsProvider(
              'primary',
              ExtraPoolSourceName.V3_MAINNET_MANUAL,
              ChainId.MAINNET,
              {
                getPools: async () => {
                  if (auroraResult instanceof Error) throw auroraResult;
                  return auroraResult;
                },
              },
              subgraph,
              mockLogger,
              mockMetric
            ),
        },
      };
      mockChainProtocols = [chainProtocol];

      await cacheAllPools(mockLogger, mockMetric, config);
      expect(writtenPoolIds(putObjectCalls()[0].input.Body)).toEqual([
        mainV3Pool.id,
        manualPool.id,
      ]);

      auroraResult = new Error('statement timeout');
      sendMock.mockClear();
      await cacheAllPools(mockLogger, mockMetric, config);
      expect(writtenPoolIds(putObjectCalls()[0].input.Body)).toEqual([
        mainV3Pool.id,
        manualPool.id,
      ]);

      // A restart empties the process-local memory: nothing to carry, so the
      // Aurora-primary source fails closed and the combo writes nothing,
      // leaving the previous snapshot (with the manual pool) in S3.
      resetExtraPoolSourceMemoryForTesting();
      sendMock.mockClear();
      await expect(
        cacheAllPools(mockLogger, mockMetric, config)
      ).resolves.toMatchObject({succeeded: 0, failed: 1});
      expect(putObjectCalls()).toEqual([]);
      expect(mockMetric.calls).toContainEqual({
        key: 'CachePools.extraPoolSource.carryForward',
        value: 1,
        unit: MetricLoggerUnit.Count,
        tags: {
          chainId: String(ChainId.MAINNET),
          protocol: String(Protocol.V3),
          source: 'v3_mainnet_manual',
          outcome: 'write_skipped',
        },
      });
      expect(mockMetric.calls).toContainEqual({
        key: 'CachePools.extraPoolSource',
        value: 1,
        unit: MetricLoggerUnit.Count,
        tags: {
          chainId: String(ChainId.MAINNET),
          protocol: String(Protocol.V3),
          source: 'v3_mainnet_manual',
          status: 'failure',
          reason: 'fetch_error',
        },
      });
    });
  });
});

describe('cacheAllPools pool activity filter', () => {
  const ROBINHOOD = 4663 as ChainId;
  const config: CachePoolsConfig = {
    s3Bucket: 'test-bucket',
    s3CacheKey: 'poolCacheGzip.json',
  };
  const savedTargets = process.env.POOL_CACHING_ACTIVITY_FILTER_TARGETS;
  let metric: MockMetric;

  beforeEach(() => {
    metric = new MockMetric();
    mockChainProtocols = [];
    resetExtraPoolSourceMemoryForTesting();
    sendMock.mockClear();
    sendMock.mockResolvedValue({});
  });

  afterEach(() => {
    if (savedTargets === undefined) {
      delete process.env.POOL_CACHING_ACTIVITY_FILTER_TARGETS;
    } else {
      process.env.POOL_CACHING_ACTIVITY_FILTER_TARGETS = savedTargets;
    }
  });

  function robinhoodV4Pool(id: string, lastStateChangeAtMs: number) {
    return {
      ...makeV4Pool(
        id,
        '0x0000000000000000000000000000000000000000',
        '0xa',
        '0xb'
      ),
      lastStateChangeAtMs,
    };
  }

  function writtenPools(): Array<Record<string, unknown>> {
    const parsed: unknown = JSON.parse(
      zlib.inflateSync(putObjectCalls()[0].input.Body).toString('utf8')
    );
    if (!Array.isArray(parsed)) throw new Error('snapshot is not an array');
    return parsed;
  }

  function cacheRobinhoodV4(pools: ReturnType<typeof robinhoodV4Pool>[]) {
    mockChainProtocols = [
      {
        protocol: Protocol.V4,
        chainId: ROBINHOOD,
        timeout: 90000,
        provider: {getPools: async () => pools},
      },
    ];
    return cacheAllPools(createMockLogger(), metric, config);
  }

  it('writes only recently changed pools, without the timestamp, for a listed combo', async () => {
    process.env.POOL_CACHING_ACTIVITY_FILTER_TARGETS = '4663:V4';
    const nowMs = Date.now();
    await cacheRobinhoodV4([
      robinhoodV4Pool('0xactive', nowMs - 60_000),
      robinhoodV4Pool('0xidle', nowMs - POOL_ACTIVITY_WINDOW_MS - 60_000),
    ]);

    const pools = writtenPools();
    expect(pools.map(pool => pool.id)).toEqual(['0xactive']);
    expect(pools.every(pool => !('lastStateChangeAtMs' in pool))).toBe(true);
    const tags = {chainId: '4663', protocol: 'V4', status: 'success'};
    expect(metric.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'CachePools.activityFilter.kept',
          value: 1,
          tags,
        }),
        expect.objectContaining({
          key: 'CachePools.activityFilter.dropped',
          value: 1,
          tags,
        }),
      ])
    );
  });

  it('writes every pool and counts a failure when the activity signal is stale', async () => {
    process.env.POOL_CACHING_ACTIVITY_FILTER_TARGETS = '4663:V4';
    const stalledMs =
      Date.now() - POOL_ACTIVITY_SIGNAL_MAX_STALENESS_MS - 60_000;
    await cacheRobinhoodV4([
      robinhoodV4Pool('0xlast', stalledMs),
      robinhoodV4Pool('0xolder', stalledMs - POOL_ACTIVITY_WINDOW_MS),
    ]);

    const pools = writtenPools();
    expect(pools.map(pool => pool.id)).toEqual(['0xlast', '0xolder']);
    expect(pools.every(pool => !('lastStateChangeAtMs' in pool))).toBe(true);
    expect(metric.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'CachePools.activityFilter.skipped',
          tags: {
            chainId: '4663',
            protocol: 'V4',
            status: 'failure',
            reason: 'stale_activity_signal',
          },
        }),
      ])
    );
  });

  it('leaves an unlisted combo unfiltered and reports an unsupported entry', async () => {
    process.env.POOL_CACHING_ACTIVITY_FILTER_TARGETS = '4663:V3,4663:V9';
    const nowMs = Date.now();
    await cacheRobinhoodV4([
      robinhoodV4Pool('0xactive', nowMs),
      robinhoodV4Pool('0xidle', nowMs - POOL_ACTIVITY_WINDOW_MS - 60_000),
    ]);

    expect(writtenPools().map(pool => pool.id)).toEqual(['0xactive', '0xidle']);
    expect(
      metric.calls.filter(call =>
        call.key.startsWith('CachePools.activityFilter')
      )
    ).toEqual([
      expect.objectContaining({
        key: 'CachePools.activityFilter.misconfigured',
        tags: {status: 'failure', reason: 'unsupported_target'},
      }),
    ]);
  });
});
