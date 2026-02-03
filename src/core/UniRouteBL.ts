import {Context} from '@uniswap/lib-uni/context';
import {CurrencyAmount, TradeType as SdkTradeType} from '@uniswap/sdk-core';
import {
  DebugInfo,
  DebugRouteCandidate,
  DeleteCachedRoutesRequest,
  DeleteCachedRoutesResponse,
  GetCachedRoutesBucketResponse,
  GetCachedRoutesRequest,
  GetCachedRoutesResponse,
  InspectCacheKeyRequest,
  InspectCacheKeyResponse,
  MethodParameters,
  PoolInRoute,
  QuoteRequest,
  QuoteResponse,
  Route,
  TokenInRoute,
} from '../../gen/uniroute/v1/api_pb';
import {
  buildSwapMethodParameters,
  buildTrade,
  MethodParameters as SDKMethodParameters,
} from '../lib/methodParameters';
import {
  buildMetricKey,
  ChainId,
  IUniRouteServiceConfig,
  LambdaType,
  needsGasPriceFetching,
} from '../lib/config';
import {Address} from '../models/address/Address';
import {IChainRepository} from '../stores/chain/IChainRepository';
import {TradeType} from '../models/quote/TradeType';
import {IQuoteFetcher} from '../stores/quote/IQuoteFetcher';
import {Chain} from '../models/chain/Chain';
import {UniPool} from '../models/pool/UniPool';
import {IQuoteSelector} from './quote/selector/IQuoteSelector';
import {
  allProtocolsIncluded,
  convertCurrencyInfoToSdkCurrency,
  erc20TokenToSdkToken,
  fetchAllInvolvedTokens,
  logElapsedTime,
  protocolToPoolTypeString,
  updateQuoteSplitWithFreshPoolDetails,
} from '../lib/helpers';
import {Erc20Token} from '../models/token/Erc20Token';
import {UniProtocol} from '../models/pool/UniProtocol';
import {V3Pool} from '../models/pool/V3Pool';
import {V2Pool} from '../models/pool/V2Pool';
import {V4Pool} from '../models/pool/V4Pool';
import {ITokenHandler} from '../stores/token/ITokenHandler';
import {IRoutesRepository} from '../stores/route/IRoutesRepository';
import {IUniRoutedBL} from './IUniRouteBL';
import {IGasEstimateProvider} from './gas/estimator/GasEstimateProvider';
import {QuoteStatus} from '../models/quote/QuoteStatus';
import {IPoolDiscoverer, UniPoolInfo} from './pool-discovery/interface';
import {IFreshPoolDetailsWrapper} from '../stores/pool/FreshPoolDetailsWrapper';
import {IRedisCache} from '@uniswap/lib-cache';
import {ICachedRoutesRepository} from '../stores/route/uniroutes/ICachedRoutesRepository';
import {QuoteType} from '../models/quote/QuoteType';
import {RouteBasic} from '../models/route/RouteBasic';
import {EnumUtils} from '../lib/EnumUtils';
import {QuoteSplit} from '../models/quote/QuoteSplit';
import {SwapInfo} from '../models/quote/SwapInfo';
import {IRouteQuoteAllocator} from './route/RouteQuoteAllocator';
import {IGasConverter} from './gas/converter/IGasConverter';
import {WRAPPED_NATIVE_CURRENCY} from '../lib/tokenUtils';
import {usdGasTokensByChain} from './gas/gas-helpers';
import {ADDRESS_ZERO} from '@uniswap/v3-sdk';
import {IQuoteStrategy} from './strategy/IQuoteStrategy';
import {ISimulator, SimulationStatus} from './simulator/ISimulator';
import {SwapOptionsFactory} from './swap/SwapOptionsFactory';
import {CurrencyInfo} from '../models/currency/CurrencyInfo';
import {IQuoteRequestValidator} from './QuoteRequestValidator';
import {
  calculateUsdAmount,
  getBucketFromAmount,
  getFineGrainedBucketFromAmount,
  UsdBucket,
  UsdBucketFineGrained,
} from '../stores/route/uniroutes/usdBucketUtils';
import {
  getCorrectedQuote,
  getCorrectedQuoteGasAdjusted,
  getPortionAmount,
  getPortionQuoteAmount,
} from '../lib/portionUtils';
import {HooksOptions} from '../models/hooks/HooksOptions';
import {ITokenProvider} from '../stores/token/provider/TokenProvider';
import {FAKE_TICK_SPACING, isValidRoute} from '../lib/poolUtils';
import {BigNumber} from '@ethersproject/bignumber';
import {JsonRpcProvider} from '@ethersproject/providers';
import assert from 'assert';
import {RedisCache} from '@uniswap/lib-cache/redis';

export class UniRouteBL implements IUniRoutedBL {
  constructor(
    private readonly serviceConfig: IUniRouteServiceConfig,
    private readonly redisCache: IRedisCache<string, string>,
    private readonly chainRepository: IChainRepository,
    private readonly poolDiscoverer: IPoolDiscoverer<UniPoolInfo>,
    private readonly freshPoolDetailsWrapper: IFreshPoolDetailsWrapper,
    private readonly tokenHandler: ITokenHandler,
    private readonly quoteFetcher: IQuoteFetcher,
    private readonly quoteSelector: IQuoteSelector,
    private readonly routeQuoteAllocator: IRouteQuoteAllocator<UniPool>,
    private readonly gasEstimateProvider: IGasEstimateProvider,
    private readonly gasConverter: IGasConverter,
    private readonly routeRepository: IRoutesRepository<UniPool>,
    private readonly cachedRoutesRepository: ICachedRoutesRepository,
    private readonly quoteStrategy: IQuoteStrategy,
    private readonly simulator: ISimulator,
    private readonly quoteRequestValidator: IQuoteRequestValidator,
    private readonly tokenProvider: ITokenProvider,
    private readonly rpcProviderMap: Map<ChainId, JsonRpcProvider>
  ) {}

