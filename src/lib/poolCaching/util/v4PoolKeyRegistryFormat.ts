/**
 * Shared contract between the pool-caching cron (writer) and the serving
 * path (reader) for the V4 PoolKey registry: an S3 file per chain mapping
 * token pair → the NON-CANONICAL (fee, tickSpacing[, hooks]) combos of every
 * initialized pool on that pair, sourced from the ingestion pipeline's
 * `v4_pool_metadata` (Initialize-event ground truth).
 *
 * Why it exists: a v4 pool id is keccak256(PoolKey), so the on-chain direct
 * probe can only find pools whose (fee, tickSpacing) it can guess — today the
 * canonical 4-tier grid. A pool on a non-canonical tier that the S3 subgraph
 * snapshot misses (or misreports) is invisible with no fallback (ROUTE-1579).
 * The registry supplies the missing guesses; the probe still reads liquidity
 * and slot0 from chain, so a stale or wrong registry entry can add RPC reads
 * but never a phantom pool.
 *
 * Hooked entries are deliberately narrow: only an explicitly enabled chain's
 * allowlisted, non-aggregator, non-permissioned hooks may enter. This lets the
 * direct probe recover vetted non-canonical hooked pools without synthesizing
 * pools owned by another selector or namespace.
 */

import {getPermissionedHookAddresses} from '@uniswap/lib-sharedconfig/permissionedTokens';
import {DYNAMIC_FEE_FLAG} from '@uniswap/v4-sdk';
import {ADDRESS_ZERO} from '@uniswap/router-sdk';

import {
  getProtocolForAggHookAddress,
  HOOKS_ADDRESSES_ALLOWLIST,
} from './hooksAddressesAllowlist';
import {HOOKS_ADDRESSES_DENYLIST} from './hooksAddressesDenylist';

export const V4_POOLKEY_REGISTRY_VERSION = 1;

/**
 * Bound on registry entries per pair, applied at build time so the file
 * size, the serving-path probe fan-out, and the manual direct-pair fallback
 * bound (MAX_MANUAL_DIRECT_PAIRS_FALLBACK) are all capped by one constant.
 * Each entry costs the direct probe two on-chain reads (liquidity + slot0),
 * so 8 keeps the worst-case pair at roughly 3x the canonical grid's cost.
 *
 * When the cap binds, retention is by Initialize AGE — the oldest 6 plus the
 * newest 2 (`selectRetainedEntries` in v4PoolKeyRegistry.ts). Creation time
 * is monotone, so zero-liquidity spam cannot displace an established pool
 * from the oldest slice; only the newest window churns. The corollary: on a
 * pair that stays over the cap, a pool ages OUT of the newest window as
 * newer pools land and — until it is old enough to enter the oldest slice —
 * sits in an unretained middle gap, exactly as undiscoverable as every
 * non-canonical pool was before the registry. By then a real pool has had
 * several snapshot cycles to enter the subgraph path. `truncatedPairs`
 * counts how often the cap binds — observed steady state is ~7% of mainnet
 * pairs and ~5% of Polygon pairs (pool-init spam is common), so the middle
 * gap is the norm for flooded pairs rather than a rare edge case; the
 * age-split retention is what keeps established pools safe inside it.
 */
export const MAX_REGISTRY_ENTRIES_PER_PAIR = 8;

// Named *Gzip for consistency with PoolCachingFilePrefixes.GzipText; like the
// pool snapshots, the body is actually zlib deflate.
export const S3_V4_POOLKEY_REGISTRY_KEY = (chainId: number): string =>
  `v4PoolKeyRegistryGzip.json-${chainId}`;

/** Hookless entries retain the deployed two-field shape; hooked entries append hooks. */
export type V4PoolKeyRegistryEntry =
  | [number, number]
  | [number, number, string];

export interface V4PoolKeyRegistryFile {
  version: number;
  chainId: number;
  generatedAtMs: number;
  /** Keyed by pairKey(); entries sorted by (fee, tickSpacing) for determinism. */
  pairs: Record<string, V4PoolKeyRegistryEntry[]>;
}

/**
 * Canonical pair key: both addresses lowercased, ordered ascending. For
 * equal-length 0x hex strings the lexicographic order equals the numeric
 * currency0 < currency1 order of the PoolKey, and native (0x0) sorts first.
 */
export function v4RegistryPairKey(tokenA: string, tokenB: string): string {
  const a = tokenA.toLowerCase();
  const b = tokenB.toLowerCase();
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/**
 * Chains the registry is materialized for (cron) and consulted on (serving).
 * Comma-separated chain ids; empty/unset (the default) = feature off. There
 * is deliberately no `*`: each chain costs an Aurora full-set query per cron
 * tick and serving-path S3 reads, so enabling one is an explicit decision.
 */
export function v4PoolKeyRegistryChainsFromEnv(): ReadonlySet<number> {
  const raw = process.env.V4_POOLKEY_REGISTRY_CHAINS?.trim();
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map(entry => Number.parseInt(entry.trim(), 10))
      .filter(chainId => Number.isInteger(chainId) && chainId > 0)
  );
}

/**
 * Independent hooked-entry gate. It intentionally has no wildcard because
 * each enabled chain increases direct-probe RPC fan-out.
 */
