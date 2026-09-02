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
 *   - primary: Aurora result is served; on Aurora error, empty result, a
 *              pool count below the per-target absolute floor
 *              (minPoolCountByTarget), or a count collapsing below
 *              minPoolCountRatio × the previous run's count, the run falls
 *              back to the subgraph provider — surviving an Aurora outage
 *              needs no deploy. The absolute floor is what protects the FIRST
 *              tick after a process start: the ratio guard's baseline is
 *              in-memory, so without a floor a mass-inadmission result (e.g.
 *              price-pipeline outage) would be accepted as the new baseline.
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
  type V4RoutablePool,
} from '@uniswap/lib-data-ingestion-aurora';

import {
  ISubgraphProvider,
  V2SubgraphPool,
  V3SubgraphPool,
  V4SubgraphPool,
} from './sor-providers';
import {V4_MIN_TVL_ETH} from './sor-providers/subgraphProvider';
import {getTvlBypassHookAddresses} from './util/hooksAddressesAllowlist';
import {getDynamicZlcaHooks} from './util/dynamicZlcaHooks';
import {v4HooksPoolsFiltering} from './util/v4HooksPoolsFiltering';
import {ChainId as SdkChainId} from '@uniswap/sdk-core';
import {Logger} from './sor-providers/util/log';
import {IMetric, MetricLoggerUnit} from './sor-providers/util/metric';

// Observability sinks for the servable-parity re-run of the serving filter:
// the REAL filter run (cachePools) owns the filter's metrics/logs; the parity
// re-run must not double-emit them.
const NOOP_LOGGER: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  fatal: () => {},
};
class NoopMetric extends IMetric {
  putDimensions(): void {}
  putMetric(): void {}
  setProperty(): void {}
}
const NOOP_METRIC = new NoopMetric();

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const CHAIN_ID_ROBINHOOD = 4663;

// Wrapped-native address per Aurora-supported chain (values from
// src/stores/chain/hardcoded/chains/*), used to convert the ETH-denominated
// TVL floors to USD and back. Grows with AURORA_SUPPORTED_TARGETS.
const WRAPPED_NATIVE_BY_CHAIN: {[chainId: number]: string} = {
  [CHAIN_ID_ROBINHOOD]: '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
};

// USDG (Global Dollar) on Robinhood — the chain's dominant stable quote asset.
const USDG_ON_ROBINHOOD = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';

// Quote assets whose fresh USD price may be propagated one hop through a
// pool's own spot price to value the OTHER side when it has no price row
// (implied in-pool pricing — the analog of the subgraph's derivedETH, which
// is what admits fresh launchpad pools the pricing pipeline hasn't covered
// yet). Restricting the propagation SOURCE to these chain quote assets
// mirrors the subgraph's whitelist concept: a meme priced off another meme's
// pool must not mint implied TVL. Lowercased; grows with
// AURORA_SUPPORTED_TARGETS.
const IMPLIED_PRICE_SOURCE_TOKENS_BY_CHAIN: {
  [chainId: number]: ReadonlySet<string>;
} = {
  [CHAIN_ID_ROBINHOOD]: new Set([
    // Native ETH: V4 pools quote against currency 0x0 directly, and this is
    // the LARGEST quoted cohort (~81k one-side-priced pools). Only useful
    // because data-ingestion writes a fresh current_token_prices row for the
    // zero address itself (verified in dev: sub-minute freshness) — if that
    // row ever went stale, native-quoted pools would silently lose implied
    // pricing (both sides null → no top-up).
    ZERO_ADDRESS,
    WRAPPED_NATIVE_BY_CHAIN[CHAIN_ID_ROBINHOOD],
    USDG_ON_ROBINHOOD,
  ]),
};

// Per-pool ceiling (in native units) on the implied top-up. 1 ETH is 100×
// the tracked-ETH admission threshold (0.01) — far more than admission needs
// — while keeping spot-derived phantom TVL from out-ranking genuinely liquid
// pools in TopPools selection (council review finding on #11463).
const IMPLIED_TVL_TOPUP_CAP_ETH = 1;

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
  // Absolute per-target pool-count floor for PRIMARY mode, keyed by
  // targetKey(). A primary result below its floor falls back to the subgraph
  // for that tick and never becomes the ratio guard's baseline. Targets
  // without an entry have no absolute floor (ratio guard only).
  minPoolCountByTarget: ReadonlyMap<string, number>;
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

