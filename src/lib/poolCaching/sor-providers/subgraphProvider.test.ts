import {describe, it, expect, vi} from 'vitest';
import {parse} from 'graphql';
import {ChainId} from '@uniswap/sdk-core';
import {V4SubgraphProvider} from './v4/subgraphProvider';
import {computeIdShards} from './subgraphProvider';
import type {Logger} from './util/log';
import {IMetric} from './util/metric';

const mockLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
};

class MockMetric extends IMetric {
  setProperty(_key: string, _value: unknown): void {}
  putDimensions(_dimensions: Record<string, string>): void {}
  putMetric(
    _key: string,
    _value: number,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _unit?: any,
    _tags?: Record<string, string>
  ): void {}
}

/**
 * Records every GraphQL query string passed to request(), and (by default)
 * always returns an empty page so pagination terminates immediately. Lets us
 * assert which queries the provider builds without hitting a real subgraph.
 * Pass `respond` to script non-empty pages for specific (query, variables).
 */
function makeRecordingProvider(
  chainId: ChainId,
  respond?: (
    query: string,
    variables: Record<string, unknown>
  ) => {pools: unknown[]}
): {
  provider: V4SubgraphProvider;
  queries: string[];
  calls: {query: string; variables: Record<string, unknown>}[];
} {
  const queries: string[] = [];
  const calls: {query: string; variables: Record<string, unknown>}[] = [];
  const provider = new V4SubgraphProvider(
    chainId,
    0, // retries
    5000, // timeout
    true,
    0.01,
    Number.MAX_VALUE,
    'https://example.invalid/subgraph', // url override so constructor doesn't throw
    undefined,
    mockLogger,
    new MockMetric()
  );
  // The GraphQLClient is created internally; swap it for a recorder.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (provider as any).client = {
    request: async (query: string, variables: Record<string, unknown>) => {
      queries.push(query);
      calls.push({query, variables: variables ?? {}});
      return respond ? respond(query, variables ?? {}) : {pools: []};
    },
  };
  return {provider, queries, calls};
}

describe('SubgraphProvider V4 permissioned-hook query', () => {
  it('bounds permissioned-hook queries to known pairs (adapter side + known counter-token, no TVL floor) for Sepolia', async () => {
    const {provider, calls} = makeRecordingProvider(ChainId.SEPOLIA);
    await provider.getPools();

    const permissionedCalls = calls.filter(c =>
      c.query.includes('getV4PermissionedHookPools')
    );
    // Two split queries (GraphQL `where` is AND-only): one per adapter side.
    expect(permissionedCalls.length).toBe(2);
    for (const {query: q} of permissionedCalls) {
      expect(q).toContain('hooks_in: $permissionedHooks');
      // Both sides are bounded: one to the adapters, the other to known tokens.
      // A PA1/arbitrary-token pool matches NEITHER side, so junk is never paged.
      expect(q).toContain('$permissionedAdapters');
      expect(q).toContain('$knownTokens');
      expect(q).toContain('token0_in:');
      expect(q).toContain('token1_in:');
      // PoolKey is fully bounded: fee/tickSpacing constrained to canonical V4.
      expect(q).toContain('feeTier_in:');
      expect(q).toContain('tickSpacing_in:');
      // Admitted by hook, not TVL — the floor must be omitted.
      expect(q).not.toContain('totalValueLockedETH_gt');
    }
    // One query binds the adapter to token0, the other to token1.
    expect(
      permissionedCalls.some(c =>
        c.query.includes('token0_in: $permissionedAdapters')
      )
    ).toBe(true);
    expect(
      permissionedCalls.some(c =>
        c.query.includes('token1_in: $permissionedAdapters')
      )
    ).toBe(true);

    // Regression (bounded fetch): the knownTokens variable contains the adapters
    // and WETH (a Sepolia major) but NOT an arbitrary token — so a PA1+junk pool
    // cannot match the query at all, not merely be filtered after fetch.
    const knownTokens = (
      permissionedCalls[0]!.variables.knownTokens as string[]
    ).map(t => t.toLowerCase());
    const adapters = (
      permissionedCalls[0]!.variables.permissionedAdapters as string[]
    ).map(t => t.toLowerCase());
    expect(adapters).toContain('0xef1dc9abd8a7e073cfdda453c775e7ce24e4a4c8'); // PA1
    expect(knownTokens).toContain('0xef1dc9abd8a7e073cfdda453c775e7ce24e4a4c8'); // PA1
    expect(knownTokens).toContain('0xfff9976782d46cc05630d1f6ebab18b2324d6b14'); // WETH (major)
    expect(knownTokens).not.toContain(
      '0x000000000000000000000000000000000000beef'
    ); // arbitrary junk
  });

  it('omits the permissioned-hook query for a chain with no permissioned hooks (Arbitrum)', async () => {
    const {provider, queries} = makeRecordingProvider(ChainId.ARBITRUM_ONE);
    await provider.getPools();

    expect(queries.some(q => q.includes('getV4PermissionedHookPools'))).toBe(
      false
    );
    // The standard V4 queries still run.
    expect(queries.some(q => q.includes('getV4HighLiquidityPools'))).toBe(true);
  });

  it('builds syntactically valid GraphQL for every query', async () => {
    const {provider, queries} = makeRecordingProvider(ChainId.SEPOLIA);
    await provider.getPools();

    // Throws GraphQLSyntaxError on malformed GraphQL — the substring
    // assertions above can't catch that.
    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) {
      expect(() => parse(q)).not.toThrow();
    }
  });
});

