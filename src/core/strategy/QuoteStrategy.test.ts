import {describe, expect, it} from 'vitest';
import {buildTestContext} from '@uniswap/lib-testhelpers';
import {DeepQuoteStrategy} from './DeepQuoteStrategy';
import {IQuoteFetcher} from '../../stores/quote/IQuoteFetcher';
import {Chain} from '../../models/chain/Chain';
import {Address} from '../../models/address/Address';
import {QuoteBasic} from '../../models/quote/QuoteBasic';
import {RouteBasic} from '../../models/route/RouteBasic';
import {TradeType} from '../../models/quote/TradeType';
import {UniProtocol} from '../../models/pool/UniProtocol';
import {SimpleQuoteSelector} from '../quote/selector/SimpleQuoteSelector';
import {UniPool} from '../../models/pool/UniPool';
import {V2Pool} from '../../models/pool/V2Pool';
import {GasEstimateProvider} from '../gas/estimator/GasEstimateProvider';
import {NoGasEstimator} from '../gas/estimator/IGasEstimator';
import {ChainId, IUniRouteServiceConfig} from '../../lib/config';
import {JsonRpcProvider} from '@ethersproject/providers';
import {RouteQuoteAllocator} from '../route/RouteQuoteAllocator';
import {IGasConverter} from '../gas/converter/IGasConverter';
import {V3Pool} from '../../models/pool/V3Pool';
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

// Create a test gas converter that properly sets gasCostInQuoteToken
class TestGasConverter implements IGasConverter {
  async prefetchGasPools() {
    return {
      nativeAndQuoteTokenV2Pool: null,
      nativeAndQuoteTokenV3Pool: null,
      nativeAndQuoteTokenV4Pool: null,
    };
  }

  async updateQuotesGasDetails(
    chainId: ChainId,
    quoteTokenAddress: string,
    tokensInfo: Map<string, Erc20Token | null>,
    quotes: QuoteSplit[],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ctx: Context
  ): Promise<void> {
    for (const quoteSplit of quotes) {
      for (const quote of quoteSplit.quotes) {
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

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async getCurrentGasPrice(chainId: ChainId): Promise<number> {
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
    ctx: Context
  ): Promise<QuoteBasic[]> {
    if (this.quotes.length > 0) {
      return this.quotes;
    }

    // Default behavior - return a simple quote
    return [
      new QuoteBasic(
        new RouteBasic(UniProtocol.V2, [
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
    routeQuoteAllocator: RouteQuoteAllocator<UniPool>,
    quoteSelector: SimpleQuoteSelector,
    tokenHandler: ITokenHandler,
    arbitrumGasDataProvider: ArbitrumGasDataProvider,
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
  const arbitrumGasDataProvider = new ArbitrumGasDataProvider(
    new JsonRpcProvider() as BaseProvider
  );
  const freshPoolDetailsWrapper = {} as IFreshPoolDetailsWrapper;

  return new strategyClass(
    quoteFetcher,
    gasEstimateProvider,
    testGasConverter,
    routeQuoteAllocator,
    quoteSelector,
    tokenHandler,
    arbitrumGasDataProvider,
    freshPoolDetailsWrapper
  );
}

// Test factory function that runs tests for a given strategy class
function runStrategyTests(
  strategyClass: new (
    quoteFetcher: IQuoteFetcher,
    gasEstimateProvider: GasEstimateProvider,
    gasConverter: IGasConverter,
    routeQuoteAllocator: RouteQuoteAllocator<UniPool>,
    quoteSelector: SimpleQuoteSelector,
    tokenHandler: ITokenHandler,
    arbitrumGasDataProvider: ArbitrumGasDataProvider,
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
        [UniProtocol.V2, UniProtocol.V3, UniProtocol.V4, UniProtocol.MIXED],
        serviceConfig,
        [
          new RouteBasic(UniProtocol.V2, [
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

    it('should return quotes sorted by raw amount', async () => {
      const quotes = [
        new QuoteBasic(
          new RouteBasic(UniProtocol.V2, [
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
          new RouteBasic(UniProtocol.V2, [
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
        [UniProtocol.V2],
        serviceConfig,
        [
          new RouteBasic(UniProtocol.V2, [quotes[0].route.path[0]]),
          new RouteBasic(UniProtocol.V2, [quotes[1].route.path[0]]),
        ],
        new Map(),
        ['chain:MAINNET', 'tradeType:EXACT_IN']
      );

      expect(bestQuoteCandidates).toBeDefined();
      expect(bestQuoteCandidates.length).toBeGreaterThan(0);

      // First quote should be the one with highest raw amount
      expect(bestQuoteCandidates[0].quotes[0].amount).equals(
        BigInt('2000000000')
      );
      expect(
        bestQuoteCandidates[0].quotes[0].route.path[0].address.toString()
      ).equals('0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640');

      // Second quote should be the one with lower raw amount
      expect(bestQuoteCandidates[1].quotes[0].amount).equals(
        BigInt('1900000000')
      );
      expect(
        bestQuoteCandidates[1].quotes[0].route.path[0].address.toString()
      ).equals('0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8');
    });

    it('should handle mixed routes (V2 + V3)', async () => {
      const tokenMiddleAddress = new Address(
        '0x6B175474E89094C44Da98b954EedeAC495271d0F'
      ); // DAI
      const quotes = [
        new QuoteBasic(
          new RouteBasic(UniProtocol.MIXED, [
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
        [UniProtocol.V2, UniProtocol.V3, UniProtocol.V4, UniProtocol.MIXED],
        serviceConfig,
        [
          new RouteBasic(UniProtocol.MIXED, [
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
        UniProtocol.V2
      );
      expect(bestQuoteCandidates[0].quotes[0].route.path[1].protocol).equals(
        UniProtocol.V3
      );
      expect(
        bestQuoteCandidates[0].quotes[0].route.path[0].address.toString()
      ).equals('0xA478c2975Ab1Ea89e8196811F51A7B7Ade33eB11');
      expect(
        bestQuoteCandidates[0].quotes[0].route.path[1].address.toString()
      ).equals('0x5777d92f208679DB4b9778590Fa3CAB3aC9e2168');
    });
  });
}

// Run tests for each strategy implementation
describe('Quote Strategies', () => {
  runStrategyTests(DeepQuoteStrategy);
  // add more strategies here
});
