import {describe, expect, it, vi} from 'vitest';
import {buildTestContext} from '@uniswap/lib-testhelpers';
import {DeepQuoteStrategy} from './DeepQuoteStrategy';
import {IQuoteFetcher} from '../../stores/quote/IQuoteFetcher';
import {Chain} from '../../models/chain/Chain';
import {Address} from '../../models/address/Address';
import {QuoteBasic} from '../../models/quote/QuoteBasic';
import {RouteBasic} from '../../models/route/RouteBasic';
import {TradeType} from '../../models/quote/TradeType';
import {Protocol} from '../../models/pool/Protocol';
import {SimpleQuoteSelector} from '../quote/selector/SimpleQuoteSelector';
import {Pool} from '../../models/pool/Pool';
import {V2Pool} from '../../models/pool/V2Pool';
import {GasEstimateProvider} from '../gas/estimator/GasEstimateProvider';
import {NoGasEstimator} from '../gas/estimator/IGasEstimator';
import {ChainId, IUniRouteServiceConfig} from '../../lib/config';
import {JsonRpcProvider} from '@ethersproject/providers';
import {RouteQuoteAllocator} from '../route/RouteQuoteAllocator';
import {IGasConverter} from '../gas/converter/IGasConverter';
import {V3Pool} from '../../models/pool/V3Pool';
import {V4Pool} from '../../models/pool/V4Pool';
import {NativeCurrency} from '../../models/chain/NativeCurrency';
import {getUniRouteTestConfig} from '../../lib/config';
import {Context} from '@uniswap/lib-uni/context';
import {GasDetails} from '../../models/gas/GasDetails';
import {QuoteSplit} from '../../models/quote/QuoteSplit';
import {Erc20Token} from '../../models/token/Erc20Token';
import {BaseQuoteStrategy} from './BaseQuoteStrategy';
import {CurrencyInfo} from '../../models/currency/CurrencyInfo';
import {TokenHandlerMock} from '../../stores/token/TokenHandler.mock';
import {ITokenHandler} from '../../stores/token/ITokenHandler';
import {
  ArbitrumGasData,
  ArbitrumGasDataProvider,
} from '../gas/gas-data-provider';
import {BaseProvider} from '@ethersproject/providers';
import {IFreshPoolDetailsWrapper} from '../../stores/pool/FreshPoolDetailsWrapper';
import {UNISWAP_AGG_HOOK_ON_TEMPO} from '../../lib/poolCaching/util/aggHooksAddressesAllowlist';

// Create a test gas converter that properly sets gasCostInQuoteToken
class TestGasConverter implements IGasConverter {
  async updateQuotesGasDetails(
    chainId: ChainId,
    quoteTokenAddress: string,
    tokensInfo: Map<string, Erc20Token | null>,
    quotes: QuoteSplit[],
    ctx: Context
  ): Promise<void> {
    await this.updateQuoteBasicsGasDetails(
      chainId,
      quoteTokenAddress,
      tokensInfo,
      quotes.flatMap(split => split.quotes),
      ctx
    );
  }

  async updateQuoteBasicsGasDetails(
    chainId: ChainId,

    quoteTokenAddress: string,

    tokensInfo: Map<string, Erc20Token | null>,
    quotes: QuoteBasic[],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ctx: Context
  ): Promise<void> {
    for (const quote of quotes) {
      if (quote.gasDetails) {
        quote.gasDetails.gasCostInQuoteToken =
          quote.route.path[0].address.toString() ===
          '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640'
            ? BigInt('200000000') // $200 for first quote
            : BigInt('99000000'); // $99 for second quote
      }
    }
  }
}

// Create a test gas estimate provider that returns fixed values
class TestGasEstimateProvider extends GasEstimateProvider {
  constructor() {
    super(
      new Map<ChainId, JsonRpcProvider>(),
      new NoGasEstimator(),
      new NoGasEstimator(),
      new NoGasEstimator(),
      new NoGasEstimator()
    );
  }

  async getCurrentGasPrice(_ctx: Context, _chainId: ChainId): Promise<number> {
    return 30000000000; // 30 gwei
  }

