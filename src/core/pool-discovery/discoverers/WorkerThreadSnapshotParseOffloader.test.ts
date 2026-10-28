import {afterEach, describe, expect, it, vi} from 'vitest';
import {join} from 'node:path';
import {buildTestContext} from '@uniswap/lib-testhelpers';
import {TestMetric} from '@uniswap/lib-testhelpers/testMetrics';
import {MetricOptions} from '@uniswap/lib-uni';
import {
  IWorkerHandle,
  resolveDefaultWorkerScriptPath,
  WorkerThreadSnapshotParseOffloader,
} from './WorkerThreadSnapshotParseOffloader';
import {SNAPSHOT_PARSE_WIRE_CHUNK_POOLS} from '../../../workers/snapshotParseWorker';
import {
  FakeSnapshotParseWorkerHandle,
  realSnapshotParseWorkerResponses,
} from '../../../../tests/test-utils/FakeSnapshotParseWorkerHandle';
import {
  SNAPSHOT_PARSE_OFFLOAD_METRIC,
  SnapshotParseOffloadError,
  SnapshotParseOffloadFailureReason,
} from './SnapshotParseOffloader';
import {
  SnapshotTransformResult,
  transformSnapshotPoolBytes,
} from './s3SnapshotTransform';
import {ChainId} from '../../../lib/config';
import {Protocol} from '../../../models/pool/Protocol';
import {UniPoolInfo} from '../interface';

const CHAIN_ID = ChainId.MAINNET;
const PROTOCOL = Protocol.V3;
const PARAMS = {chainId: CHAIN_ID, protocol: PROTOCOL};

// Snapshot-shaped V3 records (feeTier and liquidity strings, TVL numbers, as
// the S3 snapshot in tests/data/v3-pools.json.gz stores them).
const snapshotBytes = (count: number): Uint8Array =>
  new TextEncoder().encode(
    JSON.stringify(
      Array.from({length: count}, (_, index) => ({
        id: `0xpool${index}`,
        token0: {id: '0xDEF'},
        token1: {id: '0x123'},
        liquidity: '1',
        tvlETH: 1,
        tvlUSD: 1,
        feeTier: '3000',
      }))
    )
  );
const POOL_BYTES = snapshotBytes(1);

function takeNextHandle(
  handles: FakeSnapshotParseWorkerHandle[]
): FakeSnapshotParseWorkerHandle {
  const handle = handles.shift();
  if (!handle) {
    throw new Error(
      'Test factory ran out of prepared FakeSnapshotParseWorkerHandles'
    );
  }
  return handle;
}

/** TestMetric, but keeping each count's tags. */
class FakeRecordingMetrics extends TestMetric {
  public readonly counts: {name: string; val: number; tags: string[]}[] = [];

  override async count(
    metric_name: string,
    val: number,
    opts?: MetricOptions
  ): Promise<void> {
    this.counts.push({name: metric_name, val, tags: [...(opts?.tags ?? [])]});
    await super.count(metric_name, val, opts);
  }
}

function recordingContext() {
  const ctx = buildTestContext();
  const metrics = new FakeRecordingMetrics();
  ctx.metrics = metrics;
  return {ctx, metrics};
}

const offloadTags = (metrics: FakeRecordingMetrics): string[][] =>
  metrics.counts
    .filter(count => count.name === SNAPSHOT_PARSE_OFFLOAD_METRIC)
    .map(count => count.tags);

const poolIds = (result: SnapshotTransformResult): string[] =>
  result.pools.map((pool: UniPoolInfo) => pool.id);

async function expectOffloadFailure(
  promise: Promise<SnapshotTransformResult>,
  reason: SnapshotParseOffloadFailureReason
): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (rejection: unknown) => rejection
  );
  expect(error).toBeInstanceOf(SnapshotParseOffloadError);
  expect(error instanceof SnapshotParseOffloadError && error.reason).toBe(
    reason
  );
}

