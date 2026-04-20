import {Protocol} from '../../models/pool/Protocol';
import {HooksOptions} from '../../models/hooks/HooksOptions';
import {
  CacheNamespace,
  RouteNamespaceContext,
  createNamespaceContext,
  STANDARD_NAMESPACE_CONTEXT,
} from '../../models/hooks/CacheNamespace';
import {EXTERNAL_PROTOCOLS} from '../../lib/helpers';

export interface NamespaceResolutionInput {
  /** Protocols requested for this quote (e.g. [V2, V3, V4, CurveStableSwap]). */
  protocols: Protocol[];
  /** Hooks preference from the request. */
  hooksOptions: HooksOptions;
}

/**
 * Feature flags that gate namespace-level cache read/write.
 *
 * These are separate from namespace resolution — the resolver determines
 * the correct namespace identity, and these flags decide whether the
 * cache layer is allowed to act on that namespace.
 *
 * Today only agg hooks have flags; permissioned and experimental
 * are added as placeholders so the gate functions are ready for them.
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
 * Design principles:
 *   – Resolution is purely semantic: it identifies what pool classes
 *     are allowed in the search space based on the request.  Config
 *     flags that gate cache access (read/write enabled) are NOT
 *     consulted here — use isCacheReadAllowed / isCacheWriteAllowed
 *     for that.
 *   – Resolution is request-driven, not route-driven. We never infer
 *     the namespace from the final route — we decide upfront.
 *   – HooksOptions is orthogonal to namespaces. NO_HOOKS constrains
 *     the search space to non-hook pools; HOOKS_ONLY constrains it
 *     to only hooked pools. Neither changes which namespace *class*
 *     a pool belongs to, but HOOKS_ONLY means the Standard namespace
 *     should not be included because Standard represents a search
 *     space that includes non-hook pools.
 */
export function resolveNamespaces(
  input: NamespaceResolutionInput
): RouteNamespaceContext {
  const {protocols, hooksOptions} = input;

  // When hooks are excluded entirely, only standard routing applies.
  if (hooksOptions === HooksOptions.NO_HOOKS) {
    return STANDARD_NAMESPACE_CONTEXT;
  }

  const namespaces: CacheNamespace[] = [];

  // Standard is included for HOOKS_INCLUSIVE (the common case).
  // For HOOKS_ONLY, Standard is excluded — the caller explicitly
  // wants only hooked pools, so the search space should not contain
  // the non-hook Standard pool class.
  if (hooksOptions !== HooksOptions.HOOKS_ONLY) {
    namespaces.push(CacheNamespace.Standard);
  }

  // If any external (agg-hook) protocols are requested, add AggHooks.
  // This is unconditional — whether caching is enabled for agg hooks
  // is a separate concern handled by isCacheReadAllowed / isCacheWriteAllowed.
  const hasExternalProtocol = protocols.some(p => EXTERNAL_PROTOCOLS.has(p));
  if (hasExternalProtocol) {
    namespaces.push(CacheNamespace.AggHooks);
  }

  // TODO: Add permissioned namespace activation once product confirms
  // the trigger (token-based vs. request-header-based).
  // if (isPermissionedRequest) {
  //   namespaces.push(CacheNamespace.PermissionedHooks);
  // }

  // TODO: Add experimental namespace activation once product confirms
  // the trigger.
  // if (isExperimentalRequest) {
  //   namespaces.push(CacheNamespace.ExperimentalHooks);
  // }

  // If no namespaces were resolved (e.g. HOOKS_ONLY with no external
  // protocols and no permissioned/experimental signals), the request
  // has no cacheable namespace.  Return null to signal this explicitly
  // — callers must check before using the context for cache operations.
  if (namespaces.length === 0) {
    return NULL_NAMESPACE_CONTEXT;
  }

  return createNamespaceContext(namespaces);
}

/**
 * Sentinel context for requests that don't map to any cache namespace.
 *
 * This happens when HOOKS_ONLY is requested but no specialised hook
 * type (agg, permissioned, experimental) is identified.  Cache
 * operations should be skipped for these requests.
 */
export const NULL_NAMESPACE_CONTEXT: RouteNamespaceContext = Object.freeze({
  allowedNamespaces: Object.freeze([] as CacheNamespace[]),
  namespaceKey: '',
});

/**
 * Returns true when the namespace context represents a cacheable request.
 * Returns false for NULL_NAMESPACE_CONTEXT.
 */
export function isNamespaceCacheable(nsCtx: RouteNamespaceContext): boolean {
  return nsCtx.allowedNamespaces.length > 0;
}

/**
 * Determines whether cached-route reads are allowed for the resolved
 * namespace context.
 *
 * Replaces the ad-hoc `shouldCheckCache` logic in UniRouteBL that
 * checks `AggHooksReadEnabled` inline.
 */
export function isCacheReadAllowed(
  nsCtx: RouteNamespaceContext,
  config: NamespaceCacheConfig
): boolean {
  if (!config.enabled) return false;
  if (!isNamespaceCacheable(nsCtx)) return false;

  for (const ns of nsCtx.allowedNamespaces) {
    switch (ns) {
      case CacheNamespace.AggHooks:
        if (!config.aggHooksReadEnabled) return false;
        break;
      case CacheNamespace.PermissionedHooks:
        if (!config.permissionedHooksReadEnabled) return false;
        break;
      case CacheNamespace.ExperimentalHooks:
        if (!config.experimentalHooksReadEnabled) return false;
        break;
      case CacheNamespace.Standard:
        // Standard is always allowed when global cache is enabled.
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
  if (!isNamespaceCacheable(nsCtx)) return false;

  for (const ns of nsCtx.allowedNamespaces) {
    switch (ns) {
      case CacheNamespace.AggHooks:
        if (!config.aggHooksWriteEnabled) return false;
        break;
      case CacheNamespace.PermissionedHooks:
        if (!config.permissionedHooksWriteEnabled) return false;
        break;
      case CacheNamespace.ExperimentalHooks:
        if (!config.experimentalHooksWriteEnabled) return false;
        break;
      case CacheNamespace.Standard:
        break;
    }
  }
  return true;
}
