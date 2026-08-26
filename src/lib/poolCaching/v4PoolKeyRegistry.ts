/**
 * Materializes the V4 PoolKey registry (see util/v4PoolKeyRegistryFormat.ts
 * for the contract and why it exists) in the pool-caching cron: one Aurora
 * `v4_pool_metadata` full-set read per enabled chain, filtered down to the
 * non-canonical hookless PoolKeys the direct probe cannot guess, written to
 * the pool-cache bucket next to the snapshots.
 *
 * Fail-soft at every level: a chain that cannot be read or written keeps its
 * previous registry object (S3 is never cleared, and a shrunken or losing
 * write is skipped rather than forced), and a registry failure never fails
 * the pool-caching run — the canonical probe grid still applies without it.
 */

import * as zlib from 'zlib';
import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {Currency, Token} from '@uniswap/sdk-core';
import {Pool as V4SDKPool} from '@uniswap/v4-sdk';
import {ADDRESS_ZERO} from '@uniswap/router-sdk';
import type {ExtendedChainId} from '@uniswap/lib-data-api';
import type {V4PoolKey} from '@uniswap/lib-data-ingestion-aurora';
import {createAuroraRoutablePoolsService} from '@uniswap/lib-data-ingestion-aurora';

import {auroraContext, getOrCreateUnirouteAuroraDb} from './auroraPoolsSource';
import {nativeOnChain} from './util/nativeOnChain';
import {Logger} from './sor-providers/util/log';
import {IMetric, MetricLoggerUnit} from './sor-providers/util/metric';
import {
  MAX_REGISTRY_ENTRIES_PER_PAIR,
  S3_V4_POOLKEY_REGISTRY_KEY,
  V4PoolKeyRegistryEntry,
  V4PoolKeyRegistryFile,
  V4_POOLKEY_REGISTRY_VERSION,
  v4PoolKeyRegistryChainsFromEnv,
  v4RegistryPairKey,
} from './util/v4PoolKeyRegistryFormat';

export {MAX_REGISTRY_ENTRIES_PER_PAIR};

// The grid getApplicableV4FeesTickspacingsHooks already probes; a pool on it
// gains nothing from the registry. Kept local (mirroring
// v4HooksPoolsFiltering's CANONICAL_V4_FEE_TICK_SPACINGS) rather than
// importing the serving-path model graph into the cron.
const CANONICAL_V4_FEE_TICK_SPACINGS: Record<number, number> = {
  75: 1,
  100: 1,
  375: 4,
  500: 10,
  2500: 25,
  3000: 60,
  9000: 90,
  10000: 200,
};

/**
 * When a pair exceeds MAX_REGISTRY_ENTRIES_PER_PAIR, retention splits by
 * Initialize time: the OLDEST entries plus a small NEWEST window. Creation
 * time is monotone, so no later actor can displace an established pool from
 * the oldest slice by spamming zero-liquidity initializations — spam can
 * crowd only the newest window. (A fee- or id-ordered policy is trivially
 * crowdable: initializing 8 lower-fee pools on the pair costs only gas.)
 * The newest window exists so a genuinely new market on an already-noisy
 * pair still becomes probeable.
 */
const RETAIN_OLDEST_PER_PAIR = 6;
const RETAIN_NEWEST_PER_PAIR =
  MAX_REGISTRY_ENTRIES_PER_PAIR - RETAIN_OLDEST_PER_PAIR;

/**
 * A run whose Aurora row count collapses below this fraction of the last
 * accepted run's count is treated like a failed read: a partial ingestion
 * state (backfill in progress, coverage regression) must not overwrite a
 * previously complete registry. Mirrors the pool-count collapse guard on the
 * Aurora snapshot source (auroraPoolsSource.ts minPoolCountRatio).
 */
const ROW_COUNT_COLLAPSE_RATIO = 0.5;

// Process-lifetime baseline per chain, set only after an accepted run
// (mirrors lastAuroraPoolCountByTarget in auroraPoolsSource.ts).
const lastAcceptedRowCountByChain = new Map<number, number>();

export function resetV4PoolKeyRegistryBaselinesForTesting(): void {
  lastAcceptedRowCountByChain.clear();
}

// S3 object metadata keys. The build timestamp lets concurrent writers (the
// scheduled all-chains job AND the on-demand poolCachingRunOnce worker drive
// the same path) arbitrate freshness instead of last-write-wins. The row
// count makes the collapse baseline DURABLE: a freshly-started container has
// no process-local baseline, so without it a cold container reading partial
// ingestion data mid-backfill could overwrite a complete incumbent with a
// newer-timestamped partial registry.
export const GENERATED_AT_METADATA_KEY = 'registry-generated-at-ms';
export const ROW_COUNT_METADATA_KEY = 'registry-row-count';

