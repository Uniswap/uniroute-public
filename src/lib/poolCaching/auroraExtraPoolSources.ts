/**
 * The extra pool sources cachePools layers on top of a combo's main read:
 * EulerSwap hook pools (V4), aggregator hook pools (V4) and the hand-picked
 * mainnet V3 pools. Each is a targeted Aurora read of a code-owned id list,
 * so unlike the main sources there is no TVL admission to replicate.
 *
 * A source has no second read behind it: on an error or an empty result the
 * sweep carries forward the source's last good pools (withExtraPoolSource),
 * and a served read is checked against what it is expected to cover.
 */

import {ADDRESS_ZERO, Protocol} from '@uniswap/router-sdk';
import {ChainId} from '@uniswap/sdk-core';
import {ethers} from 'ethers';
import type {Context} from '@uniswap/lib-uni/context';
import {toExtendedChainId} from '@uniswap/lib-data-api';
import type {
  RoutablePoolsService,
  V3RoutablePool,
  V4RoutablePool,
} from '@uniswap/lib-data-ingestion-aurora';

import type {V3SubgraphPool, V4SubgraphPool} from './sor-providers';
import {
  EthersPseudoTvlReader,
  type PseudoTvlReader,
} from './sor-providers/v4/pseudoTvlReader';
import {Logger} from './sor-providers/util/log';
import {IMetric, MetricLoggerUnit} from './sor-providers/util/metric';
import {
  EULER_SWAP_TVL_ETH,
  EULER_SWAP_TVL_USD,
  ExtraPoolSourceName,
  ExtraPoolSources,
  ExtraPoolsSource,
  MAINNET_V3_MANUAL_POOL_IDS,
  V4_EXTRA_POOL_SOURCE_MEMORY,
  extraSourceKey,
} from './extraPoolSources';
import type {RecentPoolIds} from './extraPoolSourceMemory';
import {EULER_SWAP_HOOKS_BY_CHAIN} from './util/eulerSwapHooksRegistry';
import type {AggHooksPoolSourceConfig} from './cacheConfig';

// --- Providers ---

export interface AuroraExtraSourceDeps {
  routablePools: Pick<
    RoutablePoolsService,
    'listV4RoutablePoolsByHooks' | 'listV3RoutablePoolsByAddresses'
  >;
  // USD price of the chain's wrapped-native token, fresh or throwing; turns
  // Aurora's USD TVL into the snapshot's tvlETH.
  nativeUsdPrice(ctx: Context, chainId: number): Promise<number>;
  newContext(): Context;
  logger: Logger;
  metric: IMetric;
  // The sweep's Aurora fetch slots; absent on scoped runs.
  fetchSlots?: {run<T>(work: () => Promise<T>): Promise<T>};
}

function withFetchSlot<T>(
  deps: AuroraExtraSourceDeps,
  work: () => Promise<T>
): Promise<T> {
  return deps.fetchSlots ? deps.fetchSlots.run(work) : work();
}

type DropReason = 'null_decimals' | 'pseudo_tvl_unavailable';

// Pools kept, but valued with less than the source has. `unpriced_side`
// counts each pseudo-TVL side holding a positive amount with no fresh USD
// price (valued at 0); `unpriced_pseudo_tvl` counts pools where every such
// side is unpriced, so the pool keeps its PoolManager values instead.
type DegradeReason = 'unpriced_side' | 'unpriced_pseudo_tvl';

function emitDegraded(
  deps: AuroraExtraSourceDeps,
  source: ExtraPoolSourceName,
  chainId: number,
  reason: DegradeReason,
  count: number
): void {
  if (count === 0) return;
  deps.metric.putMetric(
    'CachePools.aurora.extra_source_degraded',
    count,
    MetricLoggerUnit.Count,
    {source, chainId: String(chainId), reason}
  );
}

function emitDropped(
  deps: AuroraExtraSourceDeps,
  source: ExtraPoolSourceName,
  chainId: number,
  reason: DropReason,
  count: number
): void {
  if (count === 0) return;
  deps.metric.putMetric(
    'CachePools.aurora.extra_source_dropped',
    count,
    MetricLoggerUnit.Count,
    {source, chainId: String(chainId), reason}
  );
}

