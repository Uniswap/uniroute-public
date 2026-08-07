/**
 * Corrects the V4 snapshot's `feeTier` from the TOTAL swap fee back to the
 * pool-key LP fee.
 *
 * The v4 subgraph maintains `Pool.feeTier` from the `Swap` event's `fee`
 * param, which is the total swap fee — `ProtocolFeeLibrary.calculateSwapFee`,
 * i.e. lpFee + protocolFee net of their product. `PoolKey.fee` is the lpFee
 * alone, so the two agree only while a pool's protocol fee is 0 and diverge
 * the moment one is set. uniroute copies `feeTier` verbatim into the snapshot
 * and eventually into the quoter's `PathKey.fee`, which addresses a PoolKey
 * that does not exist — the quote reverts with `PoolNotInitialized()`.
 *
 * data-api already solves this by preferring the pool-key fee recorded from
 * the `Initialize` event by the ingestion pipeline (see
 * `data-api/src/bl/ProtocolFeeResolver.ts`, `StoredV4Fees.staticLpFeePips`).
 * uniroute has that Aurora access in prod as well — the pool source is
 * enabled there and primary for `4663:V4` — but it is code-capped to that
 * combo by `AURORA_SUPPORTED_TARGETS`, so every chain this correction covers
 * still takes its feeTier from the subgraph. Reading `v4_pool_metadata`'s
 * `fee_bips` instead is a scoping/rollout step, not a missing capability.
 * Meanwhile the fee comes from `StateView.getSlot0`, which returns `lpFee`
 * and `protocolFee` directly — no inversion of the swap-fee formula is
 * needed or attempted.
 *
 * Applied in the pool-caching cron BEFORE `v4HooksPoolsFiltering`, so the
 * corrected fee feeds the `token0+token1+feeTier` grouping and the canonical
 * `(feeTier, tickSpacing)` gate rather than only the served value.
 */

import {ethers} from 'ethers';
import pLimit from 'p-limit';
import {LRUCache} from 'lru-cache';
import {Currency, Token} from '@uniswap/sdk-core';
import {Pool as V4SDKPool} from '@uniswap/v4-sdk';
import {ADDRESS_ZERO} from '@uniswap/router-sdk';

import {ChainId} from '../../config';
import {V4SubgraphPool} from '../sor-providers/v4/subgraphProvider';
import {Logger} from '../sor-providers/util/log';
import {IMetric, MetricLoggerUnit} from '../sor-providers/util/metric';
import {isPoolFeeDynamic} from './isPoolFeeDynamic';
import {nativeOnChain} from './nativeOnChain';

/** v4-core PIPS denominator (hundredths of a bip). */
export const PIPS_DENOMINATOR = 1_000_000;

/** Width of each packed protocol-fee direction in slot0's uint24. */
const PROTOCOL_FEE_DIRECTION_MASK = 0xfff;

/**
 * v4-core `ProtocolFeeLibrary.calculateSwapFee`, including its integer floor
 * division — the subtracted product term is what makes (500, 3000) resolve to
 * 3499 rather than 3500.
 */
export function calculateSwapFee(
  protocolFeePips: number,
  lpFeePips: number
): number {
  return (
    protocolFeePips +
    lpFeePips -
    Math.floor((protocolFeePips * lpFeePips) / PIPS_DENOMINATOR)
  );
}

/**
 * slot0 packs the protocol fee as two 12-bit directions: the low bits are
 * zero→one, the high bits one→zero. A pool may charge different fees per
 * direction, and the subgraph's feeTier reflects whichever direction last
 * swapped, so both are kept and either may explain an observed total.
 */
export function unpackProtocolFee(packed: number): {
  zeroForOnePips: number;
  oneForZeroPips: number;
} {
  return {
    zeroForOnePips: packed & PROTOCOL_FEE_DIRECTION_MASK,
    oneForZeroPips: (packed >> 12) & PROTOCOL_FEE_DIRECTION_MASK,
  };
}