  async quote(ctx: Context, request: QuoteRequest): Promise<QuoteResponse> {
    /*
     * Token Pair Journey Through UniRoute System
     * =======================================================
     *
     * Input: TokenIn/TokenOut pair + Amount + TradeType + QuoteType + ChainId
     *
     * CACHED ROUTES CHECK (Fast Quote Type)
     * ------------------------------------
     * [Input] ---[Cache Check]---> Cache Hit:  Use cached routes, skip to quote finding
     *                              Cache Miss: Continue with route discovery
     *
     *                              Cache contains:
     *                              - Previously discovered best routes
     *                              - For same token pair and chainId
     *                              - For same protocols
     *                              - Within expiry window
     *
     *                              For detailed implementation see:
     *                              CachedRoutesRepository class
     *                              - Redis sorted sets for storage
     *                              - Async route refresh mechanism (FRESH quote type)
     *                              - Pool state sanitization
     *
     * 1. POOL DISCOVERY & ROUTE CREATION (Skip if cache hit)
     * ----------------------------------------------------
     * TokenIn ----[Pool Discovery]----> [Pool1, Pool2, Pool3, ...]
     *   |
     * TokenOut                          Each pool contains:
     *                                   - Protocol (V2/V3/V4)
     *                                   - Liquidity/Reserves
     *                                   - Tokens & Decimals
     *                                   - Fee tiers (V3/V4)
     *
     *                                   ⬇
     *
     *                                   [Route1]: Pool1 -> Pool2
     *                                   [Route2]: Pool3
     *                                   [Route3]: Pool1 -> Pool4 -> Pool5
     *
     *                                   RouteBasic[] objects with:
     *                                   - Path of pools
     *                                   - Protocol per pool
     *                                   - Token pairs per hop
     *
     * 2. QUOTE FINDING STRATEGY
     * ------------------------
     * [Routes] ---[Strategy]---> Best Quote
     *
     *                            The provided strategy handles:
     *                            - Route splitting and combinations
     *                            - Quote fetching
     *                            - Gas use estimation
     *                            - Quote stitching
     *                            - Top candidate (split) routes selection
     *
     *                            See individual strategy implementations for details
     *                            on their specific quote finding approaches.
     *
     * 3. GAS ADJUSTED QUOTE AMOUNT ESTIMATION & QUOTE SELECTION
     * --------------------------------
     * Gas adjusted quote estimation and best quote selection
     * from the optimized set of route combinations.
     *
     * 4. SIMULATION & VALIDATION
     * -------------------------
     * [Best Quotes] ---[Simulation]---> Valid Quote
     *
     *                            Simulation process:
     *                            - Attempts to simulate each quote in order
     *                            - Validates transaction execution
     *                            - Updates gas estimates
     *                            - Returns first successful simulation
     *                            - Falls back to next quote if simulation fails
     *
     * 5. CACHE UPDATE
     * --------------
     * Best QuoteSplit:                Cache Updates:
     * [Route1_75% + Route2_25%] -->   Route1 cached independently
     *                                  Route2 cached independently
     *
     *                                  Each route is cached separately
     *                                  regardless of its % in the split,
     *                                  allowing future reuse in different
     *                                  combinations
     *
     * Output: QuoteResponse with best route(s), amounts, and gas estimates
     *
     */
    // Validate request inputs
    const invalidRequestResponse =
      await this.quoteRequestValidator.validateInputs(request, ctx);
    if (invalidRequestResponse) {
      return invalidRequestResponse;
    }

    const quoteCallStartTime = Date.now();

    // Parse inputs
    const chain = await this.chainRepository.getChain(request.tokenInChainId)!;
    const tradeType = EnumUtils.stringToEnum(TradeType, request.tradeType);
    const originalAmountIn = BigInt(request.amount);
    let amountIn = BigInt(request.amount);
    const quoteType = EnumUtils.stringToEnum(QuoteType, request.quoteType);
    const hooksOptions = EnumUtils.stringToEnum(
      HooksOptions,
      request.hooksOptions ?? HooksOptions.HOOKS_INCLUSIVE
    );
    const forceMixed = request.forceMixed;
    const protocols = request.protocols
      .split(',')
      .map(p => EnumUtils.stringToEnum(UniProtocol, p));
    const debugLogs = request.debugLogs;
    const portionBips = request.portionBips;
    const portionRecipient = request.portionRecipient;

    const metricTags = [
      `quoteservice:${this.serviceConfig.QuoteService}`,
      `chain:${ChainId[chain.chainId]}`,
      `tradeType:${tradeType}`,
      `quoteType:${quoteType}`,
      `protocols:${protocols.sort().join('_').toLowerCase()}`,
      `strategy:${this.quoteStrategy.name()}`,
      `hooksOptions:${hooksOptions}`,
    ];

    try {
      // Start parallel token search operations
      const startTime = Date.now();
      const [tokenInCurrencyInfo, tokenOutCurrencyInfo] = await Promise.all([
        this.tokenProvider.searchForToken(chain, request.tokenInAddress, ctx),
        this.tokenProvider.searchForToken(chain, request.tokenOutAddress, ctx),
      ]);
      ctx.logger.debug(
        `Token search took ${Date.now() - startTime}ms for tokenIn:${request.tokenInAddress} and tokenOut:${request.tokenOutAddress}`
      );

      // Check if we need to fetch gasPrice based on chain and tokens
      const needToFetchGasPrice = needsGasPriceFetching(
        chain.chainId,
        tokenInCurrencyInfo.wrappedAddress.address,
        tokenOutCurrencyInfo.wrappedAddress.address
      );

      // Fetch tokens info and block number in parallel
      // Those are needed for fot detection, gas estimation and quote conversion to USD.
      const getTokensStartTime = Date.now();
      ctx.logger.debug('Starting getTokens and block number fetch');
      const [tokensInfo, blockNumber, gasPriceResult] = await Promise.all([
        this.tokenHandler.getTokens(
          chain,
          [
            tokenInCurrencyInfo.wrappedAddress,
            tokenOutCurrencyInfo.wrappedAddress,
            new Address(WRAPPED_NATIVE_CURRENCY[chain.chainId]!.address),
            ...(usdGasTokensByChain[chain.chainId] ?? []).map(
              t => new Address(t.address)
            ),
          ],
          ctx
        ),
        this.serviceConfig.ResponseRequirements.NeedsBlockNumber
          ? this.rpcProviderMap.get(chain.chainId)!.getBlockNumber()
          : Promise.resolve<number>(0),
        needToFetchGasPrice
          ? this.rpcProviderMap.get(chain.chainId)!.getGasPrice()
          : Promise.resolve<BigNumber | undefined>(undefined),
      ]);
      // Use gasPriceResult if it is defined and greater than 0, otherwise use undefined
      const gasPrice =
        gasPriceResult !== undefined && gasPriceResult.gt(0)
          ? gasPriceResult.toBigInt()
          : undefined;

      await logElapsedTime(
        'GetTokensAndBlockNumber',
        getTokensStartTime,
        ctx,
        metricTags
      );

      // Check if any of the tokens are FOT, in which case getRoutes implementations must only return V2 routes.
      // Also check if any of the tokens are FOT with failed external transfer,
      const directSwapTokens = new Map(
        Array.from(tokensInfo).filter(([k]) =>
          [
            tokenInCurrencyInfo.wrappedAddress.toString(),
            tokenOutCurrencyInfo.wrappedAddress.toString(),
          ].includes(k)
        )
      );
      const fotInDirectSwap = this.containsFOT(directSwapTokens);
      const externalTransferFailedInDirectSwap =
        this.containsExternalTransferFailedTokens(directSwapTokens);

      // Do portion adjustments if needed for ExactOut.
      if (tradeType === TradeType.ExactOut) {
        const portionAmount = getPortionAmount(
          fotInDirectSwap,
          externalTransferFailedInDirectSwap,
          amountIn,
          portionBips,
          portionRecipient
        );
        amountIn += portionAmount;
      }

      // Calculate usd amount bucket based on the input amount
      const usdAmount = calculateUsdAmount(
        chain.chainId,
        amountIn,
        tradeType,
        tokenInCurrencyInfo.wrappedAddress,
        tokenOutCurrencyInfo.wrappedAddress,
        tokensInfo
      );
      // Used for caching bucket.
      const usdBucket = getBucketFromAmount(usdAmount);
      // Used for metrics granularity.
      const fineGrainedUsdBucket = getFineGrainedBucketFromAmount(usdAmount);

      metricTags.push(`bucket:${fineGrainedUsdBucket}`);
      ctx.logger.debug('Calculated USD amount and bucket', {
        amountIn: amountIn.toString(),
        usdAmount,
        fineGrainedUsdBucket,
        cacheUsdBucket: usdBucket,
        tokenIn: tokenInCurrencyInfo.wrappedAddress.toString(),
        tokenOut: tokenOutCurrencyInfo.wrappedAddress.toString(),
      });

      // Check if we have cached routes / otherwise use fresh ones.
      // If QuoteType.Fast, we always try to use cached routes first, even if expired (in which case an async QuoteType.Fresh fetch will be triggered)
      // - we only use cached routes if all protocols are included (i.e. we don't cache specific protocols requests as this would harm our "Global best" caching approach)
      // If QuoteType.Fresh, we force a fresh route fetch.
      let routes: RouteBasic<UniPool>[] = [];
      let usedCachedRoutes: boolean = false;
      if (
        quoteType === QuoteType.Fast &&
        allProtocolsIncluded(protocols) &&
        hooksOptions === HooksOptions.HOOKS_INCLUSIVE &&
        this.serviceConfig.CachedRoutes.Enabled
      ) {
        const getCachedRoutesStartTime = Date.now();
        routes = await this.cachedRoutesRepository.getCachedRoutes(
          chain.chainId,
          tokenInCurrencyInfo,
          tokenOutCurrencyInfo,
          tradeType,
          amountIn,
          usdBucket,
          quoteType,
          protocols,
          request,
          ctx
        );
        await logElapsedTime(
          'GetCachedRoutes',
          getCachedRoutesStartTime,
          ctx,
          metricTags
        );
        if (routes.length > 0) {
          usedCachedRoutes = true;
        }
      }
      if (routes.length === 0) {
        // Only skip pools for tokens cache if hooks are not inclusive (i.e. pool list might be different than the cached version)
        const skipPoolsForTokensCache =
          hooksOptions !== HooksOptions.HOOKS_INCLUSIVE;
        // Get fresh routes
        const getRoutesStartTime = Date.now();
        ctx.logger.debug('Starting getRoutes');
        routes = await this.routeRepository.getRoutes(
          chain,
          tokenInCurrencyInfo,
          tokenOutCurrencyInfo,
          protocols,
          tradeType,
          fotInDirectSwap,
          hooksOptions,
          skipPoolsForTokensCache,
          ctx
        );
        await logElapsedTime('GetRoutes', getRoutesStartTime, ctx, metricTags);
      }

      metricTags.push(
        `cachedRoutesStatus:${usedCachedRoutes ? 'hit' : 'miss'}`
      );

      // Make sure all our routes are valid here.
      const unfilteredRoutesLength = routes.length;
      const invalidRoutes: string[] = [];
      routes = routes.filter(r => {
        const isValid = isValidRoute(
          r,
          chain.chainId,
          tokenInCurrencyInfo.isNative,
          tokenOutCurrencyInfo.isNative
        );
        if (!isValid) {
          invalidRoutes.push(r.toString());
        }
        return isValid;
      });

      await ctx.metrics.count(
        buildMetricKey('InvalidRoutesFiltered'),
        invalidRoutes.length,
        {
          tags: metricTags,
        }
      );
      if (unfilteredRoutesLength !== routes.length) {
        ctx.logger.debug('Filtered out invalid routes', {
          unfilteredRoutesLength,
          filteredRoutesLength: routes.length,
          invalidRoutes,
        });
      }

      if (forceMixed) {
        ctx.logger.debug('Forcing mixed routes');
        routes = routes.filter(r => r.protocol === UniProtocol.MIXED);

        if (routes.length === 0) {
          ctx.logger.debug('No routes found');
          return new QuoteResponse({
            error: {
              code: 404,
              message: `No mixed valid routes found for pair ${request.tokenInAddress} -> ${request.tokenOutAddress}`,
            },
            hitsCachedRoutes: usedCachedRoutes,
            usdBucket: fineGrainedUsdBucket.toString(),
            debugInfo: debugLogs
              ? this.constructDebugInfo(routes, [])
              : undefined,
          });
        }
      }

      // Do some logging
      ctx.logger.debug(`Routes (${routes.length})`, {
        v2Routes: routes
          .filter(r => r.protocol === UniProtocol.V2)
          .map(r => r.toString()),
        v3Routes: routes
          .filter(r => r.protocol === UniProtocol.V3)
          .map(r => r.toString()),
        v4Routes: routes
          .filter(r => r.protocol === UniProtocol.V4)
          .map(r => r.toString()),
        mixedRoutes: routes
          .filter(r => r.protocol === UniProtocol.MIXED)
          .map(r => r.toString()),
      });

      // Get best quote based on the given quote strategy
      const bestQuoteCandidates =
        await this.quoteStrategy.findBestQuoteCandidates(
          ctx,
          chain,
          tokenInCurrencyInfo,
          tokenOutCurrencyInfo,
          amountIn,
          tradeType,
          protocols,
          this.serviceConfig,
          routes,
          tokensInfo,
          metricTags
        );

      ctx.logger.debug(
        `Best Quote Candidates (${bestQuoteCandidates.length}):`,
        {
          candidates: bestQuoteCandidates.map(candidate => ({
            route: candidate.quotes.map(q => ({
              routeString: q.route.toString(),
              amount: q.amount.toString(),
            })),
          })),
        }
      );

      // Update quotes with gas costs to USD / quote token
      if (this.serviceConfig.GasEstimation.Enabled) {
        const startGasUpdateTime = Date.now();
        await this.gasConverter.updateQuotesGasDetails(
          chain.chainId,
          tradeType === TradeType.ExactIn
            ? tokenOutCurrencyInfo.wrappedAddress.toString()
            : tokenInCurrencyInfo.wrappedAddress.toString(),
          tokensInfo,
          bestQuoteCandidates,
          ctx
        );
        await logElapsedTime(
          'UpdateQuotesGasDetails',
          startGasUpdateTime,
          ctx,
          metricTags
        );
      }

      // Select top N best quotes
      let topNQuotes: QuoteSplit[] = [];
      if (bestQuoteCandidates.length > 0) {
        const getBestQuotesStartTime = Date.now();
        topNQuotes = await this.quoteSelector.getBestQuotes(
          bestQuoteCandidates,
          tradeType,
          this.serviceConfig.Simulation.TopNQuotes,
          metricTags,
          ctx
        );
        await logElapsedTime(
          'SelectorGetBestQuotes',
          getBestQuotesStartTime,
          ctx,
          metricTags
        );
      }

      // Simulate quotes one by one (from best quote to worst) until we find a valid one
      const bestQuote = await this.simulateAndPopulateBestQuote(
        chain,
        tokenInCurrencyInfo,
        tokenOutCurrencyInfo,
        amountIn,
        tradeType,
        topNQuotes,
        tokensInfo,
        request,
        ctx,
        metricTags,
        gasPrice,
        blockNumber
      );

      // Finally update best route's pools with latest pool information
      let status = QuoteStatus.Pending;
      if (bestQuote) {
        ctx.logger.debug('Best quote:', {
          route: bestQuote.quotes.map(q => ({
            routeString: q.route.toString(),
            amount: q.amount.toString(),
          })),
        });

        status = QuoteStatus.Success;

        // Only update pool details if required
        if (this.serviceConfig.ResponseRequirements.NeedsUpToDatePoolsInfo) {
          const startUpdatePoolsTime = Date.now();
          await updateQuoteSplitWithFreshPoolDetails(
            this.freshPoolDetailsWrapper,
            bestQuote,
            chain,
            ctx,
            metricTags
          );
          await logElapsedTime(
            'MainUpdateBestQuotePoolsWithFreshDetails',
            startUpdatePoolsTime,
            ctx,
            metricTags
          );
        }
      } else {
        status = QuoteStatus.NoRoute;
      }

      // Report metrics
      metricTags.push(`status:${status}`);
      metricTags.push(
        `simulationStatus:${bestQuote?.simulationResult?.status}`
      );
      await ctx.metrics.count(buildMetricKey('Call'), 1, {
        tags: metricTags,
      });
      await ctx.metrics.timer(
        buildMetricKey('Latency'),
        Date.now() - quoteCallStartTime,
        {
          tags: metricTags,
        }
      );

      if (status === QuoteStatus.NoRoute) {
        return new QuoteResponse({
          error: {
            code: 404,
            message: `No valid quotes found for pair ${request.tokenInAddress} -> ${request.tokenOutAddress}`,
          },
          hitsCachedRoutes: usedCachedRoutes,
          usdBucket: fineGrainedUsdBucket.toString(),
          debugInfo: debugLogs
            ? this.constructDebugInfo(routes, bestQuoteCandidates)
            : undefined,
        });
      }

      // if this was a cache miss + all protocols searched + the simulation didn't fail + is async call, cache the best quote's route(s)
      if (
        !usedCachedRoutes &&
        allProtocolsIncluded(protocols) &&
        this.serviceConfig.Lambda.Type === LambdaType.Async &&
        bestQuote?.simulationResult?.status !== SimulationStatus.FAILED &&
        this.serviceConfig.CachedRoutes.Enabled
      ) {
        await Promise.all(
          bestQuote!.quotes.map(quote =>
            this.cachedRoutesRepository.saveCachedRoutes(
              quote.route,
              chain.chainId,
              tokenInCurrencyInfo.isNative
                ? new Address(ADDRESS_ZERO)
                : tokenInCurrencyInfo.wrappedAddress,
              tokenOutCurrencyInfo.isNative
                ? new Address(ADDRESS_ZERO)
                : tokenOutCurrencyInfo.wrappedAddress,
              tradeType,
              amountIn,
              usdBucket
            )
          )
        );
      }

      // Construct debugLogs if requested
      let debugInfo: DebugInfo | undefined;
      if (debugLogs) {
        debugInfo = this.constructDebugInfo(routes, bestQuoteCandidates);
      }

      // Populate response
      return await this.populateQuoteResponse(
        ctx,
        blockNumber,
        amountIn,
        originalAmountIn,
        tokenInCurrencyInfo,
        tokenOutCurrencyInfo,
        request.slippageTolerance,
        tradeType,
        bestQuote!,
        chain,
        usedCachedRoutes,
        fotInDirectSwap,
        externalTransferFailedInDirectSwap,
        fineGrainedUsdBucket,
        portionBips,
        portionRecipient,
        debugInfo
      );
    } catch (error) {
      // If request fails, log metric + request details for debugging purposes
      await ctx.metrics.count(buildMetricKey('UnhandledError'), 1, {
        tags: metricTags,
      });
      ctx.logger.error('Unhandled error in quote method', {
        error: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : undefined,
        request: {
          tokenInChainId: request.tokenInChainId,
          tokenInAddress: request.tokenInAddress,
          tokenOutChainId: request.tokenOutChainId,
          tokenOutAddress: request.tokenOutAddress,
          amount: request.amount,
          tradeType: request.tradeType,
          quoteType: request.quoteType,
          protocols: request.protocols,
          hooksOptions: request.hooksOptions,
          slippageTolerance: request.slippageTolerance,
          portionBips: request.portionBips,
          portionRecipient: request.portionRecipient,
          debugLogs: request.debugLogs,
          recipient: request.recipient,
          simulateFromAddress: request.simulateFromAddress,
        },
      });
      throw error;
    }
  }