function v4PoolIdentity(
  row: V4RoutablePool,
  decimals0: number,
  decimals1: number
): Omit<V4SubgraphPool, 'liquidity' | 'tvlETH' | 'tvlUSD'> {
  return {
    id: row.poolId.toLowerCase(),
    feeTier: String(row.feeBips),
    tickSpacing: String(row.tickSpacing),
    hooks: (row.hooksAddress ?? ADDRESS_ZERO).toLowerCase(),
    token0: {
      id: row.token0Address.toLowerCase(),
      symbol: row.token0Symbol ?? undefined,
      name: row.token0Name ?? undefined,
      decimals: String(decimals0),
    },
    token1: {
      id: row.token1Address.toLowerCase(),
      symbol: row.token1Symbol ?? undefined,
      name: row.token1Name ?? undefined,
      decimals: String(decimals1),
    },
  };
}

// EulerSwap pools: identity from Aurora, the fixed EULER_SWAP_TVL_* values
// (their liquidity sits in Euler vaults). Liquidity is the PoolManager's.
export class AuroraEulerSwapPoolsProvider implements ExtraPoolsSource<V4SubgraphPool> {
  constructor(
    private readonly chainId: number,
    private readonly hooks: readonly string[],
    private readonly deps: AuroraExtraSourceDeps
  ) {}

  async getPools(): Promise<V4SubgraphPool[]> {
    const ctx = this.deps.newContext();
    const rows = await withFetchSlot(this.deps, () =>
      this.deps.routablePools.listV4RoutablePoolsByHooks(ctx, {
        chainId: toExtendedChainId(this.chainId),
        hooks: this.hooks,
      })
    );
    const pools: V4SubgraphPool[] = [];
    let droppedNullDecimals = 0;
    for (const row of rows) {
      if (row.token0Decimals === null || row.token1Decimals === null) {
        droppedNullDecimals++;
        continue;
      }
      pools.push({
        ...v4PoolIdentity(row, row.token0Decimals, row.token1Decimals),
        liquidity: row.liquidity,
        tvlUSD: EULER_SWAP_TVL_USD,
        tvlETH: EULER_SWAP_TVL_ETH,
      });
    }
    emitDropped(
      this.deps,
      ExtraPoolSourceName.EULER_HOOKS,
      this.chainId,
      'null_decimals',
      droppedNullDecimals
    );
    return pools;
  }
}

function rawToUnits(amount: bigint, decimals: number): number {
  return Number(ethers.utils.formatUnits(amount.toString(), decimals));
}

export interface AggHooksSpec {
  hookAddresses: readonly string[];
  pseudoTvl: PseudoTvlReader;
  // Keep only pools whose hook reports liquidity it holds externally (the
  // read succeeds and either amount is positive); Aurora carries no
  // isExternalLiquidity flag of its own.
  externalLiquidityOnly: boolean;
}

// Aggregator-hook pools: identity from Aurora, TVL from the hook's own
// pseudoTotalValueLocked valued at Aurora's fresh USD prices (a side without
// a fresh price contributes 0). `liquidity` carries floor(tvlUSD) so the
// pools pass the serving `liquidity > 0` filter; it is not used for slippage.
// When the hook reports amounts but none of them is priced, the pool keeps
// its PoolManager TVL and liquidity, as on a failed read: Aurora's prices
// have a freshness cutoff, so a stalled price feed would otherwise value
// every such pool at 0 and serving would drop it.
export class AuroraAggHooksPoolsProvider implements ExtraPoolsSource<V4SubgraphPool> {
  constructor(
    private readonly chainId: number,
    private readonly spec: AggHooksSpec,
    private readonly deps: AuroraExtraSourceDeps
  ) {}