/** A pool's authoritative fee state, as read from `StateView.getSlot0`. */
export interface V4PoolKeyFees {
  /**
   * slot0's `lpFee` — the CURRENT effective LP fee. For a static-fee pool that
   * is `PoolKey.fee`; for a dynamic-fee pool it is whatever the hook last set,
   * bounded by `MAX_LP_FEE` (1,000,000). It is never `DYNAMIC_FEE_FLAG`
   * (0x800000 = 8,388,608): the sentinel lives in `PoolKey.fee`, which
   * `getSlot0` does not return, and exceeds `MAX_LP_FEE` besides. Dynamic-fee
   * pools must therefore be identified from the PoolKey, not from this field.
   */
  lpFeePips: number;
  zeroForOnePips: number;
  oneForZeroPips: number;
}

/**
 * The pool's two PoolKey currencies.
 *
 * Decimals are pinned to 18 rather than parsed: they do not enter the pool id,
 * and a NaN from the subgraph would fail the `Token` invariant for no reason.
 */
function poolKeyCurrencies(
  chainId: number,
  pool: V4SubgraphPool
): [Currency, Currency] {
  const currency = (address: string): Currency =>
    address === ADDRESS_ZERO
      ? nativeOnChain(chainId)
      : new Token(chainId, address, 18);
  return [currency(pool.token0.id), currency(pool.token1.id)];
}

/**
 * True when the pool's `PoolKey.fee` is the dynamic-fee sentinel.
 *
 * `PoolKey.fee` is the very thing this module derives, so it cannot be read
 * back directly. `isPoolFeeDynamic` sidesteps that by reproducing the pool id
 * with the sentinel substituted — the id is the only PoolKey field the
 * snapshot already carries verbatim. A hookless pool cannot have a dynamic
 * fee, which short-circuits the keccak for nearly every pool.
 */
export function isDynamicFeeV4Pool(
  chainId: number,
  pool: V4SubgraphPool
): boolean {
  if (pool.hooks === ADDRESS_ZERO) return false;
  try {
    const [currency0, currency1] = poolKeyCurrencies(chainId, pool);
    return isPoolFeeDynamic(
      currency0,
      currency1,
      Number(pool.tickSpacing),
      pool.hooks,
      pool.id
    );
  } catch {
    // A pool whose currencies will not construct cannot be shown to be
    // static, and the correction must never rewrite a fee it cannot justify.
    return true;
  }
}

/**
 * True when the snapshot's own `feeTier` reproduces the pool id — an offline
 * proof that `feeTier` already IS `PoolKey.fee`. The id is
 * `keccak256(PoolKey)` and the snapshot carries it verbatim, so substituting
 * `feeTier` into the PoolKey and re-deriving the id settles it with no RPC.
 *
 * One-directional by construction: a match licenses a SKIP and nothing else.
 * A mismatch, an unparseable field, or a derivation that throws disproves
 * nothing — those fall through to `StateView.getSlot0`, which remains the
 * only thing permitted to change a fee.
 *
 * Uses the same v4-sdk derivation `isPoolFeeDynamic` calls one level down.
 * `V4Pool.computePoolId` produces byte-identical ids but would pull the
 * serving-path model graph into the cron for no gain.
 */
export function isFeeTierProvenByPoolId(
  chainId: number,
  pool: V4SubgraphPool
): boolean {
  const feeTier = Number(pool.feeTier);
  const tickSpacing = Number(pool.tickSpacing);
  if (!Number.isInteger(feeTier) || !Number.isInteger(tickSpacing)) {
    return false;
  }
  try {
    const [currency0, currency1] = poolKeyCurrencies(chainId, pool);
    return (
      V4SDKPool.getPoolId(
        currency0,
        currency1,
        feeTier,
        tickSpacing,
        pool.hooks
      ).toLowerCase() === pool.id.toLowerCase()
    );
  } catch {
    return false;
  }
}

/**
 * `prefiltered` and `deferred` are decided before any read and so are never
 * returned by `resolveFeeTier` — they are outcomes of the pass as a whole.
 */
export type FeeTierOutcome =
  /** Snapshot value already equals the pool-key fee (includes protocolFee 0). */
  | 'already_correct'
  /** Snapshot value was the total swap fee; replaced with the pool-key fee. */
  | 'corrected'
  /** No on-chain read available for this pool. */
  | 'unknown'
  /** Pool id proved `feeTier === PoolKey.fee` offline; no read was made. */
  | 'prefiltered'
  /** Read skipped this pass to stay under the read cap; retried next tick. */
  | 'deferred'
  /** Dynamic-fee pool — its lpFee is per-swap, not a pool-key fee (ROUTE-607). */
  | 'dynamic'
  /** Snapshot value is explained by neither the lpFee nor the total. */
  | 'unexplained';

