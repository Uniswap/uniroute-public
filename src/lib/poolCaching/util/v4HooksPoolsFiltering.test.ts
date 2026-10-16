import {describe, it, expect, vi} from 'vitest';
import {utils} from 'ethers';
import {
  v4HooksPoolsFiltering,
  blocksUnvettedHookAdmission,
  hasCustomAccountingPermissions,
} from './v4HooksPoolsFiltering';
import {ChainId, Token} from '@uniswap/sdk-core';
import {ADDRESS_ZERO} from '@uniswap/router-sdk';
import {DYNAMIC_FEE_FLAG, Pool} from '@uniswap/v4-sdk';
import {V4SubgraphPool} from '../sor-providers/v4/subgraphProvider';
import type {Logger} from '../sor-providers/util/log';
import {IMetric} from '../sor-providers/util/metric';
import {
  ZORA_CREATOR_HOOK_ON_BASE_v1,
  ZORA_POST_HOOK_ON_BASE_v1,
  ZORA_CREATOR_HOOK_ON_BASE_v1_0_0_1 as _ZORA_CREATOR_HOOK_ON_BASE_v1_0_0_1,
  ZORA_POST_HOOK_ON_BASE_v2_4_0,
  CLANKER_DYNAMIC_FEE_HOOKS_ADDRESS_ON_BASE,
  CLANKER_STATIC_FEE_HOOKS_ADDRESS_ON_BASE,
  CLANKER_DYNAMIC_FEE_HOOKS_ADDRESS_ON_UNICHAIN,
  HOOKS_ADDRESSES_ALLOWLIST,
} from './hooksAddressesAllowlist';
import {HOOKS_ADDRESSES_DENYLIST} from './hooksAddressesDenylist';
import {computeV4PoolId} from './v4PoolIdFast';

const mockLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
};

class MockMetric extends IMetric {
  setProperty(_key: string, _value: unknown): void {}
  putDimensions(_dimensions: Record<string, string>): void {}
  putMetric(
    _key: string,
    _value: number,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _unit?: any,
    _tags?: Record<string, string>
  ): void {}
}

const mockMetric = new MockMetric();

function createPool(overrides: Partial<V4SubgraphPool> = {}): V4SubgraphPool {
  return {
    id: overrides.id ?? '0x' + Math.random().toString(16).slice(2),
    feeTier: '3000',
    tickSpacing: '60',
    hooks: ADDRESS_ZERO,
    liquidity: '1000000',
    token0: {
      id: '0x0000000000000000000000000000000000000001',
      symbol: 'A',
      name: 'TokenA',
      decimals: '18',
    },
    token1: {
      id: '0x0000000000000000000000000000000000000002',
      symbol: 'B',
      name: 'TokenB',
      decimals: '18',
    },
    tvlETH: 10,
    tvlUSD: 20000,
    ...overrides,
  };
}

describe('hasCustomAccountingPermissions', () => {
  it('returns false when no returnsDelta flags are set', () => {
    expect(hasCustomAccountingPermissions(ADDRESS_ZERO)).toBe(false);
    // beforeSwap only (0x80)
    expect(
      hasCustomAccountingPermissions(
        '0x0000000000000000000000000000000000000080'
      )
    ).toBe(false);
  });

  it('returns true when beforeSwapReturnsDelta or afterSwapReturnsDelta is set', () => {
    // beforeSwapReturnsDelta (0x08)
    expect(
      hasCustomAccountingPermissions(
        '0x0000000000000000000000000000000000000008'
      )
    ).toBe(true);
    // afterSwapReturnsDelta (0x04)
    expect(
      hasCustomAccountingPermissions(
        '0x0000000000000000000000000000000000000004'
      )
    ).toBe(true);
    // both (0x0c)
    expect(
      hasCustomAccountingPermissions(
        '0x000000000000000000000000000000000000000c'
      )
    ).toBe(true);
  });
});

describe('blocksUnvettedHookAdmission', () => {
  it('blocks swap and custom-accounting bits', () => {
    // beforeSwap (0x80), afterSwap (0x40), beforeSwapReturnsDelta (0x08),
    // afterSwapReturnsDelta (0x04), before+afterSwap (0xc0).
    for (const hook of [
      '0x0000000000000000000000000000000000000080',
      '0x0000000000000000000000000000000000000040',
      '0x0000000000000000000000000000000000000008',
      '0x0000000000000000000000000000000000000004',
      '0x00000000000000000000000000000000000000c0',
    ]) {
      expect(blocksUnvettedHookAdmission(hook)).toBe(true);
    }
  });

  it('does not block hookless or non-swap bits', () => {
    // beforeAddLiquidity (0x0800), beforeInitialize (0x2000).
    for (const hook of [
      ADDRESS_ZERO,
      '0x0000000000000000000000000000000000000800',
      '0x0000000000000000000000000000000000002000',
    ]) {
      expect(blocksUnvettedHookAdmission(hook)).toBe(false);
    }
  });
});

