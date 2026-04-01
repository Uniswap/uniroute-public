import {describe, it, expect, vi, beforeEach} from 'vitest';
import {ChainId} from '@uniswap/sdk-core';
import {GraphQLClient} from 'graphql-request';
import {AggHooksSubgraphProvider} from './aggHooksSubgraphProvider';

const MOCK_URL = 'https://mock-subgraph.example/graphql';
const MOCK_HOOK = '0xabcdef0000000000000000000000000000000001';

// ---- mock graphql-request ----
const mockRequest = vi.fn();
vi.mock('graphql-request', () => {
  // Must use regular function (not arrow) so it can be called with `new`
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const MockGraphQLClient = vi.fn(function MockGraphQLClient(this: any) {
    this.request = mockRequest;
  });
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    gql: vi.fn((strings: TemplateStringsArray, ...vals: any[]) =>
      strings.reduce(
        (acc: string, str: string, i: number) => acc + str + (vals[i] ?? ''),
        ''
      )
    ),
    GraphQLClient: MockGraphQLClient,
  };
});

// ---- mock ethers.Contract while keeping real utils (formatUnits, BigNumber, etc.) ----
const mockPseudoTVL = vi.fn();
vi.mock('ethers', async importOriginal => {
  const actual = await importOriginal<typeof import('ethers')>();
  // Must use regular function so it can be called with `new`
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const MockContract = vi.fn(function MockContract(this: any) {
    this.pseudoTotalValueLocked = mockPseudoTVL;
  });
  return {
    // Spread all named exports (e.g. constants, BigNumber) so downstream
    // imports like `import { constants } from 'ethers'` continue to work.
    ...actual,
    ethers: {
      ...actual.ethers,
      Contract: MockContract,
    },
  };
});

// minimal stand-in for ethers.providers.BaseProvider (not called in our tests)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockEthersProvider = {} as any;

// ---- helpers ----

function makeProvider(hookAddresses = [MOCK_HOOK]) {
  return new AggHooksSubgraphProvider(
    ChainId.MAINNET,
    hookAddresses,
    mockEthersProvider,
    2,
    30000,
    true,
    MOCK_URL
  );
}

