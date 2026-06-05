/**
 * Ported from routing-api/lib/util/v4HooksPoolsFiltering.ts
 */

import {Hook, HookOptions} from '@uniswap/v4-sdk';
import {
  getAdapterHookConfig,
  getPermissionedHookAddresses,
} from '@uniswap/lib-sharedconfig/permissionedTokens';
import {HOOKS_ADDRESSES_ALLOWLIST} from './hooksAddressesAllowlist';
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

type V4PoolGroupingKey = string;
const TOP_GROUPED_V4_POOLS = 10;

// Canonical V4 feeTier → tickSpacing pairs (mirrors models V4FeeAmounts/
// V4TickSpacing and what quickRoute probes). Used to bound permissioned-pool
// PoolKeys to a finite, routable set.
const CANONICAL_V4_FEE_TICK_SPACINGS: Record<string, string> = {
  '100': '1',
  '500': '10',
  '3000': '60',
  '10000': '200',
};

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

  // Permissioned-hook (e.g. Superstate) pools are admitted by their hook, not by
  // TVL — an adapter↔adapter pool's tvlETH is ~0 and would lose the top-N race,
  // so admissible ones are appended deterministically below rather than via the
  // TVL queues. The cache MUST apply the same trust boundary as the route path
  // (hasAdmissibleAdapters): persist a permissioned-hook pool only when at least
  // one endpoint is an adapter OWNED by that hook. Without this, the no-TVL-floor
  // permissioned subgraph query could ingest an unbounded set of arbitrary pools
  // initialized under a permissioned hook and bloat the snapshot.
  const permissionedHookAddresses = new Set(
    getPermissionedHookAddresses(chainId).map(hook => hook.toLowerCase())
  );
  const isOwnedAdapter = (token: string, hookAddress: string): boolean =>
    getAdapterHookConfig(chainId, token)?.deployment.hookAddress ===
    hookAddress;
  // A permissioned-hook pool is admissible only if its PoolKey is fully bounded:
  //   - hook ∈ permissioned registry,
  //   - feeTier/tickSpacing ∈ the canonical V4 set (what quickRoute probes),
  //   - BOTH endpoints are "known" (an adapter owned by THIS hook, or a
  //     base/major token), with at least one an owned adapter.
  // This bounds the admitted set to ownedAdapters × (ownedAdapters ∪ majors) ×
  // canonical(fee,tickSpacing) — finite and attacker-uninflatable — so the
  // no-TVL-floor subgraph query cannot bloat the snapshot. Partner base tokens
  // not in the default majors are added via V4_HOOKS_EXTRA_MAJOR_TOKENS (config).
  const isAdmissiblePermissionedPool = (pool: V4SubgraphPool): boolean => {
    const hookAddress = pool.hooks.toLowerCase();
    if (!permissionedHookAddresses.has(hookAddress)) return false;
    // Canonical V4 (feeTier → tickSpacing) pairs only; reject nonstandard keys.
    if (CANONICAL_V4_FEE_TICK_SPACINGS[pool.feeTier] !== pool.tickSpacing) {
      return false;
    }
    const token0 = pool.token0.id.toLowerCase();
    const token1 = pool.token1.id.toLowerCase();
    const token0Owned = isOwnedAdapter(token0, hookAddress);
    const token1Owned = isOwnedAdapter(token1, hookAddress);
    if (!token0Owned && !token1Owned) return false;
    const token0Known = token0Owned || majorTokens.has(token0);
    const token1Known = token1Owned || majorTokens.has(token1);
    return token0Known && token1Known;
  };

  // Auto-allowlisted: non-denylisted, non-zero-address hooks on non-major pairs
  // without custom accounting. These get their own separate top-N TVL queue
  // (parallel to routable hooks) to bound pool cache file size.
  const isAutoAllowlistedHook = (pool: V4SubgraphPool): boolean => {
    const hookAddress = pool.hooks.toLowerCase();
    if (denylistedHooksAddresses.has(hookAddress)) return false;
    if (hookAddress === ADDRESS_ZERO) return false;
    if (hasCustomAccountingPermissions(hookAddress)) return false;
    if (isMajorPair(pool.token0.id, pool.token1.id, majorTokens)) return false;
    return true;
  };

  // Shared logic for adding a pool to a top-N TVL priority queue map.
  const addPoolToQueue = (
    pool: V4SubgraphPool,
    queueMap: Record<V4PoolGroupingKey, PriorityQueue<V4SubgraphPool>>
  ): void => {
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
      logger?.info(`Setting tvl for flETH/FLNCH pool ${JSON.stringify(pool)}`);
      additionalAllowedPool += 1;
    }

    // Zora/Clanker low-TVL filtering (tvlETH <= 0.001) is no longer needed here —
    // the V4_MIN_TVL_ETH filter at the subgraph query level already
    // excludes V4 pools with totalValueLockedETH <= 0.001.

    const key = convertV4PoolToGroupingKey(pool);
    const pq =
      queueMap[key] ??
      new PriorityQueue<V4SubgraphPool>(V4SubgraphPoolComparator);
    pq.push(pool);

    if (pq.size() > TOP_GROUPED_V4_POOLS + additionalAllowedPool) {
      pq.dequeue();
    }

    queueMap[key] = pq;
  };

  // Separate top-N TVL queue for auto-allowlisted hooks
  const autoAllowlistedPoolsByTokenPairsAndFees: Record<
    V4PoolGroupingKey,
    PriorityQueue<V4SubgraphPool>
  > = {};

  pools.forEach((pool: V4SubgraphPool) => {
    if (denylistedHooksAddresses.has(pool.hooks.toLowerCase())) {
      return;
    }

    // Permissioned-hook pools bypass the TVL-bounded queues; they are admitted
    // (ownership-gated) via the deterministic append below.
    if (permissionedHookAddresses.has(pool.hooks.toLowerCase())) {
      return;
    }

    if (isHooksPoolRoutable(pool, chainId, logger, metric)) {
      addPoolToQueue(pool, v4PoolsByTokenPairsAndFees);
    } else if (isAutoAllowlistedHook(pool)) {
      addPoolToQueue(pool, autoAllowlistedPoolsByTokenPairsAndFees);
    }
  });

  const topPoolsByTvl: Array<V4SubgraphPool> = [];
  Object.values(v4PoolsByTokenPairsAndFees).forEach(
    (pq: PriorityQueue<V4SubgraphPool>) => {
      topPoolsByTvl.push(...pq.toArray());
    }
  );

  const topAutoAllowlistedPoolsByTvl: Array<V4SubgraphPool> = [];
  Object.values(autoAllowlistedPoolsByTokenPairsAndFees).forEach(
    (pq: PriorityQueue<V4SubgraphPool>) => {
      topAutoAllowlistedPoolsByTvl.push(...pq.toArray());
    }
  );

  // Create Set for O(1) lookups to find pools not already selected by either queue.
  const selectedPoolIds = new Set(
    topPoolsByTvl
      .concat(topAutoAllowlistedPoolsByTvl)
      .map(pool => pool.id.toLowerCase())
  );

  // Append explicitly allowlisted hooks not already selected by either queue.
  const explicitlyAllowlistedHooksPools = pools.filter(
    (pool: V4SubgraphPool) => {
      const hookAddress = pool.hooks.toLowerCase();
      return (
        allowlistedHooksAddresses.has(hookAddress) &&
        // Permissioned hooks take the dedicated ownership-gated append below;
        // exclude them here so a hook accidentally in both lists isn't doubled.
        !permissionedHookAddresses.has(hookAddress) &&
        !denylistedHooksAddresses.has(hookAddress) &&
        !selectedPoolIds.has(pool.id.toLowerCase())
      );
    }
  );

  // Append permissioned-hook pools that pass the adapter-ownership check, and
  // count the ones rejected for ownership so unowned pools under a permissioned
  // hook never reach the snapshot (the route path still enforces the endpoint
  // check at quote time).
  let rejectedUnownedPermissionedPools = 0;
  const ownedPermissionedHooksPools = pools.filter((pool: V4SubgraphPool) => {
    const hookAddress = pool.hooks.toLowerCase();
    if (!permissionedHookAddresses.has(hookAddress)) return false;
    if (denylistedHooksAddresses.has(hookAddress)) return false;
    if (selectedPoolIds.has(pool.id.toLowerCase())) return false;
    if (!isAdmissiblePermissionedPool(pool)) {
      rejectedUnownedPermissionedPools += 1;
      return false;
    }
    return true;
  });
  if (rejectedUnownedPermissionedPools > 0) {
    metric?.putMetric(
      'v4HooksPoolsFiltering.permissionedHookPoolRejected.unowned',
      rejectedUnownedPermissionedPools,
      MetricLoggerUnit.Count
    );
  }

  return topPoolsByTvl
    .concat(topAutoAllowlistedPoolsByTvl)
    .concat(explicitlyAllowlistedHooksPools)
    .concat(ownedPermissionedHooksPools);
}