  async getCachedRoutes(
    ctx: Context,
    request: GetCachedRoutesRequest
  ): Promise<GetCachedRoutesResponse> {
    try {
      // Parse inputs
      const chain = await this.chainRepository.getChain(request.chainId)!;
      const tokenInCurrencyInfo = await this.tokenProvider.searchForToken(
        chain,
        request.tokenInAddress,
        ctx
      );
      const tokenOutCurrencyInfo = await this.tokenProvider.searchForToken(
        chain,
        request.tokenOutAddress,
        ctx
      );
      const tradeType = EnumUtils.stringToEnum(TradeType, request.tradeType);
      // For getting cached routes, we always use amountIn = 0 as it's not really used.
      const amountIn = BigInt(0);

      // Get all USD buckets to check for cached routes
      const allUsdBuckets = Object.values(UsdBucket);
      const bucketResponses: GetCachedRoutesBucketResponse[] = [];

      // Check each USD bucket for cached routes
      for (const usdBucket of allUsdBuckets) {
        try {
          // Get cached routes for this specific bucket using the same logic as the quote method.
          // Note that `cachedRoutesRepository.getCachedRoutes` contains logic to trigger async update
          // but since we this endpoint is called with the async serviceConfig, it will not trigger it.
          // - see `CachedRoutesRepository.validateAndParseCachedRoutes` logic in `CachedRoutesRepository.ts`
          // - see `UniRouteService.getCachedRoutes` in `src/api/index.ts`
          const routes = await this.cachedRoutesRepository.getCachedRoutes(
            chain.chainId,
            tokenInCurrencyInfo,
            tokenOutCurrencyInfo,
            tradeType,
            amountIn,
            usdBucket,
            QuoteType.Fresh,
            [UniProtocol.V2, UniProtocol.V3, UniProtocol.V4, UniProtocol.MIXED], // All protocols
            new QuoteRequest(), // Empty request since we're not doing a full quote
            ctx
          );

          if (routes.length > 0) {
            // Convert routes to proto format
            const protoRoutes = await this.convertRoutesToProto(
              routes,
              chain,
              ctx
            );

            bucketResponses.push(
              new GetCachedRoutesBucketResponse({
                usdBucket: usdBucket,
                routes: protoRoutes,
                found: true,
                message: `Found ${routes.length} cached routes in bucket ${usdBucket}`,
              })
            );
          }
        } catch (bucketError) {
          ctx.logger.warn(
            `Error getting cached routes for bucket ${usdBucket}:`,
            bucketError
          );
          // Continue with other buckets even if one fails
        }
      }

      if (bucketResponses.length === 0) {
        return new GetCachedRoutesResponse({
          buckets: [],
        });
      }

      return new GetCachedRoutesResponse({
        buckets: bucketResponses,
      });
    } catch (error) {
      ctx.logger.error('Error getting cached routes:', error);
      return new GetCachedRoutesResponse({
        buckets: [],
      });
    }
  }

