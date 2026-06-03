import {BaseQuoteStrategy} from './BaseQuoteStrategy';
import {Protocol} from '../../models/pool/Protocol';
import {
  buildMetricKey,
  ChainId,
  IUniRouteServiceConfig,
  OPTIMISM_STACK_CHAINS,
} from '../../lib/config';
import {QuoteSplit} from '../../models/quote/QuoteSplit';
import {Context} from '@uniswap/lib-uni/context';
import {Chain} from '../../models/chain/Chain';
import {TradeType} from '../../models/quote/TradeType';
import {
  fetchAllInvolvedTokens,
  logElapsedTime,
  updateQuotesWithFreshPoolDetailsUsingPoolsMap,
} from '../../lib/helpers';
import {RouteBasic} from '../../models/route/RouteBasic';
import {Pool} from '../../models/pool/Pool';
import {QuoteBasic} from '../../models/quote/QuoteBasic';
import {Erc20Token} from '../../models/token/Erc20Token';
import {QuoteBestSplitFinder} from '../quote/QuoteBestSplitFinder';
import {IQuoteFetcher} from '../../stores/quote/IQuoteFetcher';
import {IGasEstimateProvider} from '../gas/estimator/GasEstimateProvider';
import {IGasConverter} from '../gas/converter/IGasConverter';
import {IRouteQuoteAllocator} from '../route/RouteQuoteAllocator';
import {IQuoteSelector} from '../quote/selector/IQuoteSelector';
import {CurrencyInfo} from '../../models/currency/CurrencyInfo';
import {
  ArbitrumGasData,
  ArbitrumGasDataProvider,
} from '../gas/gas-data-provider';
import {ITokenHandler} from '../../stores/token/ITokenHandler';
import {IFreshPoolDetailsWrapper} from '../../stores/pool/FreshPoolDetailsWrapper';
import {JsonRpcProvider} from '@ethersproject/providers';
import {partitionAggHookRoutes, fetchAggHookQuotes} from './AggHookQuoter';
import {isAggHookPool} from '../../lib/observability';

/**
 * DeepQuoteStrategy implements an optimized quote finding logic:
 *
 * 1. ROUTE PCT GENERATION
 * ------------------
 * Generate all possible partial routes per percentage step
 * but only for individual routes (no splits yet).
 *
 * 2. QUOTE FETCHING
 * ----------------
 * Fetch quotes for all individual routes/percentages
 * This gives us a baseline of how each route performs
 * at different percentage allocations
 *
 * 3. QUOTE ORGANIZATION
 * -------------------
 * Group and sort quotes by percentage
 * This lets us quickly access the best performing routes
 * for any given percentage allocation
 *
 * 4. BEST SPLIT FINDING
 * --------------------
 * Use QuoteBestSplitFinder to efficiently find the best
 * route combinations, prioritizing:
 * - Best performing routes
 * - Simpler splits before complex ones
 * - Limited search space per percentage
 * - Respect maximum execution time
 */
export class DeepQuoteStrategy extends BaseQuoteStrategy {
  private readonly quoteBestSplitFinder: QuoteBestSplitFinder<Pool>;
  private readonly rpcProviderMap: Map<ChainId, JsonRpcProvider>;

