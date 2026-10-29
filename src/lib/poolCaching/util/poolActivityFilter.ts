import {getPermissionedHookAddresses} from '@uniswap/lib-sharedconfig/permissionedTokens';
import {CanonicalPools} from '../../CanonicalPools';
import {AURORA_SUPPORTED_TARGETS} from '../auroraPoolsSource';
import {V2SubgraphPool} from '../sor-providers/v2/subgraphProvider';
import {V3SubgraphPool} from '../sor-providers/v3/subgraphProvider';
import {V4SubgraphPool} from '../sor-providers/v4/subgraphProvider';
import {getTvlBypassHookAddresses} from './hooksAddressesAllowlist';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A pool whose state last changed longer ago than this is dropped. */
export const POOL_ACTIVITY_WINDOW_MS = 7 * DAY_MS;

/**
 * The activity signal is Aurora pool-state ingestion. When even its newest
 * write is older than this, ingestion has stalled and every pool would look
 * inactive, so the filter keeps the whole list instead.
 */
export const POOL_ACTIVITY_SIGNAL_MAX_STALENESS_MS = 6 * 60 * 60 * 1000;

/**
 * When the filter would keep less than this share of a combo's pools, the
 * activity signal is more likely wrong than the pools idle, so the filter
 * keeps the whole list instead. Robinhood V4 on dev keeps ~7.7% (26.4k of
 * 341.6k), about four times this floor.
 */
export const POOL_ACTIVITY_MIN_KEPT_SHARE = 0.02;

export type ActivityFilterPool =
  | V2SubgraphPool
  | V3SubgraphPool
  | V4SubgraphPool;

export enum PoolActivitySkipReason {
  /** No pool carries a timestamp: the provider did not record activity. */
  NO_ACTIVITY_SIGNAL = 'no_activity_signal',
  STALE_ACTIVITY_SIGNAL = 'stale_activity_signal',
  KEPT_SHARE_BELOW_FLOOR = 'kept_share_below_floor',
}

export type PoolActivityFilterOutcome =
  | {status: 'pruned'; kept: number; dropped: number; exempt: number}
  | {status: 'skipped'; reason: PoolActivitySkipReason};

export interface PoolActivityFilterResult<T extends ActivityFilterPool> {
  /** The pools to cache, each without `lastStateChangeAtMs`. */
  pools: T[];
  outcome: PoolActivityFilterOutcome;
}

/** Pools that stay cached however long ago their state last changed. */
export interface PoolActivityExemptions {
  /** Lowercased V4 hook addresses. */
  hooks: ReadonlySet<string>;
  /** Lowercased pool ids. */
  poolIds: ReadonlySet<string>;
}

export interface PoolActivityFilterConfig {
  /** `targetKey(chainId, protocol)` of each combo the filter runs on. */
  targets: ReadonlySet<string>;
  /** Entries of the env value that name no code-supported Aurora combo. */
  ignoredEntries: string[];
}

/**
 * Combos whose cached pool lists drop pools with no state change in the last
 * POOL_ACTIVITY_WINDOW_MS. Comma-separated `chainId:protocol` (`4663:V4`);
 * unset or empty (the default) is off. The activity timestamp comes from the
 * Aurora pool source, so an entry outside AURORA_SUPPORTED_TARGETS is
 * ignored. There is no `*`: dropping pools is a per-combo decision.
 */
export function poolActivityFilterConfigFromEnv(): PoolActivityFilterConfig {
  const raw = process.env.POOL_CACHING_ACTIVITY_FILTER_TARGETS?.trim();
  const targets = new Set<string>();
  const ignoredEntries: string[] = [];
  if (!raw) return {targets, ignoredEntries};
  for (const entry of raw.split(',')) {
    const target = entry.trim().toUpperCase();
    if (AURORA_SUPPORTED_TARGETS.has(target)) {
      targets.add(target);
    } else {
      ignoredEntries.push(entry.trim());
    }
  }
  return {targets, ignoredEntries};
}

