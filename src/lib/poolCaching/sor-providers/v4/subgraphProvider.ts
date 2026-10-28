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
   * Epoch ms of the pool's last state change (swap, liquidity change, V2
   * Sync, or creation), from Aurora pool state. Set only on combos in
   * POOL_CACHING_ACTIVITY_FILTER_TARGETS; the cron's activity filter reads it
   * and strips it before the snapshot is written.
   */
  lastStateChangeAtMs?: number;
}
