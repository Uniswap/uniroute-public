import {Worker, WorkerOptions} from 'node:worker_threads';
import {join} from 'node:path';
import {Context} from '@uniswap/lib-uni/context';
import {UniPoolInfo} from '../interface';
import {
  SnapshotTransformParams,
  SnapshotTransformResult,
} from './s3SnapshotTransform';
import {
  ISnapshotParseOffloader,
  SNAPSHOT_PARSE_OFFLOAD_METRIC,
  SnapshotParseOffloadError,
  SnapshotParseOffloadFailureReason,
  snapshotParseOffloadMetricTags,
} from './SnapshotParseOffloader';
import {
  decodePoolsFromWire,
  SnapshotParseWorkerRequest,
  SnapshotParseWorkerResponse,
} from '../../../workers/snapshotParseWorker';

// The subset of node:worker_threads' Worker API this pool uses, so the pool
// itself can be unit-tested against a closure-based Fake instead of spinning
// up real OS threads.
export interface IWorkerHandle {
  postMessage(message: SnapshotParseWorkerRequest): void;
  onMessage(listener: (response: SnapshotParseWorkerResponse) => void): void;
  onError(listener: (error: Error) => void): void;
  // A worker can exit WITHOUT ever emitting 'error' (e.g. it calls
  // process.exit() itself, or is killed) — the pool must still notice and
  // retire it instead of leaving its in-flight job hanging until the full
  // job timeout.
  onExit(listener: (exitCode: number) => void): void;
  terminate(): Promise<number>;
}

export class NodeWorkerThreadHandle implements IWorkerHandle {
  private readonly worker: Worker;

  constructor(
    workerScriptPath: string,
    resourceLimits?: WorkerOptions['resourceLimits']
  ) {
    this.worker = new Worker(workerScriptPath, {resourceLimits});
    // A worker thread must never by itself keep the process alive past
    // shutdown — matches the per-job timer's own `timeout.unref?.()` below.
    // Deterministic shutdown still goes through
    // WorkerThreadSnapshotParseOffloader.close(), which this unref doesn't
    // replace; it only prevents a forgotten worker from blocking exit.
    this.worker.unref();
  }

  postMessage(message: SnapshotParseWorkerRequest): void {
    this.worker.postMessage(message);
  }

  onMessage(listener: (response: SnapshotParseWorkerResponse) => void): void {
    this.worker.on('message', listener);
  }

  onError(listener: (error: Error) => void): void {
    this.worker.on('error', listener);
  }

  onExit(listener: (exitCode: number) => void): void {
    this.worker.on('exit', listener);
  }

  async terminate(): Promise<number> {
    return this.worker.terminate();
  }
}

// The esbuild-bundled image (containers/Dockerfile.ec2) and local dev/test
// tooling never share one answer for "where does this process's own code
// live" — process.cwd() is the one thing that DOES stay constant across
// every entry point this offloader can be bundled into.
//
// Why not import.meta.url (what this file used before): esbuild bundles
// src/workers/*.ts files as SEPARATE entry points (one output file per
// worker, e.g. dist/workers/snapshotParseWorker.mjs — the same mechanism the
// Dockerfile already relies on for dist/proto resolution, see its "Copy
// proto/ directory" step), but THIS file is not itself an entry point: it
// gets inlined into whichever entry imports it, at a DIFFERENT output
// location depending on the caller — dist/init.mjs (root) for the serving
// path, dist/workers/freshRequestsQueue.mjs (one level deeper) for the SQS
// worker. import.meta.url inside inlined code resolves to the bundle it was
// inlined INTO, so a path relative to it would mean two different things
// from the two entry points. process.cwd(), by contrast, is set once by
// containers/Dockerfile.ec2's `WORKDIR /var/task` and never overridden by
// any of this service's ECS commands (see infra/index.ts's absolute
// `/var/task/dist/workers/*.mjs` commands), so it is identical for every
// process this offloader can run in.
// `baseDir` defaults to process.cwd(); tests pass the directory they bundled
// the worker into.
export function resolveDefaultWorkerScriptPath(
  baseDir: string = process.cwd()
): string {
  return join(baseDir, 'dist', 'workers', 'snapshotParseWorker.mjs');
}