describe('SubgraphProvider V4 TVL-bypass Hook query', () => {
  it('fetches TVL-bypass Hook pools by hook address with no TVL floor for Mainnet', async () => {
    const {provider, calls} = makeRecordingProvider(ChainId.MAINNET);
    await provider.getPools();

    const bypassCalls = calls.filter(c =>
      c.query.includes('getV4TvlBypassHookPools')
    );
    expect(bypassCalls.length).toBe(1);
    const {query: q, variables} = bypassCalls[0]!;
    expect(q).toContain('hooks_in: $tvlBypassHooks');
    // TVL-bypass Hooks report structurally-zero liquidity/TVL — neither a
    // liquidity nor a TVL floor can be applied here. Hook-address membership
    // is the sole admission gate.
    expect(q).not.toContain('liquidity_gt');
    expect(q).not.toContain('totalValueLockedETH_gt');

    const tvlBypassHooks = (variables.tvlBypassHooks as string[]).map(h =>
      h.toLowerCase()
    );
    // ZLCA registry (ZLCA_HOOKS_PER_CHAIN) contributes the LitePSM and
    // dualpool hooks. Mainnet has no ZERO_MEASURED_TVL_HOOKS_PER_CHAIN
    // entries, so the bypass set is exactly these three.
    expect(tvlBypassHooks).toContain(
      '0x958a0904940f744f8c6b72c043ceee3ea34ae888'
    ); // LitePSM USDS
    expect(tvlBypassHooks).toContain(
      '0x958942af77dcd973b815b2a16bd88a5134c46888'
    ); // LitePSM DAI
    expect(tvlBypassHooks).toContain(
      '0x00000078bd49d5279a99b5f4011a5c61ee8caac0'
    ); // dualpool
  });

  it('fetches the Robinhood zero-measured-TVL hooks by address', async () => {
    const {provider, calls} = makeRecordingProvider(ChainId.ROBINHOOD);
    await provider.getPools();

    const bypassCalls = calls.filter(c =>
      c.query.includes('getV4TvlBypassHookPools')
    );
    // Robinhood V4 is id-range sharded: the TVL-bypass query fans out once
    // per shard (all carrying the same hooks variable).
    expect(bypassCalls.length).toBe(4);
    for (const call of bypassCalls) {
      const tvlBypassHooks = (call.variables.tvlBypassHooks as string[]).map(
        h => h.toLowerCase()
      );
      expect(tvlBypassHooks).toContain(
        '0x2cd91bd228ff4c537031d6b8204782090c84c0cc'
      ); // IndexFeeHook
      expect(tvlBypassHooks).toContain(
        '0x2539029365c03b131cca25cb10ff4519a1dcc0cc'
      ); // PensionTaxHook
    }
  });

  it('omits the TVL-bypass Hook query for a chain with none configured (Arbitrum)', async () => {
    const {provider, queries} = makeRecordingProvider(ChainId.ARBITRUM_ONE);
    await provider.getPools();

    expect(queries.some(q => q.includes('getV4TvlBypassHookPools'))).toBe(
      false
    );
    // The standard V4 queries still run.
    expect(queries.some(q => q.includes('getV4HighLiquidityPools'))).toBe(true);
  });

  it('builds syntactically valid GraphQL including the TVL-bypass Hook query', async () => {
    const {provider, queries} = makeRecordingProvider(ChainId.MAINNET);
    await provider.getPools();

    expect(queries.some(q => q.includes('getV4TvlBypassHookPools'))).toBe(true);
    for (const q of queries) {
      expect(() => parse(q)).not.toThrow();
    }
  });

  it('survives the post-fetch sanitize filter despite zero liquidity and zero TVL', async () => {
    const zlcaHookPool = {
      id: '0xzlcapool',
      feeTier: '3000',
      tickSpacing: '60',
      hooks: '0x958a0904940f744f8c6b72c043ceee3ea34ae888', // LitePSM USDS
      liquidity: '0',
      token0: {
        symbol: 'DAI',
        id: '0x6b175474e89094c44da98b954eedeac495271d0f',
        name: 'Dai Stablecoin',
        decimals: '18',
      },
      token1: {
        symbol: 'USDS',
        id: '0xdc035d45d973e3ec169d2276ddab16f1e407384f',
        name: 'USDS Stablecoin',
        decimals: '18',
      },
      totalValueLockedUSD: '0',
      totalValueLockedETH: '0',
      totalValueLockedUSDUntracked: '0',
    };

    const provider = new V4SubgraphProvider(
      ChainId.MAINNET,
      0,
      5000,
      true,
      0.01,
      Number.MAX_VALUE,
      'https://example.invalid/subgraph',
      undefined,
      mockLogger,
      new MockMetric()
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any).client = {
      request: async (query: string, variables: Record<string, unknown>) => {
        // Only return the pool on the first page (id === '') so pagination
        // terminates instead of looping on the same result forever.
        if (query.includes('getV4TvlBypassHookPools') && variables.id === '') {
          return {pools: [zlcaHookPool]};
        }
        return {pools: []};
      },
    };

    const pools = await provider.getPools();
    expect(pools.some(p => p.id === '0xzlcapool')).toBe(true);
  });
});

