import {describe, expect, it} from 'vitest';
import {
  resolveNamespaces,
  isCacheReadAllowed,
  isCacheWriteAllowed,
  NamespaceCacheConfig,
  NamespaceResolutionInput,
} from './RouteNamespaceResolver';
import {Experiment} from '../../models/hooks/Experiment';
import {Protocol} from '../../models/pool/Protocol';
import {HooksOptions} from '../../models/hooks/HooksOptions';
import {
  AggHooksNamespace,
  EMPTY_NAMESPACE_CONTEXT,
  ExperimentalHooksNamespace,
  PermissionedHooksNamespace,
  buildCacheKeyNamespacePrefix,
  createNamespaceContext,
} from '../../models/hooks/namespaces';

const ALL_ENABLED_CONFIG: NamespaceCacheConfig = {
  enabled: true,
  aggHooksReadEnabled: true,
  aggHooksWriteEnabled: true,
  permissionedHooksReadEnabled: true,
  permissionedHooksWriteEnabled: true,
  experimentalHooksReadEnabled: true,
  experimentalHooksWriteEnabled: true,
};

const DEFAULT_CONFIG: NamespaceCacheConfig = {
  enabled: true,
  aggHooksReadEnabled: true,
  aggHooksWriteEnabled: true,
  permissionedHooksReadEnabled: false,
  permissionedHooksWriteEnabled: false,
  experimentalHooksReadEnabled: false,
  experimentalHooksWriteEnabled: false,
};

function makeInput(
  overrides: Partial<NamespaceResolutionInput> = {}
): NamespaceResolutionInput {
  return {
    protocols: [Protocol.V2, Protocol.V3, Protocol.V4, Protocol.MIXED],
    hooksOptions: HooksOptions.HOOKS_INCLUSIVE,
    ...overrides,
  };
}

function names(ctx: ReturnType<typeof resolveNamespaces>): string[] {
  return ctx.allowedNamespaces.map(ns => ns.name);
}