/**
 * Pools admitted by identity rather than by trading: TVL-bypass hooks (ZLCA
 * and zero-measured-TVL hooks, static and factory-discovered), permissioned
 * hooks, and canonical pools. A canonical pool missing from the snapshot
 * leaves its token unroutable. Allowlisted hooks are not exempt: Robinhood's
 * allowlist includes the zero address, and an idle allowlisted pool off the
 * canonical (fee, tickSpacing) grid stays reachable as a direct pair through
 * the V4 PoolKey registry probe on stacks whose registry lists include the
 * chain (prod for Robinhood).
 */
export function poolActivityExemptions(
  chainId: number
): PoolActivityExemptions {
  const hooks = new Set(getTvlBypassHookAddresses(chainId) ?? []);
  for (const hook of getPermissionedHookAddresses(chainId)) {
    hooks.add(hook.toLowerCase());
  }
  return {
    hooks,
    poolIds: CanonicalPools.canonicalPoolIds(chainId),
  };
}

function withoutActivityTimestamp<T extends ActivityFilterPool>(pool: T): T {
  const copy = {...pool};
  delete copy.lastStateChangeAtMs;
  return copy;
}

function isExempt(
  pool: ActivityFilterPool,
  exemptions: PoolActivityExemptions
): boolean {
  if (exemptions.poolIds.has(pool.id.toLowerCase())) return true;
  return 'hooks' in pool && exemptions.hooks.has(pool.hooks.toLowerCase());
}

/**
 * Keeps pools whose state changed within POOL_ACTIVITY_WINDOW_MS of `nowMs`,
 * exempt pools, and pools without a timestamp (extra sources and manual
 * entries). A pool's creation is a state change, so a new pool stays cached
 * for the whole window before its first swap.
 */
export function filterPoolsByRecentActivity<T extends ActivityFilterPool>(
  pools: T[],
  exemptions: PoolActivityExemptions,
  nowMs: number
): PoolActivityFilterResult<T> {
  let newestMs = Number.NEGATIVE_INFINITY;
  for (const pool of pools) {
    const changedAtMs = pool.lastStateChangeAtMs;
    if (changedAtMs !== undefined && changedAtMs > newestMs) {
      newestMs = changedAtMs;
    }
  }
  if (!Number.isFinite(newestMs)) {
    // No pool carries a usable timestamp, so there is nothing to strip.
    return {
      pools,
      outcome: {
        status: 'skipped',
        reason: PoolActivitySkipReason.NO_ACTIVITY_SIGNAL,
      },
    };
  }
  if (nowMs - newestMs > POOL_ACTIVITY_SIGNAL_MAX_STALENESS_MS) {
    return {
      pools: pools.map(withoutActivityTimestamp),
      outcome: {
        status: 'skipped',
        reason: PoolActivitySkipReason.STALE_ACTIVITY_SIGNAL,
      },
    };
  }

  const cutoffMs = nowMs - POOL_ACTIVITY_WINDOW_MS;
  const kept: T[] = [];
  let dropped = 0;
  let exempt = 0;
  for (const pool of pools) {
    const changedAtMs = pool.lastStateChangeAtMs;
    if (changedAtMs === undefined || changedAtMs >= cutoffMs) {
      kept.push(withoutActivityTimestamp(pool));
    } else if (isExempt(pool, exemptions)) {
      exempt++;
      kept.push(withoutActivityTimestamp(pool));
    } else {
      dropped++;
    }
  }
  if (kept.length < pools.length * POOL_ACTIVITY_MIN_KEPT_SHARE) {
    return {
      pools: pools.map(withoutActivityTimestamp),
      outcome: {
        status: 'skipped',
        reason: PoolActivitySkipReason.KEPT_SHARE_BELOW_FLOOR,
      },
    };
  }
  return {
    pools: kept,
    outcome: {status: 'pruned', kept: kept.length, dropped, exempt},
  };
}
