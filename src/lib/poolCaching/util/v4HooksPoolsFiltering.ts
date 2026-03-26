/**
 * Ported from routing-api/lib/util/v4HooksPoolsFiltering.ts
 */

import {Hook, HookOptions} from '@uniswap/v4-sdk';
import {
  HOOKS_ADDRESSES_ALLOWLIST,
  ZORA_CREATOR_HOOK_ON_BASE_v1,
  ZORA_CREATOR_HOOK_ON_BASE_v1_0_0_1,
  ZORA_CREATOR_HOOK_ON_BASE_v1_1_1,
  ZORA_CREATOR_HOOK_ON_BASE_v1_1_1_1,
  ZORA_CREATOR_HOOK_ON_BASE_v1_1_2,
  ZORA_CREATOR_HOOK_ON_BASE_v2_2,
  ZORA_CREATOR_HOOK_ON_BASE_v2_2_1,
  ZORA_POST_HOOK_ON_BASE_v1,
  ZORA_POST_HOOK_ON_BASE_v1_0_0_1,
  ZORA_POST_HOOK_ON_BASE_v1_0_0_2,
  ZORA_POST_HOOK_ON_BASE_v1_1_1,
  ZORA_POST_HOOK_ON_BASE_v1_1_1_1,
  ZORA_POST_HOOK_ON_BASE_v1_1_2,
  ZORA_POST_HOOK_ON_BASE_v2_2,
  ZORA_POST_HOOK_ON_BASE_v2_2_1,
  ZORA_POST_HOOK_ON_BASE_v2_3_0,
  ZORA_POST_HOOK_ON_BASE_v2_4_0,
  CLANKER_DYNAMIC_FEE_HOOKS_ADDRESS_ON_BASE,
  CLANKER_STATIC_FEE_HOOKS_ADDRESS_ON_BASE,
  CLANKER_DYNAMIC_FEE_HOOKS_ADDRESS_ON_BASE_v2,
  CLANKER_STATIC_FEE_HOOKS_ADDRESS_ON_BASE_v2,
  CLANKER_DYNAMIC_FEE_HOOKS_ADDRESS_ON_ARBITRUM,
  CLANKER_STATIC_FEE_HOOKS_ADDRESS_ON_ARBITRUM,
  CLANKER_DYNAMIC_FEE_HOOKS_ADDRESS_ON_UNICHAIN,
  CLANKER_STATIC_FEE_HOOKS_ADDRESS_ON_UNICHAIN,
  CLANKER_STATIC_FEE_HOOKS_ADDRESS_ON_MAINNET,
  CLANKER_STATIC_FEE_HOOKS_ADDRESS_ON_MONAD,
} from './hooksAddressesAllowlist';
import {HOOKS_ADDRESSES_DENYLIST} from './hooksAddressesDenylist';
import {ChainId, Currency, Token} from '@uniswap/sdk-core';
import {PriorityQueue} from '@datastructures-js/priority-queue';
import {ADDRESS_ZERO} from '@uniswap/router-sdk';
import {V4SubgraphPool} from '../sor-providers/v4/subgraphProvider';
import {Logger} from '../sor-providers/util/log';
import {IMetric} from '../sor-providers/util/metric';
import {MetricLoggerUnit} from '../sor-providers/util/metric';
import {isPoolFeeDynamic} from './isPoolFeeDynamic';
import {nativeOnChain} from './nativeOnChain';
import {getMajorTokens, isMajorPair} from './majorTokens';

const CLANKER_HOOKS = new Set([
  CLANKER_DYNAMIC_FEE_HOOKS_ADDRESS_ON_BASE,
  CLANKER_STATIC_FEE_HOOKS_ADDRESS_ON_BASE,
  CLANKER_DYNAMIC_FEE_HOOKS_ADDRESS_ON_BASE_v2,
  CLANKER_STATIC_FEE_HOOKS_ADDRESS_ON_BASE_v2,
  CLANKER_DYNAMIC_FEE_HOOKS_ADDRESS_ON_ARBITRUM,
  CLANKER_STATIC_FEE_HOOKS_ADDRESS_ON_ARBITRUM,
  CLANKER_DYNAMIC_FEE_HOOKS_ADDRESS_ON_UNICHAIN,
  CLANKER_STATIC_FEE_HOOKS_ADDRESS_ON_UNICHAIN,
  CLANKER_STATIC_FEE_HOOKS_ADDRESS_ON_MAINNET,
  CLANKER_STATIC_FEE_HOOKS_ADDRESS_ON_MONAD,
]);