describe('computeIdShards', () => {
  it('returns a single unbounded shard for count <= 1', () => {
    expect(computeIdShards(1)).toEqual([{startId: ''}]);
    expect(computeIdShards(0)).toEqual([{startId: ''}]);
  });

  it('splits the keyspace at 2-nibble boundaries for 4 shards', () => {
    expect(computeIdShards(4)).toEqual([
      {startId: '', endId: '0x40'},
      {startId: '0x40', endId: '0x80'},
      {startId: '0x80', endId: '0xc0'},
      {startId: '0xc0', endId: undefined},
    ]);
  });

  it('produces contiguous coverage for non-power-of-two counts', () => {
    const shards = computeIdShards(3);
    expect(shards[0]!.startId).toBe('');
    expect(shards[shards.length - 1]!.endId).toBeUndefined();
    for (let i = 1; i < shards.length; i++) {
      expect(shards[i]!.startId).toBe(shards[i - 1]!.endId);
    }
  });

  it('boundary strings order correctly against full-length lowercase pool ids', () => {
    // The subgraph's id_gt/id_lt is lexicographic; every real id is
    // 0x + 64 lowercase hex chars. A pool just below/above each boundary
    // must land in the right shard.
    const below = '0x3f' + 'f'.repeat(62);
    const at = '0x40' + '0'.repeat(62);
    expect(below < '0x40').toBe(true); // belongs to shard [.., 0x40)
    expect(at > '0x40').toBe(true); // belongs to shard [0x40, ..)
  });
});

