import {describe, it, expect, afterEach} from 'vitest';
import {ChainId} from '@uniswap/sdk-core';
import {
  setDynamicZlcaHooks,
  getDynamicZlcaHooks,
  getDynamicZlcaHooksVersion,
  resetDynamicZlcaHooksForTest,
} from './dynamicZlcaHooks';
import {HOOKS_ADDRESSES_DENYLIST} from './hooksAddressesDenylist';

const HOOK_A = '0x00000000000000000000000000000000000000c1';
const HOOK_B = '0x00000000000000000000000000000000000000c2';

describe('dynamicZlcaHooks store', () => {
  afterEach(() => {
    resetDynamicZlcaHooksForTest();
  });

  it('is empty until populated and getDynamicZlcaHooks returns undefined', () => {
    expect(getDynamicZlcaHooks(ChainId.MAINNET)).toBeUndefined();
  });

  it('stores hooks with lowercased keys', () => {
    setDynamicZlcaHooks(
      ChainId.MAINNET,
      new Map([[HOOK_A.toUpperCase().replace('0X', '0x'), 500_000n]])
    );
    expect(getDynamicZlcaHooks(ChainId.MAINNET)?.get(HOOK_A)).toBe(500_000n);
  });

  it('fully replaces a chain set on each call', () => {
    setDynamicZlcaHooks(ChainId.MAINNET, new Map([[HOOK_A, 500_000n]]));
    setDynamicZlcaHooks(ChainId.MAINNET, new Map([[HOOK_B, 1_000_000n]]));
    const hooks = getDynamicZlcaHooks(ChainId.MAINNET);
    expect(hooks?.has(HOOK_A)).toBe(false);
    expect(hooks?.get(HOOK_B)).toBe(1_000_000n);
  });

  it('keeps chains independent', () => {
    setDynamicZlcaHooks(ChainId.MAINNET, new Map([[HOOK_A, 500_000n]]));
    expect(getDynamicZlcaHooks(ChainId.BASE)).toBeUndefined();
  });

  it('returns undefined when a chain is replaced with an empty set', () => {
    setDynamicZlcaHooks(ChainId.MAINNET, new Map([[HOOK_A, 500_000n]]));
    setDynamicZlcaHooks(ChainId.MAINNET, new Map());
    expect(getDynamicZlcaHooks(ChainId.MAINNET)).toBeUndefined();
  });

  it('KEEPS denylisted hooks — the denylist gates admission, not gas calibration', () => {
    // A freshly denylisted hook's routes keep serving from route/pair caches
    // until TTL; dropping its overhead here would under-gas those swaps.
    // Admission-facing consumers (getTvlBypassHookAddresses,
    // v4HooksPoolsFiltering) apply the denylist themselves.
    const denylist = HOOKS_ADDRESSES_DENYLIST[ChainId.MAINNET]!;
    denylist.push(HOOK_A);
    try {
      setDynamicZlcaHooks(ChainId.MAINNET, new Map([[HOOK_A, 500_000n]]));
      expect(getDynamicZlcaHooks(ChainId.MAINNET)?.get(HOOK_A)).toBe(500_000n);
    } finally {
      denylist.pop();
    }
  });

  it('bumps the store version on set and reset', () => {
    const v0 = getDynamicZlcaHooksVersion();
    setDynamicZlcaHooks(ChainId.MAINNET, new Map([[HOOK_A, 500_000n]]));
    const v1 = getDynamicZlcaHooksVersion();
    expect(v1).not.toBe(v0);
    resetDynamicZlcaHooksForTest();
    expect(getDynamicZlcaHooksVersion()).not.toBe(v1);
  });
});