export interface V4PoolKeyRegistryBuildStats {
  included: number;
  skippedCanonical: number;
  skippedHooked: number;
  skippedInvalidId: number;
  truncatedPairs: number;
  pairs: number;
}

function poolKeyCurrency(chainId: number, address: string): Currency {
  // Decimals pinned to 18: they do not enter the pool id derivation.
  return address === ADDRESS_ZERO
    ? nativeOnChain(chainId)
    : new Token(chainId, address, 18);
}

/**
 * True when the row's PoolKey reproduces its stored pool_id — the same
 * offline keccak proof v4LpFeeCorrection uses. A row that fails is corrupt
 * (or uses an address shape the SDK rejects) and must not become a probe
 * candidate under a wrong id.
 */
function poolKeyReproducesId(chainId: number, row: V4PoolKey): boolean {
  try {
    return (
      V4SDKPool.getPoolId(
        poolKeyCurrency(chainId, row.token0Address.toLowerCase()),
        poolKeyCurrency(chainId, row.token1Address.toLowerCase()),
        row.feeBips,
        row.tickSpacing,
        ADDRESS_ZERO
      ).toLowerCase() === row.poolId.toLowerCase()
    );
  } catch {
    return false;
  }
}

interface CandidateEntry {
  fee: number;
  tickSpacing: number;
  createdAtMs: number;
}

/** Oldest slice + newest window; see RETAIN_OLDEST_PER_PAIR. */
export function selectRetainedEntries(
  candidates: CandidateEntry[]
): CandidateEntry[] {
  if (candidates.length <= MAX_REGISTRY_ENTRIES_PER_PAIR) return candidates;
  const byAge = [...candidates].sort(
    (a, b) =>
      a.createdAtMs - b.createdAtMs ||
      a.fee - b.fee ||
      a.tickSpacing - b.tickSpacing
  );
  return [
    ...byAge.slice(0, RETAIN_OLDEST_PER_PAIR),
    ...byAge.slice(byAge.length - RETAIN_NEWEST_PER_PAIR),
  ];
}