export function v4PoolKeyRegistryHookedChainsFromEnv(): ReadonlySet<number> {
  const raw = process.env.V4_POOLKEY_REGISTRY_HOOKED_CHAINS?.trim();
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map(entry => Number.parseInt(entry.trim(), 10))
      .filter(chainId => Number.isInteger(chainId) && chainId > 0)
  );
}

// Mirrors MAX_REASONABLE_V4_FEE_TIER_PPM in v4HooksPoolsFiltering.ts. Keep
// this local: the format is also used on the serving path, not snapshot admission.
export const MAX_REASONABLE_V4_FEE_TIER_PPM = 110_000;
const MAX_ENTRY_TICK_SPACING = 32_767;
const HOOK_ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;

interface RegistryHookSets {
  allowlisted: ReadonlySet<string>;
  denylisted: ReadonlySet<string>;
  permissioned: ReadonlySet<string>;
}

const registryHookSetsByChain = new Map<number, RegistryHookSets>();

function getRegistryHookSets(chainId: number): RegistryHookSets {
  const memoized = registryHookSetsByChain.get(chainId);
  if (memoized) return memoized;
  const sets = {
    allowlisted: new Set(
      (HOOKS_ADDRESSES_ALLOWLIST[chainId] ?? [])
        .map(hook => hook.toLowerCase())
        .filter(hook => hook !== ADDRESS_ZERO)
    ),
    denylisted: new Set(
      (HOOKS_ADDRESSES_DENYLIST[chainId] ?? []).map(hook => hook.toLowerCase())
    ),
    permissioned: new Set(
      getPermissionedHookAddresses(chainId).map(hook => hook.toLowerCase())
    ),
  };
  registryHookSetsByChain.set(chainId, sets);
  return sets;
}

/**
 * Shared writer/reader trust boundary for hooked registry entries. Keeping it
 * here avoids a stale file widening the quote path after policy changes.
 */
export function isRegistryAdmissibleHook(
  chainId: number,
  hooksAddress: string,
  hookedChains: ReadonlySet<number> = v4PoolKeyRegistryHookedChainsFromEnv()
): boolean {
  const hooks = hooksAddress.toLowerCase();
  if (!hookedChains.has(chainId) || hooks === ADDRESS_ZERO) return false;
  const sets = getRegistryHookSets(chainId);
  return (
    sets.allowlisted.has(hooks) &&
    !sets.denylisted.has(hooks) &&
    !sets.permissioned.has(hooks) &&
    getProtocolForAggHookAddress(hooks, chainId) === undefined
  );
}

function isValidEntry(entry: unknown): entry is V4PoolKeyRegistryEntry {
  if (!Array.isArray(entry) || (entry.length !== 2 && entry.length !== 3)) {
    return false;
  }
  const [fee, tickSpacing, hooks] = entry as unknown[];
  const isHooked = entry.length === 3;
  return (
    Number.isInteger(fee) &&
    (fee as number) >= 0 &&
    (isHooked
      ? (fee as number) <= MAX_REASONABLE_V4_FEE_TIER_PPM ||
        fee === DYNAMIC_FEE_FLAG
      : (fee as number) <= MAX_REASONABLE_V4_FEE_TIER_PPM) &&
    Number.isInteger(tickSpacing) &&
    (tickSpacing as number) >= 1 &&
    (tickSpacing as number) <= MAX_ENTRY_TICK_SPACING &&
    (!isHooked ||
      (typeof hooks === 'string' &&
        HOOK_ADDRESS_PATTERN.test(hooks) &&
        hooks !== ADDRESS_ZERO))
  );
}

/**
 * Parses and SANITIZES a registry file. The serving path must survive any
 * bytes that deflate+JSON.parse happen to accept — a malformed pair value
 * must never throw through a quote, and an oversized array must never widen
 * the probe fan-out past MAX_REGISTRY_ENTRIES_PER_PAIR. Entries that fail
 * validation are dropped per-entry; a file failing the envelope checks is
 * rejected whole. Never throws.
 */
export function parseV4PoolKeyRegistryFile(
  json: string,
  expectedChainId: number
): V4PoolKeyRegistryFile | undefined {
  try {
    const parsed = JSON.parse(json) as V4PoolKeyRegistryFile;
    if (
      parsed?.version !== V4_POOLKEY_REGISTRY_VERSION ||
      parsed.chainId !== expectedChainId ||
      typeof parsed.pairs !== 'object' ||
      parsed.pairs === null ||
      Array.isArray(parsed.pairs)
    ) {
      return undefined;
    }
    const pairs: Record<string, V4PoolKeyRegistryEntry[]> = {};
    for (const [pairKey, value] of Object.entries(parsed.pairs)) {
      if (!Array.isArray(value)) continue;
      // Keeping the old two-field shape means an old serving container drops
      // only new hooked entries during a mixed deploy, not the whole file.
      const validEntries = value.filter(isValidEntry);
      const entries = [
        ...validEntries
          .filter(entry => entry.length === 2)
          .slice(0, MAX_REGISTRY_ENTRIES_PER_PAIR),
        ...validEntries
          .filter(entry => entry.length === 3)
          .slice(0, MAX_REGISTRY_ENTRIES_PER_PAIR),
      ];
      if (entries.length > 0) pairs[pairKey] = entries;
    }
    return {
      version: parsed.version,
      chainId: parsed.chainId,
      generatedAtMs:
        typeof parsed.generatedAtMs === 'number' ? parsed.generatedAtMs : 0,
      pairs,
    };
  } catch {
    return undefined;
  }
}
