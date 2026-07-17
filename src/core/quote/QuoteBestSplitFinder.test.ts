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
        dist: vi.fn().mockResolvedValue(undefined),
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
    amount: bigint,
    gasCostInQuoteToken?: bigint
  ): QuoteBasic =>
    ({
      route,
      amount,
      ...(gasCostInQuoteToken !== undefined
        ? {gasDetails: {gasCostInQuoteToken}}
        : {}),
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

    it('keeps descending past empty shallow levels and returns deep splits (huge-trade shape)', async () => {
      // Huge-trade shape: every bucket above 20% is empty (those route-shares
      // revert on-chain), so levels 2-4 can't sum to 100% and the first
      // complete combinations exist only at depth 5 (5 legs of 20%).
      const quotes20 = Array.from({length: 5}, (_, i) =>
        createMockQuote(
          createMockRoute(
            [createMockPool(mockToken0, mockToken1, `0xaa${i + 1}`)],
            20
          ),
          200n
        )
      );
      const percentageToQuotes = new Map<number, QuoteBasic[]>([
        [20, quotes20],
      ]);

      const result = await finder.findBestSplits(
        ChainId.MAINNET,
        percentageToQuotes,
        5,
        7,
        100,
        10000,
        TradeType.ExactIn,
        [],
        mockContext
      );

      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toHaveLength(5);
      expect(result[0].every(route => route.percentage === 20)).toBe(true);

      // Levels 2-4 are provably infeasible (level * 20 < 100) and must be
      // skipped without running their DFS.
      const metricCalls = vi.mocked(mockContext.metrics.count).mock.calls;
      const skippedCalls = metricCalls.filter(call =>
        String(call[0]).includes('QuoteBestSplitFinder.Level.SkippedInfeasible')
      );
      expect(skippedCalls).toHaveLength(3);
      expect(
        skippedCalls.map(call => (call[2] as {tags: string[]}).tags).flat()
      ).toEqual(expect.arrayContaining(['level:2', 'level:3', 'level:4']));

      // The winning combination came from level 5, and the bucket shape is
      // the huge-trade one (max split-eligible leg <= 20%).
      const bestFoundCall = metricCalls.find(call =>
        String(call[0]).includes('QuoteBestSplitFinder.BestFoundAtLevel')
      );
      expect((bestFoundCall?.[2] as {tags: string[]}).tags).toContain(
        'level:5'
      );
      const earlyExitCall = metricCalls.find(call =>
        String(call[0]).includes('QuoteBestSplitFinder.EarlyExit')
      );
      expect((earlyExitCall?.[2] as {tags: string[]}).tags).toContain(
        'maxLegPct:le20'
      );
    });

    it('tags BestFoundAtLevel with the gas-adjusted winner level, not the raw frontrunner', async () => {
      // Raw frontrunner is the 100% route (2000 > 1900), but gas-adjusted
      // the level-2 split wins (1900 - 100 = 1800 vs 2000 - 300 = 1700).
      const fullQuote = createMockQuote(
        createMockRoute([createMockPool(mockToken0, mockToken1, '0xab1')], 100),
        2000n,
        300n
      );
      const quotes50 = Array.from({length: 2}, (_, i) =>
        createMockQuote(
          createMockRoute(
            [createMockPool(mockToken0, mockToken1, `0xac${i + 1}`)],
            50
          ),
          950n,
          50n
        )
      );
      const percentageToQuotes = new Map<number, QuoteBasic[]>([
        [100, [fullQuote]],
        [50, quotes50],
      ]);

      const result = await finder.findBestSplits(
        ChainId.MAINNET,
        percentageToQuotes,
        50,
        2,
        100,
        10000,
        TradeType.ExactIn,
        [],
        mockContext
      );

      expect(result[0]).toHaveLength(2);
      const bestFoundCall = vi
        .mocked(mockContext.metrics.count)
        .mock.calls.find(call =>
          String(call[0]).includes('QuoteBestSplitFinder.BestFoundAtLevel')
        );
      expect((bestFoundCall?.[2] as {tags: string[]}).tags).toContain(
        'level:2'
      );
    });

    it('does not settle for a poor 100% route when better splits exist past an infeasible level', async () => {
      // A bad full route exists, level 2 is infeasible (max split-eligible
      // bucket is 35%, 2 * 35 < 100), and a much better 3-way split
      // (35 + 35 + 30) exists at level 3. The old no_new_routes exit broke at
      // level 2 and returned only the full route.
      const fullQuote = createMockQuote(
        createMockRoute([createMockPool(mockToken0, mockToken1, '0xff1')], 100),
        100n
      );
      const quotes35 = Array.from({length: 2}, (_, i) =>
        createMockQuote(
          createMockRoute(
            [createMockPool(mockToken0, mockToken1, `0xbb${i + 1}`)],
            35
          ),
          350n
        )
      );
      const quotes30 = [
        createMockQuote(
          createMockRoute(
            [createMockPool(mockToken0, mockToken1, '0xcc1')],
            30
          ),
          300n
        ),
      ];
      const percentageToQuotes = new Map<number, QuoteBasic[]>([
        [100, [fullQuote]],
        [35, quotes35],
        [30, quotes30],
      ]);

      const result = await finder.findBestSplits(
        ChainId.MAINNET,
        percentageToQuotes,
        5,
        7,
        100,
        10000,
        TradeType.ExactIn,
        [],
        mockContext
      );

      expect(result[0]).toHaveLength(3);
      const percentages = result[0].map(route => route.percentage).sort();
      expect(percentages).toEqual([30, 35, 35]);
    });

    it('returns the accumulated best-so-far combinations when the timeout fires', async () => {
      const fullQuotes = Array.from({length: 2}, (_, i) =>
        createMockQuote(
          createMockRoute(
            [createMockPool(mockToken0, mockToken1, `0xdd${i + 1}`)],
            100
          ),
          BigInt(1000 - i * 100)
        )
      );
      const quotes50 = Array.from({length: 2}, (_, i) =>
        createMockQuote(
          createMockRoute(
            [createMockPool(mockToken0, mockToken1, `0xee${i + 1}`)],
            50
          ),
          500n
        )
      );
      const percentageToQuotes = new Map<number, QuoteBasic[]>([
        [100, fullQuotes],
        [50, quotes50],
      ]);

      // First Date.now call captures startTime; subsequent calls fall through
      // to the real clock, so the first level-2 DFS timeout check trips.
      const dateNowSpy = vi
        .spyOn(Date, 'now')
        .mockImplementationOnce(() => 1000);

      const result = await finder.findBestSplits(
        ChainId.MAINNET,
        percentageToQuotes,
        5,
        7,
        100,
        100,
        TradeType.ExactIn,
        [],
        mockContext
      );

      expect(mockContext.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Timed out after')
      );
      expect(result).toHaveLength(2);
      expect(
        result.every(
          combination =>
            combination.length === 1 && combination[0].percentage === 100
        )
      ).toBe(true);
      // Best-so-far ordering survives the timeout.
      expect(result[0][0]).toBe(fullQuotes[0].route);

      // The timeout delivered a non-empty best-so-far result.
      const timedOutCall = vi
        .mocked(mockContext.metrics.count)
        .mock.calls.find(call =>
          String(call[0]).includes('QuoteBestSplitFinder.TimedOut')
        );
      expect((timedOutCall?.[2] as {tags: string[]}).tags).toContain(
        'hasResult:true'
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

    it('tracks the EXACT_OUT best combination direction-aware (lower input is better)', async () => {
      // EXACT_OUT amounts are required inputs: the level-2 split needing 960
      // beats the 100% route needing 1000. The raw `>` tracker recorded the
      // 100% route as best (bestFoundAtLevel 1, bestAmount 1000).
      const fullQuote = createMockQuote(
        createMockRoute([createMockPool(mockToken0, mockToken1, '0xba1')], 100),
        1000n
      );
      const quotes50 = Array.from({length: 2}, (_, i) =>
        createMockQuote(
          createMockRoute(
            [createMockPool(mockToken0, mockToken1, `0xbc${i + 1}`)],
            50
          ),
          480n
        )
      );
      const percentageToQuotes = new Map<number, QuoteBasic[]>([
        [100, [fullQuote]],
        [50, quotes50],
      ]);

      const result = await finder.findBestSplits(
        ChainId.MAINNET,
        percentageToQuotes,
        50,
        2,
        100,
        10000,
        TradeType.ExactOut,
        [],
        mockContext
      );

      expect(result[0]).toHaveLength(2);

      const observabilityCall = (
        mockContext.logger.debug as ReturnType<typeof vi.fn>
      ).mock.calls.find(
        ([msg]) =>
          typeof msg === 'string' &&
          msg === 'QuoteBestSplitFinder observability'
      );
      expect(observabilityCall?.[1]?.bestFoundAtLevel).toBe(2);
      expect(observabilityCall?.[1]?.bestAmount).toBe('960');
    });

    it('does not low_improvement-exit an improving EXACT_OUT search', async () => {
      // Each deeper level lowers the required input (1000 -> 960 -> 940 ->
      // 920). With the raw delta, level 3's improvement computed negative
      // and tripped the low_improvement exit before level 4 was searched.
      const percentageToQuotes = new Map<number, QuoteBasic[]>([
        [
          100,
          [
            createMockQuote(
              createMockRoute(
                [createMockPool(mockToken0, mockToken1, '0xda1')],
                100
              ),
              1000n
            ),
          ],
        ],
        [
          50,
          Array.from({length: 2}, (_, i) =>
            createMockQuote(
              createMockRoute(
                [createMockPool(mockToken0, mockToken1, `0xdb${i + 1}`)],
                50
              ),
              480n
            )
          ),
        ],
        [
          25,
          Array.from({length: 4}, (_, i) =>
            createMockQuote(
              createMockRoute(
                [createMockPool(mockToken0, mockToken1, `0xdc${i + 1}`)],
                25
              ),
              230n
            )
          ),
        ],
      ]);

      const result = await finder.findBestSplits(
        ChainId.MAINNET,
        percentageToQuotes,
        25,
        4,
        100,
        10000,
        TradeType.ExactOut,
        [],
        mockContext
      );

      // The 4-way split (4 x 230 = 920) is the true winner and must be
      // reachable — the search may not stop at level 3.
      expect(result[0]).toHaveLength(4);
      expect(result[0].every(route => route.percentage === 25)).toBe(true);
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
        partitionAnchorAnalysisLogBudget: {remaining: number};
        aggHookAttribution: {
          firedPartitionKeptHigherGas: boolean;
          firedSoleCandidateAdmit: boolean;
          firedSoleCandidateGasWorse: boolean;
          firedChosenSplitGasWorse: boolean;
          firedAnchorSubOptimal: boolean;
        };
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
      partitionAnchorAnalysisLogBudget: {remaining: 5},
      aggHookAttribution: {
        firedPartitionKeptHigherGas: false,
        firedSoleCandidateAdmit: false,
        firedSoleCandidateGasWorse: false,
        firedChosenSplitGasWorse: false,
        firedAnchorSubOptimal: false,
      },
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
      // Three metrics fire on every partition decision: PartitionDecision
      // (raw verdict), PartitionGasAdjustedDecision (gas-adjusted
      // verdict), and PartitionAnchorAnalysis (raw-winner vs lowest-gas
      // no-hook anchor verdict). Mock quotes lack gasDetails, so both
      // gas-related sides emit `gas_info_missing` and skip their logs.
      const partitionDecisionMetrics = metricMock().mock.calls.filter(c =>
        (c[2] as {tags: string[]}).tags.some(t =>
          t.startsWith('partitionVerdict:')
        )
      );
      const gasAdjustedMetrics = metricMock().mock.calls.filter(c =>
        (c[2] as {tags: string[]}).tags.some(t =>
          t.startsWith('gasAdjustedVerdict:')
        )
      );
      const anchorAnalysisMetrics = metricMock().mock.calls.filter(c =>
        (c[2] as {tags: string[]}).tags.some(t =>
          t.startsWith('anchorVerdict:')
        )
      );
      expect(partitionDecisionMetrics).toHaveLength(1);
      expect(
        (partitionDecisionMetrics[0][2] as {tags: string[]}).tags
      ).toContain('partitionVerdict:agghook_better_or_tie');
      expect(
        (partitionDecisionMetrics[0][2] as {tags: string[]}).tags
      ).toContain('testAggHooks:true');
      expect(
        (partitionDecisionMetrics[0][2] as {tags: string[]}).tags
      ).toContain(`tradeType:${TradeType.ExactIn}`);
      expect(gasAdjustedMetrics).toHaveLength(1);
      expect((gasAdjustedMetrics[0][2] as {tags: string[]}).tags).toContain(
        'gasAdjustedVerdict:gas_info_missing'
      );
      expect(anchorAnalysisMetrics).toHaveLength(1);
      expect((anchorAnalysisMetrics[0][2] as {tags: string[]}).tags).toContain(
        'anchorVerdict:gas_info_missing'
      );
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
      // 21 = 7 iterations × 3 metrics per partition decision
      // (PartitionDecision, PartitionGasAdjustedDecision,
      // PartitionAnchorAnalysis). The two gas-related metrics emit
      // gas_info_missing since mock quotes lack gasDetails.
      expect(metricMock().mock.calls).toHaveLength(21);
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

    // ----- Partition anchor analysis instrumentation -----
    //
    // Caused by the prod trace 7343506789041406327 finding (PR #8327
    // data): treatment picked a Fluid-hook v4 terminal over a no-hook
    // v4 terminal at the same percentage bucket, even though the
    // no-hook v4 was in treatment's universe. The hypothesis: the
    // K-budget gate anchors on `noHookQuotes[0]` (best-by-raw), but
    // the LOWEST-GAS no-hook in the bucket has lower gas than the
    // raw winner. Re-anchoring on the lowest-gas no-hook would
    // reject the agg-hook in cases where the raw-winner anchor
    // currently admits it.

    it('emits anchorVerdict:winner_is_lowest_gas when the raw winner is also the lowest-gas no-hook', () => {
      const aggHook = aggHookRouteAt(
        '0xb000000000000000000000000000000000000000',
        50
      );
      const noHookWinner = noHookRouteAt(
        '0xb100000000000000000000000000000000000000',
        50
      );
      const noHookRunnerUp = noHookRouteAt(
        '0xb200000000000000000000000000000000000000',
        50
      );

      finder['getBestUnusedQuotesStats'](
        50,
        new Map<number, QuoteBasic[]>([
          [
            50,
            [
              // No-hook winner (best raw=1000) is also lowest gas=100.
              createMockQuoteWithGas(noHookWinner, 1000n, 100n),
              // Runner-up has higher gas.
              createMockQuoteWithGas(noHookRunnerUp, 990n, 300n),
              createMockQuoteWithGas(aggHook, 1000n, 200n),
            ],
          ],
        ]),
        [],
        ChainId.MAINNET,
        TradeType.ExactIn,
        buildInstrumentation({tradeType: TradeType.ExactIn})
      );

      const anchorMetrics = metricMock().mock.calls.filter(c =>
        (c[2] as {tags: string[]}).tags.some(t =>
          t.startsWith('anchorVerdict:')
        )
      );
      expect(anchorMetrics).toHaveLength(1);
      expect((anchorMetrics[0][2] as {tags: string[]}).tags).toContain(
        'anchorVerdict:winner_is_lowest_gas'
      );
    });

    it('emits anchorVerdict:lowest_gas_differs_anchor_admits + log when re-anchoring on lowest-gas no-hook would reject agg-hook', () => {
      const aggHook = aggHookRouteAt(
        '0xb300000000000000000000000000000000000000',
        50
      );
      const noHookWinner = noHookRouteAt(
        '0xb400000000000000000000000000000000000000',
        50
      );
      const noHookLowGas = noHookRouteAt(
        '0xb500000000000000000000000000000000000000',
        50
      );

      // Permissive finder has 10M-unit gas tolerance; use realistic
      // bucket-scale gas values (tens of millions) so the gate-verdict
      // delta against the lowest-gas anchor materially exceeds it.
      //
      // No-hook winner (best raw=1000) has gas=50M (gate's current
      // anchor). A different no-hook has gas=5M (the actual lowest).
      // Agg-hook gas=20M. Against the raw winner (50M), agg-hook is
      // gas-better → gate admits. Against the lowest (5M), agg-hook
      // is gas-worse by 15M > 10M tolerance → gate would reject.
      finder['getBestUnusedQuotesStats'](
        50,
        new Map<number, QuoteBasic[]>([
          [
            50,
            [
              createMockQuoteWithGas(noHookWinner, 1000n, 50_000_000n),
              createMockQuoteWithGas(noHookLowGas, 990n, 5_000_000n),
              createMockQuoteWithGas(aggHook, 1000n, 20_000_000n),
            ],
          ],
        ]),
        [],
        ChainId.MAINNET,
        TradeType.ExactIn,
        buildInstrumentation({tradeType: TradeType.ExactIn})
      );

      const anchorMetrics = metricMock().mock.calls.filter(c =>
        (c[2] as {tags: string[]}).tags.some(t =>
          t.startsWith('anchorVerdict:')
        )
      );
      expect(anchorMetrics).toHaveLength(1);
      expect((anchorMetrics[0][2] as {tags: string[]}).tags).toContain(
        'anchorVerdict:lowest_gas_differs_anchor_admits'
      );

      const anchorLogs = infoMock().mock.calls.filter(
        c =>
          c[0] ===
          'QuoteBestSplitFinder partition anchor sub-optimal — lowest-gas no-hook differs from raw winner'
      );
      expect(anchorLogs).toHaveLength(1);
      const payload = anchorLogs[0][1] as Record<string, unknown>;
      expect((payload.aggHookWinner as {gasUse: string}).gasUse).toBe(
        '20000000'
      );
      expect((payload.noHookWinnerByRaw as {gasUse: string}).gasUse).toBe(
        '50000000'
      );
      expect((payload.noHookLowestGas as {gasUse: string}).gasUse).toBe(
        '5000000'
      );
      expect(payload.gasUseDeltaVsRawWinner).toBe('-30000000');
      expect(payload.gasUseDeltaVsLowestGas).toBe('15000000');
    });

    it('emits anchorVerdict:lowest_gas_differs_anchor_neutral when lowest-gas anchor also admits the agg-hook', () => {
      const aggHook = aggHookRouteAt(
        '0xb600000000000000000000000000000000000000',
        50
      );
      const noHookWinner = noHookRouteAt(
        '0xb700000000000000000000000000000000000000',
        50
      );
      const noHookLowGas = noHookRouteAt(
        '0xb800000000000000000000000000000000000000',
        50
      );

      // Permissive finder has 10M-unit gas tolerance. Use bucket-scale
      // gas values where agg-hook is gas-best (5M), lowest no-hook is
      // 4M, raw winner is 50M. Even re-anchored on the lowest no-hook
      // (4M), agg-hook's delta is 1M ≤ 10M tolerance → still admits →
      // neutral verdict (no change in gate outcome).
      finder['getBestUnusedQuotesStats'](
        50,
        new Map<number, QuoteBasic[]>([
          [
            50,
            [
              createMockQuoteWithGas(noHookWinner, 1000n, 50_000_000n),
              createMockQuoteWithGas(noHookLowGas, 990n, 4_000_000n),
              createMockQuoteWithGas(aggHook, 1000n, 5_000_000n),
            ],
          ],
        ]),
        [],
        ChainId.MAINNET,
        TradeType.ExactIn,
        buildInstrumentation({tradeType: TradeType.ExactIn})
      );

      const anchorMetrics = metricMock().mock.calls.filter(c =>
        (c[2] as {tags: string[]}).tags.some(t =>
          t.startsWith('anchorVerdict:')
        )
      );
      expect(anchorMetrics).toHaveLength(1);
      expect((anchorMetrics[0][2] as {tags: string[]}).tags).toContain(
        'anchorVerdict:lowest_gas_differs_anchor_neutral'
      );

      const anchorLogs = infoMock().mock.calls.filter(
        c =>
          c[0] ===
          'QuoteBestSplitFinder partition anchor sub-optimal — lowest-gas no-hook differs from raw winner'
      );
      expect(anchorLogs).toHaveLength(0);
    });

    it('respects partitionAnchorAnalysisLogBudget cap while metric keeps firing', () => {
      const aggHook = aggHookRouteAt(
        '0xb900000000000000000000000000000000000000',
        50
      );
      const noHookWinner = noHookRouteAt(
        '0xba00000000000000000000000000000000000000',
        50
      );
      const noHookLowGas = noHookRouteAt(
        '0xbb00000000000000000000000000000000000000',
        50
      );
      // Bucket-scale gas values so anchor-admits verdict fires past
      // the permissive 10M-unit tolerance on every iteration.
      const quotesMap = new Map<number, QuoteBasic[]>([
        [
          50,
          [
            createMockQuoteWithGas(noHookWinner, 1000n, 50_000_000n),
            createMockQuoteWithGas(noHookLowGas, 990n, 5_000_000n),
            createMockQuoteWithGas(aggHook, 1000n, 20_000_000n),
          ],
        ],
      ]);

      const sharedInstr = buildInstrumentation({tradeType: TradeType.ExactIn});
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

      const anchorLogs = infoMock().mock.calls.filter(
        c =>
          c[0] ===
          'QuoteBestSplitFinder partition anchor sub-optimal — lowest-gas no-hook differs from raw winner'
      );
      const anchorMetrics = metricMock().mock.calls.filter(c =>
        (c[2] as {tags: string[]}).tags.some(t =>
          t.startsWith('anchorVerdict:')
        )
      );
      expect(anchorLogs).toHaveLength(5);
      expect(anchorMetrics).toHaveLength(7);
      expect(sharedInstr.partitionAnchorAnalysisLogBudget.remaining).toBe(0);
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
          partitionAnchorAnalysisLogBudget: {remaining: 5},
          aggHookAttribution: {
            firedPartitionKeptHigherGas: false,
            firedSoleCandidateAdmit: false,
            firedSoleCandidateGasWorse: false,
            firedChosenSplitGasWorse: false,
            firedAnchorSubOptimal: false,
          },
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

    // ----- Lowest-gas anchor kill-switch -----
    //
    // The K-budget partition gas-gate's default anchor is `noHookQuotes[0]`
    // (best by raw amount). Prod `PartitionAnchorAnalysis` telemetry
    // (commit-fa30fa0, 60 min) showed that in 47.0% of partition firings
    // the lowest-gas no-hook in the same bucket differs from the raw
    // winner AND would reject the agg-hook under the live gas tolerance.
    // The kill-switch `AGG_HOOK_PARTITION_USE_LOWEST_GAS_ANCHOR` swaps the
    // anchor to that lowest-gas quote, matching the alternative DFS would
    // pick if agg-hook were excluded from the candidate set.
    //
    // The bug-shape fixture below mirrors the trace `5715715370883124467`
    // (LINK→USDT $100k EXACT_IN) where the gate admitted agg-hook 5×
    // against a raw winner that wasn't the lowest-gas no-hook in the
    // bucket — producing a Cat-B loss downstream.
    describe('lowest-gas anchor kill-switch', () => {
      it('flag off: confirms bug shape — agg-hook admitted by raw-anchor gas gate even when lowest-gas no-hook is cheaper than agg-hook', () => {
        // Trim down to the actual K-budget bug shape: only enough quotes
        // that the raw gate has no anchor to evict against (no runner-up
        // beyond the no-hook budget). Then the gas gate is the only
        // mechanism — and at default anchor it compares against the raw
        // winner (200k), not the cheapest gas (100k). aggHook 170k <
        // 200k → gas-gate passes → partition admits.
        //
        // Setup: noHookBudgetIfPartitioned=1, noHookQuotes.length=1 → no
        // runner-up → raw gate skipped. But we need two no-hook quotes
        // to demonstrate the anchor-choice mattering. Workaround: use a
        // displacement that ties on raw so the raw gate vacuously
        // passes (badness=0), and let the gas gate be decisive.
        const noHookRawWinner = noHookRouteAt(
          '0x1b00000000000000000000000000000000000000',
          50
        );
        const noHookCheapestGas = noHookRouteAt(
          '0x1b10000000000000000000000000000000000000',
          50
        );
        const aggHook = aggHookRouteAt(
          '0x1b20000000000000000000000000000000000000',
          50
        );

        const stats = finder['getBestUnusedQuotesStats'](
          50,
          new Map<number, QuoteBasic[]>([
            [
              50,
              [
                // raw-tied so raw gate's badness=0 (passes vacuously)
                createMockQuoteWithGasUse(noHookRawWinner, 1000n, 200_000n),
                createMockQuoteWithGasUse(noHookCheapestGas, 1000n, 100_000n),
                createMockQuoteWithGasUse(aggHook, 1000n, 170_000n),
              ],
            ],
          ]),
          [],
          ChainId.MAINNET,
          TradeType.ExactIn
        );

        // Default anchor = noHookRawWinner (200k). aggHook 170k < 200k →
        // gas-gate passes → partition admits agg-hook → 1 slot each.
        expect(stats.returnedCount).toBe(2);
        const routes = stats.quotes.map(q => q.route);
        expect(routes).toContain(noHookRawWinner);
        expect(routes).toContain(aggHook); // <-- the bug: agg-hook admitted
        expect(routes).not.toContain(noHookCheapestGas);
      });

      it('flag on: rejects agg-hook in the bug shape (lowest-gas anchor catches the 70k delta)', () => {
        // Same fixture as the prior test; with the flag on the anchor
        // becomes noHookCheapestGas (100k). aggHook 170k > 100k by 70k,
        // exceeds default 0n tolerance → gas-gate rejects → all K slots
        // go to no-hook.
        const lowestGasAnchorFinder = new QuoteBestSplitFinder<MockPool>(
          0n,
          0n,
          0n,
          true
        );

        const noHookRawWinner = noHookRouteAt(
          '0x1c00000000000000000000000000000000000000',
          50
        );
        const noHookCheapestGas = noHookRouteAt(
          '0x1c10000000000000000000000000000000000000',
          50
        );
        const aggHook = aggHookRouteAt(
          '0x1c20000000000000000000000000000000000000',
          50
        );

        const stats = lowestGasAnchorFinder['getBestUnusedQuotesStats'](
          50,
          new Map<number, QuoteBasic[]>([
            [
              50,
              [
                createMockQuoteWithGasUse(noHookRawWinner, 1000n, 200_000n),
                createMockQuoteWithGasUse(noHookCheapestGas, 1000n, 100_000n),
                createMockQuoteWithGasUse(aggHook, 1000n, 170_000n),
              ],
            ],
          ]),
          [],
          ChainId.MAINNET,
          TradeType.ExactIn
        );

        expect(stats.returnedCount).toBe(2);
        const routes = stats.quotes.map(q => q.route);
        expect(routes).toContain(noHookRawWinner);
        expect(routes).toContain(noHookCheapestGas);
        expect(routes).not.toContain(aggHook);
      });

      it('flag on: still admits when agg-hook gas <= lowest-gas no-hook', () => {
        // Symmetric guard: the lowest-gas anchor must not over-correct
        // and exclude legitimately-cheap agg-hook quotes.
        const lowestGasAnchorFinder = new QuoteBestSplitFinder<MockPool>(
          0n,
          0n,
          0n,
          true
        );

        const noHookRawWinner = noHookRouteAt(
          '0x1d00000000000000000000000000000000000000',
          50
        );
        const noHookCheapestGas = noHookRouteAt(
          '0x1d10000000000000000000000000000000000000',
          50
        );
        const aggHook = aggHookRouteAt(
          '0x1d20000000000000000000000000000000000000',
          50
        );

        const stats = lowestGasAnchorFinder['getBestUnusedQuotesStats'](
          50,
          new Map<number, QuoteBasic[]>([
            [
              50,
              [
                createMockQuoteWithGasUse(noHookRawWinner, 1000n, 200_000n),
                createMockQuoteWithGasUse(noHookCheapestGas, 1000n, 100_000n),
                // aggHook ties cheapest gas → gas-gate vacuously passes.
                createMockQuoteWithGasUse(aggHook, 1000n, 100_000n),
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
      });

      it('flag on: respects the existing gas tolerance — admits within threshold', () => {
        // Lowest-gas anchor + 100k unit tolerance. Bug-shape gap is
        // 70k → within tolerance → gate admits.
        const lowestGasAnchorFinder = new QuoteBestSplitFinder<MockPool>(
          0n,
          100_000n,
          0n,
          true
        );

        const noHookRawWinner = noHookRouteAt(
          '0x1e00000000000000000000000000000000000000',
          50
        );
        const noHookCheapestGas = noHookRouteAt(
          '0x1e10000000000000000000000000000000000000',
          50
        );
        const aggHook = aggHookRouteAt(
          '0x1e20000000000000000000000000000000000000',
          50
        );

        const stats = lowestGasAnchorFinder['getBestUnusedQuotesStats'](
          50,
          new Map<number, QuoteBasic[]>([
            [
              50,
              [
                createMockQuoteWithGasUse(noHookRawWinner, 1000n, 200_000n),
                createMockQuoteWithGasUse(noHookCheapestGas, 1000n, 100_000n),
                createMockQuoteWithGasUse(aggHook, 1000n, 170_000n),
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
      });

      it('flag on: no-op when no-hook quotes lack gasUse (preserves test-mock compatibility)', () => {
        // When no no-hook quote has gasDetails.gasUse populated, the
        // lowest-gas anchor is undefined and the gas-gate skips —
        // matching the existing BPS-only fallback that protects unit-test
        // fixtures and stale-gas code paths.
        const lowestGasAnchorFinder = new QuoteBestSplitFinder<MockPool>(
          0n,
          0n,
          0n,
          true
        );

        const noHookWinner = noHookRouteAt(
          '0x1f00000000000000000000000000000000000000',
          50
        );
        const noHookRunnerUp = noHookRouteAt(
          '0x1f10000000000000000000000000000000000000',
          50
        );
        const aggHook = aggHookRouteAt(
          '0x1f20000000000000000000000000000000000000',
          50
        );

        const stats = lowestGasAnchorFinder['getBestUnusedQuotesStats'](
          50,
          new Map<number, QuoteBasic[]>([
            [
              50,
              [
                // No gasDetails on the no-hook quotes; aggHook tied raw,
                // so raw gate passes; gas gate has no anchor → admit.
                createMockQuote(noHookWinner, 1000n),
                createMockQuote(noHookRunnerUp, 1001n),
                createMockQuoteWithGasUse(aggHook, 1000n, 500_000n),
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
    });

    // The projected gas-adjusted gate kill-switch
    // (`AGG_HOOK_PARTITION_USE_PROJECTED_GAS_ADJ_GATE`) extends the
    // existing gas-use gate by comparing in quote-token wei: it rejects
    // when projected gas overhead exceeds projected raw improvement.
    // The fixture below mirrors the dominant Cat-A pattern attributed
    // on prod commit-fb14030 (FluidDexT1 USDT↔USDC second hop): +0.04
    // bps raw gain at +58% gas overhead, which the existing gas-use
    // gate admits because the per-leg gas-unit delta is small enough
    // even against the lowest-gas anchor.
    describe('projected gas-adjusted gate kill-switch', () => {
      const createMockQuoteWithGasCostQT = (
        route: RouteBasic<MockPool>,
        amount: bigint,
        gasUse: bigint,
        gasCostInQuoteToken: bigint
      ): QuoteBasic =>
        ({
          route,
          amount,
          gasDetails: {
            gasPriceInWei: 1n,
            gasCostInWei: 1n,
            gasCostInEth: 0,
            gasUse,
            gasCostInQuoteToken,
          },
        }) as unknown as QuoteBasic;

      // Canary instrumentation blob enabling projected-gate verdict
      // telemetry. Codex round-4 finding: verdict computation is now
      // gated on `instrumentation?.testAggHooks` so non-canary paths
      // skip the bigint arithmetic and protocol lookup. Tests that
      // assert on `stats.projectedGateVerdict` must pass this blob.
      const canaryInstrumentation = () => ({
        ctx: mockContext,
        tradeType: TradeType.ExactIn,
        testAggHooks: true,
        partitionEvictLogBudget: {remaining: 5},
        soleCandidateLogBudget: {remaining: 5},
        partitionGasAdjustedLogBudget: {remaining: 5},
        gateEarlyReturnLeakLogBudget: {remaining: 5},
        soleCandidateGasComparisonLogBudget: {remaining: 5},
        partitionAnchorAnalysisLogBudget: {remaining: 5},
        aggHookAttribution: {
          firedPartitionKeptHigherGas: false,
          firedSoleCandidateAdmit: false,
          firedSoleCandidateGasWorse: false,
          firedChosenSplitGasWorse: false,
          firedAnchorSubOptimal: false,
        },
        metricTags: ['chainId:1'],
      });

      // Canonical 3-quote bug-shape fixture for the projected-gate
      // tests. The projection anchors on the DISPLACED runner-up
      // (`noHookRunnerUp`), not the kept winner (`noHookWinner`) —
      // see Codex round-3 finding. Each test below varies the
      // agg-hook side (raw amount, gas QT, missing gas data) and the
      // constructor flags; the runner-up profile is the gas anchor
      // the projection actually uses.
      const makeBugShapeFixture = (
        noHookWinnerAddr: string,
        noHookRunnerUpAddr: string,
        aggHookAddr: string
      ) => {
        const noHookWinner = noHookRouteAt(noHookWinnerAddr, 50);
        const noHookRunnerUp = noHookRouteAt(noHookRunnerUpAddr, 50);
        const aggHook = aggHookRouteAt(aggHookAddr, 50);
        return {noHookWinner, noHookRunnerUp, aggHook};
      };

      it('flag off: no behavior change — agg-hook admitted by existing gate even when projection would reject', () => {
        // Default constructor (all flags off). Same gas-units between
        // sides so the existing gas-use gate vacuously admits, but the
        // projection comparison (raw +911 vs gas +17,635 wei QT) would
        // reject. Without the kill-switch the gate should still admit.
        const {noHookWinner, noHookRunnerUp, aggHook} = makeBugShapeFixture(
          '0x2a00000000000000000000000000000000000000',
          '0x2a01000000000000000000000000000000000000',
          '0x2a10000000000000000000000000000000000000'
        );

        const stats = finder['getBestUnusedQuotesStats'](
          50,
          new Map<number, QuoteBasic[]>([
            [
              50,
              [
                // noHookWinner: raw-best (kept either way)
                createMockQuoteWithGasCostQT(
                  noHookWinner,
                  236895678n,
                  445011n,
                  30445n
                ),
                // noHookRunnerUp: displaced when agg-hook is admitted
                // — projection anchor's gas profile lives HERE.
                createMockQuoteWithGasCostQT(
                  noHookRunnerUp,
                  236895677n,
                  445011n,
                  30445n
                ),
                // aggHook: +911 raw vs runnerUp, +17_635 gas QT
                createMockQuoteWithGasCostQT(
                  aggHook,
                  236896588n,
                  445011n,
                  48080n
                ),
              ],
            ],
          ]),
          [],
          ChainId.MAINNET,
          TradeType.ExactIn,
          canaryInstrumentation()
        );

        // Gas-use gate vacuous (delta 0); projection would reject but
        // kill-switch off → partition admits both classes.
        expect(stats.partitionAdmittedAggHook).toBe(true);
        const routes = stats.quotes.map(q => q.route);
        expect(routes).toContain(aggHook);
        // What-if verdict should report `admit_raw_only` — what the
        // pre-flip telemetry needs to size the population.
        expect(stats.projectedGateVerdict).toBe('admit_raw_only');
      });

      it('flag on: emits admit_raw_only verdict for dominant Cat-A shape; partition still admits (telemetry-only per Codex round-5)', () => {
        const projectedGateFinder = new QuoteBestSplitFinder<MockPool>(
          0n,
          0n,
          0n,
          false,
          true,
          0n
        );

        const {noHookWinner, noHookRunnerUp, aggHook} = makeBugShapeFixture(
          '0x2b00000000000000000000000000000000000000',
          '0x2b01000000000000000000000000000000000000',
          '0x2b10000000000000000000000000000000000000'
        );

        const stats = projectedGateFinder['getBestUnusedQuotesStats'](
          50,
          new Map<number, QuoteBasic[]>([
            [
              50,
              [
                createMockQuoteWithGasCostQT(
                  noHookWinner,
                  236895678n,
                  445011n,
                  30445n
                ),
                createMockQuoteWithGasCostQT(
                  noHookRunnerUp,
                  236895677n,
                  445011n,
                  30445n
                ),
                createMockQuoteWithGasCostQT(
                  aggHook,
                  236896588n,
                  445011n,
                  48080n
                ),
              ],
            ],
          ]),
          [],
          ChainId.MAINNET,
          TradeType.ExactIn,
          canaryInstrumentation()
        );

        // Projection: gasOverheadQT (17_635) - rawImprovementQT (911)
        // = 16_724 > 0n tolerance → projection WOULD reject. With
        // round-5 telemetry-only semantics, the verdict surfaces in
        // the metric but the K-budget partition still admits — only
        // the existing raw/gas-use gates can hard-prune.
        expect(stats.partitionAdmittedAggHook).toBe(true);
        const routes = stats.quotes.map(q => q.route);
        expect(routes).toContain(aggHook);
        expect(stats.projectedGateVerdict).toBe('admit_raw_only');
      });

      it('flag on: admits when raw improvement covers gas overhead (upside-preservation)', () => {
        // Same shape but raw gain large enough that
        // rawImprovementQT > gasOverheadQT — must NOT be over-corrected
        // out of the partition.
        const projectedGateFinder = new QuoteBestSplitFinder<MockPool>(
          0n,
          0n,
          0n,
          false,
          true,
          0n
        );

        const {noHookWinner, noHookRunnerUp, aggHook} = makeBugShapeFixture(
          '0x2c00000000000000000000000000000000000000',
          '0x2c01000000000000000000000000000000000000',
          '0x2c10000000000000000000000000000000000000'
        );

        const stats = projectedGateFinder['getBestUnusedQuotesStats'](
          50,
          new Map<number, QuoteBasic[]>([
            [
              50,
              [
                createMockQuoteWithGasCostQT(
                  noHookWinner,
                  236895678n,
                  445011n,
                  30445n
                ),
                createMockQuoteWithGasCostQT(
                  noHookRunnerUp,
                  236895677n,
                  445011n,
                  30445n
                ),
                // aggHook: +50_000 raw vs runnerUp, +17_635 gas QT →
                // net +32_365 wei QT
                createMockQuoteWithGasCostQT(
                  aggHook,
                  236945677n,
                  445011n,
                  48080n
                ),
              ],
            ],
          ]),
          [],
          ChainId.MAINNET,
          TradeType.ExactIn,
          canaryInstrumentation()
        );

        expect(stats.partitionAdmittedAggHook).toBe(true);
        expect(stats.projectedGateVerdict).toBe('admit_both');
      });

      it('flag on: defensive admit when gasCostInQuoteToken is missing on a side', () => {
        const projectedGateFinder = new QuoteBestSplitFinder<MockPool>(
          0n,
          0n,
          0n,
          false,
          true,
          0n
        );

        const {noHookWinner, noHookRunnerUp, aggHook} = makeBugShapeFixture(
          '0x2d00000000000000000000000000000000000000',
          '0x2d01000000000000000000000000000000000000',
          '0x2d10000000000000000000000000000000000000'
        );

        const stats = projectedGateFinder['getBestUnusedQuotesStats'](
          50,
          new Map<number, QuoteBasic[]>([
            [
              50,
              [
                createMockQuoteWithGasCostQT(
                  noHookWinner,
                  236895678n,
                  445011n,
                  30445n
                ),
                createMockQuoteWithGasCostQT(
                  noHookRunnerUp,
                  236895677n,
                  445011n,
                  30445n
                ),
                // aggHook has no gasCostInQuoteToken → projection skips.
                createMockQuoteWithGasUse(aggHook, 236896588n, 445011n),
              ],
            ],
          ]),
          [],
          ChainId.MAINNET,
          TradeType.ExactIn,
          canaryInstrumentation()
        );

        expect(stats.partitionAdmittedAggHook).toBe(true);
        expect(stats.projectedGateVerdict).toBe('no_data');
      });

      it('flag on: respects projected-loss tolerance — admits within slack', () => {
        // Bug-shape but with tolerance 20_000n wei → projection net
        // loss 16_724 is within slack → admit.
        const tolerantProjectedGateFinder = new QuoteBestSplitFinder<MockPool>(
          0n,
          0n,
          0n,
          false,
          true,
          20_000n
        );

        const {noHookWinner, noHookRunnerUp, aggHook} = makeBugShapeFixture(
          '0x2e00000000000000000000000000000000000000',
          '0x2e01000000000000000000000000000000000000',
          '0x2e10000000000000000000000000000000000000'
        );

        const stats = tolerantProjectedGateFinder['getBestUnusedQuotesStats'](
          50,
          new Map<number, QuoteBasic[]>([
            [
              50,
              [
                createMockQuoteWithGasCostQT(
                  noHookWinner,
                  236895678n,
                  445011n,
                  30445n
                ),
                createMockQuoteWithGasCostQT(
                  noHookRunnerUp,
                  236895677n,
                  445011n,
                  30445n
                ),
                createMockQuoteWithGasCostQT(
                  aggHook,
                  236896588n,
                  445011n,
                  48080n
                ),
              ],
            ],
          ]),
          [],
          ChainId.MAINNET,
          TradeType.ExactIn,
          canaryInstrumentation()
        );

        expect(stats.partitionAdmittedAggHook).toBe(true);
        expect(stats.projectedGateVerdict).toBe('admit_both');
      });

      it('reports reject_gas_use verdict when the existing gas-use gate already rejected', () => {
        // Big gas-use delta so existing gas-use gate rejects regardless
        // of projection. Projection verdict should still be reported as
        // `reject_gas_use` (not `admit_raw_only`) because admit_both /
        // admit_raw_only are only meaningful when the existing gate
        // admitted.
        const projectedGateFinder = new QuoteBestSplitFinder<MockPool>(
          0n,
          0n,
          0n,
          false,
          true,
          0n
        );

        const noHook = noHookRouteAt(
          '0x2f00000000000000000000000000000000000000',
          50
        );
        const aggHook = aggHookRouteAt(
          '0x2f10000000000000000000000000000000000000',
          50
        );

        const stats = projectedGateFinder['getBestUnusedQuotesStats'](
          50,
          new Map<number, QuoteBasic[]>([
            [
              50,
              [
                // 500_000 vs 100_000 → 400_000 gas-unit delta exceeds
                // the 0n existing tolerance → existing gate rejects.
                createMockQuoteWithGasCostQT(
                  aggHook,
                  236896588n,
                  500_000n,
                  48080n
                ),
                createMockQuoteWithGasCostQT(
                  noHook,
                  236895677n,
                  100_000n,
                  30445n
                ),
              ],
            ],
          ]),
          [],
          ChainId.MAINNET,
          TradeType.ExactIn,
          canaryInstrumentation()
        );

        expect(stats.partitionAdmittedAggHook).toBe(false);
        expect(stats.projectedGateVerdict).toBe('reject_gas_use');
      });

      it('reports reject_raw_amount verdict when the existing raw-amount gate already rejected (Codex finding #2)', () => {
        // Raw badness exceeds the tolerance (0n bps), so the existing
        // raw-amount gate rejects. Verdict must be `reject_raw_amount`
        // — not the legacy `reject_gas_use` fallback that conflates
        // both mechanisms.
        const projectedGateFinder = new QuoteBestSplitFinder<MockPool>(
          0n,
          0n,
          0n,
          false,
          true,
          0n
        );

        const noHookWinner = noHookRouteAt(
          '0x3000000000000000000000000000000000000000',
          50
        );
        const noHookRunnerUp = noHookRouteAt(
          '0x3010000000000000000000000000000000000000',
          50
        );
        const aggHook = aggHookRouteAt(
          '0x3020000000000000000000000000000000000000',
          50
        );

        const stats = projectedGateFinder['getBestUnusedQuotesStats'](
          50,
          new Map<number, QuoteBasic[]>([
            [
              50,
              [
                // noHookRunnerUp at index=1 has amount 1000 (raw better
                // than aggHook 900 by 100 — badness * 10000 = 1_000_000
                // > 0 * 1000 → raw-amount gate rejects).
                createMockQuoteWithGasCostQT(
                  noHookWinner,
                  2000n,
                  100_000n,
                  30445n
                ),
                createMockQuoteWithGasCostQT(
                  noHookRunnerUp,
                  1000n,
                  100_000n,
                  30445n
                ),
                createMockQuoteWithGasCostQT(aggHook, 900n, 100_000n, 30445n),
              ],
            ],
          ]),
          [],
          ChainId.MAINNET,
          TradeType.ExactIn,
          canaryInstrumentation()
        );

        expect(stats.partitionAdmittedAggHook).toBe(false);
        expect(stats.projectedGateVerdict).toBe('reject_raw_amount');
      });

      it('projection gate uses lowest-gas anchor independent of AGG_HOOK_PARTITION_USE_LOWEST_GAS_ANCHOR (Codex finding #3)', () => {
        // Both kill-switches: projection ON, lowest-gas anchor OFF.
        // The projection should STILL use the lowest-gas no-hook
        // anchor — its anchor selection is decoupled from the legacy
        // flag. With raw-winner-anchored projection, this fixture
        // would falsely admit; with lowest-gas-anchored projection,
        // it rejects because the gas delta vs the cheapest no-hook
        // exceeds the raw improvement.
        const projectedGateFinder = new QuoteBestSplitFinder<MockPool>(
          0n,
          0n,
          0n,
          false, // AGG_HOOK_PARTITION_USE_LOWEST_GAS_ANCHOR: OFF
          true, // AGG_HOOK_PARTITION_USE_PROJECTED_GAS_ADJ_GATE: ON
          0n
        );

        const noHookRawWinner = noHookRouteAt(
          '0x3100000000000000000000000000000000000000',
          50
        );
        const noHookCheapestGas = noHookRouteAt(
          '0x3110000000000000000000000000000000000000',
          50
        );
        const aggHook = aggHookRouteAt(
          '0x3120000000000000000000000000000000000000',
          50
        );

        const stats = projectedGateFinder['getBestUnusedQuotesStats'](
          50,
          new Map<number, QuoteBasic[]>([
            [
              50,
              [
                // Raw-winner has both high gas (50_000 QT) AND high gas
                // units (200_000). Lowest-gas no-hook has 30_000 QT,
                // 100_000 units. AggHook beats raw-winner trivially on
                // BOTH gas dimensions (170_000 units, 35_000 QT) but
                // loses to the lowest-gas anchor on gas QT
                // (35_000 vs 30_000 = +5_000 overhead) vs +911 raw gain.
                createMockQuoteWithGasCostQT(
                  noHookRawWinner,
                  1001n,
                  200_000n,
                  50_000n
                ),
                createMockQuoteWithGasCostQT(
                  noHookCheapestGas,
                  1001n,
                  100_000n,
                  30_000n
                ),
                createMockQuoteWithGasCostQT(aggHook, 1912n, 170_000n, 35_000n),
              ],
            ],
          ]),
          [],
          ChainId.MAINNET,
          TradeType.ExactIn,
          canaryInstrumentation()
        );

        // Projection against displaced-slice anchor (lowest-gas no-
        // hook within indices [1, K)) = noHookCheapestGas (30_000 QT).
        // gasOverheadQT (5000) - rawImprovementQT (911) = 4089 > 0 →
        // projection WOULD reject. The verdict (`admit_raw_only`)
        // proves the projection used the displaced-slice anchor
        // independent of `AGG_HOOK_PARTITION_USE_LOWEST_GAS_ANCHOR`.
        // With round-5 telemetry-only semantics, partition still
        // admits.
        expect(stats.partitionAdmittedAggHook).toBe(true);
        expect(stats.projectedGateVerdict).toBe('admit_raw_only');
      });

      it('projection anchor stays inside the K-budget returnable set, not phantom no-hook outside top-K (Codex round-2 finding #1)', () => {
        // MAX_VALID_QUOTES_PER_PERCENTAGE=2. Place a cheap-gas no-hook
        // at index 2 (outside the top-K). If the projection anchored
        // on the full no-hook list, it would compare agg-hook against
        // the index-2 quote (low gas), reject, and then fill the K=2
        // slots with the worse-gas no-hook quotes at indices 0/1.
        // With the round-2 fix, the projection anchors WITHIN the
        // top-K (indices 0/1), where agg-hook is competitive enough
        // to be admitted.
        const projectedGateFinder = new QuoteBestSplitFinder<MockPool>(
          0n,
          0n,
          0n,
          false,
          true, // projection kill-switch ON
          0n
        );

        const noHookRaw0 = noHookRouteAt(
          '0x3400000000000000000000000000000000000000',
          50
        );
        const noHookRaw1 = noHookRouteAt(
          '0x3410000000000000000000000000000000000000',
          50
        );
        const noHookCheapButDiscarded = noHookRouteAt(
          '0x3420000000000000000000000000000000000000',
          50
        );
        const aggHook = aggHookRouteAt(
          '0x3430000000000000000000000000000000000000',
          50
        );

        const stats = projectedGateFinder['getBestUnusedQuotesStats'](
          50,
          new Map<number, QuoteBasic[]>([
            [
              50,
              [
                // Top-K (indices 0..1) no-hooks have HIGH gas QT
                // (60_000), so agg-hook at 35_000 GAS QT beats them.
                // The phantom quote at index 2 has very low gas
                // (10_000) — outside the K-budget and SHOULD NOT
                // anchor the projection.
                createMockQuoteWithGasCostQT(
                  noHookRaw0,
                  2000n,
                  200_000n,
                  60_000n
                ),
                createMockQuoteWithGasCostQT(
                  noHookRaw1,
                  1999n,
                  200_000n,
                  60_000n
                ),
                createMockQuoteWithGasCostQT(
                  noHookCheapButDiscarded,
                  1500n,
                  100_000n,
                  10_000n
                ),
                // aggHook: +1_911 raw vs top-K-anchor 2000n
                // (badness=89 raw, badness*10000=890_000 > 0*2000=0;
                // raw_amount gate rejects). Move aggHook above noHook
                // top-K on raw to bypass the raw-amount gate.
                createMockQuoteWithGasCostQT(aggHook, 2050n, 200_000n, 35_000n),
              ],
            ],
          ]),
          [],
          ChainId.MAINNET,
          TradeType.ExactIn,
          canaryInstrumentation()
        );

        // With round-2 fix: projection anchor is among top-K (raw0 at
        // 60_000 QT). aggHook 35_000 < 60_000 → gas overhead negative
        // → projection ADMITS. Without the fix (anchor on the
        // phantom quote): aggHook 35_000 > 10_000 → projection
        // rejects. The test must observe ADMIT.
        expect(stats.partitionAdmittedAggHook).toBe(true);
        expect(stats.projectedGateVerdict).toBe('admit_both');
      });

      it('existing raw/gas reject takes precedence over no_data when gasCostInQuoteToken is missing (Codex round-2 finding #2)', () => {
        // gas-use gate rejects (big gas-unit delta) AND
        // gasCostInQuoteToken is missing on agg-hook side. Verdict
        // must be `reject_gas_use`, not `no_data` (which would
        // wrongly imply defensive admit).
        const projectedGateFinder = new QuoteBestSplitFinder<MockPool>(
          0n,
          0n,
          0n,
          false,
          true, // projection kill-switch ON
          0n
        );

        const noHook = noHookRouteAt(
          '0x3500000000000000000000000000000000000000',
          50
        );
        const aggHook = aggHookRouteAt(
          '0x3510000000000000000000000000000000000000',
          50
        );

        const stats = projectedGateFinder['getBestUnusedQuotesStats'](
          50,
          new Map<number, QuoteBasic[]>([
            [
              50,
              [
                // gas-use delta 400_000 > 0 → existing gas-use gate
                // rejects. aggHook lacks gasCostInQuoteToken →
                // projection would return undefined (`no_data`).
                // Verdict must reflect the actual rejection cause.
                createMockQuoteWithGasUse(aggHook, 1000n, 500_000n),
                createMockQuoteWithGasCostQT(noHook, 1000n, 100_000n, 30_000n),
              ],
            ],
          ]),
          [],
          ChainId.MAINNET,
          TradeType.ExactIn,
          canaryInstrumentation()
        );

        expect(stats.partitionAdmittedAggHook).toBe(false);
        expect(stats.projectedGateVerdict).toBe('reject_gas_use');
      });

      it('existing raw_amount reject takes precedence over no_data when gasCostInQuoteToken is missing (Codex round-2 finding #2)', () => {
        // Same as above but raw-amount gate rejects instead. Verdict
        // must be `reject_raw_amount`, not `no_data`.
        const projectedGateFinder = new QuoteBestSplitFinder<MockPool>(
          0n,
          0n,
          0n,
          false,
          true,
          0n
        );

        const noHookWinner = noHookRouteAt(
          '0x3600000000000000000000000000000000000000',
          50
        );
        const noHookRunnerUp = noHookRouteAt(
          '0x3610000000000000000000000000000000000000',
          50
        );
        const aggHook = aggHookRouteAt(
          '0x3620000000000000000000000000000000000000',
          50
        );

        const stats = projectedGateFinder['getBestUnusedQuotesStats'](
          50,
          new Map<number, QuoteBasic[]>([
            [
              50,
              [
                createMockQuoteWithGasCostQT(
                  noHookWinner,
                  2000n,
                  100_000n,
                  30_000n
                ),
                createMockQuoteWithGasCostQT(
                  noHookRunnerUp,
                  1000n,
                  100_000n,
                  30_000n
                ),
                // aggHook below noHookRunnerUp on raw → raw-amount
                // gate rejects. No gasCostInQuoteToken on aggHook →
                // projection no_data.
                createMockQuoteWithGasUse(aggHook, 900n, 100_000n),
              ],
            ],
          ]),
          [],
          ChainId.MAINNET,
          TradeType.ExactIn,
          canaryInstrumentation()
        );

        expect(stats.partitionAdmittedAggHook).toBe(false);
        expect(stats.projectedGateVerdict).toBe('reject_raw_amount');
      });

      it('projection anchor uses the displaced runner-up, NOT the kept winner (Codex round-3 finding)', () => {
        // The kept winner has CHEAP gas. The displaced runner-up has
        // EXPENSIVE gas. Pre-fix code anchored on the kept winner
        // (lowest-gas in the top-K) and would have rejected agg-hook
        // against a quote it doesn't displace. The fix bounds the
        // anchor to the displaced slice, so projection compares
        // agg-hook vs the runner-up — where agg-hook is competitive
        // (cheaper gas than the runner-up).
        const projectedGateFinder = new QuoteBestSplitFinder<MockPool>(
          0n,
          0n,
          0n,
          false,
          true, // projection kill-switch ON
          0n
        );

        const noHookKeptCheapGas = noHookRouteAt(
          '0x3700000000000000000000000000000000000000',
          50
        );
        const noHookDisplacedExpensiveGas = noHookRouteAt(
          '0x3710000000000000000000000000000000000000',
          50
        );
        const aggHook = aggHookRouteAt(
          '0x3720000000000000000000000000000000000000',
          50
        );

        const stats = projectedGateFinder['getBestUnusedQuotesStats'](
          50,
          new Map<number, QuoteBasic[]>([
            [
              50,
              [
                // noHookKeptCheapGas: top-by-raw AND cheapest gas
                // (10_000 QT). KEPT in both admit and reject outcomes
                // → should NOT anchor the projection.
                createMockQuoteWithGasCostQT(
                  noHookKeptCheapGas,
                  2000n,
                  100_000n,
                  10_000n
                ),
                // noHookDisplacedExpensiveGas: runner-up, expensive
                // gas (50_000 QT) → DISPLACED when agg-hook admitted.
                // This IS the projection anchor.
                createMockQuoteWithGasCostQT(
                  noHookDisplacedExpensiveGas,
                  1999n,
                  100_000n,
                  50_000n
                ),
                // aggHook: 1 raw better than runnerUp, 35_000 QT gas
                // (cheaper than runnerUp's 50_000). vs runnerUp:
                // gasOverhead = 35_000-50_000 = -15_000, raw +1 →
                // net = -15_001 < 0 → projection ADMITS. vs winner
                // (10_000 QT): gasOverhead = 25_000 > raw 1 → would
                // wrongly REJECT.
                createMockQuoteWithGasCostQT(aggHook, 2000n, 100_000n, 35_000n),
              ],
            ],
          ]),
          [],
          ChainId.MAINNET,
          TradeType.ExactIn,
          canaryInstrumentation()
        );

        // With round-3 fix (displaced-slice anchor): ADMIT. Without
        // the fix (top-K anchor that includes the kept winner):
        // REJECT.
        expect(stats.partitionAdmittedAggHook).toBe(true);
        expect(stats.projectedGateVerdict).toBe('admit_both');
      });

      it('verdict is admit_raw_only when raw/gas gates admit but projection would reject (round-5 telemetry-only)', () => {
        // Codex stop-gate (round-4) finding: pre-fix code mis-tagged
        // a projection-only rejection as `reject_gas_use` because
        // `existingGateRejectReason` returned `undefined` and the
        // fallback was `reject_gas_use`. Correct verdict is
        // `admit_raw_only`. Round-5 telemetry-only semantics: the
        // partition still admits (no hard-prune); only the metric
        // verdict reflects that the projection would have rejected.
        const projectedGateFinder = new QuoteBestSplitFinder<MockPool>(
          0n,
          0n,
          0n,
          false,
          true, // projection kill-switch ON
          0n
        );

        const {noHookWinner, noHookRunnerUp, aggHook} = makeBugShapeFixture(
          '0x3300000000000000000000000000000000000000',
          '0x3301000000000000000000000000000000000000',
          '0x3310000000000000000000000000000000000000'
        );

        const stats = projectedGateFinder['getBestUnusedQuotesStats'](
          50,
          new Map<number, QuoteBasic[]>([
            [
              50,
              [
                createMockQuoteWithGasCostQT(
                  noHookWinner,
                  236895678n,
                  445_011n,
                  30445n
                ),
                createMockQuoteWithGasCostQT(
                  noHookRunnerUp,
                  236895677n,
                  445_011n,
                  30445n
                ),
                // FluidDexT1-shape fixture: +911 raw vs runnerUp,
                // +17,635 gas QT, SAME gas units (so the gas-use gate
                // vacuously admits).
                createMockQuoteWithGasCostQT(
                  aggHook,
                  236896588n,
                  445_011n,
                  48080n
                ),
              ],
            ],
          ]),
          [],
          ChainId.MAINNET,
          TradeType.ExactIn,
          canaryInstrumentation()
        );

        // Projection would reject (gas QT overhead > raw gain), but
        // raw/gas gates admit → telemetry verdict `admit_raw_only`;
        // partition admits (telemetry-only enforcement per round-5).
        expect(stats.partitionAdmittedAggHook).toBe(true);
        expect(stats.projectedGateVerdict).toBe('admit_raw_only');
      });

      it('telemetry skipped when testAggHooks is false (no projectedGateVerdict computed, Codex round-4 perf finding)', () => {
        // The verdict block must NOT run on non-canary paths — under
        // wall-clock timeout pressure the bigint arithmetic and
        // protocol-registry lookup can convert successful searches
        // into partial searches. Round-5 telemetry-only semantics:
        // partition admits in either canary or non-canary mode (the
        // flag is reserved for future enforcement); the test asserts
        // only that the verdict helpers are not invoked when the
        // canary gate is off.
        const projectedGateFinder = new QuoteBestSplitFinder<MockPool>(
          0n,
          0n,
          0n,
          false,
          true, // kill-switch ON — verdict computation should still skip without testAggHooks
          0n
        );

        const {noHookWinner, noHookRunnerUp, aggHook} = makeBugShapeFixture(
          '0x3800000000000000000000000000000000000000',
          '0x3801000000000000000000000000000000000000',
          '0x3810000000000000000000000000000000000000'
        );

        // Spy on the helpers — they must NOT be called when
        // telemetry is off.
        const projSpy = vi.spyOn(
          projectedGateFinder as unknown as {
            projectedGateWouldAdmit: () => unknown;
          },
          'projectedGateWouldAdmit'
        );
        const reasonSpy = vi.spyOn(
          projectedGateFinder as unknown as {
            existingGateRejectReason: () => unknown;
          },
          'existingGateRejectReason'
        );

        const stats = projectedGateFinder['getBestUnusedQuotesStats'](
          50,
          new Map<number, QuoteBasic[]>([
            [
              50,
              [
                createMockQuoteWithGasCostQT(
                  noHookWinner,
                  236895678n,
                  445_011n,
                  30445n
                ),
                createMockQuoteWithGasCostQT(
                  noHookRunnerUp,
                  236895677n,
                  445_011n,
                  30445n
                ),
                createMockQuoteWithGasCostQT(
                  aggHook,
                  236896588n,
                  445_011n,
                  48080n
                ),
              ],
            ],
          ]),
          [],
          ChainId.MAINNET,
          TradeType.ExactIn
          // No instrumentation arg → telemetry off.
        );

        // Round-5: no hard-prune, so partition admits agg-hook
        // regardless of the projection result. The important guarantee
        // is that the telemetry verdict computation skipped entirely
        // → verdict undefined and helpers not invoked.
        expect(stats.partitionAdmittedAggHook).toBe(true);
        expect(stats.projectedGateVerdict).toBeUndefined();
        expect(projSpy).not.toHaveBeenCalled();
        expect(reasonSpy).not.toHaveBeenCalled();

        projSpy.mockRestore();
        reasonSpy.mockRestore();
      });

      it('round-5: gate does NOT hard-prune agg-hook even when projection rejects (telemetry-only)', () => {
        // Codex round-5 finding #1: hard-pruning on a local
        // projection is unsafe given DFS conflict-propagation. The
        // K-budget partition's admit/reject decision must stay
        // driven by the existing raw-amount and gas-USE gates;
        // projection only feeds telemetry.
        const projectedGateFinder = new QuoteBestSplitFinder<MockPool>(
          0n,
          0n,
          0n,
          false,
          true, // projection flag ON — still a no-op for enforcement
          0n
        );

        const {noHookWinner, noHookRunnerUp, aggHook} = makeBugShapeFixture(
          '0x3a00000000000000000000000000000000000000',
          '0x3a01000000000000000000000000000000000000',
          '0x3a10000000000000000000000000000000000000'
        );

        const stats = projectedGateFinder['getBestUnusedQuotesStats'](
          50,
          new Map<number, QuoteBasic[]>([
            [
              50,
              [
                createMockQuoteWithGasCostQT(
                  noHookWinner,
                  236895678n,
                  445_011n,
                  30445n
                ),
                createMockQuoteWithGasCostQT(
                  noHookRunnerUp,
                  236895677n,
                  445_011n,
                  30445n
                ),
                // FluidDexT1 shape: projection WOULD reject.
                createMockQuoteWithGasCostQT(
                  aggHook,
                  236896588n,
                  445_011n,
                  48080n
                ),
              ],
            ],
          ]),
          [],
          ChainId.MAINNET,
          TradeType.ExactIn,
          canaryInstrumentation()
        );

        // Partition admits — projection is observation-only.
        expect(stats.partitionAdmittedAggHook).toBe(true);
        const routes = stats.quotes.map(q => q.route);
        expect(routes).toContain(aggHook);
        // Telemetry still records what the projection would have done.
        expect(stats.projectedGateVerdict).toBe('admit_raw_only');
      });

      it('telemetry skipped: projectedGateWouldAdmit is short-circuited when raw/gas gate already rejected (Codex round-4)', () => {
        // Even when telemetry is ON, if the existing raw or gas-use
        // gate already rejected, the projection check is irrelevant
        // — skip it to save the bigint arithmetic.
        const projectedGateFinder = new QuoteBestSplitFinder<MockPool>(
          0n,
          0n,
          0n,
          false,
          true,
          0n
        );

        const projSpy = vi.spyOn(
          projectedGateFinder as unknown as {
            projectedGateWouldAdmit: () => unknown;
          },
          'projectedGateWouldAdmit'
        );

        const noHookWinner = noHookRouteAt(
          '0x3900000000000000000000000000000000000000',
          50
        );
        const noHookRunnerUp = noHookRouteAt(
          '0x3901000000000000000000000000000000000000',
          50
        );
        const aggHook = aggHookRouteAt(
          '0x3910000000000000000000000000000000000000',
          50
        );

        // Big gas-use delta → existing gas-use gate rejects.
        const stats = projectedGateFinder['getBestUnusedQuotesStats'](
          50,
          new Map<number, QuoteBasic[]>([
            [
              50,
              [
                createMockQuoteWithGasCostQT(
                  noHookWinner,
                  1001n,
                  100_000n,
                  30_000n
                ),
                createMockQuoteWithGasCostQT(
                  noHookRunnerUp,
                  1000n,
                  100_000n,
                  30_000n
                ),
                createMockQuoteWithGasCostQT(aggHook, 1000n, 500_000n, 48_000n),
              ],
            ],
          ]),
          [],
          ChainId.MAINNET,
          TradeType.ExactIn,
          canaryInstrumentation()
        );

        expect(stats.partitionAdmittedAggHook).toBe(false);
        expect(stats.projectedGateVerdict).toBe('reject_gas_use');
        // Verdict computation went through `existingGateRejectReason`
        // path and skipped the more expensive projection check.
        expect(projSpy).not.toHaveBeenCalled();

        projSpy.mockRestore();
      });

      it('worst-case verdict retention: DFS revisit with admit_raw_only is not suppressed by an earlier admit_both visit (Codex finding #1)', () => {
        // Simulate two DFS visits to the same percentage with
        // different `usedRoutes`. First visit produces `admit_both`
        // (benign), second produces `admit_raw_only` (projection
        // would reject). The accumulator must retain `admit_raw_only`
        // because that's the population the metric must size.
        const projectedGateFinder = new QuoteBestSplitFinder<MockPool>(
          0n,
          0n,
          0n,
          false,
          true,
          0n
        );

        const aggHook = aggHookRouteAt(
          '0x3200000000000000000000000000000000000000',
          50
        );
        // Visit 1 quote set: agg-hook gas gain covers gas overhead →
        // admit_both.
        const noHookFavorable = noHookRouteAt(
          '0x3210000000000000000000000000000000000000',
          50
        );
        // Visit 2 quote set (different `usedRoutes` filter): cheaper
        // no-hook anchor → admit_raw_only.
        const noHookUnfavorable = noHookRouteAt(
          '0x3220000000000000000000000000000000000000',
          50
        );

        const protocol = 'StableSwapNG';
        const accumulator = new Map<
          string,
          | 'admit_both'
          | 'admit_raw_only'
          | 'reject_raw_amount'
          | 'reject_gas_use'
          | 'no_data'
        >();

        // Simulate the wrapper's worst-case retention logic by calling
        // the helper directly. First visit: admit_both.
        const k1 = `50:${protocol}`;
        accumulator.set(k1, 'admit_both');
        const existing1 = accumulator.get(k1);
        const sev = (
          v:
            | 'admit_both'
            | 'admit_raw_only'
            | 'reject_raw_amount'
            | 'reject_gas_use'
            | 'no_data'
        ) => projectedGateFinder['projectedGateVerdictSeverity'](v);
        // Second visit: admit_raw_only (worse). Should replace.
        if (existing1 === undefined || sev('admit_raw_only') > sev(existing1)) {
          accumulator.set(k1, 'admit_raw_only');
        }
        expect(accumulator.get(k1)).toBe('admit_raw_only');

        // Third visit: admit_both (less severe). Must NOT replace.
        const existing2 = accumulator.get(k1);
        if (existing2 === undefined || sev('admit_both') > sev(existing2)) {
          accumulator.set(k1, 'admit_both');
        }
        expect(accumulator.get(k1)).toBe('admit_raw_only');

        // Sanity: the fixture-level pieces compile.
        void aggHook;
        void noHookFavorable;
        void noHookUnfavorable;
      });
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
        ['chainId:1'],
        {firedChosenSplitGasWorse: false}
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
        ['chainId:1'],
        {firedChosenSplitGasWorse: false}
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
        ['chainId:1'],
        {firedChosenSplitGasWorse: false}
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
        ['chainId:1'],
        {firedChosenSplitGasWorse: false}
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
        ['chainId:1'],
        {firedChosenSplitGasWorse: false}
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
        ['chainId:1'],
        {firedChosenSplitGasWorse: false}
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
        ['chainId:1'],
        {firedChosenSplitGasWorse: false}
      );

      expect(splitMetricCalls()).toHaveLength(0);
      expect(splitLogCalls()).toHaveLength(0);
    });
  });

  describe('agg-hook winner attribution (catch-all)', () => {
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

    const buildAttribution = (
      overrides?: Partial<{
        firedPartitionKeptHigherGas: boolean;
        firedSoleCandidateAdmit: boolean;
        firedSoleCandidateGasWorse: boolean;
        firedChosenSplitGasWorse: boolean;
        firedAnchorSubOptimal: boolean;
      }>
    ) => ({
      firedPartitionKeptHigherGas: false,
      firedSoleCandidateAdmit: false,
      firedSoleCandidateGasWorse: false,
      firedChosenSplitGasWorse: false,
      firedAnchorSubOptimal: false,
      ...overrides,
    });

    const infoMock = () => mockContext.logger.info as ReturnType<typeof vi.fn>;
    const metricMock = () =>
      mockContext.metrics.count as ReturnType<typeof vi.fn>;

    const attributionMetricCalls = () =>
      metricMock().mock.calls.filter(c =>
        (c[2] as {tags: string[]}).tags.some(t => t.startsWith('attributed:'))
      );
    const attributionLogCalls = () =>
      infoMock().mock.calls.filter(
        c => c[0] === 'QuoteBestSplitFinder agg-hook selected as winner'
      );

    it('does not fire when testAggHooks is false', () => {
      const aggHook = aggHookRouteAt(
        '0xa000000000000000000000000000000000000000',
        50
      );
      const noHook = noHookRouteAt(
        '0xa100000000000000000000000000000000000000',
        50
      );
      const quoteMap = buildQuoteMap([
        createMockQuoteWithGas(aggHook, 1000n, 200n),
        createMockQuoteWithGas(noHook, 990n, 100n),
      ]);
      finder['emitAggHookWinnerAttribution'](
        [[aggHook]],
        quoteMap,
        ChainId.MAINNET,
        mockContext,
        false,
        TradeType.ExactIn,
        ['chainId:1'],
        buildAttribution()
      );
      expect(attributionMetricCalls()).toHaveLength(0);
      expect(attributionLogCalls()).toHaveLength(0);
    });

    it('does not fire when the chosen split has no agg-hook leg', () => {
      const noHook1 = noHookRouteAt(
        '0xa200000000000000000000000000000000000000',
        50
      );
      const noHook2 = noHookRouteAt(
        '0xa300000000000000000000000000000000000000',
        50
      );
      const quoteMap = buildQuoteMap([
        createMockQuoteWithGas(noHook1, 1000n, 100n),
        createMockQuoteWithGas(noHook2, 990n, 100n),
      ]);
      finder['emitAggHookWinnerAttribution'](
        [[noHook1, noHook2]],
        quoteMap,
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1'],
        buildAttribution()
      );
      expect(attributionMetricCalls()).toHaveLength(0);
      expect(attributionLogCalls()).toHaveLength(0);
    });

    it('does not fire when result is empty', () => {
      finder['emitAggHookWinnerAttribution'](
        [],
        new Map(),
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1'],
        buildAttribution()
      );
      expect(attributionMetricCalls()).toHaveLength(0);
      expect(attributionLogCalls()).toHaveLength(0);
    });

    it('fires with attributed:false when no sibling log fired (the residual category)', () => {
      const aggHook = aggHookRouteAt(
        '0xa400000000000000000000000000000000000000',
        50
      );
      const noHook = noHookRouteAt(
        '0xa500000000000000000000000000000000000000',
        50
      );
      // EQUAL gas between chosen agg-hook and no-hook alt so the
      // shape flag `firedRawBetterGasWorseVsNoHookAlt` does NOT fire
      // — this is the genuinely-residual case (treatment higher raw,
      // same gas → treatment win, not a Cat-A loss shape).
      const quoteMap = buildQuoteMap([
        createMockQuoteWithGas(aggHook, 1000n, 100n),
        createMockQuoteWithGas(noHook, 990n, 100n),
      ]);
      finder['emitAggHookWinnerAttribution'](
        [[aggHook], [noHook]],
        quoteMap,
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1'],
        buildAttribution()
      );
      expect(attributionMetricCalls()).toHaveLength(1);
      expect(
        (attributionMetricCalls()[0][2] as {tags: string[]}).tags
      ).toContain('attributed:false');
      expect(attributionLogCalls()).toHaveLength(1);
      const payload = attributionLogCalls()[0][1] as {
        attribution: {
          anyFired: boolean;
          firedRawBetterGasWorseVsNoHookAlt: boolean;
        };
      };
      expect(payload.attribution.anyFired).toBe(false);
      expect(payload.attribution.firedRawBetterGasWorseVsNoHookAlt).toBe(false);
    });

    it('fires firedRawBetterGasWorseVsNoHookAlt when chosen has higher raw AND higher gas than no-hook alt', () => {
      const aggHook = aggHookRouteAt(
        '0xa410000000000000000000000000000000000000',
        50
      );
      const noHook = noHookRouteAt(
        '0xa520000000000000000000000000000000000000',
        50
      );
      // Cat-A loss shape: chosen agg-hook winner has higher raw
      // (1000 > 990) AND higher gas (500 > 100) than the no-hook
      // alternative — `firedRawBetterGasWorseVsNoHookAlt` should fire
      // even when none of the 5 mechanism flags fire.
      const quoteMap = buildQuoteMap([
        createMockQuoteWithGas(aggHook, 1000n, 500n),
        createMockQuoteWithGas(noHook, 990n, 100n),
      ]);
      finder['emitAggHookWinnerAttribution'](
        [[aggHook], [noHook]],
        quoteMap,
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1'],
        buildAttribution()
      );
      expect(attributionMetricCalls()).toHaveLength(1);
      expect(
        (attributionMetricCalls()[0][2] as {tags: string[]}).tags
      ).toContain('attributed:true');
      const payload = attributionLogCalls()[0][1] as {
        attribution: {
          anyFired: boolean;
          firedRawBetterGasWorseVsNoHookAlt: boolean;
          firedPartitionKeptHigherGas: boolean;
        };
      };
      expect(payload.attribution.firedRawBetterGasWorseVsNoHookAlt).toBe(true);
      // Other mechanism flags remain false (test passes
      // `buildAttribution()` with all flags false).
      expect(payload.attribution.firedPartitionKeptHigherGas).toBe(false);
      expect(payload.attribution.anyFired).toBe(true);
    });

    it('does not fire firedRawBetterGasWorseVsNoHookAlt when no no-hook alternative exists', () => {
      const aggHook1 = aggHookRouteAt(
        '0xa430000000000000000000000000000000000000',
        50
      );
      const aggHook2 = aggHookRouteAt(
        '0xa440000000000000000000000000000000000000',
        50
      );
      // Both combinations are agg-hook → no noHookAlt → shape flag
      // can't fire regardless of gas/raw values.
      const quoteMap = buildQuoteMap([
        createMockQuoteWithGas(aggHook1, 1000n, 500n),
        createMockQuoteWithGas(aggHook2, 990n, 100n),
      ]);
      finder['emitAggHookWinnerAttribution'](
        [[aggHook1], [aggHook2]],
        quoteMap,
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1'],
        buildAttribution()
      );
      const payload = attributionLogCalls()[0][1] as {
        attribution: {firedRawBetterGasWorseVsNoHookAlt: boolean};
        noHookAlternative: unknown;
      };
      expect(payload.attribution.firedRawBetterGasWorseVsNoHookAlt).toBe(false);
      expect(payload.noHookAlternative).toBeNull();
    });

    it('propagates attribution flags from sibling logs into the metric tags and payload', () => {
      const aggHook = aggHookRouteAt(
        '0xa600000000000000000000000000000000000000',
        50
      );
      const noHook = noHookRouteAt(
        '0xa700000000000000000000000000000000000000',
        50
      );
      const quoteMap = buildQuoteMap([
        createMockQuoteWithGas(aggHook, 1000n, 200n),
        createMockQuoteWithGas(noHook, 990n, 100n),
      ]);
      finder['emitAggHookWinnerAttribution'](
        [[aggHook], [noHook]],
        quoteMap,
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1'],
        buildAttribution({
          firedPartitionKeptHigherGas: true,
          firedAnchorSubOptimal: true,
        })
      );
      expect(attributionMetricCalls()).toHaveLength(1);
      const metricTags = (attributionMetricCalls()[0][2] as {tags: string[]})
        .tags;
      // The 5 firedXxx flags are deliberately excluded from metric
      // tags (cardinality guard per PR #8341's SRE pager); they live
      // on the log payload only. The metric carries only bounded
      // slicers + the attributed summary so its timeseries count
      // stays orders of magnitude below the 500K threshold.
      expect(metricTags).toContain('attributed:true');
      expect(metricTags).toContain('testAggHooks:true');
      expect(
        metricTags.some(t => t.startsWith('firedPartitionKeptHigherGas:'))
      ).toBe(false);
      expect(metricTags.some(t => t.startsWith('firedAnchorSubOptimal:'))).toBe(
        false
      );

      const payload = attributionLogCalls()[0][1] as {
        attribution: Record<string, boolean>;
      };
      expect(payload.attribution.firedPartitionKeptHigherGas).toBe(true);
      expect(payload.attribution.firedAnchorSubOptimal).toBe(true);
      expect(payload.attribution.firedSoleCandidateAdmit).toBe(false);
      expect(payload.attribution.anyFired).toBe(true);
    });

    it('emits chosen split + best no-hook alternative deltas in the log payload', () => {
      const aggHook = aggHookRouteAt(
        '0xa800000000000000000000000000000000000000',
        50
      );
      const noHookBest = noHookRouteAt(
        '0xa900000000000000000000000000000000000000',
        50
      );
      const noHookWorse = noHookRouteAt(
        '0xaa00000000000000000000000000000000000000',
        50
      );
      const quoteMap = buildQuoteMap([
        createMockQuoteWithGas(aggHook, 1010n, 200n),
        createMockQuoteWithGas(noHookBest, 1000n, 80n),
        createMockQuoteWithGas(noHookWorse, 950n, 70n),
      ]);
      finder['emitAggHookWinnerAttribution'](
        [[aggHook], [noHookBest], [noHookWorse]],
        quoteMap,
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1'],
        buildAttribution()
      );
      const payload = attributionLogCalls()[0][1] as {
        chosenSplit: {
          rawTotal: string;
          gasTotal: string;
          aggHookLegCount: number;
          legsWithMissingGas: number;
        };
        noHookAlternative: {
          rawTotal: string;
          gasTotal: string;
          rawTotalDelta: string;
          gasTotalDelta: string;
        } | null;
      };
      expect(payload.chosenSplit.rawTotal).toBe('1010');
      expect(payload.chosenSplit.gasTotal).toBe('200');
      expect(payload.chosenSplit.aggHookLegCount).toBe(1);
      expect(payload.chosenSplit.legsWithMissingGas).toBe(0);
      // Best (first-encountered) no-hook alternative is noHookBest.
      expect(payload.noHookAlternative!.rawTotal).toBe('1000');
      expect(payload.noHookAlternative!.gasTotal).toBe('80');
      expect(payload.noHookAlternative!.rawTotalDelta).toBe('10');
      expect(payload.noHookAlternative!.gasTotalDelta).toBe('120');
    });

    it('emits noHookAlternative=null when no no-hook combination exists', () => {
      const aggHook1 = aggHookRouteAt(
        '0xab00000000000000000000000000000000000000',
        50
      );
      const aggHook2 = aggHookRouteAt(
        '0xac00000000000000000000000000000000000000',
        50
      );
      const quoteMap = buildQuoteMap([
        createMockQuoteWithGas(aggHook1, 1000n, 200n),
        createMockQuoteWithGas(aggHook2, 990n, 200n),
      ]);
      finder['emitAggHookWinnerAttribution'](
        [[aggHook1], [aggHook2]],
        quoteMap,
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1'],
        buildAttribution()
      );
      const payload = attributionLogCalls()[0][1] as {
        noHookAlternative: unknown;
      };
      expect(payload.noHookAlternative).toBeNull();
    });

    // Empirical-dev finding: `filterAndSortResults` puts 100%
    // single-pool routes at result[0] regardless of score, so when the
    // user-facing winner is a multi-leg split it sits at result[1+].
    // Both the catch-all and existing sibling #4 (`chosen split has
    // agg-hook with worse gas`) inspected result[0] only, missing the
    // winner entirely. The catch-all now scans all of result and
    // treats the HIGHEST-RAW combination as the winner (matches BL
    // selection), so it fires even when the agg-hook combo is not at
    // index 0.
    it('detects agg-hook winner when it lives at result[i>0] behind a 100% no-hook route', () => {
      const noHook100 = noHookRouteAt(
        '0xac10000000000000000000000000000000000000',
        100
      );
      // 5-leg split with agg-hook in one of the legs; total raw beats
      // the 100% pool's raw total → BL would pick this split.
      const splitLeg1 = noHookRouteAt(
        '0xac20000000000000000000000000000000000000',
        20
      );
      const splitLeg2 = aggHookRouteAt(
        '0xac30000000000000000000000000000000000000',
        80
      );
      const quoteMap = buildQuoteMap([
        createMockQuoteWithGas(noHook100, 900n, 100n),
        createMockQuoteWithGas(splitLeg1, 250n, 100n),
        createMockQuoteWithGas(splitLeg2, 800n, 300n),
      ]);
      finder['emitAggHookWinnerAttribution'](
        // result[0] = 100% no-hook route (filterAndSort puts it first)
        // result[1] = split with agg-hook (higher raw total = 1050)
        [[noHook100], [splitLeg1, splitLeg2]],
        quoteMap,
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1'],
        buildAttribution()
      );
      expect(attributionMetricCalls()).toHaveLength(1);
      expect(attributionLogCalls()).toHaveLength(1);
      const payload = attributionLogCalls()[0][1] as {
        chosenSplit: {
          rawTotal: string;
          gasTotal: string;
          legCount: number;
          aggHookLegCount: number;
          resultIdx: number;
        };
        noHookAlternative: {rawTotal: string} | null;
      };
      // Highest-raw combination is result[1] (sum 250+800=1050) vs
      // result[0] (900). Catch-all picks result[1].
      expect(payload.chosenSplit.resultIdx).toBe(1);
      expect(payload.chosenSplit.rawTotal).toBe('1050');
      expect(payload.chosenSplit.legCount).toBe(2);
      expect(payload.chosenSplit.aggHookLegCount).toBe(1);
      // No-hook alternative is the 100% route at result[0].
      expect(payload.noHookAlternative!.rawTotal).toBe('900');
    });

    it('still uses result[0] when it is the highest-raw combination', () => {
      const aggHook = aggHookRouteAt(
        '0xac40000000000000000000000000000000000000',
        100
      );
      const noHook = noHookRouteAt(
        '0xac50000000000000000000000000000000000000',
        100
      );
      const quoteMap = buildQuoteMap([
        createMockQuoteWithGas(aggHook, 1000n, 200n),
        createMockQuoteWithGas(noHook, 900n, 100n),
      ]);
      finder['emitAggHookWinnerAttribution'](
        [[aggHook], [noHook]],
        quoteMap,
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1'],
        buildAttribution()
      );
      const payload = attributionLogCalls()[0][1] as {
        chosenSplit: {resultIdx: number; rawTotal: string};
      };
      expect(payload.chosenSplit.resultIdx).toBe(0);
      expect(payload.chosenSplit.rawTotal).toBe('1000');
    });
  });

  describe('no-hook winner Cat-B attribution (catch-all)', () => {
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

    const catBMetricCalls = () =>
      metricMock().mock.calls.filter(c => {
        const tags = (c[2] as {tags: string[]}).tags;
        return (
          tags.some(t => t.startsWith('attributed:')) &&
          // Distinguish from Cat-A attribution metric, which shares
          // the `attributed:` tag prefix. The Cat-B emission also
          // carries `testAggHooks:true` but only fires once per
          // findBestSplits — so look for the Cat-B log alongside.
          true
        );
      });
    const catBLogCalls = () =>
      infoMock().mock.calls.filter(
        c =>
          c[0] === 'QuoteBestSplitFinder no-hook winner with agg-hooks enabled'
      );

    it('does not fire when testAggHooks is false', () => {
      const noHook = noHookRouteAt(
        '0xc000000000000000000000000000000000000000',
        100
      );
      const quoteMap = buildQuoteMap([
        createMockQuoteWithGas(noHook, 1000n, 100n),
      ]);
      finder['emitNoHookWinnerCatBAttribution'](
        [[noHook]],
        quoteMap,
        ChainId.MAINNET,
        mockContext,
        false,
        TradeType.ExactIn,
        ['chainId:1'],
        {firedFindBestSplitsTimedOut: false}
      );
      expect(catBLogCalls()).toHaveLength(0);
    });

    it('does not fire when the chosen winner contains agg-hook (Cat-A territory)', () => {
      const aggHook = aggHookRouteAt(
        '0xc100000000000000000000000000000000000000',
        100
      );
      const quoteMap = buildQuoteMap([
        createMockQuoteWithGas(aggHook, 1000n, 100n),
      ]);
      finder['emitNoHookWinnerCatBAttribution'](
        [[aggHook]],
        quoteMap,
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1'],
        {firedFindBestSplitsTimedOut: false}
      );
      expect(catBLogCalls()).toHaveLength(0);
    });

    it('does not fire when result is empty', () => {
      finder['emitNoHookWinnerCatBAttribution'](
        [],
        new Map(),
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1'],
        {firedFindBestSplitsTimedOut: false}
      );
      expect(catBLogCalls()).toHaveLength(0);
    });

    it('fires with attributed:false when no Cat-B mechanism log fired', () => {
      const noHook = noHookRouteAt(
        '0xc200000000000000000000000000000000000000',
        100
      );
      // Single no-hook quote in result → no agg-hook alternative →
      // `firedAggHookAltLowerGasAndRaw` shape flag can't fire either.
      const quoteMap = buildQuoteMap([
        createMockQuoteWithGas(noHook, 1000n, 100n),
      ]);
      finder['emitNoHookWinnerCatBAttribution'](
        [[noHook]],
        quoteMap,
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1'],
        {firedFindBestSplitsTimedOut: false}
      );
      expect(catBLogCalls()).toHaveLength(1);
      const payload = catBLogCalls()[0][1] as {
        attribution: {
          anyFired: boolean;
          firedFindBestSplitsTimedOut: boolean;
          firedAggHookAltLowerGasAndRaw: boolean;
        };
      };
      expect(payload.attribution.anyFired).toBe(false);
      expect(payload.attribution.firedFindBestSplitsTimedOut).toBe(false);
      expect(payload.attribution.firedAggHookAltLowerGasAndRaw).toBe(false);
    });

    it('fires firedAggHookAltLowerGasAndRaw when result contains an agg-hook combo with lower gas AND lower raw', () => {
      const noHook = noHookRouteAt(
        '0xc210000000000000000000000000000000000000',
        100
      );
      const aggHookAlt = aggHookRouteAt(
        '0xc220000000000000000000000000000000000000',
        100
      );
      // Chosen no-hook (raw=1000, gas=500). Agg-hook alt
      // (raw=900, gas=200) has BOTH lower raw and lower gas — the
      // gas-adj winner depends on per-unit cost, so the BL's pick of
      // no-hook on raw alone is suspicious (Cat-B loss shape).
      const quoteMap = buildQuoteMap([
        createMockQuoteWithGas(noHook, 1000n, 500n),
        createMockQuoteWithGas(aggHookAlt, 900n, 200n),
      ]);
      finder['emitNoHookWinnerCatBAttribution'](
        [[noHook], [aggHookAlt]],
        quoteMap,
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1'],
        {firedFindBestSplitsTimedOut: false}
      );
      expect(catBLogCalls()).toHaveLength(1);
      expect((catBMetricCalls()[0][2] as {tags: string[]}).tags).toContain(
        'attributed:true'
      );
      const payload = catBLogCalls()[0][1] as {
        attribution: {
          anyFired: boolean;
          firedAggHookAltLowerGasAndRaw: boolean;
        };
      };
      expect(payload.attribution.firedAggHookAltLowerGasAndRaw).toBe(true);
      expect(payload.attribution.anyFired).toBe(true);
    });

    it('does not fire firedAggHookAltLowerGasAndRaw when agg-hook alt has higher gas', () => {
      const noHook = noHookRouteAt(
        '0xc230000000000000000000000000000000000000',
        100
      );
      const aggHookAlt = aggHookRouteAt(
        '0xc240000000000000000000000000000000000000',
        100
      );
      // Agg-hook alt has lower raw (900<1000) but HIGHER gas
      // (700>500) — strictly worse alt, BL correctly excluded.
      // Shape flag should NOT fire.
      const quoteMap = buildQuoteMap([
        createMockQuoteWithGas(noHook, 1000n, 500n),
        createMockQuoteWithGas(aggHookAlt, 900n, 700n),
      ]);
      finder['emitNoHookWinnerCatBAttribution'](
        [[noHook], [aggHookAlt]],
        quoteMap,
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1'],
        {firedFindBestSplitsTimedOut: false}
      );
      const payload = catBLogCalls()[0][1] as {
        attribution: {firedAggHookAltLowerGasAndRaw: boolean};
      };
      expect(payload.attribution.firedAggHookAltLowerGasAndRaw).toBe(false);
    });

    it('propagates firedFindBestSplitsTimedOut into the payload + attributed:true tag', () => {
      const noHook = noHookRouteAt(
        '0xc300000000000000000000000000000000000000',
        100
      );
      const quoteMap = buildQuoteMap([
        createMockQuoteWithGas(noHook, 1000n, 100n),
      ]);
      finder['emitNoHookWinnerCatBAttribution'](
        [[noHook]],
        quoteMap,
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1'],
        {firedFindBestSplitsTimedOut: true}
      );
      expect(catBLogCalls()).toHaveLength(1);
      const metricTags = (catBMetricCalls()[0][2] as {tags: string[]}).tags;
      expect(metricTags).toContain('attributed:true');
      // Cardinality guard: per-mechanism flag stays off the metric.
      expect(
        metricTags.some(t => t.startsWith('firedFindBestSplitsTimedOut:'))
      ).toBe(false);

      const payload = catBLogCalls()[0][1] as {
        attribution: {anyFired: boolean; firedFindBestSplitsTimedOut: boolean};
      };
      expect(payload.attribution.firedFindBestSplitsTimedOut).toBe(true);
      expect(payload.attribution.anyFired).toBe(true);
    });

    it('emits chosen split + best agg-hook alternative deltas in the log payload', () => {
      const noHookBest = noHookRouteAt(
        '0xc400000000000000000000000000000000000000',
        50
      );
      const aggHookAlt1 = aggHookRouteAt(
        '0xc500000000000000000000000000000000000000',
        50
      );
      const aggHookAlt2 = aggHookRouteAt(
        '0xc600000000000000000000000000000000000000',
        50
      );
      const quoteMap = buildQuoteMap([
        createMockQuoteWithGas(noHookBest, 1100n, 100n),
        createMockQuoteWithGas(aggHookAlt1, 1050n, 200n),
        createMockQuoteWithGas(aggHookAlt2, 1000n, 250n),
      ]);
      finder['emitNoHookWinnerCatBAttribution'](
        // result[0] = no-hook (1100), result[1] = aggHookAlt1 (1050),
        // result[2] = aggHookAlt2 (1000). Chosen = result[0]; best
        // agg-hook alt = result[1].
        [[noHookBest], [aggHookAlt1], [aggHookAlt2]],
        quoteMap,
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1'],
        {firedFindBestSplitsTimedOut: false}
      );
      const payload = catBLogCalls()[0][1] as {
        chosenSplit: {
          rawTotal: string;
          gasTotal: string;
          legCount: number;
          legsWithMissingGas: number;
          resultIdx: number;
        };
        bestAggHookAlternative: {
          rawTotal: string;
          gasTotal: string;
          legCount: number;
          aggHookLegCount: number;
          rawTotalDelta: string;
          gasTotalDelta: string;
        } | null;
      };
      expect(payload.chosenSplit.rawTotal).toBe('1100');
      expect(payload.chosenSplit.gasTotal).toBe('100');
      expect(payload.chosenSplit.resultIdx).toBe(0);
      expect(payload.bestAggHookAlternative!.rawTotal).toBe('1050');
      expect(payload.bestAggHookAlternative!.gasTotal).toBe('200');
      expect(payload.bestAggHookAlternative!.aggHookLegCount).toBe(1);
      expect(payload.bestAggHookAlternative!.rawTotalDelta).toBe('50');
      expect(payload.bestAggHookAlternative!.gasTotalDelta).toBe('-100');
    });

    it('emits bestAggHookAlternative=null when result has no agg-hook combinations', () => {
      const noHook1 = noHookRouteAt(
        '0xc700000000000000000000000000000000000000',
        100
      );
      const noHook2 = noHookRouteAt(
        '0xc800000000000000000000000000000000000000',
        100
      );
      const quoteMap = buildQuoteMap([
        createMockQuoteWithGas(noHook1, 1000n, 100n),
        createMockQuoteWithGas(noHook2, 990n, 100n),
      ]);
      finder['emitNoHookWinnerCatBAttribution'](
        [[noHook1], [noHook2]],
        quoteMap,
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1'],
        {firedFindBestSplitsTimedOut: false}
      );
      const payload = catBLogCalls()[0][1] as {
        bestAggHookAlternative: unknown;
      };
      expect(payload.bestAggHookAlternative).toBeNull();
    });
  });

  // Residual attribution: post-PR-#8431 the K-budget anchor bug is
  // closed. These two emitters size the remaining mechanism prevalence
  // in prod without re-running DFS.
  describe('K-budget admit / winner correlation', () => {
    const aggHookAddr = STABLE_SWAP_NG[0]!;
    const noHookRouteAt = (addr: string, pct: number) =>
      createMockRoute([createMockPool(mockToken0, mockToken1, addr)], pct);
    const aggHookRouteAt = (addr: string, pct: number) =>
      createMockRoute(
        [createMockPool(mockToken0, mockToken1, addr, aggHookAddr)],
        pct
      );
    const metricCalls = () =>
      (mockContext.metrics.count as ReturnType<typeof vi.fn>).mock.calls.filter(
        c =>
          (c[0] as string).endsWith(
            'QuoteBestSplitFinder.KBudgetAdmitWinnerCorrelation'
          )
      );
    const quoteMapStub = new Map<RouteBasic<MockPool>, QuoteBasic>();

    it('does not fire when testAggHooks is false', () => {
      finder['emitKBudgetAdmitWinnerCorrelation'](
        [[noHookRouteAt('0xa000000000000000000000000000000000000000', 100)]],
        quoteMapStub,
        ChainId.MAINNET,
        mockContext,
        false,
        TradeType.ExactIn,
        ['chainId:1'],
        0
      );
      expect(metricCalls()).toHaveLength(0);
    });

    it('does not fire when result is empty', () => {
      finder['emitKBudgetAdmitWinnerCorrelation'](
        [],
        quoteMapStub,
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1'],
        0
      );
      expect(metricCalls()).toHaveLength(0);
    });

    it('tags partitionAdmitted:true winnerHasAggHook:true when admit propagated to winner', () => {
      const aggHookRoute = aggHookRouteAt(
        '0xa100000000000000000000000000000000000000',
        50
      );
      const noHookRoute = noHookRouteAt(
        '0xa200000000000000000000000000000000000000',
        50
      );
      finder['emitKBudgetAdmitWinnerCorrelation'](
        [[aggHookRoute, noHookRoute]],
        quoteMapStub,
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1'],
        3
      );
      expect(metricCalls()).toHaveLength(1);
      const tags = (metricCalls()[0][2] as {tags: string[]}).tags;
      expect(tags).toContain('partitionAdmitted:true');
      expect(tags).toContain('winnerHasAggHook:true');
    });

    it('tags partitionAdmitted:true winnerHasAggHook:false when admit was harmless', () => {
      const noHookRoute = noHookRouteAt(
        '0xa300000000000000000000000000000000000000',
        100
      );
      finder['emitKBudgetAdmitWinnerCorrelation'](
        [[noHookRoute]],
        quoteMapStub,
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1'],
        2
      );
      expect(metricCalls()).toHaveLength(1);
      const tags = (metricCalls()[0][2] as {tags: string[]}).tags;
      expect(tags).toContain('partitionAdmitted:true');
      expect(tags).toContain('winnerHasAggHook:false');
    });

    it('tags partitionAdmitted:false winnerHasAggHook:true when agg-hook came in via non-partition path', () => {
      const aggHookRoute = aggHookRouteAt(
        '0xa400000000000000000000000000000000000000',
        100
      );
      finder['emitKBudgetAdmitWinnerCorrelation'](
        [[aggHookRoute]],
        quoteMapStub,
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1'],
        0
      );
      expect(metricCalls()).toHaveLength(1);
      const tags = (metricCalls()[0][2] as {tags: string[]}).tags;
      expect(tags).toContain('partitionAdmitted:false');
      expect(tags).toContain('winnerHasAggHook:true');
    });

    it('tags partitionAdmitted:false winnerHasAggHook:false', () => {
      const noHookRoute = noHookRouteAt(
        '0xa500000000000000000000000000000000000000',
        100
      );
      finder['emitKBudgetAdmitWinnerCorrelation'](
        [[noHookRoute]],
        quoteMapStub,
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1'],
        0
      );
      expect(metricCalls()).toHaveLength(1);
      const tags = (metricCalls()[0][2] as {tags: string[]}).tags;
      expect(tags).toContain('partitionAdmitted:false');
      expect(tags).toContain('winnerHasAggHook:false');
    });
  });

  describe('filterAndSortResults full-route bias', () => {
    const aggHookAddr = STABLE_SWAP_NG[0]!;
    const noHookRouteAt = (addr: string, pct: number) =>
      createMockRoute([createMockPool(mockToken0, mockToken1, addr)], pct);
    const aggHookRouteAt = (addr: string, pct: number) =>
      createMockRoute(
        [createMockPool(mockToken0, mockToken1, addr, aggHookAddr)],
        pct
      );

    // Mock quotes with `gasDetails.gasCostInQuoteToken` populated so
    // the scorer takes the gas-adjusted path rather than the raw-only
    // fallback. Matches the live `scoreAndSortCombinations` shape.
    const createMockQuoteWithGasCost = (
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
          gasUse: 1n,
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

    const metricCalls = () =>
      (mockContext.metrics.count as ReturnType<typeof vi.fn>).mock.calls.filter(
        c =>
          (c[0] as string).endsWith(
            'QuoteBestSplitFinder.FilterAndSortFullRouteBias'
          )
      );

    it('does not fire when testAggHooks is false', () => {
      const fullRoute = noHookRouteAt(
        '0xb000000000000000000000000000000000000000',
        100
      );
      const quoteMap = buildQuoteMap([
        createMockQuoteWithGasCost(fullRoute, 1000n, 10n),
      ]);
      finder['emitFilterAndSortFullRouteBias'](
        [[fullRoute]],
        quoteMap,
        ChainId.MAINNET,
        mockContext,
        false,
        TradeType.ExactIn,
        ['chainId:1']
      );
      expect(metricCalls()).toHaveLength(0);
    });

    it('verdict:no_split when only 100% routes present', () => {
      const fullRoute = noHookRouteAt(
        '0xb100000000000000000000000000000000000000',
        100
      );
      const quoteMap = buildQuoteMap([
        createMockQuoteWithGasCost(fullRoute, 1000n, 10n),
      ]);
      finder['emitFilterAndSortFullRouteBias'](
        [[fullRoute]],
        quoteMap,
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1']
      );
      expect(metricCalls()).toHaveLength(1);
      const tags = (metricCalls()[0][2] as {tags: string[]}).tags;
      expect(tags).toContain('verdict:no_split');
      expect(tags).toContain('topPct100HasAggHook:false');
    });

    it('verdict:no_pct100 when only split routes present', () => {
      const splitA = noHookRouteAt(
        '0xb200000000000000000000000000000000000000',
        50
      );
      const splitB = noHookRouteAt(
        '0xb210000000000000000000000000000000000000',
        50
      );
      const quoteMap = buildQuoteMap([
        createMockQuoteWithGasCost(splitA, 500n, 5n),
        createMockQuoteWithGasCost(splitB, 500n, 5n),
      ]);
      finder['emitFilterAndSortFullRouteBias'](
        [[splitA, splitB]],
        quoteMap,
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1']
      );
      expect(metricCalls()).toHaveLength(1);
      const tags = (metricCalls()[0][2] as {tags: string[]}).tags;
      expect(tags).toContain('verdict:no_pct100');
    });

    it('verdict:split_beats_pct100 — bug shape: split has higher gas-adj score but 100% route is ranked first', () => {
      // ExactIn — higher score (amount - gas) is better.
      // 100% route: amount=1000, gas=200 → score=800
      // Split route: 500+500=1000 amount, 5+5=10 gas → score=990 (higher → split is better)
      const fullRoute = aggHookRouteAt(
        '0xb300000000000000000000000000000000000000',
        100
      );
      const splitA = noHookRouteAt(
        '0xb310000000000000000000000000000000000000',
        50
      );
      const splitB = noHookRouteAt(
        '0xb320000000000000000000000000000000000000',
        50
      );
      const quoteMap = buildQuoteMap([
        createMockQuoteWithGasCost(fullRoute, 1000n, 200n),
        createMockQuoteWithGasCost(splitA, 500n, 5n),
        createMockQuoteWithGasCost(splitB, 500n, 5n),
      ]);
      finder['emitFilterAndSortFullRouteBias'](
        [[fullRoute], [splitA, splitB]],
        quoteMap,
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1']
      );
      expect(metricCalls()).toHaveLength(1);
      const tags = (metricCalls()[0][2] as {tags: string[]}).tags;
      expect(tags).toContain('verdict:split_beats_pct100');
      expect(tags).toContain('topPct100HasAggHook:true');
    });

    it('verdict:pct100_beats_split — 100%-first ordering is justified', () => {
      // 100%: amount=1000, gas=5 → score=995
      // Split: 1000 amount, 100 gas → score=900
      const fullRoute = noHookRouteAt(
        '0xb400000000000000000000000000000000000000',
        100
      );
      const splitA = noHookRouteAt(
        '0xb410000000000000000000000000000000000000',
        50
      );
      const splitB = noHookRouteAt(
        '0xb420000000000000000000000000000000000000',
        50
      );
      const quoteMap = buildQuoteMap([
        createMockQuoteWithGasCost(fullRoute, 1000n, 5n),
        createMockQuoteWithGasCost(splitA, 500n, 50n),
        createMockQuoteWithGasCost(splitB, 500n, 50n),
      ]);
      finder['emitFilterAndSortFullRouteBias'](
        [[fullRoute], [splitA, splitB]],
        quoteMap,
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1']
      );
      expect(metricCalls()).toHaveLength(1);
      const tags = (metricCalls()[0][2] as {tags: string[]}).tags;
      expect(tags).toContain('verdict:pct100_beats_split');
    });

    it('emits a score-based verdict + topPct100/topSplitGasComplete tags when any leg lacks gasCostInQuoteToken', () => {
      // Live `scoreAndSortCombinations` falls back to raw-only
      // scoring per-combination when any leg lacks
      // `gasCostInQuoteToken`. Mixed-completeness combinations are
      // still ranked together — the bias metric must mirror that
      // semantic, NOT suppress the verdict via a `gas_info_missing`
      // short-circuit. The completeness tags expose data quality so
      // DD analysts can filter to a strict-gas subset.
      //
      // ExactIn scores (higher = better):
      //   fullRoute: amount=1000, gas=10 → score=990, gasComplete=true
      //   splitA (no gas): amount=500 → score=500 (raw fallback),
      //                                gasComplete=false
      // Best 100% (990) > best split (500) → verdict:pct100_beats_split
      // (an honest reflection of how the live scorer would rank).
      const fullRoute = noHookRouteAt(
        '0xb500000000000000000000000000000000000000',
        100
      );
      const splitA = noHookRouteAt(
        '0xb510000000000000000000000000000000000000',
        50
      );
      const quoteWithoutGas = {
        route: splitA,
        amount: 500n,
        gasDetails: {gasPriceInWei: 1n, gasCostInWei: 1n, gasCostInEth: 0},
      } as unknown as QuoteBasic;
      const quoteMap = buildQuoteMap([
        createMockQuoteWithGasCost(fullRoute, 1000n, 10n),
        quoteWithoutGas,
      ]);
      finder['emitFilterAndSortFullRouteBias'](
        [[fullRoute], [splitA]],
        quoteMap,
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1']
      );
      expect(metricCalls()).toHaveLength(1);
      const tags = (metricCalls()[0][2] as {tags: string[]}).tags;
      expect(tags).toContain('verdict:pct100_beats_split');
      expect(tags).toContain('topPct100GasComplete:true');
      expect(tags).toContain('topSplitGasComplete:false');
      expect(tags.some(t => t === 'verdict:gas_info_missing')).toBe(false);
    });

    it('detects split_beats_pct100 hidden by mixed gas completeness (Codex stop-time finding)', () => {
      // Bug shape Codex flagged: best 100% has complete gas (lower
      // score), best split lacks gas (raw fallback inflates score),
      // and the live scorer's mixed comparison would rank the
      // raw-fallback split first. The previous `gas_info_missing`
      // early-return SUPPRESSED this verdict, hiding the
      // dropped-split bias.
      //
      // ExactIn scores (higher = better):
      //   100%:  amount=1000, gas=200 → 800,  gasComplete=true
      //   split: amount=900 (no gas)  → 900,  gasComplete=false (raw)
      // split (900) > 100% (800) → verdict:split_beats_pct100
      // The fix MUST surface this verdict, not suppress with
      // gas_info_missing.
      const fullRoute = aggHookRouteAt(
        '0xb600000000000000000000000000000000000000',
        100
      );
      const splitA = noHookRouteAt(
        '0xb610000000000000000000000000000000000000',
        50
      );
      const splitB = noHookRouteAt(
        '0xb620000000000000000000000000000000000000',
        50
      );
      const splitAWithoutGas = {
        route: splitA,
        amount: 450n,
        gasDetails: {gasPriceInWei: 1n, gasCostInWei: 1n, gasCostInEth: 0},
      } as unknown as QuoteBasic;
      const splitBWithoutGas = {
        route: splitB,
        amount: 450n,
        gasDetails: {gasPriceInWei: 1n, gasCostInWei: 1n, gasCostInEth: 0},
      } as unknown as QuoteBasic;
      const quoteMap = buildQuoteMap([
        createMockQuoteWithGasCost(fullRoute, 1000n, 200n),
        splitAWithoutGas,
        splitBWithoutGas,
      ]);
      finder['emitFilterAndSortFullRouteBias'](
        [[fullRoute], [splitA, splitB]],
        quoteMap,
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1']
      );
      expect(metricCalls()).toHaveLength(1);
      const tags = (metricCalls()[0][2] as {tags: string[]}).tags;
      expect(tags).toContain('verdict:split_beats_pct100');
      expect(tags).toContain('topPct100HasAggHook:true');
      expect(tags).toContain('topPct100GasComplete:true');
      expect(tags).toContain('topSplitGasComplete:false');
    });

    it('ExactOut: split_beats_pct100 when split has lower (better) score', () => {
      // ExactOut — score = amount + gas, lower is better.
      // 100%: amount=1000, gas=200 → score=1200
      // Split: 1000 amount, 10 gas → score=1010 (lower → split is better)
      const fullRoute = noHookRouteAt(
        '0xb600000000000000000000000000000000000000',
        100
      );
      const splitA = noHookRouteAt(
        '0xb610000000000000000000000000000000000000',
        50
      );
      const splitB = noHookRouteAt(
        '0xb620000000000000000000000000000000000000',
        50
      );
      const quoteMap = buildQuoteMap([
        createMockQuoteWithGasCost(fullRoute, 1000n, 200n),
        createMockQuoteWithGasCost(splitA, 500n, 5n),
        createMockQuoteWithGasCost(splitB, 500n, 5n),
      ]);
      finder['emitFilterAndSortFullRouteBias'](
        [[fullRoute], [splitA, splitB]],
        quoteMap,
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactOut,
        ['chainId:1']
      );
      expect(metricCalls()).toHaveLength(1);
      const tags = (metricCalls()[0][2] as {tags: string[]}).tags;
      expect(tags).toContain('verdict:split_beats_pct100');
    });
  });

  describe('K-budget eviction permanent exclusion', () => {
    const noHookRouteAt = (addr: string, pct: number) =>
      createMockRoute([createMockPool(mockToken0, mockToken1, addr)], pct);

    const createMockQuote = (
      route: RouteBasic<MockPool>,
      amount: bigint
    ): QuoteBasic =>
      ({
        route,
        amount,
      }) as unknown as QuoteBasic;

    const metricCalls = () =>
      (mockContext.metrics.count as ReturnType<typeof vi.fn>).mock.calls.filter(
        c =>
          (c[0] as string).endsWith(
            'QuoteBestSplitFinder.KBudgetEvictionPermanentExclusion'
          )
      );

    it('does not fire when testAggHooks is false', () => {
      finder['emitKBudgetEvictionPermanentExclusion'](
        [[noHookRouteAt('0xc000000000000000000000000000000000000000', 50)]],
        mockContext,
        false,
        TradeType.ExactIn,
        ['chainId:1'],
        [createMockQuote(noHookRouteAt('0xc100', 50), 100n)]
      );
      expect(metricCalls()).toHaveLength(0);
    });

    it('does not fire when no quotes were displaced', () => {
      finder['emitKBudgetEvictionPermanentExclusion'](
        [[noHookRouteAt('0xc200000000000000000000000000000000000000', 50)]],
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1'],
        []
      );
      expect(metricCalls()).toHaveLength(0);
    });

    it('tags excludedAny:true when a displaced route never appears in result', () => {
      const displacedRoute = noHookRouteAt(
        '0xc300000000000000000000000000000000000000',
        50
      );
      // Result contains an unrelated route — displaced is excluded.
      const otherRoute = noHookRouteAt(
        '0xc400000000000000000000000000000000000000',
        50
      );
      finder['emitKBudgetEvictionPermanentExclusion'](
        [[otherRoute]],
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1'],
        [createMockQuote(displacedRoute, 100n)]
      );
      expect(metricCalls()).toHaveLength(1);
      const tags = (metricCalls()[0][2] as {tags: string[]}).tags;
      expect(tags).toContain('excludedAny:true');
      expect(tags).toContain('excludedCountBucket:1');
      expect(tags).toContain('displacedCountBucket:1');
    });

    it('tags excludedAny:false when displaced route appears elsewhere in result', () => {
      const displacedRoute = noHookRouteAt(
        '0xc500000000000000000000000000000000000000',
        50
      );
      // Same displaced route appears in `result` at the same pool sequence.
      finder['emitKBudgetEvictionPermanentExclusion'](
        [[displacedRoute]],
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1'],
        [createMockQuote(displacedRoute, 100n)]
      );
      expect(metricCalls()).toHaveLength(1);
      const tags = (metricCalls()[0][2] as {tags: string[]}).tags;
      expect(tags).toContain('excludedAny:false');
      expect(tags).toContain('excludedCountBucket:0');
      expect(tags).toContain('displacedCountBucket:1');
    });

    it('quantizes displaced counts into 4_plus bucket for >=4 displacements', () => {
      const otherRoute = noHookRouteAt(
        '0xc600000000000000000000000000000000000000',
        50
      );
      const displaced = [1, 2, 3, 4, 5].map(i =>
        createMockQuote(
          noHookRouteAt(`0xc6${i}0000000000000000000000000000000000000`, 50),
          100n
        )
      );
      finder['emitKBudgetEvictionPermanentExclusion'](
        [[otherRoute]],
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1'],
        displaced
      );
      expect(metricCalls()).toHaveLength(1);
      const tags = (metricCalls()[0][2] as {tags: string[]}).tags;
      expect(tags).toContain('displacedCountBucket:4_plus');
      expect(tags).toContain('excludedCountBucket:4_plus');
    });
  });

  describe('K-budget eviction impact (counterfactual)', () => {
    // FluidDexT1 mainnet hook — registered agg-hook for cross-checks.
    const FLUID_HOOK = '0xf1abe2961CCf73B55be164054E7ADC985a52A888';

    const routeAt = (
      addr: string,
      pct: number,
      hooks?: string
    ): RouteBasic<MockPool> =>
      createMockRoute(
        [createMockPool(mockToken0, mockToken1, addr, hooks)],
        pct
      );

    // Builds a QuoteBasic with optional gasCostInQuoteToken populated.
    const quoteWithGas = (
      route: RouteBasic<MockPool>,
      amount: bigint,
      gasCostInQuoteToken?: bigint
    ): QuoteBasic =>
      ({
        route,
        amount,
        gasDetails: {gasCostInQuoteToken},
      }) as unknown as QuoteBasic;

    const metricCalls = () =>
      (mockContext.metrics.count as ReturnType<typeof vi.fn>).mock.calls.filter(
        c =>
          (c[0] as string).endsWith(
            'QuoteBestSplitFinder.KBudgetEvictionImpact'
          )
      );

    const buildEvents = (
      events: {
        percentage: number;
        admittedAggHookQuote: QuoteBasic;
        slotZeroNoHookQuote: QuoteBasic;
        displacedNoHookQuotes: QuoteBasic[];
      }[]
    ) => {
      const m = new Map<
        string,
        {
          percentage: number;
          admittedAggHookQuote: QuoteBasic;
          slotZeroNoHookQuote: QuoteBasic;
          displacedNoHookQuotes: QuoteBasic[];
        }
      >();
      for (const ev of events) {
        const aggRoute = ev.admittedAggHookQuote.route;
        const key = `${ev.percentage}:${aggRoute.path
          .map(p => p.address.toString().toLowerCase())
          .join(',')}`;
        m.set(key, ev);
      }
      return m;
    };

    it('does not fire when testAggHooks is false', () => {
      finder['emitKBudgetEvictionImpact'](
        [],
        ChainId.MAINNET,
        mockContext,
        false,
        TradeType.ExactIn,
        ['chainId:1'],
        0,
        new Map()
      );
      expect(metricCalls()).toHaveLength(0);
    });

    it('emits no_displacement when no admits and no events', () => {
      finder['emitKBudgetEvictionImpact'](
        [[routeAt('0xd100', 50)]],
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1'],
        0,
        new Map()
      );
      expect(metricCalls()).toHaveLength(1);
      const tags = (metricCalls()[0][2] as {tags: string[]}).tags;
      expect(tags).toContain('verdict:no_displacement');
      expect(tags).toContain('displacedAbsorbed:na');
      expect(tags).toContain('displacedScoreDeltaBucket:na');
    });

    it('emits admit_no_truncation when admits fired but no truncation occurred', () => {
      finder['emitKBudgetEvictionImpact'](
        [[routeAt('0xd200', 50)]],
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1'],
        2,
        new Map()
      );
      expect(metricCalls()).toHaveLength(1);
      const tags = (metricCalls()[0][2] as {tags: string[]}).tags;
      expect(tags).toContain('verdict:admit_no_truncation');
    });

    it('emits admit_harmful_gas_adj when displaced beats both anchors materially (EXACT_IN)', () => {
      const aggHookRoute = routeAt('0xd301', 50, FLUID_HOOK);
      const slotZeroRoute = routeAt('0xd302', 50);
      const displacedRoute = routeAt('0xd303', 50);
      // EXACT_IN scores: amount - gasCostInQuoteToken (higher = better)
      //   slotZero = 1000 - 5 = 995
      //   admitted = 998 - 40 = 958  (loses to slotZero)
      //   anchor   = max(995, 958) = 995
      //   displaced = 1050 - 5 = 1045  → 5,025 bps above anchor (well > tol)
      const events = buildEvents([
        {
          percentage: 50,
          admittedAggHookQuote: quoteWithGas(aggHookRoute, 998n, 40n),
          slotZeroNoHookQuote: quoteWithGas(slotZeroRoute, 1000n, 5n),
          displacedNoHookQuotes: [quoteWithGas(displacedRoute, 1050n, 5n)],
        },
      ]);
      finder['emitKBudgetEvictionImpact'](
        [[aggHookRoute]],
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1'],
        1,
        events
      );
      expect(metricCalls()).toHaveLength(1);
      const tags = (metricCalls()[0][2] as {tags: string[]}).tags;
      expect(tags).toContain('verdict:admit_harmful_gas_adj');
      expect(tags).toContain('displacedAbsorbed:false');
      expect(tags).toContain('displacedScoreDeltaBucket:gt_50');
    });

    it('emits admit_neutral_gas_adj when displaced ties the anchor within tolerance', () => {
      const aggHookRoute = routeAt('0xd401', 50, FLUID_HOOK);
      const slotZeroRoute = routeAt('0xd402', 50);
      const displacedRoute = routeAt('0xd403', 50);
      // Default AGG_HOOK_PARTITION_TOLERANCE_BPS=0 ⇒ admit_neutral only
      // when deltaBps is exactly 0. Build a tie: anchor=slotZero=995;
      // displaced=995 → delta=0bps → admit_neutral_gas_adj.
      const events = buildEvents([
        {
          percentage: 50,
          admittedAggHookQuote: quoteWithGas(aggHookRoute, 998n, 40n),
          slotZeroNoHookQuote: quoteWithGas(slotZeroRoute, 1000n, 5n),
          displacedNoHookQuotes: [quoteWithGas(displacedRoute, 1000n, 5n)],
        },
      ]);
      finder['emitKBudgetEvictionImpact'](
        [[aggHookRoute]],
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1'],
        1,
        events
      );
      expect(metricCalls()).toHaveLength(1);
      const tags = (metricCalls()[0][2] as {tags: string[]}).tags;
      expect(tags).toContain('verdict:admit_neutral_gas_adj');
      expect(tags).toContain('displacedScoreDeltaBucket:0_to_1');
    });

    it('emits admit_correct_gas_adj when displaced is strictly worse beyond tolerance', () => {
      const aggHookRoute = routeAt('0xd501', 50, FLUID_HOOK);
      const slotZeroRoute = routeAt('0xd502', 50);
      const displacedRoute = routeAt('0xd503', 50);
      // anchor = max(1000-5, 998-40) = 995; displaced = 100-5 = 95
      // delta = (95-995)/1000 * 10000 = -9000 bps → admit_correct_gas_adj
      const events = buildEvents([
        {
          percentage: 50,
          admittedAggHookQuote: quoteWithGas(aggHookRoute, 998n, 40n),
          slotZeroNoHookQuote: quoteWithGas(slotZeroRoute, 1000n, 5n),
          displacedNoHookQuotes: [quoteWithGas(displacedRoute, 100n, 5n)],
        },
      ]);
      finder['emitKBudgetEvictionImpact'](
        [[aggHookRoute]],
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1'],
        1,
        events
      );
      expect(metricCalls()).toHaveLength(1);
      const tags = (metricCalls()[0][2] as {tags: string[]}).tags;
      expect(tags).toContain('verdict:admit_correct_gas_adj');
      expect(tags).toContain('displacedScoreDeltaBucket:le_neg_50');
    });

    it('emits gas_data_missing when displaced quote lacks gasCostInQuoteToken', () => {
      const aggHookRoute = routeAt('0xd601', 50, FLUID_HOOK);
      const slotZeroRoute = routeAt('0xd602', 50);
      const displacedRoute = routeAt('0xd603', 50);
      const events = buildEvents([
        {
          percentage: 50,
          admittedAggHookQuote: quoteWithGas(aggHookRoute, 998n, 40n),
          slotZeroNoHookQuote: quoteWithGas(slotZeroRoute, 1000n, 5n),
          displacedNoHookQuotes: [
            quoteWithGas(displacedRoute, 1050n /* no gasCost */),
          ],
        },
      ]);
      finder['emitKBudgetEvictionImpact'](
        [[aggHookRoute]],
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1'],
        1,
        events
      );
      expect(metricCalls()).toHaveLength(1);
      const tags = (metricCalls()[0][2] as {tags: string[]}).tags;
      expect(tags).toContain('verdict:gas_data_missing');
      expect(tags).toContain('displacedAbsorbed:false');
      expect(tags).toContain('displacedScoreDeltaBucket:na');
    });

    it('overrides gas_data_missing → displaced_absorbed_in_result when displaced route appears in result', () => {
      const aggHookRoute = routeAt('0xd701', 50, FLUID_HOOK);
      const slotZeroRoute = routeAt('0xd702', 50);
      const displacedRoute = routeAt('0xd703', 50);
      const events = buildEvents([
        {
          percentage: 50,
          admittedAggHookQuote: quoteWithGas(aggHookRoute, 998n, 40n),
          slotZeroNoHookQuote: quoteWithGas(slotZeroRoute, 1000n, 5n),
          displacedNoHookQuotes: [
            quoteWithGas(displacedRoute, 1050n /* no gasCost */),
          ],
        },
      ]);
      finder['emitKBudgetEvictionImpact'](
        // The displaced route appears as a leg in a different combination.
        [[aggHookRoute], [displacedRoute]],
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1'],
        1,
        events
      );
      expect(metricCalls()).toHaveLength(1);
      const tags = (metricCalls()[0][2] as {tags: string[]}).tags;
      expect(tags).toContain('verdict:displaced_absorbed_in_result');
      expect(tags).toContain('displacedAbsorbed:true');
    });

    it('sets displacedAbsorbed:true tag when displaced route appears in result on the harmful path', () => {
      const aggHookRoute = routeAt('0xd801', 50, FLUID_HOOK);
      const slotZeroRoute = routeAt('0xd802', 50);
      const displacedRoute = routeAt('0xd803', 50);
      const events = buildEvents([
        {
          percentage: 50,
          admittedAggHookQuote: quoteWithGas(aggHookRoute, 998n, 40n),
          slotZeroNoHookQuote: quoteWithGas(slotZeroRoute, 1000n, 5n),
          displacedNoHookQuotes: [quoteWithGas(displacedRoute, 1050n, 5n)],
        },
      ]);
      finder['emitKBudgetEvictionImpact'](
        // displacedRoute appears as a leg in a different combination — absorbed.
        [[aggHookRoute], [displacedRoute]],
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1'],
        1,
        events
      );
      expect(metricCalls()).toHaveLength(1);
      const tags = (metricCalls()[0][2] as {tags: string[]}).tags;
      expect(tags).toContain('verdict:admit_harmful_gas_adj');
      expect(tags).toContain('displacedAbsorbed:true');
    });

    it('sets winnerHasAggHook:true when result[0] contains an agg-hook route', () => {
      const aggHookRoute = routeAt('0xd901', 50, FLUID_HOOK);
      const slotZeroRoute = routeAt('0xd902', 50);
      const displacedRoute = routeAt('0xd903', 50);
      const events = buildEvents([
        {
          percentage: 50,
          admittedAggHookQuote: quoteWithGas(aggHookRoute, 998n, 40n),
          slotZeroNoHookQuote: quoteWithGas(slotZeroRoute, 1000n, 5n),
          displacedNoHookQuotes: [quoteWithGas(displacedRoute, 1050n, 5n)],
        },
      ]);
      finder['emitKBudgetEvictionImpact'](
        [[aggHookRoute]],
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1'],
        1,
        events
      );
      const tags = (metricCalls()[0][2] as {tags: string[]}).tags;
      expect(tags).toContain('winnerHasAggHook:true');
    });

    it('sets winnerHasAggHook:false when result[0] is no-hook only', () => {
      const aggHookRoute = routeAt('0xda01', 50, FLUID_HOOK);
      const slotZeroRoute = routeAt('0xda02', 50);
      const displacedRoute = routeAt('0xda03', 50);
      const events = buildEvents([
        {
          percentage: 50,
          admittedAggHookQuote: quoteWithGas(aggHookRoute, 998n, 40n),
          slotZeroNoHookQuote: quoteWithGas(slotZeroRoute, 1000n, 5n),
          displacedNoHookQuotes: [quoteWithGas(displacedRoute, 1050n, 5n)],
        },
      ]);
      finder['emitKBudgetEvictionImpact'](
        // No agg-hook in result.
        [[slotZeroRoute]],
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1'],
        1,
        events
      );
      const tags = (metricCalls()[0][2] as {tags: string[]}).tags;
      expect(tags).toContain('winnerHasAggHook:false');
    });

    it('sign-inverts for EXACT_OUT — displaced needing less input is harmful (gas-adj)', () => {
      const aggHookRoute = routeAt('0xdb01', 50, FLUID_HOOK);
      const slotZeroRoute = routeAt('0xdb02', 50);
      const displacedRoute = routeAt('0xdb03', 50);
      // EXACT_OUT scores: amount + gasCostInQuoteToken (LOWER = better)
      //   slotZero = 1000+5 = 1005; admitted = 998+40 = 1038
      //   anchor   = min(1005, 1038) = 1005 (best)
      //   displaced = 800+5 = 805  → 200 bps "better" than anchor when
      //   sign-normalized for EXACT_OUT → admit_harmful_gas_adj
      const events = buildEvents([
        {
          percentage: 50,
          admittedAggHookQuote: quoteWithGas(aggHookRoute, 998n, 40n),
          slotZeroNoHookQuote: quoteWithGas(slotZeroRoute, 1000n, 5n),
          displacedNoHookQuotes: [quoteWithGas(displacedRoute, 800n, 5n)],
        },
      ]);
      finder['emitKBudgetEvictionImpact'](
        [[aggHookRoute]],
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactOut,
        ['chainId:1'],
        1,
        events
      );
      const tags = (metricCalls()[0][2] as {tags: string[]}).tags;
      expect(tags).toContain('verdict:admit_harmful_gas_adj');
    });

    it('aggregates worst-case across multiple events (one harmful, one correct → emits harmful)', () => {
      const aggHook1 = routeAt('0xdc01', 50, FLUID_HOOK);
      const aggHook2 = routeAt('0xdc02', 75, FLUID_HOOK);
      const slotZero1 = routeAt('0xdc03', 50);
      const slotZero2 = routeAt('0xdc04', 75);
      const displacedHarmful = routeAt('0xdc05', 50);
      const displacedCorrect = routeAt('0xdc06', 75);
      const events = buildEvents([
        // Event A: displaced strictly worse — admit_correct.
        {
          percentage: 75,
          admittedAggHookQuote: quoteWithGas(aggHook2, 998n, 40n),
          slotZeroNoHookQuote: quoteWithGas(slotZero2, 1000n, 5n),
          displacedNoHookQuotes: [quoteWithGas(displacedCorrect, 100n, 5n)],
        },
        // Event B: displaced beats both anchors — admit_harmful.
        {
          percentage: 50,
          admittedAggHookQuote: quoteWithGas(aggHook1, 998n, 40n),
          slotZeroNoHookQuote: quoteWithGas(slotZero1, 1000n, 5n),
          displacedNoHookQuotes: [quoteWithGas(displacedHarmful, 1050n, 5n)],
        },
      ]);
      finder['emitKBudgetEvictionImpact'](
        [[aggHook1]],
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1'],
        2,
        events
      );
      const tags = (metricCalls()[0][2] as {tags: string[]}).tags;
      expect(tags).toContain('verdict:admit_harmful_gas_adj');
    });

    it('always emits exactly once per request (no-displacement path)', () => {
      finder['emitKBudgetEvictionImpact'](
        [],
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1'],
        0,
        new Map()
      );
      expect(metricCalls()).toHaveLength(1);
    });

    // Codex review finding #2: route identity must include percentage.
    // Without the fix, a displaced 50% route would be incorrectly
    // marked absorbed by a 25% route with the same pool path —
    // different percentages produce different gas-adj math and are
    // not equivalent routes.
    it('does NOT mark displacedAbsorbed:true when result has the same pool path at a different percentage', () => {
      const aggHookRoute = routeAt('0xdd01', 50, FLUID_HOOK);
      const slotZeroRoute = routeAt('0xdd02', 50);
      const displacedRoute = routeAt('0xdd03', 50);
      // result contains the same pool path but at percentage 25 — NOT
      // the same route by identity. Should be flagged as not absorbed.
      const sameShapeDifferentPct = routeAt('0xdd03', 25);
      const events = buildEvents([
        {
          percentage: 50,
          admittedAggHookQuote: quoteWithGas(aggHookRoute, 998n, 40n),
          slotZeroNoHookQuote: quoteWithGas(slotZeroRoute, 1000n, 5n),
          displacedNoHookQuotes: [quoteWithGas(displacedRoute, 1050n, 5n)],
        },
      ]);
      finder['emitKBudgetEvictionImpact'](
        [[aggHookRoute], [sameShapeDifferentPct]],
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1'],
        1,
        events
      );
      const tags = (metricCalls()[0][2] as {tags: string[]}).tags;
      expect(tags).toContain('verdict:admit_harmful_gas_adj');
      // Pool path matches a result route but percentage differs ⇒
      // not absorbed.
      expect(tags).toContain('displacedAbsorbed:false');
    });

    // Codex review finding #1: worst-case across multiple events at
    // the SAME percentage. Different DFS branches at the same
    // percentage admit the same agg-hook with different slot-zero
    // and displaced slates. The wrapper now keys events on the full
    // slate (percentage + admittedAggHook + slotZero + displaced),
    // so each unique slate lands as its own event. The emitter
    // aggregates worst-case across them; if any slate is harmful,
    // the verdict must be admit_harmful_gas_adj.
    it('selects the worst-case slate when the same percentage has multiple harmful + benign events', () => {
      const aggHookRoute = routeAt('0xde01', 50, FLUID_HOOK);
      const slotZeroA = routeAt('0xde02', 50);
      const slotZeroB = routeAt('0xde03', 50);
      const displacedHarmful = routeAt('0xde04', 50);
      const displacedBenign = routeAt('0xde05', 50);
      const events = buildEvents([
        // Slate A: benign — displaced strictly worse than anchor.
        {
          percentage: 50,
          admittedAggHookQuote: quoteWithGas(aggHookRoute, 998n, 40n),
          slotZeroNoHookQuote: quoteWithGas(slotZeroA, 1000n, 5n),
          displacedNoHookQuotes: [quoteWithGas(displacedBenign, 100n, 5n)],
        },
        // Slate B: harmful — different slot-zero, harmful displaced.
        {
          percentage: 50,
          admittedAggHookQuote: quoteWithGas(aggHookRoute, 998n, 40n),
          slotZeroNoHookQuote: quoteWithGas(slotZeroB, 999n, 5n),
          displacedNoHookQuotes: [quoteWithGas(displacedHarmful, 1050n, 5n)],
        },
      ]);
      finder['emitKBudgetEvictionImpact'](
        [[aggHookRoute]],
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1'],
        1,
        events
      );
      const tags = (metricCalls()[0][2] as {tags: string[]}).tags;
      expect(tags).toContain('verdict:admit_harmful_gas_adj');
    });

    // Codex adversarial-review (second pass) finding: aggregating
    // raw-unit score deltas across events before computing bps is
    // wrong. A large-notional event with a bigger absolute wei
    // delta but 0 bps after integer division can overwrite a
    // small-notional event with materially harmful bps. Pre-fix
    // behavior would emit admit_neutral; post-fix the per-event
    // classification + severity-ranked selection surfaces the
    // harmful event.
    it('does NOT let a large-notional 0-bps event overwrite a small-notional harmful-bps event', () => {
      // Event A — small notional, deltaBps=30 (harmful):
      //   anchor amount=1000, displaced amount=1003, no gas cost.
      //   rawDelta=3, deltaBps=(3*10000)/1000=30
      const aggHookSmall = routeAt('0xea01', 50, FLUID_HOOK);
      const slotZeroSmall = routeAt('0xea02', 50);
      const displacedSmall = routeAt('0xea03', 50);
      // Event B — large notional, raw delta is bigger but bps=0:
      //   anchor amount=1_000_000, displaced=1_000_010 → raw=10,
      //   deltaBps = (10*10000)/1_000_000 = 0 (integer truncation).
      const aggHookLarge = routeAt('0xea04', 75, FLUID_HOOK);
      const slotZeroLarge = routeAt('0xea05', 75);
      const displacedLarge = routeAt('0xea06', 75);
      const events = buildEvents([
        {
          percentage: 50,
          admittedAggHookQuote: quoteWithGas(aggHookSmall, 999n, 0n),
          slotZeroNoHookQuote: quoteWithGas(slotZeroSmall, 1000n, 0n),
          displacedNoHookQuotes: [quoteWithGas(displacedSmall, 1003n, 0n)],
        },
        {
          percentage: 75,
          admittedAggHookQuote: quoteWithGas(aggHookLarge, 999_999n, 0n),
          slotZeroNoHookQuote: quoteWithGas(slotZeroLarge, 1_000_000n, 0n),
          displacedNoHookQuotes: [quoteWithGas(displacedLarge, 1_000_010n, 0n)],
        },
      ]);
      finder['emitKBudgetEvictionImpact'](
        [[aggHookSmall]],
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1'],
        2,
        events
      );
      const tags = (metricCalls()[0][2] as {tags: string[]}).tags;
      // Pre-fix this would have emitted admit_neutral_gas_adj because
      // the large-notional event's rawDelta (10) > small-notional's
      // (3), and the chosen event's deltaBps rounds to 0.
      expect(tags).toContain('verdict:admit_harmful_gas_adj');
      expect(tags).toContain('displacedScoreDeltaBucket:10_to_50');
    });

    // Companion to the above: when one event is harmful+absorbed and
    // another is harmful+unabsorbed, severity ranking picks the
    // unabsorbed one (the smoking-gun query `verdict:harmful AND
    // displacedAbsorbed:false`). Pre-fix behavior would pick by raw
    // delta and could let the absorbed event hide the unabsorbed one.
    it('prefers harmful+unabsorbed over harmful+absorbed regardless of bps magnitude', () => {
      const aggHookA = routeAt('0xeb01', 50, FLUID_HOOK);
      const slotZeroA = routeAt('0xeb02', 50);
      // Smoking-gun: harmful + NOT absorbed in result. Moderate bps.
      const unabsorbedDisplaced = routeAt('0xeb03', 50);
      const aggHookB = routeAt('0xeb04', 75, FLUID_HOOK);
      const slotZeroB = routeAt('0xeb05', 75);
      // Absorbed harmful event with much bigger bps but absorbed in
      // result — should NOT win selection over the unabsorbed
      // smoking-gun.
      const absorbedDisplaced = routeAt('0xeb06', 75);
      const events = buildEvents([
        {
          percentage: 50,
          admittedAggHookQuote: quoteWithGas(aggHookA, 999n, 0n),
          slotZeroNoHookQuote: quoteWithGas(slotZeroA, 1000n, 0n),
          displacedNoHookQuotes: [quoteWithGas(unabsorbedDisplaced, 1010n, 0n)],
        },
        {
          percentage: 75,
          admittedAggHookQuote: quoteWithGas(aggHookB, 999n, 0n),
          slotZeroNoHookQuote: quoteWithGas(slotZeroB, 1000n, 0n),
          // Much larger bps — would dominate any "tiebreak by
          // magnitude" if absorbed was disregarded.
          displacedNoHookQuotes: [quoteWithGas(absorbedDisplaced, 2000n, 0n)],
        },
      ]);
      finder['emitKBudgetEvictionImpact'](
        // Result contains absorbedDisplaced (75%) but NOT
        // unabsorbedDisplaced (50%).
        [[aggHookA], [absorbedDisplaced]],
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1'],
        2,
        events
      );
      const tags = (metricCalls()[0][2] as {tags: string[]}).tags;
      expect(tags).toContain('verdict:admit_harmful_gas_adj');
      // Severity ranking should pick the unabsorbed event over the
      // absorbed one even though the absorbed event has bigger bps.
      expect(tags).toContain('displacedAbsorbed:false');
    });

    // Codex review finding #3: only the partition-evicted slice is
    // the counterfactual replacement. Wrapper feeds
    // `partitionEvictedNoHookQuotes` (the slice
    // noHooks[noHookBudget, k)) into the event — NOT
    // `displacedNoHookQuotes` (which is the broader
    // noHooks[noHookBudget:] used by KBudgetEvictionPermanentExclusion).
    // This test asserts that the emitter's input semantics produce
    // admit_harmful only when the singular partition-evicted rank
    // would have won — i.e. its gas-adj score beats both anchors.
    it('only considers the partition-evicted slice (the rank that would have been admitted if partition rejected)', () => {
      const aggHookRoute = routeAt('0xdf01', 50, FLUID_HOOK);
      const slotZeroRoute = routeAt('0xdf02', 50);
      // The partition-evicted quote — rank 1 (the one displaced by
      // K=2/budget=1). Pass it as the SOLE displaced quote in the
      // event tuple, mirroring what the wrapper produces from
      // partitionEvictedNoHookQuotes.
      const partitionEvicted = routeAt('0xdf03', 50);
      const events = buildEvents([
        {
          percentage: 50,
          admittedAggHookQuote: quoteWithGas(aggHookRoute, 998n, 40n),
          slotZeroNoHookQuote: quoteWithGas(slotZeroRoute, 1000n, 5n),
          // Only the partition-evicted candidate — no rank-3+ entries
          // here (those are excluded at the wrapper level so they
          // never reach the emitter as displaced candidates).
          displacedNoHookQuotes: [quoteWithGas(partitionEvicted, 1050n, 5n)],
        },
      ]);
      finder['emitKBudgetEvictionImpact'](
        [[aggHookRoute]],
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1'],
        1,
        events
      );
      const tags = (metricCalls()[0][2] as {tags: string[]}).tags;
      expect(tags).toContain('verdict:admit_harmful_gas_adj');
    });
  });

  describe('K-budget bucket profile', () => {
    const metricCalls = () =>
      (mockContext.metrics.count as ReturnType<typeof vi.fn>).mock.calls.filter(
        c =>
          (c[0] as string).endsWith('QuoteBestSplitFinder.KBudgetBucketProfile')
      );

    const emptyCounts = {
      both_populated_partition_admitted: 0,
      both_populated_partition_rejected: 0,
      no_hook_only: 0,
      agg_hook_only_admitted: 0,
      agg_hook_only_rejected: 0,
      empty: 0,
    };

    it('does not fire when testAggHooks is false', () => {
      finder['emitKBudgetBucketProfile'](
        mockContext,
        false,
        TradeType.ExactIn,
        ['chainId:1'],
        {...emptyCounts, no_hook_only: 5}
      );
      expect(metricCalls()).toHaveLength(0);
    });

    it('emits one metric with all six bucket-shape counts tagged', () => {
      finder['emitKBudgetBucketProfile'](
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1'],
        {
          both_populated_partition_admitted: 2,
          both_populated_partition_rejected: 1,
          no_hook_only: 4,
          agg_hook_only_admitted: 0,
          agg_hook_only_rejected: 3,
          empty: 0,
        }
      );
      expect(metricCalls()).toHaveLength(1);
      const tags = (metricCalls()[0][2] as {tags: string[]}).tags;
      expect(tags).toContain('bothPopulatedAdmittedBucket:2');
      expect(tags).toContain('bothPopulatedRejectedBucket:1');
      expect(tags).toContain('noHookOnlyBucket:4_plus');
      expect(tags).toContain('aggHookOnlyAdmittedBucket:0');
      expect(tags).toContain('aggHookOnlyRejectedBucket:3');
      expect(tags).toContain('emptyBucket:0');
    });
  });

  describe('K-budget projected-loss what-if', () => {
    const metricCalls = () =>
      (mockContext.metrics.count as ReturnType<typeof vi.fn>).mock.calls.filter(
        c =>
          (c[0] as string).endsWith(
            'QuoteBestSplitFinder.KBudgetAdmitProjectedLoss'
          )
      );

    it('does not fire when testAggHooks is false', () => {
      const worst = new Map<
        string,
        | 'admit_both'
        | 'admit_raw_only'
        | 'reject_raw_amount'
        | 'reject_gas_use'
        | 'no_data'
      >([['50:FluidDexT1', 'admit_raw_only']]);
      finder['emitKBudgetAdmitProjectedLoss'](
        mockContext,
        false,
        TradeType.ExactIn,
        ['chainId:1'],
        worst
      );
      expect(metricCalls()).toHaveLength(0);
    });

    it('emits one count per (verdict, protocol) with the per-bucket count as the value', () => {
      const worst = new Map<
        string,
        | 'admit_both'
        | 'admit_raw_only'
        | 'reject_raw_amount'
        | 'reject_gas_use'
        | 'no_data'
      >([
        // 5 buckets at admit_both/FluidDexT1
        ['25:FluidDexT1', 'admit_both'],
        ['50:FluidDexT1', 'admit_both'],
        ['75:FluidDexT1', 'admit_both'],
        ['100:FluidDexT1', 'admit_both'],
        ['10:FluidDexT1', 'admit_both'],
        // 3 buckets at admit_raw_only/FluidDexT1
        ['30:FluidDexT1', 'admit_raw_only'],
        ['60:FluidDexT1', 'admit_raw_only'],
        ['90:FluidDexT1', 'admit_raw_only'],
        // 1 bucket at admit_raw_only/CurveStableSwapNG
        ['20:CurveStableSwapNG', 'admit_raw_only'],
        // 2 buckets at reject_gas_use/FluidDexLite
        ['40:FluidDexLite', 'reject_gas_use'],
        ['80:FluidDexLite', 'reject_gas_use'],
      ]);
      finder['emitKBudgetAdmitProjectedLoss'](
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1'],
        worst
      );
      const calls = metricCalls();
      expect(calls).toHaveLength(4);

      const findCall = (verdict: string, protocol: string) =>
        calls.find(c => {
          const tags = (c[2] as {tags: string[]}).tags;
          return (
            tags.includes(`verdict:${verdict}`) &&
            tags.includes(`protocol:${protocol}`)
          );
        });

      expect(findCall('admit_both', 'FluidDexT1')?.[1]).toBe(5);
      expect(findCall('admit_raw_only', 'FluidDexT1')?.[1]).toBe(3);
      expect(findCall('admit_raw_only', 'CurveStableSwapNG')?.[1]).toBe(1);
      expect(findCall('reject_gas_use', 'FluidDexLite')?.[1]).toBe(2);
    });

    it('emits no events when the worst-verdict map is empty', () => {
      const worst = new Map<
        string,
        | 'admit_both'
        | 'admit_raw_only'
        | 'reject_raw_amount'
        | 'reject_gas_use'
        | 'no_data'
      >();
      finder['emitKBudgetAdmitProjectedLoss'](
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1'],
        worst
      );
      expect(metricCalls()).toHaveLength(0);
    });

    it('emits reject_raw_amount as a distinct verdict from reject_gas_use', () => {
      // Codex adversarial-review finding #2: dashboards must be able
      // to distinguish raw-gate rejects from gas-use rejects.
      const worst = new Map<
        string,
        | 'admit_both'
        | 'admit_raw_only'
        | 'reject_raw_amount'
        | 'reject_gas_use'
        | 'no_data'
      >([
        ['10:FluidDexT1', 'reject_raw_amount'],
        ['50:FluidDexT1', 'reject_gas_use'],
      ]);
      finder['emitKBudgetAdmitProjectedLoss'](
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1'],
        worst
      );
      const calls = metricCalls();
      expect(calls).toHaveLength(2);
      const verdictTags = calls.map(c =>
        (c[2] as {tags: string[]}).tags.find(t => t.startsWith('verdict:'))
      );
      expect(verdictTags).toContain('verdict:reject_raw_amount');
      expect(verdictTags).toContain('verdict:reject_gas_use');
    });
  });

  describe('projected-gate verdict severity (worst-case retention)', () => {
    // Codex adversarial-review finding #1: DFS revisits with different
    // `usedRoutes` can produce different verdicts for the same
    // (percentage, protocol). The accumulator must retain the
    // highest-severity verdict so a benign early visit doesn't
    // suppress a later projected-loss signal.
    type Verdict =
      | 'admit_both'
      | 'admit_raw_only'
      | 'reject_raw_amount'
      | 'reject_gas_use'
      | 'no_data';
    const severity = (v: Verdict): number =>
      finder['projectedGateVerdictSeverity'](v);

    it('ranks admit_raw_only above all other verdicts', () => {
      expect(severity('admit_raw_only')).toBeGreaterThan(
        severity('admit_both')
      );
      expect(severity('admit_raw_only')).toBeGreaterThan(
        severity('reject_raw_amount')
      );
      expect(severity('admit_raw_only')).toBeGreaterThan(
        severity('reject_gas_use')
      );
      expect(severity('admit_raw_only')).toBeGreaterThan(severity('no_data'));
    });

    it('ranks admit_both above reject_* and no_data', () => {
      expect(severity('admit_both')).toBeGreaterThan(
        severity('reject_raw_amount')
      );
      expect(severity('admit_both')).toBeGreaterThan(
        severity('reject_gas_use')
      );
      expect(severity('admit_both')).toBeGreaterThan(severity('no_data'));
    });

    it('ranks reject_raw_amount above reject_gas_use and no_data', () => {
      expect(severity('reject_raw_amount')).toBeGreaterThan(
        severity('reject_gas_use')
      );
      expect(severity('reject_raw_amount')).toBeGreaterThan(
        severity('no_data')
      );
    });

    it('ranks no_data as the lowest severity', () => {
      expect(severity('no_data')).toBeLessThan(severity('reject_gas_use'));
    });
  });

  describe('agg-hook winner gas per protocol', () => {
    const aggHookAddr = STABLE_SWAP_NG[0]!;
    const aggHookRouteAt = (addr: string, pct: number) =>
      createMockRoute(
        [createMockPool(mockToken0, mockToken1, addr, aggHookAddr)],
        pct
      );
    const noHookRouteAt = (addr: string, pct: number) =>
      createMockRoute([createMockPool(mockToken0, mockToken1, addr)], pct);

    const createMockQuoteWithGasCost = (
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
          gasUse: 1n,
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

    const distCalls = () =>
      (mockContext.metrics.dist as ReturnType<typeof vi.fn>).mock.calls.filter(
        c =>
          (c[0] as string).endsWith(
            'QuoteBestSplitFinder.AggHookWinnerGasPerProtocol'
          )
      );

    it('does not fire when testAggHooks is false', () => {
      const aggHook = aggHookRouteAt(
        '0xd000000000000000000000000000000000000000',
        100
      );
      const quoteMap = buildQuoteMap([
        createMockQuoteWithGasCost(aggHook, 1000n, 100n),
      ]);
      finder['emitAggHookWinnerGasPerProtocol'](
        [[aggHook]],
        quoteMap,
        ChainId.MAINNET,
        mockContext,
        false,
        TradeType.ExactIn,
        ['chainId:1']
      );
      expect(distCalls()).toHaveLength(0);
    });

    it('does not fire when result has no agg-hook legs', () => {
      const noHook = noHookRouteAt(
        '0xd100000000000000000000000000000000000000',
        100
      );
      const quoteMap = buildQuoteMap([
        createMockQuoteWithGasCost(noHook, 1000n, 100n),
      ]);
      finder['emitAggHookWinnerGasPerProtocol'](
        [[noHook]],
        quoteMap,
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1']
      );
      expect(distCalls()).toHaveLength(0);
    });

    it('emits one distribution datapoint per agg-hook leg tagged with the AGG-HOOK protocol (not the Uniswap version)', () => {
      // Staging-deploy bug shape: prior code used `pool.protocol`
      // which for V4Pool returns `Protocol.V4` — every emission
      // tagged `protocol:v4`, making the per-protocol distribution
      // useless. The fix uses `getProtocolForAggHookAddress` so the
      // tag carries the agg-hook protocol family (FluidDexT1,
      // CurveStableSwapNG, etc.). For STABLE_SWAP_NG[0] on mainnet
      // the registry resolves to Protocol.CURVESTABLESWAPNG.
      const aggHookA = aggHookRouteAt(
        '0xd200000000000000000000000000000000000000',
        50
      );
      const aggHookB = aggHookRouteAt(
        '0xd210000000000000000000000000000000000000',
        50
      );
      const quoteMap = buildQuoteMap([
        createMockQuoteWithGasCost(aggHookA, 500n, 100n),
        createMockQuoteWithGasCost(aggHookB, 500n, 200n),
      ]);
      finder['emitAggHookWinnerGasPerProtocol'](
        [[aggHookA, aggHookB]],
        quoteMap,
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1']
      );
      expect(distCalls()).toHaveLength(2);
      for (const c of distCalls()) {
        const tags = (c[2] as {tags: string[]}).tags;
        // The agg-hook protocol identifier resolved via the registry.
        // STABLE_SWAP_NG[0] on MAINNET → Protocol.CURVESTABLESWAPNG.
        expect(tags).toContain(`protocol:${Protocol.CURVESTABLESWAPNG}`);
        // Must NOT be the bare Uniswap version that V4Pool reports.
        expect(tags).not.toContain('protocol:v4');
      }
    });

    it('skips agg-hook legs without populated gasCostInQuoteToken', () => {
      const aggHook = aggHookRouteAt(
        '0xd300000000000000000000000000000000000000',
        100
      );
      const quoteWithoutGas = {
        route: aggHook,
        amount: 1000n,
        gasDetails: {gasPriceInWei: 1n, gasCostInWei: 1n, gasCostInEth: 0},
      } as unknown as QuoteBasic;
      const quoteMap = buildQuoteMap([quoteWithoutGas]);
      finder['emitAggHookWinnerGasPerProtocol'](
        [[aggHook]],
        quoteMap,
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1']
      );
      expect(distCalls()).toHaveLength(0);
    });

    // Codex finding (medium): "tags the first pool, not the agg-hook
    // pool". `Pool` requires every pool to expose `protocol`, so mixed
    // routes whose first hop is V2/V3/V4 and whose agg-hook leg is
    // deeper would be mislabeled. The emitter must pick the agg-hook
    // leg via the same `isAggHookPool` predicate used by
    // `routeUsesAggHook`.
    it('tags the agg-hook leg protocol on mixed routes (not the first leg)', () => {
      // Build a mixed 2-leg route:
      //   leg 0: no-hook MockPool with protocol = Protocol.V2
      //   leg 1: agg-hook MockPool with protocol = Protocol.V3
      // Bug shape: emitter previously took the first non-null
      // `protocol` (leg 0 = V2). Correct shape: take the agg-hook
      // leg's protocol (leg 1 = V3).
      const noHookLeg = createMockPool(
        mockToken0,
        mockToken1,
        '0xd400000000000000000000000000000000000000'
      );
      Object.defineProperty(noHookLeg, 'protocol', {
        get: () => Protocol.V2,
        configurable: true,
      });
      const aggHookLeg = createMockPool(
        mockToken0,
        mockToken1,
        '0xd410000000000000000000000000000000000000',
        aggHookAddr
      );
      Object.defineProperty(aggHookLeg, 'protocol', {
        get: () => Protocol.V3,
        configurable: true,
      });

      const mixedRoute = createMockRoute([noHookLeg, aggHookLeg], 100);
      const quoteMap = buildQuoteMap([
        createMockQuoteWithGasCost(mixedRoute, 1000n, 250n),
      ]);
      finder['emitAggHookWinnerGasPerProtocol'](
        [[mixedRoute]],
        quoteMap,
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1']
      );
      expect(distCalls()).toHaveLength(1);
      const tags = (distCalls()[0][2] as {tags: string[]}).tags;
      // The emitter resolves the protocol via the agg-hook address
      // registry (`getProtocolForAggHookAddress`), not via
      // `pool.protocol`. STABLE_SWAP_NG[0] on MAINNET → CurveStableSwapNG.
      // The `pool.protocol` override on the agg-hook leg (V3) is
      // intentionally IGNORED — the registry is the source of truth
      // for the agg-hook protocol family. And the no-hook leg's
      // `pool.protocol` (V2) is also ignored because the emitter
      // first selects the agg-hook leg via `isAggHookPool`.
      expect(tags).toContain(`protocol:${Protocol.CURVESTABLESWAPNG}`);
      expect(tags).not.toContain(`protocol:${Protocol.V2}`);
      expect(tags).not.toContain(`protocol:${Protocol.V3}`);
      expect(tags).not.toContain('protocol:v4');
    });
  });

  describe('agg-hook winner by address', () => {
    // FluidDexT1 hook addresses observed in prod attribution. These
    // are real registered addresses from the allowlist registry;
    // the test relies on the registry returning a non-undefined
    // protocol for them.
    const FLUID_DEX_T1_DOMINANT = '0xf143f8c995846bda830d1e3ba98d631079ede888';
    const FLUID_DEX_T1_SECONDARY = '0xf1e16488795901174365eb84103f20bd28096888';
    const STABLE_SWAP_NG_ADDR = STABLE_SWAP_NG[0]!;

    const aggHookRouteAt = (poolAddr: string, hookAddr: string, pct: number) =>
      createMockRoute(
        [createMockPool(mockToken0, mockToken1, poolAddr, hookAddr)],
        pct
      );
    const noHookRouteAt = (addr: string, pct: number) =>
      createMockRoute([createMockPool(mockToken0, mockToken1, addr)], pct);

    const countCalls = () =>
      (mockContext.metrics.count as ReturnType<typeof vi.fn>).mock.calls.filter(
        c =>
          (c[0] as string).endsWith(
            'QuoteBestSplitFinder.AggHookWinnerByAddress'
          )
      );

    it('does not fire when testAggHooks is false', () => {
      const aggHook = aggHookRouteAt(
        '0xe000000000000000000000000000000000000000',
        FLUID_DEX_T1_DOMINANT,
        100
      );
      finder['emitAggHookWinnerByAddress'](
        [[aggHook]],
        ChainId.MAINNET,
        mockContext,
        false,
        TradeType.ExactIn,
        ['chainId:1']
      );
      expect(countCalls()).toHaveLength(0);
    });

    it('does not fire when result is empty', () => {
      finder['emitAggHookWinnerByAddress'](
        [],
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1']
      );
      expect(countCalls()).toHaveLength(0);
    });

    it('does not fire when the winner has no agg-hook legs', () => {
      const noHook = noHookRouteAt(
        '0xe100000000000000000000000000000000000000',
        100
      );
      finder['emitAggHookWinnerByAddress'](
        [[noHook]],
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1']
      );
      expect(countCalls()).toHaveLength(0);
    });

    it('emits one count per (hookAddress, protocol) with the address as a tag', () => {
      const aggHook = aggHookRouteAt(
        '0xe200000000000000000000000000000000000000',
        FLUID_DEX_T1_DOMINANT,
        100
      );
      finder['emitAggHookWinnerByAddress'](
        [[aggHook]],
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1']
      );
      const calls = countCalls();
      expect(calls).toHaveLength(1);
      const tags = (calls[0][2] as {tags: string[]}).tags;
      expect(tags).toContain(`hookAddress:${FLUID_DEX_T1_DOMINANT}`);
      expect(tags).toContain('protocol:FluidDexT1');
      expect(tags).toContain(`tradeType:${TradeType.ExactIn}`);
      expect(tags).toContain('testAggHooks:true');
      expect(calls[0][1]).toBe(1);
    });

    it('lowercases mixed-case hook addresses for tag stability', () => {
      const mixedCase = '0xF143F8C995846bda830d1e3ba98d631079ede888';
      const aggHook = aggHookRouteAt(
        '0xe300000000000000000000000000000000000000',
        mixedCase,
        100
      );
      finder['emitAggHookWinnerByAddress'](
        [[aggHook]],
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1']
      );
      const tags = (countCalls()[0][2] as {tags: string[]}).tags;
      expect(tags).toContain(`hookAddress:${mixedCase.toLowerCase()}`);
    });

    it('emits distinct counts for two different hook addresses on the same winner', () => {
      // Two-leg winner: first leg uses FLUID_DEX_T1_DOMINANT, second
      // leg uses FLUID_DEX_T1_SECONDARY. Both are FluidDexT1 protocol
      // but distinct addresses — each should produce its own emit.
      const route = createMockRoute(
        [
          createMockPool(
            mockToken0,
            mockToken1,
            '0xe400000000000000000000000000000000000000',
            FLUID_DEX_T1_DOMINANT
          ),
          createMockPool(
            mockToken1,
            mockToken0,
            '0xe401000000000000000000000000000000000000',
            FLUID_DEX_T1_SECONDARY
          ),
        ],
        100
      );
      finder['emitAggHookWinnerByAddress'](
        [[route]],
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1']
      );
      const calls = countCalls();
      expect(calls).toHaveLength(2);
      const allTags = calls.map(c => (c[2] as {tags: string[]}).tags);
      const addresses = allTags.map(t =>
        t.find(s => s.startsWith('hookAddress:'))
      );
      expect(addresses).toContain(`hookAddress:${FLUID_DEX_T1_DOMINANT}`);
      expect(addresses).toContain(`hookAddress:${FLUID_DEX_T1_SECONDARY}`);
    });

    it('dedupes (hookAddress, protocol) within a single winner', () => {
      // Two legs both using the SAME hook address — should fire once.
      const route = createMockRoute(
        [
          createMockPool(
            mockToken0,
            mockToken1,
            '0xe500000000000000000000000000000000000000',
            FLUID_DEX_T1_DOMINANT
          ),
          createMockPool(
            mockToken1,
            mockToken0,
            '0xe501000000000000000000000000000000000000',
            FLUID_DEX_T1_DOMINANT
          ),
        ],
        100
      );
      finder['emitAggHookWinnerByAddress'](
        [[route]],
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1']
      );
      expect(countCalls()).toHaveLength(1);
    });

    it('skips pools whose hook address is not in the registry (cardinality guard)', () => {
      const unregisteredHook = '0x0000000000000000000000000000000000000099';
      const aggHook = aggHookRouteAt(
        '0xe600000000000000000000000000000000000000',
        unregisteredHook,
        100
      );
      finder['emitAggHookWinnerByAddress'](
        [[aggHook]],
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1']
      );
      // routeUsesAggHook depends on the registry too — when the
      // address isn't registered, the route is not "agg-hook" and
      // the emitter returns before counting.
      expect(countCalls()).toHaveLength(0);
    });

    it('only emits for the winning combination (result[0]), not subsequent combinations', () => {
      const winnerAggHook = aggHookRouteAt(
        '0xe700000000000000000000000000000000000000',
        FLUID_DEX_T1_DOMINANT,
        100
      );
      const runnerUpAggHook = aggHookRouteAt(
        '0xe701000000000000000000000000000000000000',
        FLUID_DEX_T1_SECONDARY,
        100
      );
      finder['emitAggHookWinnerByAddress'](
        [[winnerAggHook], [runnerUpAggHook]],
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1']
      );
      const calls = countCalls();
      expect(calls).toHaveLength(1);
      const tags = (calls[0][2] as {tags: string[]}).tags;
      expect(tags).toContain(`hookAddress:${FLUID_DEX_T1_DOMINANT}`);
      expect(tags).not.toContain(`hookAddress:${FLUID_DEX_T1_SECONDARY}`);
    });

    it('includes baseline metric tags', () => {
      const aggHook = aggHookRouteAt(
        '0xe800000000000000000000000000000000000000',
        STABLE_SWAP_NG_ADDR,
        100
      );
      finder['emitAggHookWinnerByAddress'](
        [[aggHook]],
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactOut,
        ['chainId:1', 'env:test']
      );
      const tags = (countCalls()[0][2] as {tags: string[]}).tags;
      expect(tags).toContain('chainId:1');
      expect(tags).toContain('env:test');
      expect(tags).toContain(`tradeType:${TradeType.ExactOut}`);
    });
  });

  // Codex finding (medium): the bias metric searches only the final
  // `result`. When `fullRoutes.length >= maxSplitRoutes` the filter
  // returns ONLY 100% routes, so the metric reads no split and emits
  // `verdict:no_split` — undercounting the very mechanism it's meant
  // to size. The fix: pass the pre-truncation candidate set to the
  // emitter so it can compare the best dropped split against the
  // 100% route.
  describe('filterAndSortFullRouteBias on pre-truncation candidates', () => {
    const aggHookAddr = STABLE_SWAP_NG[0]!;
    const noHookRouteAt = (addr: string, pct: number) =>
      createMockRoute([createMockPool(mockToken0, mockToken1, addr)], pct);
    const aggHookRouteAt = (addr: string, pct: number) =>
      createMockRoute(
        [createMockPool(mockToken0, mockToken1, addr, aggHookAddr)],
        pct
      );

    const createMockQuoteWithGasCost = (
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
          gasUse: 1n,
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

    const metricCalls = () =>
      (mockContext.metrics.count as ReturnType<typeof vi.fn>).mock.calls.filter(
        c =>
          (c[0] as string).endsWith(
            'QuoteBestSplitFinder.FilterAndSortFullRouteBias'
          )
      );

    // Codex stop-time finding: the pre-truncation array is in DFS
    // insertion order, NOT sorted by gas-adj score. Using
    // `.find(isFullRoute)` would pick the first inserted 100% route
    // (not the best by score), and similarly for splits. This test
    // pins down that the emitter must pick the BEST of each group.
    it('picks the best 100% and best split by gas-adj score, not insertion order', () => {
      // 3 100% routes inserted in DFS order; the LAST inserted has
      // the best gas-adj score. 2 splits inserted; the LAST has the
      // best gas-adj score. If the emitter used `.find(...)` it
      // would pick the first inserted (worst-by-score) of each
      // group, and the verdict would be wrong.
      //
      // ExactIn scores (higher = better):
      //   full[0]: amount=1000, gas=200 → 800
      //   full[1]: amount=1000, gas=100 → 900
      //   full[2]: amount=1000, gas=10  → 990  (best 100%)
      //   split[0]: 500+500=1000, 200+200=400 → 600 (worst split)
      //   split[1]: 500+500=1000, 5+5=10      → 990 (best split)
      // best100% (990) === bestSplit (990) → verdict:tie
      // If the emitter mistakenly used find-first:
      //   full[0]=800 vs split[0]=600 → pct100_beats_split (WRONG)
      const fullWorst = noHookRouteAt(
        '0xef00000000000000000000000000000000000000',
        100
      );
      const fullMid = noHookRouteAt(
        '0xef10000000000000000000000000000000000000',
        100
      );
      const fullBest = aggHookRouteAt(
        '0xef20000000000000000000000000000000000000',
        100
      );
      const splitWorstA = noHookRouteAt(
        '0xef30000000000000000000000000000000000000',
        50
      );
      const splitWorstB = noHookRouteAt(
        '0xef31000000000000000000000000000000000000',
        50
      );
      const splitBestA = noHookRouteAt(
        '0xef40000000000000000000000000000000000000',
        50
      );
      const splitBestB = noHookRouteAt(
        '0xef41000000000000000000000000000000000000',
        50
      );
      const quoteMapBestOf = buildQuoteMap([
        createMockQuoteWithGasCost(fullWorst, 1000n, 200n),
        createMockQuoteWithGasCost(fullMid, 1000n, 100n),
        createMockQuoteWithGasCost(fullBest, 1000n, 10n),
        createMockQuoteWithGasCost(splitWorstA, 500n, 200n),
        createMockQuoteWithGasCost(splitWorstB, 500n, 200n),
        createMockQuoteWithGasCost(splitBestA, 500n, 5n),
        createMockQuoteWithGasCost(splitBestB, 500n, 5n),
      ]);
      const preFilterResultBestOf: RouteBasic<MockPool>[][] = [
        [fullWorst],
        [fullMid],
        [fullBest],
        [splitWorstA, splitWorstB],
        [splitBestA, splitBestB],
      ];
      finder['emitFilterAndSortFullRouteBias'](
        preFilterResultBestOf,
        quoteMapBestOf,
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1']
      );
      expect(metricCalls()).toHaveLength(1);
      const tags = (metricCalls()[0][2] as {tags: string[]}).tags;
      // best 100% (fullBest, score 990) vs best split (splitBest*, score
      // 990) → tie. If the find-first bug returned (no longer the
      // current behavior) the tag would say `pct100_beats_split`.
      expect(tags).toContain('verdict:tie');
      // Top 100% by score is fullBest, which is an agg-hook route.
      expect(tags).toContain('topPct100HasAggHook:true');
    });

    it('detects split_beats_pct100 when the post-filter result has only 100% routes but the pre-filter set has a better split', () => {
      // Simulates the severe-bias case: `filterAndSortResults` dropped
      // every split route because there were enough 100% routes. The
      // emitter must be invoked on the PRE-FILTER candidate set so it
      // can still see the dropped split.
      const fullA = aggHookRouteAt(
        '0xe000000000000000000000000000000000000000',
        100
      );
      const fullB = aggHookRouteAt(
        '0xe100000000000000000000000000000000000000',
        100
      );
      const droppedSplitA = noHookRouteAt(
        '0xe200000000000000000000000000000000000000',
        50
      );
      const droppedSplitB = noHookRouteAt(
        '0xe210000000000000000000000000000000000000',
        50
      );
      // Scores (ExactIn, higher = better):
      //   fullA:        1000 amount, 200 gas → 800
      //   fullB:         900 amount, 200 gas → 700
      //   droppedSplit: 500+500=1000 amount, 5+5=10 gas → 990 (best)
      const quoteMap = buildQuoteMap([
        createMockQuoteWithGasCost(fullA, 1000n, 200n),
        createMockQuoteWithGasCost(fullB, 900n, 200n),
        createMockQuoteWithGasCost(droppedSplitA, 500n, 5n),
        createMockQuoteWithGasCost(droppedSplitB, 500n, 5n),
      ]);
      const preFilterResult: RouteBasic<MockPool>[][] = [
        [fullA],
        [fullB],
        [droppedSplitA, droppedSplitB],
      ];
      finder['emitFilterAndSortFullRouteBias'](
        preFilterResult,
        quoteMap,
        ChainId.MAINNET,
        mockContext,
        true,
        TradeType.ExactIn,
        ['chainId:1']
      );
      expect(metricCalls()).toHaveLength(1);
      const tags = (metricCalls()[0][2] as {tags: string[]}).tags;
      expect(tags).toContain('verdict:split_beats_pct100');
      expect(tags).toContain('topPct100HasAggHook:true');
    });
  });

  // Codex finding (medium): "K-budget eviction counts are inflated by
  // recursive duplicate visits". The wrapper inside `findBestSplits`
  // calls `getBestUnusedQuotesStats` from every recursive DFS branch,
  // so the same `(percentage, route)` displacement is reported
  // multiple times. The fix: dedupe by composite key inside the
  // wrapper accumulation step. These tests exercise the inner
  // `getBestUnusedQuotesStats` directly to verify per-request
  // displacement and bucket-shape semantics are stable across
  // repeated invocations with the same percentage.
  describe('K-budget per-request dedupe', () => {
    const aggHookAddr = STABLE_SWAP_NG[0]!;
    const noHookRouteAt = (addr: string, pct: number) =>
      createMockRoute([createMockPool(mockToken0, mockToken1, addr)], pct);
    const aggHookRouteAt = (addr: string, pct: number) =>
      createMockRoute(
        [createMockPool(mockToken0, mockToken1, addr, aggHookAddr)],
        pct
      );

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

    it("reports the same displacement on every invocation (deduplication is the wrapper's responsibility)", () => {
      // `getBestUnusedQuotesStats` is the pure function — it returns
      // the same displacement state each time. The wrapper inside
      // `findBestSplits` is what dedupes by (percentage, route key).
      // This test pins down the contract so a future refactor can't
      // silently start deduping inside the pure function (which would
      // hide repeated visits from invocation-weighted callers).
      const noHookA = noHookRouteAt(
        '0xea00000000000000000000000000000000000000',
        50
      );
      const noHookB = noHookRouteAt(
        '0xeb00000000000000000000000000000000000000',
        50
      );
      const aggHook = aggHookRouteAt(
        '0xec00000000000000000000000000000000000000',
        50
      );
      const buckets = new Map<number, QuoteBasic[]>([
        [
          50,
          [
            createMockQuoteWithGasUse(noHookA, 1000n, 100n),
            createMockQuoteWithGasUse(noHookB, 1000n, 100n),
            // raw-tied so raw gate vacuously passes; gas-equal so
            // gas gate passes — partition admits → noHookB displaced.
            createMockQuoteWithGasUse(aggHook, 1000n, 100n),
          ],
        ],
      ]);

      // First invocation.
      const stats1 = finder['getBestUnusedQuotesStats'](
        50,
        buckets,
        [],
        ChainId.MAINNET,
        TradeType.ExactIn
      );
      // Second invocation with no change to inputs — same percentage,
      // empty usedRoutes. Pure function reports the same state.
      const stats2 = finder['getBestUnusedQuotesStats'](
        50,
        buckets,
        [],
        ChainId.MAINNET,
        TradeType.ExactIn
      );

      expect(stats1.partitionAdmittedAggHook).toBe(true);
      expect(stats1.displacedNoHookQuotes).toHaveLength(1);
      expect(stats1.displacedNoHookQuotes[0].route).toBe(noHookB);

      expect(stats2.partitionAdmittedAggHook).toBe(true);
      expect(stats2.displacedNoHookQuotes).toHaveLength(1);
      expect(stats2.displacedNoHookQuotes[0].route).toBe(noHookB);
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
