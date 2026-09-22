import {describe, expect, it} from 'vitest';
import {Token} from '@uniswap/sdk-core';
import {DYNAMIC_FEE_FLAG, Pool as V4SDKPool} from '@uniswap/v4-sdk';
import {ADDRESS_ZERO} from '@uniswap/router-sdk';

import {computeV4PoolId} from './v4PoolIdFast';
import {nativeOnChain} from './nativeOnChain';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const SIERRA = '0xbceb5f6877d979ec621ae694da1102cb95691ad3';
const HOOK = '0xa4e6f5500e88691fdcb289aa0e99067481434880';
const CHAIN_ID = 1;

/** The reference: what the SDK derives for the same PoolKey. */
function sdkPoolId(
  currencyA: string,
  currencyB: string,
  fee: number,
  tickSpacing: number,
  hooks: string
): string {
  const currency = (address: string) =>
    address === ADDRESS_ZERO
      ? nativeOnChain(CHAIN_ID)
      : new Token(CHAIN_ID, address, 18);
  return V4SDKPool.getPoolId(
    currency(currencyA),
    currency(currencyB),
    fee,
    tickSpacing,
    hooks
  ).toLowerCase();
}

describe('computeV4PoolId', () => {
  it('reproduces the pinned Base USDC/DGLD Arrakis pool id', () => {
    // Verbatim from the Base Initialize event at block 50219544 (ROUTE-1837).
    expect(
      computeV4PoolId(
        '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        '0xe908475f8beb7a138b0dc6eb5a05cb27068ffb9a',
        DYNAMIC_FEE_FLAG,
        5,
        HOOK
      )
    ).toBe(
      '0x68ab198bc4c61c8c691a3e35d1b3a5248d8e04acb9e28a1bb2ef0d3fa564fe93'
    );
  });

  it('matches the SDK across the PoolKey input space', () => {
    const fees = [0, 1, 100, 3000, 109_000, 0xff_ff_fe, DYNAMIC_FEE_FLAG];
    const tickSpacings = [
      1, 7, 60, 200, 32_767, -1, -60, -0x80_00_00, 0x7f_ff_ff,
    ];
    const pairs: Array<[string, string]> = [
      [USDC, SIERRA],
      [SIERRA, USDC], // reversed input order must sort identically
      [ADDRESS_ZERO, USDC], // native currency
      [USDC, ADDRESS_ZERO],
    ];
    const hooks = [ADDRESS_ZERO, HOOK];
    let cases = 0;
    for (const [a, b] of pairs) {
      for (const fee of fees) {
        for (const tickSpacing of tickSpacings) {
          for (const hook of hooks) {
            expect(computeV4PoolId(a, b, fee, tickSpacing, hook)).toBe(
              sdkPoolId(a, b, fee, tickSpacing, hook)
            );
            cases++;
          }
        }
      }
    }
    expect(cases).toBe(pairs.length * fees.length * tickSpacings.length * 2);
  });

  it('returns undefined for every input the SDK rejects, instead of a wrong id', () => {
    expect(computeV4PoolId(USDC, USDC, 3000, 60, ADDRESS_ZERO)).toBeUndefined();
    expect(() => sdkPoolId(USDC, USDC, 3000, 60, ADDRESS_ZERO)).toThrow();

    expect(computeV4PoolId(USDC, SIERRA, -1, 60, ADDRESS_ZERO)).toBeUndefined();
    expect(
      computeV4PoolId(USDC, SIERRA, 0x1_00_00_00, 60, ADDRESS_ZERO)
    ).toBeUndefined();
    expect(
      computeV4PoolId(USDC, SIERRA, 3000.5, 60, ADDRESS_ZERO)
    ).toBeUndefined();
    expect(
      computeV4PoolId(USDC, SIERRA, 3000, 0x80_00_00, ADDRESS_ZERO)
    ).toBeUndefined();
    expect(
      computeV4PoolId(USDC, SIERRA, 3000, -0x80_00_01, ADDRESS_ZERO)
    ).toBeUndefined();
    expect(computeV4PoolId(USDC, SIERRA, 3000, 60, '0xnothex')).toBeUndefined();
    expect(
      computeV4PoolId('0x1234', SIERRA, 3000, 60, ADDRESS_ZERO)
    ).toBeUndefined();
  });

  it('rejects non-lowercase addresses rather than normalizing them', () => {
    // The caller lowercases before comparing to the stored id; accepting
    // mixed case here would let a casing difference masquerade as a match.
    const checksummed = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
    expect(
      computeV4PoolId(checksummed, SIERRA, 3000, 60, ADDRESS_ZERO)
    ).toBeUndefined();
    expect(
      computeV4PoolId(
        USDC,
        SIERRA,
        3000,
        60,
        HOOK.toUpperCase().replace('0X', '0x')
      )
    ).toBeUndefined();
  });
});
