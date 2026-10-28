import {Context} from '@uniswap/lib-uni/context';
import {buildMetricKey, ChainId} from '../../../lib/config';
import {
  SnapshotTransformParams,
  SnapshotTransformResult,
  transformSnapshotPoolBytes,
} from './s3SnapshotTransform';

export const SNAPSHOT_PARSE_OFFLOAD_METRIC = buildMetricKey(
  'PoolDiscoverer.SnapshotParseOffload'
);

export enum SnapshotParseOffloadFailureReason {
  TIMEOUT = 'timeout',
  QUEUE_TIMEOUT = 'queue_timeout',
  WORKER_EXITED = 'worker_exited',
  WORKER_ERROR = 'worker_error',
  POOL_CLOSED = 'pool_closed',
  WORKER_SCRIPT_MISSING = 'worker_script_missing',
  // Not an offload failure: the worker ran the transform and it threw.
  TRANSFORM_ERROR = 'transform_error',
}

// The offloaded parse did not produce a snapshot. The caller decides what to
// serve instead (see BaseS3SubgraphPoolDiscoverer.fetchSnapshot): the held
// snapshot while it is still within the stale-serve bound, else a main-thread
// parse.
export class SnapshotParseOffloadError extends Error {
  constructor(
    readonly reason: SnapshotParseOffloadFailureReason,
    message: string,
    options?: {cause?: unknown}
  ) {
    super(message, options);
    this.name = 'SnapshotParseOffloadError';
  }
}

export function snapshotParseOffloadMetricTags(
  params: SnapshotTransformParams
): string[] {
  return [`chain:${ChainId[params.chainId]}`, `protocol:${params.protocol}`];
}

// Parses and filters a decompressed (but not yet utf-8-decoded) pool-snapshot
// byte buffer into typed pools. Implementations decide WHERE that work runs
// (this thread vs. a worker_threads pool), not WHAT it computes: every
// implementation returns transformSnapshotPoolBytes's result for the input.
export interface ISnapshotParseOffloader {
  // Rejects with SnapshotParseOffloadError when the work could not run where
  // the implementation runs it; any other rejection is a transform error
  // (an unusable snapshot body).
  parseAndFilterSnapshot(
    poolBytes: Uint8Array,
    params: SnapshotTransformParams,
    ctx: Context
  ): Promise<SnapshotTransformResult>;
  // Releases any resources held for this offloader's lifetime (e.g. a
  // worker_threads pool). A no-op for implementations that hold none, so
  // callers can always call it unconditionally during shutdown.
  close(): Promise<void>;
}

// Runs the parse+filter synchronously on the caller's event loop. Used when
// the worker-thread offload is disabled
// (POOL_DISCOVERY_SNAPSHOT_PARSE_OFFLOAD_ENABLED=false), and when it is
// enabled but the worker script is missing from the image: then
// `degradedReason` is set and every parse counts a failure, so a broken image
// does not look healthy.
export class MainThreadSnapshotParseOffloader implements ISnapshotParseOffloader {
  constructor(
    private readonly degradedReason?: SnapshotParseOffloadFailureReason
  ) {}

  async parseAndFilterSnapshot(
    poolBytes: Uint8Array,
    params: SnapshotTransformParams,
    ctx: Context
  ): Promise<SnapshotTransformResult> {
    if (this.degradedReason !== undefined) {
      void ctx.metrics
        .count(SNAPSHOT_PARSE_OFFLOAD_METRIC, 1, {
          tags: [
            ...snapshotParseOffloadMetricTags(params),
            'status:failure',
            `reason:${this.degradedReason}`,
          ],
        })
        .catch(() => undefined);
    }
    return transformSnapshotPoolBytes(poolBytes, params);
  }

  async close(): Promise<void> {
    // No resources to release — the parse runs on the caller's own thread.
  }
}
