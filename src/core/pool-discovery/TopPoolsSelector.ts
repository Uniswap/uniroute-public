import {Address} from '../../models/address/Address';
import {
  ITopPoolsSelector,
  UniPoolInfo,
  V2PoolInfo,
  V3PoolInfo,
  V4PoolInfo,
} from './interface';
import {ChainId} from '../../lib/config';
import {
  BASE_TOKENS_PER_CHAIN,
  WRAPPED_NATIVE_CURRENCY,
} from '../../lib/tokenUtils';
import {Context} from '@uniswap/lib-uni/context';
import {RoutingBlockList} from '../../lib/RoutingBlockList';
import {UniProtocol} from '../../models/pool/UniProtocol';
import {V2Pool} from '../../models/pool/V2Pool';
import {IChainRepository} from '../../stores/chain/IChainRepository';
import {getApplicableV3FeeAmounts, V3Pool} from '../../models/pool/V3Pool';
import {
  getApplicableV4FeesTickspacingsHooks,
  V4Pool,
} from '../../models/pool/V4Pool';
import {HooksOptions} from '../../models/hooks/HooksOptions';
import {ADDRESS_ZERO} from '@uniswap/router-sdk';
import {IPoolSelectionConfig} from '../../lib/config';

// Token-to-pool index for faster lookups
interface TokenPoolIndex {
  tokenToPools: Map<string, UniPoolInfo[]>;
  poolToTokens: Map<string, Set<string>>;
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

export class BasicTopPoolsSelector implements ITopPoolsSelector<UniPoolInfo> {
  constructor(
    private readonly chainRepository: IChainRepository,
    private readonly poolSelectionConfig: Record<ChainId, IPoolSelectionConfig>
  ) {}

  public async filterPools(
    pools: UniPoolInfo[],
    chainId: ChainId,
    tokenIn: Address,
    tokenOut: Address,
    protocol: UniProtocol,
    hooksOptions: HooksOptions | undefined,
    ctx: Context
  ): Promise<UniPoolInfo[]> {
    ctx.logger.debug(
      `Starting Filtering pools for tokens ${tokenIn} and ${tokenOut}`
    );

    // Filter out pools that are unsupported:
    // Only consider pools where neither tokens are in the blocked token list.
    const filteredUnsupportedPools =
      BasicTopPoolsSelector.filterUnsupportedPools(pools, chainId);
    ctx.logger.debug('Filtering unsupported tokens from pools', {
      chainId,
      totalChainPools: pools.length,
      filteredUnsupportedPools: filteredUnsupportedPools.length,
    });

    // Also filter out pools that don't match the hooks options,
    // only if the uniswap protocol is v4
    const filteredPools = filteredUnsupportedPools.filter(pool => {
      if (protocol === UniProtocol.V4) {
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

    ctx.logger.debug("Filtering pools that don't match the hooks options", {
      chainId,
      filteredUnsupportedPools: filteredUnsupportedPools.length,
      filteredPools: filteredPools.length,
    });

    // Build token-to-pool index for faster lookups
    const tokenPoolIndex = buildTokenPoolIndex(filteredPools);

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
    const topNPairs = BasicTopPoolsSelector.getTopNPairs(
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

  protected static filterUnsupportedPools(
    pools: UniPoolInfo[],
    chainId: ChainId
  ): UniPoolInfo[] {
    return pools.filter(pool => {
      return (
        !RoutingBlockList.isUnsupportedToken(pool.token0.id, chainId) &&
        !RoutingBlockList.isUnsupportedToken(pool.token1.id, chainId)
      );
    });
  }

  protected static filterAndAddPools(
    poolsToFilter: UniPoolInfo[],
    filterFn: (pool: UniPoolInfo) => boolean,
    limit: number,
    seenPoolIds: Set<string>
  ): UniPoolInfo[] {
    // Helper function to filter and add pools without duplicates
    const filteredAndSorted = poolsToFilter
      .filter(pool => {
        const poolId = pool.id.toLowerCase();
        // Only include if not seen before and passes filter
        if (!seenPoolIds.has(poolId) && filterFn(pool)) {
          seenPoolIds.add(poolId);
          return true;
        }
        return false;
      })
      .sort((a, b) => getPoolTVL(b) - getPoolTVL(a));

    // Remove pools that will be sliced from seenPoolIds
    const poolsToRemove = filteredAndSorted.slice(limit);
    poolsToRemove.forEach(pool => {
      seenPoolIds.delete(pool.id.toLowerCase());
    });

    return filteredAndSorted.slice(0, limit);
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

  protected static getDirectPairs(
    pools: UniPoolInfo[],
    chainId: ChainId,
    protocol: UniProtocol,
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
      selectedPoolIds
    );

    if (protocol === UniProtocol.V3) {
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

  protected static getTokenInOnlyPairs(
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
      selectedPoolIds
    );
  }

  protected static getTokenOutOnlyPairs(
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
      selectedPoolIds
    );
  }

  protected static getIntermediaryTokenIds(
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

  protected static getTopNPoolsForIntermediaryToken(
    intermediaryTokenIds: string[],
    selectedPoolIds: Set<string>,
    tokenPoolIndex: TokenPoolIndex,
    chainId: ChainId,
    poolSelectionConfig: Record<ChainId, IPoolSelectionConfig>
  ): UniPoolInfo[] {
    const secondHopPairs: UniPoolInfo[] = [];
    for (const tokenId of Array.from(intermediaryTokenIds)) {
      const topPoolsForToken = BasicTopPoolsSelector.filterAndAddPools(
        tokenPoolIndex.tokenToPools.get(tokenId) || [],
        () => true, // All pools in the index already contain this token
        poolSelectionConfig[chainId].topNSecondHopPairs,
        selectedPoolIds
      );
      secondHopPairs.push(...topPoolsForToken);
    }
    return secondHopPairs;
  }

  protected static getTopNPairs(
    filteredPools: UniPoolInfo[],
    selectedPoolIds: Set<string>,
    chainId: ChainId,
    poolSelectionConfig: Record<ChainId, IPoolSelectionConfig>
  ): UniPoolInfo[] {
    return BasicTopPoolsSelector.filterAndAddPools(
      filteredPools,
      () => true,
      poolSelectionConfig[chainId].topNPairs,
      selectedPoolIds
    );
  }

  protected static getTopBaseTokenPools(
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
        selectedPoolIds
      );
      allBaseTokenPools.push(...selectedPools);
    }

    // Sort all base token pools by TVL and take the top topNWithBaseToken
    return allBaseTokenPools
      .sort((a, b) => getPoolTVL(b) - getPoolTVL(a))
      .slice(0, poolSelectionConfig[chainId].topNWithBaseToken);
  }

  protected static getTopPoolForTokens(
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
    protocol: UniProtocol,
    chainId: ChainId,
    tokenInAddress: string,
    tokenOutAddress: string,
    selectedPoolIds: Set<string>,
    hooksOptions?: HooksOptions
  ) => {
    let forceAddedDirectPools: UniPoolInfo[] = [];
    switch (protocol) {
      case UniProtocol.V2: {
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
      case UniProtocol.V3: {
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
      case UniProtocol.V4: {
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

    if (protocol === UniProtocol.V3) {
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
