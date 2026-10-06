import {DYNAMIC_FEE_FLAG} from '@uniswap/v4-sdk';
import {V4SubgraphPool} from '../sor-providers/v4/subgraphProvider';
import {computeV4PoolId} from './v4PoolIdFast';

/**
 * True when the pool's `PoolKey.fee` is the dynamic-fee flag: the snapshot's
 * pool id is reproduced with `DYNAMIC_FEE_FLAG` as the fee. Pool ids do not
 * depend on token decimals, so only the addresses and tickSpacing matter.
 *
 * Returns `undefined` when an address or the tickSpacing is outside the
 * PoolKey domain; each caller decides how to fail.
 */
export function isPoolFeeDynamic(
  pool: Pick<
    V4SubgraphPool,
    'id' | 'token0' | 'token1' | 'tickSpacing' | 'hooks'
  >
): boolean | undefined {
  const dynamicPoolId = computeV4PoolId(
    pool.token0.id.toLowerCase(),
    pool.token1.id.toLowerCase(),
    DYNAMIC_FEE_FLAG,
    Number(pool.tickSpacing),
    pool.hooks.toLowerCase()
  );
  return dynamicPoolId === undefined
    ? undefined
    : dynamicPoolId === pool.id.toLowerCase();
}
