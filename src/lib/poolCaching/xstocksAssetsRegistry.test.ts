import {describe, expect, it} from 'vitest';
import {S3Client} from '@aws-sdk/client-s3';
import {
  buildXStocksAssetsRegistry,
  filterLegacyV1Deployments,
  parseExpectedHookCodehashByChain,
  XStocksAssetEntry,
} from './xstocksAssetsRegistry';
import {IMetric} from './sor-providers/util/metric';
import {Logger} from './sor-providers/util/log';

const now = 1_800_000_000_000;
const entry: XStocksAssetEntry = {
  xStock: '0xaa00000000000000000000000000000000000001',
  wxStock: '0xbb00000000000000000000000000000000000002',
  hookAddress: '0xcc00000000000000000000000000000000000003',
  poolId: `0x${'11'.repeat(32)}`,
  feeTier: '500',
  tickSpacing: '10',
  status: 'active',
  updatedAtMs: now,
};

const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  fatal() {},
} as Logger;
const metric = {
  setProperty() {},
  putDimensions() {},
  putMetric() {},
} as IMetric;

const run = async (
  previous: XStocksAssetEntry[],
  options: {
    nowMs?: number;
    conflict?: boolean;
    markerAtMs?: number;
    firstWrite?: boolean;
    assets?: Array<{
      xStockAddress: string;
      tokenDeployments: Array<{
        chainId: number;
        wrapperAddress: string;
        hookAddress: string;
        poolId: string;
        feeTier: string;
        tickSpacing: string;
      }>;
    }>;
    verifyAsset?: (
      chainId: number,
      candidate: XStocksAssetEntry
    ) => Promise<boolean>;
  } = {}
) => {
  const writes: Array<{key: string; body: unknown}> = [];
  const s3 = {
    send: async (command: {input: {Body?: string; Key: string}}) => {
      if (command.input.Body === undefined) {
        if (command.input.Key.endsWith('writer-last-successful-run')) {
          if (options.markerAtMs === undefined) {
            const error = new Error('missing') as Error & {name: string};
            error.name = 'NoSuchKey';
            throw error;
          }
          return {
            ETag: 'marker-etag',
            Body: {
              transformToString: async () =>
                JSON.stringify({lastSuccessfulRunAtMs: options.markerAtMs}),
            },
          };
        }
        if (options.firstWrite) {
          const error = new Error('missing') as Error & {name: string};
          error.name = 'NoSuchKey';
          throw error;
        }
        return {
          ETag: 'etag',
          Body: {transformToString: async () => JSON.stringify(previous)},
        };
      }
      if (options.conflict) {
        const error = new Error('conflict') as Error & {name: string};
        error.name = 'PreconditionFailed';
        throw error;
      }
      writes.push({
        key: command.input.Key,
        body: JSON.parse(command.input.Body),
      });
      return {};
    },
  } as unknown as S3Client;
  await buildXStocksAssetsRegistry(
    logger,
    metric,
    {
      s3Bucket: 'bucket',
      s3BaseKey: 'xstocksAssetsRegistry.json',
      chainIds: [1],
      retirementSafetyMarginMs: 60 * 60 * 1000,
      retiredRetentionMs: 7 * 24 * 60 * 60 * 1000,
      runIntervalMs: 5 * 60 * 1000,
      expectedHookCodehashByChain: {},
    },
    {
      s3,
      fetchAssets: async () => options.assets ?? [],
      getChain: () => undefined,
      getProvider: () => undefined,
      nowMs: () => options.nowMs ?? now,
      verifyAsset: options.verifyAsset ?? (async () => true),
    }
  );
  return writes
    .filter(write => write.key.endsWith('-1-V4'))
    .map(write => write.body);
};

