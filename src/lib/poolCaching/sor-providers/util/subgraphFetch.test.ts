import {describe, it, expect} from 'vitest';
import {FetchConfig, FetchLike} from '@uniswap/lib-uni';
import {Context} from '@uniswap/lib-uni/context';
import {sanitizePath} from '@uniswap/lib-middlewares/client';

import {createWorkerFetcher} from '../../../workerFetcher';
import {
  SUBGRAPH_METRIC_PATH,
  SUBGRAPH_PAGE_TIMEOUT_MS,
  subgraphCtxFetchEnabled,
  subgraphFetchFactoryFromContext,
  subgraphPageTimeoutMs,
} from './subgraphFetch';

const OPTS = {runTimeoutMs: 90_000, chainId: 1, protocol: 'v3'};

describe('subgraphPageTimeoutMs', () => {
  it('bounds one request well under undici’s 300s default', () => {
    // A 300s cap surfaces as UND_ERR_HEADERS_TIMEOUT, which leaves
    // client.timeout flat; staying under it keeps stalls identifiable.
    expect(SUBGRAPH_PAGE_TIMEOUT_MS).toBeLessThan(300_000);
  });

  it('never exceeds the run budget it sits inside', () => {
    // The four long budgets in cacheConfig are WHOLE-RUN deadlines.
    for (const run of [30_000, 90_000, 360_000, 900_000, 1_200_000]) {
      expect(subgraphPageTimeoutMs(run)).toBeLessThanOrEqual(run);
      expect(subgraphPageTimeoutMs(run)).toBe(
        Math.min(SUBGRAPH_PAGE_TIMEOUT_MS, run)
      );
    }
  });

  it('leaves the Robinhood fast job room to retry', () => {
    // 110s job budget (POOL_CACHING_ROBINHOOD_V4_JOB_TIMEOUT_MS) against the
    // 90s provider budget cacheConfig gives chain 4663.
    const perRequest = subgraphPageTimeoutMs(90_000);
    expect(perRequest * 3).toBeLessThan(110_000);
  });
});

describe('subgraphCtxFetchEnabled', () => {
  it('defaults ON when unset or empty', () => {
    expect(subgraphCtxFetchEnabled({})).toBe(true);
    expect(
      subgraphCtxFetchEnabled({POOL_CACHING_SUBGRAPH_CTX_FETCH_ENABLED: ''})
    ).toBe(true);
  });

  it('is disabled only by an exact "false", tolerating surrounding whitespace', () => {
    for (const v of ['false', ' false', 'false\n', '  false  ']) {
      expect(
        subgraphCtxFetchEnabled({POOL_CACHING_SUBGRAPH_CTX_FETCH_ENABLED: v})
      ).toBe(false);
    }
    // Anything else leaves the new transport on — a fail-open switch must not
    // be flipped by a value it does not recognise.
    for (const v of ['true', '0', 'no', 'FALSE', 'disabled']) {
      expect(
        subgraphCtxFetchEnabled({POOL_CACHING_SUBGRAPH_CTX_FETCH_ENABLED: v})
      ).toBe(true);
    }
  });
});