// JSON map of targetKey -> absolute floor, e.g. '{"4663:V4":40000}'. Keys are
// normalized through targetKey casing (uppercased protocol). Malformed JSON or
// non-positive values are dropped entry-wise rather than failing boot — the
// floor is a safety net, and a config typo must not take the whole Aurora
// source down; the ratio guard still applies either way.
export function parseMinPoolCountByTarget(
  raw: string | undefined
): ReadonlyMap<string, number> {
  const result = new Map<string, number>();
  if (!raw || raw.trim() === '') return result;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return result;
  }
  if (typeof parsed !== 'object' || parsed === null) return result;
  for (const [key, value] of Object.entries(parsed)) {
    const floor = Number(value);
    if (Number.isFinite(floor) && floor > 0) {
      result.set(key.trim().toUpperCase(), Math.floor(floor));
    }
  }
  return result;
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
    minPoolCountByTarget: parseMinPoolCountByTarget(
      process.env.POOL_CACHING_AURORA_MIN_POOL_COUNT_BY_TARGET
    ),
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
  // Narrowed to the method the V4 provider consumes, so fakes and the wave-2
  // V3 provider each depend only on their own slice of the lib interface.
  routablePools: Pick<RoutablePoolsService, 'listAllV4RoutablePools'>;
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

    const impliedSourceTokens =
      IMPLIED_PRICE_SOURCE_TOKENS_BY_CHAIN[this.chainId];
    const result: V4SubgraphPool[] = [];
    let droppedNullDecimals = 0;
    // The implied top-up is spot-derived and therefore attacker-influenced:
    // anyone can initialize a pool at an arbitrary price and donate token
    // reserve, minting phantom TVL. The cap keeps that useful for ADMISSION
    // (1 ETH ≫ the 0.001/0.01 ETH floors) while bounding its RANKING power —
    // tvlUSD feeds TopPools selection, and a ~1-ETH ceiling cannot displace
    // genuinely liquid pools. Genuinely valuable pools carry real priced-side
    // TVL, which is never capped.
    const impliedTopUpCapUsd = IMPLIED_TVL_TOPUP_CAP_ETH * nativePrice;
    let impliedPriced = 0;
    let impliedCapped = 0;
    for (const pool of pools) {
      const hooks = (pool.hooksAddress ?? ZERO_ADDRESS).toLowerCase();
      // SQL tvlUsd counts only sides with a fresh price row. Fresh launchpad
      // tokens have none, so their pools (whole token supply vs a near-empty
      // quote side) would compute ≈$0 and fail admission even though the
      // subgraph admits them via derivedETH — top the TVL up with the
      // in-pool implied value of the unpriced side.
      const rawImpliedUsd = impliedOneHopTvlUsd(pool, impliedSourceTokens);
      if (rawImpliedUsd > impliedTopUpCapUsd) impliedCapped++;
      const impliedUsd = Math.min(rawImpliedUsd, impliedTopUpCapUsd);
      const tvlUsd = pool.tvlUsd + impliedUsd;
      const tvlEth = tvlUsd / nativePrice;
      if (!admitted(tvlEth, pool.liquidity, hooks)) continue;
      // Count only admission FLIPS — pools rescued by the top-up, not every
      // pool where the code path fired. This is the number the shadow
      // readout compares against the missing-pool gap.
      if (
        impliedUsd > 0 &&
        !admitted(pool.tvlUsd / nativePrice, pool.liquidity, hooks)
      ) {
        impliedPriced++;
      }
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
        tvlUSD: tvlUsd,
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
    if (impliedPriced > 0) {
      this.deps.metric.putMetric(
        'CachePools.aurora.implied_priced',
        impliedPriced,
        MetricLoggerUnit.Count,
        {chainId: String(this.chainId), protocol: String(Protocol.V4)}
      );
    }
    if (impliedCapped > 0) {
      this.deps.metric.putMetric(
        'CachePools.aurora.implied_capped',
        impliedCapped,
        MetricLoggerUnit.Count,
        {chainId: String(this.chainId), protocol: String(Protocol.V4)}
      );
    }
    return result;
  }
}

