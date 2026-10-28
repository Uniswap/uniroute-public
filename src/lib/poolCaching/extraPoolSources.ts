import type {V3SubgraphPool, V4SubgraphPool} from './sor-providers';
import {ExtraPoolSourceMemory} from './extraPoolSourceMemory';

// The extra pool sources layered on top of a combo's main `getPools()`
// result; the values are the `source` tag of `CachePools.extraPoolSource`.
export const ExtraPoolSourceName = {
  EULER_HOOKS: 'euler_hooks',
  AGG_HOOKS: 'agg_hooks',
  V3_MAINNET_MANUAL: 'v3_mainnet_manual',
} as const;
export type ExtraPoolSourceName =
  (typeof ExtraPoolSourceName)[keyof typeof ExtraPoolSourceName];

export function extraSourceKey(
  source: ExtraPoolSourceName,
  chainId: number
): string {
  return `${source}:${chainId}`;
}

// The process-wide last-good results behind withExtraPoolSource's
// carry-forward and the AggHooks coverage check, one per pool shape.
export const V4_EXTRA_POOL_SOURCE_MEMORY =
  new ExtraPoolSourceMemory<V4SubgraphPool>();
export const V3_EXTRA_POOL_SOURCE_MEMORY =
  new ExtraPoolSourceMemory<V3SubgraphPool>();

export function resetExtraPoolSourceMemoryForTesting(): void {
  V4_EXTRA_POOL_SOURCE_MEMORY.clear();
  V3_EXTRA_POOL_SOURCE_MEMORY.clear();
}

export interface ExtraPoolsSource<TPool> {
  getPools(): Promise<TPool[]>;
}

// Installed on a combo by applyAuroraExtraPoolSources: the Aurora reads
// cachePools adds to the combo's main pool set. A combo without a source for
// a name has no such pools to add.
export interface ExtraPoolSources {
  euler?: ExtraPoolsSource<V4SubgraphPool>;
  aggHooks?: ExtraPoolsSource<V4SubgraphPool>;
  v3Manual?: ExtraPoolsSource<V3SubgraphPool>;
}

// EulerSwap pools hold their liquidity in Euler vaults, so the PoolManager
// reports 0 TVL for them. These fixed values let them pass every TVL filter
// on the way into the snapshot.
export const EULER_SWAP_TVL_USD = 1000;
export const EULER_SWAP_TVL_ETH = 5_500_000;

// Hand-picked mainnet V3 pools read on top of the chain's main V3 set.
// wstETH/USDC: its untracked TVL is 0, so the main admission drops it.
export const MAINNET_V3_MANUAL_POOL_IDS: readonly string[] = [
  '0x4622df6fb2d9bee0dcdacf545acdb6a2b2f4f863',
];