type V4PoolGroupingKey = string;
const TOP_GROUPED_V4_POOLS = 10;

function convertV4PoolToGroupingKey(pool: V4SubgraphPool): V4PoolGroupingKey {
  return pool.token0.id.concat(pool.token1.id).concat(pool.feeTier);
}

export function hasCustomAccountingPermissions(hookAddress: string): boolean {
  return (
    Hook.hasPermission(hookAddress, HookOptions.BeforeSwapReturnsDelta) ||
    Hook.hasPermission(hookAddress, HookOptions.AfterSwapReturnsDelta)
  );
}

function isHooksPoolRoutable(
  pool: V4SubgraphPool,
  chainId: ChainId,
  logger: Logger,
  metric: IMetric
): boolean {
  try {
    const tokenA: Currency =
      pool.token0.id === ADDRESS_ZERO
        ? nativeOnChain(chainId)
        : new Token(
            chainId,
            pool.token0.id,
            parseInt(pool.token0.decimals),
            pool.token0.symbol,
            pool.token0.name
          );
    const tokenB: Currency =
      pool.token1.id === ADDRESS_ZERO
        ? nativeOnChain(chainId)
        : new Token(
            chainId,
            pool.token1.id,
            parseInt(pool.token1.decimals),
            pool.token1.symbol,
            pool.token1.name
          );

    metric?.putMetric(
      `Hook.hasSwapPermissions.${Hook.hasSwapPermissions(pool.hooks)}`,
      1,
      MetricLoggerUnit.Count
    );
    metric?.putMetric(
      `Hook.hasCustomAccountingPermissions.${hasCustomAccountingPermissions(pool.hooks)}`,
      1,
      MetricLoggerUnit.Count
    );

    return (
      pool.hooks === ADDRESS_ZERO ||
      (!Hook.hasSwapPermissions(pool.hooks) &&
        !hasCustomAccountingPermissions(pool.hooks) &&
        Number(pool.feeTier) <= 1000000 &&
        !isPoolFeeDynamic(
          tokenA,
          tokenB,
          Number(pool.tickSpacing),
          pool.hooks,
          pool.id
        ))
    );
  } catch (e) {
    logger?.error(
      `Error creating tokens for pool ${pool.id} on chain ${chainId} with token0 decimals ${pool.token0.decimals} token1 decimals ${pool.token1.decimals}: ${e}`
    );

    // hardcode to 18 decimals since we cannot parse and pass the token invariant checks
    const tokenA: Currency =
      pool.token0.id === ADDRESS_ZERO
        ? nativeOnChain(chainId)
        : new Token(
            chainId,
            pool.token0.id,
            18,
            pool.token0.symbol,
            pool.token0.name
          );
    const tokenB: Currency =
      pool.token1.id === ADDRESS_ZERO
        ? nativeOnChain(chainId)
        : new Token(
            chainId,
            pool.token1.id,
            18,
            pool.token1.symbol,
            pool.token1.name
          );

    return (
      pool.hooks === ADDRESS_ZERO ||
      (!Hook.hasSwapPermissions(pool.hooks) &&
        !hasCustomAccountingPermissions(pool.hooks) &&
        Number(pool.feeTier) <= 1000000 &&
        !isPoolFeeDynamic(
          tokenA,
          tokenB,
          Number(pool.tickSpacing),
          pool.hooks,
          pool.id
        ))
    );
  }
}

// it has to be a min heap in order to preserve the top eth tvl v4 pools
const V4SubgraphPoolComparator = (a: V4SubgraphPool, b: V4SubgraphPool) => {
  return a.tvlETH > b.tvlETH ? 1 : -1;
};

