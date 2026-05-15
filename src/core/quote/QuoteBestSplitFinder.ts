import {QuoteBasic} from '../../models/quote/QuoteBasic';
import {RouteBasic} from '../../models/route/RouteBasic';
import {Pool} from '../../models/pool/Pool';
import {Context as UniContext} from '@uniswap/lib-uni/context';
import {ADDRESS_ZERO} from '@uniswap/v3-sdk';
import {WRAPPED_NATIVE_CURRENCY} from '../../lib/tokenUtils';
import {ChainId} from '../../lib/config';
import {buildMetricKey} from '../../lib/config';
import {IQuoteBestSplitFinder} from './IQuoteBestSplitFinder';
import {TradeType} from '../../models/quote/TradeType';
import {routeUsesAggHook, hashForLogging} from '../../lib/observability';

export class QuoteBestSplitFinder<TPool extends Pool>
  implements IQuoteBestSplitFinder<TPool>
{
  /**
   * Maximum number of quotes to return per percentage, after filtering for
   * validity, while constructing splits. The total returned across both route
   * classes never exceeds this — branching factor at every recursion level
   * stays the same regardless of whether agg-hook protocols are enabled.
   *
   * When both no-hook and agg-hook valid quotes are available at a percentage,
   * the budget is split so each class always gets at least one slot (no-hook
   * gets the extra when K is odd). When only one class has valid quotes, all
   * K slots go to that class. This guarantees that high-yielding agg-hook
   * routes can no longer evict every native Uniswap route from the candidate
   * set without inflating the search space.
   */
  private readonly MAX_VALID_QUOTES_PER_PERCENTAGE = 2;
  // Improvement threshold percentage to continue searching to next level (0.01%)
  private readonly MIN_IMPROVEMENT_PCT_PER_LEVEL = 0.01;
  // Minimum number of split levels to try before exiting early
  private readonly MIN_SPLIT_LEVELS_BEFORE_EARLY_EXIT = 3;

  /**
   * Maximum bps that the agg-hook winner is allowed to be *worse* than the
   * no-hook runner-up the partition would displace, before we drop the
   * partition reservation entirely and give all K slots to no-hook.
   *
   * Background: PR #8105 instrumentation on dev confirmed the K-budget
   * partition was firing the bad-case eviction on every WETH→USDC EXACT_OUT
   * $1k repro at every DFS percentage step (5, 10, 90, 95) — keeping an
   * agg-hook quote that was 0.0009–5.66 bps worse than the displaced
   * no-hook runner-up. With tolerance=0n the partition only fires when the
   * agg-hook winner is at least tied with the displaced no-hook quote;
   * tiebreaker-class agg-hook routes still qualify.
   *
   * If empirical prod data shows we're over-correcting and dropping useful
   * agg-hook exploration, bump this up (1n–5n bps) to allow a small
   * "investment" margin. Constructor-settable for tests; default is 0n.
   */
  private readonly AGG_HOOK_PARTITION_TOLERANCE_BPS: bigint;

  /**
   * Maximum gas units the agg-hook winner is allowed to exceed the no-hook
   * runner-up by, before the partition is gated off. Direction-agnostic:
   * lower gas is always better.
   *
   * Background: PR #8142 instrumentation in prod (`commit-477b87a`)
   * showed 7,665 `partition kept higher-gas agg-hook` log emissions in 10
   * minutes — every observed bad case had an exact gas delta of either
   * 80,000 (EXACT_OUT) or 97,000 (EXACT_IN) units, spread evenly across
   * every percentage step (25 → 90). The raw-only gate from PR #8114
   * correctly admits these quotes as raw-competitive (within 1–2 bps), but
   * the +80–97k gas overhead per step compounds into the +472k gas
   * regression observed in the prod loss sample (treatment 1.156M vs
   * control 684k). At tolerance=0n the gate rejects any agg-hook winner
   * with strictly more gas use than the displaced no-hook runner-up.
   *
   * Bump this if prod shows over-correction (e.g. legitimate agg-hook
   * routes with a small fixed gas overhead being dropped). Constructor-
   * settable for tests; default is 0n.
   *
   * When `gasDetails.gasUse` is missing on either quote (e.g. unit-test
   * mocks without gas info), the gas check is skipped and only the BPS
   * gate applies — preserves the pre-fix behavior for code paths that
   * don't populate gas. In prod, DeepQuoteStrategy.findBestQuoteCandidates
   * always populates gasUse before findBestSplits runs.
   */
  private readonly AGG_HOOK_PARTITION_GAS_TOLERANCE_UNITS: bigint;

  constructor(
    aggHookPartitionToleranceBps: bigint = 0n,
    aggHookPartitionGasToleranceUnits: bigint = 0n
  ) {
    this.AGG_HOOK_PARTITION_TOLERANCE_BPS = aggHookPartitionToleranceBps;
    this.AGG_HOOK_PARTITION_GAS_TOLERANCE_UNITS =
      aggHookPartitionGasToleranceUnits;
  }

  private routeHasGivenAddressAsInputOrOutput(
    route: RouteBasic<TPool>,
    address: string
  ): boolean {
    if (route.path.length === 0) return false;
    if (route.path.length === 1) {
      return (
        route.path[0].token0.address.toLowerCase() === address.toLowerCase() ||
        route.path[0].token1.address.toLowerCase() === address.toLowerCase()
      );
    }
    // We have more than one pool in the route. Determine the tokenInAddress
    let tokenInAddress = route.path[0].token0.address.toLowerCase();
    let otherTokenAddress = route.path[0].token1.address.toLowerCase();
    // Check if the next pool has the tokenInAddress as token0 or token1, if it does, then the tokenInAddress is the other token
    if (
      route.path[1].token0.address.toLowerCase() ===
        tokenInAddress.toLowerCase() ||
      route.path[1].token1.address.toLowerCase() ===
        tokenInAddress.toLowerCase()
    ) {
      tokenInAddress = route.path[0].token1.address.toLowerCase();
      otherTokenAddress = route.path[0].token0.address.toLowerCase();
    }
    // Now that we have the tokenInAddress, keep going through the route to find the tokenOutAddress.
    // The tokenOutAddress is the other token in the last pool.
    for (let i = 1; i < route.path.length; i++) {
      if (
        route.path[i].token0.address.toLowerCase() ===
        otherTokenAddress.toLowerCase()
      ) {
        otherTokenAddress = route.path[i].token1.address.toLowerCase();
      } else {
        otherTokenAddress = route.path[i].token0.address.toLowerCase();
      }
    }
    const tokenOutAddress = otherTokenAddress;

    return (
      tokenOutAddress.toLowerCase() === address.toLowerCase() ||
      tokenInAddress.toLowerCase() === address.toLowerCase()
    );
  }

  private routeHasNativeTokenInputOrOutput(route: RouteBasic<TPool>): boolean {
    return this.routeHasGivenAddressAsInputOrOutput(
      route,
      ADDRESS_ZERO.toLowerCase()
    );
  }
  private routeHasWrappedNativeTokenInputOrOutput(
    route: RouteBasic<TPool>,
    chainId: ChainId
  ): boolean {
    return this.routeHasGivenAddressAsInputOrOutput(
      route,
      WRAPPED_NATIVE_CURRENCY[chainId].address.toLowerCase()
    );
  }

  // Helper to check if a route shares any pools with routes in the current combination
  private sharesPoolsWith(
    route: RouteBasic<TPool>,
    currentRoutes: RouteBasic<TPool>[]
  ): boolean {
    const routePoolAddresses = new Set(
      route.path.map(p => p.address.toString())
    );

    for (const existingRoute of currentRoutes) {
      for (const pool of existingRoute.path) {
        if (routePoolAddresses.has(pool.address.toString())) {
          return true;
        }
      }
    }
    return false;
  }

  // Helper to check for native/wrapped token conflicts
  private hasEthWethTokenConflict(
    route: RouteBasic<TPool>,
    currentRoutes: RouteBasic<TPool>[],
    chainId: ChainId
  ): boolean {
    const hasNativeInUsedRoutes = currentRoutes.some(r =>
      this.routeHasNativeTokenInputOrOutput(r)
    );
    const hasWrappedNativeInUsedRoutes = currentRoutes.some(r =>
      this.routeHasWrappedNativeTokenInputOrOutput(r, chainId)
    );

    return (
      (hasNativeInUsedRoutes &&
        this.routeHasWrappedNativeTokenInputOrOutput(route, chainId)) ||
      (hasWrappedNativeInUsedRoutes &&
        this.routeHasNativeTokenInputOrOutput(route))
    );
  }

  /**
   * Returns the top valid quotes for a given percentage that don't conflict
   * with routes already in the current combination.
   *
   * Quotes are partitioned into two classes (no-hook vs agg-hook V4 pools).
   * `MAX_VALID_QUOTES_PER_PERCENTAGE` slots are split between them only when
   * the agg-hook winner is competitive with the no-hook runner-up the
   * partition would otherwise displace — gated by `AGG_HOOK_PARTITION_TOLERANCE_BPS`
   * via `isAggHookCompetitive`. If the agg-hook class fails the gate, all
   * K slots go to no-hook. When only one class has valid quotes, all K slots
   * go to that class.
   */
  private getBestUnusedQuotesStats(
    percentage: number,
    percentageToSortedQuotes: Map<number, QuoteBasic[]>,
    usedRoutes: RouteBasic<TPool>[],
    chainId: ChainId,
    tradeType: TradeType,
    instrumentation?: {
      ctx: UniContext;
      tradeType: TradeType;
      testAggHooks: boolean | undefined;
      partitionEvictLogBudget: {remaining: number};
      soleCandidateLogBudget: {remaining: number};
      partitionGasAdjustedLogBudget: {remaining: number};
      gateEarlyReturnLeakLogBudget: {remaining: number};
      metricTags: string[];
    }
  ): {
    quotes: QuoteBasic[];
    totalCount: number;
    validCount: number;
    returnedCount: number;
  } {
    const quotes = percentageToSortedQuotes.get(percentage) || [];
    // First filter valid quotes
    const validQuotes = quotes.filter(quote => {
      const route = quote.route as RouteBasic<TPool>;
      return (
        !this.sharesPoolsWith(route, usedRoutes) &&
        !this.hasEthWethTokenConflict(route, usedRoutes, chainId)
      );
    });

    // Partition by class. `validQuotes` preserves the input order (which is
    // sorted by amount upstream), so each class is already amount-sorted.
    const noHookQuotes: QuoteBasic[] = [];
    const aggHookQuotes: QuoteBasic[] = [];
    for (const quote of validQuotes) {
      const route = quote.route as RouteBasic<TPool>;
      if (routeUsesAggHook(route, chainId)) {
        aggHookQuotes.push(quote);
      } else {
        noHookQuotes.push(quote);
      }
    }

    const k = this.MAX_VALID_QUOTES_PER_PERCENTAGE;
    const bothPresent = noHookQuotes.length > 0 && aggHookQuotes.length > 0;
    const noHookBudgetIfPartitioned = Math.ceil(k / 2);
    const useBothPopulatedPartition =
      bothPresent &&
      this.isAggHookCompetitive(
        aggHookQuotes,
        noHookQuotes,
        noHookBudgetIfPartitioned,
        tradeType
      );
    const noHookBudget = useBothPopulatedPartition
      ? noHookBudgetIfPartitioned
      : noHookQuotes.length > 0
        ? k
        : 0;
    const aggHookBudget = k - noHookBudget;

    const returnedQuotes = [
      ...noHookQuotes.slice(0, noHookBudget),
      ...aggHookQuotes.slice(0, aggHookBudget),
    ];

    // Instrumentation is gated on the partition having actually fired
    // (`useBothPopulatedPartition`), so the "evicts better no-hook" log
    // accurately describes what happened. The sole-candidate path still
    // applies when only the agg-hook class is populated.
    if (instrumentation && instrumentation.testAggHooks) {
      if (useBothPopulatedPartition) {
        this.maybeLogPartitionDecision(
          percentage,
          chainId,
          noHookQuotes,
          aggHookQuotes,
          noHookBudget,
          aggHookBudget,
          instrumentation
        );
        this.maybeLogPartitionGasAdjustedDecision(
          percentage,
          chainId,
          noHookQuotes,
          aggHookQuotes,
          noHookBudget,
          instrumentation
        );
        // Investigation: the `isAggHookCompetitive` early-return at "no
        // displacement happens" skips the gas check entirely, so an agg-hook
        // quote with materially higher gas use still gets a slot when
        // `noHookQuotes.length <= noHookBudgetIfPartitioned`. The existing
        // PartitionDecision / PartitionGasAdjustedDecision instrumentation
        // both short-circuit on the same condition, so this case is
        // currently invisible in prod telemetry. Fire a dedicated signal.
        if (noHookQuotes.length <= noHookBudgetIfPartitioned) {
          this.maybeLogGateEarlyReturnLeak(
            percentage,
            chainId,
            noHookQuotes,
            aggHookQuotes,
            instrumentation
          );
        }
      } else if (aggHookQuotes.length > 0 && noHookQuotes.length === 0) {
        this.maybeLogAggHookSoleCandidate(
          percentage,
          chainId,
          aggHookQuotes,
          instrumentation
        );
      }
    }

    return {
      quotes: returnedQuotes,
      totalCount: quotes.length,
      validCount: validQuotes.length,
      returnedCount: returnedQuotes.length,
    };
  }

  /**
   * Returns true if it's worth reserving a partition slot for the agg-hook
   * class — i.e., the agg-hook winner is at most
   * `AGG_HOOK_PARTITION_TOLERANCE_BPS` worse than the displaced no-hook
   * runner-up on raw amount, AND uses at most
   * `AGG_HOOK_PARTITION_GAS_TOLERANCE_UNITS` more gas than the runner-up.
   *
   * Both gates must pass. The raw gate (added in PR #8114) prevents the
   * partition from evicting a strictly-better no-hook quote on amount. The
   * gas gate (added here) prevents it from keeping a quote that ties on
   * raw but burns materially more gas — the residual loss pattern that
   * PR #8132/#8142 instrumentation captured in prod at ~7,665 occurrences
   * per 10 minutes (80–97k extra gas units per partition firing).
   *
   * Inputs are pre-sorted by amount in the trade-direction-appropriate
   * order (best first). `noHookBudgetIfPartitioned` is the count of
   * no-hook quotes that would be kept under the partition (typically
   * Math.ceil(k/2)); the displaced quote (when one exists) is therefore
   * at `noHookQuotes[noHookBudgetIfPartitioned]`.
   *
   * Anchoring:
   *   raw-bps gate runs ONLY when displacement happens (a runner-up
   *     exists at `noHookQuotes[noHookBudgetIfPartitioned]`). If no
   *     runner-up exists, nothing is being evicted, so the raw badness
   *     comparison has no meaningful anchor — skip the raw check.
   *   gas-use gate runs ALWAYS against `noHookQuotes[0]` (best no-hook
   *     in the bucket), regardless of whether displacement happens. The
   *     reason: even when no no-hook is being displaced, the agg-hook
   *     still gets a partition slot alongside the surviving no-hook(s),
   *     and downstream `scoreAndSortCombinations` ranks splits by raw
   *     amount only — so a gas-heavier agg-hook can still surface in
   *     the final split. Anchoring against the best no-hook (rather
   *     than the runner-up) reflects the alternative DFS would pick if
   *     agg-hook were excluded from the candidate set.
   *
   * Pre-fix (PR #8161) anchored gas against `noHookRunnerUp` and
   * short-circuited via `noHookQuotes.length <= noHookBudgetIfPartitioned`,
   * which skipped the gas check entirely when no displacement happened.
   * Prod telemetry from PR #8182's `GateEarlyReturnLeak` metric
   * recorded 100+ leak emissions in the first 3 min of the fixed
   * deploy, with sample gas deltas matching the 80k/97k pattern seen
   * pre-PR-#8161 — proving the leak was the proximate cause of the
   * residual ~50/min losses.
   *
   * If `gasDetails.gasUse` is absent on either side, the gas gate is
   * skipped (preserves test-mock compatibility).
   */
  private isAggHookCompetitive(
    aggHookQuotes: QuoteBasic[],
    noHookQuotes: QuoteBasic[],
    noHookBudgetIfPartitioned: number,
    tradeType: TradeType
  ): boolean {
    if (aggHookQuotes.length === 0) return false;
    // Defensive: caller's `bothPresent` check guarantees noHookQuotes
    // is non-empty before invoking. Guard the array-access below
    // regardless so this stays safe in isolation.
    if (noHookQuotes.length === 0) return true;

    const aggHookWinner = aggHookQuotes[0];
    const noHookWinner = noHookQuotes[0];
    const noHookRunnerUp =
      noHookQuotes.length > noHookBudgetIfPartitioned
        ? noHookQuotes[noHookBudgetIfPartitioned]
        : undefined;

    // --- Raw-amount gate (PR #8114) ---
    // Scoped to the displacement case: only meaningful when a no-hook
    // quote is actually being kicked out. With k=2 and
    // noHookBudgetIfPartitioned=1, this fires iff noHookQuotes.length>=2.
    if (noHookRunnerUp !== undefined) {
      // Direction-aware "badness" = how much the agg-hook winner is worse
      // than the no-hook quote the partition would displace.
      //   EXACT_IN: higher amount is better → badness = runnerUp.amount - winner.amount
      //   EXACT_OUT: lower amount is better → badness = winner.amount - runnerUp.amount
      const badness =
        tradeType === TradeType.ExactIn
          ? noHookRunnerUp.amount - aggHookWinner.amount
          : aggHookWinner.amount - noHookRunnerUp.amount;

      if (badness > 0n) {
        // bps comparison without floats:
        //   (badness / runnerUp.amount) * 10000 <= tolerance
        //   ↔ badness * 10000 <= tolerance * runnerUp.amount
        if (
          badness * 10000n >
          this.AGG_HOOK_PARTITION_TOLERANCE_BPS * noHookRunnerUp.amount
        ) {
          return false;
        }
      }
    }

    // --- Gas-use gate (PR #8161, extended to anchor on `noHookWinner`) ---
    // Direction-agnostic: lower gas is always better. Anchor is the
    // best no-hook in the bucket — the alternative DFS would pick if
    // agg-hook were excluded. Skip if gas info is missing on either
    // side (preserves backward compat with code paths that don't
    // populate gasDetails, notably unit-test mocks).
    const aggHookGasUse = aggHookWinner.gasDetails?.gasUse;
    const noHookGasUse = noHookWinner.gasDetails?.gasUse;
    if (aggHookGasUse !== undefined && noHookGasUse !== undefined) {
      if (aggHookGasUse > noHookGasUse) {
        const gasUseDelta = aggHookGasUse - noHookGasUse;
        if (gasUseDelta > this.AGG_HOOK_PARTITION_GAS_TOLERANCE_UNITS) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Investigation-only: confirms whether the K-budget partition is responsible
   * for evicting a better no-hook quote in favor of an agg-hook quote at a
   * given percentage step. Emits a metric on every partition decision (with
   * verdict tag), and a structured log only on the "agg-hook winner is worse
   * than displaced no-hook runner-up" case, capped per-request.
   */
  private maybeLogPartitionDecision(
    percentage: number,
    chainId: ChainId,
    noHookQuotes: QuoteBasic[],
    aggHookQuotes: QuoteBasic[],
    noHookBudget: number,
    aggHookBudget: number,
    instrumentation: {
      ctx: UniContext;
      tradeType: TradeType;
      testAggHooks: boolean | undefined;
      partitionEvictLogBudget: {remaining: number};
      soleCandidateLogBudget: {remaining: number};
      partitionGasAdjustedLogBudget: {remaining: number};
      gateEarlyReturnLeakLogBudget: {remaining: number};
      metricTags: string[];
    }
  ): void {
    // Without a no-hook runner-up there's nobody to evict — partition was a
    // no-op on the no-hook side. Skip.
    if (noHookQuotes.length <= noHookBudget) return;
    if (aggHookQuotes.length === 0) return;

    const aggHookWinner = aggHookQuotes[0];
    const noHookRunnerUp = noHookQuotes[noHookBudget];
    const noHookWinner = noHookQuotes[0];

    // For EXACT_IN, higher amount is better. For EXACT_OUT, lower amount is
    // better. Compare the agg-hook winner against the no-hook runner-up
    // (the candidate the partition is implicitly evicting).
    const isExactIn = instrumentation.tradeType === TradeType.ExactIn;
    const aggHookWorseThanRunnerUp = isExactIn
      ? aggHookWinner.amount < noHookRunnerUp.amount
      : aggHookWinner.amount > noHookRunnerUp.amount;

    const verdictTag = `partitionVerdict:${
      aggHookWorseThanRunnerUp
        ? 'agghook_worse_than_runnerup'
        : 'agghook_better_or_tie'
    }`;
    void instrumentation.ctx.metrics.count(
      buildMetricKey('QuoteBestSplitFinder.PartitionDecision'),
      1,
      {
        tags: [
          ...instrumentation.metricTags,
          verdictTag,
          `testAggHooks:${instrumentation.testAggHooks}`,
          `tradeType:${instrumentation.tradeType}`,
        ],
      }
    );

    if (!aggHookWorseThanRunnerUp) return;
    if (instrumentation.partitionEvictLogBudget.remaining <= 0) return;
    instrumentation.partitionEvictLogBudget.remaining -= 1;

    instrumentation.ctx.logger.info(
      'QuoteBestSplitFinder partition evicts better no-hook',
      {
        chainId,
        percentage,
        tradeType: instrumentation.tradeType,
        noHookCount: noHookQuotes.length,
        aggHookCount: aggHookQuotes.length,
        noHookBudget,
        aggHookBudget,
        aggHookWinner: {
          routeHash: hashForLogging(aggHookWinner.route.toString()),
          amount: aggHookWinner.amount.toString(),
        },
        noHookRunnerUp: {
          routeHash: hashForLogging(noHookRunnerUp.route.toString()),
          amount: noHookRunnerUp.amount.toString(),
        },
        noHookWinner: {
          routeHash: hashForLogging(noHookWinner.route.toString()),
          amount: noHookWinner.amount.toString(),
        },
      }
    );
  }

  /**
   * Investigation-only: catches the case where the agg-hook code path is
   * selecting an agg-hook quote at a percentage because NO no-hook candidate
   * is present in `percentageToSortedQuotes` at that percentage — i.e. the
   * agg-hook quote wins by default, not by partition eviction. This is the
   * upstream-filter signal: it implicates cached routes / route cap / the
   * pre-`findBestSplits` percentage-bucket assembly rather than K-budget.
   */
  private maybeLogAggHookSoleCandidate(
    percentage: number,
    chainId: ChainId,
    aggHookQuotes: QuoteBasic[],
    instrumentation: {
      ctx: UniContext;
      tradeType: TradeType;
      testAggHooks: boolean | undefined;
      partitionEvictLogBudget: {remaining: number};
      soleCandidateLogBudget: {remaining: number};
      partitionGasAdjustedLogBudget: {remaining: number};
      gateEarlyReturnLeakLogBudget: {remaining: number};
      metricTags: string[];
    }
  ): void {
    if (aggHookQuotes.length === 0) return;
    const aggHookWinner = aggHookQuotes[0];

    void instrumentation.ctx.metrics.count(
      buildMetricKey('QuoteBestSplitFinder.AggHookSoleCandidate'),
      1,
      {
        tags: [
          ...instrumentation.metricTags,
          `testAggHooks:${instrumentation.testAggHooks}`,
          `tradeType:${instrumentation.tradeType}`,
        ],
      }
    );

    if (instrumentation.soleCandidateLogBudget.remaining <= 0) return;
    instrumentation.soleCandidateLogBudget.remaining -= 1;

    // Include gasUse so DD analytics can correlate sole-candidate firings
    // with the high-gas Curve+Fluid path observed in prod losses (no
    // no-hook competitor exists to anchor a relative comparison, so we log
    // the absolute gas-use to let queries filter by magnitude).
    instrumentation.ctx.logger.info(
      'QuoteBestSplitFinder agg-hook quote selected with no no-hook competitor',
      {
        chainId,
        percentage,
        tradeType: instrumentation.tradeType,
        aggHookCount: aggHookQuotes.length,
        aggHookWinner: {
          routeHash: hashForLogging(aggHookWinner.route.toString()),
          amount: aggHookWinner.amount.toString(),
          gasUse: aggHookWinner.gasDetails?.gasUse?.toString(),
        },
      }
    );
  }

  /**
   * Investigation-only: companion to maybeLogPartitionDecision that catches
   * the case the raw-only gate can't see — when the partition fires because
   * the agg-hook winner ties or beats the displaced no-hook runner-up on
   * RAW amount, but uses materially MORE GAS (and therefore loses on
   * gas-adjusted ranking downstream of `findBestSplits`).
   *
   * Why compare gas use rather than gas-adjusted amount: `gasCostInQuoteToken`
   * is populated by `GasConverter.updateQuotesGasDetails` AFTER findBestSplits
   * returns, so it's undefined at the partition step. `gasDetails.gasUse`
   * (gas units) is populated by the per-protocol gas estimators when
   * `DeepQuoteStrategy.findBestQuoteCandidates` builds `quotesWithGas`, so
   * it's always available here. Both quotes pay the same gas price on the
   * same chain, so a direct gas-use comparison is a strong proxy for
   * gas-adjusted cost without needing the quote-token conversion.
   *
   * Pre-condition: caller has determined the partition actually fired
   * (`useBothPopulatedPartition === true`). If gas info is missing on
   * either side, emits the metric with a `gas_info_missing` tag and
   * skips the log.
   *
   * Emits:
   *   metric `QuoteBestSplitFinder.PartitionGasAdjustedDecision` tagged
   *     `gasAdjustedVerdict:{agghook_more_gas_used,agghook_equal_or_less_gas_used,gas_info_missing}`
   *     + the standard `testAggHooks`/`tradeType`/baseline tags. Fires on
   *     every partition firing where a no-hook runner-up exists. Metric
   *     name kept stable so prod dashboards / saved queries keep working;
   *     the verdict tag values are the meaningful change.
   *   log `'QuoteBestSplitFinder partition kept higher-gas agg-hook'` only
   *     when verdict is `agghook_more_gas_used`, capped per request via
   *     `partitionGasAdjustedLogBudget`.
   */
  private maybeLogPartitionGasAdjustedDecision(
    percentage: number,
    chainId: ChainId,
    noHookQuotes: QuoteBasic[],
    aggHookQuotes: QuoteBasic[],
    noHookBudget: number,
    instrumentation: {
      ctx: UniContext;
      tradeType: TradeType;
      testAggHooks: boolean | undefined;
      partitionEvictLogBudget: {remaining: number};
      soleCandidateLogBudget: {remaining: number};
      partitionGasAdjustedLogBudget: {remaining: number};
      gateEarlyReturnLeakLogBudget: {remaining: number};
      metricTags: string[];
    }
  ): void {
    // No-hook runner-up at position noHookBudget is the candidate the
    // partition implicitly evicts. If it doesn't exist, partition wasn't
    // displacing anyone — nothing to compare gas use against.
    if (noHookQuotes.length <= noHookBudget) return;
    if (aggHookQuotes.length === 0) return;

    const aggHookWinner = aggHookQuotes[0];
    const noHookRunnerUp = noHookQuotes[noHookBudget];

    const baseTags = [
      ...instrumentation.metricTags,
      `testAggHooks:${instrumentation.testAggHooks}`,
      `tradeType:${instrumentation.tradeType}`,
    ];

    const aggHookGasUse = aggHookWinner.gasDetails?.gasUse;
    const noHookGasUse = noHookRunnerUp.gasDetails?.gasUse;
    if (aggHookGasUse === undefined || noHookGasUse === undefined) {
      void instrumentation.ctx.metrics.count(
        buildMetricKey('QuoteBestSplitFinder.PartitionGasAdjustedDecision'),
        1,
        {tags: [...baseTags, 'gasAdjustedVerdict:gas_info_missing']}
      );
      return;
    }

    // Lower gas use is better for both trade directions — gas converts to
    // a quote-token cost via a shared chain gas price, so direct
    // comparison is direction-agnostic.
    const aggHookUsesMoreGas = aggHookGasUse > noHookGasUse;

    const verdictTag = aggHookUsesMoreGas
      ? 'gasAdjustedVerdict:agghook_more_gas_used'
      : 'gasAdjustedVerdict:agghook_equal_or_less_gas_used';
    void instrumentation.ctx.metrics.count(
      buildMetricKey('QuoteBestSplitFinder.PartitionGasAdjustedDecision'),
      1,
      {tags: [...baseTags, verdictTag]}
    );

    if (!aggHookUsesMoreGas) return;
    if (instrumentation.partitionGasAdjustedLogBudget.remaining <= 0) return;
    instrumentation.partitionGasAdjustedLogBudget.remaining -= 1;

    instrumentation.ctx.logger.info(
      'QuoteBestSplitFinder partition kept higher-gas agg-hook',
      {
        chainId,
        percentage,
        tradeType: instrumentation.tradeType,
        aggHookWinner: {
          routeHash: hashForLogging(aggHookWinner.route.toString()),
          amount: aggHookWinner.amount.toString(),
          gasUse: aggHookGasUse.toString(),
        },
        noHookRunnerUp: {
          routeHash: hashForLogging(noHookRunnerUp.route.toString()),
          amount: noHookRunnerUp.amount.toString(),
          gasUse: noHookGasUse.toString(),
        },
        gasUseDelta: (aggHookGasUse - noHookGasUse).toString(),
      }
    );
  }

  /**
   * Investigation-only: catches the case where `isAggHookCompetitive` returns
   * true via its "no displacement" early-return — i.e.
   * `noHookQuotes.length <= noHookBudgetIfPartitioned` (typically exactly 1
   * no-hook quote at the percentage with k=2). The gate's gas check is
   * skipped in that branch, so an agg-hook winner with materially higher
   * gas use still gets a partition slot alongside the lone no-hook quote.
   * Once both classes sit in the per-percentage candidate set, the upstream
   * DFS scores combinations by RAW amount only, so the gas-heavy agg-hook
   * can win a 1–2 bps raw advantage and surface in the final split.
   *
   * Pre-existing `maybeLogPartitionDecision` and
   * `maybeLogPartitionGasAdjustedDecision` both short-circuit on the same
   * `noHookQuotes.length <= noHookBudget` condition (see their guards) so
   * this case is invisible in `PartitionDecision` /
   * `PartitionGasAdjustedDecision` telemetry. This method fires a dedicated
   * metric and log to make the leak visible without changing any decision
   * behavior.
   *
   * Pre-condition: caller has determined `useBothPopulatedPartition === true`
   * AND `noHookQuotes.length <= noHookBudgetIfPartitioned` (the gate's
   * early-return path). The comparison anchor is `noHookQuotes[0]` — the
   * best no-hook in the bucket — since the partition is admitting agg-hook
   * alongside it without any gas check.
   *
   * Emits:
   *   metric `QuoteBestSplitFinder.GateEarlyReturnLeak` tagged with
   *     `gasVerdict:{agghook_more_gas_used,agghook_equal_or_less_gas_used,gas_info_missing}`
   *     + standard tags. Fires on every early-return-path partition firing.
   *   log `'QuoteBestSplitFinder gate early-return admitted higher-gas agg-hook'`
   *     only when verdict is `agghook_more_gas_used`, capped per request via
   *     `gateEarlyReturnLeakLogBudget`.
   */
  private maybeLogGateEarlyReturnLeak(
    percentage: number,
    chainId: ChainId,
    noHookQuotes: QuoteBasic[],
    aggHookQuotes: QuoteBasic[],
    instrumentation: {
      ctx: UniContext;
      tradeType: TradeType;
      testAggHooks: boolean | undefined;
      partitionEvictLogBudget: {remaining: number};
      soleCandidateLogBudget: {remaining: number};
      partitionGasAdjustedLogBudget: {remaining: number};
      gateEarlyReturnLeakLogBudget: {remaining: number};
      metricTags: string[];
    }
  ): void {
    if (aggHookQuotes.length === 0 || noHookQuotes.length === 0) return;

    const aggHookWinner = aggHookQuotes[0];
    const noHookWinner = noHookQuotes[0];

    const baseTags = [
      ...instrumentation.metricTags,
      `testAggHooks:${instrumentation.testAggHooks}`,
      `tradeType:${instrumentation.tradeType}`,
    ];

    const aggHookGasUse = aggHookWinner.gasDetails?.gasUse;
    const noHookGasUse = noHookWinner.gasDetails?.gasUse;
    if (aggHookGasUse === undefined || noHookGasUse === undefined) {
      void instrumentation.ctx.metrics.count(
        buildMetricKey('QuoteBestSplitFinder.GateEarlyReturnLeak'),
        1,
        {tags: [...baseTags, 'gasVerdict:gas_info_missing']}
      );
      return;
    }

    const aggHookUsesMoreGas = aggHookGasUse > noHookGasUse;

    const verdictTag = aggHookUsesMoreGas
      ? 'gasVerdict:agghook_more_gas_used'
      : 'gasVerdict:agghook_equal_or_less_gas_used';
    void instrumentation.ctx.metrics.count(
      buildMetricKey('QuoteBestSplitFinder.GateEarlyReturnLeak'),
      1,
      {tags: [...baseTags, verdictTag]}
    );

    if (!aggHookUsesMoreGas) return;
    if (instrumentation.gateEarlyReturnLeakLogBudget.remaining <= 0) return;
    instrumentation.gateEarlyReturnLeakLogBudget.remaining -= 1;

    instrumentation.ctx.logger.info(
      'QuoteBestSplitFinder gate early-return admitted higher-gas agg-hook',
      {
        chainId,
        percentage,
        tradeType: instrumentation.tradeType,
        noHookCount: noHookQuotes.length,
        aggHookCount: aggHookQuotes.length,
        aggHookWinner: {
          routeHash: hashForLogging(aggHookWinner.route.toString()),
          amount: aggHookWinner.amount.toString(),
          gasUse: aggHookGasUse.toString(),
        },
        noHookWinner: {
          routeHash: hashForLogging(noHookWinner.route.toString()),
          amount: noHookWinner.amount.toString(),
          gasUse: noHookGasUse.toString(),
        },
        gasUseDelta: (aggHookGasUse - noHookGasUse).toString(),
      }
    );
  }

  /**
   * Scores and sorts route combinations based on total quote amounts
   * @param combinations Array of route combinations to score and sort
   * @param quoteMap Pre-computed map of routes to quotes for O(1) lookup
   * @param tradeType The trade type to determine sorting direction
   * @returns Sorted array of route combinations (descending for ExactIn, ascending for ExactOut)
   */
  private scoreAndSortCombinations(
    combinations: RouteBasic<TPool>[][],
    quoteMap: Map<RouteBasic<TPool>, QuoteBasic>,
    tradeType: TradeType
  ): RouteBasic<TPool>[][] {
    const scoredCombinations = combinations.map(combination => {
      const totalAmount = combination.reduce(
        (sum, route) => sum + (quoteMap.get(route)?.amount || 0n),
        0n
      );

      return {
        combination,
        score: totalAmount,
      };
    });

    // Sort by score - descending for EXACT_IN, ascending for EXACT_OUT
    scoredCombinations.sort((a, b) => {
      const comparison = b.score > a.score ? 1 : b.score < a.score ? -1 : 0;
      return tradeType === TradeType.ExactOut ? -comparison : comparison;
    });

    return scoredCombinations.map(item => item.combination);
  }

  /**
   * Filters and sorts results to keep only the best ones based on maxSplitRoutes limit
   * Prioritizes 100% routes over split routes and applies trade-type-specific sorting
   * @param results Array of route combinations to filter and sort
   * @param maxSplitRoutes Maximum number of split routes to return
   * @param quoteMap Pre-computed map of routes to quotes for O(1) lookup
   * @param tradeType The trade type to determine sorting direction
   * @returns Filtered and sorted array of route combinations
   */
  private filterAndSortResults(
    results: RouteBasic<TPool>[][],
    maxSplitRoutes: number,
    quoteMap: Map<RouteBasic<TPool>, QuoteBasic>,
    tradeType: TradeType
  ): RouteBasic<TPool>[][] {
    // If maxSplitRoutes is 0, return empty array
    if (maxSplitRoutes <= 0) {
      return [];
    }

    if (results.length <= maxSplitRoutes) {
      // Still need to sort even when we don't need to filter
      return this.scoreAndSortCombinations(results, quoteMap, tradeType);
    }

    // Keep all 100% routes
    const fullRoutes = results.filter(
      combination =>
        combination.length === 1 && combination[0].percentage === 100
    );

    // For split routes, score them based on the quote amounts
    const splitRoutes = results.filter(
      combination =>
        !(combination.length === 1 && combination[0].percentage === 100)
    );

    const sortedSplitRoutes = this.scoreAndSortCombinations(
      splitRoutes,
      quoteMap,
      tradeType
    );

    // If we have more 100% routes than maxSplitRoutes, only keep the first maxSplitRoutes
    if (fullRoutes.length >= maxSplitRoutes) {
      return fullRoutes.slice(0, maxSplitRoutes);
    }

    // Combine full routes with top scoring split routes
    const remainingSlots = maxSplitRoutes - fullRoutes.length;
    const topSplitRoutes = sortedSplitRoutes.slice(
      0,
      Math.max(0, remainingSlots)
    );

    return [...fullRoutes, ...topSplitRoutes];
  }

  public async findBestSplits(
    chainId: ChainId,
    percentageToSortedQuotes: Map<number, QuoteBasic[]>,
    percentageStep: number,
    maxSplits: number,
    maxSplitRoutes: number,
    timeoutMs: number,
    tradeType: TradeType,
    metricTags: string[],
    ctx: UniContext,
    testAggHooks?: boolean
  ): Promise<RouteBasic<TPool>[][]> {
    if (percentageStep < 5 || percentageStep > 100) {
      throw new Error('Percentage step must be between 5 and 100');
    }
    if (100 % percentageStep !== 0) {
      throw new Error('Percentage step must divide 100 exactly');
    }

    const combinations = new Set<string>();
    let result: RouteBasic<TPool>[][] = [];
    let currentLevelBestAmount = 0n;
    let previousLevelBestAmount = 0n;
    const startTime = Date.now();
    let timedOut = false;
    let earlyExitReason:
      | 'timeout'
      | 'no_new_routes'
      | 'low_improvement'
      | null = null;
    const bestUnusedQuoteStats = {
      calls: 0,
      totalQuotes: 0,
      validQuotes: 0,
      returnedQuotes: 0,
      droppedByConflict: 0,
      droppedByLimit: 0,
    };
    // Per-request caps on instrumentation logs (cf. maybeLogPartitionDecision,
    // maybeLogAggHookSoleCandidate, maybeLogPartitionGasAdjustedDecision,
    // maybeLogGateEarlyReturnLeak). Metrics fire unconditionally.
    const partitionEvictLogBudget = {remaining: 5};
    const soleCandidateLogBudget = {remaining: 5};
    const partitionGasAdjustedLogBudget = {remaining: 5};
    const gateEarlyReturnLeakLogBudget = {remaining: 5};

    // Pre-compute quote lookup map for O(1) access throughout the function
    const quoteMap = new Map<RouteBasic<TPool>, QuoteBasic>();
    for (const quotes of percentageToSortedQuotes.values()) {
      for (const quote of quotes) {
        quoteMap.set(quote.route as RouteBasic<TPool>, quote);
      }
    }

    // Helper to convert a combination to a unique string key
    const getCombinationKey = (combination: RouteBasic<TPool>[]) => {
      return combination
        .map(
          route =>
            `${route.path.map(p => p.address.toString()).join(',')}-${route.percentage}`
        )
        .sort()
        .join('|');
    };

    // Helper to add a combination if it's unique and track best amount
    const addCombination = (routes: RouteBasic<TPool>[]) => {
      const key = getCombinationKey(routes);
      if (!combinations.has(key)) {
        combinations.add(key);
        result.push([...routes]);

        // Calculate total amount for this combination using pre-computed map
        const quotes = routes.map(route => quoteMap.get(route));
        const totalAmount = quotes.reduce(
          (sum, q) => (q ? sum + q.amount : sum),
          0n
        );

        // Update best amount if this combination is better
        if (totalAmount > currentLevelBestAmount) {
          currentLevelBestAmount = totalAmount;
        }
      }
    };
    const getBestUnusedQuotes = (
      percentage: number,
      currentRoutes: RouteBasic<TPool>[]
    ): QuoteBasic[] => {
      const stats = this.getBestUnusedQuotesStats(
        percentage,
        percentageToSortedQuotes,
        currentRoutes,
        chainId,
        tradeType,
        {
          ctx,
          tradeType,
          testAggHooks,
          partitionEvictLogBudget,
          soleCandidateLogBudget,
          partitionGasAdjustedLogBudget,
          gateEarlyReturnLeakLogBudget,
          metricTags,
        }
      );
      bestUnusedQuoteStats.calls++;
      bestUnusedQuoteStats.totalQuotes += stats.totalCount;
      bestUnusedQuoteStats.validQuotes += stats.validCount;
      bestUnusedQuoteStats.returnedQuotes += stats.returnedCount;
      bestUnusedQuoteStats.droppedByConflict +=
        stats.totalCount - stats.validCount;
      bestUnusedQuoteStats.droppedByLimit +=
        stats.validCount - stats.returnedCount;
      return stats.quotes;
    };

    // First, add all 100% routes from the best quotes
    const fullQuotes = percentageToSortedQuotes.get(100) || [];
    // Try all 100% routes since they're the most efficient
    for (let i = 0; i < fullQuotes.length; i++) {
      addCombination([fullQuotes[i].route as RouteBasic<TPool>]);
    }

    // If we only want single routes, return early
    if (maxSplits === 1) {
      return result;
    }

    // Set previous level best amount after processing level 1
    previousLevelBestAmount = currentLevelBestAmount;

    ctx.logger.debug(
      `QuoteBestSplitFinder: after level 1 we got ${result.length} route combinations`
    );

    // Helper function to generate combinations level by level
    const generateCombinationsForLevel = async (
      splitLevel: number,
      remainingPercentage: number,
      currentRoutes: RouteBasic<TPool>[]
    ) => {
      // Check for timeout
      if (Date.now() - startTime > timeoutMs) {
        timedOut = true;
        earlyExitReason = 'timeout';
        return;
      }

      // If we've reached our target split level and used exactly 100%, add the combination
      if (splitLevel === 0 && remainingPercentage === 0) {
        addCombination(currentRoutes);
        return;
      }

      // If we can't complete this combination, return
      if (splitLevel === 0 || remainingPercentage === 0) {
        return;
      }

      // If this is the last split (splitLevel = 1), use the remaining percentage directly
      if (splitLevel === 1) {
        // Only proceed if remaining percentage is valid
        if (
          remainingPercentage >= percentageStep &&
          remainingPercentage <= 100 - percentageStep
        ) {
          const availableQuotes = getBestUnusedQuotes(
            remainingPercentage,
            currentRoutes
          );

          // Try each available quote
          for (const quote of availableQuotes) {
            const route = quote.route as RouteBasic<TPool>;
            currentRoutes.push(route);
            await generateCombinationsForLevel(0, 0, currentRoutes);
            currentRoutes.pop();

            if (timedOut) break;
          }
        }
        return;
      }

      // For non-final splits, iterate through possible percentages
      const maxPercent = Math.min(remainingPercentage, 100 - percentageStep);
      for (
        let percent = percentageStep;
        percent <= maxPercent && !timedOut;
        percent += percentageStep
      ) {
        // Check for timeout in the percentage loop
        if (Date.now() - startTime > timeoutMs) {
          timedOut = true;
          earlyExitReason = 'timeout';
          return;
        }

        // Get best available quotes for this percentage
        const availableQuotes = getBestUnusedQuotes(percent, currentRoutes);

        // Try each available quote
        for (const quote of availableQuotes) {
          // Check for timeout in the inner loop
          if (Date.now() - startTime > timeoutMs) {
            timedOut = true;
            earlyExitReason = 'timeout';
            return;
          }

          const route = quote.route as RouteBasic<TPool>;
          currentRoutes.push(route);
          await generateCombinationsForLevel(
            splitLevel - 1,
            remainingPercentage - percent,
            currentRoutes
          );
          currentRoutes.pop();

          if (timedOut) break;
        }
      }
    };

    // Generate combinations level by level, from 2 splits up to maxSplits
    for (let level = 2; level <= maxSplits && !timedOut; level++) {
      await ctx.metrics.count(
        buildMetricKey(`QuoteBestSplitFinder.Level.Invocations.${level}`),
        1,
        {
          tags: metricTags,
        }
      );

      const previousResultLength = result.length;
      // Reset current level best amount before processing new level
      currentLevelBestAmount = previousLevelBestAmount;
      // Snapshot the timeout flag to detect mid-level truncation. If
      // generateCombinationsForLevel sets `timedOut`, this level's results are
      // partial — we must not infer convergence from the partial improvement.
      const wasTimedOutBeforeLevel = timedOut;
      await generateCombinationsForLevel(level, 100, []);
      const wasTruncatedThisLevel = !wasTimedOutBeforeLevel && timedOut;

      const unfilteredResultLength = result.length;

      await ctx.metrics.count(
        buildMetricKey(`QuoteBestSplitFinder.Level.Results.${level}`),
        unfilteredResultLength - previousResultLength,
        {
          tags: metricTags,
        }
      );

      ctx.logger.debug(
        `QuoteBestSplitFinder: after level ${level} we got ${unfilteredResultLength} route combinations`
      );

      // Filter and sort results after each level to keep array size manageable
      result = this.filterAndSortResults(
        result,
        maxSplitRoutes,
        quoteMap,
        tradeType
      );

      // Exit early if no new routes were added (check before filtering)
      if (unfilteredResultLength === previousResultLength) {
        ctx.logger.debug(
          `QuoteBestSplitFinder: No new routes added at level ${level}, exiting early`
        );
        earlyExitReason = 'no_new_routes';
        break;
      }

      // Calculate improvement percentage
      if (previousLevelBestAmount > 0n) {
        const improvement =
          (Number(currentLevelBestAmount - previousLevelBestAmount) /
            Number(previousLevelBestAmount)) *
          100;

        ctx.logger.debug(
          `QuoteBestSplitFinder: Level ${level} improvement: ${improvement.toFixed(5)}%`
        );

        // Exit if improvement is less than 0.01%, but only if we've tried at
        // least 3 splits and this level finished generating combinations. A
        // level whose recursion was cut off by the split-finder timeout
        // produces a partial result whose 0% "improvement" is meaningless;
        // the loop's top-of-iteration `!timedOut` guard will end the search
        // anyway, so we just skip the spurious low-improvement exit here.
        if (
          level >= this.MIN_SPLIT_LEVELS_BEFORE_EARLY_EXIT &&
          improvement < this.MIN_IMPROVEMENT_PCT_PER_LEVEL &&
          !wasTruncatedThisLevel
        ) {
          ctx.logger.debug(
            `QuoteBestSplitFinder: Improvement less than 0.01% at level ${level}, exiting early`
          );
          earlyExitReason = 'low_improvement';
          break;
        }
      }

      previousLevelBestAmount = currentLevelBestAmount;
    }

    if (timedOut) {
      ctx.logger.warn(
        `QuoteBestSplitFinder: Timed out after ${timeoutMs}ms with ${result.length} combinations found`
      );
      await ctx.metrics.count(
        buildMetricKey('QuoteBestSplitFinder.TimedOut'),
        1,
        {
          tags: metricTags,
        }
      );
    } else {
      ctx.logger.debug(
        `QuoteBestSplitFinder: Pre-filter ${result.length} route combinations`
      );
    }

    ctx.logger.debug('QuoteBestSplitFinder observability', {
      chainId,
      percentageStep,
      maxSplits,
      maxSplitRoutes,
      timeoutMs,
      elapsedMs: Date.now() - startTime,
      timedOut,
      earlyExitReason,
      combinationsFound: result.length,
      bestUnusedQuoteStats,
    });
    const earlyExitTag = `earlyExitReason:${earlyExitReason ?? 'normal'}`;
    await Promise.all([
      ctx.metrics.count(
        buildMetricKey('QuoteBestSplitFinder.PrunedByConflict'),
        bestUnusedQuoteStats.droppedByConflict,
        {tags: metricTags}
      ),
      ctx.metrics.count(
        buildMetricKey('QuoteBestSplitFinder.PrunedByLimit'),
        bestUnusedQuoteStats.droppedByLimit,
        {tags: metricTags}
      ),
      ctx.metrics.count(buildMetricKey('QuoteBestSplitFinder.EarlyExit'), 1, {
        tags: [...metricTags, earlyExitTag, `testAggHooks:${testAggHooks}`],
      }),
    ]);

    return result;
  }
}
