/**
 * The HTTP transport the subgraph providers hand to `graphql-request`.
 *
 * `graphql-request@3.7.0` performs its request through whatever callable it
 * finds on the client's `fetch` option, falling back to `cross-fetch`
 * (node-fetch@2 on the server) when the option is absent. Injecting a
 * `ctx.fetch`-backed implementation is therefore the whole migration: no
 * version bump and no hand-rolled GraphQL POST.
 *
 * The type is deliberately narrower than lib-uni's `FetchLike` (no leading
 * `Context`, no `FetchConfig`) for two reasons: it is exactly what
 * graphql-request calls, and it keeps this ported sor-providers layer free of
 * a UNI `Context` dependency — the same reason the layer wraps `Logger` and
 * `IMetric` rather than taking `ctx`.
 */

import {FetchConfig} from '@uniswap/lib-uni';
import {Context} from '@uniswap/lib-uni/context';
import {ErrTimeout, isErrTimeout} from '@uniswap/lib-middlewares/client';

export type SubgraphFetch = (
  // eslint-disable-next-line n/no-unsupported-features/node-builtins
  input: string | URL | Request,
  init?: RequestInit
  // eslint-disable-next-line n/no-unsupported-features/node-builtins
) => Promise<Response>;

export interface SubgraphFetchOptions {
  /**
   * The provider's own `timeout` — the deadline it races the WHOLE `getPools`
   * against (every shard, page and retry). Used here only as a CEILING on the
   * per-request budget, never as the budget itself: a per-request deadline
   * equal to the whole-run deadline can never fire before the run is already
   * over, which would leave an abandoned page holding its socket past the job
   * budget and past the cron's overlap guard.
   */
  runTimeoutMs: number;
  /** Bounded metric dimensions so an operator can tell WHICH subgraph broke. */
  chainId: number | string;
  protocol: string;
}

/**
 * Each provider carries its own budget, so the transport is supplied as a
 * factory the provider binds rather than as an already-bound fetch.
 */
export type SubgraphFetchFactory = (
  opts: SubgraphFetchOptions
) => SubgraphFetch;

/**
 * Static replacement for the `path` dimension on every `client.*` metric these
 * calls emit.
 *
 * `metricMiddleware` derives `path` from `sanitizePath(url.pathname)`, and
 * `sanitizePath` only redacts segments >= 40 characters. 21 of the subgraph
 * URLs in `cacheConfig.ts` carry the Goldsky API key as a path segment
 * (`/api/private/${GOLD_SKY_API_KEY}/subgraphs/...`), so whether the key is
 * redacted would otherwise depend on how long that secret happens to be — a
 * property no one can see from the repo and that rotates outside it. Pinning a
 * bounded literal removes the dependency entirely, and it cannot regress when
 * a new subgraph URL shape is added.
 *
 * The `to` (host) dimension still separates goldsky / thegraph / ellipfra,
 * and `chainid` / `protocol` (below) identify the individual subgraph.
 */
export const SUBGRAPH_METRIC_PATH = '/{subgraph}';

/**
 * Deadline for ONE HTTP request (headers AND body), as distinct from the
 * provider's whole-run budget.
 *
 * 30s matches the base providers' own default whole-run `timeout`, so it is
 * generous for a single page of <= `PAGE_SIZE` entities while staying small
 * enough that the retries wrapped around `getPools` remain usable inside the
 * tightest job budget in the fleet — the 2-minute Robinhood V4 fast job, whose
 * per-run ceiling is 110s (`POOL_CACHING_ROBINHOOD_V4_JOB_TIMEOUT_MS`) against
 * a 90s provider budget. At 30s a failed page leaves room for three attempts
 * inside that job; at 90s it left room for one.
 *
 * Keeping this well under 300s also keeps undici's DEFAULT `headersTimeout` /
 * `bodyTimeout` (300s on Node 22, and nothing here installs a dispatcher) out
 * of reach. That matters for diagnosis, not just duration: a 300s undici cap
 * surfaces as `TypeError: fetch failed` / `UND_ERR_HEADERS_TIMEOUT`, which
 * lands as a generic `status:error` and leaves `client.timeout` flat, whereas
 * our own abort raises `ErrTimeout` and is counted as `client.timeout`.
 */
