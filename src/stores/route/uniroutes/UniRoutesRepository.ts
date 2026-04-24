import {Address} from '../../../models/address/Address';
import {Chain} from '../../../models/chain/Chain';
import {Pool} from '../../../models/pool/Pool';
import {RouteBasic} from '../../../models/route/RouteBasic';
import {Context as UniContext} from '@uniswap/lib-uni/context';
import {
  IPoolDiscoverer,
  ITopPoolsSelector,
  UniPoolInfo,
  V2PoolInfo,
  V3PoolInfo,
  V4PoolInfo,
} from '../../../core/pool-discovery/interface';
import {Protocol} from '../../../models/pool/Protocol';
import {IRouteFinder} from '../../../core/route/RouteFinder';
import {V2Pool} from '../../../models/pool/V2Pool';
import {V3Fee, V3Pool} from '../../../models/pool/V3Pool';
import {V4Pool} from '../../../models/pool/V4Pool';
import {
  ChainId,
  IUniRouteServiceConfig,
  V2_SUPPORTED,
  V4_SUPPORTED,
} from '../../../lib/config';
import {HooksOptions} from '../../../models/hooks/HooksOptions';
import {RouteNamespaceContext} from '../../../models/hooks/namespaces';
import {
  BasicTopPoolsSelector,
  buildTokenPoolIndex,
  getPoolTVL,
  getOtherToken,
} from '../../../core/pool-discovery/TopPoolsSelector';
import {applyDynamicFeeIfNeeded} from '../../../lib/poolUtils';
import {BaseRoutesRepository} from '../BaseRoutesRepository';
import {ADDRESS_ZERO} from '@uniswap/v3-sdk';
import {isExternalProtocol, logElapsedTime} from '../../../lib/helpers';
import {getProtocolForAggHookAddress} from '../../../lib/poolCaching/util/hooksAddressesAllowlist';
import {getHardcodedV4Pools} from '../../../core/pool-discovery/discoverers/hardcoded-v4-pools';

export class UniRoutesRepository extends BaseRoutesRepository {
  constructor(
    protected readonly routeFinder: IRouteFinder<Pool>,
    protected readonly poolDiscoverer: IPoolDiscoverer<UniPoolInfo>,
    protected readonly topPoolsSelector: ITopPoolsSelector<UniPoolInfo>,
    protected readonly topAggHooksPoolsSelector: ITopPoolsSelector<UniPoolInfo>,
    protected readonly serviceConfig: IUniRouteServiceConfig
  ) {
    super(serviceConfig);
  }

