/**
 * Isolated tests for the agg hook filtering logic in BasicTopPoolsSelector and
 * AggHooksTopPoolsSelector using a fully mocked hooksAddressesAllowlist module.
 *
 * These tests are kept in a separate file from TopPoolsSelector.test.ts because
 * vi.mock is hoisted to the top of the file — adding it to the existing file
 * would replace the real module for all tests there, which rely on real
 * FLUID_DEX_LITE / STABLE_SWAP_NG addresses.
 *
 * Key scenarios verified here (not possible without mocking):
 *   - AGG_HOOKS_PER_CHAIN drives exclusion in BasicTopPoolsSelector and
 *     inclusion in AggHooksTopPoolsSelector — the selectors build their address
 *     sets directly from this map and never call getProtocolForAggHookAddress.
 *   - AGG_HOOKS_PROTOCOL_CACHED_ROUTES_FILTER_OUT_LIST (populated with
 *     'FluidDexT1' here) has NO effect on either selector — that list is a
 *     cached-routes / routing-universe concern only.
 */

import {describe, beforeEach, it, expect, vi} from 'vitest';
import {
  AggHooksTopPoolsSelector,
  BasicTopPoolsSelector,
} from './TopPoolsSelector';
import {ChainId} from '../../lib/config';
import {Context} from '@uniswap/lib-uni/context';
import {Address} from '../../models/address/Address';
import {V2PoolInfo, V4PoolInfo} from './interface';
import {HardcodedChainRepository} from '../../stores/chain/hardcoded/HardcodedChainRepository';
import {ADDRESS_ZERO} from '@uniswap/router-sdk';
import {poolSelectionConfig} from 'src/lib/config';
import {Protocol} from 'src/models/pool/Protocol';
import {EMPTY_NAMESPACE_CONTEXT} from '../../models/hooks/namespaces';
import {HooksOptions} from 'src/models/hooks/HooksOptions';

// ---------------------------------------------------------------------------
// Synthetic test addresses — no dependency on production address lists.
// ---------------------------------------------------------------------------
// A hook address that the mock treats as belonging to Protocol.FLUIDDEXT1.
const TEST_AGG_HOOK = '0xaaaa000000000000000000000000000000000001';
// A hook address that the mock does NOT recognise as an agg hook.
const NON_AGG_HOOK = '0xbbbb000000000000000000000000000000000001';

// vi.mock is hoisted before any imports so the factory must use literals.
// AGG_HOOKS_PER_CHAIN and getProtocolForAggHookAddress must be consistent:
//   FluidDexT1 owns TEST_AGG_HOOK on MAINNET (chainId=1).
// AGG_HOOKS_PROTOCOL_CACHED_ROUTES_FILTER_OUT_LIST is populated with 'FluidDexT1'
// to verify that neither selector reads it — it is a cached-routes concern only.
vi.mock('src/lib/poolCaching/util/hooksAddressesAllowlist', () => ({
  AGG_HOOKS_PER_CHAIN: {
    FluidDexT1: {[1]: ['0xaaaa000000000000000000000000000000000001']},
  },
  AGG_HOOKS_PROTOCOL_CACHED_ROUTES_FILTER_OUT_LIST: new Set(['FluidDexT1']),
  GUIDESTAR_STABLE_STABLE_HOOK_ON_MAINNET:
    '0x4509b7eb3f9641226804fea4976963435d1c6080',
  getProtocolForAggHookAddress: (hookAddress: string, _chainId: number) =>
    hookAddress.toLowerCase() === '0xaaaa000000000000000000000000000000000001'
      ? 'FluidDexT1'
      : undefined,
}));

// ---------------------------------------------------------------------------
// Pool factory helpers
// ---------------------------------------------------------------------------
function makeV4Pool(
  id: string,
  token0: string,
  token1: string,
  hooks: string,
  tvlUSD = 5000
): V4PoolInfo {
  return {
    id,
    token0: {id: token0},
    token1: {id: token1},
    hooks,
    feeTier: '3000',
    tickSpacing: '60',
    liquidity: '10000',
    tvlETH: tvlUSD,
    tvlUSD,
  } as V4PoolInfo;
}

function makeV2Pool(
  id: string,
  token0: string,
  token1: string,
  reserveUSD = 5000
): V2PoolInfo {
  return {
    id,
    token0: {id: token0},
    token1: {id: token1},
    reserveUSD,
    supply: 10000,
    reserve: 10000,
  } as V2PoolInfo;
}

// Canonical token addresses used across all tests.
const TOKEN_IN = '0x1000000000000000000000000000000000000001';
const TOKEN_OUT = '0x2000000000000000000000000000000000000001';
const tokenIn = new Address(TOKEN_IN);
const tokenOut = new Address(TOKEN_OUT);