export const SUBGRAPH_PAGE_TIMEOUT_MS = 30_000;

/**
 * The per-request budget: the page budget, or the provider's whole-run budget
 * when that is tighter (a per-request deadline must never exceed the deadline
 * for the run containing it).
 *
 * Note this leaves the four deliberately long whole-run budgets in
 * `cacheConfig.ts` (V3 Base 900s, V3 Zora 360s, V2 mainnet 1,200s, V2 Base
 * 900s) enforced exactly as before by the providers' own `await-timeout` race.
 * Those are budgets for a whole multi-page crawl, not for one request, so they
 * neither need nor want a 900s socket deadline.
 */
export function subgraphPageTimeoutMs(runTimeoutMs: number): number {
  return Math.min(SUBGRAPH_PAGE_TIMEOUT_MS, runTimeoutMs);
}

/**
 * Kill switch. This repo auto-promotes to prod on merge and the pool-caching
 * cron runs in a blue/green task an ALB rollback does not stop, so without
 * this a bad transport needs a revert PR plus a full deploy cycle. The
 * transport argument is optional at every seam, so withholding the factory is
 * an exact restore of the pre-migration `cross-fetch` behaviour.
 *
 * Default ON. Read with `'String'` semantics and compared `!== 'false'` after
 * a `.trim()`: config values are stored verbatim, nothing downstream trims,
 * and a fail-open switch must not be flipped by `"false\n"` looking like a
 * value it does not recognise — nor left silently on by it.
 */
export const SUBGRAPH_CTX_FETCH_ENV = 'POOL_CACHING_SUBGRAPH_CTX_FETCH_ENABLED';

export function subgraphCtxFetchEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return (env[SUBGRAPH_CTX_FETCH_ENV] ?? '').trim() !== 'false';
}

const BODY_TIMEOUT_METRIC = 'client.timeout';

function serviceName(): string {
  return (
    process.env.POWERTOOLS_SERVICE_NAME ||
    process.env.SERVICE_NAME ||
    'uniroute'
  );
}

function hostOrUndefined(
  // eslint-disable-next-line n/no-unsupported-features/node-builtins
  input: string | URL | Request
): string | undefined {
  try {
    return typeof input === 'string'
      ? new URL(input).host
      : input instanceof URL
        ? input.host
        : new URL(input.url).host;
  } catch {
    return undefined;
  }
}

/**
 * Reads the whole body inside `budgetMs`, cancelling the stream on expiry, and
 * hands back a Response carrying the buffered bytes.
 *
 * This closes the one gap the middleware cannot: `timeoutMiddleware` clears its
 * abort timer the moment `fetch` resolves, which is when HEADERS arrive, and
 * graphql-request reads the body itself afterwards. A subgraph that answers
 * headers and then stalls on the JSON would otherwise be metered
 * `status:200` by `metricMiddleware` while the cron job dies around it, bounded
 * only by undici's 300s-per-chunk default.
 *
 * The middleware's own signal cannot be reused for this: it removes its
 * listener from the caller's signal in its `finally`, so once headers land
 * nothing outside the middleware can abort the in-flight body. Draining here
 * and re-wrapping is what makes the deadline cover the whole exchange without
 * a custom dispatcher (`undici` is not a declared dependency of this service).
 * Buffering costs nothing extra: graphql-request calls `response.json()`, so
 * the body was always going to be read into memory in one piece.
 *
 * Mirrors `unirouteFetch`'s `readBodyWithin` / `countBodyReadTimeout`.
 */
