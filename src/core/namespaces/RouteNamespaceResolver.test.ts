import {describe, expect, it} from 'vitest';
import {
  resolveNamespaces,
  isCacheReadAllowed,
  isCacheWriteAllowed,
  isNamespaceCacheable,
  NULL_NAMESPACE_CONTEXT,
  NamespaceCacheConfig,
  NamespaceResolutionInput,
} from './RouteNamespaceResolver';
import {
  CacheNamespace,
  createNamespaceContext,
} from '../../models/hooks/CacheNamespace';
import {Protocol} from '../../models/pool/Protocol';
import {HooksOptions} from '../../models/hooks/HooksOptions';

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

describe('RouteNamespaceResolver', () => {
  describe('resolveNamespaces', () => {
    it('returns Standard for uniswap-only protocols with HOOKS_INCLUSIVE', () => {
      const ctx = resolveNamespaces(makeInput());
      expect([...ctx.allowedNamespaces]).toEqual([CacheNamespace.Standard]);
      expect(ctx.namespaceKey).toBe('Standard');
    });

    it('returns Standard for NO_HOOKS regardless of protocols', () => {
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
      expect([...ctx.allowedNamespaces]).toEqual([CacheNamespace.Standard]);
    });

    it('returns AggHooks#Standard when external protocols are present', () => {
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
      expect([...ctx.allowedNamespaces]).toEqual([
        CacheNamespace.AggHooks,
        CacheNamespace.Standard,
      ]);
      expect(ctx.namespaceKey).toBe('AggHooks#Standard');
    });

    it('does not consult config flags — agg hook namespace is always resolved when external protocols are present', () => {
      // Even if someone later passes config flags, the resolver ignores them.
      // This verifies the decoupling: resolution is purely semantic.
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
      expect([...ctx.allowedNamespaces]).toContain(CacheNamespace.AggHooks);
      expect([...ctx.allowedNamespaces]).toContain(CacheNamespace.Standard);
    });

    it('returns NULL_NAMESPACE_CONTEXT for HOOKS_ONLY with no external protocols', () => {
      const ctx = resolveNamespaces(
        makeInput({
          protocols: [Protocol.V4],
          hooksOptions: HooksOptions.HOOKS_ONLY,
        })
      );
      expect(ctx).toBe(NULL_NAMESPACE_CONTEXT);
      expect(ctx.allowedNamespaces).toHaveLength(0);
      expect(ctx.namespaceKey).toBe('');
      expect(isNamespaceCacheable(ctx)).toBe(false);
    });

    it('returns AggHooks for HOOKS_ONLY with external protocols', () => {
      const ctx = resolveNamespaces(
        makeInput({
          protocols: [Protocol.V4, Protocol.MIXED, Protocol.FLUIDDEXT1],
          hooksOptions: HooksOptions.HOOKS_ONLY,
        })
      );
      expect([...ctx.allowedNamespaces]).toEqual([CacheNamespace.AggHooks]);
      expect(ctx.namespaceKey).toBe('AggHooks');
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
      // Multiple external protocols still produce a single AggHooks entry
      expect([...ctx.allowedNamespaces]).toEqual([
        CacheNamespace.AggHooks,
        CacheNamespace.Standard,
      ]);
    });

    it('produces frozen allowedNamespaces', () => {
      const ctx = resolveNamespaces(makeInput());
      expect(Object.isFrozen(ctx.allowedNamespaces)).toBe(true);
    });
  });

  describe('isNamespaceCacheable', () => {
    it('returns true for Standard context', () => {
      const ctx = resolveNamespaces(makeInput());
      expect(isNamespaceCacheable(ctx)).toBe(true);
    });

    it('returns true for AggHooks#Standard context', () => {
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
      expect(isNamespaceCacheable(ctx)).toBe(true);
    });

    it('returns false for NULL_NAMESPACE_CONTEXT', () => {
      expect(isNamespaceCacheable(NULL_NAMESPACE_CONTEXT)).toBe(false);
    });
  });

  describe('isCacheReadAllowed', () => {
    it('returns true for Standard with global cache enabled', () => {
      const ctx = resolveNamespaces(makeInput());
      expect(isCacheReadAllowed(ctx, DEFAULT_CONFIG)).toBe(true);
    });

    it('returns false when global cache is disabled', () => {
      const ctx = resolveNamespaces(makeInput());
      expect(isCacheReadAllowed(ctx, {...DEFAULT_CONFIG, enabled: false})).toBe(
        false
      );
    });

    it('returns true for AggHooks#Standard when agg hooks read is enabled', () => {
      const ctx = createNamespaceContext([
        CacheNamespace.AggHooks,
        CacheNamespace.Standard,
      ]);
      expect(isCacheReadAllowed(ctx, DEFAULT_CONFIG)).toBe(true);
    });

    it('returns false when AggHooks is in namespace but read flag is off', () => {
      const ctx = createNamespaceContext([
        CacheNamespace.AggHooks,
        CacheNamespace.Standard,
      ]);
      expect(
        isCacheReadAllowed(ctx, {
          ...DEFAULT_CONFIG,
          aggHooksReadEnabled: false,
        })
      ).toBe(false);
    });

    it('returns false when PermissionedHooks is in namespace but read flag is off', () => {
      const ctx = createNamespaceContext([
        CacheNamespace.Standard,
        CacheNamespace.PermissionedHooks,
      ]);
      expect(
        isCacheReadAllowed(ctx, {
          ...ALL_ENABLED_CONFIG,
          permissionedHooksReadEnabled: false,
        })
      ).toBe(false);
    });

    it('returns false when ExperimentalHooks is in namespace but read flag is off', () => {
      const ctx = createNamespaceContext([
        CacheNamespace.Standard,
        CacheNamespace.ExperimentalHooks,
      ]);
      expect(
        isCacheReadAllowed(ctx, {
          ...ALL_ENABLED_CONFIG,
          experimentalHooksReadEnabled: false,
        })
      ).toBe(false);
    });

    it('returns false for NULL_NAMESPACE_CONTEXT even with all enabled', () => {
      expect(
        isCacheReadAllowed(NULL_NAMESPACE_CONTEXT, ALL_ENABLED_CONFIG)
      ).toBe(false);
    });
  });

  describe('isCacheWriteAllowed', () => {
    it('returns true for Standard with global cache enabled', () => {
      const ctx = resolveNamespaces(makeInput());
      expect(isCacheWriteAllowed(ctx, DEFAULT_CONFIG)).toBe(true);
    });

    it('returns false when global cache is disabled', () => {
      const ctx = resolveNamespaces(makeInput());
      expect(
        isCacheWriteAllowed(ctx, {...DEFAULT_CONFIG, enabled: false})
      ).toBe(false);
    });

    it('returns true for AggHooks#Standard when write is enabled', () => {
      const ctx = createNamespaceContext([
        CacheNamespace.AggHooks,
        CacheNamespace.Standard,
      ]);
      expect(isCacheWriteAllowed(ctx, DEFAULT_CONFIG)).toBe(true);
    });

    it('returns false when AggHooks is in namespace but write flag is off', () => {
      const ctx = createNamespaceContext([
        CacheNamespace.AggHooks,
        CacheNamespace.Standard,
      ]);
      expect(
        isCacheWriteAllowed(ctx, {
          ...DEFAULT_CONFIG,
          aggHooksWriteEnabled: false,
        })
      ).toBe(false);
    });

    it('returns false when PermissionedHooks is in namespace but write flag is off', () => {
      const ctx = createNamespaceContext([
        CacheNamespace.Standard,
        CacheNamespace.PermissionedHooks,
      ]);
      expect(
        isCacheWriteAllowed(ctx, {
          ...ALL_ENABLED_CONFIG,
          permissionedHooksWriteEnabled: false,
        })
      ).toBe(false);
    });

    it('returns false for NULL_NAMESPACE_CONTEXT even with all enabled', () => {
      expect(
        isCacheWriteAllowed(NULL_NAMESPACE_CONTEXT, ALL_ENABLED_CONFIG)
      ).toBe(false);
    });
  });
});