export function createNodeSnapshotParseWorkerHandle(
  workerScriptPath: string,
  resourceLimits?: WorkerOptions['resourceLimits']
): IWorkerHandle {
  return new NodeWorkerThreadHandle(workerScriptPath, resourceLimits);
}

interface PendingJob {
  resolve: (result: SnapshotTransformResult) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  // Pools decoded from the chunk messages received so far.
  pools: UniPoolInfo[];
}

interface PooledWorker {
  handle: IWorkerHandle;
  pending: Map<number, PendingJob>;
}

interface Waiter {
  resolve: (worker: PooledWorker) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

// A plain rejection is the transform's own error (an unusable snapshot body),
// relayed from the worker; it is not an offload failure.
function failureReasonOf(error: unknown): SnapshotParseOffloadFailureReason {
  return error instanceof SnapshotParseOffloadError
    ? error.reason
    : SnapshotParseOffloadFailureReason.TRANSFORM_ERROR;
}

// Bounded pool of persistent worker_threads workers that runs
// transformSnapshotPoolBytes's CPU-bound parse+filter off the request-serving
// event loop. One pool per process (see dependencies.ts's
// getOrCreateSnapshotParseOffloaderOnce), shared across every chain/protocol
// that refreshes a snapshot in it — spawning a worker per load would pay OS
// thread start-up on every re-parse and let concurrent chain refreshes
// exhaust process memory/CPU.
//
// Workers are never pipelined (one in-flight job each): the job is CPU-bound
// end to end, so a second job on the same worker would only queue inside it.
// Jobs queue here instead, for at most queueTimeoutMs.
//
// A worker error, exit, job timeout or queue timeout rejects with
// SnapshotParseOffloadError and counts status:failure with its reason. A
// transform error inside the worker (an unusable snapshot body) is relayed as
// the plain error the main-thread path would throw. There is no main-thread
// re-parse here: the caller keeps serving the snapshot it holds while that
// is still within the stale-serve bound (see
// BaseS3SubgraphPoolDiscoverer.fetchSnapshot), so a failing worker does not
// put the stall it exists to remove back on the event loop. The suspect
// worker is terminated and not returned to the idle pool.
export class WorkerThreadSnapshotParseOffloader implements ISnapshotParseOffloader {
  private readonly allWorkers = new Set<PooledWorker>();
  private readonly idleWorkers: PooledWorker[] = [];
  private readonly waiters: Waiter[] = [];
  private nextRequestId = 0;
  private closed = false;

  constructor(
    private readonly workerHandleFactory: () => IWorkerHandle,
    private readonly poolSize: number,
    private readonly jobTimeoutMs: number,
    private readonly queueTimeoutMs: number
  ) {}

  async parseAndFilterSnapshot(
    poolBytes: Uint8Array,
    params: SnapshotTransformParams,
    ctx: Context
  ): Promise<SnapshotTransformResult> {
    const metricTags = snapshotParseOffloadMetricTags(params);
    let result: SnapshotTransformResult;
    try {
      result = await this.runOnWorker(poolBytes, params);
    } catch (error) {
      const reason = failureReasonOf(error);
      ctx.logger.warn(
        '[WorkerThreadSnapshotParseOffloader] Worker snapshot parse failed',
        {
          chainId: params.chainId,
          protocol: params.protocol,
          reason,
          errorName: error instanceof Error ? error.name : typeof error,
          errorMessage: error instanceof Error ? error.message : undefined,
        }
      );
      void ctx.metrics
        .count(SNAPSHOT_PARSE_OFFLOAD_METRIC, 1, {
          tags: [...metricTags, 'status:failure', `reason:${reason}`],
        })
        .catch(() => undefined);
      throw error;
    }
    void ctx.metrics
      .count(SNAPSHOT_PARSE_OFFLOAD_METRIC, 1, {
        tags: [...metricTags, 'status:success'],
      })
      .catch(() => undefined);
    return result;
  }