export interface FeeTierResolution {
  outcome: FeeTierOutcome;
  /** The feeTier to store. Always the snapshot's value unless `corrected`. */
  feeTier: string;
}

/**
 * Decides the `feeTier` to store for one pool.
 *
 * Deliberately conservative: the snapshot value is replaced ONLY when the
 * observed drift is fully explained by `calculateSwapFee` for one of the
 * pool's two protocol-fee directions. Anything else — an unreadable pool, a
 * dynamic-fee pool, or a value the formula does not reproduce — keeps the
 * subgraph's value, so the correction can never invent a fee.
 */
export function resolveFeeTier(
  snapshotFeeTier: string,
  fees: V4PoolKeyFees | undefined,
  isDynamicFee = false
): FeeTierResolution {
  const keep = (outcome: FeeTierOutcome): FeeTierResolution => ({
    outcome,
    feeTier: snapshotFeeTier,
  });

  // A dynamic-fee pool's PoolKey.fee is the sentinel and its slot0 lpFee is
  // whatever the hook last set, so neither is a pool-key fee to store here.
  // Checked from the PoolKey by the caller — slot0 cannot reveal it.
  if (isDynamicFee) return keep('dynamic');
  if (!fees) return keep('unknown');

  const observed = Number(snapshotFeeTier);
  if (!Number.isFinite(observed)) return keep('unexplained');
  if (observed === fees.lpFeePips) return keep('already_correct');

  const explained =
    observed === calculateSwapFee(fees.zeroForOnePips, fees.lpFeePips) ||
    observed === calculateSwapFee(fees.oneForZeroPips, fees.lpFeePips);

  return explained
    ? {outcome: 'corrected', feeTier: String(fees.lpFeePips)}
    : keep('unexplained');
}

// --- On-chain source ---

/**
 * Reads the authoritative fee state for a batch of pools. An entry is omitted
 * for any pool the source could not answer for (uninitialized, read failure);
 * callers keep the subgraph's value for those.
 */
export interface V4PoolKeyFeeReader {
  readPoolKeyFees(
    chainId: number,
    poolIds: string[]
  ): Promise<Map<string, V4PoolKeyFees>>;
}

const STATE_VIEW_ABI = [
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
];

/**
 * StateView address per chain the correction supports (values from
 * `src/stores/chain/hardcoded/chains/*`, `v4StateViewLibraryAddress`). Kept
 * local rather than importing the serving-path chain repository, mirroring
 * `auroraPoolsSource.ts`'s WRAPPED_NATIVE_BY_CHAIN. This map is the hard
 * bound on the feature: a chain absent here can never be corrected, whatever
 * POOL_CACHING_V4_LP_FEE_CORRECTION_CHAINS says.
 */
export const V4_STATE_VIEW_BY_CHAIN: {[chainId: number]: string} = {
  [ChainId.MAINNET]: '0x7ffe42c4a5deea5b0fec41c94c136cf115597227',
  [ChainId.POLYGON]: '0x5ea1bd7974c8a611cbab0bdcafcb1d9cc9b3ba5a',
  // The five below were verified over PUBLIC RPCs only. The cron reaches
  // StateView through UniRPC (`/rpc/<chainId>`), a different path — confirm
  // each on a dev deploy before enabling that chain near prod.
  [ChainId.OPTIMISM]: '0xc18a3169788f4f75a170290584eca6395c75ecdb',
  [ChainId.BNB]: '0xd13dd3d6e93f276fafc9db9e6bb47c1180aee0c4',
  [ChainId.ROBINHOOD]: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b',
  [ChainId.ARBITRUM]: '0x76fd297e2d437cd7f76d50f01afe6160f86e9990',
  [ChainId.BASE]: '0xa3c0c9b65bad0b08107aa264b0f3db444b867a71',
};

const MAX_CONCURRENT_ONCHAIN_READS = 10;

/**
 * Takes no logger on purpose: the reader is memoized for the process while
 * each chain+protocol run has its own prefixed logger, so capturing one would
 * tag every later chain's output with the first chain's prefix. Unread pools
 * surface through `applyV4LpFeeCorrection`'s `unknown` count instead.
 */
