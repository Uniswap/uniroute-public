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