describe('subgraphFetchFactoryFromContext', () => {
  it('calls ctx.fetch with the per-page budget and the bounded tags', async () => {
    const seen: {
      input: unknown;
      init?: RequestInit;
      fetchConfig?: FetchConfig;
    }[] = [];
    const ctx = Context.Background();
    const fetcher: FetchLike = async (_ctx, input, init, fetchConfig) => {
      seen.push({input, init, fetchConfig});
      // eslint-disable-next-line n/no-unsupported-features/node-builtins
      return new Response('{}', {status: 200});
    };
    ctx.fetcher = fetcher;

    const fetchImpl = subgraphFetchFactoryFromContext(ctx)(OPTS);
    const response = await fetchImpl('https://example.invalid/subgraph', {
      method: 'POST',
      body: '{"query":"{ pools { id } }"}',
    });

    expect(response.status).toBe(200);
    expect(seen.length).toBe(1);
    expect(seen[0]!.init?.method).toBe('POST');
    // NOT the 90s run budget: a per-request deadline equal to the whole-run
    // deadline can never fire before the run is already over.
    expect(seen[0]!.fetchConfig?.timeoutMs).toBe(SUBGRAPH_PAGE_TIMEOUT_MS);
    expect(seen[0]!.fetchConfig?.metricTags).toEqual({
      vendor: 'subgraph',
      path: SUBGRAPH_METRIC_PATH,
      chainid: '1',
      protocol: 'v3',
    });
  });

  it('buffers the body so a post-headers stall cannot outlive the budget', async () => {
    // graphql-request reads the body itself, AFTER timeoutMiddleware has
    // cleared its abort timer. A stream that never closes must not hang.
    const ctx = Context.Background();
    ctx.fetcher = async () => {
      // eslint-disable-next-line n/no-unsupported-features/node-builtins
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"data":'));
          // never closed
        },
      });
      // eslint-disable-next-line n/no-unsupported-features/node-builtins
      return new Response(stream, {
        status: 200,
        headers: {'Content-Type': 'application/json'},
      });
    };
    let counted = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ctx as any).metrics = {
      count: async (name: string) => {
        if (name === 'client.timeout') counted += 1;
      },
    };

    const fetchImpl = subgraphFetchFactoryFromContext(ctx)({
      ...OPTS,
      runTimeoutMs: 50, // tiny budget so the test is fast
    });

    await expect(fetchImpl('https://example.invalid/subgraph')).rejects.toThrow(
      /timedout/i
    );
    // Without this counter a stalled-body incident reads as 100% vendor
    // success, because metricMiddleware already metered the 200 off the headers.
    expect(counted).toBe(1);
  });

  /**
   * Regression: `metricMiddleware` tags every client.* metric with
   * `sanitizePath(url.pathname)`, and `sanitizePath` only redacts segments of
   * 40+ characters. 21 subgraph URLs in `cacheConfig.ts` carry the Goldsky API
   * key as a path segment, so before the static override a key shorter than 40
   * chars reached Datadog verbatim.
   *
   * This drives the REAL middleware stack (`createWorkerFetcher`) with a
   * recording metrics implementation, rather than replacing ctx.fetcher — the
   * guarantee lives in metricMiddleware's spread order, so a test that stubs
   * the fetcher replaces the very middleware it means to protect.
   */
  it('never lets a goldsky path-embedded API key reach the emitted metric dimensions', async () => {
    const key = 'gsk_short_key_abc123';
    const url = `https://api.goldsky.com/api/private/${key}/subgraphs/uniswap-v4-robinhood-mainnet/prod/gn`;

    // Establishes the hazard is real rather than hypothetical: the middleware's
    // own derivation leaves this key in place, because the segment is under 40.
    expect(key.length).toBeLessThan(40);
    expect(sanitizePath(new URL(url).pathname)).toContain(key);

    const emitted: Record<string, string>[] = [];
    const record = async (
      _name: string,
      _value: number,
      opts?: {dimensions?: Record<string, string>}
    ) => {
      if (opts?.dimensions) emitted.push(opts.dimensions);
    };

    const ctx = Context.Background();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ctx as any).metrics = {count: record, timer: record, dist: record};
    // Both prod entrypoints wire a tracer; without one the stack also emits
    // client.tracer_missing, whose dimensions are {to} only.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ctx as any).tracer = {
      trace: async <T>(_name: string, fn: () => Promise<T>) => fn(),
    };
    // The real stack: s2sHeaders -> metrics -> timeout -> tracer -> transport.
    ctx.fetcher = async (c, input, init, config) => {
      const stack = createWorkerFetcher();
      // Swap only the bottom transport by intercepting at the network layer.
      return stack(c, input, init, config);
    };

    // Point the real stack at a local server so no network egress is needed.
    const {createServer} = await import('node:http');
    const server = createServer((_req, res) => {
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end('{"data":{"pools":[]}}');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as {port: number}).port;
    // Same shape of path, on a reachable host.
    const localUrl = `http://127.0.0.1:${port}/api/private/${key}/subgraphs/x/prod/gn`;

    try {
      const fetchImpl = subgraphFetchFactoryFromContext(ctx)(OPTS);
      await fetchImpl(localUrl, {method: 'POST', body: '{}'});
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }

    // metricMiddleware emits client.total / client.status / client.latency,
    // all carrying `path`.
    const withPath = emitted.filter(d => d.path !== undefined);
    expect(withPath.length).toBeGreaterThan(0);
    for (const dims of withPath) {
      expect(dims.path).toBe(SUBGRAPH_METRIC_PATH);
      expect(dims.chainid).toBe('1');
      expect(dims.protocol).toBe('v3');
    }
    // The security property holds across EVERY emitted dimension, not just
    // the ones that happen to carry a path.
    for (const dims of emitted) {
      for (const value of Object.values(dims)) {
        expect(value).not.toContain(key);
        expect(value).not.toContain('api/private');
      }
    }
  });

  it('pins a bounded, non-URL-derived metric path', () => {
    // If this ever became URL-derived again the leak returns silently.
    expect(SUBGRAPH_METRIC_PATH).toBe('/{subgraph}');
    expect(SUBGRAPH_METRIC_PATH.length).toBeLessThan(40);
  });
});
