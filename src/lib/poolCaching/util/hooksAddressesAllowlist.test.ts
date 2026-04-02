import {describe, it, expect} from 'vitest';
import {
  AGG_HOOKS_PER_CHAIN,
  AGG_HOOKS_PROTOCOL_CACHED_ROUTES_FILTER_OUT_LIST,
  getProtocolForAggHookAddress,
} from './hooksAddressesAllowlist';
import {
  FLUID_DEX_1,
  FLUID_DEX_LITE,
  STABLE_SWAP,
  STABLE_SWAP_NG,
  UNISWAP_AGG_HOOK_ON_TEMPO,
} from './aggHooksAddressesAllowlist';
import {Protocol} from '../../../models/pool/Protocol';
import {ChainId} from '@uniswap/sdk-core';

const MAINNET = ChainId.MAINNET;
const CHAIN_ID_TEMPO = 4217;

describe('AGG_HOOKS_PROTOCOL_CACHED_ROUTES_FILTER_OUT_LIST', () => {
  it('is defined (guards against circular-import causing undefined at module load)', () => {
    expect(AGG_HOOKS_PROTOCOL_CACHED_ROUTES_FILTER_OUT_LIST).toBeInstanceOf(
      Set
    );
  });

  it('is empty (denylist cleared — uniswap-only filtering uses Rule 1 in fetchCachedRoutes)', () => {
    expect(AGG_HOOKS_PROTOCOL_CACHED_ROUTES_FILTER_OUT_LIST).toEqual(new Set());
  });
});

describe('AGG_HOOKS_PER_CHAIN', () => {
  it('contains entries for all expected agg hook protocols', () => {
    expect(AGG_HOOKS_PER_CHAIN[Protocol.CURVESTABLESWAP]).toBeDefined();
    expect(AGG_HOOKS_PER_CHAIN[Protocol.CURVESTABLESWAPNG]).toBeDefined();
    expect(AGG_HOOKS_PER_CHAIN[Protocol.FLUIDDEXT1]).toBeDefined();
    expect(AGG_HOOKS_PER_CHAIN[Protocol.FLUIDDEXLITE]).toBeDefined();
  });
});

describe('getProtocolForAggHookAddress', () => {
  describe('correct protocol returned for known addresses', () => {
    it('identifies a CURVESTABLESWAP address on MAINNET', () => {
      expect(getProtocolForAggHookAddress(STABLE_SWAP[0]!, MAINNET)).toBe(
        Protocol.CURVESTABLESWAP
      );
    });

    it('identifies a CURVESTABLESWAPNG address on MAINNET', () => {
      expect(getProtocolForAggHookAddress(STABLE_SWAP_NG[0]!, MAINNET)).toBe(
        Protocol.CURVESTABLESWAPNG
      );
    });

    it('identifies a FLUIDDEXT1 address on MAINNET', () => {
      expect(getProtocolForAggHookAddress(FLUID_DEX_1[0]!, MAINNET)).toBe(
        Protocol.FLUIDDEXT1
      );
    });

    it('identifies a FLUIDDEXLITE address on MAINNET', () => {
      expect(getProtocolForAggHookAddress(FLUID_DEX_LITE[0]!, MAINNET)).toBe(
        Protocol.FLUIDDEXLITE
      );
    });

    // skipped because Tempo is a special case, we want to treat it as normal v4 pool
    it.skip('identifies the TEMPOEXCHANGE address on the Tempo chain', () => {
      expect(
        getProtocolForAggHookAddress(UNISWAP_AGG_HOOK_ON_TEMPO, CHAIN_ID_TEMPO)
      ).toBe(Protocol.TEMPOEXCHANGE);
    });
  });

  describe('case insensitivity', () => {
    it('matches an uppercase hook address', () => {
      expect(
        getProtocolForAggHookAddress(STABLE_SWAP[0]!.toUpperCase(), MAINNET)
      ).toBe(Protocol.CURVESTABLESWAP);
    });

    it('matches a mixed-case hook address', () => {
      const mixed =
        FLUID_DEX_1[0]!.slice(0, FLUID_DEX_1[0]!.length / 2).toUpperCase() +
        FLUID_DEX_1[0]!.slice(FLUID_DEX_1[0]!.length / 2).toLowerCase();
      expect(getProtocolForAggHookAddress(mixed, MAINNET)).toBe(
        Protocol.FLUIDDEXT1
      );
    });
  });

  describe('unknown addresses return undefined', () => {
    it('returns undefined for an address not in any protocol', () => {
      expect(
        getProtocolForAggHookAddress(
          '0x0000000000000000000000000000000000000001',
          MAINNET
        )
      ).toBeUndefined();
    });

    it('returns undefined for ADDRESS_ZERO', () => {
      expect(
        getProtocolForAggHookAddress(
          '0x0000000000000000000000000000000000000000',
          MAINNET
        )
      ).toBeUndefined();
    });
  });

  describe('wrong chain returns undefined', () => {
    it('returns undefined for a MAINNET address queried on Arbitrum', () => {
      expect(
        getProtocolForAggHookAddress(STABLE_SWAP[0]!, ChainId.ARBITRUM_ONE)
      ).toBeUndefined();
    });

    it('returns undefined for the Tempo address queried on MAINNET', () => {
      expect(
        getProtocolForAggHookAddress(UNISWAP_AGG_HOOK_ON_TEMPO, MAINNET)
      ).toBeUndefined();
    });
  });

  describe('covers all addresses in AGG_HOOKS_PER_CHAIN', () => {
    it('every address in every protocol/chain entry resolves to the correct protocol', () => {
      for (const [protocol, perChain] of Object.entries(
        AGG_HOOKS_PER_CHAIN
      ) as [Protocol, Partial<Record<number, string[]>>][]) {
        for (const [chainIdStr, addresses] of Object.entries(perChain ?? {})) {
          for (const address of addresses ?? []) {
            expect(
              getProtocolForAggHookAddress(address, Number(chainIdStr)),
              `${address} on chain ${chainIdStr}`
            ).toBe(protocol);
          }
        }
      }
    });
  });
});
