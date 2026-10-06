import {describe, it, expect} from 'vitest';
import {isPoolFeeDynamic} from './isPoolFeeDynamic';
import {Token} from '@uniswap/sdk-core';
import {DYNAMIC_FEE_FLAG, Pool} from '@uniswap/v4-sdk';
import {V4SubgraphPool} from '../sor-providers/v4/subgraphProvider';

describe('isPoolFeeDynamic', () => {
  const tokenA = '0x0000000000000000000000000000000000000001';
  const tokenB = '0x0000000000000000000000000000000000000002';
  const tickSpacing = 60;
  const hooks = '0x0000000000000000000000000000000000000000';
  // The v4-sdk derivation is the independent reference for the expected id.
  const dynamicPoolId = Pool.getPoolId(
    new Token(1, tokenA, 18),
    new Token(1, tokenB, 18),
    DYNAMIC_FEE_FLAG,
    tickSpacing,
    hooks
  );

  function pool(
    id: string,
    overrides: Partial<Pick<V4SubgraphPool, 'tickSpacing' | 'hooks'>> & {
      token0?: string;
    } = {}
  ): Pick<
    V4SubgraphPool,
    'id' | 'token0' | 'token1' | 'tickSpacing' | 'hooks'
  > {
    return {
      id,
      token0: {id: overrides.token0 ?? tokenA, decimals: '18'},
      token1: {id: tokenB, decimals: '18'},
      tickSpacing: overrides.tickSpacing ?? String(tickSpacing),
      hooks: overrides.hooks ?? hooks,
    };
  }

  it('returns true when pool ID matches dynamic fee pool ID', () => {
    expect(isPoolFeeDynamic(pool(dynamicPoolId))).toBe(true);
  });

  it('returns false when pool ID does not match dynamic fee pool ID', () => {
    expect(isPoolFeeDynamic(pool('0xdeadbeef'))).toBe(false);
  });

  it('is case-insensitive for pool ID comparison', () => {
    expect(isPoolFeeDynamic(pool(dynamicPoolId.toUpperCase()))).toBe(true);
  });

  it('returns the same answer whatever order the tokens arrive in', () => {
    expect(
      isPoolFeeDynamic({
        ...pool(dynamicPoolId),
        token0: {id: tokenB, decimals: '18'},
        token1: {id: tokenA, decimals: '18'},
      })
    ).toBe(true);
  });

  it.each([
    {label: 'a token value that is not an address', input: {token0: 'nope'}},
    {label: 'a non-numeric tickSpacing', input: {tickSpacing: 'sixty'}},
    {label: 'a hooks value that is not an address', input: {hooks: 'nope'}},
  ])('returns undefined for $label', ({input}) => {
    expect(isPoolFeeDynamic(pool(dynamicPoolId, input))).toBeUndefined();
  });
});
