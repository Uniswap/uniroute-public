/**
 * Ported from @uniswap/smart-order-router/src/providers/v4/pool-provider.ts
 */

import {Currency} from '@uniswap/sdk-core';
import {DYNAMIC_FEE_FLAG, Pool} from '@uniswap/v4-sdk';

export function isPoolFeeDynamic(
  tokenA: Currency,
  tokenB: Currency,
  tickSpacing: number,
  hooks: string,
  poolId: string
): boolean {
  return (
    Pool.getPoolId(
      tokenA!,
      tokenB!,
      DYNAMIC_FEE_FLAG,
      tickSpacing,
      hooks
    ).toLowerCase() === poolId.toLowerCase()
  );
}
