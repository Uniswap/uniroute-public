import {ChainId} from '../../lib/config';
import {Pool} from '../../models/pool/Pool';
import {V4Pool} from '../../models/pool/V4Pool';
import {getProtocolForAggHookAddress} from '../../lib/poolCaching/util/hooksAddressesAllowlist';

/**
 * Per-agg-hook-protocol gas overhead in gas units. Added to the
 * estimator's base gas use ONLY for legs that hop through a
 * registered agg-hook pool, to correct for V4Quoter's view-call
 * under-estimate of production transaction gas.
 *
 * Background: V4Quoter simulates `poolManager.swap()` in a standalone
 * eth_call. It captures the swap-only execution including the hook's
 * `beforeSwap` callback, but misses cost components that only show
 * up in the full Universal Router transaction context — multicall
 * coordination, settle/take refunds, permit handling, and any
 * hook-internal state that depends on real tx context. For no-hook
 * V4 pools the missed cost is fairly constant (~160k) and is already
 * absorbed by the estimator's `BASE_SWAP_COST` + `SINGLE_HOP_OVERHEAD`
 * constants. For agg-hook pools the missed cost is materially
 * larger and varies by protocol because each hook implementation
 * has its own router-side coordination overhead.
 *
 * Calibration source: prod data on `commit-2787f7f` (PR #8559)
 * comparing trading-side `treatmentGasEstimate` (Tenderly simulator
 * result when `simulationStatus:SUCCESS`) vs the same field when
 * `simulationStatus:INSUFFICIENT_BALANCE` (which falls back to the
 * V4Quoter view-call number). Cat-A loss traces with the dominant
 * hook of each protocol were used as the sample.
 *
 * Per-protocol numbers (avg simulator gas − avg quoter gas, with the
 * no-hook control's same delta subtracted to isolate hook-specific
 * overhead):
 *
 *   FluidDexT1:          +172k  (sample: 168 SUCCESS / 216 INSUF)
 *   FluidDexLite:         +67k  (sample:  37 SUCCESS / 201 INSUF)
 *   CurveStableSwapNG:   +188k  (sample:  80 SUCCESS /  60 INSUF)
 *
 * These constants should be refreshed periodically as we collect
 * more sim-vs-quoter data and as hook implementations evolve. The
 * `KBudgetAdmitProjectedLoss` and `AggHookWinnerByAddress` metrics
 * will surface drift if the calibration goes stale.
 *
 * Cardinality: bounded — only registered agg-hook protocols can
 * contribute, and unrecognized hooks are dropped via the registry
 * lookup. New protocols added to `HOOKS_ADDRESSES_ALLOWLIST` will
 * default to zero overhead (no correction) until their constant is
 * added here.
 */
export const AGG_HOOK_GAS_CALIBRATION_OVERHEAD: Readonly<
  Record<string, bigint>
> = {
  FluidDexT1: 172_000n,
  FluidDexLite: 67_000n,
  CurveStableSwapNG: 188_000n,
};

/**
 * Per-agg-hook-protocol V4Quoter-equivalent gas fallback. Used as
 * the base gas value for agg-hook routes that were quoted directly
 * via the hook ABI (`fetchAggHookQuotes`) and therefore lack a
 * `V3QuoterResponseDetails.gasEstimate`. Without this fallback the
 * `V4_USE_QUOTER_GAS_AS_BASE` code path silently degrades to the
 * heuristic baseline for the actual production agg-hook routes —
 * exactly the routes the calibration was designed to fix.
 *
 * The values are the average single-hop V4Quoter view-call gas
 * observed on the same SUCCESS traces used to derive the
 * calibration overhead (see `AGG_HOOK_GAS_CALIBRATION_OVERHEAD`).
 * Treating these as the per-leg quoter-equivalent base keeps the
 * accounting consistent: total per-leg gas =
 *   `AGG_HOOK_QUOTER_GAS_FALLBACK[protocol]` +
 *   `AGG_HOOK_GAS_CALIBRATION_OVERHEAD[protocol]`
 * which matches `simulator_gas − universal_router_overhead` for
 * routes with one agg-hook leg.
 *
 * If a future protocol is added to
 * `AGG_HOOK_GAS_CALIBRATION_OVERHEAD`, add it here too — otherwise
 * routes through that protocol will keep falling back to the
 * heuristic even with the kill-switch on.
 */
export const AGG_HOOK_QUOTER_GAS_FALLBACK: Readonly<Record<string, bigint>> = {
  FluidDexT1: 250_000n,
  FluidDexLite: 233_000n,
  CurveStableSwapNG: 249_000n,
};

/**
 * Returns the total gas-unit calibration adjustment for a route,
 * summing per-protocol overhead across every leg that hops through
 * a registered agg-hook pool. Multi-leg routes that use the same
 * hook twice add it twice — each hop runs the callback once.
 *
 * Returns `0n` when the route has no agg-hook legs OR when none of
 * the agg-hook legs match a calibrated protocol; callers can use
 * the zero return safely without any extra branch.
 */
export function aggHookGasCalibrationAdjustment(
  path: Pool[],
  chainId: ChainId
): bigint {
  let total = 0n;
  for (const pool of path) {
    if (!(pool instanceof V4Pool)) continue;
    const hooks = pool.hooks;
    if (typeof hooks !== 'string') continue;
    const protocol = getProtocolForAggHookAddress(hooks.toLowerCase(), chainId);
    if (protocol === undefined) continue;
    const overhead = AGG_HOOK_GAS_CALIBRATION_OVERHEAD[protocol];
    if (overhead === undefined) continue;
    total += overhead;
  }
  return total;
}

/**
 * Returns the per-leg V4Quoter-equivalent gas fallback for any
 * agg-hook legs in the route, or `0n` if the route has none.
 *
 * Used by `V4GasEstimator` when the kill-switch is on but the quote
 * was produced by `fetchAggHookQuotes` (no `gasEstimate` field).
 * Pairs with `aggHookGasCalibrationAdjustment` — callers add both
 * to compose the full router-side gas for an agg-hook route.
 */
export function aggHookQuoterGasFallback(
  path: Pool[],
  chainId: ChainId
): bigint {
  let total = 0n;
  for (const pool of path) {
    if (!(pool instanceof V4Pool)) continue;
    const hooks = pool.hooks;
    if (typeof hooks !== 'string') continue;
    const protocol = getProtocolForAggHookAddress(hooks.toLowerCase(), chainId);
    if (protocol === undefined) continue;
    const fallback = AGG_HOOK_QUOTER_GAS_FALLBACK[protocol];
    if (fallback === undefined) continue;
    total += fallback;
  }
  return total;
}
