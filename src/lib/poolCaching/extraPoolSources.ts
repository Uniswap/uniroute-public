import type {
  IEulerSwapHooksSubgraphProvider,
  V3SubgraphPool,
  V4SubgraphPool,
} from './sor-providers';
import {Logger} from './sor-providers/util/log';
import {IMetric, MetricLoggerUnit} from './sor-providers/util/metric';
import {ExtraPoolSourceMemory} from './extraPoolSourceMemory';

// The extra pool sources layered on top of a combo's main `getPools()`
// result; the values are the `source` tag of `CachePools.extraPoolSource` and
// the source half of a `POOL_CACHING_AURORA_EXTRA_SOURCE_*_TARGETS` key.
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

// Installed by applyAuroraPoolSources for combos whose extra source is an
// Aurora target: each wraps the subgraph source cachePools builds, so the
// subgraph read stays the shadow comparison and the primary fallback.
export interface ExtraPoolSourceOverrides {
  euler?: (
    subgraph: ExtraPoolsSource<V4SubgraphPool>
  ) => ExtraPoolsSource<V4SubgraphPool>;
  aggHooks?: (
    subgraph: ExtraPoolsSource<V4SubgraphPool>
  ) => ExtraPoolsSource<V4SubgraphPool>;
  v3Manual?: (
    subgraph: ExtraPoolsSource<V3SubgraphPool>
  ) => ExtraPoolsSource<V3SubgraphPool>;
}

// EulerSwap pools hold their liquidity in Euler vaults, so the V4 subgraph
// reports 0 TVL for them. These fixed values let them pass every TVL filter
// on the way into the snapshot, from either source.
export const EULER_SWAP_TVL_USD = 1000;
export const EULER_SWAP_TVL_ETH = 5_500_000;

// Hand-picked mainnet V3 pools read on top of the chain's main V3 set, by
// both the subgraph and the Aurora source. wstETH/USDC: its subgraph
// totalValueLockedUSDUntracked is 0.
export const MAINNET_V3_MANUAL_POOL_IDS: readonly string[] = [
  '0x4622df6fb2d9bee0dcdacf545acdb6a2b2f4f863',
];

export class SubgraphEulerSwapPoolsSource
  implements ExtraPoolsSource<V4SubgraphPool>
{
  constructor(
    private readonly hooksProvider: IEulerSwapHooksSubgraphProvider,
    private readonly logger: Logger,
    private readonly metric: IMetric,
    private readonly metricTags: Record<string, string>
  ) {}

  async getPools(): Promise<V4SubgraphPool[]> {
    const eulerHooks = await this.hooksProvider.getHooks();
    if (!eulerHooks) {
      return [];
    }
    this.metric.putMetric(
      'eulerHooks.length',
      eulerHooks.length,
      MetricLoggerUnit.Count,
      this.metricTags
    );
    const hookPools = await Promise.all(
      eulerHooks.map(async eulerHook => {
        const pool = await this.hooksProvider.getPoolByHook(eulerHook.hook);
        this.logger.info(`eulerHooks pool ${JSON.stringify(pool)}`);
        if (pool) {
          pool.tvlUSD = EULER_SWAP_TVL_USD;
          pool.tvlETH = EULER_SWAP_TVL_ETH;
        }
        return pool;
      })
    );
    return hookPools.filter(
      (pool): pool is V4SubgraphPool => pool !== null && pool !== undefined
    );
  }
}
