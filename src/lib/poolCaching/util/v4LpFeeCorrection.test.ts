import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import type {AddressInfo} from 'node:net';
import {DYNAMIC_FEE_FLAG, Pool} from '@uniswap/v4-sdk';
import {Token} from '@uniswap/sdk-core';

import {
  applyV4LpFeeCorrection,
  calculateSwapFee,
  isDynamicFeeV4Pool,
  isFeeTierProvenByPoolId,
  makeStateViewPoolKeyFeeReader,
  resetV4LpFeeMemoForTesting,
  resolveFeeTier,
  unpackProtocolFee,
  v4LpFeeCorrectionChainsFromEnv,
  v4LpFeeCorrectionReadCapFromEnv,
  V4_LP_FEE_CORRECTION_DEFAULT_MAX_READS_PER_TICK,
  V4_STATE_VIEW_BY_CHAIN,
  V4PoolKeyFeeReader,
  V4PoolKeyFees,
} from './v4LpFeeCorrection';
import {V4SubgraphPool} from '../sor-providers/v4/subgraphProvider';
import {v4HooksPoolsFiltering} from './v4HooksPoolsFiltering';
import {Logger} from '../sor-providers/util/log';
import {IMetric} from '../sor-providers/util/metric';

const CHAIN_ID = 1;

// A PoolKey whose fee is the dynamic sentinel, and the otherwise-identical
// PoolKey with a static 3000 fee. Both ids are literals so the tests below
// pin them rather than re-deriving with the same call the guard makes;
// `pins the fixture pool ids` checks the literals against the derivation.
const TOKEN_A = '0x0000000000000000000000000000000000000011';
const TOKEN_B = '0x0000000000000000000000000000000000000022';
const DYNAMIC_HOOK = '0x0000000000000000000000000000000000000080';
const HOOKLESS = '0x0000000000000000000000000000000000000000';
const DYNAMIC_POOL_ID =
  '0xa3b5e5acf951d312f5218c26863b9075ed42d372cb1750e9f6e7e5af02511326';
const STATIC_POOL_ID =
  '0x892b927419a579af0b683b77a234bc3f6db044e13d2ecdca04cd7d716f335641';
const HOOKLESS_DYNAMIC_POOL_ID =
  '0x16d581ae92e055249ceab19a6b6e75c367dfd528033ca9d33409551b6f057e5c';
// (TOKEN_A, TOKEN_B, fee 3000, tickSpacing 60, no hook) — a PoolKey whose id
// re-derives from its own feeTier, i.e. the pre-filter's positive case.
const HOOKLESS_3000_POOL_ID =
  '0x58b838a63f41294ab9afa308e83f54a7337ad0e6cee51dd3d89fd6b0ab756c4d';

/** Same PoolKey shape as the ids above, with a settable id and feeTier. */
function hookedPool(id: string, feeTier: string): V4SubgraphPool {
  return {
    id,
    feeTier,
    tickSpacing: '60',
    hooks: DYNAMIC_HOOK,
    liquidity: '1000',
    token0: {id: TOKEN_A, decimals: '18'},
    token1: {id: TOKEN_B, decimals: '18'},
    tvlETH: 10,
    tvlUSD: 10,
  } as unknown as V4SubgraphPool;
}

/**
 * The four independently measured (protocolFee, lpFee) → total pairs, each
 * read from slot0 on-chain and cross-checked against the subgraph's drifted
 * feeTier.
 */
const MEASURED_POOLS = [
  {label: 'ETH/USDC 0xdce6…f78d', protocolFee: 500, lpFee: 3000, total: 3499},
  {label: 'ETH/USDC 0x21c6…ca27', protocolFee: 125, lpFee: 500, total: 625},
  {label: 'USDC/SIERRA 0xb2bc…8a8f', protocolFee: 100, lpFee: 375, total: 475},
  {
    label: 'USDC/HmS 0xbd25…c517',
    protocolFee: 1000,
    lpFee: 199000,
    total: 199801,
  },
] as const;

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

const noopMetric = {putMetric: () => {}} as unknown as IMetric;

/** Closure-based fake metric: sums emitted values per correction counter. */
function makeRecordingMetric(): {
  metric: IMetric;
  total: (suffix: string) => number;
  tagsFor: (suffix: string) => Array<Record<string, string> | undefined>;
} {
  const emitted: Array<{
    key: string;
    value: number;
    tags?: Record<string, string>;
  }> = [];
  const metric = {
    putMetric: (
      key: string,
      value: number,
      _unit?: unknown,
      tags?: Record<string, string>
    ) => {
      emitted.push({key, value, tags});
    },
  } as unknown as IMetric;
  const matching = (suffix: string) =>
    emitted.filter(e => e.key === `CachePools.v4LpFeeCorrection.${suffix}`);
  return {
    metric,
    total: suffix => matching(suffix).reduce((sum, e) => sum + e.value, 0),
    tagsFor: suffix => matching(suffix).map(e => e.tags),
  };
}

/** Closure-based fake: answers from a fixed map, records what was asked for. */
function makeFakeReader(fees: Record<string, V4PoolKeyFees>): {
  reader: V4PoolKeyFeeReader;
  requested: string[][];
} {
  const requested: string[][] = [];
  return {
    requested,
    reader: {
      readPoolKeyFees: async (_chainId, poolIds) => {
        requested.push([...poolIds]);
        const result = new Map<string, V4PoolKeyFees>();
        for (const poolId of poolIds) {
          const entry = fees[poolId];
          if (entry) result.set(poolId, entry);
        }
        return result;
      },
    },
  };
}

function pool(id: string, feeTier: string): V4SubgraphPool {
  return {
    id,
    feeTier,
    tickSpacing: '60',
    hooks: '0x0000000000000000000000000000000000000000',
    liquidity: '1000',
    token0: {id: '0x0000000000000000000000000000000000000000'},
    token1: {id: '0x0000000000000000000000000000000000000001'},
    tvlETH: 10,
    tvlUSD: 10,
  } as unknown as V4SubgraphPool;
}

const fees = (
  lpFeePips: number,
  zeroForOnePips = 0,
  oneForZeroPips = zeroForOnePips
): V4PoolKeyFees => ({lpFeePips, zeroForOnePips, oneForZeroPips});

describe('calculateSwapFee', () => {
  it.each(MEASURED_POOLS)(
    'reproduces the measured total swap fee for $label',
    ({protocolFee, lpFee, total}) => {
      expect(calculateSwapFee(protocolFee, lpFee)).toBe(total);
    }
  );

  it('is a no-op when the protocol fee is zero', () => {
    for (const {lpFee} of MEASURED_POOLS) {
      expect(calculateSwapFee(0, lpFee)).toBe(lpFee);
    }
  });

  it('floors the product term rather than rounding it', () => {
    // 500 + 3000 = 3500; the product term is 1.5, floored to 1 → 3499.
    expect(calculateSwapFee(500, 3000)).toBe(3499);
    // 1000 * 199000 / 1e6 = 199.0 exactly → 200000 - 199 = 199801.
    expect(calculateSwapFee(1000, 199000)).toBe(199801);
  });
});

describe('unpackProtocolFee', () => {
  it.each([
    // Values as read from slot0 on chain 1 (2026-08-03).
    {packed: 0x64064, zeroForOnePips: 100, oneForZeroPips: 100},
    {packed: 0x7d07d, zeroForOnePips: 125, oneForZeroPips: 125},
    {packed: 0x1f41f4, zeroForOnePips: 500, oneForZeroPips: 500},
    {packed: 0x19019, zeroForOnePips: 25, oneForZeroPips: 25},
    {packed: 0, zeroForOnePips: 0, oneForZeroPips: 0},
    // Asymmetric directions.
    {packed: (300 << 12) | 100, zeroForOnePips: 100, oneForZeroPips: 300},
  ])('unpacks $packed', ({packed, zeroForOnePips, oneForZeroPips}) => {
    expect(unpackProtocolFee(packed)).toEqual({
      zeroForOnePips,
      oneForZeroPips,
    });
  });
});

