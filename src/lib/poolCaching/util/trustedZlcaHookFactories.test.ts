import {describe, it, expect} from 'vitest';
import {TRUSTED_ZLCA_HOOK_FACTORIES_PER_CHAIN} from './trustedZlcaHookFactories';

// Mirrors the hooksAddressesAllowlist.test.ts registry-hygiene checks:
// lowercase addresses are load-bearing (the enumerator and dynamic store key
// by lowercased addresses) and a zero/negative overhead would under-estimate
// gas and revert user swaps (see ZLCA_HOOKS_PER_CHAIN doc comment).
describe('TRUSTED_ZLCA_HOOK_FACTORIES_PER_CHAIN hygiene', () => {
  it('every factory address is lowercase and every overhead is positive', () => {
    for (const [chainIdStr, factories] of Object.entries(
      TRUSTED_ZLCA_HOOK_FACTORIES_PER_CHAIN
    )) {
      for (const factory of factories) {
        expect(
          factory.factoryAddress,
          `factory ${factory.name} on chain ${chainIdStr}`
        ).toBe(factory.factoryAddress.toLowerCase());
        expect(
          factory.factoryAddress,
          `factory ${factory.name} on chain ${chainIdStr}`
        ).toMatch(/^0x[0-9a-f]{40}$/);
        expect(
          factory.gasOverheadPerHop > 0n,
          `factory ${factory.name} on chain ${chainIdStr} must declare a positive gasOverheadPerHop`
        ).toBe(true);
      }
    }
  });

  it('no factory is listed twice on a chain', () => {
    for (const factories of Object.values(
      TRUSTED_ZLCA_HOOK_FACTORIES_PER_CHAIN
    )) {
      const addresses = factories.map(factory => factory.factoryAddress);
      expect(new Set(addresses).size).toBe(addresses.length);
    }
  });
});
