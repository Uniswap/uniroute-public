import {TradeType} from '../../../models/quote/TradeType';
import {IQuoteSelector} from './IQuoteSelector';
import {Context as UniContext} from '@uniswap/lib-uni/context';
import {QuoteSplit} from '../../../models/quote/QuoteSplit';
import {buildMetricKey} from '../../../lib/config';

export class SimpleQuoteSelector implements IQuoteSelector {
  // If the gas-adjusted amount is within this percentage of the original amount, it is considered valid.
  // If valid, the gas-adjusted amount is used for sorting, otherwise the original amount is used.
  // This prevents the router from using quotes that are badly adjusted for gas due to bad conversion rates in related pools.
  private static readonly GAS_ADJUSTMENT_THRESHOLD_PERCENT = 30;

  constructor() {}

  async getBestQuotes(
    quotes: QuoteSplit[],
    tradeType: TradeType,
    topN: number,
    metricTags: string[],
    ctx: UniContext
  ): Promise<QuoteSplit[]> {
    const getOriginalAmount = (quoteSplit: QuoteSplit): bigint => {
      return quoteSplit.quotes.reduce((sum, quote) => sum + quote.amount, 0n);
    };

    const getGasAdjustedAmount = (quoteSplit: QuoteSplit): bigint => {
      const totalAmount = quoteSplit.quotes.reduce(
        (sum, quote) => sum + quote.amount,
        0n
      );
      const totalGasCost = quoteSplit.quotes.reduce(
        (sum, quote) => sum + (quote.gasDetails?.gasCostInQuoteToken ?? 0n),
        0n
      );
      return totalAmount - totalGasCost;
    };

    const getGasCostInWei = (quoteSplit: QuoteSplit): bigint => {
      return quoteSplit.quotes.reduce(
        (sum, quote) => sum + (quote.gasDetails?.gasCostInWei ?? 0n),
        0n
      );
    };

    // Check if all gas-adjusted amounts are within 30% of original amounts
    const areGasAdjustmentsValid = (quotes: QuoteSplit[]): boolean => {
      return quotes.every(quoteSplit => {
        const originalAmount = getOriginalAmount(quoteSplit);
        const gasAdjustedAmount = getGasAdjustedAmount(quoteSplit);

        // If original amount is 0, gas adjustment is invalid
        if (originalAmount === 0n) {
          return false;
        }

        // Calculate the gas difference
        const gasDifference =
          gasAdjustedAmount > originalAmount
            ? gasAdjustedAmount - originalAmount
            : originalAmount - gasAdjustedAmount;

        // Check if difference is within the configured threshold of original amount
        const maxAllowedGasDifference =
          (originalAmount *
            BigInt(SimpleQuoteSelector.GAS_ADJUSTMENT_THRESHOLD_PERCENT)) /
          100n;
        return gasDifference <= maxAllowedGasDifference;
      });
    };

    // Determine whether to use gas-adjusted amounts or original amounts for sorting
    const validGasAdjustments = areGasAdjustmentsValid(quotes);
    const getAmountForSorting = validGasAdjustments
      ? getGasAdjustedAmount
      : getOriginalAmount;

    await ctx.metrics.count(
      buildMetricKey('SimpleQuoteSelector.GasAdjustments'),
      1,
      {
        tags: [
          ...metricTags,
          `status:${validGasAdjustments ? 'valid' : 'invalid'}`,
        ],
      }
    );

    // Get best quotes based on amount (gas-adjusted if valid, otherwise original), then gasCostInWei.
    // Higher amount is better for ExactIn, lower is better for ExactOut.
    const quoteComparator =
      tradeType === TradeType.ExactIn
        ? (a: QuoteSplit, b: QuoteSplit) => {
            const amountA = getAmountForSorting(a);
            const amountB = getAmountForSorting(b);
            if (amountA === amountB) {
              // On tie, prefer lower gas cost
              return getGasCostInWei(a) < getGasCostInWei(b) ? -1 : 1;
            }
            return amountA > amountB ? -1 : 1;
          }
        : (a: QuoteSplit, b: QuoteSplit) => {
            const amountA = getAmountForSorting(a);
            const amountB = getAmountForSorting(b);
            if (amountA === amountB) {
              // On tie, prefer lower gas cost
              return getGasCostInWei(a) < getGasCostInWei(b) ? -1 : 1;
            }
            return amountA < amountB ? -1 : 1;
          };

    // Sort quotes and return top N
    return [...quotes].sort(quoteComparator).slice(0, topN);
  }
}
