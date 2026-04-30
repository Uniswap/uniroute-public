import {describe, beforeEach, it, expect, vi} from 'vitest';
import {
  AggHooksTopPoolsSelector,
  BasicTopPoolsSelector,
  getPoolTVL,
  buildTokenPoolIndex,
  getMaxFilteredPoolCount,
  MAX_MANUAL_DIRECT_PAIRS_FALLBACK,
} from './TopPoolsSelector';
import {defaultPoolSelectionConfig} from '../../lib/config';
import {
  AGG_HOOKS_ON_MAINNET,
  FLUID_DEX_LITE,
  STABLE_SWAP_NG,
} from '../../lib/poolCaching/util/aggHooksAddressesAllowlist';
import {ChainId} from '../../lib/config';
import {Context} from '@uniswap/lib-uni/context';
import {Address} from '../../models/address/Address';
import {IChainRepository} from '../../stores/chain/IChainRepository';
import {V2PoolInfo, V3PoolInfo, V4PoolInfo} from './interface';
import {HardcodedChainRepository} from '../../stores/chain/hardcoded/HardcodedChainRepository';
import {
  createNamespaceContext,
  EMPTY_NAMESPACE_CONTEXT,
  ExperimentalHooksNamespace,
} from '../../models/hooks/namespaces';
import {
  BASE_TOKENS_PER_CHAIN,
  WRAPPED_NATIVE_CURRENCY,
} from '../../lib/tokenUtils';
import {HooksOptions} from 'src/models/hooks/HooksOptions';
import {Experiment} from 'src/models/hooks/Experiment';
import {ADDRESS_ZERO} from '@uniswap/router-sdk';
import {
  poolSelectionConfig,
  aggHooksPoolSelectionPerChainConfig,
  IPoolSelectionConfig,
} from 'src/lib/config';
import {Protocol} from 'src/models/pool/Protocol';

