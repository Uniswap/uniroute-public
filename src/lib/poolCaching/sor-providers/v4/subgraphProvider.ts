/**
 * V4 pool shape of the pool-caching snapshot, ported from
 * @uniswap/smart-order-router/src/providers/v4/subgraph-provider.ts.
 */

export interface V4SubgraphPool {
  id: string; // v4 pool id is the internal PoolId from pool manager
  feeTier: string;
  tickSpacing: string;
  hooks: string;
  liquidity: string;
  token0: {
    symbol?: string;
    id: string;
    name?: string;
    decimals: string;
  };
  token1: {
    symbol?: string;
    id: string;
    name?: string;
    decimals: string;
  };
  tvlETH: number;
  tvlUSD: number;
  isExternalLiquidity?: boolean;
  /**
   * Epoch ms of the pool's Aurora pool state (`state_as_of_timestamp`): the
   * time data-ingestion read the state after a swap, liquidity change or
   * creation, so it trails the event. A state backfill rewrites it with the
   * pool's last transaction time, which can be earlier. Set only on combos in
   * POOL_CACHING_ACTIVITY_FILTER_TARGETS; the cron's activity filter reads it
   * and strips it before the snapshot is written.
   */
  lastStateChangeAtMs?: number;
}