/**
 * USD value of a pool's UNPRICED side, derived one hop through the pool's own
 * spot price from the priced side — the analog of the subgraph's derivedETH
 * for tokens `current_token_prices` doesn't cover (fresh launchpad tokens).
 *
 * Returns 0 (no contribution) unless ALL of:
 *   - exactly one side has a fresh price (both priced → SQL already counted
 *     everything; neither priced → nothing to propagate from);
 *   - the priced side is one of the chain's designated quote assets
 *     (`IMPLIED_PRICE_SOURCE_TOKENS_BY_CHAIN`) — propagation from arbitrary
 *     priced tokens (the pricing pipeline covers ~58k, memes included) mints
 *     implied TVL from junk pairings, which the subgraph's whitelist forbids;
 *   - decimals for both sides and a positive finite spot price are present.
 *
 * "Unpriced" includes a side whose price row exists but is STALE (>24h) —
 * deliberate: the pool's own spot state is fresher than a day-old pipeline
 * row, so spot-repricing a stale side beats counting it as zero.
 *
 * Returns the UNCAPPED value; the caller caps the top-up (see
 * IMPLIED_TVL_TOPUP_CAP_ETH) before it touches admission/ranking TVL.
 *
 * Float math is deliberate: values feed TVL floor comparisons and snapshot
 * ranking, not amounts — the ~15 significant digits of a double are plenty.
 */
export function impliedOneHopTvlUsd(
  pool: V4RoutablePool,
  impliedSourceTokens: ReadonlySet<string> | undefined
): number {
  if (!impliedSourceTokens) return 0;
  const p0 = pool.token0PriceUsd;
  const p1 = pool.token1PriceUsd;
  if ((p0 === null) === (p1 === null)) return 0;
  if (pool.token0Decimals === null || pool.token1Decimals === null) return 0;
  const pricedToken = (
    p0 !== null ? pool.token0Address : pool.token1Address
  ).toLowerCase();
  if (!impliedSourceTokens.has(pricedToken)) return 0;
  const sqrtP = Number(pool.sqrtPriceX96);
  if (!Number.isFinite(sqrtP) || sqrtP <= 0) return 0;
  // Raw token1 per raw token0, then adjusted to human units.
  const rawPrice = (sqrtP / 2 ** 96) ** 2;
  const humanPrice =
    rawPrice * 10 ** (pool.token0Decimals - pool.token1Decimals);
  if (!Number.isFinite(humanPrice) || humanPrice <= 0) return 0;
  let implied: number;
  if (p0 !== null) {
    // token1 unpriced: 1 human token1 = p0 / humanPrice USD.
    const reserve1 = Number(pool.tvlToken1) / 10 ** pool.token1Decimals;
    implied = reserve1 * (p0 / humanPrice);
  } else {
    // token0 unpriced: 1 human token0 = p1 × humanPrice USD.
    const reserve0 = Number(pool.tvlToken0) / 10 ** pool.token0Decimals;
    implied = reserve0 * (p1! * humanPrice);
  }
  return Number.isFinite(implied) && implied > 0 ? implied : 0;
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
  missingInAurora: number;
  extraInAurora: number;
  tvlDriftBpsP50: number;
  // Diagnostic samples so a parity gap is classifiable from logs alone:
  // top-TVL pool ids the subgraph has but Aurora lacks / vice versa, and
  // median-drift matched pools with both TVLs (id:subgraphTvl:auroraTvl).
  missingSample: string[];
  extraSample: string[];
  driftSample: string[];
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
  const driftsBps: Array<{bps: number; id: string; s: number; a: number}> = [];
  for (const [id, subgraphPool] of subgraphById) {
    const auroraPool = auroraById.get(id);
    if (!auroraPool) continue;
    intersection++;
    const subgraphTvl = poolTvlUsd(subgraphPool);
    const auroraTvl = poolTvlUsd(auroraPool);
    if (subgraphTvl > 0) {
      driftsBps.push({
        bps: Math.abs(auroraTvl - subgraphTvl) / subgraphTvl / 0.0001,
        id,
        s: subgraphTvl,
        a: auroraTvl,
      });
    }
  }
  const unionSize = subgraphById.size + auroraById.size - intersection || 1;

  const top100 = [...subgraphById.values()]
    .sort((a, b) => poolTvlUsd(b) - poolTvlUsd(a))
    .slice(0, 100);
  const missingTop100 = top100.filter(
    pool => !auroraById.has(pool.id.toLowerCase())
  ).length;

  driftsBps.sort((a, b) => a.bps - b.bps);
  const medianIdx = Math.floor(driftsBps.length / 2);
  const tvlDriftBpsP50 = driftsBps.length > 0 ? driftsBps[medianIdx]!.bps : 0;

  const topTvlSample = (
    pools: Iterable<AnySubgraphPool>,
    excludeIds: Map<string, AnySubgraphPool>
  ) =>
    [...pools]
      .filter(pool => !excludeIds.has(pool.id.toLowerCase()))
      .sort((a, b) => poolTvlUsd(b) - poolTvlUsd(a))
      .slice(0, SAMPLE_SIZE)
      .map(pool => pool.id.toLowerCase());
  const driftSample = driftsBps
    .slice(medianIdx, medianIdx + 3)
    .map(d => `${d.id}:${d.s.toFixed(2)}:${d.a.toFixed(2)}`);

  return {
    subgraphCount: subgraphById.size,
    auroraCount: auroraById.size,
    jaccardBps: Math.round((intersection / unionSize) * 10000),
    missingTop100,
    missingInAurora: subgraphById.size - intersection,
    extraInAurora: auroraById.size - intersection,
    tvlDriftBpsP50: Math.round(tvlDriftBpsP50),
    missingSample: topTvlSample(subgraphById.values(), auroraById),
    extraSample: topTvlSample(auroraById.values(), subgraphById),
    driftSample,
  };
}

