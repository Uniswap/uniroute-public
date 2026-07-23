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

  /**
   * @param minGasConversionGuardEnabled Selects how gas-adjustment validity
   * is judged (QUOTE_SELECTOR_GAS_GUARD_V2_ENABLED, wired in
   * dependencies.ts).
   *
   * Legacy rule (false): adjustments are trusted only when EVERY candidate's
   * adjustment is within the threshold. Any dust-output candidate (gas ≫
   * output on a bad multi-hop path) or any accurately-expensive candidate
   * (ZLCA hooks add up to 3M gas/hop) trips the check and silently reverts
   * the WHOLE selection to raw-output sorting — which then favors exactly
   * those high-gas candidates when they quote marginally better raw output
   * (observed picking net-negative routes for small trades).
   *
   * v2 rule (true): the gas→quote-token conversion rate is shared by every
   * candidate in a request, so judge the RATE at its best case. If even the
   * minimum-adjustment-ratio candidate trips the threshold — equivalently,
   * if NO positive-amount candidate is within it — the conversion is
   * genuinely suspect (thin/stale reference pool) and the whole set falls
   * back to raw: the legacy protection, preserved. Otherwise adjustments
   * are trusted for ALL candidates, and genuinely gas-expensive routes lose
   * on their merits. v2 also corrects the ExactOut adjustment sign (input
   * PLUS gas = total cost) — legacy subtracts in both directions, which
   * under ExactOut's lower-wins ranking rewards gassier routes.
   */
  constructor(private readonly minGasConversionGuardEnabled = false) {}

  async getBestQuotes(
    quotes: QuoteSplit[],
    tradeType: TradeType,
    topN: number,
    metricTags: string[],
    ctx: UniContext
  ): Promise<QuoteSplit[]> {
    if (quotes.length === 0) {
      return [];
    }

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
      // v2 semantics: adjust toward the user's true economics in BOTH
      // directions — ExactIn: output minus gas (higher wins); ExactOut:
      // input PLUS gas, i.e. total cost (lower wins). Legacy subtracts for
      // both, which under ExactOut's lower-wins ranking rewards gassier
      // routes; that inversion is preserved when the flag is off so the
      // off-state stays byte-identical. Note the validity threshold is
      // unaffected: it uses |adjusted − original| = gas cost either way.
      if (
        this.minGasConversionGuardEnabled &&
        tradeType === TradeType.ExactOut
      ) {
        return totalAmount + totalGasCost;
      }
      return totalAmount - totalGasCost;
    };

    const getGasCostInWei = (quoteSplit: QuoteSplit): bigint => {
      return quoteSplit.quotes.reduce(
        (sum, quote) => sum + (quote.gasDetails?.gasCostInWei ?? 0n),
        0n
      );
    };

    // A candidate's gas adjustment is within threshold when it moves the
    // amount by no more than GAS_ADJUSTMENT_THRESHOLD_PERCENT.
    const isWithinThreshold = (quoteSplit: QuoteSplit): boolean => {
      const originalAmount = getOriginalAmount(quoteSplit);
      const gasAdjustedAmount = getGasAdjustedAmount(quoteSplit);

      // If original amount is 0, gas adjustment is invalid
      if (originalAmount === 0n) {
        return false;
      }

      const gasDifference =
        gasAdjustedAmount > originalAmount
          ? gasAdjustedAmount - originalAmount
          : originalAmount - gasAdjustedAmount;

      const maxAllowedGasDifference =
        (originalAmount *
          BigInt(SimpleQuoteSelector.GAS_ADJUSTMENT_THRESHOLD_PERCENT)) /
        100n;
      return gasDifference <= maxAllowedGasDifference;
    };

    // Legacy rule: every candidate must be within threshold.
    const legacyValid = quotes.every(isWithinThreshold);

    // v2 rule: probe the shared conversion rate (see constructor doc). A
    // candidate's adjustment%, rate × gasCostInWei / amount, is minimized by
    // the best RATIO candidate — not the min-gasCostInWei one (a cheap-gas
    // dust-output route can trip the threshold on its own economics while
    // the rate is fine). "The min-ratio candidate is within threshold" is
    // exactly "some positive-amount candidate is within threshold": if none
    // is, even the best-case candidate looks implausible and the shared
    // rate itself is suspect.
    const v2Valid = quotes.some(
      quoteSplit =>
        getOriginalAmount(quoteSplit) > 0n && isWithinThreshold(quoteSplit)
    );

    const validGasAdjustments = this.minGasConversionGuardEnabled
      ? v2Valid
      : legacyValid;
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
          `rule:${this.minGasConversionGuardEnabled ? 'v2' : 'legacy'}`,
        ],
      }
    );

    // Comparator over a chosen amount getter; shared by the final sort and
    // the divergence probe below. Higher amount wins for ExactIn, lower for
    // ExactOut; ties prefer lower gas.
    const makeComparator =
      (getAmount: (quoteSplit: QuoteSplit) => bigint) =>
      (a: QuoteSplit, b: QuoteSplit): number => {
        const amountA = getAmount(a);
        const amountB = getAmount(b);
        if (amountA === amountB) {
          return getGasCostInWei(a) < getGasCostInWei(b) ? -1 : 1;
        }
        if (tradeType === TradeType.ExactIn) {
          return amountA > amountB ? -1 : 1;
        }
        return amountA < amountB ? -1 : 1;
      };

    // Shadow signal for the v2 rollout: how often the two rules disagree,
    // whether the disagreement changes the actual winner, and by how much.
    // The magnitude is the gas-adjusted improvement of the gas-ranked winner
    // over the raw-ranked winner, normalized to basis points of the raw
    // winner's amount and bucketed (bounded tag values — deliberately NOT a
    // distribution, to stay clear of the dist-allowlist machinery). >= 0 by
    // construction: the gas-ranked winner is optimal under that yardstick.
    // Winners are single O(n) scans, not sorts — divergence can fire on a
    // large share of deep-search selections, so this branch must stay cheap.
    if (legacyValid !== v2Valid) {
      const pickWinner = (
        getAmount: (quoteSplit: QuoteSplit) => bigint
      ): QuoteSplit => {
        const comparator = makeComparator(getAmount);
        return quotes.reduce((best, candidate) =>
          comparator(candidate, best) < 0 ? candidate : best
        );
      };
      const gasWinner = pickWinner(getGasAdjustedAmount);
      const rawWinner = pickWinner(getOriginalAmount);
      const winnerChanged = gasWinner !== rawWinner;
      let improvementBucket = '0';
      if (winnerChanged) {
        const improvement =
          tradeType === TradeType.ExactIn
            ? getGasAdjustedAmount(gasWinner) - getGasAdjustedAmount(rawWinner)
            : getGasAdjustedAmount(rawWinner) - getGasAdjustedAmount(gasWinner);
        const denominator = getOriginalAmount(rawWinner);
        if (denominator > 0n) {
          const bps = (improvement * 10_000n) / denominator;
          improvementBucket =
            bps < 10n
              ? 'lt10'
              : bps < 100n
                ? '10to100'
                : bps < 1000n
                  ? '100to1000'
                  : 'gt1000';
        } else {
          improvementBucket = 'unknown';
        }
      }
      await ctx.metrics.count(
        buildMetricKey('SimpleQuoteSelector.GasGuardRuleDivergence'),
        1,
        {
          tags: [
            ...metricTags,
            `legacyVerdict:${legacyValid ? 'valid' : 'invalid'}`,
            `v2Verdict:${v2Valid ? 'valid' : 'invalid'}`,
            `winnerChanged:${winnerChanged}`,
            `improvementBps:${improvementBucket}`,
          ],
        }
      );
    }

    // Get best quotes based on amount (gas-adjusted if valid, otherwise
    // original), then gasCostInWei.
    const quoteComparator = makeComparator(getAmountForSorting);

    // Sort quotes and return top N
    return [...quotes].sort(quoteComparator).slice(0, topN);
  }
}