describe('isDynamicFeeV4Pool', () => {
  it('pins the fixture pool ids to the PoolKeys they claim to encode', () => {
    const a = new Token(CHAIN_ID, TOKEN_A, 18);
    const b = new Token(CHAIN_ID, TOKEN_B, 18);
    expect(Pool.getPoolId(a, b, DYNAMIC_FEE_FLAG, 60, DYNAMIC_HOOK)).toBe(
      DYNAMIC_POOL_ID
    );
    expect(Pool.getPoolId(a, b, 3000, 60, DYNAMIC_HOOK)).toBe(STATIC_POOL_ID);
  });

  it('detects a dynamic-fee pool from its id', () => {
    expect(
      isDynamicFeeV4Pool(CHAIN_ID, hookedPool(DYNAMIC_POOL_ID, '3499'))
    ).toBe(true);
  });

  it('does not flag a static-fee pool behind the same hook', () => {
    expect(
      isDynamicFeeV4Pool(CHAIN_ID, hookedPool(STATIC_POOL_ID, '3499'))
    ).toBe(false);
  });

  it('short-circuits a hookless pool, since a dynamic fee needs a hook', () => {
    const pool = {
      ...hookedPool(HOOKLESS_DYNAMIC_POOL_ID, '3499'),
      hooks: '0x0000000000000000000000000000000000000000',
    } as V4SubgraphPool;
    expect(isDynamicFeeV4Pool(CHAIN_ID, pool)).toBe(false);
  });

  it('treats a pool whose currencies will not construct as dynamic', () => {
    const pool = {
      ...hookedPool(DYNAMIC_POOL_ID, '3499'),
      token0: {id: 'not-an-address', decimals: '18'},
    } as unknown as V4SubgraphPool;
    expect(isDynamicFeeV4Pool(CHAIN_ID, pool)).toBe(true);
  });
});

describe('isFeeTierProvenByPoolId', () => {
  it('pins the hookless fixture id to the PoolKey it claims to encode', () => {
    const a = new Token(CHAIN_ID, TOKEN_A, 18);
    const b = new Token(CHAIN_ID, TOKEN_B, 18);
    expect(Pool.getPoolId(a, b, 3000, 60, HOOKLESS)).toBe(
      HOOKLESS_3000_POOL_ID
    );
  });

  it('proves a pool whose id re-derives from its own feeTier', () => {
    expect(
      isFeeTierProvenByPoolId(CHAIN_ID, hookedPool(STATIC_POOL_ID, '3000'))
    ).toBe(true);
  });

  it('proves a hookless pool too — the id is the whole evidence', () => {
    const pool = {
      ...hookedPool(HOOKLESS_3000_POOL_ID, '3000'),
      hooks: HOOKLESS,
    } as V4SubgraphPool;
    expect(isFeeTierProvenByPoolId(CHAIN_ID, pool)).toBe(true);
  });

  it('proves nothing when the feeTier is the drifted total', () => {
    expect(
      isFeeTierProvenByPoolId(CHAIN_ID, hookedPool(STATIC_POOL_ID, '3499'))
    ).toBe(false);
  });

  // Every failure mode must fall through to StateView — the pre-filter may
  // only ever license a skip.
  it.each([
    {
      label: 'a non-numeric feeTier',
      pool: () => hookedPool(STATIC_POOL_ID, 'not-a-number'),
    },
    {
      label: 'a fractional feeTier',
      pool: () => hookedPool(STATIC_POOL_ID, '3000.5'),
    },
    {
      label: 'a feeTier too wide for uint24',
      pool: () => hookedPool(STATIC_POOL_ID, '99999999'),
    },
    {
      label: 'a non-numeric tickSpacing',
      pool: () =>
        ({
          ...hookedPool(STATIC_POOL_ID, '3000'),
          tickSpacing: 'sixty',
        }) as V4SubgraphPool,
    },
    {
      label: 'a token address that will not construct',
      pool: () =>
        ({
          ...hookedPool(STATIC_POOL_ID, '3000'),
          token0: {id: 'not-an-address', decimals: '18'},
        }) as unknown as V4SubgraphPool,
    },
    {
      label: 'a hooks value that is not an address',
      pool: () =>
        ({
          ...hookedPool(STATIC_POOL_ID, '3000'),
          hooks: 'nope',
        }) as V4SubgraphPool,
    },
  ])('proves nothing for $label', ({pool}) => {
    expect(isFeeTierProvenByPoolId(CHAIN_ID, pool())).toBe(false);
  });
});

describe('resolveFeeTier', () => {
  it.each(MEASURED_POOLS)(
    'corrects the drifted total back to the pool-key fee for $label',
    ({protocolFee, lpFee, total}) => {
      expect(resolveFeeTier(String(total), fees(lpFee, protocolFee))).toEqual({
        outcome: 'corrected',
        feeTier: String(lpFee),
      });
    }
  );

  it.each(MEASURED_POOLS)(
    'is a no-op when the protocol fee is zero for $label',
    ({lpFee}) => {
      expect(resolveFeeTier(String(lpFee), fees(lpFee, 0))).toEqual({
        outcome: 'already_correct',
        feeTier: String(lpFee),
      });
    }
  );

  it('leaves the snapshot value alone when no on-chain read is available', () => {
    expect(resolveFeeTier('475', undefined)).toEqual({
      outcome: 'unknown',
      feeTier: '475',
    });
  });

  it('never corrects a dynamic-fee pool (ROUTE-607 is separate)', () => {
    // A shape the reader can actually produce: slot0 carries the hook's
    // current lpFee 3000 and a 500 protocol fee, so the subgraph's feeTier is
    // the 3499 total — the exact input that resolves to `corrected` for a
    // static pool. Only the PoolKey-derived flag distinguishes the two;
    // slot0's lpFee is bounded by MAX_LP_FEE and can never be the sentinel.
    expect(resolveFeeTier('3499', fees(3000, 500), true)).toEqual({
      outcome: 'dynamic',
      feeTier: '3499',
    });
    // Same read, static pool: proves the flag is what makes the difference.
    expect(resolveFeeTier('3499', fees(3000, 500), false)).toEqual({
      outcome: 'corrected',
      feeTier: '3000',
    });
  });

  it('reports a dynamic pool as dynamic even with no on-chain read', () => {
    expect(resolveFeeTier('3499', undefined, true)).toEqual({
      outcome: 'dynamic',
      feeTier: '3499',
    });
  });

  it('leaves a value the formula cannot explain alone', () => {
    // lpFee 3000 with protocolFee 500 explains 3499, not 4000.
    expect(resolveFeeTier('4000', fees(3000, 500))).toEqual({
      outcome: 'unexplained',
      feeTier: '4000',
    });
  });

  it('accepts a total explained by either swap direction', () => {
    // zeroForOne 0 (would explain 3000), oneForZero 500 (explains 3499).
    expect(resolveFeeTier('3499', fees(3000, 0, 500))).toEqual({
      outcome: 'corrected',
      feeTier: '3000',
    });
  });

  it('leaves a non-numeric feeTier alone', () => {
    expect(resolveFeeTier('not-a-number', fees(3000, 500))).toEqual({
      outcome: 'unexplained',
      feeTier: 'not-a-number',
    });
  });
});

