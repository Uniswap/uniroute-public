import {Address} from '../../models/address/Address';
import {
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
import {buildMetricKey, ChainId} from '../../lib/config';
import {
  BASE_TOKENS_PER_CHAIN,
  WRAPPED_NATIVE_CURRENCY,
} from '../../lib/tokenUtils';
import {Context} from '@uniswap/lib-uni/context';
import {RoutingBlockList} from '../../lib/RoutingBlockList';
import {FeatureGatedTokensRepository} from '../../stores/compliance/FeatureGatedTokensRepository';
import {Protocol} from '../../models/pool/Protocol';
import {V2Pool} from '../../models/pool/V2Pool';
import {IChainRepository} from '../../stores/chain/IChainRepository';
import {
  getApplicableV3FeeAmounts,
  V3FeeAmountsBase,
  V3Pool,
} from '../../models/pool/V3Pool';
import {
  getApplicableV4FeesTickspacingsHooks,
  V4FeeAmounts,
  V4Pool,
} from '../../models/pool/V4Pool';
import {HooksOptions} from '../../models/hooks/HooksOptions';
import {EXPERIMENT_HOOKS} from '../../models/hooks/Experiment';
import {
  getActiveExperiment,
  RouteNamespaceContext,
} from '../../models/hooks/namespaces';
import {maybeDropPermissionedPools} from '../../models/hooks/PermissionedHooks';
import {ADDRESS_ZERO} from '@uniswap/router-sdk';
import {IPoolSelectionConfig} from '../../lib/config';
import {
  AGG_HOOKS_PER_CHAIN,
  getTvlBypassHookAddresses,
} from '../../lib/poolCaching/util/hooksAddressesAllowlist';

// Token-to-pool index for faster lookups
interface TokenPoolIndex {
  tokenToPools: Map<string, UniPoolInfo[]>;
  poolToTokens: Map<string, Set<string>>;
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

// Helper function to build token-to-pool index
export const buildTokenPoolIndex = (pools: UniPoolInfo[]): TokenPoolIndex => {
  const tokenToPools = new Map<string, UniPoolInfo[]>();
  const poolToTokens = new Map<string, Set<string>>();

  for (const pool of pools) {
    const token0Id = pool.token0.id.toLowerCase();
    const token1Id = pool.token1.id.toLowerCase();
    const poolId = pool.id.toLowerCase();

    // Initialize token-to-pools mapping
    if (!tokenToPools.has(token0Id)) {
      tokenToPools.set(token0Id, []);
    }
    if (!tokenToPools.has(token1Id)) {
      tokenToPools.set(token1Id, []);
    }

    // Add pool to both tokens
    tokenToPools.get(token0Id)!.push(pool);
    tokenToPools.get(token1Id)!.push(pool);

    // Initialize pool-to-tokens mapping
    poolToTokens.set(poolId, new Set([token0Id, token1Id]));
  }

  return {tokenToPools, poolToTokens};
};

// Worst-case pool count returned by manuallyGenerateDirectPairs across all
// (protocol, chain) combos. V2 → 1, V3 → up to V3FeeAmountsBase.length (BASE
// has the most fee tiers), V4 → V4FeeAmounts.length. Auto-tracks if any
// protocol adds a fee tier.
export const MAX_MANUAL_DIRECT_PAIRS_FALLBACK = Math.max(
  1,
  V3FeeAmountsBase.length,
  V4FeeAmounts.length
);

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

export class BasicTopPoolsSelector implements ITopPoolsSelector<UniPoolInfo> {
  // Selection views memoized by (pools array, deny-list payload) identity.
  // Layer-1 memoization in BaseCachingPoolDiscoverer keeps both references
  // stable for the lifetime of a snapshot, so views rebuild exactly when the
  // snapshot or deny list actually changes and are GC'd with the old arrays.
  // The inner key is the ≤4-valued hooksOptions variant per chain/protocol.
  private readonly selectionViewMemo = new WeakMap<
    UniPoolInfo[],
    WeakMap<Set<string>, Map<string, SelectionView>>
  >();

  constructor(
    private readonly chainRepository: IChainRepository,
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

    // The permissioned-hook drop is pair- and namespace-dependent, so the
    // snapshot-keyed selection view cannot be reused on chains that configure
    // permissioned hooks (only Sepolia today) — those keep the legacy path.
    const permissionedChain =
      chain !== undefined && (chain.permissionedHookAddresses?.length ?? 0) > 0;

    const canUseSelectionView =
      this.snapshotMemoEnabled && arrayMemoStable && !permissionedChain;

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
      // (permissioned chain). Unstable per-request arrays stay silent —
      // emitting per direct-pool request would drown the signal.
      if (this.snapshotMemoEnabled && arrayMemoStable) {
        await ctx.metrics.count(
          buildMetricKey('TopPoolsSelector.SelectionView.Cache'),
          1,
          {
            tags: [`chain:${chainId}`, `protocol:${protocol}`, 'result:bypass'],
          }
        );
      }
      const filteredUnsupportedPools =
        BasicTopPoolsSelector.filterUnsupportedPools(
          pools,
          chainId,
          unsupportedTokens
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

      filteredPools = permissionedFilteredPools.filter(pool => {
        if (
          BasicTopPoolsSelector.isExcludedAggHookPool(
            pool,
            protocol,
            aggHookAddressSet
          )
        ) {
          ctx.logger.debug('Excluding agg hook pool', {
            chainId,
            protocol,
            poolId: pool.id,
            poolHooks: (pool as V4PoolInfo).hooks,
          });
          return false;
        }
        return BasicTopPoolsSelector.matchesHooksOptions(
          pool,
          protocol,
          hooksOptions
        );
      });

      ctx.logger.debug("Filtering pools that don't match the hooks options", {
        chainId,
        filteredUnsupportedPools: filteredUnsupportedPools.length,
        filteredPools: filteredPools.length,
      });

      // Build token-to-pool index for faster lookups
      tokenPoolIndex = buildTokenPoolIndex(filteredPools);
    }

    // Keep track of selected pool addresses to avoid duplicates
    const selectedPoolIds = new Set<string>();

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

    // 2. Pools with only tokenIn
    const tokenInOnlyPairs = BasicTopPoolsSelector.getTokenInOnlyPairs(
      tokenIn,
      tokenOut,
      selectedPoolIds,
      tokenPoolIndex,
      chainId,
      this.poolSelectionConfig
    );

    // 3. Pools with only tokenOut
    const tokenOutOnlyPairs = BasicTopPoolsSelector.getTokenOutOnlyPairs(
      tokenIn,
      tokenOut,
      selectedPoolIds,
      tokenPoolIndex,
      chainId,
      this.poolSelectionConfig
    );

    // 4. Get tokens from first hop pools to use as intermediary tokens
    const intermediaryTokenIds = BasicTopPoolsSelector.getIntermediaryTokenIds(
      tokenInOnlyPairs,
      tokenOutOnlyPairs,
      tokenIn,
      tokenOut
    );

    // 5. For each intermediary token, get top N pools
    const secondHopPairs: UniPoolInfo[] =
      BasicTopPoolsSelector.getTopNPoolsForIntermediaryToken(
        intermediaryTokenIds,
        selectedPoolIds,
        tokenPoolIndex,
        chainId,
        this.poolSelectionConfig
      );

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

    const topBaseTokenPoolsTokenOut =
      BasicTopPoolsSelector.getTopBaseTokenPools(
        selectedPoolIds,
        chainId,
        tokenOut.address,
        tokenPoolIndex,
        this.poolSelectionConfig
      );

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
    // through. Gated on V4 because experiment hooks are a V4-only concept.
    if (protocol === Protocol.V4 && experiment !== undefined) {
      const experimentHookAddresses = new Set(
        (EXPERIMENT_HOOKS[experiment] ?? []).map(addr => addr.toLowerCase())
      );
      const experimentPoolsAvailable = pools.filter(pool => {
        const hooks = (pool as V4PoolInfo).hooks?.toLowerCase();
        return hooks !== undefined && experimentHookAddresses.has(hooks);
      }).length;
      const experimentPools = pools.filter(pool => {
        const hooks = (pool as V4PoolInfo).hooks?.toLowerCase();
        if (!hooks || !experimentHookAddresses.has(hooks)) {
          return false;
        }
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
      await ctx.metrics.count(
        buildMetricKey('TopPoolsSelector.ExperimentHit'),
        1,
        {tags: experimentMetricTags}
      );
      await ctx.metrics.count(
        buildMetricKey('TopPoolsSelector.ExperimentPoolsAvailable'),
        experimentPoolsAvailable,
        {tags: experimentMetricTags}
      );
      await ctx.metrics.count(
        buildMetricKey('TopPoolsSelector.ExperimentPoolsAppended'),
        experimentPools.length,
        {tags: experimentMetricTags}
      );
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

  public static filterUnsupportedPools(
    pools: UniPoolInfo[],
    _chainId: ChainId,
    unsupportedTokens: Set<string>
  ): UniPoolInfo[] {
    return pools.filter(pool => {
      return (
        !unsupportedTokens.has(pool.token0.id.toLowerCase()) &&
        !unsupportedTokens.has(pool.token1.id.toLowerCase())
      );
    });
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
    if (protocol !== Protocol.V4) {
      return true;
    }
    if (
      hooksOptions === undefined ||
      hooksOptions === HooksOptions.HOOKS_INCLUSIVE
    ) {
      return true;
    }
    if (hooksOptions === HooksOptions.HOOKS_ONLY) {
      return (pool as V4PoolInfo).hooks !== ADDRESS_ZERO;
    }
    if (hooksOptions === HooksOptions.NO_HOOKS) {
      return (pool as V4PoolInfo).hooks === ADDRESS_ZERO;
    }
    return true;
  }

  private async getOrBuildSelectionView(
    pools: UniPoolInfo[],
    unsupportedTokens: Set<string>,
    chainId: ChainId,
    protocol: Protocol,
    hooksOptions: HooksOptions | undefined,
    ctx: Context
  ): Promise<SelectionView> {
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
    // Canonicalized: hooksOptions only affects V4 filtering, and undefined
    // is filter-identical to HOOKS_INCLUSIVE — collapsing those variants
    // avoids building content-identical views per alias.
    const variantKey =
      protocol === Protocol.V4
        ? `${chainId}#${protocol}#${hooksOptions ?? HooksOptions.HOOKS_INCLUSIVE}`
        : `${chainId}#${protocol}`;
    const existing = byVariant.get(variantKey);
    if (existing !== undefined) {
      await ctx.metrics.count(
        buildMetricKey('TopPoolsSelector.SelectionView.Cache'),
        1,
        {tags: [`chain:${chainId}`, `protocol:${protocol}`, 'result:hit']}
      );
      return existing;
    }

    // Build and publish before any await: the build below is fully
    // synchronous, so with no suspension point between the memo read above
    // and the set below, concurrent same-tick misses cannot each rebuild the
    // view — the second caller sees the first one's entry. Metrics are
    // emitted only after publication.
    const buildStartTime = Date.now();
    const aggHookAddressSet =
      BasicTopPoolsSelector.getAggHookAddressSet(chainId);
    const filteredUnsupportedPools =
      BasicTopPoolsSelector.filterUnsupportedPools(
        pools,
        chainId,
        unsupportedTokens
      );
    const filteredPools = filteredUnsupportedPools.filter(
      pool =>
        !BasicTopPoolsSelector.isExcludedAggHookPool(
          pool,
          protocol,
          aggHookAddressSet
        ) &&
        BasicTopPoolsSelector.matchesHooksOptions(pool, protocol, hooksOptions)
    );
    const tokenPoolIndex = buildTokenPoolIndex(filteredPools);
    const tvlSortedPools =
      BasicTopPoolsSelector.buildTvlSortedPools(filteredPools);
    const view: SelectionView = {filteredPools, tokenPoolIndex, tvlSortedPools};
    byVariant.set(variantKey, view);
    await ctx.metrics.count(
      buildMetricKey('TopPoolsSelector.SelectionView.Cache'),
      1,
      {tags: [`chain:${chainId}`, `protocol:${protocol}`, 'result:miss']}
    );
    await ctx.metrics.dist(
      buildMetricKey('TopPoolsSelector.SelectionView.Build.Latency.dist'),
      Date.now() - buildStartTime,
      {tags: [`chain:${chainId}`, `protocol:${protocol}`]}
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
  public static buildTvlSortedPools(pools: UniPoolInfo[]): UniPoolInfo[] {
    const seenIds = new Set<string>();
    const uniquePools = pools.filter(pool => {
      const poolId = pool.id.toLowerCase();
      if (seenIds.has(poolId)) {
        return false;
      }
      seenIds.add(poolId);
      return true;
    });
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
    const tokenOutPoolIds = new Set(tokenOutPools.map(p => p.id.toLowerCase()));
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
      const tokenPoolIds = new Set(tokenPools.map(p => p.id.toLowerCase()));
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
    const token0PoolIds = new Set(
      (tokenPoolIndex.tokenToPools.get(token0Address.toLowerCase()) || []).map(
        p => p.id.toLowerCase()
      )
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
        if (hooksOptions !== HooksOptions.HOOKS_ONLY) {
          forceAddedDirectPools = getApplicableV4FeesTickspacingsHooks(
            chainId
          ).map(v4PoolParams => {
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
        }
        break;
      }
      default:
        throw new Error(`Unsupported protocol ${protocol}`);
    }

    let directPairs = BasicTopPoolsSelector.filterAndAddPools(
      forceAddedDirectPools,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      pool => true,
      6, // make sure we add all generated pools (can be up to 6 depending on protocol)
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

    return directPairs;
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
        unsupportedTokens
      );

    // 3. Filter out pools that don't match the hooks options, only if the uniswap protocol is v4.
    const filteredPools = filteredUnsupportedPools.filter(pool => {
      if (protocol === Protocol.V4) {
        if (
          hooksOptions === undefined ||
          hooksOptions === HooksOptions.HOOKS_INCLUSIVE
        ) {
          return true;
        }

        if (hooksOptions === HooksOptions.HOOKS_ONLY) {
          return (pool as V4PoolInfo).hooks !== ADDRESS_ZERO;
        }
        if (hooksOptions === HooksOptions.NO_HOOKS) {
          return (pool as V4PoolInfo).hooks === ADDRESS_ZERO;
        }
      }
      return true;
    });

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
