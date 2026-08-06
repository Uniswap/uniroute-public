import {ChainId} from '../../lib/config';
import {Pool} from '../../models/pool/Pool';
import {V4Pool} from '../../models/pool/V4Pool';

export const ERC4626_WRAPPER_GAS_PER_CHAIN: Partial<
  Record<ChainId, Record<string, bigint>>
> = {};

/**
 * Returns the total registered ERC-4626 wrapper-hook overhead for a route.
 * Apply only on the heuristic path: the V4Quoter gas estimate already runs
 * hook callbacks and must not be adjusted again.
 */
export function erc4626WrapperHookGasAdjustment(
  path: Pool[],
  chainId: ChainId
): bigint {
  const wrapperHooks = ERC4626_WRAPPER_GAS_PER_CHAIN[chainId];
  if (!wrapperHooks) return 0n;

  let total = 0n;
  for (const pool of path) {
    if (!(pool instanceof V4Pool)) continue;
    const hooks = pool.hooks;
    if (typeof hooks !== 'string') continue;
    total += wrapperHooks[hooks.toLowerCase()] ?? 0n;
  }
  return total;
}
