import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {promisify} from 'node:util';
import * as zlib from 'node:zlib';
import {readFileSync, mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import * as esbuild from 'esbuild';
import {buildTestContext} from '@uniswap/lib-testhelpers';
import {
  createNodeSnapshotParseWorkerHandle,
  resolveDefaultWorkerScriptPath,
  WorkerThreadSnapshotParseOffloader,
} from './WorkerThreadSnapshotParseOffloader';
import {
  ISnapshotParseOffloader,
  SnapshotParseOffloadError,
} from './SnapshotParseOffloader';
import {createSnapshotParseOffloader} from './createSnapshotParseOffloader';
import {
  SnapshotTransformParams,
  transformSnapshotPoolBytes,
} from './s3SnapshotTransform';
import {ChainId} from '../../../lib/config';
import {Protocol} from '../../../models/pool/Protocol';

const inflateAsync = promisify(zlib.inflate);

describe('WorkerThreadSnapshotParseOffloader against a real worker_threads worker', () => {
  let baseDir: string;
  let offloader: ISnapshotParseOffloader;

  beforeAll(async () => {
    // Bundles src/workers/snapshotParseWorker.ts with esbuild the way
    // containers/Dockerfile.ec2 bundles every worker entry point, into the
    // same dist/workers/ layout the image has under its WORKDIR, then builds
    // the offloader through resolveDefaultWorkerScriptPath and
    // createSnapshotParseOffloader as dependencies.ts does. A regression in
    // the path resolution or the boot-time script check fails here.
    baseDir = mkdtempSync(join(tmpdir(), 'snapshot-parse-worker-real-'));
    await esbuild.build({
      entryPoints: [join(__dirname, '../../../workers/snapshotParseWorker.ts')],
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node22',
      outdir: join(baseDir, 'dist', 'workers'),
      outExtension: {'.js': '.mjs'},
    });

    offloader = createSnapshotParseOffloader(
      {
        snapshotParseOffloadEnabled: true,
        snapshotParseWorkerPoolSize: 1,
        snapshotParseWorkerJobTimeoutMs: 30_000,
        snapshotParseWorkerQueueTimeoutMs: 30_000,
        workerScriptPath: resolveDefaultWorkerScriptPath(baseDir),
      },
      createNodeSnapshotParseWorkerHandle,
      buildTestContext()
    );
  }, 30_000);

  afterAll(async () => {
    await offloader.close();
    rmSync(baseDir, {recursive: true, force: true});
  });

  it('builds a worker-pool offloader from the resolved script path', () => {
    expect(offloader).toBeInstanceOf(WorkerThreadSnapshotParseOffloader);
  });

  it('parses a real V4 snapshot fixture through an actual worker thread and matches the main-thread result', async () => {
    const inflated = await inflateAsync(
      readFileSync(join(process.cwd(), 'tests/data/v4-pools.json.gz'))
    );
    const params: SnapshotTransformParams = {
      chainId: ChainId.MAINNET,
      protocol: Protocol.V4,
    };

    const workerResult = await offloader.parseAndFilterSnapshot(
      inflated,
      params,
      buildTestContext()
    );

    expect(workerResult.pools.length).toBeGreaterThan(0);
    expect(workerResult).toEqual(transformSnapshotPoolBytes(inflated, params));
  }, 30_000);

  it('relays a real in-worker JSON.parse failure as a transform error, not an offload failure (failure path)', async () => {
    const params: SnapshotTransformParams = {
      chainId: ChainId.MAINNET,
      protocol: Protocol.V4,
    };

    const error = await offloader
      .parseAndFilterSnapshot(
        new TextEncoder().encode('{not valid json'),
        params,
        buildTestContext()
      )
      .then(
        () => undefined,
        (rejection: unknown) => rejection
      );

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(SnapshotParseOffloadError);
    expect(error instanceof Error && error.message).toMatch(/JSON/);
  }, 30_000);
});
