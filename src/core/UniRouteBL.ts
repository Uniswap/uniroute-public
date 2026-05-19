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
  QuoteService,
  needsGasPriceFetching,
  getUniRouteSyncCacheMissRouteFinderOverrides,
} from '../lib/config';
import {Address} from '../models/address/Address';
import {IChainRepository} from '../stores/chain/IChainRepository';
import {TradeType} from '../models/quote/TradeType';
import {IQuoteFetcher} from '../stores/quote/IQuoteFetcher';
import {Chain} from '../models/chain/Chain';
import {Pool} from '../models/pool/Pool';
import {IQuoteSelector} from './quote/selector/IQuoteSelector';
import {
  onlyUniswapProtocolsIncludedAndMixed,
  allUniswapNativeProtocolsIncludedAndMixed,
  convertCurrencyInfoToSdkCurrency,
  erc20TokenToSdkToken,
  fetchAllInvolvedTokens,
  logElapsedTime,
  protocolToPoolTypeString,
  sanitizeRequestSourceTag,
  updateQuoteSplitWithFreshPoolDetails,
  isExternalProtocol,
  UNISWAP_NATIVE_PROTOCOLS,
  allUniswapAndSomeExternalProtocolsAndMixed,
} from '../lib/helpers';
import {Erc20Token} from '../models/token/Erc20Token';
import {Protocol} from '../models/pool/Protocol';
import {V3Pool} from '../models/pool/V3Pool';
import {V2Pool} from '../models/pool/V2Pool';
import {V4Pool} from '../models/pool/V4Pool';
import {ITokenHandler} from '../stores/token/ITokenHandler';
import {IRoutesRepository} from '../stores/route/IRoutesRepository';
import {IUniRoutedBL, QuoteOptions} from './IUniRouteBL';
import {IGasEstimateProvider} from './gas/estimator/GasEstimateProvider';
import {QuoteStatus} from '../models/quote/QuoteStatus';
import {IPoolDiscoverer, UniPoolInfo} from './pool-discovery/interface';
import {IFreshPoolDetailsWrapper} from '../stores/pool/FreshPoolDetailsWrapper';
import {IRedisCache} from '@uniswap/lib-cache';
import {ICachedRoutesRepository} from '../stores/route/uniroutes/ICachedRoutesRepository';
import {INoRouteCacheRepository} from '../stores/route/uniroutes/NoRouteCacheRepository';
import {QuoteType} from '../models/quote/QuoteType';
import {RouteBasic} from '../models/route/RouteBasic';
import {EnumUtils} from '../lib/EnumUtils';
import {QuoteSplit} from '../models/quote/QuoteSplit';
import {SwapInfo} from '../models/quote/SwapInfo';
import {IRouteQuoteAllocator} from './route/RouteQuoteAllocator';
import {IGasConverter} from './gas/converter/IGasConverter';
import {getGasToken} from '../lib/tokenUtils';
import {usdGasTokensByChain} from './gas/gas-helpers';
import {ADDRESS_ZERO} from '@uniswap/v3-sdk';
import {IQuoteStrategy} from './strategy/IQuoteStrategy';
import {ISimulator, SimulationStatus} from './simulator/ISimulator';
import {ResolvedStateOverride} from './simulator/ResolvedStateOverride';
import {
  StateOverrideResolver,
  detectDuplicateResolvedWrites,
} from './simulator/StateOverrideResolver';
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
  getQuoteGasAndPortionAdjusted,
} from '../lib/portionUtils';
import {HooksOptions} from '../models/hooks/HooksOptions';
import {EXPERIMENT_HOOKS, Experiment} from '../models/hooks/Experiment';
import {resolveNamespaces} from './namespaces/RouteNamespaceResolver';
import {ITokenProvider} from '../stores/token/provider/TokenProvider';
import {
  containsExternalTransferFailedTokens,
  containsFOT,
  FAKE_TICK_SPACING,
  filterRoutesWithFotIntermediaryTokens,
  isValidRoute,
} from '../lib/poolUtils';
import {BigNumber} from '@ethersproject/bignumber';
import {JsonRpcProvider} from '@ethersproject/providers';
import assert from 'assert';
import {getProtocolForAggHookAddress} from '../lib/poolCaching/util/hooksAddressesAllowlist';
import {RedisCache} from '@uniswap/lib-cache/redis';
import {CHAIN_TO_GAS_LIMIT_MAP} from './simulator/routing-api-port/gasLimit';
import {SwapOptionsUniversalRouter} from './simulator/sor-port/simulation-provider';
import {UniversalRouterVersion} from '@uniswap/universal-router-sdk';
import {
  namespaceFieldsForLogging,
  routeSetCountsForLogging,
  summarizeRouteForLogging,
  summarizeRoutesForLogging,
} from '../lib/observability';
import {capRoutesByAggHookClass} from '../lib/routeCap';
import {EMPTY_NAMESPACE_CONTEXT} from '../models/hooks/namespaces';
import {RouteNamespaceContext} from '../models/hooks/namespaces/CacheNamespace';

/**
 * Inspects the tokensInfo map for the direct-swap pair (tokenIn, tokenOut)
 * and reports whether either token is fee-on-transfer or has a failed
 * external transfer.
 */
function detectFotInDirectSwap(
  tokensInfo: Map<string, Erc20Token | null>,
  tokenInCurrencyInfo: CurrencyInfo,
  tokenOutCurrencyInfo: CurrencyInfo
): {fotInDirectSwap: boolean; externalTransferFailedInDirectSwap: boolean} {
  const directSwapTokens = new Map(
    Array.from(tokensInfo).filter(([k]) =>
      [
        tokenInCurrencyInfo.wrappedAddress.toString(),
        tokenOutCurrencyInfo.wrappedAddress.toString(),
      ].includes(k)
    )
  );
  return {
    fotInDirectSwap: containsFOT(directSwapTokens),
    externalTransferFailedInDirectSwap:
      containsExternalTransferFailedTokens(directSwapTokens),
  };
}

/**
 * Computes the USD value of the input amount and the corresponding
 * cache bucket (coarse) plus fine-grained bucket (metrics).
 */
