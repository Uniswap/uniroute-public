import {describe, it, expect, vi, beforeEach} from 'vitest';
import {cacheAllPools, CachePoolsConfig} from './cachePools';
import type {Logger} from './sor-providers/util/log';
import {IMetric} from './sor-providers/util/metric';
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

// Mock V2SubgraphProvider and V3SubgraphProvider constructors used inside cachePoolsForChainProtocol
vi.mock('./sor-providers', () => ({
  V2SubgraphProvider: class {
    async getPools() {
      return [];
    }
  },
  V3SubgraphProvider: class {
    async getPools() {
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
  setProperty(_key: string, _value: unknown): void {}
  putDimensions(_dimensions: Record<string, string>): void {}
  putMetric(
    _key: string,
    _value: number,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _unit?: any,
    _tags?: Record<string, string>
  ): void {}
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
});
