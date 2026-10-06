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
import {ChainId} from '@uniswap/sdk-core';
import {PriorityQueue} from '@datastructures-js/priority-queue';
import {ADDRESS_ZERO} from '@uniswap/router-sdk';
import {V4SubgraphPool} from '../sor-providers/v4/subgraphProvider';
import {Logger} from '../sor-providers/util/log';
import {IMetric} from '../sor-providers/util/metric';
import {MetricLoggerUnit} from '../sor-providers/util/metric';
import {isPoolFeeDynamic} from './isPoolFeeDynamic';
import {getMajorTokens, isMajorPair} from './majorTokens';
import {isStaticFeeWithinSanityCeiling} from './feeTierSanityCeiling';

type V4PoolGroupingKey = string;
const TOP_GROUPED_V4_POOLS = 10;
// Per-hook bound on the factory-discovered (dynamic ZLCA) admission path.
// DualPool-family bytecode owner-gates pool creation so this should never
// bind in practice; it exists so a future factory whose bytecode does NOT
// gate initialization cannot bloat the snapshot with permissionless pools.
const MAX_POOLS_PER_DYNAMIC_ZLCA_HOOK = 50;

// Canonical V4 feeTier → tickSpacing pairs (mirrors models V4FeeAmounts/
// V4TickSpacing and what quickRoute probes). Used to bound permissioned-pool
// PoolKeys to a finite, routable set.
const CANONICAL_V4_FEE_TICK_SPACINGS: Record<string, string> = {
  '75': '1',
  '100': '1',
  '375': '4',
  '500': '10',
  '2500': '25',
  '3000': '60',
  '9000': '90',
  '10000': '200',
};

function isFeeTierWithinSanityCeiling(pool: V4SubgraphPool): boolean {
  return isStaticFeeWithinSanityCeiling(Number(pool.feeTier));
}

function convertV4PoolToGroupingKey(pool: V4SubgraphPool): V4PoolGroupingKey {
  return pool.token0.id.concat(pool.token1.id).concat(pool.feeTier);
}

export function hasCustomAccountingPermissions(hookAddress: string): boolean {
  return (
    Hook.hasPermission(hookAddress, HookOptions.BeforeSwapReturnsDelta) ||
    Hook.hasPermission(hookAddress, HookOptions.AfterSwapReturnsDelta)
  );
}

// Both unvetted admission gates — isHooksPoolRoutable (routable queue) and
// isAutoAllowlistedHook (auto-admit fallback) — must reject dynamic-fee pools:
// a hook can set its fee from a plain beforeSwap with no custom-accounting
// permission bits, so permission checks alone cannot catch it. Matches against
// the pool id (ground truth) rather than the subgraph-reported feeTier string.
function isDynamicFeePool(
  pool: V4SubgraphPool,
  chainId: ChainId,
  logger: Logger
): boolean {
  const dynamic = isPoolFeeDynamic(pool);
  if (dynamic === undefined) {
    // Fail closed: a pool whose id cannot be derived (an unparseable address
    // or tickSpacing) is treated as dynamic so both gates reject it.
    logger?.error(
      `Error classifying dynamic fee for pool ${pool.id} on chain ${chainId}, treating as dynamic: pool key is outside the PoolKey domain`
    );
    return true;
  }
  return dynamic;
}

type HookPermissions = {swap: boolean; customAccounting: boolean};

function isHooksPoolRoutable(
  pool: V4SubgraphPool,
  chainId: ChainId,
  logger: Logger,
  metric: IMetric,
  hookPermissions: (hookAddress: string) => HookPermissions
): boolean {
  try {
    const permissions = hookPermissions(pool.hooks);
    metric?.putMetric(
      `Hook.hasSwapPermissions.${permissions.swap}`,
      1,
      MetricLoggerUnit.Count
    );
    metric?.putMetric(
      `Hook.hasCustomAccountingPermissions.${permissions.customAccounting}`,
      1,
      MetricLoggerUnit.Count
    );
  } catch (e) {
    // A metric-emission failure must not abort filtering for the whole batch.
    logger?.error(`Error emitting hook metrics for pool ${pool.id}: ${e}`);
  }

  return (
    isFeeTierWithinSanityCeiling(pool) &&
    (pool.hooks === ADDRESS_ZERO ||
      (!hookPermissions(pool.hooks).swap &&
        !hookPermissions(pool.hooks).customAccounting &&
        !isDynamicFeePool(pool, chainId, logger)))
  );
}

// it has to be a min heap in order to preserve the top eth tvl v4 pools
const V4SubgraphPoolComparator = (a: V4SubgraphPool, b: V4SubgraphPool) => {
  return a.tvlETH > b.tvlETH ? 1 : -1;
};