  async estimateGas(
    serviceConfig: IUniRouteServiceConfig,
    tokenInCurrencyInfo: CurrencyInfo,
    tokenOutCurrencyInfo: CurrencyInfo,
    amountIn: bigint,
    chainId: ChainId,
    tokensInfo: Map<string, Erc20Token | null>,
    tradeType: TradeType,
    quote: QuoteBasic,
    ctx: Context,
    gasPriceWei?: number,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    l2GasData?: ArbitrumGasData
  ): Promise<GasDetails> {
    const gasPrice = gasPriceWei ?? 30000000000;
    return new GasDetails(
      BigInt(gasPrice), // gasPriceInWei
      BigInt('4500000000000000'), // gasCostInWei
      0.0045, // gasCostInEth
      BigInt('150000') // gasUse
    );
  }
}

class TestQuoteFetcher implements IQuoteFetcher {
  constructor(private readonly quotes: QuoteBasic[] = []) {}

  async fetchQuotes(
    chain: Chain,
    tokenInCurrencyInfo: CurrencyInfo,
    tokenOutCurrencyInfo: CurrencyInfo,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    amount: bigint,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    routes: RouteBasic[],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    tradeType: TradeType,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ctx: Context,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    metricTags?: string[],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    blockNumber?: number,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    tokensInfo?: Map<string, Erc20Token | null>
  ): Promise<QuoteBasic[]> {
    if (this.quotes.length > 0) {
      return this.quotes;
    }

    // Default behavior - return a simple quote
    return [
      new QuoteBasic(
        new RouteBasic(Protocol.V2, [
          new V2Pool(
            tokenInCurrencyInfo.wrappedAddress,
            tokenOutCurrencyInfo.wrappedAddress,
            new Address('0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640'),
            BigInt('1000000000000'),
            BigInt('1000000000000')
          ),
        ]),
        BigInt('1234567890'),
        undefined
      ),
    ];
  }
}

// Test factory function that creates a strategy instance
function createStrategy(
  strategyClass: new (
    quoteFetcher: IQuoteFetcher,
    gasEstimateProvider: GasEstimateProvider,
    gasConverter: IGasConverter,
    routeQuoteAllocator: RouteQuoteAllocator<Pool>,
    quoteSelector: SimpleQuoteSelector,
    tokenHandler: ITokenHandler,
    arbitrumGasDataProviders: Map<ChainId, ArbitrumGasDataProvider>,
    freshPoolDetailsWrapper: IFreshPoolDetailsWrapper
  ) => BaseQuoteStrategy,
  quotes: QuoteBasic[] = []
): BaseQuoteStrategy {
  const quoteFetcher = new TestQuoteFetcher(quotes);
  const gasEstimateProvider = new TestGasEstimateProvider();
  const testGasConverter = new TestGasConverter();
  const routeQuoteAllocator = new RouteQuoteAllocator();
  const quoteSelector = new SimpleQuoteSelector();
  const tokenHandler = new TokenHandlerMock();
  const arbitrumGasDataProviders = new Map<ChainId, ArbitrumGasDataProvider>([
    [
      ChainId.ARBITRUM,
      new ArbitrumGasDataProvider(new JsonRpcProvider() as BaseProvider),
    ],
  ]);
  const freshPoolDetailsWrapper = {} as IFreshPoolDetailsWrapper;

  return new strategyClass(
    quoteFetcher,
    gasEstimateProvider,
    testGasConverter,
    routeQuoteAllocator,
    quoteSelector,
    tokenHandler,
    arbitrumGasDataProviders,
    freshPoolDetailsWrapper
  );
}