  constructor(
    quoteFetcher: IQuoteFetcher,
    gasEstimateProvider: IGasEstimateProvider,
    gasConverter: IGasConverter,
    routeQuoteAllocator: IRouteQuoteAllocator<Pool>,
    quoteSelector: IQuoteSelector,
    tokenHandler: ITokenHandler,
    arbitrumGasDataProviders: Map<ChainId, ArbitrumGasDataProvider>,
    freshPoolDetailsWrapper: IFreshPoolDetailsWrapper,
    rpcProviderMap?: Map<ChainId, JsonRpcProvider>
  ) {
    super(
      quoteFetcher,
      gasEstimateProvider,
      gasConverter,
      routeQuoteAllocator,
      quoteSelector,
      tokenHandler,
      arbitrumGasDataProviders,
      freshPoolDetailsWrapper
    );
    // Kill-switch for the lowest-gas anchor in the K-budget partition
    // gate. See `QuoteBestSplitFinder.AGG_HOOK_PARTITION_USE_LOWEST_GAS_ANCHOR`
    // for the rationale; default off until the canary deploy validates
    // the change against prod `PartitionAnchorAnalysis` telemetry.
    const useLowestGasAnchor =
      process.env.AGG_HOOK_PARTITION_USE_LOWEST_GAS_ANCHOR === 'true';
    // Reserved env-flag handle for the projected gas-adjusted gate
    // in the K-budget partition. CURRENTLY A NO-OP FOR ENFORCEMENT
    // — Codex adversarial-review round-5 finding #1 showed that
    // hard-pruning agg-hook on a local projection is unsafe given
    // the DFS conflict-propagation semantics. The wiring stays so a
    // future PR can flip this on once a conflict-aware enforcement
    // implementation lands. Telemetry
    // (`KBudgetAdmitProjectedLoss{verdict:admit_raw_only}`) is
    // computed independently under the `testAggHooks` canary gate.
    const useProjectedGasAdjGate =
      process.env.AGG_HOOK_PARTITION_USE_PROJECTED_GAS_ADJ_GATE === 'true';
    this.quoteBestSplitFinder = new QuoteBestSplitFinder<Pool>(
      0n,
      0n,
      0n,
      useLowestGasAnchor,
      useProjectedGasAdjGate,
      0n
    );
    this.rpcProviderMap = rpcProviderMap ?? new Map();
  }

