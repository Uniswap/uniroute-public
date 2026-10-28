import {existsSync} from 'node:fs';
import {Context} from '@uniswap/lib-uni/context';
import {
  ISnapshotParseOffloader,
  MainThreadSnapshotParseOffloader,
  SnapshotParseOffloadFailureReason,
} from './SnapshotParseOffloader';
import {
  IWorkerHandle,
  WorkerThreadSnapshotParseOffloader,
} from './WorkerThreadSnapshotParseOffloader';

// Plain-value inputs createSnapshotParseOffloader needs, split out of
// IUniRouteServiceConfig['PoolDiscovery'] so this module doesn't depend on
// the full service config type.
export interface SnapshotParseOffloaderSelection {
  snapshotParseOffloadEnabled: boolean;
  snapshotParseWorkerPoolSize: number;
  snapshotParseWorkerJobTimeoutMs: number;
  snapshotParseWorkerQueueTimeoutMs: number;
  workerScriptPath: string;
}

// The flag-based choice between the main-thread and worker-thread
// implementations — this is behavior, not wiring, so it lives here (with its
// own test covering each case) rather than inline in dependencies.ts.
//
// The worker script path depends on the process's working directory, so with
// the flag on it is checked once at boot: a missing script logs an error and
// parses on the main thread, counting status:failure
// reason:worker_script_missing on every parse instead of failing each job.
export function createSnapshotParseOffloader(
  selection: SnapshotParseOffloaderSelection,
  workerHandleFactory: (workerScriptPath: string) => IWorkerHandle,
  bootCtx: Context,
  scriptExists: (path: string) => boolean = existsSync
): ISnapshotParseOffloader {
  if (!selection.snapshotParseOffloadEnabled) {
    return new MainThreadSnapshotParseOffloader();
  }
  const {workerScriptPath} = selection;
  if (!scriptExists(workerScriptPath)) {
    bootCtx.logger.error(
      '[SnapshotParseOffloader] Worker script missing; parsing pool snapshots on the main thread',
      {workerScriptPath, cwd: process.cwd()}
    );
    return new MainThreadSnapshotParseOffloader(
      SnapshotParseOffloadFailureReason.WORKER_SCRIPT_MISSING
    );
  }
  bootCtx.logger.info(
    '[SnapshotParseOffloader] Parsing pool snapshots on a worker pool',
    {
      workerScriptPath,
      poolSize: selection.snapshotParseWorkerPoolSize,
      jobTimeoutMs: selection.snapshotParseWorkerJobTimeoutMs,
      queueTimeoutMs: selection.snapshotParseWorkerQueueTimeoutMs,
    }
  );
  return new WorkerThreadSnapshotParseOffloader(
    () => workerHandleFactory(workerScriptPath),
    selection.snapshotParseWorkerPoolSize,
    selection.snapshotParseWorkerJobTimeoutMs,
    selection.snapshotParseWorkerQueueTimeoutMs
  );
}
