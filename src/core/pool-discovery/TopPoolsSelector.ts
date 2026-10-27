import {Address} from '../../models/address/Address';
import {
  IPoolSnapshotWarmer,
  isPoolsArrayMemoStable,
  ITopPoolsSelector,
  markPoolsForTokensUncacheable,
  PoolsForTokensCacheDirective,
  PoolsForTokensCacheSkipReason,
  UniPoolInfo,
  V2PoolInfo,
  V3PoolInfo,
  V4PoolInfo,
} from './interface';
import {
  buildMetricKey,
  buildStatusTags,
  ChainId,
  MetricFailureReason,
} from '../../lib/config';
import {
  BASE_TOKENS_PER_CHAIN,
  WRAPPED_NATIVE_CURRENCY,
} from '../../lib/tokenUtils';
import {Context} from '@uniswap/lib-uni/context';
import {RoutingBlockList} from '../../lib/RoutingBlockList';
import {CanonicalPools} from '../../lib/CanonicalPools';
import {FeatureGatedTokensRepository} from '../../stores/compliance/FeatureGatedTokensRepository';
import {
  IV4PoolKeyRegistry,
  V4RegistryPoolKey,
} from '../../stores/pool/V4PoolKeyRegistryStore';
import {Protocol} from '../../models/pool/Protocol';
import {V2Pool} from '../../models/pool/V2Pool';
import {IChainRepository} from '../../stores/chain/IChainRepository';
import {Chain} from '../../models/chain/Chain';
import {
  Erc4626RegistrySnapshot,
  Erc4626WrapperRegistrySource,
} from '../registry/Erc4626WrapperRegistry';
import {getApplicableV3FeeAmounts, V3Pool} from '../../models/pool/V3Pool';
import {
  getApplicableV4FeesTickspacingsHooks,
  V4Pool,
} from '../../models/pool/V4Pool';
import {HooksOptions} from '../../models/hooks/HooksOptions';
import {getExperimentHookAddresses} from '../../models/hooks/Experiment';
import {
  getActiveExperiment,
  RouteNamespaceContext,
} from '../../models/hooks/namespaces';
import {maybeDropPermissionedPools} from '../../models/hooks/PermissionedHooks';
import {maybeDropErc4626Pools} from '../../models/hooks/Erc4626WrapperHooks';
import {ADDRESS_ZERO} from '@uniswap/router-sdk';
import {IPoolSelectionConfig} from '../../lib/config';
import {matchesHooksOptions} from '../../lib/poolUtils';
import {
  AGG_HOOKS_PER_CHAIN,
  getTvlBypassHookAddresses,
} from '../../lib/poolCaching/util/hooksAddressesAllowlist';
import {
  assertValidSliceMs,
  DEFAULT_EVENT_LOOP_SLICE_MS,
  EventLoopSlicer,
} from '../../lib/eventLoopSlicer';

// Token-to-pool index for faster lookups
interface TokenPoolIndex {
  tokenToPools: Map<string, UniPoolInfo[]>;
}

// Pair-independent selection state derived from one pool snapshot. Building
// this is the O(all pools) part of filterPools; everything pair-specific is
// O(topN) lookups against it. `tvlSortedPools` is a build-time copy sorted by
// the getTopNPairs comparator and must never be mutated after build.
interface SelectionView {
  filteredPools: UniPoolInfo[];
  tokenPoolIndex: TokenPoolIndex;
  tvlSortedPools: UniPoolInfo[];
}

// `view` is set once `build` resolves; until then requests share `build`.
interface SelectionViewEntry {
  build: Promise<SelectionView>;
  view?: SelectionView;
}

export const METRIC_NON_CANONICAL_POOL = buildMetricKey(
  'TopPoolsSelector.NonCanonicalPool'
);

// Helper function to get pool liquidity based on pool type (using USD value for now)
export const getPoolTVL = (pool: UniPoolInfo): number => {
  return getPoolUsdTVL(pool);
};

// Helper function to get pool eth liquidity based on pool type
export const getPoolEthTVL = (pool: UniPoolInfo): number => {
  if ('tvlETH' in pool) {
    // V3/4 pools use tvlETH
    return Number(pool.tvlETH);
  }
  // V2 pools use reserve for now
  return Number(pool.reserve);
};

// Helper function to get pool usd liquidity based on pool type
export const getPoolUsdTVL = (pool: UniPoolInfo): number => {
  if ('tvlUSD' in pool) {
    // V3/4 pools use tvlUSD
    return Number(pool.tvlUSD);
  }
  // V2 pools use reserveUSD
  return Number(pool.reserveUSD);
};

// Helper function to get the other token in a pool
export const getOtherToken = (pool: UniPoolInfo, tokenId: string): string => {
  return pool.token0.id.toLowerCase() === tokenId.toLowerCase()
    ? pool.token1.id
    : pool.token0.id;
};

// Pools a selection-view build processes between slice checks.
export const SELECTION_VIEW_BUILD_CHUNK_SIZE = 512;

const isBuildChunkEnd = (index: number): boolean =>
  (index + 1) % SELECTION_VIEW_BUILD_CHUNK_SIZE === 0;

// Helper function to build token-to-pool index
export const buildTokenPoolIndex = (pools: UniPoolInfo[]): TokenPoolIndex => {
  const tokenToPools = new Map<string, UniPoolInfo[]>();
  for (const pool of pools) {
    indexPool(tokenToPools, pool.token0.id.toLowerCase(), pool);
    indexPool(tokenToPools, pool.token1.id.toLowerCase(), pool);
  }
  return {tokenToPools};
};

const indexPool = (
  tokenToPools: Map<string, UniPoolInfo[]>,
  tokenIdLower: string,
  pool: UniPoolInfo
): void => {
  let tokenPools = tokenToPools.get(tokenIdLower);
  if (tokenPools === undefined) {
    tokenPools = [];
    tokenToPools.set(tokenIdLower, tokenPools);
  }
  tokenPools.push(pool);
};

// The per-pool rule of BasicTopPoolsSelector.filterUnsupportedPools, shared
// with the selection-view build. countDrops emits the NonCanonicalPool count
// accumulated by admits. Canonical-pool lifts are read once, so a lift that
// flips while a sliced build is yielded cannot split one view across states.
class CompliancePoolFilter {
  private nonCanonicalDrops = 0;
  private readonly liftedTokens: ReadonlySet<string>;

  constructor(
    private readonly chainId: ChainId,
    private readonly unsupportedTokens: Set<string>
  ) {
    this.liftedTokens = CanonicalPools.liftedTokensSnapshot(chainId);
  }

  admits(pool: UniPoolInfo): boolean {
    if (
      this.unsupportedTokens.has(pool.token0.id.toLowerCase()) ||
      this.unsupportedTokens.has(pool.token1.id.toLowerCase())
    ) {
      return false;
    }
    if (
      !CanonicalPools.isPoolAdmitted(
        this.chainId,
        pool.id,
        pool.token0.id,
        pool.token1.id,
        this.liftedTokens
      )
    ) {
      this.nonCanonicalDrops++;
      return false;
    }
    return true;
  }

  countDrops(ctx: Context | undefined): void {
    CanonicalPools.countDroppedNonCanonicalPools(
      this.chainId,
      this.nonCanonicalDrops,
      ctx,
      METRIC_NON_CANONICAL_POOL
    );
  }
}

// Lowercased ids of a token's pool list, memoized on the list's identity.
// A selection view's index lists keep growing while the view builds, but no
// caller sees them until the build resolves, and they never change after.
// The view's index lives as long as its snapshot, so a hub token's id set (WETH,
// native ETH, USDC: tens of thousands of pools on a large chain) is built
// once per view rather than once per intersection — getTopPoolForTokens
// alone intersects with the WETH and ETH lists for every intermediary token
// of every request.
const lowercasedPoolIdSetMemo = new WeakMap<UniPoolInfo[], Set<string>>();

export const getLowercasedPoolIdSet = (pools: UniPoolInfo[]): Set<string> => {
  let ids = lowercasedPoolIdSetMemo.get(pools);
  if (ids === undefined) {
    ids = new Set(pools.map(pool => pool.id.toLowerCase()));
    lowercasedPoolIdSetMemo.set(pools, ids);
  }
  return ids;
};

// A token pair to look up, both addresses already lowercased.
export type LowercasedTokenPair = {tokenALower: string; tokenBLower: string};

