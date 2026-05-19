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
        ChainId.MAINNET,
        TradeType.ExactIn
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
        ChainId.MAINNET,
        TradeType.ExactIn
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
        ChainId.MAINNET,
        TradeType.ExactIn
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
        ChainId.MAINNET,
        TradeType.ExactIn
      );

      expect(stats.returnedCount).toBe(2);
      expect(stats.quotes.map(q => q.route)).toEqual([r1, r2]);
    });
  });

  describe('partition decision instrumentation', () => {
    const aggHookAddr = STABLE_SWAP_NG[0]!;

    // The behavioral fix (isAggHookCompetitive at tolerance=0) blocks the
    // partition for any scenario where the agg-hook winner is worse than the
    // displaced no-hook runner-up. These tests exercise the *instrumentation
    // log/metric emission code* itself, so we use a very permissive tolerance
    // that lets the partition fire regardless. The fix's competitiveness gate
    // is validated separately in its own describe block below.
    let finder: QuoteBestSplitFinder<MockPool>;
    beforeEach(() => {
      // Permissive on both BPS and gas-use tolerances so partition fires
      // for every scenario in this block — we're exercising the
      // instrumentation log/metric path, not the gas gate (which has its
      // own dedicated describe block below).
      finder = new QuoteBestSplitFinder<MockPool>(10_000n, 10_000_000n);
    });

    const noHookRouteAt = (addr: string, pct: number) =>
      createMockRoute([createMockPool(mockToken0, mockToken1, addr)], pct);
    const aggHookRouteAt = (addr: string, pct: number) =>
      createMockRoute(
        [createMockPool(mockToken0, mockToken1, addr, aggHookAddr)],
        pct
      );

    const buildInstrumentation = (
      overrides?: Partial<{
        tradeType: TradeType;
        testAggHooks: boolean | undefined;
        partitionEvictLogBudget: {remaining: number};
        soleCandidateLogBudget: {remaining: number};
        partitionGasAdjustedLogBudget: {remaining: number};
        gateEarlyReturnLeakLogBudget: {remaining: number};
        soleCandidateGasComparisonLogBudget: {remaining: number};
        metricTags: string[];
      }>
    ) => ({
      ctx: mockContext,
      tradeType: TradeType.ExactIn,
      testAggHooks: true as boolean | undefined,
      partitionEvictLogBudget: {remaining: 5},
      soleCandidateLogBudget: {remaining: 5},
      partitionGasAdjustedLogBudget: {remaining: 5},
      gateEarlyReturnLeakLogBudget: {remaining: 5},
      soleCandidateGasComparisonLogBudget: {remaining: 5},
      metricTags: ['chainId:1'],
      ...overrides,
    });

    const infoMock = () => mockContext.logger.info as ReturnType<typeof vi.fn>;
    const metricMock = () =>
      mockContext.metrics.count as ReturnType<typeof vi.fn>;

    it('emits the bad-case log when EXACT_IN agg-hook winner is worse than displaced no-hook runner-up', () => {
      const noHookWinner = noHookRouteAt(
        '0xa000000000000000000000000000000000000000',
        50
      );
      const noHookRunnerUp = noHookRouteAt(
        '0xa100000000000000000000000000000000000000',
        50
      );
      const aggHook = aggHookRouteAt(
        '0xb000000000000000000000000000000000000000',
        50
      );

      // EXACT_IN: higher amount = better. Agg-hook winner (990) trails the
      // displaced no-hook runner-up (995). The partition put a worse route in.
      finder['getBestUnusedQuotesStats'](
        50,
        new Map<number, QuoteBasic[]>([
          [
            50,
            [
              createMockQuote(noHookWinner, 1000n),
              createMockQuote(noHookRunnerUp, 995n),
              createMockQuote(aggHook, 990n),
            ],
          ],
        ]),
        [],
        ChainId.MAINNET,
        TradeType.ExactIn,
        buildInstrumentation({tradeType: TradeType.ExactIn})
      );

      const calls = infoMock().mock.calls;
      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toBe(
        'QuoteBestSplitFinder partition evicts better no-hook'
      );
      const payload = calls[0][1] as Record<string, unknown>;
      expect(payload.percentage).toBe(50);
      expect(payload.tradeType).toBe(TradeType.ExactIn);
      expect(payload.noHookCount).toBe(2);
      expect(payload.aggHookCount).toBe(1);
      expect(payload.noHookBudget).toBe(1);
      expect(payload.aggHookBudget).toBe(1);
      expect((payload.aggHookWinner as {amount: string}).amount).toBe('990');
      expect((payload.noHookRunnerUp as {amount: string}).amount).toBe('995');
      expect((payload.noHookWinner as {amount: string}).amount).toBe('1000');
    });

    it('emits the bad-case log when EXACT_OUT agg-hook winner needs more input than displaced no-hook runner-up', () => {
      // EXACT_OUT: lower amount = better (less input required). Comparison
      // direction must flip relative to EXACT_IN.
      const noHookWinner = noHookRouteAt(
        '0xc000000000000000000000000000000000000000',
        50
      );
      const noHookRunnerUp = noHookRouteAt(
        '0xc100000000000000000000000000000000000000',
        50
      );
      const aggHook = aggHookRouteAt(
        '0xd000000000000000000000000000000000000000',
        50
      );

      finder['getBestUnusedQuotesStats'](
        50,
        new Map<number, QuoteBasic[]>([
          [
            50,
            [
              createMockQuote(noHookWinner, 990n),
              createMockQuote(noHookRunnerUp, 995n),
              createMockQuote(aggHook, 1000n),
            ],
          ],
        ]),
        [],
        ChainId.MAINNET,
        TradeType.ExactOut,
        buildInstrumentation({tradeType: TradeType.ExactOut})
      );

      const calls = infoMock().mock.calls;
      expect(calls).toHaveLength(1);
      const payload = calls[0][1] as Record<string, unknown>;
      expect(payload.tradeType).toBe(TradeType.ExactOut);
      expect((payload.aggHookWinner as {amount: string}).amount).toBe('1000');
      expect((payload.noHookRunnerUp as {amount: string}).amount).toBe('995');
    });

    it('does NOT emit the log when agg-hook winner beats the no-hook runner-up, but still emits the metric', () => {
      // EXACT_IN: agg-hook winner (1000) > no-hook runner-up (985). Partition
      // chose well; only the aggregate metric should fire.
      const aggHook = aggHookRouteAt(
        '0xe000000000000000000000000000000000000000',
        50
      );
      const noHookWinner = noHookRouteAt(
        '0xe100000000000000000000000000000000000000',
        50
      );
      const noHookRunnerUp = noHookRouteAt(
        '0xe200000000000000000000000000000000000000',
        50
      );

      finder['getBestUnusedQuotesStats'](
        50,
        new Map<number, QuoteBasic[]>([
          [
            50,
            [
              createMockQuote(aggHook, 1000n),
              createMockQuote(noHookWinner, 995n),
              createMockQuote(noHookRunnerUp, 985n),
            ],
          ],
        ]),
        [],
        ChainId.MAINNET,
        TradeType.ExactIn,
        buildInstrumentation({tradeType: TradeType.ExactIn})
      );

      expect(infoMock().mock.calls).toHaveLength(0);
      const metricCalls = metricMock().mock.calls;
      // Two metrics fire when partition runs: PartitionDecision (raw verdict)
      // and PartitionGasAdjustedDecision (gas-adjusted verdict). Mock quotes
      // lack gasDetails, so the gas-adjusted side emits the gas_info_missing
      // tag and does not fire its log.
      expect(metricCalls).toHaveLength(2);
      const rawTags = (metricCalls[0][2] as {tags: string[]}).tags;
      expect(rawTags).toContain('partitionVerdict:agghook_better_or_tie');
      expect(rawTags).toContain('testAggHooks:true');
      expect(rawTags).toContain(`tradeType:${TradeType.ExactIn}`);
      const gasTags = (metricCalls[1][2] as {tags: string[]}).tags;
      expect(gasTags).toContain('gasAdjustedVerdict:gas_info_missing');
    });

    it('does not emit log or metric when testAggHooks is false', () => {
      // Instrumentation is gated on testAggHooks being truthy — baseline
      // (non-shadow) traffic should never produce these signals.
      const noHookWinner = noHookRouteAt(
        '0xf000000000000000000000000000000000000000',
        50
      );
      const noHookRunnerUp = noHookRouteAt(
        '0xf100000000000000000000000000000000000000',
        50
      );
      const aggHook = aggHookRouteAt(
        '0xf200000000000000000000000000000000000000',
        50
      );

      finder['getBestUnusedQuotesStats'](
        50,
        new Map<number, QuoteBasic[]>([
          [
            50,
            [
              createMockQuote(noHookWinner, 1000n),
              createMockQuote(noHookRunnerUp, 995n),
              createMockQuote(aggHook, 990n),
            ],
          ],
        ]),
        [],
        ChainId.MAINNET,
        TradeType.ExactIn,
        buildInstrumentation({
          testAggHooks: false,
          tradeType: TradeType.ExactIn,
        })
      );

      expect(infoMock().mock.calls).toHaveLength(0);
      expect(metricMock().mock.calls).toHaveLength(0);
    });

    it('does not emit when only one class is populated (partition is a no-op)', () => {
      // bothPopulated=false: nothing to ask about partition quality, so log
      // and metric are both skipped.
      const noHookA = noHookRouteAt(
        '0xaa00000000000000000000000000000000000000',
        50
      );
      const noHookB = noHookRouteAt(
        '0xab00000000000000000000000000000000000000',
        50
      );

      finder['getBestUnusedQuotesStats'](
        50,
        new Map<number, QuoteBasic[]>([
          [
            50,
            [createMockQuote(noHookA, 1000n), createMockQuote(noHookB, 995n)],
          ],
        ]),
        [],
        ChainId.MAINNET,
        TradeType.ExactIn,
        buildInstrumentation()
      );

      expect(infoMock().mock.calls).toHaveLength(0);
      expect(metricMock().mock.calls).toHaveLength(0);
    });

    it('does not emit partition-evict signals when there is no no-hook runner-up to evict', () => {
      // 1 no-hook quote fills the entire no-hook budget; there is no
      // displaced runner-up. The PartitionDecision /
      // PartitionGasAdjustedDecision counterfactuals are unanswerable so
      // both stay silent. The new GateEarlyReturnLeak instrumentation,
      // however, is specifically designed to fire here (gas_info_missing
      // verdict since gasDetails is not populated on these mock quotes).
      const noHook = noHookRouteAt(
        '0xba00000000000000000000000000000000000000',
        50
      );
      const aggHook = aggHookRouteAt(
        '0xbb00000000000000000000000000000000000000',
        50
      );

      finder['getBestUnusedQuotesStats'](
        50,
        new Map<number, QuoteBasic[]>([
          [
            50,
            [createMockQuote(noHook, 1000n), createMockQuote(aggHook, 990n)],
          ],
        ]),
        [],
        ChainId.MAINNET,
        TradeType.ExactIn,
        buildInstrumentation()
      );

      // Old partition-evict log is silent (no displaced runner-up).
      const evictLogs = infoMock().mock.calls.filter(
        c => c[0] === 'QuoteBestSplitFinder partition evicts better no-hook'
      );
      const higherGasLogs = infoMock().mock.calls.filter(
        c => c[0] === 'QuoteBestSplitFinder partition kept higher-gas agg-hook'
      );
      expect(evictLogs).toHaveLength(0);
      expect(higherGasLogs).toHaveLength(0);

      // Old PartitionDecision / PartitionGasAdjustedDecision metrics are
      // silent (their emitters early-return on the same condition).
      const oldMetrics = metricMock().mock.calls.filter(c =>
        (c[2] as {tags: string[]}).tags.some(
          t =>
            t.startsWith('partitionVerdict:') ||
            t.startsWith('gasAdjustedVerdict:')
        )
      );
      expect(oldMetrics).toHaveLength(0);

      // New leak instrumentation correctly fires with gas_info_missing
      // (no gasDetails on these mock quotes).
      const leakMetrics = metricMock().mock.calls.filter(c =>
        (c[2] as {tags: string[]}).tags.some(t => t.startsWith('gasVerdict:'))
      );
      expect(leakMetrics).toHaveLength(1);
      expect((leakMetrics[0][2] as {tags: string[]}).tags).toContain(
        'gasVerdict:gas_info_missing'
      );
    });

    it('respects the per-request partition-evict log budget cap while metric keeps firing', () => {
      // 7 identical bad-case invocations share one partitionEvictLogBudget
      // (mirrors how findBestSplits allocates one budget across many DFS
      // calls). First 5 produce logs; calls 6 and 7 only produce metrics.
      const aggHook = aggHookRouteAt(
        '0xca00000000000000000000000000000000000000',
        50
      );
      const noHookWinner = noHookRouteAt(
        '0xcb00000000000000000000000000000000000000',
        50
      );
      const noHookRunnerUp = noHookRouteAt(
        '0xcc00000000000000000000000000000000000000',
        50
      );

      const quotesMap = new Map<number, QuoteBasic[]>([
        [
          50,
          [
            createMockQuote(noHookWinner, 1000n),
            createMockQuote(noHookRunnerUp, 995n),
            createMockQuote(aggHook, 990n),
          ],
        ],
      ]);

      const sharedInstr = buildInstrumentation({
        tradeType: TradeType.ExactIn,
      });
      for (let i = 0; i < 7; i++) {
        finder['getBestUnusedQuotesStats'](
          50,
          quotesMap,
          [],
          ChainId.MAINNET,
          TradeType.ExactIn,
          sharedInstr
        );
      }

      expect(infoMock().mock.calls).toHaveLength(5);
      // 14 = 7 PartitionDecision + 7 PartitionGasAdjustedDecision metrics
      // (the latter emits gas_info_missing since mock quotes lack gasDetails).
      expect(metricMock().mock.calls).toHaveLength(14);
      expect(sharedInstr.partitionEvictLogBudget.remaining).toBe(0);
    });

    // ----- Sole-candidate instrumentation (the upstream-filter signal) -----

    it('emits sole-candidate log and metric when an agg-hook quote is the only candidate at a percentage', () => {
      // No no-hook quote at this percentage → bothPopulated=false →
      // partition can't evict anything; the agg-hook quote "wins by default".
      // This is the signal that pinpoints upstream filtering.
      const aggHook = aggHookRouteAt(
        '0xda00000000000000000000000000000000000000',
        50
      );

      finder['getBestUnusedQuotesStats'](
        50,
        new Map<number, QuoteBasic[]>([[50, [createMockQuote(aggHook, 990n)]]]),
        [],
        ChainId.MAINNET,
        TradeType.ExactOut,
        buildInstrumentation({tradeType: TradeType.ExactOut})
      );

      const calls = infoMock().mock.calls;
      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toBe(
        'QuoteBestSplitFinder agg-hook quote selected with no no-hook competitor'
      );
      const payload = calls[0][1] as Record<string, unknown>;
      expect(payload.percentage).toBe(50);
      expect(payload.tradeType).toBe(TradeType.ExactOut);
      expect(payload.aggHookCount).toBe(1);
      expect((payload.aggHookWinner as {amount: string}).amount).toBe('990');

      // Filter to the original AggHookSoleCandidate metric only; the
      // newer AggHookSoleCandidateGasComparison (gasVerdict: tag) and
      // SoleCandidateDecision (soleCandidateVerdict: tag) metrics are
      // exercised by their own tests below.
      const metricCalls = metricMock().mock.calls.filter(
        c =>
          !(c[2] as {tags: string[]}).tags.some(
            t =>
              t.startsWith('gasVerdict:') ||
              t.startsWith('soleCandidateVerdict:')
          )
      );
      expect(metricCalls).toHaveLength(1);
      const tags = (metricCalls[0][2] as {tags: string[]}).tags;
      expect(tags).toContain('testAggHooks:true');
      expect(tags).toContain(`tradeType:${TradeType.ExactOut}`);
    });

    it('does not emit sole-candidate signals when only no-hook quotes exist', () => {
      // bothPopulated=false but the lone class is no-hook — this is the
      // expected baseline case, not a signal of upstream filtering.
      const noHook = noHookRouteAt(
        '0xea00000000000000000000000000000000000000',
        50
      );

      finder['getBestUnusedQuotesStats'](
        50,
        new Map<number, QuoteBasic[]>([[50, [createMockQuote(noHook, 1000n)]]]),
        [],
        ChainId.MAINNET,
        TradeType.ExactIn,
        buildInstrumentation()
      );

      expect(infoMock().mock.calls).toHaveLength(0);
      expect(metricMock().mock.calls).toHaveLength(0);
    });

    it('respects the per-request sole-candidate log budget cap while metric keeps firing', () => {
      const aggHook = aggHookRouteAt(
        '0xfa00000000000000000000000000000000000000',
        50
      );

      const quotesMap = new Map<number, QuoteBasic[]>([
        [50, [createMockQuote(aggHook, 990n)]],
      ]);

      const sharedInstr = buildInstrumentation();
      for (let i = 0; i < 7; i++) {
        finder['getBestUnusedQuotesStats'](
          50,
          quotesMap,
          [],
          ChainId.MAINNET,
          TradeType.ExactIn,
          sharedInstr
        );
      }

      // Original AggHookSoleCandidate metric: one emission per call.
      // Filter out the newer AggHookSoleCandidateGasComparison
      // (gasVerdict: tag) and SoleCandidateDecision
      // (soleCandidateVerdict: tag) emissions tested separately.
      const soleCandidateMetricCalls = metricMock().mock.calls.filter(
        c =>
          !(c[2] as {tags: string[]}).tags.some(
            t =>
              t.startsWith('gasVerdict:') ||
              t.startsWith('soleCandidateVerdict:')
          )
      );
      expect(infoMock().mock.calls).toHaveLength(5);
      expect(soleCandidateMetricCalls).toHaveLength(7);
      expect(sharedInstr.soleCandidateLogBudget.remaining).toBe(0);
    });

    it('does not emit sole-candidate signals when testAggHooks is false', () => {
      const aggHook = aggHookRouteAt(
        '0x1100000000000000000000000000000000000000',
        50
      );

      finder['getBestUnusedQuotesStats'](
        50,
        new Map<number, QuoteBasic[]>([[50, [createMockQuote(aggHook, 990n)]]]),
        [],
        ChainId.MAINNET,
        TradeType.ExactIn,
        buildInstrumentation({testAggHooks: false})
      );

      expect(infoMock().mock.calls).toHaveLength(0);
      expect(metricMock().mock.calls).toHaveLength(0);
    });

    // ----- Gas-use partition decision instrumentation -----

    const createMockQuoteWithGas = (
      route: RouteBasic<MockPool>,
      amount: bigint,
      gasUse: bigint
    ): QuoteBasic =>
      ({
        route,
        amount,
        gasDetails: {
          gasPriceInWei: 1n,
          gasCostInWei: 1n,
          gasCostInEth: 0,
          gasUse,
          // gasCostInQuoteToken stays undefined — it's populated by
          // GasConverter AFTER findBestSplits, so the instrumentation can't
          // rely on it. Comparison happens against gasDetails.gasUse instead.
        },
      }) as unknown as QuoteBasic;

    it('emits the higher-gas log and metric when partition keeps an agg-hook with more gas use (EXACT_OUT)', () => {
      // EXACT_OUT, raw-tied scenario: agg-hook (1000n) ties no-hook on raw
      // input but uses far more gas. The raw-only gate passes
      // (`isAggHookCompetitive` returns true at tolerance=0n because
      // badness<=0); the partition fires; this instrumentation flags it.
      const noHookWinner = noHookRouteAt(
        '0xaa00000000000000000000000000000000000000',
        50
      );
      const noHookRunnerUp = noHookRouteAt(
        '0xab00000000000000000000000000000000000000',
        50
      );
      const aggHook = aggHookRouteAt(
        '0xac00000000000000000000000000000000000000',
        50
      );

      // Raw amounts (EXACT_OUT, ascending = best first):
      //   noHookWinner    = 1000n
      //   noHookRunnerUp  = 1001n  (displaced by partition)
      //   aggHookWinner   = 1000n  (raw-ties → gate passes)
      // gasUse:
      //   noHookRunnerUp  = 100n
      //   aggHookWinner   = 500n  (5x more gas → verdict agghook_more_gas_used)
      finder['getBestUnusedQuotesStats'](
        50,
        new Map<number, QuoteBasic[]>([
          [
            50,
            [
              createMockQuoteWithGas(noHookWinner, 1000n, 100n),
              createMockQuoteWithGas(noHookRunnerUp, 1001n, 100n),
              createMockQuoteWithGas(aggHook, 1000n, 500n),
            ],
          ],
        ]),
        [],
        ChainId.MAINNET,
        TradeType.ExactOut,
        buildInstrumentation({tradeType: TradeType.ExactOut})
      );

      const logs = infoMock().mock.calls.filter(
        c => c[0] === 'QuoteBestSplitFinder partition kept higher-gas agg-hook'
      );
      expect(logs).toHaveLength(1);
      const payload = logs[0][1] as Record<string, unknown>;
      expect(payload.percentage).toBe(50);
      expect(payload.tradeType).toBe(TradeType.ExactOut);
      expect((payload.aggHookWinner as {gasUse: string}).gasUse).toBe('500');
      expect((payload.noHookRunnerUp as {gasUse: string}).gasUse).toBe('100');
      expect(payload.gasUseDelta).toBe('400');

      const gasMetric = metricMock().mock.calls.find(c =>
        (c[2] as {tags: string[]}).tags.some(t =>
          t.startsWith('gasAdjustedVerdict:')
        )
      );
      expect(gasMetric).toBeDefined();
      const tags = (gasMetric![2] as {tags: string[]}).tags;
      expect(tags).toContain('gasAdjustedVerdict:agghook_more_gas_used');
      expect(tags).toContain(`tradeType:${TradeType.ExactOut}`);
    });

    it('emits equal-or-less-gas metric tag (no log) when agg-hook uses no more gas than the runner-up', () => {
      // Agg-hook uses LESS gas than the displaced no-hook runner-up.
      // Verdict: agghook_equal_or_less_gas_used. No log fires.
      const noHookWinner = noHookRouteAt(
        '0xb000000000000000000000000000000000000000',
        50
      );
      const noHookRunnerUp = noHookRouteAt(
        '0xb100000000000000000000000000000000000000',
        50
      );
      const aggHook = aggHookRouteAt(
        '0xb200000000000000000000000000000000000000',
        50
      );

      finder['getBestUnusedQuotesStats'](
        50,
        new Map<number, QuoteBasic[]>([
          [
            50,
            [
              createMockQuoteWithGas(noHookWinner, 1000n, 200n),
              createMockQuoteWithGas(noHookRunnerUp, 999n, 200n),
              // EXACT_IN gate uses `amount >= noHookRunnerUp.amount`. 999n
              // ties so partition fires. gasUse 50n < 200n → equal-or-less.
              createMockQuoteWithGas(aggHook, 999n, 50n),
            ],
          ],
        ]),
        [],
        ChainId.MAINNET,
        TradeType.ExactIn,
        buildInstrumentation({tradeType: TradeType.ExactIn})
      );

      const logs = infoMock().mock.calls.filter(
        c => c[0] === 'QuoteBestSplitFinder partition kept higher-gas agg-hook'
      );
      expect(logs).toHaveLength(0);
      const gasMetric = metricMock().mock.calls.find(c =>
        (c[2] as {tags: string[]}).tags.some(t =>
          t.startsWith('gasAdjustedVerdict:')
        )
      );
      expect(gasMetric).toBeDefined();
      const tags = (gasMetric![2] as {tags: string[]}).tags;
      expect(tags).toContain(
        'gasAdjustedVerdict:agghook_equal_or_less_gas_used'
      );
    });

    it('emits gas_info_missing tag when either side lacks gasDetails', () => {
      // Mixed: agg-hook has gas info, no-hook runner-up does not.
      const noHookWinner = noHookRouteAt(
        '0xc000000000000000000000000000000000000000',
        50
      );
      const noHookRunnerUp = noHookRouteAt(
        '0xc100000000000000000000000000000000000000',
        50
      );
      const aggHook = aggHookRouteAt(
        '0xc200000000000000000000000000000000000000',
        50
      );

      finder['getBestUnusedQuotesStats'](
        50,
        new Map<number, QuoteBasic[]>([
          [
            50,
            [
              createMockQuote(noHookWinner, 1000n),
              createMockQuote(noHookRunnerUp, 999n), // no gas info
              createMockQuoteWithGas(aggHook, 999n, 50n),
            ],
          ],
        ]),
        [],
        ChainId.MAINNET,
        TradeType.ExactIn,
        buildInstrumentation({tradeType: TradeType.ExactIn})
      );

      const gasMetric = metricMock().mock.calls.find(c =>
        (c[2] as {tags: string[]}).tags.some(t =>
          t.startsWith('gasAdjustedVerdict:')
        )
      );
      expect(gasMetric).toBeDefined();
      const tags = (gasMetric![2] as {tags: string[]}).tags;
      expect(tags).toContain('gasAdjustedVerdict:gas_info_missing');
      // No log even though gas info is missing — only the bad-case verdict
      // produces a log.
      const logs = infoMock().mock.calls.filter(
        c => c[0] === 'QuoteBestSplitFinder partition kept higher-gas agg-hook'
      );
      expect(logs).toHaveLength(0);
    });

    it('respects partitionGasAdjustedLogBudget cap while metric keeps firing', () => {
      const noHookWinner = noHookRouteAt(
        '0xd000000000000000000000000000000000000000',
        50
      );
      const noHookRunnerUp = noHookRouteAt(
        '0xd100000000000000000000000000000000000000',
        50
      );
      const aggHook = aggHookRouteAt(
        '0xd200000000000000000000000000000000000000',
        50
      );
      const quotesMap = new Map<number, QuoteBasic[]>([
        [
          50,
          [
            createMockQuoteWithGas(noHookWinner, 1000n, 100n),
            createMockQuoteWithGas(noHookRunnerUp, 1001n, 100n),
            createMockQuoteWithGas(aggHook, 1000n, 500n),
          ],
        ],
      ]);
      const sharedInstr = buildInstrumentation({tradeType: TradeType.ExactOut});
      for (let i = 0; i < 7; i++) {
        finder['getBestUnusedQuotesStats'](
          50,
          quotesMap,
          [],
          ChainId.MAINNET,
          TradeType.ExactOut,
          sharedInstr
        );
      }

      const logs = infoMock().mock.calls.filter(
        c => c[0] === 'QuoteBestSplitFinder partition kept higher-gas agg-hook'
      );
      expect(logs).toHaveLength(5);
      const gasMetrics = metricMock().mock.calls.filter(c =>
        (c[2] as {tags: string[]}).tags.some(t =>
          t.startsWith('gasAdjustedVerdict:')
        )
      );
      expect(gasMetrics).toHaveLength(7);
      expect(sharedInstr.partitionGasAdjustedLogBudget.remaining).toBe(0);
    });

    // ----- Gate early-return leak instrumentation -----
    //
    // Pre-fix shape (now closed): percentage bucket had exactly 1
    // no-hook quote and >=1 agg-hook quote. `isAggHookCompetitive`
    // short-circuited at `noHookQuotes.length <= noHookBudgetIfPartitioned`
    // and returned true without running the gas check, admitting a
    // gas-heavy agg-hook into the partition slot. Post-fix the gate
    // anchors the gas check on `noHookQuotes[0]` regardless of
    // displacement, so the gas-bad case is rejected outright.
    //
    // The GateEarlyReturnLeak instrumentation is kept in place as a
    // post-fix validation signal: it fires only when
    // `useBothPopulatedPartition === true` (i.e. the gate ADMITTED the
    // agg-hook), so the `gasVerdict:agghook_more_gas_used` tag should
    // drop to zero in prod with default gas tolerance (0n). Non-zero
    // gas tolerance configurations may still emit on this tag (within
    // tolerance) but never reflect a leak.

    it('rejects agg-hook (no leak emitted) when noHookQuotes.length == 1 and agg-hook uses more gas', () => {
      // Post-fix: the line-344 early-return is gone. The gate runs the
      // gas check anchored on noHookQuotes[0]. Agg-hook gas (500n) >
      // noHookWinner gas (100n) with delta 400n > tolerance 0n → gate
      // rejects → useBothPopulatedPartition=false → leak instrumentation
      // is NEVER reached (it's nested under that branch).
      //
      // Use a strict (default-tolerance) finder for the rejection
      // assertion — the surrounding `finder` is constructed with huge
      // tolerances at line 1765 to make most of this suite's gates
      // pass-by-default.
      const strictFinder = new QuoteBestSplitFinder<MockPool>();
      const noHookWinner = noHookRouteAt(
        '0xe000000000000000000000000000000000000000',
        50
      );
      const aggHook = aggHookRouteAt(
        '0xe100000000000000000000000000000000000000',
        50
      );

      const stats = strictFinder['getBestUnusedQuotesStats'](
        50,
        new Map<number, QuoteBasic[]>([
          [
            50,
            [
              createMockQuoteWithGas(noHookWinner, 1000n, 100n),
              createMockQuoteWithGas(aggHook, 1000n, 500n),
            ],
          ],
        ]),
        [],
        ChainId.MAINNET,
        TradeType.ExactIn,
        buildInstrumentation({tradeType: TradeType.ExactIn})
      );

      // Agg-hook is rejected; only the no-hook quote is returned.
      expect(stats.returnedCount).toBe(1);
      const routes = stats.quotes.map(q => q.route);
      expect(routes).toContain(noHookWinner);
      expect(routes).not.toContain(aggHook);

      // No leak log or metric — gate rejected before the instrumentation
      // branch could fire.
      const leakLogs = infoMock().mock.calls.filter(
        c =>
          c[0] ===
          'QuoteBestSplitFinder gate early-return admitted higher-gas agg-hook'
      );
      const leakMetrics = metricMock().mock.calls.filter(c =>
        (c[2] as {tags: string[]}).tags.some(t => t.startsWith('gasVerdict:'))
      );
      expect(leakLogs).toHaveLength(0);
      expect(leakMetrics).toHaveLength(0);

      // And — same as pre-fix — the older partition logs are still
      // silent in the no-displacement case.
      const oldEvictLogs = infoMock().mock.calls.filter(
        c => c[0] === 'QuoteBestSplitFinder partition evicts better no-hook'
      );
      const oldHigherGasLogs = infoMock().mock.calls.filter(
        c => c[0] === 'QuoteBestSplitFinder partition kept higher-gas agg-hook'
      );
      expect(oldEvictLogs).toHaveLength(0);
      expect(oldHigherGasLogs).toHaveLength(0);
    });

    it('emits gate-early-return-leak metric with equal-or-less-gas verdict (no log) when agg-hook is gas-neutral', () => {
      // Same early-return path, but agg-hook gas <= no-hook gas. Metric
      // still fires (so DD can count overall early-return-path frequency)
      // but no log emitted (verdict tag does not indicate harm).
      const noHookWinner = noHookRouteAt(
        '0xe200000000000000000000000000000000000000',
        50
      );
      const aggHook = aggHookRouteAt(
        '0xe300000000000000000000000000000000000000',
        50
      );

      finder['getBestUnusedQuotesStats'](
        50,
        new Map<number, QuoteBasic[]>([
          [
            50,
            [
              createMockQuoteWithGas(noHookWinner, 1000n, 500n),
              createMockQuoteWithGas(aggHook, 1000n, 100n),
            ],
          ],
        ]),
        [],
        ChainId.MAINNET,
        TradeType.ExactIn,
        buildInstrumentation({tradeType: TradeType.ExactIn})
      );

      const logs = infoMock().mock.calls.filter(
        c =>
          c[0] ===
          'QuoteBestSplitFinder gate early-return admitted higher-gas agg-hook'
      );
      expect(logs).toHaveLength(0);

      const leakMetrics = metricMock().mock.calls.filter(c =>
        (c[2] as {tags: string[]}).tags.some(t => t.startsWith('gasVerdict:'))
      );
      expect(leakMetrics).toHaveLength(1);
      expect((leakMetrics[0][2] as {tags: string[]}).tags).toContain(
        'gasVerdict:agghook_equal_or_less_gas_used'
      );
    });

    it('emits gate-early-return-leak metric with gas_info_missing verdict when gasUse is undefined', () => {
      // Same early-return path, but no gas info available. Metric fires
      // with a sentinel tag so we can size the population for which the
      // gas comparison is undefined (e.g. unit-test paths) vs definitive.
      const noHookWinner = noHookRouteAt(
        '0xe400000000000000000000000000000000000000',
        50
      );
      const aggHook = aggHookRouteAt(
        '0xe500000000000000000000000000000000000000',
        50
      );

      finder['getBestUnusedQuotesStats'](
        50,
        new Map<number, QuoteBasic[]>([
          [
            50,
            [
              createMockQuote(noHookWinner, 1000n),
              createMockQuote(aggHook, 1000n),
            ],
          ],
        ]),
        [],
        ChainId.MAINNET,
        TradeType.ExactIn,
        buildInstrumentation({tradeType: TradeType.ExactIn})
      );

      const leakMetrics = metricMock().mock.calls.filter(c =>
        (c[2] as {tags: string[]}).tags.some(t => t.startsWith('gasVerdict:'))
      );
      expect(leakMetrics).toHaveLength(1);
      expect((leakMetrics[0][2] as {tags: string[]}).tags).toContain(
        'gasVerdict:gas_info_missing'
      );
    });

    it('does not emit gate-early-return-leak when partition runs with displacement (noHookQuotes.length > noHookBudget)', () => {
      // 2 no-hook + 1 agg-hook → noHookQuotes.length(2) >
      // noHookBudgetIfPartitioned(1) → gate runs full check (not early-
      // return). The leak instrumentation must not fire here, since the
      // existing PartitionDecision / PartitionGasAdjustedDecision logs
      // already cover this path.
      const noHookWinner = noHookRouteAt(
        '0xe600000000000000000000000000000000000000',
        50
      );
      const noHookRunnerUp = noHookRouteAt(
        '0xe700000000000000000000000000000000000000',
        50
      );
      const aggHook = aggHookRouteAt(
        '0xe800000000000000000000000000000000000000',
        50
      );

      finder['getBestUnusedQuotesStats'](
        50,
        new Map<number, QuoteBasic[]>([
          [
            50,
            [
              createMockQuoteWithGas(noHookWinner, 1000n, 100n),
              createMockQuoteWithGas(noHookRunnerUp, 999n, 100n),
              createMockQuoteWithGas(aggHook, 1000n, 500n),
            ],
          ],
        ]),
        [],
        ChainId.MAINNET,
        TradeType.ExactIn,
        buildInstrumentation({tradeType: TradeType.ExactIn})
      );

      const leakLogs = infoMock().mock.calls.filter(
        c =>
          c[0] ===
          'QuoteBestSplitFinder gate early-return admitted higher-gas agg-hook'
      );
      const leakMetrics = metricMock().mock.calls.filter(c =>
        (c[2] as {tags: string[]}).tags.some(t => t.startsWith('gasVerdict:'))
      );
      expect(leakLogs).toHaveLength(0);
      expect(leakMetrics).toHaveLength(0);
    });

    it('respects gateEarlyReturnLeakLogBudget cap while metric keeps firing', () => {
      // Post-fix, the leak log only fires when the gate ADMITS a
      // gas-more agg-hook (verdict = agghook_more_gas_used). With
      // default tolerance=0n the gate rejects such cases, so we use a
      // tolerant gate (raw tol=0n, gas tol=1000n units) — the gate
      // passes the agg-hook within tolerance and the leak
      // instrumentation correctly reports it.
      const tolerantFinder = new QuoteBestSplitFinder<MockPool>(0n, 1000n);
      const noHookWinner = noHookRouteAt(
        '0xe900000000000000000000000000000000000000',
        50
      );
      const aggHook = aggHookRouteAt(
        '0xea00000000000000000000000000000000000000',
        50
      );
      const quotesMap = new Map<number, QuoteBasic[]>([
        [
          50,
          [
            createMockQuoteWithGas(noHookWinner, 1000n, 100n),
            // Gas delta 400 vs noHookWinner.gas(100) — within 1000n
            // tolerance → gate passes → leak instr fires more_gas.
            createMockQuoteWithGas(aggHook, 1000n, 500n),
          ],
        ],
      ]);

      const sharedInstr = buildInstrumentation({tradeType: TradeType.ExactIn});
      for (let i = 0; i < 7; i++) {
        tolerantFinder['getBestUnusedQuotesStats'](
          50,
          quotesMap,
          [],
          ChainId.MAINNET,
          TradeType.ExactIn,
          sharedInstr
        );
      }

      const leakLogs = infoMock().mock.calls.filter(
        c =>
          c[0] ===
          'QuoteBestSplitFinder gate early-return admitted higher-gas agg-hook'
      );
      const leakMetrics = metricMock().mock.calls.filter(c =>
        (c[2] as {tags: string[]}).tags.some(t => t.startsWith('gasVerdict:'))
      );
      expect(leakLogs).toHaveLength(5);
      expect(leakMetrics).toHaveLength(7);
      expect(sharedInstr.gateEarlyReturnLeakLogBudget.remaining).toBe(0);
    });

    // ----- Sole-candidate gasUse log payload -----

    it('includes agg-hook gasUse in the sole-candidate log payload when populated', () => {
      const aggHook = aggHookRouteAt(
        '0xeb00000000000000000000000000000000000000',
        50
      );

      finder['getBestUnusedQuotesStats'](
        50,
        new Map<number, QuoteBasic[]>([
          [50, [createMockQuoteWithGas(aggHook, 990n, 750n)]],
        ]),
        [],
        ChainId.MAINNET,
        TradeType.ExactIn,
        buildInstrumentation({tradeType: TradeType.ExactIn})
      );

      const logs = infoMock().mock.calls.filter(
        c =>
          c[0] ===
          'QuoteBestSplitFinder agg-hook quote selected with no no-hook competitor'
      );
      expect(logs).toHaveLength(1);
      const payload = logs[0][1] as Record<string, unknown>;
      expect((payload.aggHookWinner as {gasUse: string}).gasUse).toBe('750');
    });

    // ----- Sole-candidate gas-comparison instrumentation -----
    //
    // Post-PR-#8195 the K-budget gate's early-return leak is closed but
    // prod still sees residual UniRoute-wins bursts (~30-48 per 10 min)
    // on the same Curve+Fluid v4 chain shape. The chain enters via the
    // sole-candidate path (`noHookQuotes.length === 0` at a percentage),
    // where no anchor exists for the gate. This instrumentation lets
    // us prove that residual mechanism in prod by cross-referencing
    // the sole-candidate agg-hook winner against the cheapest no-hook
    // quote anywhere in `percentageToSortedQuotes` — i.e. the fallback
    // DFS would pick if agg-hook were excluded from the trade.

    it('emits gas-comparison log + metric when sole-candidate agg-hook uses more gas than the cheapest no-hook anywhere', () => {
      const aggHook = aggHookRouteAt(
        '0xfa10000000000000000000000000000000000000',
        50
      );
      const cheapNoHookElsewhere = noHookRouteAt(
        '0xfa20000000000000000000000000000000000000',
        90
      );

      finder['getBestUnusedQuotesStats'](
        50,
        new Map<number, QuoteBasic[]>([
          // Bucket at pct=50: only the agg-hook chain (sole-candidate).
          [50, [createMockQuoteWithGas(aggHook, 990n, 230_000n)]],
          // Bucket at pct=90: a no-hook quote with much cheaper gas
          // (the alternative DFS would pick if agg-hook were excluded).
          [90, [createMockQuoteWithGas(cheapNoHookElsewhere, 1000n, 150_000n)]],
        ]),
        [],
        ChainId.MAINNET,
        TradeType.ExactOut,
        buildInstrumentation({tradeType: TradeType.ExactOut})
      );

      const logs = infoMock().mock.calls.filter(
        c =>
          c[0] ===
          'QuoteBestSplitFinder agg-hook sole-candidate is gas-worse than best no-hook elsewhere'
      );
      expect(logs).toHaveLength(1);
      const payload = logs[0][1] as Record<string, unknown>;
      expect(payload.percentage).toBe(50);
      expect(payload.tradeType).toBe(TradeType.ExactOut);
      expect((payload.aggHookWinner as {gasUse: string}).gasUse).toBe('230000');
      expect(
        (payload.cheapestNoHookElsewhere as {percentage: number}).percentage
      ).toBe(90);
      expect((payload.cheapestNoHookElsewhere as {gasUse: string}).gasUse).toBe(
        '150000'
      );
      expect(payload.gasUseDelta).toBe('80000');

      const comparisonMetrics = metricMock().mock.calls.filter(c =>
        (c[2] as {tags: string[]}).tags.some(t => t.startsWith('gasVerdict:'))
      );
      expect(comparisonMetrics).toHaveLength(1);
      expect((comparisonMetrics[0][2] as {tags: string[]}).tags).toContain(
        'gasVerdict:agghook_more_gas'
      );
    });

    it('emits gas-comparison metric (no log) when sole-candidate agg-hook uses equal-or-less gas than the cheapest no-hook anywhere', () => {
      const aggHook = aggHookRouteAt(
        '0xfa30000000000000000000000000000000000000',
        50
      );
      const expensiveNoHookElsewhere = noHookRouteAt(
        '0xfa40000000000000000000000000000000000000',
        90
      );

      finder['getBestUnusedQuotesStats'](
        50,
        new Map<number, QuoteBasic[]>([
          [50, [createMockQuoteWithGas(aggHook, 990n, 100_000n)]],
          [
            90,
            [createMockQuoteWithGas(expensiveNoHookElsewhere, 1000n, 300_000n)],
          ],
        ]),
        [],
        ChainId.MAINNET,
        TradeType.ExactOut,
        buildInstrumentation({tradeType: TradeType.ExactOut})
      );

      const logs = infoMock().mock.calls.filter(
        c =>
          c[0] ===
          'QuoteBestSplitFinder agg-hook sole-candidate is gas-worse than best no-hook elsewhere'
      );
      expect(logs).toHaveLength(0);

      const comparisonMetrics = metricMock().mock.calls.filter(c =>
        (c[2] as {tags: string[]}).tags.some(t => t.startsWith('gasVerdict:'))
      );
      expect(comparisonMetrics).toHaveLength(1);
      expect((comparisonMetrics[0][2] as {tags: string[]}).tags).toContain(
        'gasVerdict:agghook_equal_or_less_gas'
      );
    });

    it('emits gas-comparison metric with no_nohook_anywhere verdict when no no-hook exists at any percentage', () => {
      const aggHook = aggHookRouteAt(
        '0xfa50000000000000000000000000000000000000',
        50
      );
      const otherAggHook = aggHookRouteAt(
        '0xfa60000000000000000000000000000000000000',
        80
      );

      // Every quote in percentageToSortedQuotes is agg-hook — no
      // cheapest no-hook fallback exists anywhere.
      finder['getBestUnusedQuotesStats'](
        50,
        new Map<number, QuoteBasic[]>([
          [50, [createMockQuoteWithGas(aggHook, 990n, 230_000n)]],
          [80, [createMockQuoteWithGas(otherAggHook, 1000n, 162_000n)]],
        ]),
        [],
        ChainId.MAINNET,
        TradeType.ExactOut,
        buildInstrumentation({tradeType: TradeType.ExactOut})
      );

      const comparisonMetrics = metricMock().mock.calls.filter(c =>
        (c[2] as {tags: string[]}).tags.some(t => t.startsWith('gasVerdict:'))
      );
      expect(comparisonMetrics).toHaveLength(1);
      expect((comparisonMetrics[0][2] as {tags: string[]}).tags).toContain(
        'gasVerdict:no_nohook_anywhere'
      );
    });

    it('emits gas-comparison metric with gas_info_missing verdict when agg-hook winner has no gas details (but a no-hook with gas exists elsewhere)', () => {
      const aggHook = aggHookRouteAt(
        '0xfa70000000000000000000000000000000000000',
        50
      );
      const noHookElsewhere = noHookRouteAt(
        '0xfa80000000000000000000000000000000000000',
        90
      );

      finder['getBestUnusedQuotesStats'](
        50,
        new Map<number, QuoteBasic[]>([
          [50, [createMockQuote(aggHook, 990n)]], // no gasDetails
          [90, [createMockQuoteWithGas(noHookElsewhere, 1000n, 150_000n)]],
        ]),
        [],
        ChainId.MAINNET,
        TradeType.ExactOut,
        buildInstrumentation({tradeType: TradeType.ExactOut})
      );

      const comparisonMetrics = metricMock().mock.calls.filter(c =>
        (c[2] as {tags: string[]}).tags.some(t => t.startsWith('gasVerdict:'))
      );
      expect(comparisonMetrics).toHaveLength(1);
      expect((comparisonMetrics[0][2] as {tags: string[]}).tags).toContain(
        'gasVerdict:gas_info_missing'
      );
    });

    it('respects soleCandidateGasComparisonLogBudget cap while metric keeps firing', () => {
      const aggHook = aggHookRouteAt(
        '0xfa90000000000000000000000000000000000000',
        50
      );
      const cheapNoHookElsewhere = noHookRouteAt(
        '0xfaa0000000000000000000000000000000000000',
        90
      );
      const quotesMap = new Map<number, QuoteBasic[]>([
        [50, [createMockQuoteWithGas(aggHook, 990n, 230_000n)]],
        [90, [createMockQuoteWithGas(cheapNoHookElsewhere, 1000n, 150_000n)]],
      ]);

      const sharedInstr = buildInstrumentation({tradeType: TradeType.ExactOut});
      for (let i = 0; i < 7; i++) {
        finder['getBestUnusedQuotesStats'](
          50,
          quotesMap,
          [],
          ChainId.MAINNET,
          TradeType.ExactOut,
          sharedInstr
        );
      }

      const comparisonLogs = infoMock().mock.calls.filter(
        c =>
          c[0] ===
          'QuoteBestSplitFinder agg-hook sole-candidate is gas-worse than best no-hook elsewhere'
      );
      const comparisonMetrics = metricMock().mock.calls.filter(c =>
        (c[2] as {tags: string[]}).tags.some(t => t.startsWith('gasVerdict:'))
      );
      expect(comparisonLogs).toHaveLength(5);
      expect(comparisonMetrics).toHaveLength(7);
      expect(sharedInstr.soleCandidateGasComparisonLogBudget.remaining).toBe(0);
    });

    it('does not emit gas-comparison signals when bothPresent (only fires on the sole-candidate path)', () => {
      // bothPresent=true → partition decision path, not sole-candidate.
      // The new instrumentation must not fire — it's nested inside the
      // `noHookQuotes.length === 0` branch of getBestUnusedQuotesStats.
      const aggHook = aggHookRouteAt(
        '0xfab0000000000000000000000000000000000000',
        50
      );
      const noHook = noHookRouteAt(
        '0xfac0000000000000000000000000000000000000',
        50
      );

      finder['getBestUnusedQuotesStats'](
        50,
        new Map<number, QuoteBasic[]>([
          [
            50,
            [
              createMockQuoteWithGas(noHook, 1000n, 100_000n),
              createMockQuoteWithGas(aggHook, 990n, 230_000n),
            ],
          ],
        ]),
        [],
        ChainId.MAINNET,
        TradeType.ExactOut,
        buildInstrumentation({tradeType: TradeType.ExactOut})
      );

      const comparisonLogs = infoMock().mock.calls.filter(
        c =>
          c[0] ===
          'QuoteBestSplitFinder agg-hook sole-candidate is gas-worse than best no-hook elsewhere'
      );
      const comparisonMetrics = metricMock().mock.calls.filter(c =>
        (c[2] as {tags: string[]}).tags.some(
          t =>
            t.startsWith('gasVerdict:') &&
            // gasVerdict is also used by GateEarlyReturnLeak so disambiguate
            // by verdict value: the new metric uses agghook_more_gas (not
            // agghook_more_gas_used).
            (t === 'gasVerdict:agghook_more_gas' ||
              t === 'gasVerdict:agghook_equal_or_less_gas' ||
              t === 'gasVerdict:no_nohook_anywhere')
        )
      );
      expect(comparisonLogs).toHaveLength(0);
      expect(comparisonMetrics).toHaveLength(0);
    });
  });

  describe('agg-hook competitiveness gate', () => {
    const aggHookAddr = STABLE_SWAP_NG[0]!;

    const noHookRouteAt = (addr: string, pct: number) =>
      createMockRoute([createMockPool(mockToken0, mockToken1, addr)], pct);
    const aggHookRouteAt = (addr: string, pct: number) =>
      createMockRoute(
        [createMockPool(mockToken0, mockToken1, addr, aggHookAddr)],
        pct
      );

    it('EXACT_IN: keeps partition when agg-hook winner ties or beats the displaced no-hook runner-up', () => {
      // Agg-hook winner (1000) >= no-hook runner-up (980). Gate passes →
      // 1 slot each → returnedCount=2 with both top quotes per class.
      const aggHook = aggHookRouteAt(
        '0xa000000000000000000000000000000000000000',
        50
      );
      const noHookWinner = noHookRouteAt(
        '0xa100000000000000000000000000000000000000',
        50
      );
      const noHookRunnerUp = noHookRouteAt(
        '0xa200000000000000000000000000000000000000',
        50
      );

      const stats = finder['getBestUnusedQuotesStats'](
        50,
        new Map<number, QuoteBasic[]>([
          [
            50,
            [
              createMockQuote(aggHook, 1000n),
              createMockQuote(noHookWinner, 990n),
              createMockQuote(noHookRunnerUp, 980n),
            ],
          ],
        ]),
        [],
        ChainId.MAINNET,
        TradeType.ExactIn
      );

      expect(stats.returnedCount).toBe(2);
      const routes = stats.quotes.map(q => q.route);
      expect(routes).toContain(aggHook);
      expect(routes).toContain(noHookWinner);
      expect(routes).not.toContain(noHookRunnerUp);
    });

    it('EXACT_IN: drops partition when agg-hook winner is worse than displaced no-hook runner-up beyond default tolerance (0 bps)', () => {
      // Agg-hook (990) < no-hook runner-up (995). Gate fails → all K=2 slots
      // to no-hook → agg-hook is dropped entirely.
      const noHookWinner = noHookRouteAt(
        '0xb000000000000000000000000000000000000000',
        50
      );
      const noHookRunnerUp = noHookRouteAt(
        '0xb100000000000000000000000000000000000000',
        50
      );
      const aggHook = aggHookRouteAt(
        '0xb200000000000000000000000000000000000000',
        50
      );

      const stats = finder['getBestUnusedQuotesStats'](
        50,
        new Map<number, QuoteBasic[]>([
          [
            50,
            [
              createMockQuote(noHookWinner, 1000n),
              createMockQuote(noHookRunnerUp, 995n),
              createMockQuote(aggHook, 990n),
            ],
          ],
        ]),
        [],
        ChainId.MAINNET,
        TradeType.ExactIn
      );

      expect(stats.returnedCount).toBe(2);
      const routes = stats.quotes.map(q => q.route);
      expect(routes).toContain(noHookWinner);
      expect(routes).toContain(noHookRunnerUp);
      expect(routes).not.toContain(aggHook);
    });

    it('EXACT_OUT: drops partition when agg-hook winner needs more input than displaced no-hook runner-up (direction flip)', () => {
      // EXACT_OUT: lower amount = better. Agg-hook (1000) > no-hook
      // runner-up (995) → agg-hook is worse → gate fails → drop.
      const noHookWinner = noHookRouteAt(
        '0xc000000000000000000000000000000000000000',
        50
      );
      const noHookRunnerUp = noHookRouteAt(
        '0xc100000000000000000000000000000000000000',
        50
      );
      const aggHook = aggHookRouteAt(
        '0xc200000000000000000000000000000000000000',
        50
      );

      const stats = finder['getBestUnusedQuotesStats'](
        50,
        new Map<number, QuoteBasic[]>([
          [
            50,
            [
              createMockQuote(noHookWinner, 990n),
              createMockQuote(noHookRunnerUp, 995n),
              createMockQuote(aggHook, 1000n),
            ],
          ],
        ]),
        [],
        ChainId.MAINNET,
        TradeType.ExactOut
      );

      expect(stats.returnedCount).toBe(2);
      const routes = stats.quotes.map(q => q.route);
      expect(routes).toContain(noHookWinner);
      expect(routes).toContain(noHookRunnerUp);
      expect(routes).not.toContain(aggHook);
    });

    it('keeps partition when no no-hook runner-up exists (nothing to evict)', () => {
      // Only 1 no-hook quote fills the entire no-hook budget under the
      // partition; there is no runner-up to displace, so the gate passes
      // vacuously and the partition stays on.
      const noHook = noHookRouteAt(
        '0xd000000000000000000000000000000000000000',
        50
      );
      const aggHook1 = aggHookRouteAt(
        '0xd100000000000000000000000000000000000000',
        50
      );
      const aggHook2 = aggHookRouteAt(
        '0xd200000000000000000000000000000000000000',
        50
      );

      const stats = finder['getBestUnusedQuotesStats'](
        50,
        new Map<number, QuoteBasic[]>([
          [
            50,
            [
              createMockQuote(aggHook1, 1000n),
              createMockQuote(aggHook2, 999n),
              createMockQuote(noHook, 1n), // far worse, but still no runner-up to evict
            ],
          ],
        ]),
        [],
        ChainId.MAINNET,
        TradeType.ExactIn
      );

      expect(stats.returnedCount).toBe(2);
      const routes = stats.quotes.map(q => q.route);
      expect(routes).toContain(noHook);
      expect(routes).toContain(aggHook1);
      expect(routes).not.toContain(aggHook2);
    });

    it('only-agg-hook present: K slots to agg-hook regardless of gate', () => {
      const aggHook1 = aggHookRouteAt(
        '0xe000000000000000000000000000000000000000',
        50
      );
      const aggHook2 = aggHookRouteAt(
        '0xe100000000000000000000000000000000000000',
        50
      );
      const aggHook3 = aggHookRouteAt(
        '0xe200000000000000000000000000000000000000',
        50
      );

      const stats = finder['getBestUnusedQuotesStats'](
        50,
        new Map<number, QuoteBasic[]>([
          [
            50,
            [
              createMockQuote(aggHook1, 1000n),
              createMockQuote(aggHook2, 990n),
              createMockQuote(aggHook3, 980n),
            ],
          ],
        ]),
        [],
        ChainId.MAINNET,
        TradeType.ExactIn
      );

      expect(stats.returnedCount).toBe(2);
      expect(stats.quotes.map(q => q.route)).toEqual([aggHook1, aggHook2]);
    });

    it('honors a non-zero tolerance — admits a marginally-worse agg-hook within X bps', () => {
      // Constructed with 10 bps tolerance. aggHookWinner is ~5 bps worse than
      // no-hook runner-up, which is within tolerance → partition stays on.
      const tolerantFinder = new QuoteBestSplitFinder<MockPool>(10n);

      // EXACT_IN amounts. runnerUp = 10_000_000n, aggHookWinner = 9_995_000n
      // → badness = 5000, runnerUp = 10_000_000 → 5 bps gap.
      const noHookWinner = noHookRouteAt(
        '0xf000000000000000000000000000000000000000',
        50
      );
      const noHookRunnerUp = noHookRouteAt(
        '0xf100000000000000000000000000000000000000',
        50
      );
      const aggHook = aggHookRouteAt(
        '0xf200000000000000000000000000000000000000',
        50
      );

      const stats = tolerantFinder['getBestUnusedQuotesStats'](
        50,
        new Map<number, QuoteBasic[]>([
          [
            50,
            [
              createMockQuote(noHookWinner, 10_000_010n),
              createMockQuote(noHookRunnerUp, 10_000_000n),
              createMockQuote(aggHook, 9_995_000n),
            ],
          ],
        ]),
        [],
        ChainId.MAINNET,
        TradeType.ExactIn
      );

      expect(stats.returnedCount).toBe(2);
      const routes = stats.quotes.map(q => q.route);
      expect(routes).toContain(noHookWinner);
      expect(routes).toContain(aggHook); // within tolerance → kept
      expect(routes).not.toContain(noHookRunnerUp);
    });

    // ----- Gas-aware competitiveness gate -----

    const createMockQuoteWithGasUse = (
      route: RouteBasic<MockPool>,
      amount: bigint,
      gasUse: bigint
    ): QuoteBasic =>
      ({
        route,
        amount,
        gasDetails: {
          gasPriceInWei: 1n,
          gasCostInWei: 1n,
          gasCostInEth: 0,
          gasUse,
        },
      }) as unknown as QuoteBasic;

    it('drops partition when agg-hook ties on raw but uses more gas than runner-up (default gas tolerance 0n)', () => {
      // This is the prod-confirmed regression shape: agg-hook ties or
      // beats no-hook runner-up on raw amount (raw gate passes at tol=0n
      // because badness<=0), but uses materially more gas. The new gas
      // gate must reject it. EXACT_OUT.
      const noHookWinner = noHookRouteAt(
        '0xaa00000000000000000000000000000000000000',
        50
      );
      const noHookRunnerUp = noHookRouteAt(
        '0xab00000000000000000000000000000000000000',
        50
      );
      const aggHook = aggHookRouteAt(
        '0xac00000000000000000000000000000000000000',
        50
      );

      const stats = finder['getBestUnusedQuotesStats'](
        50,
        new Map<number, QuoteBasic[]>([
          [
            50,
            [
              createMockQuoteWithGasUse(noHookWinner, 1000n, 100n),
              createMockQuoteWithGasUse(noHookRunnerUp, 1001n, 100n),
              // Raw 1000n: ties best no-hook → raw gate passes.
              // gasUse 500n: 400n more than runner-up's 100n → gas gate fails.
              createMockQuoteWithGasUse(aggHook, 1000n, 500n),
            ],
          ],
        ]),
        [],
        ChainId.MAINNET,
        TradeType.ExactOut
      );

      expect(stats.returnedCount).toBe(2);
      const routes = stats.quotes.map(q => q.route);
      expect(routes).toContain(noHookWinner);
      expect(routes).toContain(noHookRunnerUp);
      expect(routes).not.toContain(aggHook);
    });

    it('keeps partition when agg-hook ties on raw and uses equal gas', () => {
      const noHookWinner = noHookRouteAt(
        '0xba00000000000000000000000000000000000000',
        50
      );
      const noHookRunnerUp = noHookRouteAt(
        '0xbb00000000000000000000000000000000000000',
        50
      );
      const aggHook = aggHookRouteAt(
        '0xbc00000000000000000000000000000000000000',
        50
      );

      const stats = finder['getBestUnusedQuotesStats'](
        50,
        new Map<number, QuoteBasic[]>([
          [
            50,
            [
              createMockQuoteWithGasUse(noHookWinner, 1000n, 100n),
              createMockQuoteWithGasUse(noHookRunnerUp, 1001n, 100n),
              // Tied raw + equal gas → partition fires.
              createMockQuoteWithGasUse(aggHook, 1000n, 100n),
            ],
          ],
        ]),
        [],
        ChainId.MAINNET,
        TradeType.ExactOut
      );

      expect(stats.returnedCount).toBe(2);
      const routes = stats.quotes.map(q => q.route);
      expect(routes).toContain(noHookWinner);
      expect(routes).toContain(aggHook);
      expect(routes).not.toContain(noHookRunnerUp);
    });

    it('keeps partition when agg-hook uses LESS gas than runner-up', () => {
      const noHookWinner = noHookRouteAt(
        '0xca00000000000000000000000000000000000000',
        50
      );
      const noHookRunnerUp = noHookRouteAt(
        '0xcb00000000000000000000000000000000000000',
        50
      );
      const aggHook = aggHookRouteAt(
        '0xcc00000000000000000000000000000000000000',
        50
      );

      const stats = finder['getBestUnusedQuotesStats'](
        50,
        new Map<number, QuoteBasic[]>([
          [
            50,
            [
              createMockQuoteWithGasUse(noHookWinner, 1000n, 200n),
              createMockQuoteWithGasUse(noHookRunnerUp, 1001n, 200n),
              createMockQuoteWithGasUse(aggHook, 1000n, 50n), // less gas
            ],
          ],
        ]),
        [],
        ChainId.MAINNET,
        TradeType.ExactOut
      );

      expect(stats.returnedCount).toBe(2);
      const routes = stats.quotes.map(q => q.route);
      expect(routes).toContain(aggHook);
    });

    it('honors a non-zero gas tolerance — admits a marginally-more-gas agg-hook within the threshold', () => {
      // Constructor: raw tolerance 0n, gas tolerance 1000n units.
      // Agg-hook ties on raw and uses 500 more gas units → within 1000n
      // gas tolerance → gate passes.
      const tolerantFinder = new QuoteBestSplitFinder<MockPool>(0n, 1000n);

      const noHookWinner = noHookRouteAt(
        '0xda00000000000000000000000000000000000000',
        50
      );
      const noHookRunnerUp = noHookRouteAt(
        '0xdb00000000000000000000000000000000000000',
        50
      );
      const aggHook = aggHookRouteAt(
        '0xdc00000000000000000000000000000000000000',
        50
      );

      const stats = tolerantFinder['getBestUnusedQuotesStats'](
        50,
        new Map<number, QuoteBasic[]>([
          [
            50,
            [
              createMockQuoteWithGasUse(noHookWinner, 1000n, 100n),
              createMockQuoteWithGasUse(noHookRunnerUp, 1001n, 100n),
              createMockQuoteWithGasUse(aggHook, 1000n, 600n), // +500 gas
            ],
          ],
        ]),
        [],
        ChainId.MAINNET,
        TradeType.ExactOut
      );

      expect(stats.returnedCount).toBe(2);
      const routes = stats.quotes.map(q => q.route);
      expect(routes).toContain(aggHook);
    });

    it('falls back to BPS-only gate when gasUse is absent on either side (preserves pre-fix behavior)', () => {
      // No gasDetails on the quotes — exactly mirrors how the rest of the
      // QuoteBestSplitFinder.test.ts suite constructs mocks. Gas gate must
      // be a no-op so existing test scenarios keep working unchanged.
      const noHookWinner = noHookRouteAt(
        '0xea00000000000000000000000000000000000000',
        50
      );
      const noHookRunnerUp = noHookRouteAt(
        '0xeb00000000000000000000000000000000000000',
        50
      );
      const aggHook = aggHookRouteAt(
        '0xec00000000000000000000000000000000000000',
        50
      );

      const stats = finder['getBestUnusedQuotesStats'](
        50,
        new Map<number, QuoteBasic[]>([
          [
            50,
            [
              createMockQuote(noHookWinner, 1000n),
              createMockQuote(noHookRunnerUp, 1001n),
              createMockQuote(aggHook, 1000n), // raw-tied, no gas info
            ],
          ],
        ]),
        [],
        ChainId.MAINNET,
        TradeType.ExactOut
      );

      // BPS-only path → raw tie passes → partition fires.
      expect(stats.returnedCount).toBe(2);
      const routes = stats.quotes.map(q => q.route);
      expect(routes).toContain(aggHook);
    });

    it('EXACT_IN: drops partition when agg-hook ties raw but uses more gas', () => {
      // EXACT_IN: higher amount better. Tied raw + more gas → same gate
      // reject (gas check is direction-agnostic).
      const noHookWinner = noHookRouteAt(
        '0xfa00000000000000000000000000000000000000',
        50
      );
      const noHookRunnerUp = noHookRouteAt(
        '0xfb00000000000000000000000000000000000000',
        50
      );
      const aggHook = aggHookRouteAt(
        '0xfc00000000000000000000000000000000000000',
        50
      );

      const stats = finder['getBestUnusedQuotesStats'](
        50,
        new Map<number, QuoteBasic[]>([
          [
            50,
            [
              createMockQuoteWithGasUse(noHookWinner, 1001n, 100n),
              createMockQuoteWithGasUse(noHookRunnerUp, 1000n, 100n),
              // EXACT_IN, higher amount best. aggHook=1000 ties runnerUp →
              // raw gate passes. Gas 500 vs runnerUp 100 → gas gate fails.
              createMockQuoteWithGasUse(aggHook, 1000n, 500n),
            ],
          ],
        ]),
        [],
        ChainId.MAINNET,
        TradeType.ExactIn
      );

      expect(stats.returnedCount).toBe(2);
      const routes = stats.quotes.map(q => q.route);
      expect(routes).not.toContain(aggHook);
    });

    // ----- Post-fix: gas gate runs even when there's no displacement
    //
    // These tests directly target the prod 1k-USDC WETH→USDC EXACT_OUT
    // loss class. Pre-fix the gate took an early-return at
    // `noHookQuotes.length <= noHookBudgetIfPartitioned`, skipping the
    // gas check whenever a percentage bucket had exactly 1 no-hook
    // quote. PR #8182 instrumentation confirmed the leak fired ~100+
    // times in 3 min on prod with the classic 80k-unit gas delta at
    // percentages 5, 70, 75, 80, 85, 90. The fix anchors the gas check
    // against `noHookQuotes[0]` regardless of displacement state.

    it('rejects gas-bad agg-hook when noHookQuotes.length === 1 (prod loss shape)', () => {
      // The percentage=5 bucket on the prod loss path has exactly 1
      // no-hook quote (the v3 direct E0554a backup leg) and a Curve+Fluid
      // v4 agg-hook chain that costs ~80k more gas. Pre-fix the gate
      // admitted both; post-fix the gas check anchors on the lone
      // no-hook and rejects the agg-hook.
      const noHookWinner = noHookRouteAt(
        '0xab10000000000000000000000000000000000000',
        5
      );
      const aggHook = aggHookRouteAt(
        '0xab20000000000000000000000000000000000000',
        5
      );

      const stats = finder['getBestUnusedQuotesStats'](
        5,
        new Map<number, QuoteBasic[]>([
          [
            5,
            [
              createMockQuoteWithGasUse(noHookWinner, 1000n, 150_000n),
              // +80k gas delta vs noHookWinner — same magnitude as the
              // prod GateEarlyReturnLeak emissions captured in PR #8182.
              createMockQuoteWithGasUse(aggHook, 1000n, 230_000n),
            ],
          ],
        ]),
        [],
        ChainId.MAINNET,
        TradeType.ExactOut
      );

      expect(stats.returnedCount).toBe(1);
      const routes = stats.quotes.map(q => q.route);
      expect(routes).toContain(noHookWinner);
      expect(routes).not.toContain(aggHook);
    });

    it('admits agg-hook when noHookQuotes.length === 1 and agg-hook is gas-competitive', () => {
      // Symmetric case: same bucket shape but agg-hook is genuinely
      // gas-competitive (equal-or-less). The fix must not over-correct
      // and exclude every agg-hook in the no-displacement case — only
      // the gas-bad ones.
      const noHookWinner = noHookRouteAt(
        '0xab30000000000000000000000000000000000000',
        50
      );
      const aggHook = aggHookRouteAt(
        '0xab40000000000000000000000000000000000000',
        50
      );

      const stats = finder['getBestUnusedQuotesStats'](
        50,
        new Map<number, QuoteBasic[]>([
          [
            50,
            [
              createMockQuoteWithGasUse(noHookWinner, 1000n, 200_000n),
              createMockQuoteWithGasUse(aggHook, 1000n, 150_000n),
            ],
          ],
        ]),
        [],
        ChainId.MAINNET,
        TradeType.ExactOut
      );

      expect(stats.returnedCount).toBe(2);
      const routes = stats.quotes.map(q => q.route);
      expect(routes).toContain(noHookWinner);
      expect(routes).toContain(aggHook);
    });

    it('honors non-zero gas tolerance even when noHookQuotes.length === 1', () => {
      // The gate's gas-tolerance constructor param must apply in the
      // no-displacement branch too. With 100k unit tolerance, an
      // 80k-unit gas delta is admitted; a 120k-unit delta is rejected.
      const tolerantFinder = new QuoteBestSplitFinder<MockPool>(0n, 100_000n);
      const noHookWinner = noHookRouteAt(
        '0xab50000000000000000000000000000000000000',
        50
      );
      const aggHookWithinTol = aggHookRouteAt(
        '0xab60000000000000000000000000000000000000',
        50
      );

      const stats = tolerantFinder['getBestUnusedQuotesStats'](
        50,
        new Map<number, QuoteBasic[]>([
          [
            50,
            [
              createMockQuoteWithGasUse(noHookWinner, 1000n, 150_000n),
              // +80k → within 100k tolerance → admitted.
              createMockQuoteWithGasUse(aggHookWithinTol, 1000n, 230_000n),
            ],
          ],
        ]),
        [],
        ChainId.MAINNET,
        TradeType.ExactOut
      );
      expect(stats.returnedCount).toBe(2);
      expect(stats.quotes.map(q => q.route)).toContain(aggHookWithinTol);

      // And the matching reject case at the same tolerance.
      const aggHookOverTol = aggHookRouteAt(
        '0xab70000000000000000000000000000000000000',
        50
      );
      const stats2 = tolerantFinder['getBestUnusedQuotesStats'](
        50,
        new Map<number, QuoteBasic[]>([
          [
            50,
            [
              createMockQuoteWithGasUse(noHookWinner, 1000n, 150_000n),
              // +120k → outside 100k tolerance → rejected.
              createMockQuoteWithGasUse(aggHookOverTol, 1000n, 270_000n),
            ],
          ],
        ]),
        [],
        ChainId.MAINNET,
        TradeType.ExactOut
      );
      expect(stats2.returnedCount).toBe(1);
      expect(stats2.quotes.map(q => q.route)).not.toContain(aggHookOverTol);
    });

    // ----- Sole-candidate gas gate (this PR) -----
    //
    // PR #8195 closed the K-budget gate's early-return leak (bothPresent
    // case with exactly 1 no-hook). The remaining loss-burst path is the
    // sole-candidate branch where `noHookQuotes.length === 0 &&
    // aggHookQuotes.length > 0`: the existing code admits agg-hook by
    // default because there's no no-hook anchor at the percentage. PR
    // #8248 instrumentation captured 200+ harmful sole-candidate firings
    // in 3 min of prod with the same Curve+Fluid v4 gas signature.
    //
    // The fix extends the gate's gas-use check to this branch using the
    // cheapest no-hook quote anywhere in `percentageToSortedQuotes` as
    // the anchor.

    it('rejects sole-candidate agg-hook when gas exceeds cheapest no-hook anywhere (prod loss shape)', () => {
      // Mirrors the dominant prod PR-#8248 emission: agg-hook at pct=85
      // uses 162k gas; cheapest no-hook anywhere is a 100% direct route
      // at pct=100 with 97k gas. Delta = 65k > tolerance 0n → reject.
      const aggHook = aggHookRouteAt(
        '0xfb10000000000000000000000000000000000000',
        85
      );
      const cheapestNoHookElsewhere = noHookRouteAt(
        '0xfb20000000000000000000000000000000000000',
        100
      );

      const stats = finder['getBestUnusedQuotesStats'](
        85,
        new Map<number, QuoteBasic[]>([
          [85, [createMockQuoteWithGasUse(aggHook, 1000n, 162_000n)]],
          [
            100,
            [
              createMockQuoteWithGasUse(
                cheapestNoHookElsewhere,
                1000n,
                97_000n
              ),
            ],
          ],
        ]),
        [],
        ChainId.MAINNET,
        TradeType.ExactOut
      );

      expect(stats.returnedCount).toBe(0);
      expect(stats.quotes.map(q => q.route)).not.toContain(aggHook);
    });

    it('admits sole-candidate agg-hook when gas is competitive with cheapest no-hook anywhere', () => {
      // Symmetric case: agg-hook uses fewer gas units than the cheapest
      // no-hook fallback. Gate admits.
      const aggHook = aggHookRouteAt(
        '0xfb30000000000000000000000000000000000000',
        85
      );
      const expensiveNoHookElsewhere = noHookRouteAt(
        '0xfb40000000000000000000000000000000000000',
        100
      );

      const stats = finder['getBestUnusedQuotesStats'](
        85,
        new Map<number, QuoteBasic[]>([
          [85, [createMockQuoteWithGasUse(aggHook, 1000n, 90_000n)]],
          [
            100,
            [
              createMockQuoteWithGasUse(
                expensiveNoHookElsewhere,
                1000n,
                100_000n
              ),
            ],
          ],
        ]),
        [],
        ChainId.MAINNET,
        TradeType.ExactOut
      );

      expect(stats.returnedCount).toBe(1);
      expect(stats.quotes.map(q => q.route)).toContain(aggHook);
    });

    it('admits sole-candidate agg-hook when no no-hook exists anywhere (trade has no fallback)', () => {
      // The cross-bucket scan finds no no-hook anywhere. Rejecting the
      // agg-hook would leave the trade with no route, so the gate
      // admits.
      const aggHook = aggHookRouteAt(
        '0xfb50000000000000000000000000000000000000',
        85
      );
      const otherAggHook = aggHookRouteAt(
        '0xfb60000000000000000000000000000000000000',
        70
      );

      const stats = finder['getBestUnusedQuotesStats'](
        85,
        new Map<number, QuoteBasic[]>([
          [85, [createMockQuoteWithGasUse(aggHook, 1000n, 230_000n)]],
          [70, [createMockQuoteWithGasUse(otherAggHook, 1000n, 162_000n)]],
        ]),
        [],
        ChainId.MAINNET,
        TradeType.ExactOut
      );

      expect(stats.returnedCount).toBe(1);
      expect(stats.quotes.map(q => q.route)).toContain(aggHook);
    });

    it('admits sole-candidate agg-hook when gas info is missing (preserves test-mock compatibility)', () => {
      // No gasDetails on the agg-hook → gate skips the comparison and
      // admits. Mirrors how unit-test fixtures elsewhere in this suite
      // construct mocks without gas info.
      const aggHook = aggHookRouteAt(
        '0xfb70000000000000000000000000000000000000',
        85
      );
      const noHookElsewhere = noHookRouteAt(
        '0xfb80000000000000000000000000000000000000',
        100
      );

      const stats = finder['getBestUnusedQuotesStats'](
        85,
        new Map<number, QuoteBasic[]>([
          [85, [createMockQuote(aggHook, 1000n)]], // no gasDetails
          [100, [createMockQuoteWithGasUse(noHookElsewhere, 1000n, 97_000n)]],
        ]),
        [],
        ChainId.MAINNET,
        TradeType.ExactOut
      );

      expect(stats.returnedCount).toBe(1);
      expect(stats.quotes.map(q => q.route)).toContain(aggHook);
    });

    it('honors non-zero gas tolerance on the sole-candidate path', () => {
      // Tolerance 100k. 65k delta admitted; 120k delta rejected.
      const tolerantFinder = new QuoteBestSplitFinder<MockPool>(
        0n,
        0n,
        100_000n
      );
      const cheapestNoHookElsewhere = noHookRouteAt(
        '0xfb90000000000000000000000000000000000000',
        100
      );
      const aggHookWithinTol = aggHookRouteAt(
        '0xfba0000000000000000000000000000000000000',
        85
      );

      const stats = tolerantFinder['getBestUnusedQuotesStats'](
        85,
        new Map<number, QuoteBasic[]>([
          // +65k delta → within 100k tolerance → admitted.
          [85, [createMockQuoteWithGasUse(aggHookWithinTol, 1000n, 162_000n)]],
          [
            100,
            [
              createMockQuoteWithGasUse(
                cheapestNoHookElsewhere,
                1000n,
                97_000n
              ),
            ],
          ],
        ]),
        [],
        ChainId.MAINNET,
        TradeType.ExactOut
      );
      expect(stats.returnedCount).toBe(1);
      expect(stats.quotes.map(q => q.route)).toContain(aggHookWithinTol);

      const aggHookOverTol = aggHookRouteAt(
        '0xfbb0000000000000000000000000000000000000',
        85
      );
      const stats2 = tolerantFinder['getBestUnusedQuotesStats'](
        85,
        new Map<number, QuoteBasic[]>([
          // +120k delta → outside 100k tolerance → rejected.
          [85, [createMockQuoteWithGasUse(aggHookOverTol, 1000n, 217_000n)]],
          [
            100,
            [
              createMockQuoteWithGasUse(
                cheapestNoHookElsewhere,
                1000n,
                97_000n
              ),
            ],
          ],
        ]),
        [],
        ChainId.MAINNET,
        TradeType.ExactOut
      );
      expect(stats2.returnedCount).toBe(0);
      expect(stats2.quotes.map(q => q.route)).not.toContain(aggHookOverTol);
    });

    it('emits SoleCandidateDecision metric with verdict reflecting gate outcome', () => {
      // Verifies the dedicated decision-tracking metric (companion to
      // PartitionDecision) fires once per sole-candidate firing with
      // the verdict tag set to admitted/rejected.
      const aggHookRejected = aggHookRouteAt(
        '0xfbc0000000000000000000000000000000000000',
        85
      );
      const cheapestNoHookElsewhere = noHookRouteAt(
        '0xfbd0000000000000000000000000000000000000',
        100
      );

      finder['getBestUnusedQuotesStats'](
        85,
        new Map<number, QuoteBasic[]>([
          [85, [createMockQuoteWithGasUse(aggHookRejected, 1000n, 162_000n)]],
          [
            100,
            [
              createMockQuoteWithGasUse(
                cheapestNoHookElsewhere,
                1000n,
                97_000n
              ),
            ],
          ],
        ]),
        [],
        ChainId.MAINNET,
        TradeType.ExactOut,
        // testAggHooks must be true for the decision metric to emit;
        // build a minimal instrumentation shim that mirrors the suite
        // helper used in the partition-decision tests.
        {
          ctx: mockContext,
          tradeType: TradeType.ExactOut,
          testAggHooks: true,
          partitionEvictLogBudget: {remaining: 5},
          soleCandidateLogBudget: {remaining: 5},
          partitionGasAdjustedLogBudget: {remaining: 5},
          gateEarlyReturnLeakLogBudget: {remaining: 5},
          soleCandidateGasComparisonLogBudget: {remaining: 5},
          metricTags: ['chainId:1'],
        }
      );

      const decisionMetrics = (
        mockContext.metrics.count as ReturnType<typeof vi.fn>
      ).mock.calls.filter(c =>
        (c[2] as {tags: string[]}).tags.some(t =>
          t.startsWith('soleCandidateVerdict:')
        )
      );
      expect(decisionMetrics).toHaveLength(1);
      expect((decisionMetrics[0][2] as {tags: string[]}).tags).toContain(
        'soleCandidateVerdict:rejected'
      );
    });
  });

  describe('chosen-split gas-comparison instrumentation', () => {
    const aggHookAddr = STABLE_SWAP_NG[0]!;

    const noHookRouteAt = (addr: string, pct: number) =>
      createMockRoute([createMockPool(mockToken0, mockToken1, addr)], pct);
    const aggHookRouteAt = (addr: string, pct: number) =>
      createMockRoute(
        [createMockPool(mockToken0, mockToken1, addr, aggHookAddr)],
        pct
      );

    const createMockQuoteWithGas = (
      route: RouteBasic<MockPool>,
      amount: bigint,
      gasUse: bigint
    ): QuoteBasic =>
      ({
        route,
        amount,
        gasDetails: {
          gasPriceInWei: 1n,
          gasCostInWei: 1n,
          gasCostInEth: 0,
          gasUse,
        },
      }) as unknown as QuoteBasic;

    const buildQuoteMap = (
      quotes: QuoteBasic[]
    ): Map<RouteBasic<MockPool>, QuoteBasic> => {
      const m = new Map<RouteBasic<MockPool>, QuoteBasic>();
      for (const q of quotes) {
        m.set(q.route as RouteBasic<MockPool>, q);
      }
      return m;
    };

    const infoMock = () => mockContext.logger.info as ReturnType<typeof vi.fn>;
    const metricMock = () =>
      mockContext.metrics.count as ReturnType<typeof vi.fn>;

    const splitMetricCalls = () =>
      metricMock().mock.calls.filter(c =>
        (c[2] as {tags: string[]}).tags.some(t => t.startsWith('splitVerdict:'))
      );
    const splitLogCalls = () =>
      infoMock().mock.calls.filter(
        c =>
          c[0] ===
          'QuoteBestSplitFinder chosen split has agg-hook with worse gas than no-hook alternative'
      );

    it('emits empty_result verdict when no combinations exist', () => {
      finder['maybeLogChosenSplitGasComparison'](
        [],
        new Map(),
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1']
      );

      expect(splitMetricCalls()).toHaveLength(1);
      expect((splitMetricCalls()[0][2] as {tags: string[]}).tags).toContain(
        'splitVerdict:empty_result'
      );
      expect(splitLogCalls()).toHaveLength(0);
    });

    it('emits nohook_only verdict when chosen split has no agg-hook routes', () => {
      const r1 = noHookRouteAt(
        '0xa110000000000000000000000000000000000000',
        100
      );
      const result = [[r1]];
      const quoteMap = buildQuoteMap([createMockQuoteWithGas(r1, 1000n, 100n)]);

      finder['maybeLogChosenSplitGasComparison'](
        result,
        quoteMap,
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1']
      );

      expect(splitMetricCalls()).toHaveLength(1);
      expect((splitMetricCalls()[0][2] as {tags: string[]}).tags).toContain(
        'splitVerdict:nohook_only'
      );
      expect(splitLogCalls()).toHaveLength(0);
    });

    it('emits agghook_no_alternative verdict when chosen has agg-hook and result has no no-hook combination', () => {
      const aggHook = aggHookRouteAt(
        '0xa120000000000000000000000000000000000000',
        100
      );
      const otherAggHook = aggHookRouteAt(
        '0xa130000000000000000000000000000000000000',
        100
      );
      const result = [[aggHook], [otherAggHook]];
      const quoteMap = buildQuoteMap([
        createMockQuoteWithGas(aggHook, 1000n, 250_000n),
        createMockQuoteWithGas(otherAggHook, 999n, 240_000n),
      ]);

      finder['maybeLogChosenSplitGasComparison'](
        result,
        quoteMap,
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1']
      );

      expect(splitMetricCalls()).toHaveLength(1);
      expect((splitMetricCalls()[0][2] as {tags: string[]}).tags).toContain(
        'splitVerdict:agghook_no_alternative'
      );
      expect(splitLogCalls()).toHaveLength(0);
    });

    it('emits agghook_chosen_lower_gas verdict (no log) when agg-hook split uses lower or equal gas than the no-hook alternative', () => {
      const aggHook = aggHookRouteAt(
        '0xa140000000000000000000000000000000000000',
        100
      );
      const noHookAlt = noHookRouteAt(
        '0xa150000000000000000000000000000000000000',
        100
      );
      // Chosen is agg-hook with 100 gas; alternative is no-hook with 200 gas.
      // The agg-hook is gas-better (legitimate).
      const result = [[aggHook], [noHookAlt]];
      const quoteMap = buildQuoteMap([
        createMockQuoteWithGas(aggHook, 1000n, 100n),
        createMockQuoteWithGas(noHookAlt, 999n, 200n),
      ]);

      finder['maybeLogChosenSplitGasComparison'](
        result,
        quoteMap,
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1']
      );

      expect(splitMetricCalls()).toHaveLength(1);
      expect((splitMetricCalls()[0][2] as {tags: string[]}).tags).toContain(
        'splitVerdict:agghook_chosen_lower_gas'
      );
      expect(splitLogCalls()).toHaveLength(0);
    });

    it('emits agghook_chosen_higher_gas verdict + log when agg-hook split uses MORE gas than the no-hook alternative (suspected residual)', () => {
      // The prod loss pattern: chosen split contains a hooked leg
      // (e.g. Fluid 90%) with higher gas; a pure-no-hook alternative
      // (e.g. v3 100% direct) exists with lower gas. DFS picked the
      // hooked split because it has marginally higher raw amount.
      const aggHookLeg = aggHookRouteAt(
        '0xa160000000000000000000000000000000000000',
        90
      );
      const aggHookSidekick = noHookRouteAt(
        '0xa170000000000000000000000000000000000000',
        10
      );
      const noHookAlt = noHookRouteAt(
        '0xa180000000000000000000000000000000000000',
        100
      );

      const chosen = [aggHookLeg, aggHookSidekick];
      const altCombination = [noHookAlt];
      const result = [chosen, altCombination];
      const quoteMap = buildQuoteMap([
        createMockQuoteWithGas(aggHookLeg, 950n, 700_000n),
        createMockQuoteWithGas(aggHookSidekick, 100n, 100_000n),
        createMockQuoteWithGas(noHookAlt, 1000n, 350_000n),
      ]);

      finder['maybeLogChosenSplitGasComparison'](
        result,
        quoteMap,
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1']
      );

      const metrics = splitMetricCalls();
      expect(metrics).toHaveLength(1);
      expect((metrics[0][2] as {tags: string[]}).tags).toContain(
        'splitVerdict:agghook_chosen_higher_gas'
      );

      const logs = splitLogCalls();
      expect(logs).toHaveLength(1);
      const payload = logs[0][1] as Record<string, unknown>;
      // Chosen total raw = 950 + 100 = 1050; gas = 700k + 100k = 800k.
      expect((payload.chosenSplit as {rawTotal: string}).rawTotal).toBe('1050');
      expect((payload.chosenSplit as {gasTotal: string}).gasTotal).toBe(
        '800000'
      );
      expect((payload.noHookAlternative as {rawTotal: string}).rawTotal).toBe(
        '1000'
      );
      expect((payload.noHookAlternative as {gasTotal: string}).gasTotal).toBe(
        '350000'
      );
      // Delta = 800k - 350k = 450k.
      expect(payload.gasTotalDelta).toBe('450000');
      expect(payload.rawTotalDelta).toBe('50');
    });

    it('emits gas_info_missing verdict when any leg in the chosen split has no gasUse', () => {
      const aggHook = aggHookRouteAt(
        '0xa190000000000000000000000000000000000000',
        100
      );
      const result = [[aggHook]];
      // Quote without gasDetails.
      const quote: QuoteBasic = {route: aggHook, amount: 1000n} as QuoteBasic;
      const quoteMap = buildQuoteMap([quote]);

      finder['maybeLogChosenSplitGasComparison'](
        result,
        quoteMap,
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1']
      );

      expect(splitMetricCalls()).toHaveLength(1);
      expect((splitMetricCalls()[0][2] as {tags: string[]}).tags).toContain(
        'splitVerdict:gas_info_missing'
      );
      expect(splitLogCalls()).toHaveLength(0);
    });

    it('does not emit when testAggHooks is false', () => {
      const aggHook = aggHookRouteAt(
        '0xa1a0000000000000000000000000000000000000',
        100
      );
      const noHookAlt = noHookRouteAt(
        '0xa1b0000000000000000000000000000000000000',
        100
      );
      const result = [[aggHook], [noHookAlt]];
      const quoteMap = buildQuoteMap([
        createMockQuoteWithGas(aggHook, 1000n, 700_000n),
        createMockQuoteWithGas(noHookAlt, 999n, 200_000n),
      ]);

      finder['maybeLogChosenSplitGasComparison'](
        result,
        quoteMap,
        ChainId.MAINNET,
        mockContext,
        false, // testAggHooks=false → instrumentation should be silent
        TradeType.ExactIn,
        ['chainId:1']
      );

      expect(splitMetricCalls()).toHaveLength(0);
      expect(splitLogCalls()).toHaveLength(0);
    });
  });

  describe('gas-adjusted scoreAndSortCombinations', () => {
    const aggHookAddr = STABLE_SWAP_NG[0]!;

    const noHookRouteAt = (addr: string, pct: number) =>
      createMockRoute([createMockPool(mockToken0, mockToken1, addr)], pct);
    const aggHookRouteAt = (addr: string, pct: number) =>
      createMockRoute(
        [createMockPool(mockToken0, mockToken1, addr, aggHookAddr)],
        pct
      );

    const createMockQuoteWithGasAdj = (
      route: RouteBasic<MockPool>,
      amount: bigint,
      gasCostInQuoteToken: bigint
    ): QuoteBasic =>
      ({
        route,
        amount,
        gasDetails: {
          gasPriceInWei: 1n,
          gasCostInWei: 1n,
          gasCostInEth: 0,
          gasUse: 0n,
          gasCostInQuoteToken,
        },
      }) as unknown as QuoteBasic;

    const buildQuoteMap = (
      quotes: QuoteBasic[]
    ): Map<RouteBasic<MockPool>, QuoteBasic> => {
      const m = new Map<RouteBasic<MockPool>, QuoteBasic>();
      for (const q of quotes) {
        m.set(q.route as RouteBasic<MockPool>, q);
      }
      return m;
    };

    it('EXACT_IN: ranks combinations by raw - gasCostInQuoteToken (gas-good split beats raw-better/gas-bad split)', () => {
      // Mirrors the prod PR #8285 finding: chosen split has slightly
      // better raw but materially worse gas — under gas-adjusted
      // scoring, the no-hook alternative now wins.
      const aggHookLeg = aggHookRouteAt(
        '0xfd10000000000000000000000000000000000000',
        100
      );
      const noHookAlt = noHookRouteAt(
        '0xfd20000000000000000000000000000000000000',
        100
      );
      const aggHookCombo = [aggHookLeg];
      const altCombo = [noHookAlt];

      const quoteMap = buildQuoteMap([
        // Agg-hook: raw 1,050, gas $100 → gas-adj 950
        createMockQuoteWithGasAdj(aggHookLeg, 1050n, 100n),
        // No-hook: raw 1,000, gas $10 → gas-adj 990 (wins)
        createMockQuoteWithGasAdj(noHookAlt, 1000n, 10n),
      ]);

      const sorted = finder['scoreAndSortCombinations'](
        [aggHookCombo, altCombo],
        quoteMap,
        TradeType.ExactIn
      );
      expect(sorted[0]).toBe(altCombo);
      expect(sorted[1]).toBe(aggHookCombo);
    });

    it('EXACT_OUT: ranks combinations by raw + gasCostInQuoteToken (lower gas-adj cost wins)', () => {
      const aggHookLeg = aggHookRouteAt(
        '0xfd30000000000000000000000000000000000000',
        100
      );
      const noHookAlt = noHookRouteAt(
        '0xfd40000000000000000000000000000000000000',
        100
      );
      const aggHookCombo = [aggHookLeg];
      const altCombo = [noHookAlt];

      const quoteMap = buildQuoteMap([
        // EXACT_OUT: lower amount better. Agg-hook: raw 1,000 + 100 gas
        //                                            = effective input 1,100
        createMockQuoteWithGasAdj(aggHookLeg, 1000n, 100n),
        // No-hook: raw 1,050 + 10 gas = effective input 1,060 (wins)
        createMockQuoteWithGasAdj(noHookAlt, 1050n, 10n),
      ]);

      const sorted = finder['scoreAndSortCombinations'](
        [aggHookCombo, altCombo],
        quoteMap,
        TradeType.ExactOut
      );
      expect(sorted[0]).toBe(altCombo);
      expect(sorted[1]).toBe(aggHookCombo);
    });

    it('falls back to raw-only ranking when ANY leg lacks gasCostInQuoteToken (backward compat)', () => {
      // Existing tests construct QuoteBasic without gasDetails; this
      // makes sure those test scenarios still see raw-only sorting and
      // don't get re-ordered by spurious gas comparisons.
      const r1 = noHookRouteAt(
        '0xfd50000000000000000000000000000000000000',
        100
      );
      const r2 = noHookRouteAt(
        '0xfd60000000000000000000000000000000000000',
        100
      );
      const combo1 = [r1];
      const combo2 = [r2];

      const quoteMap = new Map<RouteBasic<MockPool>, QuoteBasic>();
      // No gasDetails on either quote.
      quoteMap.set(r1, {route: r1, amount: 2000n} as QuoteBasic);
      quoteMap.set(r2, {route: r2, amount: 1500n} as QuoteBasic);

      const sorted = finder['scoreAndSortCombinations'](
        [combo1, combo2],
        quoteMap,
        TradeType.ExactIn
      );
      // Raw-only: 2000 > 1500 → combo1 first.
      expect(sorted[0]).toBe(combo1);
      expect(sorted[1]).toBe(combo2);
    });

    it('sums leg gasCostInQuoteToken across all routes in a multi-leg combination', () => {
      // Verifies the per-combination sum: total gas = sum of leg gas.
      const r1 = noHookRouteAt(
        '0xfd70000000000000000000000000000000000000',
        60
      );
      const r2 = noHookRouteAt(
        '0xfd80000000000000000000000000000000000000',
        40
      );
      const altR = noHookRouteAt(
        '0xfd90000000000000000000000000000000000000',
        100
      );
      const multiLegCombo = [r1, r2];
      const singleLegAlt = [altR];

      // Multi-leg total: raw 600+400=1000, gas 50+50=100 → gas-adj 900
      // Single-leg     : raw 950,        gas 10        → gas-adj 940 (wins)
      const quoteMap = buildQuoteMap([
        createMockQuoteWithGasAdj(r1, 600n, 50n),
        createMockQuoteWithGasAdj(r2, 400n, 50n),
        createMockQuoteWithGasAdj(altR, 950n, 10n),
      ]);

      const sorted = finder['scoreAndSortCombinations'](
        [multiLegCombo, singleLegAlt],
        quoteMap,
        TradeType.ExactIn
      );
      expect(sorted[0]).toBe(singleLegAlt);
      expect(sorted[1]).toBe(multiLegCombo);
    });
  });
});