const newOffloader = (
  factory: () => IWorkerHandle,
  {
    poolSize = 1,
    jobTimeoutMs = 1_000,
    queueTimeoutMs = 1_000,
  }: {poolSize?: number; jobTimeoutMs?: number; queueTimeoutMs?: number} = {}
) =>
  new WorkerThreadSnapshotParseOffloader(
    factory,
    poolSize,
    jobTimeoutMs,
    queueTimeoutMs
  );

describe('resolveDefaultWorkerScriptPath', () => {
  it('resolves to dist/workers/snapshotParseWorker.mjs under the current working directory', () => {
    // Anchored on process.cwd(), not import.meta.url: the image's WORKDIR is
    // the same whichever entry point this module is bundled into.
    expect(resolveDefaultWorkerScriptPath()).toBe(
      join(process.cwd(), 'dist', 'workers', 'snapshotParseWorker.mjs')
    );
  });

  it('resolves under a given base directory', () => {
    expect(resolveDefaultWorkerScriptPath('/var/task')).toBe(
      '/var/task/dist/workers/snapshotParseWorker.mjs'
    );
  });
});

describe('WorkerThreadSnapshotParseOffloader', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with the transform result the worker computed and counts a success', async () => {
    const handles: FakeSnapshotParseWorkerHandle[] = [];
    const offloader = newOffloader(
      () => {
        const handle = new FakeSnapshotParseWorkerHandle();
        handles.push(handle);
        return handle;
      },
      {poolSize: 2}
    );
    const {ctx, metrics} = recordingContext();

    const result = await offloader.parseAndFilterSnapshot(
      POOL_BYTES,
      PARAMS,
      ctx
    );

    expect(result).toEqual(transformSnapshotPoolBytes(POOL_BYTES, PARAMS));
    expect(handles).toHaveLength(1);
    expect(offloadTags(metrics)).toEqual([
      ['chain:MAINNET', 'protocol:v3', 'status:success'],
    ]);
  });

  it('assembles a multi-chunk result in order', async () => {
    const poolCount = SNAPSHOT_PARSE_WIRE_CHUNK_POOLS * 2 + 5;
    const bytes = snapshotBytes(poolCount);
    let chunkMessages = 0;
    const offloader = newOffloader(
      () =>
        new FakeSnapshotParseWorkerHandle(request => {
          const responses = realSnapshotParseWorkerResponses(request);
          chunkMessages = responses.filter(
            response => response.status === 'chunk'
          ).length;
          return responses;
        })
    );

    const result = await offloader.parseAndFilterSnapshot(
      bytes,
      PARAMS,
      buildTestContext()
    );

    expect(chunkMessages).toBe(3);
    expect(result).toEqual(transformSnapshotPoolBytes(bytes, PARAMS));
  });

  it('carries the skipped-record counts across the worker boundary', async () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify([
        {
          id: '0xgood',
          token0: {id: '0xa'},
          token1: {id: '0xb'},
          liquidity: '1',
          tvlETH: 1,
          tvlUSD: 1,
          feeTier: '3000',
        },
        {id: '0xbad', token0: {id: '0xa'}, token1: {id: '0xb'}},
      ])
    );
    const offloader = newOffloader(() => new FakeSnapshotParseWorkerHandle());

    const result = await offloader.parseAndFilterSnapshot(
      bytes,
      PARAMS,
      buildTestContext()
    );

    expect(poolIds(result)).toEqual(['0xgood']);
    expect(result.skippedRecords).toEqual({shape_mismatch: 1});
  });

  it('bounds concurrent worker creation to the configured pool size', async () => {
    let created = 0;
    const offloader = newOffloader(
      () => {
        created++;
        return new FakeSnapshotParseWorkerHandle(() => 'hang');
      },
      {poolSize: 2, jobTimeoutMs: 60_000, queueTimeoutMs: 60_000}
    );
    const ctx = buildTestContext();

    for (let i = 0; i < 5; i++) {
      offloader
        .parseAndFilterSnapshot(POOL_BYTES, PARAMS, ctx)
        .catch(() => undefined);
    }
    await Promise.resolve();
    await Promise.resolve();

    expect(created).toBe(2);
    await offloader.close();
  });

  it('reuses an idle worker for a subsequent job instead of creating a new one', async () => {
    let created = 0;
    const offloader = newOffloader(
      () => {
        created++;
        return new FakeSnapshotParseWorkerHandle();
      },
      {poolSize: 2}
    );
    const ctx = buildTestContext();

    await offloader.parseAndFilterSnapshot(POOL_BYTES, PARAMS, ctx);
    await offloader.parseAndFilterSnapshot(POOL_BYTES, PARAMS, ctx);

    expect(created).toBe(1);
  });

  it('rejects with reason worker_error and retires the worker when it errors (failure path)', async () => {
    const fakeHandle = new FakeSnapshotParseWorkerHandle(() => 'hang');
    const offloader = newOffloader(() => fakeHandle);
    const {ctx, metrics} = recordingContext();

    const resultPromise = offloader.parseAndFilterSnapshot(
      POOL_BYTES,
      PARAMS,
      ctx
    );
    await vi.waitFor(() => expect(fakeHandle.received).toHaveLength(1));
    fakeHandle.emitError(new Error('worker crashed'));

    await expectOffloadFailure(
      resultPromise,
      SnapshotParseOffloadFailureReason.WORKER_ERROR
    );
    expect(fakeHandle.terminated).toBe(true);
    expect(offloadTags(metrics)).toEqual([
      ['chain:MAINNET', 'protocol:v3', 'status:failure', 'reason:worker_error'],
    ]);
    expect(
      ctx.logger.outputs.some(
        entry =>
          entry.prefix === 'WARN:' &&
          entry.msg.includes('Worker snapshot parse failed')
      )
    ).toBe(true);
  });

  it('rejects with reason timeout when a job exceeds its timeout (failure path)', async () => {
    const fakeHandle = new FakeSnapshotParseWorkerHandle(() => 'hang');
    const offloader = newOffloader(() => fakeHandle, {jobTimeoutMs: 10});

    await expectOffloadFailure(
      offloader.parseAndFilterSnapshot(POOL_BYTES, PARAMS, buildTestContext()),
      SnapshotParseOffloadFailureReason.TIMEOUT
    );
    expect(fakeHandle.terminated).toBe(true);
  });

  it('rejects with reason worker_exited when a worker exits without erroring (failure path)', async () => {
    const fakeHandle = new FakeSnapshotParseWorkerHandle(() => 'hang');
    const offloader = newOffloader(() => fakeHandle);

    const resultPromise = offloader.parseAndFilterSnapshot(
      POOL_BYTES,
      PARAMS,
      buildTestContext()
    );
    await vi.waitFor(() => expect(fakeHandle.received).toHaveLength(1));
    fakeHandle.emitExit(1);

    await expectOffloadFailure(
      resultPromise,
      SnapshotParseOffloadFailureReason.WORKER_EXITED
    );
  });

  it('does not double-process a worker that both errors and then exits', async () => {
    const fakeHandle = new FakeSnapshotParseWorkerHandle(() => 'hang');
    const offloader = newOffloader(() => fakeHandle);
    const {ctx, metrics} = recordingContext();

    const resultPromise = offloader.parseAndFilterSnapshot(
      POOL_BYTES,
      PARAMS,
      ctx
    );
    await vi.waitFor(() => expect(fakeHandle.received).toHaveLength(1));
    fakeHandle.emitError(new Error('worker crashed'));
    expect(() => fakeHandle.emitExit(1)).not.toThrow();

    await expectOffloadFailure(
      resultPromise,
      SnapshotParseOffloadFailureReason.WORKER_ERROR
    );
    expect(offloadTags(metrics)).toHaveLength(1);
  });

  it('recycles a worker after it errors instead of reusing it for the next job', async () => {
    const firstHandle = new FakeSnapshotParseWorkerHandle(() => 'hang');
    const secondHandle = new FakeSnapshotParseWorkerHandle();
    const handles = [firstHandle, secondHandle];
    const offloader = newOffloader(() => takeNextHandle(handles));
    const ctx = buildTestContext();

    const resultPromise = offloader.parseAndFilterSnapshot(
      POOL_BYTES,
      PARAMS,
      ctx
    );
    await vi.waitFor(() => expect(firstHandle.received).toHaveLength(1));
    firstHandle.emitError(new Error('worker crashed'));
    await resultPromise.catch(() => undefined);

    await offloader.parseAndFilterSnapshot(POOL_BYTES, PARAMS, ctx);

    expect(secondHandle.received).toHaveLength(1);
  });

  it('relays a transform error from the worker as a plain error with reason transform_error (failure path)', async () => {
    const fakeHandle = new FakeSnapshotParseWorkerHandle(request => [
      {id: request.id, status: 'error', errorMessage: 'malformed snapshot'},
    ]);
    const offloader = newOffloader(() => fakeHandle);
    const {ctx, metrics} = recordingContext();

    const error = await offloader
      .parseAndFilterSnapshot(POOL_BYTES, PARAMS, ctx)
      .then(
        () => undefined,
        (rejection: unknown) => rejection
      );

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(SnapshotParseOffloadError);
    expect(offloadTags(metrics)).toEqual([
      [
        'chain:MAINNET',
        'protocol:v3',
        'status:failure',
        'reason:transform_error',
      ],
    ]);
  });

  it('rejects with reason worker_error when a chunk cannot be decoded (failure path)', async () => {
    const offloader = newOffloader(
      () =>
        new FakeSnapshotParseWorkerHandle(request => [
          {
            id: request.id,
            status: 'chunk',
            poolsJson: new TextEncoder().encode('{not json'),
          },
          {id: request.id, status: 'done', skippedRecords: {}},
        ])
    );

    await expectOffloadFailure(
      offloader.parseAndFilterSnapshot(POOL_BYTES, PARAMS, buildTestContext()),
      SnapshotParseOffloadFailureReason.WORKER_ERROR
    );
  });

  it('discards a late response for a job that already timed out, without throwing', async () => {
    let capturedId: number | undefined;
    const fakeHandle = new FakeSnapshotParseWorkerHandle(request => {
      capturedId = request.id;
      return 'hang';
    });
    const offloader = newOffloader(() => fakeHandle, {jobTimeoutMs: 10});

    await offloader
      .parseAndFilterSnapshot(POOL_BYTES, PARAMS, buildTestContext())
      .catch(() => undefined);
    if (capturedId === undefined) {
      throw new Error('Expected a request id to have been captured');
    }
    const requestId: number = capturedId;
    expect(() =>
      fakeHandle.deliverLateResponse({
        id: requestId,
        status: 'done',
        skippedRecords: {},
      })
    ).not.toThrow();
  });

  it('hands a just-freed worker slot to a queued job instead of leaving it stuck', async () => {
    const firstHandle = new FakeSnapshotParseWorkerHandle(() => 'hang');
    const secondHandle = new FakeSnapshotParseWorkerHandle();
    const handles = [firstHandle, secondHandle];
    const offloader = newOffloader(() => takeNextHandle(handles));
    const ctx = buildTestContext();

    const firstResult = offloader.parseAndFilterSnapshot(
      POOL_BYTES,
      PARAMS,
      ctx
    );
    await vi.waitFor(() => expect(firstHandle.received).toHaveLength(1));
    const secondResultPromise = offloader.parseAndFilterSnapshot(
      POOL_BYTES,
      PARAMS,
      ctx
    );
    firstHandle.emitError(new Error('worker crashed'));
    await firstResult.catch(() => undefined);
    const secondResult = await secondResultPromise;

    expect(poolIds(secondResult)).toEqual(['0xpool0']);
    expect(secondHandle.received).toHaveLength(1);
  });

  it('rejects a queued job (instead of crashing the process) when the replacement worker fails to construct', async () => {
    const firstHandle = new FakeSnapshotParseWorkerHandle(() => 'hang');
    let constructCount = 0;
    const offloader = newOffloader(() => {
      constructCount++;
      if (constructCount === 1) {
        return firstHandle;
      }
      throw new Error('ERR_WORKER_PATH: invalid worker script path');
    });
    const ctx = buildTestContext();

    const firstResult = offloader.parseAndFilterSnapshot(
      POOL_BYTES,
      PARAMS,
      ctx
    );
    await vi.waitFor(() => expect(firstHandle.received).toHaveLength(1));
    const secondResultPromise = offloader.parseAndFilterSnapshot(
      POOL_BYTES,
      PARAMS,
      ctx
    );
    firstHandle.emitError(new Error('worker crashed'));
    await firstResult.catch(() => undefined);

    await expectOffloadFailure(
      secondResultPromise,
      SnapshotParseOffloadFailureReason.WORKER_ERROR
    );
  });

  it('rejects a job that waits longer than the queue timeout for a worker (failure path)', async () => {
    vi.useFakeTimers();
    const firstHandle = new FakeSnapshotParseWorkerHandle(() => 'hang');
    const offloader = newOffloader(() => firstHandle, {
      jobTimeoutMs: 60_000,
      queueTimeoutMs: 500,
    });
    const {ctx, metrics} = recordingContext();

    const firstResult = offloader.parseAndFilterSnapshot(
      POOL_BYTES,
      PARAMS,
      ctx
    );
    firstResult.catch(() => undefined);
    await vi.waitFor(() => expect(firstHandle.received).toHaveLength(1));
    const queuedResult = offloader.parseAndFilterSnapshot(
      POOL_BYTES,
      PARAMS,
      ctx
    );
    const queuedOutcome = expectOffloadFailure(
      queuedResult,
      SnapshotParseOffloadFailureReason.QUEUE_TIMEOUT
    );

    await vi.advanceTimersByTimeAsync(500);
    await queuedOutcome;

    // The timed-out job left the queue: it was never posted to the worker.
    expect(firstHandle.received).toHaveLength(1);
    expect(offloadTags(metrics)).toEqual([
      [
        'chain:MAINNET',
        'protocol:v3',
        'status:failure',
        'reason:queue_timeout',
      ],
    ]);
    await offloader.close();
  });

  describe('close()', () => {
    it('terminates every live worker', async () => {
      const handles: FakeSnapshotParseWorkerHandle[] = [];
      const offloader = newOffloader(
        () => {
          const handle = new FakeSnapshotParseWorkerHandle();
          handles.push(handle);
          return handle;
        },
        {poolSize: 2}
      );
      await offloader.parseAndFilterSnapshot(
        POOL_BYTES,
        PARAMS,
        buildTestContext()
      );

      await offloader.close();

      expect(handles.every(handle => handle.terminated)).toBe(true);
    });

    it('rejects an in-flight job and a queued job with reason pool_closed', async () => {
      const fakeHandle = new FakeSnapshotParseWorkerHandle(() => 'hang');
      const offloader = newOffloader(() => fakeHandle, {
        jobTimeoutMs: 60_000,
        queueTimeoutMs: 60_000,
      });
      const ctx = buildTestContext();

      const inFlight = offloader.parseAndFilterSnapshot(
        POOL_BYTES,
        PARAMS,
        ctx
      );
      await vi.waitFor(() => expect(fakeHandle.received).toHaveLength(1));
      const queued = offloader.parseAndFilterSnapshot(POOL_BYTES, PARAMS, ctx);

      await offloader.close();

      await expectOffloadFailure(
        inFlight,
        SnapshotParseOffloadFailureReason.POOL_CLOSED
      );
      await expectOffloadFailure(
        queued,
        SnapshotParseOffloadFailureReason.POOL_CLOSED
      );
      expect(fakeHandle.terminated).toBe(true);
    });

    it('rejects a new job submitted after close (failure path)', async () => {
      const offloader = newOffloader(() => new FakeSnapshotParseWorkerHandle());
      await offloader.close();

      await expectOffloadFailure(
        offloader.parseAndFilterSnapshot(
          POOL_BYTES,
          PARAMS,
          buildTestContext()
        ),
        SnapshotParseOffloadFailureReason.POOL_CLOSED
      );
    });
  });
});
