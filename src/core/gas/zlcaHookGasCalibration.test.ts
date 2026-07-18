import {describe, it, expect} from 'vitest';
import {zlcaHookGasAdjustment} from './zlcaHookGasCalibration';
import {ChainId} from '../../lib/config';
import {V2Pool} from '../../models/pool/V2Pool';
import {V4Pool} from '../../models/pool/V4Pool';
import {Address} from '../../models/address/Address';
import {
  LITEPSM_AGGREGATOR_HOOK_USDS_ON_MAINNET,
  LITEPSM_AGGREGATOR_HOOK_DAI_ON_MAINNET,
  DUALPOOL_HOOK_ON_MAINNET,
} from '../../lib/poolCaching/util/hooksAddressesAllowlist';

// Registry values asserted explicitly so a registry edit shows up here.
const LITEPSM_OVERHEAD = 500_000n;
const DUALPOOL_OVERHEAD = 3_000_000n;

const UNREGISTERED_HOOK_ADDR = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const NO_HOOK_ADDR = '0x0000000000000000000000000000000000000000';

const token0 = new Address('0x1000000000000000000000000000000000000000');
const token1 = new Address('0x2000000000000000000000000000000000000000');

const FAKE_POOL_ID_A = '0xaaa0000000000000000000000000000000000000';
const FAKE_POOL_ID_B = '0xbbb0000000000000000000000000000000000000';

function makeV4Pool(hooks: string, poolId: string): V4Pool {
  return new V4Pool(
    token0,
    token1,
    0,
    1,
    hooks,
    BigInt(0),
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

describe('zlcaHookGasAdjustment', () => {
  it('returns 0n for empty path', () => {
    expect(zlcaHookGasAdjustment([], ChainId.MAINNET)).toBe(0n);
  });

  it('returns 0n for V2-only route', () => {
    expect(zlcaHookGasAdjustment([makeV2Pool()], ChainId.MAINNET)).toBe(0n);
  });

  it('returns 0n for V4 pool with no hooks (zero address)', () => {
    expect(
      zlcaHookGasAdjustment(
        [makeV4Pool(NO_HOOK_ADDR, FAKE_POOL_ID_A)],
        ChainId.MAINNET
      )
    ).toBe(0n);
  });

  it('returns 0n for V4 pool with a non-ZLCA hook', () => {
    expect(
      zlcaHookGasAdjustment(
        [makeV4Pool(UNREGISTERED_HOOK_ADDR, FAKE_POOL_ID_A)],
        ChainId.MAINNET
      )
    ).toBe(0n);
  });

  it('returns the overhead for a LitePSM USDS hook leg on mainnet', () => {
    expect(
      zlcaHookGasAdjustment(
        [makeV4Pool(LITEPSM_AGGREGATOR_HOOK_USDS_ON_MAINNET, FAKE_POOL_ID_A)],
        ChainId.MAINNET
      )
    ).toBe(LITEPSM_OVERHEAD);
  });

  it('returns the overhead for a LitePSM DAI hook leg on mainnet', () => {
    expect(
      zlcaHookGasAdjustment(
        [makeV4Pool(LITEPSM_AGGREGATOR_HOOK_DAI_ON_MAINNET, FAKE_POOL_ID_A)],
        ChainId.MAINNET
      )
    ).toBe(LITEPSM_OVERHEAD);
  });

  it('returns the dualpool overhead for a dualpool hook leg on mainnet', () => {
    expect(
      zlcaHookGasAdjustment(
        [makeV4Pool(DUALPOOL_HOOK_ON_MAINNET, FAKE_POOL_ID_A)],
        ChainId.MAINNET
      )
    ).toBe(DUALPOOL_OVERHEAD);
  });

  it('returns 0n when a registered mainnet hook appears on a chain with no ZLCA hooks', () => {
    expect(
      zlcaHookGasAdjustment(
        [makeV4Pool(LITEPSM_AGGREGATOR_HOOK_USDS_ON_MAINNET, FAKE_POOL_ID_A)],
        ChainId.ARBITRUM
      )
    ).toBe(0n);
  });

  it('sums per-leg overhead across a route with two ZLCA-hook legs', () => {
    expect(
      zlcaHookGasAdjustment(
        [
          makeV4Pool(LITEPSM_AGGREGATOR_HOOK_USDS_ON_MAINNET, FAKE_POOL_ID_A),
          makeV4Pool(LITEPSM_AGGREGATOR_HOOK_DAI_ON_MAINNET, FAKE_POOL_ID_B),
        ],
        ChainId.MAINNET
      )
    ).toBe(2n * LITEPSM_OVERHEAD);
  });

  it('sums distinct per-hook overheads across a LitePSM leg and a dualpool leg', () => {
    expect(
      zlcaHookGasAdjustment(
        [
          makeV4Pool(LITEPSM_AGGREGATOR_HOOK_USDS_ON_MAINNET, FAKE_POOL_ID_A),
          makeV4Pool(DUALPOOL_HOOK_ON_MAINNET, FAKE_POOL_ID_B),
        ],
        ChainId.MAINNET
      )
    ).toBe(LITEPSM_OVERHEAD + DUALPOOL_OVERHEAD);
  });

  it('only counts ZLCA legs in a mixed route (V2 + ZLCA hook + non-ZLCA hook)', () => {
    expect(
      zlcaHookGasAdjustment(
        [
          makeV2Pool(),
          makeV4Pool(LITEPSM_AGGREGATOR_HOOK_USDS_ON_MAINNET, FAKE_POOL_ID_A),
          makeV4Pool(UNREGISTERED_HOOK_ADDR, FAKE_POOL_ID_B),
        ],
        ChainId.MAINNET
      )
    ).toBe(LITEPSM_OVERHEAD);
  });

  it('matches lookup regardless of hook-address case', () => {
    const checksummed = zlcaHookGasAdjustment(
      [
        makeV4Pool(
          '0x958A0904940f744f8c6b72c043CeeE3EA34AE888',
          FAKE_POOL_ID_A
        ),
      ],
      ChainId.MAINNET
    );
    expect(checksummed).toBe(LITEPSM_OVERHEAD);
  });
});
