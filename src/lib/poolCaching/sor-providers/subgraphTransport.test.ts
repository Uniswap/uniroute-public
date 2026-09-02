/**
 * Transport wiring for the subgraph providers.
 *
 * graphql-request@3.7.0 reads `options.fetch` on every request and only falls
 * back to its bundled cross-fetch (node-fetch@2) when the option is absent, so
 * these tests drive the REAL GraphQLClient and assert the injected transport is
 * what performs the HTTP call — the whole point of routing these calls through
 * `ctx.fetch`.
 */

import {describe, it, expect, vi} from 'vitest';
import {ChainId} from '@uniswap/sdk-core';

import {V4SubgraphProvider} from './v4/subgraphProvider';
import {V2SubgraphProvider} from './v2/subgraphProvider';
import {EulerSwapHooksSubgraphProvider} from './v4/eulerSwapHooksSubgraphProvider';
import {AggHooksSubgraphProvider} from './v4/aggHooksSubgraphProvider';
import type {Logger} from './util/log';
import {IMetric} from './util/metric';
import type {
  SubgraphFetch,
  SubgraphFetchFactory,
  SubgraphFetchOptions,
} from './util/subgraphFetch';

const SUBGRAPH_URL = 'https://example.invalid/subgraph';

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

interface RecordedCall {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body: {query?: string; variables?: Record<string, unknown>};
}

/**
 * A `SubgraphFetchFactory` that records the budget it was bound to and every
 * request the GraphQL client makes, always answering with an empty page so
 * pagination terminates on the first round.
 */
function recordingFactory(
  respond?: (query: string) => {
    status?: number;
    body: string;
    contentType?: string;
  }
): {
  factory: SubgraphFetchFactory;
  boundOpts: SubgraphFetchOptions[];
  calls: RecordedCall[];
} {
  const boundOpts: SubgraphFetchOptions[] = [];
  const calls: RecordedCall[] = [];
  const factory: SubgraphFetchFactory = (opts: SubgraphFetchOptions) => {
    boundOpts.push(opts);
    const fetchImpl: SubgraphFetch = async (input, init) => {
      const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        url: String(input),
        method: init?.method,
        headers: Object.fromEntries(
          Object.entries(rawHeaders).map(([k, v]) => [k.toLowerCase(), v])
        ),
        body: JSON.parse(String(init?.body ?? '{}')),
      });
      // Answer with whichever root field the query asked for, so pagination
      // terminates on the first empty page: V2 uses `pairs`, V3/V4 `pools`,
      // the euler-hooks provider `eulerSwapHooks`, and the agg-hooks provider
      // follows its pool page with a `bundle` read.
      const query = String(JSON.parse(String(init?.body ?? '{}')).query ?? '');
      const scripted = respond?.(query);
      if (scripted) {
        // eslint-disable-next-line n/no-unsupported-features/node-builtins
        return new Response(scripted.body, {
          status: scripted.status ?? 200,
          headers: {
            'Content-Type': scripted.contentType ?? 'application/json',
          },
        });
      }
      let data: Record<string, unknown> = {pools: []};
      if (query.includes('pairs(')) {
        data = {pairs: []};
      } else if (query.includes('eulerSwapHooks(')) {
        data = {eulerSwapHooks: []};
      } else if (query.includes('bundle')) {
        data = {bundle: {ethPriceUSD: '2000'}};
      }
      // eslint-disable-next-line n/no-unsupported-features/node-builtins
      return new Response(JSON.stringify({data}), {
        status: 200,
        headers: {'Content-Type': 'application/json'},
      });
    };
    return fetchImpl;
  };
  return {factory, boundOpts, calls};
}