async function drainWithin(
  ctx: Context,
  // eslint-disable-next-line n/no-unsupported-features/node-builtins
  response: Response,
  budgetMs: number,
  dimensions: Record<string, string>
  // eslint-disable-next-line n/no-unsupported-features/node-builtins
): Promise<Response> {
  const reader = response.body?.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let text: string;
  try {
    text = await Promise.race([
      reader ? drain(reader) : response.text(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          void reader?.cancel().catch(() => {});
          reject(new ErrTimeout(budgetMs));
        }, budgetMs);
      }),
    ]);
  } catch (err) {
    // metricMiddleware metered this call off its headers the moment fetch
    // resolved — client.status/client.latency already say e.g. 200 — and this
    // timeout fires outside the middleware stack, so without a counter here a
    // stalled-body incident reads as 100% vendor success in client.*.
    if (isErrTimeout(err)) {
      await ctx.metrics
        .count(BODY_TIMEOUT_METRIC, 1, {dimensions})
        .catch(() => undefined);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  // Headers are copied so graphql-request's Content-Type sniff still works.
  // eslint-disable-next-line n/no-unsupported-features/node-builtins
  return new Response(text, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

// Structural, so this file never names the web-stream globals — same reason
// `unirouteFetch.ts` declares its own `ByteReader`.
type ByteReader = {read: () => Promise<{done: boolean; value?: Uint8Array}>};

async function drain(reader: ByteReader): Promise<string> {
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    if (value) out += decoder.decode(value, {stream: true});
  }
  return out + decoder.decode();
}

/**
 * Builds the factory from a UNI context. `ctx.fetch` needs a fetcher on the
 * context: request middleware installs one on the serving path, and worker /
 * boot-time entrypoints must call `installWorkerFetcher` first, or every call
 * throws `ErrorContextKeyNotFound`.
 */
export function subgraphFetchFactoryFromContext(
  ctx: Context
): SubgraphFetchFactory {
  return ({runTimeoutMs, chainId, protocol}: SubgraphFetchOptions) => {
    const timeoutMs = subgraphPageTimeoutMs(runTimeoutMs);
    // `path` is pinned rather than URL-derived (see SUBGRAPH_METRIC_PATH), and
    // chainid/protocol identify the individual subgraph: `to` collapses all 65
    // subgraph URLs onto 3 vendor hosts, so without them an operator cannot
    // tell which one broke. Bounded at ~63 chain x protocol combinations.
    //
    // WHERE THESE TAGS ARE QUERYABLE. The middleware emits four metrics and
    // they do not behave alike, because none of them is covered by any
    // `MetricTagConfiguration` (the routing include-list in
    // `packages/infra/datadog-cloud/monitors/routing/metric-tag-configs.ts`
    // applies only to `UNIROUTE_DIST_METRIC_NAMES`, which has no `client.*`
    // entry):
    //   - `client.total` / `client.status` / `client.timeout` are COUNTS
    //     (`ctx.metrics.count`). Counts are not subject to the distribution
    //     auto-allowlist, so chainid/protocol/vendor are queryable — group
    //     `client.status` by them to see which subgraph is failing. This is
    //     the path to rely on.
    //   - `client.latency.dist` is a DISTRIBUTION (`ctx.metrics.timer` appends
    //     `.dist`). Datadog auto-allowlists a small tag set on a
    //     distribution's FIRST emission and a group-by on a dropped tag
    //     returns `disabled_tags`; percentiles additionally need
    //     `includePercentiles`. So a per-subgraph LATENCY PERCENTILE may not
    //     be available. That needs a Pulumi change to the shared
    //     datadog-cloud project (adding these metric names to a tag
    //     configuration) — deliberately not done from this service.
    // Cost is not a concern either way: `client.latency.dist` has been
    // emitting since the axios migration, so its allowlist is already fixed
    // and these keys cannot expand it.
    const metricTags = {
      vendor: 'subgraph',
      path: SUBGRAPH_METRIC_PATH,
      chainid: String(chainId),
      protocol: String(protocol),
    };
    return async (input, init) => {
      const startedAt = Date.now();
      // metricTags are spread AFTER the middleware's own dimensions
      // (lib-middlewares/client/metrics.ts), which is what lets `path`
      // displace the URL-derived one. Applied here rather than per provider so
      // every caller of the factory is covered and a new provider cannot
      // forget it.
      const response = await ctx.fetch(
        input,
        init,
        new FetchConfig({timeoutMs, metricTags})
      );
      // ONE deadline spans headers and body: the read gets what is LEFT of
      // timeoutMs, never a fresh budget.
      return drainWithin(
        ctx,
        response,
        Math.max(0, startedAt + timeoutMs - Date.now()),
        {
          to: hostOrUndefined(input) ?? 'unknown',
          service: serviceName(),
          ...metricTags,
        }
      );
    };
  };
}
