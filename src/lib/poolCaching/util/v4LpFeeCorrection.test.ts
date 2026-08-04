import {describe, it, expect, beforeEach} from 'vitest';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import type {AddressInfo} from 'node:net';
import {DYNAMIC_FEE_FLAG, Pool} from '@uniswap/v4-sdk';
import {Token} from '@uniswap/sdk-core';

import {
  applyV4LpFeeCorrection,
  calculateSwapFee,
  isDynamicFeeV4Pool,
  makeStateViewPoolKeyFeeReader,
  resetV4LpFeeMemoForTesting,
  resolveFeeTier,
  unpackProtocolFee,
  v4LpFeeCorrectionChainsFromEnv,
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
const DYNAMIC_POOL_ID =
  '0xa3b5e5acf951d312f5218c26863b9075ed42d372cb1750e9f6e7e5af02511326';
const STATIC_POOL_ID =
  '0x892b927419a579af0b683b77a234bc3f6db044e13d2ecdca04cd7d716f335641';
const HOOKLESS_DYNAMIC_POOL_ID =
  '0x16d581ae92e055249ceab19a6b6e75c367dfd528033ca9d33409551b6f057e5c';

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
    process.env[KEY] = '1,8453';
    expect([...v4LpFeeCorrectionChainsFromEnv()]).toEqual([1]);
  });

  // `*` stays the explicit opt-in to everything the code supports: it is how
  // an operator turns the correction on without enumerating chain ids, and it
  // stays bounded by V4_STATE_VIEW_BY_CHAIN.
  it('expands an explicit * to every supported chain', () => {
    process.env[KEY] = '*';
    expect([...v4LpFeeCorrectionChainsFromEnv()].sort()).toEqual([1, 137]);
  });

  /**
   * The parser is only half the default. What actually reaches production is
   * whatever infra/index.ts puts in the env var, so a parser test alone can
   * pass while the two layers together resolve to the opposite of what this
   * file claims. These pin the RESOLVED default across both layers.
   */
  describe('resolved default, infra layer included', () => {
    const serviceRoot = new URL('../../../../', import.meta.url);
    const read = (relPath: string) =>
      readFileSync(new URL(relPath, serviceRoot), 'utf8');
    const infraFallback = () =>
      read('infra/index.ts').match(
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

    it.each(['dev', 'staging', 'prod'])(
      'leaves the correction unset in the %s stack, so the default is what ships',
      stack => {
        expect(read(`infra/Pulumi.${stack}.yaml`)).not.toContain(
          'poolCachingV4LpFeeCorrectionChains'
        );
      }
    );
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
        // Base has no StateView entry, so it can never be corrected.
        expect((await reader.readPoolKeyFees(8453, [POOL_A])).size).toBe(0);
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

  it('targets the chain-specific StateView address', async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', c => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw);
        seen.push(body.params?.[0]?.to);
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
      expect(seen[0]?.toLowerCase()).toBe(MAINNET_STATE_VIEW.toLowerCase());
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});

describe('correction interacting with v4HooksPoolsFiltering', () => {
  beforeEach(() => resetV4LpFeeMemoForTesting());

  const TOKEN0 = '0x0000000000000000000000000000000000000011';
  const TOKEN1 = '0x0000000000000000000000000000000000000022';
  const HOOKLESS = '0x0000000000000000000000000000000000000000';
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
