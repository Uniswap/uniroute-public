/**
 * Aurora replacements for the extra pool sources cachePools layers on top of
 * a combo's main read (ROUTE-1839): EulerSwap hook pools (V4), aggregator
 * hook pools (V4) and the hand-picked mainnet V3 pools. Each is a targeted
 * read of a code-owned id list, so unlike the main sources there is no TVL
 * admission to replicate: the Aurora read must return the same pools the
 * subgraph does.
 *
 * Rollout mirrors the main sources: per `<source>:<chainId>` key, shadow
 * serves the subgraph and compares pool-id sets in the background; primary
 * serves Aurora only, and on an error or an empty result the sweep carries
 * forward the source's last good pools. Targets come from POOL_CACHING_AURORA_EXTRA_SOURCE_SHADOW_TARGETS
 * (`*` allowed) and POOL_CACHING_AURORA_EXTRA_SOURCE_PRIMARY_TARGETS (`*`
 * rejected: every primary key is listed explicitly). They take effect only
 * where the main POOL_CACHING_AURORA_{SHADOW,PRIMARY}_TARGETS are set, since
 * applyAuroraPoolSources only opens the Aurora connection then; extra targets
 * set without them are reported (CachePools.aurora.extra_source_inert).
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

import type {
  AggHooksSubgraphProvider,
  V3SubgraphPool,
  V4SubgraphPool,
} from './sor-providers';
import {
  EthersPseudoTvlReader,
  type PseudoTvlReader,
  shadowPseudoTvlLimit,
} from './sor-providers/v4/pseudoTvlReader';
import {Logger} from './sor-providers/util/log';
import {IMetric, MetricLoggerUnit} from './sor-providers/util/metric';
import {
  EULER_SWAP_TVL_ETH,
  EULER_SWAP_TVL_USD,
  ExtraPoolSourceName,
  ExtraPoolSourceOverrides,
  ExtraPoolsSource,
  MAINNET_V3_MANUAL_POOL_IDS,
  V4_EXTRA_POOL_SOURCE_MEMORY,
  extraSourceKey,
} from './extraPoolSources';
import type {RecentPoolIds} from './extraPoolSourceMemory';
import {EULER_SWAP_HOOKS_BY_CHAIN} from './util/eulerSwapHooksRegistry';

export type AuroraExtraSourceMode = 'shadow' | 'primary';

// --- Config ---

export type ExtraSourceConfigRejection = 'primary_wildcard' | 'invalid_entry';

export interface AuroraExtraSourceConfig {
  // 'all' (env value "*") or a set of `<source>:<chainId>` keys.
  shadowTargets: 'all' | ReadonlySet<string>;
  primaryTargets: ReadonlySet<string>;
  rejections: ReadonlySet<ExtraSourceConfigRejection>;
}

const EXTRA_SOURCE_NAMES: ReadonlySet<string> = new Set(
  Object.values(ExtraPoolSourceName)
);

function parseExtraSourceTargets(
  raw: string | undefined,
  rejections: Set<ExtraSourceConfigRejection>
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const entry of (raw ?? '').split(',')) {
    const trimmed = entry.trim().toLowerCase();
    if (trimmed === '') continue;
    const [source, chainId, ...rest] = trimmed.split(':');
    if (
      rest.length > 0 ||
      source === undefined ||
      chainId === undefined ||
      !EXTRA_SOURCE_NAMES.has(source) ||
      !/^[1-9][0-9]*$/.test(chainId)
    ) {
      rejections.add('invalid_entry');
      continue;
    }
    keys.add(`${source}:${chainId}`);
  }
  return keys;
}

export function auroraExtraSourceConfigFromEnv(): AuroraExtraSourceConfig {
  const rejections = new Set<ExtraSourceConfigRejection>();
  const shadowRaw = process.env.POOL_CACHING_AURORA_EXTRA_SOURCE_SHADOW_TARGETS;
  const primaryRaw =
    process.env.POOL_CACHING_AURORA_EXTRA_SOURCE_PRIMARY_TARGETS;
  const shadowTargets =
    shadowRaw?.trim() === '*'
      ? 'all'
      : parseExtraSourceTargets(shadowRaw, rejections);
  // A wildcard would flip every extra source on every chain to Aurora at once;
  // primary keys are listed one by one after their shadow soak.
  const primaryWithoutWildcard = (primaryRaw ?? '')
    .split(',')
    .filter(entry => {
      if (entry.trim() !== '*') return true;
      rejections.add('primary_wildcard');
      return false;
    })
    .join(',');
  return {
    shadowTargets,
    primaryTargets: parseExtraSourceTargets(primaryWithoutWildcard, rejections),
    rejections,
  };
}

// The extra sources only run where the main Aurora targets are set (that is
// when applyAuroraPoolSources opens the connection). Called when they are not:
// extra targets set on their own would otherwise do nothing without a trace.
export function reportInertExtraSourceTargets(
  logger: Logger,
  metric: IMetric
): void {
  const hasExtraTargets = [
    process.env.POOL_CACHING_AURORA_EXTRA_SOURCE_SHADOW_TARGETS,
    process.env.POOL_CACHING_AURORA_EXTRA_SOURCE_PRIMARY_TARGETS,
  ].some(raw => (raw ?? '').trim() !== '');
  if (!hasExtraTargets) return;
  metric.putMetric(
    'CachePools.aurora.extra_source_inert',
    1,
    MetricLoggerUnit.Count,
    {reason: 'main_targets_unset'}
  );
  logger.warn(
    'Aurora extra pool source targets are set but POOL_CACHING_AURORA_{SHADOW,PRIMARY}_TARGETS are not — extra sources stay on the subgraph'
  );
}

export function resolveExtraSourceMode(
  config: AuroraExtraSourceConfig,
  source: ExtraPoolSourceName,
  chainId: number
): AuroraExtraSourceMode | undefined {
  const key = extraSourceKey(source, chainId);
  // primary wins when a key is (mis)listed in both.
  if (config.primaryTargets.has(key)) return 'primary';
  if (config.shadowTargets === 'all' || config.shadowTargets.has(key)) {
    return 'shadow';
  }
  return undefined;
}

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

// EulerSwap pools: identity from Aurora, the same fixed TVL the subgraph
// source assigns. Liquidity is the PoolManager's, as the subgraph reports it.
export class AuroraEulerSwapPoolsProvider
  implements ExtraPoolsSource<V4SubgraphPool>
{
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
  // read succeeds and either amount is positive). Replaces the subgraph's
  // isExternalLiquidity flag, which Aurora does not carry.
  externalLiquidityOnly: boolean;
}

// Aggregator-hook pools: identity from Aurora, TVL from the hook's own
// pseudoTotalValueLocked valued at Aurora's fresh USD prices (a side without
// a fresh price contributes 0). `liquidity` carries floor(tvlUSD) so the
// pools pass the serving `liquidity > 0` filter; it is not used for slippage.
// When the hook reports amounts but none of them is priced, the pool keeps
// its PoolManager TVL and liquidity, as on a failed read: the subgraph path
// prices through derivedETH, which it almost always has, while Aurora's
// prices have a freshness cutoff, so a stalled price feed would otherwise
// value every such pool at 0 and serving would drop it.
export class AuroraAggHooksPoolsProvider
  implements ExtraPoolsSource<V4SubgraphPool>
{
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
          // Same as the subgraph source on a failed read: keep the pool at the
          // PoolManager's own TVL and liquidity.
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
export class AuroraV3PoolIdsProvider
  implements ExtraPoolsSource<V3SubgraphPool>
{
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

// --- Shadow / primary wrapper ---

const pendingExtraShadowByKey = new Map<string, Promise<void>>();

export async function settlePendingAuroraExtraShadowsForTesting(): Promise<void> {
  await Promise.all([...pendingExtraShadowByKey.values()]);
}

// Missing ids logged per shadow comparison: enough to classify a gap, small
// enough to keep the warn line bounded.
const MISSING_IDS_LOG_LIMIT = 50;

// A pool both sources return counts as a TVL mismatch when its Aurora tvlUSD
// is outside this band around the subgraph's, or exactly one side is 0. The
// band is wide on purpose: the two price sources differ, and the check exists
// to catch decimals or pricing errors (orders of magnitude), not drift.
const TVL_PARITY_MIN_RATIO = 0.5;
const TVL_PARITY_MAX_RATIO = 2;
const TVL_MISMATCH_LOG_LIMIT = 10;

type ExtraSourceFailureReason = 'error' | 'empty' | 'previous_pending';

// What a primary read is expected to cover. A key with no served pool is
// missing; the read is still served (a partial result beats the fallback,
// which is the subgraph and fails after the shutoff), but it is counted.
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

interface TvlMismatch {
  id: string;
  subgraphTvlUsd: number;
  auroraTvlUsd: number;
}

function isTvlMismatch(subgraphTvlUsd: number, auroraTvlUsd: number): boolean {
  if (subgraphTvlUsd === 0 || auroraTvlUsd === 0) {
    return subgraphTvlUsd !== auroraTvlUsd;
  }
  const ratio = auroraTvlUsd / subgraphTvlUsd;
  return ratio < TVL_PARITY_MIN_RATIO || ratio > TVL_PARITY_MAX_RATIO;
}

// Larger is worse; a one-sided zero ranks above any finite ratio.
function tvlMismatchSeverity({
  subgraphTvlUsd,
  auroraTvlUsd,
}: TvlMismatch): number {
  if (subgraphTvlUsd === 0 || auroraTvlUsd === 0) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.abs(Math.log(auroraTvlUsd / subgraphTvlUsd));
}

export class AuroraSourcedExtraPoolsProvider<
  TPool extends {id: string; tvlUSD: number},
> implements ExtraPoolsSource<TPool>
{
  constructor(
    private readonly mode: AuroraExtraSourceMode,
    private readonly source: ExtraPoolSourceName,
    private readonly chainId: number,
    private readonly aurora: ExtraPoolsSource<TPool>,
    private readonly subgraph: ExtraPoolsSource<TPool>,
    private readonly logger: Logger,
    private readonly metric: IMetric,
    private readonly coverage?: ExtraPoolsCoverage<TPool>,
    private readonly nowMs: () => number = Date.now
  ) {}

  private get tags(): Record<string, string> {
    return {
      source: this.source,
      chainId: String(this.chainId),
      mode: this.mode,
    };
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

  /** True when this source serves Aurora with no subgraph read behind it. */
  get isAuroraPrimary(): boolean {
    return this.mode === 'primary';
  }

  getPools(): Promise<TPool[]> {
    return this.mode === 'primary' ? this.getPoolsPrimary() : this.getShadow();
  }

  // Primary has no second source. withExtraPoolSource turns a throw or an
  // empty result into a carry-forward of the source's last good pools.
  private async getPoolsPrimary(): Promise<TPool[]> {
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

  // Primary only: a partial Aurora result is served, so this is the only
  // signal that it is partial once the subgraph comparison is gone.
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

  // Resolves with the subgraph result; the comparison settles in the
  // background so a slow Aurora read never delays the snapshot write.
  private getShadow(): Promise<TPool[]> {
    const key = extraSourceKey(this.source, this.chainId);
    const subgraphPromise = this.subgraph.getPools();
    if (pendingExtraShadowByKey.has(key)) {
      this.emit('failure', 'previous_pending');
      return subgraphPromise;
    }
    const comparison = this.compareShadow(
      subgraphPromise,
      this.aurora.getPools()
    );
    pendingExtraShadowByKey.set(key, comparison);
    void comparison.finally(() => pendingExtraShadowByKey.delete(key));
    return subgraphPromise;
  }

  // Never rejects: a subgraph failure is the caller's to report, and an
  // Aurora failure is counted here.
  private async compareShadow(
    subgraphPromise: Promise<TPool[]>,
    auroraPromise: Promise<TPool[]>
  ): Promise<void> {
    const [subgraphResult, auroraResult] = await Promise.allSettled([
      subgraphPromise,
      auroraPromise,
    ]);
    if (auroraResult.status === 'rejected') {
      this.emit('failure', 'error');
      this.logger.warn(
        `Aurora extra pool source shadow ${extraSourceKey(this.source, this.chainId)} failed: ${auroraResult.reason instanceof Error ? auroraResult.reason.name : typeof auroraResult.reason}`
      );
      return;
    }
    this.emit('success');
    if (subgraphResult.status === 'rejected') return;

    const subgraphTvlById = new Map(
      subgraphResult.value.map(pool => [pool.id.toLowerCase(), pool.tvlUSD])
    );
    const auroraTvlById = new Map(
      auroraResult.value.map(pool => [pool.id.toLowerCase(), pool.tvlUSD])
    );
    const missing = [...subgraphTvlById.keys()].filter(
      id => !auroraTvlById.has(id)
    );
    const extra = [...auroraTvlById.keys()].filter(
      id => !subgraphTvlById.has(id)
    );
    const tvlMismatches: TvlMismatch[] = [];
    for (const [id, subgraphTvlUsd] of subgraphTvlById) {
      const auroraTvlUsd = auroraTvlById.get(id);
      if (
        auroraTvlUsd !== undefined &&
        isTvlMismatch(subgraphTvlUsd, auroraTvlUsd)
      ) {
        tvlMismatches.push({id, subgraphTvlUsd, auroraTvlUsd});
      }
    }
    const tags = {source: this.source, chainId: String(this.chainId)};
    const counts: Array<[string, number]> = [
      ['subgraph_count', subgraphTvlById.size],
      ['aurora_count', auroraTvlById.size],
      ['missing', missing.length],
      ['extra', extra.length],
      ['tvl_mismatch', tvlMismatches.length],
    ];
    for (const [name, value] of counts) {
      this.metric.putMetric(
        `CachePools.aurora.extra_source_parity.${name}`,
        value,
        MetricLoggerUnit.Count,
        tags
      );
    }
    if (missing.length > 0) {
      this.logger.warn(
        `Aurora extra pool source gap ${extraSourceKey(this.source, this.chainId)}: missing=${missing.length} extra=${extra.length}`,
        {missingIds: missing.slice(0, MISSING_IDS_LOG_LIMIT)}
      );
    }
    if (tvlMismatches.length > 0) {
      const worst = [...tvlMismatches]
        .sort((a, b) => tvlMismatchSeverity(b) - tvlMismatchSeverity(a))
        .slice(0, TVL_MISMATCH_LOG_LIMIT);
      this.logger.warn(
        `Aurora extra pool source TVL mismatch ${extraSourceKey(this.source, this.chainId)}: ${tvlMismatches.length} of ${subgraphTvlById.size - missing.length} shared pools outside ${TVL_PARITY_MIN_RATIO}-${TVL_PARITY_MAX_RATIO}x`,
        {worstTvlMismatches: worst}
      );
    }
  }
}