// For each pair, the highest-TVL pool containing both tokens whose lowercased
// id is not in selectedPoolIdsLower and that `isEligible` accepts, or
// undefined when none does. On equal TVL the earliest pool in `pools` wins,
// and a non-finite TVL ranks below every finite one. One pass answers every
// pair, for callers that look up a handful of pairs in a full snapshot and
// would otherwise build a token index over it. `isEligible` runs only for
// pools that match a pair and are unselected, at most once per pool, so a
// per-pool admission rule costs nothing for the rest of the snapshot.
export const findTopUnselectedPoolsForPairs = (
  pools: UniPoolInfo[],
  pairs: LowercasedTokenPair[],
  selectedPoolIdsLower: Set<string>,
  isEligible: (pool: UniPoolInfo) => boolean
): (UniPoolInfo | undefined)[] => {
  if (pairs.length === 0) {
    return [];
  }
  const topMatches: ({pool: UniPoolInfo; tvl: number} | undefined)[] =
    pairs.map(() => undefined);

  for (const pool of pools) {
    const token0Lower = pool.token0.id.toLowerCase();
    const token1Lower = pool.token1.id.toLowerCase();
    let eligible: boolean | undefined;
    for (let pairIndex = 0; pairIndex < pairs.length; pairIndex++) {
      const {tokenALower, tokenBLower} = pairs[pairIndex];
      if (
        (token0Lower !== tokenALower && token1Lower !== tokenALower) ||
        (token0Lower !== tokenBLower && token1Lower !== tokenBLower) ||
        selectedPoolIdsLower.has(pool.id.toLowerCase())
      ) {
        continue;
      }
      eligible ??= isEligible(pool);
      if (!eligible) {
        continue;
      }

      const rawTvl = getPoolTVL(pool);
      const tvl = Number.isFinite(rawTvl) ? rawTvl : -Infinity;
      const topMatch = topMatches[pairIndex];
      if (topMatch === undefined || tvl > topMatch.tvl) {
        topMatches[pairIndex] = {pool, tvl};
      }
    }
  }

  return topMatches.map(topMatch => topMatch?.pool);
};

// Worst-case pool count returned by manuallyGenerateDirectPairs across all
// (protocol, chain) combos. V2 → 1, V3 → up to V3FeeAmountsBase.length (BASE
// has the most fee tiers), V4 → canonical grid (8) + hookless registry (8) +
// hooked registry (8). Keep 24 explicit: an arithmetic cap can silently
// truncate hooked fallback keys if either source ordering changes.
export const MAX_MANUAL_DIRECT_PAIRS_FALLBACK = 24;

// Strict upper bound on pools BasicTopPoolsSelector.filterPools can return for
// a given (chainId, protocol, tokenIn, tokenOut). Mirrors the stage limits in
// filterPools(); update both together. Pools are deduped via shared
// selectedPoolIds, so this is a real upper bound, not a sum of expectations.
//
// Excludes experiment-hook pools (V4 + experiment opt-in only) — unbounded by
// config but small in practice. Callers gating on this should leave headroom.
export function getMaxFilteredPoolCount(config: IPoolSelectionConfig): number {
  const oneHopBoth = 2 * config.topNOneHopPairs;
  const intermediaryTokens = oneHopBoth; // worst case: one new token per one-hop pool
  const secondHopPerIntermediary = config.topNSecondHopPairs + 2; // + WETH + ETH
  return (
    // Stage-1 direct pairs OR manual fallback — the two are mutually
    // exclusive (fallback only fires when stage-1 returns 0).
    Math.max(config.topNDirectPairs, MAX_MANUAL_DIRECT_PAIRS_FALLBACK) +
    oneHopBoth + // tokenIn-only + tokenOut-only
    intermediaryTokens * secondHopPerIntermediary + // second-hop per intermediary
    config.topNPairs + // global top-N
    2 * config.topNWithBaseToken + // base-token pools for tokenIn + tokenOut
    4 // top WETH/ETH pool × {tokenIn, tokenOut}
  );
}

