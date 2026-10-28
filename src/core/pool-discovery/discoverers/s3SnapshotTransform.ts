import {V2PoolInfo, V3PoolInfo, V4PoolInfo, UniPoolInfo} from '../interface';
import {ChainId} from '../../../lib/config';
import {Protocol} from '../../../models/pool/Protocol';

// Pure, framework-free pool-snapshot transform: JSON.parse the decompressed
// S3 object body, convert each raw subgraph record to its typed pool shape,
// dedup by id, and apply the same TVL/liquidity + force-select filter
// BaseS3SubgraphPoolDiscoverer.fetchSnapshot has always applied. No class
// state, no `this`, no I/O — the ONLY reason this is its own module: it must
// be callable identically from the main thread (MainThreadSnapshotParseOffloader)
// and from a worker_threads worker (snapshotParseWorker.ts), which cannot
// invoke an instance method or receive a closure across the thread boundary.
// Keeping exactly one implementation means the two call sites can never drift.

export const TRACKED_ETH_THRESHOLD = 0.01;

export interface BasePoolData {
  id: string;
  token0: {id: string};
  token1: {id: string};
}

export interface V2PoolData extends BasePoolData {
  liquidity?: string;
  supply?: number;
  reserve?: number;
  reserveUSD?: number;
}

export interface V3PoolData extends BasePoolData {
  liquidity: string;
  tvlETH: number;
  tvlUSD: number;
  // The real S3-stored snapshot serializes this as a string (verified
  // against the actual fixture data in tests/data/*.json.gz, not assumed) —
  // convertV3PoolData/convertV4PoolData call .toString() on it, which is a
  // no-op for a string and the intended coercion for a number.
  feeTier: number | string;
}

export interface V4PoolData extends V3PoolData {
  tickSpacing: string;
  hooks: string;
  isExternalLiquidity?: boolean;
}

export type SnapshotPoolData = V2PoolData | V3PoolData | V4PoolData;

// Inputs a snapshot transform run needs beyond the raw pool-data string.
// JSON-serializable by construction (no Sets/Maps/functions) so this can
// cross a worker_threads postMessage boundary as-is.
export interface SnapshotTransformParams {
  chainId: ChainId;
  protocol: Protocol;
  // V4-only: lowercase hook addresses force-selected regardless of
  // liquidity/TVL (ZLCA + zero-measured-TVL hooks — see
  // hooksAddressesAllowlist.ts). Captured on the main thread at dispatch
  // time from the live DynamicZlcaHooksRefresher-backed store, since a
  // worker thread has its own module registry and would otherwise never see
  // that store's updates.
  v4BypassHookAddresses?: readonly string[];
}

const FEI_TOKEN_ADDRESS = '0x956f47f50a910163d8bf957cf5846d573e7f87ca';
const VIRTUAL_TOKEN_ADDRESS =
  '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b'.toLowerCase();

// A given pair base V2 pool on Base is force-selected regardless of reserve.
export function isVirtualPairBaseV2Pool(
  pool: V2PoolInfo,
  chainId: ChainId
): boolean {
  return (
    chainId === ChainId.BASE &&
    (pool.token0.id.toLowerCase() === VIRTUAL_TOKEN_ADDRESS ||
      pool.token1.id.toLowerCase() === VIRTUAL_TOKEN_ADDRESS)
  );
}

// TODO: Remove. Temporary fix to ensure tokens without trackedReserveETH are in the list.
export function forceSelectV2Pool(pool: V2PoolInfo, chainId: ChainId): boolean {
  return (
    pool.token0.id === FEI_TOKEN_ADDRESS ||
    pool.token1.id === FEI_TOKEN_ADDRESS ||
    isVirtualPairBaseV2Pool(pool, chainId)
  );
}

export function forceSelectV4Pool(
  pool: V4PoolInfo,
  bypassHookAddresses: ReadonlySet<string> | undefined
): boolean {
  if (!bypassHookAddresses) return false;
  return bypassHookAddresses.has(pool.hooks.toLowerCase());
}

export function convertV2PoolData(pool: V2PoolData): V2PoolInfo {
  const {token0, token1, id} = pool;
  return {
    id: id.toLowerCase(),
    token0: {
      id: token0.id.toLowerCase(),
    },
    token1: {
      id: token1.id.toLowerCase(),
    },
    supply: pool.supply || 100,
    reserve: pool.reserve || 100,
    reserveUSD: pool.reserveUSD || 100,
  };
}

export function convertV3PoolData(pool: V3PoolData): V3PoolInfo {
  const {token0, token1, id, liquidity, feeTier, tvlETH, tvlUSD} = pool;
  return {
    id: id.toLowerCase(),
    feeTier: feeTier.toString(),
    liquidity: liquidity.toString(),
    token0: {
      id: token0.id.toLowerCase(),
    },
    token1: {
      id: token1.id.toLowerCase(),
    },
    tvlETH: tvlETH,
    tvlUSD: tvlUSD,
  };
}

