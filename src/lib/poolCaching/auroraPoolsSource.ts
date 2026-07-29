/**
 * Aurora-backed pool source for the pool-caching cron (subgraph → Aurora
 * migration). Replaces SubgraphProvider.getPools() behind env-flagged
 * targets; everything downstream of getPools() (hooks filtering, S3 snapshot
 * format, serving path) is unchanged.
 *
 * SCOPE: hard-limited to Robinhood V4 (AURORA_SUPPORTED_TARGETS) — the pilot
 * combo. Env targets outside the allowlist are ignored with a metric, so even
 * a `*` flag cannot enable other chains/protocols without a code change.
 *
 * Modes:
 *   - shadow:  subgraph result stays authoritative (written to S3); Aurora is
 *              fetched concurrently and diffed, parity metrics emitted.
 *   - primary: Aurora result is served; on Aurora error, empty result, or a
 *              pool count collapsing below minPoolCountRatio × the previous
 *              run's count, the run falls back to the subgraph provider —
 *              surviving an Aurora outage needs no deploy.
 */

import * as fs from 'fs';
import * as tls from 'tls';
import {Protocol} from '@uniswap/router-sdk';
import {Kysely} from 'kysely';
import {Context} from '@uniswap/lib-uni/context';
import type {IMetrics, MetricOptions} from '@uniswap/lib-observability';
import {createAddress, type ExtendedChainId} from '@uniswap/lib-data-api';
import {
  createDataIngestionAuroraKysely,
  createAuroraRoutablePoolsService,
  createAuroraCurrentTokenPricesService,
  canonicalTokenKey,
  type CurrentTokenPricesService,
  type DataIngestionAuroraDB,
  type RoutablePoolsService,
} from '@uniswap/lib-data-ingestion-aurora';

import {
  ISubgraphProvider,
  V2SubgraphPool,
  V3SubgraphPool,
  V4SubgraphPool,
} from './sor-providers';
import {V4_MIN_TVL_ETH} from './sor-providers/subgraphProvider';
import {getTvlBypassHookAddresses} from './util/hooksAddressesAllowlist';
import {Logger} from './sor-providers/util/log';
import {IMetric, MetricLoggerUnit} from './sor-providers/util/metric';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const CHAIN_ID_ROBINHOOD = 4663;

// Wrapped-native address per Aurora-supported chain (values from
// src/stores/chain/hardcoded/chains/*), used to convert the ETH-denominated
// TVL floors to USD and back. Grows with AURORA_SUPPORTED_TARGETS.
const WRAPPED_NATIVE_BY_CHAIN: {[chainId: number]: string} = {
  [CHAIN_ID_ROBINHOOD]: '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
};

// The only chain×protocol combos the Aurora source may serve. Deliberately
// Robinhood-V4-only for the pilot; expanding a rollout wave means adding the
// combo here (and its wrapped native above) — env flags alone cannot widen it.
export const AURORA_SUPPORTED_TARGETS: ReadonlySet<string> = new Set([
  `${CHAIN_ID_ROBINHOOD}:${Protocol.V4}`,
]);

// --- Config ---

export type AuroraTargetMode = 'shadow' | 'primary';

export interface AuroraPoolsSourceConfig {
  // 'all' (env value "*") or a set of `${chainId}:${PROTOCOL}` keys.
  shadowTargets: 'all' | ReadonlySet<string>;
  primaryTargets: 'all' | ReadonlySet<string>;
  minPoolCountRatio: number;
}

export function targetKey(chainId: number, protocol: Protocol): string {
  return `${chainId}:${String(protocol).toUpperCase()}`;
}

function parseTargets(raw: string | undefined): 'all' | ReadonlySet<string> {
  if (!raw || raw.trim() === '') return new Set();
  if (raw.trim() === '*') return 'all';
  return new Set(
    raw
      .split(',')
      .map(entry => entry.trim().toUpperCase())
      .filter(entry => entry.length > 0)
  );
}

