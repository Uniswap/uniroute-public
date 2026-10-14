import {TradeType} from '../../../models/quote/TradeType';

// A stale or wrong quote-token USD price is what the 30% guard protects
// against. A tiny trade realizes close to the mid price, so a 2x disagreement
// means at least one price is not trustworthy.
const MAX_PRICE_DEVIATION_FACTOR = 2;

/**
 * Checks whether identity conversion or the trade's realized USD exchange
 * rate justifies gas ordering even when gas exceeds the output guard.
 * Pool-derived rates and ExactOut retain the selector's existing protection.
 */
export function isGasConversionTrustworthy(input: {
  tradeType: TradeType;
  quoteTokenIsWrappedNative: boolean;
  nativePriceUSD: number | undefined;
  quoteTokenPriceUSD: number | undefined;
  tokenInPriceUSD: number | undefined;
  amountInDecimal: number;
  bestGrossOutputDecimal: number;
}): boolean {
  if (input.tradeType !== TradeType.ExactIn) {
    return false;
  }
  if (input.quoteTokenIsWrappedNative) {
    return true;
  }

  const {
    nativePriceUSD,
    quoteTokenPriceUSD,
    tokenInPriceUSD,
    amountInDecimal,
    bestGrossOutputDecimal,
  } = input;
  if (
    nativePriceUSD === undefined ||
    quoteTokenPriceUSD === undefined ||
    tokenInPriceUSD === undefined ||
    ![
      nativePriceUSD,
      quoteTokenPriceUSD,
      tokenInPriceUSD,
      amountInDecimal,
      bestGrossOutputDecimal,
    ].every(value => Number.isFinite(value) && value > 0)
  ) {
    return false;
  }

  const valueIn = amountInDecimal * tokenInPriceUSD;
  const valueOut = bestGrossOutputDecimal * quoteTokenPriceUSD;
  const ratio = valueOut / valueIn;
  return (
    Number.isFinite(valueIn) &&
    Number.isFinite(valueOut) &&
    Number.isFinite(ratio) &&
    ratio >= 1 / MAX_PRICE_DEVIATION_FACTOR &&
    ratio <= MAX_PRICE_DEVIATION_FACTOR
  );
}