/**
 * Builds a raw pool response as returned by the subgraph.
 * token0: WETH (18 decimals, derivedETH=1.0)
 * token1: USDC (6 decimals, derivedETH=0.0005)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeRawPool(id: string, hooks = MOCK_HOOK): any {
  return {
    id,
    feeTier: '100',
    tickSpacing: '1',
    hooks,
    liquidity: '0',
    token0: {
      symbol: 'WETH',
      id: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
      name: 'Wrapped Ether',
      decimals: '18',
      derivedETH: '1.0',
    },
    token1: {
      symbol: 'USDC',
      id: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      name: 'USD Coin',
      decimals: '6',
      derivedETH: '0.0005',
    },
    totalValueLockedUSD: '0',
    totalValueLockedETH: '0',
    isExternalLiquidity: true,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeBundleResponse(ethPriceUSD = '2000'): any {
  return {bundle: {ethPriceUSD}};
}

// Set up mock calls for a scenario with exactly `pools` in the first page.
// Pattern: page1 → given pools, page2 → empty (stops pagination), then bundle.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function setupSinglePageMocks(pools: any[], ethPriceUSD = '2000') {
  mockRequest
    .mockResolvedValueOnce({pools}) // page 1
    .mockResolvedValueOnce({pools: []}) // page 2 → empty, pagination stops
    .mockResolvedValueOnce(makeBundleResponse(ethPriceUSD)); // bundle
}

// ---- tests ----

describe('AggHooksSubgraphProvider', () => {
  beforeEach(() => {
    mockRequest.mockReset();
    mockPseudoTVL.mockReset();
    vi.mocked(GraphQLClient).mockClear();
  });

  // ---- constructor ----

  describe('constructor', () => {
    it('throws when no subgraph URL exists for the chain and no override is given', () => {
      expect(
        () =>
          new AggHooksSubgraphProvider(
            99999 as ChainId,
            [MOCK_HOOK],
            mockEthersProvider
          )
      ).toThrow('No subgraph url for chain id: 99999');
    });

    it('does not throw when a subgraphUrlOverride is provided', () => {
      expect(
        () =>
          new AggHooksSubgraphProvider(
            99999 as ChainId,
            [MOCK_HOOK],
            mockEthersProvider,
            2,
            30000,
            true,
            MOCK_URL
          )
      ).not.toThrow();
    });

    it('creates GraphQLClient with Authorization header when bearerToken is provided', () => {
      new AggHooksSubgraphProvider(
        ChainId.MAINNET,
        [MOCK_HOOK],
        mockEthersProvider,
        2,
        30000,
        true,
        MOCK_URL,
        'my-secret-token'
      );
      expect(vi.mocked(GraphQLClient)).toHaveBeenCalledWith(MOCK_URL, {
        headers: {authorization: 'Bearer my-secret-token'},
      });
    });

    it('creates GraphQLClient without extra headers when no bearerToken is given', () => {
      new AggHooksSubgraphProvider(
        ChainId.MAINNET,
        [MOCK_HOOK],
        mockEthersProvider,
        2,
        30000,
        true,
        MOCK_URL
      );
      expect(vi.mocked(GraphQLClient)).toHaveBeenCalledWith(MOCK_URL);
    });
  });

  // ---- getPools ----

  describe('getPools', () => {
    it('returns an empty array when the subgraph returns no pools', async () => {
      mockRequest
        .mockResolvedValueOnce({pools: []}) // page 1 → empty, loop exits immediately
        .mockResolvedValueOnce(makeBundleResponse());

      const pools = await makeProvider().getPools();
      expect(pools).toEqual([]);
    });

    it('computes tvlETH and tvlUSD from pseudoTotalValueLocked amounts', async () => {
      setupSinglePageMocks([makeRawPool('0xpool1')], '2000');

      // amount0 = 1e18 (1 WETH, decimals=18, derivedETH=1.0) → 1.0 ETH
      // amount1 = 2000e6 (2000 USDC, decimals=6, derivedETH=0.0005) → 1.0 ETH
      // tvlETH = 2.0, tvlUSD = 2.0 * 2000 = 4000
      mockPseudoTVL.mockResolvedValueOnce([
        '1000000000000000000', // 1e18
        '2000000000', // 2e9 (2000 USDC)
      ]);

      const pools = await makeProvider().getPools();

      expect(pools).toHaveLength(1);
      expect(pools[0]!.tvlETH).toBeCloseTo(2.0);
      expect(pools[0]!.tvlUSD).toBeCloseTo(4000);
    });

    it('falls back to subgraph TVL (0) when pseudoTotalValueLocked call fails', async () => {
      setupSinglePageMocks([makeRawPool('0xpool1')]);
      mockPseudoTVL.mockRejectedValueOnce(new Error('execution reverted'));

      const pools = await makeProvider().getPools();

      expect(pools).toHaveLength(1);
      expect(pools[0]!.tvlETH).toBe(0);
      expect(pools[0]!.tvlUSD).toBe(0);
    });

    it('handles multiple pools independently — one succeeds, one fails', async () => {
      setupSinglePageMocks(
        [makeRawPool('0xpool1'), makeRawPool('0xpool2')],
        '2000'
      );

      // pool1: succeeds → 1 ETH from token0 only
      mockPseudoTVL.mockResolvedValueOnce(['1000000000000000000', '0']);
      // pool2: fails → fallback to 0
      mockPseudoTVL.mockRejectedValueOnce(new Error('reverted'));

      const pools = await makeProvider().getPools();

      expect(pools).toHaveLength(2);
      expect(pools[0]!.tvlETH).toBeCloseTo(1.0);
      expect(pools[0]!.tvlUSD).toBeCloseTo(2000);
      expect(pools[1]!.tvlETH).toBe(0);
      expect(pools[1]!.tvlUSD).toBe(0);
    });

    it('paginates across multiple pages and accumulates all pools', async () => {
      const page1 = [makeRawPool('0xpool0'), makeRawPool('0xpool1')];
      const page2 = [makeRawPool('0xpool2')];
      mockRequest
        .mockResolvedValueOnce({pools: page1})
        .mockResolvedValueOnce({pools: page2})
        .mockResolvedValueOnce({pools: []})
        .mockResolvedValueOnce(makeBundleResponse());

      // all contract calls return zero amounts
      mockPseudoTVL.mockResolvedValue(['0', '0']);

      const pools = await makeProvider().getPools();
      expect(pools).toHaveLength(3);
    });

    it('uses the last pool id as cursor for the next page', async () => {
      const page1 = [makeRawPool('0xaaapool')];
      mockRequest
        .mockResolvedValueOnce({pools: page1})
        .mockResolvedValueOnce({pools: []})
        .mockResolvedValueOnce(makeBundleResponse());

      mockPseudoTVL.mockResolvedValue(['0', '0']);

      await makeProvider().getPools();

      // second pool-query call should include id: '0xaaapool' as the cursor
      const secondCallVars = mockRequest.mock.calls[1]![1];
      expect(secondCallVars.id).toBe('0xaaapool');
    });

    it('lowercases hook addresses when querying the subgraph', async () => {
      const upperHook = '0xABCDEF0000000000000000000000000000000001';
      const provider = new AggHooksSubgraphProvider(
        ChainId.MAINNET,
        [upperHook],
        mockEthersProvider,
        2,
        30000,
        true,
        MOCK_URL
      );

      mockRequest
        .mockResolvedValueOnce({pools: []})
        .mockResolvedValueOnce(makeBundleResponse());

      await provider.getPools();

      const firstCallVars = mockRequest.mock.calls[0]![1];
      expect(firstCallVars.hooks).toEqual([upperHook.toLowerCase()]);
    });

    it('passes the pool id to pseudoTotalValueLocked on the hook contract', async () => {
      const poolId =
        '0xdeadbeef0000000000000000000000000000000000000000000000000000cafe';
      setupSinglePageMocks([makeRawPool(poolId)]);
      mockPseudoTVL.mockResolvedValueOnce(['0', '0']);

      await makeProvider().getPools();

      expect(mockPseudoTVL).toHaveBeenCalledWith(poolId);
    });

    it('maps subgraph fields onto the returned V4SubgraphPool', async () => {
      const rawPool = makeRawPool('0xmypool');
      setupSinglePageMocks([rawPool]);
      mockPseudoTVL.mockResolvedValueOnce(['0', '0']);

      const pools = await makeProvider().getPools();

      expect(pools[0]).toMatchObject({
        id: '0xmypool',
        feeTier: '100',
        tickSpacing: '1',
        hooks: MOCK_HOOK,
        liquidity: '0',
        token0: {
          symbol: 'WETH',
          id: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
          name: 'Wrapped Ether',
          decimals: '18',
        },
        token1: {
          symbol: 'USDC',
          id: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          name: 'USD Coin',
          decimals: '6',
        },
      });
      // derivedETH must NOT be present on the returned pool tokens
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((pools[0]!.token0 as any).derivedETH).toBeUndefined();
    });

    it('uses ethPriceUSD from the subgraph bundle for USD conversion', async () => {
      setupSinglePageMocks([makeRawPool('0xpool1')], '3000');
      // 1 ETH worth of token0 only
      mockPseudoTVL.mockResolvedValueOnce(['1000000000000000000', '0']);

      const pools = await makeProvider().getPools();

      // tvlETH = 1.0, tvlUSD = 1.0 * 3000
      expect(pools[0]!.tvlETH).toBeCloseTo(1.0);
      expect(pools[0]!.tvlUSD).toBeCloseTo(3000);
    });

    it('treats a null subgraph bundle as ethPriceUSD = 0', async () => {
      mockRequest
        .mockResolvedValueOnce({pools: [makeRawPool('0xpool1')]})
        .mockResolvedValueOnce({pools: []})
        .mockResolvedValueOnce({bundle: null}); // null bundle

      mockPseudoTVL.mockResolvedValueOnce(['1000000000000000000', '0']);

      const pools = await makeProvider().getPools();

      // tvlETH should still be computed, but tvlUSD = tvlETH * 0
      expect(pools[0]!.tvlETH).toBeCloseTo(1.0);
      expect(pools[0]!.tvlUSD).toBeCloseTo(0);
    });
  });
});