describe('applyV4LpFeeCorrection', () => {
  beforeEach(() => resetV4LpFeeMemoForTesting());

  it('rewrites drifted pools and leaves correct ones untouched', async () => {
    const {reader} = makeFakeReader({
      '0xdrifted': fees(3000, 500),
      '0xcorrect': fees(500, 0),
    });
    const result = await applyV4LpFeeCorrection(
      CHAIN_ID,
      [pool('0xdrifted', '3499'), pool('0xcorrect', '500')],
      reader,
      noopLogger,
      noopMetric
    );
    expect(result.map(p => p.feeTier)).toEqual(['3000', '500']);
  });

  it('keeps the subgraph value for a pool the reader cannot answer for', async () => {
    const {reader} = makeFakeReader({});
    const result = await applyV4LpFeeCorrection(
      CHAIN_ID,
      [pool('0xunknown', '3499')],
      reader,
      noopLogger,
      noopMetric
    );
    expect(result[0].feeTier).toBe('3499');
  });

  it('keeps the whole snapshot when the read throws', async () => {
    const reader: V4PoolKeyFeeReader = {
      readPoolKeyFees: async () => {
        throw new Error('rpc down');
      },
    };
    const pools = [pool('0xdrifted', '3499')];
    const result = await applyV4LpFeeCorrection(
      CHAIN_ID,
      pools,
      reader,
      noopLogger,
      noopMetric
    );
    expect(result).toBe(pools);
    expect(result[0].feeTier).toBe('3499');
  });

  it('memoizes the pool-key fee so later runs make no read', async () => {
    const {reader, requested} = makeFakeReader({'0xdrifted': fees(3000, 500)});
    const first = await applyV4LpFeeCorrection(
      CHAIN_ID,
      [pool('0xdrifted', '3499')],
      reader,
      noopLogger,
      noopMetric
    );
    expect(first[0].feeTier).toBe('3000');

    // Second run: still drifted in the subgraph, still corrected, no re-read.
    const second = await applyV4LpFeeCorrection(
      CHAIN_ID,
      [pool('0xdrifted', '3499')],
      reader,
      noopLogger,
      noopMetric
    );
    expect(second[0].feeTier).toBe('3000');
    expect(requested).toEqual([['0xdrifted'], []]);
  });

  it('does not memoize an unexplained pool', async () => {
    const {reader, requested} = makeFakeReader({'0xodd': fees(3000, 500)});
    await applyV4LpFeeCorrection(
      CHAIN_ID,
      [pool('0xodd', '4000')],
      reader,
      noopLogger,
      noopMetric
    );
    await applyV4LpFeeCorrection(
      CHAIN_ID,
      [pool('0xodd', '4000')],
      reader,
      noopLogger,
      noopMetric
    );
    expect(requested).toEqual([['0xodd'], ['0xodd']]);
  });

  it('keys the memo by chain so the same pool id on two chains is read twice', async () => {
    const {reader, requested} = makeFakeReader({'0xsame': fees(3000, 500)});
    const pools = [pool('0xsame', '3499')];
    await applyV4LpFeeCorrection(1, pools, reader, noopLogger, noopMetric);
    await applyV4LpFeeCorrection(137, pools, reader, noopLogger, noopMetric);
    expect(requested).toEqual([['0xsame'], ['0xsame']]);
  });
});

describe('applyV4LpFeeCorrection pool-id pre-filter', () => {
  beforeEach(() => resetV4LpFeeMemoForTesting());

  const provablyCorrect = () => hookedPool(STATIC_POOL_ID, '3000');
  const mismatched = () => hookedPool(STATIC_POOL_ID, '3499');

  it('skips a provably-correct pool with zero reads', async () => {
    const {reader, requested} = makeFakeReader({});
    const {metric, total} = makeRecordingMetric();
    const result = await applyV4LpFeeCorrection(
      CHAIN_ID,
      [provablyCorrect()],
      reader,
      noopLogger,
      metric
    );
    expect(result[0].feeTier).toBe('3000');
    expect(requested).toEqual([[]]);
    expect(total('prefiltered')).toBe(1);
    expect(total('read')).toBe(0);
    // Its own outcome, not folded into alreadyCorrect.
    expect(total('alreadyCorrect')).toBe(0);
  });

  it('sends a mismatched pool to StateView and corrects it', async () => {
    const {reader, requested} = makeFakeReader({
      [STATIC_POOL_ID]: fees(3000, 500),
    });
    const {metric, total} = makeRecordingMetric();
    const result = await applyV4LpFeeCorrection(
      CHAIN_ID,
      [mismatched()],
      reader,
      noopLogger,
      metric
    );
    expect(result[0].feeTier).toBe('3000');
    expect(requested).toEqual([[STATIC_POOL_ID]]);
    expect(total('prefiltered')).toBe(0);
    expect(total('corrected')).toBe(1);
  });

  it('reads only the mismatched pool out of a mixed snapshot', async () => {
    const {reader, requested} = makeFakeReader({
      '0xdrifted': fees(3000, 500),
    });
    const result = await applyV4LpFeeCorrection(
      CHAIN_ID,
      [provablyCorrect(), pool('0xdrifted', '3499')],
      reader,
      noopLogger,
      noopMetric
    );
    expect(result.map(p => p.feeTier)).toEqual(['3000', '3000']);
    expect(requested).toEqual([['0xdrifted']]);
  });

  // The dynamic check is settled before the pre-filter, and neither may put a
  // dynamic pool on the wire: its slot0 lpFee is a momentary hook value.
  it('still bypasses a dynamic-fee pool entirely', async () => {
    const {reader, requested} = makeFakeReader({
      [DYNAMIC_POOL_ID]: fees(3000, 500),
    });
    const {metric, total} = makeRecordingMetric();
    const result = await applyV4LpFeeCorrection(
      CHAIN_ID,
      [hookedPool(DYNAMIC_POOL_ID, '3499')],
      reader,
      noopLogger,
      metric
    );
    expect(result[0].feeTier).toBe('3499');
    expect(requested).toEqual([[]]);
    expect(total('dynamic')).toBe(1);
    expect(total('prefiltered')).toBe(0);
  });

  // A pool proved correct offline must NOT enter the memo — see the
  // pre-filter's call site in applyV4LpFeeCorrection.
  it('does not memoize the proof, so a later drift still hits StateView', async () => {
    const {reader, requested} = makeFakeReader({
      [STATIC_POOL_ID]: fees(3000, 500),
    });
    const first = await applyV4LpFeeCorrection(
      CHAIN_ID,
      [provablyCorrect()],
      reader,
      noopLogger,
      noopMetric
    );
    expect(first[0].feeTier).toBe('3000');

    // Same pool, protocol fee now live so the subgraph reports the total.
    const second = await applyV4LpFeeCorrection(
      CHAIN_ID,
      [mismatched()],
      reader,
      noopLogger,
      noopMetric
    );
    expect(second[0].feeTier).toBe('3000');
    expect(requested).toEqual([[], [STATIC_POOL_ID]]);
  });
});

