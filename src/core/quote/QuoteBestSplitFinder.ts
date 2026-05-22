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
import {
  isAggHookPool,
  routeUsesAggHook,
  hashForLogging,
} from '../../lib/observability';
import {getProtocolForAggHookAddress} from '../../lib/poolCaching/util/hooksAddressesAllowlist';
import {V4Pool} from '../../models/pool/V4Pool';

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

  /**
   * Maximum gas units a SOLE-CANDIDATE agg-hook winner is allowed to
   * exceed the cheapest no-hook quote anywhere in
   * `percentageToSortedQuotes` by, before the agg-hook is dropped
   * from the candidate set at that percentage step.
   *
   * Background: PR #8195 closed the K-budget gate's early-return leak.
   * Residual UniRoute-wins bursts on prod (~30-48 per 10 min, peaks at
   * ~60/min during agg-hook-rich traffic) come from the sole-candidate
   * path — when `noHookQuotes.length === 0 && aggHookQuotes.length > 0`
   * at a percentage bucket, the gate has no anchor and the existing
   * code admits agg-hook by default. PR #8248 instrumentation
   * (`AggHookSoleCandidateGasComparison{gasVerdict:agghook_more_gas}`)
   * sampled 200+ emissions in 3 min on prod with gas deltas clustering
   * at 65k-97k units vs the cheapest no-hook anywhere — the same gas-
   * overhead signature seen pre-PR-#8195 in the leak data, matching
   * the Curve+Fluid v4 chain shape.
   *
   * Anchor: cheapest no-hook quote across all percentages in
   * `percentageToSortedQuotes`. That's the alternative DFS would pick
   * if agg-hook were excluded entirely from the trade. Comparing the
   * agg-hook leg's gas to this whole-trade fallback is direction- and
   * percentage-agnostic: per-route gas is dominated by routing/hop
   * cost, not by the trade's notional size, so a single-hop direct
   * route at percentage=100 (~97k gas) is a meaningful baseline
   * against a 70%-allocation agg-hook leg (~162k gas).
   *
   * Defaults to 0n (strict — reject any extra gas). Constructor-
   * settable for tests. Bump this if prod data shows legitimate
   * agg-hook sole candidates being dropped (e.g. small fixed
   * overhead routes that are still net-better than the no-hook
   * fallback after raw-amount comparison downstream).
   *
   * When the agg-hook winner has no `gasDetails.gasUse`, OR there is
   * no no-hook quote anywhere in `percentageToSortedQuotes` to anchor
   * against, the gate admits — preserves test-mock compatibility and
   * avoids leaving a trade with no route when agg-hook is the only
   * option.
   */
  private readonly AGG_HOOK_SOLE_CANDIDATE_GAS_TOLERANCE_UNITS: bigint;

  /**
   * Kill-switch for the lowest-gas anchor in `isAggHookCompetitive`'s
   * gas-use gate. When false (default), the gate anchors on
   * `noHookQuotes[0]` (best by raw amount). When true, the gate scans
   * all of `noHookQuotes` for the entry with the minimum `gasUse` and
   * anchors on that instead.
   *
   * Background: `maybeLogPartitionAnchorAnalysis` instrumentation in
   * prod (`commit-fa30fa0`) showed 47.0% of partition firings (6.6M /
   * 14.0M total in 60 min) hit the
   * `anchorVerdict:lowest_gas_differs_anchor_admits` branch — the
   * raw-anchor admits agg-hook but the lowest-gas anchor would
   * reject. Trace `5715715370883124467` (a $100k LINK→USDT EXACT_IN
   * losing 29.92 bps gas-adjusted) fired
   * `firedAnchorSubOptimal=true` across 5 distinct percentage
   * buckets, then `partition kept higher-gas agg-hook` 5×, then
   * `chosen split has agg-hook with worse gas than no-hook
   * alternative`, and ended as a within-uniroute Cat-A loss +
   * trading-side Cat-B comparison loss.
   *
   * The lowest-gas anchor reflects the alternative DFS would pick
   * if agg-hook were excluded from the candidate set, which is the
   * correct comparison point for the partition's gas tradeoff —
   * `noHookQuotes[0]` (raw winner) only happens to be the right
   * anchor when it also has the lowest gas in the bucket, which the
   * instrumentation showed is true ~50.6% of the time.
   *
   * Default off to ship behind a kill-switch and validate in a
   * canary deploy before flipping. Constructor-settable for tests;
   * production reads via env var `AGG_HOOK_PARTITION_USE_LOWEST_GAS_ANCHOR`
   * in `DeepQuoteStrategy`.
   */
  private readonly AGG_HOOK_PARTITION_USE_LOWEST_GAS_ANCHOR: boolean;

  constructor(
    aggHookPartitionToleranceBps: bigint = 0n,
    aggHookPartitionGasToleranceUnits: bigint = 0n,
    aggHookSoleCandidateGasToleranceUnits: bigint = 0n,
    aggHookPartitionUseLowestGasAnchor: boolean = false
  ) {
    this.AGG_HOOK_PARTITION_TOLERANCE_BPS = aggHookPartitionToleranceBps;
    this.AGG_HOOK_PARTITION_GAS_TOLERANCE_UNITS =
      aggHookPartitionGasToleranceUnits;
    this.AGG_HOOK_SOLE_CANDIDATE_GAS_TOLERANCE_UNITS =
      aggHookSoleCandidateGasToleranceUnits;
    this.AGG_HOOK_PARTITION_USE_LOWEST_GAS_ANCHOR =
      aggHookPartitionUseLowestGasAnchor;
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
      soleCandidateGasComparisonLogBudget: {remaining: number};
      partitionAnchorAnalysisLogBudget: {remaining: number};
      aggHookAttribution: {
        firedPartitionKeptHigherGas: boolean;
        firedSoleCandidateAdmit: boolean;
        firedSoleCandidateGasWorse: boolean;
        firedChosenSplitGasWorse: boolean;
        firedAnchorSubOptimal: boolean;
      };
      metricTags: string[];
    }
  ): {
    quotes: QuoteBasic[];
    totalCount: number;
    validCount: number;
    returnedCount: number;
    // Whether the K-budget partition gate actually fired at this
    // percentage (both classes populated AND `isAggHookCompetitive`
    // returned true). Bubbled up so `findBestSplits` can correlate
    // partition admits with the final winner's agg-hook content.
    partitionAdmittedAggHook: boolean;
    // No-hook quotes that the partition admit pushed past the
    // truncation point (i.e., `noHookQuotes.slice(noHookBudget)` when
    // partitioned). These quotes will not appear in the K-slot pool
    // for this percentage; the eviction may still be harmless if DFS
    // can build the optimal combination from other percentages, or
    // harmful if the displaced route's pools are uniquely available
    // here. `findBestSplits` uses this to size the "permanent
    // exclusion" subset (displaced routes that never appear anywhere
    // else in the final result).
    displacedNoHookQuotes: QuoteBasic[];
    // Bucket-shape category for this percentage. Sizes the
    // distribution of bucket types per request — used by the
    // `KBudgetBucketProfile` metric to detect pool-discovery /
    // cross-percentage interaction asymmetries.
    bucketShape:
      | 'both_populated_partition_admitted'
      | 'both_populated_partition_rejected'
      | 'no_hook_only'
      | 'agg_hook_only_admitted'
      | 'agg_hook_only_rejected'
      | 'empty';
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
    // Sole-candidate gate: when only agg-hook quotes are present at
    // this percentage, the K-budget partition gate has no no-hook
    // anchor and would otherwise admit agg-hook by default. Compare
    // against the cheapest no-hook quote anywhere in
    // `percentageToSortedQuotes` (the alternative DFS would pick if
    // agg-hook were excluded from the trade) and reject when the
    // delta exceeds tolerance. See PR #8248 instrumentation for the
    // prod evidence.
    const useAggHookSoleCandidate =
      !bothPresent &&
      noHookQuotes.length === 0 &&
      aggHookQuotes.length > 0 &&
      this.isAggHookSoleCandidateCompetitive(
        aggHookQuotes,
        percentageToSortedQuotes,
        chainId
      );

    let noHookBudget = 0;
    let aggHookBudget = 0;
    if (useBothPopulatedPartition) {
      noHookBudget = noHookBudgetIfPartitioned;
      aggHookBudget = k - noHookBudgetIfPartitioned;
    } else if (noHookQuotes.length > 0) {
      // Either bothPresent + gate rejected (agg-hook is gas-bad vs
      // displaced runner-up), or no-hook-only bucket. Either way, all
      // K slots go to no-hook.
      noHookBudget = k;
    } else if (useAggHookSoleCandidate) {
      aggHookBudget = k;
    }
    // else: noHookQuotes.length === 0 && sole-candidate gate rejected.
    // Both budgets stay 0; bucket has no usable candidates.

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
        // Anchor-analysis instrumentation: PR #8327's prod data showed
        // gas-cost-per-gas-unit is consistent between control and
        // treatment runs (~0.298 in WETH→USDC trades), so the residual
        // UniRoute-wins-by-gas-adj losses aren't from gas-pricing
        // inconsistency. A specific failing trace
        // (`7343506789041406327`) showed treatment picked a Fluid-hook
        // v4 terminal instead of control's lower-gas no-hook v4
        // terminal at the same 55% bucket, even though the no-hook
        // v4 was in treatment's universe. Hypothesis: the K-budget
        // gate anchors on `noHookQuotes[0]` (best by raw amount) but
        // the LOWEST-GAS no-hook in the bucket is what would have
        // produced control's preferred combination. When those differ
        // and the gate's anchor is gas-heavier than the agg-hook
        // winner, the gate admits agg-hook → DFS evicts the lower-gas
        // no-hook from K=2 at that percentage.
        //
        // This emission compares (a) the agg-hook winner's gas to (b)
        // the lowest-gas no-hook in the bucket (not the gate's actual
        // anchor) so prod telemetry can size the population where
        // anchor choice matters.
        this.maybeLogPartitionAnchorAnalysis(
          percentage,
          chainId,
          noHookQuotes,
          aggHookQuotes,
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
        // Cross-bucket gas comparison: now that PR #8195 has closed the
        // K-budget gate's early-return leak in prod, the residual loss
        // bursts (peak ~48/10min vs pre-fix peak ~193/10min) come from
        // this sole-candidate path — where no no-hook quote exists at
        // the current percentage to anchor the gate. Compare the agg-
        // hook winner against the cheapest no-hook quote present at any
        // OTHER percentage (the alternative DFS would pick if we
        // excluded agg-hook entirely from this trade) so we can prove
        // the residual mechanism in prod telemetry before drafting a
        // fix.
        this.maybeLogAggHookSoleCandidateGasComparison(
          percentage,
          chainId,
          aggHookQuotes,
          percentageToSortedQuotes,
          instrumentation
        );
        // Sole-candidate gate decision (companion to PartitionDecision):
        // tells us in prod telemetry how often the gate admitted vs
        // rejected. The `verdict` tag should track the harmful-case
        // suppression rate post-fix — admitted should drop relative to
        // the volume of AggHookSoleCandidateGasComparison emissions
        // with verdict `agghook_more_gas`.
        void instrumentation.ctx.metrics.count(
          buildMetricKey('QuoteBestSplitFinder.SoleCandidateDecision'),
          1,
          {
            tags: [
              ...instrumentation.metricTags,
              `testAggHooks:${instrumentation.testAggHooks}`,
              `tradeType:${instrumentation.tradeType}`,
              `soleCandidateVerdict:${
                useAggHookSoleCandidate ? 'admitted' : 'rejected'
              }`,
            ],
          }
        );
      }
    }

    // The K-slot truncation discards no-hook quotes whose index >= noHookBudget.
    // Track them so `findBestSplits` can size "permanent exclusion" — routes
    // that never appear anywhere else in the final result, so eviction was
    // load-bearing for this percentage.
    const displacedNoHookQuotes =
      useBothPopulatedPartition && noHookQuotes.length > noHookBudget
        ? noHookQuotes.slice(noHookBudget)
        : [];

    let bucketShape:
      | 'both_populated_partition_admitted'
      | 'both_populated_partition_rejected'
      | 'no_hook_only'
      | 'agg_hook_only_admitted'
      | 'agg_hook_only_rejected'
      | 'empty';
    if (bothPresent) {
      bucketShape = useBothPopulatedPartition
        ? 'both_populated_partition_admitted'
        : 'both_populated_partition_rejected';
    } else if (noHookQuotes.length > 0) {
      bucketShape = 'no_hook_only';
    } else if (aggHookQuotes.length > 0) {
      bucketShape = useAggHookSoleCandidate
        ? 'agg_hook_only_admitted'
        : 'agg_hook_only_rejected';
    } else {
      bucketShape = 'empty';
    }

    return {
      quotes: returnedQuotes,
      totalCount: quotes.length,
      validCount: validQuotes.length,
      returnedCount: returnedQuotes.length,
      partitionAdmittedAggHook: useBothPopulatedPartition,
      displacedNoHookQuotes,
      bucketShape,
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
   *   gas-use gate runs ALWAYS. By default it anchors against
   *     `noHookQuotes[0]` (best no-hook by raw amount). When the
   *     kill-switch `AGG_HOOK_PARTITION_USE_LOWEST_GAS_ANCHOR` is
   *     enabled, it anchors against the lowest-`gasUse` quote across
   *     all of `noHookQuotes`. The lowest-gas anchor reflects the
   *     alternative DFS would pick if agg-hook were excluded from the
   *     candidate set — the raw winner only coincides with that
   *     anchor when it also happens to be the cheapest on gas, which
   *     prod telemetry (`PartitionAnchorAnalysis` metric, 60 min on
   *     `commit-fa30fa0`) showed is true 50.6% of the time. In the
   *     other 47.0% the raw-anchor would admit agg-hook while the
   *     lowest-gas anchor would reject — the prod-observed proximate
   *     cause of the Cat-B losses traced to specific requests (e.g.
   *     `5715715370883124467` fires `firedAnchorSubOptimal=true` 5×
   *     in a single LINK→USDT $100k EXACT_IN trace).
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
    // Direction-agnostic: lower gas is always better. The anchor is
    // either the raw winner (`noHookQuotes[0]`) or the lowest-gas
    // no-hook in the bucket, gated by
    // `AGG_HOOK_PARTITION_USE_LOWEST_GAS_ANCHOR`. The lowest-gas
    // anchor is what `maybeLogPartitionAnchorAnalysis` measures, and
    // prod data showed the raw-anchor admits agg-hook in 47% of
    // partition firings where the lowest-gas anchor would reject —
    // the proximate cause of the Cat-B losses traced to specific
    // requests (e.g. `5715715370883124467`). Skip if gas info is
    // missing on either side (preserves backward compat with code
    // paths that don't populate gasDetails, notably unit-test mocks).
    const aggHookGasUse = aggHookWinner.gasDetails?.gasUse;
    const noHookAnchorGasUse = this.AGG_HOOK_PARTITION_USE_LOWEST_GAS_ANCHOR
      ? this.lowestNoHookGasUse(noHookQuotes)
      : noHookWinner.gasDetails?.gasUse;
    if (aggHookGasUse !== undefined && noHookAnchorGasUse !== undefined) {
      if (aggHookGasUse > noHookAnchorGasUse) {
        const gasUseDelta = aggHookGasUse - noHookAnchorGasUse;
        if (gasUseDelta > this.AGG_HOOK_PARTITION_GAS_TOLERANCE_UNITS) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Returns the minimum `gasDetails.gasUse` across `noHookQuotes`, or
   * undefined when no quote in the input has gas info. Used by the
   * gas-use gate when `AGG_HOOK_PARTITION_USE_LOWEST_GAS_ANCHOR` is on
   * so the anchor reflects the cheapest alternative DFS would pick
   * (rather than the raw winner, which may coincidentally have higher
   * gas than another viable no-hook in the same bucket).
   */
  private lowestNoHookGasUse(noHookQuotes: QuoteBasic[]): bigint | undefined {
    let lowest: bigint | undefined;
    for (const quote of noHookQuotes) {
      const gasUse = quote.gasDetails?.gasUse;
      if (gasUse === undefined) continue;
      if (lowest === undefined || gasUse < lowest) {
        lowest = gasUse;
      }
    }
    return lowest;
  }

  /**
   * Returns true if a sole-candidate agg-hook winner (i.e. no no-hook
   * quote present at this percentage bucket) is competitive enough on
   * gas to keep in the candidate set. Anchored against the cheapest
   * no-hook quote anywhere in `percentageToSortedQuotes` — see
   * `AGG_HOOK_SOLE_CANDIDATE_GAS_TOLERANCE_UNITS` for the design
   * rationale and prod evidence.
   *
   * Defensive admissions (returns true):
   *   - `aggHookQuotes.length === 0` (caller guarantees > 0, but
   *     guard the array access anyway)
   *   - agg-hook winner has no `gasDetails.gasUse` — preserves test-
   *     mock compatibility
   *   - no no-hook quote with gas info exists anywhere — agg-hook is
   *     the only option for this trade; rejecting it would leave the
   *     bucket with no candidates and produce a worse user outcome
   *     than admitting a gas-bad route
   *
   * Rejects (returns false) when:
   *   `aggHookGasUse - cheapestNoHookGasUse > AGG_HOOK_SOLE_CANDIDATE_GAS_TOLERANCE_UNITS`
   */
  private isAggHookSoleCandidateCompetitive(
    aggHookQuotes: QuoteBasic[],
    percentageToSortedQuotes: Map<number, QuoteBasic[]>,
    chainId: ChainId
  ): boolean {
    if (aggHookQuotes.length === 0) return false;
    const aggHookWinner = aggHookQuotes[0];
    const aggHookGasUse = aggHookWinner.gasDetails?.gasUse;
    if (aggHookGasUse === undefined) return true;

    // Find the cheapest no-hook quote anywhere by gasUse. O(total
    // quotes) — typical buckets are ~5-10 quotes across ~20
    // percentages, so this is a small constant per sole-candidate
    // firing.
    let cheapestNoHookGasUse: bigint | undefined;
    for (const bucket of percentageToSortedQuotes.values()) {
      for (const quote of bucket) {
        const route = quote.route as RouteBasic<TPool>;
        if (routeUsesAggHook(route, chainId)) continue;
        const gasUse = quote.gasDetails?.gasUse;
        if (gasUse === undefined) continue;
        if (
          cheapestNoHookGasUse === undefined ||
          gasUse < cheapestNoHookGasUse
        ) {
          cheapestNoHookGasUse = gasUse;
        }
      }
    }

    // No fallback exists; admit agg-hook so the trade has at least
    // one route.
    if (cheapestNoHookGasUse === undefined) return true;

    if (aggHookGasUse > cheapestNoHookGasUse) {
      const gasUseDelta = aggHookGasUse - cheapestNoHookGasUse;
      if (gasUseDelta > this.AGG_HOOK_SOLE_CANDIDATE_GAS_TOLERANCE_UNITS) {
        return false;
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
      soleCandidateGasComparisonLogBudget: {remaining: number};
      partitionAnchorAnalysisLogBudget: {remaining: number};
      aggHookAttribution: {
        firedPartitionKeptHigherGas: boolean;
        firedSoleCandidateAdmit: boolean;
        firedSoleCandidateGasWorse: boolean;
        firedChosenSplitGasWorse: boolean;
        firedAnchorSubOptimal: boolean;
      };
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
      soleCandidateGasComparisonLogBudget: {remaining: number};
      partitionAnchorAnalysisLogBudget: {remaining: number};
      aggHookAttribution: {
        firedPartitionKeptHigherGas: boolean;
        firedSoleCandidateAdmit: boolean;
        firedSoleCandidateGasWorse: boolean;
        firedChosenSplitGasWorse: boolean;
        firedAnchorSubOptimal: boolean;
      };
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

    instrumentation.aggHookAttribution.firedSoleCandidateAdmit = true;
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
   * Investigation-only: companion to maybeLogAggHookSoleCandidate that
   * cross-references the agg-hook winner's gas use against the cheapest
   * no-hook quote present at ANY other percentage in
   * `percentageToSortedQuotes`. The cheapest-anywhere no-hook is the
   * "fallback alternative" — what DFS would have available if agg-hook
   * were excluded entirely from the trade — so a sole-candidate firing
   * where the agg-hook is materially more gas than the cheapest no-hook
   * elsewhere is strong evidence that the bucket-level absence of a
   * no-hook competitor is letting a gas-bad route in.
   *
   * This is the post-PR-#8195 residual signal: with the K-budget gate
   * early-return leak closed, prod still sees ~30-48 UniRoute-wins per
   * 10-min burst (vs ~150-190 pre-#8195) on the same Curve+Fluid v4
   * chain shape. Those bursts come from this code path — the gate has
   * no anchor when `noHookQuotes.length === 0`. This emission lets us
   * size the harmful sole-candidate population in prod before we draft
   * the next fix (likely an absolute-gas threshold or per-percentage
   * route-cap balancing upstream).
   *
   * Emits:
   *   metric `QuoteBestSplitFinder.AggHookSoleCandidateGasComparison`
   *     tagged `gasVerdict:{agghook_more_gas, agghook_equal_or_less_gas,
   *     no_nohook_anywhere, gas_info_missing}` + standard tags. Fires on
   *     every sole-candidate firing where this method is invoked.
   *   log `'QuoteBestSplitFinder agg-hook sole-candidate is gas-worse
   *     than best no-hook elsewhere'` only when verdict is
   *     `agghook_more_gas`, capped per request via
   *     `soleCandidateGasComparisonLogBudget`. Carries route hashes,
   *     percentages, and gas-use values for downstream correlation
   *     with the residual UniRoute-wins shape.
   */
  private maybeLogAggHookSoleCandidateGasComparison(
    percentage: number,
    chainId: ChainId,
    aggHookQuotes: QuoteBasic[],
    percentageToSortedQuotes: Map<number, QuoteBasic[]>,
    instrumentation: {
      ctx: UniContext;
      tradeType: TradeType;
      testAggHooks: boolean | undefined;
      partitionEvictLogBudget: {remaining: number};
      soleCandidateLogBudget: {remaining: number};
      partitionGasAdjustedLogBudget: {remaining: number};
      gateEarlyReturnLeakLogBudget: {remaining: number};
      soleCandidateGasComparisonLogBudget: {remaining: number};
      partitionAnchorAnalysisLogBudget: {remaining: number};
      aggHookAttribution: {
        firedPartitionKeptHigherGas: boolean;
        firedSoleCandidateAdmit: boolean;
        firedSoleCandidateGasWorse: boolean;
        firedChosenSplitGasWorse: boolean;
        firedAnchorSubOptimal: boolean;
      };
      metricTags: string[];
    }
  ): void {
    if (aggHookQuotes.length === 0) return;
    const aggHookWinner = aggHookQuotes[0];

    const baseTags = [
      ...instrumentation.metricTags,
      `testAggHooks:${instrumentation.testAggHooks}`,
      `tradeType:${instrumentation.tradeType}`,
    ];

    const aggHookGasUse = aggHookWinner.gasDetails?.gasUse;

    // Scan every bucket in percentageToSortedQuotes for the cheapest
    // no-hook quote (smallest gasUse). This is direction-agnostic
    // (lower gas always better) and trade-agnostic (we don't try to
    // reason about raw amount across percentages — that's DFS's job).
    let cheapestNoHookQuote: QuoteBasic | undefined;
    let cheapestNoHookGasUse: bigint | undefined;
    for (const bucket of percentageToSortedQuotes.values()) {
      for (const quote of bucket) {
        const route = quote.route as RouteBasic<TPool>;
        if (routeUsesAggHook(route, chainId)) continue;
        const gasUse = quote.gasDetails?.gasUse;
        if (gasUse === undefined) continue;
        if (
          cheapestNoHookGasUse === undefined ||
          gasUse < cheapestNoHookGasUse
        ) {
          cheapestNoHookGasUse = gasUse;
          cheapestNoHookQuote = quote;
        }
      }
    }

    if (cheapestNoHookGasUse === undefined) {
      void instrumentation.ctx.metrics.count(
        buildMetricKey(
          'QuoteBestSplitFinder.AggHookSoleCandidateGasComparison'
        ),
        1,
        {tags: [...baseTags, 'gasVerdict:no_nohook_anywhere']}
      );
      return;
    }
    if (aggHookGasUse === undefined) {
      void instrumentation.ctx.metrics.count(
        buildMetricKey(
          'QuoteBestSplitFinder.AggHookSoleCandidateGasComparison'
        ),
        1,
        {tags: [...baseTags, 'gasVerdict:gas_info_missing']}
      );
      return;
    }

    const aggHookUsesMoreGas = aggHookGasUse > cheapestNoHookGasUse;

    const verdictTag = aggHookUsesMoreGas
      ? 'gasVerdict:agghook_more_gas'
      : 'gasVerdict:agghook_equal_or_less_gas';
    void instrumentation.ctx.metrics.count(
      buildMetricKey('QuoteBestSplitFinder.AggHookSoleCandidateGasComparison'),
      1,
      {tags: [...baseTags, verdictTag]}
    );

    if (!aggHookUsesMoreGas) return;
    instrumentation.aggHookAttribution.firedSoleCandidateGasWorse = true;
    if (instrumentation.soleCandidateGasComparisonLogBudget.remaining <= 0) {
      return;
    }
    instrumentation.soleCandidateGasComparisonLogBudget.remaining -= 1;

    // cheapestNoHookQuote is guaranteed defined here (we early-returned
    // above when cheapestNoHookGasUse was undefined and they're set
    // together inside the scan loop).
    const cheapestNoHookRoute = cheapestNoHookQuote!.route as RouteBasic<TPool>;
    instrumentation.ctx.logger.info(
      'QuoteBestSplitFinder agg-hook sole-candidate is gas-worse than best no-hook elsewhere',
      {
        chainId,
        percentage,
        tradeType: instrumentation.tradeType,
        aggHookCount: aggHookQuotes.length,
        aggHookWinner: {
          routeHash: hashForLogging(aggHookWinner.route.toString()),
          amount: aggHookWinner.amount.toString(),
          gasUse: aggHookGasUse.toString(),
        },
        cheapestNoHookElsewhere: {
          routeHash: hashForLogging(cheapestNoHookRoute.toString()),
          percentage: cheapestNoHookRoute.percentage,
          amount: cheapestNoHookQuote!.amount.toString(),
          gasUse: cheapestNoHookGasUse.toString(),
        },
        gasUseDelta: (aggHookGasUse - cheapestNoHookGasUse).toString(),
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
      soleCandidateGasComparisonLogBudget: {remaining: number};
      partitionAnchorAnalysisLogBudget: {remaining: number};
      aggHookAttribution: {
        firedPartitionKeptHigherGas: boolean;
        firedSoleCandidateAdmit: boolean;
        firedSoleCandidateGasWorse: boolean;
        firedChosenSplitGasWorse: boolean;
        firedAnchorSubOptimal: boolean;
      };
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
    instrumentation.aggHookAttribution.firedPartitionKeptHigherGas = true;
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
   * Anchor-analysis instrumentation. The K-budget gate compares the
   * agg-hook winner's gas to `noHookQuotes[0]` (the best no-hook by
   * raw amount). If a DIFFERENT no-hook in the bucket has materially
   * lower gas, the gate's anchor choice is sub-optimal — the gate may
   * admit an agg-hook whose gas is below the raw winner's but above
   * the bucket's actual minimum. When that happens, DFS's K=2 budget
   * at this percentage holds the agg-hook in place of the lowest-gas
   * no-hook, and the final split is gas-heavier than necessary.
   *
   * This method does NOT change any gate decision. It only emits
   * telemetry to size the population where anchor choice would
   * differ. Tag verdicts:
   *
   *   `anchorVerdict:winner_is_lowest_gas`
   *     The current anchor (`noHookQuotes[0]`) is also the lowest-gas
   *     no-hook in the bucket. Anchor choice doesn't matter here.
   *
   *   `anchorVerdict:lowest_gas_differs_anchor_admits`
   *     A different no-hook has lower gas than the raw winner.
   *     Comparing the agg-hook winner to the lowest-gas no-hook would
   *     hit the gas check (delta > tolerance) and reject — but the
   *     current anchor admitted because it compared against the
   *     gas-heavier raw winner.
   *
   *   `anchorVerdict:lowest_gas_differs_anchor_neutral`
   *     A different no-hook has lower gas than the raw winner, but
   *     the agg-hook winner's gas is still ≤ the lowest-gas no-hook's
   *     gas. Anchor swap wouldn't change the gate's verdict.
   *
   *   `anchorVerdict:gas_info_missing`
   *     gasDetails.gasUse absent on aggHookWinner or any no-hook.
   *
   * Emits a log on `lowest_gas_differs_anchor_admits` with full leg
   * details, capped per request via `partitionAnchorAnalysisLogBudget`.
   *
   * Caller pre-condition: `useBothPopulatedPartition === true` (the
   * partition is firing — only meaningful in that branch). Caller
   * guarantees `aggHookQuotes.length > 0` and `noHookQuotes.length > 0`.
   */
  private maybeLogPartitionAnchorAnalysis(
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
      soleCandidateGasComparisonLogBudget: {remaining: number};
      partitionAnchorAnalysisLogBudget: {remaining: number};
      aggHookAttribution: {
        firedPartitionKeptHigherGas: boolean;
        firedSoleCandidateAdmit: boolean;
        firedSoleCandidateGasWorse: boolean;
        firedChosenSplitGasWorse: boolean;
        firedAnchorSubOptimal: boolean;
      };
      metricTags: string[];
    }
  ): void {
    if (noHookQuotes.length === 0 || aggHookQuotes.length === 0) return;

    const aggHookWinner = aggHookQuotes[0];
    const noHookWinner = noHookQuotes[0];

    const baseTags = [
      ...instrumentation.metricTags,
      `testAggHooks:${instrumentation.testAggHooks}`,
      `tradeType:${instrumentation.tradeType}`,
    ];

    const aggHookGasUse = aggHookWinner.gasDetails?.gasUse;
    const noHookWinnerGasUse = noHookWinner.gasDetails?.gasUse;
    if (aggHookGasUse === undefined || noHookWinnerGasUse === undefined) {
      void instrumentation.ctx.metrics.count(
        buildMetricKey('QuoteBestSplitFinder.PartitionAnchorAnalysis'),
        1,
        {tags: [...baseTags, 'anchorVerdict:gas_info_missing']}
      );
      return;
    }

    // Find the no-hook with minimum gasUse in the bucket.
    let lowestGasNoHook: QuoteBasic = noHookWinner;
    let lowestGasNoHookGasUse: bigint = noHookWinnerGasUse;
    for (let i = 1; i < noHookQuotes.length; i++) {
      const q = noHookQuotes[i];
      const g = q.gasDetails?.gasUse;
      if (g === undefined) continue;
      if (g < lowestGasNoHookGasUse) {
        lowestGasNoHook = q;
        lowestGasNoHookGasUse = g;
      }
    }

    // Anchor is optimal — no other no-hook has lower gas.
    if (lowestGasNoHook === noHookWinner) {
      void instrumentation.ctx.metrics.count(
        buildMetricKey('QuoteBestSplitFinder.PartitionAnchorAnalysis'),
        1,
        {tags: [...baseTags, 'anchorVerdict:winner_is_lowest_gas']}
      );
      return;
    }

    // A different no-hook has lower gas. Would the gate's verdict
    // change if we anchored on it instead of the raw winner?
    //
    // The actual gate (`isAggHookCompetitive`) checks
    //   aggHookGasUse > noHookGasUse  AND
    //   (aggHookGasUse - noHookGasUse) > AGG_HOOK_PARTITION_GAS_TOLERANCE_UNITS
    // with `noHookGasUse` = `noHookQuotes[0].gas` (raw winner).
    //
    // Re-anchored against `lowestGasNoHook`, the gate would reject
    // when aggHookGasUse > lowestGasNoHookGasUse + tolerance. Use the
    // same tolerance as the live gate so the verdict reflects the
    // current configured strictness.
    const wouldRejectWithLowestAnchor =
      aggHookGasUse > lowestGasNoHookGasUse &&
      aggHookGasUse - lowestGasNoHookGasUse >
        this.AGG_HOOK_PARTITION_GAS_TOLERANCE_UNITS;

    const verdictTag = wouldRejectWithLowestAnchor
      ? 'anchorVerdict:lowest_gas_differs_anchor_admits'
      : 'anchorVerdict:lowest_gas_differs_anchor_neutral';
    void instrumentation.ctx.metrics.count(
      buildMetricKey('QuoteBestSplitFinder.PartitionAnchorAnalysis'),
      1,
      {tags: [...baseTags, verdictTag]}
    );

    if (!wouldRejectWithLowestAnchor) return;
    instrumentation.aggHookAttribution.firedAnchorSubOptimal = true;
    if (instrumentation.partitionAnchorAnalysisLogBudget.remaining <= 0) {
      return;
    }
    instrumentation.partitionAnchorAnalysisLogBudget.remaining -= 1;

    instrumentation.ctx.logger.info(
      'QuoteBestSplitFinder partition anchor sub-optimal — lowest-gas no-hook differs from raw winner',
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
        noHookWinnerByRaw: {
          routeHash: hashForLogging(noHookWinner.route.toString()),
          amount: noHookWinner.amount.toString(),
          gasUse: noHookWinnerGasUse.toString(),
        },
        noHookLowestGas: {
          routeHash: hashForLogging(lowestGasNoHook.route.toString()),
          amount: lowestGasNoHook.amount.toString(),
          gasUse: lowestGasNoHookGasUse.toString(),
        },
        gasUseDeltaVsRawWinner: (aggHookGasUse - noHookWinnerGasUse).toString(),
        gasUseDeltaVsLowestGas: (
          aggHookGasUse - lowestGasNoHookGasUse
        ).toString(),
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
      soleCandidateGasComparisonLogBudget: {remaining: number};
      partitionAnchorAnalysisLogBudget: {remaining: number};
      aggHookAttribution: {
        firedPartitionKeptHigherGas: boolean;
        firedSoleCandidateAdmit: boolean;
        firedSoleCandidateGasWorse: boolean;
        firedChosenSplitGasWorse: boolean;
        firedAnchorSubOptimal: boolean;
      };
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
   * Scores and sorts route combinations by gas-adjusted total quote
   * amount when `gasCostInQuoteToken` is populated on each leg's
   * gasDetails, otherwise falls back to raw total amount.
   *
   * Direction-aware:
   *   EXACT_IN  → score = sum(amount) - sum(gasCostInQuoteToken)
   *               (user receives output, so gas reduces the effective
   *               output amount)
   *   EXACT_OUT → score = sum(amount) + sum(gasCostInQuoteToken)
   *               (user pays input, so gas increases the effective
   *               input amount)
   *
   * Fallback behavior preserves backward compat for unit tests that
   * construct `QuoteBasic` without `gasDetails` populated: if ANY
   * route in the combination lacks `gasCostInQuoteToken`, that
   * combination is scored on raw amount alone. Mixing populated and
   * unpopulated quotes within a single combination would produce a
   * skewed comparison.
   *
   * Why gas-adjusted at this layer (rather than only post-split in
   * the selector): `filterAndSortResults` truncates to
   * `maxSplitRoutes` (default 5) using this score function, so a
   * gas-good combination with marginally worse raw amount can be
   * dropped before reaching the selector. PR #8285 prod telemetry
   * confirmed this is the dominant residual loss mechanism after
   * PR #8272.
   *
   * @param combinations Array of route combinations to score and sort
   * @param quoteMap Pre-computed map of routes to quotes for O(1) lookup
   * @param tradeType The trade type to determine sorting direction
   * @returns Sorted array of route combinations
   *   (descending for ExactIn, ascending for ExactOut)
   */
  private scoreAndSortCombinations(
    combinations: RouteBasic<TPool>[][],
    quoteMap: Map<RouteBasic<TPool>, QuoteBasic>,
    tradeType: TradeType
  ): RouteBasic<TPool>[][] {
    const scoredCombinations = combinations.map(combination => {
      let totalAmount = 0n;
      let totalGasCostInQuoteToken = 0n;
      let allGasPopulated = true;
      for (const route of combination) {
        const quote = quoteMap.get(route);
        if (!quote) continue;
        totalAmount += quote.amount;
        const gasCostInQuoteToken = quote.gasDetails?.gasCostInQuoteToken;
        if (gasCostInQuoteToken === undefined) {
          allGasPopulated = false;
        } else {
          totalGasCostInQuoteToken += gasCostInQuoteToken;
        }
      }
      const score = allGasPopulated
        ? tradeType === TradeType.ExactIn
          ? totalAmount - totalGasCostInQuoteToken
          : totalAmount + totalGasCostInQuoteToken
        : totalAmount;
      return {combination, score};
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
    // Tracks `result` as it stood at the most-recent
    // `filterAndSortResults` invocation, before truncation. Used by
    // `emitFilterAndSortFullRouteBias` so the metric can see splits
    // that the 100%-first bias dropped — otherwise the metric would
    // emit `verdict:no_split` in exactly the case it's meant to size.
    let lastUnfilteredResult: RouteBasic<TPool>[][] = [];
    let currentLevelBestAmount = 0n;
    let previousLevelBestAmount = 0n;
    // (A) cumulative best-combination tracking — which combination owns
    // currentLevelBestAmount, and at which level it was first added. Lets us
    // distinguish "search converged" from "ran out of time at L4" by comparing
    // bestFoundAtLevel against the final level reached.
    let bestCombinationKey: string | null = null;
    let bestFoundAtLevel = 0;
    let currentSearchLevel = 1;
    // (B) discovery-level map — first level at which each unique combination
    // key was added. Used to log the discovery level of the top results when
    // findBestSplits returns.
    const combinationFirstSeenLevel = new Map<string, number>();
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
      // PR-residual instrumentation: how many percentage buckets in
      // this request had the K-budget partition gate actually admit
      // agg-hook into the K-slot pool. Counted at most ONCE per
      // (percentage, partition-admit) pair via the `seenAdmitKeys`
      // dedupe Set, because `getBestUnusedQuotes` is called from
      // every recursive DFS branch and would otherwise inflate this
      // counter by the number of partial-route visits.
      partitionAdmittedAggHookCount: 0,
      // Dedupe set keyed by `percentage` for partition-admit
      // counting. The K-budget gate's decision at a given percentage
      // is a function of the percentage's quote distribution AND
      // `usedRoutes` (conflict filtering). For per-request shape
      // attribution we count the FIRST observed admit per percentage
      // — invocation-weighted counts would over-state by DFS depth.
      seenAdmitKeys: new Set<number>(),
      // Accumulated displaced no-hook quotes across the request,
      // deduplicated by `${percentage}:${route key}`. The wrapper
      // appends a route only the first time `getBestUnusedQuotesStats`
      // reports it as displaced; subsequent recursive visits of the
      // same percentage that re-displace the same route are skipped.
      // Per-route uniqueness matches the "permanent exclusion"
      // semantics of `KBudgetEvictionPermanentExclusion`.
      displacedNoHookQuotes: [] as QuoteBasic[],
      // Dedupe set keyed by `${percentage}:${route key}` for
      // displaced-quote accumulation.
      seenDisplacedKeys: new Set<string>(),
      // Histogram of bucket shapes for this request, counted at most
      // ONCE per percentage. Bucket shape at a given percentage can
      // vary with `usedRoutes` (because of conflict filtering), so
      // the first observed shape is used as the canonical per-
      // percentage shape — invocation-weighted counts would over-
      // state by DFS depth.
      bucketShapeCounts: {
        both_populated_partition_admitted: 0,
        both_populated_partition_rejected: 0,
        no_hook_only: 0,
        agg_hook_only_admitted: 0,
        agg_hook_only_rejected: 0,
        empty: 0,
      },
      // Dedupe set keyed by `percentage` for bucket-shape counting.
      seenBucketKeys: new Set<number>(),
    };
    // Per-request caps on instrumentation logs (cf. maybeLogPartitionDecision,
    // maybeLogAggHookSoleCandidate, maybeLogPartitionGasAdjustedDecision,
    // maybeLogGateEarlyReturnLeak, maybeLogAggHookSoleCandidateGasComparison).
    // Metrics fire unconditionally.
    const partitionEvictLogBudget = {remaining: 5};
    const soleCandidateLogBudget = {remaining: 5};
    const partitionGasAdjustedLogBudget = {remaining: 5};
    const gateEarlyReturnLeakLogBudget = {remaining: 5};
    const soleCandidateGasComparisonLogBudget = {remaining: 5};
    const partitionAnchorAnalysisLogBudget = {remaining: 5};
    // Catch-all attribution flags. Each existing harmful-log emission
    // site flips its corresponding flag when it fires. The end-of-call
    // `emitAggHookWinnerAttribution` reads them so the residual
    // (winner=agg-hook AND every flag=false) becomes a single DD query.
    const aggHookAttribution = {
      firedPartitionKeptHigherGas: false,
      firedSoleCandidateAdmit: false,
      firedSoleCandidateGasWorse: false,
      firedChosenSplitGasWorse: false,
      firedAnchorSubOptimal: false,
    };

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
        combinationFirstSeenLevel.set(key, currentSearchLevel);
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
          bestCombinationKey = key;
          bestFoundAtLevel = currentSearchLevel;
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
          soleCandidateGasComparisonLogBudget,
          partitionAnchorAnalysisLogBudget,
          aggHookAttribution,
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
      // Dedupe per-request attribution signals by percentage / route
      // identity so we don't over-count for DFS revisits. The
      // semantics we want are "for this REQUEST, was percentage X
      // admitted at least once?", "for this REQUEST, was route Y
      // ever displaced?", and "what shape was percentage X observed
      // as?" — all at most-once-per-percentage / once-per-route.
      if (
        stats.partitionAdmittedAggHook &&
        !bestUnusedQuoteStats.seenAdmitKeys.has(percentage)
      ) {
        bestUnusedQuoteStats.seenAdmitKeys.add(percentage);
        bestUnusedQuoteStats.partitionAdmittedAggHookCount++;
      }
      for (const displaced of stats.displacedNoHookQuotes) {
        const route = displaced.route as RouteBasic<TPool>;
        const key = `${percentage}:${route.path
          .map(p => p.address.toString().toLowerCase())
          .join(',')}`;
        if (bestUnusedQuoteStats.seenDisplacedKeys.has(key)) continue;
        bestUnusedQuoteStats.seenDisplacedKeys.add(key);
        bestUnusedQuoteStats.displacedNoHookQuotes.push(displaced);
      }
      if (!bestUnusedQuoteStats.seenBucketKeys.has(percentage)) {
        bestUnusedQuoteStats.seenBucketKeys.add(percentage);
        bestUnusedQuoteStats.bucketShapeCounts[stats.bucketShape]++;
      }
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
    ctx.logger.debug('QuoteBestSplitFinder level snapshot', {
      level: 1,
      bestAmount: currentLevelBestAmount.toString(),
      bestCombinationKey,
      bestFoundAtLevel,
      combinationsFound: result.length,
      elapsedMs: Date.now() - startTime,
    });

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
      currentSearchLevel = level;
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
      ctx.logger.debug('QuoteBestSplitFinder level snapshot', {
        level,
        bestAmount: currentLevelBestAmount.toString(),
        bestCombinationKey,
        bestFoundAtLevel,
        combinationsFound: unfilteredResultLength,
        newCombinationsThisLevel: unfilteredResultLength - previousResultLength,
        elapsedMs: Date.now() - startTime,
        timedOut,
      });

      // Snapshot the pre-truncation candidate set so the
      // `FilterAndSortFullRouteBias` emitter at end of `findBestSplits`
      // can compare the best 100% route against the best split EVEN
      // WHEN the bias drops every split (the `fullRoutes.length >=
      // maxSplitRoutes` branch returns only 100% routes). Without this
      // snapshot, the metric would emit `verdict:no_split` in exactly
      // the case it's meant to size, undercounting the bug shape.
      lastUnfilteredResult = result.slice();
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

    // (B) Final-winner discovery levels: which level each of the top-N results
    // was first discovered. If the eventual winner appears at L2 or L3, that
    // proves later-level search wasn't load-bearing for this request.
    const topResultsDiscoveryLevels = result
      .slice(0, Math.min(5, result.length))
      .map((combination, idx) => {
        const key = getCombinationKey(combination);
        const totalAmount = combination.reduce(
          (sum, route) => sum + (quoteMap.get(route)?.amount ?? 0n),
          0n
        );
        return {
          rank: idx,
          firstSeenAtLevel: combinationFirstSeenLevel.get(key) ?? null,
          amount: totalAmount.toString(),
          numRoutes: combination.length,
        };
      });
    ctx.logger.debug('QuoteBestSplitFinder top results discovery levels', {
      bestFoundAtLevel,
      bestAmount: currentLevelBestAmount.toString(),
      topResultsDiscoveryLevels,
    });

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
      bestFoundAtLevel,
      bestAmount: currentLevelBestAmount.toString(),
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

    // Chosen-split gas comparison: PR #8161/#8195/#8272 closed the per-
    // percentage gates. Post-PR-#8272 prod still shows
    // `winnerByGasAdjustedQuote=UniRoute` at ~35/10min with different
    // hook shapes than the Curve+Fluid v4 chain — Tempo/Fluid combos
    // distributed across larger percentage allocations. Hypothesis: the
    // residual is at the SPLIT-LEVEL ranking — `scoreAndSortCombinations`
    // ranks combinations by RAW amount only, so a marginally-raw-better
    // agg-hook combination can outrank a no-hook combination that uses
    // materially less gas. This instrumentation compares the chosen
    // top-ranked split against the best no-hook-only combination in
    // `result` so we can confirm or rule out that hypothesis in prod
    // before drafting another fix.
    this.maybeLogChosenSplitGasComparison(
      result,
      quoteMap,
      chainId,
      ctx,
      testAggHooks,
      tradeType,
      metricTags,
      aggHookAttribution
    );

    // Catch-all winner attribution: fires whenever testAggHooks=true and
    // the chosen split contains any agg-hook leg. The 5 sibling logs
    // emit their own attribution flags into `aggHookAttribution`; this
    // emission unions them with payload context so the residual
    // population (winner=agg-hook AND every flag=false) becomes a
    // single DD query.
    this.emitAggHookWinnerAttribution(
      result,
      quoteMap,
      chainId,
      ctx,
      testAggHooks,
      tradeType,
      metricTags,
      aggHookAttribution
    );

    // Cat-B catch-all (symmetric to Cat-A): fires whenever
    // `testAggHooks=true` AND the chosen winner has NO agg-hook leg.
    // Trading-service Cat-B (~40% of `winnerByGasAdjustedQuote:UniRoute`
    // losses) covers the population where treatment lost on both raw
    // and gas-adjusted — i.e. treatment chose a no-hook winner that's
    // worse than control's no-hook winner. From inside the treatment
    // run we don't know what control would have picked, but we can
    // surface the signals that distinguish "search degraded by the
    // wider candidate set" from "genuine no-better-quote-exists":
    // findBestSplits timeout (B1 mechanism), and the best agg-hook
    // alternative considered (size + raw/gas deltas vs the chosen
    // no-hook winner).
    this.emitNoHookWinnerCatBAttribution(
      result,
      quoteMap,
      chainId,
      ctx,
      testAggHooks,
      tradeType,
      metricTags,
      {firedFindBestSplitsTimedOut: timedOut}
    );

    // Residual attribution: post-PR-#8431 the K-budget anchor bug is
    // closed. Remaining Cat-B is small (~$600/hr on prod) and lives in
    // mechanisms we haven't sized: K-budget *eviction* propagation (the
    // partition admit displaces a no-hook quote needed for the best
    // multi-leg) and `filterAndSortResults`'s 100%-routes-first bias.
    // These two emissions size each mechanism's prod prevalence in one
    // request without requiring a re-DFS.
    this.emitKBudgetAdmitWinnerCorrelation(
      result,
      quoteMap,
      chainId,
      ctx,
      testAggHooks,
      tradeType,
      metricTags,
      bestUnusedQuoteStats.partitionAdmittedAggHookCount
    );
    this.emitFilterAndSortFullRouteBias(
      // Use the pre-truncation snapshot so the metric can see split
      // routes that the 100%-first bias dropped. Falls back to the
      // post-filter result when no level ran (empty trade) so the
      // emitter still gets a sensible input.
      lastUnfilteredResult.length > 0 ? lastUnfilteredResult : result,
      quoteMap,
      chainId,
      ctx,
      testAggHooks,
      tradeType,
      metricTags
    );
    this.emitKBudgetEvictionPermanentExclusion(
      result,
      ctx,
      testAggHooks,
      tradeType,
      metricTags,
      bestUnusedQuoteStats.displacedNoHookQuotes
    );
    this.emitKBudgetBucketProfile(
      ctx,
      testAggHooks,
      tradeType,
      metricTags,
      bestUnusedQuoteStats.bucketShapeCounts
    );
    this.emitAggHookWinnerGasPerProtocol(
      result,
      quoteMap,
      chainId,
      ctx,
      testAggHooks,
      tradeType,
      metricTags
    );

    return result;
  }

  /**
   * Residual attribution: sizes the worst-case K-budget eviction harm.
   * Tracks no-hook quotes the partition admit pushed past the K-slot
   * truncation point, then checks each one against the final `result`.
   * A displaced route counts as "permanently excluded" if its full
   * pool-sequence doesn't appear in ANY combination of `result` —
   * meaning the eviction removed it from the candidate set entirely,
   * not just from one percentage bucket.
   *
   * Metric `QuoteBestSplitFinder.KBudgetEvictionPermanentExclusion`
   * fires once per request (when `testAggHooks=true` AND at least one
   * displacement happened) with tags:
   *   `excludedAny:{true,false}` — was any displaced route never seen
   *     again in `result`?
   *   `excludedCountBucket:{0, 1, 2, 3, 4_plus}` — quantizes the
   *     displaced-and-excluded count for histogram view.
   *   `displacedCountBucket:{1, 2, 3, 4_plus}` — total displaced
   *     count for context.
   *
   * Cost: scan over `result` is bounded by `maxSplitRoutes`; comparing
   * routes via pool-address string is O(legs). For typical
   * `maxSplitRoutes=5` and ≤10 displaced quotes, the work is small.
   */
  private emitKBudgetEvictionPermanentExclusion(
    result: RouteBasic<TPool>[][],
    ctx: UniContext,
    testAggHooks: boolean | undefined,
    tradeType: TradeType,
    metricTags: string[],
    displacedNoHookQuotes: QuoteBasic[]
  ): void {
    if (!testAggHooks) return;
    if (displacedNoHookQuotes.length === 0) return;

    const routeKey = (route: RouteBasic<TPool>): string =>
      `${route.path.map(p => p.address.toString().toLowerCase()).join(',')}-${route.percentage}`;

    // Build the set of every route key present in `result` for O(1)
    // lookup. A displaced route counts as "available elsewhere" if
    // its key matches any of these.
    const resultRouteKeys = new Set<string>();
    for (const combination of result) {
      for (const route of combination) {
        resultRouteKeys.add(routeKey(route));
      }
    }

    let excludedCount = 0;
    for (const displaced of displacedNoHookQuotes) {
      const route = displaced.route as RouteBasic<TPool>;
      if (!resultRouteKeys.has(routeKey(route))) {
        excludedCount++;
      }
    }

    const quantize = (n: number): string => {
      if (n === 0) return '0';
      if (n === 1) return '1';
      if (n === 2) return '2';
      if (n === 3) return '3';
      return '4_plus';
    };

    void ctx.metrics.count(
      buildMetricKey('QuoteBestSplitFinder.KBudgetEvictionPermanentExclusion'),
      1,
      {
        tags: [
          ...metricTags,
          `excludedAny:${excludedCount > 0}`,
          `excludedCountBucket:${quantize(excludedCount)}`,
          `displacedCountBucket:${quantize(displacedNoHookQuotes.length)}`,
          `testAggHooks:${testAggHooks}`,
          `tradeType:${tradeType}`,
        ],
      }
    );
  }

  /**
   * Residual attribution: sizes the per-request bucket-shape
   * distribution. A trade's percentage buckets can be any mix of
   * both-populated (partition admitted or rejected), no-hook-only,
   * agg-hook-only (sole-candidate admitted or rejected), or empty.
   * The mix characterizes the candidate-set asymmetry between the
   * agg-hook-enabled and no-agg-hook RUNs of uniroute, which is the
   * underlying cause of pool-discovery divergence and cross-percentage
   * K-slot interactions.
   *
   * Emits one metric per request when `testAggHooks=true`, with one
   * tag per bucket shape carrying the request-level count quantized
   * into 0/1/2/3/4_plus buckets. DD aggregation by request lets us
   * compute the request-level distribution of shapes.
   *
   * Why per-request rather than per-bucket: per-bucket counts already
   * exist via `PartitionDecision` and `SoleCandidateDecision`. The
   * per-request profile is what's missing — it tells us whether
   * harmful interactions concentrate in requests with certain shape
   * mixes (e.g., 3+ admit-buckets per request).
   */
  private emitKBudgetBucketProfile(
    ctx: UniContext,
    testAggHooks: boolean | undefined,
    tradeType: TradeType,
    metricTags: string[],
    bucketShapeCounts: {
      both_populated_partition_admitted: number;
      both_populated_partition_rejected: number;
      no_hook_only: number;
      agg_hook_only_admitted: number;
      agg_hook_only_rejected: number;
      empty: number;
    }
  ): void {
    if (!testAggHooks) return;

    const quantize = (n: number): string => {
      if (n === 0) return '0';
      if (n === 1) return '1';
      if (n === 2) return '2';
      if (n === 3) return '3';
      return '4_plus';
    };

    void ctx.metrics.count(
      buildMetricKey('QuoteBestSplitFinder.KBudgetBucketProfile'),
      1,
      {
        tags: [
          ...metricTags,
          `bothPopulatedAdmittedBucket:${quantize(bucketShapeCounts.both_populated_partition_admitted)}`,
          `bothPopulatedRejectedBucket:${quantize(bucketShapeCounts.both_populated_partition_rejected)}`,
          `noHookOnlyBucket:${quantize(bucketShapeCounts.no_hook_only)}`,
          `aggHookOnlyAdmittedBucket:${quantize(bucketShapeCounts.agg_hook_only_admitted)}`,
          `aggHookOnlyRejectedBucket:${quantize(bucketShapeCounts.agg_hook_only_rejected)}`,
          `emptyBucket:${quantize(bucketShapeCounts.empty)}`,
          `testAggHooks:${testAggHooks}`,
          `tradeType:${tradeType}`,
        ],
      }
    );
  }

  /**
   * Residual attribution: per-protocol gas-cost distribution on the
   * agg-hook leg(s) of the chosen winner. Outliers in per-protocol
   * gas reporting are evidence of stale or under-estimated gas cost
   * for hook calls — a separate residual mechanism from the K-budget
   * and 100%-bias paths.
   *
   * Emits one metric per agg-hook leg in the chosen winner, with the
   * protocol identifier (e.g. `FluidDexT1`) and a quantized
   * `gasCostInQuoteToken` bucket so DD's distribution view can show
   * per-protocol percentiles. Fires only when `testAggHooks=true`
   * AND the chosen winner has at least one agg-hook leg with
   * `gasDetails.gasCostInQuoteToken` populated.
   *
   * Per-leg granularity means single-request multiple agg-hook legs
   * emit multiple datapoints — acceptable because the metric is a
   * `dist` (DD aggregates internally) rather than a per-request count.
   */
  private emitAggHookWinnerGasPerProtocol(
    result: RouteBasic<TPool>[][],
    quoteMap: Map<RouteBasic<TPool>, QuoteBasic>,
    chainId: ChainId,
    ctx: UniContext,
    testAggHooks: boolean | undefined,
    tradeType: TradeType,
    metricTags: string[]
  ): void {
    if (!testAggHooks) return;
    if (result.length === 0) return;

    const top = result[0];
    for (const route of top) {
      if (!routeUsesAggHook(route, chainId)) continue;
      const quote = quoteMap.get(route);
      const gasCost = quote?.gasDetails?.gasCostInQuoteToken;
      if (gasCost === undefined) continue;

      // Identify the agg-hook protocol via the hook-address registry
      // (`getProtocolForAggHookAddress`), NOT via `pool.protocol`.
      // The pool's `protocol` getter returns the Uniswap protocol
      // family (V4Pool → Protocol.V4) — staging post-deploy
      // confirmed every emission tagged `protocol:v4` because every
      // agg-hook pool is a V4Pool, which made the per-protocol
      // distribution useless. The registry lookup returns the actual
      // agg-hook protocol identifier (Protocol.FLUIDDEXT1,
      // Protocol.CURVESTABLESWAP, etc.) which is the value we need
      // to distinguish per-hook gas-cost outliers.
      const aggHookLeg = route.path.find(pool => isAggHookPool(pool, chainId));
      const protocolTag =
        aggHookLeg === undefined || !(aggHookLeg instanceof V4Pool)
          ? null
          : String(
              getProtocolForAggHookAddress(aggHookLeg.hooks, chainId) ??
                aggHookLeg.protocol
            );

      void ctx.metrics.dist(
        buildMetricKey('QuoteBestSplitFinder.AggHookWinnerGasPerProtocol'),
        Number(gasCost),
        {
          tags: [
            ...metricTags,
            `protocol:${protocolTag ?? 'unknown'}`,
            `testAggHooks:${testAggHooks}`,
            `tradeType:${tradeType}`,
          ],
        }
      );
    }
  }

  /**
   * Residual attribution: when the K-budget partition gate admits
   * agg-hook into the K-slot pool at any percentage during a request
   * (counted in `bestUnusedQuoteStats.partitionAdmittedAggHookCount`),
   * we don't currently know whether that admit *propagates* to the
   * final chosen winner. This emission ties admit-count to winner-
   * agg-hook-presence so prod telemetry can answer "how often does a
   * partition admit cause the trade to choose an agg-hook route?"
   *
   * Tags:
   *   `partitionAdmitted:{true,false}` — true iff
   *     `partitionAdmittedAggHookCount > 0` for this request
   *   `winnerHasAggHook:{true,false}` — true iff the top-ranked
   *     combination in `result` contains any agg-hook route
   *
   * The 2×2 contingency table in DD lets us size:
   *   - `true × true`: admit propagated to winner (suspected harmful)
   *   - `true × false`: admit was harmless (winner was no-hook anyway)
   *   - `false × true`: agg-hook reached the winner via sole-candidate
   *     or another path (separate mechanism)
   *   - `false × false`: no agg-hook involvement
   *
   * Fires exactly once per request when `testAggHooks=true`. Gated on
   * `testAggHooks` because the attribution is only meaningful when the
   * agg-hooks-enabled run actually has agg-hook routes in the
   * candidate set.
   */
  private emitKBudgetAdmitWinnerCorrelation(
    result: RouteBasic<TPool>[][],
    _quoteMap: Map<RouteBasic<TPool>, QuoteBasic>,
    chainId: ChainId,
    ctx: UniContext,
    testAggHooks: boolean | undefined,
    tradeType: TradeType,
    metricTags: string[],
    partitionAdmittedAggHookCount: number
  ): void {
    if (!testAggHooks) return;
    if (result.length === 0) return;

    const top = result[0];
    const winnerHasAggHook = top.some(route =>
      routeUsesAggHook(route, chainId)
    );
    const partitionAdmitted = partitionAdmittedAggHookCount > 0;

    void ctx.metrics.count(
      buildMetricKey('QuoteBestSplitFinder.KBudgetAdmitWinnerCorrelation'),
      1,
      {
        tags: [
          ...metricTags,
          `partitionAdmitted:${partitionAdmitted}`,
          `winnerHasAggHook:${winnerHasAggHook}`,
          `testAggHooks:${testAggHooks}`,
          `tradeType:${tradeType}`,
        ],
      }
    );
  }

  /**
   * Residual attribution: `filterAndSortResults` returns 100% routes
   * before split routes regardless of gas-adjusted score. When both
   * are present in `result`, the downstream consumer picks `result[0]`
   * — a 100% route — even if the best split has higher gas-adjusted
   * score. This emission sizes how often that 100%-bias produces a
   * gas-adj-worse winner.
   *
   * Tags:
   *   `verdict:no_pct100`          — no 100% routes in result
   *   `verdict:no_split`           — no split routes in result
   *   `verdict:pct100_beats_split` — top 100% has higher (better)
   *                                  score than top split (no bias
   *                                  issue)
   *   `verdict:split_beats_pct100` — top split has higher score than
   *                                  top 100% but is ranked below
   *                                  (the bug shape)
   *   `verdict:tie`                — equal scores
   *   `topPct100HasAggHook:{true,false}` — whether the top 100% route
   *                                         uses an agg-hook (only
   *                                         set when verdict involves
   *                                         100% routes)
   *   `topPct100GasComplete:{true,false}` — whether the top 100% had
   *                                          `gasCostInQuoteToken`
   *                                          populated on every leg.
   *                                          When false, its score is
   *                                          a raw-amount fallback —
   *                                          same fallback the live
   *                                          scorer uses.
   *   `topSplitGasComplete:{true,false}`  — same for the top split.
   *
   * IMPORTANT: when gas info is incomplete on EITHER side the
   * comparison still emits a score-based verdict — `gas_info_missing`
   * is NOT a separate verdict. The live `scoreAndSortCombinations`
   * ranks mixed-completeness combinations together (raw fallback for
   * the incomplete one, gas-adjusted for the complete one), and the
   * bias metric must mirror that semantic so it captures real
   * dropped-split cases where the live scorer's raw fallback was the
   * mechanism. The two completeness tags let DD analysts filter to
   * the clean-gas subset if they want a stricter view.
   *
   * Fires exactly once per request when `testAggHooks=true`.
   */
  private emitFilterAndSortFullRouteBias(
    result: RouteBasic<TPool>[][],
    quoteMap: Map<RouteBasic<TPool>, QuoteBasic>,
    chainId: ChainId,
    ctx: UniContext,
    testAggHooks: boolean | undefined,
    tradeType: TradeType,
    metricTags: string[]
  ): void {
    if (!testAggHooks) return;

    const isFullRoute = (combo: RouteBasic<TPool>[]) =>
      combo.length === 1 && combo[0].percentage === 100;

    const pct100Combinations = result.filter(isFullRoute);
    const splitCombinations = result.filter(combo => !isFullRoute(combo));

    if (pct100Combinations.length === 0 && splitCombinations.length === 0) {
      return;
    }

    const baseTags = [
      ...metricTags,
      `testAggHooks:${testAggHooks}`,
      `tradeType:${tradeType}`,
    ];

    // Compute gas-adjusted scores for both top routes using the same
    // formula as `scoreAndSortCombinations`. Fall back to raw amount
    // when any leg's `gasCostInQuoteToken` is missing — same
    // fallback rule the live scorer uses, so the metric's verdict
    // matches the scorer's behavior.
    const scoreCombination = (
      combination: RouteBasic<TPool>[]
    ): {score: bigint; gasComplete: boolean} => {
      let totalAmount = 0n;
      let totalGas = 0n;
      let allGasPopulated = true;
      for (const route of combination) {
        const quote = quoteMap.get(route);
        if (!quote) continue;
        totalAmount += quote.amount;
        const gas = quote.gasDetails?.gasCostInQuoteToken;
        if (gas === undefined) {
          allGasPopulated = false;
        } else {
          totalGas += gas;
        }
      }
      const score = allGasPopulated
        ? tradeType === TradeType.ExactIn
          ? totalAmount - totalGas
          : totalAmount + totalGas
        : totalAmount;
      return {score, gasComplete: allGasPopulated};
    };

    // The input is the PRE-truncation candidate set, so the entries
    // are in DFS insertion order — not sorted by score. Pick the
    // best of each group by computing scores for all members and
    // selecting the max (ExactIn) / min (ExactOut). Using
    // `.find(...)` would return the first inserted, which can be
    // arbitrarily wrong on the unfiltered array; that's the bug
    // shape the Codex review surfaced.
    const bestOf = (
      combos: RouteBasic<TPool>[][]
    ): {
      combo: RouteBasic<TPool>[];
      score: bigint;
      gasComplete: boolean;
    } | null => {
      if (combos.length === 0) return null;
      let best: {
        combo: RouteBasic<TPool>[];
        score: bigint;
        gasComplete: boolean;
      } | null = null;
      for (const combo of combos) {
        const scored = scoreCombination(combo);
        if (best === null) {
          best = {combo, ...scored};
          continue;
        }
        const isBetter =
          tradeType === TradeType.ExactIn
            ? scored.score > best.score
            : scored.score < best.score;
        if (isBetter) {
          best = {combo, ...scored};
        }
      }
      return best;
    };

    const topPct100 = bestOf(pct100Combinations);
    const topSplit = bestOf(splitCombinations);

    if (!topPct100) {
      void ctx.metrics.count(
        buildMetricKey('QuoteBestSplitFinder.FilterAndSortFullRouteBias'),
        1,
        {tags: [...baseTags, 'verdict:no_pct100']}
      );
      return;
    }

    const topPct100HasAggHook = topPct100.combo.some(r =>
      routeUsesAggHook(r, chainId)
    );

    if (!topSplit) {
      void ctx.metrics.count(
        buildMetricKey('QuoteBestSplitFinder.FilterAndSortFullRouteBias'),
        1,
        {
          tags: [
            ...baseTags,
            'verdict:no_split',
            `topPct100HasAggHook:${topPct100HasAggHook}`,
            `topPct100GasComplete:${topPct100.gasComplete}`,
          ],
        }
      );
      return;
    }

    // Always emit a score-based verdict. Live `scoreAndSortCombinations`
    // ranks mixed-completeness combinations together (raw fallback for
    // incomplete entries, gas-adjusted for complete ones); the bias
    // metric mirrors that. The `topPct100GasComplete` and
    // `topSplitGasComplete` tags expose the data-quality so DD
    // analysts can filter to a strict-gas subset when needed without
    // suppressing the verdict outright.
    //
    // For ExactIn, higher score is better. For ExactOut, lower score
    // is better.
    const pct100Better =
      tradeType === TradeType.ExactIn
        ? topPct100.score > topSplit.score
        : topPct100.score < topSplit.score;
    const splitBetter =
      tradeType === TradeType.ExactIn
        ? topSplit.score > topPct100.score
        : topSplit.score < topPct100.score;
    const verdict = pct100Better
      ? 'pct100_beats_split'
      : splitBetter
        ? 'split_beats_pct100'
        : 'tie';

    void ctx.metrics.count(
      buildMetricKey('QuoteBestSplitFinder.FilterAndSortFullRouteBias'),
      1,
      {
        tags: [
          ...baseTags,
          `verdict:${verdict}`,
          `topPct100HasAggHook:${topPct100HasAggHook}`,
          `topPct100GasComplete:${topPct100.gasComplete}`,
          `topSplitGasComplete:${topSplit.gasComplete}`,
        ],
      }
    );
  }

  /**
   * Investigation-only: at the end of `findBestSplits`, compare the
   * chosen top-ranked split against the best no-hook-only alternative
   * present in the candidate set. Emits one metric per call (verdict
   * tag covers every branch) and one log per call on the harmful
   * verdict.
   *
   * Verdict tags:
   *   `nohook_only`              chosen split has zero agg-hook routes
   *   `agghook_no_alternative`   chosen split has agg-hook AND no
   *                              pure-no-hook combination exists in
   *                              the candidate set
   *   `agghook_chosen_lower_gas` chosen split has agg-hook AND a
   *                              no-hook alternative existed with
   *                              equal or higher gas (legitimate)
   *   `agghook_chosen_higher_gas` chosen split has agg-hook AND a
   *                               no-hook alternative existed with
   *                               strictly lower gas (the suspected
   *                               residual loss mechanism)
   *   `empty_result`             result has no combinations
   *   `gas_info_missing`         a route in the chosen or alternative
   *                              combination has no gasUse; comparison
   *                              would be undefined
   */
  private maybeLogChosenSplitGasComparison(
    result: RouteBasic<TPool>[][],
    quoteMap: Map<RouteBasic<TPool>, QuoteBasic>,
    chainId: ChainId,
    ctx: UniContext,
    testAggHooks: boolean | undefined,
    tradeType: TradeType,
    metricTags: string[],
    aggHookAttribution: {
      firedChosenSplitGasWorse: boolean;
    }
  ): void {
    if (!testAggHooks) return;

    const baseTags = [
      ...metricTags,
      `testAggHooks:${testAggHooks}`,
      `tradeType:${tradeType}`,
    ];
    const emitMetric = (verdict: string): void => {
      void ctx.metrics.count(
        buildMetricKey('QuoteBestSplitFinder.ChosenSplitGasComparison'),
        1,
        {tags: [...baseTags, `splitVerdict:${verdict}`]}
      );
    };

    if (result.length === 0) {
      emitMetric('empty_result');
      return;
    }

    // Compute stats (raw total + gas total + hasAggHook) for one
    // combination. Returns undefined when any route in the combination
    // is missing gasUse — we can't make a defensible comparison.
    const statsFor = (
      combination: RouteBasic<TPool>[]
    ):
      | {rawTotal: bigint; gasTotal: bigint; hasAggHook: boolean}
      | undefined => {
      let rawTotal = 0n;
      let gasTotal = 0n;
      let hasAggHook = false;
      for (const route of combination) {
        const quote = quoteMap.get(route);
        if (!quote) return undefined;
        const gasUse = quote.gasDetails?.gasUse;
        if (gasUse === undefined) return undefined;
        rawTotal += quote.amount;
        gasTotal += gasUse;
        if (routeUsesAggHook(route, chainId)) hasAggHook = true;
      }
      return {rawTotal, gasTotal, hasAggHook};
    };

    const chosenStats = statsFor(result[0]);
    if (chosenStats === undefined) {
      emitMetric('gas_info_missing');
      return;
    }

    if (!chosenStats.hasAggHook) {
      emitMetric('nohook_only');
      return;
    }

    // Scan for the best no-hook-only alternative (highest-ranked
    // combination with no agg-hook routes). `result` is already
    // sorted by raw amount in the trade-direction-appropriate order
    // (cf. `scoreAndSortCombinations`), so the first match is the
    // best raw alternative.
    let noHookAltStats:
      | {rawTotal: bigint; gasTotal: bigint; hasAggHook: boolean}
      | undefined;
    let noHookAltCombination: RouteBasic<TPool>[] | undefined;
    for (let i = 1; i < result.length; i++) {
      const stats = statsFor(result[i]);
      if (stats === undefined) continue;
      if (stats.hasAggHook) continue;
      noHookAltStats = stats;
      noHookAltCombination = result[i];
      break;
    }

    if (noHookAltStats === undefined) {
      emitMetric('agghook_no_alternative');
      return;
    }

    if (chosenStats.gasTotal <= noHookAltStats.gasTotal) {
      emitMetric('agghook_chosen_lower_gas');
      return;
    }

    emitMetric('agghook_chosen_higher_gas');
    aggHookAttribution.firedChosenSplitGasWorse = true;

    // Log the harmful case once per request with enough detail to
    // correlate with the trading-service `winnerByGasAdjustedQuote`
    // signal.
    ctx.logger.info(
      'QuoteBestSplitFinder chosen split has agg-hook with worse gas than no-hook alternative',
      {
        chainId,
        tradeType,
        chosenSplit: {
          rawTotal: chosenStats.rawTotal.toString(),
          gasTotal: chosenStats.gasTotal.toString(),
          legCount: result[0].length,
          legs: result[0].map(route => ({
            routeHash: hashForLogging(route.toString()),
            percentage: route.percentage,
            usesAggHook: routeUsesAggHook(route, chainId),
            amount: quoteMap.get(route)?.amount.toString(),
            gasUse: quoteMap.get(route)?.gasDetails?.gasUse?.toString(),
          })),
        },
        noHookAlternative: {
          rawTotal: noHookAltStats.rawTotal.toString(),
          gasTotal: noHookAltStats.gasTotal.toString(),
          legCount: noHookAltCombination!.length,
          legs: noHookAltCombination!.map(route => ({
            routeHash: hashForLogging(route.toString()),
            percentage: route.percentage,
            amount: quoteMap.get(route)?.amount.toString(),
            gasUse: quoteMap.get(route)?.gasDetails?.gasUse?.toString(),
          })),
        },
        gasTotalDelta: (
          chosenStats.gasTotal - noHookAltStats.gasTotal
        ).toString(),
        rawTotalDelta: (
          chosenStats.rawTotal - noHookAltStats.rawTotal
        ).toString(),
      }
    );
  }

  /**
   * Catch-all attribution emission. Fires whenever `testAggHooks=true`
   * AND the chosen split contains any agg-hook leg. Emits both:
   *
   *   - `QuoteBestSplitFinder.AggHookWinnerAttribution` metric tagged
   *     with each `firedXxx:true|false` flag so DD can size the
   *     fraction of agg-hook-winners that fire no other verdict log
   *     (the residual the trading-service Category A query keeps
   *     attributing to "no log fired").
   *
   *   - `QuoteBestSplitFinder agg-hook selected as winner` log with
   *     attribution flags + payload (chosen split, best no-hook
   *     alternative, gas/raw deltas, missing-gas leg count).
   *
   * Pre-existing per-mechanism logs continue to fire on their specific
   * harmful verdicts; this emission is additive and self-contained so
   * a single DD query
   *
   *     `@attribution.firedPartitionKeptHigherGas:false
   *      @attribution.firedSoleCandidateAdmit:false
   *      @attribution.firedSoleCandidateGasWorse:false
   *      @attribution.firedChosenSplitGasWorse:false
   *      @attribution.firedAnchorSubOptimal:false`
   *
   * returns the residual population for further investigation.
   */
  private emitAggHookWinnerAttribution(
    result: RouteBasic<TPool>[][],
    quoteMap: Map<RouteBasic<TPool>, QuoteBasic>,
    chainId: ChainId,
    ctx: UniContext,
    testAggHooks: boolean | undefined,
    tradeType: TradeType,
    metricTags: string[],
    aggHookAttribution: {
      firedPartitionKeptHigherGas: boolean;
      firedSoleCandidateAdmit: boolean;
      firedSoleCandidateGasWorse: boolean;
      firedChosenSplitGasWorse: boolean;
      firedAnchorSubOptimal: boolean;
    }
  ): void {
    if (!testAggHooks) return;
    if (result.length === 0) return;

    // The user-facing winner is selected downstream of findBestSplits
    // by the BL, which picks the combination with the highest raw
    // amount (matches `quoteAmount` in the response). `result[0]` is
    // NOT a reliable proxy because `filterAndSortResults` puts 100%
    // single-pool routes first regardless of score, so when the
    // winning combination is a split, it lives at `result[1+]`. Scan
    // the entire result and treat the highest-raw combination as
    // "the winner" for attribution purposes. This matches what
    // trading-service Cat-A classification sees.
    let chosenIdx = 0;
    let chosenRawTotal = 0n;
    let chosenGasTotal = 0n;
    let chosenLegsWithMissingGas = 0;
    let chosenHasAggHook = false;
    let chosenAggHookLegCount = 0;
    for (let i = 0; i < result.length; i++) {
      let raw = 0n;
      let gas = 0n;
      let missingGas = 0;
      let hasAggHook = false;
      let aggHookLegCount = 0;
      for (const route of result[i]) {
        const quote = quoteMap.get(route);
        if (!quote) {
          missingGas++;
          continue;
        }
        raw += quote.amount;
        const gasUse = quote.gasDetails?.gasUse;
        if (gasUse === undefined) {
          missingGas++;
        } else {
          gas += gasUse;
        }
        if (routeUsesAggHook(route, chainId)) {
          hasAggHook = true;
          aggHookLegCount++;
        }
      }
      if (i === 0 || raw > chosenRawTotal) {
        chosenIdx = i;
        chosenRawTotal = raw;
        chosenGasTotal = gas;
        chosenLegsWithMissingGas = missingGas;
        chosenHasAggHook = hasAggHook;
        chosenAggHookLegCount = aggHookLegCount;
      }
    }
    if (!chosenHasAggHook) return;
    const chosen = result[chosenIdx];

    // Find the highest-raw no-hook-only alternative in the result for
    // the payload (lets the residual be diagnosed in DD without
    // another deploy). Best-effort: skip combinations with any
    // missing gas. Skips the chosen combination itself.
    let noHookAltRawTotal: bigint | undefined;
    let noHookAltGasTotal: bigint | undefined;
    let noHookAltLegCount: number | undefined;
    for (let i = 0; i < result.length; i++) {
      if (i === chosenIdx) continue;
      const combination = result[i];
      let raw = 0n;
      let gas = 0n;
      let hasAggHook = false;
      let missingGas = false;
      for (const route of combination) {
        const quote = quoteMap.get(route);
        if (!quote || quote.gasDetails?.gasUse === undefined) {
          missingGas = true;
          break;
        }
        if (routeUsesAggHook(route, chainId)) {
          hasAggHook = true;
          break;
        }
        raw += quote.amount;
        gas += quote.gasDetails.gasUse;
      }
      if (missingGas || hasAggHook) continue;
      if (noHookAltRawTotal === undefined || raw > noHookAltRawTotal) {
        noHookAltRawTotal = raw;
        noHookAltGasTotal = gas;
        noHookAltLegCount = combination.length;
      }
    }

    // Shape-level Cat-A flag: chosen agg-hook winner has both higher
    // raw AND higher gas than the best no-hook alternative in result.
    // This is the structural fingerprint of a Cat-A loss within
    // uniroute (treatment raw-better, gas-worse). Distinct from the 5
    // mechanism flags above, which fire only on partition / sole-
    // candidate gate decisions and miss the 100%-single-leg agg-hook
    // winners (no partition fires at all on a 1-leg 100% combination).
    // Empirical prod measurement: ~95% of single-leg-100% agg-hook
    // winner catch-all residuals were attributable wins (equal gas
    // vs no-hook alt); only the ~5% with this flag set are the true
    // Cat-A loss-candidate population.
    const firedRawBetterGasWorseVsNoHookAlt =
      noHookAltRawTotal !== undefined &&
      noHookAltGasTotal !== undefined &&
      chosenRawTotal > noHookAltRawTotal &&
      chosenGasTotal > noHookAltGasTotal;

    const anyFired =
      aggHookAttribution.firedPartitionKeptHigherGas ||
      aggHookAttribution.firedSoleCandidateAdmit ||
      aggHookAttribution.firedSoleCandidateGasWorse ||
      aggHookAttribution.firedChosenSplitGasWorse ||
      aggHookAttribution.firedAnchorSubOptimal ||
      firedRawBetterGasWorseVsNoHookAlt;
    // Cardinality guard (cf. PR #8341): the metric tag list excludes
    // the 5 per-mechanism `firedXxx` flags. Including them would push
    // explicit-tag combinations to 2^5 × tradeType × chainId × ~auto-tag
    // multiplier into multi-million-timeseries territory, well above
    // the 500K SRE pager threshold. Per-mechanism categorization is
    // available on the log payload via the `attribution` object — DD
    // log analytics is the right surface for that breakdown. The
    // metric only sizes the residual rate via `attributed:true|false`.
    const baseTags = [
      ...metricTags,
      `testAggHooks:${testAggHooks}`,
      `tradeType:${tradeType}`,
    ];
    void ctx.metrics.count(
      buildMetricKey('QuoteBestSplitFinder.AggHookWinnerAttribution'),
      1,
      {tags: [...baseTags, `attributed:${anyFired}`]}
    );

    ctx.logger.info('QuoteBestSplitFinder agg-hook selected as winner', {
      chainId,
      tradeType,
      attribution: {
        ...aggHookAttribution,
        firedRawBetterGasWorseVsNoHookAlt,
        anyFired,
      },
      chosenSplit: {
        rawTotal: chosenRawTotal.toString(),
        gasTotal: chosenGasTotal.toString(),
        legCount: chosen.length,
        aggHookLegCount: chosenAggHookLegCount,
        legsWithMissingGas: chosenLegsWithMissingGas,
        // Index in `result` array. 0 = filterAndSortResults' top
        // (often a 100% single-pool route). >0 means the highest-raw
        // combination was a multi-leg split that sat behind a 100%
        // route in `result`. Useful for sanity-checking the catch-all
        // is targeting what the BL actually picks.
        resultIdx: chosenIdx,
        winnerRouteHash: hashForLogging(chosen[0].toString()),
      },
      noHookAlternative:
        noHookAltRawTotal !== undefined
          ? {
              rawTotal: noHookAltRawTotal.toString(),
              gasTotal: noHookAltGasTotal!.toString(),
              legCount: noHookAltLegCount,
              rawTotalDelta: (chosenRawTotal - noHookAltRawTotal).toString(),
              gasTotalDelta: (chosenGasTotal - noHookAltGasTotal!).toString(),
            }
          : null,
    });
  }

  /**
   * Cat-B catch-all attribution emission, symmetric to
   * `emitAggHookWinnerAttribution`. Fires whenever `testAggHooks=true`
   * AND the chosen winner has NO agg-hook leg. Emits both:
   *
   *   - `QuoteBestSplitFinder.NoHookWinnerCatBAttribution` metric
   *     tagged with `attributed:true|false` so DD can size the
   *     fraction of testAggHooks=true no-hook-winners that fire no
   *     known Cat-B mechanism log.
   *
   *   - `QuoteBestSplitFinder no-hook winner with agg-hooks enabled`
   *     log with attribution flags + payload (chosen split, best
   *     agg-hook alternative present in the result, raw/gas deltas).
   *
   * Today the only known Cat-B mechanism is the findBestSplits
   * timeout (PR #8069 investigation surfaced the compute-exhaustion
   * pattern). Future Cat-B mechanisms (K-budget eviction pressure,
   * pool-discovery divergence) can be added as additional `firedXxx`
   * flags without changing the emission cadence.
   */
  private emitNoHookWinnerCatBAttribution(
    result: RouteBasic<TPool>[][],
    quoteMap: Map<RouteBasic<TPool>, QuoteBasic>,
    chainId: ChainId,
    ctx: UniContext,
    testAggHooks: boolean | undefined,
    tradeType: TradeType,
    metricTags: string[],
    noHookCatBAttribution: {
      firedFindBestSplitsTimedOut: boolean;
    }
  ): void {
    if (!testAggHooks) return;
    if (result.length === 0) return;

    // Same winner detection as Cat-A: scan all of result for the
    // highest-raw combination (matches BL selection).
    let chosenIdx = 0;
    let chosenRawTotal = 0n;
    let chosenGasTotal = 0n;
    let chosenLegsWithMissingGas = 0;
    let chosenHasAggHook = false;
    for (let i = 0; i < result.length; i++) {
      let raw = 0n;
      let gas = 0n;
      let missingGas = 0;
      let hasAggHook = false;
      for (const route of result[i]) {
        const quote = quoteMap.get(route);
        if (!quote) {
          missingGas++;
          continue;
        }
        raw += quote.amount;
        const gasUse = quote.gasDetails?.gasUse;
        if (gasUse === undefined) {
          missingGas++;
        } else {
          gas += gasUse;
        }
        if (routeUsesAggHook(route, chainId)) {
          hasAggHook = true;
        }
      }
      if (i === 0 || raw > chosenRawTotal) {
        chosenIdx = i;
        chosenRawTotal = raw;
        chosenGasTotal = gas;
        chosenLegsWithMissingGas = missingGas;
        chosenHasAggHook = hasAggHook;
      }
    }
    // Cat-A's emission handles the agg-hook-winner case; don't
    // double-emit.
    if (chosenHasAggHook) return;
    const chosen = result[chosenIdx];

    // Find the highest-raw combination in result that DOES contain
    // agg-hook (the "what could have been picked if the BL had
    // selected differently"). Lets DD log analytics see whether the
    // agg-hook universe held a competitive alternative.
    let bestAggHookAltRawTotal: bigint | undefined;
    let bestAggHookAltGasTotal: bigint | undefined;
    let bestAggHookAltLegCount: number | undefined;
    let bestAggHookAltAggHookLegCount: number | undefined;
    for (let i = 0; i < result.length; i++) {
      if (i === chosenIdx) continue;
      const combination = result[i];
      let raw = 0n;
      let gas = 0n;
      let aggHookLegs = 0;
      let missingGas = false;
      for (const route of combination) {
        const quote = quoteMap.get(route);
        if (!quote || quote.gasDetails?.gasUse === undefined) {
          missingGas = true;
          break;
        }
        raw += quote.amount;
        gas += quote.gasDetails.gasUse;
        if (routeUsesAggHook(route, chainId)) {
          aggHookLegs++;
        }
      }
      if (missingGas || aggHookLegs === 0) continue;
      if (
        bestAggHookAltRawTotal === undefined ||
        raw > bestAggHookAltRawTotal
      ) {
        bestAggHookAltRawTotal = raw;
        bestAggHookAltGasTotal = gas;
        bestAggHookAltLegCount = combination.length;
        bestAggHookAltAggHookLegCount = aggHookLegs;
      }
    }

    // Shape-level Cat-B flag: the result contains an agg-hook
    // alternative with BOTH lower gas AND lower raw than the chosen
    // no-hook winner. Gas-adj-wise that alt MIGHT have been a better
    // pick (definitive answer depends on `gasCostInQuoteToken` which
    // isn't in the catch-all payload), so this flags Cat-B losses
    // where the BL had a cheaper-gas agg-hook option but chose
    // no-hook on raw alone. Empirical prod measurement: ~15% of Cat-B
    // catch-all residuals fit this shape — the rest are either
    // "no agg-hook in result" or "agg-hook alt strictly worse",
    // neither of which is a loss mechanism.
    const firedAggHookAltLowerGasAndRaw =
      bestAggHookAltRawTotal !== undefined &&
      bestAggHookAltGasTotal !== undefined &&
      chosenRawTotal > bestAggHookAltRawTotal &&
      chosenGasTotal > bestAggHookAltGasTotal;

    const anyFired =
      noHookCatBAttribution.firedFindBestSplitsTimedOut ||
      firedAggHookAltLowerGasAndRaw;
    // Cardinality guard (cf. PR #8341): the metric tag list excludes
    // the per-mechanism `firedXxx` flags. They live on the log payload
    // only — DD log analytics is the right surface for per-mechanism
    // breakdowns.
    const baseTags = [
      ...metricTags,
      `testAggHooks:${testAggHooks}`,
      `tradeType:${tradeType}`,
    ];
    void ctx.metrics.count(
      buildMetricKey('QuoteBestSplitFinder.NoHookWinnerCatBAttribution'),
      1,
      {tags: [...baseTags, `attributed:${anyFired}`]}
    );

    ctx.logger.info(
      'QuoteBestSplitFinder no-hook winner with agg-hooks enabled',
      {
        chainId,
        tradeType,
        attribution: {
          ...noHookCatBAttribution,
          firedAggHookAltLowerGasAndRaw,
          anyFired,
        },
        chosenSplit: {
          rawTotal: chosenRawTotal.toString(),
          gasTotal: chosenGasTotal.toString(),
          legCount: chosen.length,
          legsWithMissingGas: chosenLegsWithMissingGas,
          resultIdx: chosenIdx,
          winnerRouteHash: hashForLogging(chosen[0].toString()),
        },
        bestAggHookAlternative:
          bestAggHookAltRawTotal !== undefined
            ? {
                rawTotal: bestAggHookAltRawTotal.toString(),
                gasTotal: bestAggHookAltGasTotal!.toString(),
                legCount: bestAggHookAltLegCount,
                aggHookLegCount: bestAggHookAltAggHookLegCount,
                rawTotalDelta: (
                  chosenRawTotal - bestAggHookAltRawTotal
                ).toString(),
                gasTotalDelta: (
                  chosenGasTotal - bestAggHookAltGasTotal!
                ).toString(),
              }
            : null,
      }
    );
  }
}