export function convertV4PoolData(pool: V4PoolData): V4PoolInfo {
  const {
    token0,
    token1,
    id,
    liquidity,
    feeTier,
    tvlETH,
    tvlUSD,
    tickSpacing,
    hooks,
    isExternalLiquidity,
  } = pool;
  return {
    id: id.toLowerCase(),
    feeTier: feeTier.toString(),
    liquidity: liquidity.toString(),
    tickSpacing: tickSpacing.toString(),
    hooks: hooks.toString(),
    token0: {
      id: token0.id.toLowerCase(),
    },
    token1: {
      id: token1.id.toLowerCase(),
    },
    tvlETH: tvlETH,
    tvlUSD: tvlUSD,
    // Conditional spread: don't materialize an undefined-valued key — see
    // BaseCachingPoolDiscoverer's stripUndefinedValuedKeysInPlace, which this
    // avoids needing to normalize away for most pools.
    ...(isExternalLiquidity !== undefined && {isExternalLiquidity}),
  };
}

// Why a snapshot record was left out of the parsed snapshot. A bad record is
// skipped on its own, so one malformed record can never empty a whole
// chain/protocol snapshot (the rest of the load still succeeds).
export enum SnapshotRecordSkipReason {
  NOT_AN_OBJECT = 'not_an_object',
  MISSING_ID = 'missing_id',
  SHAPE_MISMATCH = 'shape_mismatch',
}

export type SnapshotRecordSkipCounts = Partial<
  Record<SnapshotRecordSkipReason, number>
>;