  async findBestQuoteCandidates(
    ctx: Context,
    chain: Chain,
    tokenInCurrencyInfo: CurrencyInfo,
    tokenOutCurrencyInfo: CurrencyInfo,
    amount: bigint,
    tradeType: TradeType,
    protocols: Protocol[],
    serviceConfig: IUniRouteServiceConfig,
    routes: RouteBasic<Pool>[],
    tokensInfo: Map<string, Erc20Token | null>,
    metricTags: string[],
    blockNumber?: number,
    testAggHooks?: boolean
  ): Promise<QuoteSplit[]> {
    // Generate all possible partial routes per percentage step
    const pctRoutes: RouteBasic[] = [];
    for (const route of routes) {
      for (
        let pct = 100;
        pct >= serviceConfig.RouteFinder.RouteSplitPercentage;
        pct -= serviceConfig.RouteFinder.RouteSplitPercentage
      ) {
        pctRoutes.push(new RouteBasic(route.protocol, route.path, pct));
      }
    }

    // Partition: single-hop aggregator hook routes are quoted via hook.quote()
    // directly, bypassing the V4Quoter which fails for these pools.
    const {aggHookRoutes, otherRoutes} = partitionAggHookRoutes(pctRoutes);

    const fetchQuotesStartTime = Date.now();
    ctx.logger.debug('Starting fetchQuotes', {
      totalPctRoutes: pctRoutes.length,
      aggHookRoutes: aggHookRoutes.length,
      otherRoutes: otherRoutes.length,
    });

    // Fetch quotes in parallel: hook.quote() for agg hooks, standard quoter for the rest
    const [aggHookQuotes, standardQuotes] = await Promise.all([
      aggHookRoutes.length > 0
        ? fetchAggHookQuotes(
            chain,
            aggHookRoutes,
            amount,
            tradeType,
            tokenInCurrencyInfo,
            this.rpcProviderMap,
            ctx,
            metricTags
          )
        : Promise.resolve([] as QuoteBasic[]),
      otherRoutes.length > 0
        ? this.quoteFetcher.fetchQuotes(
            chain,
            tokenInCurrencyInfo,
            tokenOutCurrencyInfo,
            amount,
            otherRoutes,
            tradeType,
            ctx,
            metricTags,
            blockNumber,
            tokensInfo
          )
        : Promise.resolve([] as QuoteBasic[]),
    ]);

    const quotes = [...aggHookQuotes, ...standardQuotes];
    await logElapsedTime('FetchQuotes', fetchQuotesStartTime, ctx, metricTags);

    // Update quotes with gas estimation details
    const gasEstimateStartTime = Date.now();
    ctx.logger.debug('Starting gasEstimate');
    const gasPriceWei = serviceConfig.GasEstimation.Enabled
      ? await this.gasEstimateProvider.getCurrentGasPrice(
          chain.chainId,
          blockNumber
        )
      : 0;

    // Below information is only needed when dealing with Arbitrum Orbit or
    // Optimism Stack chains in order to calculate L2 gas costs accurately. We
    // need to update the quotes with fresh pool details so that we can
    // generate the correct calldata for L2 gas estimation.
    const orbitGasDataProvider = this.arbitrumGasDataProviders.get(
      chain.chainId
    );
    let arbitrumGasData: ArbitrumGasData | undefined = undefined;
    if (
      orbitGasDataProvider &&
      serviceConfig.L1L2GasCostFetcher.ArbitrumEnabled
    ) {
      arbitrumGasData = await orbitGasDataProvider.getGasData();
    }
    if (
      (orbitGasDataProvider &&
        serviceConfig.L1L2GasCostFetcher.ArbitrumEnabled &&
        !serviceConfig.L1L2GasCostFetcher
          .SkipArbitrumCallDataGenerationAndApproximate) ||
      (OPTIMISM_STACK_CHAINS.includes(chain.chainId) &&
        serviceConfig.L1L2GasCostFetcher.OpStackEnabled)
    ) {
      tokensInfo = await this.updateQuotesWithFreshPoolDetails(
        quotes,
        tokensInfo,
        chain,
        ctx,
        metricTags,
        blockNumber
      );
    }

    const quotesWithGas = await Promise.all(
      quotes.map(async quote => {
        const gasDetails = await this.gasEstimateProvider.estimateGas(
          serviceConfig,
          tokenInCurrencyInfo,
          tokenOutCurrencyInfo,
          amount,
          chain.chainId,
          tokensInfo,
          tradeType,
          quote,
          ctx,
          gasPriceWei,
          arbitrumGasData
        );
        return new QuoteBasic(
          quote.route,
          quote.amount,
          quote.v3QuoterResponseDetails,
          gasDetails
        );
      })
    );
    await logElapsedTime('GasEstimate', gasEstimateStartTime, ctx, metricTags);

    // Populate gasCostInQuoteToken on each quote BEFORE the split-finder
    // ranks combinations. `QuoteBestSplitFinder.scoreAndSortCombinations`
    // ranks combinations by gas-adjusted total amount when this is
    // populated, and falls back to raw amount when it isn't. Prior to
    // this call ordering, the gas conversion happened only post-split in
    // `UniRouteBL`, leaving `findBestSplits` ranking by raw amount alone
    // and producing the residual gas-bad split losses captured by
    // PR #8285 (`agghook_chosen_higher_gas` verdict in prod).
    if (serviceConfig.GasEstimation.Enabled) {
      const startGasConvTime = Date.now();
      await this.gasConverter.updateQuoteBasicsGasDetails(
        chain.chainId,
        tradeType === TradeType.ExactIn
          ? tokenOutCurrencyInfo.wrappedAddress.toString()
          : tokenInCurrencyInfo.wrappedAddress.toString(),
        tokensInfo,
        quotesWithGas,
        ctx,
        blockNumber
      );
      await logElapsedTime(
        'UpdateQuoteBasicsGasDetailsPreSplit',
        startGasConvTime,
        ctx,
        metricTags
      );
    }

    // Generate a mapping of percentage to sorted quotes. Dedup quotes by
    // their canonical route string within each percentage bucket: diagnostic
    // logs on WBTC->USDT 10 BTC showed the top no-hook 1-hop route landed
    // in the same percentage bucket twice, wasting a slot in the K=2
    // per-percentage budget downstream. Route-layer dedupe in
    // BaseRoutesRepository catches dupes among the 100%-percentage routes;
    // this catches anything that slips through later stages (e.g. quote
    // retries, partition spill).
    const percentageToSortedQuotes = new Map<number, QuoteBasic[]>();
    const seenByPercentage = new Map<number, Set<string>>();
    let quoteDuplicatesRemoved = 0;
    for (const quote of quotesWithGas) {
      const percentage = quote.route.percentage;
      const key = quote.route.toString();
      let seen = seenByPercentage.get(percentage);
      if (!seen) {
        seen = new Set<string>();
        seenByPercentage.set(percentage, seen);
      }
      if (seen.has(key)) {
        quoteDuplicatesRemoved++;
        continue;
      }
      seen.add(key);
      if (!percentageToSortedQuotes.has(percentage)) {
        percentageToSortedQuotes.set(percentage, []);
      }
      percentageToSortedQuotes.get(percentage)?.push(quote);
    }
    if (quoteDuplicatesRemoved > 0) {
      ctx.logger.debug('DeepQuoteStrategy deduped duplicate quotes', {
        chainId: chain.chainId,
        beforeDedup: quotesWithGas.length,
        afterDedup: quotesWithGas.length - quoteDuplicatesRemoved,
        duplicatesRemoved: quoteDuplicatesRemoved,
      });
    }
    // Sort quotes by amount - descending for EXACT_IN, ascending for EXACT_OUT
    for (const percentage of percentageToSortedQuotes.keys()) {
      const quotes = percentageToSortedQuotes.get(percentage)!;
      quotes.sort((a, b) => {
        const comparison =
          b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0;
        return tradeType === TradeType.ExactOut ? -comparison : comparison;
      });
    }
    const percentageBucketSummary = Array.from(
      percentageToSortedQuotes.entries()
    ).map(([percentage, quotes]) => ({
      percentage,
      quoteCount: quotes.length,
      aggHookQuoteCount: quotes.filter(quote =>
        quote.route.path.some(pool => isAggHookPool(pool, chain.chainId))
      ).length,
      v3OnlyQuoteCount: quotes.filter(quote =>
        quote.route.path.every(pool => pool.protocol === Protocol.V3)
      ).length,
    }));
    const aggHookQuoteCountTotal = percentageBucketSummary.reduce(
      (sum, bucket) => sum + bucket.aggHookQuoteCount,
      0
    );
    const v3OnlyQuoteCountTotal = percentageBucketSummary.reduce(
      (sum, bucket) => sum + bucket.v3OnlyQuoteCount,
      0
    );
    ctx.logger.debug('DeepQuoteStrategy percentage bucket observability', {
      chainId: chain.chainId,
      tradeType,
      protocols: protocols.join(',').toLowerCase(),
      routeSplitPercentage: serviceConfig.RouteFinder.RouteSplitPercentage,
      pctRoutes: pctRoutes.length,
      quotesWithGas: quotesWithGas.length,
      percentageBuckets: percentageBucketSummary,
    });
    const deepQuoteStrategyMetricTags = [
      ...metricTags,
      `testAggHooks:${testAggHooks}`,
    ];
    // Bucket-level distribution metrics. The route-cap fix (PR #8301)
    // gave no-hook routes the full MaxRoutes budget but didn't move the
    // residual UniRoute-wins-by-gas-adjusted rate on prod. Top losing
    // hash `ab69b143` is `winnerMismatchRawVsGasAdjusted:false` —
    // treatment is worse than control on BOTH raw AND gas-adjusted, yet
    // uniroute still picks it. That implies the gas-adj-better route
    // control finds isn't in treatment's candidate set — i.e., the
    // divergence happens upstream of `findBestSplits` (pool discovery /
    // route enumeration / quote fetch / cached-routes hit-miss differ
    // between testAggHooks=true and testAggHooks=false runs).
    //
    // These metrics expose per-percentage bucket counts as queryable
    // distributions so we can diff treatment vs control on the same
    // chain/tradeType: if `avg:NoHookQuotesAtPercentage.dist{...
    // testagghooks:true}` is smaller than the testagghooks:false
    // counterpart at any percentage, the route enumeration / quote
    // fetch is dropping no-hook quotes specifically when agg-hooks are
    // enabled. Per-percentage tag has 20 distinct values (5..100 in 5%
    // steps); combined with chain (~20) / tradeType (2) /
    // testagghooks (2-3) the dimension cardinality is bounded
    // (~2400 combinations) and well within DD's tag-cardinality budget.
    const noHookQuoteCountTotal = percentageBucketSummary.reduce(
      (sum, bucket) => sum + (bucket.quoteCount - bucket.aggHookQuoteCount),
      0
    );
    const percentageBucketDistEmissions = percentageBucketSummary.flatMap(
      bucket => {
        const perBucketTags = [
          ...deepQuoteStrategyMetricTags,
          `percentage:${bucket.percentage}`,
        ];
        return [
          ctx.metrics.dist(
            buildMetricKey('DeepQuoteStrategy.NoHookQuotesAtPercentage.dist'),
            bucket.quoteCount - bucket.aggHookQuoteCount,
            {tags: perBucketTags}
          ),
          ctx.metrics.dist(
            buildMetricKey('DeepQuoteStrategy.AggHookQuotesAtPercentage.dist'),
            bucket.aggHookQuoteCount,
            {tags: perBucketTags}
          ),
        ];
      }
    );
    await Promise.all([
      ctx.metrics.count(
        buildMetricKey('DeepQuoteStrategy.PctRoutes'),
        pctRoutes.length,
        {tags: deepQuoteStrategyMetricTags}
      ),
      ctx.metrics.count(
        buildMetricKey('DeepQuoteStrategy.AggHookQuotes'),
        aggHookQuoteCountTotal,
        {tags: deepQuoteStrategyMetricTags}
      ),
      ctx.metrics.count(
        buildMetricKey('DeepQuoteStrategy.V3OnlyQuotes'),
        v3OnlyQuoteCountTotal,
        {tags: deepQuoteStrategyMetricTags}
      ),
      // Per-request total no-hook / agg-hook counts as distributions —
      // gives avg/max/min/p95 across calls without per-percentage tag
      // cardinality. The cleanest single signal for "is treatment's
      // overall no-hook universe smaller than control's?".
      ctx.metrics.dist(
        buildMetricKey('DeepQuoteStrategy.NoHookQuoteCountTotal.dist'),
        noHookQuoteCountTotal,
        {tags: deepQuoteStrategyMetricTags}
      ),
      ctx.metrics.dist(
        buildMetricKey('DeepQuoteStrategy.AggHookQuoteCountTotal.dist'),
        aggHookQuoteCountTotal,
        {tags: deepQuoteStrategyMetricTags}
      ),
      ctx.metrics.dist(
        buildMetricKey('DeepQuoteStrategy.PercentageBucketCount.dist'),
        percentageBucketSummary.length,
        {tags: deepQuoteStrategyMetricTags}
      ),
      ...percentageBucketDistEmissions,
    ]);

    // Use QuoteBestSplitFinder to find optimal route combinations
    const findSplitsStartTime = Date.now();
    ctx.logger.debug('Starting findBestSplits');
    const splitRoutes = await this.quoteBestSplitFinder.findBestSplits(
      chain.chainId,
      percentageToSortedQuotes,
      serviceConfig.RouteFinder.RouteSplitPercentage,
      serviceConfig.RouteFinder.MaxSplits,
      serviceConfig.RouteFinder.MaxSplitRoutes,
      serviceConfig.RouteFinder.RouteSplitTimeoutMs,
      tradeType,
      metricTags,
      ctx,
      testAggHooks
    );
    const findBestSplitsLatencyMs = Date.now() - findSplitsStartTime;
    await logElapsedTime(
      'FindBestSplits',
      findSplitsStartTime,
      ctx,
      metricTags
    );
    ctx.logger.debug('DeepQuoteStrategy split search observability', {
      chainId: chain.chainId,
      tradeType,
      protocols: protocols.join(',').toLowerCase(),
      findBestSplitsLatencyMs,
      routeSplitTimeoutMs: serviceConfig.RouteFinder.RouteSplitTimeoutMs,
      maxSplits: serviceConfig.RouteFinder.MaxSplits,
      maxSplitRoutes: serviceConfig.RouteFinder.MaxSplitRoutes,
      splitRoutes: splitRoutes.length,
    });

    ctx.logger.debug(`--> Routes (${routes.length})`);
    ctx.logger.debug(`--> PctRoutes (${pctRoutes.length})`);
    ctx.logger.debug(`--> QuotesWithGas (${quotesWithGas.length})`);
    ctx.logger.debug(`--> SplitRoutes (${splitRoutes.length})`);

    await ctx.metrics.count(buildMetricKey('SplitRoutes'), splitRoutes.length, {
      tags: metricTags,
    });
    await ctx.metrics.count(buildMetricKey('Routes'), routes.length, {
      tags: metricTags,
    });
    await ctx.metrics.count(buildMetricKey('PctRoutes'), pctRoutes.length, {
      tags: metricTags,
    });

    // Reconstruct QuoteSplit[] from QuoteBasic[] by stitching together the split routes
    ctx.logger.debug('Starting stitchQuotes');
    const stitchedQuotesWithGas = this.routeQuoteAllocator.stitchQuotes(
      quotesWithGas,
      splitRoutes,
      ctx
    );

    return stitchedQuotesWithGas;
  }

