import {UniProtocol} from '../../../models/pool/UniProtocol';
import {V2Pool} from '../../../models/pool/V2Pool';
import {V3Pool} from '../../../models/pool/V3Pool';
import {TradeType} from '../../../models/quote/TradeType';
import {RouteBasic} from '../../../models/route/RouteBasic';
import {SimpleQuoteSelector} from './SimpleQuoteSelector';
import {MockedQuoteFetcher} from '../../../stores/quote/MockedQuoteFetcher';
import {USDC, WETH, ZeroAddress} from 'tests/constants/Mainnet';
import {beforeEach, describe, expect, it} from 'vitest';
import {buildTestContext} from '@uniswap/lib-testhelpers';
import {QuoteSplit} from '../../../models/quote/QuoteSplit';

describe('SimpleQuoteSelector', () => {
  let quoteSelector: SimpleQuoteSelector;
  let mockedQuoteFetcher: MockedQuoteFetcher;
  const ctx = buildTestContext();

  beforeEach(() => {
    mockedQuoteFetcher = new MockedQuoteFetcher();
    quoteSelector = new SimpleQuoteSelector();
  });

  it('returns empty array when no quotes are found', async () => {
    mockedQuoteFetcher.fetchQuotes.mockResolvedValueOnce([]);
    const quotes = await mockedQuoteFetcher.fetchQuotes();
    expect(
      await quoteSelector.getBestQuotes(quotes, TradeType.ExactIn, 3, [], ctx)
    ).toEqual([]);
  });

  describe('when only 1 quote is found', () => {
    describe('with exactIn trade', () => {
      it('returns only that quote', async () => {
        const pool = new V3Pool(
          WETH,
          USDC,
          100,
          ZeroAddress,
          BigInt(10_000),
          BigInt(0),
          BigInt(0)
        );
        const route = new RouteBasic<V3Pool>(UniProtocol.V3, [pool]);
        mockedQuoteFetcher.fetchQuotes.mockResolvedValueOnce([
          new QuoteSplit([{route, amount: BigInt(100)}]),
        ]);

        const quotes = await mockedQuoteFetcher.fetchQuotes();
        expect(
          await quoteSelector.getBestQuotes(
            quotes,
            TradeType.ExactIn,
            3,
            [],
            ctx
          )
        ).toEqual([new QuoteSplit([{route, amount: BigInt(100)}])]);
      });
    });

    describe('with exactOut trade', () => {
      it('returns only that quote', async () => {
        const pool = new V3Pool(
          WETH,
          USDC,
          100,
          ZeroAddress,
          BigInt(10_000),
          BigInt(0),
          BigInt(0)
        );
        const route = new RouteBasic<V3Pool>(UniProtocol.V3, [pool]);
        mockedQuoteFetcher.fetchQuotes.mockResolvedValueOnce([
          new QuoteSplit([{route, amount: BigInt(100)}]),
        ]);

        const quotes = await mockedQuoteFetcher.fetchQuotes();
        expect(
          await quoteSelector.getBestQuotes(
            quotes,
            TradeType.ExactOut,
            3,
            [],
            ctx
          )
        ).toEqual([new QuoteSplit([{route, amount: BigInt(100)}])]);
      });
    });
  });

  describe('when more than 1 quote is found', () => {
    describe('with exactIn trade', () => {
      it('returns the quotes sorted by amount in descending order', async () => {
        const pool = new V3Pool(
          WETH,
          USDC,
          100,
          ZeroAddress,
          BigInt(10_000),
          BigInt(0),
          BigInt(0)
        );
        const v3Route = new RouteBasic<V3Pool>(UniProtocol.V3, [pool]);
        const pair = new V2Pool(
          WETH,
          USDC,
          ZeroAddress,
          BigInt(10_000),
          BigInt(10_000)
        );
        const v2Route = new RouteBasic<V2Pool>(UniProtocol.V2, [pair]);

        mockedQuoteFetcher.fetchQuotes.mockResolvedValueOnce([
          new QuoteSplit([{route: v3Route, amount: BigInt(100)}]),
          new QuoteSplit([{route: v2Route, amount: BigInt(200)}]),
        ]);

        const quotes = await mockedQuoteFetcher.fetchQuotes();
        const result = await quoteSelector.getBestQuotes(
          quotes,
          TradeType.ExactIn,
          3,
          [],
          ctx
        );
        expect(result).toEqual([
          new QuoteSplit([{route: v2Route, amount: BigInt(200)}]),
          new QuoteSplit([{route: v3Route, amount: BigInt(100)}]),
        ]);
      });
    });

    describe('with exactOut trade', () => {
      it('returns the quotes sorted by amount in ascending order', async () => {
        const pool = new V3Pool(
          WETH,
          USDC,
          100,
          ZeroAddress,
          BigInt(10_000),
          BigInt(0),
          BigInt(0)
        );
        const v3Route = new RouteBasic<V3Pool>(UniProtocol.V3, [pool]);
        const pair = new V2Pool(
          WETH,
          USDC,
          ZeroAddress,
          BigInt(10_000),
          BigInt(10_000)
        );
        const v2Route = new RouteBasic<V2Pool>(UniProtocol.V2, [pair]);

        mockedQuoteFetcher.fetchQuotes.mockResolvedValueOnce([
          new QuoteSplit([{route: v3Route, amount: BigInt(100)}]),
          new QuoteSplit([{route: v2Route, amount: BigInt(200)}]),
        ]);

        const quotes = await mockedQuoteFetcher.fetchQuotes();
        const result = await quoteSelector.getBestQuotes(
          quotes,
          TradeType.ExactOut,
          3,
          [],
          ctx
        );
        expect(result).toEqual([
          new QuoteSplit([{route: v3Route, amount: BigInt(100)}]),
          new QuoteSplit([{route: v2Route, amount: BigInt(200)}]),
        ]);
      });
    });
  });

  describe('when quotes have same gas-adjusted amount', () => {
    describe('with exactIn trade', () => {
      it('returns the quotes sorted by gas cost in Wei', async () => {
        const pool = new V3Pool(
          WETH,
          USDC,
          100,
          ZeroAddress,
          BigInt(10_000),
          BigInt(0),
          BigInt(0)
        );
        const v3Route = new RouteBasic<V3Pool>(UniProtocol.V3, [pool]);
        const pair = new V2Pool(
          WETH,
          USDC,
          ZeroAddress,
          BigInt(10_000),
          BigInt(10_000)
        );
        const v2Route = new RouteBasic<V2Pool>(UniProtocol.V2, [pair]);

        // Both quotes have same gas-adjusted amount (100) but different gas costs
        const quote1 = new QuoteSplit([
          {
            route: v3Route,
            amount: BigInt(200),
            gasDetails: {
              gasCostInQuoteToken: BigInt(100),
              gasCostInWei: BigInt(2000),
              gasPriceInWei: BigInt(10),
              gasCostInEth: 2.0,
              gasUse: BigInt(200),
            },
          },
        ]);
        const quote2 = new QuoteSplit([
          {
            route: v2Route,
            amount: BigInt(200),
            gasDetails: {
              gasCostInQuoteToken: BigInt(100),
              gasCostInWei: BigInt(1000),
              gasPriceInWei: BigInt(10),
              gasCostInEth: 1.0,
              gasUse: BigInt(100),
            },
          },
        ]);

        mockedQuoteFetcher.fetchQuotes.mockResolvedValueOnce([quote1, quote2]);

        const quotes = await mockedQuoteFetcher.fetchQuotes();
        const result = await quoteSelector.getBestQuotes(
          quotes,
          TradeType.ExactIn,
          3,
          [],
          ctx
        );
        expect(result).toEqual([quote2, quote1]); // Should sort by gas cost in Wei
      });
    });

    describe('with exactOut trade', () => {
      it('returns the quotes sorted by gas cost in Wei', async () => {
        const pool = new V3Pool(
          WETH,
          USDC,
          100,
          ZeroAddress,
          BigInt(10_000),
          BigInt(0),
          BigInt(0)
        );
        const v3Route = new RouteBasic<V3Pool>(UniProtocol.V3, [pool]);
        const pair = new V2Pool(
          WETH,
          USDC,
          ZeroAddress,
          BigInt(10_000),
          BigInt(10_000)
        );
        const v2Route = new RouteBasic<V2Pool>(UniProtocol.V2, [pair]);

        // Both quotes have same gas-adjusted amount (100) but different gas costs
        const quote1 = new QuoteSplit([
          {
            route: v3Route,
            amount: BigInt(200),
            gasDetails: {
              gasCostInQuoteToken: BigInt(100),
              gasCostInWei: BigInt(2000),
              gasPriceInWei: BigInt(10),
              gasCostInEth: 2.0,
              gasUse: BigInt(200),
            },
          },
        ]);
        const quote2 = new QuoteSplit([
          {
            route: v2Route,
            amount: BigInt(200),
            gasDetails: {
              gasCostInQuoteToken: BigInt(100),
              gasCostInWei: BigInt(1000),
              gasPriceInWei: BigInt(10),
              gasCostInEth: 1.0,
              gasUse: BigInt(100),
            },
          },
        ]);

        mockedQuoteFetcher.fetchQuotes.mockResolvedValueOnce([quote1, quote2]);

        const quotes = await mockedQuoteFetcher.fetchQuotes();
        const result = await quoteSelector.getBestQuotes(
          quotes,
          TradeType.ExactOut,
          3,
          [],
          ctx
        );
        expect(result).toEqual([quote2, quote1]); // Should sort by gas cost in Wei
      });
    });
  });

  it('returns only top N quotes when more are available', async () => {
    const pool1 = new V2Pool(
      WETH,
      USDC,
      ZeroAddress,
      BigInt(10_000),
      BigInt(10_000)
    );
    const pool2 = new V2Pool(
      WETH,
      USDC,
      ZeroAddress,
      BigInt(10_000),
      BigInt(10_000)
    );
    const pool3 = new V2Pool(
      WETH,
      USDC,
      ZeroAddress,
      BigInt(10_000),
      BigInt(10_000)
    );

    const quote1 = new QuoteSplit([
      {
        route: new RouteBasic(UniProtocol.V2, [pool1]),
        amount: BigInt('2000000000'),
        gasDetails: {
          gasCostInQuoteToken: BigInt('200000000'),
          gasCostInWei: BigInt('10000000000000000'),
          gasPriceInWei: BigInt('50000000000'),
          gasCostInEth: 0.01,
          gasUse: BigInt('200000'),
        },
      },
    ]);

    const quote2 = new QuoteSplit([
      {
        route: new RouteBasic(UniProtocol.V2, [pool2]),
        amount: BigInt('1900000000'),
        gasDetails: {
          gasCostInQuoteToken: BigInt('99000000'),
          gasCostInWei: BigInt('5000000000000000'),
          gasPriceInWei: BigInt('50000000000'),
          gasCostInEth: 0.005,
          gasUse: BigInt('100000'),
        },
      },
    ]);

    const quote3 = new QuoteSplit([
      {
        route: new RouteBasic(UniProtocol.V2, [pool3]),
        amount: BigInt('1800000000'),
        gasDetails: {
          gasCostInQuoteToken: BigInt('50000000'),
          gasCostInWei: BigInt('2500000000000000'),
          gasPriceInWei: BigInt('50000000000'),
          gasCostInEth: 0.0025,
          gasUse: BigInt('50000'),
        },
      },
    ]);

    const quotes = [quote1, quote2, quote3];
    const result = await quoteSelector.getBestQuotes(
      quotes,
      TradeType.ExactIn,
      2,
      [],
      ctx
    );

    // Should return only top 2 quotes, ordered by gas-adjusted amount
    expect(result).toEqual([quote2, quote1]);
  });

  describe('gas adjustment validation', () => {
    describe('when gas adjustments are within threshold', () => {
      it('uses gas-adjusted amounts for sorting with exactIn trade', async () => {
        const pool1 = new V2Pool(
          WETH,
          USDC,
          ZeroAddress,
          BigInt(10_000),
          BigInt(10_000)
        );
        const pool2 = new V2Pool(
          WETH,
          USDC,
          ZeroAddress,
          BigInt(10_000),
          BigInt(10_000)
        );

        // Quote1: 1000 original, 800 gas-adjusted (20% difference - valid, within 30% threshold)
        const quote1 = new QuoteSplit([
          {
            route: new RouteBasic(UniProtocol.V2, [pool1]),
            amount: BigInt(1000),
            gasDetails: {
              gasCostInQuoteToken: BigInt(200),
              gasCostInWei: BigInt(1000),
              gasPriceInWei: BigInt(10),
              gasCostInEth: 0.001,
              gasUse: BigInt(100),
            },
          },
        ]);

        // Quote2: 1000 original, 900 gas-adjusted (10% difference - valid, within 30% threshold)
        const quote2 = new QuoteSplit([
          {
            route: new RouteBasic(UniProtocol.V2, [pool2]),
            amount: BigInt(1000),
            gasDetails: {
              gasCostInQuoteToken: BigInt(100),
              gasCostInWei: BigInt(500),
              gasPriceInWei: BigInt(10),
              gasCostInEth: 0.0005,
              gasUse: BigInt(50),
            },
          },
        ]);

        const quotes = [quote1, quote2];
        const result = await quoteSelector.getBestQuotes(
          quotes,
          TradeType.ExactIn,
          2,
          [],
          ctx
        );

        // Should sort by gas-adjusted amounts: quote2 (900) > quote1 (800)
        expect(result).toEqual([quote2, quote1]);
      });

      it('uses gas-adjusted amounts for sorting with exactOut trade', async () => {
        const pool1 = new V2Pool(
          WETH,
          USDC,
          ZeroAddress,
          BigInt(10_000),
          BigInt(10_000)
        );
        const pool2 = new V2Pool(
          WETH,
          USDC,
          ZeroAddress,
          BigInt(10_000),
          BigInt(10_000)
        );

        // Quote1: 1000 original, 800 gas-adjusted (20% difference - valid)
        const quote1 = new QuoteSplit([
          {
            route: new RouteBasic(UniProtocol.V2, [pool1]),
            amount: BigInt(1000),
            gasDetails: {
              gasCostInQuoteToken: BigInt(200),
              gasCostInWei: BigInt(1000),
              gasPriceInWei: BigInt(10),
              gasCostInEth: 0.001,
              gasUse: BigInt(100),
            },
          },
        ]);

        // Quote2: 1000 original, 900 gas-adjusted (10% difference - valid)
        const quote2 = new QuoteSplit([
          {
            route: new RouteBasic(UniProtocol.V2, [pool2]),
            amount: BigInt(1000),
            gasDetails: {
              gasCostInQuoteToken: BigInt(100),
              gasCostInWei: BigInt(500),
              gasPriceInWei: BigInt(10),
              gasCostInEth: 0.0005,
              gasUse: BigInt(50),
            },
          },
        ]);

        const quotes = [quote1, quote2];
        const result = await quoteSelector.getBestQuotes(
          quotes,
          TradeType.ExactOut,
          2,
          [],
          ctx
        );

        // Should sort by gas-adjusted amounts: quote1 (800) < quote2 (900)
        expect(result).toEqual([quote1, quote2]);
      });
    });

    describe('when gas adjustments exceed threshold', () => {
      it('falls back to original amounts for sorting with exactIn trade', async () => {
        const pool1 = new V2Pool(
          WETH,
          USDC,
          ZeroAddress,
          BigInt(10_000),
          BigInt(10_000)
        );
        const pool2 = new V2Pool(
          WETH,
          USDC,
          ZeroAddress,
          BigInt(10_000),
          BigInt(10_000)
        );

        // Quote1: 1000 original, 500 gas-adjusted (50% difference - invalid)
        const quote1 = new QuoteSplit([
          {
            route: new RouteBasic(UniProtocol.V2, [pool1]),
            amount: BigInt(1000),
            gasDetails: {
              gasCostInQuoteToken: BigInt(500),
              gasCostInWei: BigInt(1000),
              gasPriceInWei: BigInt(10),
              gasCostInEth: 0.001,
              gasUse: BigInt(100),
            },
          },
        ]);

        // Quote2: 1200 original, 600 gas-adjusted (50% difference - invalid)
        const quote2 = new QuoteSplit([
          {
            route: new RouteBasic(UniProtocol.V2, [pool2]),
            amount: BigInt(1200),
            gasDetails: {
              gasCostInQuoteToken: BigInt(600),
              gasCostInWei: BigInt(500),
              gasPriceInWei: BigInt(10),
              gasCostInEth: 0.0005,
              gasUse: BigInt(50),
            },
          },
        ]);

        const quotes = [quote1, quote2];
        const result = await quoteSelector.getBestQuotes(
          quotes,
          TradeType.ExactIn,
          2,
          [],
          ctx
        );

        // Should sort by original amounts: quote2 (1200) > quote1 (1000)
        expect(result).toEqual([quote2, quote1]);
      });

      it('falls back to original amounts for sorting with exactOut trade', async () => {
        const pool1 = new V2Pool(
          WETH,
          USDC,
          ZeroAddress,
          BigInt(10_000),
          BigInt(10_000)
        );
        const pool2 = new V2Pool(
          WETH,
          USDC,
          ZeroAddress,
          BigInt(10_000),
          BigInt(10_000)
        );

        // Quote1: 1000 original, 500 gas-adjusted (50% difference - invalid)
        const quote1 = new QuoteSplit([
          {
            route: new RouteBasic(UniProtocol.V2, [pool1]),
            amount: BigInt(1000),
            gasDetails: {
              gasCostInQuoteToken: BigInt(500),
              gasCostInWei: BigInt(1000),
              gasPriceInWei: BigInt(10),
              gasCostInEth: 0.001,
              gasUse: BigInt(100),
            },
          },
        ]);

        // Quote2: 1200 original, 600 gas-adjusted (50% difference - invalid)
        const quote2 = new QuoteSplit([
          {
            route: new RouteBasic(UniProtocol.V2, [pool2]),
            amount: BigInt(1200),
            gasDetails: {
              gasCostInQuoteToken: BigInt(600),
              gasCostInWei: BigInt(500),
              gasPriceInWei: BigInt(10),
              gasCostInEth: 0.0005,
              gasUse: BigInt(50),
            },
          },
        ]);

        const quotes = [quote1, quote2];
        const result = await quoteSelector.getBestQuotes(
          quotes,
          TradeType.ExactOut,
          2,
          [],
          ctx
        );

        // Should sort by original amounts: quote1 (1000) < quote2 (1200)
        expect(result).toEqual([quote1, quote2]);
      });
    });

    describe('when some quotes have valid gas adjustments and others do not', () => {
      it('falls back to original amounts for sorting', async () => {
        const pool1 = new V2Pool(
          WETH,
          USDC,
          ZeroAddress,
          BigInt(10_000),
          BigInt(10_000)
        );
        const pool2 = new V2Pool(
          WETH,
          USDC,
          ZeroAddress,
          BigInt(10_000),
          BigInt(10_000)
        );

        // Quote1: 1000 original, 800 gas-adjusted (20% difference - valid)
        const quote1 = new QuoteSplit([
          {
            route: new RouteBasic(UniProtocol.V2, [pool1]),
            amount: BigInt(1000),
            gasDetails: {
              gasCostInQuoteToken: BigInt(200),
              gasCostInWei: BigInt(1000),
              gasPriceInWei: BigInt(10),
              gasCostInEth: 0.001,
              gasUse: BigInt(100),
            },
          },
        ]);

        // Quote2: 1000 original, 500 gas-adjusted (50% difference - invalid)
        const quote2 = new QuoteSplit([
          {
            route: new RouteBasic(UniProtocol.V2, [pool2]),
            amount: BigInt(1000),
            gasDetails: {
              gasCostInQuoteToken: BigInt(500),
              gasCostInWei: BigInt(500),
              gasPriceInWei: BigInt(10),
              gasCostInEth: 0.0005,
              gasUse: BigInt(50),
            },
          },
        ]);

        const quotes = [quote1, quote2];
        const result = await quoteSelector.getBestQuotes(
          quotes,
          TradeType.ExactIn,
          2,
          [],
          ctx
        );

        // Should sort by original amounts since one quote has invalid gas adjustment
        // Both have same original amount, so should sort by gas cost in Wei
        expect(result).toEqual([quote2, quote1]); // quote2 has lower gas cost
      });
    });

    describe('when quotes have zero original amounts', () => {
      it('treats gas adjustments as invalid and falls back to original amounts', async () => {
        const pool1 = new V2Pool(
          WETH,
          USDC,
          ZeroAddress,
          BigInt(10_000),
          BigInt(10_000)
        );
        const pool2 = new V2Pool(
          WETH,
          USDC,
          ZeroAddress,
          BigInt(10_000),
          BigInt(10_000)
        );

        // Quote1: 0 original, 0 gas-adjusted (invalid due to zero original)
        const quote1 = new QuoteSplit([
          {
            route: new RouteBasic(UniProtocol.V2, [pool1]),
            amount: BigInt(0),
            gasDetails: {
              gasCostInQuoteToken: BigInt(0),
              gasCostInWei: BigInt(1000),
              gasPriceInWei: BigInt(10),
              gasCostInEth: 0.001,
              gasUse: BigInt(100),
            },
          },
        ]);

        // Quote2: 1000 original, 800 gas-adjusted (20% difference - valid)
        const quote2 = new QuoteSplit([
          {
            route: new RouteBasic(UniProtocol.V2, [pool2]),
            amount: BigInt(1000),
            gasDetails: {
              gasCostInQuoteToken: BigInt(200),
              gasCostInWei: BigInt(500),
              gasPriceInWei: BigInt(10),
              gasCostInEth: 0.0005,
              gasUse: BigInt(50),
            },
          },
        ]);

        const quotes = [quote1, quote2];
        const result = await quoteSelector.getBestQuotes(
          quotes,
          TradeType.ExactIn,
          2,
          [],
          ctx
        );

        // Should sort by original amounts since one quote has zero original amount
        expect(result).toEqual([quote2, quote1]); // quote2 has higher original amount
      });
    });

    describe('configurable threshold', () => {
      it('uses the static readonly threshold constant for validation', async () => {
        // This test verifies that the threshold is configurable through the static readonly property
        // The current threshold is 30%, so we test with values just within and just outside this threshold

        const pool1 = new V2Pool(
          WETH,
          USDC,
          ZeroAddress,
          BigInt(10_000),
          BigInt(10_000)
        );
        const pool2 = new V2Pool(
          WETH,
          USDC,
          ZeroAddress,
          BigInt(10_000),
          BigInt(10_000)
        );

        // Quote1: 1000 original, 700 gas-adjusted (30% difference - exactly at threshold, should be valid)
        const quote1 = new QuoteSplit([
          {
            route: new RouteBasic(UniProtocol.V2, [pool1]),
            amount: BigInt(1000),
            gasDetails: {
              gasCostInQuoteToken: BigInt(300),
              gasCostInWei: BigInt(1000),
              gasPriceInWei: BigInt(10),
              gasCostInEth: 0.001,
              gasUse: BigInt(100),
            },
          },
        ]);

        // Quote2: 1000 original, 699 gas-adjusted (30.1% difference - just over threshold, should be invalid)
        const quote2 = new QuoteSplit([
          {
            route: new RouteBasic(UniProtocol.V2, [pool2]),
            amount: BigInt(1000),
            gasDetails: {
              gasCostInQuoteToken: BigInt(301),
              gasCostInWei: BigInt(500),
              gasPriceInWei: BigInt(10),
              gasCostInEth: 0.0005,
              gasUse: BigInt(50),
            },
          },
        ]);

        const quotes = [quote1, quote2];
        const result = await quoteSelector.getBestQuotes(
          quotes,
          TradeType.ExactIn,
          2,
          [],
          ctx
        );

        // Since quote2 exceeds the 30% threshold, should fall back to original amounts
        // Both have same original amount, so should sort by gas cost in Wei
        expect(result).toEqual([quote2, quote1]); // quote2 has lower gas cost
      });
    });
  });
});