  async getPools(): Promise<V4SubgraphPool[]> {
    const ctx = this.deps.newContext();
    const {nativePrice, rows} = await withFetchSlot(this.deps, async () => ({
      nativePrice: await this.deps.nativeUsdPrice(ctx, this.chainId),
      rows: await this.deps.routablePools.listV4RoutablePoolsByHooks(ctx, {
        chainId: toExtendedChainId(this.chainId),
        hooks: this.spec.hookAddresses,
      }),
    }));

    let droppedNullDecimals = 0;
    let droppedNoPseudoTvl = 0;
    let unpricedSides = 0;
    let unpricedPseudoTvl = 0;
    const tags = {chainId: String(this.chainId)};
    const pools = await Promise.all(
      rows.map(async (row): Promise<V4SubgraphPool | undefined> => {
        const decimals0 = row.token0Decimals;
        const decimals1 = row.token1Decimals;
        if (decimals0 === null || decimals1 === null) {
          droppedNullDecimals++;
          return undefined;
        }
        const identity = v4PoolIdentity(row, decimals0, decimals1);
        let amounts: {amount0: bigint; amount1: bigint} | undefined;
        try {
          amounts = await this.spec.pseudoTvl.read(identity.hooks, identity.id);
          this.deps.metric.putMetric(
            'CachePools.aurora.agg_hooks_pseudo_tvl',
            1,
            MetricLoggerUnit.Count,
            {...tags, status: 'success'}
          );
        } catch (err) {
          this.deps.metric.putMetric(
            'CachePools.aurora.agg_hooks_pseudo_tvl',
            1,
            MetricLoggerUnit.Count,
            {...tags, status: 'failure', reason: 'rpc_error'}
          );
          this.deps.logger.warn(
            `Aurora agg hooks pseudoTotalValueLocked failed for pool ${identity.id}: ${err instanceof Error ? err.name : typeof err}`
          );
        }

        const holdsExternalLiquidity =
          amounts !== undefined &&
          (amounts.amount0 > 0n || amounts.amount1 > 0n);
        if (this.spec.externalLiquidityOnly && !holdsExternalLiquidity) {
          droppedNoPseudoTvl++;
          return undefined;
        }
        const keepPoolManagerValues = (): V4SubgraphPool => ({
          ...identity,
          liquidity: row.liquidity,
          tvlUSD: row.tvlUsd,
          tvlETH: row.tvlUsd / nativePrice,
          isExternalLiquidity: this.spec.externalLiquidityOnly,
        });
        if (amounts === undefined) {
          // A failed read keeps the pool at the PoolManager's own TVL and
          // liquidity.
          return keepPoolManagerValues();
        }
        const sides = [
          {
            amount: amounts.amount0,
            decimals: decimals0,
            price: row.token0PriceUsd,
          },
          {
            amount: amounts.amount1,
            decimals: decimals1,
            price: row.token1PriceUsd,
          },
        ];
        const heldSides = sides.filter(side => side.amount > 0n);
        const unpricedHeldSides = heldSides.filter(
          side => side.price === null
        ).length;
        unpricedSides += unpricedHeldSides;
        if (heldSides.length > 0 && unpricedHeldSides === heldSides.length) {
          unpricedPseudoTvl++;
          return keepPoolManagerValues();
        }
        const tvlUsd = sides.reduce(
          (sum, side) =>
            sum + rawToUnits(side.amount, side.decimals) * (side.price ?? 0),
          0
        );
        return {
          ...identity,
          liquidity: Math.floor(tvlUsd).toString(),
          tvlUSD: tvlUsd,
          tvlETH: tvlUsd / nativePrice,
          isExternalLiquidity: this.spec.externalLiquidityOnly,
        };
      })
    );
    emitDropped(
      this.deps,
      ExtraPoolSourceName.AGG_HOOKS,
      this.chainId,
      'null_decimals',
      droppedNullDecimals
    );
    emitDropped(
      this.deps,
      ExtraPoolSourceName.AGG_HOOKS,
      this.chainId,
      'pseudo_tvl_unavailable',
      droppedNoPseudoTvl
    );
    emitDegraded(
      this.deps,
      ExtraPoolSourceName.AGG_HOOKS,
      this.chainId,
      'unpriced_side',
      unpricedSides
    );
    emitDegraded(
      this.deps,
      ExtraPoolSourceName.AGG_HOOKS,
      this.chainId,
      'unpriced_pseudo_tvl',
      unpricedPseudoTvl
    );
    return pools.filter((pool): pool is V4SubgraphPool => pool !== undefined);
  }
}

// Hand-picked V3 pools by address, valued like the main Aurora V3 source:
// the fresh-priced sides only.
export class AuroraV3PoolIdsProvider implements ExtraPoolsSource<V3SubgraphPool> {
  constructor(
    private readonly chainId: number,
    private readonly poolIds: readonly string[],
    private readonly deps: AuroraExtraSourceDeps
  ) {}

