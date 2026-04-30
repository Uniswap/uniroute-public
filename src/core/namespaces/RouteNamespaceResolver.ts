import {Protocol} from '../../models/pool/Protocol';
import {HooksOptions} from '../../models/hooks/HooksOptions';
import {Experiment} from '../../models/hooks/Experiment';
import {ChainId} from '../../lib/config';
import {allUniswapAndSomeExternalProtocolsAndMixed} from '../../lib/helpers';
import {shouldUsePermissionedHookNamespace} from '../../models/hooks/PermissionedHooks';
import {
  AggHooksNamespace,
  CacheNamespace,
  CacheNamespaceName,
  EMPTY_NAMESPACE_CONTEXT,
  ExperimentalHooksNamespace,
  PermissionedHooksNamespace,
  RouteNamespaceContext,
  createNamespaceContext,
} from '../../models/hooks/namespaces';

export interface NamespaceResolutionInput {
  /** Protocols requested for this quote (e.g. [V2, V3, V4, CurveStableSwap]). */
  protocols: Protocol[];
  /** Hooks preference from the request. */
  hooksOptions: HooksOptions;
  /** Request params — used to derive PermissionedHooks activation. */
  tokenInAddress: string;
  tokenOutAddress: string;
  chainId: ChainId;
  /**
   * The active experiment for this request, when the caller has opted into
   * experimental-hook routing (e.g. `x-stable-stable-hook-enabled: true` →
   * `Experiment.GuideStar_Stable_Stable`). Presence activates the
   * `ExperimentalHooks` namespace and scopes the cache keyspace under the
   * specific experiment (`ExperimentalHooks#<experiment>#`).
   */
  experiment?: Experiment;
}

/**
 * Feature flags that gate namespace-level cache read/write.
 *
 * These are separate from namespace resolution — the resolver determines
 * the correct namespace identity, and these flags decide whether the
 * cache layer is allowed to act on that namespace.
 */
export interface NamespaceCacheConfig {
  /** Global cache enabled flag. */
  enabled: boolean;
  /** Whether agg-hooks cache reads/writes are enabled. */
  aggHooksReadEnabled: boolean;
  aggHooksWriteEnabled: boolean;
  /** Whether permissioned-hooks cache reads/writes are enabled. */
  permissionedHooksReadEnabled: boolean;
  permissionedHooksWriteEnabled: boolean;
  /** Whether experimental-hooks cache reads/writes are enabled. */
  experimentalHooksReadEnabled: boolean;
  experimentalHooksWriteEnabled: boolean;
}

/**
 * Resolves the cache namespace(s) for a given quote request.
 *
 * Called once near the top of the quote path. The returned context is
 * threaded through cache lookup, pool discovery, and cache writes so
 * that every layer operates on the same namespace scope.
 *
 * The base (pure-Uniswap) case resolves to the empty set, which produces
 * an empty cache-key prefix and therefore byte-identical keys to the
 * pre-namespace format. Specialised namespaces (AggHooks, PermissionedHooks,
 * ExperimentalHooks) are layered on top, each carrying its own dimensions
 * (protocols for AggHooks, experiment for ExperimentalHooks).
 *
 * Whether the request is actually cacheable at all is a separate concern
 * from namespace resolution — it's gated by `shouldCheckCache` in
 * UniRouteBL (HOOKS_ONLY without external protocols, for example, is
 * uncacheable regardless of namespace).
 *
 * Design principles:
 *   – Resolution is purely semantic: it identifies what pool classes
 *     are allowed in the search space based on the request. Config
 *     flags that gate cache access (read/write enabled) are NOT
 *     consulted here — use isCacheReadAllowed / isCacheWriteAllowed
 *     for that.
 *   – Resolution is request-driven, not route-driven. We never infer
 *     the namespace from the final route — we decide upfront.
 */
export function resolveNamespaces(
  input: NamespaceResolutionInput
): RouteNamespaceContext {
  const {
    protocols,
    hooksOptions,
    tokenInAddress,
    tokenOutAddress,
    chainId,
    experiment,
  } = input;

  // NO_HOOKS forces the base case: no hook pools of any class, so no
  // specialised namespaces apply.
  if (hooksOptions === HooksOptions.NO_HOOKS) {
    return EMPTY_NAMESPACE_CONTEXT;
  }

  const namespaces: CacheNamespace[] = [];

  // If any external (agg-hook) protocols are requested, add AggHooks and
  // embed the *full request protocol list* in the namespace instance — the
  // AggHooks cache-key segment (`AggHooks#CurveStableSwapNG,mixed,v2,v3,v4`)
  // renders from this list. The repository layer enforces that callers
  // resolving external protocols through this function end up with an
  // AggHooksNamespace in `namespaces`; hand-rolling `[]` alongside external
  // protocols will throw in `assertCacheableProtocols` rather than silently
  // writing to the Standard keyspace.
  if (allUniswapAndSomeExternalProtocolsAndMixed(protocols)) {
    namespaces.push(new AggHooksNamespace(protocols));
  }

  if (
    shouldUsePermissionedHookNamespace(tokenInAddress, tokenOutAddress, chainId)
  ) {
    namespaces.push(new PermissionedHooksNamespace());
  }

  if (experiment !== undefined) {
    namespaces.push(new ExperimentalHooksNamespace(experiment));
  }

  return createNamespaceContext(namespaces);
}

/**
 * Determines whether cached-route reads are allowed for the resolved
 * namespace context.
 *
 * The base case (empty namespace set) is always read-allowed when the
 * global cache is enabled. Specialised namespaces gate on their
 * per-namespace feature flags.
 */
export function isCacheReadAllowed(
  nsCtx: RouteNamespaceContext,
  config: NamespaceCacheConfig
): boolean {
  if (!config.enabled) return false;

  for (const ns of nsCtx.allowedNamespaces) {
    switch (ns.name) {
      case CacheNamespaceName.AggHooks:
        if (!config.aggHooksReadEnabled) return false;
        break;
      case CacheNamespaceName.PermissionedHooks:
        if (!config.permissionedHooksReadEnabled) return false;
        break;
      case CacheNamespaceName.ExperimentalHooks:
        if (!config.experimentalHooksReadEnabled) return false;
        break;
    }
  }
  return true;
}

/**
 * Determines whether cached-route writes are allowed for the resolved
 * namespace context.
 */
export function isCacheWriteAllowed(
  nsCtx: RouteNamespaceContext,
  config: NamespaceCacheConfig
): boolean {
  if (!config.enabled) return false;

  for (const ns of nsCtx.allowedNamespaces) {
    switch (ns.name) {
      case CacheNamespaceName.AggHooks:
        if (!config.aggHooksWriteEnabled) return false;
        break;
      case CacheNamespaceName.PermissionedHooks:
        if (!config.permissionedHooksWriteEnabled) return false;
        break;
      case CacheNamespaceName.ExperimentalHooks:
        if (!config.experimentalHooksWriteEnabled) return false;
        break;
    }
  }
  return true;
}
