import {afterEach, describe, expect, it} from 'vitest';
import {ChainId} from '../../lib/config';
import {Address} from '../../models/address/Address';
import {V2Pool} from '../../models/pool/V2Pool';
import {V4Pool} from '../../models/pool/V4Pool';
import {
  ERC4626_WRAPPER_GAS_PER_CHAIN,
  erc4626WrapperHookGasAdjustment,
} from './erc4626WrapperHookGasCalibration';

const WRAPPER_HOOK_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const WRAPPER_HOOK_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const UNREGISTERED_HOOK = '0xcccccccccccccccccccccccccccccccccccccccc';
const token0 = new Address('0x1000000000000000000000000000000000000000');
const token1 = new Address('0x2000000000000000000000000000000000000000');

function makeV4Pool(hooks: string, poolId: string): V4Pool {
  return new V4Pool(token0, token1, 0, 1, hooks, 0n, poolId, 1_000n, 0n);
}

function makeV2Pool(): V2Pool {
  return new V2Pool(
    token0,
    token1,
    new Address('0x4000000000000000000000000000000000000000'),
    1_000n,
    1_000n
  );
}

describe('erc4626WrapperHookGasAdjustment', () => {
  afterEach(() => {
    delete ERC4626_WRAPPER_GAS_PER_CHAIN[ChainId.MAINNET];
  });

  it('returns 0n when the chain has no registered wrapper hooks', () => {
    expect(erc4626WrapperHookGasAdjustment([], ChainId.MAINNET)).toBe(0n);
    expect(
      erc4626WrapperHookGasAdjustment(
        [
          makeV4Pool(
            WRAPPER_HOOK_A,
            '0xaaa0000000000000000000000000000000000000'
          ),
        ],
        ChainId.MAINNET
      )
    ).toBe(0n);
  });

  it('sums registered wrapper-hook overhead for every V4 leg', () => {
    ERC4626_WRAPPER_GAS_PER_CHAIN[ChainId.MAINNET] = {
      [WRAPPER_HOOK_A]: 11_000n,
      [WRAPPER_HOOK_B]: 22_000n,
    };

    expect(
      erc4626WrapperHookGasAdjustment(
        [
          makeV2Pool(),
          makeV4Pool(
            WRAPPER_HOOK_A,
            '0xaaa0000000000000000000000000000000000000'
          ),
          makeV4Pool(
            UNREGISTERED_HOOK,
            '0xbbb0000000000000000000000000000000000000'
          ),
          makeV4Pool(
            WRAPPER_HOOK_B,
            '0xccc0000000000000000000000000000000000000'
          ),
        ],
        ChainId.MAINNET
      )
    ).toBe(33_000n);
  });

  it('matches registered hooks regardless of address case', () => {
    ERC4626_WRAPPER_GAS_PER_CHAIN[ChainId.MAINNET] = {
      [WRAPPER_HOOK_A]: 11_000n,
    };

    expect(
      erc4626WrapperHookGasAdjustment(
        [
          makeV4Pool(
            '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa',
            '0xaaa0000000000000000000000000000000000000'
          ),
        ],
        ChainId.MAINNET
      )
    ).toBe(11_000n);
  });
});
