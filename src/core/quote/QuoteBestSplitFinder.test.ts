import {describe, beforeEach, it, expect, vi} from 'vitest';
import {QuoteBestSplitFinder} from './QuoteBestSplitFinder';
import {QuoteBasic} from '../../models/quote/QuoteBasic';
import {RouteBasic} from '../../models/route/RouteBasic';
import {ChainId} from '../../lib/config';
import {Context as UniContext} from '@uniswap/lib-uni/context';
import {ADDRESS_ZERO} from '@uniswap/v3-sdk';
import {WRAPPED_NATIVE_CURRENCY} from '../../lib/tokenUtils';
import {Address} from '../../models/address/Address';
import {TradeType} from '../../models/quote/TradeType';
import {Protocol} from '../../models/pool/Protocol';
import {V4Pool} from '../../models/pool/V4Pool';
import {STABLE_SWAP_NG} from '../../lib/poolCaching/util/aggHooksAddressesAllowlist';

// Extends V4Pool so `pool instanceof V4Pool` is true — required by
// `isAggHookPool` / `routeUsesAggHook` to recognize hooked pools in tests.
// The protocol getter is overridden back to V3 for parity with the original
// MockPool behavior the rest of the test suite relies on.
class MockPool extends V4Pool {
  constructor(
    token0: Address,
    token1: Address,
    address: Address,
    hooks?: string
  ) {
    super(
      token0,
      token1,
      500,
      10,
      hooks ?? '0x0000000000000000000000000000000000000000',
      0n,
      address.address,
      0n,
      0n
    );
  }

  override get protocol(): Protocol {
    return Protocol.V3;
  }

  override toString(): string {
    return `MockPool(${this.address})`;
  }
}