export class BasicTopPoolsSelector
  implements ITopPoolsSelector<UniPoolInfo>, IPoolSnapshotWarmer
{
  // Selection views memoized by (pools array, deny-list payload) identity.
  // Layer-1 memoization in BaseCachingPoolDiscoverer keeps both references
  // stable for the lifetime of a snapshot, so views rebuild exactly when the
  // snapshot or deny list actually changes and are GC'd with the old arrays.
  // The inner key is the ≤4-valued hooksOptions variant per chain/protocol.
  private readonly selectionViewMemo = new WeakMap<
    UniPoolInfo[],
    WeakMap<Set<string>, Map<string, SelectionViewEntry>>
  >();

  // hooksOptions variants requests have asked a selection view for, per
  // `${chainId}#${protocol}` (canonicalized like the view key, so at most
  // three per V4 key and one per V2/V3 key). warmSnapshot prebuilds exactly
  // these for a new snapshot.
  private readonly requestedViewVariants = new Map<string, Set<HooksOptions>>();

  // Settles when the last queued view build for `${chainId}#${protocol}` has,
  // and is removed then, so an entry means a new build for that key waits.
  private readonly buildQueueTails = new Map<string, Promise<void>>();

  constructor(
    private readonly chainRepository: IChainRepository,
    private readonly poolSelectionConfig: Record<ChainId, IPoolSelectionConfig>,
    protected readonly featureGatedTokensRepository: FeatureGatedTokensRepository,
    private readonly snapshotMemoEnabled: boolean = false,
    // Optional so existing construction sites keep working; without it the
    // manual direct-pair fallback stays on the canonical grid alone.
    private readonly poolKeyRegistry?: IV4PoolKeyRegistry,
    private readonly eventLoopSliceMs: number = DEFAULT_EVENT_LOOP_SLICE_MS,
    private readonly erc4626WrapperRegistry?: Erc4626WrapperRegistrySource,
    private readonly clock: () => number = () => performance.now()
  ) {
    assertValidSliceMs(eventLoopSliceMs);
  }

  public async filterPools(
    pools: UniPoolInfo[],
    chainId: ChainId,
    tokenIn: Address,
    tokenOut: Address,
    protocol: Protocol,
    hooksOptions: HooksOptions | undefined,
    nsCtx: RouteNamespaceContext,
    ctx: Context,
    cacheDirective: PoolsForTokensCacheDirective
  ): Promise<UniPoolInfo[]> {
    const experiment = getActiveExperiment(nsCtx);
    ctx.logger.debug(
      `Starting Filtering pools for tokens ${tokenIn} and ${tokenOut}`
    );

    // Filter out pools that are unsupported:
    // Only consider pools where neither tokens are in the blocked token list.
    const {globalSet: unsupportedTokens} =
      await this.featureGatedTokensRepository.getSnapshot(ctx);

    const chain =
      protocol === Protocol.V4
        ? await this.chainRepository.getChain(chainId)
        : undefined;

    // The view memo only engages for arrays the discoverer marked as
    // identity-stable (memoized snapshot outputs). Per-request arrays from
    // Direct/Static discoverers would structurally miss an identity-keyed
    // memo every call — churning WeakMap entries and flooding the
    // SelectionView.Cache hit/miss signal the flag rollout is judged by —
    // so they silently keep the legacy path (which is cheap on their small
    // universes).
    const arrayMemoStable = isPoolsArrayMemoStable(pools);
    const canUseSelectionView = this.usesSelectionView(
      pools,
      chain,
      nsCtx.erc4626Snapshot
    );

    let filteredPools: UniPoolInfo[];
    let tokenPoolIndex: TokenPoolIndex;
    let tvlSortedPools: UniPoolInfo[] | undefined;

    if (canUseSelectionView) {
      const view = await this.getOrBuildSelectionView(
        pools,
        unsupportedTokens,
        chainId,
        protocol,
        hooksOptions,
        ctx
      );
      filteredPools = view.filteredPools;
      tokenPoolIndex = view.tokenPoolIndex;
      tvlSortedPools = view.tvlSortedPools;
      ctx.logger.debug('Filtering unsupported tokens from pools', {
        chainId,
        totalChainPools: pools.length,
        filteredPools: filteredPools.length,
      });
    } else {
      // `bypass` marks a stable snapshot array we CHOSE not to memoize
      // (permissioned-hook or ERC-4626 chain). Unstable per-request arrays
      // stay silent — emitting per direct-pool request would drown the signal.
      if (this.snapshotMemoEnabled && arrayMemoStable) {
        await ctx.metrics.count(
          buildMetricKey('TopPoolsSelector.SelectionView.Cache'),
          1,
          {
            tags: [`chain:${chainId}`, `protocol:${protocol}`, 'result:bypass'],
          }
        );
      }
      const fallbackSlicer = this.newSlicer();
      const filteredUnsupportedPools =
        BasicTopPoolsSelector.filterUnsupportedPools(
          pools,
          chainId,
          unsupportedTokens,
          ctx
        );
      ctx.logger.debug('Filtering unsupported tokens from pools', {
        chainId,
        totalChainPools: pools.length,
        filteredUnsupportedPools: filteredUnsupportedPools.length,
      });

      // Also filter out pools that don't match the hooks options,
      // only if the uniswap protocol is v4.
      // Additionally, exclude agg hook pools — those are handled exclusively by
      // AggHooksTopPoolsSelector and must not appear in BasicTopPoolsSelector results.
      const aggHookAddressSet =
        BasicTopPoolsSelector.getAggHookAddressSet(chainId);

      let permissionedFilteredPools: UniPoolInfo[];
      if (chain !== undefined) {
        const dropResult = await maybeDropPermissionedPools(
          filteredUnsupportedPools as V4PoolInfo[],
          chain,
          nsCtx,
          tokenIn,
          tokenOut,
          ctx,
          buildMetricKey('TopPoolsSelector.PermissionedPoolDropped')
        );
        permissionedFilteredPools = dropResult.filteredPools;
        if (!dropResult.shouldCache) {
          markPoolsForTokensUncacheable(
            cacheDirective,
            PoolsForTokensCacheSkipReason.PermissionedHookInactiveNamespace
          );
        }
      } else {
        permissionedFilteredPools = filteredUnsupportedPools;
      }

      const erc4626DropResult = nsCtx.erc4626Snapshot
        ? await maybeDropErc4626Pools(
            permissionedFilteredPools,
            nsCtx.erc4626Snapshot,
            tokenIn,
            tokenOut,
            ctx,
            buildMetricKey('TopPoolsSelector.Erc4626WrapperHooks.poolDropped')
          )
        : {filteredPools: permissionedFilteredPools, shouldCache: true};
      if (!erc4626DropResult.shouldCache) {
        markPoolsForTokensUncacheable(
          cacheDirective,
          PoolsForTokensCacheSkipReason.Erc4626WrapperPool
        );
      }
      const logExcludedAggHookPool = (pool: UniPoolInfo) =>
        ctx.logger.debug('Excluding agg hook pool', {
          chainId,
          protocol,
          poolId: pool.id,
          poolHooks: 'hooks' in pool ? pool.hooks : undefined,
        });
      filteredPools = erc4626DropResult.filteredPools.filter(pool =>
        BasicTopPoolsSelector.isSelectablePool(
          pool,
          protocol,
          hooksOptions,
          aggHookAddressSet,
          logExcludedAggHookPool
        )
      );

      ctx.logger.debug("Filtering pools that don't match the hooks options", {
        chainId,
        filteredUnsupportedPools: filteredUnsupportedPools.length,
        filteredPools: filteredPools.length,
      });

      // Build token-to-pool index for faster lookups
      tokenPoolIndex = buildTokenPoolIndex(filteredPools);
      await fallbackSlicer.yieldIfSliceElapsed();
    }

    // Keep track of selected pool addresses to avoid duplicates
    const selectedPoolIds = new Set<string>();
    const slicer = this.newSlicer();

    // 1. Direct pairs (pools with both tokenIn and tokenOut)
    let directPairs = BasicTopPoolsSelector.getDirectPairs(
      filteredPools,
      chainId,
      protocol,
      tokenIn,
      tokenOut,
      selectedPoolIds,
      tokenPoolIndex,
      this.poolSelectionConfig
    );
    await slicer.yieldIfSliceElapsed();

    // 2. Pools with only tokenIn
    const tokenInOnlyPairs = BasicTopPoolsSelector.getTokenInOnlyPairs(
      tokenIn,
      tokenOut,
      selectedPoolIds,
      tokenPoolIndex,
      chainId,
      this.poolSelectionConfig
    );
    await slicer.yieldIfSliceElapsed();

    // 3. Pools with only tokenOut
    const tokenOutOnlyPairs = BasicTopPoolsSelector.getTokenOutOnlyPairs(
      tokenIn,
      tokenOut,
      selectedPoolIds,
      tokenPoolIndex,
      chainId,
      this.poolSelectionConfig
    );
    await slicer.yieldIfSliceElapsed();

    // 4. Get tokens from first hop pools to use as intermediary tokens
    const intermediaryTokenIds = BasicTopPoolsSelector.getIntermediaryTokenIds(
      tokenInOnlyPairs,
      tokenOutOnlyPairs,
      tokenIn,
      tokenOut
    );

    // 5. For each intermediary token, get top N pools
    const secondHopPairs: UniPoolInfo[] = [];
    for (const intermediaryTokenId of intermediaryTokenIds) {
      secondHopPairs.push(
        ...BasicTopPoolsSelector.getTopNPoolsForIntermediaryToken(
          [intermediaryTokenId],
          selectedPoolIds,
          tokenPoolIndex,
          chainId,
          this.poolSelectionConfig
        )
      );
      await slicer.yieldIfSliceElapsed();
    }

    // 6. get top N pools with highest liquidity (excluding already selected pools)
    // The selection-view path walks the pre-sorted copy instead of
    // re-sorting the whole universe per request; output is identical.
    const topNPairs =
      tvlSortedPools !== undefined
        ? BasicTopPoolsSelector.getTopNPairsFromSorted(
            tvlSortedPools,
            selectedPoolIds,
            chainId,
            this.poolSelectionConfig
          )
        : BasicTopPoolsSelector.getTopNPairs(
            filteredPools,
            selectedPoolIds,
            chainId,
            this.poolSelectionConfig
          );

    // 7. Get top base token pools for tokenIn and tokenOut
    const topBaseTokenPoolsTokenIn = BasicTopPoolsSelector.getTopBaseTokenPools(
      selectedPoolIds,
      chainId,
      tokenIn.address,
      tokenPoolIndex,
      this.poolSelectionConfig
    );
    await slicer.yieldIfSliceElapsed();

    const topBaseTokenPoolsTokenOut =
      BasicTopPoolsSelector.getTopBaseTokenPools(
        selectedPoolIds,
        chainId,
        tokenOut.address,
        tokenPoolIndex,
        this.poolSelectionConfig
      );
    await slicer.yieldIfSliceElapsed();

    // 8. Top 1 WETH and ETH pool for tokenIn
    const topWethPoolTokenIn = BasicTopPoolsSelector.getTopPoolForTokens(
      selectedPoolIds,
      WRAPPED_NATIVE_CURRENCY[chainId].address,
      tokenIn.address,
      tokenPoolIndex
    );
    const topEthPoolTokenIn = BasicTopPoolsSelector.getTopPoolForTokens(
      selectedPoolIds,
      ADDRESS_ZERO,
      tokenIn.address,
      tokenPoolIndex
    );
    await slicer.yieldIfSliceElapsed();

    // 9. Top 1 WETH and ETH pool for tokenOut
    const topWethPoolTokenOut = BasicTopPoolsSelector.getTopPoolForTokens(
      selectedPoolIds,
      WRAPPED_NATIVE_CURRENCY[chainId].address,
      tokenOut.address,
      tokenPoolIndex
    );
    const topEthPoolTokenOut = BasicTopPoolsSelector.getTopPoolForTokens(
      selectedPoolIds,
      ADDRESS_ZERO,
      tokenOut.address,
      tokenPoolIndex
    );

    let allPools = [
      ...directPairs,
      ...tokenInOnlyPairs,
      ...tokenOutOnlyPairs,
      ...secondHopPairs,
      ...topNPairs,
      ...topBaseTokenPoolsTokenIn,
      ...topBaseTokenPoolsTokenOut,
      ...topWethPoolTokenIn,
      ...topWethPoolTokenOut,
      ...topEthPoolTokenIn,
      ...topEthPoolTokenOut,
    ];

    // Manually append V4 pools bearing experiment hook addresses so the
    // experimental-hooks routing path always sees them as candidates,
    // regardless of TVL / top-N thresholds. Operates on the pre-filter
    // `pools` input so pools that would otherwise be pruned still make it
    // through. Gated on V4 because experiment hooks are a V4-only concept,
    // and on a non-empty hook set so a hookless experiment costs nothing here
    // (resolveNamespaces already refuses to activate one).
    const experimentHookAddresses =
      experiment === undefined
        ? undefined
        : getExperimentHookAddresses(experiment);
    if (
      protocol === Protocol.V4 &&
      experiment !== undefined &&
      experimentHookAddresses !== undefined &&
      experimentHookAddresses.size > 0
    ) {
      // The counter tallies every matching pool before the dedupe check, so
      // `available` counts pools an earlier stage already selected too.
      let experimentPoolsAvailable = 0;
      const experimentPools = pools.filter(pool => {
        const hooks = (pool as V4PoolInfo).hooks?.toLowerCase();
        if (!hooks || !experimentHookAddresses.has(hooks)) {
          return false;
        }
        // Reads the pre-filter universe, so the canonical-pools rule has to
        // be re-applied here.
        if (
          !CanonicalPools.isPoolAdmitted(
            chainId,
            pool.id,
            pool.token0.id,
            pool.token1.id
          )
        ) {
          return false;
        }
        experimentPoolsAvailable++;
        const poolId = pool.id.toLowerCase();
        if (selectedPoolIds.has(poolId)) {
          return false;
        }
        selectedPoolIds.add(poolId);
        return true;
      });
      allPools = [...allPools, ...experimentPools];
      ctx.logger.debug('Manually appended experiment pools', {
        chainId,
        experiment,
        availableCount: experimentPoolsAvailable,
        appendedCount: experimentPools.length,
      });
      const experimentMetricTags = [
        `chainId:${chainId}`,
        `experiment:${experiment}`,
      ];
      await Promise.all([
        ctx.metrics.count(buildMetricKey('TopPoolsSelector.ExperimentHit'), 1, {
          tags: experimentMetricTags,
        }),
        ctx.metrics.count(
          buildMetricKey('TopPoolsSelector.ExperimentPoolsAvailable'),
          experimentPoolsAvailable,
          {tags: experimentMetricTags}
        ),
        ctx.metrics.count(
          buildMetricKey('TopPoolsSelector.ExperimentPoolsAppended'),
          experimentPools.length,
          {tags: experimentMetricTags}
        ),
      ]);
    }

    // 10. Finally, manually add some direct pairs pools if not already discovered/selected.
    // This is to handle the case where a direct pool exists but was not returned by the subgraph query.
    // Only add the direct pairs if we have at least one pool from the subgraph to allow static provider fallback to kick in.
    // Ensures that new pools can be swapped on immediately, and that if a pool was filtered out of the
    // subgraph query for some reason (e.g. trackedReserveETH was 0), then we still consider it.
    if (allPools.length > 0 && directPairs.length === 0) {
      directPairs = await this.manuallyGenerateDirectPairs(
        protocol,
        chainId,
        tokenIn.address,
        tokenOut.address,
        selectedPoolIds,
        hooksOptions
      );
      allPools = [...allPools, ...directPairs];
    }

    // Log selected pools
    ctx.logger.debug('TopPoolSelector selected pools', {
      chainId,
      protocol,
      totalChainPools: filteredPools.length,
      directPairs,
      tokenInOnlyPairs,
      tokenOutOnlyPairs,
      secondHopPairs,
      topNPairs,
      topBaseTokenPoolsTokenIn,
      topBaseTokenPoolsTokenOut,
      topWethPoolTokenIn,
      topWethPoolTokenOut,
      topEthPoolTokenIn,
      topEthPoolTokenOut,
      intermediaryTokenIds,
    });

    return allPools;
  }

  /**
   * Drops pools that carry a feature-gated (unsupported) token, and pools
   * that carry a token with a canonical-pools entry without being one of
   * its canonical pools. Both selectors run every candidate universe through
   * this rule before any selection stage (the selection-view build applies
   * it pool by pool through the same CompliancePoolFilter), so a
   * non-canonical pool can never occupy a top-N slot. Drops are counted on
   * `TopPoolsSelector.NonCanonicalPool` when `ctx` is given. Whether the canonical pool exists at all is checked
   * once per loaded snapshot by `CanonicalPools.checkRegistryCoverage`, not
   * here: this runs per protocol and per pair, so the canonical v4 pool is
   * legitimately absent from most inputs.
   */
  public static filterUnsupportedPools(
    pools: UniPoolInfo[],
    chainId: ChainId,
    unsupportedTokens: Set<string>,
    ctx?: Context
  ): UniPoolInfo[] {
    const complianceFilter = new CompliancePoolFilter(
      chainId,
      unsupportedTokens
    );
    const admittedPools = pools.filter(pool => complianceFilter.admits(pool));
    complianceFilter.countDrops(ctx);
    return admittedPools;
  }

  // The permissioned-hook and ERC-4626 (xStocks) drops are pair-dependent, so
  // chains with either keep the unsliced path. warmSnapshot must not build a
  // view this refuses.
  private usesSelectionView(
    pools: UniPoolInfo[],
    chain: Chain | undefined,
    erc4626Snapshot: Erc4626RegistrySnapshot | undefined
  ): boolean {
    return (
      this.snapshotMemoEnabled &&
      isPoolsArrayMemoStable(pools) &&
      (chain?.permissionedHookAddresses?.length ?? 0) === 0 &&
      (erc4626Snapshot?.assets.length ?? 0) === 0
    );
  }

  private newSlicer(): EventLoopSlicer {
    return new EventLoopSlicer(this.eventLoopSliceMs, this.clock);
  }

  protected static getAggHookAddressSet(chainId: ChainId): Set<string> {
    return new Set(
      Object.values(AGG_HOOKS_PER_CHAIN).flatMap(perChain =>
        (perChain?.[chainId] ?? []).map(addr => addr.toLowerCase())
      )
    );
  }

  // V4 pools bearing an agg hook are excluded from BasicTopPoolsSelector
  // results regardless of hooksOptions — AggHooksTopPoolsSelector owns those.
  protected static isExcludedAggHookPool(
    pool: UniPoolInfo,
    protocol: Protocol,
    aggHookAddressSet: Set<string>
  ): boolean {
    return (
      protocol === Protocol.V4 &&
      aggHookAddressSet.has((pool as V4PoolInfo).hooks?.toLowerCase())
    );
  }

  protected static matchesHooksOptions(
    pool: UniPoolInfo,
    protocol: Protocol,
    hooksOptions: HooksOptions | undefined
  ): boolean {
    return matchesHooksOptions(pool, protocol, hooksOptions);
  }

  private static isSelectablePool(
    pool: UniPoolInfo,
    protocol: Protocol,
    hooksOptions: HooksOptions | undefined,
    aggHookAddressSet: Set<string>,
    onAggHookPoolExcluded?: (pool: UniPoolInfo) => void
  ): boolean {
    if (
      BasicTopPoolsSelector.isExcludedAggHookPool(
        pool,
        protocol,
        aggHookAddressSet
      )
    ) {
      onAggHookPoolExcluded?.(pool);
      return false;
    }
    return BasicTopPoolsSelector.matchesHooksOptions(
      pool,
      protocol,
      hooksOptions
    );
  }

  // Canonicalized: hooksOptions only affects V4 filtering, and undefined is
  // filter-identical to HOOKS_INCLUSIVE — collapsing those variants avoids
  // building content-identical views per alias.
  private static canonicalViewHooksOptions(
    protocol: Protocol,
    hooksOptions: HooksOptions | undefined
  ): HooksOptions {
    return protocol === Protocol.V4
      ? hooksOptions ?? HooksOptions.HOOKS_INCLUSIVE
      : HooksOptions.HOOKS_INCLUSIVE;
  }

  private getSelectionViewSlot(
    pools: UniPoolInfo[],
    unsupportedTokens: Set<string>,
    chainId: ChainId,
    protocol: Protocol,
    hooksOptions: HooksOptions | undefined
  ): {byVariant: Map<string, SelectionViewEntry>; variantKey: string} {
    let byDenySet = this.selectionViewMemo.get(pools);
    if (byDenySet === undefined) {
      byDenySet = new WeakMap();
      this.selectionViewMemo.set(pools, byDenySet);
    }
    let byVariant = byDenySet.get(unsupportedTokens);
    if (byVariant === undefined) {
      byVariant = new Map();
      byDenySet.set(unsupportedTokens, byVariant);
    }
    const variantKey =
      protocol === Protocol.V4
        ? `${chainId}#${protocol}#${BasicTopPoolsSelector.canonicalViewHooksOptions(protocol, hooksOptions)}`
        : `${chainId}#${protocol}`;
    return {byVariant, variantKey};
  }

  /**
   * Prebuilds, for a snapshot a discoverer just published, the selection
   * views requests have been using for this chain and protocol (the
   * inclusive variant when none has been requested yet), so the first
   * request after a snapshot swap does not pay the build. Views are keyed
   * and built exactly as getOrBuildSelectionView would build them, so
   * selection results are unchanged. Skipped wherever the request path
   * would not use a view.
   */
  public async warmSnapshot(
    pools: UniPoolInfo[],
    unsupportedTokens: Set<string>,
    chainId: ChainId,
    protocol: Protocol,
    ctx: Context
  ): Promise<void> {
    if (!this.snapshotMemoEnabled || !isPoolsArrayMemoStable(pools)) {
      return;
    }
    const [chain, erc4626Snapshot] = await Promise.all([
      protocol === Protocol.V4
        ? this.chainRepository.getChain(chainId)
        : undefined,
      this.erc4626WrapperRegistry?.getSnapshot(chainId, ctx),
    ]);
    if (!this.usesSelectionView(pools, chain, erc4626Snapshot)) {
      return;
    }
    const variants = this.requestedViewVariants.get(
      `${chainId}#${protocol}`
    ) ?? [HooksOptions.HOOKS_INCLUSIVE];
    let built = 0;
    let failed = false;
    let firstError: unknown;
    for (const hooksOptions of variants) {
      const {byVariant, variantKey} = this.getSelectionViewSlot(
        pools,
        unsupportedTokens,
        chainId,
        protocol,
        hooksOptions
      );
      if (byVariant.has(variantKey)) {
        continue;
      }
      try {
        await this.publishSelectionView(
          byVariant,
          variantKey,
          pools,
          unsupportedTokens,
          chainId,
          protocol,
          hooksOptions,
          ctx
        );
        built += 1;
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
      }
    }
    // Failures are counted per variant by SelectionView.Build and by the
    // caller's SnapshotWarm, so Prebuild only counts views built.
    void ctx.metrics
      .count(buildMetricKey('TopPoolsSelector.SelectionView.Prebuild'), built, {
        tags: [`chain:${chainId}`, `protocol:${protocol}`, 'status:success'],
      })
      .catch(() => undefined);
    if (failed) {
      throw firstError;
    }
  }

  // Published before the build starts, so concurrent misses for one view
  // share a single build. Builds for one chain and protocol run one at a time,
  // each holding a full-snapshot copy while it runs. A failed build is
  // unpublished so the next request retries it.
  private publishSelectionView(
    byVariant: Map<string, SelectionViewEntry>,
    variantKey: string,
    pools: UniPoolInfo[],
    unsupportedTokens: Set<string>,
    chainId: ChainId,
    protocol: Protocol,
    hooksOptions: HooksOptions | undefined,
    ctx: Context
  ): Promise<SelectionView> {
    const queueKey = `${chainId}#${protocol}`;
    const tags = [`chain:${chainId}`, `protocol:${protocol}`];
    const queueTail = this.buildQueueTails.get(queueKey);
    if (queueTail !== undefined) {
      void ctx.metrics
        .count(
          buildMetricKey('TopPoolsSelector.SelectionView.Build.Queued'),
          1,
          {tags}
        )
        .catch(() => undefined);
    }
    const entry: SelectionViewEntry = {
      build: (queueTail ?? Promise.resolve()).then(async () => {
        const startedAt = this.clock();
        const view = await BasicTopPoolsSelector.buildSelectionView(
          pools,
          unsupportedTokens,
          chainId,
          protocol,
          hooksOptions,
          ctx,
          // One slicer per build: builds for different keys each hold up to
          // a slice per turn, bounded by the few keys building at once. A
          // shared slicer would let the first build to resume take every
          // slice and starve the others.
          this.newSlicer()
        );
        void ctx.metrics
          .dist(
            buildMetricKey('TopPoolsSelector.SelectionView.Build.Latency.dist'),
            this.clock() - startedAt,
            {tags}
          )
          .catch(() => undefined);
        return view;
      }),
    };
    byVariant.set(variantKey, entry);
    const removeSettledTail = (): void => {
      if (this.buildQueueTails.get(queueKey) === tail) {
        this.buildQueueTails.delete(queueKey);
      }
    };
    const tail = entry.build.then(removeSettledTail, removeSettledTail);
    this.buildQueueTails.set(queueKey, tail);
    const countBuild = (succeeded: boolean) =>
      void ctx.metrics
        .count(buildMetricKey('TopPoolsSelector.SelectionView.Build'), 1, {
          tags: [
            ...tags,
            ...buildStatusTags(
              succeeded,
              MetricFailureReason.SELECTION_VIEW_BUILD_ERROR
            ),
          ],
        })
        .catch(() => undefined);
    entry.build.then(
      view => {
        entry.view = view;
        countBuild(true);
      },
      () => {
        if (byVariant.get(variantKey) === entry) {
          byVariant.delete(variantKey);
        }
        countBuild(false);
      }
    );
    return entry.build;
  }

  private static async buildSelectionView(
    pools: UniPoolInfo[],
    unsupportedTokens: Set<string>,
    chainId: ChainId,
    protocol: Protocol,
    hooksOptions: HooksOptions | undefined,
    ctx: Context,
    slicer: EventLoopSlicer
  ): Promise<SelectionView> {
    const aggHookAddressSet =
      BasicTopPoolsSelector.getAggHookAddressSet(chainId);
    const complianceFilter = new CompliancePoolFilter(
      chainId,
      unsupportedTokens
    );
    const filteredPools: UniPoolInfo[] = [];
    const tokenToPools = new Map<string, UniPoolInfo[]>();
    for (let index = 0; index < pools.length; index++) {
      const pool = pools[index];
      if (
        complianceFilter.admits(pool) &&
        BasicTopPoolsSelector.isSelectablePool(
          pool,
          protocol,
          hooksOptions,
          aggHookAddressSet
        )
      ) {
        filteredPools.push(pool);
        indexPool(tokenToPools, pool.token0.id.toLowerCase(), pool);
        indexPool(tokenToPools, pool.token1.id.toLowerCase(), pool);
      }
      if (isBuildChunkEnd(index)) {
        await slicer.yieldIfSliceElapsed();
      }
    }
    complianceFilter.countDrops(ctx);
    const tvlSortedPools = await BasicTopPoolsSelector.buildTvlSortedPools(
      filteredPools,
      slicer
    );
    return {filteredPools, tokenPoolIndex: {tokenToPools}, tvlSortedPools};
  }

  private async getOrBuildSelectionView(
    pools: UniPoolInfo[],
    unsupportedTokens: Set<string>,
    chainId: ChainId,
    protocol: Protocol,
    hooksOptions: HooksOptions | undefined,
    ctx: Context
  ): Promise<SelectionView> {
    const variantsKey = `${chainId}#${protocol}`;
    let requested = this.requestedViewVariants.get(variantsKey);
    if (requested === undefined) {
      requested = new Set();
      this.requestedViewVariants.set(variantsKey, requested);
    }
    requested.add(
      BasicTopPoolsSelector.canonicalViewHooksOptions(protocol, hooksOptions)
    );
    const {byVariant, variantKey} = this.getSelectionViewSlot(
      pools,
      unsupportedTokens,
      chainId,
      protocol,
      hooksOptions
    );
    const existing = byVariant.get(variantKey);
    if (existing !== undefined) {
      const result = existing.view === undefined ? 'inflight' : 'hit';
      await ctx.metrics.count(
        buildMetricKey('TopPoolsSelector.SelectionView.Cache'),
        1,
        {tags: [`chain:${chainId}`, `protocol:${protocol}`, `result:${result}`]}
      );
      return existing.view ?? existing.build;
    }

    const view = await this.publishSelectionView(
      byVariant,
      variantKey,
      pools,
      unsupportedTokens,
      chainId,
      protocol,
      hooksOptions,
      ctx
    );
    await ctx.metrics.count(
      buildMetricKey('TopPoolsSelector.SelectionView.Cache'),
      1,
      {tags: [`chain:${chainId}`, `protocol:${protocol}`, 'result:miss']}
    );
    return view;
  }

  // Builds the pre-sorted array getTopNPairsFromSorted walks. Dedupes by
  // pool id FIRST (first occurrence in input order wins) to match legacy
  // getTopNPairs, whose seen-set filter runs before its sort — sorting
  // before deduping would let a higher-TVL duplicate displace the
  // occurrence the legacy path keeps.
  //
  // Precondition: getPoolTVL(pool) is a finite number for every input. A
  // NaN TVL makes the comparator inconsistent, and then NO ordering
  // contract exists on either path (legacy sorts a different subset per
  // request, so it is equally unspecified) — parity under NaN is
  // undefinable rather than broken here. Snapshot entries are JSON
  // round-tripped and TVL-filtered upstream, which excludes NaN in
  // practice.
  public static async buildTvlSortedPools(
    pools: UniPoolInfo[],
    slicer: EventLoopSlicer
  ): Promise<UniPoolInfo[]> {
    const seenIds = new Set<string>();
    const uniquePools: UniPoolInfo[] = [];
    for (let index = 0; index < pools.length; index++) {
      const pool = pools[index];
      const poolId = pool.id.toLowerCase();
      if (!seenIds.has(poolId)) {
        seenIds.add(poolId);
        uniquePools.push(pool);
      }
      if (isBuildChunkEnd(index)) {
        await slicer.yieldIfSliceElapsed();
      }
    }
    return uniquePools.sort((a, b) => getPoolTVL(b) - getPoolTVL(a));
  }

  protected static filterAndAddPools(
    poolsToFilter: UniPoolInfo[],
    filterFn: (pool: UniPoolInfo) => boolean,
    limit: number,
    seenPoolIds: Set<string>,
    chainId?: ChainId
  ): UniPoolInfo[] {
    // Helper function to filter and add pools without duplicates
    const filtered = poolsToFilter.filter(pool => {
      const poolId = pool.id.toLowerCase();
      // Only include if not seen before and passes filter
      if (!seenPoolIds.has(poolId) && filterFn(pool)) {
        seenPoolIds.add(poolId);
        return true;
      }
      return false;
    });

    // TVL-bypass hook pools report structurally ~0 liquidity/tvlUSD, so
    // they'd otherwise always sort to the bottom of a TVL-ranked pool set
    // and get sliced off by topN limits, even for their own direct pair.
    // Mirrors the forceSelect exemption S3SubgraphPoolDiscovererV4 applies
    // at the pool-cache read step. Undefined for chains with no TVL-bypass
    // hooks configured so we can skip the force-select split entirely.
    const tvlBypassHookAddressSet =
      chainId === undefined ? undefined : getTvlBypassHookAddresses(chainId);

    if (!tvlBypassHookAddressSet) {
      // No TVL-bypass hooks configured for this chain — identical cost to
      // before this feature existed.
      const sorted = filtered.sort((a, b) => getPoolTVL(b) - getPoolTVL(a));
      const poolsToRemove = sorted.slice(limit);
      poolsToRemove.forEach(pool => {
        seenPoolIds.delete(pool.id.toLowerCase());
      });
      return sorted.slice(0, limit);
    }

    const forced: UniPoolInfo[] = [];
    const rankedRemainder: UniPoolInfo[] = [];
    for (const pool of filtered) {
      const hooks =
        'hooks' in pool ? (pool as V4PoolInfo).hooks?.toLowerCase() : undefined;
      if (hooks !== undefined && tvlBypassHookAddressSet.has(hooks)) {
        forced.push(pool);
      } else {
        rankedRemainder.push(pool);
      }
    }
    rankedRemainder.sort((a, b) => getPoolTVL(b) - getPoolTVL(a));

    // Forced pools are additive — they don't consume a slot from the
    // ordinary top-N budget, so a rarely-competing ZLCA hook pool can't
    // displace a legitimately higher-TVL pool from its usual spot.
    const keptRemainder = rankedRemainder.slice(0, limit);

    // Remove pools that will be sliced from seenPoolIds
    const poolsToRemove = rankedRemainder.slice(limit);
    poolsToRemove.forEach(pool => {
      seenPoolIds.delete(pool.id.toLowerCase());
    });

    return [...forced, ...keptRemainder];
  }

  protected static poolContainsToken(
    pool: UniPoolInfo,
    tokenId: string
  ): boolean {
    // Helper function to check if a pool contains a token
    return (
      pool.token0.id.toLowerCase() === tokenId.toLowerCase() ||
      pool.token1.id.toLowerCase() === tokenId.toLowerCase()
    );
  }

  public static getDirectPairs(
    pools: UniPoolInfo[],
    chainId: ChainId,
    protocol: Protocol,
    tokenIn: Address,
    tokenOut: Address,
    selectedPoolIds: Set<string>,
    tokenPoolIndex: TokenPoolIndex,
    poolSelectionConfig: Record<ChainId, IPoolSelectionConfig>
  ): UniPoolInfo[] {
    // Get pools containing tokenIn
    const tokenInPools =
      tokenPoolIndex.tokenToPools.get(tokenIn.address.toLowerCase()) || [];
    // Get pools containing tokenOut
    const tokenOutPools =
      tokenPoolIndex.tokenToPools.get(tokenOut.address.toLowerCase()) || [];

    // Find intersection of pools containing both tokens
    const tokenOutPoolIds = getLowercasedPoolIdSet(tokenOutPools);
    const directPairs = BasicTopPoolsSelector.filterAndAddPools(
      tokenInPools.filter(pool => tokenOutPoolIds.has(pool.id.toLowerCase())),
      pool =>
        BasicTopPoolsSelector.poolContainsToken(pool, tokenIn.address) &&
        BasicTopPoolsSelector.poolContainsToken(pool, tokenOut.address),
      poolSelectionConfig[chainId].topNDirectPairs,
      selectedPoolIds,
      chainId
    );

    if (protocol === Protocol.V3) {
      return directPairs.filter(pool => {
        if (
          RoutingBlockList.isBlockedDirectSwapPool(pool.id, chainId) ||
          RoutingBlockList.isBlockedDirectSwapToken(pool.token0.id, chainId) ||
          RoutingBlockList.isBlockedDirectSwapToken(pool.token1.id, chainId)
        ) {
          return false;
        }
        return true;
      });
    }

    return directPairs;
  }

  public static getTokenInOnlyPairs(
    tokenIn: Address,
    tokenOut: Address,
    selectedPoolIds: Set<string>,
    tokenPoolIndex: TokenPoolIndex,
    chainId: ChainId,
    poolSelectionConfig: Record<ChainId, IPoolSelectionConfig>
  ): UniPoolInfo[] {
    return BasicTopPoolsSelector.filterAndAddPools(
      tokenPoolIndex.tokenToPools.get(tokenIn.address.toLowerCase()) || [],
      pool => !BasicTopPoolsSelector.poolContainsToken(pool, tokenOut.address),
      poolSelectionConfig[chainId].topNOneHopPairs,
      selectedPoolIds,
      chainId
    );
  }

  public static getTokenOutOnlyPairs(
    tokenIn: Address,
    tokenOut: Address,
    selectedPoolIds: Set<string>,
    tokenPoolIndex: TokenPoolIndex,
    chainId: ChainId,
    poolSelectionConfig: Record<ChainId, IPoolSelectionConfig>
  ): UniPoolInfo[] {
    return BasicTopPoolsSelector.filterAndAddPools(
      tokenPoolIndex.tokenToPools.get(tokenOut.address.toLowerCase()) || [],
      pool => !BasicTopPoolsSelector.poolContainsToken(pool, tokenIn.address),
      poolSelectionConfig[chainId].topNOneHopPairs,
      selectedPoolIds,
      chainId
    );
  }

  public static getIntermediaryTokenIds(
    tokenInOnlyPairs: UniPoolInfo[],
    tokenOutOnlyPairs: UniPoolInfo[],
    tokenIn: Address,
    tokenOut: Address
  ): string[] {
    const intermediaryTokenIds = new Set<string>();
    tokenInOnlyPairs.forEach(pool => {
      // For pools with tokenIn, get the other token
      const otherToken =
        pool.token0.id.toLowerCase() === tokenIn.address.toLowerCase()
          ? pool.token1.id
          : pool.token0.id;
      intermediaryTokenIds.add(otherToken.toLowerCase());
    });
    tokenOutOnlyPairs.forEach(pool => {
      // For pools with tokenOut, get the other token
      const otherToken =
        pool.token0.id.toLowerCase() === tokenOut.address.toLowerCase()
          ? pool.token1.id
          : pool.token0.id;
      intermediaryTokenIds.add(otherToken.toLowerCase());
    });
    return Array.from(intermediaryTokenIds);
  }

  public static getTopNPoolsForIntermediaryToken(
    intermediaryTokenIds: string[],
    selectedPoolIds: Set<string>,
    tokenPoolIndex: TokenPoolIndex,
    chainId: ChainId,
    poolSelectionConfig: Record<ChainId, IPoolSelectionConfig>
  ): UniPoolInfo[] {
    const secondHopPairs: UniPoolInfo[] = [];

    // Get WETH address (wrapped native currency)
    const wethAddress = WRAPPED_NATIVE_CURRENCY[chainId]?.address.toLowerCase();
    const ethAddress = ADDRESS_ZERO.toLowerCase();

    for (const tokenId of Array.from(intermediaryTokenIds)) {
      // Get top N pools for this intermediary token
      const topPoolsForToken = BasicTopPoolsSelector.filterAndAddPools(
        tokenPoolIndex.tokenToPools.get(tokenId) || [],
        () => true, // All pools in the index already contain this token
        poolSelectionConfig[chainId].topNSecondHopPairs,
        selectedPoolIds,
        chainId
      );
      secondHopPairs.push(...topPoolsForToken);

      // Always include top 1 ETH and top 1 WETH pool for this intermediary token
      if (wethAddress) {
        const topWethPool = BasicTopPoolsSelector.getTopPoolForTokens(
          selectedPoolIds,
          wethAddress,
          tokenId,
          tokenPoolIndex
        );
        secondHopPairs.push(...topWethPool);
      }
      const topEthPool = BasicTopPoolsSelector.getTopPoolForTokens(
        selectedPoolIds,
        ethAddress,
        tokenId,
        tokenPoolIndex
      );
      secondHopPairs.push(...topEthPool);
    }
    return secondHopPairs;
  }

  public static getTopNPairs(
    filteredPools: UniPoolInfo[],
    selectedPoolIds: Set<string>,
    chainId: ChainId,
    poolSelectionConfig: Record<ChainId, IPoolSelectionConfig>
  ): UniPoolInfo[] {
    // Deliberately no chainId here, unlike the other filterAndAddPools call
    // sites in this class. filteredPools is the whole chain's pool universe,
    // not scoped to tokenIn/tokenOut — force-selecting ZLCA hook pools here
    // would inject them into every single quote request on the chain
    // regardless of relevance, not just requests where they're actually a
    // plausible hop. The token-scoped call sites (getDirectPairs,
    // getToken{In,Out}OnlyPairs, getTopNPoolsForIntermediaryToken,
    // getTopBaseTokenPools) are where force-selection belongs.
    return BasicTopPoolsSelector.filterAndAddPools(
      filteredPools,
      () => true,
      poolSelectionConfig[chainId].topNPairs,
      selectedPoolIds
    );
  }

  // Selection-view counterpart of getTopNPairs. The input is pre-sorted by
  // the same comparator; a stable sort commutes with the seen-set filter, so
  // walking it yields the same pools in the same order as filter→sort→slice.
  // Same deliberate omission of the TVL-bypass as getTopNPairs — see above.
  public static getTopNPairsFromSorted(
    tvlSortedPools: UniPoolInfo[],
    selectedPoolIds: Set<string>,
    chainId: ChainId,
    poolSelectionConfig: Record<ChainId, IPoolSelectionConfig>
  ): UniPoolInfo[] {
    const limit = poolSelectionConfig[chainId].topNPairs;
    const selected: UniPoolInfo[] = [];
    for (const pool of tvlSortedPools) {
      if (selected.length >= limit) {
        break;
      }
      const poolId = pool.id.toLowerCase();
      if (selectedPoolIds.has(poolId)) {
        continue;
      }
      selectedPoolIds.add(poolId);
      selected.push(pool);
    }
    return selected;
  }

  public static getTopBaseTokenPools(
    selectedPoolIds: Set<string>,
    chainId: ChainId,
    tokenAddress: string,
    tokenPoolIndex: TokenPoolIndex,
    poolSelectionConfig: Record<ChainId, IPoolSelectionConfig>
  ): UniPoolInfo[] {
    const baseTokens = BASE_TOKENS_PER_CHAIN[chainId] || [];
    const allBaseTokenPools: UniPoolInfo[] = [];

    // For each base token, get topNWithBaseTokenEach pools
    for (const baseToken of Array.from(baseTokens)) {
      const baseTokenPools =
        tokenPoolIndex.tokenToPools.get(baseToken.address.toLowerCase()) || [];
      const tokenPools =
        tokenPoolIndex.tokenToPools.get(tokenAddress.toLowerCase()) || [];

      // Find intersection of pools containing both base token and target token
      const tokenPoolIds = getLowercasedPoolIdSet(tokenPools);
      const intersectionPools = baseTokenPools.filter(pool =>
        tokenPoolIds.has(pool.id.toLowerCase())
      );

      const selectedPools = BasicTopPoolsSelector.filterAndAddPools(
        intersectionPools,
        () => true, // All pools in intersection already contain both tokens
        poolSelectionConfig[chainId].topNWithBaseTokenEach,
        selectedPoolIds,
        chainId
      );
      allBaseTokenPools.push(...selectedPools);
    }

    // Sort all base token pools by TVL and take the top topNWithBaseToken
    return allBaseTokenPools
      .sort((a, b) => getPoolTVL(b) - getPoolTVL(a))
      .slice(0, poolSelectionConfig[chainId].topNWithBaseToken);
  }

  public static getTopPoolForTokens(
    selectedPoolIds: Set<string>,
    token0Address: string,
    token1Address: string,
    tokenPoolIndex: TokenPoolIndex
  ): UniPoolInfo[] {
    // Get pools containing token1
    const token1Pools =
      tokenPoolIndex.tokenToPools.get(token1Address.toLowerCase()) || [];

    // Find intersection of pools containing both tokens
    const token0PoolIds = getLowercasedPoolIdSet(
      tokenPoolIndex.tokenToPools.get(token0Address.toLowerCase()) || []
    );

    const intersectionPools = token1Pools.filter(pool =>
      token0PoolIds.has(pool.id.toLowerCase())
    );

    return BasicTopPoolsSelector.filterAndAddPools(
      intersectionPools,
      pool =>
        BasicTopPoolsSelector.poolContainsToken(pool, token0Address) &&
        BasicTopPoolsSelector.poolContainsToken(pool, token1Address),
      1,
      selectedPoolIds
    );
  }

  protected manuallyGenerateDirectPairs = async (
    protocol: Protocol,
    chainId: ChainId,
    tokenInAddress: string,
    tokenOutAddress: string,
    selectedPoolIds: Set<string>,
    hooksOptions?: HooksOptions
  ) => {
    let forceAddedDirectPools: UniPoolInfo[] = [];
    switch (protocol) {
      case Protocol.V2: {
        const poolAddress = V2Pool.computeAddress(
          new Address(tokenInAddress),
          new Address(tokenOutAddress),
          (await this.chainRepository.getChain(chainId))!.v2FactoryAddress!
        );

        forceAddedDirectPools = [
          {
            id: poolAddress.address,
            token0: {
              id: tokenInAddress,
            },
            token1: {
              id: tokenOutAddress,
            },
            supply: 10000, // Not used. Set to arbitrary number.
            reserve: 10000, // Not used. Set to arbitrary number.
            reserveUSD: 10000, // Not used. Set to arbitrary number.
          } as V2PoolInfo,
        ];
        break;
      }
      case Protocol.V3: {
        const v3FactoryAddress = (await this.chainRepository.getChain(chainId))!
          .v3FactoryAddress!;
        forceAddedDirectPools = getApplicableV3FeeAmounts(chainId).map(
          feeAmount => {
            const poolAddress = V3Pool.computeAddress(
              new Address(tokenInAddress),
              new Address(tokenOutAddress),
              feeAmount,
              v3FactoryAddress,
              chainId
            );

            return {
              id: poolAddress.address,
              feeTier: feeAmount.toString(),
              liquidity: '10000', // Not used. Set to arbitrary number.
              token0: {
                id: tokenInAddress,
              },
              token1: {
                id: tokenOutAddress,
              },
              tvlETH: 10000, // Not used. Set to arbitrary number.
              tvlUSD: 10000, // Not used. Set to arbitrary number.
            } as V3PoolInfo;
          }
        );
        break;
      }
      case Protocol.V4: {
        // Registry PoolKeys extend the "pool exists on chain but the snapshot
        // missed it" safety net. This fallback bypasses filterPools, so it
        // must apply hooksOptions before constructing placeholder pools.
        let registryKeys: V4RegistryPoolKey[] = [];
        try {
          registryKeys =
            (await this.poolKeyRegistry?.getPoolKeysForPair(
              chainId,
              tokenInAddress,
              tokenOutAddress
            )) ?? [];
        } catch {
          // Store contract is never-throw; guard other implementations.
        }
        const filteredRegistryKeys = registryKeys.filter(key =>
          hooksOptions === HooksOptions.HOOKS_ONLY
            ? key.hooks !== ADDRESS_ZERO
            : hooksOptions === HooksOptions.NO_HOOKS
              ? key.hooks === ADDRESS_ZERO
              : true
        );
        const v4Combos: Array<[number, number, string]> = [
          ...(hooksOptions === HooksOptions.HOOKS_ONLY
            ? []
            : getApplicableV4FeesTickspacingsHooks(chainId)),
          ...filteredRegistryKeys.map((key): [number, number, string] => [
            key.fee,
            key.tickSpacing,
            key.hooks,
          ]),
        ];
        forceAddedDirectPools = v4Combos.map(v4PoolParams => {
          const fee = v4PoolParams[0];
          const tickSpacing = v4PoolParams[1];
          const hooks = v4PoolParams[2];

          const poolId = V4Pool.computePoolId(
            new Address(tokenInAddress),
            new Address(tokenOutAddress),
            fee,
            tickSpacing,
            hooks
          );

          return {
            id: poolId,
            feeTier: fee.toString(),
            tickSpacing: tickSpacing.toString(),
            hooks: hooks,
            liquidity: '10000', // Not used. Set to arbitrary number.
            token0: {
              id: tokenInAddress,
            },
            token1: {
              id: tokenOutAddress,
            },
            tvlETH: 10000, // Not used. Set to arbitrary number.
            tvlUSD: 10000, // Not used. Set to arbitrary number.
          } as V4PoolInfo;
        });
        break;
      }
      default:
        throw new Error(`Unsupported protocol ${protocol}`);
    }

    let directPairs = BasicTopPoolsSelector.filterAndAddPools(
      forceAddedDirectPools,
      () => true,
      // Admit every generated pool — this constant is the worst case across
      // protocols (v4 canonical grid + registry entries).
      MAX_MANUAL_DIRECT_PAIRS_FALLBACK,
      selectedPoolIds
    );

    if (protocol === Protocol.V3) {
      directPairs = directPairs.filter(pool => {
        if (
          RoutingBlockList.isBlockedDirectSwapPool(pool.id, chainId) ||
          RoutingBlockList.isBlockedDirectSwapToken(pool.token0.id, chainId) ||
          RoutingBlockList.isBlockedDirectSwapToken(pool.token1.id, chainId)
        ) {
          return false;
        }
        return true;
      });
    }

    // The generated grid never went through filterUnsupportedPools, so a
    // token's non-canonical (fee, tickSpacing, hooks) combos would otherwise
    // re-enter here after the snapshot filter removed them.
    return CanonicalPools.filterAdmittedPools(directPairs, chainId);
  };
}