// ---------------------------------------------------------------------------
// BasicTopPoolsSelector — agg hook exclusion with mocked module
// ---------------------------------------------------------------------------
describe('BasicTopPoolsSelector — agg hook exclusion (mocked hooksAddressesAllowlist)', () => {
  let selector: BasicTopPoolsSelector;
  let ctx: Context;

  beforeEach(() => {
    selector = new BasicTopPoolsSelector(
      new HardcodedChainRepository(),
      poolSelectionConfig
    );
    ctx = {logger: {debug: vi.fn(), warn: vi.fn()}} as unknown as Context;
  });

  it('excludes a V4 pool whose hook address is in AGG_HOOKS_PER_CHAIN', async () => {
    const aggPool = makeV4Pool('agg-pool', TOKEN_IN, TOKEN_OUT, TEST_AGG_HOOK);
    const normalPool = makeV4Pool(
      'normal-pool',
      TOKEN_IN,
      TOKEN_OUT,
      ADDRESS_ZERO
    );

    const result = await selector.filterPools(
      [aggPool, normalPool],
      ChainId.MAINNET,
      tokenIn,
      tokenOut,
      Protocol.V4,
      undefined,
      EMPTY_NAMESPACE_CONTEXT,
      ctx,
      {shouldUseCache: true}
    );

    const ids = result.map(p => p.id);
    expect(ids).not.toContain('agg-pool');
    expect(ids).toContain('normal-pool');
  });

  it('keeps a V4 pool whose hook is NOT recognised (returns undefined)', async () => {
    const nonAggPool = makeV4Pool(
      'non-agg-pool',
      TOKEN_IN,
      TOKEN_OUT,
      NON_AGG_HOOK
    );

    const result = await selector.filterPools(
      [nonAggPool],
      ChainId.MAINNET,
      tokenIn,
      tokenOut,
      Protocol.V4,
      undefined,
      EMPTY_NAMESPACE_CONTEXT,
      ctx,
      {shouldUseCache: true}
    );

    expect(result.map(p => p.id)).toContain('non-agg-pool');
  });

  it('excludes agg hook pool even when hooksOptions is HOOKS_INCLUSIVE', async () => {
    const aggPool = makeV4Pool('agg-pool', TOKEN_IN, TOKEN_OUT, TEST_AGG_HOOK);
    const normalPool = makeV4Pool(
      'normal-pool',
      TOKEN_IN,
      TOKEN_OUT,
      NON_AGG_HOOK
    );

    const result = await selector.filterPools(
      [aggPool, normalPool],
      ChainId.MAINNET,
      tokenIn,
      tokenOut,
      Protocol.V4,
      HooksOptions.HOOKS_INCLUSIVE,
      EMPTY_NAMESPACE_CONTEXT,
      ctx,
      {shouldUseCache: true}
    );

    const ids = result.map(p => p.id);
    expect(ids).not.toContain('agg-pool');
    expect(ids).toContain('normal-pool');
  });

  it('AGG_HOOKS_PROTOCOL_CACHED_ROUTES_FILTER_OUT_LIST has no effect on exclusion', async () => {
    // The mock populates AGG_HOOKS_PROTOCOL_CACHED_ROUTES_FILTER_OUT_LIST with
    // 'FluidDexT1', yet BasicTopPoolsSelector does not read that list — it only
    // calls getProtocolForAggHookAddress().  The agg hook pool must still be excluded.
    const aggPool = makeV4Pool('agg-pool', TOKEN_IN, TOKEN_OUT, TEST_AGG_HOOK);
    const normalPool = makeV4Pool(
      'normal-pool',
      TOKEN_IN,
      TOKEN_OUT,
      ADDRESS_ZERO
    );

    const result = await selector.filterPools(
      [aggPool, normalPool],
      ChainId.MAINNET,
      tokenIn,
      tokenOut,
      Protocol.V4,
      undefined,
      EMPTY_NAMESPACE_CONTEXT,
      ctx,
      {shouldUseCache: true}
    );

    expect(result.map(p => p.id)).not.toContain('agg-pool');
  });

  it('does not affect V2 pools (no hooks field)', async () => {
    const v2Pool = makeV2Pool('v2-pool', TOKEN_IN, TOKEN_OUT);

    const result = await selector.filterPools(
      [v2Pool],
      ChainId.MAINNET,
      tokenIn,
      tokenOut,
      Protocol.V2,
      undefined,
      EMPTY_NAMESPACE_CONTEXT,
      ctx,
      {shouldUseCache: true}
    );

    expect(result.map(p => p.id)).toContain('v2-pool');
  });
});