export function makeStateViewPoolKeyFeeReader(
  uniRpcEndpoint: string
): V4PoolKeyFeeReader {
  const providers = new Map<number, ethers.providers.StaticJsonRpcProvider>();
  const providerFor = (chainId: number) => {
    let provider = providers.get(chainId);
    if (!provider) {
      // skipFetchSetup + timeout + service-id header mirror
      // ccaScheduledPools.ts / DynamicZlcaHooksRefresher — a bare
      // StaticJsonRpcProvider(url) fails against the UniRPC gateway from ECS
      // containers, and a hung socket must not outlive the run's timeout.
      provider = new ethers.providers.StaticJsonRpcProvider(
        {
          url: `${uniRpcEndpoint}/rpc/${chainId}`,
          skipFetchSetup: true,
          timeout: 10_000,
          headers: {['x-uni-service-id']: 'uniroute-pool-caching'},
        },
        chainId
      );
      providers.set(chainId, provider);
    }
    return provider;
  };

  return {
    readPoolKeyFees: async (chainId, poolIds) => {
      const stateView = V4_STATE_VIEW_BY_CHAIN[chainId];
      const result = new Map<string, V4PoolKeyFees>();
      if (!stateView || poolIds.length === 0) return result;

      const contract = new ethers.Contract(
        stateView,
        STATE_VIEW_ABI,
        providerFor(chainId)
      );
      const limit = pLimit(MAX_CONCURRENT_ONCHAIN_READS);
      await Promise.all(
        poolIds.map(poolId =>
          limit(async () => {
            try {
              const slot0 = await contract.getSlot0(poolId);
              // An uninitialized pool reads back all zeros; a real pool always
              // has a non-zero price. Skip rather than store lpFee 0, which is
              // itself a legitimate fee for an initialized pool.
              if (BigInt(slot0.sqrtPriceX96.toString()) === 0n) return;
              const {zeroForOnePips, oneForZeroPips} = unpackProtocolFee(
                Number(slot0.protocolFee)
              );
              result.set(poolId, {
                lpFeePips: Number(slot0.lpFee),
                zeroForOnePips,
                oneForZeroPips,
              });
            } catch {
              // Fail-soft per pool: an unread pool keeps its subgraph value.
            }
          })
        )
      );
      return result;
    },
  };
}

// --- Corrector ---

/**
 * Memo of pool-key fees, keyed `${chainId}:${poolId}`. This is what keeps the
 * steady-state RPC cost proportional to newly-admitted pools rather than to
 * snapshot size.
 *
 * Entries never go stale: `PoolKey.fee` is fixed at `Initialize` and can never
 * change (it is part of the pool's identity), which is why data-api treats the
 * Initialize-recorded fee as the authority. Only static-fee pools are memoized
 * — a dynamic-fee pool's slot0 lpFee does move, and those are never corrected.
 *
 * Bounded anyway: the cron process is long-lived and pools churn, so an
 * unbounded map would grow without limit. Evicting merely costs one re-read on
 * the next tick. The cap holds every V4 pool of the largest chains at once.
 */
const LP_FEE_MEMO_MAX_ENTRIES = 250_000;

const lpFeeMemo = new LRUCache<string, number>({
  max: LP_FEE_MEMO_MAX_ENTRIES,
});

/**
 * How long a pool that was READ and came back with no answer is held out of
 * the candidate list.
 *
 * This exists because the read cap is now filled highest-TVL-first. Ordering
 * by TVL is what makes a binding cap spend its reads well, but it also makes
 * the front of the queue stable: a block of high-TVL pools that StateView
 * cannot answer for would be re-selected every tick, re-occupy the whole
 * tranche, and starve every lower-TVL pool behind them indefinitely. Skipping
 * them for a bounded interval bounds that starvation without ever latching a
 * fee value — nothing is corrected on the strength of this cache, a pool in
 * cooldown simply keeps its subgraph fee and is still reported `unknown`.
 *
 * Short relative to how long a genuinely-broken pool stays broken, but long
 * enough to cover several ticks of the 2-minute fast job.
 */
const UNKNOWN_READ_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * Bounded like `lpFeeMemo`: the cron process is long-lived. Eviction only
 * costs one re-read, which is the pre-cooldown behaviour anyway.
 */
