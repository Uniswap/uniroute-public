import {afterEach, describe, expect, it} from 'vitest';
import {V2SubgraphPool} from '../sor-providers/v2/subgraphProvider';
import {V4SubgraphPool} from '../sor-providers/v4/subgraphProvider';
import {FLETH_HOOK_ON_ROBINHOOD} from './hooksAddressesAllowlist';
import {
  filterPoolsByRecentActivity,
  POOL_ACTIVITY_MIN_KEPT_SHARE,
  POOL_ACTIVITY_SIGNAL_MAX_STALENESS_MS,
  POOL_ACTIVITY_WINDOW_MS,
  poolActivityExemptions,
  poolActivityFilterConfigFromEnv,
  PoolActivityExemptions,
  PoolActivitySkipReason,
} from './poolActivityFilter';

const ROBINHOOD = 4663;
// STANDARD's canonical ETH/STANDARD pool in CanonicalPools.ts.
const ROBINHOOD_CANONICAL_POOL_ID =
  '0xc73f3cd3fb68288e63f008e08ef69caa0437224e420963c6aeb4526178e87ad9';
const NOW_MS = Date.UTC(2026, 9, 26, 12, 0, 0);
const RECENT_MS = NOW_MS - 60 * 1000;
const STALE_MS = NOW_MS - POOL_ACTIVITY_WINDOW_MS - 60 * 1000;
const HOOKLESS = '0x0000000000000000000000000000000000000000';
const NO_EXEMPTIONS: PoolActivityExemptions = {
  hooks: new Set(),
  poolIds: new Set(),
};

function v4Pool(
  id: string,
  lastStateChangeAtMs: number | undefined,
  hooks = HOOKLESS
): V4SubgraphPool {
  return {
    id,
    feeTier: '3000',
    tickSpacing: '60',
    hooks,
    liquidity: '1000',
    token0: {id: '0xa', decimals: '18'},
    token1: {id: '0xb', decimals: '6'},
    tvlETH: 1,
    tvlUSD: 2000,
    lastStateChangeAtMs,
  };
}

function v2Pool(id: string, lastStateChangeAtMs: number): V2SubgraphPool {
  return {
    id,
    token0: {id: '0xa'},
    token1: {id: '0xb'},
    supply: 1,
    reserve: 1,
    reserveUSD: 2000,
    lastStateChangeAtMs,
  };
}

describe('poolActivityFilterConfigFromEnv', () => {
  const saved = process.env.POOL_CACHING_ACTIVITY_FILTER_TARGETS;
  afterEach(() => {
    if (saved === undefined) {
      delete process.env.POOL_CACHING_ACTIVITY_FILTER_TARGETS;
    } else {
      process.env.POOL_CACHING_ACTIVITY_FILTER_TARGETS = saved;
    }
  });

  it.each([undefined, '', '  '])('is off for %j', raw => {
    if (raw === undefined) {
      delete process.env.POOL_CACHING_ACTIVITY_FILTER_TARGETS;
    } else {
      process.env.POOL_CACHING_ACTIVITY_FILTER_TARGETS = raw;
    }
    expect(poolActivityFilterConfigFromEnv()).toEqual({
      targets: new Set(),
      ignoredEntries: [],
    });
  });

  it('accepts Aurora combos in any case and reports every other entry', () => {
    process.env.POOL_CACHING_ACTIVITY_FILTER_TARGETS =
      '4663:v4, 4663:V2,*,4663:V9,999999:V4';
    expect(poolActivityFilterConfigFromEnv()).toEqual({
      targets: new Set(['4663:V4', '4663:V2']),
      ignoredEntries: ['*', '4663:V9', '999999:V4'],
    });
  });
});

describe('poolActivityExemptions', () => {
  it('exempts Robinhood canonical pools and TVL-bypass hooks', () => {
    const exemptions = poolActivityExemptions(ROBINHOOD);
    expect(exemptions.poolIds.has(ROBINHOOD_CANONICAL_POOL_ID)).toBe(true);
    expect(exemptions.hooks.has(FLETH_HOOK_ON_ROBINHOOD.toLowerCase())).toBe(
      true
    );
  });

  it('is empty on a chain with no identity-admitted pools', () => {
    const exemptions = poolActivityExemptions(999999);
    expect(exemptions.poolIds.size).toBe(0);
    expect(exemptions.hooks.size).toBe(0);
  });
});