// JSON-serializable by construction, so it can cross a worker_threads
// postMessage boundary as-is.
export interface SnapshotTransformResult {
  pools: UniPoolInfo[];
  skippedRecords: SnapshotRecordSkipCounts;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readTokenRef(value: unknown): {id: string} | undefined {
  return isPlainRecord(value) && typeof value.id === 'string'
    ? {id: value.id}
    : undefined;
}

// The converters stringify these fields, so a number and a string are both
// accepted, the same set the stringifying converters accept.
function readStringLike(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return value.toString();
  return undefined;
}

// A numeric string is coerced to its number; the TVL filter already compared
// such a value as a number.
function readNumberLike(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

// An absent, null, zero or empty V2 amount takes the converter's 100
// placeholder (`pool.supply || 100`).
const V2_AMOUNT_PLACEHOLDER = 100;
function readV2Amount(value: unknown): number | undefined {
  if (value === undefined || value === null) return V2_AMOUNT_PLACEHOLDER;
  const amount = readNumberLike(value);
  if (amount !== undefined) return amount || V2_AMOUNT_PLACEHOLDER;
  return value === '' ? V2_AMOUNT_PLACEHOLDER : undefined;
}

function readBaseFields(
  record: Record<string, unknown>
): BasePoolData | undefined {
  const token0 = readTokenRef(record.token0);
  const token1 = readTokenRef(record.token1);
  if (typeof record.id !== 'string' || !token0 || !token1) return undefined;
  return {id: record.id, token0, token1};
}

function readV2PoolData(
  record: Record<string, unknown>
): V2PoolData | undefined {
  const base = readBaseFields(record);
  const supply = readV2Amount(record.supply);
  const reserve = readV2Amount(record.reserve);
  const reserveUSD = readV2Amount(record.reserveUSD);
  if (
    !base ||
    supply === undefined ||
    reserve === undefined ||
    reserveUSD === undefined
  ) {
    return undefined;
  }
  return {...base, supply, reserve, reserveUSD};
}

function readV3PoolData(
  record: Record<string, unknown>
): V3PoolData | undefined {
  const base = readBaseFields(record);
  const liquidity = readStringLike(record.liquidity);
  const feeTier = readStringLike(record.feeTier);
  const tvlETH = readNumberLike(record.tvlETH);
  const tvlUSD = readNumberLike(record.tvlUSD);
  if (
    !base ||
    liquidity === undefined ||
    feeTier === undefined ||
    tvlETH === undefined ||
    tvlUSD === undefined
  ) {
    return undefined;
  }
  return {...base, liquidity, feeTier, tvlETH, tvlUSD};
}

function readV4PoolData(
  record: Record<string, unknown>
): V4PoolData | undefined {
  const v3 = readV3PoolData(record);
  const tickSpacing = readStringLike(record.tickSpacing);
  const hooks = readStringLike(record.hooks);
  const {isExternalLiquidity} = record;
  if (
    !v3 ||
    tickSpacing === undefined ||
    hooks === undefined ||
    (isExternalLiquidity !== undefined &&
      typeof isExternalLiquidity !== 'boolean')
  ) {
    return undefined;
  }
  return {
    ...v3,
    tickSpacing,
    hooks,
    ...(isExternalLiquidity !== undefined && {isExternalLiquidity}),
  };
}

function countSkip(
  skipped: SnapshotRecordSkipCounts,
  reason: SnapshotRecordSkipReason
): void {
  skipped[reason] = (skipped[reason] ?? 0) + 1;
}

// Dedups by raw pool id (first valid record wins), converts, and keeps the
// pools the protocol's filter admits. A record that fails conversion is
// counted and skipped and does not claim its id, so a later valid record with
// the same id is still kept.
function collectPools<T extends UniPoolInfo>(
  records: readonly unknown[],
  convert: (record: Record<string, unknown>) => T | undefined,
  keep: (pool: T) => boolean,
  skipped: SnapshotRecordSkipCounts
): T[] {
  const seenIds = new Set<string>();
  const pools: T[] = [];
  for (const record of records) {
    if (!isPlainRecord(record)) {
      countSkip(skipped, SnapshotRecordSkipReason.NOT_AN_OBJECT);
      continue;
    }
    if (typeof record.id !== 'string') {
      countSkip(skipped, SnapshotRecordSkipReason.MISSING_ID);
      continue;
    }
    if (seenIds.has(record.id)) {
      continue;
    }
    const pool = convert(record);
    if (pool === undefined) {
      countSkip(skipped, SnapshotRecordSkipReason.SHAPE_MISMATCH);
      continue;
    }
    seenIds.add(record.id);
    if (keep(pool)) {
      pools.push(pool);
    }
  }
  return pools;
}

// JSON.parse the raw snapshot body, dedup by pool id, convert each record to
// its typed pool shape, and apply the TVL/liquidity + force-select filter.
// Deliberately synchronous and allocation-only (no I/O, no awaits): this is
// the CPU-bound unit that blocks the event loop on a large snapshot, and the
// one WorkerThreadSnapshotParseOffloader runs on a worker thread. Throws only
// when the body itself is unusable (bad JSON, not an array) or the protocol
// is unsupported; a bad record is skipped and counted in `skippedRecords`.
export function transformSnapshotPoolString(
  poolString: string,
  params: SnapshotTransformParams
): SnapshotTransformResult {
  const parsed: unknown = JSON.parse(poolString);
  if (!Array.isArray(parsed)) {
    throw new Error('Snapshot pool data is not an array');
  }
  const {protocol, chainId} = params;
  const skippedRecords: SnapshotRecordSkipCounts = {};
  // Keep only pools with > TRACKED_ETH_THRESHOLD TVL.
  // TODO: In the future we might consider removing all filtering from here (and just trust whatever is in the S3)
  // as we already do similar filtering there
  switch (protocol) {
    case Protocol.V2:
      return {
        pools: collectPools(
          parsed,
          record => {
            const data = readV2PoolData(record);
            return data && convertV2PoolData(data);
          },
          pool =>
            pool.reserve > TRACKED_ETH_THRESHOLD ||
            forceSelectV2Pool(pool, chainId),
          skippedRecords
        ),
        skippedRecords,
      };
    case Protocol.V3:
      // Special treatment for all V3 pools in order to reduce latency due to thousands of pools with very low TVL locked
      // - Include "parseFloat(pool.totalValueLockedETH) === 0" as in certain occasions we have no way of calculating derivedETH so this is 0
      return {
        pools: collectPools(
          parsed,
          record => {
            const data = readV3PoolData(record);
            return data && convertV3PoolData(data);
          },
          pool =>
            (parseInt(pool.liquidity) > 0 && pool.tvlETH === 0) ||
            pool.tvlETH > TRACKED_ETH_THRESHOLD,
          skippedRecords
        ),
        skippedRecords,
      };
    case Protocol.V4: {
      const bypassHookAddresses = params.v4BypassHookAddresses
        ? new Set(params.v4BypassHookAddresses)
        : undefined;
      return {
        pools: collectPools(
          parsed,
          record => {
            const data = readV4PoolData(record);
            return data && convertV4PoolData(data);
          },
          pool =>
            pool.isExternalLiquidity === true ||
            parseInt(pool.liquidity) > 0 ||
            pool.tvlETH > TRACKED_ETH_THRESHOLD ||
            forceSelectV4Pool(pool, bypassHookAddresses),
          skippedRecords
        ),
        skippedRecords,
      };
    }
    default:
      throw new Error(
        `Unsupported protocol for snapshot transform: ${protocol}`
      );
  }
}

// Same transform, taking the raw inflated (not yet utf-8-decoded) snapshot
// bytes, so the utf-8 decode of a multi-MB buffer runs wherever the
// transform runs (main thread or a worker).
export function transformSnapshotPoolBytes(
  poolBytes: Uint8Array,
  params: SnapshotTransformParams
): SnapshotTransformResult {
  const poolString = Buffer.from(
    poolBytes.buffer,
    poolBytes.byteOffset,
    poolBytes.byteLength
  ).toString('utf-8');
  return transformSnapshotPoolString(poolString, params);
}
