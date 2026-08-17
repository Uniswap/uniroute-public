import {ClientError} from 'graphql-request';

import {Logger} from './log';
import {IMetric, MetricLoggerUnit} from './metric';

export interface SalvagedSubgraphResponse<TData> {
  data: TData;
  errorMessages: string[];
}

// Non-fatal graph-node indexing errors, matched loosely so a provider
// wording change doesn't silently re-break the cron (Goldsky's exact string
// today is "indexing_error"; block-pinned queries say "indexed up to").
// Loose-but-present is deliberate: data presence ALONE must not salvage,
// because a data-carrying non-indexing error (e.g. a resolver error that
// ignores the pagination cursor) could otherwise be accepted repeatedly.
const INDEXING_ERROR_PATTERN = /indexing[\s_-]?error|indexed up to/i;

/**
 * The subgraph queries pass `subgraphError: allow`, so a subgraph stuck on a
 * deterministic (non-fatal) indexing error still returns data alongside an
 * `errors` array instead of failing outright. graphql-request, however,
 * throws a ClientError whenever the response carries `errors` — even when
 * usable data is present. This unwraps exactly that case: a ClientError
 * whose EVERY error message looks like an indexing error and whose response
 * data holds the expected root field (`list` = must be an array; `entity` =
 * key present, object or null).
 *
 * Returns undefined for everything else (transport errors, fatal subgraph
 * errors, non-indexing GraphQL errors, malformed responses) so callers
 * rethrow and keep today's retry/failure behavior.
 */
export function salvageAllowedSubgraphError<
  TData extends Record<string, unknown>,
>(
  err: unknown,
  rootField: keyof TData & string,
  expect: 'list' | 'entity' = 'list'
): SalvagedSubgraphResponse<TData> | undefined {
  if (!(err instanceof ClientError)) {
    return undefined;
  }
  const errors = err.response?.errors;
  if (
    !errors?.length ||
    !errors.every(e => INDEXING_ERROR_PATTERN.test(e.message))
  ) {
    return undefined;
  }
  const data = err.response?.data as TData | undefined;
  if (!data || typeof data !== 'object') {
    return undefined;
  }
  if (
    expect === 'list' ? !Array.isArray(data[rootField]) : !(rootField in data)
  ) {
    return undefined;
  }
  return {
    data,
    errorMessages: errors.map(e => e.message),
  };
}

/**
 * Salvage wrapper for provider request sites: returns the data when the
 * thrown error is a non-fatal allow-flag response, rethrows the original
 * error otherwise. Salvaged responses emit a warn log and the
 * `SubgraphProvider.subgraphErrorAllowed` metric — nothing downstream
 * inspects the subgraph error flag, so this is what keeps degraded data
 * from arriving silently.
 */
export function salvageAllowedSubgraphErrorOrRethrow<
  TData extends Record<string, unknown>,
>(opts: {
  err: unknown;
  rootField: keyof TData & string;
  expect?: 'list' | 'entity';
  /** e.g. "V4 high liquidity pools shard 2/4 page 3" — appended to a stable log prefix */
  label: string;
  logger?: Logger;
  metric?: IMetric;
  metricTags?: Record<string, string>;
}): TData {
  const salvaged = salvageAllowedSubgraphError<TData>(
    opts.err,
    opts.rootField,
    opts.expect ?? 'list'
  );
  if (!salvaged) {
    throw opts.err;
  }
  opts.logger?.warn(
    `Subgraph returned data alongside a non-fatal error for ${opts.label}`,
    {subgraphErrorMessages: salvaged.errorMessages}
  );
  opts.metric?.putMetric(
    'SubgraphProvider.subgraphErrorAllowed',
    1,
    MetricLoggerUnit.Count,
    opts.metricTags
  );
  return salvaged.data;
}

const SUBGRAPH_META_QUERY =
  '{ _meta(subgraphError: allow) { block { number } } }';

type SubgraphMetaResponse = {_meta: {block: {number: number}} | null};

/**
 * Best-effort probe run after a getPools pass that salvaged at least one
 * page: reads the subgraph's own indexed head (`_meta.block.number`) and
 * emits it as the `SubgraphProvider.subgraphErrorAllowed.metaBlock` gauge.
 *
 * This is what separates "tolerating a non-fatal error while the subgraph
 * advances at chain head" (gauge keeps climbing) from "saving snapshots
 * built from data frozen at the failure block" (gauge goes flat) — without
 * it, the salvage counter alone can't tell those apart. Never throws: an
 * observability probe must not add a failure mode to the salvage path.
 */
export async function emitSalvagedSubgraphMetaBlock(opts: {
  // Structurally satisfied by GraphQLClient; typed to the one query this
  // helper issues so test fakes can return the concrete shape.
  client: {request(query: string): Promise<SubgraphMetaResponse>};
  logger?: Logger;
  metric?: IMetric;
  metricTags?: Record<string, string>;
}): Promise<void> {
  try {
    let result: SubgraphMetaResponse;
    try {
      result = await opts.client.request(SUBGRAPH_META_QUERY);
    } catch (err) {
      const salvaged = salvageAllowedSubgraphError<SubgraphMetaResponse>(
        err,
        '_meta',
        'entity'
      );
      if (!salvaged) {
        return;
      }
      result = salvaged.data;
    }
    const blockNumber = result._meta?.block?.number;
    if (typeof blockNumber !== 'number') {
      return;
    }
    opts.logger?.warn(
      `Salvaged subgraph reports indexed head block ${blockNumber}`
    );
    opts.metric?.putGauge(
      'SubgraphProvider.subgraphErrorAllowed.metaBlock',
      blockNumber,
      opts.metricTags
    );
  } catch {
    // best-effort — never fail the caller over an observability probe
  }
}