describe('filterPoolsByRecentActivity', () => {
  it('drops pools idle past the window and strips the timestamp from the rest', () => {
    const {pools, outcome} = filterPoolsByRecentActivity(
      [
        v4Pool('0xrecent', RECENT_MS),
        v4Pool('0xstale', STALE_MS),
        v4Pool('0xedge', NOW_MS - POOL_ACTIVITY_WINDOW_MS),
      ],
      NO_EXEMPTIONS,
      NOW_MS
    );
    expect(pools.map(pool => pool.id)).toEqual(['0xrecent', '0xedge']);
    expect(pools.every(pool => !('lastStateChangeAtMs' in pool))).toBe(true);
    expect(outcome).toEqual({status: 'pruned', kept: 2, dropped: 1, exempt: 0});
  });

  it('keeps idle Robinhood canonical and TVL-bypass pools whatever their casing', () => {
    const {pools, outcome} = filterPoolsByRecentActivity(
      [
        v4Pool('0xrecent', RECENT_MS),
        v4Pool(ROBINHOOD_CANONICAL_POOL_ID.toUpperCase(), STALE_MS),
        v4Pool('0xzlca', STALE_MS, FLETH_HOOK_ON_ROBINHOOD.toUpperCase()),
        v4Pool('0xidle', STALE_MS),
      ],
      poolActivityExemptions(ROBINHOOD),
      NOW_MS
    );
    expect(pools.map(pool => pool.id)).toEqual([
      '0xrecent',
      ROBINHOOD_CANONICAL_POOL_ID.toUpperCase(),
      '0xzlca',
    ]);
    expect(outcome).toEqual({status: 'pruned', kept: 3, dropped: 1, exempt: 2});
  });

  it('keeps pools that carry no timestamp, such as extra-source pools', () => {
    const {pools, outcome} = filterPoolsByRecentActivity(
      [v4Pool('0xrecent', RECENT_MS), v4Pool('0xmanual', undefined)],
      NO_EXEMPTIONS,
      NOW_MS
    );
    expect(pools.map(pool => pool.id)).toEqual(['0xrecent', '0xmanual']);
    expect(outcome).toEqual({status: 'pruned', kept: 2, dropped: 0, exempt: 0});
  });

  it('filters V2 pairs, which have no hooks', () => {
    const {pools} = filterPoolsByRecentActivity(
      [v2Pool('0xactive', RECENT_MS), v2Pool('0xidle', STALE_MS)],
      NO_EXEMPTIONS,
      NOW_MS
    );
    expect(pools.map(pool => pool.id)).toEqual(['0xactive']);
  });

  it('keeps every pool when ingestion has stalled', () => {
    const stalledMs = NOW_MS - POOL_ACTIVITY_SIGNAL_MAX_STALENESS_MS - 1;
    const {pools, outcome} = filterPoolsByRecentActivity(
      [v4Pool('0xlast', stalledMs), v4Pool('0xold', STALE_MS)],
      NO_EXEMPTIONS,
      NOW_MS
    );
    expect(pools.map(pool => pool.id)).toEqual(['0xlast', '0xold']);
    expect(pools.every(pool => !('lastStateChangeAtMs' in pool))).toBe(true);
    expect(outcome).toEqual({
      status: 'skipped',
      reason: PoolActivitySkipReason.STALE_ACTIVITY_SIGNAL,
    });
  });

  it('keeps every pool when it would keep less than the floor share', () => {
    const idleCount = Math.ceil(1 / POOL_ACTIVITY_MIN_KEPT_SHARE);
    const input = [
      v4Pool('0xactive', RECENT_MS),
      ...Array.from({length: idleCount}, (_, index) =>
        v4Pool(`0xidle${index}`, STALE_MS)
      ),
    ];
    const {pools, outcome} = filterPoolsByRecentActivity(
      input,
      NO_EXEMPTIONS,
      NOW_MS
    );
    expect(pools).toHaveLength(input.length);
    expect(pools.every(pool => !('lastStateChangeAtMs' in pool))).toBe(true);
    expect(outcome).toEqual({
      status: 'skipped',
      reason: PoolActivitySkipReason.KEPT_SHARE_BELOW_FLOOR,
    });
  });

  it('prunes when the kept share is exactly at the floor', () => {
    const idleCount = Math.round(1 / POOL_ACTIVITY_MIN_KEPT_SHARE) - 1;
    const {outcome} = filterPoolsByRecentActivity(
      [
        v4Pool('0xactive', RECENT_MS),
        ...Array.from({length: idleCount}, (_, index) =>
          v4Pool(`0xidle${index}`, STALE_MS)
        ),
      ],
      NO_EXEMPTIONS,
      NOW_MS
    );
    expect(outcome).toEqual({
      status: 'pruned',
      kept: 1,
      dropped: idleCount,
      exempt: 0,
    });
  });

  it('keeps every pool when none carries a timestamp', () => {
    const input = [v4Pool('0xa', undefined), v4Pool('0xb', undefined)];
    const {pools, outcome} = filterPoolsByRecentActivity(
      input,
      NO_EXEMPTIONS,
      NOW_MS
    );
    expect(pools).toEqual(input);
    expect(outcome).toEqual({
      status: 'skipped',
      reason: PoolActivitySkipReason.NO_ACTIVITY_SIGNAL,
    });
  });
});