// Ids per diagnostic sample in the parity result/log — enough to classify a
// gap against the DB by hand, small enough to keep the log line bounded.
const SAMPLE_SIZE = 5;

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
    // 0 = no absolute floor for this target (ratio guard only).
    private readonly minPoolCount: number,
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
      } else if (this.minPoolCount > 0 && pools.length < this.minPoolCount) {
        // Absolute floor: unlike the ratio guard it holds on the FIRST tick
        // after a process start (in-memory baseline is empty then), so a
        // mass-inadmission result can't be served or become the baseline.
        fallbackReason = 'below_floor';
        this.logger.warn(
          `Aurora pool count ${pools.length} below absolute floor ${this.minPoolCount}`
        );
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
          `tvlDriftBpsP50=${parity.tvlDriftBpsP50}`,
        {
          missingInAurora: parity.missingInAurora,
          extraInAurora: parity.extraInAurora,
          missingSample: parity.missingSample,
          extraSample: parity.extraSample,
          driftSample: parity.driftSample,
        }
      );
      // Raw getPools parity over-counts: the serving path drops
      // non-servable pools (non-allowlisted custom-accounting hooks etc.)
      // in v4HooksPoolsFiltering AFTER this seam, so a subgraph pool that
      // would never serve inflates missingInAurora. Diff the sets the way
      // serving would actually see them — same filter, no-op observability
      // so the genuine cachePools run's filter metrics stay untouched.
      if (this.protocol === Protocol.V4) {
        const dynamicZlcaHookMap = getDynamicZlcaHooks(this.chainId);
        const dynamicHooks = dynamicZlcaHookMap
          ? new Set(dynamicZlcaHookMap.keys())
          : undefined;
        const servableSubgraph = v4HooksPoolsFiltering(
          this.chainId as SdkChainId,
          [...(subgraphPools as unknown as V4SubgraphPool[])],
          NOOP_LOGGER,
          NOOP_METRIC,
          dynamicHooks
        );
        const servableAurora = v4HooksPoolsFiltering(
          this.chainId as SdkChainId,
          [...(auroraPools as unknown as V4SubgraphPool[])],
          NOOP_LOGGER,
          NOOP_METRIC,
          dynamicHooks
        );
        const servable = computePoolParity(servableSubgraph, servableAurora);
        this.metric.putMetric(
          'CachePools.parity.servable_missing',
          servable.missingInAurora,
          MetricLoggerUnit.Count,
          this.tags
        );
        this.metric.putMetric(
          'CachePools.parity.servable_extra',
          servable.extraInAurora,
          MetricLoggerUnit.Count,
          this.tags
        );
        this.metric.putMetric(
          'CachePools.parity.servable_jaccard_bps',
          servable.jaccardBps,
          MetricLoggerUnit.None,
          this.tags
        );
        this.logger.info(
          `Aurora servable parity ${targetKey(this.chainId, this.protocol)}: ` +
            `subgraph=${servable.subgraphCount} aurora=${servable.auroraCount} ` +
            `jaccardBps=${servable.jaccardBps} missingTop100=${servable.missingTop100} ` +
            `tvlDriftBpsP50=${servable.tvlDriftBpsP50}`,
          {
            missingInAurora: servable.missingInAurora,
            extraInAurora: servable.extraInAurora,
            missingSample: servable.missingSample,
            extraSample: servable.extraSample,
            driftSample: servable.driftSample,
          }
        );
      }
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
      config.minPoolCountByTarget.get(targetKey(chainId, protocol)) ?? 0,
      logger,
      metric
    );
    logger.info(
      `Aurora pool source enabled (${mode}) for ${targetKey(chainId, protocol)}`
    );
  }
}