export function buildV4PoolKeyRegistry(
  chainId: number,
  rows: V4PoolKey[],
  generatedAtMs: number
): {file: V4PoolKeyRegistryFile; stats: V4PoolKeyRegistryBuildStats} {
  const stats: V4PoolKeyRegistryBuildStats = {
    included: 0,
    skippedCanonical: 0,
    skippedHooked: 0,
    skippedInvalidId: 0,
    truncatedPairs: 0,
    pairs: 0,
  };

  const byPair = new Map<string, CandidateEntry[]>();
  const seen = new Set<string>();
  for (const row of rows) {
    const hooks = (row.hooksAddress ?? ADDRESS_ZERO).toLowerCase();
    if (hooks !== ADDRESS_ZERO) {
      stats.skippedHooked++;
      continue;
    }
    if (CANONICAL_V4_FEE_TICK_SPACINGS[row.feeBips] === row.tickSpacing) {
      stats.skippedCanonical++;
      continue;
    }
    if (!poolKeyReproducesId(chainId, row)) {
      stats.skippedInvalidId++;
      continue;
    }
    const pairKey = v4RegistryPairKey(row.token0Address, row.token1Address);
    // The (chain, pair, fee, tickSpacing, hookless) tuple IS the pool id, so
    // duplicates can only come from duplicate metadata rows; keep one.
    const dedupeKey = `${pairKey}:${row.feeBips}:${row.tickSpacing}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    let entries = byPair.get(pairKey);
    if (!entries) {
      entries = [];
      byPair.set(pairKey, entries);
    }
    const createdAtMs = row.poolCreatedAtBlockTimestamp?.getTime?.();
    entries.push({
      fee: row.feeBips,
      tickSpacing: row.tickSpacing,
      // A missing/garbage timestamp sorts as newest: an entry that cannot
      // prove its age must not be able to displace the protected old slice.
      createdAtMs: Number.isFinite(createdAtMs)
        ? (createdAtMs as number)
        : Number.MAX_SAFE_INTEGER,
    });
  }

  const pairs: Record<string, V4PoolKeyRegistryEntry[]> = {};
  for (const [pairKey, candidates] of byPair) {
    const retained = selectRetainedEntries(candidates);
    if (retained.length < candidates.length) stats.truncatedPairs++;
    stats.included += retained.length;
    pairs[pairKey] = retained
      .map((entry): V4PoolKeyRegistryEntry => [entry.fee, entry.tickSpacing])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  }
  stats.pairs = byPair.size;

  return {
    file: {
      version: V4_POOLKEY_REGISTRY_VERSION,
      chainId,
      generatedAtMs,
      pairs,
    },
    stats,
  };
}

export interface V4PoolKeyRegistryMaterializeConfig {
  s3Bucket: string;
}

type WriteOutcome = 'written' | 'incumbent_fresher' | 'write_conflict';

interface IncumbentRegistry {
  etag?: string;
  generatedAtMs?: number;
  rowCount?: number;
}

/**
 * Reads the incumbent object's arbitration metadata. `undefined` means a
 * clean 404 (no incumbent); anything else that prevents seeing the incumbent
 * fails closed (throws to the per-chain catch) rather than risk clobbering a
 * fresher object we couldn't read.
 */
async function headIncumbentRegistry(
  s3: S3Client,
  bucket: string,
  key: string
): Promise<IncumbentRegistry | undefined> {
  try {
    const head = await s3.send(
      new HeadObjectCommand({Bucket: bucket, Key: key})
    );
    const generatedAtMs = Number(head.Metadata?.[GENERATED_AT_METADATA_KEY]);
    const rowCount = Number(head.Metadata?.[ROW_COUNT_METADATA_KEY]);
    return {
      etag: head.ETag,
      generatedAtMs: Number.isFinite(generatedAtMs) ? generatedAtMs : undefined,
      rowCount: Number.isFinite(rowCount) ? rowCount : undefined,
    };
  } catch (err) {
    const status = (err as {$metadata?: {httpStatusCode?: number}})?.$metadata
      ?.httpStatusCode;
    const name = (err as {name?: string})?.name;
    if (name !== 'NotFound' && status !== 404) throw err;
    return undefined;
  }
}

/**
 * True when this run's row count is a collapse against the strongest known
 * baseline — the process-local last accepted count OR the incumbent object's
 * durable count, whichever is larger. The durable side is what protects a
 * cold container: process memory starts empty, but the incumbent's metadata
 * survives restarts.
 */
export function isRowCountCollapse(
  rowCount: number,
  processBaseline: number | undefined,
  incumbentBaseline: number | undefined
): boolean {
  const baseline = Math.max(processBaseline ?? 0, incumbentBaseline ?? 0);
  return baseline > 0 && rowCount < baseline * ROW_COUNT_COLLAPSE_RATIO;
}

/**
 * Freshness-arbitrated conditional PUT against a previously-headed
 * incumbent: an incumbent at least as fresh wins, and a conditional-write
 * conflict (another writer landed between head and put) is a benign skip —
 * their object is at most one build interval different from ours.
 */
async function writeRegistryObject(
  s3: S3Client,
  bucket: string,
  key: string,
  body: Buffer,
  generatedAtMs: number,
  rowCount: number,
  incumbent: IncumbentRegistry | undefined
): Promise<WriteOutcome> {
  if (
    incumbent?.generatedAtMs !== undefined &&
    incumbent.generatedAtMs >= generatedAtMs
  ) {
    return 'incumbent_fresher';
  }
  const putCondition: {IfMatch: string} | {IfNoneMatch: string} =
    incumbent?.etag ? {IfMatch: incumbent.etag} : {IfNoneMatch: '*'};
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        Metadata: {
          [GENERATED_AT_METADATA_KEY]: String(generatedAtMs),
          [ROW_COUNT_METADATA_KEY]: String(rowCount),
        },
        ...putCondition,
      })
    );
    return 'written';
  } catch (err) {
    const status = (err as {$metadata?: {httpStatusCode?: number}})?.$metadata
      ?.httpStatusCode;
    const name = (err as {name?: string})?.name;
    if (
      status === 412 ||
      status === 409 ||
      name === 'PreconditionFailed' ||
      name === 'ConditionalRequestConflict'
    ) {
      return 'write_conflict';
    }
    throw err;
  }
}

/**
 * One registry write per enabled chain. Both the scheduled all-chains job
 * and the on-demand poolCachingRunOnce worker can reach this, so writes are
 * freshness-arbitrated rather than assumed single-writer. The caller bounds
 * the whole step with a timeout so a stalled Aurora read or S3 PUT cannot
 * eat the pool-caching run's budget.
 */
export async function materializeV4PoolKeyRegistries(
  s3: S3Client,
  config: V4PoolKeyRegistryMaterializeConfig,
  logger: Logger,
  metric: IMetric
): Promise<void> {
  const chains = v4PoolKeyRegistryChainsFromEnv();
  if (chains.size === 0) return;

  const init = getOrCreateUnirouteAuroraDb(logger);
  if (init.status !== 'ready') {
    // Tagged per enabled chain: the materialization monitor groups
    // by {chainid, reason}, and metric group-by drops untagged points — an
    // untagged emission would make "enabled but Aurora is absent" (the most
    // important state to catch when flipping the flag on a fresh stack)
    // invisible to alerting.
    for (const chainId of chains) {
      metric.putMetric(
        'CachePools.v4PoolKeyRegistry.error',
        1,
        MetricLoggerUnit.Count,
        {chainId: String(chainId), reason: init.status}
      );
    }
    logger.warn(
      `V4 PoolKey registry enabled for chains ${[...chains].join(',')} but Aurora is unavailable (${init.status}) — skipping`
    );
    return;
  }
  const routablePools = createAuroraRoutablePoolsService(init.db, 'uniroute');

  for (const chainId of chains) {
    const tags = {chainId: String(chainId)};
    try {
      const rows = await routablePools.listAllV4PoolKeys(
        auroraContext(metric),
        {chainId: chainId as ExtendedChainId}
      );
      const key = S3_V4_POOLKEY_REGISTRY_KEY(chainId);
      const incumbent = await headIncumbentRegistry(s3, config.s3Bucket, key);
      // An empty metadata table means ingestion does not cover this chain
      // (or is broken); a collapsed count means it is mid-backfill or
      // regressing. Either way, overwriting would erase a previously useful
      // registry — keep the incumbent and surface the gap instead. The
      // baseline is the STRONGER of process memory and the incumbent's
      // durable metadata count, so a cold container is protected too.
      const collapsed = isRowCountCollapse(
        rows.length,
        lastAcceptedRowCountByChain.get(chainId),
        incumbent?.rowCount
      );
      if (rows.length === 0 || collapsed) {
        metric.putMetric(
          'CachePools.v4PoolKeyRegistry.error',
          1,
          MetricLoggerUnit.Count,
          {
            ...tags,
            reason:
              rows.length === 0 ? 'no_metadata_rows' : 'row_count_collapse',
          }
        );
        logger.warn(
          `V4 PoolKey registry chain ${chainId}: ${rows.length} metadata rows` +
            (collapsed
              ? ` collapsed vs baseline (process=${lastAcceptedRowCountByChain.get(chainId) ?? 'none'}, incumbent=${incumbent?.rowCount ?? 'none'})`
              : '') +
            ' — keeping existing registry'
        );
        continue;
      }
      const generatedAtMs = Date.now();
      const {file, stats} = buildV4PoolKeyRegistry(
        chainId,
        rows,
        generatedAtMs
      );
      const body = zlib.deflateSync(JSON.stringify(file));
      const outcome = await writeRegistryObject(
        s3,
        config.s3Bucket,
        key,
        body,
        generatedAtMs,
        rows.length,
        incumbent
      );
      lastAcceptedRowCountByChain.set(chainId, rows.length);
      if (outcome !== 'written') {
        metric.putMetric(
          'CachePools.v4PoolKeyRegistry.writeSkipped',
          1,
          MetricLoggerUnit.Count,
          {...tags, reason: outcome}
        );
        logger.info(
          `V4 PoolKey registry chain ${chainId}: write skipped (${outcome})`
        );
        continue;
      }
      metric.putMetric(
        'CachePools.v4PoolKeyRegistry.pairs',
        stats.pairs,
        MetricLoggerUnit.Count,
        tags
      );
      metric.putMetric(
        'CachePools.v4PoolKeyRegistry.keys',
        stats.included,
        MetricLoggerUnit.Count,
        tags
      );
      metric.putMetric(
        'CachePools.v4PoolKeyRegistry.skippedInvalidId',
        stats.skippedInvalidId,
        MetricLoggerUnit.Count,
        tags
      );
      metric.putMetric(
        'CachePools.v4PoolKeyRegistry.truncatedPairs',
        stats.truncatedPairs,
        MetricLoggerUnit.Count,
        tags
      );
      logger.info(
        `V4 PoolKey registry chain ${chainId}: pairs=${stats.pairs} keys=${stats.included} ` +
          `skippedCanonical=${stats.skippedCanonical} skippedHooked=${stats.skippedHooked} ` +
          `skippedInvalidId=${stats.skippedInvalidId} truncatedPairs=${stats.truncatedPairs} ` +
          `rows=${rows.length} bytes=${body.length}`
      );
    } catch (err) {
      metric.putMetric(
        'CachePools.v4PoolKeyRegistry.error',
        1,
        MetricLoggerUnit.Count,
        {...tags, reason: 'materialize_failed'}
      );
      logger.error(
        `V4 PoolKey registry chain ${chainId}: materialization failed — keeping existing registry`,
        {err: err instanceof Error ? err.message : String(err)}
      );
    }
  }
}
