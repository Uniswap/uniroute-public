import {describe, expect, it} from 'vitest';
import {JsonRpcProvider} from '@ethersproject/providers';
import {Chain} from '../../models/chain/Chain';
import {XStocksAssetEntry} from './xstocksAssetsRegistry';
import {
  computeXStocksPoolId,
  verifyXStocksAssetOnChain,
} from './xstocksOnChainVerifier';

const entry: XStocksAssetEntry = {
  xStock: '0xaa00000000000000000000000000000000000001',
  wxStock: '0xbb00000000000000000000000000000000000002',
  hookAddress: '0xcc00000000000000000000000000000000000003',
  poolId: '',
  feeTier: '500',
  tickSpacing: '10',
  status: 'active',
  updatedAtMs: 1,
};
entry.poolId = computeXStocksPoolId(entry);

const provider = {} as JsonRpcProvider;
const chain = {
  v4StateViewLibraryAddress: {
    address: '0xdd00000000000000000000000000000000000004',
  },
} as Chain;
const HOOK_CODEHASH = `0x${'ab'.repeat(32)}`;
const deps = (
  overrides: Partial<Parameters<typeof verifyXStocksAssetOnChain>[2]> = {}
) => ({
  getChain: () => chain,
  getProvider: () => provider,
  expectedHookCodehashByChain: {1: HOOK_CODEHASH},
  readHookCodehash: async () => HOOK_CODEHASH,
  readVaultAsset: async () => entry.xStock,
  getPoolSqrtPriceX96: async () => 1n,
  ...overrides,
});

describe('verifyXStocksAssetOnChain', () => {
  it('rejects a pool id that does not recompute from the claimed components', async () => {
    expect(
      await verifyXStocksAssetOnChain(
        1,
        {...entry, poolId: `0x${'00'.repeat(32)}`},
        deps()
      )
    ).toBe(false);
  });

  it('rejects a vault whose asset does not equal the claimed xStock', async () => {
    expect(
      await verifyXStocksAssetOnChain(
        1,
        entry,
        deps({
          readVaultAsset: async () =>
            '0xee00000000000000000000000000000000000005',
        })
      )
    ).toBe(false);
  });

  it('rejects an uninitialized pool', async () => {
    expect(
      await verifyXStocksAssetOnChain(
        1,
        entry,
        deps({getPoolSqrtPriceX96: async () => 0n})
      )
    ).toBe(false);
  });

  it('rejects a hook whose codehash differs from the chain expectation', async () => {
    expect(
      await verifyXStocksAssetOnChain(
        1,
        entry,
        deps({readHookCodehash: async () => `0x${'cd'.repeat(32)}`})
      )
    ).toBe(false);
  });

  it('accepts a codehash match regardless of casing', async () => {
    expect(
      await verifyXStocksAssetOnChain(
        1,
        entry,
        deps({
          readHookCodehash: async () =>
            HOOK_CODEHASH.toUpperCase().replace('0X', '0x'),
        })
      )
    ).toBe(true);
  });

  it('fails closed when the chain has no expected hook codehash configured', async () => {
    expect(
      await verifyXStocksAssetOnChain(
        1,
        entry,
        deps({expectedHookCodehashByChain: {}})
      )
    ).toBe(false);
    expect(
      await verifyXStocksAssetOnChain(
        1,
        entry,
        deps({expectedHookCodehashByChain: undefined})
      )
    ).toBe(false);
  });

  it('accepts a fully verified asset', async () => {
    expect(await verifyXStocksAssetOnChain(1, entry, deps())).toBe(true);
  });
});