  async getPools(): Promise<V3SubgraphPool[]> {
    const ctx = this.deps.newContext();
    const {nativePrice, rows} = await withFetchSlot(this.deps, async () => ({
      nativePrice: await this.deps.nativeUsdPrice(ctx, this.chainId),
      rows: await this.deps.routablePools.listV3RoutablePoolsByAddresses(ctx, {
        chainId: toExtendedChainId(this.chainId),
        poolAddresses: this.poolIds,
      }),
    }));
    return rows.map((row: V3RoutablePool) => ({
      id: row.poolAddress.toLowerCase(),
      feeTier: String(row.feeTier),
      liquidity: row.liquidity,
      token0: {id: row.token0Address.toLowerCase()},
      token1: {id: row.token1Address.toLowerCase()},
      tvlUSD: row.tvlUsd,
      tvlETH: row.tvlUsd / nativePrice,
    }));
  }
}

// --- Guarded source ---

// Missing keys logged per coverage check: enough to classify a gap, small
// enough to keep the warn line bounded.
const MISSING_IDS_LOG_LIMIT = 50;

type ExtraSourceFailureReason = 'error' | 'empty';

// What a read is expected to cover. A key with no served pool is missing;
// the read is still served (a partial result beats the carry-forward), but
// it is counted.
// - expected_keys: a fixed list, one key per expected pool or hook (EulerSwap
//   registry hooks map one-to-one to pools; the V3 manual ids are the pools).
// - recent_pool_ids: the pool ids a good read of this source served within
//   the last-good window (AggHooks, where a hook has any number of pools,
//   including none). Empty after a restart, so the first read reports full
//   coverage.
export type ExtraPoolsCoverage<TPool> =
  | {
      kind: 'expected_keys';
      expectedKeys: readonly string[];
      coverageKey(pool: TPool): string;
      warnOnMissing: boolean;
    }
  | {kind: 'recent_pool_ids'; recent: RecentPoolIds; warnOnMissing: boolean};

export class AuroraSourcedExtraPoolsProvider<
  TPool extends {id: string; tvlUSD: number},
> implements ExtraPoolsSource<TPool> {
  constructor(
    private readonly source: ExtraPoolSourceName,
    private readonly chainId: number,
    private readonly aurora: ExtraPoolsSource<TPool>,
    private readonly logger: Logger,
    private readonly metric: IMetric,
    private readonly coverage?: ExtraPoolsCoverage<TPool>,
    private readonly nowMs: () => number = Date.now
  ) {}

  private get tags(): Record<string, string> {
    return {source: this.source, chainId: String(this.chainId)};
  }

  private emit(
    status: 'success' | 'failure',
    reason?: ExtraSourceFailureReason
  ): void {
    this.metric.putMetric(
      'CachePools.aurora.extra_source',
      1,
      MetricLoggerUnit.Count,
      reason ? {...this.tags, status, reason} : {...this.tags, status}
    );
  }

  // withExtraPoolSource turns a throw or an empty result into a carry-forward
  // of the source's last good pools.
  async getPools(): Promise<TPool[]> {
    let pools: TPool[];
    try {
      pools = await this.aurora.getPools();
    } catch (err) {
      this.emit('failure', 'error');
      this.logger.warn(
        `Aurora extra pool source ${extraSourceKey(this.source, this.chainId)} failed: ${err instanceof Error ? err.name : typeof err}`
      );
      throw err;
    }
    if (pools.length === 0) {
      this.emit('failure', 'empty');
      return pools;
    }
    this.emit('success');
    this.reportCoverage(pools);
    return pools;
  }

  // A partial Aurora result is served, so this is the only signal that it is
  // partial.
  private reportCoverage(pools: TPool[]): void {
    const coverage = this.coverage;
    if (!coverage) return;
    const expected =
      coverage.kind === 'expected_keys'
        ? new Set(coverage.expectedKeys.map(key => key.toLowerCase()))
        : coverage.recent.recentIds(
            extraSourceKey(this.source, this.chainId),
            this.nowMs()
          );
    const covered = new Set(
      pools.map(pool =>
        (coverage.kind === 'expected_keys'
          ? coverage.coverageKey(pool)
          : pool.id
        ).toLowerCase()
      )
    );
    const missing = [...expected].filter(key => !covered.has(key));
    const counts: Array<[string, number]> = [
      ['served', pools.length],
      ['expected', expected.size],
      ['missing', missing.length],
    ];
    for (const [name, value] of counts) {
      this.metric.putMetric(
        `CachePools.aurora.extra_source_coverage.${name}`,
        value,
        MetricLoggerUnit.Count,
        this.tags
      );
    }
    this.metric.putMetric(
      'CachePools.aurora.extra_source_coverage_check',
      1,
      MetricLoggerUnit.Count,
      missing.length === 0
        ? {...this.tags, status: 'success'}
        : {...this.tags, status: 'failure', reason: 'missing_expected'}
    );
    if (missing.length > 0 && coverage.warnOnMissing) {
      this.logger.warn(
        `Aurora extra pool source incomplete ${extraSourceKey(this.source, this.chainId)}: missing=${missing.length} of ${expected.size}`,
        {missingKeys: missing.slice(0, MISSING_IDS_LOG_LIMIT)}
      );
    }
  }
}

