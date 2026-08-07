import {describe, expect, it} from 'vitest';
import {S3Client} from '@aws-sdk/client-s3';
import {DynamicErc4626WrapperRegistry} from './DynamicErc4626WrapperRegistry';

const entry = {
  xStock: '0xaa00000000000000000000000000000000000001',
  wxStock: '0xbb00000000000000000000000000000000000002',
  hookAddress: '0xcc00000000000000000000000000000000000003',
  poolId: `0x${'11'.repeat(32)}`,
  feeTier: '500',
  tickSpacing: '10',
  status: 'active' as const,
  updatedAtMs: 1,
};

describe('DynamicErc4626WrapperRegistry', () => {
  it('fails closed to last-known-good after a successful read fails', async () => {
    let calls = 0;
    const s3 = {
      send: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            Body: {transformToString: async () => JSON.stringify([entry])},
          };
        }
        throw new Error('S3 unavailable');
      },
    } as unknown as S3Client;
    const registry = new DynamicErc4626WrapperRegistry(s3, {
      s3Bucket: 'bucket',
      s3BaseKey: 'xstocksAssetsRegistry.json',
      cacheTtlMs: 0,
      coldStartMaxWaitMs: 250,
    });

    expect(await registry.getActiveAssets(1)).toEqual([entry]);
    // The stale read triggers refresh; its failure must retain the LKG entry.
    expect(await registry.getActiveAssets(1)).toEqual([entry]);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(await registry.getActiveAssets(1)).toEqual([entry]);
  });

  it('returns [] on a cold-start failure with no value to retain', async () => {
    const s3 = {
      send: async () => {
        throw new Error('S3 unavailable');
      },
    } as unknown as S3Client;
    const registry = new DynamicErc4626WrapperRegistry(s3, {
      s3Bucket: 'bucket',
      s3BaseKey: 'xstocksAssetsRegistry.json',
      cacheTtlMs: 45_000,
      coldStartMaxWaitMs: 250,
    });

    expect(await registry.getActiveAssets(1)).toEqual([]);
  });
});
