/**
 * V3 pool shape of the pool-caching snapshot, ported from
 * @uniswap/smart-order-router/src/providers/v3/subgraph-provider.ts.
 */

export interface V3SubgraphPool {
  id: string;
  feeTier: string;
  liquidity: string;
  token0: {
    id: string;
  };
  token1: {
    id: string;
  };
  tvlETH: number;
  tvlUSD: number;
  /**
   * Epoch ms of the pool's Aurora pool state (`state_as_of_timestamp`),
   * which data-ingestion moves on each swap, liquidity change and creation.
   * Set only on combos in POOL_CACHING_ACTIVITY_FILTER_TARGETS; the cron's
   * activity filter reads it and strips it before the snapshot is written.
   */
  lastStateChangeAtMs?: number;
}
