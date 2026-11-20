import {Protocol} from '@uniswap/router-sdk';
import {describe, expect, it} from 'vitest';
import * as zlib from 'zlib';

import {
  countSnapshotPools,
  IncumbentSnapshotReader,
  isS3NotFound,
  parseSnapshotPoolCount,
  UNLABELLED_SNAPSHOT_MAX_COUNT_BYTES,
} from './incumbentSnapshots';
import {Logger} from './sor-providers/util/log';
import {
  FakeSnapshotObjectStore,
  snapshotHead,
} from '../../../tests/test-utils/FakeIncumbentSnapshots';

const MEGAETH = 4326;
const KEY = 'poolCacheGzip.json-4326-V3';
const keyFor = (chainId: number, protocol: Protocol) =>
  `poolCacheGzip.json-${chainId}-${protocol}`;

function recordingLogger(): Logger & {warnings: string[]} {
  const warnings: string[] = [];
  return {
    warnings,
    info: () => {},
    warn: (msg: string) => {
      warnings.push(msg);
    },
    error: () => {},
    debug: () => {},
    fatal: () => {},
  };
}

// The megaeth V3 snapshot as read from the prod bucket: one pool.
const ONE_POOL_BODY = zlib.deflateSync(
  JSON.stringify([
    {
      id: '0xa42f01610f633d9de29f8d5a5f2782b1570bc580',
      feeTier: '500',
      liquidity: '22310311517323105275',
      token0: {id: '0x4200000000000000000000000000000000000006'},
      token1: {id: '0xfafddbb3fc7688494971a79cc65dca3ef82079e7'},
      tvlETH: 1.0793061505906836,
      tvlUSD: 1891.0317160047753,
    },
  ])
);

describe('IncumbentSnapshotReader', () => {
  it('reads the labelled pool count and recorded fetch start without the body', async () => {
    const fetchStart = '2026-11-19T20:40:00.000Z';
    const store = new FakeSnapshotObjectStore(
      new Map([
        [
          KEY,
          snapshotHead({
            metadata: {
              'source-pool-count': '1',
              'fetch-start-time': fetchStart,
            },
            contentLength: ONE_POOL_BODY.length,
          }),
        ],
      ])
    );
    const reader = new IncumbentSnapshotReader(
      store,
      keyFor,
      recordingLogger()
    );

    expect(await reader.read(MEGAETH, Protocol.V3)).toEqual({
      poolCount: 1,
      fetchStartMs: Date.parse(fetchStart),
    });
    expect(store.getBytesCalls).toEqual([]);
  });

  it('falls back to LastModified when the fetch start is not recorded', async () => {
    const lastModified = new Date('2026-11-19T20:41:00Z');
    const store = new FakeSnapshotObjectStore(
      new Map([
        [
          KEY,
          snapshotHead({metadata: {'source-pool-count': '1'}, lastModified}),
        ],
      ])
    );
    const reader = new IncumbentSnapshotReader(
      store,
      keyFor,
      recordingLogger()
    );

    expect((await reader.read(MEGAETH, Protocol.V3))?.fetchStartMs).toBe(
      lastModified.getTime()
    );
  });

  it('counts the body of a small unlabelled snapshot', async () => {
    const store = new FakeSnapshotObjectStore(
      new Map([[KEY, snapshotHead({contentLength: ONE_POOL_BODY.length})]]),
      new Map([[KEY, ONE_POOL_BODY]])
    );
    const reader = new IncumbentSnapshotReader(
      store,
      keyFor,
      recordingLogger()
    );

    expect((await reader.read(MEGAETH, Protocol.V3))?.poolCount).toBe(1);
    expect(store.getBytesCalls).toEqual([KEY]);
  });

  it('never downloads an unlabelled snapshot too large to be tiny', async () => {
    const store = new FakeSnapshotObjectStore(
      new Map([
        [
          KEY,
          snapshotHead({
            contentLength: UNLABELLED_SNAPSHOT_MAX_COUNT_BYTES + 1,
          }),
        ],
      ])
    );
    const reader = new IncumbentSnapshotReader(
      store,
      keyFor,
      recordingLogger()
    );

    expect(
      (await reader.read(MEGAETH, Protocol.V3))?.poolCount
    ).toBeUndefined();
    expect(store.getBytesCalls).toEqual([]);
  });

  it('warns and reports no count when a small unlabelled body cannot be counted', async () => {
    const store = new FakeSnapshotObjectStore(
      new Map([[KEY, snapshotHead({contentLength: 12})]]),
      new Map([[KEY, Buffer.from('not deflated')]])
    );
    const logger = recordingLogger();
    const reader = new IncumbentSnapshotReader(store, keyFor, logger);

    expect(
      (await reader.read(MEGAETH, Protocol.V3))?.poolCount
    ).toBeUndefined();
    expect(logger.warnings).toHaveLength(1);
  });

  it('reads a missing snapshot as absent', async () => {
    const reader = new IncumbentSnapshotReader(
      new FakeSnapshotObjectStore(),
      keyFor,
      recordingLogger()
    );

    expect(await reader.read(MEGAETH, Protocol.V3)).toBeUndefined();
  });

  it('warns and reads as absent when the HEAD fails', async () => {
    const throttled = new Error('throttled');
    throttled.name = 'SlowDown';
    const logger = recordingLogger();
    const reader = new IncumbentSnapshotReader(
      new FakeSnapshotObjectStore(new Map([[KEY, throttled]])),
      keyFor,
      logger
    );

    expect(await reader.read(MEGAETH, Protocol.V3)).toBeUndefined();
    expect(logger.warnings).toEqual([
      `Could not read the incumbent pool snapshot ${KEY}: SlowDown`,
    ]);
  });

  it('hands a retained HEAD out once, and only for a retaining read', async () => {
    const head = snapshotHead({
      eTag: '"v1"',
      metadata: {'source-pool-count': '1'},
    });
    const reader = new IncumbentSnapshotReader(
      new FakeSnapshotObjectStore(new Map([[KEY, head]])),
      keyFor,
      recordingLogger()
    );

    await reader.read(MEGAETH, Protocol.V3);
    expect(reader.takeRetainedHead(KEY)).toBeUndefined();

    await reader.read(MEGAETH, Protocol.V3, {retainHead: true});
    expect(reader.takeRetainedHead(KEY)).toEqual(head);
    expect(reader.takeRetainedHead(KEY)).toBeUndefined();
  });
});

