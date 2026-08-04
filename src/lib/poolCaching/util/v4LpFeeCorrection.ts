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
 * That Aurora path is not enabled for uniroute in prod, so the fee is read
 * from `StateView.getSlot0`, which returns `lpFee` and `protocolFee`
 * directly — no inversion of the swap-fee formula is needed or attempted.
 *
 * Applied in the pool-caching cron BEFORE `v4HooksPoolsFiltering`, so the
 * corrected fee feeds the `token0+token1+feeTier` grouping and the canonical
 * `(feeTier, tickSpacing)` gate rather than only the served value.
 */

import {ethers} from 'ethers';
import pLimit from 'p-limit';
import {LRUCache} from 'lru-cache';
import {Currency, Token} from '@uniswap/sdk-core';
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
 * True when the pool's `PoolKey.fee` is the dynamic-fee sentinel.
 *
 * `PoolKey.fee` is the very thing this module derives, so it cannot be read
 * back directly. `isPoolFeeDynamic` sidesteps that by reproducing the pool id
 * with the sentinel substituted — the id is the only PoolKey field the
 * snapshot already carries verbatim. A hookless pool cannot have a dynamic
 * fee, which short-circuits the keccak for nearly every pool.
 *
 * Decimals are pinned to 18 rather than parsed: they do not enter the pool id,
 * and a NaN from the subgraph would fail the `Token` invariant for no reason.
 */
export function isDynamicFeeV4Pool(
  chainId: number,
  pool: V4SubgraphPool
): boolean {
  if (pool.hooks === ADDRESS_ZERO) return false;
  const currency = (address: string): Currency =>
    address === ADDRESS_ZERO
      ? nativeOnChain(chainId)
      : new Token(chainId, address, 18);
  try {
    return isPoolFeeDynamic(
      currency(pool.token0.id),
      currency(pool.token1.id),
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

export type FeeTierOutcome =
  /** Snapshot value already equals the pool-key fee (includes protocolFee 0). */
  | 'already_correct'
  /** Snapshot value was the total swap fee; replaced with the pool-key fee. */
  | 'corrected'
  /** No on-chain read available for this pool. */
  | 'unknown'
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

export function resetV4LpFeeMemoForTesting(): void {
  lpFeeMemo.clear();
}

export interface V4LpFeeCorrectionStats {
  read: number;
  corrected: number;
  alreadyCorrect: number;
  unknown: number;
  dynamic: number;
  unexplained: number;
  memoHits: number;
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
  metric: IMetric
): Promise<V4SubgraphPool[]> {
  const stats: V4LpFeeCorrectionStats = {
    read: 0,
    corrected: 0,
    alreadyCorrect: 0,
    unknown: 0,
    dynamic: 0,
    unexplained: 0,
    memoHits: 0,
  };

  const memoKey = (poolId: string) => `${chainId}:${poolId.toLowerCase()}`;
  // Settled up front so a dynamic-fee pool is excluded from the read and the
  // memo as well as the rewrite: its slot0 lpFee moves with every hook update,
  // so latching one would be wrong even if it were never written back.
  const isDynamic = new Map(
    pools.map(pool => [pool.id, isDynamicFeeV4Pool(chainId, pool)])
  );
  const toRead = pools
    .filter(pool => !isDynamic.get(pool.id) && !lpFeeMemo.has(memoKey(pool.id)))
    .map(pool => pool.id);

  let fetched = new Map<string, V4PoolKeyFees>();
  try {
    fetched = await reader.readPoolKeyFees(chainId, toRead);
    stats.read = toRead.length;
  } catch (err) {
    metric?.putMetric(
      'CachePools.v4LpFeeCorrection.error',
      1,
      MetricLoggerUnit.Count,
      {chainId: String(chainId)}
    );
    logger?.error(
      `V4 lpFee correction read failed on chain ${chainId}; keeping subgraph fees`,
      {error: err instanceof Error ? err.message : String(err)}
    );
    return pools;
  }

  const bump = (outcome: FeeTierOutcome) => {
    if (outcome === 'already_correct') stats.alreadyCorrect++;
    else stats[outcome]++;
  };

  const corrected = pools.map(pool => {
    if (isDynamic.get(pool.id)) {
      bump('dynamic');
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
    // Only a validated pool-key fee is memoized; an unexplained or dynamic
    // pool is re-read next tick rather than latching a value we don't trust.
    if (fees && (outcome === 'corrected' || outcome === 'already_correct')) {
      lpFeeMemo.set(key, fees.lpFeePips);
    }
    return outcome === 'corrected' ? {...pool, feeTier} : pool;
  });

  const tags = {chainId: String(chainId)};
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
