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
 * 341.6k), about four times this floor. A combo whose list is mostly idle by
 * construction can lower its own floor through
 * POOL_CACHING_ACTIVITY_FILTER_MIN_KEPT_SHARE_BY_TARGET; no combo can raise it.
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
  | {
      status: 'skipped';
      reason:
        | PoolActivitySkipReason.NO_ACTIVITY_SIGNAL
        | PoolActivitySkipReason.STALE_ACTIVITY_SIGNAL;
    }
  // The counts the prune would have produced, so a combo's floor can be set
  // from a measured share.
  | {
      status: 'skipped';
      reason: PoolActivitySkipReason.KEPT_SHARE_BELOW_FLOOR;
      kept: number;
      dropped: number;
      exempt: number;
      minKeptShare: number;
    };

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
  /** Per-combo floors below POOL_ACTIVITY_MIN_KEPT_SHARE, by `targetKey`. */
  minKeptShareByTarget: ReadonlyMap<string, number>;
  /**
   * Keys of POOL_CACHING_ACTIVITY_FILTER_MIN_KEPT_SHARE_BY_TARGET whose value
   * is not a share in (0, POOL_ACTIVITY_MIN_KEPT_SHARE]; those combos keep the
   * default floor.
   */
  invalidMinKeptShareKeys: string[];
  /** The override is not a JSON object; every combo keeps the default floor. */
  minKeptShareUnparseable: boolean;
}

/** The floor that applies to a combo: its override, else the default. */
export function minKeptShareFor(
  config: Pick<PoolActivityFilterConfig, 'minKeptShareByTarget'>,
  target: string
): number {
  return (
    config.minKeptShareByTarget.get(target) ?? POOL_ACTIVITY_MIN_KEPT_SHARE
  );
}

/**
 * JSON object of `chainId:protocol` to a kept-share floor, e.g.
 * '{"8453:V3":0.005}'. A value must be a finite share in
 * (0, POOL_ACTIVITY_MIN_KEPT_SHARE], so an override can only lower the floor.
 * A bad value, or a key outside AURORA_SUPPORTED_TARGETS, leaves that combo on
 * the default floor and is reported, rather than failing the cron: the
 * default is the safer value, since it keeps the full list more often.
 */
export function parseMinKeptShareByTarget(raw: string | undefined): {
  byTarget: ReadonlyMap<string, number>;
  invalidKeys: string[];
  unparseable: boolean;
} {
  const byTarget = new Map<string, number>();
  const invalidKeys: string[] = [];
  if (!raw || raw.trim() === '') {
    return {byTarget, invalidKeys, unparseable: false};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {byTarget, invalidKeys, unparseable: true};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {byTarget, invalidKeys, unparseable: true};
  }
  for (const [key, value] of Object.entries(parsed)) {
    const target = key.trim().toUpperCase();
    const share = typeof value === 'number' ? value : Number.NaN;
    if (
      AURORA_SUPPORTED_TARGETS.has(target) &&
      Number.isFinite(share) &&
      share > 0 &&
      share <= POOL_ACTIVITY_MIN_KEPT_SHARE
    ) {
      byTarget.set(target, share);
    } else {
      invalidKeys.push(key.trim());
    }
  }
  return {byTarget, invalidKeys, unparseable: false};
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
  const minKeptShare = parseMinKeptShareByTarget(
    process.env.POOL_CACHING_ACTIVITY_FILTER_MIN_KEPT_SHARE_BY_TARGET
  );
  const targets = new Set<string>();
  const ignoredEntries: string[] = [];
  for (const entry of raw ? raw.split(',') : []) {
    const target = entry.trim().toUpperCase();
    if (AURORA_SUPPORTED_TARGETS.has(target)) {
      targets.add(target);
    } else {
      ignoredEntries.push(entry.trim());
    }
  }
  return {
    targets,
    ignoredEntries,
    minKeptShareByTarget: minKeptShare.byTarget,
    invalidMinKeptShareKeys: minKeptShare.invalidKeys,
    minKeptShareUnparseable: minKeptShare.unparseable,
  };
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
 * for the whole window before its first swap. When the kept pools would be
 * fewer than `minKeptShare` of the list, the whole list is kept.
 */
export function filterPoolsByRecentActivity<T extends ActivityFilterPool>(
  pools: T[],
  exemptions: PoolActivityExemptions,
  nowMs: number,
  minKeptShare: number
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
  if (kept.length < pools.length * minKeptShare) {
    return {
      pools: pools.map(withoutActivityTimestamp),
      outcome: {
        status: 'skipped',
        reason: PoolActivitySkipReason.KEPT_SHARE_BELOW_FLOOR,
        kept: kept.length,
        dropped,
        exempt,
        minKeptShare,
      },
    };
  }
  return {
    pools: kept,
    outcome: {status: 'pruned', kept: kept.length, dropped, exempt},
  };
}