const UNKNOWN_COOLDOWN_MAX_ENTRIES = 250_000;

const unknownReadCooldown = new LRUCache<string, true>({
  max: UNKNOWN_COOLDOWN_MAX_ENTRIES,
  ttl: UNKNOWN_READ_COOLDOWN_MS,
});

/** Clears both process-lifetime caches: the fee memo and the unknown-read cooldown. */
export function resetV4LpFeeMemoForTesting(): void {
  lpFeeMemo.clear();
  unknownReadCooldown.clear();
}

export interface V4LpFeeCorrectionStats {
  read: number;
  corrected: number;
  alreadyCorrect: number;
  unknown: number;
  prefiltered: number;
  deferred: number;
  dynamic: number;
  unexplained: number;
  memoHits: number;
}

const STAT_BY_OUTCOME: {
  [outcome in FeeTierOutcome]: keyof V4LpFeeCorrectionStats;
} = {
  already_correct: 'alreadyCorrect',
  corrected: 'corrected',
  unknown: 'unknown',
  prefiltered: 'prefiltered',
  deferred: 'deferred',
  dynamic: 'dynamic',
  unexplained: 'unexplained',
};

/**
 * TVL as a sort key only — never as a threshold. `tvlUSD` is typed `number`
 * but arrives from the subgraph, so NaN/Infinity are reachable; those sort
 * last rather than poisoning every comparison and scrambling the order.
 */
function tvlUsdForOrdering(pool: V4SubgraphPool): number {
  const value = Number(pool.tvlUSD);
  return Number.isFinite(value) ? value : 0;
}

/**
 * Replaces the total-swap-fee `feeTier` with the pool-key LP fee for every
 * pool the on-chain read can explain. Returns the same array instance shape
 * (a new array of possibly-rewritten pools) so callers can drop it straight
 * into the existing pipeline.
 *
 * Never throws: a failed read leaves the snapshot exactly as it is today.
 */