describe('QuoteBestSplitFinder', () => {
  let finder: QuoteBestSplitFinder<MockPool>;
  let mockContext: UniContext;
  let mockToken0: Address;
  let mockToken1: Address;
  let mockWrappedNative: Address;

  beforeEach(() => {
    finder = new QuoteBestSplitFinder();
    mockContext = {
      logger: {
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
      },
      metrics: {
        count: vi.fn().mockResolvedValue(undefined),
        gauge: vi.fn(),
        timing: vi.fn(),
      },
      state: new Map(),
      set: vi.fn(),
      mustGet: vi.fn(),
      clear: vi.fn(),
      has: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
      entries: vi.fn(),
      keys: vi.fn(),
      values: vi.fn(),
      size: 0,
    } as unknown as UniContext;

    mockToken0 = new Address('0x1111111111111111111111111111111111111111');
    mockToken1 = new Address('0x2222222222222222222222222222222222222222');
    mockWrappedNative = new Address(
      WRAPPED_NATIVE_CURRENCY[ChainId.MAINNET]!.address
    );
  });

  const createMockPool = (
    token0: Address,
    token1: Address,
    address: string,
    hooks?: string
  ): MockPool =>
    new MockPool(token0, token1, new Address(address.padEnd(42, '0')), hooks);

  const createMockRoute = (
    pools: MockPool[],
    percentage: number
  ): RouteBasic<MockPool> =>
    ({
      path: pools,
      percentage,
    }) as RouteBasic<MockPool>;

  const createMockQuote = (
    route: RouteBasic<MockPool>,
    amount: bigint
  ): QuoteBasic =>
    ({
      route,
      amount,
    }) as QuoteBasic;

  describe('findBestSplits', () => {
    it('should throw error for invalid percentage step', async () => {
      const percentageToQuotes = new Map<number, QuoteBasic[]>();

      await expect(async () =>
        finder.findBestSplits(
          ChainId.MAINNET,
          percentageToQuotes,
          3, // invalid step
          2,
          5,
          1000,
          TradeType.ExactIn,
          [],
          mockContext
        )
      ).rejects.toThrowError('Percentage step must be between 5 and 100');
    });

    it('should find best single route when maxSplits is 1', async () => {
      const pool1 = createMockPool(
        mockToken0,
        mockToken1,
        '0x3333333333333333333333333333333333333333'
      );
      const route1 = createMockRoute([pool1], 100);
      const quote1 = createMockQuote(route1, 1000n);

      const pool2 = createMockPool(
        mockToken0,
        mockToken1,
        '0x4444444444444444444444444444444444444444'
      );
      const route2 = createMockRoute([pool2], 100);
      const quote2 = createMockQuote(route2, 900n);

      const percentageToQuotes = new Map<number, QuoteBasic[]>([
        [100, [quote1, quote2]],
      ]);

      const result = await finder.findBestSplits(
        ChainId.MAINNET,
        percentageToQuotes,
        10,
        1, // maxSplits
        5,
        1000,
        TradeType.ExactIn,
        [],
        mockContext
      );

      expect(result).toHaveLength(2);
      expect(result[0]).toHaveLength(1);
      expect(result[0][0].percentage).toBe(100);
      expect(result[1]).toHaveLength(1);
      expect(result[1][0].percentage).toBe(100);
    });

    it('should find best split routes with multiple splits', async () => {
      const pool1 = createMockPool(
        mockToken0,
        mockToken1,
        '0x3333333333333333333333333333333333333333'
      );
      const route1 = createMockRoute([pool1], 60);
      const quote1 = createMockQuote(route1, 600n);

      const pool2 = createMockPool(
        mockToken0,
        mockToken1,
        '0x4444444444444444444444444444444444444444'
      );
      const route2 = createMockRoute([pool2], 40);
      const quote2 = createMockQuote(route2, 420n);

      const percentageToQuotes = new Map<number, QuoteBasic[]>([
        [60, [quote1]],
        [40, [quote2]],
      ]);

      const result = await finder.findBestSplits(
        ChainId.MAINNET,
        percentageToQuotes,
        20,
        2,
        5,
        1000,
        TradeType.ExactIn,
        [],
        mockContext
      );

      expect(result.length).toBeGreaterThan(0);
      // At least one result should have 2 splits
      expect(result.some(routes => routes.length === 2)).toBe(true);
    });

    it('should handle native and wrapped token conflicts', async () => {
      const nativePool = createMockPool(
        mockToken0,
        new Address(ADDRESS_ZERO),
        '0x5555555555555555555555555555555555555555'
      );
      const wrappedPool = createMockPool(
        mockToken0,
        mockWrappedNative,
        '0x6666666666666666666666666666666666666666'
      );

      const nativeRoute = createMockRoute([nativePool], 50);
      const wrappedRoute = createMockRoute([wrappedPool], 50);

      const nativeQuote = createMockQuote(nativeRoute, 500n);
      const wrappedQuote = createMockQuote(wrappedRoute, 500n);

      const percentageToQuotes = new Map<number, QuoteBasic[]>([
        [50, [nativeQuote, wrappedQuote]],
      ]);

      const result = await finder.findBestSplits(
        ChainId.MAINNET,
        percentageToQuotes,
        10,
        2,
        5,
        1000,
        TradeType.ExactIn,
        [],
        mockContext
      );

      // Should not combine native and wrapped routes
      expect(
        result.every(
          routes =>
            !(
              routes.some(r => r === nativeRoute) &&
              routes.some(r => r === wrappedRoute)
            )
        )
      ).toBe(true);
    });

    it('should respect maxSplitRoutes limit', async () => {
      const pools = Array.from({length: 5}, (_, i) =>
        createMockPool(
          mockToken0,
          mockToken1,
          `0x${(i + 1).toString().padStart(40, '0')}`
        )
      );

      // Create quotes for different percentages to encourage splits
      const percentageToQuotes = new Map<number, QuoteBasic[]>();

      // Add 60% quotes
      const quotes60 = pools.map(pool =>
        createMockQuote(createMockRoute([pool], 60), 600n)
      );
      percentageToQuotes.set(60, quotes60);

      // Add 40% quotes
      const quotes40 = pools.map(pool =>
        createMockQuote(createMockRoute([pool], 40), 400n)
      );
      percentageToQuotes.set(40, quotes40);

      const maxSplitRoutes = 3;
      const result = await finder.findBestSplits(
        ChainId.MAINNET,
        percentageToQuotes,
        20,
        2, // maxSplits = 2 to encourage splitting
        maxSplitRoutes,
        1000,
        TradeType.ExactIn,
        [],
        mockContext
      );

      expect(result.length).toBeLessThanOrEqual(maxSplitRoutes);
    });

    it('should timeout after specified duration', async () => {
      const pool = createMockPool(
        mockToken0,
        mockToken1,
        '0x7777777777777777777777777777777777777777'
      );
      const quotes = Array.from({length: 20}, (_, i) =>
        createMockQuote(
          createMockRoute([pool], 5 * (i + 1)),
          BigInt(100 * (i + 1))
        )
      );

      const percentageToQuotes = new Map<number, QuoteBasic[]>();
      for (let i = 5; i <= 100; i += 5) {
        percentageToQuotes.set(i, quotes);
      }

      // Mock Date.now() to simulate timeout
      const startTime = 1000;
      const timeoutMs = 100;
      const dateNowSpy = vi
        .spyOn(Date, 'now')
        .mockImplementationOnce(() => startTime) // First call returns start time
        .mockImplementationOnce(() => startTime + timeoutMs + 1); // Second call returns time that exceeds timeout

      await finder.findBestSplits(
        ChainId.MAINNET,
        percentageToQuotes,
        5,
        5,
        100,
        timeoutMs,
        TradeType.ExactIn,
        [],
        mockContext
      );

      expect(mockContext.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Timed out after')
      );

      dateNowSpy.mockRestore();
    });

    it('does not infer convergence from a truncated level when timeout fires mid-recursion', async () => {
      // Repro of the regression the timed-out-level guard fixes: if
      // generateCombinationsForLevel is cut off mid-recursion the level's
      // "improvement" reads as 0% (it never reached the better combinations),
      // and the low-improvement early-exit branch must not interpret that as
      // convergence — earlyExitReason must stay 'timeout', not flip to
      // 'low_improvement'.

      // Eight distinct pools across percentages 25/50/75/100 give level 4
      // (four 25% routes) a non-empty search space without sharing pools.
      const pools = Array.from({length: 8}, (_, i) =>
        createMockPool(
          mockToken0,
          mockToken1,
          `0x${(0x11 + i).toString(16)}000000000000000000000000000000000000`
        )
      );
      const percentageToQuotes = new Map<number, QuoteBasic[]>();
      percentageToQuotes.set(100, [
        createMockQuote(createMockRoute([pools[0]!], 100), 100n),
      ]);
      percentageToQuotes.set(75, [
        createMockQuote(createMockRoute([pools[1]!], 75), 80n),
      ]);
      percentageToQuotes.set(50, [
        createMockQuote(createMockRoute([pools[2]!], 50), 55n),
        createMockQuote(createMockRoute([pools[3]!], 50), 50n),
      ]);
      percentageToQuotes.set(25, [
        createMockQuote(createMockRoute([pools[4]!], 25), 28n),
        createMockQuote(createMockRoute([pools[5]!], 25), 27n),
        createMockQuote(createMockRoute([pools[6]!], 25), 26n),
        createMockQuote(createMockRoute([pools[7]!], 25), 25n),
      ]);

      // Mock Date.now to let levels 2-3 complete then trip timeout deeper in
      // the recursion. The exact call count needed is implementation-detail-
      // sensitive; 50 free calls comfortably covers levels 1-3 for this small
      // search space, and any later call returns past the timeout horizon.
      const startTime = 1_000_000;
      const timeoutMs = 100;
      let calls = 0;
      const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
        calls += 1;
        if (calls === 1) return startTime;
        if (calls < 50) return startTime + 1; // well within timeoutMs
        return startTime + timeoutMs + 1;
      });

      await finder.findBestSplits(
        ChainId.MAINNET,
        percentageToQuotes,
        25,
        4,
        100,
        timeoutMs,
        TradeType.ExactIn,
        [],
        mockContext
      );

      const debugCalls = (mockContext.logger.debug as ReturnType<typeof vi.fn>)
        .mock.calls;
      const hasLowImprovementExit = debugCalls.some(
        ([msg]) =>
          typeof msg === 'string' && msg.includes('Improvement less than 0.01%')
      );
      expect(hasLowImprovementExit).toBe(false);

      const observabilityCall = debugCalls.find(
        ([msg]) =>
          typeof msg === 'string' &&
          msg === 'QuoteBestSplitFinder observability'
      );
      expect(observabilityCall?.[1]?.earlyExitReason).toBe('timeout');

      dateNowSpy.mockRestore();
    });

    it('should generate all possible combinations respecting MAX_VALID_QUOTES_PER_PERCENTAGE', async () => {
      // Create 3 distinct pools
      const pool1 = createMockPool(
        mockToken0,
        mockToken1,
        '0x1000000000000000000000000000000000000000'
      );
      const pool2 = createMockPool(
        mockToken0,
        mockToken1,
        '0x2000000000000000000000000000000000000000'
      );
      const pool3 = createMockPool(
        mockToken0,
        mockToken1,
        '0x3000000000000000000000000000000000000000'
      );

      // Create routes and quotes for different percentages
      const percentageToQuotes = new Map<number, QuoteBasic[]>();

      // Add 3 quotes for 50% - only top 2 should be considered due to MAX_VALID_QUOTES_PER_PERCENTAGE
      const route1_50 = createMockRoute([pool1], 50);
      const route2_50 = createMockRoute([pool2], 50);
      const route3_50 = createMockRoute([pool3], 50);

      const quotes50 = [
        createMockQuote(route1_50, 500n), // Best quote
        createMockQuote(route2_50, 490n), // Second best quote
        createMockQuote(route3_50, 480n), // Should be ignored due to MAX_VALID_QUOTES_PER_PERCENTAGE
      ];
      percentageToQuotes.set(50, quotes50);

      // Add 2 quotes for 100%
      const route1_100 = createMockRoute([pool1], 100);
      const route2_100 = createMockRoute([pool2], 100);

      const quotes100 = [
        createMockQuote(route1_100, 1000n),
        createMockQuote(route2_100, 990n),
      ];
      percentageToQuotes.set(100, quotes100);

      const result = await finder.findBestSplits(
        ChainId.MAINNET,
        percentageToQuotes,
        50, // percentageStep
        2, // maxSplits
        10, // maxSplitRoutes - high enough to not limit results
        1000,
        TradeType.ExactIn,
        [],
        mockContext
      );

      // Expected combinations:
      // 1. [100%] route1_100
      // 2. [100%] route2_100
      // 3. [50%, 50%] route1_50 + route2_50
      // 4. [50%, 50%] route1_50 + route3_50
      // 5. [50%, 50%] route2_50 + route3_50
      // Note: All routes can be used in splits as long as they don't share pools with other routes in the same split

      expect(result).toHaveLength(5);

      // Check 100% routes
      const fullRoutes = result.filter(r => r.length === 1);
      expect(fullRoutes).toHaveLength(2);
      expect(fullRoutes.some(r => r[0] === route1_100)).toBe(true);
      expect(fullRoutes.some(r => r[0] === route2_100)).toBe(true);

      // Check 50-50 splits
      const splitRoutes = result.filter(r => r.length === 2);
      expect(splitRoutes).toHaveLength(3); // Three possible split combinations

      // Helper to check if a split route matches expected routes
      const matchesSplitRoute = (
        routes: RouteBasic<MockPool>[],
        route1: RouteBasic<MockPool>,
        route2: RouteBasic<MockPool>
      ) => {
        return (
          routes.length === 2 &&
          routes.includes(route1) &&
          routes.includes(route2)
        );
      };

      // Verify all expected split combinations exist
      expect(
        splitRoutes.some(routes =>
          matchesSplitRoute(routes, route1_50, route2_50)
        )
      ).toBe(true);
      expect(
        splitRoutes.some(routes =>
          matchesSplitRoute(routes, route1_50, route3_50)
        )
      ).toBe(true);
      expect(
        splitRoutes.some(routes =>
          matchesSplitRoute(routes, route2_50, route3_50)
        )
      ).toBe(true);

      // Verify no route is used twice in any split
      expect(
        result.every(routes => new Set(routes).size === routes.length)
      ).toBe(true);
    });
  });

  describe('filterAndSortResults', () => {
    it('should return all results when length is less than or equal to maxSplitRoutes', () => {
      const pool1 = createMockPool(
        mockToken0,
        mockToken1,
        '0x1000000000000000000000000000000000000000'
      );
      const pool2 = createMockPool(
        mockToken0,
        mockToken1,
        '0x2000000000000000000000000000000000000000'
      );

      const route1 = createMockRoute([pool1], 100);
      const route2 = createMockRoute([pool2], 100);
      const route3 = createMockRoute([pool1], 50);

      const quoteMap = new Map<RouteBasic<MockPool>, QuoteBasic>([
        [route1, createMockQuote(route1, 1000n)],
        [route2, createMockQuote(route2, 900n)],
        [route3, createMockQuote(route3, 500n)],
      ]);

      const results = [[route1], [route2], [route3, route3]];
      const maxSplitRoutes = 5;

      const filtered = finder['filterAndSortResults'](
        results,
        maxSplitRoutes,
        quoteMap,
        TradeType.ExactIn
      );

      // Results should be sorted by amount in descending order for ExactIn
      // route1: 1000n, route2: 900n, [route3, route3]: 1000n (500n + 500n)
      // So order should be: [route1], [route3, route3], [route2]
      expect(filtered).toEqual([[route1], [route3, route3], [route2]]);
    });

    it('should prioritize 100% routes over split routes', () => {
      const pool1 = createMockPool(
        mockToken0,
        mockToken1,
        '0x1000000000000000000000000000000000000000'
      );
      const pool2 = createMockPool(
        mockToken0,
        mockToken1,
        '0x2000000000000000000000000000000000000000'
      );
      const pool3 = createMockPool(
        mockToken0,
        mockToken1,
        '0x3000000000000000000000000000000000000000'
      );

      const route100_1 = createMockRoute([pool1], 100);
      const route100_2 = createMockRoute([pool2], 100);
      const route50_1 = createMockRoute([pool3], 50);
      const route50_2 = createMockRoute([pool1], 50);

      const quoteMap = new Map<RouteBasic<MockPool>, QuoteBasic>([
        [route100_1, createMockQuote(route100_1, 1000n)],
        [route100_2, createMockQuote(route100_2, 900n)],
        [route50_1, createMockQuote(route50_1, 500n)],
        [route50_2, createMockQuote(route50_2, 450n)],
      ]);

      const results = [
        [route100_1], // 1000n
        [route100_2], // 900n
        [route50_1, route50_2], // 950n total
        [route50_1, route50_1], // 1000n total
      ];
      const maxSplitRoutes = 3;

      const filtered = finder['filterAndSortResults'](
        results,
        maxSplitRoutes,
        quoteMap,
        TradeType.ExactIn
      );

      expect(filtered).toHaveLength(3);
      // Should keep both 100% routes and the best split route
      expect(filtered).toContainEqual([route100_1]);
      expect(filtered).toContainEqual([route100_2]);
      expect(filtered).toContainEqual([route50_1, route50_1]); // Best split route
    });

    it('should sort split routes by total amount in descending order', () => {
      const pool1 = createMockPool(
        mockToken0,
        mockToken1,
        '0x1000000000000000000000000000000000000000'
      );
      const pool2 = createMockPool(
        mockToken0,
        mockToken1,
        '0x2000000000000000000000000000000000000000'
      );
      const pool3 = createMockPool(
        mockToken0,
        mockToken1,
        '0x3000000000000000000000000000000000000000'
      );

      const route50_1 = createMockRoute([pool1], 50);
      const route50_2 = createMockRoute([pool2], 50);
      const route50_3 = createMockRoute([pool3], 50);

      const quoteMap = new Map<RouteBasic<MockPool>, QuoteBasic>([
        [route50_1, createMockQuote(route50_1, 600n)],
        [route50_2, createMockQuote(route50_2, 500n)],
        [route50_3, createMockQuote(route50_3, 400n)],
      ]);

      const results = [
        [route50_1, route50_2], // 1100n total
        [route50_2, route50_3], // 900n total
        [route50_1, route50_3], // 1000n total
      ];
      const maxSplitRoutes = 2;

      const filtered = finder['filterAndSortResults'](
        results,
        maxSplitRoutes,
        quoteMap,
        TradeType.ExactIn
      );

      expect(filtered).toHaveLength(2);
      // Should return the two highest scoring split combinations
      expect(filtered[0]).toEqual([route50_1, route50_2]); // 1100n
      expect(filtered[1]).toEqual([route50_1, route50_3]); // 1000n
    });

    it('should handle case where no 100% routes exist', () => {
      const pool1 = createMockPool(
        mockToken0,
        mockToken1,
        '0x1000000000000000000000000000000000000000'
      );
      const pool2 = createMockPool(
        mockToken0,
        mockToken1,
        '0x2000000000000000000000000000000000000000'
      );

      const route60 = createMockRoute([pool1], 60);
      const route40 = createMockRoute([pool2], 40);

      const quoteMap = new Map<RouteBasic<MockPool>, QuoteBasic>([
        [route60, createMockQuote(route60, 600n)],
        [route40, createMockQuote(route40, 400n)],
      ]);

      const results = [
        [route60, route40], // 1000n total
        [route60, route60], // 1200n total (invalid but for testing)
      ];
      const maxSplitRoutes = 1;

      const filtered = finder['filterAndSortResults'](
        results,
        maxSplitRoutes,
        quoteMap,
        TradeType.ExactIn
      );

      expect(filtered).toHaveLength(1);
      expect(filtered[0]).toEqual([route60, route60]); // Higher total amount
    });

    it('should handle case where only 100% routes exist', () => {
      const pool1 = createMockPool(
        mockToken0,
        mockToken1,
        '0x1000000000000000000000000000000000000000'
      );
      const pool2 = createMockPool(
        mockToken0,
        mockToken1,
        '0x2000000000000000000000000000000000000000'
      );

      const route100_1 = createMockRoute([pool1], 100);
      const route100_2 = createMockRoute([pool2], 100);

      const quoteMap = new Map<RouteBasic<MockPool>, QuoteBasic>([
        [route100_1, createMockQuote(route100_1, 1000n)],
        [route100_2, createMockQuote(route100_2, 900n)],
      ]);

      const results = [[route100_1], [route100_2]];
      const maxSplitRoutes = 3;

      const filtered = finder['filterAndSortResults'](
        results,
        maxSplitRoutes,
        quoteMap,
        TradeType.ExactIn
      );

      expect(filtered).toHaveLength(2);
      expect(filtered).toContainEqual([route100_1]);
      expect(filtered).toContainEqual([route100_2]);
    });

    it('should handle empty results array', () => {
      const quoteMap = new Map<RouteBasic<MockPool>, QuoteBasic>();
      const results: RouteBasic<MockPool>[][] = [];
      const maxSplitRoutes = 5;

      const filtered = finder['filterAndSortResults'](
        results,
        maxSplitRoutes,
        quoteMap,
        TradeType.ExactIn
      );

      expect(filtered).toEqual([]);
    });

    it('should handle case where maxSplitRoutes is 0', () => {
      const pool1 = createMockPool(
        mockToken0,
        mockToken1,
        '0x1000000000000000000000000000000000000000'
      );

      const route100 = createMockRoute([pool1], 100);
      const quoteMap = new Map<RouteBasic<MockPool>, QuoteBasic>([
        [route100, createMockQuote(route100, 1000n)],
      ]);

      const results = [[route100]];
      const maxSplitRoutes = 0;

      const filtered = finder['filterAndSortResults'](
        results,
        maxSplitRoutes,
        quoteMap,
        TradeType.ExactIn
      );

      expect(filtered).toEqual([]);
    });

    it('should sort split routes correctly based on trade type', () => {
      const pool1 = createMockPool(
        mockToken0,
        mockToken1,
        '0x1000000000000000000000000000000000000000'
      );
      const pool2 = createMockPool(
        mockToken0,
        mockToken1,
        '0x2000000000000000000000000000000000000000'
      );
      const pool3 = createMockPool(
        mockToken0,
        mockToken1,
        '0x3000000000000000000000000000000000000000'
      );

      const route50_1 = createMockRoute([pool1], 50);
      const route50_2 = createMockRoute([pool2], 50);
      const route50_3 = createMockRoute([pool3], 50);

      // Create quotes with clearly different amounts
      const quoteMap = new Map<RouteBasic<MockPool>, QuoteBasic>([
        [route50_1, createMockQuote(route50_1, 100n)], // Lowest amount
        [route50_2, createMockQuote(route50_2, 1000n)], // Highest amount
        [route50_3, createMockQuote(route50_3, 500n)], // Middle amount
      ]);

      // Create combinations with clearly different total amounts
      const results = [
        [route50_1, route50_1], // 200n total (100n + 100n)
        [route50_2, route50_2], // 2000n total (1000n + 1000n)
        [route50_3, route50_3], // 1000n total (500n + 500n)
      ];
      const maxSplitRoutes = 2; // This will force sorting since we have 3 results

      // Test ExactIn - should prefer higher amounts (descending order)
      const filteredExactIn = finder['filterAndSortResults'](
        results,
        maxSplitRoutes,
        quoteMap,
        TradeType.ExactIn
      );

      expect(filteredExactIn).toHaveLength(2);
      // For ExactIn, higher amounts are better, so 2000n should come first, then 1000n
      expect(filteredExactIn[0]).toEqual([route50_2, route50_2]); // 2000n total (highest)
      expect(filteredExactIn[1]).toEqual([route50_3, route50_3]); // 1000n total (middle)

      // Test ExactOut - should prefer lower amounts (ascending order)
      const filteredExactOut = finder['filterAndSortResults'](
        results,
        maxSplitRoutes,
        quoteMap,
        TradeType.ExactOut
      );

      expect(filteredExactOut).toHaveLength(2);
      // For ExactOut, lower amounts are better, so 200n should come first, then 1000n
      expect(filteredExactOut[0]).toEqual([route50_1, route50_1]); // 200n total (lowest)
      expect(filteredExactOut[1]).toEqual([route50_3, route50_3]); // 1000n total (middle)
    });

    it('should sort results even when results.length <= maxSplitRoutes', () => {
      const pool1 = createMockPool(
        mockToken0,
        mockToken1,
        '0x1000000000000000000000000000000000000000'
      );
      const pool2 = createMockPool(
        mockToken0,
        mockToken1,
        '0x2000000000000000000000000000000000000000'
      );

      const route50_1 = createMockRoute([pool1], 50);
      const route50_2 = createMockRoute([pool2], 50);

      // Create quotes with different amounts
      const quoteMap = new Map<RouteBasic<MockPool>, QuoteBasic>([
        [route50_1, createMockQuote(route50_1, 100n)], // Lower amount
        [route50_2, createMockQuote(route50_2, 1000n)], // Higher amount
      ]);

      // Create combinations with different total amounts
      const results = [
        [route50_1, route50_1], // 200n total (100n + 100n)
        [route50_2, route50_2], // 2000n total (1000n + 1000n)
      ];
      const maxSplitRoutes = 3; // More than results.length, so early return

      // Test ExactIn - should prefer higher amounts (descending order)
      const filteredExactIn = finder['filterAndSortResults'](
        results,
        maxSplitRoutes,
        quoteMap,
        TradeType.ExactIn
      );

      expect(filteredExactIn).toHaveLength(2);
      // For ExactIn, higher amounts are better, so 2000n should come first
      expect(filteredExactIn[0]).toEqual([route50_2, route50_2]); // 2000n total (highest)
      expect(filteredExactIn[1]).toEqual([route50_1, route50_1]); // 200n total (lowest)

      // Test ExactOut - should prefer lower amounts (ascending order)
      const filteredExactOut = finder['filterAndSortResults'](
        results,
        maxSplitRoutes,
        quoteMap,
        TradeType.ExactOut
      );

      expect(filteredExactOut).toHaveLength(2);
      // For ExactOut, lower amounts are better, so 200n should come first
      expect(filteredExactOut[0]).toEqual([route50_1, route50_1]); // 200n total (lowest)
      expect(filteredExactOut[1]).toEqual([route50_2, route50_2]); // 2000n total (highest)
    });

    it('should handle case where maxSplitRoutes is less than number of 100% routes', () => {
      const pool1 = createMockPool(
        mockToken0,
        mockToken1,
        '0x1000000000000000000000000000000000000000'
      );
      const pool2 = createMockPool(
        mockToken0,
        mockToken1,
        '0x2000000000000000000000000000000000000000'
      );

      const route100_1 = createMockRoute([pool1], 100);
      const route100_2 = createMockRoute([pool2], 100);

      const quoteMap = new Map<RouteBasic<MockPool>, QuoteBasic>([
        [route100_1, createMockQuote(route100_1, 1000n)],
        [route100_2, createMockQuote(route100_2, 900n)],
      ]);

      const results = [[route100_1], [route100_2]];
      const maxSplitRoutes = 1;

      const filtered = finder['filterAndSortResults'](
        results,
        maxSplitRoutes,
        quoteMap,
        TradeType.ExactIn
      );

      expect(filtered).toHaveLength(1);
      // Should keep the first 100% route (order preserved for 100% routes)
      expect(filtered[0]).toEqual([route100_1]);
    });

    it('should handle missing quotes in quoteMap gracefully', () => {
      const pool1 = createMockPool(
        mockToken0,
        mockToken1,
        '0x1000000000000000000000000000000000000000'
      );
      const pool2 = createMockPool(
        mockToken0,
        mockToken1,
        '0x2000000000000000000000000000000000000000'
      );

      const route50_1 = createMockRoute([pool1], 50);
      const route50_2 = createMockRoute([pool2], 50);

      // Only include one quote in the map
      const quoteMap = new Map<RouteBasic<MockPool>, QuoteBasic>([
        [route50_1, createMockQuote(route50_1, 500n)],
        // route50_2 is missing from quoteMap
      ]);

      const results = [
        [route50_1, route50_2], // 500n + 0n = 500n total
        [route50_1, route50_1], // 500n + 500n = 1000n total
      ];
      const maxSplitRoutes = 1;

      const filtered = finder['filterAndSortResults'](
        results,
        maxSplitRoutes,
        quoteMap,
        TradeType.ExactIn
      );

      expect(filtered).toHaveLength(1);
      expect(filtered[0]).toEqual([route50_1, route50_1]); // Higher total amount
    });
  });

  describe('scoreAndSortCombinations', () => {
    it('should sort combinations in descending order for ExactIn trade type', () => {
      const pool1 = createMockPool(
        mockToken0,
        mockToken1,
        '0x1000000000000000000000000000000000000000'
      );
      const pool2 = createMockPool(
        mockToken0,
        mockToken1,
        '0x2000000000000000000000000000000000000000'
      );
      const pool3 = createMockPool(
        mockToken0,
        mockToken1,
        '0x3000000000000000000000000000000000000000'
      );

      const route1 = createMockRoute([pool1], 50);
      const route2 = createMockRoute([pool2], 50);
      const route3 = createMockRoute([pool3], 50);

      const quoteMap = new Map<RouteBasic<MockPool>, QuoteBasic>([
        [route1, createMockQuote(route1, 100n)], // Lowest amount
        [route2, createMockQuote(route2, 1000n)], // Highest amount
        [route3, createMockQuote(route3, 500n)], // Middle amount
      ]);

      const combinations = [
        [route1, route1], // 200n total (100n + 100n)
        [route2, route2], // 2000n total (1000n + 1000n)
        [route3, route3], // 1000n total (500n + 500n)
      ];

      const result = finder['scoreAndSortCombinations'](
        combinations,
        quoteMap,
        TradeType.ExactIn
      );

      expect(result).toHaveLength(3);
      // For ExactIn, higher amounts should come first (descending order)
      expect(result[0]).toEqual([route2, route2]); // 2000n total (highest)
      expect(result[1]).toEqual([route3, route3]); // 1000n total (middle)
      expect(result[2]).toEqual([route1, route1]); // 200n total (lowest)
    });

    it('should sort combinations in ascending order for ExactOut trade type', () => {
      const pool1 = createMockPool(
        mockToken0,
        mockToken1,
        '0x1000000000000000000000000000000000000000'
      );
      const pool2 = createMockPool(
        mockToken0,
        mockToken1,
        '0x2000000000000000000000000000000000000000'
      );
      const pool3 = createMockPool(
        mockToken0,
        mockToken1,
        '0x3000000000000000000000000000000000000000'
      );

      const route1 = createMockRoute([pool1], 50);
      const route2 = createMockRoute([pool2], 50);
      const route3 = createMockRoute([pool3], 50);

      const quoteMap = new Map<RouteBasic<MockPool>, QuoteBasic>([
        [route1, createMockQuote(route1, 100n)], // Lowest amount
        [route2, createMockQuote(route2, 1000n)], // Highest amount
        [route3, createMockQuote(route3, 500n)], // Middle amount
      ]);

      const combinations = [
        [route1, route1], // 200n total (100n + 100n)
        [route2, route2], // 2000n total (1000n + 1000n)
        [route3, route3], // 1000n total (500n + 500n)
      ];

      const result = finder['scoreAndSortCombinations'](
        combinations,
        quoteMap,
        TradeType.ExactOut
      );

      expect(result).toHaveLength(3);
      // For ExactOut, lower amounts should come first (ascending order)
      expect(result[0]).toEqual([route1, route1]); // 200n total (lowest)
      expect(result[1]).toEqual([route3, route3]); // 1000n total (middle)
      expect(result[2]).toEqual([route2, route2]); // 2000n total (highest)
    });

    it('should handle combinations with missing quotes gracefully', () => {
      const pool1 = createMockPool(
        mockToken0,
        mockToken1,
        '0x1000000000000000000000000000000000000000'
      );
      const pool2 = createMockPool(
        mockToken0,
        mockToken1,
        '0x2000000000000000000000000000000000000000'
      );

      const route1 = createMockRoute([pool1], 50);
      const route2 = createMockRoute([pool2], 50);

      // Only provide quote for route1, route2 will be missing
      const quoteMap = new Map<RouteBasic<MockPool>, QuoteBasic>([
        [route1, createMockQuote(route1, 1000n)],
        // route2 is missing from quoteMap
      ]);

      const combinations = [
        [route1, route1], // 2000n total (1000n + 1000n)
        [route2, route2], // 0n total (0n + 0n due to missing quote)
      ];

      const result = finder['scoreAndSortCombinations'](
        combinations,
        quoteMap,
        TradeType.ExactIn
      );

      expect(result).toHaveLength(2);
      // route1 should come first due to higher amount
      expect(result[0]).toEqual([route1, route1]); // 2000n total
      expect(result[1]).toEqual([route2, route2]); // 0n total
    });

    it('should handle empty combinations array', () => {
      const quoteMap = new Map<RouteBasic<MockPool>, QuoteBasic>();
      const combinations: RouteBasic<MockPool>[][] = [];

      const result = finder['scoreAndSortCombinations'](
        combinations,
        quoteMap,
        TradeType.ExactIn
      );

      expect(result).toHaveLength(0);
      expect(result).toEqual([]);
    });

    it('should handle combinations with equal amounts consistently', () => {
      const pool1 = createMockPool(
        mockToken0,
        mockToken1,
        '0x1000000000000000000000000000000000000000'
      );
      const pool2 = createMockPool(
        mockToken0,
        mockToken1,
        '0x2000000000000000000000000000000000000000'
      );

      const route1 = createMockRoute([pool1], 50);
      const route2 = createMockRoute([pool2], 50);

      const quoteMap = new Map<RouteBasic<MockPool>, QuoteBasic>([
        [route1, createMockQuote(route1, 500n)],
        [route2, createMockQuote(route2, 500n)],
      ]);

      const combinations = [
        [route1, route1], // 1000n total (500n + 500n)
        [route2, route2], // 1000n total (500n + 500n)
      ];

      const result = finder['scoreAndSortCombinations'](
        combinations,
        quoteMap,
        TradeType.ExactIn
      );

      expect(result).toHaveLength(2);
      // Both have equal amounts, order should be stable (same as input order)
      expect(result[0]).toEqual([route1, route1]);
      expect(result[1]).toEqual([route2, route2]);
    });

    it('should handle single route combinations', () => {
      const pool1 = createMockPool(
        mockToken0,
        mockToken1,
        '0x1000000000000000000000000000000000000000'
      );
      const pool2 = createMockPool(
        mockToken0,
        mockToken1,
        '0x2000000000000000000000000000000000000000'
      );

      const route1 = createMockRoute([pool1], 100);
      const route2 = createMockRoute([pool2], 100);

      const quoteMap = new Map<RouteBasic<MockPool>, QuoteBasic>([
        [route1, createMockQuote(route1, 1000n)],
        [route2, createMockQuote(route2, 500n)],
      ]);

      const combinations = [
        [route1], // 1000n total
        [route2], // 500n total
      ];

      const result = finder['scoreAndSortCombinations'](
        combinations,
        quoteMap,
        TradeType.ExactIn
      );

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual([route1]); // 1000n total (higher)
      expect(result[1]).toEqual([route2]); // 500n total (lower)
    });
  });

  describe('routeHasGivenAddressAsInputOrOutput', () => {
    it('should return false for empty route', () => {
      const emptyRoute = createMockRoute([], 100);
      const result = finder['routeHasGivenAddressAsInputOrOutput'](
        emptyRoute,
        mockToken0.address
      );
      expect(result).toBe(false);
    });

    it('should return true for single pool route when address is token0', () => {
      const pool = createMockPool(
        mockToken0,
        mockToken1,
        '0x1111111111111111111111111111111111111111'
      );
      const route = createMockRoute([pool], 100);

      const result = finder['routeHasGivenAddressAsInputOrOutput'](
        route,
        mockToken0.address
      );
      expect(result).toBe(true);
    });

    it('should return true for single pool route when address is token1', () => {
      const pool = createMockPool(
        mockToken0,
        mockToken1,
        '0x1111111111111111111111111111111111111111'
      );
      const route = createMockRoute([pool], 100);

      const result = finder['routeHasGivenAddressAsInputOrOutput'](
        route,
        mockToken1.address
      );
      expect(result).toBe(true);
    });

    it('should return false for single pool route when address is neither token0 nor token1', () => {
      const otherToken = new Address(
        '0x3333333333333333333333333333333333333333'
      );
      const pool = createMockPool(
        mockToken0,
        mockToken1,
        '0x1111111111111111111111111111111111111111'
      );
      const route = createMockRoute([pool], 100);

      const result = finder['routeHasGivenAddressAsInputOrOutput'](
        route,
        otherToken.address
      );
      expect(result).toBe(false);
    });

    it('should return true for multi-pool route when address is tokenIn (first pool token0)', () => {
      // Create a 3-pool route: TokenA -> TokenB -> TokenC -> TokenD
      const tokenA = mockToken0;
      const tokenB = mockToken1;
      const tokenC = new Address('0x3333333333333333333333333333333333333333');
      const tokenD = new Address('0x4444444444444444444444444444444444444444');

      const pool1 = createMockPool(
        tokenA,
        tokenB,
        '0x1111111111111111111111111111111111111111'
      );
      const pool2 = createMockPool(
        tokenB,
        tokenC,
        '0x2222222222222222222222222222222222222222'
      );
      const pool3 = createMockPool(
        tokenC,
        tokenD,
        '0x3333333333333333333333333333333333333333'
      );

      const route = createMockRoute([pool1, pool2, pool3], 100);

      // TokenA should be tokenIn (doesn't appear in second pool)
      const result = finder['routeHasGivenAddressAsInputOrOutput'](
        route,
        tokenA.address
      );
      expect(result).toBe(true);
    });

    it('should return true for multi-pool route when address is tokenIn (first pool token1)', () => {
      // Create a 3-pool route: TokenB -> TokenA -> TokenC -> TokenD
      const tokenA = mockToken0;
      const tokenB = mockToken1;
      const tokenC = new Address('0x3333333333333333333333333333333333333333');
      const tokenD = new Address('0x4444444444444444444444444444444444444444');

      // Pool1: TokenB, TokenA (TokenB is token0, TokenA is token1)
      const pool1 = createMockPool(
        tokenB,
        tokenA,
        '0x1111111111111111111111111111111111111111'
      );
      const pool2 = createMockPool(
        tokenA,
        tokenC,
        '0x2222222222222222222222222222222222222222'
      );
      const pool3 = createMockPool(
        tokenC,
        tokenD,
        '0x3333333333333333333333333333333333333333'
      );

      const route = createMockRoute([pool1, pool2, pool3], 100);

      // TokenB should be tokenIn (doesn't appear in second pool)
      const result = finder['routeHasGivenAddressAsInputOrOutput'](
        route,
        tokenB.address
      );
      expect(result).toBe(true);
    });

    it('should return true for multi-pool route when address is tokenOut', () => {
      // Create a 3-pool route: TokenA -> TokenB -> TokenC -> TokenD
      const tokenA = mockToken0;
      const tokenB = mockToken1;
      const tokenC = new Address('0x3333333333333333333333333333333333333333');
      const tokenD = new Address('0x4444444444444444444444444444444444444444');

      const pool1 = createMockPool(
        tokenA,
        tokenB,
        '0x1111111111111111111111111111111111111111'
      );
      const pool2 = createMockPool(
        tokenB,
        tokenC,
        '0x2222222222222222222222222222222222222222'
      );
      const pool3 = createMockPool(
        tokenC,
        tokenD,
        '0x3333333333333333333333333333333333333333'
      );

      const route = createMockRoute([pool1, pool2, pool3], 100);

      // TokenD should be tokenOut (final token in the path)
      const result = finder['routeHasGivenAddressAsInputOrOutput'](
        route,
        tokenD.address
      );
      expect(result).toBe(true);
    });

    it('should return false for multi-pool route when address is intermediate token', () => {
      // Create a 3-pool route: TokenA -> TokenB -> TokenC -> TokenD
      const tokenA = mockToken0;
      const tokenB = mockToken1;
      const tokenC = new Address('0x3333333333333333333333333333333333333333');
      const tokenD = new Address('0x4444444444444444444444444444444444444444');

      const pool1 = createMockPool(
        tokenA,
        tokenB,
        '0x1111111111111111111111111111111111111111'
      );
      const pool2 = createMockPool(
        tokenB,
        tokenC,
        '0x2222222222222222222222222222222222222222'
      );
      const pool3 = createMockPool(
        tokenC,
        tokenD,
        '0x3333333333333333333333333333333333333333'
      );

      const route = createMockRoute([pool1, pool2, pool3], 100);

      // TokenB and TokenC are intermediate tokens, not input or output
      const resultB = finder['routeHasGivenAddressAsInputOrOutput'](
        route,
        tokenB.address
      );
      expect(resultB).toBe(false);

      const resultC = finder['routeHasGivenAddressAsInputOrOutput'](
        route,
        tokenC.address
      );
      expect(resultC).toBe(false);
    });

    it('should return false for multi-pool route when address is not in any pool', () => {
      // Create a 3-pool route: TokenA -> TokenB -> TokenC -> TokenD
      const tokenA = mockToken0;
      const tokenB = mockToken1;
      const tokenC = new Address('0x3333333333333333333333333333333333333333');
      const tokenD = new Address('0x4444444444444444444444444444444444444444');
      const tokenE = new Address('0x5555555555555555555555555555555555555555'); // Not in route

      const pool1 = createMockPool(
        tokenA,
        tokenB,
        '0x1111111111111111111111111111111111111111'
      );
      const pool2 = createMockPool(
        tokenB,
        tokenC,
        '0x2222222222222222222222222222222222222222'
      );
      const pool3 = createMockPool(
        tokenC,
        tokenD,
        '0x3333333333333333333333333333333333333333'
      );

      const route = createMockRoute([pool1, pool2, pool3], 100);

      const result = finder['routeHasGivenAddressAsInputOrOutput'](
        route,
        tokenE.address
      );
      expect(result).toBe(false);
    });

    it('should handle case-insensitive address comparison', () => {
      const pool = createMockPool(
        mockToken0,
        mockToken1,
        '0x1111111111111111111111111111111111111111'
      );
      const route = createMockRoute([pool], 100);

      // Test with uppercase address
      const result = finder['routeHasGivenAddressAsInputOrOutput'](
        route,
        mockToken0.address.toUpperCase()
      );
      expect(result).toBe(true);
    });

    it('should work with 2-pool route correctly', () => {
      // Create a 2-pool route: TokenA -> TokenB -> TokenC
      const tokenA = mockToken0;
      const tokenB = mockToken1;
      const tokenC = new Address('0x3333333333333333333333333333333333333333');

      const pool1 = createMockPool(
        tokenA,
        tokenB,
        '0x1111111111111111111111111111111111111111'
      );
      const pool2 = createMockPool(
        tokenB,
        tokenC,
        '0x2222222222222222222222222222222222222222'
      );

      const route = createMockRoute([pool1, pool2], 100);

      // TokenA should be tokenIn
      const resultA = finder['routeHasGivenAddressAsInputOrOutput'](
        route,
        tokenA.address
      );
      expect(resultA).toBe(true);

      // TokenC should be tokenOut
      const resultC = finder['routeHasGivenAddressAsInputOrOutput'](
        route,
        tokenC.address
      );
      expect(resultC).toBe(true);

      // TokenB should be intermediate (not input or output)
      const resultB = finder['routeHasGivenAddressAsInputOrOutput'](
        route,
        tokenB.address
      );
      expect(resultB).toBe(false);
    });

    it('should work with 4-pool route correctly', () => {
      // Create a 4-pool route: TokenA -> TokenB -> TokenC -> TokenD -> TokenE
      const tokenA = mockToken0;
      const tokenB = mockToken1;
      const tokenC = new Address('0x3333333333333333333333333333333333333333');
      const tokenD = new Address('0x4444444444444444444444444444444444444444');
      const tokenE = new Address('0x5555555555555555555555555555555555555555');

      const pool1 = createMockPool(
        tokenA,
        tokenB,
        '0x1111111111111111111111111111111111111111'
      );
      const pool2 = createMockPool(
        tokenB,
        tokenC,
        '0x2222222222222222222222222222222222222222'
      );
      const pool3 = createMockPool(
        tokenC,
        tokenD,
        '0x3333333333333333333333333333333333333333'
      );
      const pool4 = createMockPool(
        tokenD,
        tokenE,
        '0x4444444444444444444444444444444444444444'
      );

      const route = createMockRoute([pool1, pool2, pool3, pool4], 100);

      // TokenA should be tokenIn
      const resultA = finder['routeHasGivenAddressAsInputOrOutput'](
        route,
        tokenA.address
      );
      expect(resultA).toBe(true);

      // TokenE should be tokenOut
      const resultE = finder['routeHasGivenAddressAsInputOrOutput'](
        route,
        tokenE.address
      );
      expect(resultE).toBe(true);

      // Intermediate tokens should not be input or output
      const resultB = finder['routeHasGivenAddressAsInputOrOutput'](
        route,
        tokenB.address
      );
      expect(resultB).toBe(false);

      const resultC = finder['routeHasGivenAddressAsInputOrOutput'](
        route,
        tokenC.address
      );
      expect(resultC).toBe(false);

      const resultD = finder['routeHasGivenAddressAsInputOrOutput'](
        route,
        tokenD.address
      );
      expect(resultD).toBe(false);
    });
  });

  describe('agg-hook partition (MAX_VALID_QUOTES_PER_PERCENTAGE)', () => {
    // Sourced from the allowlist file so the test stays valid if the
    // canonical address ever changes.
    const aggHookAddr = STABLE_SWAP_NG[0]!;

    it('reserves at least one slot for the no-hook class when both are populated', async () => {
      // Two no-hook pools and two agg-hook pools. Pre-partition the global
      // top-K=2 would be filled entirely by the agg-hook leaders. With the
      // partition the budget is split between classes (no-hook gets the
      // ceiling slot when K is odd; for K=2 each class gets exactly 1).
      const noHookPool1 = createMockPool(
        mockToken0,
        mockToken1,
        '0xa000000000000000000000000000000000000000'
      );
      const noHookPool2 = createMockPool(
        mockToken0,
        mockToken1,
        '0xa100000000000000000000000000000000000000'
      );
      const hookPool1 = createMockPool(
        mockToken0,
        mockToken1,
        '0xb000000000000000000000000000000000000000',
        aggHookAddr
      );
      const hookPool2 = createMockPool(
        mockToken0,
        mockToken1,
        '0xb100000000000000000000000000000000000000',
        aggHookAddr
      );

      // Sorted by amount desc — both leaders are agg-hook routes. The
      // partition still keeps the top no-hook route in the candidate set.
      const hookRouteHi = createMockRoute([hookPool1], 50);
      const hookRouteLo = createMockRoute([hookPool2], 50);
      const noHookRouteHi = createMockRoute([noHookPool1], 50);
      const noHookRouteLo = createMockRoute([noHookPool2], 50);

      const stats = finder['getBestUnusedQuotesStats'](
        50,
        new Map<number, QuoteBasic[]>([
          [
            50,
            [
              createMockQuote(hookRouteHi, 1000n),
              createMockQuote(hookRouteLo, 990n),
              createMockQuote(noHookRouteHi, 980n),
              createMockQuote(noHookRouteLo, 970n),
            ],
          ],
        ]),
        [],
        ChainId.MAINNET
      );

      expect(stats.returnedCount).toBe(2);
      const returnedRoutes = stats.quotes.map(q => q.route);
      // One slot per class — top no-hook + top agg-hook.
      expect(returnedRoutes).toContain(noHookRouteHi);
      expect(returnedRoutes).toContain(hookRouteHi);
      expect(returnedRoutes).not.toContain(noHookRouteLo);
      expect(returnedRoutes).not.toContain(hookRouteLo);
    });

    it('total returned across classes never exceeds K (branching factor preserved)', async () => {
      // Branching factor is the bug-fix dial: doubling per-percentage candidates
      // when both classes are populated would explode the level-N search space
      // and starve the optimal split before the timeout. K stays constant.
      const noHookPool = createMockPool(
        mockToken0,
        mockToken1,
        '0xe000000000000000000000000000000000000000'
      );
      const hookPool1 = createMockPool(
        mockToken0,
        mockToken1,
        '0xe100000000000000000000000000000000000000',
        aggHookAddr
      );
      const hookPool2 = createMockPool(
        mockToken0,
        mockToken1,
        '0xe200000000000000000000000000000000000000',
        aggHookAddr
      );

      const noHookRoute = createMockRoute([noHookPool], 50);
      const hookRoute1 = createMockRoute([hookPool1], 50);
      const hookRoute2 = createMockRoute([hookPool2], 50);

      const stats = finder['getBestUnusedQuotesStats'](
        50,
        new Map<number, QuoteBasic[]>([
          [
            50,
            [
              createMockQuote(hookRoute1, 1000n),
              createMockQuote(hookRoute2, 990n),
              createMockQuote(noHookRoute, 980n),
            ],
          ],
        ]),
        [],
        ChainId.MAINNET
      );

      expect(stats.returnedCount).toBe(2);
    });

    it('gives all K slots to the agg-hook class when no no-hook quote is present', async () => {
      const hookPool1 = createMockPool(
        mockToken0,
        mockToken1,
        '0xc000000000000000000000000000000000000000',
        aggHookAddr
      );
      const hookPool2 = createMockPool(
        mockToken0,
        mockToken1,
        '0xc100000000000000000000000000000000000000',
        aggHookAddr
      );
      const hookPool3 = createMockPool(
        mockToken0,
        mockToken1,
        '0xc200000000000000000000000000000000000000',
        aggHookAddr
      );

      const r1 = createMockRoute([hookPool1], 50);
      const r2 = createMockRoute([hookPool2], 50);
      const r3 = createMockRoute([hookPool3], 50);

      const stats = finder['getBestUnusedQuotesStats'](
        50,
        new Map<number, QuoteBasic[]>([
          [
            50,
            [
              createMockQuote(r1, 1000n),
              createMockQuote(r2, 990n),
              createMockQuote(r3, 980n),
            ],
          ],
        ]),
        [],
        ChainId.MAINNET
      );

      expect(stats.returnedCount).toBe(2);
      expect(stats.quotes.map(q => q.route)).toEqual([r1, r2]);
    });

    it('matches pre-partition behavior when no agg-hook pools are present', async () => {
      // Pre-partition top-K=2 cap: 3 no-hook quotes -> top 2 returned.
      const pool1 = createMockPool(
        mockToken0,
        mockToken1,
        '0xd000000000000000000000000000000000000000'
      );
      const pool2 = createMockPool(
        mockToken0,
        mockToken1,
        '0xd100000000000000000000000000000000000000'
      );
      const pool3 = createMockPool(
        mockToken0,
        mockToken1,
        '0xd200000000000000000000000000000000000000'
      );

      const r1 = createMockRoute([pool1], 50);
      const r2 = createMockRoute([pool2], 50);
      const r3 = createMockRoute([pool3], 50);

      const stats = finder['getBestUnusedQuotesStats'](
        50,
        new Map<number, QuoteBasic[]>([
          [
            50,
            [
              createMockQuote(r1, 1000n),
              createMockQuote(r2, 990n),
              createMockQuote(r3, 980n),
            ],
          ],
        ]),
        [],
        ChainId.MAINNET
      );

      expect(stats.returnedCount).toBe(2);
      expect(stats.quotes.map(q => q.route)).toEqual([r1, r2]);
    });
  });
});