// --- Wiring ---

export interface ExtraSourceChainProtocol {
  protocol: Protocol;
  chainId: number;
  aggHooks?: AggHooksPoolSourceConfig;
  extraPoolSources?: ExtraPoolSources;
}

// Installs extraPoolSources on every combo that has one: EulerSwap hooks on
// the V4 combos of the chains in EULER_SWAP_HOOKS_BY_CHAIN, aggregator hooks
// on the V4 combos with an aggHooks config, and the manual pools on mainnet
// V3.
export function applyAuroraExtraPoolSources(
  chainProtocols: ExtraSourceChainProtocol[],
  deps: AuroraExtraSourceDeps,
  logger: Logger,
  metric: IMetric
): void {
  for (const chainProtocol of chainProtocols) {
    const {chainId, protocol} = chainProtocol;
    const sources: ExtraPoolSources = {...chainProtocol.extraPoolSources};

    const eulerHooks = EULER_SWAP_HOOKS_BY_CHAIN.get(chainId);
    if (protocol === Protocol.V4 && eulerHooks) {
      sources.euler = new AuroraSourcedExtraPoolsProvider(
        ExtraPoolSourceName.EULER_HOOKS,
        chainId,
        new AuroraEulerSwapPoolsProvider(chainId, eulerHooks, deps),
        logger,
        metric,
        // One pool per registry hook.
        {
          kind: 'expected_keys',
          expectedKeys: eulerHooks,
          coverageKey: pool => pool.hooks,
          warnOnMissing: true,
        }
      );
    }

    const aggHooks = chainProtocol.aggHooks;
    if (protocol === Protocol.V4 && aggHooks) {
      sources.aggHooks = new AuroraSourcedExtraPoolsProvider(
        ExtraPoolSourceName.AGG_HOOKS,
        chainId,
        new AuroraAggHooksPoolsProvider(
          chainId,
          {
            hookAddresses: aggHooks.hookAddresses,
            pseudoTvl: new EthersPseudoTvlReader(aggHooks.ethersProvider),
            externalLiquidityOnly: aggHooks.useExternalLiquidity,
          },
          deps
        ),
        logger,
        metric,
        // Keyed by pool id against recent good reads: a hook can have any
        // number of pools, so per-hook keys miss a partial loss (Tempo: 1
        // hook, 5 pools) and fail forever on an empty hook.
        {
          kind: 'recent_pool_ids',
          recent: V4_EXTRA_POOL_SOURCE_MEMORY,
          warnOnMissing: true,
        }
      );
    }

    if (protocol === Protocol.V3 && chainId === ChainId.MAINNET) {
      sources.v3Manual = new AuroraSourcedExtraPoolsProvider(
        ExtraPoolSourceName.V3_MAINNET_MANUAL,
        chainId,
        new AuroraV3PoolIdsProvider(chainId, MAINNET_V3_MANUAL_POOL_IDS, deps),
        logger,
        metric,
        {
          kind: 'expected_keys',
          expectedKeys: MAINNET_V3_MANUAL_POOL_IDS,
          coverageKey: pool => pool.id,
          warnOnMissing: true,
        }
      );
    }

    if (sources.euler || sources.aggHooks || sources.v3Manual) {
      chainProtocol.extraPoolSources = sources;
    }
  }
}
