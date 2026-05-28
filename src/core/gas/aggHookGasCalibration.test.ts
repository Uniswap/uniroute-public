import {describe, it, expect} from 'vitest';
import {
  AGG_HOOK_GAS_CALIBRATION_OVERHEAD,
  aggHookGasCalibrationAdjustment,
} from './aggHookGasCalibration';
import {ChainId} from '../../lib/config';
import {V2Pool} from '../../models/pool/V2Pool';
import {V3Pool} from '../../models/pool/V3Pool';
import {V4Pool} from '../../models/pool/V4Pool';
import {Address} from '../../models/address/Address';

const FLUID_DEX_T1_ADDR = '0xf1abe2961CCf73B55be164054E7ADC985a52A888';
const FLUID_DEX_LITE_ADDR = '0xF37c11667d10BbC39C7712a5409c19Ced7EBa088';
const STABLE_SWAP_NG_ADDR = '0xc24cf69d2f636db53b57342709bdcb01fbd3a088';
const UNREGISTERED_HOOK_ADDR = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const NO_HOOK_ADDR = '0x0000000000000000000000000000000000000000';

const token0 = new Address('0x1000000000000000000000000000000000000000');
const token1 = new Address('0x2000000000000000000000000000000000000000');
const token2 = new Address('0x3000000000000000000000000000000000000000');

const FAKE_POOL_ID_A = '0xaaa0000000000000000000000000000000000000';
const FAKE_POOL_ID_B = '0xbbb0000000000000000000000000000000000000';

function makeV4Pool(hooks: string, poolId: string): V4Pool {
  return new V4Pool(
    token0,
    token1,
    500,
    60,
    hooks,
    BigInt(1000),
    poolId,
    BigInt(1000),
    BigInt(0)
  );
}

function makeV2Pool(): V2Pool {
  return new V2Pool(
    token0,
    token1,
    new Address('0x1234567890123456789012345678901234567890'),
    BigInt(1000),
    BigInt(1000)
  );
}

function makeV3Pool(): V3Pool {
  return new V3Pool(
    token1,
    token2,
    500,
    new Address('0x3234567890123456789012345678901234567890'),
    BigInt(1000),
    BigInt(1000),
    BigInt(0)
  );
}

describe('aggHookGasCalibrationAdjustment', () => {
  it('returns 0n for empty path', () => {
    expect(aggHookGasCalibrationAdjustment([], ChainId.MAINNET)).toBe(0n);
  });

  it('returns 0n for V2-only route', () => {
    expect(
      aggHookGasCalibrationAdjustment([makeV2Pool()], ChainId.MAINNET)
    ).toBe(0n);
  });

  it('returns 0n for V3-only route', () => {
    expect(
      aggHookGasCalibrationAdjustment([makeV3Pool()], ChainId.MAINNET)
    ).toBe(0n);
  });

  it('returns 0n for V4 pool with no hooks (zero address)', () => {
    expect(
      aggHookGasCalibrationAdjustment(
        [makeV4Pool(NO_HOOK_ADDR, FAKE_POOL_ID_A)],
        ChainId.MAINNET
      )
    ).toBe(0n);
  });

  it('returns 0n for V4 pool with unregistered hook address', () => {
    expect(
      aggHookGasCalibrationAdjustment(
        [makeV4Pool(UNREGISTERED_HOOK_ADDR, FAKE_POOL_ID_A)],
        ChainId.MAINNET
      )
    ).toBe(0n);
  });

  it('returns FluidDexT1 overhead for a FluidDexT1 hook on mainnet', () => {
    const adjustment = aggHookGasCalibrationAdjustment(
      [makeV4Pool(FLUID_DEX_T1_ADDR, FAKE_POOL_ID_A)],
      ChainId.MAINNET
    );
    expect(adjustment).toBe(AGG_HOOK_GAS_CALIBRATION_OVERHEAD['FluidDexT1']);
    expect(adjustment).toBe(172_000n);
  });

  it('returns FluidDexLite overhead for a FluidDexLite hook on mainnet', () => {
    const adjustment = aggHookGasCalibrationAdjustment(
      [makeV4Pool(FLUID_DEX_LITE_ADDR, FAKE_POOL_ID_A)],
      ChainId.MAINNET
    );
    expect(adjustment).toBe(67_000n);
  });

  it('returns CurveStableSwapNG overhead for a NG hook on mainnet', () => {
    const adjustment = aggHookGasCalibrationAdjustment(
      [makeV4Pool(STABLE_SWAP_NG_ADDR, FAKE_POOL_ID_A)],
      ChainId.MAINNET
    );
    expect(adjustment).toBe(188_000n);
  });

  it('returns 0n when a registered mainnet hook appears on a non-mainnet chainId', () => {
    expect(
      aggHookGasCalibrationAdjustment(
        [makeV4Pool(FLUID_DEX_T1_ADDR, FAKE_POOL_ID_A)],
        ChainId.ARBITRUM
      )
    ).toBe(0n);
  });

  it('sums per-leg overhead across a multi-hop route hitting the same protocol twice', () => {
    const adjustment = aggHookGasCalibrationAdjustment(
      [
        makeV4Pool(FLUID_DEX_T1_ADDR, FAKE_POOL_ID_A),
        makeV4Pool(FLUID_DEX_T1_ADDR, FAKE_POOL_ID_B),
      ],
      ChainId.MAINNET
    );
    expect(adjustment).toBe(2n * 172_000n);
  });

  it('sums per-leg overhead across a multi-hop route with different protocols', () => {
    const adjustment = aggHookGasCalibrationAdjustment(
      [
        makeV4Pool(FLUID_DEX_T1_ADDR, FAKE_POOL_ID_A),
        makeV4Pool(STABLE_SWAP_NG_ADDR, FAKE_POOL_ID_B),
      ],
      ChainId.MAINNET
    );
    expect(adjustment).toBe(172_000n + 188_000n);
  });

  it('only counts calibrated legs in a mixed route (V2 + agg hook + unregistered hook)', () => {
    const adjustment = aggHookGasCalibrationAdjustment(
      [
        makeV2Pool(),
        makeV4Pool(FLUID_DEX_T1_ADDR, FAKE_POOL_ID_A),
        makeV4Pool(UNREGISTERED_HOOK_ADDR, FAKE_POOL_ID_B),
      ],
      ChainId.MAINNET
    );
    expect(adjustment).toBe(172_000n);
  });

  it('matches lookup regardless of hook-address case', () => {
    const lower = aggHookGasCalibrationAdjustment(
      [makeV4Pool(FLUID_DEX_T1_ADDR.toLowerCase(), FAKE_POOL_ID_A)],
      ChainId.MAINNET
    );
    const upper = aggHookGasCalibrationAdjustment(
      [makeV4Pool(FLUID_DEX_T1_ADDR.toUpperCase(), FAKE_POOL_ID_A)],
      ChainId.MAINNET
    );
    expect(lower).toBe(172_000n);
    expect(upper).toBe(172_000n);
  });
});