export async function applyV4LpFeeCorrection(
  chainId: number,
  pools: V4SubgraphPool[],
  reader: V4PoolKeyFeeReader,
  logger: Logger,
  metric: IMetric,
  /**
   * Per-job cap, overriding the env cap for this pass only. Used by the
   * 2-minute Robinhood job, which needs a tighter tranche than the all-chain
   * job to stay inside its own timeout. `undefined` (not `0`) means "no
   * override" — see the `??` below.
   */
  maxReadsPerTickOverride?: number
): Promise<V4SubgraphPool[]> {
  const stats: V4LpFeeCorrectionStats = {
    read: 0,
    corrected: 0,
    alreadyCorrect: 0,
    unknown: 0,
    prefiltered: 0,
    deferred: 0,
    dynamic: 0,
    unexplained: 0,
    memoHits: 0,
  };
  const tags = {chainId: String(chainId)};

  const memoKey = (poolId: string) => `${chainId}:${poolId.toLowerCase()}`;
  // Settled up front so a dynamic-fee pool is excluded from the read and the
  // memo as well as the rewrite: its slot0 lpFee moves with every hook update,
  // so latching one would be wrong even if it were never written back.
  const isDynamic = new Map(
    pools.map(pool => [pool.id, isDynamicFeeV4Pool(chainId, pool)])
  );

  // Deliberately NOT memoized: a memo hit rewrites a drifted feeTier without
  // consulting StateView, so latching this skip-only proof would make it a
  // rewrite authority. A pool that grows a protocol fee later still reaches
  // StateView on the tick where it drifts.
  const provenByPoolId = new Set<string>();
  const candidatePools: V4SubgraphPool[] = [];
  for (const pool of pools) {
    if (isDynamic.get(pool.id) || lpFeeMemo.has(memoKey(pool.id))) continue;
    if (isFeeTierProvenByPoolId(chainId, pool)) {
      provenByPoolId.add(pool.id);
      continue;
    }
    // Held out after a read that produced no answer — see
    // UNKNOWN_READ_COOLDOWN_MS. Such a pool still falls through to the
    // `unknown` outcome below; it is only excluded from the READ list.
    if (unknownReadCooldown.has(memoKey(pool.id))) continue;
    candidatePools.push(pool);
  }
  // Highest TVL first, so that when the cap binds the reads are spent on the
  // pools whose fee is worth the most to get right rather than on whichever
  // pools the subgraph happened to return first. The id tie-break keeps the
  // tranche boundary deterministic across ticks (and across processes), which
  // is what makes "deferred now, read next tick" a stable rotation rather
  // than a reshuffle. Sorts a copy: `pools` is the caller's array.
  const candidates = candidatePools
    .sort(
      (a, b) =>
        tvlUsdForOrdering(b) - tvlUsdForOrdering(a) || a.id.localeCompare(b.id)
    )
    .map(pool => pool.id);

  const readCap = v4LpFeeCorrectionReadCapFromEnv();
  if (readCap.misconfigured) {
    metric?.putMetric(
      'CachePools.v4LpFeeCorrection.misconfigured',
      1,
      MetricLoggerUnit.Count,
      {...tags, reason: 'invalid_max_reads_per_tick'}
    );
    logger?.warn(
      `POOL_CACHING_V4_LP_FEE_CORRECTION_MAX_READS_PER_TICK is not a usable read cap; using ${readCap.maxReads}`
    );
  }
  // `??`, never `||`: an explicit per-job override of 0 is a load-shed
  // instruction ("defer everything this pass"), and `0 || envCap` would
  // silently turn it into the full env cap — the exact opposite.
  const maxReads = maxReadsPerTickOverride ?? readCap.maxReads;
  const toRead = candidates.slice(0, maxReads);
  // Read this pass, so an `unknown` below is a real no-answer rather than a
  // pool that was skipped by the cap or the cooldown.
  const attempted = new Set(toRead);
  // Past the cap: keep the subgraph value and retry next tick. Distinct from
  // `unknown`, which means the read was attempted and did not answer.
  const deferred = new Set(candidates.slice(maxReads));
  if (deferred.size > 0) {
    logger?.warn(
      `V4 lpFee correction chain ${chainId}: read cap ${maxReads} reached, deferring ${deferred.size} of ${candidates.length} pools`
    );
  }

  let fetched = new Map<string, V4PoolKeyFees>();
  try {
    fetched = await reader.readPoolKeyFees(chainId, toRead);
    stats.read = toRead.length;
  } catch (err) {
    metric?.putMetric(
      'CachePools.v4LpFeeCorrection.error',
      1,
      MetricLoggerUnit.Count,
      tags
    );
    logger?.error(
      `V4 lpFee correction read failed on chain ${chainId}; keeping subgraph fees`,
      {error: err instanceof Error ? err.message : String(err)}
    );
    return pools;
  }

  const bump = (outcome: FeeTierOutcome) => {
    stats[STAT_BY_OUTCOME[outcome]]++;
  };

  const corrected = pools.map(pool => {
    if (isDynamic.get(pool.id)) {
      bump('dynamic');
      return pool;
    }
    if (provenByPoolId.has(pool.id)) {
      bump('prefiltered');
      return pool;
    }
    if (deferred.has(pool.id)) {
      bump('deferred');
      return pool;
    }

    const key = memoKey(pool.id);
    const memoized = lpFeeMemo.get(key);

    // A memoized lpFee is already-validated and immutable, so it is applied
    // directly. It must NOT be re-run through resolveFeeTier with a synthetic
    // zero protocol fee: the guard would then fail to explain a still-drifted
    // feeTier and wrongly leave it in place.
    if (memoized !== undefined) {
      stats.memoHits++;
      const outcome =
        Number(pool.feeTier) === memoized ? 'already_correct' : 'corrected';
      bump(outcome);
      return outcome === 'corrected'
        ? {...pool, feeTier: String(memoized)}
        : pool;
    }

    const fees = fetched.get(pool.id);
    const {outcome, feeTier} = resolveFeeTier(pool.feeTier, fees);
    bump(outcome);
    // Spent a read and learned nothing. Hold this pool out of the candidate
    // list for a while so it cannot re-occupy a binding cap every tick. Only
    // pools actually read this pass qualify: a pool already in cooldown also
    // reports `unknown`, and re-arming on that would extend the cooldown
    // forever instead of letting it expire.
    if (outcome === 'unknown' && attempted.has(pool.id)) {
      unknownReadCooldown.set(memoKey(pool.id), true);
    }
    // Only a validated pool-key fee is memoized; an unexplained or dynamic
    // pool is re-read next tick rather than latching a value we don't trust.
    if (fees && (outcome === 'corrected' || outcome === 'already_correct')) {
      lpFeeMemo.set(key, fees.lpFeePips);
    }
    return outcome === 'corrected' ? {...pool, feeTier} : pool;
  });

  for (const [name, value] of Object.entries(stats)) {
    metric?.putMetric(
      `CachePools.v4LpFeeCorrection.${name}`,
      value,
      MetricLoggerUnit.Count,
      tags
    );
  }
  logger?.info(
    `V4 lpFee correction chain ${chainId}: corrected=${stats.corrected} ` +
      `alreadyCorrect=${stats.alreadyCorrect} unknown=${stats.unknown} ` +
      `prefiltered=${stats.prefiltered} deferred=${stats.deferred} ` +
      `dynamic=${stats.dynamic} unexplained=${stats.unexplained} ` +
      `reads=${stats.read} memoHits=${stats.memoHits}`
  );
  return corrected;
}