// ---------------------------------------------------------------------------
// AggHooksTopPoolsSelector — agg hook inclusion with mocked module
// ---------------------------------------------------------------------------
describe('AggHooksTopPoolsSelector — agg hook inclusion (mocked hooksAddressesAllowlist)', () => {
  let selector: AggHooksTopPoolsSelector;
  let ctx: Context;

  beforeEach(() => {
    selector = new AggHooksTopPoolsSelector(poolSelectionConfig);
    ctx = {logger: {debug: vi.fn(), warn: vi.fn()}} as unknown as Context;
  });

  it('includes only the pool whose hook address is in AGG_HOOKS_PER_CHAIN', async () => {
    const aggPool = makeV4Pool('agg-pool', TOKEN_IN, TOKEN_OUT, TEST_AGG_HOOK);
    const nonAggPool = makeV4Pool(
      'non-agg-pool',
      TOKEN_IN,
      TOKEN_OUT,
      NON_AGG_HOOK
    );

    const result = await selector.filterPools(
      [aggPool, nonAggPool],
      ChainId.MAINNET,
      tokenIn,
      tokenOut,
      Protocol.V4,
      undefined,
      EMPTY_NAMESPACE_CONTEXT,
      ctx,
      {shouldUseCache: true}
    );

    const ids = result.map(p => p.id);
    expect(ids).toContain('agg-pool');
    expect(ids).not.toContain('non-agg-pool');
  });

  it('excludes pools with unrecognised hook addresses', async () => {
    const nonAggPool = makeV4Pool(
      'non-agg-pool',
      TOKEN_IN,
      TOKEN_OUT,
      NON_AGG_HOOK
    );

    const result = await selector.filterPools(
      [nonAggPool],
      ChainId.MAINNET,
      tokenIn,
      tokenOut,
      Protocol.V4,
      undefined,
      EMPTY_NAMESPACE_CONTEXT,
      ctx,
      {shouldUseCache: true}
    );

    expect(result).toHaveLength(0);
  });

  it('excludes pools with ADDRESS_ZERO hooks', async () => {
    const noHookPool = makeV4Pool(
      'no-hook-pool',
      TOKEN_IN,
      TOKEN_OUT,
      ADDRESS_ZERO
    );

    const result = await selector.filterPools(
      [noHookPool],
      ChainId.MAINNET,
      tokenIn,
      tokenOut,
      Protocol.V4,
      undefined,
      EMPTY_NAMESPACE_CONTEXT,
      ctx,
      {shouldUseCache: true}
    );

    expect(result).toHaveLength(0);
  });

  it('includes a tokenIn-only agg hook pool via one-hop heuristic', async () => {
    const OTHER_TOKEN = '0x3000000000000000000000000000000000000001';
    // Pool exists for tokenIn → other, not tokenIn → tokenOut directly.
    const aggPool = makeV4Pool(
      'agg-pool',
      TOKEN_IN,
      OTHER_TOKEN,
      TEST_AGG_HOOK
    );

    const result = await selector.filterPools(
      [aggPool],
      ChainId.MAINNET,
      tokenIn,
      tokenOut,
      Protocol.V4,
      undefined,
      EMPTY_NAMESPACE_CONTEXT,
      ctx,
      {shouldUseCache: true}
    );

    // With the refactored multi-hop heuristics, tokenIn-only pools are selected
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('agg-pool');
  });

  it('AGG_HOOKS_PROTOCOL_CACHED_ROUTES_FILTER_OUT_LIST has no effect on pool inclusion', async () => {
    // The mock populates AGG_HOOKS_PROTOCOL_CACHED_ROUTES_FILTER_OUT_LIST with
    // 'FluidDexT1'.  AggHooksTopPoolsSelector does not read that list — the
    // recognised agg hook pool must still be returned.
    const aggPool = makeV4Pool('agg-pool', TOKEN_IN, TOKEN_OUT, TEST_AGG_HOOK);

    const result = await selector.filterPools(
      [aggPool],
      ChainId.MAINNET,
      tokenIn,
      tokenOut,
      Protocol.V4,
      undefined,
      EMPTY_NAMESPACE_CONTEXT,
      ctx,
      {shouldUseCache: true}
    );

    expect(result.map(p => p.id)).toContain('agg-pool');
  });

  it('matches hook addresses case-insensitively', async () => {
    // TEST_AGG_HOOK in uppercase — the selector lowercases before lookup.
    const upperCaseHookPool = makeV4Pool(
      'upper-hook-pool',
      TOKEN_IN,
      TOKEN_OUT,
      TEST_AGG_HOOK.toUpperCase()
    );

    const result = await selector.filterPools(
      [upperCaseHookPool],
      ChainId.MAINNET,
      tokenIn,
      tokenOut,
      Protocol.V4,
      undefined,
      EMPTY_NAMESPACE_CONTEXT,
      ctx,
      {shouldUseCache: true}
    );

    expect(result.map(p => p.id)).toContain('upper-hook-pool');
  });
});