describe('RouteNamespaceResolver', () => {
  describe('resolveNamespaces', () => {
    it('returns empty set for uniswap-only protocols with HOOKS_INCLUSIVE (base case)', () => {
      const ctx = resolveNamespaces(makeInput());
      expect(names(ctx)).toEqual([]);
      // Empty → empty prefix → byte-identical to pre-namespace keys.
      expect(buildCacheKeyNamespacePrefix(ctx.allowedNamespaces)).toBe('');
    });

    it('returns empty set for NO_HOOKS regardless of protocols', () => {
      const ctx = resolveNamespaces(
        makeInput({
          protocols: [
            Protocol.V2,
            Protocol.V3,
            Protocol.V4,
            Protocol.MIXED,
            Protocol.CURVESTABLESWAP,
          ],
          hooksOptions: HooksOptions.NO_HOOKS,
        })
      );
      expect(names(ctx)).toEqual([]);
    });

    it('returns [AggHooks] when external protocols are present, inlining the full request protocol list', () => {
      const ctx = resolveNamespaces(
        makeInput({
          protocols: [
            Protocol.V2,
            Protocol.V3,
            Protocol.V4,
            Protocol.MIXED,
            Protocol.CURVESTABLESWAP,
          ],
        })
      );
      expect(names(ctx)).toEqual(['AggHooks']);
      expect(buildCacheKeyNamespacePrefix(ctx.allowedNamespaces)).toBe(
        'AggHooks#CurveStableSwap,mixed,v2,v3,v4#'
      );
    });

    it('does not consult config flags — agg hook namespace is always resolved when external protocols are present', () => {
      // Resolution is purely semantic; caching-enabled flags live elsewhere.
      const ctx = resolveNamespaces(
        makeInput({
          protocols: [
            Protocol.V2,
            Protocol.V3,
            Protocol.V4,
            Protocol.MIXED,
            Protocol.CURVESTABLESWAP,
          ],
        })
      );
      expect(names(ctx)).toContain('AggHooks');
    });

    it('returns empty set for HOOKS_ONLY with no external protocols (caller gates via shouldCheckCache)', () => {
      const ctx = resolveNamespaces(
        makeInput({
          protocols: [Protocol.V4],
          hooksOptions: HooksOptions.HOOKS_ONLY,
        })
      );
      expect(names(ctx)).toEqual([]);
    });

    it('returns [AggHooks] for HOOKS_ONLY with external protocols', () => {
      const ctx = resolveNamespaces(
        makeInput({
          protocols: [Protocol.V4, Protocol.MIXED, Protocol.FLUIDDEXT1],
          hooksOptions: HooksOptions.HOOKS_ONLY,
        })
      );
      expect(names(ctx)).toEqual(['AggHooks']);
      expect(buildCacheKeyNamespacePrefix(ctx.allowedNamespaces)).toBe(
        'AggHooks#FluidDexT1,mixed,v4#'
      );
    });

    it('handles multiple external protocols without duplication', () => {
      const ctx = resolveNamespaces(
        makeInput({
          protocols: [
            Protocol.V2,
            Protocol.V3,
            Protocol.V4,
            Protocol.MIXED,
            Protocol.CURVESTABLESWAP,
            Protocol.FLUIDDEXT1,
            Protocol.FLUIDDEXLITE,
          ],
        })
      );
      expect(names(ctx)).toEqual(['AggHooks']);
    });

    it('produces frozen allowedNamespaces', () => {
      const ctx = resolveNamespaces(makeInput());
      expect(Object.isFrozen(ctx.allowedNamespaces)).toBe(true);
    });

    it('activates PermissionedHooks when x-is-user-allowlisted is true', () => {
      const ctx = resolveNamespaces(makeInput({isUserAllowlisted: true}));
      expect(names(ctx)).toEqual(['PermissionedHooks']);
      expect(buildCacheKeyNamespacePrefix(ctx.allowedNamespaces)).toBe(
        'PermissionedHooks#'
      );
    });

    it('activates PermissionedHooks when x-is-user-allowlisted is false', () => {
      const ctx = resolveNamespaces(makeInput({isUserAllowlisted: false}));
      expect(names(ctx)).toContain('PermissionedHooks');
    });

    it('does not activate PermissionedHooks when the header is absent', () => {
      const ctx = resolveNamespaces(makeInput());
      expect(names(ctx)).not.toContain('PermissionedHooks');
    });

    it('combines AggHooks and PermissionedHooks (sorted)', () => {
      const ctx = resolveNamespaces(
        makeInput({
          protocols: [
            Protocol.V2,
            Protocol.V3,
            Protocol.V4,
            Protocol.MIXED,
            Protocol.CURVESTABLESWAP,
          ],
          isUserAllowlisted: true,
        })
      );
      expect(names(ctx)).toEqual(['AggHooks', 'PermissionedHooks']);
      expect(buildCacheKeyNamespacePrefix(ctx.allowedNamespaces)).toBe(
        'AggHooks#CurveStableSwap,mixed,v2,v3,v4#PermissionedHooks#'
      );
    });

    it('resolves empty set for NO_HOOKS even when the header is set', () => {
      const ctx = resolveNamespaces(
        makeInput({
          hooksOptions: HooksOptions.NO_HOOKS,
          isUserAllowlisted: true,
        })
      );
      expect(names(ctx)).toEqual([]);
    });

    it('activates PermissionedHooks alone for HOOKS_ONLY + header set', () => {
      const ctx = resolveNamespaces(
        makeInput({
          protocols: [Protocol.V4],
          hooksOptions: HooksOptions.HOOKS_ONLY,
          isUserAllowlisted: true,
        })
      );
      expect(names(ctx)).toEqual(['PermissionedHooks']);
    });

    it('includes ExperimentalHooks and carries experiment inside the namespace instance', () => {
      const ctx = resolveNamespaces(
        makeInput({experiment: Experiment.GuideStar_Stable_Stable})
      );
      expect(names(ctx)).toContain('ExperimentalHooks');
      const expNs = ctx.allowedNamespaces.find(
        ns => ns.name === 'ExperimentalHooks'
      ) as ExperimentalHooksNamespace;
      expect(expNs.experiment).toBe(Experiment.GuideStar_Stable_Stable);
      expect(buildCacheKeyNamespacePrefix(ctx.allowedNamespaces)).toBe(
        'ExperimentalHooks#GuideStar_Stable_Stable#'
      );
    });

    it('does not include ExperimentalHooks when experiment is omitted', () => {
      const ctx = resolveNamespaces(makeInput());
      expect(names(ctx)).not.toContain('ExperimentalHooks');
    });

    it('combines ExperimentalHooks with AggHooks when both are triggered', () => {
      const ctx = resolveNamespaces(
        makeInput({
          protocols: [
            Protocol.V2,
            Protocol.V3,
            Protocol.V4,
            Protocol.MIXED,
            Protocol.CURVESTABLESWAP,
          ],
          experiment: Experiment.GuideStar_Stable_Stable,
        })
      );
      expect(names(ctx)).toContain('AggHooks');
      expect(names(ctx)).toContain('ExperimentalHooks');
      expect(buildCacheKeyNamespacePrefix(ctx.allowedNamespaces)).toBe(
        'AggHooks#CurveStableSwap,mixed,v2,v3,v4#ExperimentalHooks#GuideStar_Stable_Stable#'
      );
    });

    it('returns ExperimentalHooks for HOOKS_ONLY when experiment is provided', () => {
      const ctx = resolveNamespaces(
        makeInput({
          protocols: [Protocol.V4],
          hooksOptions: HooksOptions.HOOKS_ONLY,
          experiment: Experiment.GuideStar_Stable_Stable,
        })
      );
      expect(names(ctx)).toEqual(['ExperimentalHooks']);
      const expNs = ctx.allowedNamespaces[0] as ExperimentalHooksNamespace;
      expect(expNs.experiment).toBe(Experiment.GuideStar_Stable_Stable);
    });
  });

  describe('EMPTY_NAMESPACE_CONTEXT', () => {
    it('has an empty allowedNamespaces set', () => {
      expect([...EMPTY_NAMESPACE_CONTEXT.allowedNamespaces]).toEqual([]);
    });

    it('is the base-case context for NO_HOOKS / HOOKS_ONLY-with-no-external requests', () => {
      const ctx = resolveNamespaces(
        makeInput({hooksOptions: HooksOptions.NO_HOOKS})
      );
      expect(ctx).toBe(EMPTY_NAMESPACE_CONTEXT);
    });
  });

  describe('isCacheReadAllowed', () => {
    it('returns true for the base (empty) namespace context with global cache enabled', () => {
      const ctx = resolveNamespaces(makeInput());
      expect(isCacheReadAllowed(ctx, DEFAULT_CONFIG)).toBe(true);
    });

    it('returns false when global cache is disabled', () => {
      const ctx = resolveNamespaces(makeInput());
      expect(isCacheReadAllowed(ctx, {...DEFAULT_CONFIG, enabled: false})).toBe(
        false
      );
    });

    it('returns true for [AggHooks] when agg hooks read is enabled', () => {
      const ctx = createNamespaceContext([new AggHooksNamespace()]);
      expect(isCacheReadAllowed(ctx, DEFAULT_CONFIG)).toBe(true);
    });

    it('returns false when AggHooks is in namespace but read flag is off', () => {
      const ctx = createNamespaceContext([new AggHooksNamespace()]);
      expect(
        isCacheReadAllowed(ctx, {
          ...DEFAULT_CONFIG,
          aggHooksReadEnabled: false,
        })
      ).toBe(false);
    });

    it('returns false when PermissionedHooks is in namespace but read flag is off', () => {
      const ctx = createNamespaceContext([new PermissionedHooksNamespace()]);
      expect(
        isCacheReadAllowed(ctx, {
          ...ALL_ENABLED_CONFIG,
          permissionedHooksReadEnabled: false,
        })
      ).toBe(false);
    });

    it('returns false when ExperimentalHooks is in namespace but read flag is off', () => {
      const ctx = createNamespaceContext([new ExperimentalHooksNamespace()]);
      expect(
        isCacheReadAllowed(ctx, {
          ...ALL_ENABLED_CONFIG,
          experimentalHooksReadEnabled: false,
        })
      ).toBe(false);
    });
  });

  describe('isCacheWriteAllowed', () => {
    it('returns true for the base (empty) namespace context with global cache enabled', () => {
      const ctx = resolveNamespaces(makeInput());
      expect(isCacheWriteAllowed(ctx, DEFAULT_CONFIG)).toBe(true);
    });

    it('returns false when global cache is disabled', () => {
      const ctx = resolveNamespaces(makeInput());
      expect(
        isCacheWriteAllowed(ctx, {...DEFAULT_CONFIG, enabled: false})
      ).toBe(false);
    });

    it('returns true for [AggHooks] when write is enabled', () => {
      const ctx = createNamespaceContext([new AggHooksNamespace()]);
      expect(isCacheWriteAllowed(ctx, DEFAULT_CONFIG)).toBe(true);
    });

    it('returns false when AggHooks is in namespace but write flag is off', () => {
      const ctx = createNamespaceContext([new AggHooksNamespace()]);
      expect(
        isCacheWriteAllowed(ctx, {
          ...DEFAULT_CONFIG,
          aggHooksWriteEnabled: false,
        })
      ).toBe(false);
    });

    it('returns false when PermissionedHooks is in namespace but write flag is off', () => {
      const ctx = createNamespaceContext([new PermissionedHooksNamespace()]);
      expect(
        isCacheWriteAllowed(ctx, {
          ...ALL_ENABLED_CONFIG,
          permissionedHooksWriteEnabled: false,
        })
      ).toBe(false);
    });
  });
});