  /**
   * Updates quotes with fresh pool details needed for L2 gas estimation.
   * Only needed for Arbitrum/Optimism Stack chains.
   * @param quotes - Quotes to update (mutated in place)
   * @param tokensInfo - Map of token info
   * @param chain - Chain information
   * @param ctx - Context
   * @param metricTags - Metric tags for logging
   * @returns Updated tokensInfo map
   */
  private async updateQuotesWithFreshPoolDetails(
    quotes: QuoteBasic[],
    tokensInfo: Map<string, Erc20Token | null>,
    chain: Chain,
    ctx: Context,
    metricTags: string[],
    blockNumber?: number
  ): Promise<Map<string, Erc20Token | null>> {
    // Ensure we have fresh pool details for all pools involved in the quotes as we need it to generate calldata for L2 gas estimation
    // Only needed for Arbitrum/Optimism Stack chains
    tokensInfo = await fetchAllInvolvedTokens(
      quotes,
      this.tokenHandler,
      chain,
      ctx,
      tokensInfo
    );

    const poolsToUpdate = quotes.map(quote => quote.route.path).flat();
    const poolsCount = poolsToUpdate.length;
    const freshPoolDetailsStartTime = Date.now();
    ctx.logger.debug('Starting FreshPoolDetailsUpdateForGasEstimation update', {
      poolsCount,
    });
    const updatedPoolsMap = await this.freshPoolDetailsWrapper.getPoolsDetails(
      ctx,
      poolsToUpdate,
      chain,
      blockNumber
    );
    await updateQuotesWithFreshPoolDetailsUsingPoolsMap(
      updatedPoolsMap,
      quotes,
      ctx
    );
    await logElapsedTime(
      'FreshPoolDetailsUpdateForGasEstimation',
      freshPoolDetailsStartTime,
      ctx,
      metricTags
    );
    ctx.logger.debug('Completed FreshPoolDetailsUpdateForGasEstimation', {
      elapsedTime: Date.now() - freshPoolDetailsStartTime,
      poolsCount,
      updatedPoolsCount: updatedPoolsMap.size,
    });

    return tokensInfo;
  }

  name(): string {
    return 'DeepQuoteStrategy';
  }
}