// Returns undefined when neither target env is set — the feature is fully off
// and no Aurora client is created.
export function auroraPoolsSourceConfigFromEnv():
  | AuroraPoolsSourceConfig
  | undefined {
  const shadowRaw = process.env.POOL_CACHING_AURORA_SHADOW_TARGETS;
  const primaryRaw = process.env.POOL_CACHING_AURORA_PRIMARY_TARGETS;
  if (!shadowRaw && !primaryRaw) return undefined;

  const ratioRaw = process.env.POOL_CACHING_AURORA_MIN_POOL_COUNT_RATIO;
  const parsedRatio = ratioRaw ? Number(ratioRaw) : NaN;
  return {
    shadowTargets: parseTargets(shadowRaw),
    primaryTargets: parseTargets(primaryRaw),
    minPoolCountRatio:
      Number.isFinite(parsedRatio) && parsedRatio > 0 && parsedRatio <= 1
        ? parsedRatio
        : 0.5,
  };
}

export function resolveAuroraMode(
  config: AuroraPoolsSourceConfig,
  chainId: number,
  protocol: Protocol
): AuroraTargetMode | undefined {
  const key = targetKey(chainId, protocol);
  const inTargets = (targets: 'all' | ReadonlySet<string>) =>
    targets === 'all' || targets.has(key);
  // primary wins when a combo is (mis)listed in both.
  if (inTargets(config.primaryTargets)) return 'primary';
  if (inTargets(config.shadowTargets)) return 'shadow';
  return undefined;
}

// --- Connection (mirrors liquidity's createDeployedDataIngestionDbIfConfigured) ---

// Process-lifetime singleton: applyAuroraPoolSources runs on EVERY cron tick,
// and each createDataIngestionAuroraKysely call opens a fresh pg pool that
// nothing ever destroys — without the memo the sidecar would leak Aurora
// connections tick after tick. Env is immutable within a process, so caching
// the first outcome (including a failure — a retry can't succeed) is safe,
// but the latched failure must stay distinguishable from missing env so
// every tick re-emits the real cause instead of misdiagnosing it.
export type AuroraDbInitState =
  | {status: 'ready'; db: Kysely<DataIngestionAuroraDB>}
  | {status: 'env_missing'}
  | {status: 'init_failed'; error: Error};

let auroraDbInitState: AuroraDbInitState | undefined;

