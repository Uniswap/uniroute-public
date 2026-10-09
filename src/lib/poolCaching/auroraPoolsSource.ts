/**
 * Aurora-backed pool source for the pool-caching cron (subgraph → Aurora
 * migration). Replaces SubgraphProvider.getPools() behind env-flagged
 * targets; everything downstream of getPools() (hooks filtering, S3 snapshot
 * format, serving path) is unchanged.
 *
 * SCOPE: hard-limited to the cron's V2 + V3 + V4 matrix (except Base, Ink,
 * and Monad testnet;
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
import {
  createAddress,
  toExtendedChainId,
  type ExtendedChainId,
} from '@uniswap/lib-data-api';
import {
  getPermissionedAdapterTokens,
  getPermissionedHookAddresses,
} from '@uniswap/lib-sharedconfig/permissionedTokens';
import {
  MAX_POOL_VOLUME_IDENTIFIERS_PER_STATEMENT,
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
import {BASE} from '../../stores/chain/hardcoded/chains/Base';
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
  BASE,
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

// This mirrors createChainProtocols' V2/V3/V4 matrix. Base V3 and V4 (1.9M
// and 15.4M rows) need SQL admission pushdown first; Ink and Monad testnet
// have no Aurora pool rows yet. Unichain V2 and Base V2 need their per-combo
// pre-filter because their full reads exceed the cron's 30s statement
// timeout.
const AURORA_CHAIN_IDS_BY_PROTOCOL: ReadonlyArray<
  readonly [Protocol, readonly number[]]
> = [
  [
    Protocol.V2,
    [
      1, 42161, 137, 10, 56, 43114, 81457, 130, 480, 1868, 143, 4217, 196,
      59144, 4326, 4663, 5042, 8453,
    ],
  ],
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

// V2 combos whose full read exceeds the statement timeout. They are read
// only with the pre-filter; without it they stay on the subgraph.
const V2_TARGETS_REQUIRING_PREFILTER: ReadonlySet<string> = new Set([
  '130:V2',
  '8453:V2',
]);

// The cut targets empty and dust spam pairs, which are almost all of
// Unichain's and Base's V2 pairs (Base: 42k of 3.07M pairs hold $1 or more
// in pool_stats). On an ETH-native chain such as these, tracked V2 admission needs
// over 0.025 native, far above $1. On a chain whose native token is cheap,
// that admission floor can sit below $1, and pool_stats can undervalue a
// pair on any chain. So each combo's shadow parity must measure coverage
// before it is listed, and before it serves from this lossy read.
const V2_PREFILTER_MIN_POOL_STATS_TVL_USD = 1;
const V2_FEI_TOKEN = '0x956f47f50a910163d8bf957cf5846d573e7f87ca';
const V2_BASE_VIRTUAL_TOKEN = '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b';

function v2PrefilterAlwaysIncludeTokens(chainId: number): readonly string[] {
  return chainId === SdkChainId.BASE
    ? [V2_FEI_TOKEN, V2_BASE_VIRTUAL_TOKEN]
    : [V2_FEI_TOKEN];
}

export const AURORA_SUPPORTED_TARGETS: ReadonlySet<string> = new Set(
  AURORA_CHAIN_IDS_BY_PROTOCOL.flatMap(([protocol, chainIds]) =>
    chainIds.map(chainId => targetKey(chainId, protocol))
  )
);

// --- Config ---

export type AuroraTargetMode = 'shadow' | 'primary';

// Why a `*` in the guard targets was rejected: the environment says prod, or
// no environment source is set at all.
export type TvlGuardWildcardRejection =
  | 'wildcard_in_prod'
  | 'wildcard_unknown_environment';

export interface AuroraPoolsSourceConfig {
  // 'all' (env value "*") or a set of `${chainId}:${PROTOCOL}` keys.
  shadowTargets: 'all' | ReadonlySet<string>;
  primaryTargets: 'all' | ReadonlySet<string>;
  tvlGuardTargets: 'all' | ReadonlySet<string>;
  v2PrefilterTargets: ReadonlySet<string>;
  // A lossy pre-filter requires explicit per-combo selection.
  v2PrefilterWildcardIgnored: boolean;
  // Prod enables the guard per combo after its shadow soak; rejecting `*`
  // keeps an all-combo typo in shadow everywhere and makes it observable.
  tvlGuardTargetsWildcardRejection: TvlGuardWildcardRejection | undefined;
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
export function auroraPoolsSourceConfigFromEnv(
  environments: readonly (string | undefined)[] = [
    process.env.DD_ENV,
    process.env.ENVIRONMENT,
    process.env.ENV,
  ]
): AuroraPoolsSourceConfig | undefined {
  const shadowRaw = process.env.POOL_CACHING_AURORA_SHADOW_TARGETS;
  const primaryRaw = process.env.POOL_CACHING_AURORA_PRIMARY_TARGETS;
  if (!shadowRaw && !primaryRaw) return undefined;

  const ratioRaw = process.env.POOL_CACHING_AURORA_MIN_POOL_COUNT_RATIO;
  const floorConfig = parseMinPoolCountByTarget(
    process.env.POOL_CACHING_AURORA_MIN_POOL_COUNT_BY_TARGET
  );
  const parsedRatio = ratioRaw ? Number(ratioRaw) : NaN;
  const tvlGuardRaw = process.env.POOL_CACHING_AURORA_TVL_GUARD_TARGETS;
  const parsedTvlGuardTargets = tvlGuardRaw
    ?.split(',')
    .some(entry => entry.trim() === '*')
    ? 'all'
    : parseTargets(tvlGuardRaw);
  const v2PrefilterRaw = process.env.POOL_CACHING_AURORA_V2_PREFILTER_TARGETS;
  const parsedV2PrefilterTargets = parseTargets(v2PrefilterRaw);
  const v2PrefilterWildcardIgnored =
    parsedV2PrefilterTargets === 'all' || parsedV2PrefilterTargets.has('*');
  const v2PrefilterTargets =
    parsedV2PrefilterTargets === 'all'
      ? new Set<string>()
      : new Set([...parsedV2PrefilterTargets].filter(key => key !== '*'));
  const setEnvironments = environments
    .map(value => value?.trim().toLowerCase())
    .filter((value): value is string => Boolean(value));
  // This safety gate keeps a wildcard in shadow when the environment is
  // unknown or any source says prod, including conflicting env values.
  const tvlGuardTargetsWildcardRejection:
    | TvlGuardWildcardRejection
    | undefined =
    parsedTvlGuardTargets !== 'all'
      ? undefined
      : setEnvironments.includes('prod')
        ? 'wildcard_in_prod'
        : setEnvironments.length === 0
          ? 'wildcard_unknown_environment'
          : undefined;
  return {
    shadowTargets: parseTargets(shadowRaw),
    primaryTargets: parseTargets(primaryRaw),
    tvlGuardTargets: tvlGuardTargetsWildcardRejection
      ? new Set()
      : parsedTvlGuardTargets,
    v2PrefilterTargets,
    v2PrefilterWildcardIgnored,
    tvlGuardTargetsWildcardRejection,
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

// Server-side statement_timeout for the cron's Aurora reads. The default
// bounds a hung scan so it can't pin a reader connection across cron ticks
// (the cron's withTimeout detaches, it doesn't cancel): a full-set query
// measured 1.8s prod / 7.1s dev at ~127k rows, so the largest supported
// fetches (~1M rows: mainnet V2, Unichain V2) fit the default in prod but
// not on the slower dev reader. The ceiling keeps any override under the
// Robinhood fast job's 110s budget (POOL_CACHING_ROBINHOOD_V4_JOB_TIMEOUT_MS),
// not merely its two-minute cadence: withTimeout detaches rather than
// cancels, so a statement still running at the ceiling must have released
// the fast job's one spare pool connection before that job's next tick can
// need it.
const DEFAULT_POOL_CACHING_AURORA_STATEMENT_TIMEOUT_MS = 30_000;
const MIN_POOL_CACHING_AURORA_STATEMENT_TIMEOUT_MS = 5_000;
const MAX_POOL_CACHING_AURORA_STATEMENT_TIMEOUT_MS = 100_000;

// Absent → default. A present value that is not an integer inside the bounds
// is refused with a warn and the default applies: like the other pool-source
// env knobs, a typo must degrade this one setting, not take the whole Aurora
// source down.
export function poolCachingAuroraStatementTimeoutMsFromEnv(logger: {
  warn: (message: string) => void;
}): number {
  const raw = process.env.POOL_CACHING_AURORA_STATEMENT_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_POOL_CACHING_AURORA_STATEMENT_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  if (
    !Number.isInteger(parsed) ||
    parsed < MIN_POOL_CACHING_AURORA_STATEMENT_TIMEOUT_MS ||
    parsed > MAX_POOL_CACHING_AURORA_STATEMENT_TIMEOUT_MS
  ) {
    logger.warn(
      `POOL_CACHING_AURORA_STATEMENT_TIMEOUT_MS must be an integer in [${MIN_POOL_CACHING_AURORA_STATEMENT_TIMEOUT_MS}, ${MAX_POOL_CACHING_AURORA_STATEMENT_TIMEOUT_MS}] ms, got "${raw}" — using ${DEFAULT_POOL_CACHING_AURORA_STATEMENT_TIMEOUT_MS}`
    );
    return DEFAULT_POOL_CACHING_AURORA_STATEMENT_TIMEOUT_MS;
  }
  return parsed;
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
    statementTimeoutMillis: poolCachingAuroraStatementTimeoutMsFromEnv(logger),
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
  routablePools: Pick<
    RoutablePoolsService,
    TListMethod | 'batchGetPoolVolumeUsd30d'
  >;
  prices: CurrentTokenPricesService;
  logger: Logger;
  metric: IMetric;
  // Absent on scoped runs (the 2-minute Robinhood job caches 1-2 combos and
  // must never queue behind the all-chains sweep — the pool holds a spare
  // connection precisely for it). Set to the shared semaphore on the sweep.
  fetchSemaphore?: FetchSlots;
  // Test seam; production stays within the lib's one-statement 5,000-ID chunk.
  volumeLookupMaxPools?: number;
}

type AuroraPoolListMethod =
  | 'listAllV2RoutablePools'
  | 'listAllV3RoutablePools'
  | 'listAllV4RoutablePools';

export interface FetchSlots {
  run<T>(work: () => Promise<T>): Promise<T>;
}

// poolCachingBatchSize is 50 but Aurora's shared Kysely pool is deliberately
// small. Limit full-set reads to three, below the pool's four connections, so
// Robinhood's fast job keeps a checkout even during the all-chains sweep.
// A freed slot goes to the oldest normal waiter first; low-priority waiters
// only get a slot when no normal waiter is queued.
export class AsyncSemaphore implements FetchSlots {
  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly lowPriorityWaiters: Array<() => void> = [];

  constructor(private readonly concurrency: number) {}

  async acquire(lowPriority = false): Promise<() => void> {
    if (this.inFlight < this.concurrency) {
      this.inFlight++;
    } else {
      const queue = lowPriority ? this.lowPriorityWaiters : this.waiters;
      await new Promise<void>(resolve => queue.push(resolve));
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift() ?? this.lowPriorityWaiters.shift();
      if (next) next();
      else this.inFlight--;
    };
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    return this.runAcquired(await this.acquire(), work);
  }

  /** The same slots, queued behind every normal-priority waiter. */
  lowPriority(): FetchSlots {
    return {
      run: async work => this.runAcquired(await this.acquire(true), work),
    };
  }

  private async runAcquired<T>(
    release: () => void,
    work: () => Promise<T>
  ): Promise<T> {
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

// Shadow comparisons settle after their cron job has returned, so a sweep's
// shadow reads can still be queued when the registry step, or the next
// sweep's primary reads, need a slot. Low priority lets those go first.
const AURORA_SHADOW_FETCH_SLOTS = AURORA_FETCH_SEMAPHORE.lowPriority();

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

// Real pools can turn their liquidity over many times in a month. Credit a
// fraction of swap volume: crediting all of it would let wash-traded junk
// return near the top of the ranking.
const TVL_GUARD_VOLUME_CREDIT_RATIO = 0.1;
// One lib statement's worth, so the volume read stays a single bounded
// statement under the statement timeout.
const TVL_GUARD_VOLUME_LOOKUP_MAX_POOLS =
  MAX_POOL_VOLUME_IDENTIFIERS_PER_STATEMENT;

function volumeCreditedTvlUsd(
  raw: number,
  guarded: number,
  volumeUsd30d: number | undefined
): number {
  if (volumeUsd30d === undefined || !Number.isFinite(volumeUsd30d)) {
    return guarded;
  }
  return Math.max(
    guarded,
    Math.min(raw, TVL_GUARD_VOLUME_CREDIT_RATIO * Math.max(0, volumeUsd30d))
  );
}

abstract class BaseAuroraPoolsProvider<
  TListMethod extends keyof RoutablePoolsService,
> {
  constructor(
    protected readonly chainId: number,
    protected readonly trackedEthThreshold: number,
    protected readonly deps: AuroraProviderDeps<TListMethod>,
    protected readonly applyTvlGuard = false
  ) {
    const maxPools = deps.volumeLookupMaxPools;
    if (
      maxPools !== undefined &&
      (!Number.isSafeInteger(maxPools) ||
        maxPools < 1 ||
        maxPools > TVL_GUARD_VOLUME_LOOKUP_MAX_POOLS)
    ) {
      throw new Error('Invalid Aurora volume lookup pool cap');
    }
  }

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

  // The guard's cap for this fetch: at least the USD constant, and always
  // above this provider's native-unit admission floor.
  protected tvlGuardCapUsd(nativePrice: number): number {
    return Math.max(
      UNANCHORED_ONE_SIDE_TVL_CAP_USD,
      GUARD_ADMISSION_FLOOR_MARGIN * this.trackedEthThreshold * nativePrice
    );
  }

  protected async poolVolumesForCapped(
    ctx: Context,
    protocol: 'v2' | 'v3' | 'v4',
    identifiers: readonly string[]
  ): Promise<ReadonlyMap<string, number>> {
    if (identifiers.length === 0) return new Map();
    try {
      return await this.withFetchSlot(() =>
        this.deps.routablePools.batchGetPoolVolumeUsd30d(ctx, {
          chainId: toExtendedChainId(this.chainId),
          protocol,
          poolIdentifiers: identifiers,
        })
      );
    } catch (error) {
      void this.deps.metric.putMetric(
        'CachePools.aurora.tvl_guard_volume_error',
        1,
        MetricLoggerUnit.Count,
        {chainId: String(this.chainId), protocol: protocol.toUpperCase()}
      );
      this.deps.logger.warn(
        `Aurora TVL guard volume read failed: ${error instanceof Error ? error.name : 'UnknownError'}`
      );
      return new Map();
    }
  }

  protected volumesForGuardCappedPools<TRow>(
    ctx: Context,
    protocol: 'v2' | 'v3' | 'v4',
    rows: readonly TRow[],
    toGuardInput: (row: TRow) => TvlGuardInput,
    identifierOf: (row: TRow) => string,
    anchorTokens: ReadonlySet<string> | undefined,
    capUsd: number
  ): Promise<ReadonlyMap<string, number>> {
    const capped = rows
      .map(row => ({input: toGuardInput(row), identifier: identifierOf(row)}))
      .filter(
        ({input}) =>
          guardPricedTvlUsd(input, anchorTokens, capUsd).tvlUsd < input.tvlUsd
      )
      .sort(
        (left, right) =>
          right.input.tvlUsd - left.input.tvlUsd ||
          (left.identifier < right.identifier
            ? -1
            : left.identifier > right.identifier
              ? 1
              : 0)
      );
    const maxPools =
      this.deps.volumeLookupMaxPools ?? TVL_GUARD_VOLUME_LOOKUP_MAX_POOLS;
    const truncated = capped.length - maxPools;
    if (truncated > 0) {
      this.deps.metric.putMetric(
        'CachePools.aurora.tvl_guard_volume_truncated',
        truncated,
        MetricLoggerUnit.Count,
        {chainId: String(this.chainId), protocol: protocol.toUpperCase()}
      );
    }
    // Only pools near the top of the raw ranking can win a top-N slot, so
    // credit them first; the cap keeps the volume read to one bounded statement.
    return this.poolVolumesForCapped(
      ctx,
      protocol,
      capped.slice(0, maxPools).map(({identifier}) => identifier)
    );
  }

  protected emitVolumeCredited(protocol: Protocol, count: number): void {
    if (count === 0) return;
    this.deps.metric.putMetric(
      'CachePools.aurora.tvl_guard_volume_credited',
      count,
      MetricLoggerUnit.Count,
      {
        chainId: String(this.chainId),
        protocol: String(protocol),
        applied: String(this.applyTvlGuard),
      }
    );
  }

  // One count per guard reason that fired this fetch; a chain without anchor
  // tokens also reports that its one-side check was skipped.
  protected emitTvlGuarded(
    protocol: Protocol,
    guardedByReason: Record<TvlGuardReason, number>,
    trustedBothAnchor: number,
    anchorTokens: ReadonlySet<string> | undefined,
    rankedPools: Array<{id: string; raw: number; guarded: number}>
  ): void {
    for (const [reason, count] of Object.entries(guardedByReason)) {
      if (count === 0) continue;
      this.deps.metric.putMetric(
        'CachePools.aurora.tvl_guarded',
        count,
        MetricLoggerUnit.Count,
        {
          chainId: String(this.chainId),
          protocol: String(protocol),
          reason,
          applied: String(this.applyTvlGuard),
        }
      );
    }
    if (trustedBothAnchor > 0) {
      this.deps.metric.putMetric(
        'CachePools.aurora.tvl_guard_trusted',
        trustedBothAnchor,
        MetricLoggerUnit.Count,
        {
          chainId: String(this.chainId),
          protocol: String(protocol),
          reason: 'both_anchor',
          applied: String(this.applyTvlGuard),
        }
      );
    }
    if (Object.values(guardedByReason).some(count => count > 0)) {
      const topIds = (value: 'raw' | 'guarded') =>
        new Set(
          [...rankedPools]
            // TopPoolsSelector keeps provider order when ranked values tie.
            .sort((a, b) => b[value] - a[value])
            .slice(0, 100)
            .map(pool => pool.id)
        );
      const rawTop = topIds('raw');
      const guardedTop = topIds('guarded');
      const displaced = [...rawTop].filter(id => !guardedTop.has(id)).length;
      this.deps.metric.putMetric(
        'CachePools.aurora.tvl_guard_top100_displaced',
        displaced,
        MetricLoggerUnit.Count,
        {
          chainId: String(this.chainId),
          protocol: String(protocol),
          applied: String(this.applyTvlGuard),
        }
      );
    }
    if (anchorTokens === undefined) {
      this.deps.metric.putMetric(
        'CachePools.aurora.tvl_guard_skipped',
        1,
        MetricLoggerUnit.Count,
        {
          chainId: String(this.chainId),
          protocol: String(protocol),
          reason: 'no_anchor_tokens',
        }
      );
    }
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
    private readonly admissionDeps: AuroraV4AdmissionDeps = DEFAULT_V4_ADMISSION_DEPS,
    applyTvlGuard = false
  ) {
    super(chainId, trackedEthThreshold, deps, applyTvlGuard);
  }

  async getPools(): Promise<V4SubgraphPool[]> {
    const ctx = auroraContext(this.deps.metric);
    const bypassHooks = new Set(
      [...(getTvlBypassHookAddresses(this.chainId) ?? [])].map(hook =>
        hook.toLowerCase()
      )
    );
    const permissionedHooks = new Set(
      [...this.admissionDeps.permissionedHookAddresses(this.chainId)].map(
        hook => hook.toLowerCase()
      )
    );
    // The read stays unfloored on TVL: a SQL floor would drop the
    // [V4_MIN_TVL_ETH, trackedEthThreshold) liquidity band and pools the
    // implied top-up admits. It skips pools with nothing locked on either
    // side, which no TVL-based family below can admit, and keeps the bypass
    // and permissioned hooks, whose families need no TVL. On launchpad chains
    // a large share of pools hold nothing, and reading them all can approach
    // the statement timeout.
    //
    // The native-price lookup rides the SAME fetch slot: a provider must hold
    // at most one pool connection at a time, or dozens of concurrent price
    // queries would drain the pool outside the semaphore's control
    // (security-gate finding on #12440).
    const {nativePrice, pools} = await this.withFetchSlot(async () => ({
      nativePrice: await this.nativeUsdPrice(ctx),
      pools: await this.deps.routablePools.listAllV4RoutablePools(ctx, {
        chainId: this.chainId as ExtendedChainId,
        minTvlUsd: 0,
        lockedAmountPrefilter: {
          alwaysIncludeHooks: [...bypassHooks, ...permissionedHooks],
        },
      }),
    }));

    // Subgraph V4 admission = union of four query families
    // (sor-providers/subgraphProvider.ts getPools):
    //   (a) tvlETH > trackedEthThreshold
    //   (b) liquidity > 0 AND tvlETH > V4_MIN_TVL_ETH
    //   (c) hooks ∈ TVL-bypass registries (no floor)
    //   (d) permissioned hook + bounded adapter/known-token pair (no floor)
    // Build these once per fetch to keep every row comparison bounded and
    // normalized. Permissioned pairs need an adapter endpoint; a major/major
    // pool under a public hook is not an owned, finite admission family.
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
    const rankedPools: Array<{id: string; raw: number; guarded: number}> = [];
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
    const anchorTokens = tvlGuardAnchorTokens(this.chainId, chainId =>
      this.admissionDeps.majorTokens(chainId)
    );
    const capUsd = this.tvlGuardCapUsd(nativePrice);
    const guardedByReason: Record<TvlGuardReason, number> = {
      side_imbalance: 0,
      unanchored_one_side: 0,
    };
    let trustedBothAnchor = 0;
    const volumeByPool = await this.volumesForGuardCappedPools(
      ctx,
      'v4',
      pools,
      pool => ({...pool, amount0: pool.tvlToken0, amount1: pool.tvlToken1}),
      pool => pool.poolId,
      anchorTokens,
      capUsd
    );
    let volumeCredited = 0;
    for (const pool of pools) {
      const hooks = (pool.hooksAddress ?? ZERO_ADDRESS).toLowerCase();
      const token0 = pool.token0Address.toLowerCase();
      const token1 = pool.token1Address.toLowerCase();
      // The guard bounds the priced-side TVL first; the implied top-up then
      // values an unpriced side on top of it, under its own cap.
      const guarded = guardPricedTvlUsd(
        {...pool, amount0: pool.tvlToken0, amount1: pool.tvlToken1},
        anchorTokens,
        capUsd
      );
      if (guarded.reason) guardedByReason[guarded.reason]++;
      if (guarded.trusted === 'both_anchor') trustedBothAnchor++;
      const creditedPricedUsd = volumeCreditedTvlUsd(
        pool.tvlUsd,
        guarded.tvlUsd,
        volumeByPool.get(pool.poolId)
      );
      if (creditedPricedUsd > guarded.tvlUsd) volumeCredited++;
      // SQL tvlUsd counts only sides with a fresh price row. Fresh launchpad
      // tokens have none, so their pools (whole token supply vs a near-empty
      // quote side) would compute ≈$0 and fail admission even though the
      // subgraph admits them via derivedETH — top the TVL up with the
      // in-pool implied value of the unpriced side.
      const rawImpliedUsd = impliedOneHopTvlUsd(pool, impliedSourceTokens);
      if (rawImpliedUsd > impliedTopUpCapUsd) impliedCapped++;
      const impliedUsd = Math.min(rawImpliedUsd, impliedTopUpCapUsd);
      const rawTvlUsd = pool.tvlUsd + impliedUsd;
      const guardedTvlUsd = creditedPricedUsd + impliedUsd;
      const tvlUsd = this.applyTvlGuard ? guardedTvlUsd : rawTvlUsd;
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
          (this.applyTvlGuard ? creditedPricedUsd : pool.tvlUsd) / nativePrice,
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
      rankedPools.push({
        id: pool.poolId.toLowerCase(),
        raw: rawTvlUsd,
        guarded: guardedTvlUsd,
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
    this.emitVolumeCredited(Protocol.V4, volumeCredited);
    this.emitTvlGuarded(
      Protocol.V4,
      guardedByReason,
      trustedBothAnchor,
      anchorTokens,
      rankedPools
    );
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
  constructor(
    chainId: number,
    trackedEthThreshold: number,
    deps: AuroraProviderDeps<'listAllV3RoutablePools'>,
    applyTvlGuard = false
  ) {
    super(chainId, trackedEthThreshold, deps, applyTvlGuard);
  }

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
    const rankedPools: Array<{id: string; raw: number; guarded: number}> = [];
    let impliedPriced = 0;
    let impliedCapped = 0;
    const admittedByFamily = {threshold: 0, exact_zero: 0};
    const anchorTokens = tvlGuardAnchorTokens(this.chainId);
    const capUsd = this.tvlGuardCapUsd(nativePrice);
    const guardedByReason: Record<TvlGuardReason, number> = {
      side_imbalance: 0,
      unanchored_one_side: 0,
    };
    let trustedBothAnchor = 0;
    const volumeByPool = await this.volumesForGuardCappedPools(
      ctx,
      'v3',
      pools,
      pool => ({...pool, amount0: pool.tvlToken0, amount1: pool.tvlToken1}),
      pool => pool.poolAddress,
      anchorTokens,
      capUsd
    );
    let volumeCredited = 0;
    for (const pool of pools) {
      // Same order as V4: guard the priced-side TVL, then add the capped
      // implied top-up for an unpriced side.
      const guarded = guardPricedTvlUsd(
        {...pool, amount0: pool.tvlToken0, amount1: pool.tvlToken1},
        anchorTokens,
        capUsd
      );
      if (guarded.reason) guardedByReason[guarded.reason]++;
      if (guarded.trusted === 'both_anchor') trustedBothAnchor++;
      const creditedPricedUsd = volumeCreditedTvlUsd(
        pool.tvlUsd,
        guarded.tvlUsd,
        volumeByPool.get(pool.poolAddress)
      );
      if (creditedPricedUsd > guarded.tvlUsd) volumeCredited++;
      const rawImpliedUsd = impliedOneHopTvlUsd(pool, impliedSourceTokens);
      if (rawImpliedUsd > impliedTopUpCapUsd) impliedCapped++;
      const impliedUsd = Math.min(rawImpliedUsd, impliedTopUpCapUsd);
      const rawTvlUsd = pool.tvlUsd + impliedUsd;
      const guardedTvlUsd = creditedPricedUsd + impliedUsd;
      const tvlUsd = this.applyTvlGuard ? guardedTvlUsd : rawTvlUsd;
      // On non-ETH-native chains, the historical ETH-named thresholds are
      // native-unit thresholds: subgraph derivedETH is derivedNative there.
      const tvlEth = tvlUsd / nativePrice;
      // Family (b) is judged on the RAW priced-side TVL (pre-guard,
      // pre-top-up): it mirrors the subgraph's exact `totalValueLockedETH: "0"`
      // — the cohort the pricing pipeline can't see. A pool the guard
      // collapses had a nonzero raw TVL, so it does not re-enter here. The
      // top-up only feeds family (a).
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
      if (
        impliedUsd > 0 &&
        !admissionFamily(
          (this.applyTvlGuard ? creditedPricedUsd : pool.tvlUsd) / nativePrice
        )
      ) {
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
      rankedPools.push({
        id: pool.poolAddress.toLowerCase(),
        raw: rawTvlUsd,
        guarded: guardedTvlUsd,
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
    this.emitVolumeCredited(Protocol.V3, volumeCredited);
    this.emitTvlGuarded(
      Protocol.V3,
      guardedByReason,
      trustedBothAnchor,
      anchorTokens,
      rankedPools
    );
    return result;
  }
}

// V2 mirrors V2SubgraphProvider's four query families in their original
// priority order. Aurora prices both reserve sides, which is the closest
// equivalent to the subgraph's tracked reserve; shadow parity per chain is
// the judge of any remaining divergence.
export class AuroraV2PoolsProvider
  extends BaseAuroraPoolsProvider<'listAllV2RoutablePools'>
  implements ISubgraphProvider<V2SubgraphPool>
{
  constructor(
    chainId: number,
    trackedEthThreshold: number,
    private readonly untrackedUsdThreshold: number,
    deps: AuroraProviderDeps<'listAllV2RoutablePools'>,
    applyTvlGuard = false,
    private readonly poolStatsPrefilter:
      | {minPoolStatsTvlUsd: number; alwaysIncludeTokens: readonly string[]}
      | undefined = undefined
  ) {
    super(chainId, trackedEthThreshold, deps, applyTvlGuard);
  }

  async getPools(): Promise<V2SubgraphPool[]> {
    const ctx = auroraContext(this.deps.metric);
    // Price lookup inside the fetch slot for the same one-connection-per-
    // provider invariant as V4/V3.
    const {nativePrice, pools} = await this.withFetchSlot(async () => ({
      nativePrice: await this.nativeUsdPrice(ctx),
      pools: await this.deps.routablePools.listAllV2RoutablePools(ctx, {
        chainId: this.chainId as ExtendedChainId,
        minTvlUsd: 0,
        ...(this.poolStatsPrefilter
          ? {poolStatsPrefilter: this.poolStatsPrefilter}
          : {}),
      }),
    }));

    type V2AdmissionFamily =
      | 'fei'
      | 'virtual'
      | 'tracked_reserve'
      | 'untracked_usd';
    const admittedByFamily: Record<V2AdmissionFamily, number> = {
      fei: 0,
      virtual: 0,
      tracked_reserve: 0,
      untracked_usd: 0,
    };
    const result: V2SubgraphPool[] = [];
    const rankedPools: Array<{id: string; raw: number; guarded: number}> = [];
    let impliedStaleSide = 0;
    const anchorTokens = tvlGuardAnchorTokens(this.chainId);
    const capUsd = this.tvlGuardCapUsd(nativePrice);
    const guardedByReason: Record<TvlGuardReason, number> = {
      side_imbalance: 0,
      unanchored_one_side: 0,
    };
    let trustedBothAnchor = 0;
    const volumeByPool = await this.volumesForGuardCappedPools(
      ctx,
      'v2',
      pools,
      pool => ({...pool, amount0: pool.reserve0, amount1: pool.reserve1}),
      pool => pool.pairAddress,
      anchorTokens,
      capUsd
    );
    let volumeCredited = 0;
    for (const pool of pools) {
      const token0 = pool.token0Address.toLowerCase();
      const token1 = pool.token1Address.toLowerCase();
      const guarded = guardPricedTvlUsd(
        {...pool, amount0: pool.reserve0, amount1: pool.reserve1},
        anchorTokens,
        capUsd
      );
      if (guarded.reason) guardedByReason[guarded.reason]++;
      if (guarded.trusted === 'both_anchor') trustedBothAnchor++;
      const creditedPricedUsd = volumeCreditedTvlUsd(
        pool.tvlUsd,
        guarded.tvlUsd,
        volumeByPool.get(pool.pairAddress)
      );
      if (creditedPricedUsd > guarded.tvlUsd) volumeCredited++;
      const pricedTvlUsd = this.applyTvlGuard ? creditedPricedUsd : pool.tvlUsd;
      // The V2 subgraph carries two TVL numbers and V2SubgraphProvider uses
      // each for one job. trackedReserveETH DOUBLES the tracked side when only
      // one side is whitelisted (both sides of a constant-product pair are
      // value-equal at spot); it gates the tracked family and becomes
      // `reserve`. reserveUSD is the untracked per-side sum with no doubling;
      // it gates the untracked family and becomes `reserveUSD`, the field
      // TopPoolsSelector ranks across protocols. Aurora's analog of
      // "whitelisted" is "has a fresh price row": both sides priced → the sum
      // is already two-sided; one side priced → double it for the tracked
      // number only; neither → 0. Exporting the doubled value as reserveUSD
      // ranked one-side-priced V2 pools ~2x against V3/V4, whose TVL is a
      // priced-side sum on both sources.
      const bothSidesPriced =
        pool.token0PriceUsd !== null && pool.token1PriceUsd !== null;
      const oneSidePriced =
        pool.token0PriceUsd !== null || pool.token1PriceUsd !== null;
      const trackedUsd = bothSidesPriced
        ? pricedTvlUsd
        : oneSidePriced
          ? 2 * pricedTvlUsd
          : 0;
      const tvlNative = trackedUsd / nativePrice;
      // A side whose token went idle has a price row older than the
      // freshness window, so Aurora prices it at 0 while the subgraph keeps
      // its last derived price and counts it in reserveUSD. Both sides of a
      // constant-product pair hold equal value at spot, so value that side at
      // the fresh side's USD value. A token with no price row at all stays at
      // 0: the subgraph cannot price it either, so its reserveUSD is the
      // one-sided sum. The tracked number above already doubles every
      // one-sided pool, so only the untracked number changes. The equal-value
      // argument needs a nonzero reserve on the idle side: a side drained to 0
      // holds nothing, whatever its old price row says.
      const staleSideImplied =
        (pool.token0PriceUsd !== null &&
          pool.token1PriceUsd === null &&
          pool.token1HasStalePrice &&
          parsePositiveLiquidity(pool.reserve1)) ||
        (pool.token1PriceUsd !== null &&
          pool.token0PriceUsd === null &&
          pool.token0HasStalePrice &&
          parsePositiveLiquidity(pool.reserve0));
      // One rule for the served value and both guard-metric values, so the
      // shadow metrics rank exactly what would be served.
      const reserveUsdOf = (pricedUsd: number) =>
        staleSideImplied ? 2 * pricedUsd : pricedUsd;
      const untrackedUsd = reserveUsdOf(pricedTvlUsd);
      const rawReserveUsd = reserveUsdOf(pool.tvlUsd);
      const guardedReserveUsd = reserveUsdOf(creditedPricedUsd);
      let family: V2AdmissionFamily | undefined;
      if (token0 === V2_FEI_TOKEN || token1 === V2_FEI_TOKEN) {
        family = 'fei';
      } else if (
        this.chainId === SdkChainId.BASE &&
        (token0 === V2_BASE_VIRTUAL_TOKEN || token1 === V2_BASE_VIRTUAL_TOKEN)
      ) {
        family = 'virtual';
      } else if (tvlNative > this.trackedEthThreshold) {
        family = 'tracked_reserve';
      } else if (untrackedUsd > this.untrackedUsdThreshold) {
        family = 'untracked_usd';
      }
      if (!family) continue;
      admittedByFamily[family]++;
      if (staleSideImplied) impliedStaleSide++;
      result.push({
        id: pool.pairAddress.toLowerCase(),
        token0: {id: token0},
        token1: {id: token1},
        // V2 LP tokens are always 18 decimals. This is only the snapshot's
        // optional serve-side fallback, so a floating representation is fine —
        // and Number() (unlike BigInt()) cannot throw on an unexpected numeric
        // serialization, so one malformed row cannot fail the whole fetch.
        supply: Number(pool.totalSupply) / 1e18,
        reserve: tvlNative,
        reserveUSD: untrackedUsd,
      });
      rankedPools.push({
        id: pool.pairAddress.toLowerCase(),
        raw: rawReserveUsd,
        guarded: guardedReserveUsd,
      });
    }
    for (const [family, count] of Object.entries(admittedByFamily)) {
      this.deps.metric.putMetric(
        'CachePools.aurora.admitted_by_family',
        count,
        MetricLoggerUnit.Count,
        {chainId: String(this.chainId), protocol: String(Protocol.V2), family}
      );
    }
    if (impliedStaleSide > 0) {
      this.deps.metric.putMetric(
        'CachePools.aurora.implied_stale_side',
        impliedStaleSide,
        MetricLoggerUnit.Count,
        {chainId: String(this.chainId), protocol: String(Protocol.V2)}
      );
    }
    this.emitVolumeCredited(Protocol.V2, volumeCredited);
    this.emitTvlGuarded(
      Protocol.V2,
      guardedByReason,
      trustedBothAnchor,
      anchorTokens,
      rankedPools
    );
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

// --- Junk-price TVL guard ---

// A pool's priced-side TVL may be at most this many times its smaller priced
// side, plus that side. Prod `current_token_prices` carries fresh but absurd
// prices for junk tokens, and a pool pairing one with a near-empty real side
// reads as billions (Polygon V3 WPOL/"BTC" $5.7B, Arc V3 USDC/"USDC" $27.6B).
// Measured on prod, legitimately imbalanced pools sit well inside 10:1
// (wstETH/USDC.e 6.2:1, VELO/WETH 2.6:1).
const MAX_PRICED_SIDE_VALUE_RATIO = 10;

// A side worth less than this cannot corroborate the other side's price, so
// the guard treats it as unpriced. An empty real side (0 WPOL, or 0 WETH in a
// single-sided launch pool) then takes the one-side rule instead of an
// imbalance cap of about $0, which would drop the pool from the snapshot.
const MIN_PRICED_SIDE_USD = 1;

// Ceiling for a pool with exactly one priced side when that side is not an
// anchor token: the price is the only evidence, and nothing in the pool can
// corroborate it. Also the floor of the imbalance cap. USD rather than native
// units, because a native-denominated cap collapses to cents on cheap-native
// chains (1 CELO is about $0.3). About 1 ETH, far below the top-N pools it
// would otherwise displace. Providers raise it when their native-unit
// admission floor is higher (tvlGuardCapUsd).
const UNANCHORED_ONE_SIDE_TVL_CAP_USD = 2500;

// Admission uses a strict > against trackedEthThreshold in native units, so
// the cap must sit above that floor. A USD constant alone stops doing so if
// an erroneous fresh native price is very high.
const GUARD_ADMISSION_FLOOR_MARGIN = 2;

export type TvlGuardReason = 'side_imbalance' | 'unanchored_one_side';

export type TvlGuardInput = {
  token0Address: string;
  token1Address: string;
  // Raw base-unit amounts (divide by 10^decimals).
  amount0: string;
  amount1: string;
  token0PriceUsd: number | null;
  token1PriceUsd: number | null;
  token0Decimals: number | null;
  token1Decimals: number | null;
  // Priced-side TVL as the SQL computed it.
  tvlUsd: number;
};

// The guard trusts an anchor's fresh price outright. Each address must be
// the canonical token holding the chain's real liquidity for that symbol,
// never a same-symbol look-alike (Polygon canonical_tokens has many fake
// "USDT" entries).
export const TVL_GUARD_EXTRA_ANCHOR_TOKENS_BY_CHAIN: {
  [chainId: number]: ReadonlySet<string>;
} = {
  [SdkChainId.OPTIMISM]: new Set([
    '0xd4dd9e2f021bb459d5a5f6c24c12fe09c5d45553', // ZCHF (Frankencoin)
  ]),
  [SdkChainId.POLYGON]: new Set([
    '0xc2132d05d31c914a87c6611c10748aeb04b58e8f', // USDT0
  ]),
  [SdkChainId.CELO]: new Set([
    '0xd8763cba276a3738e6de85b4b3bf5fded6d6ca73', // EURm (Mento Euro)
    '0xe8537a3d056da446677b9e9d6c5db704eaab4787', // BRLm (Mento Brazilian Real)
    '0x456a3d042c0dbd3db53d5489e98dfb038553b0d0', // KESm (Mento Kenyan Shilling)
  ]),
};

/**
 * Tokens whose fresh price the guard trusts on its own: the chain's major
 * tokens (`getMajorTokens`), canonical guard-only anchors, its wrapped native
 * and the zero address. Returns undefined when the chain has neither majors
 * nor guard-only anchors; the guard then skips only its one-side check.
 */
export function tvlGuardAnchorTokens(
  chainId: number,
  majorTokens: (chainId: number) => Iterable<string> = getMajorTokens
): ReadonlySet<string> | undefined {
  const majors = [...majorTokens(chainId)].map(token => token.toLowerCase());
  const extras = TVL_GUARD_EXTRA_ANCHOR_TOKENS_BY_CHAIN[chainId];
  if (majors.length === 0 && !extras?.size) return undefined;
  const wrappedNative = WRAPPED_NATIVE_BY_CHAIN.get(chainId);
  return new Set([
    ...majors,
    ...[...(extras ?? [])].map(token => token.toLowerCase()),
    ZERO_ADDRESS,
    ...(wrappedNative ? [wrappedNative] : []),
  ]);
}

/**
 * Bounds the raw SQL priced-side TVL when applied; callers also run this in
 * shadow to measure its effect while serving raw TVL.
 *
 * A side counts as priced only when its computed value is at least $1. With
 * two priced sides, trust the raw TVL when both tokens are anchors: two
 * trusted prices can describe a real out-of-range pool. Report that trust
 * when raw TVL exceeds the imbalance threshold. Otherwise cap raw
 * TVL at eleven times the smaller side, but never below min(raw TVL, capUsd).
 * With one priced side, cap at capUsd only when anchor tokens are known and
 * that side is not an anchor. With neither side priced, leave raw TVL
 * unchanged. Report a reason only when TVL falls.
 *
 * A malformed or non-finite side counts as $0. Providers set capUsd to at
 * least $2,500 and above their native-unit admission floor, so a guard cannot
 * drop a pool admitted by that floor.
 */
export function guardPricedTvlUsd(
  pool: TvlGuardInput,
  anchorTokens: ReadonlySet<string> | undefined,
  capUsd: number
): {
  tvlUsd: number;
  reason: TvlGuardReason | undefined;
  trusted?: 'both_anchor';
} {
  const sideUsd = (
    amount: string,
    decimals: number | null,
    priceUsd: number | null
  ): number | undefined => {
    if (priceUsd === null || decimals === null) return undefined;
    const value = (Number(amount) / 10 ** decimals) * priceUsd;
    return Number.isFinite(value) && value > 0 ? value : 0;
  };
  const usd0 = sideUsd(pool.amount0, pool.token0Decimals, pool.token0PriceUsd);
  const usd1 = sideUsd(pool.amount1, pool.token1Decimals, pool.token1PriceUsd);

  const priced0 = usd0 !== undefined && usd0 >= MIN_PRICED_SIDE_USD;
  const priced1 = usd1 !== undefined && usd1 >= MIN_PRICED_SIDE_USD;
  if (priced0 && priced1) {
    if (
      anchorTokens?.has(pool.token0Address.toLowerCase()) &&
      anchorTokens.has(pool.token1Address.toLowerCase())
    ) {
      return pool.tvlUsd >
        (1 + MAX_PRICED_SIDE_VALUE_RATIO) * Math.min(usd0, usd1)
        ? {tvlUsd: pool.tvlUsd, reason: undefined, trusted: 'both_anchor'}
        : {tvlUsd: pool.tvlUsd, reason: undefined};
    }
    const cap = Math.max(
      (1 + MAX_PRICED_SIDE_VALUE_RATIO) * Math.min(usd0, usd1),
      Math.min(pool.tvlUsd, capUsd)
    );
    return pool.tvlUsd > cap
      ? {tvlUsd: cap, reason: 'side_imbalance'}
      : {tvlUsd: pool.tvlUsd, reason: undefined};
  }
  const pricedToken = priced0
    ? pool.token0Address
    : priced1
      ? pool.token1Address
      : undefined;
  if (
    pricedToken !== undefined &&
    anchorTokens !== undefined &&
    !anchorTokens.has(pricedToken.toLowerCase()) &&
    pool.tvlUsd > capUsd
  ) {
    return {
      tvlUsd: capUsd,
      reason: 'unanchored_one_side',
    };
  }
  return {tvlUsd: pool.tvlUsd, reason: undefined};
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
  // missingTop100 over the subgraph pools that hold liquidity. The subgraph
  // keeps reporting TVL for pools emptied long ago and ranks them by it, so
  // missingTop100 also counts pools with nothing to route through. V2 pools
  // carry no liquidity field and all count as live, and so do pools of a
  // TVL-bypass hook, whose liquidity sits outside the PoolManager and reads 0
  // however much the hook holds.
  // Blind spots: `liquidity` is in-range liquidity, so a pool whose positions
  // are all out of range counts as not live even when it holds two-sided
  // value, and a pool drained to dust stays live. missingTop100 keeps the
  // unfiltered view next to it.
  missingTop100Live: number;
  // The pools behind missingTop100Live (at most 100), lowercase, in subgraph
  // TVL order. A flip gate values every one, so unlike the samples below it
  // is not truncated.
  missingTop100LiveIds: string[];
  missingInAurora: number;
  extraInAurora: number;
  // The reverse of missingTop100: how many of Aurora's top 100 pools by TVL
  // the subgraph set does not contain. missingTop100 cannot see a pool that
  // only Aurora admits, so a junk-priced Aurora-only pool at the top of the
  // ranking leaves it at 0. Blind spot: a pool both sources hold but that
  // Aurora ranks far higher (a mispriced shared pool) counts in neither.
  extraTop100: number;
  tvlDriftBpsP50: number;
  // tvlDriftBpsP50 over the matched pools in the subgraph's top 100 by TVL.
  // On a chain with a large long tail, dust pools set the full median, so it
  // says little about the pools that ranking picks. Blind spots: it ranks by
  // the subgraph's TVL, so a pool Aurora alone ranks high is not in it (see
  // extraTop100). Undefined when no top-100 pool has a drift sample (no
  // match, or a subgraph TVL of 0), so an empty sample never reads as parity.
  tvlDriftBpsTop100P50: number | undefined;
  // Diagnostic samples so a parity gap is classifiable from logs alone:
  // top-TVL pool ids the subgraph has but Aurora lacks / vice versa, and
  // median-drift matched pools with both TVLs (id:subgraphTvl:auroraTvl).
  missingSample: string[];
  missingLiveSample: string[];
  extraSample: string[];
  driftSample: string[];
}

function holdsLiquidity(
  pool: AnySubgraphPool,
  tvlBypassHooks: ReadonlySet<string> | undefined
): boolean {
  if ('hooks' in pool && tvlBypassHooks?.has(pool.hooks.toLowerCase())) {
    return true;
  }
  return 'liquidity' in pool ? parsePositiveLiquidity(pool.liquidity) : true;
}

export function computePoolParity(
  subgraphPools: AnySubgraphPool[],
  auroraPools: AnySubgraphPool[],
  tvlBypassHooks: ReadonlySet<string> | undefined
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

  const subgraphByTvlDesc = [...subgraphById.values()].sort(
    (a, b) => poolTvlUsd(b) - poolTvlUsd(a)
  );
  const liveSubgraphByTvlDesc = subgraphByTvlDesc.filter(pool =>
    holdsLiquidity(pool, tvlBypassHooks)
  );
  const countMissing = (pools: AnySubgraphPool[]) =>
    pools.filter(pool => !auroraById.has(pool.id.toLowerCase())).length;
  const missingTop100 = countMissing(subgraphByTvlDesc.slice(0, 100));
  const missingTop100LiveIds = liveSubgraphByTvlDesc
    .slice(0, 100)
    .map(pool => pool.id.toLowerCase())
    .filter(id => !auroraById.has(id));
  const missingTop100Live = missingTop100LiveIds.length;
  // Ties break on the lowercase id, so equal-TVL pools at the cutoff give the
  // same count on every sweep whatever order the source returned them in.
  const auroraTop100 = [...auroraById.entries()]
    .sort(
      ([idA, a], [idB, b]) =>
        poolTvlUsd(b) - poolTvlUsd(a) || (idA < idB ? -1 : idA > idB ? 1 : 0)
    )
    .slice(0, 100)
    .map(([, pool]) => pool);
  const extraTop100 = auroraTop100.filter(
    pool => !subgraphById.has(pool.id.toLowerCase())
  ).length;

  driftsBps.sort((a, b) => a.bps - b.bps);
  const medianIdx = Math.floor(driftsBps.length / 2);
  const tvlDriftBpsP50 = upperMedianBps(driftsBps);
  const subgraphTop100Ids = new Set(
    subgraphByTvlDesc.slice(0, 100).map(pool => pool.id.toLowerCase())
  );
  const top100Drifts = driftsBps.filter(drift =>
    subgraphTop100Ids.has(drift.id)
  );
  const tvlDriftBpsTop100P50 =
    top100Drifts.length > 0 ? upperMedianBps(top100Drifts) : undefined;

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
    missingTop100Live,
    missingTop100LiveIds,
    missingInAurora: subgraphById.size - intersection,
    extraInAurora: auroraById.size - intersection,
    extraTop100,
    tvlDriftBpsP50: Math.round(tvlDriftBpsP50),
    tvlDriftBpsTop100P50:
      tvlDriftBpsTop100P50 === undefined
        ? undefined
        : Math.round(tvlDriftBpsTop100P50),
    missingSample: topTvlSample(subgraphById.values(), auroraById),
    missingLiveSample: topTvlSample(liveSubgraphByTvlDesc, auroraById),
    extraSample: topTvlSample(auroraById.values(), subgraphById),
    driftSample,
  };
}

// Ids per diagnostic sample in the parity result/log — enough to classify a
// gap against the DB by hand, small enough to keep the log line bounded.
const SAMPLE_SIZE = 5;

// Upper median of drifts already sorted ascending; 0 when there are none.
function upperMedianBps(sortedDrifts: ReadonlyArray<{bps: number}>): number {
  return sortedDrifts[Math.floor(sortedDrifts.length / 2)]?.bps ?? 0;
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

// In-flight shadow comparisons, keyed by targetKey. Module level for the same
// reason as the baselines: providers are rebuilt every tick, and the bound
// has to hold across ticks. One entry per combo caps the background backlog
// at one sweep's worth of shadow reads.
const pendingAuroraShadowByTarget = new Map<string, Promise<void>>();

export async function settlePendingAuroraShadowsForTesting(): Promise<void> {
  await Promise.all(pendingAuroraShadowByTarget.values());
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

  // Resolves with the subgraph result without waiting for Aurora: the shadow
  // read queues on the sweep's fetch slots and can run past the subgraph
  // fetch, and the per-job timeout that bounds this call would otherwise
  // drop the job's S3 write over a comparison that never affects serving.
  // The parity comparison settles in the background.
  private getPoolsShadow(
    ...args: Parameters<ISubgraphProvider<TPool>['getPools']>
  ): Promise<TPool[]> {
    const key = targetKey(this.chainId, this.protocol);
    if (pendingAuroraShadowByTarget.has(key)) {
      this.metric.putMetric(
        'CachePools.aurora.shadow_skipped',
        1,
        MetricLoggerUnit.Count,
        {...this.tags, reason: 'previous_pending'}
      );
      return this.subgraph.getPools(...args);
    }

    const auroraPromise = this.aurora.getPools(...args);
    const subgraphPromise = this.subgraph.getPools(...args);
    const comparison = this.compareShadow(subgraphPromise, auroraPromise);
    pendingAuroraShadowByTarget.set(key, comparison);
    void comparison.finally(() => pendingAuroraShadowByTarget.delete(key));
    return subgraphPromise;
  }

  // Never rejects: a subgraph failure is the caller's to report, and an
  // Aurora failure is counted as shadow_error.
  private async compareShadow(
    subgraphPromise: Promise<TPool[]>,
    auroraPromise: Promise<TPool[]>
  ): Promise<void> {
    const [subgraphResult, auroraResult] = await Promise.allSettled([
      subgraphPromise,
      auroraPromise,
    ]);
    if (subgraphResult.status === 'rejected') return;
    const subgraphPools = subgraphResult.value;

    try {
      if (auroraResult.status === 'rejected') throw auroraResult.reason;
      const auroraPools = auroraResult.value;
      const parity = computePoolParity(
        subgraphPools,
        auroraPools,
        getTvlBypassHookAddresses(this.chainId)
      );
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
        'CachePools.parity.missing_top100_live',
        parity.missingTop100Live,
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
      this.metric.putMetric(
        'CachePools.parity.extra_top100',
        parity.extraTop100,
        MetricLoggerUnit.Count,
        this.tags
      );
      // A gauge, not putMetric: a unit-less putMetric lands as an
      // allowlist-gated `.dist`, and this is one level per sweep. Not emitted
      // without a sample, so the series shows a gap rather than a false 0.
      if (parity.tvlDriftBpsTop100P50 !== undefined) {
        this.metric.putGauge(
          'CachePools.parity.tvl_drift_bps_top100_p50',
          parity.tvlDriftBpsTop100P50,
          this.tags
        );
      }
      this.logger.info(
        `Aurora shadow parity ${targetKey(this.chainId, this.protocol)}: ` +
          `subgraph=${parity.subgraphCount} aurora=${parity.auroraCount} ` +
          `jaccardBps=${parity.jaccardBps} missingTop100=${parity.missingTop100} ` +
          `tvlDriftBpsP50=${parity.tvlDriftBpsP50} missingTop100Live=${parity.missingTop100Live} ` +
          `extraTop100=${parity.extraTop100} tvlDriftBpsTop100P50=${parity.tvlDriftBpsTop100P50 ?? 'n/a'}`,
        {
          missingInAurora: parity.missingInAurora,
          extraInAurora: parity.extraInAurora,
          missingSample: parity.missingSample,
          missingLiveSample: parity.missingLiveSample,
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
        const servable = computePoolParity(
          servableSubgraph,
          servableAurora,
          getTvlBypassHookAddresses(this.chainId)
        );
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
        this.metric.putMetric(
          'CachePools.parity.servable_missing_top100_live',
          servable.missingTop100Live,
          MetricLoggerUnit.Count,
          this.tags
        );
        // The info line below is sampled. This warn is not, so every sweep
        // that misses a live servable top-100 pool leaves all of the missing
        // ids in the logs for the flip gate's value check.
        if (servable.missingTop100Live > 0) {
          this.logger.warn(
            `Aurora servable top-100 gap ${targetKey(this.chainId, this.protocol)}: missingTop100Live=${servable.missingTop100Live}`,
            {missingTop100LiveIds: servable.missingTop100LiveIds}
          );
        }
        this.logger.info(
          `Aurora servable parity ${targetKey(this.chainId, this.protocol)}: ` +
            `subgraph=${servable.subgraphCount} aurora=${servable.auroraCount} ` +
            `jaccardBps=${servable.jaccardBps} missingTop100=${servable.missingTop100} ` +
            `tvlDriftBpsP50=${servable.tvlDriftBpsP50} missingTop100Live=${servable.missingTop100Live} ` +
            `extraTop100=${servable.extraTop100} tvlDriftBpsTop100P50=${servable.tvlDriftBpsTop100P50 ?? 'n/a'}`,
          {
            missingInAurora: servable.missingInAurora,
            extraInAurora: servable.extraInAurora,
            missingSample: servable.missingSample,
            missingLiveSample: servable.missingLiveSample,
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
        target: targetKey(this.chainId, this.protocol),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// --- Wiring ---

export interface AuroraSourceThresholds {
  trackedEthThresholdFor(protocol: Protocol, chainId: number): number;
  untrackedUsdThresholdFor(protocol: Protocol, chainId: number): number;
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
    // Aurora services to use instead of the shared uniroute connection. Unset
    // in production; lets the env-to-provider path run without a database.
    providerDeps?: AuroraProviderDeps<AuroraPoolListMethod>;
  }
): void {
  const config = auroraPoolsSourceConfigFromEnv();
  if (!config) return;
  if (config.tvlGuardTargetsWildcardRejection) {
    metric.putMetric(
      'CachePools.aurora.tvl_guard_config_rejected',
      1,
      MetricLoggerUnit.Count,
      {reason: config.tvlGuardTargetsWildcardRejection}
    );
    logger.warn(
      'Aurora TVL guard targets "*" rejected — guard stays in shadow everywhere',
      {reason: config.tvlGuardTargetsWildcardRejection}
    );
  }
  if (config.v2PrefilterWildcardIgnored) {
    metric.putMetric(
      'CachePools.aurora.v2_prefilter_config_rejected',
      1,
      MetricLoggerUnit.Count,
      {reason: 'wildcard'}
    );
    logger.warn(
      'Aurora V2 pre-filter targets wildcard ignored — list explicit combos'
    );
  }
  const skippedTargets = new Set<string>();
  for (const {chainId, protocol} of chainProtocols) {
    const key = targetKey(chainId, protocol);
    if (
      V2_TARGETS_REQUIRING_PREFILTER.has(key) &&
      resolveAuroraMode(config, chainId, protocol) &&
      !config.v2PrefilterTargets.has(key)
    ) {
      skippedTargets.add(key);
      logger.warn(
        `Aurora pool source ${key} requires the V2 pre-filter — staying on subgraph`
      );
      metric.putMetric(
        'CachePools.aurora.target_skipped',
        1,
        MetricLoggerUnit.Count,
        {
          chainId: String(chainId),
          protocol: String(protocol),
          reason: 'prefilter_required',
        }
      );
    }
  }

  let deps = options?.providerDeps;
  if (!deps) {
    // A failed init (e.g. missing CA bundle file) must degrade THIS feature,
    // never kill the whole all-chains pool-caching run. The failure is latched
    // (env is immutable, a retry can't succeed) but re-emitted every tick so a
    // permanently-down Aurora path stays visible.
    const init = getOrCreateUnirouteAuroraDb(logger);
    if (init.status === 'init_failed') {
      metric.putMetric(
        'CachePools.aurora.init_error',
        1,
        MetricLoggerUnit.Count
      );
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

    deps = {
      routablePools: createAuroraRoutablePoolsService(db, 'uniroute'),
      prices: createAuroraCurrentTokenPricesService(db, 'uniroute'),
      logger,
      metric,
      fetchSemaphore: options?.scopedRun ? undefined : AURORA_FETCH_SEMAPHORE,
    };
  }
  const shadowDeps: AuroraProviderDeps<AuroraPoolListMethod> = {
    ...deps,
    fetchSemaphore: options?.scopedRun ? undefined : AURORA_SHADOW_FETCH_SLOTS,
  };

  for (const chainProtocol of chainProtocols) {
    const {chainId, protocol} = chainProtocol;
    const key = targetKey(chainId, protocol);
    if (skippedTargets.has(key)) continue;
    const mode = resolveAuroraModeWithPrimaryFloor(
      config,
      chainId,
      protocol,
      logger,
      metric
    );
    if (!mode) continue;

    if (!AURORA_SUPPORTED_TARGETS.has(key)) {
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

    const providerDeps = mode === 'shadow' ? shadowDeps : deps;
    const applyTvlGuard =
      config.tvlGuardTargets === 'all' ||
      config.tvlGuardTargets.has(targetKey(chainId, protocol));

    // Per-protocol provider dispatch. A combo added to
    // AURORA_SUPPORTED_TARGETS must have a protocol-shaped provider branch
    // here — never map one protocol's pools through another's row shape.
    if (protocol === Protocol.V4) {
      chainProtocol.provider = new AuroraSourcedProvider(
        mode,
        new AuroraV4PoolsProvider(
          chainId,
          thresholds.trackedEthThresholdFor(protocol, chainId),
          providerDeps,
          DEFAULT_V4_ADMISSION_DEPS,
          applyTvlGuard
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
          providerDeps,
          applyTvlGuard
        ),
        chainProtocol.provider as ISubgraphProvider<V3SubgraphPool>,
        chainId,
        protocol,
        config.minPoolCountRatio,
        config.minPoolCountByTarget.get(targetKey(chainId, protocol)) ?? 0,
        logger,
        metric
      );
    } else if (protocol === Protocol.V2) {
      chainProtocol.provider = new AuroraSourcedProvider(
        mode,
        new AuroraV2PoolsProvider(
          chainId,
          thresholds.trackedEthThresholdFor(protocol, chainId),
          thresholds.untrackedUsdThresholdFor(protocol, chainId),
          providerDeps,
          applyTvlGuard,
          config.v2PrefilterTargets.has(key)
            ? {
                minPoolStatsTvlUsd: V2_PREFILTER_MIN_POOL_STATS_TVL_USD,
                alwaysIncludeTokens: v2PrefilterAlwaysIncludeTokens(chainId),
              }
            : undefined
        ),
        chainProtocol.provider as ISubgraphProvider<V2SubgraphPool>,
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