describe('subgraph provider transport injection', () => {
  it('routes V3/V4 GraphQL calls through the injected fetch as a JSON POST', async () => {
    const {factory, calls} = recordingFactory();
    const provider = new V4SubgraphProvider(
      ChainId.ARBITRUM_ONE,
      0, // retries
      5000, // timeout
      true,
      0.01,
      Number.MAX_VALUE,
      SUBGRAPH_URL,
      undefined,
      mockLogger,
      new MockMetric(),
      factory
    );

    await provider.getPools();

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.url).toBe(SUBGRAPH_URL);
      expect(call.method).toBe('POST');
      expect(call.headers['content-type']).toBe('application/json');
      expect(call.body.query).toContain('pools(');
    }
  });

  it('routes V2 GraphQL calls through the injected fetch', async () => {
    const {factory, calls} = recordingFactory();
    const provider = new V2SubgraphProvider(
      ChainId.MAINNET,
      0, // retries
      5000, // timeout
      true,
      1000,
      0.025,
      Number.MAX_VALUE,
      SUBGRAPH_URL,
      undefined,
      mockLogger,
      new MockMetric(),
      factory
    );

    await provider.getPools();

    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]!.url).toBe(SUBGRAPH_URL);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body.query).toContain('pairs(');
  });

  it("binds the transport to the provider's own budget, not the 1s ambient default", async () => {
    const {factory, boundOpts} = recordingFactory();
    new V4SubgraphProvider(
      ChainId.ARBITRUM_ONE,
      0,
      123456, // timeout
      true,
      0.01,
      Number.MAX_VALUE,
      SUBGRAPH_URL,
      undefined,
      mockLogger,
      new MockMetric(),
      factory
    );

    expect(boundOpts).toEqual([
      {runTimeoutMs: 123456, chainId: ChainId.ARBITRUM_ONE, protocol: 'v4'},
    ]);
  });

  it('still sends the bearer token through the injected fetch', async () => {
    const {factory, calls} = recordingFactory();
    const provider = new V4SubgraphProvider(
      ChainId.ARBITRUM_ONE,
      0,
      5000,
      true,
      0.01,
      Number.MAX_VALUE,
      SUBGRAPH_URL,
      'test-bearer-token',
      mockLogger,
      new MockMetric(),
      factory
    );

    await provider.getPools();

    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]!.headers['authorization']).toBe('Bearer test-bearer-token');
  });

  it('omits the fetch option entirely when no factory is injected', () => {
    // White-box on purpose: with no `fetch` option graphql-request@3.7.0 uses
    // its bundled cross-fetch, so this pins the fallback for callers that have
    // no context (and keeps the option from being set to a bare `undefined`
    // that a future version might not treat as "unset").
    const provider = new V4SubgraphProvider(
      ChainId.ARBITRUM_ONE,
      0,
      5000,
      true,
      0.01,
      Number.MAX_VALUE,
      SUBGRAPH_URL,
      'test-bearer-token',
      mockLogger,
      new MockMetric()
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const options = (provider as any).client.options as Record<string, unknown>;
    expect('fetch' in options).toBe(false);
    expect(options.headers).toEqual({
      authorization: 'Bearer test-bearer-token',
    });
  });

  it('routes euler-hooks GraphQL calls through the injected fetch', async () => {
    const {factory, boundOpts, calls} = recordingFactory();
    const provider = new EulerSwapHooksSubgraphProvider(
      ChainId.UNICHAIN,
      0, // retries
      90000, // timeout — the value cacheConfig passes for this provider
      true,
      SUBGRAPH_URL,
      mockLogger,
      new MockMetric(),
      factory
    );

    await provider.getHooks();

    expect(boundOpts[0]!.runTimeoutMs).toBe(90000);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]!.url).toBe(SUBGRAPH_URL);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body.query).toContain('eulerSwapHooks(');
  });

  it('routes agg-hooks GraphQL calls through the injected fetch', async () => {
    const {factory, boundOpts, calls} = recordingFactory();
    const provider = new AggHooksSubgraphProvider(
      ChainId.MAINNET,
      ['0x0000000000000000000000000000000000000abc'],
      // Not reached: with zero pools returned there is no on-chain TVL read.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      0, // retries
      90000, // timeout — the value cacheConfig passes for this provider
      true,
      SUBGRAPH_URL,
      undefined,
      mockLogger,
      new MockMetric(),
      false, // useExternalLiquidity — positional, precedes the transport
      factory
    );

    await provider.getPools();

    expect(boundOpts[0]!.runTimeoutMs).toBe(90000);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.url).toBe(SUBGRAPH_URL);
      expect(call.method).toBe('POST');
    }
    expect(calls.some(c => c.body.query?.includes('pools('))).toBe(true);
  });

  it('omits the fetch option on the hooks providers when no factory is given', () => {
    const euler = new EulerSwapHooksSubgraphProvider(
      ChainId.UNICHAIN,
      0,
      90000,
      true,
      SUBGRAPH_URL,
      mockLogger,
      new MockMetric()
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect('fetch' in ((euler as any).client.options as object)).toBe(false);
  });

  /**
   * The `ClientError` salvage contract is the load-bearing reason this PR keeps
   * the SDK instead of hand-rolling a ctx.fetch POST
   * (`util/allowedSubgraphError.ts` pulls `response.data` off the thrown
   * ClientError for tolerated subgraph indexing errors). Nothing exercised it
   * end-to-end THROUGH the injected transport, so these pin current behaviour.
   */
  describe('ClientError salvage through the injected transport', () => {
    it('salvages data from a 200 carrying a tolerated indexing error', async () => {
      const pool = {
        id: '0xpool',
        feeTier: '3000',
        tickSpacing: '60',
        hooks: '0x0000000000000000000000000000000000000000',
        liquidity: '1',
        token0: {symbol: 'A', id: '0xa'},
        token1: {symbol: 'B', id: '0xb'},
        totalValueLockedUSD: '1000000',
        totalValueLockedETH: '1000',
        totalValueLockedUSDUntracked: '0',
      };
      let served = false;
      const {factory} = recordingFactory(() => {
        // One page of data alongside the error, then empty pages so the
        // paginating cursor advances and the crawl terminates.
        if (served) return {body: JSON.stringify({data: {pools: []}})};
        served = true;
        return {
          body: JSON.stringify({
            data: {pools: [pool]},
            errors: [
              {
                message:
                  'indexing_error: subgraph has only indexed up to block 100',
              },
            ],
          }),
        };
      });

      const provider = new V4SubgraphProvider(
        ChainId.ARBITRUM_ONE,
        0,
        5000,
        true,
        0.01,
        Number.MAX_VALUE,
        SUBGRAPH_URL,
        undefined,
        mockLogger,
        new MockMetric(),
        factory
      );

      // Salvaged rather than thrown: graphql-request throws on ANY non-empty
      // `errors` array even when `data` is present.
      await expect(provider.getPools()).resolves.toBeInstanceOf(Array);
    });

    it('rethrows a 502 whose body is not JSON', async () => {
      const {factory} = recordingFactory(() => ({
        status: 502,
        body: '<html>bad gateway</html>',
        contentType: 'text/html',
      }));

      const provider = new V4SubgraphProvider(
        ChainId.ARBITRUM_ONE,
        0, // no retries, so the rejection is prompt
        5000,
        true,
        0.01,
        Number.MAX_VALUE,
        SUBGRAPH_URL,
        undefined,
        mockLogger,
        new MockMetric(),
        factory
      );

      // Nothing to salvage — an upstream 5xx with an HTML body must not be
      // mistaken for a tolerated indexing error.
      await expect(provider.getPools()).rejects.toThrow();
    });
  });
});
