// Process-local memory of each extra pool source's last good result, keyed by
// `<source>:<chainId>`. The cron worker is a long-lived ECS task, so this
// survives across sweeps; a restart starts empty, and the first failing sweep
// after one writes the snapshot without that source's pools.
//
// One sweep runs every 20 minutes, so a 6h window rides out 18 failed sweeps
// (an Aurora incident, a stale wrapped-native price, an RPC outage) before the
// source's pools leave the snapshot. Serving re-reads pool state on chain at
// quote time, so a carried-forward pool's snapshot values only feed ranking.
export const EXTRA_POOL_SOURCE_LAST_GOOD_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export interface RecentPoolIds {
  // Ids served by a good read within the max age, lowercased.
  recentIds(key: string, nowMs: number): ReadonlySet<string>;
}

interface LastGood<TPool> {
  pools: readonly TPool[];
  atMs: number;
}

export class ExtraPoolSourceMemory<TPool extends {id: string}>
  implements RecentPoolIds
{
  private readonly lastGoodByKey = new Map<string, LastGood<TPool>>();
  private readonly idSeenAtByKey = new Map<string, Map<string, number>>();

  constructor(
    private readonly maxAgeMs: number = EXTRA_POOL_SOURCE_LAST_GOOD_MAX_AGE_MS
  ) {}

  recordGood(key: string, pools: readonly TPool[], nowMs: number): void {
    this.lastGoodByKey.set(key, {pools, atMs: nowMs});
    let seenAt = this.idSeenAtByKey.get(key);
    if (!seenAt) {
      seenAt = new Map();
      this.idSeenAtByKey.set(key, seenAt);
    }
    for (const pool of pools) seenAt.set(pool.id.toLowerCase(), nowMs);
    for (const [id, atMs] of seenAt) {
      if (nowMs - atMs > this.maxAgeMs) seenAt.delete(id);
    }
  }

  // The last good pools while they are within the max age, with their age.
  lastGood(
    key: string,
    nowMs: number
  ): {pools: readonly TPool[]; ageMs: number} | 'expired' | undefined {
    const entry = this.lastGoodByKey.get(key);
    if (!entry) return undefined;
    const ageMs = nowMs - entry.atMs;
    return ageMs > this.maxAgeMs ? 'expired' : {pools: entry.pools, ageMs};
  }

  recentIds(key: string, nowMs: number): ReadonlySet<string> {
    const seenAt = this.idSeenAtByKey.get(key);
    const ids = new Set<string>();
    if (!seenAt) return ids;
    for (const [id, atMs] of seenAt) {
      if (nowMs - atMs <= this.maxAgeMs) ids.add(id);
    }
    return ids;
  }

  clear(): void {
    this.lastGoodByKey.clear();
    this.idSeenAtByKey.clear();
  }
}