  async deleteCachedRoutes(
    ctx: Context,
    request: DeleteCachedRoutesRequest
  ): Promise<DeleteCachedRoutesResponse> {
    try {
      // Parse inputs
      const chain = await this.chainRepository.getChain(request.chainId)!;
      const tokenInCurrencyInfo = await this.tokenProvider.searchForToken(
        chain,
        request.tokenInAddress,
        ctx
      );
      const tokenOutCurrencyInfo = await this.tokenProvider.searchForToken(
        chain,
        request.tokenOutAddress,
        ctx
      );
      const tradeType = EnumUtils.stringToEnum(TradeType, request.tradeType);
      // For deleting cached routes, we always use amountIn = 0 as it's not really used.
      const amountIn = BigInt(0);
      const usdBucket = request.usdBucket as UsdBucket;

      // Delete cached routes
      const success = await this.cachedRoutesRepository.deleteCachedRoutes(
        chain.chainId,
        tokenInCurrencyInfo.isNative
          ? new Address(ADDRESS_ZERO)
          : tokenInCurrencyInfo.wrappedAddress,
        tokenOutCurrencyInfo.isNative
          ? new Address(ADDRESS_ZERO)
          : tokenOutCurrencyInfo.wrappedAddress,
        tradeType,
        amountIn,
        usdBucket
      );

      if (success) {
        return new DeleteCachedRoutesResponse({
          success: true,
          message: 'Cached routes deleted successfully',
        });
      } else {
        return new DeleteCachedRoutesResponse({
          success: false,
          message: 'Failed to delete cached routes',
        });
      }
    } catch (error) {
      ctx.logger.error('Error deleting cached routes:', error);
      return new DeleteCachedRoutesResponse({
        success: false,
        message: 'Error deleting cached routes',
        error: {
          code: 500,
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      });
    }
  }

  // Helper endpoint to inspect/debug raw keys in redis cache
  // In general, keys in redis are encoded as: {Namespace}\"key\" (if namespace is not undefined).
  // Namespaces for redis per service are defined in config.ts
  // Note: Uniroute config has no namespace.
  // Examples:
  // Uniroute key: "\"CACHEDROUTE#1#EXACT_IN#0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984#0x514910771AF9Ca656af840dff83E8264EcF986CA#USD_1_000\""
  // Quickroute key: "quickroute-\"CACHEDROUTE#1#EXACT_IN#0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984#0x514910771AF9Ca656af840dff83E8264EcF986CA#USD_1_000\""
  async inspectCacheKey(
    request: InspectCacheKeyRequest
  ): Promise<InspectCacheKeyResponse> {
    const client = (this.redisCache as RedisCache<string, string>).client;
    const response = {
      key: request.key,
      type: 'any' as 'normal' | 'list' | 'sorted_set' | 'any',
      value: undefined as string | undefined,
      status: 'pending' as 'pending' | 'success' | 'not_found',
    };
    try {
      const val = await client.get(request.key);
      if (val !== null) {
        response.value = val;
        response.status = 'success';
        response.type = 'normal';
      }
    } catch {
      // That's fine, we'll check other types of keys.
    }

    if (response.status === 'pending') {
      try {
        // check if lrange
        const lrange = await client.lrange(request.key, 0, -1);
        if (lrange.length > 0) {
          response.value = lrange.join(',');
          response.status = 'success';
          response.type = 'list';
        }
      } catch {
        // That's fine, we'll check other types of keys.
      }
    }

    if (response.status === 'pending') {
      // check if zrange
      const zrange = await client.zrange(request.key, 0, -1, 'WITHSCORES');
      if (zrange.length > 0) {
        const result: [string, number][] = [];
        // Redis returns [value1, score1, value2, score2, ...] when using WITHSCORES
        for (let i = 0; i < zrange.length; i += 2) {
          result.push([zrange[i], parseFloat(zrange[i + 1])]);
        }
        response.value = result.join(', ');
        response.status = 'success';
        response.type = 'sorted_set';
      }
    }

    if (response.status === 'pending') {
      response.status = 'not_found';
    }

    return new InspectCacheKeyResponse({
      key: response.key,
      type: response.type,
      value: response.value,
      status: response.status,
    });
  }

  async populateQuoteResponse(
    ctx: Context,
    blockNumber: number,
    amountIn: bigint,
    originalAmountIn: bigint,
    tokenInCurrencyInfo: CurrencyInfo,
    tokenOutCurrencyInfo: CurrencyInfo,
    slippageTolerance: number | undefined,
    tradeType: TradeType,
    quoteSplit: QuoteSplit,
    chain: Chain,
    usedCachedRoutes: boolean,
    fotInDirectSwap: boolean,
    externalTransferFailedInDirectSwap: boolean,
    fineGrainedUsdBucket: UsdBucketFineGrained,
    portionBips?: number,
    portionRecipient?: string,
    debugInfo?: DebugInfo
  ): Promise<QuoteResponse> {
    const tokenIn = erc20TokenToSdkToken(
      chain.chainId,
      quoteSplit.tokensInfo!.get(tokenInCurrencyInfo.wrappedAddress.toString())!
    );
    const tokenOut = erc20TokenToSdkToken(
      chain.chainId,
      quoteSplit.tokensInfo!.get(
        tokenOutCurrencyInfo.wrappedAddress.toString()
      )!
    );

    // Calculate total quote amount by summing up all quote amounts
    const totalQuoteAmount = quoteSplit.quotes.reduce(
      (sum, quote) => sum + quote.amount,
      0n
    );

    // Calculate amountIn distribution for each quote using original route percentages
    let remainingAmountIn = amountIn;
    const quoteAmountsIn = quoteSplit.quotes.map((quote, i) => {
      if (i === quoteSplit.quotes.length - 1) {
        // Last quote gets remaining amount to ensure total equals amountIn
        return remainingAmountIn;
      }
      const quoteAmountIn = (amountIn * BigInt(quote.route.percentage)) / 100n;
      remainingAmountIn -= quoteAmountIn;
      return quoteAmountIn;
    });

    const gasCostInQuoteToken = quoteSplit.quotes.reduce(
      (sum, quote) => sum + (quote.gasDetails?.gasCostInQuoteToken ?? 0n),
      0n
    );

    const gasCostInUSD = quoteSplit.quotes.reduce(
      (sum, quote) => sum + (quote.gasDetails?.gasCostInUSD ?? 0),
      0
    );

    const quoteGasAdjusted =
      tradeType === TradeType.ExactIn
        ? totalQuoteAmount - gasCostInQuoteToken // For EXACT_INPUT, subtract gas from output
        : totalQuoteAmount + gasCostInQuoteToken; // For EXACT_OUTPUT, add gas to input

    // Aggregate gas details from all quotes
    const totalGasUse = quoteSplit.quotes.reduce(
      (sum, quote) => sum + (quote.gasDetails?.gasUse ?? 0n),
      0n
    );
    // Use gas price from first quote since it should be the same for all quotes
    const gasPriceWei = quoteSplit.quotes[0]?.gasDetails?.gasPriceInWei;

    // Create route string by joining all quote routes
    const routeString = quoteSplit.quotes
      .map(quote => quote.route.toString())
      .join(', ');

    // If simulation succeeded, update quoteGasAdjusted amount and gas estimates
    let finalQuoteGasAdjusted = quoteGasAdjusted;
    let finalGasUseEstimate = totalGasUse;
    let finalGasUseEstimateQuote = gasCostInQuoteToken;
    if (
      quoteSplit.simulationResult?.status === SimulationStatus.SUCCESS &&
      quoteSplit.simulationResult.estimatedGasUsedInQuoteToken !== 0n
    ) {
      // TODO: estimatedGasUsedInQuoteToken might go negative (https://linear.app/uniswap/issue/ROUTE-453)
      if (tradeType === TradeType.ExactIn) {
        finalQuoteGasAdjusted =
          totalQuoteAmount -
          quoteSplit.simulationResult.estimatedGasUsedInQuoteToken;
      } else {
        finalQuoteGasAdjusted =
          totalQuoteAmount +
          quoteSplit.simulationResult.estimatedGasUsedInQuoteToken;
      }
      finalGasUseEstimate = quoteSplit.simulationResult.estimatedGasUsed;
      finalGasUseEstimateQuote =
        quoteSplit.simulationResult.estimatedGasUsedInQuoteToken;

      ctx.logger.debug(
        'Simulation succeeded - updating quoteGasAdjusted amount',
        {
          quoteGasAdjusted: quoteGasAdjusted.toString(),
          finalQuoteGasAdjusted: finalQuoteGasAdjusted.toString(),
        }
      );
    }

    // Do portion amount calculations
    const tokenOutAmountIn =
      tradeType === TradeType.ExactOut ? originalAmountIn : totalQuoteAmount;
    const portionAmount = getPortionAmount(
      fotInDirectSwap,
      externalTransferFailedInDirectSwap,
      tokenOutAmountIn,
      portionBips,
      portionRecipient
    );
    const portionAmountDecimals = CurrencyAmount.fromRawAmount(
      tokenOut,
      portionAmount.toString()
    );

    // Calculate portion quote amount for ExactOut trades (needed for correction)
    const portionQuoteAmount = getPortionQuoteAmount(
      tradeType,
      totalQuoteAmount,
      originalAmountIn,
      portionAmount
    );

    // Apply corrections for ExactOut trades
    const correctedQuote = getCorrectedQuote(
      tradeType,
      totalQuoteAmount,
      portionQuoteAmount
    );
    const correctedQuoteGasAdjusted = getCorrectedQuoteGasAdjusted(
      tradeType,
      finalQuoteGasAdjusted,
      portionQuoteAmount
    );

    // Log portion correction details
    if (tradeType === TradeType.ExactOut && portionAmount > 0n) {
      ctx.logger.debug('Portion correction applied for ExactOut trade', {
        originalAmountIn: originalAmountIn.toString(),
        portionAmount: portionAmount.toString(),
        totalQuoteAmount: totalQuoteAmount.toString(),
        portionQuoteAmount: portionQuoteAmount.toString(),
        correctedQuote: correctedQuote.toString(),
        correctedQuoteGasAdjusted: correctedQuoteGasAdjusted.toString(),
        finalGasUseEstimateQuote: finalGasUseEstimateQuote.toString(),
      });
    }

    // Convert corrected amounts to CurrencyAmount for decimals
    const finalGasUseEstimateQuoteDecimals = CurrencyAmount.fromRawAmount(
      tradeType === TradeType.ExactIn ? tokenOut : tokenIn,
      finalGasUseEstimateQuote.toString()
    );

    // Convert corrected amounts to CurrencyAmount for decimals
    const correctedQuoteDecimals = CurrencyAmount.fromRawAmount(
      tradeType === TradeType.ExactIn ? tokenOut : tokenIn,
      correctedQuote.toString()
    );
    const correctedQuoteGasAdjustedDecimals = CurrencyAmount.fromRawAmount(
      tradeType === TradeType.ExactIn ? tokenOut : tokenIn,
      correctedQuoteGasAdjusted.toString()
    );

    // Create an array of arrays where each inner array represents pools from one quote
    const allPools = quoteSplit.quotes.map((quote, quoteIndex) => {
      return quote.route.path.map((p, index) => {
        // Determine if we need to swap token0/token1 for this pool
        let isTokenOrderSwapped = false;

        if (index === 0) {
          // First pool: token0 must be tokenInAddress
          // 1. if input token is not native, then just assume input token is tokenInCurrencyInfo.wrappedAddress
          // 2. if input token is native
          //    a. if we only have one pool, then tokenIn is either native/wrappedAddress, whatever is present in the first pool
          //    b. if we have multiple pools, then we can figure out tokenIn to be the token0/1 of first pool that is not present in the second pool
          // after figuring out tokenIn, we can figure out isTokenOrderSwapped by checking p.token0.address !== tokenIn.address
          let inferredTokenIn: Address;

          if (!tokenInCurrencyInfo.isNative) {
            // Case 1: Input token is not native, use wrapped address
            inferredTokenIn = tokenInCurrencyInfo.wrappedAddress;
          } else {
            // Case 2: Input token is native
            if (quote.route.path.length === 1) {
              // Case 2a: Single pool - use whichever token (native/wrapped) is present in the pool
              const zeroAddress = new Address(ADDRESS_ZERO);
              inferredTokenIn =
                p.token0.equals(zeroAddress) ||
                p.token0.equals(tokenInCurrencyInfo.wrappedAddress)
                  ? p.token0
                  : p.token1;
            } else {
              // Case 2b: Multiple pools - find token in first pool that's not in second pool
              const nextPool = quote.route.path[1];
              if (
                nextPool.token0.equals(p.token0) ||
                nextPool.token1.equals(p.token0)
              ) {
                inferredTokenIn = p.token1;
              } else {
                inferredTokenIn = p.token0;
              }
            }
          }

          isTokenOrderSwapped = !p.token0.equals(inferredTokenIn);
        } else {
          // Other pools: token0 must match previous pool's token1
          const prevPool = quote.route.path[index - 1];
          // For subsequent pools, we need to track which token was the output of the previous pool
          // If the previous pool had swapped order, then token0 was the output
          // If not swapped, then token1 was the output
          const prevTokenOut =
            prevPool.token0.equals(p.token0) || prevPool.token0.equals(p.token1)
              ? prevPool.token0
              : prevPool.token1;
          isTokenOrderSwapped = !p.token0.equals(prevTokenOut);
        }

        // Get tokens in correct order
        const tokenIn = quoteSplit.tokensInfo!.get(
          isTokenOrderSwapped ? p.token1.address : p.token0.address
        )!;
        const tokenOut = quoteSplit.tokensInfo!.get(
          isTokenOrderSwapped ? p.token0.address : p.token1.address
        )!;

        const tokenInInRoute = new TokenInRoute({
          address: tokenIn.address.address,
          decimals: tokenIn.decimals,
          symbol: tokenIn.symbol,
          chainId: chain.chainId,
          buyFeeBps: tokenIn.feeOnTransfer?.buyFeeBps?.toString(),
          sellFeeBps: tokenIn.feeOnTransfer?.sellFeeBps?.toString(),
        });

        const tokenOutInRoute = new TokenInRoute({
          address: tokenOut.address.address,
          decimals: tokenOut.decimals,
          symbol: tokenOut.symbol,
          chainId: chain.chainId,
          buyFeeBps: tokenOut.feeOnTransfer?.buyFeeBps?.toString(),
          sellFeeBps: tokenOut.feeOnTransfer?.sellFeeBps?.toString(),
        });

        let extraPoolInfo = {};
        if (p.protocol === UniProtocol.V2) {
          const v2Pool = p as V2Pool;
          extraPoolInfo = {
            reserve0: {
              token: tokenInInRoute,
              quotient: isTokenOrderSwapped
                ? v2Pool.reserve1.toString()
                : v2Pool.reserve0.toString(),
            },
            reserve1: {
              token: tokenOutInRoute,
              quotient: isTokenOrderSwapped
                ? v2Pool.reserve0.toString()
                : v2Pool.reserve1.toString(),
            },
          };
        } else if (p.protocol === UniProtocol.V3) {
          const v3Pool = p as V3Pool;
          extraPoolInfo = {
            liquidity: v3Pool.liquidity.toString(),
            fee: v3Pool.fee.toString(),
            tickCurrent: v3Pool.tickCurrent.toString(),
            // populate both sqrtPriceX96 and sqrtRatioX96 for backward compatibility
            sqrtPriceX96: v3Pool.sqrtPriceX96.toString(),
            sqrtRatioX96: v3Pool.sqrtPriceX96.toString(),
          };
        } else if (p.protocol === UniProtocol.V4) {
          const v4Pool = p as V4Pool;
          extraPoolInfo = {
            liquidity: v4Pool.liquidity.toString(),
            fee: v4Pool.fee.toString(),
            tickCurrent: v4Pool.tickCurrent.toString(),
            tickSpacing: v4Pool.tickSpacing.toString(),
            // populate both sqrtPriceX96 and sqrtRatioX96 for backward compatibility
            sqrtPriceX96: v4Pool.sqrtPriceX96.toString(),
            sqrtRatioX96: v4Pool.sqrtPriceX96.toString(),
            hooks: v4Pool.hooks,
          };
        }

        // Calculate pool's amountIn/Out using pre-calculated amounts
        let poolAmountIn: string | undefined;
        let poolAmountOut: string | undefined;
        if (index === 0) {
          poolAmountIn =
            tradeType === TradeType.ExactIn
              ? quoteAmountsIn[quoteIndex].toString()
              : quote.amount.toString();
        }
        if (index === quote.route.path.length - 1) {
          // Calculate the portion amount for this specific route's quote
          const routePortionAmount = getPortionAmount(
            fotInDirectSwap,
            externalTransferFailedInDirectSwap,
            quote.amount,
            portionBips,
            portionRecipient
          );
          assert(
            tradeType === TradeType.ExactIn
              ? quote.amount >= routePortionAmount
              : true,
            'Quote amount must be greater than route portion amount'
          );
          poolAmountOut =
            tradeType === TradeType.ExactIn
              ? // For ExactIn, we need to adjust last pool's amountOut to account for portion
                // This is to be on parity with RoutinApi, which deducts portion from the final output amount on ExactIn trades
                // UI reads this value to show user the final expected output amount after portion deduction
                // See https://github.com/Uniswap/smart-order-router/blob/main/src/routers/alpha-router/functions/best-swap-route.ts#L810
                (quote.amount - routePortionAmount).toString()
              : quoteAmountsIn[quoteIndex].toString();
        }

        return new PoolInRoute({
          type: protocolToPoolTypeString(p.protocol),
          address: p.address.address,
          tokenIn: tokenInInRoute,
          tokenOut: tokenOutInRoute,
          amountIn: poolAmountIn?.toString(),
          amountOut: poolAmountOut?.toString(),
          ...extraPoolInfo,
        });
      });
    });

    // Filter out V4 pools with fake tick spacing after constructing allPools
    // This is temporary until we remove fake eth/weth connector (once eth/weth hooks are enabled on all chains)
    // TODO: https://linear.app/uniswap/issue/ROUTE-741
    const filteredAllPools = allPools.map(pools =>
      pools.filter(pool => {
        // Skip fake eth/weth V4 pools with fake tick spacing
        if (
          pool.type === protocolToPoolTypeString(UniProtocol.V4) &&
          pool.tickSpacing === FAKE_TICK_SPACING.toString()
        ) {
          return false;
        }
        return true; // Keep this pool
      })
    );

    // Finally construct and return the QuoteResponse
    const quoteResponse = new QuoteResponse({
      blockNumber: blockNumber.toString(),
      quoteAmount: correctedQuote.toString(),
      quoteAmountDecimals: correctedQuoteDecimals.toExact(),
      quoteGasAdjusted: correctedQuoteGasAdjusted.toString(),
      quoteGasAdjustedDecimals: correctedQuoteGasAdjustedDecimals.toExact(),
      gasPriceWei: gasPriceWei?.toString(),
      gasUseEstimate: finalGasUseEstimate.toString(),
      gasUseEstimateQuote: finalGasUseEstimateQuote.toString(),
      gasUseEstimateQuoteDecimals: finalGasUseEstimateQuoteDecimals.toExact(),
      gasUseEstimateUSD: gasCostInUSD.toString(),
      routeString,
      route: filteredAllPools.map(pools => new Route({pools})),
      hitsCachedRoutes: usedCachedRoutes,
      debugInfo: debugInfo,
      simulationStatus: quoteSplit.simulationResult?.status.toString(),
      simulationError:
        quoteSplit.simulationResult?.status === SimulationStatus.FAILED,
      simulationDescription: quoteSplit.simulationResult?.description,
      methodParameters: new MethodParameters({
        to: quoteSplit.swapInfo?.methodParameters?.to,
        calldata: quoteSplit.swapInfo?.methodParameters?.calldata,
        value: quoteSplit.swapInfo?.methodParameters?.value,
      }),
      portionBips,
      portionRecipient,
      portionAmount: portionAmount.toString(),
      portionAmountDecimals: portionAmountDecimals.toExact(),
      priceImpact: this.formatPriceImpact(quoteSplit.swapInfo?.priceImpact),
      quoteId: ctx.requestId,
      usdBucket: fineGrainedUsdBucket.toString(),
    });

    // Log detailed error if simulation failed
    if (quoteSplit.simulationResult?.status === SimulationStatus.FAILED) {
      ctx.logger.error(
        'Quote with Simulation failed - Request/QuoteResponse details',
        {
          tokenIn: tokenInCurrencyInfo.wrappedAddress.address,
          tokenInIsNative: tokenInCurrencyInfo.isNative,
          tokenOut: tokenOutCurrencyInfo.wrappedAddress.address,
          tokenOutIsNative: tokenOutCurrencyInfo.isNative,
          tradeType: tradeType,
          amountIn: amountIn.toString(),
          slippageTolerance: slippageTolerance,
          chainId: chain.chainId,
          blockNumber: quoteResponse.blockNumber,
          quoteAmount: quoteResponse.quoteAmount,
          quoteAmountDecimals: quoteResponse.quoteAmountDecimals,
          quoteGasAdjusted: quoteResponse.quoteGasAdjusted,
          quoteGasAdjustedDecimals: quoteResponse.quoteGasAdjustedDecimals,
          gasPriceWei: quoteResponse.gasPriceWei,
          gasUseEstimate: quoteResponse.gasUseEstimate,
          gasUseEstimateQuote: quoteResponse.gasUseEstimateQuote,
          gasUseEstimateQuoteDecimals:
            quoteResponse.gasUseEstimateQuoteDecimals,
          gasUseEstimateUSD: quoteResponse.gasUseEstimateUSD,
          routeString: quoteResponse.routeString,
          hitsCachedRoutes: quoteResponse.hitsCachedRoutes,
          simulationStatus: quoteResponse.simulationStatus,
          simulationError: quoteResponse.simulationError,
          simulationDescription: quoteResponse.simulationDescription,
          portionBips: quoteResponse.portionBips,
          portionRecipient: quoteResponse.portionRecipient,
          portionAmount: quoteResponse.portionAmount,
          portionAmountDecimals: quoteResponse.portionAmountDecimals,
          priceImpact: quoteResponse.priceImpact,
          quoteId: quoteResponse.quoteId,
          usdBucket: quoteResponse.usdBucket,
          methodParameters: quoteResponse.methodParameters
            ? {
                to: quoteResponse.methodParameters.to,
                calldata: quoteResponse.methodParameters.calldata,
                value: quoteResponse.methodParameters.value,
              }
            : undefined,
        }
      );
    }

    return quoteResponse;
  }

  containsFOT(tokensInfo: Map<string, Erc20Token | null>): boolean {
    for (const token of tokensInfo.values()) {
      const sellTokenIsFot = token?.feeOnTransfer?.buyFeeBps ?? 0 > 0;
      const buyTokenIsFot = token?.feeOnTransfer?.sellFeeBps ?? 0 > 0;
      if (sellTokenIsFot || buyTokenIsFot) {
        return true;
      }
    }
    return false;
  }

  containsExternalTransferFailedTokens(
    tokensInfo: Map<string, Erc20Token | null>
  ): boolean {
    for (const token of tokensInfo.values()) {
      if (token?.feeOnTransfer?.externalTransferFailed) {
        return true;
      }
    }
    return false;
  }

  private constructDebugInfo(
    routes: RouteBasic<UniPool>[],
    bestQuoteCandidates: QuoteSplit[]
  ): DebugInfo {
    // Map and sort route candidates by totalQuoteAmount in descending order
    const sortedRouteCandidates = bestQuoteCandidates
      .map(quoteSplit => {
        const routeString = quoteSplit.quotes
          .map(quote => quote.route.toString())
          .join(', ');
        const totalQuoteAmount = quoteSplit.quotes.reduce(
          (sum, quote) => sum + quote.amount,
          0n
        );
        return {
          routeString,
          totalQuoteAmount,
        };
      })
      .sort((a, b) => {
        // Sort in descending order (highest to lowest)
        return a.totalQuoteAmount > b.totalQuoteAmount
          ? -1
          : a.totalQuoteAmount < b.totalQuoteAmount
            ? 1
            : 0;
      });

    return new DebugInfo({
      routesConsidered: routes.map(r => r.toString()),
      routeCandidates: sortedRouteCandidates.map(
        candidate =>
          new DebugRouteCandidate({
            routeString: candidate.routeString,
            quoteAmount: candidate.totalQuoteAmount.toString(),
          })
      ),
    });
  }

  private async simulateAndPopulateBestQuote(
    chain: Chain,
    tokenInCurrencyInfo: CurrencyInfo,
    tokenOutCurrencyInfo: CurrencyInfo,
    amountIn: bigint,
    tradeType: TradeType,
    topNQuotes: QuoteSplit[],
    tokensInfo: Map<string, Erc20Token | null>,
    request: QuoteRequest,
    ctx: Context,
    metricTags: string[],
    gasPrice?: bigint,
    blockNumber?: number
  ): Promise<QuoteSplit | undefined> {
    if (topNQuotes.length === 0) {
      return undefined;
    }

    let bestQuote: QuoteSplit | undefined;
    let simulationAttempts = 0;
    let simulationSuccesses = 0;
    let simulationFailures = 0;
    const failedRoutes: string[] = [];
    let firstSwapInfo: SwapInfo | undefined = undefined; // Store swapInfo from first successful trade build

    // Create our swap configuration
    const swapOptions = SwapOptionsFactory.createUniversalRouterOptions_2_0({
      chainId: chain.chainId,
      tradeType: tradeType,
      amountIn: request.amount,
      tokenInWrappedAddress: tokenInCurrencyInfo.wrappedAddress.address,
      slippageTolerance: request.slippageTolerance?.toString(),
      portionBips: request.portionBips,
      portionRecipient: request.portionRecipient,
      deadline: request.deadline,
      recipient: request.recipient,
      permitSignature: request.permitSignature,
      permitNonce: request.permitNonce,
      permitExpiration: request.permitExpiration,
      permitAmount: request.permitAmount,
      permitSigDeadline: request.permitSigDeadline,
      simulateFromAddress: request.simulateFromAddress,
    });

    if (
      this.serviceConfig.Simulation.Enabled &&
      swapOptions?.simulate?.fromAddress
    ) {
      for (const quoteSplit of topNQuotes) {
        const simulationStartTime = Date.now();
        const allTokensInfo = await fetchAllInvolvedTokens(
          quoteSplit.quotes,
          this.tokenHandler,
          chain,
          ctx,
          tokensInfo
        );

        // Note: We need to update the quote with the latest pool details (needed to create trade properly)
        await updateQuoteSplitWithFreshPoolDetails(
          this.freshPoolDetailsWrapper,
          quoteSplit,
          chain,
          ctx,
          metricTags
        );

        // Now build the trade
        const {tokenInCurrency, tokenOutCurrency} =
          convertCurrencyInfoToSdkCurrency(
            tokenInCurrencyInfo,
            tokenOutCurrencyInfo,
            chain.chainId,
            allTokensInfo
          );

        let trade;
        try {
          trade = buildTrade(
            tokenInCurrency,
            tokenOutCurrency,
            amountIn,
            chain.chainId,
            allTokensInfo,
            tradeType === TradeType.ExactIn
              ? SdkTradeType.EXACT_INPUT
              : SdkTradeType.EXACT_OUTPUT,
            quoteSplit,
            true, // percentageSumCheck
            ctx
          );
        } catch (error) {
          await ctx.metrics.count(buildMetricKey('buildTradeFailed'), 1, {
            tags: metricTags,
          });
          ctx.logger.error('Error building trade', {
            error: error.toString(),
            tokenInIsNative: tokenInCurrencyInfo.isNative,
            tokenInWrappedAddress: tokenInCurrencyInfo.wrappedAddress.address,
            tokenOutIsNative: tokenOutCurrencyInfo.isNative,
            tokenOutWrappedAddress: tokenOutCurrencyInfo.wrappedAddress.address,
            amountIn: amountIn.toString(),
            chainId: chain.chainId,
            quoteSplit: quoteSplit.quotes
              .map(q => q.route.toString())
              .join(', '),
            tradeType,
            metricTags,
          });
          // Continue with next candidate quote
          continue;
        }

        // Get our method parameters
        let methodParameters: SDKMethodParameters;
        try {
          methodParameters = buildSwapMethodParameters(
            ctx,
            swapOptions!,
            chain.chainId,
            trade
          );
        } catch (error) {
          // Call to UR might fail if not enough reserves in v2 - continue to next quote
          await ctx.metrics.count(
            buildMetricKey('buildSwapMethodParametersFailed'),
            1,
            {
              tags: metricTags,
            }
          );
          ctx.logger.error('Error building swap method parameters', {
            error,
            quoteSplit: quoteSplit.toString(),
          });
          continue;
        }

        // TODO: ROUTE-886 - fix v4 midPrice calculation in SDK
        // Temporary fix to make sure we don't throw an error and return a quote with priceImpact = 0
        let priceImpact = 0.0;
        try {
          priceImpact = Number(trade.priceImpact.toFixed());
        } catch (e) {
          await ctx.metrics.count(
            buildMetricKey('PriceImpactCalculationFailed'),
            1,
            {
              tags: metricTags,
            }
          );
          ctx.logger.error('Error calculating priceImpact for trade', {
            error: String(e),
            tradeType,
            tokenIn: tokenInCurrencyInfo.wrappedAddress.address,
            tokenOut: tokenOutCurrencyInfo.wrappedAddress.address,
            tokenInIsNative: tokenInCurrencyInfo.isNative,
            tokenOutIsNative: tokenOutCurrencyInfo.isNative,
            routes: trade.routes.map((route, idx) => ({
              routeIndex: idx,
              input: route.input.symbol,
              output: route.output.symbol,
              pools: route.pools.map((pool, poolIdx) => ({
                poolIndex: poolIdx,
                token0: pool.token0.symbol,
                token1: pool.token1.symbol,
                token0Address: pool.token0.wrapped.address,
                token1Address: pool.token1.wrapped.address,
                token0decimals: pool.token0.decimals,
                token1decimals: pool.token1.decimals,
                token0isNative: pool.token0.isNative,
                token1isNative: pool.token1.isNative,
                chainId: pool.chainId,
              })),
            })),
            quoteSplitRoutes: quoteSplit.quotes.map(q => q.route.toString()),
          });
        }

        const swapInfo = new SwapInfo(
          tokenInCurrencyInfo.wrappedAddress.address,
          tokenOutCurrencyInfo.wrappedAddress.address,
          tokenInCurrency.isNative,
          tokenOutCurrency.isNative,
          amountIn,
          tradeType,
          priceImpact,
          methodParameters
        );

        // Store swapInfo from first attempt for potential fallback use in case all simulations fail
        if (firstSwapInfo === undefined) {
          firstSwapInfo = swapInfo;
        }

        const simulationQuote: QuoteSplit = {
          ...quoteSplit,
          swapInfo: swapInfo,
          tokensInfo: allTokensInfo,
        };

        // And let's simulate!
        simulationAttempts++;
        const simulatedQuote = await this.simulator.simulate(
          chain.chainId,
          swapOptions,
          simulationQuote,
          tokenInCurrencyInfo,
          tokenOutCurrencyInfo,
          amountIn,
          simulationQuote.quotes.reduce((sum, quote) => sum + quote.amount, 0n),
          ctx,
          gasPrice,
          blockNumber
        );

        // Log simulation latency and status
        const simulationLatency = Date.now() - simulationStartTime;
        const simulationStatus =
          simulatedQuote.simulationResult?.status ??
          SimulationStatus.UNATTEMPTED;
        await ctx.metrics.timer(
          buildMetricKey('SimulationLatency'),
          simulationLatency,
          {
            tags: [
              ...metricTags,
              `simulationStatus:${SimulationStatus[simulationStatus]}`,
            ],
          }
        );

        // TODO: Check what other SimulationStatus values we want to handle/try more quotes
        if (
          simulatedQuote.simulationResult?.status === SimulationStatus.FAILED
        ) {
          simulationFailures++;
          failedRoutes.push(
            quoteSplit.quotes.map(q => q.route.toString()).join(', ')
          );
          ctx.logger.error('Simulation failed for quote:', {
            error: simulatedQuote.simulationResult?.description,
            quoteSplit: simulatedQuote.quotes.map(q => q.route.toString()),
            methodParameters: simulatedQuote.swapInfo?.methodParameters,
            tokenInCurrency,
            tokenOutCurrency,
            tokenInCurrencyInfo,
            tokenOutCurrencyInfo,
          });
        } else {
          simulationSuccesses++;
          bestQuote = simulatedQuote;
          break;
        }
      }

      // If all simulations failed, return the first quote (best by amount) with Failed status
      if (!bestQuote && topNQuotes.length > 0 && firstSwapInfo) {
        const allTokensInfo = await fetchAllInvolvedTokens(
          topNQuotes[0].quotes,
          this.tokenHandler,
          chain,
          ctx,
          tokensInfo
        );

        bestQuote = {
          ...topNQuotes[0],
          simulationResult: {
            estimatedGasUsed: 0n,
            estimatedGasUsedInQuoteToken: 0n,
            status: SimulationStatus.FAILED,
            description: 'All simulation attempts failed',
          },
          swapInfo: firstSwapInfo, // Use the swapInfo from the first attempt
          tokensInfo: allTokensInfo,
        };

        ctx.logger.error(
          'All simulation attempts failed, returning failed quote',
          {
            failedRoutes,
            tags: metricTags,
            tokenInIsNative: tokenInCurrencyInfo.isNative,
            tokenInWrappedAddress: tokenInCurrencyInfo.wrappedAddress.address,
            tokenOutIsNative: tokenOutCurrencyInfo.isNative,
            tokenOutWrappedAddress: tokenOutCurrencyInfo.wrappedAddress.address,
            amountIn: amountIn.toString(),
            tradeType,
          }
        );
      }
    } else {
      // If simulation is disabled, just use the best quote
      // TODO: maybe populate swapInfo/methodParameters here is well
      const allTokensInfo = await fetchAllInvolvedTokens(
        topNQuotes[0].quotes,
        this.tokenHandler,
        chain,
        ctx,
        tokensInfo
      );
      bestQuote = {
        ...topNQuotes[0],
        simulationResult: {
          estimatedGasUsed: 0n,
          estimatedGasUsedInQuoteToken: 0n,
          status: SimulationStatus.UNATTEMPTED,
          description: 'Simulation skipped',
        },
        tokensInfo: allTokensInfo,
      };

      await ctx.metrics.count(buildMetricKey('SimulationSkipped'), 1, {
        tags: metricTags,
      });
    }

    // Log simulation metrics
    await ctx.metrics.count(
      buildMetricKey('SimulationAttempts'),
      simulationAttempts,
      {
        tags: metricTags,
      }
    );
    await ctx.metrics.count(
      buildMetricKey('SimulationSuccesses'),
      simulationSuccesses,
      {
        tags: metricTags,
      }
    );
    await ctx.metrics.count(
      buildMetricKey('SimulationFailures'),
      simulationFailures,
      {
        tags: metricTags,
      }
    );

    // Log failed routes if any
    if (failedRoutes.length > 0) {
      ctx.logger.error('Routes that failed simulation:', {
        failedRoutes,
        tags: metricTags,
      });
    }

    return bestQuote;
  }

  // Used to generate Routes for getCachedRoutesResponse
  private async convertRoutesToProto(
    routes: RouteBasic<UniPool>[],
    chain: Chain,
    ctx: Context
  ): Promise<Route[]> {
    // Collect all unique token addresses from all routes
    const tokenAddresses = new Set<string>();
    for (const route of routes) {
      for (const pool of route.path) {
        tokenAddresses.add(pool.token0.address);
        tokenAddresses.add(pool.token1.address);
      }
    }

    // Fetch all involved tokens using tokenHandler
    const tokensInfo = await this.tokenHandler.getTokens(
      chain,
      Array.from(tokenAddresses).map(address => new Address(address)),
      ctx
    );

    const protoRoutes: Route[] = [];

    for (const route of routes) {
      const pools: PoolInRoute[] = [];

      for (const pool of route.path) {
        // Get token information from the fetched tokens
        const token0Info = tokensInfo.get(pool.token0.address);
        const token1Info = tokensInfo.get(pool.token1.address);

        const tokenInInRoute = new TokenInRoute({
          address: pool.token0.address,
          decimals: token0Info?.decimals ?? 0,
          symbol: token0Info?.symbol ?? 'UNKNOWN',
          chainId: chain.chainId,
          buyFeeBps: token0Info?.feeOnTransfer?.buyFeeBps?.toString(),
          sellFeeBps: token0Info?.feeOnTransfer?.sellFeeBps?.toString(),
        });

        const tokenOutInRoute = new TokenInRoute({
          address: pool.token1.address,
          decimals: token1Info?.decimals ?? 0,
          symbol: token1Info?.symbol ?? 'UNKNOWN',
          chainId: chain.chainId,
          buyFeeBps: token1Info?.feeOnTransfer?.buyFeeBps?.toString(),
          sellFeeBps: token1Info?.feeOnTransfer?.sellFeeBps?.toString(),
        });

        const poolInRoute = new PoolInRoute({
          type: protocolToPoolTypeString(pool.protocol),
          address: pool.address.address,
          tokenIn: tokenInInRoute,
          tokenOut: tokenOutInRoute,
        });

        pools.push(poolInRoute);
      }

      protoRoutes.push(new Route({pools}));
    }

    return protoRoutes;
  }

  private formatPriceImpact(priceImpact: number | undefined): string {
    if (priceImpact === undefined) return '0';
    return Math.max(-100, Math.min(100, priceImpact)).toString();
  }
}