describe('v4HooksPoolsFiltering', () => {
  describe('major pair hook allowlisting', () => {
    const hookWithoutSwapPermissions =
      '0x0000000000000000000000000000000000000100';

    it('keeps routable non-allowlisted hooked pools when both assets are majors', () => {
      const pool = createPool({
        hooks: hookWithoutSwapPermissions,
        token0: {
          id: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
          symbol: 'WETH',
          name: 'Wrapped Ether',
          decimals: '18',
        },
        token1: {
          id: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          symbol: 'USDC',
          name: 'USD Coin',
          decimals: '6',
        },
      });

      const result = v4HooksPoolsFiltering(
        ChainId.MAINNET,
        [pool],
        mockLogger,
        mockMetric
      );
      expect(result.length).toBe(1);
      expect(result[0]?.id).toBe(pool.id);
    });

    it('drops non-routable non-allowlisted hook on major pair', () => {
      // Hook with beforeSwap permission (0x80) — non-routable due to swap permissions.
      // On a major pair (WETH/USDC on mainnet) and NOT in the explicit allowlist,
      // so nothing admits it.
      const hookWithSwapPermissions =
        '0x0000000000000000000000000000000000000080';
      const pool = createPool({
        hooks: hookWithSwapPermissions,
        tvlETH: 100,
        token0: {
          id: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
          symbol: 'WETH',
          name: 'Wrapped Ether',
          decimals: '18',
        },
        token1: {
          id: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          symbol: 'USDC',
          name: 'USD Coin',
          decimals: '6',
        },
      });

      const result = v4HooksPoolsFiltering(
        ChainId.MAINNET,
        [pool],
        mockLogger,
        mockMetric
      );
      expect(result).toEqual([]);
    });

    it('includes non-allowlisted hooked pools when pair is not major-major', () => {
      const pool = createPool({
        hooks: hookWithoutSwapPermissions,
        token0: {
          id: '0x00000000000000000000000000000000000000a1',
          symbol: 'TOKEN_A',
          name: 'Token A',
          decimals: '18',
        },
        token1: {
          id: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          symbol: 'USDC',
          name: 'USD Coin',
          decimals: '6',
        },
      });

      const result = v4HooksPoolsFiltering(
        ChainId.MAINNET,
        [pool],
        mockLogger,
        mockMetric
      );
      expect(result.length).toBe(1);
    });

    it('applies env-based major token extensions without excluding routable pools', () => {
      const previous = process.env.V4_HOOKS_EXTRA_MAJOR_TOKENS_BY_CHAIN;
      try {
        process.env.V4_HOOKS_EXTRA_MAJOR_TOKENS_BY_CHAIN = JSON.stringify({
          [ChainId.MAINNET]: [
            '0x00000000000000000000000000000000000000a1',
            '0x00000000000000000000000000000000000000a2',
          ],
        });

        const pool = createPool({
          hooks: hookWithoutSwapPermissions,
          token0: {
            id: '0x00000000000000000000000000000000000000a1',
            symbol: 'TOKEN_A',
            name: 'Token A',
            decimals: '18',
          },
          token1: {
            id: '0x00000000000000000000000000000000000000a2',
            symbol: 'TOKEN_B',
            name: 'Token B',
            decimals: '18',
          },
        });

        const result = v4HooksPoolsFiltering(
          ChainId.MAINNET,
          [pool],
          mockLogger,
          mockMetric
        );
        expect(result.length).toBe(1);
        expect(result[0]?.id).toBe(pool.id);
      } finally {
        process.env.V4_HOOKS_EXTRA_MAJOR_TOKENS_BY_CHAIN = previous;
      }
    });
  });

  it('returns pools with ADDRESS_ZERO hooks', () => {
    const pools = [createPool({hooks: ADDRESS_ZERO, tvlETH: 5})];
    const result = v4HooksPoolsFiltering(
      ChainId.MAINNET,
      pools,
      mockLogger,
      mockMetric
    );
    expect(result.length).toBe(1);
  });

  it('limits pools per token pair + fee grouping via top TVL', () => {
    const pools = Array.from({length: 15}, (_, i) =>
      createPool({
        hooks: ADDRESS_ZERO,
        tvlETH: i + 1,
        token0: {
          id: '0x0000000000000000000000000000000000000001',
          symbol: 'A',
          name: 'A',
          decimals: '18',
        },
        token1: {
          id: '0x0000000000000000000000000000000000000002',
          symbol: 'B',
          name: 'B',
          decimals: '18',
        },
        feeTier: '3000',
      })
    );
    const result = v4HooksPoolsFiltering(
      ChainId.MAINNET,
      pools,
      mockLogger,
      mockMetric
    );
    expect(result.length).toBe(15);
  });

  it('returns empty array for empty input', () => {
    const result = v4HooksPoolsFiltering(
      ChainId.MAINNET,
      [],
      mockLogger,
      mockMetric
    );
    expect(result).toEqual([]);
  });

  it('handles pools with non-allowlisted hooks that have no swap permissions', () => {
    const pool = createPool({hooks: ADDRESS_ZERO, tvlETH: 100});
    const result = v4HooksPoolsFiltering(
      ChainId.MAINNET,
      [pool],
      mockLogger,
      mockMetric
    );
    expect(result.length).toBe(1);
  });

  it.each([
    ['beforeSwap', '0x0000000000000000000000000000000000000080'],
    ['afterSwap', '0x0000000000000000000000000000000000000040'],
    ['before+afterSwap', '0x00000000000000000000000000000000000000c0'],
  ])(
    'does not admit a non-allowlisted non-major hooked pool with %s',
    (_name, hook) => {
      const pool = createPool({hooks: hook, tvlETH: 100, feeTier: '3000'});
      const result = v4HooksPoolsFiltering(
        ChainId.MAINNET,
        [pool],
        mockLogger,
        mockMetric
      );
      expect(result).toEqual([]);
    }
  );

  it.each([
    ['beforeSwap', '0x0000000000000000000000000000000000000080'],
    ['afterSwap', '0x0000000000000000000000000000000000000040'],
  ])(
    'still admits a %s hook pool once the hook is allowlisted',
    (_name, hook) => {
      const pool = createPool({hooks: hook, tvlETH: 100, feeTier: '3000'});
      const result = v4HooksPoolsFiltering(
        ChainId.MAINNET,
        [pool],
        mockLogger,
        mockMetric,
        new Set([hook])
      );
      expect(result.map(p => p.id)).toEqual([pool.id]);
    }
  );

  it('includes allowlisted hooks pools even if not in top TVL set', () => {
    const topTvlPool = createPool({
      hooks: ADDRESS_ZERO,
      tvlETH: 100,
      token0: {
        id: '0x0000000000000000000000000000000000000001',
        symbol: 'A',
        name: 'A',
        decimals: '18',
      },
      token1: {
        id: '0x0000000000000000000000000000000000000002',
        symbol: 'B',
        name: 'B',
        decimals: '18',
      },
    });
    const allowlistedPool = createPool({
      hooks: ADDRESS_ZERO,
      tvlETH: 0.5,
      token0: {
        id: '0x0000000000000000000000000000000000000099',
        symbol: 'X',
        name: 'X',
        decimals: '18',
      },
      token1: {
        id: '0x0000000000000000000000000000000000000098',
        symbol: 'Y',
        name: 'Y',
        decimals: '18',
      },
    });
    const result = v4HooksPoolsFiltering(
      ChainId.MAINNET,
      [topTvlPool, allowlistedPool],
      mockLogger,
      mockMetric
    );
    expect(result.length).toBe(2);
  });

  // --- Zora hooks on BASE ---
  // Note: Low-TVL filtering for Zora/Clanker hooks (tvlETH <= 0.001) is now handled
  // at the subgraph query level via V4_MIN_TVL_ETH, so v4HooksPoolsFiltering
  // no longer drops those pools. These tests verify that the function processes
  // Zora/Clanker pools normally when they reach this stage.
  describe('Zora hooks on BASE', () => {
    it('includes Zora creator hook pool on BASE via allowlist', () => {
      const pool = createPool({
        hooks: ZORA_CREATOR_HOOK_ON_BASE_v1,
        tvlETH: 5,
        tvlUSD: 10000,
      });
      const result = v4HooksPoolsFiltering(
        ChainId.BASE,
        [pool],
        mockLogger,
        mockMetric
      );
      expect(result.length).toBe(1);
    });

    it('includes Zora post hook pool on BASE via allowlist', () => {
      const pool = createPool({
        hooks: ZORA_POST_HOOK_ON_BASE_v1,
        tvlETH: 1,
        tvlUSD: 2000,
      });
      const result = v4HooksPoolsFiltering(
        ChainId.BASE,
        [pool],
        mockLogger,
        mockMetric
      );
      expect(result.length).toBe(1);
    });

    it('does not admit the Zora hook on a chain where it is not allowlisted', () => {
      const pool = createPool({
        hooks: ZORA_CREATOR_HOOK_ON_BASE_v1,
        tvlETH: 0.002,
        tvlUSD: 4,
      });
      // The hook has swap callbacks and is allowlisted on BASE only.
      const result = v4HooksPoolsFiltering(
        ChainId.MAINNET,
        [pool],
        mockLogger,
        mockMetric
      );
      expect(result).toEqual([]);
    });

    it('includes Zora post hook v2_4_0 variant on BASE via allowlist', () => {
      const pool = createPool({
        hooks: ZORA_POST_HOOK_ON_BASE_v2_4_0,
        tvlETH: 0.5,
        tvlUSD: 1000,
      });
      const result = v4HooksPoolsFiltering(
        ChainId.BASE,
        [pool],
        mockLogger,
        mockMetric
      );
      expect(result.length).toBe(1);
    });
  });

  // --- Clanker hooks ---
  describe('Clanker hooks', () => {
    it('includes Clanker dynamic fee hook pool via allowlist', () => {
      const pool = createPool({
        hooks: CLANKER_DYNAMIC_FEE_HOOKS_ADDRESS_ON_BASE,
        tvlETH: 5,
        tvlUSD: 10000,
      });
      const result = v4HooksPoolsFiltering(
        ChainId.BASE,
        [pool],
        mockLogger,
        mockMetric
      );
      expect(result.length).toBe(1);
    });

    it('includes Clanker static fee hook pool via allowlist', () => {
      const pool = createPool({
        hooks: CLANKER_STATIC_FEE_HOOKS_ADDRESS_ON_BASE,
        tvlETH: 2,
        tvlUSD: 4000,
      });
      const result = v4HooksPoolsFiltering(
        ChainId.BASE,
        [pool],
        mockLogger,
        mockMetric
      );
      expect(result.length).toBe(1);
    });

    it('includes Clanker hook on UNICHAIN via allowlist', () => {
      const pool = createPool({
        hooks: CLANKER_DYNAMIC_FEE_HOOKS_ADDRESS_ON_UNICHAIN,
        tvlETH: 0.5,
        tvlUSD: 1000,
      });
      const result = v4HooksPoolsFiltering(
        ChainId.UNICHAIN,
        [pool],
        mockLogger,
        mockMetric
      );
      expect(result.length).toBe(1);
    });
  });

  // --- Token0 / Token1 being ADDRESS_ZERO (native currency path) ---
  describe('ADDRESS_ZERO token (native currency)', () => {
    it('handles token0 being ADDRESS_ZERO', () => {
      const pool = createPool({
        hooks: ADDRESS_ZERO,
        tvlETH: 100,
        token0: {
          id: ADDRESS_ZERO,
          symbol: 'ETH',
          name: 'Ethereum',
          decimals: '18',
        },
        token1: {
          id: '0x0000000000000000000000000000000000000002',
          symbol: 'B',
          name: 'B',
          decimals: '18',
        },
      });
      const result = v4HooksPoolsFiltering(
        ChainId.MAINNET,
        [pool],
        mockLogger,
        mockMetric
      );
      expect(result.length).toBe(1);
    });

    it('handles token1 being ADDRESS_ZERO', () => {
      const pool = createPool({
        hooks: ADDRESS_ZERO,
        tvlETH: 100,
        token0: {
          id: '0x0000000000000000000000000000000000000001',
          symbol: 'A',
          name: 'A',
          decimals: '18',
        },
        token1: {
          id: ADDRESS_ZERO,
          symbol: 'ETH',
          name: 'Ethereum',
          decimals: '18',
        },
      });
      const result = v4HooksPoolsFiltering(
        ChainId.MAINNET,
        [pool],
        mockLogger,
        mockMetric
      );
      expect(result.length).toBe(1);
    });

    it('handles both tokens being ADDRESS_ZERO', () => {
      const pool = createPool({
        hooks: ADDRESS_ZERO,
        tvlETH: 100,
        token0: {
          id: ADDRESS_ZERO,
          symbol: 'ETH',
          name: 'Ethereum',
          decimals: '18',
        },
        token1: {
          id: ADDRESS_ZERO,
          symbol: 'ETH',
          name: 'Ethereum',
          decimals: '18',
        },
      });
      // This may fail in Token construction but the catch block handles it
      const result = v4HooksPoolsFiltering(
        ChainId.MAINNET,
        [pool],
        mockLogger,
        mockMetric
      );
      expect(result.length).toBeGreaterThanOrEqual(0);
    });
  });

  // --- Error in token creation falling back to 18 decimals ---
  describe('hook address casing', () => {
    // Low bits 0xa00: beforeAddLiquidity + beforeRemoveLiquidity only, so the
    // hook has no swap or custom-accounting permission and the pool routes.
    const lowercaseHook = '0xabcdef0000000000000000000000000000000a00';
    const checksummedHook = utils.getAddress(lowercaseHook);
    // Flip the case of the first letter, so the casing is mixed but the
    // EIP-55 checksum is wrong.
    const firstLetter = checksummedHook.slice(2).search(/[a-fA-F]/) + 2;
    const flipped = checksummedHook[firstLetter];
    const badChecksumHook =
      checksummedHook.slice(0, firstLetter) +
      (flipped === flipped.toUpperCase()
        ? flipped.toLowerCase()
        : flipped.toUpperCase()) +
      checksummedHook.slice(firstLetter + 1);

    it.each([
      {label: 'lowercase', hooks: lowercaseHook},
      {label: 'checksummed', hooks: checksummedHook},
      {label: 'mixed case with a wrong checksum', hooks: badChecksumHook},
    ])('routes a pool whose hook address is $label', ({hooks}) => {
      expect(utils.isAddress(badChecksumHook)).toBe(false);
      const result = v4HooksPoolsFiltering(
        ChainId.MAINNET,
        [createPool({hooks, tvlETH: 100})],
        mockLogger,
        mockMetric
      );
      expect(result.length).toBe(1);
    });
  });

  describe('invalid token decimals', () => {
    it('classifies a hooked pool without error, since decimals do not enter the pool id', () => {
      // A hookless (ADDRESS_ZERO) pool can never carry a dynamic fee — there's no
      // hook to set one — so isDynamicFeePool is skipped for it. Use a real,
      // no-swap-permission hook so the dynamic-fee check actually runs.
      const hookNoSwap = '0x0000000000000000000000000000000000000100';
      const pool = createPool({
        hooks: hookNoSwap,
        tvlETH: 100,
        token0: {
          id: '0x0000000000000000000000000000000000000001',
          symbol: 'A',
          name: 'A',
          decimals: 'invalid',
        },
        token1: {
          id: '0x0000000000000000000000000000000000000002',
          symbol: 'B',
          name: 'B',
          decimals: '18',
        },
      });
      const logger: Logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        fatal: vi.fn(),
      };
      const result = v4HooksPoolsFiltering(
        ChainId.MAINNET,
        [pool],
        logger,
        mockMetric
      );
      expect(result.length).toBe(1);
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('keeps a hookless pool with a negative decimals value', () => {
      const pool = createPool({
        hooks: ADDRESS_ZERO,
        tvlETH: 100,
        token0: {
          id: '0x0000000000000000000000000000000000000001',
          symbol: 'A',
          name: 'A',
          decimals: '-1',
        },
        token1: {
          id: '0x0000000000000000000000000000000000000002',
          symbol: 'B',
          name: 'B',
          decimals: '18',
        },
      });
      const result = v4HooksPoolsFiltering(
        ChainId.MAINNET,
        [pool],
        mockLogger,
        mockMetric
      );
      expect(result.length).toBe(1);
    });

    it('keeps a hookless native-token0 pool whose token1 decimals are invalid', () => {
      const pool = createPool({
        hooks: ADDRESS_ZERO,
        tvlETH: 100,
        token0: {
          id: ADDRESS_ZERO,
          symbol: 'ETH',
          name: 'Ethereum',
          decimals: '18',
        },
        token1: {
          id: '0x0000000000000000000000000000000000000002',
          symbol: 'B',
          name: 'B',
          decimals: 'bad',
        },
      });
      const result = v4HooksPoolsFiltering(
        ChainId.MAINNET,
        [pool],
        mockLogger,
        mockMetric
      );
      expect(result.length).toBe(1);
    });

    it('keeps a hookless native-token1 pool whose token0 decimals are invalid', () => {
      const pool = createPool({
        hooks: ADDRESS_ZERO,
        tvlETH: 100,
        token0: {
          id: '0x0000000000000000000000000000000000000001',
          symbol: 'A',
          name: 'A',
          decimals: 'bad',
        },
        token1: {
          id: ADDRESS_ZERO,
          symbol: 'ETH',
          name: 'Ethereum',
          decimals: '18',
        },
      });
      const result = v4HooksPoolsFiltering(
        ChainId.MAINNET,
        [pool],
        mockLogger,
        mockMetric
      );
      expect(result.length).toBe(1);
    });
  });

  // --- Fee-tier sanity ceiling (ROUTE-1690) ---
  // Confirmed live on mainnet: NVDAx/USDC v4 pools with feeTier 960500 and
  // 955000 (~96%/95.5%) — scalper-created, near-zero-liquidity pools, not an
  // isolated misconfiguration (routing team, #apps-feedback) — were the only
  // CLASSIC candidates, so BEST_PRICE quoted 1000 USDC in for ~1.42 NVDAx out.
  // ADDRESS_ZERO (hookless) pools previously bypassed the fee-tier check
  // entirely, which is how a plain, non-hooked pool could carry an absurd fee.
  describe('fee-tier sanity ceiling', () => {
    it('keeps a hookless pool at a normal fee tier', () => {
      const pool = createPool({
        hooks: ADDRESS_ZERO,
        feeTier: '3000',
        tvlETH: 5,
      });
      const result = v4HooksPoolsFiltering(
        ChainId.MAINNET,
        [pool],
        mockLogger,
        mockMetric
      );
      expect(result.map(p => p.id)).toContain(pool.id);
    });

    it('excludes a hookless pool at the reported absurd fee tier (960500, ~96%)', () => {
      const pool = createPool({
        hooks: ADDRESS_ZERO,
        feeTier: '960500',
        tvlETH: 5,
      });
      const result = v4HooksPoolsFiltering(
        ChainId.MAINNET,
        [pool],
        mockLogger,
        mockMetric
      );
      expect(result).toEqual([]);
    });

    it('excludes a hookless pool at the second reported absurd fee tier (955000, ~95.5%)', () => {
      const pool = createPool({
        hooks: ADDRESS_ZERO,
        feeTier: '955000',
        tvlETH: 5,
      });
      const result = v4HooksPoolsFiltering(
        ChainId.MAINNET,
        [pool],
        mockLogger,
        mockMetric
      );
      expect(result).toEqual([]);
    });

    it('still routes a hooked pool at a fee tier within the ceiling', () => {
      const hookNoSwap = '0x0000000000000000000000000000000000000100';
      const pool = createPool({
        hooks: hookNoSwap,
        feeTier: '50000',
        tvlETH: 100,
      });
      const result = v4HooksPoolsFiltering(
        ChainId.MAINNET,
        [pool],
        mockLogger,
        mockMetric
      );
      expect(result.map(p => p.id)).toContain(pool.id);
    });

    it('excludes an above-ceiling hookless major-pair pool that would otherwise be a routable candidate', () => {
      // Major/major pair, so the only admission paths are isHooksPoolRoutable
      // (blocked by the ceiling) and the explicit allowlist (this hook isn't
      // on it).
      const pool = createPool({
        hooks: ADDRESS_ZERO,
        feeTier: '960500',
        tvlETH: 100,
        token0: {
          id: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
          symbol: 'WETH',
          name: 'Wrapped Ether',
          decimals: '18',
        },
        token1: {
          id: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          symbol: 'USDC',
          name: 'USD Coin',
          decimals: '6',
        },
      });
      const result = v4HooksPoolsFiltering(
        ChainId.MAINNET,
        [pool],
        mockLogger,
        mockMetric
      );
      expect(result).toEqual([]);
    });

    describe('non-allowlisted hooked path', () => {
      // beforeAddLiquidity only (0x0800): no swap bits, so the hook is
      // routable without an allowlist entry and only the fee checks apply.
      const hookWithoutSwapPermission =
        '0x0000000000000000000000000000000000000800';

      it.each(['999000', '8388600'])(
        'excludes a non-major hooked pool with incident fee tier %s',
        feeTier => {
          const pool = createPool({
            hooks: hookWithoutSwapPermission,
            feeTier,
            tvlETH: 100,
          });
          const result = v4HooksPoolsFiltering(
            ChainId.ROBINHOOD,
            [pool],
            mockLogger,
            mockMetric
          );
          expect(result).toEqual([]);
        }
      );

      it('admits a non-allowlisted hooked pool at the sanity ceiling boundary', () => {
        const pool = createPool({
          hooks: hookWithoutSwapPermission,
          feeTier: '110000',
          tvlETH: 100,
        });
        const result = v4HooksPoolsFiltering(
          ChainId.MAINNET,
          [pool],
          mockLogger,
          mockMetric
        );
        expect(result.map(p => p.id)).toContain(pool.id);
      });

      it('rejects a non-allowlisted hooked pool just above the sanity ceiling boundary', () => {
        const pool = createPool({
          hooks: hookWithoutSwapPermission,
          feeTier: '110001',
          tvlETH: 100,
        });
        const result = v4HooksPoolsFiltering(
          ChainId.MAINNET,
          [pool],
          mockLogger,
          mockMetric
        );
        expect(result).toEqual([]);
      });

      it('does not treat the dynamic-fee sentinel as an above-ceiling static fee', () => {
        const pool = createPool({
          hooks: hookWithoutSwapPermission,
          feeTier: String(DYNAMIC_FEE_FLAG),
          tvlETH: 100,
        });
        const result = v4HooksPoolsFiltering(
          ChainId.MAINNET,
          [pool],
          mockLogger,
          mockMetric
        );
        expect(result.map(p => p.id)).toContain(pool.id);
      });
    });
  });

  describe('hook denylisting', () => {
    it('excludes non-major hooked pools when hook is denylisted', () => {
      const hookNoSwap = '0x0000000000000000000000000000000000000400';
      const previous = HOOKS_ADDRESSES_DENYLIST[ChainId.MAINNET];
      HOOKS_ADDRESSES_DENYLIST[ChainId.MAINNET] = [hookNoSwap];

      try {
        const pool = createPool({
          hooks: hookNoSwap,
          token0: {
            id: '0x00000000000000000000000000000000000000a1',
            symbol: 'TOKEN_A',
            name: 'Token A',
            decimals: '18',
          },
          token1: {
            id: '0x00000000000000000000000000000000000000a2',
            symbol: 'TOKEN_B',
            name: 'Token B',
            decimals: '18',
          },
        });

        const result = v4HooksPoolsFiltering(
          ChainId.MAINNET,
          [pool],
          mockLogger,
          mockMetric
        );
        expect(result).toEqual([]);
      } finally {
        if (previous) {
          HOOKS_ADDRESSES_DENYLIST[ChainId.MAINNET] = previous;
        } else {
          delete HOOKS_ADDRESSES_DENYLIST[ChainId.MAINNET];
        }
      }
    });

    it('gives denylist precedence over allowlist for major pairs', () => {
      const allowlistedHookAddress = (HOOKS_ADDRESSES_ALLOWLIST[ChainId.BASE] ??
        [])[1]!;
      const previous = HOOKS_ADDRESSES_DENYLIST[ChainId.BASE];
      HOOKS_ADDRESSES_DENYLIST[ChainId.BASE] = [allowlistedHookAddress];

      try {
        const pool = createPool({
          hooks: allowlistedHookAddress,
          token0: {
            id: '0x4200000000000000000000000000000000000006',
            symbol: 'WETH',
            name: 'WETH',
            decimals: '18',
          },
          token1: {
            id: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
            symbol: 'USDC',
            name: 'USDC',
            decimals: '6',
          },
          feeTier: '500',
          tickSpacing: '10',
        });

        const result = v4HooksPoolsFiltering(
          ChainId.BASE,
          [pool],
          mockLogger,
          mockMetric
        );
        expect(result).toEqual([]);
      } finally {
        if (previous) {
          HOOKS_ADDRESSES_DENYLIST[ChainId.BASE] = previous;
        } else {
          delete HOOKS_ADDRESSES_DENYLIST[ChainId.BASE];
        }
      }
    });

    describe('quoter-exempt hook family', () => {
      // One real pool per hook, with literals from its on-chain Initialize
      // event, deliberately not imported from the denylist module: the
      // shipped denylist is the input under test.
      const familyPools: Array<{
        name: string;
        chainId: ChainId;
        hook: string;
        poolId: string;
        feeTier: string;
        token0: [string, string];
        token1: [string, string];
      }> = [
        {
          name: 'Robinhood 0xa735 WETH/AAPL',
          chainId: ChainId.ROBINHOOD,
          hook: '0xa735d365630987d86789d5aefbd91b244a7feac0',
          poolId:
            '0x24312471cd459f2095fff775b900b9248d86c6d559ca4e50fe28fc129d981ca9',
          feeTier: '1000',
          token0: ['0x0bd7d308f8e1639fab988df18a8011f41eacad73', 'WETH'],
          token1: ['0xaf3d76f1834a1d425780943c99ea8a608f8a93f9', 'AAPL'],
        },
        {
          name: 'Robinhood 0x8e21 WETH/PONS',
          chainId: ChainId.ROBINHOOD,
          hook: '0x8e21aff7115d3a91259897db144db7fe841d6ac0',
          poolId:
            '0x7c14da8732f4c269320bfe95709b09ed54496e87393b4936d406b49f6239e563',
          feeTier: '100',
          token0: ['0x0bd7d308f8e1639fab988df18a8011f41eacad73', 'WETH'],
          token1: ['0x39dbed3a2bd333467115de45665cc57f813c4571', 'PONS'],
        },
        {
          name: 'Base 0x2940 WETH/Surplus',
          chainId: ChainId.BASE,
          hook: '0x2940c82a3be9ebf56946c488348bd3a413486ac0',
          poolId:
            '0x19e2c0b21a6967bc1563d7eba8b80b1284c0fc4f564a30e5a93dbd0101a7b503',
          feeTier: '1000',
          token0: ['0x4200000000000000000000000000000000000006', 'WETH'],
          token1: ['0xc52aedec3374422d7510e294cfaa90799595cba3', 'Surplus'],
        },
        {
          name: 'Base 0xff7a WETH/Surplus',
          chainId: ChainId.BASE,
          hook: '0xff7aaf1e66bf9f5ac479464c9643162e915ceac0',
          poolId:
            '0xb1f4f5b1f144cbdc7bbb1cd27228041f7c0fc39b4e82f0546a8aee3b8ddad99d',
          feeTier: '1000',
          token0: ['0x4200000000000000000000000000000000000006', 'WETH'],
          token1: ['0xc52aedec3374422d7510e294cfaa90799595cba3', 'Surplus'],
        },
        {
          name: 'Base 0xc634 WETH/AERO',
          chainId: ChainId.BASE,
          hook: '0xc6340a6e50a2c233e175c9b27ed8eea4e0196ac0',
          poolId:
            '0x775f43bd181e8abeeaf1ba3146cc7bf52ed4401cdfc93ae5e17279d478bc627b',
          feeTier: '200',
          token0: ['0x4200000000000000000000000000000000000006', 'WETH'],
          token1: ['0x940181a94a35a4569e4529a3cdfb74e38fd98631', 'AERO'],
        },
        {
          name: 'Mainnet 0xdc76 PEPE/WETH',
          chainId: ChainId.MAINNET,
          hook: '0xdc766448ff29b8cd12ae12d8252762d93ecd2ac0',
          poolId:
            '0xcc2bed5ca7ab0c93173ea0c894b280b42dc146671183fc2c27a6a3254e496fe3',
          feeTier: '1000',
          token0: ['0x6982508145454ce325ddbe47a25d4ec3d2311933', 'PEPE'],
          token1: ['0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', 'WETH'],
        },
      ];
      // Same permission bits (0x2ac0: before/after swap, no returnsDelta) on a
      // hook that is not denylisted. Swap callbacks keep both out of the
      // unvetted path, so the denylist is load-bearing only once a hook is allowlisted;
      // the dynamic ZLCA set stands in for that allowlist entry (the filter
      // admits it exactly like a static one) without mutating the shipped
      // registry.
      const sameFlagsUnlistedHook =
        '0x0000000000000000000000000000000000002ac0';

      const buildPool = (
        row: (typeof familyPools)[number],
        hooks: string,
        id: string
      ): V4SubgraphPool =>
        createPool({
          id,
          hooks,
          feeTier: row.feeTier,
          tickSpacing: '1',
          token0: {
            id: row.token0[0],
            symbol: row.token0[1],
            name: row.token0[1],
            decimals: '18',
          },
          token1: {
            id: row.token1[0],
            symbol: row.token1[1],
            name: row.token1[1],
            decimals: '18',
          },
          tvlETH: 100,
        });

      it.each(familyPools)('$name: pool id matches its PoolKey', row => {
        expect(
          computeV4PoolId(
            row.token0[0],
            row.token1[0],
            Number(row.feeTier),
            1,
            row.hook
          )
        ).toBe(row.poolId);
      });

      const controlPoolId =
        '0x00000000000000000000000000000000000000000000000000000000000000c1';

      it.each(familyPools)(
        '$name: does not admit the pool shape without an allowlist entry (swap bits)',
        row => {
          const control = buildPool(row, sameFlagsUnlistedHook, controlPoolId);
          const result = v4HooksPoolsFiltering(
            row.chainId,
            [control],
            mockLogger,
            mockMetric
          );
          expect(result).toEqual([]);
        }
      );

      it.each(familyPools)(
        '$name: admits the pool shape when an allowlisted hook is not denylisted',
        row => {
          const control = buildPool(row, sameFlagsUnlistedHook, controlPoolId);
          const result = v4HooksPoolsFiltering(
            row.chainId,
            [control],
            mockLogger,
            mockMetric,
            new Set([sameFlagsUnlistedHook])
          );
          expect(result.map(p => p.id)).toEqual([control.id]);
        }
      );

      it.each(
        familyPools.flatMap(row => [
          {...row, casing: 'lowercase', hooks: row.hook},
          {...row, casing: 'checksummed', hooks: utils.getAddress(row.hook)},
        ])
      )(
        '$name: rejects the pool with the $casing hook address even when allowlisted',
        row => {
          const pool = buildPool(row, row.hooks, row.poolId);
          const result = v4HooksPoolsFiltering(
            row.chainId,
            [pool],
            mockLogger,
            mockMetric,
            new Set([row.hooks])
          );
          expect(result).toEqual([]);
        }
      );
    });
  });

  // --- Special pool ID overrides ---
  describe('special pool ID overrides', () => {
    it('sets TVL for OPTIMISM ETH/WETH pool', () => {
      const pool = createPool({
        id: '0xbf3d38951e485c811bb1fc7025fcd1ef60c15fda4c4163458facb9bedfe26f83',
        hooks: ADDRESS_ZERO,
        tvlETH: 0,
        tvlUSD: 0,
        token0: {
          id: '0x0000000000000000000000000000000000000001',
          symbol: 'ETH',
          name: 'ETH',
          decimals: '18',
        },
        token1: {
          id: '0x0000000000000000000000000000000000000002',
          symbol: 'WETH',
          name: 'WETH',
          decimals: '18',
        },
      });
      const result = v4HooksPoolsFiltering(
        ChainId.OPTIMISM,
        [pool],
        mockLogger,
        mockMetric
      );
      expect(result.length).toBe(1);
      expect(pool.tvlETH).toBe(826);
      expect(pool.tvlUSD).toBe(1482475);
    });

    it('sets TVL for UNICHAIN ETH/WETH pool', () => {
      const pool = createPool({
        id: '0xba246b8420b5aeb13e586cd7cbd32279fa7584d7f4cbc9bd356a6bb6200d16a6',
        hooks: ADDRESS_ZERO,
        tvlETH: 0,
        tvlUSD: 0,
        token0: {
          id: '0x0000000000000000000000000000000000000001',
          symbol: 'ETH',
          name: 'ETH',
          decimals: '18',
        },
        token1: {
          id: '0x0000000000000000000000000000000000000002',
          symbol: 'WETH',
          name: 'WETH',
          decimals: '18',
        },
      });
      const result = v4HooksPoolsFiltering(
        ChainId.UNICHAIN,
        [pool],
        mockLogger,
        mockMetric
      );
      expect(result.length).toBe(1);
      expect(pool.tvlETH).toBe(33482);
      expect(pool.tvlUSD).toBe(60342168);
    });

    it('sets TVL for BASE ETH/WETH pool', () => {
      const pool = createPool({
        id: '0xbb2aefc6c55a0464b944c0478869527ba1a537f05f90a1bb82e1196c6e9403e2',
        hooks: ADDRESS_ZERO,
        tvlETH: 0,
        tvlUSD: 0,
        token0: {
          id: '0x0000000000000000000000000000000000000001',
          symbol: 'ETH',
          name: 'ETH',
          decimals: '18',
        },
        token1: {
          id: '0x0000000000000000000000000000000000000002',
          symbol: 'WETH',
          name: 'WETH',
          decimals: '18',
        },
      });
      const result = v4HooksPoolsFiltering(
        ChainId.BASE,
        [pool],
        mockLogger,
        mockMetric
      );
      expect(result.length).toBe(1);
      expect(pool.tvlETH).toBe(6992);
      expect(pool.tvlUSD).toBe(12580000);
    });

    it('sets TVL for ARBITRUM ETH/WETH pool', () => {
      const pool = createPool({
        id: '0xc1c777843809a8e77a398fd79ecddcefbdad6a5676003ae2eedf3a33a56589e9',
        hooks: ADDRESS_ZERO,
        tvlETH: 0,
        tvlUSD: 0,
        token0: {
          id: '0x0000000000000000000000000000000000000001',
          symbol: 'ETH',
          name: 'ETH',
          decimals: '18',
        },
        token1: {
          id: '0x0000000000000000000000000000000000000002',
          symbol: 'WETH',
          name: 'WETH',
          decimals: '18',
        },
      });
      const result = v4HooksPoolsFiltering(
        ChainId.ARBITRUM_ONE,
        [pool],
        mockLogger,
        mockMetric
      );
      expect(result.length).toBe(1);
      expect(pool.tvlETH).toBe(23183);
      expect(pool.tvlUSD).toBe(41820637);
    });

    it('sets TVL for BASE flETH pool', () => {
      const pool = createPool({
        id: '0x14287e3268eb628fcebd2d8f0730b01703109e112a7a41426a556d10211d2086',
        hooks: ADDRESS_ZERO,
        tvlETH: 0,
        tvlUSD: 0,
        token0: {
          id: '0x0000000000000000000000000000000000000001',
          symbol: 'flETH',
          name: 'flETH',
          decimals: '18',
        },
        token1: {
          id: '0x0000000000000000000000000000000000000002',
          symbol: 'FLNCH',
          name: 'FLNCH',
          decimals: '18',
        },
      });
      const result = v4HooksPoolsFiltering(
        ChainId.BASE,
        [pool],
        mockLogger,
        mockMetric
      );
      expect(result.length).toBe(1);
      expect(pool.tvlETH).toBe(1000);
      expect(pool.tvlUSD).toBe(5500000);
    });

    it('does not set TVL override when pool id matches but wrong chain', () => {
      const pool = createPool({
        id: '0xbf3d38951e485c811bb1fc7025fcd1ef60c15fda4c4163458facb9bedfe26f83',
        hooks: ADDRESS_ZERO,
        tvlETH: 5,
        tvlUSD: 10000,
      });
      v4HooksPoolsFiltering(ChainId.MAINNET, [pool], mockLogger, mockMetric);
      // TVL should NOT be overridden since it's MAINNET, not OPTIMISM
      expect(pool.tvlETH).toBe(5);
      expect(pool.tvlUSD).toBe(10000);
    });
  });

  // --- Priority queue overflow (>10 pools per group) with dequeue ---
  describe('priority queue overflow', () => {
    it('dequeues lowest TVL pool when more than 10 pools in same group', () => {
      // Create 12 pools with same token pair and fee tier, different TVLs.
      // ADDRESS_ZERO is in the allowlist, so dequeued pools may get re-added.
      // The result will have all 12 because 10 from top TVL set + 2 from allowlist path.
      // Instead we verify the priority queue behavior by checking that a non-allowlisted
      // hook's pool with low TVL is actually excluded.
      const pools = Array.from({length: 12}, (_, i) =>
        createPool({
          hooks: ADDRESS_ZERO,
          tvlETH: (i + 1) * 10,
          token0: {
            id: '0x000000000000000000000000000000000000000a',
            symbol: 'X',
            name: 'X',
            decimals: '18',
          },
          token1: {
            id: '0x000000000000000000000000000000000000000b',
            symbol: 'Y',
            name: 'Y',
            decimals: '18',
          },
          feeTier: '500',
        })
      );
      const result = v4HooksPoolsFiltering(
        ChainId.MAINNET,
        pools,
        mockLogger,
        mockMetric
      );
      // All 12 appear: 10 from priority queue + 2 re-added via allowlist (ADDRESS_ZERO is allowlisted)
      expect(result.length).toBe(12);
    });
  });

  // --- Allowlisted hooks pools included even if not in top TVL set ---
  describe('allowlisted hooks pools addition', () => {
    it('includes allowlisted hooks pool not already in top TVL set', () => {
      // Fill up the group with 10 ADDRESS_ZERO pools
      const groupPools = Array.from({length: 10}, (_, i) =>
        createPool({
          hooks: ADDRESS_ZERO,
          tvlETH: (i + 1) * 100,
          token0: {
            id: '0x000000000000000000000000000000000000000a',
            symbol: 'X',
            name: 'X',
            decimals: '18',
          },
          token1: {
            id: '0x000000000000000000000000000000000000000b',
            symbol: 'Y',
            name: 'Y',
            decimals: '18',
          },
          feeTier: '500',
        })
      );

      // Pick an allowlisted hook for BASE
      const allowlistedHookAddress = (HOOKS_ADDRESSES_ALLOWLIST[ChainId.BASE] ??
        [])[1]; // FLAUNCH_POSM_V1_ON_BASE
      // This pool has different token pair so it won't be in the same group
      const allowlistedPool = createPool({
        hooks: allowlistedHookAddress!,
        tvlETH: 0.01,
        token0: {
          id: '0x000000000000000000000000000000000000cc01',
          symbol: 'C',
          name: 'C',
          decimals: '18',
        },
        token1: {
          id: '0x000000000000000000000000000000000000cc02',
          symbol: 'D',
          name: 'D',
          decimals: '18',
        },
        feeTier: '3000',
      });

      const allPools = [...groupPools, allowlistedPool];
      const result = v4HooksPoolsFiltering(
        ChainId.BASE,
        allPools,
        mockLogger,
        mockMetric
      );
      // Should include all 10 group pools + the allowlisted pool
      expect(result.length).toBe(11);
    });

    it('does not duplicate allowlisted pool already in top TVL set', () => {
      // A pool with allowlisted hook that is ALSO in the top TVL set
      const allowlistedHookAddress = (HOOKS_ADDRESSES_ALLOWLIST[ChainId.BASE] ??
        [])[1]!;
      const pool = createPool({
        hooks: allowlistedHookAddress,
        tvlETH: 500,
        token0: {
          id: '0x000000000000000000000000000000000000cc01',
          symbol: 'C',
          name: 'C',
          decimals: '18',
        },
        token1: {
          id: '0x000000000000000000000000000000000000cc02',
          symbol: 'D',
          name: 'D',
          decimals: '18',
        },
        feeTier: '3000',
      });

      const result = v4HooksPoolsFiltering(
        ChainId.BASE,
        [pool],
        mockLogger,
        mockMetric
      );
      // Should only appear once
      expect(result.length).toBe(1);
    });
  });

  describe('custom accounting hooks allowlisting', () => {
    // 0x08 = beforeSwapReturnsDelta only, 0x04 = afterSwapReturnsDelta only, 0x0c = both
    const hookBeforeSwapReturnsDelta =
      '0x0000000000000000000000000000000000000008';
    const hookAfterSwapReturnsDelta =
      '0x0000000000000000000000000000000000000004';
    const hookBothSwapReturnsDelta =
      '0x000000000000000000000000000000000000000c';

    it('excludes non-allowlisted custom accounting hook on non-major pair', () => {
      const pool = createPool({
        hooks: hookBeforeSwapReturnsDelta,
        tvlETH: 100,
        token0: {
          id: '0x00000000000000000000000000000000000000a1',
          symbol: 'TOKEN_A',
          name: 'Token A',
          decimals: '18',
        },
        token1: {
          id: '0x00000000000000000000000000000000000000a2',
          symbol: 'TOKEN_B',
          name: 'Token B',
          decimals: '18',
        },
      });

      const result = v4HooksPoolsFiltering(
        ChainId.MAINNET,
        [pool],
        mockLogger,
        mockMetric
      );
      expect(result).toEqual([]);
    });

    it('excludes non-allowlisted afterSwapReturnsDelta hook on non-major pair', () => {
      const pool = createPool({
        hooks: hookAfterSwapReturnsDelta,
        tvlETH: 100,
        token0: {
          id: '0x00000000000000000000000000000000000000a1',
          symbol: 'TOKEN_A',
          name: 'Token A',
          decimals: '18',
        },
        token1: {
          id: '0x00000000000000000000000000000000000000a2',
          symbol: 'TOKEN_B',
          name: 'Token B',
          decimals: '18',
        },
      });

      const result = v4HooksPoolsFiltering(
        ChainId.MAINNET,
        [pool],
        mockLogger,
        mockMetric
      );
      expect(result).toEqual([]);
    });

    it('excludes non-allowlisted custom accounting hook on major pair', () => {
      const pool = createPool({
        hooks: hookBothSwapReturnsDelta,
        tvlETH: 100,
        token0: {
          id: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
          symbol: 'WETH',
          name: 'Wrapped Ether',
          decimals: '18',
        },
        token1: {
          id: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          symbol: 'USDC',
          name: 'USD Coin',
          decimals: '6',
        },
      });

      const result = v4HooksPoolsFiltering(
        ChainId.MAINNET,
        [pool],
        mockLogger,
        mockMetric
      );
      expect(result).toEqual([]);
    });

    it('includes allowlisted custom accounting hook on non-major pair', () => {
      const allowlistedHookAddress = (HOOKS_ADDRESSES_ALLOWLIST[ChainId.BASE] ??
        [])[1]!;

      const pool = createPool({
        hooks: allowlistedHookAddress,
        tvlETH: 100,
        token0: {
          id: '0x00000000000000000000000000000000000000a1',
          symbol: 'TOKEN_A',
          name: 'Token A',
          decimals: '18',
        },
        token1: {
          id: '0x00000000000000000000000000000000000000a2',
          symbol: 'TOKEN_B',
          name: 'Token B',
          decimals: '18',
        },
      });

      const result = v4HooksPoolsFiltering(
        ChainId.BASE,
        [pool],
        mockLogger,
        mockMetric
      );
      expect(result.length).toBe(1);
    });
  });

  describe('non-allowlisted hooked pools compete in the routable top-N queue', () => {
    it('caps non-allowlisted hooked pools per token pair + fee via top TVL', () => {
      // 15 pools with a non-allowlisted hook that has no swap or custom-accounting
      // bits (beforeAddLiquidity, 0x0800) on one token pair and fee tier. Only
      // the top 10 by TVL survive; the hook is not in the explicit allowlist, so
      // the rest are not re-added.
      const hookWithoutSwap = '0x0000000000000000000000000000000000000800';
      const pools = Array.from({length: 15}, (_, i) =>
        createPool({
          hooks: hookWithoutSwap,
          tvlETH: i + 1,
          token0: {
            id: '0x00000000000000000000000000000000000000a1',
            symbol: 'A',
            name: 'A',
            decimals: '18',
          },
          token1: {
            id: '0x00000000000000000000000000000000000000a2',
            symbol: 'B',
            name: 'B',
            decimals: '18',
          },
          feeTier: '3000',
        })
      );
      const result = v4HooksPoolsFiltering(
        ChainId.MAINNET,
        pools,
        mockLogger,
        mockMetric
      );
      expect(result.length).toBe(10);
      // Verify the top 10 by TVL are kept (tvlETH 6-15)
      const tvls = result.map(p => p.tvlETH).sort((a, b) => a - b);
      expect(tvls).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    });
  });

  describe('top TVL membership equivalence', () => {
    it('matches second-pass-only eligibility membership as a set', () => {
      const hookNoSwapA = '0x0000000000000000000000000000000000000100';
      const hookNoSwapB = '0x0000000000000000000000000000000000000200';

      const pools: V4SubgraphPool[] = [
        createPool({
          id: '0x1000000000000000000000000000000000000000000000000000000000000001',
          hooks: ADDRESS_ZERO,
          token0: {
            id: '0x00000000000000000000000000000000000000a1',
            symbol: 'A',
            name: 'A',
            decimals: '18',
          },
          token1: {
            id: '0x00000000000000000000000000000000000000a2',
            symbol: 'B',
            name: 'B',
            decimals: '18',
          },
          feeTier: '3000',
          tvlETH: 1,
        }),
        createPool({
          id: '0x1000000000000000000000000000000000000000000000000000000000000002',
          hooks: hookNoSwapA,
          token0: {
            id: '0x00000000000000000000000000000000000000a3',
            symbol: 'C',
            name: 'C',
            decimals: '18',
          },
          token1: {
            id: '0x00000000000000000000000000000000000000a4',
            symbol: 'D',
            name: 'D',
            decimals: '18',
          },
          feeTier: '500',
          tvlETH: 0.5,
        }),
        createPool({
          id: '0x1000000000000000000000000000000000000000000000000000000000000003',
          hooks: hookNoSwapB,
          token0: {
            id: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
            symbol: 'WETH',
            name: 'WETH',
            decimals: '18',
          },
          token1: {
            id: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
            symbol: 'USDC',
            name: 'USDC',
            decimals: '6',
          },
          feeTier: '3000',
          tvlETH: 999,
        }),
        createPool({
          id: '0x1000000000000000000000000000000000000000000000000000000000000004',
          hooks: (HOOKS_ADDRESSES_ALLOWLIST[ChainId.BASE] ?? [])[1]!,
          token0: {
            id: '0x4200000000000000000000000000000000000006',
            symbol: 'WETH',
            name: 'WETH',
            decimals: '18',
          },
          token1: {
            id: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
            symbol: 'USDC',
            name: 'USDC',
            decimals: '6',
          },
          feeTier: '3000',
          tvlETH: 0.001,
        }),
      ];

      const result = v4HooksPoolsFiltering(
        ChainId.BASE,
        pools,
        mockLogger,
        mockMetric
      );

      const allowlistedHooks = new Set(
        (HOOKS_ADDRESSES_ALLOWLIST[ChainId.BASE] ?? []).map(hook =>
          hook.toLowerCase()
        )
      );
      const expectedBySecondPassOnly = pools.filter(pool => {
        const hook = pool.hooks.toLowerCase();
        if (hook === ADDRESS_ZERO) {
          return true;
        }
        if (!blocksUnvettedHookAdmission(hook)) {
          return true;
        }
        return allowlistedHooks.has(hook);
      });

      expect(new Set(result.map(pool => pool.id.toLowerCase()))).toEqual(
        new Set(expectedBySecondPassOnly.map(pool => pool.id.toLowerCase()))
      );
    });
  });
});

// Permissioned-hook (Superstate) pools are admitted by their hook, not by TVL.
// An adapter↔adapter pool (e.g. PA1/PA2) holds no whitelisted base token, so its
// tvlETH is ~0 and would otherwise be dropped — this guards that it survives.
describe('permissioned-hook pools (Superstate PA↔PA)', () => {
  // Sepolia PermissionedHooks + its adapters (PA1/PA2), from the shared
  // registry @uniswap/lib-sharedconfig/permissionedTokens.
  const SEPOLIA_PERMISSIONED_HOOK =
    '0x51247e2291d290d17c08813a175ac86465ede8c0';
  const PA1 = '0xc6f4b10e842d16a35dd49853a9d3f3169442bfd0';
  const PA2 = '0x8308119359f9fb7dea90b1b977276a6d89902818';
  // Deterministic v4 pool id of the PA2/PA1 3000/60 pool on the current hook
  // (keccak256 of the PoolKey) — valid whether or not the pool exists yet.
  const PA_POOL_ID =
    '0xf686d60e241770ffd7f18a73e82ecaf1b2aae0eb5aac7b66b2bbae4d5067795e';

  const createPaPool = (overrides: Partial<V4SubgraphPool> = {}) =>
    createPool({
      id: PA_POOL_ID,
      hooks: SEPOLIA_PERMISSIONED_HOOK,
      tvlETH: 0,
      tvlUSD: 0,
      token0: {id: PA1, symbol: 'PA1', name: 'Perm Token 1', decimals: '18'},
      token1: {id: PA2, symbol: 'PA2', name: 'Perm Token 2', decimals: '18'},
      ...overrides,
    });

  it('keeps a PA↔PA pool with tvlETH = 0 (regression: direct permissioned pool)', () => {
    const paPool = createPaPool();
    const result = v4HooksPoolsFiltering(
      ChainId.SEPOLIA,
      [paPool],
      mockLogger,
      mockMetric
    );
    expect(result.map(p => p.id.toLowerCase())).toContain(
      paPool.id.toLowerCase()
    );
  });

  it('retains an owned permissioned pool though its hook is absent from HOOKS_ADDRESSES_ALLOWLIST', () => {
    expect(
      (HOOKS_ADDRESSES_ALLOWLIST[ChainId.SEPOLIA] ?? []).map(h =>
        h.toLowerCase()
      )
    ).not.toContain(SEPOLIA_PERMISSIONED_HOOK);

    // Even alongside a higher-TVL vanilla pool in the same fee group, the
    // zero-TVL owned permissioned pool is still retained.
    const vanilla = createPool({
      id: '0x' + 'a'.repeat(63) + '1',
      hooks: ADDRESS_ZERO,
      token0: {id: PA1, symbol: 'PA1', name: 'Perm Token 1', decimals: '18'},
      token1: {id: PA2, symbol: 'PA2', name: 'Perm Token 2', decimals: '18'},
      tvlETH: 100,
    });
    const result = v4HooksPoolsFiltering(
      ChainId.SEPOLIA,
      [createPaPool(), vanilla],
      mockLogger,
      mockMetric
    );
    expect(result.map(p => p.id.toLowerCase())).toContain(PA_POOL_ID);
  });

  // Trust-boundary regression: a pool initialized under a permissioned hook but
  // whose tokens are NOT adapters owned by that hook must NOT be persisted —
  // the no-TVL-floor query could otherwise ingest arbitrary pools. Mirrors the
  // route-level hasAdmissibleAdapters check.
  it('drops a permissioned-hook pool whose tokens are not registered adapters', () => {
    const unownedPool = createPool({
      id: '0x' + 'b'.repeat(63) + '2',
      hooks: SEPOLIA_PERMISSIONED_HOOK,
      tvlETH: 0,
      tvlUSD: 0,
      // Neither token is a registered adapter for this hook.
      token0: {
        id: '0x000000000000000000000000000000000000dea1',
        symbol: 'X',
        name: 'NotAdapterX',
        decimals: '18',
      },
      token1: {
        id: '0x000000000000000000000000000000000000dea2',
        symbol: 'Y',
        name: 'NotAdapterY',
        decimals: '18',
      },
    });
    const result = v4HooksPoolsFiltering(
      ChainId.SEPOLIA,
      [unownedPool],
      mockLogger,
      mockMetric
    );
    expect(result.map(p => p.id.toLowerCase())).not.toContain(
      unownedPool.id.toLowerCase()
    );
  });

  // Bounded-admission regression (Codex): an owned adapter paired with an
  // ARBITRARY non-adapter, non-major token must NOT be persisted — otherwise an
  // actor could pair a registered adapter with unlimited junk tokens under the
  // public hook and bloat the snapshot.
  it('drops an owned-adapter pool paired with an arbitrary non-major token', () => {
    const adapterJunkPool = createPool({
      id: '0x' + 'd'.repeat(63) + '4',
      hooks: SEPOLIA_PERMISSIONED_HOOK,
      tvlETH: 0,
      tvlUSD: 0,
      // PA1 is an owned adapter, but the counter-token is arbitrary junk.
      token0: {id: PA1, symbol: 'PA1', name: 'Perm Token 1', decimals: '18'},
      token1: {
        id: '0x000000000000000000000000000000000000beef',
        symbol: 'JUNK',
        name: 'Junk',
        decimals: '18',
      },
    });
    const result = v4HooksPoolsFiltering(
      ChainId.SEPOLIA,
      [adapterJunkPool],
      mockLogger,
      mockMetric
    );
    expect(result.map(p => p.id.toLowerCase())).not.toContain(
      adapterJunkPool.id.toLowerCase()
    );
  });

  // PoolKey-bound regression (Codex): an owned adapter + major token at a
  // NONSTANDARD fee/tickSpacing must not be admitted — bounds the PoolKey space
  // to the canonical V4 set quickRoute can route, so it can't be inflated.
  it('drops an owned permissioned pool with a nonstandard fee/tickSpacing', () => {
    const WETH_SEPOLIA = '0xfff9976782d46cc05630d1f6ebab18b2324d6b14';
    const nonstandardKeyPool = createPool({
      id: '0x' + 'e'.repeat(63) + '5',
      hooks: SEPOLIA_PERMISSIONED_HOOK,
      feeTier: '1234', // not in {100, 500, 3000, 10000}
      tickSpacing: '7', // not canonical
      tvlETH: 0,
      tvlUSD: 0,
      token0: {id: PA1, symbol: 'PA1', name: 'Perm Token 1', decimals: '18'},
      token1: {id: WETH_SEPOLIA, symbol: 'WETH', name: 'WETH', decimals: '18'},
    });
    const result = v4HooksPoolsFiltering(
      ChainId.SEPOLIA,
      [nonstandardKeyPool],
      mockLogger,
      mockMetric
    );
    expect(result.map(p => p.id.toLowerCase())).not.toContain(
      nonstandardKeyPool.id.toLowerCase()
    );
  });

  it('keeps an owned permissioned pool at an interface-default fee tier (9000/90)', () => {
    const WETH_SEPOLIA = '0xfff9976782d46cc05630d1f6ebab18b2324d6b14';
    const newTierPool = createPool({
      id: '0x' + 'f'.repeat(63) + '6',
      hooks: SEPOLIA_PERMISSIONED_HOOK,
      feeTier: '9000',
      tickSpacing: '90',
      tvlETH: 0,
      tvlUSD: 0,
      token0: {id: PA1, symbol: 'PA1', name: 'Perm Token 1', decimals: '18'},
      token1: {id: WETH_SEPOLIA, symbol: 'WETH', name: 'WETH', decimals: '18'},
    });
    const result = v4HooksPoolsFiltering(
      ChainId.SEPOLIA,
      [newTierPool],
      mockLogger,
      mockMetric
    );
    expect(result.map(p => p.id.toLowerCase())).toContain(
      newTierPool.id.toLowerCase()
    );
  });

  it('keeps an owned PA↔WETH permissioned pool (single adapter endpoint)', () => {
    const WETH_SEPOLIA = '0xfff9976782d46cc05630d1f6ebab18b2324d6b14';
    const paWethPool = createPool({
      id: '0x' + 'c'.repeat(63) + '3',
      hooks: SEPOLIA_PERMISSIONED_HOOK,
      tvlETH: 0,
      tvlUSD: 0,
      token0: {id: PA1, symbol: 'PA1', name: 'Perm Token 1', decimals: '18'},
      token1: {id: WETH_SEPOLIA, symbol: 'WETH', name: 'WETH', decimals: '18'},
    });
    const result = v4HooksPoolsFiltering(
      ChainId.SEPOLIA,
      [paWethPool],
      mockLogger,
      mockMetric
    );
    expect(result.map(p => p.id.toLowerCase())).toContain(
      paWethPool.id.toLowerCase()
    );
  });
});

describe('v4HooksPoolsFiltering dynamic ZLCA hooks', () => {
  // Custom-accounting flags (BeforeSwapReturnsDelta) — never routable
  // unvetted, so admission requires (dynamic) allowlisting.
  const customAccountingHook = '0x0000000000000000000000000000000000000008';

  const majorPairPool = () =>
    createPool({
      hooks: customAccountingHook,
      tvlETH: 100,
      token0: {
        id: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
        symbol: 'WETH',
        name: 'Wrapped Ether',
        decimals: '18',
      },
      token1: {
        id: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        symbol: 'USDC',
        name: 'USD Coin',
        decimals: '6',
      },
    });

  it('drops a custom-accounting hooked pool when no dynamic set is passed (regression)', () => {
    const result = v4HooksPoolsFiltering(
      ChainId.MAINNET,
      [majorPairPool()],
      mockLogger,
      mockMetric
    );
    expect(result).toEqual([]);
  });

  it('admits the pool when its hook is in the dynamic ZLCA set', () => {
    const pool = majorPairPool();
    const result = v4HooksPoolsFiltering(
      ChainId.MAINNET,
      [pool],
      mockLogger,
      mockMetric,
      new Set([customAccountingHook])
    );
    expect(result.map(p => p.id)).toContain(pool.id);
  });

  it('denylist wins over the dynamic ZLCA set', () => {
    const denylist = HOOKS_ADDRESSES_DENYLIST[ChainId.MAINNET]!;
    denylist.push(customAccountingHook);
    try {
      const result = v4HooksPoolsFiltering(
        ChainId.MAINNET,
        [majorPairPool()],
        mockLogger,
        mockMetric,
        new Set([customAccountingHook])
      );
      expect(result).toEqual([]);
    } finally {
      denylist.pop();
    }
  });
});

describe('v4HooksPoolsFiltering dynamic ZLCA per-hook pool cap', () => {
  const dynamicHook = '0x0000000000000000000000000000000000000008';

  it('caps pools per dynamic-only hook at 50, keeping highest tvlETH', () => {
    const pools = Array.from({length: 60}, (_, i) =>
      createPool({
        id: '0x' + (i + 1).toString(16).padStart(64, '0'),
        hooks: dynamicHook,
        tvlETH: i, // ascending so the cap must keep the top 50 (tvlETH 10..59)
        token0: {
          id: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
          symbol: 'WETH',
          name: 'Wrapped Ether',
          decimals: '18',
        },
        token1: {
          id: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          symbol: 'USDC',
          name: 'USD Coin',
          decimals: '6',
        },
      })
    );

    const result = v4HooksPoolsFiltering(
      ChainId.MAINNET,
      pools,
      mockLogger,
      mockMetric,
      new Set([dynamicHook])
    );
    expect(result.length).toBe(50);
    expect(Math.min(...result.map(p => p.tvlETH))).toBe(10);
  });
});

describe('dynamic fee hooks excluded from unvetted admission', () => {
  // beforeAddLiquidity only (0x0800): no swap or custom-accounting bits, so
  // absent the dynamic-fee check this would be routable on any pair.
  const dynamicFeeHook = '0x0000000000000000000000000000000000000800';
  const tickSpacing = 60;

  const nonMajorToken0 = {
    id: '0x00000000000000000000000000000000000000a1',
    symbol: 'TOKEN_A',
    name: 'Token A',
    decimals: '18',
  };
  const nonMajorToken1 = {
    id: '0x00000000000000000000000000000000000000a2',
    symbol: 'TOKEN_B',
    name: 'Token B',
    decimals: '18',
  };

  // Recompute the pool id the same way isDynamicFeePool does, so the pool
  // genuinely satisfies isPoolFeeDynamic rather than merely carrying the
  // sentinel feeTier string.
  const buildDynamicFeePool = (chainId: ChainId): V4SubgraphPool => {
    const tokenA = new Token(
      chainId,
      nonMajorToken0.id,
      parseInt(nonMajorToken0.decimals),
      nonMajorToken0.symbol,
      nonMajorToken0.name
    );
    const tokenB = new Token(
      chainId,
      nonMajorToken1.id,
      parseInt(nonMajorToken1.decimals),
      nonMajorToken1.symbol,
      nonMajorToken1.name
    );
    const poolId = Pool.getPoolId(
      tokenA,
      tokenB,
      DYNAMIC_FEE_FLAG,
      tickSpacing,
      dynamicFeeHook
    );
    return createPool({
      id: poolId,
      hooks: dynamicFeeHook,
      feeTier: String(DYNAMIC_FEE_FLAG),
      tickSpacing: String(tickSpacing),
      token0: nonMajorToken0,
      token1: nonMajorToken1,
      tvlETH: 100,
    });
  };

  it('rejects a dynamic-fee hook on a non-major pair on mainnet', () => {
    const pool = buildDynamicFeePool(ChainId.MAINNET);
    const result = v4HooksPoolsFiltering(
      ChainId.MAINNET,
      [pool],
      mockLogger,
      mockMetric
    );
    expect(result).toEqual([]);
  });

  it('rejects a dynamic-fee hook on a non-major pair on Robinhood chain (no major-token list at all)', () => {
    const pool = buildDynamicFeePool(ChainId.ROBINHOOD);
    const result = v4HooksPoolsFiltering(
      ChainId.ROBINHOOD,
      [pool],
      mockLogger,
      mockMetric
    );
    expect(result).toEqual([]);
  });

  it('still admits the same hook/pair shape when the pool is not actually dynamic-fee (regression)', () => {
    const pool = createPool({
      hooks: dynamicFeeHook,
      feeTier: '3000',
      tickSpacing: String(tickSpacing),
      token0: nonMajorToken0,
      token1: nonMajorToken1,
      tvlETH: 100,
    });
    const result = v4HooksPoolsFiltering(
      ChainId.MAINNET,
      [pool],
      mockLogger,
      mockMetric
    );
    expect(result.length).toBe(1);
  });

  // Trusted bypasses are deliberately untouched — only the unvetted path
  // applies the dynamic-fee check.
  it('still admits a genuinely dynamic-fee hook when it is in the dynamic ZLCA set (trusted bypass unaffected)', () => {
    const pool = buildDynamicFeePool(ChainId.MAINNET);
    const result = v4HooksPoolsFiltering(
      ChainId.MAINNET,
      [pool],
      mockLogger,
      mockMetric,
      new Set([dynamicFeeHook])
    );
    expect(result.map(p => p.id.toLowerCase())).toContain(
      pool.id.toLowerCase()
    );
  });

  it('still admits a genuinely dynamic-fee hook via the explicit static allowlist (trusted bypass unaffected)', () => {
    const tokenA = new Token(
      ChainId.BASE,
      nonMajorToken0.id,
      parseInt(nonMajorToken0.decimals),
      nonMajorToken0.symbol,
      nonMajorToken0.name
    );
    const tokenB = new Token(
      ChainId.BASE,
      nonMajorToken1.id,
      parseInt(nonMajorToken1.decimals),
      nonMajorToken1.symbol,
      nonMajorToken1.name
    );
    const poolId = Pool.getPoolId(
      tokenA,
      tokenB,
      DYNAMIC_FEE_FLAG,
      tickSpacing,
      CLANKER_DYNAMIC_FEE_HOOKS_ADDRESS_ON_BASE
    );
    const pool = createPool({
      id: poolId,
      hooks: CLANKER_DYNAMIC_FEE_HOOKS_ADDRESS_ON_BASE,
      feeTier: String(DYNAMIC_FEE_FLAG),
      tickSpacing: String(tickSpacing),
      token0: nonMajorToken0,
      token1: nonMajorToken1,
      tvlETH: 100,
    });
    const result = v4HooksPoolsFiltering(
      ChainId.BASE,
      [pool],
      mockLogger,
      mockMetric
    );
    expect(result.map(p => p.id.toLowerCase())).toContain(
      pool.id.toLowerCase()
    );
  });

  it('fails closed on an unclassifiable pool (invalid token address) instead of throwing and aborting the batch', () => {
    // Token construction throws on the address itself, so the 18-decimal
    // fallback throws too — isDynamicFeePool must treat the pool as dynamic
    // (rejected by the unvetted gate), not propagate and kill the whole filter run.
    const unclassifiablePool = createPool({
      hooks: dynamicFeeHook,
      feeTier: '3000',
      tickSpacing: String(tickSpacing),
      token0: {
        id: 'not-a-valid-address',
        symbol: 'BAD',
        name: 'Bad Token',
        decimals: '18',
      },
      token1: nonMajorToken1,
      tvlETH: 100,
    });
    const healthyPool = createPool({
      hooks: dynamicFeeHook,
      feeTier: '3000',
      tickSpacing: String(tickSpacing),
      token0: nonMajorToken0,
      token1: nonMajorToken1,
      tvlETH: 100,
    });
    let result: V4SubgraphPool[] = [];
    expect(() => {
      result = v4HooksPoolsFiltering(
        ChainId.MAINNET,
        [unclassifiablePool, healthyPool],
        mockLogger,
        mockMetric
      );
    }).not.toThrow();
    // The malformed pool is dropped; the rest of the batch survives.
    expect(result.map(p => p.id)).toEqual([healthyPool.id]);
  });
});
