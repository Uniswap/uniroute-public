import {Address} from '../../../models/address/Address';
import {Chain} from '../../../models/chain/Chain';
import {UniPool} from '../../../models/pool/UniPool';
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
import {UniProtocol} from '../../../models/pool/UniProtocol';
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
import {
  buildTokenPoolIndex,
  getPoolTVL,
  getOtherToken,
} from '../../../core/pool-discovery/TopPoolsSelector';
import {applyDynamicFeeIfNeeded} from '../../../lib/poolUtils';
import {BaseRoutesRepository} from '../BaseRoutesRepository';
import {ADDRESS_ZERO} from '@uniswap/v3-sdk';
import {logElapsedTime} from '../../../lib/helpers';

export class UniRoutesRepository extends BaseRoutesRepository {
  constructor(
    protected readonly routeFinder: IRouteFinder<UniPool>,
    protected readonly poolDiscoverer: IPoolDiscoverer<UniPoolInfo>,
    protected readonly topPoolsSelector: ITopPoolsSelector<UniPoolInfo>,
    protected readonly serviceConfig: IUniRouteServiceConfig
  ) {
    super(serviceConfig);
  }

  public override async fetchRoutesForTokens(
    chain: Chain,
    tokenInAddress: Address,
    tokenOutAddress: Address,
    protocols: UniProtocol[],
    generateMixedRoutes: boolean,
    hooksOptions: HooksOptions | undefined,
    skipPoolsForTokensCache: boolean,
    ctx: UniContext
  ): Promise<RouteBasic<UniPool>[]> {
    // Only fetch pools for requested protocols
    const poolPromises: Promise<UniPoolInfo[]>[] = [];
    if (
      protocols.includes(UniProtocol.V2) &&
      V2_SUPPORTED.includes(chain.chainId)
    ) {
      poolPromises.push(
        this.poolDiscoverer.getPoolsForTokens(
          chain.chainId,
          UniProtocol.V2,
          tokenInAddress,
          tokenOutAddress,
          this.topPoolsSelector,
          hooksOptions,
          skipPoolsForTokensCache,
          ctx
        )
      );
    } else {
      poolPromises.push(Promise.resolve([]));
    }

    if (protocols.includes(UniProtocol.V3)) {
      poolPromises.push(
        this.poolDiscoverer.getPoolsForTokens(
          chain.chainId,
          UniProtocol.V3,
          tokenInAddress,
          tokenOutAddress,
          this.topPoolsSelector,
          hooksOptions,
          skipPoolsForTokensCache,
          ctx
        )
      );
    } else {
      poolPromises.push(Promise.resolve([]));
    }

    if (
      protocols.includes(UniProtocol.V4) &&
      V4_SUPPORTED.includes(chain.chainId)
    ) {
      poolPromises.push(
        this.poolDiscoverer.getPoolsForTokens(
          chain.chainId,
          UniProtocol.V4,
          tokenInAddress,
          tokenOutAddress,
          this.topPoolsSelector,
          hooksOptions,
          skipPoolsForTokensCache,
          ctx
        )
      );
    } else {
      poolPromises.push(Promise.resolve([]));
    }

    const fetchPoolsStartTime = Date.now();
    const [poolsV2, poolsV3, poolsV4] = await Promise.all(poolPromises);
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
      const protocolPoolsMap: Partial<Record<UniProtocol, UniPoolInfo[]>> = {};
      if (protocols.includes(UniProtocol.V2)) {
        protocolPoolsMap[UniProtocol.V2] = poolsV2;
      }
      if (protocols.includes(UniProtocol.V3)) {
        protocolPoolsMap[UniProtocol.V3] = poolsV3;
      }
      if (protocols.includes(UniProtocol.V4)) {
        protocolPoolsMap[UniProtocol.V4] = poolsV4;
      }

      const crossLiquidityStartTime = Date.now();
      const crossLiquidityPools = await this.getCrossLiquidityCandidatePools(
        chain,
        tokenInAddress,
        tokenOutAddress,
        protocolPoolsMap,
        protocols,
        hooksOptions,
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

    // To get allRoutes, use RouteFinder
    // Note: we need to convert UniPoolInfo to UniPool with outdated liquidity and reserves
    // - we could load latest pool info from poolRepository and then use RouteFinder but
    //   this would be slower and more expensive.
    // We only need to load latest pool info for the route we select in the end.
    const generateRoutesStartTime = Date.now();
    const allRoutes = this.routeFinder.generateRoutes(
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
            const liquidity = BigInt(pool.liquidity);
            // On V4 pools, a liquidity of 0 with no hooks means the pool is inactive.
            // Hooked pools might have external liquidity, so we keep them.
            if (liquidity === 0n && pool.hooks === ADDRESS_ZERO) {
              return null;
            }

            // If the pool is a dynamic fee pool, we need to update the fee tier
            const fee = applyDynamicFeeIfNeeded(
              parseInt(pool.feeTier),
              pool.id,
              new Address(pool.token0.id),
              new Address(pool.token1.id),
              parseInt(pool.tickSpacing),
              pool.hooks
            );

            return new V4Pool(
              new Address(pool.token0.id),
              new Address(pool.token1.id),
              fee,
              parseInt(pool.tickSpacing),
              pool.hooks,
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
      generateMixedRoutes
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
    protocolPools: Partial<Record<UniProtocol, UniPoolInfo[]>>,
    protocols: UniProtocol[],
    hooksOptions: HooksOptions | undefined,
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
      protocols.includes(UniProtocol.V2) &&
      V2_SUPPORTED.includes(chain.chainId)
    ) {
      allPoolsPromises.push(
        this.poolDiscoverer.getPools(chain.chainId, UniProtocol.V2, ctx)
      );
    } else {
      allPoolsPromises.push(Promise.resolve([]));
    }

    if (protocols.includes(UniProtocol.V3)) {
      allPoolsPromises.push(
        this.poolDiscoverer.getPools(chain.chainId, UniProtocol.V3, ctx)
      );
    } else {
      allPoolsPromises.push(Promise.resolve([]));
    }

    if (
      protocols.includes(UniProtocol.V4) &&
      V4_SUPPORTED.includes(chain.chainId)
    ) {
      allPoolsPromises.push(
        this.poolDiscoverer.getPools(chain.chainId, UniProtocol.V4, ctx)
      );
    } else {
      allPoolsPromises.push(Promise.resolve([]));
    }

    const [allV2Pools, allV3Pools, allV4Pools] =
      await Promise.all(allPoolsPromises);

    const tokenInAddressLower = tokenInAddress.address.toLowerCase();
    const tokenOutAddressLower = tokenOutAddress.address.toLowerCase();

    // Create sets of already selected pool IDs to avoid duplicates
    const selectedV2PoolIds = new Set(
      protocolPools[UniProtocol.V2]?.map(p => p.id.toLowerCase()) || []
    );
    const selectedV3PoolIds = new Set(
      protocolPools[UniProtocol.V3]?.map(p => p.id.toLowerCase()) || []
    );
    const selectedV4PoolIds = new Set(
      protocolPools[UniProtocol.V4]?.map(p => p.id.toLowerCase()) || []
    );

    // Build token-to-pool indices for efficient lookups
    const v2TokenIndex = buildTokenPoolIndex(allV2Pools);
    const v3TokenIndex = buildTokenPoolIndex(allV3Pools);
    const v4TokenIndex = buildTokenPoolIndex(allV4Pools);

    // Find cross-liquidity pools for V2
    if (
      protocols.includes(UniProtocol.V2) &&
      V2_SUPPORTED.includes(chain.chainId)
    ) {
      const v2CrossPools = this.findCrossProtocolMissingPools(
        tokenInAddressLower,
        tokenOutAddressLower,
        v2TokenIndex,
        UniProtocol.V2,
        selectedV2PoolIds,
        protocolPools[UniProtocol.V3] || [],
        protocolPools[UniProtocol.V4] || [],
        ctx
      );
      result.v2Pools.push(...(v2CrossPools as V2PoolInfo[]));
    }

    // Find cross-liquidity pools for V3
    if (protocols.includes(UniProtocol.V3)) {
      const v3CrossPools = this.findCrossProtocolMissingPools(
        tokenInAddressLower,
        tokenOutAddressLower,
        v3TokenIndex,
        UniProtocol.V3,
        selectedV3PoolIds,
        protocolPools[UniProtocol.V2] || [],
        protocolPools[UniProtocol.V4] || [],
        ctx
      );
      result.v3Pools.push(...(v3CrossPools as V3PoolInfo[]));
    }

    // Find cross-liquidity pools for V4
    if (
      protocols.includes(UniProtocol.V4) &&
      V4_SUPPORTED.includes(chain.chainId)
    ) {
      const v4CrossPools = this.findCrossProtocolMissingPools(
        tokenInAddressLower,
        tokenOutAddressLower,
        v4TokenIndex,
        UniProtocol.V4,
        selectedV4PoolIds,
        protocolPools[UniProtocol.V2] || [],
        protocolPools[UniProtocol.V3] || [],
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
    protocol: UniProtocol,
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
