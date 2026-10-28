import {describe, expect, it} from 'vitest';
import {buildTestContext} from '@uniswap/lib-testhelpers';
import {
  createSnapshotParseOffloader,
  SnapshotParseOffloaderSelection,
} from './createSnapshotParseOffloader';
import {
  MainThreadSnapshotParseOffloader,
  SNAPSHOT_PARSE_OFFLOAD_METRIC,
} from './SnapshotParseOffloader';
import {
  IWorkerHandle,
  WorkerThreadSnapshotParseOffloader,
} from './WorkerThreadSnapshotParseOffloader';
import {transformSnapshotPoolBytes} from './s3SnapshotTransform';
import {ChainId} from '../../../lib/config';
import {Protocol} from '../../../models/pool/Protocol';

// Never called in these tests: no job is dispatched to a worker.
class UnusedWorkerHandle implements IWorkerHandle {
  postMessage(): void {
    throw new Error('no job is dispatched in these tests');
  }
  onMessage(): void {}
  onError(): void {}
  onExit(): void {}
  async terminate(): Promise<number> {
    return 0;
  }
}

const WORKER_SCRIPT_PATH = '/var/task/dist/workers/snapshotParseWorker.mjs';

const selection = (
  snapshotParseOffloadEnabled: boolean
): SnapshotParseOffloaderSelection => ({
  snapshotParseOffloadEnabled,
  snapshotParseWorkerPoolSize: 1,
  snapshotParseWorkerJobTimeoutMs: 10_000,
  snapshotParseWorkerQueueTimeoutMs: 10_000,
  workerScriptPath: WORKER_SCRIPT_PATH,
});

const POOL_BYTES = new TextEncoder().encode(
  JSON.stringify([
    {
      id: '0xabc',
      token0: {id: '0xdef'},
      token1: {id: '0x123'},
      liquidity: '1',
      tvlETH: 1,
      tvlUSD: 1,
      feeTier: '3000',
    },
  ])
);
const PARAMS = {chainId: ChainId.MAINNET, protocol: Protocol.V3};

describe('createSnapshotParseOffloader', () => {
  it('returns a MainThreadSnapshotParseOffloader when the flag is disabled, without checking the script', () => {
    let scriptChecks = 0;
    const offloader = createSnapshotParseOffloader(
      selection(false),
      () => new UnusedWorkerHandle(),
      buildTestContext(),
      () => {
        scriptChecks++;
        return true;
      }
    );

    expect(offloader).toBeInstanceOf(MainThreadSnapshotParseOffloader);
    expect(scriptChecks).toBe(0);
  });

  it('returns a WorkerThreadSnapshotParseOffloader and logs the script path when the flag is enabled and the script exists', () => {
    const ctx = buildTestContext();
    const checkedPaths: string[] = [];
    const offloader = createSnapshotParseOffloader(
      selection(true),
      () => new UnusedWorkerHandle(),
      ctx,
      path => {
        checkedPaths.push(path);
        return true;
      }
    );

    expect(offloader).toBeInstanceOf(WorkerThreadSnapshotParseOffloader);
    expect(checkedPaths).toEqual([WORKER_SCRIPT_PATH]);
    expect(
      ctx.logger.outputs.some(entry =>
        entry.msg.includes('Parsing pool snapshots on a worker pool')
      )
    ).toBe(true);
  });

  it('parses on the main thread, logs an error and counts every parse as a failure when the script is missing (failure path)', async () => {
    const bootCtx = buildTestContext();
    const offloader = createSnapshotParseOffloader(
      selection(true),
      () => new UnusedWorkerHandle(),
      bootCtx,
      () => false
    );
    expect(offloader).toBeInstanceOf(MainThreadSnapshotParseOffloader);
    expect(
      bootCtx.logger.outputs.some(
        entry =>
          entry.prefix === 'ERROR:' &&
          entry.msg.includes('Worker script missing')
      )
    ).toBe(true);

    const ctx = buildTestContext();
    const result = await offloader.parseAndFilterSnapshot(
      POOL_BYTES,
      PARAMS,
      ctx
    );

    expect(result).toEqual(transformSnapshotPoolBytes(POOL_BYTES, PARAMS));
    expect(ctx.metrics.countStore[SNAPSHOT_PARSE_OFFLOAD_METRIC]).toBe(1);
  });
});