export function v4HooksPoolsFiltering(
  chainId: ChainId,
  pools: Array<V4SubgraphPool>,
  logger: Logger,
  metric: IMetric
): Array<V4SubgraphPool> {
  const v4PoolsByTokenPairsAndFees: Record<
    V4PoolGroupingKey,
    PriorityQueue<V4SubgraphPool>
  > = {};
  const allowlistedHooksAddresses = new Set(
    (HOOKS_ADDRESSES_ALLOWLIST[chainId] ?? []).map(hook => hook.toLowerCase())
  );
  const denylistedHooksAddresses = new Set(
    (HOOKS_ADDRESSES_DENYLIST[chainId] ?? []).map(hook => hook.toLowerCase())
  );
  const majorTokens = getMajorTokens(chainId);

  /* checks are in order of priority

    - denylisted hooks - never allowed
    - zero address - always allowed, same priority as denylist

    NEEDS ALLOWLIST:
    - custom accounting permissions
    - major pair

    Otherwise, automatically allowed
   */
  const isHookAllowedForPool = (pool: V4SubgraphPool): boolean => {
    const hookAddress = pool.hooks.toLowerCase();

    if (denylistedHooksAddresses.has(hookAddress)) {
      return false;
    }

    if (hookAddress === ADDRESS_ZERO) {
      return true;
    }

    if (
      hasCustomAccountingPermissions(hookAddress) ||
      isMajorPair(pool.token0.id, pool.token1.id, majorTokens)
    ) {
      return allowlistedHooksAddresses.has(hookAddress);
    }

    return true;
  };

  pools.forEach((pool: V4SubgraphPool) => {
    if (
      isHooksPoolRoutable(pool, chainId, logger, metric) &&
      !denylistedHooksAddresses.has(pool.hooks.toLowerCase())
    ) {
      const v4Pools =
        v4PoolsByTokenPairsAndFees[convertV4PoolToGroupingKey(pool)] ??
        new PriorityQueue<V4SubgraphPool>(V4SubgraphPoolComparator);

      let additionalAllowedPool = 0;

      // OPTIMISM ETH/WETH
      if (
        pool.id.toLowerCase() ===
          '0xbf3d38951e485c811bb1fc7025fcd1ef60c15fda4c4163458facb9bedfe26f83'.toLowerCase() &&
        chainId === ChainId.OPTIMISM
      ) {
        pool.tvlETH = 826;
        pool.tvlUSD = 1482475;
        logger?.info(
          `Setting tvl for OPTIMISM ETH/WETH pool ${JSON.stringify(pool)}`
        );
        additionalAllowedPool += 1;
      }

      // UNICHAIN ETH/WETH
      if (
        pool.id.toLowerCase() ===
          '0xba246b8420b5aeb13e586cd7cbd32279fa7584d7f4cbc9bd356a6bb6200d16a6'.toLowerCase() &&
        chainId === ChainId.UNICHAIN
      ) {
        pool.tvlETH = 33482;
        pool.tvlUSD = 60342168;
        logger?.info(
          `Setting tvl for UNICHAIN ETH/WETH pool ${JSON.stringify(pool)}`
        );
        additionalAllowedPool += 1;
      }

      // BASE ETH/WETH
      if (
        pool.id.toLowerCase() ===
          '0xbb2aefc6c55a0464b944c0478869527ba1a537f05f90a1bb82e1196c6e9403e2'.toLowerCase() &&
        chainId === ChainId.BASE
      ) {
        pool.tvlETH = 6992;
        pool.tvlUSD = 12580000;
        logger?.info(
          `Setting tvl for BASE ETH/WETH pool ${JSON.stringify(pool)}`
        );
        additionalAllowedPool += 1;
      }

      // ARBITRUM ETH/WETH
      if (
        pool.id.toLowerCase() ===
          '0xc1c777843809a8e77a398fd79ecddcefbdad6a5676003ae2eedf3a33a56589e9'.toLowerCase() &&
        chainId === ChainId.ARBITRUM_ONE
      ) {
        pool.tvlETH = 23183;
        pool.tvlUSD = 41820637;
        logger?.debug(
          `Setting tvl for ARBITRUM ETH/WETH pool ${JSON.stringify(pool)}`
        );
        additionalAllowedPool += 1;
      }

      // ETH/flETH
      if (
        pool.id.toLowerCase() ===
          '0x14287e3268eb628fcebd2d8f0730b01703109e112a7a41426a556d10211d2086'.toLowerCase() &&
        chainId === ChainId.BASE
      ) {
        pool.tvlETH = 1000;
        pool.tvlUSD = 5500000;
        logger?.info(
          `Setting tvl for flETH/FLNCH pool ${JSON.stringify(pool)}`
        );
        additionalAllowedPool += 1;
      }

      let shouldNotAddV4Pool = false;

      const isZoraPool =
        (pool.hooks.toLowerCase() === ZORA_CREATOR_HOOK_ON_BASE_v1 ||
          pool.hooks.toLowerCase() === ZORA_CREATOR_HOOK_ON_BASE_v1_0_0_1 ||
          pool.hooks.toLowerCase() === ZORA_CREATOR_HOOK_ON_BASE_v1_1_1 ||
          pool.hooks.toLowerCase() === ZORA_CREATOR_HOOK_ON_BASE_v1_1_1_1 ||
          pool.hooks.toLowerCase() === ZORA_CREATOR_HOOK_ON_BASE_v1_1_2 ||
          pool.hooks.toLowerCase() === ZORA_CREATOR_HOOK_ON_BASE_v2_2 ||
          pool.hooks.toLowerCase() === ZORA_CREATOR_HOOK_ON_BASE_v2_2_1 ||
          pool.hooks.toLowerCase() === ZORA_POST_HOOK_ON_BASE_v1 ||
          pool.hooks.toLowerCase() === ZORA_POST_HOOK_ON_BASE_v1_0_0_1 ||
          pool.hooks.toLowerCase() === ZORA_POST_HOOK_ON_BASE_v1_0_0_2 ||
          pool.hooks.toLowerCase() === ZORA_POST_HOOK_ON_BASE_v1_1_1 ||
          pool.hooks.toLowerCase() === ZORA_POST_HOOK_ON_BASE_v1_1_1_1 ||
          pool.hooks.toLowerCase() === ZORA_POST_HOOK_ON_BASE_v1_1_2 ||
          pool.hooks.toLowerCase() === ZORA_POST_HOOK_ON_BASE_v2_2 ||
          pool.hooks.toLowerCase() === ZORA_POST_HOOK_ON_BASE_v2_2_1 ||
          pool.hooks.toLowerCase() === ZORA_POST_HOOK_ON_BASE_v2_3_0 ||
          pool.hooks.toLowerCase() === ZORA_POST_HOOK_ON_BASE_v2_4_0) &&
        chainId === ChainId.BASE;
      if (isZoraPool) {
        if (pool.tvlETH <= 0.001) {
          shouldNotAddV4Pool = true;
        }
      }

      const isClankerPool = CLANKER_HOOKS.has(pool.hooks.toLowerCase());
      if (isClankerPool) {
        if (pool.tvlETH <= 0.001) {
          shouldNotAddV4Pool = true;
        }
      }

      if (!shouldNotAddV4Pool) {
        v4Pools.push(pool);
      }

      if (v4Pools.size() > TOP_GROUPED_V4_POOLS + additionalAllowedPool) {
        v4Pools.dequeue();
      }

      v4PoolsByTokenPairsAndFees[convertV4PoolToGroupingKey(pool)] = v4Pools;
    }
  });

  const topTvlPools: Array<V4SubgraphPool> = [];
  Object.values(v4PoolsByTokenPairsAndFees).forEach(
    (pq: PriorityQueue<V4SubgraphPool>) => {
      topTvlPools.push(...pq.toArray());
    }
  );

  // Create Set for O(1) lookups in order to compute pools excluded by top TVL capping.
  const topTvlPoolIds = new Set(topTvlPools.map(pool => pool.id.toLowerCase()));

  const allowlistedHooksPools = pools.filter((pool: V4SubgraphPool) => {
    return (
      isHookAllowedForPool(pool) && !topTvlPoolIds.has(pool.id.toLowerCase())
    );
  });

  return topTvlPools.concat(allowlistedHooksPools);
}
