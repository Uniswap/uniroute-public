import {describe, expect, it} from 'vitest';
import {TradeType} from '../../../models/quote/TradeType';
import {isGasConversionTrustworthy} from './gasConversionTrust';

describe('isGasConversionTrustworthy', () => {
  // FIFA -> USDT at mainnet block 26186720 checks prices at the trade's scale.
  const input = {
    tradeType: TradeType.ExactIn,
    quoteTokenIsWrappedNative: false,
    nativePriceUSD: 2500,
    quoteTokenPriceUSD: 1,
    tokenInPriceUSD: 3.9787e-9,
    amountInDecimal: 19.2e6,
    bestGrossOutputDecimal: 0.076035,
  };

  it('trusts wrapped-native identity conversion without USD prices', () => {
    expect(
      isGasConversionTrustworthy({
        ...input,
        quoteTokenIsWrappedNative: true,
        nativePriceUSD: undefined,
        quoteTokenPriceUSD: undefined,
        tokenInPriceUSD: undefined,
      })
    ).toBe(true);
  });

  it('trusts USD conversion confirmed by the realized exchange rate', () => {
    expect(isGasConversionTrustworthy(input)).toBe(true);
  });

  it.each([0.1, 10])(
    'rejects a quote price off by 10x (%s)',
    quoteTokenPriceUSD => {
      expect(isGasConversionTrustworthy({...input, quoteTokenPriceUSD})).toBe(
        false
      );
    }
  );

  it.each(['nativePriceUSD', 'quoteTokenPriceUSD', 'tokenInPriceUSD'])(
    'rejects a missing %s',
    key => {
      expect(isGasConversionTrustworthy({...input, [key]: undefined})).toBe(
        false
      );
    }
  );

  it.each([false, true])(
    'rejects ExactOut even with identity conversion %s',
    quoteTokenIsWrappedNative => {
      expect(
        isGasConversionTrustworthy({
          ...input,
          tradeType: TradeType.ExactOut,
          quoteTokenIsWrappedNative,
        })
      ).toBe(false);
    }
  );

  for (const key of [
    'nativePriceUSD',
    'quoteTokenPriceUSD',
    'tokenInPriceUSD',
    'amountInDecimal',
    'bestGrossOutputDecimal',
  ]) {
    it.each([0, -1, NaN, Infinity, -Infinity])(
      `rejects invalid ${key} %s`,
      value => {
        expect(isGasConversionTrustworthy({...input, [key]: value})).toBe(
          false
        );
      }
    );
  }

  it.each([0.5, 2])('includes the price agreement boundary %s', ratio => {
    expect(
      isGasConversionTrustworthy({
        ...input,
        amountInDecimal: 1,
        tokenInPriceUSD: 1,
        bestGrossOutputDecimal: ratio,
      })
    ).toBe(true);
  });

  it.each([
    {amountInDecimal: Number.MAX_VALUE, tokenInPriceUSD: 2},
    {bestGrossOutputDecimal: Number.MAX_VALUE, quoteTokenPriceUSD: 2},
    {amountInDecimal: Number.MIN_VALUE, tokenInPriceUSD: 0.5},
    {amountInDecimal: Number.MIN_VALUE, tokenInPriceUSD: 1},
  ])('rejects unusable intermediate values %o', overrides => {
    expect(isGasConversionTrustworthy({...input, ...overrides})).toBe(false);
  });
});
