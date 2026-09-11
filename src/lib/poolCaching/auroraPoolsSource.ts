/**
 * Aurora-backed pool source for the pool-caching cron (subgraph → Aurora
 * migration). Replaces SubgraphProvider.getPools() behind env-flagged
 * targets; everything downstream of getPools() (hooks filtering, S3 snapshot
 * format, serving path) is unchanged.
 *
 * SCOPE: hard-limited to the cron's V4 + V3 matrix (except Base and Ink;
 * AURORA_SUPPORTED_TARGETS). Env
 * targets outside the allowlist are ignored with a metric, so even a `*`
 * flag cannot enable other chains/protocols without a code change.
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
  getPermissionedAdapterTokens,
  getPermissionedHookAddresses,
} from '@uniswap/lib-sharedconfig/permissionedTokens';
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
import {getMajorTokens} from './util/majorTokens';
import {v4HooksPoolsFiltering} from './util/v4HooksPoolsFiltering';
import {ChainId as SdkChainId} from '@uniswap/sdk-core';
import {Logger} from './sor-providers/util/log';
import {IMetric, MetricLoggerUnit} from './sor-providers/util/metric';
import {ARBITRUM} from '../../stores/chain/hardcoded/chains/Arbitrum';
import {ARC} from '../../stores/chain/hardcoded/chains/Arc';
import {AVALANCHE} from '../../stores/chain/hardcoded/chains/Avalanche';
import {BNB} from '../../stores/chain/hardcoded/chains/BNB';
import {BLAST} from '../../stores/chain/hardcoded/chains/Blast';
import {CELO} from '../../stores/chain/hardcoded/chains/Celo';
import {LINEA} from '../../stores/chain/hardcoded/chains/Linea';
import {MAINNET} from '../../stores/chain/hardcoded/chains/Mainnet';
import {MEGAETH} from '../../stores/chain/hardcoded/chains/MegaEth';
import {MONAD} from '../../stores/chain/hardcoded/chains/Monad';
import {OPTIMISM} from '../../stores/chain/hardcoded/chains/Optimism';
import {POLYGON} from '../../stores/chain/hardcoded/chains/Polygon';
import {ROBINHOOD} from '../../stores/chain/hardcoded/chains/Robinhood';
import {SEPOLIA} from '../../stores/chain/hardcoded/chains/Sepolia';
import {SONEIUM} from '../../stores/chain/hardcoded/chains/Soneium';
import {TEMPO} from '../../stores/chain/hardcoded/chains/Tempo';
import {UNICHAIN} from '../../stores/chain/hardcoded/chains/Unichain';
import {WORLDCHAIN} from '../../stores/chain/hardcoded/chains/WorldChain';
import {XLAYER} from '../../stores/chain/hardcoded/chains/XLayer';
import {ZORA} from '../../stores/chain/hardcoded/chains/Zora';

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

// The hardcoded chain objects are side-effect-free definitions. Keep this
// static collection local rather than constructing a repository, whose shared
// registry overlays are unnecessary for the wrapped-native lookup.
const HARD_CODED_CHAINS = [
  ARBITRUM,
  ARC,
  AVALANCHE,
  BNB,
  BLAST,
  CELO,
  LINEA,
  MAINNET,
  MEGAETH,
  MONAD,
  OPTIMISM,
  POLYGON,
  ROBINHOOD,
  SEPOLIA,
  SONEIUM,
  TEMPO,
  UNICHAIN,
  WORLDCHAIN,
  XLAYER,
  ZORA,
];

// Registry-derived wrapped-native addresses are lowercased for Aurora's
// canonical-token keys. A missing entry still fails only that combo at init.
export const WRAPPED_NATIVE_BY_CHAIN: ReadonlyMap<number, string> = new Map(
  HARD_CODED_CHAINS.map(chain => [
    chain.chainId,
    chain.wrappedNativeToken.lowerCased,
  ])
);

// USDG (Global Dollar) on Robinhood — the chain's dominant stable quote asset.
const USDG_ON_ROBINHOOD = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';

// Quote assets whose fresh USD price may be propagated one hop through a
// pool's own spot price to value the OTHER side when it has no price row
// (implied in-pool pricing — the analog of the subgraph's derivedETH, which
// is what admits fresh launchpad pools the pricing pipeline hasn't covered
// yet). Restricting the propagation SOURCE to these chain quote assets
// mirrors the subgraph's whitelist concept: a meme priced off another meme's
// pool must not mint implied TVL. Per-chain opt-in requires verifying that
// chain's deployed subgraph whitelist and minimumNativeLocked semantics; new
// chains intentionally launch without it and shadow parity decides if needed.
export const IMPLIED_PRICE_SOURCE_TOKENS_BY_CHAIN: {
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
    WRAPPED_NATIVE_BY_CHAIN.get(CHAIN_ID_ROBINHOOD)!,
    USDG_ON_ROBINHOOD,
  ]),
};

// Per-pool ceiling (in native units) on the implied top-up. 1 ETH is 100×
// the tracked-ETH admission threshold (0.01) — far more than admission needs
// — while keeping spot-derived phantom TVL from out-ranking genuinely liquid
// pools in TopPools selection (council review finding on #11463).
const IMPLIED_TVL_TOPUP_CAP_ETH = 1;

// This mirrors createChainProtocols' V3/V4 matrix. Base's 15.2M-row full
// fetch needs SQL admission pushdown first; Ink has no Aurora pool rows yet.
// Keep V2 out of this source even though it remains in the cron matrix.
const AURORA_CHAIN_IDS_BY_PROTOCOL: ReadonlyArray<
  readonly [Protocol, readonly number[]]
> = [
  [
    Protocol.V3,
    [
      1, 42161, 137, 10, 42220, 56, 43114, 81457, 130, 480, 7777777, 1868, 143,
      4217, 196, 59144, 4326, 4663, 5042,
    ],
  ],
  [
    Protocol.V4,
    [
      11155111, 42161, 137, 480, 7777777, 130, 81457, 1, 1868, 10, 56, 143,
      4217, 196, 43114, 42220, 59144, 4326, 4663, 5042,
    ],
  ],
];

export const AURORA_SUPPORTED_TARGETS: ReadonlySet<string> = new Set(
  AURORA_CHAIN_IDS_BY_PROTOCOL.flatMap(([protocol, chainIds]) =>
    chainIds.map(chainId => targetKey(chainId, protocol))
  )
);

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
  // without an entry are never served in primary mode. An entry (or the whole
  // env) that failed to parse also downgrades to shadow — same fail-closed
  // outcome as an absent entry — but under a distinct misconfiguration metric
  // so a typo stays distinguishable from a deliberate absence.
  minPoolCountByTarget: ReadonlyMap<string, number>;
  minPoolCountFloorInvalidKeys: ReadonlySet<string>;
  minPoolCountFloorUnparseable: boolean;
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
export function parseMinPoolCountByTarget(raw: string | undefined): {
  byTarget: ReadonlyMap<string, number>;
  // Targets whose ENTRY existed but had a malformed value. Behaviorally an
  // invalid entry downgrades the target to shadow exactly like an absent one
  // (fail closed — a floorless primary is unprotected on the first
  // post-deploy tick), but it is tracked separately so a typo stays
  // distinguishable from a deliberate absence in metrics/alerting. Kept
  // per-key so one bad entry cannot affect any OTHER target
  // (security-gate finding on #12440).
  invalidKeys: ReadonlySet<string>;
  // The whole env failed to parse (bad JSON / non-object): key names are
  // unknowable, so every primary target is treated as invalid-entry.
  unparseable: boolean;
} {
  const byTarget = new Map<string, number>();
  const invalidKeys = new Set<string>();
  if (!raw || raw.trim() === '') {
    return {byTarget, invalidKeys, unparseable: false};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {byTarget, invalidKeys, unparseable: true};
  }
  // Arrays pass the object check but read as {"0": value, ...} — index keys
  // would land primary targets in primary_without_floor instead of
  // primary_floor_config_invalid, and #12443's monitor keys off that
  // distinction. Same fail-closed outcome either way; keep the metric honest.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {byTarget, invalidKeys, unparseable: true};
  }
  for (const [key, value] of Object.entries(parsed)) {
    const floor = Number(value);
    if (Number.isFinite(floor) && floor > 0) {
      byTarget.set(key.trim().toUpperCase(), Math.floor(floor));
    } else {
      invalidKeys.add(key.trim().toUpperCase());
    }
  }
  return {byTarget, invalidKeys, unparseable: false};
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
  const floorConfig = parseMinPoolCountByTarget(
    process.env.POOL_CACHING_AURORA_MIN_POOL_COUNT_BY_TARGET
  );
  const parsedRatio = ratioRaw ? Number(ratioRaw) : NaN;
  return {
    shadowTargets: parseTargets(shadowRaw),
    primaryTargets: parseTargets(primaryRaw),
    minPoolCountRatio:
      Number.isFinite(parsedRatio) && parsedRatio > 0 && parsedRatio <= 1
        ? parsedRatio
        : 0.5,
    minPoolCountByTarget: floorConfig.byTarget,
    minPoolCountFloorInvalidKeys: floorConfig.invalidKeys,
    minPoolCountFloorUnparseable: floorConfig.unparseable,
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

export function resolveAuroraModeWithPrimaryFloor(
  config: AuroraPoolsSourceConfig,
  chainId: number,
  protocol: Protocol,
  logger: Logger,
  metric: IMetric
): AuroraTargetMode | undefined {
  const mode = resolveAuroraMode(config, chainId, protocol);
  const key = targetKey(chainId, protocol);
  if (mode !== 'primary' || config.minPoolCountByTarget.has(key)) return mode;
  if (
    config.minPoolCountFloorUnparseable ||
    config.minPoolCountFloorInvalidKeys.has(key)
  ) {
    // FAIL CLOSED (review round on #12440): a primary target whose floor
    // entry (or the whole env) failed to parse downgrades to shadow, same
    // as an absent entry. Keeping primary here would drop the exact
    // protection the floor exists for — the first tick after a deploy,
    // where the ratio guard has no baseline. The cost of the downgrade is
    // one deploy cycle of freshness; the distinct metric below keeps a typo
    // distinguishable from a deliberate absence for the #12443 monitor.
    logger.warn(
      `Aurora pool source primary_floor_config_invalid for ${key} — downgrading to shadow`
    );
    metric.putMetric(
      'CachePools.aurora.primary_floor_config_invalid',
      1,
      MetricLoggerUnit.Count,
      {chainId: String(chainId), protocol: String(protocol)}
    );
    return 'shadow';
  }
  logger.warn(
    `Aurora pool source primary_without_floor for ${key} — downgrading to shadow`
  );
  metric.putMetric(
    'CachePools.aurora.primary_without_floor',
    1,
    MetricLoggerUnit.Count,
    {chainId: String(chainId), protocol: String(protocol)}
  );
  return 'shadow';
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

// Env + TLS recipe shared by every uniroute Aurora consumer (cron pool
// source here, token-metadata serving pool in stores/token). Pool tuning is
// deliberately NOT part of it — each consumer's sizing/timeouts are its own
// decision, but credentials and hostname-verification rules must never fork.
export function unirouteAuroraConnectionOptionsFromEnv(logger: {
  warn: (message: string) => void;
}):
  | {
      host: string;
      database: string;
      user: string;
      password: string;
      ssl: NonNullable<
        Parameters<typeof createDataIngestionAuroraKysely>[0]['ssl']
      >;
    }
  | undefined {
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

  return {host, database, user, password, ssl};
}

export function createUnirouteAuroraDbFromEnv(
  logger: Logger
): Kysely<DataIngestionAuroraDB> | undefined {
  const connection = unirouteAuroraConnectionOptionsFromEnv(logger);
  if (!connection) return undefined;

  return createDataIngestionAuroraKysely({
    ...connection,
    // The all-chains sweep is batch=50, while the two-minute Robinhood job
    // must still acquire a connection. The fetch limiter below uses three
    // slots and each provider holds at most ONE connection inside its slot
    // (price + list ride the same slot), so one of these four connections is
    // genuinely always free for the scoped fast job. Checkout should
    // therefore be near-immediate: 30s is a safety margin that still fails
    // fast relative to the 2-minute fast-job cadence (the previous 120s
    // could stall a whole fast tick — security-gate finding on #12440).
    max: 4,
    connectionTimeoutMillis: 30_000,
    // Full-set query measured 1.8s prod / 7.1s dev (~127k rows); 30s bounds a
    // hung scan so it can't pin a reader connection across cron ticks (the
    // cron's withTimeout detaches, it doesn't cancel).
    statementTimeoutMillis: 30_000,
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

// --- Aurora providers (per-protocol) ---

export interface AuroraProviderDeps<
  TListMethod extends keyof RoutablePoolsService = 'listAllV4RoutablePools',
> {
  // Narrowed to the single list method each provider consumes, so fakes and
  // each per-protocol provider depend only on their own slice of the lib
  // interface.
  routablePools: Pick<RoutablePoolsService, TListMethod>;
  prices: CurrentTokenPricesService;
  logger: Logger;
  metric: IMetric;
  // Absent on scoped runs (the 2-minute Robinhood job caches 1-2 combos and
  // must never queue behind the all-chains sweep — the pool holds a spare
  // connection precisely for it). Set to the shared semaphore on the sweep.
  fetchSemaphore?: AsyncSemaphore;
}

// poolCachingBatchSize is 50 but Aurora's shared Kysely pool is deliberately
// small. Limit full-set reads to three, below the pool's four connections, so
// Robinhood's fast job keeps a checkout even during the all-chains sweep.
export class AsyncSemaphore {
  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly concurrency: number) {}

  async acquire(): Promise<() => void> {
    if (this.inFlight < this.concurrency) {
      this.inFlight++;
    } else {
      await new Promise<void>(resolve => this.waiters.push(resolve));
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.inFlight--;
    };
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await work();
    } finally {
      release();
    }
  }
}

// Shared by every sweep-time Aurora full-set read — the per-combo pool
// fetches AND the V4 PoolKey registry materialization (which runs on the
// sweep off the same singleton pool; unslotted it could take the 4th
// connection and starve the fast Robinhood job, review round on #12440).
// Scoped fast-job runs bypass it entirely (fetchSemaphore left unset).
export const AURORA_FETCH_SEMAPHORE = new AsyncSemaphore(3);

export interface AuroraV4AdmissionDeps {
  permissionedHookAddresses(chainId: number): Iterable<string>;
  permissionedAdapterTokens(chainId: number): Iterable<string>;
  majorTokens(chainId: number): Iterable<string>;
}

const DEFAULT_V4_ADMISSION_DEPS: AuroraV4AdmissionDeps = {
  permissionedHookAddresses: getPermissionedHookAddresses,
  permissionedAdapterTokens: getPermissionedAdapterTokens,
  majorTokens: getMajorTokens,
};

// A wrapped-native price older than this cannot be used for the floor/tvlETH
// conversion. Matches the lib's DEFAULT_PRICE_STALENESS_SECONDS used for the
// per-side TVL joins, so both freshness gates move together.
const NATIVE_PRICE_MAX_STALENESS_MS = 24 * 60 * 60 * 1000;

abstract class BaseAuroraPoolsProvider<
  TListMethod extends keyof RoutablePoolsService,
> {
  constructor(
    protected readonly chainId: number,
    protected readonly trackedEthThreshold: number,
    protected readonly deps: AuroraProviderDeps<TListMethod>
  ) {}

  protected withFetchSlot<T>(work: () => Promise<T>): Promise<T> {
    const semaphore = this.deps.fetchSemaphore;
    return semaphore ? semaphore.run(work) : work();
  }

  // USD price of the chain's wrapped-native token: converts the ETH-denominated
  // TVL floors into USD and Aurora's USD TVL back into tvlETH, so the
  // serve-side TrackedEthThreshold filters keep working unchanged.
  protected async nativeUsdPrice(ctx: Context): Promise<number> {
    const wrappedNative = WRAPPED_NATIVE_BY_CHAIN.get(this.chainId);
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
}

export class AuroraV4PoolsProvider
  extends BaseAuroraPoolsProvider<'listAllV4RoutablePools'>
  implements ISubgraphProvider<V4SubgraphPool>
{
  constructor(
    chainId: number,
    trackedEthThreshold: number,
    deps: AuroraProviderDeps<'listAllV4RoutablePools'>,
    private readonly admissionDeps: AuroraV4AdmissionDeps = DEFAULT_V4_ADMISSION_DEPS
  ) {
    super(chainId, trackedEthThreshold, deps);
  }

  async getPools(): Promise<V4SubgraphPool[]> {
    const ctx = auroraContext(this.deps.metric);
    // Fetch the FULL set (floor 0) and replicate the subgraph V4 admission
    // union in TS below — a single SQL floor would drop pools the subgraph
    // path includes (the [V4_MIN_TVL_ETH, trackedEthThreshold) high-liquidity
    // band and the zero-TVL bypass-hook pools). The native-price lookup rides
    // the SAME fetch slot: a provider must hold at most one pool connection
    // at a time, or dozens of concurrent price queries would drain the pool
    // outside the semaphore's control (security-gate finding on #12440).
    const {nativePrice, pools} = await this.withFetchSlot(async () => ({
      nativePrice: await this.nativeUsdPrice(ctx),
      pools: await this.deps.routablePools.listAllV4RoutablePools(ctx, {
        chainId: this.chainId as ExtendedChainId,
        minTvlUsd: 0,
      }),
    }));

    // Subgraph V4 admission = union of four query families
    // (sor-providers/subgraphProvider.ts getPools):
    //   (a) tvlETH > trackedEthThreshold
    //   (b) liquidity > 0 AND tvlETH > V4_MIN_TVL_ETH
    //   (c) hooks ∈ TVL-bypass registries (no floor)
    //   (d) permissioned hook + bounded adapter/known-token pair (no floor)
    const bypassHooks = new Set(
      [...(getTvlBypassHookAddresses(this.chainId) ?? [])].map(hook =>
        hook.toLowerCase()
      )
    );
    // Build these once per fetch to keep every row comparison bounded and
    // normalized. Permissioned pairs need an adapter endpoint; a major/major
    // pool under a public hook is not an owned, finite admission family.
    const permissionedHooks = new Set(
      [...this.admissionDeps.permissionedHookAddresses(this.chainId)].map(
        hook => hook.toLowerCase()
      )
    );
    const permissionedAdapters = new Set(
      [...this.admissionDeps.permissionedAdapterTokens(this.chainId)].map(
        token => token.toLowerCase()
      )
    );
    const permissionedKnownTokens = new Set([
      ...permissionedAdapters,
      ...[...this.admissionDeps.majorTokens(this.chainId)].map(token =>
        token.toLowerCase()
      ),
    ]);
    const canonicalFees = new Set([100, 500, 3000, 10000]);
    const canonicalTickSpacings = new Set([1, 10, 60, 200]);
    type V4AdmissionFamily =
      | 'threshold'
      | 'liquidity_band'
      | 'bypass_hook'
      | 'permissioned';
    const admissionFamily = (
      tvlEth: number,
      liquidity: string,
      hooks: string,
      token0: string,
      token1: string,
      feeBips: number,
      tickSpacing: number
    ): V4AdmissionFamily | undefined => {
      if (tvlEth > this.trackedEthThreshold) return 'threshold';
      if (parsePositiveLiquidity(liquidity) && tvlEth > V4_MIN_TVL_ETH) {
        return 'liquidity_band';
      }
      if (bypassHooks.has(hooks)) return 'bypass_hook';
      const token0IsAdapter = permissionedAdapters.has(token0);
      const token1IsAdapter = permissionedAdapters.has(token1);
      if (
        parsePositiveLiquidity(liquidity) &&
        permissionedHooks.has(hooks) &&
        canonicalFees.has(feeBips) &&
        canonicalTickSpacings.has(tickSpacing) &&
        ((token0IsAdapter && permissionedKnownTokens.has(token1)) ||
          (token1IsAdapter && permissionedKnownTokens.has(token0)))
      ) {
        return 'permissioned';
      }
      return undefined;
    };

    const impliedSourceTokens =
      IMPLIED_PRICE_SOURCE_TOKENS_BY_CHAIN[this.chainId];
    const result: V4SubgraphPool[] = [];
    let droppedNullDecimals = 0;
    const admittedByFamily: Record<V4AdmissionFamily, number> = {
      threshold: 0,
      liquidity_band: 0,
      bypass_hook: 0,
      permissioned: 0,
    };
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
      const token0 = pool.token0Address.toLowerCase();
      const token1 = pool.token1Address.toLowerCase();
      // SQL tvlUsd counts only sides with a fresh price row. Fresh launchpad
      // tokens have none, so their pools (whole token supply vs a near-empty
      // quote side) would compute ≈$0 and fail admission even though the
      // subgraph admits them via derivedETH — top the TVL up with the
      // in-pool implied value of the unpriced side.
      const rawImpliedUsd = impliedOneHopTvlUsd(pool, impliedSourceTokens);
      if (rawImpliedUsd > impliedTopUpCapUsd) impliedCapped++;
      const impliedUsd = Math.min(rawImpliedUsd, impliedTopUpCapUsd);
      const tvlUsd = pool.tvlUsd + impliedUsd;
      // On non-ETH-native chains, the historical ETH-named thresholds are
      // native-unit thresholds: subgraph derivedETH is derivedNative there.
      const tvlEth = tvlUsd / nativePrice;
      const family = admissionFamily(
        tvlEth,
        pool.liquidity,
        hooks,
        token0,
        token1,
        pool.feeBips,
        pool.tickSpacing
      );
      if (!family) continue;
      admittedByFamily[family]++;
      // Count only admission FLIPS — pools rescued by the top-up, not every
      // pool where the code path fired. This is the number the shadow
      // readout compares against the missing-pool gap.
      if (
        impliedUsd > 0 &&
        !admissionFamily(
          pool.tvlUsd / nativePrice,
          pool.liquidity,
          hooks,
          token0,
          token1,
          pool.feeBips,
          pool.tickSpacing
        )
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
          id: token0,
          symbol: pool.token0Symbol ?? undefined,
          name: pool.token0Name ?? undefined,
          decimals: String(pool.token0Decimals),
        },
        token1: {
          id: token1,
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
    for (const [family, count] of Object.entries(admittedByFamily)) {
      this.deps.metric.putMetric(
        'CachePools.aurora.admitted_by_family',
        count,
        MetricLoggerUnit.Count,
        {chainId: String(this.chainId), protocol: String(Protocol.V4), family}
      );
    }
    return result;
  }
}

// V3 analog: same fetch-full-set + TS admission replication, mirroring the
// V3 subgraph query families (sor-providers/subgraphProvider.ts getPools):
//   (a) tvlETH > trackedEthThreshold
//   (b) liquidity > 0 AND tvlETH == 0 ("V3 zero ETH pools": live liquidity
//       the subgraph cannot value in tracked terms — an EXACT-zero match,
//       not V4's (V4_MIN_TVL_ETH, threshold] band)
// No hook families, and V3SubgraphPool carries no token decimals/symbols, so
// null-decimals pools are kept (implied pricing just contributes 0 for them).
export class AuroraV3PoolsProvider
  extends BaseAuroraPoolsProvider<'listAllV3RoutablePools'>
  implements ISubgraphProvider<V3SubgraphPool>
{
  async getPools(): Promise<V3SubgraphPool[]> {
    const ctx = auroraContext(this.deps.metric);
    // Price lookup inside the fetch slot for the same one-connection-per-
    // provider invariant as V4.
    const {nativePrice, pools} = await this.withFetchSlot(async () => ({
      nativePrice: await this.nativeUsdPrice(ctx),
      pools: await this.deps.routablePools.listAllV3RoutablePools(ctx, {
        chainId: this.chainId as ExtendedChainId,
        minTvlUsd: 0,
      }),
    }));

    const impliedSourceTokens =
      IMPLIED_PRICE_SOURCE_TOKENS_BY_CHAIN[this.chainId];
    const impliedTopUpCapUsd = IMPLIED_TVL_TOPUP_CAP_ETH * nativePrice;
    const result: V3SubgraphPool[] = [];
    let impliedPriced = 0;
    let impliedCapped = 0;
    const admittedByFamily = {threshold: 0, exact_zero: 0};
    for (const pool of pools) {
      const rawImpliedUsd = impliedOneHopTvlUsd(pool, impliedSourceTokens);
      if (rawImpliedUsd > impliedTopUpCapUsd) impliedCapped++;
      const impliedUsd = Math.min(rawImpliedUsd, impliedTopUpCapUsd);
      const tvlUsd = pool.tvlUsd + impliedUsd;
      // On non-ETH-native chains, the historical ETH-named thresholds are
      // native-unit thresholds: subgraph derivedETH is derivedNative there.
      const tvlEth = tvlUsd / nativePrice;
      // Family (b) is judged on the RAW priced-side TVL (pre-top-up): it
      // mirrors the subgraph's exact `totalValueLockedETH: "0"` — the cohort
      // the pricing pipeline can't see. The top-up only feeds family (a).
      const admissionFamily = (tvlEthForThreshold: number) => {
        if (tvlEthForThreshold > this.trackedEthThreshold) return 'threshold';
        if (parsePositiveLiquidity(pool.liquidity) && pool.tvlUsd === 0) {
          return 'exact_zero';
        }
        return undefined;
      };
      const family = admissionFamily(tvlEth);
      if (!family) continue;
      admittedByFamily[family]++;
      // Count only admission FLIPS (rescued by the top-up), matching V4.
      if (impliedUsd > 0 && !admissionFamily(pool.tvlUsd / nativePrice)) {
        impliedPriced++;
      }
      result.push({
        id: pool.poolAddress.toLowerCase(),
        feeTier: String(pool.feeTier),
        liquidity: pool.liquidity,
        token0: {id: pool.token0Address.toLowerCase()},
        token1: {id: pool.token1Address.toLowerCase()},
        tvlETH: tvlEth,
        tvlUSD: tvlUsd,
      });
    }
    if (impliedPriced > 0) {
      this.deps.metric.putMetric(
        'CachePools.aurora.implied_priced',
        impliedPriced,
        MetricLoggerUnit.Count,
        {chainId: String(this.chainId), protocol: String(Protocol.V3)}
      );
    }
    if (impliedCapped > 0) {
      this.deps.metric.putMetric(
        'CachePools.aurora.implied_capped',
        impliedCapped,
        MetricLoggerUnit.Count,
        {chainId: String(this.chainId), protocol: String(Protocol.V3)}
      );
    }
    for (const [family, count] of Object.entries(admittedByFamily)) {
      this.deps.metric.putMetric(
        'CachePools.aurora.admitted_by_family',
        count,
        MetricLoggerUnit.Count,
        {chainId: String(this.chainId), protocol: String(Protocol.V3), family}
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
// Structural slice shared by V4RoutablePool and V3RoutablePool — the implied
// one-hop math is protocol-agnostic (both carry sqrtPriceX96 + raw reserves).
export type ImpliedPricingPool = Pick<
  V4RoutablePool,
  | 'token0Address'
  | 'token1Address'
  | 'sqrtPriceX96'
  | 'tvlToken0'
  | 'tvlToken1'
  | 'token0PriceUsd'
  | 'token1PriceUsd'
  | 'token0Decimals'
  | 'token1Decimals'
>;

export function impliedOneHopTvlUsd(
  pool: ImpliedPricingPool,
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
  metric: IMetric,
  options?: {
    // True for 'only'-filtered runs (the fast Robinhood job): their one or
    // two fetches bypass the sweep's fetch semaphore and ride the spare pool
    // connection instead of queueing FIFO behind ~40 sweep fetches.
    scopedRun?: boolean;
  }
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

  const deps: AuroraProviderDeps<keyof RoutablePoolsService> = {
    routablePools: createAuroraRoutablePoolsService(db, 'uniroute'),
    prices: createAuroraCurrentTokenPricesService(db, 'uniroute'),
    logger,
    metric,
    fetchSemaphore: options?.scopedRun ? undefined : AURORA_FETCH_SEMAPHORE,
  };

  for (const chainProtocol of chainProtocols) {
    const {chainId, protocol} = chainProtocol;
    const mode = resolveAuroraModeWithPrimaryFloor(
      config,
      chainId,
      protocol,
      logger,
      metric
    );
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

    // Per-protocol provider dispatch. A combo added to
    // AURORA_SUPPORTED_TARGETS must have a protocol-shaped provider branch
    // here — never map one protocol's pools through another's row shape.
    if (protocol === Protocol.V4) {
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
    } else if (protocol === Protocol.V3) {
      chainProtocol.provider = new AuroraSourcedProvider(
        mode,
        new AuroraV3PoolsProvider(
          chainId,
          thresholds.trackedEthThresholdFor(protocol, chainId),
          deps
        ),
        chainProtocol.provider as ISubgraphProvider<V3SubgraphPool>,
        chainId,
        protocol,
        config.minPoolCountRatio,
        config.minPoolCountByTarget.get(targetKey(chainId, protocol)) ?? 0,
        logger,
        metric
      );
    } else {
      logger.warn(
        `Aurora pool source targeted for ${targetKey(chainId, protocol)} but no Aurora provider exists for ${String(protocol)} — staying on subgraph`
      );
      metric.putMetric(
        'CachePools.aurora.unsupported_target',
        1,
        MetricLoggerUnit.Count,
        {chainId: String(chainId), protocol: String(protocol)}
      );
      continue;
    }
    logger.info(
      `Aurora pool source enabled (${mode}) for ${targetKey(chainId, protocol)}`
    );
  }
}
