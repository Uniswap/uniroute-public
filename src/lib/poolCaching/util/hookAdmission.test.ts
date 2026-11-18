import {afterEach, describe, expect, it} from 'vitest';
import {ChainId} from '@uniswap/sdk-core';
import {blocksUnvettedHookAdmission} from '@uniswap/lib-v4-hooks';
import {getPermissionedHookAddresses} from '@uniswap/lib-sharedconfig/permissionedTokens';
import {
  getLowercasedAllowlistedHooks,
  isHookAdmissible,
  passesUnvettedHookGate,
  resetHookListsForTest,
} from './hookAdmission';
import {
  resetDynamicZlcaHooksForTest,
  setDynamicZlcaHooks,
} from './dynamicZlcaHooks';
import {
  ACCUMULATION_HOOK_ON_MAINNET,
  HOOKS_ADDRESSES_ALLOWLIST,
} from './hooksAddressesAllowlist';
import {
  HOOKS_ADDRESSES_DENYLIST,
  QUOTER_EXEMPT_HOOKS_ON_MAINNET,
} from './hooksAddressesDenylist';

const ZERO_HOOK = '0x0000000000000000000000000000000000000000';
// beforeSwap bit only (0x0080): blocked from unvetted admission, on no list.
const UNLISTED_SWAP_HOOK = '0x1111111111111111111111111111111111110080';
// No permission bits at all.
const UNLISTED_INERT_HOOK = '0x1111111111111111111111111111111111110000';
const STATIC_FEE = (): boolean => false;
const DYNAMIC_FEE = (): boolean => true;
const upperCaseHex = (address: string) => `0x${address.slice(2).toUpperCase()}`;

describe('passesUnvettedHookGate', () => {
  it('admits a hookless pool even when the fee is dynamic', () => {
    expect(passesUnvettedHookGate(ZERO_HOOK, DYNAMIC_FEE)).toBe(true);
  });

  it('admits a hook without swap or custom-accounting bits on a static-fee pool', () => {
    expect(passesUnvettedHookGate(UNLISTED_INERT_HOOK, STATIC_FEE)).toBe(true);
  });

  it('rejects the same hook on a dynamic-fee pool', () => {
    expect(passesUnvettedHookGate(UNLISTED_INERT_HOOK, DYNAMIC_FEE)).toBe(
      false
    );
  });

  it('rejects a swap hook without deriving the dynamic fee', () => {
    let feeChecks = 0;
    const isDynamicFee = () => {
      feeChecks += 1;
      return false;
    };

    expect(passesUnvettedHookGate(UNLISTED_SWAP_HOOK, isDynamicFee)).toBe(
      false
    );
    expect(feeChecks).toBe(0);
  });

  it('uses the injected permission check', () => {
    expect(
      passesUnvettedHookGate(UNLISTED_SWAP_HOOK, STATIC_FEE, () => false)
    ).toBe(true);
  });

  it('propagates a permission check that throws on a malformed address', () => {
    expect(() => passesUnvettedHookGate('0x1234', STATIC_FEE)).toThrow();
  });
});

describe('getLowercasedAllowlistedHooks', () => {
  it('lowercases every entry of the chain allowlist', () => {
    const allowlist = getLowercasedAllowlistedHooks(ChainId.MAINNET);

    expect(allowlist.size).toBeGreaterThan(0);
    for (const hook of HOOKS_ADDRESSES_ALLOWLIST[ChainId.MAINNET] ?? []) {
      expect(allowlist.has(hook.toLowerCase())).toBe(true);
    }
  });

  it('returns an empty set for a chain without an allowlist', () => {
    expect(getLowercasedAllowlistedHooks(999_999).size).toBe(0);
  });
});

describe('isHookAdmissible', () => {
  afterEach(() => {
    resetDynamicZlcaHooksForTest();
  });

  it('admits a hookless pool', () => {
    expect(isHookAdmissible(ChainId.MAINNET, ZERO_HOOK, DYNAMIC_FEE)).toBe(
      true
    );
  });

  it.each([
    ['lowercase', ACCUMULATION_HOOK_ON_MAINNET.toLowerCase()],
    ['uppercase', upperCaseHex(ACCUMULATION_HOOK_ON_MAINNET)],
  ])(
    'admits an allowlisted swap hook stored %s, dynamic fee or not',
    (_casing, hook) => {
      expect(blocksUnvettedHookAdmission(hook)).toBe(true);
      expect(isHookAdmissible(ChainId.MAINNET, hook, DYNAMIC_FEE)).toBe(true);
    }
  );

  it('scopes the allowlist to its chain', () => {
    expect(
      isHookAdmissible(
        ChainId.ARBITRUM_ONE,
        ACCUMULATION_HOOK_ON_MAINNET,
        STATIC_FEE
      )
    ).toBe(false);
  });

  it('rejects an unlisted swap hook', () => {
    expect(
      isHookAdmissible(ChainId.MAINNET, UNLISTED_SWAP_HOOK, STATIC_FEE)
    ).toBe(false);
  });

  it('admits an unlisted inert hook on a static-fee pool only', () => {
    expect(
      isHookAdmissible(ChainId.MAINNET, UNLISTED_INERT_HOOK, STATIC_FEE)
    ).toBe(true);
    expect(
      isHookAdmissible(ChainId.MAINNET, UNLISTED_INERT_HOOK, DYNAMIC_FEE)
    ).toBe(false);
  });

  it('admits a factory-discovered ZLCA hook while the store holds it', () => {
    setDynamicZlcaHooks(
      ChainId.MAINNET,
      new Map([[upperCaseHex(UNLISTED_SWAP_HOOK), 500_000n]])
    );
    expect(
      isHookAdmissible(ChainId.MAINNET, UNLISTED_SWAP_HOOK, STATIC_FEE)
    ).toBe(true);

    resetDynamicZlcaHooksForTest();
    expect(
      isHookAdmissible(ChainId.MAINNET, UNLISTED_SWAP_HOOK, STATIC_FEE)
    ).toBe(false);
  });

  it('admits a permissioned-registry hook that is not allowlisted', () => {
    const [permissionedHook] = getPermissionedHookAddresses(ChainId.MAINNET);
    expect(permissionedHook).toBeDefined();
    expect(
      getLowercasedAllowlistedHooks(ChainId.MAINNET).has(
        permissionedHook.toLowerCase()
      )
    ).toBe(false);
    expect(blocksUnvettedHookAdmission(permissionedHook)).toBe(true);

    expect(
      isHookAdmissible(
        ChainId.MAINNET,
        upperCaseHex(permissionedHook),
        STATIC_FEE
      )
    ).toBe(true);
  });

  it('rejects a denylisted hook even when it is allowlisted', () => {
    const denylist = HOOKS_ADDRESSES_DENYLIST[ChainId.MAINNET];
    expect(denylist).toBeDefined();
    denylist?.push(ACCUMULATION_HOOK_ON_MAINNET);
    resetHookListsForTest();
    try {
      expect(
        isHookAdmissible(
          ChainId.MAINNET,
          ACCUMULATION_HOOK_ON_MAINNET,
          STATIC_FEE
        )
      ).toBe(false);
    } finally {
      denylist?.pop();
      resetHookListsForTest();
    }
  });

  it('rejects a shipped denylist entry', () => {
    const [denylistedHook] = QUOTER_EXEMPT_HOOKS_ON_MAINNET;
    expect(isHookAdmissible(ChainId.MAINNET, denylistedHook, STATIC_FEE)).toBe(
      false
    );
  });
});