/**
 * Top pools selector for aggregator hook pools (e.g. FluidDex, StableSwapNG).
 *
 * Uses the same multi-step heuristic as BasicTopPoolsSelector (direct pairs,
 * one-hop, second-hop, intermediary tokens, global top-N, base token pools,
 * WETH/ETH pools) but operates on a pool universe pre-filtered to agg hook
 * addresses only, ensuring that high-TVL vanilla V4 pools cannot crowd out the
 * quota reserved for agg hook pools.
 *
 * Does NOT include the manuallyGenerateDirectPairs fallback since agg hook pools
 * are discovered from subgraph data, not generated from factory addresses.
 */
export class AggHooksTopPoolsSelector
  implements ITopPoolsSelector<UniPoolInfo>
{
  public readonly aggHooksOnly = true;

  // The agg-hook result is always uncacheable (see the cache-skip below), so
  // without memoization the O(all pools) agg-subset scan runs on every
  // request. Keyed by snapshot array identity (stable via Layer-1 memo in
  // BaseCachingPoolDiscoverer) and the (chainId, protocol) variant.
  private readonly aggSubsetMemo = new WeakMap<
    UniPoolInfo[],
    Map<string, UniPoolInfo[]>
  >();

  constructor(
    private readonly poolSelectionConfig: Record<ChainId, IPoolSelectionConfig>,
    protected readonly featureGatedTokensRepository: FeatureGatedTokensRepository,
    private readonly snapshotMemoEnabled: boolean = false
  ) {}

  public async filterPools(
    pools: UniPoolInfo[],
    chainId: ChainId,
    tokenIn: Address,
    tokenOut: Address,
    protocol: Protocol,
    hooksOptions: HooksOptions | undefined,
    _nsCtx: RouteNamespaceContext,
    ctx: Context,
    cacheDirective: PoolsForTokensCacheDirective
  ): Promise<UniPoolInfo[]> {
    // Defensive cache-skip: AggHooks output is an AGG_HOOKS-only subset of
    // Protocol.V4, but the POOLSFORTOKENS cache key isn't selector-aware, so a
    // write here would pollute the shared V4 keyspace with AGG_HOOKS-only
    // results. Callers (UniRoutesRepository) already pass
    // `skipPoolsForTokensCache=true` which sets `CallerOptOut` first
    // (and also short-circuits the read); first-reason-wins keeps that intact.
    // This flip is the backstop for any future caller that forgets the flag.
    markPoolsForTokensUncacheable(
      cacheDirective,
      PoolsForTokensCacheSkipReason.AggHooksSelector
    );
    // 1. Restrict to agg hook pools only before any selection logic runs.
    // Use protocol-specific list when protocol is an external/agg hook protocol.
    const protocolAddresses = AGG_HOOKS_PER_CHAIN[protocol]?.[chainId];
    const aggHookAddressSet = new Set(
      (
        protocolAddresses ??
        Object.values(AGG_HOOKS_PER_CHAIN).flatMap(
          perChain => perChain?.[chainId] ?? []
        )
      ).map(addr => addr.toLowerCase())
    );

    let aggHooksPools: UniPoolInfo[];
    // Same stability gate as BasicTopPoolsSelector: only identity-stable
    // snapshot arrays can recur, so only they are worth memoizing (and only
    // they emit the cache signal).
    if (this.snapshotMemoEnabled && isPoolsArrayMemoStable(pools)) {
      let byVariant = this.aggSubsetMemo.get(pools);
      if (byVariant === undefined) {
        byVariant = new Map();
        this.aggSubsetMemo.set(pools, byVariant);
      }
      const variantKey = `${chainId}#${protocol}`;
      const memoized = byVariant.get(variantKey);
      if (memoized !== undefined) {
        aggHooksPools = memoized;
      } else {
        aggHooksPools = pools.filter(pool =>
          aggHookAddressSet.has((pool as V4PoolInfo).hooks?.toLowerCase())
        );
        byVariant.set(variantKey, aggHooksPools);
      }
      await ctx.metrics.count(
        buildMetricKey('TopPoolsSelector.AggSubset.Cache'),
        1,
        {
          tags: [
            `chain:${chainId}`,
            `protocol:${protocol}`,
            `result:${memoized !== undefined ? 'hit' : 'miss'}`,
          ],
        }
      );
    } else {
      aggHooksPools = pools.filter(pool =>
        aggHookAddressSet.has((pool as V4PoolInfo).hooks?.toLowerCase())
      );
    }

    ctx.logger.debug('AggHooksTopPoolsSelector filtering agg hook pools', {
      chainId,
      protocol,
      totalPools: pools.length,
      aggHooksPools: aggHooksPools.length,
    });

    // 2. Drop pools whose tokens are on the routing block list.
    const {globalSet: unsupportedTokens} =
      await this.featureGatedTokensRepository.getSnapshot(ctx);
    const filteredUnsupportedPools =
      BasicTopPoolsSelector.filterUnsupportedPools(
        aggHooksPools,
        chainId,
        unsupportedTokens,
        ctx
      );

    const filteredPools = filteredUnsupportedPools.filter(pool =>
      matchesHooksOptions(pool, protocol, hooksOptions)
    );

    ctx.logger.debug('AggHooksTopPoolsSelector filtering pools', {
      chainId,
      protocol,
      totalPools: pools.length,
      aggHooksPools: aggHooksPools.length,
      filteredUnsupportedPools: filteredUnsupportedPools.length,
      filteredPools: filteredPools.length,
    });

    // 4. Build token-to-pool index for faster lookups
    const tokenPoolIndex = buildTokenPoolIndex(filteredPools);
    const selectedPoolIds = new Set<string>();

    // 5. Direct pairs (pools with both tokenIn and tokenOut)
    const directPairs = BasicTopPoolsSelector.getDirectPairs(
      filteredPools,
      chainId,
      protocol,
      tokenIn,
      tokenOut,
      selectedPoolIds,
      tokenPoolIndex,
      this.poolSelectionConfig
    );

    // 6. Pools with only tokenIn
    const tokenInOnlyPairs = BasicTopPoolsSelector.getTokenInOnlyPairs(
      tokenIn,
      tokenOut,
      selectedPoolIds,
      tokenPoolIndex,
      chainId,
      this.poolSelectionConfig
    );

    // 7. Pools with only tokenOut
    const tokenOutOnlyPairs = BasicTopPoolsSelector.getTokenOutOnlyPairs(
      tokenIn,
      tokenOut,
      selectedPoolIds,
      tokenPoolIndex,
      chainId,
      this.poolSelectionConfig
    );

    // 8. Get tokens from first hop pools to use as intermediary tokens
    const intermediaryTokenIds = BasicTopPoolsSelector.getIntermediaryTokenIds(
      tokenInOnlyPairs,
      tokenOutOnlyPairs,
      tokenIn,
      tokenOut
    );

    // 9. For each intermediary token, get top N pools
    const secondHopPairs =
      BasicTopPoolsSelector.getTopNPoolsForIntermediaryToken(
        intermediaryTokenIds,
        selectedPoolIds,
        tokenPoolIndex,
        chainId,
        this.poolSelectionConfig
      );

    // 10. Get top N pools with highest liquidity (excluding already selected pools)
    const topNPairs = BasicTopPoolsSelector.getTopNPairs(
      filteredPools,
      selectedPoolIds,
      chainId,
      this.poolSelectionConfig
    );

    // 11. Get top base token pools for tokenIn and tokenOut
    const topBaseTokenPoolsTokenIn = BasicTopPoolsSelector.getTopBaseTokenPools(
      selectedPoolIds,
      chainId,
      tokenIn.address,
      tokenPoolIndex,
      this.poolSelectionConfig
    );

    const topBaseTokenPoolsTokenOut =
      BasicTopPoolsSelector.getTopBaseTokenPools(
        selectedPoolIds,
        chainId,
        tokenOut.address,
        tokenPoolIndex,
        this.poolSelectionConfig
      );

    // 12. Top 1 WETH and ETH pool for tokenIn
    const topWethPoolTokenIn = BasicTopPoolsSelector.getTopPoolForTokens(
      selectedPoolIds,
      WRAPPED_NATIVE_CURRENCY[chainId].address,
      tokenIn.address,
      tokenPoolIndex
    );
    const topEthPoolTokenIn = BasicTopPoolsSelector.getTopPoolForTokens(
      selectedPoolIds,
      ADDRESS_ZERO,
      tokenIn.address,
      tokenPoolIndex
    );

    // 13. Top 1 WETH and ETH pool for tokenOut
    const topWethPoolTokenOut = BasicTopPoolsSelector.getTopPoolForTokens(
      selectedPoolIds,
      WRAPPED_NATIVE_CURRENCY[chainId].address,
      tokenOut.address,
      tokenPoolIndex
    );
    const topEthPoolTokenOut = BasicTopPoolsSelector.getTopPoolForTokens(
      selectedPoolIds,
      ADDRESS_ZERO,
      tokenOut.address,
      tokenPoolIndex
    );

    const allPools = [
      ...directPairs,
      ...tokenInOnlyPairs,
      ...tokenOutOnlyPairs,
      ...secondHopPairs,
      ...topNPairs,
      ...topBaseTokenPoolsTokenIn,
      ...topBaseTokenPoolsTokenOut,
      ...topWethPoolTokenIn,
      ...topWethPoolTokenOut,
      ...topEthPoolTokenIn,
      ...topEthPoolTokenOut,
    ];

    ctx.logger.debug('AggHooksTopPoolsSelector selected pools', {
      chainId,
      protocol,
      directPairs: directPairs.length,
      tokenInOnlyPairs: tokenInOnlyPairs.length,
      tokenOutOnlyPairs: tokenOutOnlyPairs.length,
      secondHopPairs: secondHopPairs.length,
      topNPairs: topNPairs.length,
      topBaseTokenPoolsTokenIn: topBaseTokenPoolsTokenIn.length,
      topBaseTokenPoolsTokenOut: topBaseTokenPoolsTokenOut.length,
      topWethPoolTokenIn: topWethPoolTokenIn.length,
      topWethPoolTokenOut: topWethPoolTokenOut.length,
      topEthPoolTokenIn: topEthPoolTokenIn.length,
      topEthPoolTokenOut: topEthPoolTokenOut.length,
      intermediaryTokenIds,
      totalSelected: allPools.length,
    });

    return allPools;
  }
}
