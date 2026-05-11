import {QuoteBasic} from '../../models/quote/QuoteBasic';
import {RouteBasic} from '../../models/route/RouteBasic';
import {Pool} from '../../models/pool/Pool';
import {Context as UniContext} from '@uniswap/lib-uni/context';
import {ADDRESS_ZERO} from '@uniswap/v3-sdk';
import {WRAPPED_NATIVE_CURRENCY} from '../../lib/tokenUtils';
import {ChainId} from '../../lib/config';
import {buildMetricKey} from '../../lib/config';
import {IQuoteBestSplitFinder} from './IQuoteBestSplitFinder';
import {TradeType} from '../../models/quote/TradeType';
import {routeUsesAggHook} from '../../lib/observability';

export class QuoteBestSplitFinder<TPool extends Pool>
  implements IQuoteBestSplitFinder<TPool>
{
  /**
   * Maximum number of quotes to return *per route class* per percentage,
   * after filtering for validity, while constructing splits. Routes are
   * partitioned into no-hook vs agg-hook (V4 hooked) classes and the top
   * K from each are returned. When both classes are populated this yields
   * up to 2K candidates per percentage; when only one class has valid
   * quotes (e.g. legacy `protocols=v2,v3,v4,mixed` requests), it
   * degenerates to top-K total and the branching factor matches the
   * pre-partition behavior.
   *
   * The partition exists because agg-hook routes were displacing
   * high-yielding no-hook routes from the top-K slot in some sub-trees,
   * producing strictly worse quotes when external protocols were enabled.
   */
  private readonly MAX_VALID_QUOTES_PER_CLASS = 2;
  // Improvement threshold percentage to continue searching to next level (0.01%)
  private readonly MIN_IMPROVEMENT_PCT_PER_LEVEL = 0.01;
  // Minimum number of split levels to try before exiting early
  private readonly MIN_SPLIT_LEVELS_BEFORE_EARLY_EXIT = 3;

  private routeHasGivenAddressAsInputOrOutput(
    route: RouteBasic<TPool>,
    address: string
  ): boolean {
    if (route.path.length === 0) return false;
    if (route.path.length === 1) {
      return (
        route.path[0].token0.address.toLowerCase() === address.toLowerCase() ||
        route.path[0].token1.address.toLowerCase() === address.toLowerCase()
      );
    }
    // We have more than one pool in the route. Determine the tokenInAddress
    let tokenInAddress = route.path[0].token0.address.toLowerCase();
    let otherTokenAddress = route.path[0].token1.address.toLowerCase();
    // Check if the next pool has the tokenInAddress as token0 or token1, if it does, then the tokenInAddress is the other token
    if (
      route.path[1].token0.address.toLowerCase() ===
        tokenInAddress.toLowerCase() ||
      route.path[1].token1.address.toLowerCase() ===
        tokenInAddress.toLowerCase()
    ) {
      tokenInAddress = route.path[0].token1.address.toLowerCase();
      otherTokenAddress = route.path[0].token0.address.toLowerCase();
    }
    // Now that we have the tokenInAddress, keep going through the route to find the tokenOutAddress.
    // The tokenOutAddress is the other token in the last pool.
    for (let i = 1; i < route.path.length; i++) {
      if (
        route.path[i].token0.address.toLowerCase() ===
        otherTokenAddress.toLowerCase()
      ) {
        otherTokenAddress = route.path[i].token1.address.toLowerCase();
      } else {
        otherTokenAddress = route.path[i].token0.address.toLowerCase();
      }
    }
    const tokenOutAddress = otherTokenAddress;

    return (
      tokenOutAddress.toLowerCase() === address.toLowerCase() ||
      tokenInAddress.toLowerCase() === address.toLowerCase()
    );
  }

  private routeHasNativeTokenInputOrOutput(route: RouteBasic<TPool>): boolean {
    return this.routeHasGivenAddressAsInputOrOutput(
      route,
      ADDRESS_ZERO.toLowerCase()
    );
  }
  private routeHasWrappedNativeTokenInputOrOutput(
    route: RouteBasic<TPool>,
    chainId: ChainId
  ): boolean {
    return this.routeHasGivenAddressAsInputOrOutput(
      route,
      WRAPPED_NATIVE_CURRENCY[chainId].address.toLowerCase()
    );
  }

  // Helper to check if a route shares any pools with routes in the current combination
  private sharesPoolsWith(
    route: RouteBasic<TPool>,
    currentRoutes: RouteBasic<TPool>[]
  ): boolean {
    const routePoolAddresses = new Set(
      route.path.map(p => p.address.toString())
    );

    for (const existingRoute of currentRoutes) {
      for (const pool of existingRoute.path) {
        if (routePoolAddresses.has(pool.address.toString())) {
          return true;
        }
      }
    }
    return false;
  }

  // Helper to check for native/wrapped token conflicts
  private hasEthWethTokenConflict(
    route: RouteBasic<TPool>,
    currentRoutes: RouteBasic<TPool>[],
    chainId: ChainId
  ): boolean {
    const hasNativeInUsedRoutes = currentRoutes.some(r =>
      this.routeHasNativeTokenInputOrOutput(r)
    );
    const hasWrappedNativeInUsedRoutes = currentRoutes.some(r =>
      this.routeHasWrappedNativeTokenInputOrOutput(r, chainId)
    );

    return (
      (hasNativeInUsedRoutes &&
        this.routeHasWrappedNativeTokenInputOrOutput(route, chainId)) ||
      (hasWrappedNativeInUsedRoutes &&
        this.routeHasNativeTokenInputOrOutput(route))
    );
  }

  /**
   * Returns the top valid quotes for a given percentage that don't conflict
   * with routes already in the current combination.
   *
   * Quotes are partitioned into two classes (no-hook vs agg-hook V4 pools)
   * and the top `MAX_VALID_QUOTES_PER_CLASS` of each are returned. See the
   * docstring on the constant for rationale.
   */
  private getBestUnusedQuotesStats(
    percentage: number,
    percentageToSortedQuotes: Map<number, QuoteBasic[]>,
    usedRoutes: RouteBasic<TPool>[],
    chainId: ChainId
  ): {
    quotes: QuoteBasic[];
    totalCount: number;
    validCount: number;
    returnedCount: number;
  } {
    const quotes = percentageToSortedQuotes.get(percentage) || [];
    // First filter valid quotes
    const validQuotes = quotes.filter(quote => {
      const route = quote.route as RouteBasic<TPool>;
      return (
        !this.sharesPoolsWith(route, usedRoutes) &&
        !this.hasEthWethTokenConflict(route, usedRoutes, chainId)
      );
    });

    // Partition by class. `validQuotes` preserves the input order (which is
    // sorted by amount upstream), so each class is already amount-sorted.
    const noHookQuotes: QuoteBasic[] = [];
    const aggHookQuotes: QuoteBasic[] = [];
    for (const quote of validQuotes) {
      const route = quote.route as RouteBasic<TPool>;
      if (routeUsesAggHook(route, chainId)) {
        aggHookQuotes.push(quote);
      } else {
        noHookQuotes.push(quote);
      }
    }

    // Each class gets up to K slots independently. With both classes
    // populated this yields up to 2K candidates per percentage step.
    const returnedQuotes = [
      ...noHookQuotes.slice(0, this.MAX_VALID_QUOTES_PER_CLASS),
      ...aggHookQuotes.slice(0, this.MAX_VALID_QUOTES_PER_CLASS),
    ];
    return {
      quotes: returnedQuotes,
      totalCount: quotes.length,
      validCount: validQuotes.length,
      returnedCount: returnedQuotes.length,
    };
  }

  /**
   * Scores and sorts route combinations based on total quote amounts
   * @param combinations Array of route combinations to score and sort
   * @param quoteMap Pre-computed map of routes to quotes for O(1) lookup
   * @param tradeType The trade type to determine sorting direction
   * @returns Sorted array of route combinations (descending for ExactIn, ascending for ExactOut)
   */
  private scoreAndSortCombinations(
    combinations: RouteBasic<TPool>[][],
    quoteMap: Map<RouteBasic<TPool>, QuoteBasic>,
    tradeType: TradeType
  ): RouteBasic<TPool>[][] {
    const scoredCombinations = combinations.map(combination => {
      const totalAmount = combination.reduce(
        (sum, route) => sum + (quoteMap.get(route)?.amount || 0n),
        0n
      );

      return {
        combination,
        score: totalAmount,
      };
    });

    // Sort by score - descending for EXACT_IN, ascending for EXACT_OUT
    scoredCombinations.sort((a, b) => {
      const comparison = b.score > a.score ? 1 : b.score < a.score ? -1 : 0;
      return tradeType === TradeType.ExactOut ? -comparison : comparison;
    });

    return scoredCombinations.map(item => item.combination);
  }

  /**
   * Filters and sorts results to keep only the best ones based on maxSplitRoutes limit
   * Prioritizes 100% routes over split routes and applies trade-type-specific sorting
   * @param results Array of route combinations to filter and sort
   * @param maxSplitRoutes Maximum number of split routes to return
   * @param quoteMap Pre-computed map of routes to quotes for O(1) lookup
   * @param tradeType The trade type to determine sorting direction
   * @returns Filtered and sorted array of route combinations
   */
  private filterAndSortResults(
    results: RouteBasic<TPool>[][],
    maxSplitRoutes: number,
    quoteMap: Map<RouteBasic<TPool>, QuoteBasic>,
    tradeType: TradeType
  ): RouteBasic<TPool>[][] {
    // If maxSplitRoutes is 0, return empty array
    if (maxSplitRoutes <= 0) {
      return [];
    }

    if (results.length <= maxSplitRoutes) {
      // Still need to sort even when we don't need to filter
      return this.scoreAndSortCombinations(results, quoteMap, tradeType);
    }

    // Keep all 100% routes
    const fullRoutes = results.filter(
      combination =>
        combination.length === 1 && combination[0].percentage === 100
    );

    // For split routes, score them based on the quote amounts
    const splitRoutes = results.filter(
      combination =>
        !(combination.length === 1 && combination[0].percentage === 100)
    );

    const sortedSplitRoutes = this.scoreAndSortCombinations(
      splitRoutes,
      quoteMap,
      tradeType
    );

    // If we have more 100% routes than maxSplitRoutes, only keep the first maxSplitRoutes
    if (fullRoutes.length >= maxSplitRoutes) {
      return fullRoutes.slice(0, maxSplitRoutes);
    }

    // Combine full routes with top scoring split routes
    const remainingSlots = maxSplitRoutes - fullRoutes.length;
    const topSplitRoutes = sortedSplitRoutes.slice(
      0,
      Math.max(0, remainingSlots)
    );

    return [...fullRoutes, ...topSplitRoutes];
  }

  public async findBestSplits(
    chainId: ChainId,
    percentageToSortedQuotes: Map<number, QuoteBasic[]>,
    percentageStep: number,
    maxSplits: number,
    maxSplitRoutes: number,
    timeoutMs: number,
    tradeType: TradeType,
    metricTags: string[],
    ctx: UniContext,
    testAggHooks?: boolean
  ): Promise<RouteBasic<TPool>[][]> {
    if (percentageStep < 5 || percentageStep > 100) {
      throw new Error('Percentage step must be between 5 and 100');
    }
    if (100 % percentageStep !== 0) {
      throw new Error('Percentage step must divide 100 exactly');
    }

    const combinations = new Set<string>();
    let result: RouteBasic<TPool>[][] = [];
    let currentLevelBestAmount = 0n;
    let previousLevelBestAmount = 0n;
    const startTime = Date.now();
    let timedOut = false;
    let earlyExitReason:
      | 'timeout'
      | 'no_new_routes'
      | 'low_improvement'
      | null = null;
    const bestUnusedQuoteStats = {
      calls: 0,
      totalQuotes: 0,
      validQuotes: 0,
      returnedQuotes: 0,
      droppedByConflict: 0,
      droppedByLimit: 0,
    };

    // Pre-compute quote lookup map for O(1) access throughout the function
    const quoteMap = new Map<RouteBasic<TPool>, QuoteBasic>();
    for (const quotes of percentageToSortedQuotes.values()) {
      for (const quote of quotes) {
        quoteMap.set(quote.route as RouteBasic<TPool>, quote);
      }
    }

    // Helper to convert a combination to a unique string key
    const getCombinationKey = (combination: RouteBasic<TPool>[]) => {
      return combination
        .map(
          route =>
            `${route.path.map(p => p.address.toString()).join(',')}-${route.percentage}`
        )
        .sort()
        .join('|');
    };

    // Helper to add a combination if it's unique and track best amount
    const addCombination = (routes: RouteBasic<TPool>[]) => {
      const key = getCombinationKey(routes);
      if (!combinations.has(key)) {
        combinations.add(key);
        result.push([...routes]);

        // Calculate total amount for this combination using pre-computed map
        const quotes = routes.map(route => quoteMap.get(route));
        const totalAmount = quotes.reduce(
          (sum, q) => (q ? sum + q.amount : sum),
          0n
        );

        // Update best amount if this combination is better
        if (totalAmount > currentLevelBestAmount) {
          currentLevelBestAmount = totalAmount;
        }
      }
    };
    const getBestUnusedQuotes = (
      percentage: number,
      currentRoutes: RouteBasic<TPool>[]
    ): QuoteBasic[] => {
      const stats = this.getBestUnusedQuotesStats(
        percentage,
        percentageToSortedQuotes,
        currentRoutes,
        chainId
      );
      bestUnusedQuoteStats.calls++;
      bestUnusedQuoteStats.totalQuotes += stats.totalCount;
      bestUnusedQuoteStats.validQuotes += stats.validCount;
      bestUnusedQuoteStats.returnedQuotes += stats.returnedCount;
      bestUnusedQuoteStats.droppedByConflict +=
        stats.totalCount - stats.validCount;
      bestUnusedQuoteStats.droppedByLimit +=
        stats.validCount - stats.returnedCount;
      return stats.quotes;
    };

    // First, add all 100% routes from the best quotes
    const fullQuotes = percentageToSortedQuotes.get(100) || [];
    // Try all 100% routes since they're the most efficient
    for (let i = 0; i < fullQuotes.length; i++) {
      addCombination([fullQuotes[i].route as RouteBasic<TPool>]);
    }

    // If we only want single routes, return early
    if (maxSplits === 1) {
      return result;
    }

    // Set previous level best amount after processing level 1
    previousLevelBestAmount = currentLevelBestAmount;

    ctx.logger.debug(
      `QuoteBestSplitFinder: after level 1 we got ${result.length} route combinations`
    );

    // Helper function to generate combinations level by level
    const generateCombinationsForLevel = async (
      splitLevel: number,
      remainingPercentage: number,
      currentRoutes: RouteBasic<TPool>[]
    ) => {
      // Check for timeout
      if (Date.now() - startTime > timeoutMs) {
        timedOut = true;
        earlyExitReason = 'timeout';
        return;
      }

      // If we've reached our target split level and used exactly 100%, add the combination
      if (splitLevel === 0 && remainingPercentage === 0) {
        addCombination(currentRoutes);
        return;
      }

      // If we can't complete this combination, return
      if (splitLevel === 0 || remainingPercentage === 0) {
        return;
      }

      // If this is the last split (splitLevel = 1), use the remaining percentage directly
      if (splitLevel === 1) {
        // Only proceed if remaining percentage is valid
        if (
          remainingPercentage >= percentageStep &&
          remainingPercentage <= 100 - percentageStep
        ) {
          const availableQuotes = getBestUnusedQuotes(
            remainingPercentage,
            currentRoutes
          );

          // Try each available quote
          for (const quote of availableQuotes) {
            const route = quote.route as RouteBasic<TPool>;
            currentRoutes.push(route);
            await generateCombinationsForLevel(0, 0, currentRoutes);
            currentRoutes.pop();

            if (timedOut) break;
          }
        }
        return;
      }

      // For non-final splits, iterate through possible percentages
      const maxPercent = Math.min(remainingPercentage, 100 - percentageStep);
      for (
        let percent = percentageStep;
        percent <= maxPercent && !timedOut;
        percent += percentageStep
      ) {
        // Check for timeout in the percentage loop
        if (Date.now() - startTime > timeoutMs) {
          timedOut = true;
          earlyExitReason = 'timeout';
          return;
        }

        // Get best available quotes for this percentage
        const availableQuotes = getBestUnusedQuotes(percent, currentRoutes);

        // Try each available quote
        for (const quote of availableQuotes) {
          // Check for timeout in the inner loop
          if (Date.now() - startTime > timeoutMs) {
            timedOut = true;
            earlyExitReason = 'timeout';
            return;
          }

          const route = quote.route as RouteBasic<TPool>;
          currentRoutes.push(route);
          await generateCombinationsForLevel(
            splitLevel - 1,
            remainingPercentage - percent,
            currentRoutes
          );
          currentRoutes.pop();

          if (timedOut) break;
        }
      }
    };

    // Generate combinations level by level, from 2 splits up to maxSplits
    for (let level = 2; level <= maxSplits && !timedOut; level++) {
      await ctx.metrics.count(
        buildMetricKey(`QuoteBestSplitFinder.Level.Invocations.${level}`),
        1,
        {
          tags: metricTags,
        }
      );

      const previousResultLength = result.length;
      // Reset current level best amount before processing new level
      currentLevelBestAmount = previousLevelBestAmount;
      // Snapshot the timeout flag to detect mid-level truncation. If
      // generateCombinationsForLevel sets `timedOut`, this level's results are
      // partial — we must not infer convergence from the partial improvement.
      const wasTimedOutBeforeLevel = timedOut;
      await generateCombinationsForLevel(level, 100, []);
      const wasTruncatedThisLevel = !wasTimedOutBeforeLevel && timedOut;

      const unfilteredResultLength = result.length;

      await ctx.metrics.count(
        buildMetricKey(`QuoteBestSplitFinder.Level.Results.${level}`),
        unfilteredResultLength - previousResultLength,
        {
          tags: metricTags,
        }
      );

      ctx.logger.debug(
        `QuoteBestSplitFinder: after level ${level} we got ${unfilteredResultLength} route combinations`
      );

      // Filter and sort results after each level to keep array size manageable
      result = this.filterAndSortResults(
        result,
        maxSplitRoutes,
        quoteMap,
        tradeType
      );

      // Exit early if no new routes were added (check before filtering)
      if (unfilteredResultLength === previousResultLength) {
        ctx.logger.debug(
          `QuoteBestSplitFinder: No new routes added at level ${level}, exiting early`
        );
        earlyExitReason = 'no_new_routes';
        break;
      }

      // Calculate improvement percentage
      if (previousLevelBestAmount > 0n) {
        const improvement =
          (Number(currentLevelBestAmount - previousLevelBestAmount) /
            Number(previousLevelBestAmount)) *
          100;

        ctx.logger.debug(
          `QuoteBestSplitFinder: Level ${level} improvement: ${improvement.toFixed(5)}%`
        );

        // Exit if improvement is less than 0.01%, but only if we've tried at
        // least 3 splits and this level finished generating combinations. A
        // level whose recursion was cut off by the split-finder timeout
        // produces a partial result whose 0% "improvement" is meaningless;
        // the loop's top-of-iteration `!timedOut` guard will end the search
        // anyway, so we just skip the spurious low-improvement exit here.
        if (
          level >= this.MIN_SPLIT_LEVELS_BEFORE_EARLY_EXIT &&
          improvement < this.MIN_IMPROVEMENT_PCT_PER_LEVEL &&
          !wasTruncatedThisLevel
        ) {
          ctx.logger.debug(
            `QuoteBestSplitFinder: Improvement less than 0.01% at level ${level}, exiting early`
          );
          earlyExitReason = 'low_improvement';
          break;
        }
      }

      previousLevelBestAmount = currentLevelBestAmount;
    }

    if (timedOut) {
      ctx.logger.warn(
        `QuoteBestSplitFinder: Timed out after ${timeoutMs}ms with ${result.length} combinations found`
      );
      await ctx.metrics.count(
        buildMetricKey('QuoteBestSplitFinder.TimedOut'),
        1,
        {
          tags: metricTags,
        }
      );
    } else {
      ctx.logger.debug(
        `QuoteBestSplitFinder: Pre-filter ${result.length} route combinations`
      );
    }

    ctx.logger.debug('QuoteBestSplitFinder observability', {
      chainId,
      percentageStep,
      maxSplits,
      maxSplitRoutes,
      timeoutMs,
      elapsedMs: Date.now() - startTime,
      timedOut,
      earlyExitReason,
      combinationsFound: result.length,
      bestUnusedQuoteStats,
    });
    const earlyExitTag = `earlyExitReason:${earlyExitReason ?? 'normal'}`;
    await Promise.all([
      ctx.metrics.count(
        buildMetricKey('QuoteBestSplitFinder.PrunedByConflict'),
        bestUnusedQuoteStats.droppedByConflict,
        {tags: metricTags}
      ),
      ctx.metrics.count(
        buildMetricKey('QuoteBestSplitFinder.PrunedByLimit'),
        bestUnusedQuoteStats.droppedByLimit,
        {tags: metricTags}
      ),
      ctx.metrics.count(buildMetricKey('QuoteBestSplitFinder.EarlyExit'), 1, {
        tags: [...metricTags, earlyExitTag, `testAggHooks:${testAggHooks}`],
      }),
    ]);

    return result;
  }
}
