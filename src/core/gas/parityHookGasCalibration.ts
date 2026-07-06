import {ChainId} from '../../lib/config';
import {Pool} from '../../models/pool/Pool';
import {V4Pool} from '../../models/pool/V4Pool';
import {PARITY_HOOKS_PER_CHAIN} from '../../lib/poolCaching/util/hooksAddressesAllowlist';

/**
 * Per-hop gas overhead for legs that hop through a Parity Hook pool
 * (see `PARITY_HOOKS_PER_CHAIN`). Corrects the heuristic estimator's
 * under-estimate for these pools' custom accounting.
 *
 * Parity hooks execute a full external conversion inside their
 * `beforeSwap` callback (e.g. the LitePSM hooks run
 * USDC → LitePSM sellGem → DAI → USDS mint), which the V3-style
 * heuristic — tuned for plain concentrated-liquidity swaps at
 * ~60-97k per V4 hop — cannot see. An under-estimated
 * `gasUseEstimate` becomes the tx gas limit downstream (trading uses
 * it verbatim instead of simulating), so the shortfall causes
 * execution reverts, not just bad route ranking: the swap itself
 * succeeds and the tx OOGs at the final Permit2 settle
 * (`TRANSFER_FROM_FAILED`).
 *
 * Calibration source (2026-07-06, mainnet LitePSM pools):
 *   - hook callback frame in a reverted prod-shape trace: ~218k
 *   - V4Quoter view-call gas for the full hop: 258k (superseded
 *     USDS hook deployment) / 275k (current USDS hook)
 *   - heuristic base for the same hop: ~60-97k
 * The observed shortfall on a reverted 3-split EXACT_OUT trade was
 * ~250-270k, and the V4Quoter view-call itself understates real
 * tx-context cost (the agg-hook calibration measured quoter-vs-
 * simulator misses of +67k..+188k), so 250k left near-zero margin
 * for the current (pricier) hook deployment. 500k doubles that:
 * over-estimating is safe — it's a gas limit, unused gas is
 * refunded — while under-estimating reverts user transactions. The
 * cost of the headroom is a mild gas-ranking penalty against parity
 * routes, which is the safe direction to err.
 *
 * Unlike the agg-hook calibration this is NOT env-gated: parity
 * pools are quoted through the standard V4Quoter, so there is no
 * per-protocol fallback table either. The adjustment applies only on
 * the heuristic base path — the V4Quoter's `gasEstimate` already
 * includes the hook callback, so quoter-based estimates must not add
 * it again.
 *
 * Cardinality: bounded — only hooks in the curated
 * `PARITY_HOOKS_PER_CHAIN` registry contribute.
 */
export const PARITY_HOOK_GAS_OVERHEAD = 500_000n;

/**
 * Returns the total gas-unit adjustment for a route, adding
 * `PARITY_HOOK_GAS_OVERHEAD` for every leg that hops through a
 * registered parity-hook pool. Multi-leg routes that use the same
 * hook twice add it twice — each hop runs the callback once.
 *
 * Returns `0n` when the route has no parity-hook legs; callers can
 * use the zero return safely without any extra branch.
 */
export function parityHookGasAdjustment(
  path: Pool[],
  chainId: ChainId
): bigint {
  const parityHooks = PARITY_HOOKS_PER_CHAIN[chainId];
  if (!parityHooks || parityHooks.length === 0) return 0n;
  const parityHookSet = new Set(parityHooks.map(hook => hook.toLowerCase()));

  let total = 0n;
  for (const pool of path) {
    if (!(pool instanceof V4Pool)) continue;
    const hooks = pool.hooks;
    if (typeof hooks !== 'string') continue;
    if (!parityHookSet.has(hooks.toLowerCase())) continue;
    total += PARITY_HOOK_GAS_OVERHEAD;
  }
  return total;
}
