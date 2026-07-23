import {ChainId} from '../../lib/config';
import {Pool} from '../../models/pool/Pool';
import {V4Pool} from '../../models/pool/V4Pool';
import {ZLCA_HOOKS_PER_CHAIN} from '../../lib/poolCaching/util/hooksAddressesAllowlist';
import {getDynamicZlcaHooks} from '../../lib/poolCaching/util/dynamicZlcaHooks';

/**
 * Returns the total gas-unit adjustment for a route, adding each ZLCA
 * (Zero-Liquidity Custom-Accounting) hook's registered per-hop overhead
 * (the map value in `ZLCA_HOOKS_PER_CHAIN` — see that doc comment for
 * the full rationale and calibration history) for every leg that hops
 * through one of its pools. Multi-leg routes that use the same hook
 * twice add it twice — each hop runs the callback once.
 *
 * Applies only on the heuristic base path: the V4Quoter's `gasEstimate`
 * already includes the hook callback, so quoter-based estimates must not
 * add it again. Not env-gated — ZLCA pools are quoted through the
 * standard V4Quoter, so there is no per-protocol fallback table either.
 * Cardinality: bounded — only hooks in the curated registry contribute.
 *
 * Returns `0n` when the route has no ZLCA-hook legs; callers can use the
 * zero return safely without any extra branch.
 */
export function zlcaHookGasAdjustment(path: Pool[], chainId: ChainId): bigint {
  const zlcaHooks = ZLCA_HOOKS_PER_CHAIN[chainId];
  // getDynamicZlcaHooks returns undefined until factory enumeration has
  // discovered hooks on this chain, so chains with neither a static registry
  // nor factory-discovered hooks exit here.
  const dynamicZlcaHooks = getDynamicZlcaHooks(chainId);
  if (!zlcaHooks && !dynamicZlcaHooks) return 0n;

  let total = 0n;
  for (const pool of path) {
    if (!(pool instanceof V4Pool)) continue;
    const hooks = pool.hooks;
    if (typeof hooks !== 'string') continue;
    // Registry keys are lowercase (enforced by hooksAddressesAllowlist.test.ts)
    const hookLower = hooks.toLowerCase();
    // Static registry wins; factory-discovered dynamic ZLCA hooks
    // (dynamicZlcaHooks.ts) fall back to their factory's per-hop overhead.
    total += zlcaHooks?.[hookLower] ?? dynamicZlcaHooks?.get(hookLower) ?? 0n;
  }
  return total;
}