// Test factory function that runs tests for a given strategy class
function runStrategyTests(
  strategyClass: new (
    quoteFetcher: IQuoteFetcher,
    gasEstimateProvider: GasEstimateProvider,
    gasConverter: IGasConverter,
    routeQuoteAllocator: RouteQuoteAllocator<Pool>,
    quoteSelector: SimpleQuoteSelector,
    tokenHandler: ITokenHandler,
    arbitrumGasDataProviders: Map<ChainId, ArbitrumGasDataProvider>,
    freshPoolDetailsWrapper: IFreshPoolDetailsWrapper
  ) => BaseQuoteStrategy
) {
  const ctx = buildTestContext();
  const serviceConfig = getUniRouteTestConfig();

  const chain = new Chain(
    ChainId.MAINNET,
    'Ethereum',
    NativeCurrency.ETH,
    new Address('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'),
    new Address('0x1F98431c8aD98523631AE4a59f267346ea31F984'),
    new Address('0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6'),
    new Address('0x5BA1e12693Dc8F9c48aAD8770482f4739bEeD696'),
    1000000,
    75,
    new Address('0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f')
  );

  const tokenInAddress = new Address(
    '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
  ); // WETH
  const tokenOutAddress = new Address(
    '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
  ); // USDC
  const amount = BigInt('1000000000000000000'); // 1 ETH
  const makeTempoAggPool = (): V4Pool =>
    new V4Pool(
      new Address('0x20C0000000000000000000000000000000000000'),
      new Address('0x20C000000000000000000000b9537d11c60E8b50'),
      500,
      10,
      UNISWAP_AGG_HOOK_ON_TEMPO,
      0n,
      '0xdb82e743b9d5986a72b2c3ed5ce8ea89bc24caa0c8c73cf6cbbfe8f817ed7b8a',
      79228162514264337593543950336n,
      0n
    );

  describe(strategyClass.name, () => {
    it('should find best quote for EXACT_IN', async () => {
      const strategy = createStrategy(strategyClass);

      const bestQuoteCandidates = await strategy.findBestQuoteCandidates(
        ctx,
        chain,
        new CurrencyInfo(false, tokenInAddress),
        new CurrencyInfo(false, tokenOutAddress),
        amount,
        TradeType.ExactIn,
        [Protocol.V2, Protocol.V3, Protocol.V4, Protocol.MIXED],
        serviceConfig,
        [
          new RouteBasic(Protocol.V2, [
            new V2Pool(
              tokenInAddress,
              tokenOutAddress,
              new Address('0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640'),
              BigInt('1000000000000'),
              BigInt('1000000000000')
            ),
          ]),
        ],
        new Map(),
        ['chain:MAINNET', 'tradeType:EXACT_IN']
      );

      expect(bestQuoteCandidates).toBeDefined();
      expect(bestQuoteCandidates.length).toBeGreaterThan(0);
      expect(bestQuoteCandidates[0].quotes[0].amount).equals(
        BigInt('1234567890')
      );
      expect(
        bestQuoteCandidates[0].quotes[0].route.path[0].address.toString()
      ).equals('0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640');
    });

    it('should return quotes sorted by gas-adjusted amount (EXACT_IN: raw - gasCostInQuoteToken)', async () => {
      const quotes = [
        new QuoteBasic(
          new RouteBasic(Protocol.V2, [
            new V2Pool(
              tokenInAddress,
              tokenOutAddress,
              new Address('0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640'),
              BigInt('1000000000000'),
              BigInt('1000000000000')
            ),
          ]),
          BigInt('2000000000'), // 2000 USDC output
          undefined
        ),
        new QuoteBasic(
          new RouteBasic(Protocol.V2, [
            new V2Pool(
              tokenInAddress,
              tokenOutAddress,
              new Address('0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8'),
              BigInt('1000000000000'),
              BigInt('1000000000000')
            ),
          ]),
          BigInt('1900000000'), // 1900 USDC output
          undefined
        ),
      ];

      const strategy = createStrategy(strategyClass, quotes);

      const bestQuoteCandidates = await strategy.findBestQuoteCandidates(
        ctx,
        chain,
        new CurrencyInfo(false, tokenInAddress),
        new CurrencyInfo(false, tokenOutAddress),
        amount,
        TradeType.ExactIn,
        [Protocol.V2],
        serviceConfig,
        [
          new RouteBasic(Protocol.V2, [quotes[0].route.path[0]]),
          new RouteBasic(Protocol.V2, [quotes[1].route.path[0]]),
        ],
        new Map(),
        ['chain:MAINNET', 'tradeType:EXACT_IN']
      );

      expect(bestQuoteCandidates).toBeDefined();
      expect(bestQuoteCandidates.length).toBeGreaterThan(0);

      // Gas-adjusted ranking (after this PR makes scoreAndSortCombinations
      // gas-aware):
      //   Quote-1 raw 2,000,000,000 − $200 gas (200,000,000) = 1,800,000,000
      //   Quote-2 raw 1,900,000,000 − $99 gas  ( 99,000,000) = 1,801,000,000
      // Quote-2 wins gas-adjusted despite having a lower raw amount —
      // exactly the property the new ranking gives us.
      expect(bestQuoteCandidates[0].quotes[0].amount).equals(
        BigInt('1900000000')
      );
      expect(
        bestQuoteCandidates[0].quotes[0].route.path[0].address.toString()
      ).equals('0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8');

      expect(bestQuoteCandidates[1].quotes[0].amount).equals(
        BigInt('2000000000')
      );
      expect(
        bestQuoteCandidates[1].quotes[0].route.path[0].address.toString()
      ).equals('0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640');
    });

    it('should handle mixed routes (V2 + V3)', async () => {
      const tokenMiddleAddress = new Address(
        '0x6B175474E89094C44Da98b954EedeAC495271d0F'
      ); // DAI
      const quotes = [
        new QuoteBasic(
          new RouteBasic(Protocol.MIXED, [
            new V2Pool(
              tokenInAddress,
              tokenMiddleAddress,
              new Address('0xA478c2975Ab1Ea89e8196811F51A7B7Ade33eB11'),
              BigInt('2000000000000'),
              BigInt('4000000000000')
            ),
            new V3Pool(
              tokenMiddleAddress,
              tokenOutAddress,
              500,
              new Address('0x5777d92f208679DB4b9778590Fa3CAB3aC9e2168'),
              BigInt('1000000000000'),
              BigInt('3000000000000'),
              BigInt('6000000000000')
            ),
          ]),
          BigInt('2000000000'), // 2000 USDC output
          undefined
        ),
      ];

      const strategy = createStrategy(strategyClass, quotes);

      const bestQuoteCandidates = await strategy.findBestQuoteCandidates(
        ctx,
        chain,
        new CurrencyInfo(false, tokenInAddress),
        new CurrencyInfo(false, tokenOutAddress),
        amount,
        TradeType.ExactIn,
        [Protocol.V2, Protocol.V3, Protocol.V4, Protocol.MIXED],
        serviceConfig,
        [
          new RouteBasic(Protocol.MIXED, [
            quotes[0].route.path[0],
            quotes[0].route.path[1],
          ]),
        ],
        new Map(),
        ['chain:MAINNET', 'tradeType:EXACT_IN']
      );

      expect(bestQuoteCandidates).toBeDefined();
      expect(bestQuoteCandidates.length).toBeGreaterThan(0);
      expect(bestQuoteCandidates[0].quotes[0].amount).equals(
        BigInt('2000000000')
      );
      expect(bestQuoteCandidates[0].quotes[0].route.path.length).equals(2);
      expect(bestQuoteCandidates[0].quotes[0].route.path[0].protocol).equals(
        Protocol.V2
      );
      expect(bestQuoteCandidates[0].quotes[0].route.path[1].protocol).equals(
        Protocol.V3
      );
      expect(
        bestQuoteCandidates[0].quotes[0].route.path[0].address.toString()
      ).equals('0xA478c2975Ab1Ea89e8196811F51A7B7Ade33eB11');
      expect(
        bestQuoteCandidates[0].quotes[0].route.path[1].address.toString()
      ).equals('0x5777d92f208679DB4b9778590Fa3CAB3aC9e2168');
    });

    describe('FetchQuotes latency instrumentation', () => {
      const metricTags = ['chain:MAINNET', 'tradeType:EXACT_IN'];
      const standardPool = () =>
        new V2Pool(
          tokenInAddress,
          tokenOutAddress,
          new Address('0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640'),
          BigInt('1000000000000'),
          BigInt('1000000000000')
        );

      it('emits agg-hook and standard arm latency when both arms run', async () => {
        const pool = standardPool();
        const standardQuote = new QuoteBasic(
          new RouteBasic(Protocol.V2, [pool], 100),
          BigInt('1234567890'),
          undefined
        );
        const strategy = createStrategy(strategyClass, [standardQuote]);
        const testCtx = buildTestContext();

        await strategy.findBestQuoteCandidates(
          testCtx,
          chain,
          new CurrencyInfo(false, tokenInAddress),
          new CurrencyInfo(false, tokenOutAddress),
          amount,
          TradeType.ExactIn,
          [Protocol.V2, Protocol.V4],
          serviceConfig,
          [
            new RouteBasic(Protocol.V4, [makeTempoAggPool()]),
            new RouteBasic(Protocol.V2, [pool]),
          ],
          new Map(),
          metricTags
        );

        const aggHookCall = testCtx.metrics.distStore.find(call =>
          call.metric_name.includes('FetchQuotes.AggHook.Latency.dist')
        );
        const standardCall = testCtx.metrics.distStore.find(call =>
          call.metric_name.includes('FetchQuotes.Standard.Latency.dist')
        );
        expect(aggHookCall?.opts?.tags).toEqual(metricTags);
        expect(standardCall?.opts?.tags).toEqual(metricTags);
      });

      it('does not emit agg-hook arm latency when no agg-hook routes run', async () => {
        const pool = standardPool();
        const standardQuote = new QuoteBasic(
          new RouteBasic(Protocol.V2, [pool], 100),
          BigInt('1234567890'),
          undefined
        );
        const strategy = createStrategy(strategyClass, [standardQuote]);
        const testCtx = buildTestContext();

        await strategy.findBestQuoteCandidates(
          testCtx,
          chain,
          new CurrencyInfo(false, tokenInAddress),
          new CurrencyInfo(false, tokenOutAddress),
          amount,
          TradeType.ExactIn,
          [Protocol.V2],
          serviceConfig,
          [new RouteBasic(Protocol.V2, [pool])],
          new Map(),
          metricTags
        );

        expect(
          testCtx.metrics.distStore.some(call =>
            call.metric_name.includes('FetchQuotes.AggHook.Latency.dist')
          )
        ).toBe(false);
        expect(
          testCtx.metrics.distStore.some(call =>
            call.metric_name.includes('FetchQuotes.Standard.Latency.dist')
          )
        ).toBe(true);
      });

      it('does not fail quote flow when arm latency metric emission rejects', async () => {
        const pool = standardPool();
        const standardQuote = new QuoteBasic(
          new RouteBasic(Protocol.V2, [pool], 100),
          BigInt('1234567890'),
          undefined
        );
        const strategy = createStrategy(strategyClass, [standardQuote]);
        const testCtx = buildTestContext();
        const dist = testCtx.metrics.dist.bind(testCtx.metrics);
        testCtx.metrics.dist = vi.fn((metricName, val, opts) => {
          if (
            metricName.includes('FetchQuotes.AggHook.Latency.dist') ||
            metricName.includes('FetchQuotes.Standard.Latency.dist')
          ) {
            return Promise.reject(new Error('metric failed'));
          }
          return dist(metricName, val, opts);
        });

        const bestQuoteCandidates = await strategy.findBestQuoteCandidates(
          testCtx,
          chain,
          new CurrencyInfo(false, tokenInAddress),
          new CurrencyInfo(false, tokenOutAddress),
          amount,
          TradeType.ExactIn,
          [Protocol.V2, Protocol.V4],
          serviceConfig,
          [
            new RouteBasic(Protocol.V4, [makeTempoAggPool()]),
            new RouteBasic(Protocol.V2, [pool]),
          ],
          new Map(),
          metricTags
        );

        expect(bestQuoteCandidates.length).toBeGreaterThan(0);
      });
    });

    describe('Quote-level dedupe', () => {
      // RouteFinder duplicates that slip past `BaseRoutesRepository.getRoutes`
      // would otherwise reach `percentageToSortedQuotes` as multiple quotes
      // with the same canonical route key at the same percentage. Diagnostic
      // logs on prod traffic showed this is widespread (up to 140 duplicate
      // quotes removed per request). The dedupe inside
      // `findBestQuoteCandidates` collapses them.
      const poolAddress = new Address(
        '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640'
      );
      const otherPoolAddress = new Address(
        '0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8'
      );

      const buildQuote = (
        pct: number,
        addr: Address,
        amount: bigint
      ): QuoteBasic =>
        new QuoteBasic(
          new RouteBasic(
            Protocol.V2,
            [
              new V2Pool(
                tokenInAddress,
                tokenOutAddress,
                addr,
                BigInt('1000000000000'),
                BigInt('1000000000000')
              ),
            ],
            pct
          ),
          amount,
          undefined
        );

      it('drops identical quotes at the same percentage and fires the dedupe log', async () => {
        // Two quotes with same protocol + path + percentage = same route key.
        // The strategy should keep one and drop the other.
        const dupedQuote = buildQuote(100, poolAddress, BigInt('2000000000'));
        const quotes = [
          dupedQuote,
          dupedQuote,
          buildQuote(100, otherPoolAddress, BigInt('1500000000')),
        ];
        const strategy = createStrategy(strategyClass, quotes);
        const testCtx = buildTestContext();

        const candidates = await strategy.findBestQuoteCandidates(
          testCtx,
          chain,
          new CurrencyInfo(false, tokenInAddress),
          new CurrencyInfo(false, tokenOutAddress),
          amount,
          TradeType.ExactIn,
          [Protocol.V2],
          serviceConfig,
          [new RouteBasic(Protocol.V2, [quotes[0].route.path[0]])],
          new Map(),
          ['chain:MAINNET', 'tradeType:EXACT_IN']
        );

        // The dedupe must fire — exactly one duplicate dropped.
        const dedupeLogs = testCtx.logger.outputs.filter(
          o => o.msg === 'DeepQuoteStrategy deduped duplicate quotes'
        );
        expect(dedupeLogs).toHaveLength(1);
        expect(dedupeLogs[0].extra).toMatchObject({
          beforeDedup: 3,
          afterDedup: 2,
          duplicatesRemoved: 1,
        });

        // The downstream percentage map (and thus the 100% candidates here)
        // must include the two distinct routes, not three near-identical
        // entries — the top-K budget downstream only had room for distinct
        // candidates after the dedupe.
        const seenAmounts = new Set(
          candidates.map(c => c.quotes[0]?.amount.toString())
        );
        expect(seenAmounts.has('2000000000')).toBe(true);
        expect(seenAmounts.has('1500000000')).toBe(true);
      });

      it('does not fire the dedupe log when all quotes are unique', async () => {
        const quotes = [
          buildQuote(100, poolAddress, BigInt('2000000000')),
          buildQuote(100, otherPoolAddress, BigInt('1500000000')),
        ];
        const strategy = createStrategy(strategyClass, quotes);
        const testCtx = buildTestContext();

        await strategy.findBestQuoteCandidates(
          testCtx,
          chain,
          new CurrencyInfo(false, tokenInAddress),
          new CurrencyInfo(false, tokenOutAddress),
          amount,
          TradeType.ExactIn,
          [Protocol.V2],
          serviceConfig,
          [new RouteBasic(Protocol.V2, [quotes[0].route.path[0]])],
          new Map(),
          ['chain:MAINNET', 'tradeType:EXACT_IN']
        );

        const dedupeLogs = testCtx.logger.outputs.filter(
          o => o.msg === 'DeepQuoteStrategy deduped duplicate quotes'
        );
        expect(dedupeLogs).toHaveLength(0);
      });

      it('only collapses duplicates within the same percentage bucket, not across percentages', async () => {
        // The same canonical path at different percentages is a different
        // route in the split-finder's eyes (the percentage is part of the
        // toString). Dedupe must keep both.
        const quoteAt100 = buildQuote(100, poolAddress, BigInt('2000000000'));
        const quoteAt50 = buildQuote(50, poolAddress, BigInt('1100000000'));
        const strategy = createStrategy(strategyClass, [quoteAt100, quoteAt50]);
        const testCtx = buildTestContext();

        await strategy.findBestQuoteCandidates(
          testCtx,
          chain,
          new CurrencyInfo(false, tokenInAddress),
          new CurrencyInfo(false, tokenOutAddress),
          amount,
          TradeType.ExactIn,
          [Protocol.V2],
          serviceConfig,
          [new RouteBasic(Protocol.V2, [quoteAt100.route.path[0]])],
          new Map(),
          ['chain:MAINNET', 'tradeType:EXACT_IN']
        );

        const dedupeLogs = testCtx.logger.outputs.filter(
          o => o.msg === 'DeepQuoteStrategy deduped duplicate quotes'
        );
        expect(dedupeLogs).toHaveLength(0);
      });
    });
  });
}

// Run tests for each strategy implementation
describe('Quote Strategies', () => {
  runStrategyTests(DeepQuoteStrategy);
  // add more strategies here
});