describe('applyV4LpFeeCorrection read cap', () => {
  const CAP_KEY = 'POOL_CACHING_V4_LP_FEE_CORRECTION_MAX_READS_PER_TICK';
  beforeEach(() => {
    resetV4LpFeeMemoForTesting();
    delete process.env[CAP_KEY];
  });
  afterEach(() => {
    delete process.env[CAP_KEY];
  });

  const drifted = (n: number) =>
    Array.from({length: n}, (_, i) => pool(`0xdrifted${i}`, '3499'));
  /** Drifted pools in snapshot order, each with an explicit tvlUSD. */
  const driftedWithTvl = (tvls: number[]) =>
    tvls.map((tvlUSD, i) => ({
      ...pool(`0xdrifted${i}`, '3499'),
      tvlUSD,
    })) as V4SubgraphPool[];
  const allFees = (n: number) =>
    Object.fromEntries(
      Array.from({length: n}, (_, i) => [`0xdrifted${i}`, fees(3000, 500)])
    );

  // Ordering matters only when the cap binds, and it is the whole point of
  // sorting: the reads we can afford should go to the pools whose fee is
  // worth the most to get right, not to whichever pools the subgraph
  // happened to return first.
  it('truncates the read list and marks the remainder deferred', async () => {
    process.env[CAP_KEY] = '2';
    const {reader, requested} = makeFakeReader(allFees(5));
    const {metric, total} = makeRecordingMetric();
    // Ascending TVL, so snapshot order is the exact REVERSE of read priority
    // — a pass here cannot be explained by iteration order.
    const result = await applyV4LpFeeCorrection(
      CHAIN_ID,
      driftedWithTvl([1, 2, 3, 4, 5]),
      reader,
      noopLogger,
      metric
    );
    expect(requested).toEqual([['0xdrifted4', '0xdrifted3']]);
    // Returned in snapshot order; only the two highest-TVL pools corrected.
    expect(result.map(p => p.feeTier)).toEqual([
      '3499',
      '3499',
      '3499',
      '3000',
      '3000',
    ]);
    expect(total('read')).toBe(2);
    expect(total('corrected')).toBe(2);
    expect(total('deferred')).toBe(3);
    expect(total('unknown')).toBe(0);
  });

  it('breaks a TVL tie on pool id, so the boundary is stable across ticks', async () => {
    process.env[CAP_KEY] = '2';
    const {reader, requested} = makeFakeReader(allFees(4));
    // Equal TVL, shuffled relative to id order.
    const pools = [
      {...pool('0xdrifted2', '3499'), tvlUSD: 7},
      {...pool('0xdrifted0', '3499'), tvlUSD: 7},
      {...pool('0xdrifted3', '3499'), tvlUSD: 7},
      {...pool('0xdrifted1', '3499'), tvlUSD: 7},
    ] as V4SubgraphPool[];
    await applyV4LpFeeCorrection(
      CHAIN_ID,
      pools,
      reader,
      noopLogger,
      noopMetric
    );
    expect(requested).toEqual([['0xdrifted0', '0xdrifted1']]);
  });

  it('sorts a non-finite tvlUSD last instead of scrambling the order', async () => {
    process.env[CAP_KEY] = '2';
    const {reader, requested} = makeFakeReader(allFees(3));
    const pools = [
      {...pool('0xdrifted0', '3499'), tvlUSD: Number.NaN},
      {...pool('0xdrifted1', '3499'), tvlUSD: 5},
      {...pool('0xdrifted2', '3499'), tvlUSD: 9},
    ] as V4SubgraphPool[];
    await applyV4LpFeeCorrection(
      CHAIN_ID,
      pools,
      reader,
      noopLogger,
      noopMetric
    );
    expect(requested).toEqual([['0xdrifted2', '0xdrifted1']]);
  });

  it('retries a deferred pool on the next tick', async () => {
    process.env[CAP_KEY] = '1';
    const {reader, requested} = makeFakeReader(allFees(2));
    const pools = drifted(2);
    await applyV4LpFeeCorrection(
      CHAIN_ID,
      pools,
      reader,
      noopLogger,
      noopMetric
    );
    // Tick 1 memoized 0xdrifted0, so tick 2's single read slot goes to the
    // pool that was deferred.
    const second = await applyV4LpFeeCorrection(
      CHAIN_ID,
      pools,
      reader,
      noopLogger,
      noopMetric
    );
    expect(requested).toEqual([['0xdrifted0'], ['0xdrifted1']]);
    expect(second.map(p => p.feeTier)).toEqual(['3000', '3000']);
  });

  it('treats 0 as defer-all rather than falling back to the default', async () => {
    process.env[CAP_KEY] = '0';
    const {reader, requested} = makeFakeReader(allFees(3));
    const {metric, total} = makeRecordingMetric();
    const result = await applyV4LpFeeCorrection(
      CHAIN_ID,
      drifted(3),
      reader,
      noopLogger,
      metric
    );
    expect(requested).toEqual([[]]);
    expect(result.map(p => p.feeTier)).toEqual(['3499', '3499', '3499']);
    expect(total('deferred')).toBe(3);
    expect(total('misconfigured')).toBe(0);
  });

  it.each(['abc', '-1', '2.5', '1e3', '0x10', '2 000', '1000001'])(
    'falls back to the default and reports misconfigured for %j',
    async raw => {
      process.env[CAP_KEY] = raw;
      const {reader, requested} = makeFakeReader(allFees(3));
      const {metric, total, tagsFor} = makeRecordingMetric();
      await applyV4LpFeeCorrection(
        CHAIN_ID,
        drifted(3),
        reader,
        noopLogger,
        metric
      );
      // Default cap does not bind on three pools, so all three are still read.
      expect(requested).toEqual([['0xdrifted0', '0xdrifted1', '0xdrifted2']]);
      expect(total('deferred')).toBe(0);
      expect(total('misconfigured')).toBe(1);
      expect(tagsFor('misconfigured')).toEqual([
        {chainId: String(CHAIN_ID), reason: 'invalid_max_reads_per_tick'},
      ]);
    }
  );

  it('emits no misconfigured counter when the cap is usable or unset', async () => {
    for (const raw of [undefined, '', '  ', '0', '25000', '1000000']) {
      resetV4LpFeeMemoForTesting();
      if (raw === undefined) delete process.env[CAP_KEY];
      else process.env[CAP_KEY] = raw;
      const {reader} = makeFakeReader(allFees(1));
      const {metric, total} = makeRecordingMetric();
      await applyV4LpFeeCorrection(
        CHAIN_ID,
        drifted(1),
        reader,
        noopLogger,
        metric
      );
      expect(total('misconfigured'), `raw=${String(raw)}`).toBe(0);
    }
  });
});

// The per-job override exists so the 2-minute Robinhood job can run a
// tighter tranche than the all-chain job without either one needing its own
// environment variable.
describe('applyV4LpFeeCorrection per-job read cap override', () => {
  const CAP_KEY = 'POOL_CACHING_V4_LP_FEE_CORRECTION_MAX_READS_PER_TICK';
  beforeEach(() => {
    resetV4LpFeeMemoForTesting();
    delete process.env[CAP_KEY];
  });
  afterEach(() => {
    delete process.env[CAP_KEY];
  });

  const drifted = (n: number) =>
    Array.from({length: n}, (_, i) => pool(`0xdrifted${i}`, '3499'));
  const allFees = (n: number) =>
    Object.fromEntries(
      Array.from({length: n}, (_, i) => [`0xdrifted${i}`, fees(3000, 500)])
    );

  it('overrides a larger env cap for this pass only', async () => {
    process.env[CAP_KEY] = '10';
    const {reader, requested} = makeFakeReader(allFees(4));
    const {metric, total} = makeRecordingMetric();
    await applyV4LpFeeCorrection(
      CHAIN_ID,
      drifted(4),
      reader,
      noopLogger,
      metric,
      2
    );
    expect(requested).toEqual([['0xdrifted0', '0xdrifted1']]);
    expect(total('read')).toBe(2);
    expect(total('deferred')).toBe(2);
  });

  // The `??` in applyV4LpFeeCorrection, pinned. With `||` this override
  // would silently become the 25,000 env default — the exact opposite of the
  // load-shed the operator asked for.
  it('honors an explicit override of 0 rather than falling back to the env cap', async () => {
    const {reader, requested} = makeFakeReader(allFees(3));
    const {metric, total} = makeRecordingMetric();
    const result = await applyV4LpFeeCorrection(
      CHAIN_ID,
      drifted(3),
      reader,
      noopLogger,
      metric,
      0
    );
    expect(requested).toEqual([[]]);
    expect(total('read')).toBe(0);
    expect(total('corrected')).toBe(0);
    expect(total('deferred')).toBe(3);
    expect(result.map(p => p.feeTier)).toEqual(['3499', '3499', '3499']);
  });

  it('falls back to the env cap when no override is passed', async () => {
    process.env[CAP_KEY] = '1';
    const {reader, requested} = makeFakeReader(allFees(3));
    await applyV4LpFeeCorrection(
      CHAIN_ID,
      drifted(3),
      reader,
      noopLogger,
      noopMetric,
      undefined
    );
    expect(requested).toEqual([['0xdrifted0']]);
  });
});