describe('BasicTopPoolsSelector', () => {
  let chainRepository: IChainRepository;
  let selector: BasicTopPoolsSelector;
  let ctx: Context;
  let mockV2Pool: V2PoolInfo;
  let mockV3Pool: V3PoolInfo;
  let mockV4Pool: V4PoolInfo;
  let mockV4PoolWithHooks: V4PoolInfo;

  beforeEach(() => {
    chainRepository = new HardcodedChainRepository();
    selector = new BasicTopPoolsSelector(chainRepository, poolSelectionConfig);

    ctx = {
      logger: {
        debug: vi.fn(),
      },
      metrics: {
        count: vi.fn(),
      },
    } as unknown as Context;

    mockV2Pool = {
      id: '0x123',
      token0: {id: '0x0000000000000000000000000000000000000001'},
      token1: {id: '0x0000000000000000000000000000000000000002'},
      reserveUSD: 1000,
      supply: 10000,
      reserve: 10000,
    } as V2PoolInfo;

    mockV3Pool = {
      id: '0x456',
      token0: {id: '0x0000000000000000000000000000000000000001'},
      token1: {id: '0x0000000000000000000000000000000000000002'},
      tvlUSD: 2000,
      feeTier: '3000',
      liquidity: '10000',
      tvlETH: 10000,
    } as V3PoolInfo;

    mockV4Pool = {
      id: '0x789',
      token0: {id: '0x0000000000000000000000000000000000000001'},
      token1: {id: '0x0000000000000000000000000000000000000002'},
      tvlUSD: 3000,
      feeTier: '3000',
      tickSpacing: '60',
      hooks: '0x0000000000000000000000000000000000000000',
      liquidity: '10000',
      tvlETH: 10000,
    } as V4PoolInfo;

    mockV4PoolWithHooks = {
      id: '0x890',
      token0: {id: '0x0000000000000000000000000000000000000001'},
      token1: {id: '0x0000000000000000000000000000000000000002'},
      tvlUSD: 3000,
      feeTier: '3000',
      tickSpacing: '60',
      hooks: '0x1234567890123456789012345678901234567890',
      liquidity: '10000',
      tvlETH: 10000,
    } as V4PoolInfo;
  });

  describe('getPoolTVL', () => {
    it('should return reserve for V2 pools', () => {
      expect(getPoolTVL(mockV2Pool)).toBe(1000);
    });

    it('should return tvlUSD for V3/V4 pools', () => {
      expect(getPoolTVL(mockV3Pool)).toBe(2000);
      expect(getPoolTVL(mockV4Pool)).toBe(3000);
    });
  });

  describe('buildTokenPoolIndex', () => {
    it('should build correct token-to-pool index for single pool', () => {
      const pools = [mockV2Pool];
      const index = buildTokenPoolIndex(pools);

      const token0Id = mockV2Pool.token0.id.toLowerCase();
      const token1Id = mockV2Pool.token1.id.toLowerCase();
      const poolId = mockV2Pool.id.toLowerCase();

      // Check token-to-pools mapping
      expect(index.tokenToPools.has(token0Id)).toBe(true);
      expect(index.tokenToPools.has(token1Id)).toBe(true);
      expect(index.tokenToPools.get(token0Id)).toEqual([mockV2Pool]);
      expect(index.tokenToPools.get(token1Id)).toEqual([mockV2Pool]);

      // Check pool-to-tokens mapping
      expect(index.poolToTokens.has(poolId)).toBe(true);
      expect(index.poolToTokens.get(poolId)).toEqual(
        new Set([token0Id, token1Id])
      );
    });

    it('should build correct token-to-pool index for multiple pools', () => {
      const pool1 = {
        ...mockV2Pool,
        id: '0x123',
        token0: {id: '0x0000000000000000000000000000000000000001'},
        token1: {id: '0x0000000000000000000000000000000000000002'},
      };
      const pool2 = {
        ...mockV3Pool,
        id: '0x456',
        token0: {id: '0x0000000000000000000000000000000000000001'}, // Same as pool1
        token1: {id: '0x0000000000000000000000000000000000000003'},
      };
      const pool3 = {
        ...mockV4Pool,
        id: '0x789',
        token0: {id: '0x0000000000000000000000000000000000000002'}, // Same as pool1
        token1: {id: '0x0000000000000000000000000000000000000003'}, // Same as pool2
      };

      const pools = [pool1, pool2, pool3];
      const index = buildTokenPoolIndex(pools);

      const token1Id =
        '0x0000000000000000000000000000000000000001'.toLowerCase();
      const token2Id =
        '0x0000000000000000000000000000000000000002'.toLowerCase();
      const token3Id =
        '0x0000000000000000000000000000000000000003'.toLowerCase();

      // Check token-to-pools mapping
      expect(index.tokenToPools.get(token1Id)).toEqual([pool1, pool2]);
      expect(index.tokenToPools.get(token2Id)).toEqual([pool1, pool3]);
      expect(index.tokenToPools.get(token3Id)).toEqual([pool2, pool3]);

      // Check pool-to-tokens mapping
      expect(index.poolToTokens.get('0x123')).toEqual(
        new Set([token1Id, token2Id])
      );
      expect(index.poolToTokens.get('0x456')).toEqual(
        new Set([token1Id, token3Id])
      );
      expect(index.poolToTokens.get('0x789')).toEqual(
        new Set([token2Id, token3Id])
      );
    });

    it('should handle case-insensitive token addresses', () => {
      const pool = {
        ...mockV2Pool,
        token0: {id: '0xABCDEF1234567890ABCDEF1234567890ABCDEF12'},
        token1: {id: '0xabcdef1234567890abcdef1234567890abcdef12'}, // Same address, different case
      };
      const pools = [pool];
      const index = buildTokenPoolIndex(pools);

      const tokenId = '0xabcdef1234567890abcdef1234567890abcdef12';

      // Both tokens should map to the same pools since they're the same address
      expect(index.tokenToPools.get(tokenId)).toEqual([pool, pool]);
      expect(index.tokenToPools.size).toBe(1); // Only one unique token
    });

    it('should handle empty pools array', () => {
      const index = buildTokenPoolIndex([]);

      expect(index.tokenToPools.size).toBe(0);
      expect(index.poolToTokens.size).toBe(0);
    });

    it('should handle pools with duplicate tokens', () => {
      const pool = {
        ...mockV2Pool,
        token0: {id: '0x0000000000000000000000000000000000000001'},
        token1: {id: '0x0000000000000000000000000000000000000001'}, // Same as token0
      };
      const pools = [pool];
      const index = buildTokenPoolIndex(pools);

      const tokenId =
        '0x0000000000000000000000000000000000000001'.toLowerCase();

      // Token should appear twice in its own pool list
      expect(index.tokenToPools.get(tokenId)).toEqual([pool, pool]);
      expect(index.tokenToPools.size).toBe(1); // Only one unique token
    });

    it('should handle mixed pool types (V2, V3, V4)', () => {
      const v2Pool = {
        ...mockV2Pool,
        id: '0x123',
        token0: {id: '0x0000000000000000000000000000000000000001'},
        token1: {id: '0x0000000000000000000000000000000000000002'},
      };
      const v3Pool = {
        ...mockV3Pool,
        id: '0x456',
        token0: {id: '0x0000000000000000000000000000000000000002'}, // Same as v2Pool token1
        token1: {id: '0x0000000000000000000000000000000000000003'},
      };
      const v4Pool = {
        ...mockV4Pool,
        id: '0x789',
        token0: {id: '0x0000000000000000000000000000000000000001'}, // Same as v2Pool token0
        token1: {id: '0x0000000000000000000000000000000000000003'}, // Same as v3Pool token1
      };

      const pools = [v2Pool, v3Pool, v4Pool];
      const index = buildTokenPoolIndex(pools);

      const token1Id =
        '0x0000000000000000000000000000000000000001'.toLowerCase();
      const token2Id =
        '0x0000000000000000000000000000000000000002'.toLowerCase();
      const token3Id =
        '0x0000000000000000000000000000000000000003'.toLowerCase();

      // Check that all pool types are handled correctly
      expect(index.tokenToPools.get(token1Id)).toEqual([v2Pool, v4Pool]);
      expect(index.tokenToPools.get(token2Id)).toEqual([v2Pool, v3Pool]);
      expect(index.tokenToPools.get(token3Id)).toEqual([v3Pool, v4Pool]);

      // Check pool-to-tokens mapping
      expect(index.poolToTokens.get('0x123')).toEqual(
        new Set([token1Id, token2Id])
      );
      expect(index.poolToTokens.get('0x456')).toEqual(
        new Set([token2Id, token3Id])
      );
      expect(index.poolToTokens.get('0x789')).toEqual(
        new Set([token1Id, token3Id])
      );
    });
  });

  describe('filterPools', () => {
    const tokenIn = new Address('0x0000000000000000000000000000000000000001');
    const tokenOut = new Address('0x0000000000000000000000000000000000000002');

    it('should filter and return pools for V2 protocol', async () => {
      const pools = [mockV2Pool];
      const result = await selector.filterPools(
        pools,
        ChainId.MAINNET,
        tokenIn,
        tokenOut,
        Protocol.V2,
        undefined,
        EMPTY_NAMESPACE_CONTEXT,
        ctx
      );

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('0x123');
    });

    it('should filter and return pools for V3 protocol', async () => {
      const otherV3Pool = {
        id: '0x345',
        token0: {id: '0x0000000000000000000000000000000000000003'},
        token1: {id: '0x0000000000000000000000000000000000000004'},
        tvlUSD: 2000,
        feeTier: '3000',
        liquidity: '10000',
        tvlETH: 10000,
      } as V3PoolInfo;
      const pools = [otherV3Pool];
      const result = await selector.filterPools(
        pools,
        ChainId.MAINNET,
        tokenIn,
        tokenOut,
        Protocol.V3,
        undefined,
        EMPTY_NAMESPACE_CONTEXT,
        ctx
      );

      expect(result).toHaveLength(5);
      expect(result[0].id).toBe('0x345');
      expect(result[1].id).toBe('0x9257e4FDc64790015E8e372348a8069EDf95807c');
    });

    it('should filter and return pools for V4 protocol', async () => {
      const pools = [mockV4Pool];
      const result = await selector.filterPools(
        pools,
        ChainId.MAINNET,
        tokenIn,
        tokenOut,
        Protocol.V4,
        undefined,
        EMPTY_NAMESPACE_CONTEXT,
        ctx
      );

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('0x789');
    });

    it('should not generate direct pairs when no direct pools are provided', async () => {
      const result = await selector.filterPools(
        [mockV2Pool],
        ChainId.MAINNET,
        tokenIn,
        tokenOut,
        Protocol.V2,
        undefined,
        EMPTY_NAMESPACE_CONTEXT,
        ctx
      );

      expect(result).toHaveLength(1);
      expect(result[0].token0.id).toBe(
        '0x0000000000000000000000000000000000000001'
      );
      expect(result[0].token1.id).toBe(
        '0x0000000000000000000000000000000000000002'
      );
      expect(result[0].id).toBe(mockV2Pool.id);
    });

    it('should generate empty set when no pools are provided', async () => {
      const result = await selector.filterPools(
        [],
        ChainId.MAINNET,
        tokenIn,
        tokenOut,
        Protocol.V2,
        undefined,
        EMPTY_NAMESPACE_CONTEXT,
        ctx
      );

      expect(result).toHaveLength(0);
    });

    it('should not filter any pools when hooksOptions is HOOKS_INCLUSIVE', async () => {
      const pools = [
        {
          ...mockV4PoolWithHooks,
        },
        {
          ...mockV4Pool,
          hooks: ADDRESS_ZERO, // Zero hooks address
        },
      ];

      const result = await selector.filterPools(
        pools,
        ChainId.MAINNET,
        tokenIn,
        tokenOut,
        Protocol.V4,
        HooksOptions.HOOKS_INCLUSIVE,
        EMPTY_NAMESPACE_CONTEXT,
        ctx
      );

      expect(result).toHaveLength(2);
      expect((result[0] as V4PoolInfo).hooks).toBe(
        '0x1234567890123456789012345678901234567890'
      );
      expect((result[1] as V4PoolInfo).hooks).toBe(ADDRESS_ZERO);
    });

    it('should filter out pools with hooks when hooksOptions is NO_HOOKS', async () => {
      const pools = [
        {
          ...mockV4PoolWithHooks,
        },
        {
          ...mockV4Pool,
          hooks: ADDRESS_ZERO, // Zero hooks address
        },
      ];

      const result = await selector.filterPools(
        pools,
        ChainId.MAINNET,
        tokenIn,
        tokenOut,
        Protocol.V4,
        HooksOptions.NO_HOOKS,
        EMPTY_NAMESPACE_CONTEXT,
        ctx
      );

      expect(result).toHaveLength(1);
      expect((result[0] as V4PoolInfo).hooks).toBe(ADDRESS_ZERO);
    });

    it('should filter out pools with hooks when hooksOptions is HOOKS_ONLY', async () => {
      const pools = [
        {
          ...mockV4PoolWithHooks,
        },
        {
          ...mockV4Pool,
          hooks: ADDRESS_ZERO, // Zero hooks address
        },
      ];

      const result = await selector.filterPools(
        pools,
        ChainId.MAINNET,
        tokenIn,
        tokenOut,
        Protocol.V4,
        HooksOptions.HOOKS_ONLY,
        EMPTY_NAMESPACE_CONTEXT,
        ctx
      );

      expect(result).toHaveLength(1);
      expect((result[0] as V4PoolInfo).hooks).toBe(
        '0x1234567890123456789012345678901234567890'
      );
    });

    describe('agg hook exclusion', () => {
      const aggHookAddress = FLUID_DEX_LITE[0].toLowerCase();
      const nonAggHookAddress = '0x1234567890123456789012345678901234567890';

      it('should exclude V4 pools whose hook is an agg hook address', async () => {
        const aggHookPool: V4PoolInfo = {
          id: '0xagg',
          token0: {id: tokenIn.address},
          token1: {id: tokenOut.address},
          hooks: aggHookAddress,
          feeTier: '3000',
          tickSpacing: '60',
          liquidity: '10000',
          tvlETH: 9999,
          tvlUSD: 9999,
        } as V4PoolInfo;

        const result = await selector.filterPools(
          [aggHookPool, mockV4Pool],
          ChainId.MAINNET,
          tokenIn,
          tokenOut,
          Protocol.V4,
          undefined,
          EMPTY_NAMESPACE_CONTEXT,
          ctx
        );

        const ids = result.map(p => p.id);
        expect(ids).not.toContain('0xagg');
        expect(ids).toContain(mockV4Pool.id);
      });

      it('should exclude all agg hook families (FLUID_DEX_LITE and STABLE_SWAP_NG)', async () => {
        const fluidPool: V4PoolInfo = {
          ...mockV4Pool,
          id: '0xfluid',
          hooks: FLUID_DEX_LITE[0].toLowerCase(),
        } as V4PoolInfo;
        const stablePool: V4PoolInfo = {
          ...mockV4Pool,
          id: '0xstable',
          hooks: STABLE_SWAP_NG[0].toLowerCase(),
        } as V4PoolInfo;

        const result = await selector.filterPools(
          [fluidPool, stablePool, mockV4Pool],
          ChainId.MAINNET,
          tokenIn,
          tokenOut,
          Protocol.V4,
          undefined,
          EMPTY_NAMESPACE_CONTEXT,
          ctx
        );

        const ids = result.map(p => p.id);
        expect(ids).not.toContain('0xfluid');
        expect(ids).not.toContain('0xstable');
        expect(ids).toContain(mockV4Pool.id);
      });

      it('should keep V4 pools with non-agg hook addresses', async () => {
        const nonAggPool: V4PoolInfo = {
          ...mockV4Pool,
          id: '0xnonagg',
          hooks: nonAggHookAddress,
        } as V4PoolInfo;

        const result = await selector.filterPools(
          [nonAggPool],
          ChainId.MAINNET,
          tokenIn,
          tokenOut,
          Protocol.V4,
          undefined,
          EMPTY_NAMESPACE_CONTEXT,
          ctx
        );

        expect(result.map(p => p.id)).toContain('0xnonagg');
      });

      it('should exclude agg hook pools even when hooksOptions is HOOKS_INCLUSIVE', async () => {
        const aggHookPool: V4PoolInfo = {
          ...mockV4Pool,
          id: '0xagg_inclusive',
          hooks: aggHookAddress,
        } as V4PoolInfo;

        const result = await selector.filterPools(
          [aggHookPool, mockV4Pool],
          ChainId.MAINNET,
          tokenIn,
          tokenOut,
          Protocol.V4,
          HooksOptions.HOOKS_INCLUSIVE,
          EMPTY_NAMESPACE_CONTEXT,
          ctx
        );

        const ids = result.map(p => p.id);
        expect(ids).not.toContain('0xagg_inclusive');
        expect(ids).toContain(mockV4Pool.id);
      });

      it('should exclude agg hook pools even when hooksOptions is HOOKS_ONLY', async () => {
        const aggHookPool: V4PoolInfo = {
          ...mockV4Pool,
          id: '0xagg_hooks_only',
          hooks: aggHookAddress,
        } as V4PoolInfo;

        const result = await selector.filterPools(
          [aggHookPool, mockV4PoolWithHooks],
          ChainId.MAINNET,
          tokenIn,
          tokenOut,
          Protocol.V4,
          HooksOptions.HOOKS_ONLY,
          EMPTY_NAMESPACE_CONTEXT,
          ctx
        );

        const ids = result.map(p => p.id);
        expect(ids).not.toContain('0xagg_hooks_only');
        // mockV4PoolWithHooks has a non-agg non-zero hook → survives HOOKS_ONLY
        expect(ids).toContain(mockV4PoolWithHooks.id);
      });

      it('should not affect non-V4 protocols', async () => {
        // V2/V3 pools have no hooks field — agg hook exclusion must not touch them
        const result = await selector.filterPools(
          [mockV2Pool],
          ChainId.MAINNET,
          tokenIn,
          tokenOut,
          Protocol.V2,
          undefined,
          EMPTY_NAMESPACE_CONTEXT,
          ctx
        );

        expect(result.map(p => p.id)).toContain(mockV2Pool.id);
      });
    });

    describe('experiment manual append', () => {
      // Matches EXPERIMENT_HOOKS[GuideStar_Stable_Stable] in
      // src/models/hooks/Experiment.ts.
      const experimentHookAddress =
        '0x4509b7eb3f9641226804fea4976963435d1c6080';

      const makeExperimentPool = (
        id: string,
        hooks: string,
        tvlUSD = 0
      ): V4PoolInfo =>
        ({
          id,
          token0: {id: '0x0000000000000000000000000000000000000099'},
          token1: {id: '0x0000000000000000000000000000000000000098'},
          hooks,
          feeTier: '3000',
          tickSpacing: '60',
          liquidity: '10000',
          tvlETH: tvlUSD / 1000,
          tvlUSD,
        }) as V4PoolInfo;

      it('appends a V4 pool with matching experiment hook even when TVL is tiny', async () => {
        const tinyExperimentPool = makeExperimentPool(
          '0xexp',
          experimentHookAddress,
          /* tvlUSD= */ 1
        );

        const result = await selector.filterPools(
          [tinyExperimentPool, mockV4Pool],
          ChainId.MAINNET,
          tokenIn,
          tokenOut,
          Protocol.V4,
          HooksOptions.HOOKS_INCLUSIVE,
          createNamespaceContext([
            new ExperimentalHooksNamespace(Experiment.GuideStar_Stable_Stable),
          ]),
          ctx
        );

        expect(result.map(p => p.id)).toContain('0xexp');
      });

      it('is a no-op when experiment is undefined', async () => {
        // Assert directly on the manual-append debug log since the experiment
        // pool may still be pulled in via the generic top-N path regardless
        // of the append branch. Absence of the debug line is the ground truth
        // for "the append branch did not execute".
        const tinyExperimentPool = makeExperimentPool(
          '0xexp',
          experimentHookAddress,
          /* tvlUSD= */ 1
        );
        const debugSpy = ctx.logger.debug as unknown as ReturnType<
          typeof vi.fn
        >;

        await selector.filterPools(
          [tinyExperimentPool, mockV4Pool],
          ChainId.MAINNET,
          tokenIn,
          tokenOut,
          Protocol.V4,
          HooksOptions.HOOKS_INCLUSIVE,
          EMPTY_NAMESPACE_CONTEXT,
          ctx
        );

        const appendedCalls = debugSpy.mock.calls.filter(
          ([msg]) => msg === 'Manually appended experiment pools'
        );
        expect(appendedCalls).toHaveLength(0);
      });

      it('does not append for non-V4 protocols even when experiment is set', async () => {
        const result = await selector.filterPools(
          [mockV2Pool],
          ChainId.MAINNET,
          tokenIn,
          tokenOut,
          Protocol.V2,
          undefined,
          createNamespaceContext([
            new ExperimentalHooksNamespace(Experiment.GuideStar_Stable_Stable),
          ]),
          ctx
        );

        // Result is exactly the V2 pool, no duplicate, no extra appended entry.
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe(mockV2Pool.id);
      });

      it('deduplicates: does not re-append a pool already selected by the TopN path', async () => {
        // Give the experiment pool high TVL so it lands in the normal selection.
        const hiTvlExperimentPool = makeExperimentPool(
          '0xexp_hi',
          experimentHookAddress,
          /* tvlUSD= */ 100_000_000
        );
        // Make the token pair match tokenIn/tokenOut so it goes into directPairs.
        hiTvlExperimentPool.token0 = {id: tokenIn.address};
        hiTvlExperimentPool.token1 = {id: tokenOut.address};

        const result = await selector.filterPools(
          [hiTvlExperimentPool],
          ChainId.MAINNET,
          tokenIn,
          tokenOut,
          Protocol.V4,
          HooksOptions.HOOKS_INCLUSIVE,
          createNamespaceContext([
            new ExperimentalHooksNamespace(Experiment.GuideStar_Stable_Stable),
          ]),
          ctx
        );

        const occurrences = result.filter(p => p.id === '0xexp_hi').length;
        expect(occurrences).toBe(1);
      });

      it('matches experiment hook addresses case-insensitively', async () => {
        // Hook stored in UPPERCASE — must still match the lowercase entry in
        // EXPERIMENT_HOOKS.
        const upperCaseHookPool = makeExperimentPool(
          '0xexp_case',
          experimentHookAddress.toUpperCase(),
          /* tvlUSD= */ 1
        );

        const result = await selector.filterPools(
          [upperCaseHookPool, mockV4Pool],
          ChainId.MAINNET,
          tokenIn,
          tokenOut,
          Protocol.V4,
          HooksOptions.HOOKS_INCLUSIVE,
          createNamespaceContext([
            new ExperimentalHooksNamespace(Experiment.GuideStar_Stable_Stable),
          ]),
          ctx
        );

        expect(result.map(p => p.id)).toContain('0xexp_case');
      });
    });
  });

  describe('filterUnsupportedPools', () => {
    it('should filter out pools with unsupported tokens', () => {
      // 0xd233d1f6fd11640081abb8db125f722b5dc729dc is a real unsupported token on MAINNET
      const unsupportedToken = '0xd233d1f6fd11640081abb8db125f722b5dc729dc';
      const pools = [
        {
          ...mockV2Pool,
          token0: {id: unsupportedToken},
          token1: {id: '0x0000000000000000000000000000000000000002'},
        },
        mockV2Pool,
      ];

      const result = BasicTopPoolsSelector['filterUnsupportedPools'](
        pools,
        ChainId.MAINNET
      );

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('0x123');
    });
  });

  describe('filterAndAddPools', () => {
    it('should filter and add pools without duplicates', () => {
      const pools = [mockV2Pool, mockV2Pool];
      const seenPoolIds = new Set<string>();

      const result = BasicTopPoolsSelector['filterAndAddPools'](
        pools,
        () => true,
        2,
        seenPoolIds
      );

      expect(result).toHaveLength(1);
      expect(seenPoolIds.has('0x123')).toBe(true);
    });
  });

  describe('poolContainsToken', () => {
    it('should return true if pool contains token', () => {
      const result = BasicTopPoolsSelector['poolContainsToken'](
        mockV2Pool,
        '0x0000000000000000000000000000000000000001'
      );
      expect(result).toBe(true);
    });

    it('should return false if pool does not contain token', () => {
      const result = BasicTopPoolsSelector['poolContainsToken'](
        mockV2Pool,
        '0x0000000000000000000000000000000000000004'
      );
      expect(result).toBe(false);
    });
  });

  describe('getDirectPairs', () => {
    const tokenIn = new Address('0x0000000000000000000000000000000000000001');
    const tokenOut = new Address('0x0000000000000000000000000000000000000002');

    it('should return direct pairs for V2 protocol', () => {
      const pools = [mockV2Pool];
      const selectedPoolIds = new Set<string>();

      // Build token pool index using the helper function
      const tokenPoolIndex = buildTokenPoolIndex(pools);

      const result = BasicTopPoolsSelector['getDirectPairs'](
        pools,
        ChainId.MAINNET,
        Protocol.V2,
        tokenIn,
        tokenOut,
        selectedPoolIds,
        tokenPoolIndex,
        poolSelectionConfig
      );

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('0x123');
    });
  });

  describe('getTokenInOnlyPairs', () => {
    const tokenIn = new Address('0x0000000000000000000000000000000000000001');
    const tokenOut = new Address('0x0000000000000000000000000000000000000002');

    it('should return pools containing only tokenIn', () => {
      const pool = {
        ...mockV2Pool,
        token0: {id: '0x0000000000000000000000000000000000000001'}, // tokenIn
        token1: {id: '0x0000000000000000000000000000000000000003'}, // different token
      };
      const selectedPoolIds = new Set<string>();

      // Build token pool index using the helper function
      const tokenPoolIndex = buildTokenPoolIndex([pool]);

      const result = BasicTopPoolsSelector['getTokenInOnlyPairs'](
        tokenIn,
        tokenOut,
        selectedPoolIds,
        tokenPoolIndex,
        ChainId.MAINNET,
        poolSelectionConfig
      );

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('0x123');
    });
  });

  describe('getTokenOutOnlyPairs', () => {
    const tokenIn = new Address('0x0000000000000000000000000000000000000001');
    const tokenOut = new Address('0x0000000000000000000000000000000000000002');

    it('should return pools containing only tokenOut', () => {
      const pool = {
        ...mockV2Pool,
        token0: {id: '0x0000000000000000000000000000000000000003'}, // different token
        token1: {id: '0x0000000000000000000000000000000000000002'}, // tokenOut
      };
      const selectedPoolIds = new Set<string>();

      // Build token pool index using the helper function
      const tokenPoolIndex = buildTokenPoolIndex([pool]);

      const result = BasicTopPoolsSelector['getTokenOutOnlyPairs'](
        tokenIn,
        tokenOut,
        selectedPoolIds,
        tokenPoolIndex,
        ChainId.MAINNET,
        poolSelectionConfig
      );

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('0x123');
    });
  });

  describe('getIntermediaryTokenIds', () => {
    const tokenIn = new Address('0x0000000000000000000000000000000000000001');
    const tokenOut = new Address('0x0000000000000000000000000000000000000002');

    it('should return intermediary token IDs', () => {
      const tokenInOnlyPairs = [
        {
          ...mockV2Pool,
          token0: {id: '0x0000000000000000000000000000000000000001'}, // tokenIn
          token1: {id: '0x0000000000000000000000000000000000000003'}, // third token
        },
      ];
      const tokenOutOnlyPairs = [
        {
          ...mockV2Pool,
          token0: {id: '0x0000000000000000000000000000000000000003'}, // third token
          token1: {id: '0x0000000000000000000000000000000000000002'}, // tokenOut
        },
      ];

      const result = BasicTopPoolsSelector['getIntermediaryTokenIds'](
        tokenInOnlyPairs,
        tokenOutOnlyPairs,
        tokenIn,
        tokenOut
      );

      expect(result.length).toBe(1);
      expect(result[0]).toBe('0x0000000000000000000000000000000000000003');
    });
  });

  describe('getTopNPoolsForIntermediaryToken', () => {
    it('should return top N pools for intermediary token', () => {
      const intermediaryTokenIds = [
        '0x0000000000000000000000000000000000000002',
      ];
      const selectedPoolIds = new Set<string>();

      // Build token pool index using the helper function
      const tokenPoolIndex = buildTokenPoolIndex([mockV2Pool]);

      const result = BasicTopPoolsSelector['getTopNPoolsForIntermediaryToken'](
        intermediaryTokenIds,
        selectedPoolIds,
        tokenPoolIndex,
        ChainId.MAINNET,
        poolSelectionConfig
      );

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('0x123');
    });

    it('should always include top 1 WETH and ETH pools for each intermediary token', () => {
      const intermediaryToken = '0x0000000000000000000000000000000000000003';
      const intermediaryTokenIds = [intermediaryToken];
      const selectedPoolIds = new Set<string>();

      const wethAddress =
        WRAPPED_NATIVE_CURRENCY[ChainId.MAINNET].address.toLowerCase();
      const ethAddress = ADDRESS_ZERO.toLowerCase();

      // Create pools for the intermediary token with higher TVL than WETH/ETH pools
      // to ensure they get selected in top N, while WETH/ETH are added separately
      const intermediaryPool1 = {
        ...mockV3Pool,
        id: '0xintermediary1',
        token0: {id: intermediaryToken},
        token1: {id: '0x0000000000000000000000000000000000000004'},
        tvlUSD: 10000,
      } as V3PoolInfo;

      const intermediaryPool2 = {
        ...mockV3Pool,
        id: '0xintermediary2',
        token0: {id: intermediaryToken},
        token1: {id: '0x0000000000000000000000000000000000000005'},
        tvlUSD: 8000,
      } as V3PoolInfo;

      // Create WETH pool with lower TVL (so it won't be in top N, but will be added separately)
      const wethPoolHigh = {
        ...mockV3Pool,
        id: '0xwethHigh',
        token0: {id: intermediaryToken},
        token1: {id: wethAddress},
        tvlUSD: 5000,
      } as V3PoolInfo;

      // Create WETH pool with even lower TVL (should not be selected)
      const wethPoolLow = {
        ...mockV3Pool,
        id: '0xwethLow',
        token0: {id: intermediaryToken},
        token1: {id: wethAddress},
        tvlUSD: 1000,
      } as V3PoolInfo;

      // Create ETH pool with lower TVL (so it won't be in top N, but will be added separately)
      const ethPool = {
        ...mockV3Pool,
        id: '0xethPool',
        token0: {id: intermediaryToken},
        token1: {id: ethAddress},
        tvlUSD: 3000,
      } as V3PoolInfo;

      const allPools = [
        intermediaryPool1,
        intermediaryPool2,
        wethPoolHigh,
        wethPoolLow,
        ethPool,
      ];

      // Build token pool index
      const tokenPoolIndex = buildTokenPoolIndex(allPools);

      const result = BasicTopPoolsSelector['getTopNPoolsForIntermediaryToken'](
        intermediaryTokenIds,
        selectedPoolIds,
        tokenPoolIndex,
        ChainId.MAINNET,
        poolSelectionConfig
      );

      // Should include:
      // 1. Top N pools for intermediary token (intermediaryPool1, intermediaryPool2 - highest TVL)
      // 2. Top 1 WETH pool (wethPoolHigh - highest WETH TVL, added separately)
      // 3. Top 1 ETH pool (ethPool - added separately)
      const resultIds = result.map(p => p.id.toLowerCase());
      expect(resultIds).toContain('0xintermediary1');
      expect(resultIds).toContain('0xintermediary2');
      expect(resultIds).toContain('0xwethhigh'); // Top WETH pool (added separately)
      expect(resultIds).toContain('0xethpool'); // ETH pool (added separately)
      // Should NOT include the lower TVL WETH pool
      expect(resultIds).not.toContain('0xwethlow');
    });

    it('should handle multiple intermediary tokens and include ETH/WETH pools for each', () => {
      const intermediaryToken1 = '0x0000000000000000000000000000000000000003';
      const intermediaryToken2 = '0x0000000000000000000000000000000000000004';
      const intermediaryTokenIds = [intermediaryToken1, intermediaryToken2];
      const selectedPoolIds = new Set<string>();

      const wethAddress =
        WRAPPED_NATIVE_CURRENCY[ChainId.MAINNET].address.toLowerCase();
      const ethAddress = ADDRESS_ZERO.toLowerCase();

      // Create pools for first intermediary token
      // Regular pools have higher TVL so they get selected in top N
      const token1Pool = {
        ...mockV3Pool,
        id: '0xtoken1pool',
        token0: {id: intermediaryToken1},
        token1: {id: '0x0000000000000000000000000000000000000005'},
        tvlUSD: 10000,
      } as V3PoolInfo;

      // WETH/ETH pools have lower TVL so they're added separately
      const token1WethPool = {
        ...mockV3Pool,
        id: '0xtoken1weth',
        token0: {id: intermediaryToken1},
        token1: {id: wethAddress},
        tvlUSD: 2000,
      } as V3PoolInfo;

      const token1EthPool = {
        ...mockV3Pool,
        id: '0xtoken1eth',
        token0: {id: intermediaryToken1},
        token1: {id: ethAddress},
        tvlUSD: 1500,
      } as V3PoolInfo;

      // Create pools for second intermediary token
      // Regular pools have higher TVL so they get selected in top N
      const token2Pool = {
        ...mockV3Pool,
        id: '0xtoken2pool',
        token0: {id: intermediaryToken2},
        token1: {id: '0x0000000000000000000000000000000000000006'},
        tvlUSD: 8000,
      } as V3PoolInfo;

      // WETH/ETH pools have lower TVL so they're added separately
      const token2WethPool = {
        ...mockV3Pool,
        id: '0xtoken2weth',
        token0: {id: intermediaryToken2},
        token1: {id: wethAddress},
        tvlUSD: 3000,
      } as V3PoolInfo;

      const token2EthPool = {
        ...mockV3Pool,
        id: '0xtoken2eth',
        token0: {id: intermediaryToken2},
        token1: {id: ethAddress},
        tvlUSD: 2500,
      } as V3PoolInfo;

      const allPools = [
        token1Pool,
        token1WethPool,
        token1EthPool,
        token2Pool,
        token2WethPool,
        token2EthPool,
      ];

      // Build token pool index
      const tokenPoolIndex = buildTokenPoolIndex(allPools);

      const result = BasicTopPoolsSelector['getTopNPoolsForIntermediaryToken'](
        intermediaryTokenIds,
        selectedPoolIds,
        tokenPoolIndex,
        ChainId.MAINNET,
        poolSelectionConfig
      );

      const resultIds = result.map(p => p.id.toLowerCase());

      // Should include pools for both intermediary tokens
      expect(resultIds).toContain('0xtoken1pool');
      expect(resultIds).toContain('0xtoken2pool');

      // Should include WETH pools for both tokens
      expect(resultIds).toContain('0xtoken1weth');
      expect(resultIds).toContain('0xtoken2weth');

      // Should include ETH pools for both tokens
      expect(resultIds).toContain('0xtoken1eth');
      expect(resultIds).toContain('0xtoken2eth');
    });
  });

  describe('getTopNPairs', () => {
    it('should return top N pairs by liquidity', () => {
      const filteredPools = [mockV2Pool];
      const selectedPoolIds = new Set<string>();

      const result = BasicTopPoolsSelector['getTopNPairs'](
        filteredPools,
        selectedPoolIds,
        ChainId.MAINNET,
        poolSelectionConfig
      );

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('0x123');
    });
  });

  describe('getTopBaseTokenPools', () => {
    it('should select top base token pools based on TVL', () => {
      // Mock pools with different TVL values
      const pools = [
        {
          id: 'pool1',
          token0: {id: BASE_TOKENS_PER_CHAIN[ChainId.MAINNET]![0].address},
          token1: {id: '0xTOKEN_IN'},
          tvlUSD: 1000,
          feeTier: '3000',
          liquidity: '10000',
          tvlETH: 10000,
        },
        {
          id: 'pool2',
          token0: {id: BASE_TOKENS_PER_CHAIN[ChainId.MAINNET]![0].address},
          token1: {id: '0xTOKEN_IN'},
          tvlUSD: 3000,
          feeTier: '3000',
          liquidity: '10000',
          tvlETH: 30000,
        },
        {
          id: 'pool3',
          token0: {id: BASE_TOKENS_PER_CHAIN[ChainId.MAINNET]![0].address},
          token1: {id: '0xTOKEN_IN'},
          tvlUSD: 2000,
          feeTier: '3000',
          liquidity: '10000',
          tvlETH: 20000,
        },
        {
          id: 'pool4',
          token0: {id: BASE_TOKENS_PER_CHAIN[ChainId.MAINNET]![0].address},
          token1: {id: '0xTOKEN_IN'},
          tvlUSD: 500,
          feeTier: '3000',
          liquidity: '10000',
          tvlETH: 500,
        },
      ] as V3PoolInfo[];

      const selectedPoolIds = new Set<string>();

      // Build token pool index using the helper function
      const tokenPoolIndex = buildTokenPoolIndex(pools);

      const result = BasicTopPoolsSelector['getTopBaseTokenPools'](
        selectedPoolIds,
        ChainId.MAINNET,
        '0xTOKEN_IN',
        tokenPoolIndex,
        poolSelectionConfig
      );

      // Should return pools sorted by TVL (highest first)
      expect(result).toHaveLength(3); // TOP_N_WITH_BASE_TOKEN_EACH = 2
      expect(result[0].id).toBe('pool2'); // Highest TVL
      expect(result[1].id).toBe('pool3'); // Second highest TVL
      expect(result[2].id).toBe('pool1'); // Third highest TVL
    });

    it('should handle empty base tokens list', () => {
      const selectedPoolIds = new Set<string>();

      // Build empty token pool index using the helper function
      const tokenPoolIndex = buildTokenPoolIndex([]);

      const result = BasicTopPoolsSelector['getTopBaseTokenPools'](
        selectedPoolIds,
        ChainId.MAINNET,
        '0xTOKEN_IN',
        tokenPoolIndex,
        poolSelectionConfig
      );

      expect(result).toHaveLength(0);
    });
  });

  describe('getTopPoolForTokens', () => {
    it('should return top pool for two tokens', () => {
      const pool = {
        ...mockV2Pool,
        token0: {id: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'}, // WETH
        token1: {id: '0x0000000000000000000000000000000000000003'}, // different token
      };
      const selectedPoolIds = new Set<string>();
      const tokenInAddress = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
      const tokenOutAddress = '0x0000000000000000000000000000000000000003';

      // Build token pool index using the helper function
      const tokenPoolIndex = buildTokenPoolIndex([pool]);

      const result = BasicTopPoolsSelector['getTopPoolForTokens'](
        selectedPoolIds,
        tokenInAddress,
        tokenOutAddress,
        tokenPoolIndex
      );

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('0x123');
    });
  });

  describe('manuallyGenerateDirectPairs', () => {
    const tokenIn = new Address('0x0000000000000000000000000000000000000001');
    const tokenOut = new Address('0x0000000000000000000000000000000000000002');

    it('should generate direct pairs for V2 protocol', async () => {
      const selectedPoolIds = new Set<string>();

      const result = await selector['manuallyGenerateDirectPairs'](
        Protocol.V2,
        ChainId.MAINNET,
        tokenIn.address,
        tokenOut.address,
        selectedPoolIds
      );

      expect(result).toHaveLength(1);
      expect(result[0].token0.id).toBe(
        '0x0000000000000000000000000000000000000001'
      );
      expect(result[0].token1.id).toBe(
        '0x0000000000000000000000000000000000000002'
      );
    });

    it('should generate direct pairs for V3 protocol', async () => {
      const selectedPoolIds = new Set<string>();

      const result = await selector['manuallyGenerateDirectPairs'](
        Protocol.V3,
        ChainId.MAINNET,
        tokenIn.address,
        tokenOut.address,
        selectedPoolIds
      );

      expect(result.length).toBeGreaterThan(0);
      expect(result[0].token0.id).toBe(
        '0x0000000000000000000000000000000000000001'
      );
      expect(result[0].token1.id).toBe(
        '0x0000000000000000000000000000000000000002'
      );
    });

    it('should throw error for unsupported protocol', async () => {
      const selectedPoolIds = new Set<string>();

      await expect(
        selector['manuallyGenerateDirectPairs'](
          'UNSUPPORTED' as Protocol,
          ChainId.MAINNET,
          tokenIn.address,
          tokenOut.address,
          selectedPoolIds
        )
      ).rejects.toThrow('Unsupported protocol UNSUPPORTED');
    });
  });
});

// Pick one address from each family so tests are readable and deterministic
const AGG_HOOK_FLUID_LITE = FLUID_DEX_LITE[0].toLowerCase(); // 0xf37c...
const AGG_HOOK_STABLE_SWAP = STABLE_SWAP_NG[0].toLowerCase(); // 0xc24c...
const NON_AGG_HOOK = '0x1234567890123456789012345678901234567890';

function makeAggV4Pool(
  id: string,
  token0Id: string,
  token1Id: string,
  hooks = AGG_HOOK_FLUID_LITE,
  tvlUSD = 5000
): V4PoolInfo {
  return {
    id,
    token0: {id: token0Id},
    token1: {id: token1Id},
    hooks,
    feeTier: '3000',
    tickSpacing: '60',
    liquidity: '10000',
    tvlETH: tvlUSD,
    tvlUSD,
  } as V4PoolInfo;
}

describe('AggHooksTopPoolsSelector', () => {
  const TOKEN_IN = '0x0000000000000000000000000000000000000001';
  const TOKEN_OUT = '0x0000000000000000000000000000000000000002';
  const TOKEN_OTHER = '0x0000000000000000000000000000000000000003';
  const TOKEN_INTERMEDIARY = '0x0000000000000000000000000000000000000004';
  const WETH = WRAPPED_NATIVE_CURRENCY[ChainId.MAINNET].address.toLowerCase();

  const tokenIn = new Address(TOKEN_IN);
  const tokenOut = new Address(TOKEN_OUT);

  // Config with all heuristics enabled (non-zero limits) for multi-hop tests.
  const fullHeuristicsConfig: Record<ChainId, IPoolSelectionConfig> =
    Object.fromEntries(
      Object.keys(poolSelectionConfig).map(k => [
        Number(k),
        {
          topNDirectPairs: 2,
          topNOneHopPairs: 3,
          topNSecondHopPairs: 2,
          topNPairs: 2,
          topNWithBaseTokenEach: 2,
          topNWithBaseToken: 4,
        },
      ])
    ) as Record<ChainId, IPoolSelectionConfig>;

  let selector: AggHooksTopPoolsSelector;
  let selectorDefault: AggHooksTopPoolsSelector;
  let ctx: Context;

  beforeEach(() => {
    selector = new AggHooksTopPoolsSelector(fullHeuristicsConfig);
    selectorDefault = new AggHooksTopPoolsSelector(
      aggHooksPoolSelectionPerChainConfig
    );
    ctx = {
      logger: {debug: vi.fn()},
      metrics: {count: vi.fn()},
    } as unknown as Context;
  });

  it('sanity: AGG_HOOKS_ON_MAINNET contains the addresses used in these tests', () => {
    const lower = AGG_HOOKS_ON_MAINNET.map(h => h.toLowerCase());
    expect(lower).toContain(AGG_HOOK_FLUID_LITE);
    expect(lower).toContain(AGG_HOOK_STABLE_SWAP);
    expect(lower).not.toContain(NON_AGG_HOOK);
  });

  describe('agg hooks pre-filter', () => {
    it('should return a direct pair when the pool has an agg hook address', async () => {
      const pool = makeAggV4Pool('0xagg_direct', TOKEN_IN, TOKEN_OUT);
      const result = await selector.filterPools(
        [pool],
        ChainId.MAINNET,
        tokenIn,
        tokenOut,
        Protocol.V4,
        undefined,
        EMPTY_NAMESPACE_CONTEXT,
        ctx
      );
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('0xagg_direct');
    });

    it('should exclude pools whose hook address is not in AGG_HOOKS_PER_CHAIN for the chain', async () => {
      const nonAggPool = makeAggV4Pool(
        '0xnon_agg',
        TOKEN_IN,
        TOKEN_OUT,
        NON_AGG_HOOK
      );
      const result = await selector.filterPools(
        [nonAggPool],
        ChainId.MAINNET,
        tokenIn,
        tokenOut,
        Protocol.V4,
        undefined,
        EMPTY_NAMESPACE_CONTEXT,
        ctx
      );
      expect(result).toHaveLength(0);
    });

    it('should exclude regular V4 pools with ADDRESS_ZERO hooks', async () => {
      const regularPool = makeAggV4Pool(
        '0xzero_hooks',
        TOKEN_IN,
        TOKEN_OUT,
        ADDRESS_ZERO
      );
      const result = await selector.filterPools(
        [regularPool],
        ChainId.MAINNET,
        tokenIn,
        tokenOut,
        Protocol.V4,
        undefined,
        EMPTY_NAMESPACE_CONTEXT,
        ctx
      );
      expect(result).toHaveLength(0);
    });

    it('should accept pools from multiple agg hook families in a single call', async () => {
      const fluidPool = makeAggV4Pool(
        '0xfluid',
        TOKEN_IN,
        TOKEN_OUT,
        AGG_HOOK_FLUID_LITE
      );
      const stablePool = makeAggV4Pool(
        '0xstable',
        TOKEN_IN,
        TOKEN_OUT,
        AGG_HOOK_STABLE_SWAP,
        4000
      );
      const result = await selector.filterPools(
        [fluidPool, stablePool],
        ChainId.MAINNET,
        tokenIn,
        tokenOut,
        Protocol.V4,
        undefined,
        EMPTY_NAMESPACE_CONTEXT,
        ctx
      );
      expect(result).toHaveLength(2);
      expect(result.map(p => p.id)).toContain('0xfluid');
      expect(result.map(p => p.id)).toContain('0xstable');
    });
  });

  describe('multi-hop pool selection (with non-zero config limits)', () => {
    it('includes direct pairs, tokenIn-only, and tokenOut-only pools', async () => {
      const directPool = makeAggV4Pool('0xdirect', TOKEN_IN, TOKEN_OUT);
      const tokenInOnlyPool = makeAggV4Pool('0xin_only', TOKEN_IN, TOKEN_OTHER);
      const tokenOutOnlyPool = makeAggV4Pool(
        '0xout_only',
        TOKEN_OTHER,
        TOKEN_OUT
      );

      const result = await selector.filterPools(
        [directPool, tokenInOnlyPool, tokenOutOnlyPool],
        ChainId.MAINNET,
        tokenIn,
        tokenOut,
        Protocol.V4,
        undefined,
        EMPTY_NAMESPACE_CONTEXT,
        ctx
      );

      const ids = result.map(p => p.id);
      expect(ids).toContain('0xdirect');
      expect(ids).toContain('0xin_only');
      expect(ids).toContain('0xout_only');
    });

    it('includes tokenIn-only pools even when no direct pair exists', async () => {
      const tokenInOnlyPool = makeAggV4Pool('0xin_only', TOKEN_IN, TOKEN_OTHER);
      const result = await selector.filterPools(
        [tokenInOnlyPool],
        ChainId.MAINNET,
        tokenIn,
        tokenOut,
        Protocol.V4,
        undefined,
        EMPTY_NAMESPACE_CONTEXT,
        ctx
      );

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('0xin_only');
    });

    it('discovers intermediary tokens and selects second-hop pools', async () => {
      // tokenIn → intermediary (first hop)
      const firstHop = makeAggV4Pool(
        '0xfirst_hop',
        TOKEN_IN,
        TOKEN_INTERMEDIARY
      );
      // intermediary → tokenOut (second hop)
      const secondHop = makeAggV4Pool(
        '0xsecond_hop',
        TOKEN_INTERMEDIARY,
        TOKEN_OUT
      );
      // intermediary → other (second-hop pool for the intermediary token)
      const secondHopOther = makeAggV4Pool(
        '0xsecond_hop_other',
        TOKEN_INTERMEDIARY,
        TOKEN_OTHER
      );

      const result = await selector.filterPools(
        [firstHop, secondHop, secondHopOther],
        ChainId.MAINNET,
        tokenIn,
        tokenOut,
        Protocol.V4,
        undefined,
        EMPTY_NAMESPACE_CONTEXT,
        ctx
      );

      const ids = result.map(p => p.id);
      expect(ids).toContain('0xfirst_hop');
      expect(ids).toContain('0xsecond_hop');
      // secondHopOther may or may not be included depending on topNSecondHopPairs
      // and dedup logic, but the key point is that intermediary token was discovered
    });

    it('selects top N pools by TVL when more pools than limit', async () => {
      // Create more pools than the topNPairs limit (2)
      const pools = [
        makeAggV4Pool(
          '0xhigh_tvl',
          TOKEN_IN,
          TOKEN_OUT,
          AGG_HOOK_FLUID_LITE,
          9000
        ),
        makeAggV4Pool(
          '0xmed_tvl',
          TOKEN_OTHER,
          TOKEN_INTERMEDIARY,
          AGG_HOOK_FLUID_LITE,
          5000
        ),
        makeAggV4Pool(
          '0xlow_tvl_1',
          TOKEN_INTERMEDIARY,
          TOKEN_IN,
          AGG_HOOK_FLUID_LITE,
          1000
        ),
        makeAggV4Pool(
          '0xlow_tvl_2',
          TOKEN_INTERMEDIARY,
          TOKEN_OUT,
          AGG_HOOK_FLUID_LITE,
          500
        ),
        makeAggV4Pool(
          '0xlow_tvl_3',
          TOKEN_OTHER,
          TOKEN_IN,
          AGG_HOOK_FLUID_LITE,
          200
        ),
      ];

      const result = await selector.filterPools(
        pools,
        ChainId.MAINNET,
        tokenIn,
        tokenOut,
        Protocol.V4,
        undefined,
        EMPTY_NAMESPACE_CONTEXT,
        ctx
      );

      // Should include pools — higher TVL pools should be preferred in each category
      expect(result.length).toBeGreaterThan(0);
      // The highest TVL direct pair should always be included
      expect(result.map(p => p.id)).toContain('0xhigh_tvl');
    });

    it('includes WETH pools for tokenIn and tokenOut when available', async () => {
      const directPool = makeAggV4Pool('0xdirect', TOKEN_IN, TOKEN_OUT);
      const wethTokenInPool = makeAggV4Pool('0xweth_in', WETH, TOKEN_IN);
      const wethTokenOutPool = makeAggV4Pool('0xweth_out', WETH, TOKEN_OUT);

      const result = await selector.filterPools(
        [directPool, wethTokenInPool, wethTokenOutPool],
        ChainId.MAINNET,
        tokenIn,
        tokenOut,
        Protocol.V4,
        undefined,
        EMPTY_NAMESPACE_CONTEXT,
        ctx
      );

      const ids = result.map(p => p.id);
      expect(ids).toContain('0xdirect');
      expect(ids).toContain('0xweth_in');
      expect(ids).toContain('0xweth_out');
    });

    it('should return empty array when no pools are provided', async () => {
      const result = await selector.filterPools(
        [],
        ChainId.MAINNET,
        tokenIn,
        tokenOut,
        Protocol.V4,
        undefined,
        EMPTY_NAMESPACE_CONTEXT,
        ctx
      );
      expect(result).toHaveLength(0);
    });
  });

  describe('default aggHooksPoolSelectionConfig (direct + one-hop only)', () => {
    it('returns direct and one-hop pairs with default config', async () => {
      const directPool = makeAggV4Pool('0xdirect', TOKEN_IN, TOKEN_OUT);
      const tokenInOnlyPool = makeAggV4Pool('0xin_only', TOKEN_IN, TOKEN_OTHER);
      const tokenOutOnlyPool = makeAggV4Pool(
        '0xout_only',
        TOKEN_OTHER,
        TOKEN_OUT
      );

      const result = await selectorDefault.filterPools(
        [directPool, tokenInOnlyPool, tokenOutOnlyPool],
        ChainId.MAINNET,
        tokenIn,
        tokenOut,
        Protocol.V4,
        undefined,
        EMPTY_NAMESPACE_CONTEXT,
        ctx
      );

      // With topNOneHopPairs=5, direct pairs + one-hop pairs should be returned.
      expect(result).toHaveLength(3);
      const ids = result.map(p => p.id);
      expect(ids).toContain('0xdirect');
      expect(ids).toContain('0xin_only');
      expect(ids).toContain('0xout_only');
    });

    it('returns one-hop pairs even when no direct pair exists', async () => {
      const tokenInOnlyPool = makeAggV4Pool('0xin_only', TOKEN_IN, TOKEN_OTHER);
      const result = await selectorDefault.filterPools(
        [tokenInOnlyPool],
        ChainId.MAINNET,
        tokenIn,
        tokenOut,
        Protocol.V4,
        undefined,
        EMPTY_NAMESPACE_CONTEXT,
        ctx
      );
      // topNOneHopPairs=5 allows one-hop pools through
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('0xin_only');
    });
  });

  describe('hooksOptions filtering', () => {
    it('should return agg hook pools when hooksOptions is undefined', async () => {
      const pool = makeAggV4Pool('0xpool', TOKEN_IN, TOKEN_OUT);
      const result = await selector.filterPools(
        [pool],
        ChainId.MAINNET,
        tokenIn,
        tokenOut,
        Protocol.V4,
        undefined,
        EMPTY_NAMESPACE_CONTEXT,
        ctx
      );
      expect(result).toHaveLength(1);
    });

    it('should return agg hook pools when hooksOptions is HOOKS_INCLUSIVE', async () => {
      const pool = makeAggV4Pool('0xpool', TOKEN_IN, TOKEN_OUT);
      const result = await selector.filterPools(
        [pool],
        ChainId.MAINNET,
        tokenIn,
        tokenOut,
        Protocol.V4,
        HooksOptions.HOOKS_INCLUSIVE,
        EMPTY_NAMESPACE_CONTEXT,
        ctx
      );
      expect(result).toHaveLength(1);
    });

    it('should return agg hook pools when hooksOptions is HOOKS_ONLY (all agg pools have non-zero hooks)', async () => {
      const pool = makeAggV4Pool('0xpool', TOKEN_IN, TOKEN_OUT);
      const result = await selector.filterPools(
        [pool],
        ChainId.MAINNET,
        tokenIn,
        tokenOut,
        Protocol.V4,
        HooksOptions.HOOKS_ONLY,
        EMPTY_NAMESPACE_CONTEXT,
        ctx
      );
      expect(result).toHaveLength(1);
    });

    it('should return no pools when hooksOptions is NO_HOOKS (all agg pools have non-zero hooks)', async () => {
      const pool = makeAggV4Pool('0xpool', TOKEN_IN, TOKEN_OUT);
      const result = await selector.filterPools(
        [pool],
        ChainId.MAINNET,
        tokenIn,
        tokenOut,
        Protocol.V4,
        HooksOptions.NO_HOOKS,
        EMPTY_NAMESPACE_CONTEXT,
        ctx
      );
      expect(result).toHaveLength(0);
    });
  });

  describe('protocol-specific pre-filter', () => {
    it('returns only FluidDexLite pools when protocol is FLUIDDEXLITE', async () => {
      const fluidPool = makeAggV4Pool(
        '0xfluid',
        TOKEN_IN,
        TOKEN_OUT,
        AGG_HOOK_FLUID_LITE
      );
      const stablePool = makeAggV4Pool(
        '0xstable',
        TOKEN_IN,
        TOKEN_OUT,
        AGG_HOOK_STABLE_SWAP
      );

      const result = await selector.filterPools(
        [fluidPool, stablePool],
        ChainId.MAINNET,
        tokenIn,
        tokenOut,
        Protocol.FLUIDDEXLITE,
        undefined,
        EMPTY_NAMESPACE_CONTEXT,
        ctx
      );

      const ids = result.map(p => p.id);
      expect(ids).toContain('0xfluid');
      expect(ids).not.toContain('0xstable');
    });

    it('returns only CurveStableSwapNG pools when protocol is CURVESTABLESWAPNG', async () => {
      const fluidPool = makeAggV4Pool(
        '0xfluid',
        TOKEN_IN,
        TOKEN_OUT,
        AGG_HOOK_FLUID_LITE
      );
      const stablePool = makeAggV4Pool(
        '0xstable',
        TOKEN_IN,
        TOKEN_OUT,
        AGG_HOOK_STABLE_SWAP
      );

      const result = await selector.filterPools(
        [fluidPool, stablePool],
        ChainId.MAINNET,
        tokenIn,
        tokenOut,
        Protocol.CURVESTABLESWAPNG,
        undefined,
        EMPTY_NAMESPACE_CONTEXT,
        ctx
      );

      const ids = result.map(p => p.id);
      expect(ids).not.toContain('0xfluid');
      expect(ids).toContain('0xstable');
    });

    it('includes pools from all agg hook protocols when protocol is V4 (fallback)', async () => {
      const fluidPool = makeAggV4Pool(
        '0xfluid',
        TOKEN_IN,
        TOKEN_OUT,
        AGG_HOOK_FLUID_LITE
      );
      const stablePool = makeAggV4Pool(
        '0xstable',
        TOKEN_IN,
        TOKEN_OUT,
        AGG_HOOK_STABLE_SWAP
      );

      const result = await selector.filterPools(
        [fluidPool, stablePool],
        ChainId.MAINNET,
        tokenIn,
        tokenOut,
        Protocol.V4,
        undefined,
        EMPTY_NAMESPACE_CONTEXT,
        ctx
      );

      const ids = result.map(p => p.id);
      expect(ids).toContain('0xfluid');
      expect(ids).toContain('0xstable');
    });

    it('returns empty when no pools match the specific protocol address list', async () => {
      // AGG_HOOK_STABLE_SWAP belongs to CURVESTABLESWAPNG, not FLUIDDEXLITE
      const stablePool = makeAggV4Pool(
        '0xstable',
        TOKEN_IN,
        TOKEN_OUT,
        AGG_HOOK_STABLE_SWAP
      );

      const result = await selector.filterPools(
        [stablePool],
        ChainId.MAINNET,
        tokenIn,
        tokenOut,
        Protocol.FLUIDDEXLITE,
        undefined,
        EMPTY_NAMESPACE_CONTEXT,
        ctx
      );

      expect(result).toHaveLength(0);
    });
  });

  describe('unsupported token filtering', () => {
    it('should exclude pools whose tokens are on the routing block list', async () => {
      // 0xd233d1f6fd11640081abb8db125f722b5dc729dc is a real unsupported token on MAINNET
      const unsupportedToken = '0xd233d1f6fd11640081abb8db125f722b5dc729dc';
      const badPool = makeAggV4Pool(
        '0xbad',
        unsupportedToken,
        TOKEN_OUT,
        AGG_HOOK_FLUID_LITE
      );
      const goodPool = makeAggV4Pool('0xgood', TOKEN_IN, TOKEN_OUT);

      const result = await selector.filterPools(
        [badPool, goodPool],
        ChainId.MAINNET,
        tokenIn,
        tokenOut,
        Protocol.V4,
        undefined,
        EMPTY_NAMESPACE_CONTEXT,
        ctx
      );

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('0xgood');
    });
  });

  describe('no manuallyGenerateDirectPairs fallback', () => {
    it('does not generate synthetic direct pairs when none exist in pool universe', async () => {
      // Only non-direct pools — BasicTopPoolsSelector would fall back to
      // manuallyGenerateDirectPairs, but AggHooksTopPoolsSelector should not.
      const tokenInOnlyPool = makeAggV4Pool('0xin_only', TOKEN_IN, TOKEN_OTHER);

      const result = await selector.filterPools(
        [tokenInOnlyPool],
        ChainId.MAINNET,
        tokenIn,
        tokenOut,
        Protocol.V4,
        undefined,
        EMPTY_NAMESPACE_CONTEXT,
        ctx
      );

      // tokenIn-only pool is included via one-hop heuristic, but no synthetic
      // direct pair (tokenIn ↔ tokenOut) should be fabricated.
      const ids = result.map(p => p.id);
      expect(ids).toContain('0xin_only');
      // No pool with both tokenIn AND tokenOut should appear
      const directPools = result.filter(
        p =>
          (p.token0.id.toLowerCase() === TOKEN_IN.toLowerCase() &&
            p.token1.id.toLowerCase() === TOKEN_OUT.toLowerCase()) ||
          (p.token0.id.toLowerCase() === TOKEN_OUT.toLowerCase() &&
            p.token1.id.toLowerCase() === TOKEN_IN.toLowerCase())
      );
      expect(directPools).toHaveLength(0);
    });
  });
});

// Regression tests pinning the upper-bound formula. The cache-size guardrail
// in BaseCachingPoolDiscoverer derives its limit from getMaxFilteredPoolCount,
// so any drift here changes the cache write threshold. If you bump a
// poolSelectionConfig limit or add a fee tier, expect these to fail and update
// both the formula and these pinned values together.
describe('getMaxFilteredPoolCount', () => {
  it('returns 75 for defaultPoolSelectionConfig', () => {
    // 7 (max(topNDirectPairs=2, MAX_MANUAL_DIRECT_PAIRS_FALLBACK=7))
    // + 10 (2 × topNOneHopPairs=5)
    // + 40 (10 intermediaries × (topNSecondHopPairs=2 + WETH + ETH))
    // + 2  (topNPairs)
    // + 12 (2 × topNWithBaseToken=6)
    // + 4  (top WETH/ETH × {tokenIn, tokenOut})
    // = 75
    expect(getMaxFilteredPoolCount(defaultPoolSelectionConfig)).toBe(75);
  });

  it('MAX_MANUAL_DIRECT_PAIRS_FALLBACK matches BASE/V3 fee-tier count', () => {
    // BASE has the most V3 fee tiers (V3FeeAmountsBase.length = 7) and is the
    // worst case for manuallyGenerateDirectPairs. If a new fee tier is added
    // anywhere, this constant should grow and the pinned value above must be
    // updated.
    expect(MAX_MANUAL_DIRECT_PAIRS_FALLBACK).toBe(7);
  });
});