  public override async fetchRoutesForTokens(
    chain: Chain,
    tokenInAddress: Address,
    tokenOutAddress: Address,
    protocols: Protocol[],
    generateMixedRoutes: boolean,
    hooksOptions: HooksOptions | undefined,
    skipPoolsForTokensCache: boolean,
    nsCtx: RouteNamespaceContext,
    ctx: UniContext
  ): Promise<RouteBasic<Pool>[]> {
    // Only fetch pools for requested protocols
    const poolPromises: Promise<UniPoolInfo[]>[] = [];
    if (
      protocols.includes(Protocol.V2) &&
      V2_SUPPORTED.includes(chain.chainId)
    ) {
      poolPromises.push(
        this.poolDiscoverer.getPoolsForTokens(
          chain.chainId,
          Protocol.V2,
          tokenInAddress,
          tokenOutAddress,
          this.topPoolsSelector,
          hooksOptions,
          skipPoolsForTokensCache,
          nsCtx,
          ctx
        )
      );
    } else {
      poolPromises.push(Promise.resolve([]));
    }

    if (protocols.includes(Protocol.V3)) {
      poolPromises.push(
        this.poolDiscoverer.getPoolsForTokens(
          chain.chainId,
          Protocol.V3,
          tokenInAddress,
          tokenOutAddress,
          this.topPoolsSelector,
          hooksOptions,
          skipPoolsForTokensCache,
          nsCtx,
          ctx
        )
      );
    } else {
      poolPromises.push(Promise.resolve([]));
    }

    if (
      protocols.includes(Protocol.V4) &&
      V4_SUPPORTED.includes(chain.chainId)
    ) {
      poolPromises.push(
        this.poolDiscoverer.getPoolsForTokens(
          chain.chainId,
          Protocol.V4,
          tokenInAddress,
          tokenOutAddress,
          this.topPoolsSelector,
          hooksOptions,
          skipPoolsForTokensCache,
          nsCtx,
          ctx
        )
      );
    } else {
      poolPromises.push(Promise.resolve([]));
    }

    // External protocols (StableSwap, FluidDex, etc.) are V4 hook-based pools.
    // Fetch them separately and merge into the V4 pool bucket for routing.
    const externalProtocolExists = isExternalProtocol(protocols);
    if (externalProtocolExists && V4_SUPPORTED.includes(chain.chainId)) {
      // Build a selector that pre-filters the pool universe to only AGG_HOOKS pools before
      // applying the standard top-N selection logic.
      // Without this, BasicTopPoolsSelector would fill up topNDirectPairs with high-TVL
      // no-hook V4 pools, leaving no quota for agg hook pools (StableSwap, FluidDex, etc.).
      //
      // We also set skipPoolsForTokensCache=true here because this selector is different
      // from the one used for regular Protocol.V4 fetches (which share the same cache key).
      // Using the cache would either pollute the regular V4 cache with AGG_HOOKS-only results,
      // or return wrong (full V4) results for external protocol fetches.
      poolPromises.push(
        this.poolDiscoverer.getPoolsForTokens(
          chain.chainId,
          // we need to fetch V4 pools for external protocols, because
          // 1) S3SubgraphPoolDiscoverer downloads agg hooked pools as V4 pools
          // 2) BaseCachingPoolDiscoverer needs to maintain the cache key cardinality of Protocol.V4 only
          // Also in case of multiple external protocols being passed from the request,
          // we should serve all the agg hooked pools from non-cached routes repository.
          // The way to do this is to fetch V4 pools for all agg hook protocols from S3SubgraphPoolDiscoverer.
          Protocol.V4,
          tokenInAddress,
          tokenOutAddress,
          this.topAggHooksPoolsSelector,
          hooksOptions,
          true, // always skip per-token-pair cache to avoid polluting Protocol.V4 cache
          nsCtx,
          ctx
        )
      );
    } else {
      poolPromises.push(Promise.resolve([]));
    }

    const fetchPoolsStartTime = Date.now();
    const [poolsV2, poolsV3, rawPoolsV4, rawExternalPools] =
      await Promise.all(poolPromises);

    // Deduplicate by pool ID: if both Protocol.V4 and an external protocol are requested,
    // rawPoolsV4 already contains agg hook pools and rawExternalPools is a filtered subset
    // of those same pools, so a naive spread would produce duplicates.
    const poolsV4Map = new Map<string, UniPoolInfo>();
    for (const pool of rawPoolsV4) poolsV4Map.set(pool.id, pool);
    for (const pool of rawExternalPools) poolsV4Map.set(pool.id, pool);
    const poolsV4 = Array.from(poolsV4Map.values());

    await logElapsedTime('FetchPools', fetchPoolsStartTime, ctx, [
      `chain:${ChainId[chain.chainId]}`,
    ]);

    // Get cross-liquidity pools if mixed routes are enabled and multiple protocols are requested
    if (
      this.serviceConfig.RouteFinder.CrossChainLiquidityPoolsEnabled.has(
        chain.chainId
      ) &&
      generateMixedRoutes &&
      protocols.length > 1
    ) {
      const protocolPoolsMap: Partial<Record<Protocol, UniPoolInfo[]>> = {};
      if (protocols.includes(Protocol.V2)) {
        protocolPoolsMap[Protocol.V2] = poolsV2;
      }
      if (protocols.includes(Protocol.V3)) {
        protocolPoolsMap[Protocol.V3] = poolsV3;
      }
      if (protocols.includes(Protocol.V4)) {
        protocolPoolsMap[Protocol.V4] = poolsV4;
      }

      const crossLiquidityStartTime = Date.now();
      const crossLiquidityPools = await this.getCrossLiquidityCandidatePools(
        chain,
        tokenInAddress,
        tokenOutAddress,
        protocolPoolsMap,
        protocols,
        hooksOptions,
        nsCtx,
        ctx
      );
      await logElapsedTime(
        'CrossLiquidityPools',
        crossLiquidityStartTime,
        ctx,
        [`chain:${ChainId[chain.chainId]}`]
      );

      // Add cross-liquidity pools to their respective protocol buckets
      if (crossLiquidityPools.v2Pools.length > 0) {
        poolsV2.push(...crossLiquidityPools.v2Pools);
      }
      if (crossLiquidityPools.v3Pools.length > 0) {
        poolsV3.push(...crossLiquidityPools.v3Pools);
      }
      if (crossLiquidityPools.v4Pools.length > 0) {
        poolsV4.push(...crossLiquidityPools.v4Pools);
      }
    }

    // Append hardcoded V4 pools so they are always routable regardless of cache state.
    if (
      V4_SUPPORTED.includes(chain.chainId) &&
      protocols.includes(Protocol.V4)
    ) {
      const existingV4Ids = new Set(poolsV4.map(p => p.id));
      const tokenInLower = tokenInAddress.lowerCased;
      const tokenOutLower = tokenOutAddress.lowerCased;
      const appendedPools: V4PoolInfo[] = [];
      for (const hp of getHardcodedV4Pools(chain.chainId)) {
        if (existingV4Ids.has(hp.id)) {
          ctx.logger.debug(
            `Hardcoded V4 pool ${hp.id} already present from pool discovery`,
            {chainId: chain.chainId}
          );
          continue;
        }
        const t0 = hp.token0.id;
        const t1 = hp.token1.id;
        if (
          t0 === tokenInLower ||
          t0 === tokenOutLower ||
          t1 === tokenInLower ||
          t1 === tokenOutLower
        ) {
          poolsV4.push(hp);
          appendedPools.push(hp);
        }
      }
      if (appendedPools.length > 0) {
        ctx.logger.debug(
          `Appended ${appendedPools.length} hardcoded V4 pools`,
          {chainId: chain.chainId, pools: appendedPools}
        );
      }
    }

    // To get allRoutes, use RouteFinder
    // Note: we need to convert UniPoolInfo to UniPool with outdated liquidity and reserves
    // - we could load latest pool info from poolRepository and then use RouteFinder but
    //   this would be slower and more expensive.
    // We only need to load latest pool info for the route we select in the end.
    const generateRoutesStartTime = Date.now();
    const allRoutes = await this.routeFinder.generateRoutes(
      chain.chainId,
      [
        ...poolsV2.map(p => {
          const pool = p as V2PoolInfo;
          return new V2Pool(
            new Address(pool.token0.id),
            new Address(pool.token1.id),
            new Address(pool.id),
            BigInt(Math.floor(pool.reserve)),
            BigInt(Math.floor(pool.supply))
          );
        }),
        ...poolsV3
          .map(p => {
            const pool = p as V3PoolInfo;
            const liquidity = BigInt(pool.liquidity);
            if (liquidity === 0n) {
              return null;
            }
            return new V3Pool(
              new Address(pool.token0.id),
              new Address(pool.token1.id),
              parseInt(pool.feeTier) as V3Fee,
              new Address(pool.id),
              liquidity,
              BigInt(0),
              BigInt(0)
            );
          })
          .filter((pool): pool is V3Pool => pool !== null),
        ...poolsV4
          .map(p => {
            const pool = p as V4PoolInfo;
            // Guard against liquidity being decimals.
            // This happens as part of one incident https://uniswapteam.slack.com/archives/C08TV5WJL07/p1773971483144129
            const liquidity = BigInt(Math.floor(Number(pool.liquidity)));
            // On V4 pools, a liquidity of 0 with no hooks means the pool is inactive.
            // Hooked pools might have external liquidity, so we keep them.
            if (liquidity === 0n && pool.hooks === ADDRESS_ZERO) {
              return null;
            }

            const token0 = new Address(pool.token0.id);
            const token1 = new Address(pool.token1.id);
            const tickSpacing = parseInt(pool.tickSpacing);
            const hooksLower = pool.hooks.toLowerCase();

            // If the pool is a dynamic fee pool, we need to update the fee tier
            const fee = applyDynamicFeeIfNeeded(
              parseInt(pool.feeTier),
              pool.id,
              token0,
              token1,
              tickSpacing,
              hooksLower
            );

            return new V4Pool(
              token0,
              token1,
              fee,
              tickSpacing,
              hooksLower,
              liquidity,
              pool.id,
              BigInt(0),
              BigInt(0)
            );
          })
          .filter((pool): pool is V4Pool => pool !== null),
      ],
      tokenInAddress,
      tokenOutAddress,
      generateMixedRoutes,
      ctx
    );
    await logElapsedTime('GenerateRoutes', generateRoutesStartTime, ctx, [
      `chain:${ChainId[chain.chainId]}`,
    ]);

    return allRoutes;
  }