describe('isS3NotFound', () => {
  it('recognizes the shapes S3 uses for a missing object', () => {
    const notFound = new Error('NotFound');
    notFound.name = 'NotFound';
    const noSuchKey = new Error('NoSuchKey');
    noSuchKey.name = 'NoSuchKey';
    expect(isS3NotFound(notFound)).toBe(true);
    expect(isS3NotFound(noSuchKey)).toBe(true);
    expect(isS3NotFound({$metadata: {httpStatusCode: 404}})).toBe(true);
  });

  it('does not treat other failures as missing', () => {
    expect(isS3NotFound(new Error('boom'))).toBe(false);
    expect(isS3NotFound({$metadata: {httpStatusCode: 503}})).toBe(false);
    expect(isS3NotFound(undefined)).toBe(false);
    expect(isS3NotFound('NotFound')).toBe(false);
  });
});

describe('parseSnapshotPoolCount', () => {
  it('parses the count the cron writes', () => {
    expect(parseSnapshotPoolCount('0')).toBe(0);
    expect(parseSnapshotPoolCount('12345')).toBe(12345);
  });

  it.each([undefined, '', '-1', '1.5', 'abc', ' 2', '1e3'])(
    'rejects %j',
    raw => {
      expect(parseSnapshotPoolCount(raw)).toBeUndefined();
    }
  );

  it('rejects a count past the safe integer range', () => {
    expect(parseSnapshotPoolCount('9'.repeat(20))).toBeUndefined();
  });
});

describe('countSnapshotPools', () => {
  it('counts the pools in a body written the way the cron writes it', () => {
    expect(countSnapshotPools(ONE_POOL_BODY)).toBe(1);
  });

  it('counts an empty snapshot as zero', () => {
    expect(countSnapshotPools(zlib.deflateSync('[]'))).toBe(0);
  });

  it('returns undefined for a body that is not a deflated JSON array', () => {
    expect(countSnapshotPools(Buffer.from('not deflated'))).toBeUndefined();
    expect(countSnapshotPools(zlib.deflateSync('{"a":1}'))).toBeUndefined();
  });
});
