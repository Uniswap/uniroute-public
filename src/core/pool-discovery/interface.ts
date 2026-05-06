import {buildMetricKey, ChainId} from '../../lib/config';
import {Context} from '@uniswap/lib-uni/context';
import {Address} from '../../models/address/Address';
import {HooksOptions} from 'src/models/hooks/HooksOptions';
import {Protocol} from 'src/models/pool/Protocol';
import {RouteNamespaceContext} from '../../models/hooks/namespaces';

export type UniPoolInfo = V2PoolInfo | V3PoolInfo | V4PoolInfo;

export interface IPoolDiscoverer<TPool extends UniPoolInfo> {
  getPools(
    chainId: ChainId,
    protocol: Protocol,
    ctx: Context
  ): Promise<TPool[]>;
  getPoolsForTokens(
    chainId: ChainId,
    protocol: Protocol,
    tokenIn: Address,
    tokenOut: Address,
    topPoolSelector: ITopPoolsSelector<TPool>,
    hooksOptions: HooksOptions | undefined,
    skipPoolsForTokensCache: boolean,
    nsCtx: RouteNamespaceContext,
    ctx: Context
  ): Promise<TPool[]>;
}

/**
 * Single source of truth for whether `BaseCachingPoolDiscoverer.getPoolsForTokens`
 * should READ from and WRITE to the namespace-independent POOLSFORTOKENS
 * keyspace for this request. The key does NOT include namespace state, so
 * any result whose contents depend on namespace state is unsafe to share.
 *
 * Started life as an out-param for selectors only; now also carries the
 * caller's `skipPoolsForTokensCache` intent and the eventual size-limit
 * verdict, so the read and write sites have one boolean to consult.
 *
 * `skipReason` is informational — populated whenever `shouldUseCache` is
 * flipped to `false`, used for structured logging and the
 * `PoolDiscoverer.getPoolsForTokens.Cache.SkipWrite` metric's `reason` tag.
 *
 * Plumbed as an out-param rather than a return-type change on `filterPools`
 * to avoid churning the many test sites that index the returned array
 * directly.
 */
export type PoolsForTokensCacheDirective = {
  shouldUseCache: boolean;
  skipReason?: PoolsForTokensCacheSkipReason;
};

export enum PoolsForTokensCacheSkipReason {
  /** Caller passed `skipPoolsForTokensCache=true` (e.g. deep-search mode forcing a fresh fetch). */
  CallerOptOut = 'caller_opt_out',
  /**
   * Permissioned-hook pool encountered while the namespace was inactive —
   * the filtered list is incomplete relative to a future namespace-active
   * request for the same pair. See `canIncludePermissionedPool`.
   */
  PermissionedHookInactiveNamespace = 'permissioned_hook_inactive_namespace',
  /** Serialized cache value exceeds `POOLS_FOR_TOKENS_CACHE_VALUE_MAX_BYTES`. */
  ValueTooLarge = 'value_too_large',
  /**
   * `AggHooksTopPoolsSelector` was used. Its filtered output is a strict
   * AGG_HOOKS-only subset of the Protocol.V4 pool universe, but the
   * POOLSFORTOKENS cache key is keyed only on `chainId#protocol#tokenIn#tokenOut`
   * — so a write here would pollute the shared V4 cache key with AGG_HOOKS-only
   * results (and reads from that key would be wrong for regular V4 callers).
   * Callers (e.g. UniRoutesRepository) are expected to pass
   * `skipPoolsForTokensCache=true`, which produces `CallerOptOut` first (and
   * also short-circuits the read). This reason is the defensive backstop: if
   * a future caller forgets the flag, the selector still suppresses the write.
   */
  AggHooksSelector = 'agg_hooks_selector',
}

/**
 * Flip a directive to "do not use cache" with the given reason. First-reason-wins:
 * if the directive is already opted out, the existing reason is preserved
 * (the earliest signal carries the most caller-relevant context — e.g. an
 * explicit `CallerOptOut` should not be obscured by a later size or selector
 * flip).
 */
export function markPoolsForTokensUncacheable(
  directive: PoolsForTokensCacheDirective,
  reason: PoolsForTokensCacheSkipReason
): void {
  if (directive.shouldUseCache) {
    directive.shouldUseCache = false;
    directive.skipReason = reason;
  }
}

/**
 * Emit observability for a settled directive. Intended to be called once
 * after all directive mutations are done (caller opt-out at init, selector
 * flips during filterPools, size-limit verdict), just before the cache-write
 * decision.
 *
 * No-op when `shouldUseCache=true`. Otherwise:
 *   - Debug log describing the skip with structured fields.
 *   - `PoolDiscoverer.getPoolsForTokens.Cache.SkipWrite` count metric tagged
 *     `chain` / `protocol` / `reason` — single source of truth across reasons.
 *   - Suppresses observability for `CallerOptOut` (by-design caller intent
 *     — deep-search forces fresh fetch, not dashboard-worthy).
 */
export async function trackPoolsForTokensCacheSkip(
  directive: PoolsForTokensCacheDirective,
  ctx: Context,
  details: {
    discovererName: string;
    cacheKey: string;
    chainId: ChainId;
    protocol: Protocol;
    cacheValueBytes: number;
    cacheValueLimitBytes: number;
  }
): Promise<void> {
  if (directive.shouldUseCache) return;
  if (directive.skipReason === PoolsForTokensCacheSkipReason.CallerOptOut) {
    return;
  }

  ctx.logger.debug(
    `[${details.discovererName}] Skipping getPoolsForTokens cache write`,
    {
      cacheKey: details.cacheKey,
      chainId: details.chainId,
      protocol: details.protocol,
      reason: directive.skipReason,
      cacheValueBytes: details.cacheValueBytes,
      cacheValueLimitBytes: details.cacheValueLimitBytes,
    }
  );
  await ctx.metrics.count(
    buildMetricKey('PoolDiscoverer.getPoolsForTokens.Cache.SkipWrite'),
    1,
    {
      tags: [
        `chain:${details.chainId}`,
        `protocol:${details.protocol}`,
        `reason:${directive.skipReason}`,
      ],
    }
  );
}

export interface ITopPoolsSelector<TPool extends UniPoolInfo> {
  filterPools(
    pools: TPool[],
    chainId: ChainId,
    tokenIn: Address,
    tokenOut: Address,
    protocol: Protocol,
    hooksOptions: HooksOptions | undefined,
    nsCtx: RouteNamespaceContext,
    ctx: Context,
    cacheDirective: PoolsForTokensCacheDirective
  ): Promise<TPool[]>;
}

export interface V2PoolInfo {
  id: string;
  token0: {
    id: string;
  };
  token1: {
    id: string;
  };
  supply: number;
  reserve: number;
  reserveUSD: number;
}

export interface V3PoolInfo {
  id: string;
  feeTier: string;
  liquidity: string;
  token0: {
    id: string;
  };
  token1: {
    id: string;
  };
  tvlETH: number;
  tvlUSD: number;
}

export interface V4PoolInfo {
  id: string; // v4 pool id is the internal PoolId from pool manager
  feeTier: string;
  tickSpacing: string;
  hooks: string;
  liquidity: string;
  token0: {
    id: string;
  };
  token1: {
    id: string;
  };
  tvlETH: number;
  tvlUSD: number;
  isExternalLiquidity?: boolean;
}