  /**
   * Finds missing pools that were not selected by the main heuristic but that would
   * create a route with the topPool by TVL with either tokenIn or tokenOut across protocols.
   *
   * e.g. For a swap from ETH (tokenIn) to DOGE (tokenOut):
   *      - V2 pools: wstETH/DOGE is the most liquid pool (found)
   *      - V3 pools: ETH/wstETH is *not* the most liquid pool, so it is not selected
   *      This process will look for the ETH/wstETH pool in V3 to complete the route:
   *      ETH → wstETH (V3) → DOGE (V2)
   */
  private async getCrossLiquidityCandidatePools(
    chain: Chain,
    tokenInAddress: Address,
    tokenOutAddress: Address,
    protocolPools: Partial<Record<Protocol, UniPoolInfo[]>>,
    protocols: Protocol[],
    hooksOptions: HooksOptions | undefined,
    nsCtx: RouteNamespaceContext,
    ctx: UniContext
  ): Promise<{
    v2Pools: V2PoolInfo[];
    v3Pools: V3PoolInfo[];
    v4Pools: V4PoolInfo[];
  }> {
    const result = {
      v2Pools: [] as V2PoolInfo[],
      v3Pools: [] as V3PoolInfo[],
      v4Pools: [] as V4PoolInfo[],
    };

    // Get all pools for each protocol to search through
    const allPoolsPromises: Promise<UniPoolInfo[]>[] = [];

    if (
      protocols.includes(Protocol.V2) &&
      V2_SUPPORTED.includes(chain.chainId)
    ) {
      allPoolsPromises.push(
        this.poolDiscoverer.getPools(chain.chainId, Protocol.V2, ctx)
      );
    } else {
      allPoolsPromises.push(Promise.resolve([]));
    }

    if (protocols.includes(Protocol.V3)) {
      allPoolsPromises.push(
        this.poolDiscoverer.getPools(chain.chainId, Protocol.V3, ctx)
      );
    } else {
      allPoolsPromises.push(Promise.resolve([]));
    }

    if (
      protocols.includes(Protocol.V4) &&
      V4_SUPPORTED.includes(chain.chainId)
    ) {
      allPoolsPromises.push(
        this.poolDiscoverer.getPools(chain.chainId, Protocol.V4, ctx)
      );
    } else {
      allPoolsPromises.push(Promise.resolve([]));
    }

    const [allV2Pools, allV3Pools, rawAllV4Pools] =
      await Promise.all(allPoolsPromises);

    // Delegate the permissioned-hook filter to the top-pools selector so
    // the admission rule lives in one place. Cross-liquidity fetches bypass
    // the selector's top-N heuristic, but the pool-admissibility check is
    // identical, so we reuse `applyPermissionedFilter` here.
    const permissionedFilteredPools =
      BasicTopPoolsSelector.applyPermissionedFilter(
        rawAllV4Pools,
        chain,
        nsCtx,
        tokenInAddress,
        tokenOutAddress,
        chain.chainId
      );

    // Exclude agg hook pools whose protocol was NOT explicitly requested.
    // If the caller includes an external protocol (e.g. a Curve or Fluid hook),
    // those pools are valid cross-liquidity candidates and must be kept.
    // Pools with unrecognized hooks (regular V4) are always kept.
    const allV4Pools = permissionedFilteredPools.filter(pool => {
      const v4Pool = pool as V4PoolInfo;
      const hookProtocol = getProtocolForAggHookAddress(
        v4Pool.hooks,
        chain.chainId
      );
      if (
        hookProtocol !== undefined &&
        !protocols.includes(hookProtocol as Protocol)
      ) {
        return false;
      }
      return true;
    });

    const tokenInAddressLower = tokenInAddress.address.toLowerCase();
    const tokenOutAddressLower = tokenOutAddress.address.toLowerCase();

    // Create sets of already selected pool IDs to avoid duplicates
    const selectedV2PoolIds = new Set(
      protocolPools[Protocol.V2]?.map(p => p.id.toLowerCase()) || []
    );
    const selectedV3PoolIds = new Set(
      protocolPools[Protocol.V3]?.map(p => p.id.toLowerCase()) || []
    );
    const selectedV4PoolIds = new Set(
      protocolPools[Protocol.V4]?.map(p => p.id.toLowerCase()) || []
    );

    // Build token-to-pool indices for efficient lookups
    const v2TokenIndex = buildTokenPoolIndex(allV2Pools);
    const v3TokenIndex = buildTokenPoolIndex(allV3Pools);
    const v4TokenIndex = buildTokenPoolIndex(allV4Pools);

    // Find cross-liquidity pools for V2
    if (
      protocols.includes(Protocol.V2) &&
      V2_SUPPORTED.includes(chain.chainId)
    ) {
      const v2CrossPools = this.findCrossProtocolMissingPools(
        tokenInAddressLower,
        tokenOutAddressLower,
        v2TokenIndex,
        Protocol.V2,
        selectedV2PoolIds,
        protocolPools[Protocol.V3] || [],
        protocolPools[Protocol.V4] || [],
        ctx
      );
      result.v2Pools.push(...(v2CrossPools as V2PoolInfo[]));
    }

    // Find cross-liquidity pools for V3
    if (protocols.includes(Protocol.V3)) {
      const v3CrossPools = this.findCrossProtocolMissingPools(
        tokenInAddressLower,
        tokenOutAddressLower,
        v3TokenIndex,
        Protocol.V3,
        selectedV3PoolIds,
        protocolPools[Protocol.V2] || [],
        protocolPools[Protocol.V4] || [],
        ctx
      );
      result.v3Pools.push(...(v3CrossPools as V3PoolInfo[]));
    }

    // Find cross-liquidity pools for V4
    if (
      protocols.includes(Protocol.V4) &&
      V4_SUPPORTED.includes(chain.chainId)
    ) {
      const v4CrossPools = this.findCrossProtocolMissingPools(
        tokenInAddressLower,
        tokenOutAddressLower,
        v4TokenIndex,
        Protocol.V4,
        selectedV4PoolIds,
        protocolPools[Protocol.V2] || [],
        protocolPools[Protocol.V3] || [],
        ctx
      );
      result.v4Pools.push(...(v4CrossPools as V4PoolInfo[]));
    }

    ctx.logger.debug('Cross-liquidity candidate pools found', {
      chainId: chain.chainId,
      v2Pools: result.v2Pools.length,
      v3Pools: result.v3Pools.length,
      v4Pools: result.v4Pools.length,
    });

    return result;
  }