// --- Config ---

/**
 * Chains the correction runs on. Comma-separated chain ids, or `*` for every
 * chain with a known StateView. Empty/unset (the default) = feature off —
 * this is the kill switch. Chains without a StateView entry are ignored.
 */
export function v4LpFeeCorrectionChainsFromEnv(): ReadonlySet<number> {
  const raw = process.env.POOL_CACHING_V4_LP_FEE_CORRECTION_CHAINS?.trim();
  // Unset, empty, and whitespace all mean off. Opting in is explicit: this
  // path rewrites a fee on ~20k live mainnet pools, so it must never turn
  // itself on because a stack forgot to set the variable.
  if (!raw) return new Set();
  const supported = Object.keys(V4_STATE_VIEW_BY_CHAIN).map(Number);
  if (raw === '*') return new Set(supported);
  return new Set(
    raw
      .split(',')
      .map(entry => Number.parseInt(entry.trim(), 10))
      .filter(chainId => supported.includes(chainId))
  );
}

/**
 * Default read cap, set well above today's demand so it does not bind in
 * normal operation. It exists for a pathological subgraph regression (a
 * fee-field change that makes every pool look drifted) that would otherwise
 * hand StateView the entire V4 universe.
 */
export const V4_LP_FEE_CORRECTION_DEFAULT_MAX_READS_PER_TICK = 25_000;

/**
 * Above this a cap is indistinguishable from no cap, so a larger value is read
 * as a typo rather than as intent to remove the safety net.
 */
const MAX_READS_PER_TICK_CEILING = 1_000_000;

export interface V4LpFeeCorrectionReadCap {
  maxReads: number;
  /** A value was set but unusable; the default applies and ops must be told. */
  misconfigured: boolean;
}

/**
 * Cap on `StateView.getSlot0` reads per correction pass (one pass per enabled
 * chain per cron tick). Pools past the cap keep their subgraph value and are
 * retried on the next tick.
 *
 * `0` is a valid LOAD-SHED setting — defer every read — not an absent one.
 * That is why this cannot reuse `parsePositiveIntEnvOrDefault` (which rejects
 * 0) and why nothing here may apply `||` to the parsed number: `0 || DEFAULT`
 * is 25,000, the exact opposite of what the operator asked for.
 */
export function v4LpFeeCorrectionReadCapFromEnv(): V4LpFeeCorrectionReadCap {
  const raw =
    process.env.POOL_CACHING_V4_LP_FEE_CORRECTION_MAX_READS_PER_TICK?.trim() ??
    '';
  if (raw === '') {
    return {
      maxReads: V4_LP_FEE_CORRECTION_DEFAULT_MAX_READS_PER_TICK,
      misconfigured: false,
    };
  }
  // Digits only: `Number`/`parseInt` would coerce '-1', '1e5', '12.5', '0x10'
  // and '25 000' into a cap silently different from the configured one.
  const usable = /^\d+$/.test(raw) && Number(raw) <= MAX_READS_PER_TICK_CEILING;
  return usable
    ? {maxReads: Number(raw), misconfigured: false}
    : {
        maxReads: V4_LP_FEE_CORRECTION_DEFAULT_MAX_READS_PER_TICK,
        misconfigured: true,
      };
}