// Starvation guard. TVL ordering makes the front of the read queue stable,
// so without this a block of high-TVL pools StateView cannot answer for
// would re-occupy the whole tranche every tick, forever.
describe('applyV4LpFeeCorrection unknown-read cooldown', () => {
  const CAP_KEY = 'POOL_CACHING_V4_LP_FEE_CORRECTION_MAX_READS_PER_TICK';
  beforeEach(() => {
    resetV4LpFeeMemoForTesting();
    delete process.env[CAP_KEY];
  });
  afterEach(() => {
    delete process.env[CAP_KEY];
  });

  /** High-TVL pool StateView never answers for, plus a low-TVL answerable one. */
  const unreadable = {
    ...pool('0xunreadable', '3499'),
    tvlUSD: 1_000_000,
  } as V4SubgraphPool;
  const answerable = {
    ...pool('0xanswerable', '3499'),
    tvlUSD: 1,
  } as V4SubgraphPool;

  it('does not re-read a pool whose read produced no answer', async () => {
    const {reader, requested} = makeFakeReader({});
    const pools = [unreadable];
    const {metric, total} = makeRecordingMetric();
    await applyV4LpFeeCorrection(CHAIN_ID, pools, reader, noopLogger, metric);
    await applyV4LpFeeCorrection(CHAIN_ID, pools, reader, noopLogger, metric);
    // Read once on the first tick, skipped on the second.
    expect(requested).toEqual([['0xunreadable'], []]);
    // Still reported unknown both times: the cooldown suppresses the READ,
    // it never invents an outcome or rewrites a fee.
    expect(total('unknown')).toBe(2);
    expect(total('read')).toBe(1);
  });

  it('frees the tranche for lower-TVL pools instead of starving them', async () => {
    process.env[CAP_KEY] = '1';
    const {reader, requested} = makeFakeReader({
      '0xanswerable': fees(3000, 500),
    });
    const pools = [unreadable, answerable];

    // Tick 1: the cap binds and the highest-TVL pool takes the only slot.
    const first = await applyV4LpFeeCorrection(
      CHAIN_ID,
      pools,
      reader,
      noopLogger,
      noopMetric
    );
    expect(requested[0]).toEqual(['0xunreadable']);
    expect(first.map(p => p.feeTier)).toEqual(['3499', '3499']);

    // Tick 2: the unreadable pool is in cooldown, so the slot goes to the
    // pool behind it — which without the cooldown would never be read.
    const second = await applyV4LpFeeCorrection(
      CHAIN_ID,
      pools,
      reader,
      noopLogger,
      noopMetric
    );
    expect(requested[1]).toEqual(['0xanswerable']);
    expect(second.map(p => p.feeTier)).toEqual(['3499', '3000']);
  });

  it('does not cool down a pool that was merely deferred', async () => {
    process.env[CAP_KEY] = '1';
    const {reader, requested} = makeFakeReader({});
    // Both unanswerable; the low-TVL one is deferred on tick 1, never read.
    const pools = [
      unreadable,
      {...pool('0xdeferred', '3499'), tvlUSD: 2} as V4SubgraphPool,
    ];
    await applyV4LpFeeCorrection(
      CHAIN_ID,
      pools,
      reader,
      noopLogger,
      noopMetric
    );
    await applyV4LpFeeCorrection(
      CHAIN_ID,
      pools,
      reader,
      noopLogger,
      noopMetric
    );
    // Tick 2 reads the deferred pool: being skipped by the cap is not
    // evidence that a read would fail, so it must not arm the cooldown.
    expect(requested).toEqual([['0xunreadable'], ['0xdeferred']]);
  });

  it('still corrects a pool once StateView starts answering after the cooldown lapses', async () => {
    // The cooldown is time-bounded, not permanent: clearing the caches
    // stands in for its expiry, and the pool is read and corrected again.
    const answers: Record<string, V4PoolKeyFees> = {};
    const {reader, requested} = makeFakeReader(answers);
    const pools = [unreadable];
    await applyV4LpFeeCorrection(
      CHAIN_ID,
      pools,
      reader,
      noopLogger,
      noopMetric
    );
    expect(requested).toEqual([['0xunreadable']]);

    answers['0xunreadable'] = fees(3000, 500);
    resetV4LpFeeMemoForTesting();
    const after = await applyV4LpFeeCorrection(
      CHAIN_ID,
      pools,
      reader,
      noopLogger,
      noopMetric
    );
    expect(requested[1]).toEqual(['0xunreadable']);
    expect(after.map(p => p.feeTier)).toEqual(['3000']);
  });
});

describe('v4LpFeeCorrectionReadCapFromEnv', () => {
  const CAP_KEY = 'POOL_CACHING_V4_LP_FEE_CORRECTION_MAX_READS_PER_TICK';
  beforeEach(() => {
    delete process.env[CAP_KEY];
  });
  afterEach(() => {
    delete process.env[CAP_KEY];
  });

  it('defaults to 25000 when unset', () => {
    expect(V4_LP_FEE_CORRECTION_DEFAULT_MAX_READS_PER_TICK).toBe(25_000);
    expect(v4LpFeeCorrectionReadCapFromEnv()).toEqual({
      maxReads: 25_000,
      misconfigured: false,
    });
  });

  it.each(['', '   '])('treats %j as unset, not malformed', raw => {
    process.env[CAP_KEY] = raw;
    expect(v4LpFeeCorrectionReadCapFromEnv()).toEqual({
      maxReads: 25_000,
      misconfigured: false,
    });
  });

  it('accepts an explicit 0 as load-shed', () => {
    process.env[CAP_KEY] = '0';
    expect(v4LpFeeCorrectionReadCapFromEnv()).toEqual({
      maxReads: 0,
      misconfigured: false,
    });
  });

  it.each([
    ['1', 1],
    ['500', 500],
    [' 5000 ', 5000],
    ['1000000', 1_000_000],
  ])('parses %j as %i', (raw, maxReads) => {
    process.env[CAP_KEY] = raw as string;
    expect(v4LpFeeCorrectionReadCapFromEnv()).toEqual({
      maxReads,
      misconfigured: false,
    });
  });

  it.each(['abc', '-1', '2.5', '1e3', '0x10', '2 000', 'Infinity'])(
    'rejects malformed %j',
    raw => {
      process.env[CAP_KEY] = raw;
      expect(v4LpFeeCorrectionReadCapFromEnv()).toEqual({
        maxReads: 25_000,
        misconfigured: true,
      });
    }
  );

  it.each(['1000001', '250000000', '9'.repeat(40)])(
    'rejects oversized %j',
    raw => {
      process.env[CAP_KEY] = raw;
      expect(v4LpFeeCorrectionReadCapFromEnv()).toEqual({
        maxReads: 25_000,
        misconfigured: true,
      });
    }
  );

  /**
   * What reaches production is whatever the infra env wiring (staticEnv.ts,
   * shared by index.ts and preview.ts) puts in the env var, so the resolved
   * value is pinned here too — `||` there would be the wrong operator for a
   * key whose zero is meaningful.
   */
  describe('resolved read cap, infra layer included', () => {
    const serviceRoot = new URL('../../../../', import.meta.url);
    const infraFallback = readFileSync(
      new URL('infra/staticEnv.ts', serviceRoot),
      'utf8'
    ).match(
      /envConfig\.get\('poolCachingV4LpFeeCorrectionMaxReadsPerTick'\)\s*(\?\?|\|\|)\s*'([^']*)'/
    );

    it('resolves to the in-code default for a stack that configures nothing', () => {
      expect(
        infraFallback,
        'infra fallback not found — did the wiring change?'
      ).not.toBeNull();
      process.env[CAP_KEY] = infraFallback![2];
      expect(v4LpFeeCorrectionReadCapFromEnv()).toEqual({
        maxReads: 25_000,
        misconfigured: false,
      });
    });

    it('uses `??` for the infra fallback, not `||`', () => {
      expect(infraFallback![1]).toBe('??');
    });
  });
});

