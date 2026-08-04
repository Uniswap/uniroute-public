import {afterEach, describe, expect, it} from 'vitest';
import {
  EMPTY_ERC4626_SNAPSHOT,
  computeErc4626WrapperChainConfig,
  erc4626WrapperConfigFromEnv,
  Erc4626WrapperRegistryStaticData,
  filterValidErc4626Assets,
  StaticErc4626WrapperRegistry,
} from './Erc4626WrapperRegistry';

const asset = {
  xStock: '0xAa00000000000000000000000000000000000001',
  wxStock: '0xBb00000000000000000000000000000000000002',
  hookAddress: '0xCc00000000000000000000000000000000000003',
  poolId: `0x${'11'.repeat(32)}`,
  feeTier: '500',
  tickSpacing: '10',
};

const data: Erc4626WrapperRegistryStaticData = {
  getAssets: chainId => (chainId === 1 ? [asset] : []),
  getHookCodeOverrides: chainId =>
    chainId === 1 ? {[asset.hookAddress]: '0x6000'} : {},
};

const env = {...process.env};
afterEach(() => {
  process.env = {...env};
});

describe('StaticErc4626WrapperRegistry', () => {
  it('returns the shared empty snapshot while disabled', async () => {
    const registry = new StaticErc4626WrapperRegistry(
      {enabled: false, chainIds: [1]},
      data
    );
    expect(await registry.getSnapshot(1)).toBe(EMPTY_ERC4626_SNAPSHOT);
  });

  it('fails closed for chains outside its configured scope', async () => {
    const registry = new StaticErc4626WrapperRegistry(
      {enabled: true, chainIds: [2]},
      data
    );
    expect(await registry.getSnapshot(1)).toBe(EMPTY_ERC4626_SNAPSHOT);
  });

  it('passes through a memoized, normalized static snapshot when enabled', async () => {
    const registry = new StaticErc4626WrapperRegistry(
      {enabled: true, chainIds: [1]},
      data
    );
    const snapshot = await registry.getSnapshot(1);

    expect(snapshot).toBe(await registry.getSnapshot(1));
    expect(snapshot.getByXStock(asset.xStock)).toMatchObject({
      hookAddress: asset.hookAddress.toLowerCase(),
    });
    expect(snapshot.getByWxStock(asset.wxStock)).toBeDefined();
    expect(snapshot.isWrapperHook(asset.hookAddress)).toBe(true);
    expect(snapshot.hookCodeOverrides).toEqual({
      [asset.hookAddress.toLowerCase()]: '0x6000',
    });
  });

  it('excludes cross-role identity collisions from the runtime snapshot', async () => {
    const crossRoleData: Erc4626WrapperRegistryStaticData = {
      getAssets: () => [
        asset,
        {
          ...asset,
          xStock: '0xdd00000000000000000000000000000000000004',
          wxStock: asset.xStock,
          hookAddress: '0xff00000000000000000000000000000000000006',
          poolId: `0x${'22'.repeat(32)}`,
        },
      ],
      getHookCodeOverrides: () => ({}),
    };
    const registry = new StaticErc4626WrapperRegistry(
      {enabled: true, chainIds: [1]},
      crossRoleData
    );
    const snapshot = await registry.getSnapshot(1);

    expect(snapshot.assets).toEqual([]);
    expect(snapshot.excludedAssetCount).toBe(2);
  });

  it('excludes cross-role identity collisions from dynamic data', () => {
    const result = filterValidErc4626Assets([
      asset,
      {
        ...asset,
        xStock: '0xdd00000000000000000000000000000000000004',
        wxStock: asset.xStock,
        hookAddress: '0xff00000000000000000000000000000000000006',
        poolId: `0x${'22'.repeat(32)}`,
      },
    ]);

    expect(result.accepted).toEqual([]);
    expect(result.excludedCount).toBe(2);
  });

  it('returns no active chain config while disabled', () => {
    expect(
      computeErc4626WrapperChainConfig(1, {enabled: false, chainIds: [1]}, data)
    ).toEqual({hookCodeOverrides: {}, hookAddresses: new Set()});
  });
});

describe('erc4626WrapperConfigFromEnv', () => {
  it('defaults to disabled and fails closed for invalid chain ids', () => {
    delete process.env.XSTOCKS_ROUTING_ENABLED;
    process.env.XSTOCKS_CHAIN_IDS = '1,nope';
    expect(erc4626WrapperConfigFromEnv()).toEqual({
      enabled: false,
      chainIds: [],
    });
  });

  it('uses an empty chain scope when enabled with blank chain ids', () => {
    process.env.XSTOCKS_ROUTING_ENABLED = 'true';
    process.env.XSTOCKS_CHAIN_IDS = '  ';
    expect(erc4626WrapperConfigFromEnv()).toEqual({
      enabled: true,
      chainIds: [],
    });
  });
});