describe('SubgraphProvider V4 id-range sharding', () => {
  const CHAIN_ID_ROBINHOOD = 4663 as ChainId;

  it('fans each query out into 4 concurrent id-range shards on Robinhood', async () => {
    const {provider, calls} = makeRecordingProvider(CHAIN_ID_ROBINHOOD);
    await provider.getPools();

    const highLiquidityCalls = calls.filter(c =>
      c.query.includes('getV4HighLiquidityPools')
    );
    expect(highLiquidityCalls.length).toBe(4);
    expect(
      highLiquidityCalls.map(c => ({
        id: c.variables.id,
        endId: c.variables.endId,
      }))
    ).toEqual(
      expect.arrayContaining([
        {id: '', endId: '0x40'},
        {id: '0x40', endId: '0x80'},
        {id: '0x80', endId: '0xc0'},
        {id: '0xc0', endId: undefined},
      ])
    );

    // Bounded shards declare and use $endId; the last (unbounded) shard
    // must omit it entirely — GraphQL rejects declared-but-unused variables.
    for (const c of highLiquidityCalls) {
      if (c.variables.endId !== undefined) {
        expect(c.query).toContain('$endId: String');
        expect(c.query).toContain('id_lt: $endId');
      } else {
        expect(c.query).not.toContain('$endId');
        expect(c.query).not.toContain('id_lt');
      }
    }
  });

  it('builds syntactically valid GraphQL for every sharded query', async () => {
    const {provider, queries} = makeRecordingProvider(CHAIN_ID_ROBINHOOD);
    await provider.getPools();

    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) {
      expect(() => parse(q)).not.toThrow();
    }
  });

  it('keeps a single unbounded fetch per query on non-sharded chains (Arbitrum)', async () => {
    const {provider, calls} = makeRecordingProvider(ChainId.ARBITRUM_ONE);
    await provider.getPools();

    const highLiquidityCalls = calls.filter(c =>
      c.query.includes('getV4HighLiquidityPools')
    );
    expect(highLiquidityCalls.length).toBe(1);
    expect(highLiquidityCalls[0]!.variables.endId).toBeUndefined();
    expect(highLiquidityCalls[0]!.query).not.toContain('id_lt');
    expect(highLiquidityCalls[0]!.variables.id).toBe('');
  });

  it('dedupes a pool returned by more than one shard', async () => {
    const dupPool = {
      id: '0x50' + 'ab'.repeat(31),
      feeTier: '3000',
      tickSpacing: '60',
      hooks: '0x0000000000000000000000000000000000000000',
      liquidity: '1000000',
      token0: {symbol: 'A', id: '0x1111', name: 'A', decimals: '18'},
      token1: {symbol: 'B', id: '0x2222', name: 'B', decimals: '18'},
      totalValueLockedUSD: '20000',
      totalValueLockedETH: '10',
      totalValueLockedUSDUntracked: '0',
    };
    // Return the same pool from the FIRST page of two different shards
    // (boundary overlap can't happen in practice, but the merge must be
    // robust to it). Later pages (id === dupPool.id) return empty so
    // pagination terminates.
    const {provider} = makeRecordingProvider(
      CHAIN_ID_ROBINHOOD,
      (query, variables) =>
        query.includes('getV4HighLiquidityPools') &&
        (variables.id === '' || variables.id === '0x40')
          ? {pools: [dupPool]}
          : {pools: []}
    );

    const pools = await provider.getPools();
    expect(pools.filter(p => p.id === dupPool.id).length).toBe(1);
  });
});