describe('V4_STATE_VIEW_BY_CHAIN', () => {
  // Each address must be the chain's own v4StateViewLibraryAddress, read from
  // the hardcoded chain configs rather than from memory.
  const EXPECTED: Array<[string, number, string]> = [
    ['Mainnet', 1, '0x7ffe42c4a5deea5b0fec41c94c136cf115597227'],
    ['Optimism', 10, '0xc18a3169788f4f75a170290584eca6395c75ecdb'],
    ['BNB', 56, '0xd13dd3d6e93f276fafc9db9e6bb47c1180aee0c4'],
    ['Polygon', 137, '0x5ea1bd7974c8a611cbab0bdcafcb1d9cc9b3ba5a'],
    ['Robinhood', 4663, '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b'],
    ['Base', 8453, '0xa3c0c9b65bad0b08107aa264b0f3db444b867a71'],
    ['Arbitrum', 42161, '0x76fd297e2d437cd7f76d50f01afe6160f86e9990'],
  ];

  it.each(EXPECTED)(
    'resolves %s (%i) to its StateView',
    (_name, chainId, address) => {
      expect(V4_STATE_VIEW_BY_CHAIN[chainId]).toBe(address);
    }
  );

  it('has no other entries, so `*` cannot widen past this list', () => {
    expect(
      Object.keys(V4_STATE_VIEW_BY_CHAIN)
        .map(Number)
        .sort((a, b) => a - b)
    ).toEqual(EXPECTED.map(([, chainId]) => chainId).sort((a, b) => a - b));
  });

  it('gives every chain a distinct address', () => {
    const addresses = Object.values(V4_STATE_VIEW_BY_CHAIN);
    expect(new Set(addresses).size).toBe(addresses.length);
  });
});

describe('v4LpFeeCorrectionChainsFromEnv', () => {
  const KEY = 'POOL_CACHING_V4_LP_FEE_CORRECTION_CHAINS';
  beforeEach(() => {
    delete process.env[KEY];
  });

  // This path rewrites a fee value on ~20k live mainnet pools. Opting in is
  // explicit; nothing here may turn it on by omission. Unset, empty and
  // whitespace all resolve to the empty set. Pinned per-value rather than by
  // `.size` so a future refactor cannot quietly widen it.
  it('is OFF when the variable is unset', () => {
    expect(process.env[KEY]).toBeUndefined();
    expect([...v4LpFeeCorrectionChainsFromEnv()]).toEqual([]);
  });

  it.each(['', '   '])('is OFF for %j', raw => {
    process.env[KEY] = raw;
    expect([...v4LpFeeCorrectionChainsFromEnv()]).toEqual([]);
  });

  it('parses an explicit chain list', () => {
    process.env[KEY] = '1, 137';
    expect([...v4LpFeeCorrectionChainsFromEnv()].sort()).toEqual([1, 137]);
  });

  it('drops chains with no known StateView', () => {
    // 43114 (Avalanche) has a StateView on chain but no entry in the map.
    process.env[KEY] = '1,43114';
    expect([...v4LpFeeCorrectionChainsFromEnv()]).toEqual([1]);
  });

  // `*` stays the explicit opt-in to everything the code supports: it is how
  // an operator turns the correction on without enumerating chain ids, and it
  // stays bounded by V4_STATE_VIEW_BY_CHAIN. Pinned as a literal list so
  // adding a StateView entry has to come here and be noticed.
  it('expands an explicit * to every supported chain', () => {
    process.env[KEY] = '*';
    expect([...v4LpFeeCorrectionChainsFromEnv()].sort((a, b) => a - b)).toEqual(
      [1, 10, 56, 137, 4663, 8453, 42161]
    );
  });

  /**
   * The parser is only half the default. What actually reaches production is
   * whatever the infra env wiring (staticEnv.ts) puts in the env var, so a parser test alone can
   * pass while the two layers together resolve to the opposite of what this
   * file claims. These pin the RESOLVED default across both layers.
   */
  describe('resolved default, infra layer included', () => {
    const serviceRoot = new URL('../../../../', import.meta.url);
    const read = (relPath: string) =>
      readFileSync(new URL(relPath, serviceRoot), 'utf8');
    const infraFallback = () =>
      read('infra/staticEnv.ts').match(
        /envConfig\.get\('poolCachingV4LpFeeCorrectionChains'\)\s*(\?\?|\|\|)\s*'([^']*)'/
      );

    it('resolves to no chains for a stack that configures nothing', () => {
      const fallback = infraFallback();
      expect(
        fallback,
        'infra fallback not found — did the wiring change?'
      ).not.toBeNull();
      // Feed infra's literal through the parser: the two layers together are
      // what decides whether ~20k mainnet pools get rewritten. A `?? '*'`
      // here once shipped this ON while every parser test above still passed.
      process.env[KEY] = fallback![2];
      expect([...v4LpFeeCorrectionChainsFromEnv()]).toEqual([]);
    });

    // Off-by-default makes `||` and `??` behaviourally identical (both hand
    // the parser a falsy value), so this pins the shape rather than an
    // outcome: `?? '<anything>'` is the one-token edit that turned the
    // correction on before, and it has to fail here rather than pass quietly.
    it('uses `||` for the infra fallback, not `??`', () => {
      expect(infraFallback()![1]).toBe('||');
    });

    /**
     * What each stack actually ships. The value in the YAML is the whole
     * blast radius of this feature, so it is pinned per-stack and fed through
     * the parser rather than eyeballed: `"1"` and `"*"` differ by one
     * character but by every non-mainnet chain in effect.
     */
    const stackValue = (stack: string): string | undefined =>
      read(`infra/Pulumi.${stack}.yaml`).match(
        /^\s*env:poolCachingV4LpFeeCorrectionChains:\s*"([^"]*)"\s*$/m
      )?.[1];

    // All stacks at "*" — prod widened after staging's multi-chain sweep was
    // observed clean per the CLAUDE.md gate. Pinning the exact values keeps
    // the blast radius an explicit decision: any edit — widening or
    // narrowing — fails here rather than riding along unnoticed.
    it.each(['dev', 'staging', 'prod'])(
      'resolves the %s stack to every StateView-supported chain',
      stack => {
        const configured = stackValue(stack);
        expect(
          configured,
          `${stack} stack no longer sets poolCachingV4LpFeeCorrectionChains`
        ).toBe('*');
        process.env[KEY] = configured;
        expect(
          [...v4LpFeeCorrectionChainsFromEnv()].sort((a, b) => a - b)
        ).toEqual(
          Object.keys(V4_STATE_VIEW_BY_CHAIN)
            .map(Number)
            .sort((a, b) => a - b)
        );
      }
    );

    // The read path is only reachable for a chain with a StateView address —
    // a stack could otherwise "enable" a chain that can never be corrected.
    it('has a StateView entry for every chain a stack enables', () => {
      for (const stack of ['dev', 'staging', 'prod']) {
        process.env[KEY] = stackValue(stack);
        for (const chainId of v4LpFeeCorrectionChainsFromEnv()) {
          expect(V4_STATE_VIEW_BY_CHAIN[chainId]).toBeDefined();
        }
      }
    });
  });
});

