import {S3Client} from '@aws-sdk/client-s3';
import {Context} from '@uniswap/lib-uni/context';
import {describe, expect, it, vi} from 'vitest';
import {buildMetricKey} from '../../lib/config';
import {DynamicErc4626WrapperRegistry} from './DynamicErc4626WrapperRegistry';
import {
  Erc4626WrapperRegistryStaticData,
  StaticErc4626WrapperRegistry,
} from './Erc4626WrapperRegistry';
import {UnionErc4626WrapperRegistry} from './UnionErc4626WrapperRegistry';
import {canIncludeErc4626Pool} from '../../models/hooks/Erc4626WrapperHooks';
import {Address} from '../../models/address/Address';
import {V4Pool} from '../../models/pool/V4Pool';

const staticAsset = {
  xStock: '0xaa00000000000000000000000000000000000001',
  wxStock: '0xbb00000000000000000000000000000000000002',
  hookAddress: '0xcc00000000000000000000000000000000000003',
  poolId: `0x${'11'.repeat(32)}`,
  feeTier: '500',
  tickSpacing: '10',
};

const makeUnion = (
  dynamicAssets: unknown[],
  dynamicKnownIdentities: readonly string[] = []
) => {
  const staticSource = new StaticErc4626WrapperRegistry(
    {enabled: true, chainIds: [1]},
    {
      getAssets: () => [staticAsset],
      getHookCodeOverrides: () => ({}),
      getHookBytecode: () => '0x6000',
    } satisfies Erc4626WrapperRegistryStaticData
  );
  const dynamicSource = {
    getActiveAssets: async () => dynamicAssets,
    getKnownIdentities: async () => new Set(dynamicKnownIdentities),
  } as unknown as DynamicErc4626WrapperRegistry;
  return new UnionErc4626WrapperRegistry(staticSource, dynamicSource, true);
};