export function getOrCreateUnirouteAuroraDb(logger: Logger): AuroraDbInitState {
  if (!auroraDbInitState) {
    try {
      const db = createUnirouteAuroraDbFromEnv(logger);
      auroraDbInitState = db ? {status: 'ready', db} : {status: 'env_missing'};
    } catch (err) {
      auroraDbInitState = {
        status: 'init_failed',
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  }
  return auroraDbInitState;
}

export function createUnirouteAuroraDbFromEnv(
  logger: Logger
): Kysely<DataIngestionAuroraDB> | undefined {
  const host = process.env.DATA_INGESTION_AURORA_HOST;
  if (!host) return undefined;

  const database = process.env.DATA_INGESTION_AURORA_DATABASE;
  const user = process.env.DATA_INGESTION_AURORA_USER;
  const password = process.env.DATA_INGESTION_AURORA_UNIROUTE_PASSWORD;
  if (!database || !user || !password) {
    logger.warn(
      'DATA_INGESTION_AURORA_HOST is set but DATABASE/USER/PASSWORD are incomplete — Aurora pool source disabled'
    );
    return undefined;
  }

  // When DATA_INGESTION_AURORA_SERVERNAME is set we're behind a proxy/Lattice
  // path: TLS hostname verification must target the proxy hostname rather than
  // the DNS name we dial. Otherwise verify against the RDS CA bundle baked
  // into the ECS image (containers/Dockerfile.ec2).
  const servername = process.env.DATA_INGESTION_AURORA_SERVERNAME;
  const ssl = servername
    ? {
        rejectUnauthorized: true,
        servername,
        checkServerIdentity: (_host: string, cert: tls.PeerCertificate) =>
          tls.checkServerIdentity(servername, cert),
      }
    : {ca: fs.readFileSync('/var/task/aws-rds-ca-bundle.pem', 'utf8')};

  return createDataIngestionAuroraKysely({
    host,
    database,
    user,
    password,
    // Single pilot combo on a small chain — a tiny pool is plenty and keeps
    // reader connections bounded.
    max: 2,
    // Full-set query measured 1.8s prod / 7.1s dev (~127k rows); 30s bounds a
    // hung scan so it can't pin one of the 2 connections across cron ticks
    // (the cron's withTimeout detaches, it doesn't cancel).
    statementTimeoutMillis: 30_000,
    ssl,
  });
}

// --- Context adapter ---
// The pool-caching cron passes around the SOR-ported Logger/IMetric rather
// than a full uni Context; lib-data-ingestion-aurora services need
// ctx.metrics (IMetrics). Bridge putMetric-style emission so the lib's
// aurora.method.* metrics still land in Datadog.

class PoolCachingIMetricsAdapter implements IMetrics {
  constructor(private readonly metric: IMetric) {}

  private put(
    name: string,
    val: number,
    unit: MetricLoggerUnit,
    opts?: Partial<MetricOptions>
  ): Promise<void> {
    const tags: Record<string, string> = {};
    for (const tag of opts?.tags ?? []) {
      const idx = tag.indexOf(':');
      if (idx > 0) tags[tag.slice(0, idx)] = tag.slice(idx + 1);
    }
    this.metric.putMetric(name, val, unit, tags);
    return Promise.resolve();
  }

  count(name: string, val = 1, opts?: Partial<MetricOptions>): Promise<void> {
    return this.put(name, val, MetricLoggerUnit.Count, opts);
  }
  timer(name: string, val: number, opts?: Partial<MetricOptions>) {
    return this.put(name, val, MetricLoggerUnit.Milliseconds, opts);
  }
  gauge(name: string, val: number, opts?: Partial<MetricOptions>) {
    return this.put(name, val, MetricLoggerUnit.None, opts);
  }
  hist(name: string, val: number, opts?: Partial<MetricOptions>) {
    return this.put(name, val, MetricLoggerUnit.None, opts);
  }
  set(name: string, val: number, opts?: Partial<MetricOptions>) {
    return this.put(name, val, MetricLoggerUnit.None, opts);
  }
  dist(name: string, val: number, opts?: Partial<MetricOptions>) {
    return this.put(name, val, MetricLoggerUnit.None, opts);
  }
  flush(): Promise<void> {
    return Promise.resolve();
  }
}

export function auroraContext(metric: IMetric): Context {
  const ctx = Context.Background();
  ctx.metrics = new PoolCachingIMetricsAdapter(metric);
  return ctx;
}

// --- Aurora V4 provider ---

export interface AuroraProviderDeps {
  routablePools: RoutablePoolsService;
  prices: CurrentTokenPricesService;
  logger: Logger;
  metric: IMetric;
}

// A wrapped-native price older than this cannot be used for the floor/tvlETH
// conversion. Matches the lib's DEFAULT_PRICE_STALENESS_SECONDS used for the
// per-side TVL joins, so both freshness gates move together.
const NATIVE_PRICE_MAX_STALENESS_MS = 24 * 60 * 60 * 1000;

export class AuroraV4PoolsProvider
  implements ISubgraphProvider<V4SubgraphPool>
{
  constructor(
    private readonly chainId: number,
    private readonly trackedEthThreshold: number,
    private readonly deps: AuroraProviderDeps
  ) {}

  // USD price of the chain's wrapped-native token: converts the ETH-denominated
  // TVL floors into USD and Aurora's USD TVL back into tvlETH, so the
  // serve-side TrackedEthThreshold filters keep working unchanged.
  private async nativeUsdPrice(ctx: Context): Promise<number> {
    const wrappedNative = WRAPPED_NATIVE_BY_CHAIN[this.chainId];
    if (!wrappedNative) {
      throw new Error(
        `No wrapped-native address known for chain ${this.chainId} — cannot derive tvlETH`
      );
    }
    const chainId = this.chainId as ExtendedChainId;
    const address = createAddress(wrappedNative, chainId);
    const priceMap = await this.deps.prices.batchGet(ctx, [{chainId, address}]);
    const entry = priceMap.get(canonicalTokenKey(this.chainId, wrappedNative));
    const price = entry?.priceUsd;
    if (!price || !Number.isFinite(price) || price <= 0) {
      throw new Error(
        `No current native token price for chain ${this.chainId} (${wrappedNative}) — cannot derive tvlETH`
      );
    }
    // batchGet returns whatever row exists regardless of age; a frozen price
    // would silently skew the floor and every tvlETH. Treat stale as missing
    // (throw → primary mode falls back to the subgraph).
    if (
      Date.now() - entry!.timestamp.getTime() >
      NATIVE_PRICE_MAX_STALENESS_MS
    ) {
      throw new Error(
        `Stale native token price for chain ${this.chainId} (${wrappedNative}, ${entry!.timestamp.toISOString()}) — cannot derive tvlETH`
      );
    }
    return price;
  }

  async getPools(): Promise<V4SubgraphPool[]> {
    const ctx = auroraContext(this.deps.metric);
    const nativePrice = await this.nativeUsdPrice(ctx);
    // Fetch the FULL set (floor 0) and replicate the subgraph V4 admission
    // union in TS below — a single SQL floor would drop pools the subgraph
    // path includes (the [V4_MIN_TVL_ETH, trackedEthThreshold) high-liquidity
    // band and the zero-TVL bypass-hook pools).
    const pools = await this.deps.routablePools.listAllV4RoutablePools(ctx, {
      chainId: this.chainId as ExtendedChainId,
      minTvlUsd: 0,
    });

    // Subgraph V4 admission = union of three query families
    // (sor-providers/subgraphProvider.ts getPools):
    //   (a) tvlETH > trackedEthThreshold
    //   (b) liquidity > 0 AND tvlETH > V4_MIN_TVL_ETH
    //   (c) hooks ∈ TVL-bypass registries (no floor)
    // A fourth family (permissioned hooks, adapter-bounded) is NOT replicated:
    // it is empty for Robinhood, the only AURORA_SUPPORTED_TARGETS chain. It
    // must be added before the allowlist grows to a permissioned-hooks chain.
    const bypassHooks = getTvlBypassHookAddresses(this.chainId);
    const admitted = (
      tvlEth: number,
      liquidity: string,
      hooks: string
    ): boolean => {
      if (tvlEth > this.trackedEthThreshold) return true;
      if (parsePositiveLiquidity(liquidity) && tvlEth > V4_MIN_TVL_ETH) {
        return true;
      }
      return bypassHooks?.has(hooks) ?? false;
    };

    const result: V4SubgraphPool[] = [];
    let droppedNullDecimals = 0;
    for (const pool of pools) {
      const hooks = (pool.hooksAddress ?? ZERO_ADDRESS).toLowerCase();
      const tvlEth = pool.tvlUsd / nativePrice;
      if (!admitted(tvlEth, pool.liquidity, hooks)) continue;
      // V4 snapshot consumers require token decimals; canonical_tokens rows
      // may not have them (yet). Drop with a metric rather than emit garbage.
      if (pool.token0Decimals === null || pool.token1Decimals === null) {
        droppedNullDecimals++;
        continue;
      }
      result.push({
        id: pool.poolId.toLowerCase(),
        feeTier: String(pool.feeBips),
        tickSpacing: String(pool.tickSpacing),
        hooks,
        liquidity: pool.liquidity,
        token0: {
          id: pool.token0Address.toLowerCase(),
          symbol: pool.token0Symbol ?? undefined,
          name: pool.token0Name ?? undefined,
          decimals: String(pool.token0Decimals),
        },
        token1: {
          id: pool.token1Address.toLowerCase(),
          symbol: pool.token1Symbol ?? undefined,
          name: pool.token1Name ?? undefined,
          decimals: String(pool.token1Decimals),
        },
        tvlETH: tvlEth,
        tvlUSD: pool.tvlUsd,
      });
    }
    if (droppedNullDecimals > 0) {
      this.deps.metric.putMetric(
        'CachePools.aurora.dropped_null_decimals',
        droppedNullDecimals,
        MetricLoggerUnit.Count,
        {chainId: String(this.chainId), protocol: String(Protocol.V4)}
      );
    }
    return result;
  }
}

// Mirrors the subgraph's `liquidity_gt: "0"` condition; malformed values
// count as 0 rather than throwing away the whole run.
function parsePositiveLiquidity(liquidity: string): boolean {
  try {
    return BigInt(liquidity) > 0n;
  } catch {
    return false;
  }
}

// --- Parity diff (shadow mode) ---

type AnySubgraphPool = V2SubgraphPool | V3SubgraphPool | V4SubgraphPool;

function poolTvlUsd(pool: AnySubgraphPool): number {
  return 'tvlUSD' in pool ? pool.tvlUSD : pool.reserveUSD;
}

export interface PoolParity {
  subgraphCount: number;
  auroraCount: number;
  jaccardBps: number;
  missingTop100: number;
  extraInAurora: number;
  tvlDriftBpsP50: number;
}

export function computePoolParity(
  subgraphPools: AnySubgraphPool[],
  auroraPools: AnySubgraphPool[]
): PoolParity {
  const subgraphById = new Map(
    subgraphPools.map(pool => [pool.id.toLowerCase(), pool])
  );
  const auroraById = new Map(
    auroraPools.map(pool => [pool.id.toLowerCase(), pool])
  );

  let intersection = 0;
  const driftsBps: number[] = [];
  for (const [id, subgraphPool] of subgraphById) {
    const auroraPool = auroraById.get(id);
    if (!auroraPool) continue;
    intersection++;
    const subgraphTvl = poolTvlUsd(subgraphPool);
    const auroraTvl = poolTvlUsd(auroraPool);
    if (subgraphTvl > 0) {
      driftsBps.push(Math.abs(auroraTvl - subgraphTvl) / subgraphTvl / 0.0001);
    }
  }
  const unionSize = subgraphById.size + auroraById.size - intersection || 1;

  const top100 = [...subgraphById.values()]
    .sort((a, b) => poolTvlUsd(b) - poolTvlUsd(a))
    .slice(0, 100);
  const missingTop100 = top100.filter(
    pool => !auroraById.has(pool.id.toLowerCase())
  ).length;

  driftsBps.sort((a, b) => a - b);
  const tvlDriftBpsP50 =
    driftsBps.length > 0 ? driftsBps[Math.floor(driftsBps.length / 2)] : 0;

  return {
    subgraphCount: subgraphById.size,
    auroraCount: auroraById.size,
    jaccardBps: Math.round((intersection / unionSize) * 10000),
    missingTop100,
    extraInAurora: auroraById.size - intersection,
    tvlDriftBpsP50: Math.round(tvlDriftBpsP50),
  };
}

// --- Wrapper provider (the seam installed into ChainProtocol.provider) ---

// Collapse-guard baselines, keyed by targetKey. MODULE level, not an instance
// field: cacheAllPools rebuilds the providers on every cron tick, so an
// instance field would always be undefined at check time and the low_count
// fallback would never fire. The map survives as long as the cron process.
const lastAuroraPoolCountByTarget = new Map<string, number>();

export function resetAuroraPoolCountBaselinesForTesting(): void {
  lastAuroraPoolCountByTarget.clear();
}

export class AuroraSourcedProvider<TPool extends AnySubgraphPool>
  implements ISubgraphProvider<TPool>
{
  constructor(
    private readonly mode: AuroraTargetMode,
    private readonly aurora: ISubgraphProvider<TPool>,
    private readonly subgraph: ISubgraphProvider<TPool>,
    private readonly chainId: number,
    private readonly protocol: Protocol,
    private readonly minPoolCountRatio: number,
    private readonly logger: Logger,
    private readonly metric: IMetric
  ) {}

  private get tags(): Record<string, string> {
    return {
      chainId: String(this.chainId),
      protocol: String(this.protocol),
      mode: this.mode,
    };
  }

  async getPools(
    ...args: Parameters<ISubgraphProvider<TPool>['getPools']>
  ): Promise<TPool[]> {
    return this.mode === 'primary'
      ? this.getPoolsPrimary(...args)
      : this.getPoolsShadow(...args);
  }

  private async getPoolsPrimary(
    ...args: Parameters<ISubgraphProvider<TPool>['getPools']>
  ): Promise<TPool[]> {
    let fallbackReason: string | undefined;
    const baselineKey = targetKey(this.chainId, this.protocol);
    try {
      const pools = await this.aurora.getPools(...args);
      const baseline = lastAuroraPoolCountByTarget.get(baselineKey);
      if (pools.length === 0) {
        fallbackReason = 'empty';
      } else if (
        baseline !== undefined &&
        pools.length < baseline * this.minPoolCountRatio
      ) {
        fallbackReason = 'low_count';
        this.logger.warn(
          `Aurora pool count collapsed: ${pools.length} < ${this.minPoolCountRatio} x ${baseline}`
        );
      } else {
        lastAuroraPoolCountByTarget.set(baselineKey, pools.length);
        this.metric.putMetric(
          'CachePools.aurora.served',
          1,
          MetricLoggerUnit.Count,
          this.tags
        );
        return pools;
      }
    } catch (err) {
      fallbackReason = 'error';
      this.logger.error('Aurora pool fetch failed, falling back to subgraph', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    this.metric.putMetric(
      'CachePools.aurora.fallback',
      1,
      MetricLoggerUnit.Count,
      {...this.tags, reason: fallbackReason ?? 'unknown'}
    );
    return this.subgraph.getPools(...args);
  }

  private async getPoolsShadow(
    ...args: Parameters<ISubgraphProvider<TPool>['getPools']>
  ): Promise<TPool[]> {
    // Kick off Aurora concurrently; the subgraph result stays authoritative.
    const auroraPromise = this.aurora.getPools(...args);
    // A rejected shadow fetch must never become an unhandled rejection.
    auroraPromise.catch(() => {});

    const subgraphPools = await this.subgraph.getPools(...args);

    try {
      const auroraPools = await auroraPromise;
      const parity = computePoolParity(subgraphPools, auroraPools);
      this.metric.putMetric(
        'CachePools.parity.subgraph_count',
        parity.subgraphCount,
        MetricLoggerUnit.Count,
        this.tags
      );
      this.metric.putMetric(
        'CachePools.parity.aurora_count',
        parity.auroraCount,
        MetricLoggerUnit.Count,
        this.tags
      );
      this.metric.putMetric(
        'CachePools.parity.jaccard_bps',
        parity.jaccardBps,
        MetricLoggerUnit.None,
        this.tags
      );
      this.metric.putMetric(
        'CachePools.parity.missing_top100',
        parity.missingTop100,
        MetricLoggerUnit.Count,
        this.tags
      );
      this.metric.putMetric(
        'CachePools.parity.extra_in_aurora',
        parity.extraInAurora,
        MetricLoggerUnit.Count,
        this.tags
      );
      this.metric.putMetric(
        'CachePools.parity.tvl_drift_bps_p50',
        parity.tvlDriftBpsP50,
        MetricLoggerUnit.None,
        this.tags
      );
      this.logger.info(
        `Aurora shadow parity ${targetKey(this.chainId, this.protocol)}: ` +
          `subgraph=${parity.subgraphCount} aurora=${parity.auroraCount} ` +
          `jaccardBps=${parity.jaccardBps} missingTop100=${parity.missingTop100} ` +
          `tvlDriftBpsP50=${parity.tvlDriftBpsP50}`
      );
    } catch (err) {
      this.metric.putMetric(
        'CachePools.aurora.shadow_error',
        1,
        MetricLoggerUnit.Count,
        this.tags
      );
      this.logger.warn('Aurora shadow fetch failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return subgraphPools;
  }
}

// --- Wiring ---

export interface AuroraSourceThresholds {
  trackedEthThresholdFor(protocol: Protocol, chainId: number): number;
}

// Wraps the providers of targeted chain×protocol combos in place. Called by
// cacheAllPools after createChainProtocols; a no-op unless the
// POOL_CACHING_AURORA_*_TARGETS env flags are set AND the Aurora connection
// env is complete. Only combos in AURORA_SUPPORTED_TARGETS are ever wrapped.
export function applyAuroraPoolSources<
  T extends {
    protocol: Protocol;
    chainId: number;
    provider:
      | ISubgraphProvider<V2SubgraphPool>
      | ISubgraphProvider<V3SubgraphPool>
      | ISubgraphProvider<V4SubgraphPool>;
  },
>(
  chainProtocols: T[],
  thresholds: AuroraSourceThresholds,
  logger: Logger,
  metric: IMetric
): void {
  const config = auroraPoolsSourceConfigFromEnv();
  if (!config) return;

  // A failed init (e.g. missing CA bundle file) must degrade THIS feature,
  // never kill the whole all-chains pool-caching run. The failure is latched
  // (env is immutable, a retry can't succeed) but re-emitted every tick so a
  // permanently-down Aurora path stays visible.
  const init = getOrCreateUnirouteAuroraDb(logger);
  if (init.status === 'init_failed') {
    metric.putMetric('CachePools.aurora.init_error', 1, MetricLoggerUnit.Count);
    logger.error('Aurora pool source init failed — staying on subgraphs', {
      error: init.error.message,
    });
    return;
  }
  if (init.status === 'env_missing') {
    logger.warn(
      'POOL_CACHING_AURORA_*_TARGETS set but Aurora connection env is missing — staying on subgraphs'
    );
    return;
  }
  const db = init.db;

  const deps: AuroraProviderDeps = {
    routablePools: createAuroraRoutablePoolsService(db, 'uniroute'),
    prices: createAuroraCurrentTokenPricesService(db, 'uniroute'),
    logger,
    metric,
  };

  for (const chainProtocol of chainProtocols) {
    const {chainId, protocol} = chainProtocol;
    const mode = resolveAuroraMode(config, chainId, protocol);
    if (!mode) continue;

    if (!AURORA_SUPPORTED_TARGETS.has(targetKey(chainId, protocol))) {
      logger.warn(
        `Aurora pool source targeted for ${targetKey(chainId, protocol)} but only ${[...AURORA_SUPPORTED_TARGETS].join(', ')} are code-supported — staying on subgraph`
      );
      metric.putMetric(
        'CachePools.aurora.unsupported_target',
        1,
        MetricLoggerUnit.Count,
        {chainId: String(chainId), protocol: String(protocol)}
      );
      continue;
    }

    // The wrap below is V4-shaped (AuroraV4PoolsProvider + V4SubgraphPool
    // cast). Keep the invariant local: a non-V4 combo added to
    // AURORA_SUPPORTED_TARGETS must grow a protocol-specific provider, not
    // silently map its pools through the V4 row shape.
    if (protocol !== Protocol.V4) {
      logger.warn(
        `Aurora pool source targeted for ${targetKey(chainId, protocol)} but only V4 has an Aurora provider — staying on subgraph`
      );
      metric.putMetric(
        'CachePools.aurora.unsupported_target',
        1,
        MetricLoggerUnit.Count,
        {chainId: String(chainId), protocol: String(protocol)}
      );
      continue;
    }

    chainProtocol.provider = new AuroraSourcedProvider(
      mode,
      new AuroraV4PoolsProvider(
        chainId,
        thresholds.trackedEthThresholdFor(protocol, chainId),
        deps
      ),
      chainProtocol.provider as ISubgraphProvider<V4SubgraphPool>,
      chainId,
      protocol,
      config.minPoolCountRatio,
      logger,
      metric
    );
    logger.info(
      `Aurora pool source enabled (${mode}) for ${targetKey(chainId, protocol)}`
    );
  }
}