describe('makeStateViewPoolKeyFeeReader', () => {
  // Real JSON-RPC over loopback rather than a mocked ethers client: this
  // exercises the actual ABI decode and the per-pool catch, which are the
  // fail-soft guarantees the change relies on.
  const MAINNET_STATE_VIEW = V4_STATE_VIEW_BY_CHAIN[1];

  /** ABI-encodes getSlot0's 4 static return words. */
  const slot0Return = (
    sqrtPriceX96: bigint,
    tick: number,
    protocolFee: number,
    lpFee: number
  ): string => {
    const word = (v: bigint) => v.toString(16).padStart(64, '0');
    const signed = (v: number) => word(BigInt.asUintN(256, BigInt(v)));
    return (
      '0x' +
      word(sqrtPriceX96) +
      signed(tick) +
      word(BigInt(protocolFee)) +
      word(BigInt(lpFee))
    );
  };

  type Handler = (poolId: string) => {result?: string; error?: string} | 'hang';

  async function withRpc(
    handler: Handler,
    run: (endpoint: string, requests: string[]) => Promise<void>
  ): Promise<void> {
    const requests: string[] = [];
    const sockets = new Set<import('node:net').Socket>();
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', chunk => (raw += chunk));
      req.on('end', () => {
        const body = JSON.parse(raw);
        const calls = Array.isArray(body) ? body : [body];
        const responses = calls.map(call => {
          const data: string = call.params?.[0]?.data ?? '';
          // getSlot0(bytes32): 4-byte selector then the 32-byte pool id.
          const poolId = '0x' + data.slice(10);
          requests.push(poolId);
          const outcome = handler(poolId);
          // Accept the request and never answer, so the reader's own request
          // timeout is what ends the call.
          if (outcome === 'hang') return undefined;
          return outcome.error
            ? {
                jsonrpc: '2.0',
                id: call.id,
                error: {code: -32000, message: outcome.error},
              }
            : {jsonrpc: '2.0', id: call.id, result: outcome.result};
        });
        if (responses.some(r => r === undefined)) return;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(Array.isArray(body) ? responses : responses[0]));
      });
    });
    server.on('connection', socket => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const {port} = server.address() as AddressInfo;
    try {
      await run(`http://127.0.0.1:${port}`, requests);
    } finally {
      // A hung request leaves its socket open; close() alone would never
      // resolve and the test would hang on teardown instead of the assertion.
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }

  const POOL_A =
    '0xaaaa000000000000000000000000000000000000000000000000000000000001';
  const POOL_B =
    '0xbbbb000000000000000000000000000000000000000000000000000000000002';

  it('decodes lpFee and both protocol-fee directions from slot0', async () => {
    await withRpc(
      () => ({
        result: slot0Return(79228162514264337593543950336n, -306, 0x64064, 375),
      }),
      async endpoint => {
        const reader = makeStateViewPoolKeyFeeReader(endpoint);
        const fees = await reader.readPoolKeyFees(1, [POOL_A]);
        expect(fees.get(POOL_A)).toEqual({
          lpFeePips: 375,
          zeroForOnePips: 100,
          oneForZeroPips: 100,
        });
      }
    );
  });

  it('omits an uninitialized pool (slot0 reads back all zeros)', async () => {
    await withRpc(
      () => ({result: slot0Return(0n, 0, 0, 0)}),
      async endpoint => {
        const reader = makeStateViewPoolKeyFeeReader(endpoint);
        const fees = await reader.readPoolKeyFees(1, [POOL_A]);
        expect(fees.size).toBe(0);
      }
    );
  });

  it('omits a pool whose call reverts, without throwing', async () => {
    await withRpc(
      () => ({error: 'execution reverted'}),
      async endpoint => {
        const reader = makeStateViewPoolKeyFeeReader(endpoint);
        await expect(reader.readPoolKeyFees(1, [POOL_A])).resolves.toEqual(
          new Map()
        );
      }
    );
  });

  it('omits a pool whose result is malformed, without throwing', async () => {
    await withRpc(
      () => ({result: '0xdeadbeef'}),
      async endpoint => {
        const reader = makeStateViewPoolKeyFeeReader(endpoint);
        await expect(reader.readPoolKeyFees(1, [POOL_A])).resolves.toEqual(
          new Map()
        );
      }
    );
  });

  // Exercises the reader's configured 10s request timeout against a server
  // that accepts the request and never answers, so it necessarily outlasts
  // that timeout — hence the raised per-test budget.
  it('survives a hung RPC, without throwing', async () => {
    await withRpc(
      () => 'hang',
      async endpoint => {
        const reader = makeStateViewPoolKeyFeeReader(endpoint);
        await expect(reader.readPoolKeyFees(1, [POOL_A])).resolves.toEqual(
          new Map()
        );
      }
    );
  }, 30_000);

  it('keeps the readable pools when a sibling read fails', async () => {
    await withRpc(
      poolId =>
        poolId === POOL_A
          ? {error: 'execution reverted'}
          : {result: slot0Return(1n, 0, 0x1f41f4, 3000)},
      async endpoint => {
        const reader = makeStateViewPoolKeyFeeReader(endpoint);
        const fees = await reader.readPoolKeyFees(1, [POOL_A, POOL_B]);
        expect(fees.has(POOL_A)).toBe(false);
        expect(fees.get(POOL_B)).toEqual({
          lpFeePips: 3000,
          zeroForOnePips: 500,
          oneForZeroPips: 500,
        });
      }
    );
  });

  it('makes no request for an empty pool list or an unsupported chain', async () => {
    await withRpc(
      () => ({result: slot0Return(1n, 0, 0, 500)}),
      async (endpoint, requests) => {
        const reader = makeStateViewPoolKeyFeeReader(endpoint);
        expect((await reader.readPoolKeyFees(1, [])).size).toBe(0);
        // Avalanche has no StateView entry, so it can never be corrected.
        expect((await reader.readPoolKeyFees(43114, [POOL_A])).size).toBe(0);
        expect(requests).toEqual([]);
      }
    );
  });

  describe('driving applyV4LpFeeCorrection over the real read path', () => {
    beforeEach(() => resetV4LpFeeMemoForTesting());

    // slot0 exactly as it reads for a live dynamic-fee pool: the hook's
    // CURRENT lpFee (3000) plus a 500/500 protocol fee — never the sentinel,
    // which exceeds MAX_LP_FEE and lives in PoolKey.fee, not slot0. That read
    // explains the subgraph's 3499 perfectly, so it is precisely the input
    // that would drive a rewrite if the pool were not recognised as dynamic.
    const liveDynamicSlot0 = () => ({
      result: slot0Return(1n, 0, 0x1f41f4, 3000),
    });

    it('never reads, rewrites, or memoizes a dynamic-fee pool', async () => {
      await withRpc(liveDynamicSlot0, async (endpoint, requests) => {
        const reader = makeStateViewPoolKeyFeeReader(endpoint);
        const tick = () =>
          applyV4LpFeeCorrection(
            CHAIN_ID,
            [hookedPool(DYNAMIC_POOL_ID, '3499')],
            reader,
            noopLogger,
            noopMetric
          );

        expect((await tick())[0].feeTier).toBe('3499');
        // Nothing was memoized, so the next cron tick behaves identically
        // rather than replaying a latched, momentary hook fee.
        expect((await tick())[0].feeTier).toBe('3499');
        expect(requests).toEqual([]);
      });
    });

    it('still corrects the same PoolKey when its fee is static', async () => {
      await withRpc(liveDynamicSlot0, async (endpoint, requests) => {
        const reader = makeStateViewPoolKeyFeeReader(endpoint);
        const result = await applyV4LpFeeCorrection(
          CHAIN_ID,
          [hookedPool(STATIC_POOL_ID, '3499')],
          reader,
          noopLogger,
          noopMetric
        );
        expect(result[0].feeTier).toBe('3000');
        expect(requests).toEqual([STATIC_POOL_ID]);
      });
    });
  });

  it('targets the chain-specific StateView address, on every supported chain', async () => {
    const seen: Array<{url: string; to: string}> = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', c => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw);
        seen.push({url: req.url ?? '', to: body.params?.[0]?.to});
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: slot0Return(1n, 0, 0, 500),
          })
        );
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const {port} = server.address() as AddressInfo;
    try {
      const reader = makeStateViewPoolKeyFeeReader(`http://127.0.0.1:${port}`);
      await reader.readPoolKeyFees(1, [POOL_A]);
      expect(seen[0]?.to?.toLowerCase()).toBe(MAINNET_STATE_VIEW.toLowerCase());

      // Every chain in the map must resolve to its own StateView, over its own
      // `/rpc/<chainId>` UniRPC path.
      seen.length = 0;
      const chainIds = Object.keys(V4_STATE_VIEW_BY_CHAIN).map(Number);
      for (const chainId of chainIds) {
        await reader.readPoolKeyFees(chainId, [POOL_A]);
      }
      expect(seen.map(s => s.to.toLowerCase())).toEqual(
        chainIds.map(chainId => V4_STATE_VIEW_BY_CHAIN[chainId].toLowerCase())
      );
      expect(seen.map(s => s.url)).toEqual(
        chainIds.map(chainId => `/rpc/${chainId}`)
      );
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});