function computeUsdBuckets(
  chainId: ChainId,
  amountIn: bigint,
  tradeType: TradeType,
  tokenInCurrencyInfo: CurrencyInfo,
  tokenOutCurrencyInfo: CurrencyInfo,
  tokensInfo: Map<string, Erc20Token | null>
): {
  usdAmount: number | undefined;
  usdBucket: UsdBucket;
  fineGrainedUsdBucket: UsdBucketFineGrained;
} {
  const usdAmount = calculateUsdAmount(
    chainId,
    amountIn,
    tradeType,
    tokenInCurrencyInfo.wrappedAddress,
    tokenOutCurrencyInfo.wrappedAddress,
    tokensInfo
  );
  return {
    usdAmount,
    usdBucket: getBucketFromAmount(usdAmount),
    fineGrainedUsdBucket: getFineGrainedBucketFromAmount(usdAmount),
  };
}

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
    private readonly routeQuoteAllocator: IRouteQuoteAllocator<Pool>,
    private readonly gasEstimateProvider: IGasEstimateProvider,
    private readonly gasConverter: IGasConverter,
    private readonly routeRepository: IRoutesRepository<Pool>,
    private readonly cachedRoutesRepository: ICachedRoutesRepository,
    private readonly noRouteCacheRepository: INoRouteCacheRepository,
    private readonly quoteStrategy: IQuoteStrategy,
    private readonly simulator: ISimulator,
    private readonly quoteRequestValidator: IQuoteRequestValidator,
    private readonly tokenProvider: ITokenProvider,
    private readonly rpcProviderMap: Map<ChainId, JsonRpcProvider>,
    private readonly stateOverrideResolver: StateOverrideResolver
  ) {}

  /**
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
   */
  async quote(
    ctx: Context,
    request: QuoteRequest,
    options?: QuoteOptions
  ): Promise<QuoteResponse> {
    // Validate request inputs
    const invalidRequestResponse =
      await this.quoteRequestValidator.validateInputs(request, ctx);
    if (invalidRequestResponse) {
      return invalidRequestResponse;
    }

    const quoteCallStartTime = Date.now();

    const emitCallMetrics = async (tags: string[]) => {
      await ctx.metrics.count(buildMetricKey('Call'), 1, {tags});
      await ctx.metrics.dist(
        buildMetricKey('Latency.dist'),
        Date.now() - quoteCallStartTime,
        {tags}
      );
    };

    const parsed = await this.parseQuoteRequest(request, options);
    const {
      chain,
      tradeType,
      originalAmountIn,
      quoteType,
      hooksOptions,
      forceMixed,
      protocols,
      experiment,
      nsCtx,
      namespaceLogFields,
      debugLogs,
      portionBips,
      portionRecipient,
      requestBlockNumber,
      requestSource,
    } = parsed;
    let amountIn = originalAmountIn;
    const metricTags = [
      `quoteservice:${this.serviceConfig.QuoteService}`,
      `chain:${ChainId[chain.chainId]}`,
      `tradeType:${tradeType}`,
      `quoteType:${quoteType}`,
      `protocols:${protocols.sort().join('_').toLowerCase()}`,
      `strategy:${this.quoteStrategy.name()}`,
      `hooksOptions:${hooksOptions}`,
      `requestSource:${sanitizeRequestSourceTag(requestSource)}`,
    ];

    await ctx.metrics.count(buildMetricKey('QuoteRequest.Experiment'), 1, {
      tags: [`experiment:${experiment ?? 'none'}`],
    });

    // Log for debugging token usage spikes
    ctx.logger.info('Quote request parsed', {
      quoteService: this.serviceConfig.QuoteService,
      chain: ChainId[chain.chainId],
      tokenIn: request.tokenInAddress,
      tokenOut: request.tokenOutAddress,
      amount: request.amount,
      tradeType,
      quoteType,
      protocols: protocols.sort().join(',').toLowerCase(),
      hooksOptions,
      ...namespaceLogFields,
      hasExternalProtocols: isExternalProtocol(protocols),
      stableStableExperiment: experiment,
      testAggHooks: options?.testAggHooks,
      requestSource,
      forceMixed,
      portionBips,
      universalRouterVersion: options?.universalRouterVersion,
    });

    try {
      const {
        tokenInCurrencyInfo,
        tokenOutCurrencyInfo,
        tokensInfo,
        blockNumber,
        gasPrice,
      } = await this.fetchRequestData(
        ctx,
        chain,
        request,
        requestBlockNumber,
        metricTags
      );

      const {fotInDirectSwap, externalTransferFailedInDirectSwap} =
        detectFotInDirectSwap(
          tokensInfo,
          tokenInCurrencyInfo,
          tokenOutCurrencyInfo
        );

      // FOT tokens are not supported for EXACT_OUT trades. Fee-on-transfer tokens
      // take a percentage during each transfer, making exact output guarantees impossible.
      if (fotInDirectSwap && tradeType === TradeType.ExactOut) {
        metricTags.push(`status:${QuoteStatus.NoRoute}`);
        metricTags.push('reason:fot_exact_out');
        await emitCallMetrics(metricTags);
        return new QuoteResponse({
          error: {
            code: 400,
            message: 'FOT tokens are not supported for EXACT_OUT trade type',
          },
          hitsCachedRoutes: false,
        });
      }

      // Resolve client-supplied state overrides. The validator gates every
      // shape the resolver can throw on, so a non-zero failedCount in the
      // production path means validator ↔ resolver drift (server bug) —
      // fail fast with a 4xx so the drift surfaces immediately instead of
      // silently simulating against incomplete state.
      //
      // Post-resolve we also reject any bundle whose resolved entries
      // collide on the same (contract, slot), (contract, balance), or
      // (contract, code) write. The encoder applies last-wins, so a
      // duplicate is ambiguous from the client's perspective and would
      // either silently overwrite earlier intent or (for a same-value
      // no-op) cause the pre-sim guard to false-fallback to live RPC.
      // Failing fast at validation keeps both the simulator path and the
      // pre-sim guard simple.
      let resolvedStateOverrides: ResolvedStateOverride[] | undefined;
      if (request.stateOverrides.length > 0) {
        const result = await this.stateOverrideResolver.resolve(
          request.stateOverrides,
          chain.chainId,
          ctx
        );
        if (result.failedCount > 0) {
          metricTags.push(`status:${QuoteStatus.NoRoute}`);
          metricTags.push('reason:state_override_resolve_failed');
          await emitCallMetrics(metricTags);
          return new QuoteResponse({
            error: {
              code: 400,
              message: `${result.failedCount} state override(s) could not be resolved; check STATE_OVERRIDE_NOT_APPLIED logs for per-entry detail`,
            },
            hitsCachedRoutes: false,
          });
        }
        const collision = detectDuplicateResolvedWrites(result.resolved);
        if (collision) {
          metricTags.push(`status:${QuoteStatus.NoRoute}`);
          metricTags.push('reason:state_override_duplicate_write');
          await emitCallMetrics(metricTags);
          return new QuoteResponse({
            error: {
              code: 400,
              message: `Duplicate state override write at ${collision}; each (contract, slot/balance/code) target must be written by at most one entry`,
            },
            hitsCachedRoutes: false,
          });
        }
        resolvedStateOverrides = result.resolved;
        if (resolvedStateOverrides.length > 0) {
          await ctx.metrics.count(
            'SimulationStateOverridesApplied',
            resolvedStateOverrides.length,
            {
              tags: [`chain:${chain.chainId}`],
            }
          );
        }
      }

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

      const {usdAmount, usdBucket, fineGrainedUsdBucket} = computeUsdBuckets(
        chain.chainId,
        amountIn,
        tradeType,
        tokenInCurrencyInfo,
        tokenOutCurrencyInfo,
        tokensInfo
      );

      metricTags.push(`bucket:${fineGrainedUsdBucket}`);
      ctx.logger.debug('Calculated USD amount and bucket', {
        amountIn: amountIn.toString(),
        usdAmount,
        fineGrainedUsdBucket,
        cacheUsdBucket: usdBucket,
        tokenIn: tokenInCurrencyInfo.wrappedAddress.toString(),
        tokenOut: tokenOutCurrencyInfo.wrappedAddress.toString(),
      });

      // Check caches: no-route negative cache and route cache in parallel.
      const shouldCheckCache =
        (onlyUniswapProtocolsIncludedAndMixed(protocols) ||
          (allUniswapAndSomeExternalProtocolsAndMixed(protocols) &&
            this.serviceConfig.CachedRoutes.AggHooksReadEnabled)) &&
        hooksOptions === HooksOptions.HOOKS_INCLUSIVE &&
        this.serviceConfig.CachedRoutes.Enabled;

      let routes: RouteBasic<Pool>[] = [];
      let usedCachedRoutes = false;
      if (quoteType === QuoteType.Fast && shouldCheckCache) {
        const cacheResult = await this.tryReadAndShortCircuitCache(
          ctx,
          request,
          options,
          chain,
          tokenInCurrencyInfo,
          tokenOutCurrencyInfo,
          tradeType,
          amountIn,
          usdBucket,
          fineGrainedUsdBucket,
          quoteType,
          protocols,
          nsCtx,
          metricTags
        );
        if ('shortCircuit' in cacheResult) {
          await emitCallMetrics(metricTags);
          return cacheResult.shortCircuit;
        }
        routes = cacheResult.routes;
        usedCachedRoutes = cacheResult.usedCachedRoutes;
      }
      if (routes.length === 0) {
        routes = await this.fetchFreshRoutes(
          ctx,
          chain,
          tokenInCurrencyInfo,
          tokenOutCurrencyInfo,
          protocols,
          tradeType,
          fotInDirectSwap,
          hooksOptions,
          nsCtx,
          options?.testAggHooks,
          metricTags
        );
      }

      metricTags.push(
        `cachedRoutesStatus:${usedCachedRoutes ? 'hit' : 'miss'}`
      );

      const effectiveConfig = this.selectEffectiveConfig(
        usedCachedRoutes,
        protocols
      );

      routes = await this.filterInvalidRoutes(
        ctx,
        routes,
        chain,
        tokenInCurrencyInfo,
        tokenOutCurrencyInfo,
        metricTags
      );

      if (tradeType === TradeType.ExactOut && routes.length > 0) {
        routes = await this.filterFotIntermediaryRoutes(
          ctx,
          chain,
          routes,
          tokenInCurrencyInfo,
          tokenOutCurrencyInfo,
          tokensInfo
        );
      }

      if (forceMixed) {
        const forceMixedResult = this.enforceForceMixed(
          ctx,
          request,
          routes,
          debugLogs,
          usedCachedRoutes,
          fineGrainedUsdBucket
        );
        if (forceMixedResult.forceMixedNoRouteResponse) {
          metricTags.push(`status:${QuoteStatus.NoRoute}`);
          metricTags.push('reason:force_mixed_no_route');
          await emitCallMetrics(metricTags);
          return forceMixedResult.forceMixedNoRouteResponse;
        }
        routes = forceMixedResult.routes;
      }

      routes = await this.capRoutesAndObserve(
        ctx,
        chain,
        tradeType,
        quoteType,
        hooksOptions,
        protocols,
        usedCachedRoutes,
        options?.testAggHooks,
        routes,
        effectiveConfig
      );

      // Do some logging
      ctx.logger.debug(`Routes (${routes.length})`, {
        v2Routes: routes
          .filter(r => r.protocol === Protocol.V2)
          .map(r => r.toString()),
        v3Routes: routes
          .filter(r => r.protocol === Protocol.V3)
          .map(r => r.toString()),
        v4Routes: routes
          .filter(r => r.protocol === Protocol.V4)
          .map(r => r.toString()),
        mixedRoutes: routes
          .filter(r => r.protocol === Protocol.MIXED)
          .map(r => r.toString()),
      });

      const {bestQuoteCandidates, bestQuote} = await this.runQuotePipeline(
        ctx,
        chain,
        tokenInCurrencyInfo,
        tokenOutCurrencyInfo,
        amountIn,
        tradeType,
        protocols,
        effectiveConfig,
        routes,
        tokensInfo,
        request,
        options,
        metricTags,
        requestBlockNumber,
        gasPrice,
        resolvedStateOverrides
      );

      let status = QuoteStatus.Pending;
      if (bestQuote) {
        ctx.logger.debug('Best quote:', {
          route: bestQuote.quotes.map(q => ({
            routeString: q.route.toString(),
            amount: q.amount.toString(),
          })),
        });
        status = QuoteStatus.Success;

        await this.emitGuideStarMetricIfApplicable(
          ctx,
          chain,
          bestQuote,
          options,
          metricTags
        );
        await this.emitAggHookLeakMetrics(
          ctx,
          chain,
          bestQuote,
          protocols,
          usedCachedRoutes,
          options,
          metricTags
        );
        await this.refreshBestQuotePoolDetailsIfNeeded(
          ctx,
          chain,
          bestQuote,
          metricTags,
          requestBlockNumber
        );
      } else {
        status = QuoteStatus.NoRoute;
      }

      // Report metrics
      metricTags.push(`status:${status}`);
      metricTags.push(
        `simulationStatus:${bestQuote?.simulationResult?.status}`
      );
      metricTags.push(
        `routeFinderConfig:${effectiveConfig !== this.serviceConfig ? 'reduced' : 'original'}`
      );
      await emitCallMetrics(metricTags);

      await this.writeCachesIfAsync(
        status,
        bestQuote,
        ctx,
        chain,
        tokenInCurrencyInfo,
        tokenOutCurrencyInfo,
        tradeType,
        amountIn,
        usdBucket,
        quoteType,
        hooksOptions,
        protocols,
        nsCtx,
        namespaceLogFields,
        usedCachedRoutes,
        shouldCheckCache,
        options,
        metricTags
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

  /**
   * Parses a QuoteRequest + QuoteOptions into the derived values used
   * throughout quote(). Resolves the chain (the only async step) and
   * computes the cache-namespace context once per request.
   */
  private async parseQuoteRequest(
    request: QuoteRequest,
    options?: QuoteOptions
  ) {
    const chain = await this.chainRepository.getChain(request.tokenInChainId)!;
    const tradeType = EnumUtils.stringToEnum(TradeType, request.tradeType);
    const originalAmountIn = BigInt(request.amount);
    const quoteType = EnumUtils.stringToEnum(QuoteType, request.quoteType);
    const hooksOptions = EnumUtils.stringToEnum(
      HooksOptions,
      request.hooksOptions ?? HooksOptions.HOOKS_INCLUSIVE
    );
    const forceMixed = request.forceMixed;
    const protocols = request.protocols
      .split(',')
      .map(p => EnumUtils.stringToEnum(Protocol, p));
    const experiment = options?.stableStableHookEnabled
      ? Experiment.GuideStar_Stable_Stable
      : undefined;
    const nsCtx = resolveNamespaces({
      protocols,
      hooksOptions,
      experiment,
      tokenInAddress: request.tokenInAddress,
      tokenOutAddress: request.tokenOutAddress,
      chainId: chain.chainId,
    });
    const namespaceLogFields = namespaceFieldsForLogging(
      nsCtx.allowedNamespaces
    );
    return {
      chain,
      tradeType,
      originalAmountIn,
      quoteType,
      hooksOptions,
      forceMixed,
      protocols,
      experiment,
      nsCtx,
      namespaceLogFields,
      debugLogs: request.debugLogs,
      portionBips: request.portionBips,
      portionRecipient: request.portionRecipient,
      requestBlockNumber: request.blockNumber,
      requestSource: options?.requestSource?.toLowerCase() || 'unknown',
    };
  }

  /**
   * Fetches the per-request data needed before route discovery: token
   * currency info (parallel), token metadata + block number + gas price
   * (parallel). Preserves the two-stage await pattern of the inline code.
   */
  private async fetchRequestData(
    ctx: Context,
    chain: Chain,
    request: QuoteRequest,
    requestBlockNumber: number | undefined,
    metricTags: string[]
  ) {
    // Start parallel token search operations
    const [tokenInCurrencyInfo, tokenOutCurrencyInfo] = await Promise.all([
      this.tokenProvider.searchForToken(chain, request.tokenInAddress, ctx),
      this.tokenProvider.searchForToken(chain, request.tokenOutAddress, ctx),
    ]);

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
          new Address(getGasToken(chain.chainId).address),
          ...(usdGasTokensByChain[chain.chainId] ?? []).map(
            t => new Address(t.address)
          ),
        ],
        ctx
      ),
      requestBlockNumber !== undefined
        ? Promise.resolve(requestBlockNumber)
        : this.serviceConfig.ResponseRequirements.NeedsBlockNumber
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

    return {
      tokenInCurrencyInfo,
      tokenOutCurrencyInfo,
      tokensInfo,
      blockNumber,
      gasPrice,
    };
  }

  /**
   * Reads the no-route negative cache and the positive route cache in
   * parallel, then resolves the interaction:
   *
   *   - If the negative cache says "no route at this amount" AND the
   *     positive cache returned nothing, short-circuit `quote()` with a
   *     404 (emit `NoRouteCache.Hit`, set `x-no-route-cache-hit`, push
   *     the `noRouteCacheHit` tag).
   *   - Otherwise, run the heavy post-processing on the cached-routes
   *     read result (refresh trigger, score/slice, summary log/metrics)
   *     and return its output for the caller to use as the route list.
   *
   * The parallel light read trades one extra Redis `ZRANGE` per
   * no-route-cache-hit request (an empty key, typically) for ~5ms p50
   * removed from the serial cache-check path. The positive cache wins
   * on conflicts because cached routes are per-USD-bucket positive
   * evidence, whereas no-route is per-amount-cliff negative evidence.
   */
  private async tryReadAndShortCircuitCache(
    ctx: Context,
    request: QuoteRequest,
    options: QuoteOptions | undefined,
    chain: Chain,
    tokenInCurrencyInfo: CurrencyInfo,
    tokenOutCurrencyInfo: CurrencyInfo,
    tradeType: TradeType,
    amountIn: bigint,
    usdBucket: UsdBucket,
    fineGrainedUsdBucket: UsdBucketFineGrained,
    quoteType: QuoteType,
    protocols: Protocol[],
    nsCtx: RouteNamespaceContext,
    metricTags: string[]
  ): Promise<
    | {shortCircuit: QuoteResponse}
    | {routes: RouteBasic<Pool>[]; usedCachedRoutes: boolean}
  > {
    // Transient Redis read failures are isolated inside readCachedRoutes
    // (per-key allSettled emits CachedRoutes.PerKeyReadFailed and degrades
    // to an empty per-key result). Any rejection that bubbles out here is
    // a configuration error (e.g. assertCacheableProtocols) and should
    // propagate — Promise.all matches that.
    const cacheReadStartTime = Date.now();
    const [amountCliff, readResult] = await Promise.all([
      this.noRouteCacheRepository.getAmountCliff(
        nsCtx,
        protocols,
        chain.chainId,
        tokenInCurrencyInfo.wrappedAddress,
        tokenOutCurrencyInfo.wrappedAddress,
        tradeType
      ),
      this.cachedRoutesRepository.readCachedRoutes(
        nsCtx,
        chain.chainId,
        tokenInCurrencyInfo,
        tokenOutCurrencyInfo,
        tradeType,
        amountIn,
        usdBucket,
        protocols,
        ctx
      ),
    ]);

    const noRouteCliffHit =
      amountCliff !== undefined && amountIn >= amountCliff;
    const hasCachedRoutes = readResult.totalValidRouteCount > 0;

    // Short-circuit only when both signals agree: no-route cliff hit AND
    // no positive cached evidence. If cached routes exist we prefer them —
    // they're keyed on the USD bucket, which is finer-grained than the
    // amount-cliff scalar.
    if (noRouteCliffHit && !hasCachedRoutes) {
      metricTags.push(`status:${QuoteStatus.NoRoute}`);
      metricTags.push('cachedRoutesStatus:noRouteCacheHit');
      await ctx.metrics.count(buildMetricKey('NoRouteCache.Hit'), 1, {
        tags: metricTags,
      });
      ctx.handlerContext.responseHeader.set('x-no-route-cache-hit', 'true');
      return {
        shortCircuit: new QuoteResponse({
          error: {
            code: 404,
            message: `No valid quotes found for pair ${request.tokenInAddress} -> ${request.tokenOutAddress}`,
          },
          hitsCachedRoutes: false,
          usdBucket: fineGrainedUsdBucket.toString(),
        }),
      };
    }

    // Tag the call-level metric so Datadog can break it down by final
    // status. `Call{noRouteCacheOverride:true}` counts requests where the
    // cliff was overridden by the positive cache; cross-tabbed with the
    // existing `status:` tag we get both the rescue rate (status:Success)
    // and the wasted-work rate (status:NoRoute) without a second metric.
    //
    // Caveat worth noting: the positive cache is keyed by USD bucket, not
    // by `amountIn`, so a cached route from a smaller trade in the same
    // bucket can override an amount-specific cliff. The downstream
    // on-chain quoter validates at the requested amount and drops routes
    // that can't actually serve it, so this trades latency (not
    // correctness) on genuinely-no-route requests.
    if (noRouteCliffHit && hasCachedRoutes) {
      metricTags.push('noRouteCacheOverride:true');
    }

    // Cache miss OR positive hit: run the heavy post-processing so the
    // refresh trigger and read-stage metrics fire whether or not we use
    // the routes. This matches the prior `getCachedRoutes` semantics.
    const routes = await this.cachedRoutesRepository.processCachedRoutesResult(
      readResult,
      nsCtx,
      chain.chainId,
      tradeType,
      amountIn,
      usdBucket,
      quoteType,
      protocols,
      request,
      ctx,
      options
    );

    // Preserve the pre-refactor `GetCachedRoutes` metric semantic:
    // fires only on the non-short-circuit path and brackets the full
    // cache pipeline (parallel reads + processing). Pre-refactor this
    // wrapped just the sequential `cachedRoutesRepository.getCachedRoutes`
    // call; the parallel-read + process structure is the equivalent
    // unit of work, so existing dashboards/alerts on this metric keep
    // their meaning.
    await logElapsedTime(
      'GetCachedRoutes',
      cacheReadStartTime,
      ctx,
      metricTags
    );

    return {routes, usedCachedRoutes: routes.length > 0};
  }

  /**
   * Caps the route list to `effectiveConfig.RouteFinder.MaxRoutes` (which
   * may be reduced on sync cache miss) and emits route-cap observability:
   * a debug log with before/after counts + dropped-route summaries, plus
   * `RouteCap.*` count metrics by total / protocol / hop count. Returns
   * the (possibly truncated) route list.
   */
  private async capRoutesAndObserve(
    ctx: Context,
    chain: Chain,
    tradeType: TradeType,
    quoteType: QuoteType,
    hooksOptions: HooksOptions,
    protocols: Protocol[],
    usedCachedRoutes: boolean,
    testAggHooks: boolean | undefined,
    routes: RouteBasic<Pool>[],
    effectiveConfig: IUniRouteServiceConfig
  ): Promise<RouteBasic<Pool>[]> {
    const routesBeforeEffectiveSlice = routes;
    const routeCapResult = capRoutesByAggHookClass(
      routes,
      effectiveConfig.RouteFinder.MaxRoutes,
      chain.chainId
    );
    const cappedRoutes = routeCapResult.routes;
    const beforeRouteCounts = routeSetCountsForLogging(
      routesBeforeEffectiveSlice,
      chain.chainId
    );
    const afterRouteCounts = routeSetCountsForLogging(
      cappedRoutes,
      chain.chainId
    );
    const retainedRoutes = new Set(cappedRoutes);
    ctx.logger.debug('Route cap observability', {
      chainId: chain.chainId,
      tradeType,
      quoteType,
      hooksOptions,
      protocols: protocols.join(',').toLowerCase(),
      cachedRoutesStatus: usedCachedRoutes ? 'hit' : 'miss',
      maxRoutes: effectiveConfig.RouteFinder.MaxRoutes,
      capMode: routeCapResult.usedAggHookPartition
        ? 'per_agg_hook_class'
        : 'global',
      noAggHookRoutesRetained: routeCapResult.noAggHookRoutesRetained,
      aggHookRoutesRetained: routeCapResult.aggHookRoutesRetained,
      routeFinderConfig:
        effectiveConfig !== this.serviceConfig ? 'reduced' : 'original',
      beforeSlice: beforeRouteCounts,
      afterSlice: afterRouteCounts,
      droppedRouteSummaries: summarizeRoutesForLogging(
        routesBeforeEffectiveSlice
          .filter(route => !retainedRoutes.has(route))
          .slice(0, 20),
        chain.chainId
      ).map(route => ({
        routeHash: route.routeHash,
        protocol: route.protocol,
        hopCount: route.hopCount,
        hasAggHookPool: route.hasAggHookPool,
      })),
    });
    const routeCapBaseTags = [
      `chain:${ChainId[chain.chainId]}`,
      `tradeType:${tradeType}`,
      `hooksOptions:${hooksOptions}`,
      `cachedRoutesStatus:${usedCachedRoutes ? 'hit' : 'miss'}`,
      `testAggHooks:${testAggHooks}`,
    ];
    const routeCapChainTag = `chain:${ChainId[chain.chainId]}`;
    const routeCapTestAggHooksTag = `testAggHooks:${testAggHooks}`;
    const capModeTag = `capMode:${
      routeCapResult.usedAggHookPartition ? 'per_agg_hook_class' : 'global'
    }`;
    await Promise.all([
      ctx.metrics.count(
        buildMetricKey('RouteCap.RoutesBeforeSlice.Total'),
        beforeRouteCounts.totalRoutes,
        {tags: routeCapBaseTags}
      ),
      ctx.metrics.count(
        buildMetricKey('RouteCap.RoutesAfterSlice.Total'),
        afterRouteCounts.totalRoutes,
        {tags: routeCapBaseTags}
      ),
      // Per-class retained-route counts. Existing
      // `RoutesAfterSlice.Total` reports total kept across classes; these
      // two split that total by class so we can see whether agg-hook
      // routing is correctly admitting full no-hook + additional
      // agg-hook (after PR #8301) vs the prior 50/50-split policy.
      // Emitted as distributions so DD can report avg/p50/p95/max per
      // request — the right shape for "how much room does no-hook
      // typically have" rather than total routes/sec.
      ctx.metrics.dist(
        buildMetricKey('RouteCap.NoHookRoutesRetained.dist'),
        routeCapResult.noAggHookRoutesRetained,
        {tags: [...routeCapBaseTags, capModeTag]}
      ),
      ctx.metrics.dist(
        buildMetricKey('RouteCap.AggHookRoutesRetained.dist'),
        routeCapResult.aggHookRoutesRetained,
        {tags: [...routeCapBaseTags, capModeTag]}
      ),
      // Count of cap decisions split by mode — lets us answer "how
      // often does the partition branch actually fire" in DD without
      // having to dig debug logs.
      ctx.metrics.count(buildMetricKey('RouteCap.Decision'), 1, {
        tags: [...routeCapBaseTags, capModeTag],
      }),
      ...Object.entries(beforeRouteCounts.routesByProtocol).map(
        ([protocol, count]) =>
          ctx.metrics.count(
            buildMetricKey('RouteCap.RoutesBeforeSlice.ByProtocol'),
            count,
            {
              tags: [
                routeCapChainTag,
                routeCapTestAggHooksTag,
                `protocol:${protocol.toLowerCase()}`,
              ],
            }
          )
      ),
      ...Object.entries(afterRouteCounts.routesByProtocol).map(
        ([protocol, count]) =>
          ctx.metrics.count(
            buildMetricKey('RouteCap.RoutesAfterSlice.ByProtocol'),
            count,
            {
              tags: [
                routeCapChainTag,
                routeCapTestAggHooksTag,
                `protocol:${protocol.toLowerCase()}`,
              ],
            }
          )
      ),
      ...Object.entries(beforeRouteCounts.routesByHopCount).map(
        ([hopCount, count]) =>
          ctx.metrics.count(
            buildMetricKey('RouteCap.RoutesBeforeSlice.ByHopCount'),
            count,
            {
              tags: [
                routeCapChainTag,
                routeCapTestAggHooksTag,
                `hopCount:${hopCount}`,
              ],
            }
          )
      ),
      ...Object.entries(afterRouteCounts.routesByHopCount).map(
        ([hopCount, count]) =>
          ctx.metrics.count(
            buildMetricKey('RouteCap.RoutesAfterSlice.ByHopCount'),
            count,
            {
              tags: [
                routeCapChainTag,
                routeCapTestAggHooksTag,
                `hopCount:${hopCount}`,
              ],
            }
          )
      ),
    ]);
    return cappedRoutes;
  }

  /**
   * Fetches fresh routes from the route repository when no cached routes
   * are available. `skipPoolsForTokensCache` is true when hooks are not
   * inclusive — the resulting pool list may differ from the cached version.
   */
  private async fetchFreshRoutes(
    ctx: Context,
    chain: Chain,
    tokenInCurrencyInfo: CurrencyInfo,
    tokenOutCurrencyInfo: CurrencyInfo,
    protocols: Protocol[],
    tradeType: TradeType,
    fotInDirectSwap: boolean,
    hooksOptions: HooksOptions,
    nsCtx: RouteNamespaceContext,
    testAggHooks: boolean | undefined,
    metricTags: string[]
  ): Promise<RouteBasic<Pool>[]> {
    const skipPoolsForTokensCache =
      hooksOptions !== HooksOptions.HOOKS_INCLUSIVE;
    const getRoutesStartTime = Date.now();
    ctx.logger.debug('Starting getRoutes');
    const routes = await this.routeRepository.getRoutes(
      chain,
      tokenInCurrencyInfo,
      tokenOutCurrencyInfo,
      protocols,
      tradeType,
      fotInDirectSwap,
      hooksOptions,
      skipPoolsForTokensCache,
      nsCtx,
      ctx,
      testAggHooks
    );
    await logElapsedTime('GetRoutes', getRoutesStartTime, ctx, metricTags);
    return routes;
  }

  /**
   * On sync cache miss, returns a config with reduced RouteFinder search
   * space for lower latency when the protocol set is incomplete (missing
   * one of v2/v3/v4/mixed, or external-only). Requests that include the
   * full Uniswap-native set fall through to the unmodified service config
   * regardless of whether external protocols are also present.
   */
  private selectEffectiveConfig(
    usedCachedRoutes: boolean,
    protocols: Protocol[]
  ): IUniRouteServiceConfig {
    if (
      !usedCachedRoutes &&
      this.serviceConfig.Lambda.Type === LambdaType.Sync &&
      this.serviceConfig.QuoteService === QuoteService.UniRoute &&
      !allUniswapNativeProtocolsIncludedAndMixed(protocols)
    ) {
      return {
        ...this.serviceConfig,
        RouteFinder: {
          ...this.serviceConfig.RouteFinder,
          ...getUniRouteSyncCacheMissRouteFinderOverrides(),
        },
      };
    }
    return this.serviceConfig;
  }

  /**
   * Drops routes that fail structural validity (wrong chain, native-token
   * misuse, etc.). Always emits the `InvalidRoutesFiltered` count metric;
   * also emits a debug log when any routes were dropped.
   */
  private async filterInvalidRoutes(
    ctx: Context,
    routes: RouteBasic<Pool>[],
    chain: Chain,
    tokenInCurrencyInfo: CurrencyInfo,
    tokenOutCurrencyInfo: CurrencyInfo,
    metricTags: string[]
  ): Promise<RouteBasic<Pool>[]> {
    const unfilteredRoutesLength = routes.length;
    const invalidRoutes: string[] = [];
    const filteredRoutes = routes.filter(r => {
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
      {tags: metricTags}
    );
    if (unfilteredRoutesLength !== filteredRoutes.length) {
      ctx.logger.debug('Filtered out invalid routes', {
        unfilteredRoutesLength,
        filteredRoutesLength: filteredRoutes.length,
        invalidRoutes,
      });
    }
    return filteredRoutes;
  }

  /**
   * For EXACT_OUT only, drops routes whose intermediary pools contain FOT
   * tokens. Direct-swap FOT tokens are already rejected upstream; this
   * handles multi-hop routes routing through an intermediary FOT token.
   */
  private async filterFotIntermediaryRoutes(
    ctx: Context,
    chain: Chain,
    routes: RouteBasic<Pool>[],
    tokenInCurrencyInfo: CurrencyInfo,
    tokenOutCurrencyInfo: CurrencyInfo,
    tokensInfo: Map<string, Erc20Token | null>
  ): Promise<RouteBasic<Pool>[]> {
    const preFilterCount = routes.length;
    const {filteredRoutes, fotIntermediaryTokens} =
      await filterRoutesWithFotIntermediaryTokens(
        routes,
        tokenInCurrencyInfo.wrappedAddress.toString(),
        tokenOutCurrencyInfo.wrappedAddress.toString(),
        tokensInfo,
        this.tokenHandler,
        chain,
        ctx
      );
    if (fotIntermediaryTokens.size > 0) {
      ctx.logger.debug(
        'Filtered routes with intermediary FOT tokens for EXACT_OUT',
        {
          preFilterCount,
          postFilterCount: filteredRoutes.length,
          fotIntermediaryTokens: Array.from(fotIntermediaryTokens),
        }
      );
    }
    return filteredRoutes;
  }

  /**
   * Restricts routes to MIXED-protocol only when `forceMixed` is set. If
   * no mixed routes survive, returns a 404 response for the caller to
   * propagate (after emitting call metrics).
   */
  private enforceForceMixed(
    ctx: Context,
    request: QuoteRequest,
    routes: RouteBasic<Pool>[],
    debugLogs: boolean,
    usedCachedRoutes: boolean,
    fineGrainedUsdBucket: UsdBucketFineGrained
  ): {
    routes: RouteBasic<Pool>[];
    forceMixedNoRouteResponse?: QuoteResponse;
  } {
    ctx.logger.debug('Forcing mixed routes');
    const filteredRoutes = routes.filter(r => r.protocol === Protocol.MIXED);
    if (filteredRoutes.length === 0) {
      ctx.logger.debug('No routes found');
      return {
        routes: filteredRoutes,
        forceMixedNoRouteResponse: new QuoteResponse({
          error: {
            code: 404,
            message: `No mixed valid routes found for pair ${request.tokenInAddress} -> ${request.tokenOutAddress}`,
          },
          hitsCachedRoutes: usedCachedRoutes,
          usdBucket: fineGrainedUsdBucket.toString(),
          debugInfo: debugLogs
            ? this.constructDebugInfo(filteredRoutes, [])
            : undefined,
        }),
      };
    }
    return {routes: filteredRoutes};
  }

  /**
   * Runs the four-stage quote pipeline against the prepared routes:
   *   1. Strategy: enumerate quote candidates from the route set.
   *   2. Gas adjustment: compute USD-denominated gas costs per candidate
   *      (skipped when GasEstimation is disabled).
   *   3. Selector: pick the top N candidates worth simulating.
   *   4. Simulation: simulate each top candidate in order until one
   *      succeeds, returning the chosen `bestQuote` (or `undefined` if
   *      none simulated successfully or no candidates existed).
   *
   * Returns both the full candidate list (needed downstream for debug
   * info) and the simulated best quote.
   */
  private async runQuotePipeline(
    ctx: Context,
    chain: Chain,
    tokenInCurrencyInfo: CurrencyInfo,
    tokenOutCurrencyInfo: CurrencyInfo,
    amountIn: bigint,
    tradeType: TradeType,
    protocols: Protocol[],
    effectiveConfig: IUniRouteServiceConfig,
    routes: RouteBasic<Pool>[],
    tokensInfo: Map<string, Erc20Token | null>,
    request: QuoteRequest,
    options: QuoteOptions | undefined,
    metricTags: string[],
    requestBlockNumber: number | undefined,
    gasPrice: bigint | undefined,
    resolvedStateOverrides: ResolvedStateOverride[] | undefined
  ): Promise<{
    bestQuoteCandidates: QuoteSplit[];
    bestQuote: QuoteSplit | undefined;
  }> {
    const bestQuoteCandidates =
      await this.quoteStrategy.findBestQuoteCandidates(
        ctx,
        chain,
        tokenInCurrencyInfo,
        tokenOutCurrencyInfo,
        amountIn,
        tradeType,
        protocols,
        effectiveConfig,
        routes,
        tokensInfo,
        metricTags,
        requestBlockNumber,
        options?.testAggHooks
      );

    ctx.logger.debug(`Best Quote Candidates (${bestQuoteCandidates.length}):`, {
      candidates: bestQuoteCandidates.map(candidate => ({
        route: candidate.quotes.map(q => ({
          routeString: q.route.toString(),
          amount: q.amount.toString(),
        })),
      })),
    });

    if (this.serviceConfig.GasEstimation.Enabled) {
      const startGasUpdateTime = Date.now();
      await this.gasConverter.updateQuotesGasDetails(
        chain.chainId,
        tradeType === TradeType.ExactIn
          ? tokenOutCurrencyInfo.wrappedAddress.toString()
          : tokenInCurrencyInfo.wrappedAddress.toString(),
        tokensInfo,
        bestQuoteCandidates,
        ctx,
        requestBlockNumber
      );
      await logElapsedTime(
        'UpdateQuotesGasDetails',
        startGasUpdateTime,
        ctx,
        metricTags
      );
    }

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

    // Pass requestBlockNumber (not the resolved blockNumber) to simulation.
    // When the user doesn't provide a block number, requestBlockNumber is
    // undefined, which causes simulation backends (Tenderly, eth_estimateGas)
    // to use 'latest'. The resolved blockNumber is only used for the response
    // and for pool/quote fetching.
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
      requestBlockNumber,
      options?.permit2Disabled ?? false,
      options?.universalRouterVersion,
      resolvedStateOverrides
    );

    return {bestQuoteCandidates, bestQuote};
  }

  /**
   * Emits the GuideStar Stable-Stable experiment metric when the request
   * opted into the experiment, tagging whether the chosen route actually
   * traversed a GuideStar hook pool.
   */
  private async emitGuideStarMetricIfApplicable(
    ctx: Context,
    chain: Chain,
    bestQuote: QuoteSplit,
    options: QuoteOptions | undefined,
    metricTags: string[]
  ): Promise<void> {
    if (!options?.stableStableHookEnabled) {
      return;
    }
    const guideStarHookAddresses = new Set(
      (EXPERIMENT_HOOKS[Experiment.GuideStar_Stable_Stable] ?? []).map(addr =>
        addr.toLowerCase()
      )
    );
    const matched = bestQuote.quotes.some(quote =>
      quote.route.path.some(
        pool =>
          pool instanceof V4Pool &&
          pool.hooks !== undefined &&
          guideStarHookAddresses.has(pool.hooks.toLowerCase())
      )
    );
    await ctx.metrics.count(
      buildMetricKey('BestQuote.GuideStarStableStableHookMatch'),
      1,
      {
        tags: [...metricTags, `chainId:${chain.chainId}`, `matched:${matched}`],
      }
    );
  }

  /**
   * Walks the best quote's pools looking for agg-hook pools. For each one
   * found, emits either `BestQuote.AggHookPoolLeak` (unexpected: pool is in
   * the route but the request didn't authorise external protocols / test
   * agg hooks) or `BestQuote.AggHookPoolExpected` (expected: agg hooks are
   * being exercised intentionally).
   */
  private async emitAggHookLeakMetrics(
    ctx: Context,
    chain: Chain,
    bestQuote: QuoteSplit,
    protocols: Protocol[],
    usedCachedRoutes: boolean,
    options: QuoteOptions | undefined,
    metricTags: string[]
  ): Promise<void> {
    for (const quote of bestQuote.quotes) {
      const aggHookPool = quote.route.path.find(
        pool =>
          pool instanceof V4Pool &&
          pool.hooks &&
          getProtocolForAggHookAddress(pool.hooks, chain.chainId) !== undefined
      ) as V4Pool | undefined;
      if (!aggHookPool) {
        continue;
      }
      if (!isExternalProtocol(protocols) || !options?.testAggHooks) {
        ctx.logger.warn('Best quote route contains unexpected agg hook pool', {
          chainId: chain.chainId,
          hooksAddress: aggHookPool.hooks,
          hitsCachedRoutes: usedCachedRoutes,
          protocols,
          ...metricTags,
          testAggHooks: options?.testAggHooks,
        });
        await ctx.metrics.count(
          buildMetricKey('BestQuote.AggHookPoolLeak'),
          1,
          {
            tags: [
              ...metricTags,
              `hitsCachedRoutes:${usedCachedRoutes}`,
              `testAggHooks:${options?.testAggHooks}`,
            ],
          }
        );
      } else {
        await ctx.metrics.count(
          buildMetricKey('BestQuote.AggHookPoolExpected'),
          1,
          {
            tags: [
              ...metricTags,
              `hitsCachedRoutes:${usedCachedRoutes}`,
              `testAggHooks:${options?.testAggHooks}`,
            ],
          }
        );
      }
    }
  }

  /**
   * Refreshes the best quote's pool details when the response contract
   * requires up-to-date pools AND simulation didn't already refresh them.
   * Simulation (when it ran with status SUCCESS or FAILED) already calls
   * `updateQuoteSplitWithFreshPoolDetails` internally, so a second refresh
   * here would be redundant.
   */
  private async refreshBestQuotePoolDetailsIfNeeded(
    ctx: Context,
    chain: Chain,
    bestQuote: QuoteSplit,
    metricTags: string[],
    requestBlockNumber: number | undefined
  ): Promise<void> {
    const poolsAlreadyFresh =
      bestQuote.simulationResult?.status !== undefined &&
      bestQuote.simulationResult?.status !== SimulationStatus.UNATTEMPTED;
    if (
      !this.serviceConfig.ResponseRequirements.NeedsUpToDatePoolsInfo ||
      poolsAlreadyFresh
    ) {
      return;
    }
    const startUpdatePoolsTime = Date.now();
    await updateQuoteSplitWithFreshPoolDetails(
      this.freshPoolDetailsWrapper,
      bestQuote,
      chain,
      ctx,
      metricTags,
      requestBlockNumber
    );
    await logElapsedTime(
      'MainUpdateBestQuotePoolsWithFreshDetails',
      startUpdatePoolsTime,
      ctx,
      metricTags
    );
  }

  /**
   * Async-mode dispatcher for cache writes. Centralises the
   * `Lambda.Type === Async` gate so the inner helpers focus on their own
   * conditions. Picks the writer based on `status`: a NoRoute outcome
   * persists the negative cache, a successful outcome persists the route
   * cache. No-op when running in sync mode.
   */
  private async writeCachesIfAsync(
    status: QuoteStatus,
    bestQuote: QuoteSplit | undefined,
    ctx: Context,
    chain: Chain,
    tokenInCurrencyInfo: CurrencyInfo,
    tokenOutCurrencyInfo: CurrencyInfo,
    tradeType: TradeType,
    amountIn: bigint,
    usdBucket: UsdBucket,
    quoteType: QuoteType,
    hooksOptions: HooksOptions,
    protocols: Protocol[],
    nsCtx: RouteNamespaceContext,
    namespaceLogFields: ReturnType<typeof namespaceFieldsForLogging>,
    usedCachedRoutes: boolean,
    shouldCheckCache: boolean,
    options: QuoteOptions | undefined,
    metricTags: string[]
  ): Promise<void> {
    if (this.serviceConfig.Lambda.Type !== LambdaType.Async) {
      return;
    }
    if (status === QuoteStatus.NoRoute) {
      await this.maybeWriteNoRouteCache(
        ctx,
        chain,
        tokenInCurrencyInfo,
        tokenOutCurrencyInfo,
        tradeType,
        amountIn,
        usdBucket,
        protocols,
        nsCtx,
        usedCachedRoutes,
        shouldCheckCache,
        metricTags
      );
    } else {
      await this.maybeWriteRouteCache(
        ctx,
        chain,
        tokenInCurrencyInfo,
        tokenOutCurrencyInfo,
        tradeType,
        amountIn,
        usdBucket,
        quoteType,
        hooksOptions,
        protocols,
        nsCtx,
        namespaceLogFields,
        usedCachedRoutes,
        options,
        bestQuote
      );
    }
  }

  /**
   * No-route negative cache write. Called from the async dispatcher only.
   * When a deep search confirms no route exists at this amount and the
   * cache key wasn't already responsible for the hit, set the amount cliff
   * so future sync requests at this amount or higher can short-circuit
   * without re-running the search. Also clears the pending refresh marker
   * so the next sync request at a *lower* amount can trigger a fresh
   * refresh and ratchet the cliff down.
   */
  private async maybeWriteNoRouteCache(
    ctx: Context,
    chain: Chain,
    tokenInCurrencyInfo: CurrencyInfo,
    tokenOutCurrencyInfo: CurrencyInfo,
    tradeType: TradeType,
    amountIn: bigint,
    usdBucket: UsdBucket,
    protocols: Protocol[],
    nsCtx: RouteNamespaceContext,
    usedCachedRoutes: boolean,
    shouldCheckCache: boolean,
    metricTags: string[]
  ): Promise<void> {
    if (usedCachedRoutes || !shouldCheckCache) {
      return;
    }
    const wrote = await this.noRouteCacheRepository.setAmountCliff(
      nsCtx,
      protocols,
      chain.chainId,
      tokenInCurrencyInfo.wrappedAddress,
      tokenOutCurrencyInfo.wrappedAddress,
      tradeType,
      amountIn
    );
    if (wrote) {
      await ctx.metrics.count(buildMetricKey('NoRouteCache.Set'), 1, {
        tags: metricTags,
      });
    }
    // Clear pending refresh so the next sync request at a lower amount
    // can trigger a new async refresh to ratchet down the amountCliff.
    await this.cachedRoutesRepository.deletePendingRefresh(
      nsCtx,
      protocols,
      chain.chainId,
      tokenInCurrencyInfo.wrappedAddress,
      tokenOutCurrencyInfo.wrappedAddress,
      tradeType,
      amountIn,
      usdBucket
    );
  }

  /**
   * Best-quote route cache write. Called from the async dispatcher only.
   * When the deep search produced a non-failed simulation result, persist
   * each constituent route into the bucketed cache so future sync requests
   * for this token-pair / amount bucket can use them. No-op when caching
   * is disabled, when the request used cached routes (avoid double-write),
   * when external protocols are present without `AggHooksWriteEnabled`,
   * or when simulation explicitly failed.
   *
   * Emits a `Cached route write observability` debug log + a
   * `CachedRoutes.WriteBestQuote` count metric tagged with simulation
   * status and a coarse route-count bucket.
   */
  private async maybeWriteRouteCache(
    ctx: Context,
    chain: Chain,
    tokenInCurrencyInfo: CurrencyInfo,
    tokenOutCurrencyInfo: CurrencyInfo,
    tradeType: TradeType,
    amountIn: bigint,
    usdBucket: UsdBucket,
    quoteType: QuoteType,
    hooksOptions: HooksOptions,
    protocols: Protocol[],
    nsCtx: RouteNamespaceContext,
    namespaceLogFields: ReturnType<typeof namespaceFieldsForLogging>,
    usedCachedRoutes: boolean,
    options: QuoteOptions | undefined,
    bestQuote: QuoteSplit | undefined
  ): Promise<void> {
    if (
      usedCachedRoutes ||
      // TODO: replace with requestedProtocolsToHitCache once we have enabled agg hooks caching write
      !(
        onlyUniswapProtocolsIncludedAndMixed(protocols) ||
        (allUniswapAndSomeExternalProtocolsAndMixed(protocols) &&
          this.serviceConfig.CachedRoutes.AggHooksWriteEnabled)
      ) ||
      bestQuote?.simulationResult?.status === SimulationStatus.FAILED ||
      !this.serviceConfig.CachedRoutes.Enabled
    ) {
      return;
    }
    const bestQuoteRouteCount = bestQuote!.quotes.length;
    const simulationStatusForTag =
      bestQuote?.simulationResult?.status !== undefined
        ? SimulationStatus[bestQuote.simulationResult.status]
        : 'none';
    const routeCountBucket =
      bestQuoteRouteCount === 0
        ? '0'
        : bestQuoteRouteCount === 1
          ? '1'
          : bestQuoteRouteCount <= 3
            ? '2-3'
            : bestQuoteRouteCount <= 5
              ? '4-5'
              : bestQuoteRouteCount <= 10
                ? '6-10'
                : '>10';
    ctx.logger.debug('Cached route write observability', {
      chainId: chain.chainId,
      tradeType,
      quoteType,
      hooksOptions,
      protocols: protocols.join(',').toLowerCase(),
      amountIn: amountIn.toString(),
      usdBucket,
      ...namespaceLogFields,
      bestQuoteRouteCount,
      simulationStatus: bestQuote?.simulationResult?.status,
      routeSummaries: bestQuote!.quotes.map(quote => {
        const routeSummary = summarizeRouteForLogging(
          quote.route,
          chain.chainId
        );
        return {
          routeHash: routeSummary.routeHash,
          routeString: routeSummary.routeString,
          protocol: routeSummary.protocol,
          percentage: routeSummary.percentage,
          hopCount: routeSummary.hopCount,
          poolIds: routeSummary.poolIds,
          hasAggHookPool: routeSummary.hasAggHookPool,
          aggHookPoolCount: routeSummary.aggHookPoolCount,
          quoteAmount: quote.amount.toString(),
          gasCostInQuoteToken:
            quote.gasDetails?.gasCostInQuoteToken?.toString(),
          gasUse: quote.gasDetails?.gasUse.toString(),
        };
      }),
    });
    await ctx.metrics.count(buildMetricKey('CachedRoutes.WriteBestQuote'), 1, {
      tags: [
        `chain:${ChainId[chain.chainId]}`,
        `tradeType:${tradeType}`,
        `simulationStatus:${simulationStatusForTag}`,
        `routeCountBucket:${routeCountBucket}`,
        `testAggHooks:${options?.testAggHooks}`,
      ],
    });
    await Promise.all(
      bestQuote!.quotes.map(quote =>
        this.cachedRoutesRepository.saveCachedRoutes(
          nsCtx,
          protocols,
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
          usdBucket,
          ctx,
          options?.testAggHooks
        )
      )
    );
    await this.cachedRoutesRepository.deletePendingRefresh(
      nsCtx,
      protocols,
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
            // Admin endpoint operates on the base (pure-Uniswap) keyspace —
            // specialised namespaces aren't surfaced here. See ROUTE-1103
            // (payload will accept nsCtx when we expand).
            EMPTY_NAMESPACE_CONTEXT,
            chain.chainId,
            tokenInCurrencyInfo,
            tokenOutCurrencyInfo,
            tradeType,
            amountIn,
            usdBucket,
            QuoteType.Fresh,
            // TODO: https://linear.app/uniswap/issue/ROUTE-1103/tech-debt-admin-getcachedroutes-request-payload-to-modify-to-accept
            [...UNISWAP_NATIVE_PROTOCOLS], // All protocols
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

      // Delete cached routes (default: standard Uniswap+V4+MIXED set used for bucketed cache keys)
      const success = await this.cachedRoutesRepository.deleteCachedRoutes(
        ctx,
        EMPTY_NAMESPACE_CONTEXT,
        // TODO: https://linear.app/uniswap/issue/ROUTE-1102/tech-debt-deletecachedroutes-admin-endpoint-request-payload-needs-to
        [Protocol.V2, Protocol.V3, Protocol.V4, Protocol.MIXED],
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
    let finalGasUseEstimateUSD = gasCostInUSD;
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
      finalGasUseEstimateUSD =
        quoteSplit.simulationResult.estimatedGasUsedInUSD;

      ctx.logger.debug(
        'Simulation succeeded - updating quoteGasAdjusted amount',
        {
          quoteGasAdjusted: quoteGasAdjusted.toString(),
          finalQuoteGasAdjusted: finalQuoteGasAdjusted.toString(),
        }
      );
    }

    // TODO: ROUTE-1002 -investigate uniroute InsufficienToken tenderly simulation error
    //       ROUTE-1003 -fix uniroute to port gas estimate heurisitcs from routing
    if (quoteSplit.simulationResult?.status === SimulationStatus.FAILED) {
      finalGasUseEstimate = CHAIN_TO_GAS_LIMIT_MAP[chain.chainId].toBigInt();

      // Scale gas quote token and USD estimates proportionally based on the hardcoded chain gas limit
      if (totalGasUse > 0n) {
        finalGasUseEstimateQuote =
          (gasCostInQuoteToken * finalGasUseEstimate) / totalGasUse;
        finalGasUseEstimateUSD =
          (gasCostInUSD * Number(finalGasUseEstimate)) / Number(totalGasUse);
      }

      // TODO: estimatedGasUsedInQuoteToken might go negative (https://linear.app/uniswap/issue/ROUTE-453)
      if (tradeType === TradeType.ExactIn) {
        finalQuoteGasAdjusted = totalQuoteAmount - finalGasUseEstimateQuote;
      } else {
        finalQuoteGasAdjusted = totalQuoteAmount + finalGasUseEstimateQuote;
      }

      ctx.logger.debug('Simulation failed - updating quoteGasAdjusted amount', {
        quoteGasAdjusted: quoteGasAdjusted.toString(),
        finalQuoteGasAdjusted: finalQuoteGasAdjusted.toString(),
      });
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

    const quoteGasAndPortionAdjusted = getQuoteGasAndPortionAdjusted(
      tradeType,
      finalQuoteGasAdjusted,
      portionAmount
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

    const quoteGasAndPortionAdjustedDecimals = quoteGasAndPortionAdjusted
      ? CurrencyAmount.fromRawAmount(
          tradeType === TradeType.ExactIn ? tokenOut : tokenIn,
          quoteGasAndPortionAdjusted.toString()
        )
      : undefined;

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
        if (p.protocol === Protocol.V2) {
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
        } else if (p.protocol === Protocol.V3) {
          const v3Pool = p as V3Pool;
          extraPoolInfo = {
            liquidity: v3Pool.liquidity.toString(),
            fee: v3Pool.fee.toString(),
            tickCurrent: v3Pool.tickCurrent.toString(),
            // populate both sqrtPriceX96 and sqrtRatioX96 for backward compatibility
            sqrtPriceX96: v3Pool.sqrtPriceX96.toString(),
            sqrtRatioX96: v3Pool.sqrtPriceX96.toString(),
          };
        } else if (p.protocol === Protocol.V4) {
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
    const filteredAllPools = allPools.map((pools, quoteIndex) => {
      const filtered = pools.filter(pool => {
        // Skip fake eth/weth V4 pools with fake tick spacing
        if (
          pool.type === protocolToPoolTypeString(Protocol.V4) &&
          pool.tickSpacing === FAKE_TICK_SPACING.toString()
        ) {
          return false;
        }
        return true; // Keep this pool
      });

      if (filtered.length === 0) return filtered;

      const quote = quoteSplit.quotes[quoteIndex];

      // If the original first pool was a fake pool (filtered out), the new first
      // pool won't have amountIn populated — re-assign it here.
      const firstPool = filtered[0];
      if (!firstPool.amountIn) {
        firstPool.amountIn =
          tradeType === TradeType.ExactIn
            ? quoteAmountsIn[quoteIndex].toString()
            : quote.amount.toString();
      }

      // If the original last pool was a fake pool (filtered out), the new last
      // pool won't have amountOut populated — re-assign it here.
      const lastPool = filtered[filtered.length - 1];
      if (!lastPool.amountOut) {
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
        lastPool.amountOut =
          tradeType === TradeType.ExactIn
            ? (quote.amount - routePortionAmount).toString()
            : quoteAmountsIn[quoteIndex].toString();
      }

      return filtered;
    });

    // Finally construct and return the QuoteResponse
    const quoteResponse = new QuoteResponse({
      blockNumber: blockNumber.toString(),
      quoteAmount: correctedQuote.toString(),
      quoteAmountDecimals: correctedQuoteDecimals.toExact(),
      quoteGasAdjusted: correctedQuoteGasAdjusted.toString(),
      quoteGasAdjustedDecimals: correctedQuoteGasAdjustedDecimals.toExact(),
      quoteGasAndPortionAdjusted: quoteGasAndPortionAdjusted?.toString(),
      quoteGasAndPortionAdjustedDecimals:
        quoteGasAndPortionAdjustedDecimals?.toExact(),
      gasPriceWei: gasPriceWei?.toString(),
      gasUseEstimate: finalGasUseEstimate.toString(),
      gasUseEstimateQuote: finalGasUseEstimateQuote.toString(),
      gasUseEstimateQuoteDecimals: finalGasUseEstimateQuoteDecimals.toExact(),
      gasUseEstimateUSD: finalGasUseEstimateUSD.toString(),
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
          quoteGasAndPortionAdjusted: quoteResponse.quoteGasAndPortionAdjusted,
          quoteGasAndPortionAdjustedDecimals:
            quoteResponse.quoteGasAndPortionAdjustedDecimals,
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

  private constructDebugInfo(
    routes: RouteBasic<Pool>[],
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
    blockNumber?: number,
    permit2Disabled: boolean = false,
    universalRouterVersion?: UniversalRouterVersion,
    resolvedStateOverrides?: ResolvedStateOverride[]
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

    let swapOptions: SwapOptionsUniversalRouter | undefined;

    const swapOptionsInput = {
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
      permit2Disabled: permit2Disabled,
      tokenInIsNative: tokenInCurrencyInfo.isNative,
    };

    if (
      universalRouterVersion === undefined ||
      universalRouterVersion === UniversalRouterVersion.V2_0
    ) {
      swapOptions =
        SwapOptionsFactory.createUniversalRouterOptions_2_0(swapOptionsInput);
    } else if (universalRouterVersion === UniversalRouterVersion.V2_1_1) {
      swapOptions =
        SwapOptionsFactory.createUniversalRouterOptions_2_1_1(swapOptionsInput);
    } else if (request.simulateFromAddress) {
      ctx.logger.warn(
        'Simulation skipped: universalRouterVersion does not support simulation',
        {
          universalRouterVersion,
        }
      );
      await ctx.metrics.count(
        buildMetricKey('SimulationSkippedByRouterVersion'),
        1,
        {
          tags: [
            ...metricTags,
            `routerVersion:${universalRouterVersion ?? 'undefined'}`,
          ],
        }
      );
    }

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
          metricTags,
          blockNumber
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
            quoteSplitRoutes: quoteSplit.quotes.map(q => q.route.toString()),
            quoteSplitAmounts: quoteSplit.quotes.map(q => q.amount.toString()),
            swapOptions: JSON.stringify(swapOptions),
            tradeInputAmount: trade.inputAmount.toExact(),
            tradeOutputAmount: trade.outputAmount.toExact(),
            tradeRoutes: trade.swaps.map(s =>
              s.route.path
                .map(p => ('address' in p ? p.address : p.symbol))
                .join(' -> ')
            ),
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
          blockNumber,
          resolvedStateOverrides
        );

        // Log simulation latency and status
        const simulationLatency = Date.now() - simulationStartTime;
        const simulationStatus =
          simulatedQuote.simulationResult?.status ??
          SimulationStatus.UNATTEMPTED;
        await ctx.metrics.dist(
          buildMetricKey('SimulationLatency.dist'),
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
            estimatedGasUsedInUSD: 0,
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
          estimatedGasUsedInUSD: 0,
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
    routes: RouteBasic<Pool>[],
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
