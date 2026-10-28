/**
 * The pool-source seam of the pool-caching cron. Every chain x protocol combo
 * reads its pools through one of these and the snapshot written to S3 is the
 * returned array as is, so the pool shapes (v2/, v3/, v4/) are the ones the
 * routing path's S3 discoverers parse. They keep the names of the
 * smart-order-router subgraph providers they were ported from; the Aurora
 * pool source (../auroraPoolsSource.ts) is what produces them.
 */

export interface ISubgraphProvider<TSubgraphPool> {
  getPools(): Promise<TSubgraphPool[]>;
}

// V4 pools with a tracked TVL at or below this (native units) are left out of
// the snapshot; the Aurora V4 source applies it inside its admission union.
export const V4_MIN_TVL_ETH = 0.001;
