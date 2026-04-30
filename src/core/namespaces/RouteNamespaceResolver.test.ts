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
import {ChainId} from '../../lib/config';
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

// Non-adapter tokens — `shouldUsePermissionedHookNamespace` returns
// false for these, so the default makeInput resolves without
// PermissionedHooks unless the caller swaps one in.
const NON_ADAPTER_TOKEN_IN = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'; // WETH
const NON_ADAPTER_TOKEN_OUT = '0xa0b86991c6218B36c1d19D4a2e9Eb0cE3606eB48'; // USDC
// USCC — registered Mainnet adapter (matches PERMISSIONED_ADAPTER_TOKENS).
const USCC_MAINNET = '0x14d60E7FDC0D71d8611742720E4C50E7a974020c';

function makeInput(
  overrides: Partial<NamespaceResolutionInput> = {}
): NamespaceResolutionInput {
  return {
    protocols: [Protocol.V2, Protocol.V3, Protocol.V4, Protocol.MIXED],
    hooksOptions: HooksOptions.HOOKS_INCLUSIVE,
    tokenInAddress: NON_ADAPTER_TOKEN_IN,
    tokenOutAddress: NON_ADAPTER_TOKEN_OUT,
    chainId: ChainId.MAINNET,
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
          protocols: [
            Protocol.V2,
            Protocol.V3,
            Protocol.V4,
            Protocol.MIXED,
            Protocol.FLUIDDEXT1,
          ],
          hooksOptions: HooksOptions.HOOKS_ONLY,
        })
      );
      expect(names(ctx)).toEqual(['AggHooks']);
      expect(buildCacheKeyNamespacePrefix(ctx.allowedNamespaces)).toBe(
        'AggHooks#FluidDexT1,mixed,v2,v3,v4#'
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

    it('activates PermissionedHooks when tokenIn is a registered adapter', () => {
      const ctx = resolveNamespaces(makeInput({tokenInAddress: USCC_MAINNET}));
      expect(names(ctx)).toEqual(['PermissionedHooks']);
      expect(buildCacheKeyNamespacePrefix(ctx.allowedNamespaces)).toBe(
        'PermissionedHooks#'
      );
    });

    it('activates PermissionedHooks when tokenOut is a registered adapter', () => {
      const ctx = resolveNamespaces(makeInput({tokenOutAddress: USCC_MAINNET}));
      expect(names(ctx)).toContain('PermissionedHooks');
    });

    it('does not activate PermissionedHooks when neither token is an adapter', () => {
      const ctx = resolveNamespaces(makeInput());
      expect(names(ctx)).not.toContain('PermissionedHooks');
    });

    it('does not activate PermissionedHooks on chains without registered adapters', () => {
      const ctx = resolveNamespaces(
        makeInput({
          tokenInAddress: USCC_MAINNET,
          chainId: ChainId.ARBITRUM,
        })
      );
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
          tokenInAddress: USCC_MAINNET,
        })
      );
      expect(names(ctx)).toEqual(['AggHooks', 'PermissionedHooks']);
      expect(buildCacheKeyNamespacePrefix(ctx.allowedNamespaces)).toBe(
        'AggHooks#CurveStableSwap,mixed,v2,v3,v4#PermissionedHooks#'
      );
    });

    it('resolves empty set for NO_HOOKS even when an adapter token is involved', () => {
      const ctx = resolveNamespaces(
        makeInput({
          hooksOptions: HooksOptions.NO_HOOKS,
          tokenInAddress: USCC_MAINNET,
        })
      );
      expect(names(ctx)).toEqual([]);
    });

    it('activates PermissionedHooks alone for HOOKS_ONLY + adapter token', () => {
      const ctx = resolveNamespaces(
        makeInput({
          protocols: [Protocol.V4],
          hooksOptions: HooksOptions.HOOKS_ONLY,
          tokenInAddress: USCC_MAINNET,
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