  // Terminates every live worker and drops them from the pool so neither a
  // ref'd worker thread nor a ref'd timer can block process shutdown —
  // callers (e.g. freshRequestsQueue.ts's handleShutdown) should call this
  // alongside (not instead of) NodeWorkerThreadHandle's own unref, since
  // unref alone only stops an idle worker from blocking exit, not one with
  // an in-flight job.
  async close(): Promise<void> {
    this.closed = true;
    const workers = [...this.allWorkers];
    this.allWorkers.clear();
    this.idleWorkers.length = 0;
    const pendingWaiters = this.waiters.splice(0, this.waiters.length);
    for (const waiter of pendingWaiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(this.poolClosedError());
    }
    await Promise.all(
      workers.map(worker => {
        for (const job of worker.pending.values()) {
          clearTimeout(job.timeout);
          job.reject(this.poolClosedError());
        }
        worker.pending.clear();
        return worker.handle.terminate().catch(() => {
          // Best-effort: a failed terminate during shutdown leaves the OS
          // thread to exit on its own and must not block or fail shutdown.
        });
      })
    );
  }

  private poolClosedError(): SnapshotParseOffloadError {
    return new SnapshotParseOffloadError(
      SnapshotParseOffloadFailureReason.POOL_CLOSED,
      'Snapshot parse worker pool is shutting down'
    );
  }

  private async runOnWorker(
    poolBytes: Uint8Array,
    params: SnapshotTransformParams
  ): Promise<SnapshotTransformResult> {
    if (this.closed) {
      throw this.poolClosedError();
    }
    const worker = await this.acquireWorker();
    const id = this.nextRequestId++;
    try {
      return await new Promise<SnapshotTransformResult>((resolve, reject) => {
        const timeout = setTimeout(() => {
          worker.pending.delete(id);
          this.retireWorker(worker);
          reject(
            new SnapshotParseOffloadError(
              SnapshotParseOffloadFailureReason.TIMEOUT,
              `Snapshot parse worker job timed out after ${this.jobTimeoutMs}ms`
            )
          );
        }, this.jobTimeoutMs);
        // A timer alone must not keep the process alive past shutdown.
        timeout.unref?.();
        worker.pending.set(id, {resolve, reject, timeout, pools: []});
        worker.handle.postMessage({id, poolBytes, params});
      });
    } finally {
      // Only release a worker this pool still considers live — a timed-out
      // or errored job already retired (and replaced) it above.
      if (this.allWorkers.has(worker)) {
        this.releaseWorker(worker);
      }
    }
  }

