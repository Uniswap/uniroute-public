import {describe, beforeEach, it, expect, vi} from 'vitest';
import {
  BasicTopPoolsSelector,
  getPoolTVL,
  buildTokenPoolIndex,
} from './TopPoolsSelector';
import {ChainId} from '../../lib/config';
import {UniProtocol} from '../../models/pool/UniProtocol';
import {Context} from '@uniswap/lib-uni/context';
import {Address} from '../../models/address/Address';
import {IChainRepository} from '../../stores/chain/IChainRepository';
import {V2PoolInfo, V3PoolInfo, V4PoolInfo} from './interface';
import {HardcodedChainRepository} from '../../stores/chain/hardcoded/HardcodedChainRepository';
import {
  BASE_TOKENS_PER_CHAIN,
  WRAPPED_NATIVE_CURRENCY,
} from '../../lib/tokenUtils';
import {HooksOptions} from 'src/models/hooks/HooksOptions';
import {ADDRESS_ZERO} from '@uniswap/router-sdk';
import {poolSelectionConfig} from 'src/lib/config';

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
        UniProtocol.V2,
        undefined,
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
        UniProtocol.V3,
        undefined,
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
        UniProtocol.V4,
        undefined,
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
        UniProtocol.V2,
        undefined,
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
        UniProtocol.V2,
        undefined,
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
        UniProtocol.V4,
        HooksOptions.HOOKS_INCLUSIVE,
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
        UniProtocol.V4,
        HooksOptions.NO_HOOKS,
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
        UniProtocol.V4,
        HooksOptions.HOOKS_ONLY,
        ctx
      );

      expect(result).toHaveLength(1);
      expect((result[0] as V4PoolInfo).hooks).toBe(
        '0x1234567890123456789012345678901234567890'
      );
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
        UniProtocol.V2,
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
        UniProtocol.V2,
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
        UniProtocol.V3,
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
          'UNSUPPORTED' as UniProtocol,
          ChainId.MAINNET,
          tokenIn.address,
          tokenOut.address,
          selectedPoolIds
        )
      ).rejects.toThrow('Unsupported protocol UNSUPPORTED');
    });
  });
});
