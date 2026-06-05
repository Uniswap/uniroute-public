import {describe, it, expect, vi} from 'vitest';
import {parse} from 'graphql';
import {ChainId} from '@uniswap/sdk-core';
import {V4SubgraphProvider} from './v4/subgraphProvider';
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
 * Records every GraphQL query string passed to request(), and always returns an
 * empty page so pagination terminates immediately. Lets us assert which queries
 * the provider builds without hitting a real subgraph.
 */
function makeRecordingProvider(chainId: ChainId): {
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
      return {pools: []};
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