export function v4HooksPoolsFiltering(
  chainId: ChainId,
  pools: Array<V4SubgraphPool>,
  logger: Logger,
  metric: IMetric,
  // Factory-discovered ZLCA hooks (dynamicZlcaHooks.ts), admitted exactly
  // like explicit allowlist entries. Denylist still wins — both via the
  // per-pool early return and the explicit-allowlist append's guard.
  dynamicZlcaHooks?: ReadonlySet<string>
): Array<V4SubgraphPool> {
  const v4PoolsByTokenPairsAndFees: Record<
    V4PoolGroupingKey,
    PriorityQueue<V4SubgraphPool>
  > = {};
  const allowlistedHooksAddresses = new Set(
    (HOOKS_ADDRESSES_ALLOWLIST[chainId] ?? []).map(hook => hook.toLowerCase())
  );
  // Hooks admitted ONLY via factory discovery (not also statically listed).
  // Their pools get a per-hook cap below: static entries are vetted per-hook
  // by PR, but dynamic admission is automatic, so bound it in case a future
  // factory's pinned bytecode doesn't owner-gate pool initialization the way
  // DualPool's does (beforeInitialize → DirectInitializeBlocked).
  const dynamicOnlyHooks = new Set<string>();
  if (dynamicZlcaHooks) {
    for (const hook of dynamicZlcaHooks) {
      const hookLower = hook.toLowerCase();
      if (!allowlistedHooksAddresses.has(hookLower)) {
        dynamicOnlyHooks.add(hookLower);
      }
      allowlistedHooksAddresses.add(hookLower);
    }
  }
  const denylistedHooksAddresses = new Set(
    (HOOKS_ADDRESSES_DENYLIST[chainId] ?? []).map(hook => hook.toLowerCase())
  );
  const majorTokens = getMajorTokens(chainId);
  // The v4-sdk re-validates the address on every permission check, and a
  // snapshot carries far fewer distinct hooks than pools (Robinhood: ~300k
  // pools), so each hook is checked once per call. Permission bits are the
  // address's low bits, so the check runs on the lowercase form: casing
  // cannot change the answer, and a wrong EIP-55 checksum cannot make the
  // sdk throw. A malformed address still throws and is not cached.
  const hookPermissionsByAddress = new Map<string, HookPermissions>();
  const hookPermissions = (hookAddress: string): HookPermissions => {
    const address = hookAddress.toLowerCase();
    let permissions = hookPermissionsByAddress.get(address);
    if (permissions === undefined) {
      permissions = {
        swap: Hook.hasSwapPermissions(address),
        customAccounting: hasCustomAccountingPermissions(address),
      };
      hookPermissionsByAddress.set(address, permissions);
    }
    return permissions;
  };

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
  // without custom accounting or a dynamic fee. These get their own separate
  // top-N TVL queue (parallel to routable hooks) to bound pool cache file size.
  const isAutoAllowlistedHook = (pool: V4SubgraphPool): boolean => {
    const hookAddress = pool.hooks.toLowerCase();
    if (denylistedHooksAddresses.has(hookAddress)) return false;
    if (hookAddress === ADDRESS_ZERO) return false;
    if (hookPermissions(hookAddress).customAccounting) return false;
    // The auto-admit path must not be laxer than vetted routable/explicit paths; it admitted ROUTE-1607 pools.
    if (!isFeeTierWithinSanityCeiling(pool)) return false;
    if (isMajorPair(pool.token0.id, pool.token1.id, majorTokens)) return false;
    if (isDynamicFeePool(pool, chainId, logger)) return false;
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

    if (isHooksPoolRoutable(pool, chainId, logger, metric, hookPermissions)) {
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
  // The fee-tier ceiling still applies here: hook trust (allowlisting) and fee
  // sanity are independent axes — ADDRESS_ZERO itself is allowlisted on several
  // chains, so without this check a hookless pool rejected by
  // isHooksPoolRoutable for an absurd fee would be silently re-admitted here.
  let explicitlyAllowlistedHooksPools = pools.filter((pool: V4SubgraphPool) => {
    const hookAddress = pool.hooks.toLowerCase();
    return (
      allowlistedHooksAddresses.has(hookAddress) &&
      isFeeTierWithinSanityCeiling(pool) &&
      // Permissioned hooks take the dedicated ownership-gated append below;
      // exclude them here so a hook accidentally in both lists isn't doubled.
      !permissionedHookAddresses.has(hookAddress) &&
      !denylistedHooksAddresses.has(hookAddress) &&
      !selectedPoolIds.has(pool.id.toLowerCase())
    );
  });

  // Bound the auto-admission path: cap pools per dynamic-only hook, keeping
  // the highest-TVL pools. Static allowlist entries are exempt (vetted by PR).
  if (dynamicOnlyHooks.size > 0) {
    const poolsByDynamicHook = new Map<string, V4SubgraphPool[]>();
    const staticallyAdmittedPools: V4SubgraphPool[] = [];
    for (const pool of explicitlyAllowlistedHooksPools) {
      const hookAddress = pool.hooks.toLowerCase();
      if (dynamicOnlyHooks.has(hookAddress)) {
        const group = poolsByDynamicHook.get(hookAddress) ?? [];
        group.push(pool);
        poolsByDynamicHook.set(hookAddress, group);
      } else {
        staticallyAdmittedPools.push(pool);
      }
    }
    explicitlyAllowlistedHooksPools = staticallyAdmittedPools;
    for (const [hookAddress, group] of poolsByDynamicHook) {
      if (group.length > MAX_POOLS_PER_DYNAMIC_ZLCA_HOOK) {
        group.sort((a, b) => b.tvlETH - a.tvlETH);
        logger?.warn(
          `v4HooksPoolsFiltering: dynamic ZLCA hook ${hookAddress} on chain ${chainId} has ${group.length} pools, capping at ${MAX_POOLS_PER_DYNAMIC_ZLCA_HOOK} by tvlETH`
        );
        metric?.putMetric(
          'v4HooksPoolsFiltering.dynamicZlcaHookPoolsCapped',
          group.length - MAX_POOLS_PER_DYNAMIC_ZLCA_HOOK,
          MetricLoggerUnit.Count,
          {chainId: chainId.toString(), status: 'failure'}
        );
      }
      explicitlyAllowlistedHooksPools.push(
        ...group.slice(0, MAX_POOLS_PER_DYNAMIC_ZLCA_HOOK)
      );
    }
  }

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
