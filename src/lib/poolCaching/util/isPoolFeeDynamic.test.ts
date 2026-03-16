import {describe, it, expect} from 'vitest';
import {isPoolFeeDynamic} from './isPoolFeeDynamic';
import {Token} from '@uniswap/sdk-core';
import {DYNAMIC_FEE_FLAG, Pool} from '@uniswap/v4-sdk';

describe('isPoolFeeDynamic', () => {
  const tokenA = new Token(1, '0x0000000000000000000000000000000000000001', 18, 'A', 'Token A');
  const tokenB = new Token(1, '0x0000000000000000000000000000000000000002', 18, 'B', 'Token B');
  const tickSpacing = 60;
  const hooks = '0x0000000000000000000000000000000000000000';

  it('returns true when pool ID matches dynamic fee pool ID', () => {
    const dynamicPoolId = Pool.getPoolId(tokenA, tokenB, DYNAMIC_FEE_FLAG, tickSpacing, hooks);
    expect(isPoolFeeDynamic(tokenA, tokenB, tickSpacing, hooks, dynamicPoolId)).toBe(true);
  });

  it('returns false when pool ID does not match dynamic fee pool ID', () => {
    expect(isPoolFeeDynamic(tokenA, tokenB, tickSpacing, hooks, '0xdeadbeef')).toBe(false);
  });

  it('is case-insensitive for pool ID comparison', () => {
    const dynamicPoolId = Pool.getPoolId(tokenA, tokenB, DYNAMIC_FEE_FLAG, tickSpacing, hooks);
    expect(isPoolFeeDynamic(tokenA, tokenB, tickSpacing, hooks, dynamicPoolId.toUpperCase())).toBe(true);
  });
});