describe('UnionErc4626WrapperRegistry', () => {
  it('applies the chain routing-hook bytecode to dynamically discovered hooks', async () => {
    const dynamicBase = {
      ...staticAsset,
      xStock: '0xdd00000000000000000000000000000000000004',
      wxStock: '0xee00000000000000000000000000000000000005',
      hookAddress: '0xff00000000000000000000000000000000000006',
      status: 'active',
      updatedAtMs: 1,
    };
    const dynamic = {
      ...dynamicBase,
      poolId: V4Pool.computePoolId(
        new Address(dynamicBase.xStock),
        new Address(dynamicBase.wxStock),
        Number(dynamicBase.feeTier),
        Number(dynamicBase.tickSpacing),
        dynamicBase.hookAddress
      ),
    };
    const snapshot = await makeUnion([dynamic]).getSnapshot(1);

    expect(snapshot.hookCodeOverrides[dynamic.hookAddress]).toBe('0x6000');
    expect(
      canIncludeErc4626Pool(
        {
          id: dynamic.poolId,
          token0: {id: dynamic.xStock},
          token1: {id: dynamic.wxStock},
          hooks: dynamic.hookAddress,
          feeTier: dynamic.feeTier,
          tickSpacing: dynamic.tickSpacing,
          liquidity: '1',
          tvlETH: 0,
          tvlUSD: 0,
        },
        dynamic.xStock,
        '0x0000000000000000000000000000000000000001',
        snapshot
      ).canInclude
    ).toBe(true);
  });

  it('keeps one accepted entry when static and dynamic assets are identical', async () => {
    const snapshot = await makeUnion([
      {...staticAsset, status: 'active', updatedAtMs: 1},
    ]).getSnapshot(1);

    expect(snapshot.assets).toHaveLength(1);
    expect(snapshot.getByXStock(staticAsset.xStock)).toBeDefined();
  });

  it.each(['xStock', 'wxStock', 'hookAddress', 'poolId'] as const)(
    'fails closed when dynamic data collides on %s',
    async identity => {
      const dynamic = {
        ...staticAsset,
        xStock: '0xdd00000000000000000000000000000000000004',
        wxStock: '0xee00000000000000000000000000000000000005',
        hookAddress: '0xff00000000000000000000000000000000000006',
        poolId: `0x${'22'.repeat(32)}`,
        status: 'active',
        updatedAtMs: 1,
        [identity]: staticAsset[identity],
      };
      const snapshot = await makeUnion([dynamic]).getSnapshot(1);
      expect(snapshot.assets).toEqual([]);
      expect(snapshot.wasEverKnownIdentity(staticAsset[identity])).toBe(true);
    }
  );

  it('retains retired dynamic identities only for cache revalidation', async () => {
    const retired = {
      ...staticAsset,
      xStock: '0xdd00000000000000000000000000000000000004',
      wxStock: '0xee00000000000000000000000000000000000005',
      hookAddress: '0xff00000000000000000000000000000000000006',
      poolId: `0x${'22'.repeat(32)}`,
    };
    const snapshot = await makeUnion(
      [],
      [retired.xStock, retired.wxStock, retired.hookAddress, retired.poolId]
    ).getSnapshot(1);

    expect(snapshot.getByXStock(retired.xStock)).toBeUndefined();
    expect(snapshot.assets).toEqual([expect.objectContaining(staticAsset)]);
    expect(snapshot.wasEverKnownIdentity(retired.hookAddress)).toBe(true);
  });

  it('logs and emits a metric when a dynamic fetch fails through the union', async () => {
    const dynamicSource = new DynamicErc4626WrapperRegistry(
      {
        send: async () => {
          throw new Error('S3 unavailable');
        },
      } as unknown as S3Client,
      {
        s3Bucket: 'bucket',
        s3BaseKey: 'xstocksAssetsRegistry.json',
        cacheTtlMs: 45_000,
        coldStartMaxWaitMs: 250,
      }
    );
    const staticSource = new StaticErc4626WrapperRegistry(
      {enabled: true, chainIds: [1]},
      {
        getAssets: () => [staticAsset],
        getHookCodeOverrides: () => ({}),
        getHookBytecode: () => '0x6000',
      }
    );
    const ctx = {
      logger: {warn: vi.fn()},
      metrics: {count: vi.fn().mockResolvedValue(undefined)},
    } as unknown as Context;

    await new UnionErc4626WrapperRegistry(
      staticSource,
      dynamicSource,
      true
    ).getSnapshot(1, ctx);

    expect(ctx.logger.warn).toHaveBeenCalledWith(
      'Failed to fetch xStocks assets registry; retaining LKG',
      expect.any(Object)
    );
    expect(ctx.metrics.count).toHaveBeenCalledWith(
      buildMetricKey('XStocksAssetsRegistry.DynamicFetchFailed'),
      1,
      {tags: ['status:failure']}
    );
  });

  it('is a complete no-op on a chain outside the configured routing scope, even when dynamic merging is enabled', async () => {
    const staticSource = new StaticErc4626WrapperRegistry(
      {enabled: true, chainIds: [1]}, // chain 1 only -- chain 999 is out of scope
      {
        getAssets: () => [staticAsset],
        getHookCodeOverrides: () => ({}),
        getHookBytecode: () => '0x6000',
      } satisfies Erc4626WrapperRegistryStaticData
    );
    const dynamicAsset = {
      ...staticAsset,
      xStock: '0xdd00000000000000000000000000000000000004',
      wxStock: '0xee00000000000000000000000000000000000005',
      hookAddress: '0xff00000000000000000000000000000000000006',
      status: 'active',
      updatedAtMs: Date.now(),
    };
    const dynamicSource = {
      getActiveAssets: async () => [dynamicAsset],
      getKnownIdentities: async () => new Set([dynamicAsset.xStock]),
    } as unknown as DynamicErc4626WrapperRegistry;

    const snapshot = await new UnionErc4626WrapperRegistry(
      staticSource,
      dynamicSource,
      true
    ).getSnapshot(999);

    expect(snapshot.assets).toHaveLength(0);
    expect(snapshot.getByXStock(dynamicAsset.xStock)).toBeUndefined();
    expect(snapshot.wasEverKnownIdentity(dynamicAsset.xStock)).toBe(false);
  });
});
