import {TradeType} from '../models/quote/TradeType';

const BPS_PER_UNIT = 10_000n;

/**
 * How far the simulated swap fell short of its quote, in bps of the quote,
 * floored; negative when it did better. Exact-in compares the output
 * delivered with the quoted output, exact-out the input spent with the quoted
 * input. Undefined for a zero quote.
 */
export function deliveryShortfallBps(
  tradeType: TradeType,
  quotedAmount: bigint,
  deliveredAmount: bigint
): bigint | undefined {
  if (quotedAmount <= 0n) return undefined;
  const shortfall =
    tradeType === TradeType.ExactIn
      ? quotedAmount - deliveredAmount
      : deliveredAmount - quotedAmount;
  return (shortfall * BPS_PER_UNIT) / quotedAmount;
}

/** Bounded tag values for how close a passing candidate came to its quote */
export enum DeliveryHeadroomBand {
  AT_OR_ABOVE_QUOTE = 'at_or_above_quote',
  WITHIN_50_BPS = 'within_50bps',
  WITHIN_100_BPS = '50_to_100bps',
  BEYOND_100_BPS = 'beyond_100bps',
}

export function deliveryHeadroomBand(
  shortfallBps: bigint
): DeliveryHeadroomBand {
  if (shortfallBps <= 0n) return DeliveryHeadroomBand.AT_OR_ABOVE_QUOTE;
  if (shortfallBps <= 50n) return DeliveryHeadroomBand.WITHIN_50_BPS;
  if (shortfallBps <= 100n) return DeliveryHeadroomBand.WITHIN_100_BPS;
  return DeliveryHeadroomBand.BEYOND_100_BPS;
}
