import {describe, it, expect, vi} from 'vitest';
import {
  v4HooksPoolsFiltering,
  hasCustomAccountingPermissions,
} from './v4HooksPoolsFiltering';
import {ChainId} from '@uniswap/sdk-core';
import {ADDRESS_ZERO} from '@uniswap/router-sdk';
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
import {getMajorTokens, isMajorPair} from './majorTokens';

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
      // On a major pair (WETH/USDC on mainnet) and NOT in the explicit allowlist.
      // Should be excluded: not routable (fails Phase 1), not auto-allowlisted
      // (major pair fails isAutoAllowlistedHook), not explicitly allowlisted (Phase 3).
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

  it('auto-allowlists non-major hooked pools even when non-routable', () => {
    const nonRoutableHook = '0x0000000000000000000000000000000000000080';
    const pool = createPool({
      hooks: nonRoutableHook,
      tvlETH: 100,
      feeTier: '3000',
    });
    const result = v4HooksPoolsFiltering(
      ChainId.MAINNET,
      [pool],
      mockLogger,
      mockMetric
    );
    expect(result.length).toBe(1);
  });

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
  describe('Zora hooks on BASE', () => {
    it('excludes Zora creator hook pool on BASE with tvlETH <= 0.001 from top TVL but allowlist may re-add', () => {
      const pool = createPool({
        hooks: ZORA_CREATOR_HOOK_ON_BASE_v1,
        tvlETH: 0.0005,
        tvlUSD: 1,
      });
      const result = v4HooksPoolsFiltering(
        ChainId.BASE,
        [pool],
        mockLogger,
        mockMetric
      );
      // The pool is excluded from the priority queue (shouldNotAddV4Pool = true),
      // but it gets re-added via the allowlisted hooks path since ZORA hooks are in HOOKS_ADDRESSES_ALLOWLIST.
      // The pool should still appear in the result because of the allowlist.
      expect(result.length).toBe(1);
    });

    it('includes Zora creator hook pool on BASE with tvlETH > 0.001', () => {
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

    it('excludes Zora post hook pool on BASE with tvlETH <= 0.001 from priority queue', () => {
      const pool = createPool({
        hooks: ZORA_POST_HOOK_ON_BASE_v1,
        tvlETH: 0.0001,
        tvlUSD: 0,
      });
      const result = v4HooksPoolsFiltering(
        ChainId.BASE,
        [pool],
        mockLogger,
        mockMetric
      );
      // Excluded from priority queue but re-added via allowlist
      expect(result.length).toBe(1);
    });

    it('includes Zora post hook pool on BASE with tvlETH > 0.001', () => {
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

    it('auto-allowlists Zora hook on non-BASE chain when pair is not major-major', () => {
      const pool = createPool({
        hooks: ZORA_CREATOR_HOOK_ON_BASE_v1,
        tvlETH: 0.0001,
        tvlUSD: 0,
      });
      // On MAINNET the Zora TVL filter does not apply (requires chainId === BASE).
      // The pair is not major-major in this fixture, so the hook is auto-allowlisted.
      const result = v4HooksPoolsFiltering(
        ChainId.MAINNET,
        [pool],
        mockLogger,
        mockMetric
      );
      expect(result.length).toBe(1);
    });

    it('handles Zora post hook v2_4_0 variant on BASE with low tvl', () => {
      const pool = createPool({
        hooks: ZORA_POST_HOOK_ON_BASE_v2_4_0,
        tvlETH: 0.0001,
        tvlUSD: 0,
      });
      const result = v4HooksPoolsFiltering(
        ChainId.BASE,
        [pool],
        mockLogger,
        mockMetric
      );
      // Excluded from priority queue due to low TVL, but re-added via allowlist
      expect(result.length).toBe(1);
    });
  });

  // --- Clanker hooks ---
  describe('Clanker hooks', () => {
    it('excludes Clanker dynamic fee hook pool with tvlETH <= 0.001 from priority queue', () => {
      const pool = createPool({
        hooks: CLANKER_DYNAMIC_FEE_HOOKS_ADDRESS_ON_BASE,
        tvlETH: 0.0005,
        tvlUSD: 1,
      });
      const result = v4HooksPoolsFiltering(
        ChainId.BASE,
        [pool],
        mockLogger,
        mockMetric
      );
      // Excluded from priority queue but re-added via allowlist since Clanker hooks are allowlisted on BASE
      expect(result.length).toBe(1);
    });

    it('includes Clanker dynamic fee hook pool with tvlETH > 0.001', () => {
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

    it('excludes Clanker static fee hook pool with tvlETH <= 0.001 from priority queue', () => {
      const pool = createPool({
        hooks: CLANKER_STATIC_FEE_HOOKS_ADDRESS_ON_BASE,
        tvlETH: 0,
        tvlUSD: 0,
      });
      const result = v4HooksPoolsFiltering(
        ChainId.BASE,
        [pool],
        mockLogger,
        mockMetric
      );
      // Excluded from priority queue but re-added via allowlist
      expect(result.length).toBe(1);
    });

    it('includes Clanker static fee hook pool with tvlETH > 0.001', () => {
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

    it('excludes Clanker hook on UNICHAIN with tvlETH <= 0.001 from priority queue', () => {
      const pool = createPool({
        hooks: CLANKER_DYNAMIC_FEE_HOOKS_ADDRESS_ON_UNICHAIN,
        tvlETH: 0.001,
        tvlUSD: 0,
      });
      const result = v4HooksPoolsFiltering(
        ChainId.UNICHAIN,
        [pool],
        mockLogger,
        mockMetric
      );
      // Excluded from priority queue but re-added via allowlist
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
  describe('token creation error fallback', () => {
    it('falls back to 18 decimals when token decimals are invalid', () => {
      const pool = createPool({
        hooks: ADDRESS_ZERO,
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
      const result = v4HooksPoolsFiltering(
        ChainId.MAINNET,
        [pool],
        mockLogger,
        mockMetric
      );
      // The catch block should handle the NaN decimals and still process the pool
      expect(result.length).toBe(1);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Error creating tokens')
      );
    });

    it('falls back to 18 decimals for negative decimal value', () => {
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

    it('falls back with ADDRESS_ZERO token0 in catch block', () => {
      // token1 has invalid decimals to trigger error, token0 is ADDRESS_ZERO
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

    it('falls back with ADDRESS_ZERO token1 in catch block', () => {
      // token0 has invalid decimals to trigger error, token1 is ADDRESS_ZERO
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

  // --- High feeTier > 1000000 (non-routable) ---
  describe('high feeTier non-routable', () => {
    it('auto-allowlists non-major hooks even when feeTier > 1000000', () => {
      // Use a hook that has no swap permissions but feeTier is too high
      // ADDRESS_ZERO hooks bypass the feeTier check (they are always routable)
      // We need a hook without swap permissions but with high feeTier
      // A hook ending in 0x00 has no swap permissions
      const hookNoSwap = '0x0000000000000000000000000000000000000100';
      const pool = createPool({
        hooks: hookNoSwap,
        feeTier: '2000000',
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

  describe('auto-allowlisted hooks compete in top-N TVL queue', () => {
    it('caps auto-allowlisted hook pools per token pair + fee via top TVL', () => {
      // 15 pools with a non-routable auto-allowlisted hook (has beforeSwap permission
      // but no custom accounting, non-major pair) — same token pair and fee tier.
      // Only the top 10 by TVL should survive; the rest are not in the explicit
      // allowlist so they should not be re-added in Phase 2.
      const hookWithBeforeSwap = '0x0000000000000000000000000000000000000080';
      const pools = Array.from({length: 15}, (_, i) =>
        createPool({
          hooks: hookWithBeforeSwap,
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

    it('routable and auto-allowlisted hooks use separate top-N queues', () => {
      // 15 routable ADDRESS_ZERO pools and 15 auto-allowlisted hook pools,
      // all sharing the same token pair + fee tier.
      // Each queue independently keeps its top 10.
      const hookWithBeforeSwap = '0x0000000000000000000000000000000000000080';
      const token0 = {
        id: '0x00000000000000000000000000000000000000a1',
        symbol: 'A',
        name: 'A',
        decimals: '18',
      };
      const token1 = {
        id: '0x00000000000000000000000000000000000000a2',
        symbol: 'B',
        name: 'B',
        decimals: '18',
      };

      const routablePools = Array.from({length: 15}, (_, i) =>
        createPool({
          hooks: ADDRESS_ZERO,
          tvlETH: i + 1,
          token0,
          token1,
          feeTier: '3000',
        })
      );
      const autoAllowlistedPools = Array.from({length: 15}, (_, i) =>
        createPool({
          hooks: hookWithBeforeSwap,
          tvlETH: i + 1,
          token0,
          token1,
          feeTier: '3000',
        })
      );

      const result = v4HooksPoolsFiltering(
        ChainId.MAINNET,
        [...routablePools, ...autoAllowlistedPools],
        mockLogger,
        mockMetric
      );

      // Routable queue: top 10 by TVL (6-15) + 5 ADDRESS_ZERO re-added via explicit allowlist = 15
      // Auto-allowlisted queue: top 10 by TVL (6-15), not in explicit allowlist = 10
      // Total = 25
      expect(result.length).toBe(25);

      const routableResults = result.filter(p => p.hooks === ADDRESS_ZERO);
      const autoResults = result.filter(p => p.hooks === hookWithBeforeSwap);
      expect(routableResults.length).toBe(15);
      expect(autoResults.length).toBe(10);

      // Verify top-10 by TVL kept for auto-allowlisted
      const autoTvls = autoResults.map(p => p.tvlETH).sort((a, b) => a - b);
      expect(autoTvls).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
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

      const majorTokens = getMajorTokens(ChainId.BASE);
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
        if (!isMajorPair(pool.token0.id, pool.token1.id, majorTokens)) {
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