describe('correction interacting with v4HooksPoolsFiltering', () => {
  beforeEach(() => resetV4LpFeeMemoForTesting());

  const TOKEN0 = '0x0000000000000000000000000000000000000011';
  const TOKEN1 = '0x0000000000000000000000000000000000000022';
  // Low 14 bits encode hook permissions; 0x080 is BEFORE_SWAP with no
  // returns-delta bits, which routes a pool to the auto-allowlist queue
  // instead of the main one.
  const SWAP_HOOK = '0x0000000000000000000000000000000000000080';

  const filterPool = (
    id: string,
    feeTier: string,
    tickSpacing: string,
    tvlETH: number,
    hooks: string = HOOKLESS
  ): V4SubgraphPool =>
    ({
      id,
      feeTier,
      tickSpacing,
      hooks,
      liquidity: '1000000',
      token0: {id: TOKEN0, symbol: 'A', name: 'A', decimals: '18'},
      token1: {id: TOKEN1, symbol: 'B', name: 'B', decimals: '18'},
      tvlETH,
      tvlUSD: tvlETH * 1000,
    }) as unknown as V4SubgraphPool;

  const survivors = (pools: V4SubgraphPool[]) =>
    new Set(
      v4HooksPoolsFiltering(1, pools, noopLogger, noopMetric).map(p => p.id)
    );

  /**
   * Ten pools already sharing the true lpFee plus one drifted pool whose
   * corrected fee moves it into that same group, with the drifted pool the
   * lowest-TVL member — the arrangement that makes the merge cross the
   * top-10 cap.
   */
  const buildGroup = (hooks: string) => ({
    atTrueFee: Array.from({length: 10}, (_, i) =>
      filterPool(`0xpool${i}`, '3000', String(10 + i), 100 + i, hooks)
    ),
    drifted: filterPool('0xdrifted', '3499', '60', 1, hooks),
  });

  const correct = async (pools: V4SubgraphPool[]) => {
    const {reader} = makeFakeReader({'0xdrifted': fees(3000, 500)});
    return applyV4LpFeeCorrection(1, pools, reader, noopLogger, noopMetric);
  };

  it('before correction the drifted pool sits in its own group', () => {
    const {atTrueFee, drifted} = buildGroup(HOOKLESS);
    // Grouping is token0+token1+feeTier, so '3499' is its own key.
    expect(survivors([...atTrueFee, drifted]).has('0xdrifted')).toBe(true);
  });

  it('merging does not evict a hookless pool, because ADDRESS_ZERO is allowlisted', async () => {
    const {atTrueFee, drifted} = buildGroup(HOOKLESS);
    const corrected = await correct([...atTrueFee, drifted]);
    expect(corrected.find(p => p.id === '0xdrifted')?.feeTier).toBe('3000');

    // All 11 now share one group, so the top-10 cap does drop the weakest
    // from the TVL queue — but ADDRESS_ZERO is in HOOKS_ADDRESSES_ALLOWLIST
    // for this chain, and the explicit-allowlist append at the end re-admits
    // any allowlisted-hook pool the queues did not select. Net: correcting a
    // hookless pool's fee cannot cost it its place in the snapshot.
    expect(survivors(corrected).size).toBe(11);
  });

  it('merging can evict an auto-allowlisted hooked pool, which is not re-admitted', async () => {
    const {atTrueFee, drifted} = buildGroup(SWAP_HOOK);
    const corrected = await correct([...atTrueFee, drifted]);
    expect(corrected.find(p => p.id === '0xdrifted')?.feeTier).toBe('3000');

    // A hook that is only AUTO-allowlisted gets no explicit-allowlist append,
    // so here the cap really does bind: this is the one snapshot-membership
    // regression the correction can cause.
    const kept = survivors(corrected);
    expect(kept.size).toBe(10);
    expect(kept.has('0xdrifted')).toBe(false);
  });

  it('eviction is by TVL, not by whether the pool was corrected', async () => {
    const {atTrueFee} = buildGroup(SWAP_HOOK);
    const richDrifted = filterPool('0xdrifted', '3499', '60', 9999, SWAP_HOOK);
    const kept = survivors(await correct([...atTrueFee, richDrifted]));
    expect(kept.size).toBe(10);
    expect(kept.has('0xdrifted')).toBe(true);
    expect(kept.has('0xpool0')).toBe(false);
  });

  it('a merge that stays under the cap keeps every pool', async () => {
    const corrected = await correct([
      filterPool('0xpool0', '3000', '60', 100, SWAP_HOOK),
      filterPool('0xdrifted', '3499', '10', 1, SWAP_HOOK),
    ]);
    expect(survivors(corrected)).toEqual(new Set(['0xpool0', '0xdrifted']));
  });
});
