import {BaseQuoteStrategy} from './BaseQuoteStrategy';
import {UniProtocol} from '../../models/pool/UniProtocol';
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
import {UniPool} from '../../models/pool/UniPool';
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
  private readonly quoteBestSplitFinder: QuoteBestSplitFinder<UniPool>;

  constructor(
    quoteFetcher: IQuoteFetcher,
    gasEstimateProvider: IGasEstimateProvider,
    gasConverter: IGasConverter,
    routeQuoteAllocator: IRouteQuoteAllocator<UniPool>,
    quoteSelector: IQuoteSelector,
    tokenHandler: ITokenHandler,
    arbitrumGasDataProvider: ArbitrumGasDataProvider,
    freshPoolDetailsWrapper: IFreshPoolDetailsWrapper
  ) {
    super(
      quoteFetcher,
      gasEstimateProvider,
      gasConverter,
      routeQuoteAllocator,
      quoteSelector,
      tokenHandler,
      arbitrumGasDataProvider,
      freshPoolDetailsWrapper
    );
    this.quoteBestSplitFinder = new QuoteBestSplitFinder<UniPool>();
  }

  async findBestQuoteCandidates(
    ctx: Context,
    chain: Chain,
    tokenInCurrencyInfo: CurrencyInfo,
    tokenOutCurrencyInfo: CurrencyInfo,
    amount: bigint,
    tradeType: TradeType,
    protocols: UniProtocol[],
    serviceConfig: IUniRouteServiceConfig,
    routes: RouteBasic<UniPool>[],
    tokensInfo: Map<string, Erc20Token | null>,
    metricTags: string[]
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

    // Fetch quotes for all routes/percentage combos
    const fetchQuotesStartTime = Date.now();
    ctx.logger.debug('Starting fetchQuotes');
    const quotes = await this.quoteFetcher.fetchQuotes(
      chain,
      tokenInCurrencyInfo,
      tokenOutCurrencyInfo,
      amount,
      pctRoutes,
      tradeType,
      ctx,
      metricTags
    );
    await logElapsedTime('FetchQuotes', fetchQuotesStartTime, ctx, metricTags);

    // Update quotes with gas estimation details
    const gasEstimateStartTime = Date.now();
    ctx.logger.debug('Starting gasEstimate');
    const gasPriceWei = serviceConfig.GasEstimation.Enabled
      ? await this.gasEstimateProvider.getCurrentGasPrice(chain.chainId)
      : 0;

    // Below information is only needed when dealing with Arbitrum or Optimism Stack chains
    // in order to calculate L2 gas costs accurately. We need to update the quotes with fresh pool details
    // so that we can generate the correct calldata for L2 gas estimation.
    let arbitrumGasData: ArbitrumGasData | undefined = undefined;
    if (
      chain.chainId === ChainId.ARBITRUM &&
      serviceConfig.L1L2GasCostFetcher.ArbitrumEnabled
    ) {
      arbitrumGasData = await this.arbitrumGasDataProvider.getGasData();
    }
    if (
      (chain.chainId === ChainId.ARBITRUM &&
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
        metricTags
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

    // Generate a mapping of percentage to sorted quotes
    const percentageToSortedQuotes = new Map<number, QuoteBasic[]>();
    for (const quote of quotesWithGas) {
      const percentage = quote.route.percentage;
      if (!percentageToSortedQuotes.has(percentage)) {
        percentageToSortedQuotes.set(percentage, []);
      }
      percentageToSortedQuotes.get(percentage)?.push(quote);
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
      ctx
    );
    await logElapsedTime(
      'FindBestSplits',
      findSplitsStartTime,
      ctx,
      metricTags
    );

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
    const stitchQuotesStartTime = Date.now();
    ctx.logger.debug('Starting stitchQuotes');
    const stitchedQuotesWithGas = this.routeQuoteAllocator.stitchQuotes(
      quotesWithGas,
      splitRoutes,
      ctx
    );
    await logElapsedTime(
      'StitchQuotes',
      stitchQuotesStartTime,
      ctx,
      metricTags
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
    metricTags: string[]
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
      chain
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