describe('xStocks assets registry writer', () => {
  it('filters legacy v1 wrappers at the API boundary', () => {
    expect(
      filterLegacyV1Deployments([
        {
          xStockAddress: entry.xStock,
          tokenDeployments: [
            {chainId: 1, wrapperAddress: entry.wxStock, version: 'v1'},
            {chainId: 1, wrapperAddress: entry.wxStock, version: 'v2'},
          ],
        },
      ])[0].tokenDeployments
    ).toHaveLength(1);
  });

  it('keeps an active entry during its missing safety margin', async () => {
    expect(
      await run([{...entry, updatedAtMs: now - 1_000}], {markerAtMs: now})
    ).toEqual([]);
  });

  it('retires an active entry missing beyond the safety margin', async () => {
    const writes = await run([{...entry, updatedAtMs: now - 60 * 60 * 1000}], {
      markerAtMs: now,
    });
    expect(writes).toEqual([[{...entry, status: 'retired', updatedAtMs: now}]]);
  });

  it('prunes retired tombstones past their retention window', async () => {
    const writes = await run(
      [
        {
          ...entry,
          status: 'retired',
          updatedAtMs: now - 7 * 24 * 60 * 60 * 1000,
        },
      ],
      {markerAtMs: now}
    );
    expect(writes).toEqual([[]]);
  });

  it('fails the job when every configured chain has an ETag write conflict', async () => {
    await expect(
      run([{...entry, updatedAtMs: now - 60 * 60 * 1000}], {
        conflict: true,
        markerAtMs: now,
      })
    ).rejects.toThrow('failed for all 1 configured chains');
  });

  it('still fails the job when every CONFIGURED chain fails, even if an out-of-scope chain observed via the API succeeds', async () => {
    // config.chainIds is [1] (see `run`'s hardcoded config); chain 999 is
    // out of routing scope but appears via an API deployment and succeeds
    // trivially (no previous state). The failure threshold must be judged
    // against config.chainIds, not the broader reconciliation set.
    const writes: Array<{key: string; body: unknown}> = [];
    const s3 = {
      send: async (command: {input: {Body?: string; Key: string}}) => {
        if (command.input.Body === undefined) {
          if (command.input.Key.endsWith('writer-last-successful-run')) {
            return {
              ETag: 'marker-etag',
              Body: {
                transformToString: async () =>
                  JSON.stringify({lastSuccessfulRunAtMs: now}),
              },
            };
          }
          const error = new Error('missing') as Error & {name: string};
          error.name = 'NoSuchKey';
          throw error;
        }
        if (command.input.Key.includes('-1-V4')) {
          const error = new Error('conflict') as Error & {name: string};
          error.name = 'PreconditionFailed';
          throw error;
        }
        writes.push({
          key: command.input.Key,
          body: JSON.parse(command.input.Body),
        });
        return {};
      },
    } as unknown as S3Client;

    await expect(
      buildXStocksAssetsRegistry(
        logger,
        metric,
        {
          s3Bucket: 'bucket',
          s3BaseKey: 'xstocksAssetsRegistry.json',
          chainIds: [1],
          retirementSafetyMarginMs: 60 * 60 * 1000,
          retiredRetentionMs: 7 * 24 * 60 * 60 * 1000,
          runIntervalMs: 5 * 60 * 1000,
          expectedHookCodehashByChain: {},
        },
        {
          s3,
          fetchAssets: async () => [
            {
              xStockAddress: entry.xStock,
              tokenDeployments: [
                {
                  chainId: 999,
                  wrapperAddress: entry.wxStock,
                  hookAddress: entry.hookAddress,
                  poolId: entry.poolId,
                  feeTier: entry.feeTier,
                  tickSpacing: entry.tickSpacing,
                },
              ],
            },
          ],
          getChain: () => undefined,
          getProvider: () => undefined,
          nowMs: () => now,
          verifyAsset: async () => true,
        }
      )
    ).rejects.toThrow('failed for all 1 configured chains');
  });

  it('retires a previously active asset immediately after verification fails', async () => {
    const writes = await run([{...entry, updatedAtMs: now - 1_000}], {
      markerAtMs: now,
      assets: [
        {
          xStockAddress: entry.xStock,
          tokenDeployments: [
            {
              chainId: 1,
              wrapperAddress: entry.wxStock,
              hookAddress: entry.hookAddress,
              poolId: entry.poolId,
              feeTier: entry.feeTier,
              tickSpacing: entry.tickSpacing,
            },
          ],
        },
      ],
      verifyAsset: async () => false,
    });
    expect(writes).toEqual([[{...entry, status: 'retired', updatedAtMs: now}]]);
  });

  it('skips absence-based retirements after a long writer pause', async () => {
    expect(
      await run([{...entry, updatedAtMs: now - 60 * 60 * 1000}], {
        markerAtMs: now - 16 * 60 * 1000,
      })
    ).toEqual([]);
  });

  it('writes a confirmed empty registry on the first run', async () => {
    expect(await run([], {firstWrite: true, markerAtMs: now})).toEqual([[]]);
  });
});

describe('parseExpectedHookCodehashByChain', () => {
  const HASH = `0x${'ab'.repeat(32)}`;

  it('parses valid chainId→codehash entries and lowercases values', () => {
    expect(
      parseExpectedHookCodehashByChain(
        JSON.stringify({1: HASH.toUpperCase().replace('0X', '0x'), 196: HASH})
      )
    ).toEqual({1: HASH, 196: HASH});
  });

  it('drops malformed entries and tolerates malformed input', () => {
    expect(parseExpectedHookCodehashByChain(undefined)).toEqual({});
    expect(parseExpectedHookCodehashByChain('')).toEqual({});
    expect(parseExpectedHookCodehashByChain('not-json')).toEqual({});
    expect(parseExpectedHookCodehashByChain('[1,2]')).toEqual({});
    expect(
      parseExpectedHookCodehashByChain(
        JSON.stringify({abc: HASH, 1: '0x1234', 196: HASH})
      )
    ).toEqual({196: HASH});
  });
});
