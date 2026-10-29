/**
 * V2 pool shape of the pool-caching snapshot, ported from
 * @uniswap/smart-order-router/src/providers/v2/subgraph-provider.ts.
 */

export interface V2SubgraphPool {
  id: string;
  token0: {
    id: string;
  };
  token1: {
    id: string;
  };
  supply: number;
  reserve: number;
  reserveUSD: number;
  /**
   * Epoch ms of the pair's Aurora pool state (`state_as_of_timestamp`),
   * which data-ingestion moves on each Sync (every swap and liquidity change)
   * and on creation. Set only on combos in
   * POOL_CACHING_ACTIVITY_FILTER_TARGETS; the cron's activity filter reads it
   * and strips it before the snapshot is written.
   */
  lastStateChangeAtMs?: number;
}