  private async acquireWorker(): Promise<PooledWorker> {
    const idle = this.idleWorkers.pop();
    if (idle) {
      return idle;
    }
    if (this.allWorkers.size < this.poolSize) {
      return this.createWorker();
    }
    return new Promise<PooledWorker>((resolve, reject) => {
      const waiter: Waiter = {
        resolve: worker => {
          clearTimeout(waiter.timeout);
          resolve(worker);
        },
        reject: error => {
          clearTimeout(waiter.timeout);
          reject(error);
        },
        timeout: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) {
            this.waiters.splice(index, 1);
          }
          reject(
            new SnapshotParseOffloadError(
              SnapshotParseOffloadFailureReason.QUEUE_TIMEOUT,
              `Snapshot parse job waited more than ${this.queueTimeoutMs}ms for a worker`
            )
          );
        }, this.queueTimeoutMs),
      };
      waiter.timeout.unref?.();
      this.waiters.push(waiter);
    });
  }

  private releaseWorker(worker: PooledWorker): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve(worker);
    } else {
      this.idleWorkers.push(worker);
    }
  }

  // Terminates a worker that errored, exited, or timed out and drops it from
  // the pool's bookkeeping WITHOUT returning it to idleWorkers, so the next
  // acquireWorker call creates a fresh replacement instead of reusing a
  // worker whose in-process state may be corrupted. Idempotent: 'error' and
  // 'exit' can both fire for the same dying worker.
  private retireWorker(worker: PooledWorker, exitError?: Error): void {
    if (!this.allWorkers.has(worker)) {
      return;
    }
    this.allWorkers.delete(worker);
    for (const job of worker.pending.values()) {
      clearTimeout(job.timeout);
      if (exitError) {
        job.reject(exitError);
      }
    }
    worker.pending.clear();
    worker.handle.terminate().catch(() => {
      // Best-effort: the worker is already dead or dying; a failed
      // terminate() here is not actionable and must not become an
      // unhandled rejection.
    });
    if (this.closed) {
      return;
    }
    // A slot just freed up even though no worker is idle — wake one waiter
    // with a fresh replacement rather than leaving it to hang behind a pool
    // that looks full. createWorker() can throw synchronously (e.g. an
    // invalid worker script path), and this runs from a timer/error/exit
    // callback with nothing up the stack to catch it, so the throw becomes a
    // rejection on the waiting caller.
    const waiter = this.waiters.shift();
    if (waiter) {
      try {
        waiter.resolve(this.createWorker());
      } catch (error) {
        waiter.reject(
          new SnapshotParseOffloadError(
            SnapshotParseOffloadFailureReason.WORKER_ERROR,
            'Snapshot parse worker could not be started',
            {cause: error}
          )
        );
      }
    }
  }

  private handleResponse(
    pooled: PooledWorker,
    response: SnapshotParseWorkerResponse
  ): void {
    const job = pooled.pending.get(response.id);
    if (!job) {
      // Already timed out and retired — the late response is discarded.
      return;
    }
    if (response.status === 'chunk') {
      try {
        for (const pool of decodePoolsFromWire(response.poolsJson)) {
          job.pools.push(pool);
        }
      } catch (error) {
        pooled.pending.delete(response.id);
        clearTimeout(job.timeout);
        job.reject(
          new SnapshotParseOffloadError(
            SnapshotParseOffloadFailureReason.WORKER_ERROR,
            'Snapshot parse worker sent an undecodable chunk',
            {cause: error}
          )
        );
      }
      return;
    }
    pooled.pending.delete(response.id);
    clearTimeout(job.timeout);
    if (response.status === 'done') {
      job.resolve({pools: job.pools, skippedRecords: response.skippedRecords});
    } else {
      job.reject(new Error(response.errorMessage));
    }
  }

  private createWorker(): PooledWorker {
    const pooled: PooledWorker = {
      handle: this.workerHandleFactory(),
      pending: new Map(),
    };
    pooled.handle.onMessage(response => this.handleResponse(pooled, response));
    pooled.handle.onError(error => {
      this.retireWorker(
        pooled,
        new SnapshotParseOffloadError(
          SnapshotParseOffloadFailureReason.WORKER_ERROR,
          'Snapshot parse worker emitted an error',
          {cause: error}
        )
      );
    });
    pooled.handle.onExit(exitCode => {
      // A worker this pool retired itself exits too; retireWorker's
      // idempotency guard no-ops that case. This handles a worker that exits
      // on its own without emitting 'error', which would otherwise leave its
      // in-flight job hanging until the full job timeout.
      this.retireWorker(
        pooled,
        new SnapshotParseOffloadError(
          SnapshotParseOffloadFailureReason.WORKER_EXITED,
          `Snapshot parse worker exited unexpectedly with code ${exitCode}`
        )
      );
    });
    this.allWorkers.add(pooled);
    return pooled;
  }
}