// --- Wiring ---

export interface ExtraSourceChainProtocol {
  protocol: Protocol;
  chainId: number;
  eulerHooksProvider?: unknown;
  aggHooksProvider?: Pick<
    AggHooksSubgraphProvider,
    'hookAddresses' | 'ethersProvider' | 'useExternalLiquidity'
  >;
  extraPoolSourceOverrides?: ExtraPoolSourceOverrides;
}

// Installs extraPoolSourceOverrides on every combo whose extra source is an
// Aurora target. `primaryDeps` serves primary reads; `shadowDeps` (lower
// fetch-slot priority) serves shadow reads.
export function applyAuroraExtraPoolSources(
  chainProtocols: ExtraSourceChainProtocol[],
  config: AuroraExtraSourceConfig,
  primaryDeps: AuroraExtraSourceDeps,
  shadowDeps: AuroraExtraSourceDeps,
  logger: Logger,
  metric: IMetric,
  // Scoped runs carry a subset of combos, so a listed key without a combo in
  // the run is expected there and only reported on the full sweep.
  reportUnmatchedKeys: boolean
): void {
  for (const reason of config.rejections) {
    metric.putMetric(
      'CachePools.aurora.extra_source_config_rejected',
      1,
      MetricLoggerUnit.Count,
      {reason}
    );
    logger.warn(
      `Aurora extra pool source targets: ${reason} entries ignored — list explicit <source>:<chainId> keys`
    );
  }

  // Keys an override was installed for, or could be: an explicitly listed key
  // outside this set names a source/chain with no Aurora read and is reported.
  const supportedKeys = new Set<string>();

  for (const chainProtocol of chainProtocols) {
    const {chainId, protocol} = chainProtocol;
    const overrides: ExtraPoolSourceOverrides = {
      ...chainProtocol.extraPoolSourceOverrides,
    };

    if (protocol === Protocol.V4 && chainProtocol.eulerHooksProvider) {
      const mode = resolveExtraSourceMode(
        config,
        ExtraPoolSourceName.EULER_HOOKS,
        chainId
      );
      const hooks = EULER_SWAP_HOOKS_BY_CHAIN.get(chainId);
      if (hooks) {
        supportedKeys.add(
          extraSourceKey(ExtraPoolSourceName.EULER_HOOKS, chainId)
        );
      }
      if (mode && hooks) {
        const deps = mode === 'primary' ? primaryDeps : shadowDeps;
        const aurora = new AuroraEulerSwapPoolsProvider(chainId, hooks, deps);
        overrides.euler = subgraph =>
          new AuroraSourcedExtraPoolsProvider(
            mode,
            ExtraPoolSourceName.EULER_HOOKS,
            chainId,
            aurora,
            subgraph,
            logger,
            metric,
            // One pool per registry hook.
            {
              kind: 'expected_keys',
              expectedKeys: hooks,
              coverageKey: pool => pool.hooks,
              warnOnMissing: true,
            }
          );
      }
    }

    const aggHooksProvider = chainProtocol.aggHooksProvider;
    if (protocol === Protocol.V4 && aggHooksProvider) {
      const mode = resolveExtraSourceMode(
        config,
        ExtraPoolSourceName.AGG_HOOKS,
        chainId
      );
      supportedKeys.add(extraSourceKey(ExtraPoolSourceName.AGG_HOOKS, chainId));
      if (mode) {
        const deps = mode === 'primary' ? primaryDeps : shadowDeps;
        const aurora = new AuroraAggHooksPoolsProvider(
          chainId,
          {
            hookAddresses: aggHooksProvider.hookAddresses,
            pseudoTvl: new EthersPseudoTvlReader(
              aggHooksProvider.ethersProvider,
              mode === 'shadow' ? shadowPseudoTvlLimit : undefined
            ),
            externalLiquidityOnly: aggHooksProvider.useExternalLiquidity,
          },
          deps
        );
        overrides.aggHooks = subgraph =>
          new AuroraSourcedExtraPoolsProvider(
            mode,
            ExtraPoolSourceName.AGG_HOOKS,
            chainId,
            aurora,
            subgraph,
            logger,
            metric,
            // Keyed by pool id against recent good reads: a hook can have
            // any number of pools, so per-hook keys miss a partial loss
            // (Tempo: 1 hook, 5 pools) and fail forever on an empty hook.
            {
              kind: 'recent_pool_ids',
              recent: V4_EXTRA_POOL_SOURCE_MEMORY,
              warnOnMissing: true,
            }
          );
      }
    }

    if (protocol === Protocol.V3 && chainId === ChainId.MAINNET) {
      const mode = resolveExtraSourceMode(
        config,
        ExtraPoolSourceName.V3_MAINNET_MANUAL,
        chainId
      );
      supportedKeys.add(
        extraSourceKey(ExtraPoolSourceName.V3_MAINNET_MANUAL, chainId)
      );
      if (mode) {
        const deps = mode === 'primary' ? primaryDeps : shadowDeps;
        const aurora = new AuroraV3PoolIdsProvider(
          chainId,
          MAINNET_V3_MANUAL_POOL_IDS,
          deps
        );
        overrides.v3Manual = subgraph =>
          new AuroraSourcedExtraPoolsProvider(
            mode,
            ExtraPoolSourceName.V3_MAINNET_MANUAL,
            chainId,
            aurora,
            subgraph,
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
    }

    if (overrides.euler || overrides.aggHooks || overrides.v3Manual) {
      chainProtocol.extraPoolSourceOverrides = overrides;
    }
  }

  if (!reportUnmatchedKeys) return;
  const listedKeys = [
    ...config.primaryTargets,
    ...(config.shadowTargets === 'all' ? [] : config.shadowTargets),
  ];
  for (const key of new Set(listedKeys)) {
    if (supportedKeys.has(key)) continue;
    const [source] = key.split(':');
    metric.putMetric(
      'CachePools.aurora.extra_source_unsupported_target',
      1,
      MetricLoggerUnit.Count,
      {source: source ?? 'unknown'}
    );
    logger.warn(
      `Aurora extra pool source targeted for ${key} but this run has no such source — staying on subgraph`
    );
  }
}
