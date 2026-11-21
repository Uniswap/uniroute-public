import {describe, expect, it} from 'vitest';
import {TradeType} from '../models/quote/TradeType';
import {
  DeliveryHeadroomBand,
  deliveryHeadroomBand,
  deliveryShortfallBps,
} from './simulatedDelivery';

describe('deliveryShortfallBps', () => {
  it('measures an exact-in shortfall in bps of the quote, floored', () => {
    expect(deliveryShortfallBps(TradeType.ExactIn, 10_000n, 9_900n)).toBe(100n);
    expect(deliveryShortfallBps(TradeType.ExactIn, 10_000n, 9_901n)).toBe(99n);
  });

  it('is negative when the swap did better than its quote', () => {
    expect(deliveryShortfallBps(TradeType.ExactIn, 10_000n, 10_500n)).toBe(
      -500n
    );
  });

  it('counts exact-out overspend as the shortfall', () => {
    expect(deliveryShortfallBps(TradeType.ExactOut, 10_000n, 10_400n)).toBe(
      400n
    );
    expect(deliveryShortfallBps(TradeType.ExactOut, 10_000n, 9_000n)).toBe(
      -1_000n
    );
  });

  it('cannot measure against a zero quote', () => {
    expect(deliveryShortfallBps(TradeType.ExactIn, 0n, 5n)).toBeUndefined();
  });
});

describe('deliveryHeadroomBand', () => {
  it('puts each shortfall in its band, edges inclusive on the lower band', () => {
    expect(deliveryHeadroomBand(-3n)).toBe(
      DeliveryHeadroomBand.AT_OR_ABOVE_QUOTE
    );
    expect(deliveryHeadroomBand(0n)).toBe(
      DeliveryHeadroomBand.AT_OR_ABOVE_QUOTE
    );
    expect(deliveryHeadroomBand(50n)).toBe(DeliveryHeadroomBand.WITHIN_50_BPS);
    expect(deliveryHeadroomBand(51n)).toBe(DeliveryHeadroomBand.WITHIN_100_BPS);
    expect(deliveryHeadroomBand(101n)).toBe(
      DeliveryHeadroomBand.BEYOND_100_BPS
    );
  });
});