  /**
   * Helper function to find missing pools for a specific protocol
   */
  private findCrossProtocolMissingPools(
    tokenInAddress: string,
    tokenOutAddress: string,
    tokenIndex: {
      tokenToPools: Map<string, UniPoolInfo[]>;
      poolToTokens: Map<string, Set<string>>;
    },
    protocol: Protocol,
    selectedPoolIds: Set<string>,
    otherProtocolPools1: UniPoolInfo[],
    otherProtocolPools2: UniPoolInfo[],
    ctx: UniContext
  ): UniPoolInfo[] {
    const selectedPools: UniPoolInfo[] = [];

    // Find top TVL pools from other protocols that contain tokenIn or tokenOut
    // but exclude direct tokenIn/tokenOut pools since those are already handled
    const poolsWithTokenOut = [...otherProtocolPools1, ...otherProtocolPools2]
      .filter(pool => {
        const poolToken0 = pool.token0.id.toLowerCase();
        const poolToken1 = pool.token1.id.toLowerCase();
        // Include pools with tokenOut but exclude direct tokenIn/tokenOut pools
        return (
          (poolToken0 === tokenOutAddress || poolToken1 === tokenOutAddress) &&
          !(poolToken0 === tokenInAddress || poolToken1 === tokenInAddress)
        );
      })
      .sort((a, b) => getPoolTVL(b) - getPoolTVL(a));

    const poolsWithTokenIn = [...otherProtocolPools1, ...otherProtocolPools2]
      .filter(pool => {
        const poolToken0 = pool.token0.id.toLowerCase();
        const poolToken1 = pool.token1.id.toLowerCase();
        // Include pools with tokenIn but exclude direct tokenIn/tokenOut pools
        return (
          (poolToken0 === tokenInAddress || poolToken1 === tokenInAddress) &&
          !(poolToken0 === tokenOutAddress || poolToken1 === tokenOutAddress)
        );
      })
      .sort((a, b) => getPoolTVL(b) - getPoolTVL(a));

    const topPoolByTvlWithTokenOut =
      poolsWithTokenOut.length > 0 ? poolsWithTokenOut[0] : null;
    const topPoolByTvlWithTokenIn =
      poolsWithTokenIn.length > 0 ? poolsWithTokenIn[0] : null;

    // Get the cross tokens (the other token in the top pools)
    const crossTokenAgainstTokenOut = topPoolByTvlWithTokenOut
      ? getOtherToken(topPoolByTvlWithTokenOut, tokenOutAddress).toLowerCase()
      : null;

    const crossTokenAgainstTokenIn = topPoolByTvlWithTokenIn
      ? getOtherToken(topPoolByTvlWithTokenIn, tokenInAddress).toLowerCase()
      : null;

    // Search for pools using token-to-pool index
    if (crossTokenAgainstTokenIn) {
      // Look for pools that connect tokenOut with crossTokenAgainstTokenIn
      const tokenOutPools = tokenIndex.tokenToPools.get(tokenOutAddress) || [];
      const crossTokenPools =
        tokenIndex.tokenToPools.get(crossTokenAgainstTokenIn) || [];

      // Find intersection of pools containing both tokens
      const crossTokenPoolIds = new Set(
        crossTokenPools.map(p => p.id.toLowerCase())
      );
      const matchingPools = tokenOutPools
        .filter(pool => {
          const poolId = pool.id.toLowerCase();
          return !selectedPoolIds.has(poolId) && crossTokenPoolIds.has(poolId);
        })
        .sort((a, b) => getPoolTVL(b) - getPoolTVL(a));

      if (matchingPools.length > 0) {
        selectedPools.push(matchingPools[0]);
        ctx.logger.debug(
          `findCrossProtocolMissingPools${protocol}: Found cross-liquidity pool for tokenIn`,
          {
            poolId: matchingPools[0].id,
            token0: matchingPools[0].token0.id,
            token1: matchingPools[0].token1.id,
            tvl: getPoolTVL(matchingPools[0]),
          }
        );
      }
    }

    if (crossTokenAgainstTokenOut && selectedPools.length < 2) {
      // Look for pools that connect tokenIn with crossTokenAgainstTokenOut
      const tokenInPools = tokenIndex.tokenToPools.get(tokenInAddress) || [];
      const crossTokenPools =
        tokenIndex.tokenToPools.get(crossTokenAgainstTokenOut) || [];

      // Find intersection of pools containing both tokens
      const crossTokenPoolIds = new Set(
        crossTokenPools.map(p => p.id.toLowerCase())
      );
      const matchingPools = tokenInPools
        .filter(pool => {
          const poolId = pool.id.toLowerCase();
          return !selectedPoolIds.has(poolId) && crossTokenPoolIds.has(poolId);
        })
        .sort((a, b) => getPoolTVL(b) - getPoolTVL(a));

      if (matchingPools.length > 0) {
        selectedPools.push(matchingPools[0]);
        ctx.logger.debug(
          `findCrossProtocolMissingPools${protocol}: Found cross-liquidity pool for tokenOut`,
          {
            poolId: matchingPools[0].id,
            token0: matchingPools[0].token0.id,
            token1: matchingPools[0].token1.id,
            tvl: getPoolTVL(matchingPools[0]),
          }
        );
      }
    }

    return selectedPools;
  }
}
