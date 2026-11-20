import {
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {Protocol} from '@uniswap/router-sdk';
import * as zlib from 'zlib';

import {Logger} from './sor-providers/util/log';
import {
  FETCH_START_METADATA_KEY,
  parseSnapshotFetchStart,
} from './util/snapshotFetchStart';

// S3 metadata key for how many pools the combo's pool source (Aurora)
// returned for a snapshot, before the cron's activity, hook and blocklist
// filters and its extra sources. Judging an empty read against the source
// count keeps a combo whose source returns many pools from passing as tiny
// because few of them survive the filters. Kept lowercase because S3
// lowercases metadata keys.
export const SNAPSHOT_SOURCE_POOL_COUNT_METADATA_KEY = 'source-pool-count';

// TODO(ROUTE-2803): remove the unlabelled fallback (this bound, getBytes and
// countSnapshotPools) once every snapshot in the pool-cache buckets carries
// SNAPSHOT_SOURCE_POOL_COUNT_METADATA_KEY. Until then an unlabelled snapshot is
// downloaded and counted only when it is at most this large: a tiny combo's
// snapshot is a few hundred bytes, so a large combo is never fetched.
export const UNLABELLED_SNAPSHOT_MAX_COUNT_BYTES = 4096;

// The parts of a pool snapshot's S3 HEAD the cron reads.
export interface SnapshotObjectHead {
  eTag: string | undefined;
  metadata: Record<string, string> | undefined;
  contentLength: number | undefined;
  lastModified: Date | undefined;
}

// Pool-snapshot object reads. `head` resolves undefined when the object does
// not exist and throws on any other failure.
export interface ISnapshotObjectStore {
  head(key: string): Promise<SnapshotObjectHead | undefined>;
  getBytes(key: string): Promise<Uint8Array | undefined>;
}

// What the snapshot currently in S3 says about its combo.
export interface IncumbentSnapshot {
  // The source pool count it was written from. For an unlabelled snapshot,
  // the pools in its body, which is after the cron's filters and so can be
  // smaller.
  poolCount: number | undefined;
  fetchStartMs: number | undefined;
}

export interface IIncumbentSnapshotReader {
  // Undefined when the combo has no snapshot or it cannot be read.
  // `retainHead` keeps the HEAD for the same combo's write this run.
  read(
    chainId: number,
    protocol: Protocol,
    options?: {retainHead?: boolean}
  ): Promise<IncumbentSnapshot | undefined>;
  // The HEAD a `retainHead` read kept for `key`, handed out once.
  takeRetainedHead(key: string): SnapshotObjectHead | undefined;
}

// For wiring without S3: every incumbent reads as unknown, so empty reads stay
// rejected.
export const NO_INCUMBENT_SNAPSHOTS: IIncumbentSnapshotReader = {
  read: async () => undefined,
  takeRetainedHead: () => undefined,
};

export function isS3NotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const name = 'name' in err ? err.name : undefined;
  const metadata = '$metadata' in err ? err.$metadata : undefined;
  const status =
    typeof metadata === 'object' &&
    metadata !== null &&
    'httpStatusCode' in metadata
      ? metadata.httpStatusCode
      : undefined;
  return name === 'NotFound' || name === 'NoSuchKey' || status === 404;
}

export class S3SnapshotObjectStore implements ISnapshotObjectStore {
  constructor(
    private readonly s3: S3Client,
    private readonly bucket: string
  ) {}

  async head(key: string): Promise<SnapshotObjectHead | undefined> {
    try {
      const head = await this.s3.send(
        new HeadObjectCommand({Bucket: this.bucket, Key: key})
      );
      return {
        eTag: head.ETag,
        metadata: head.Metadata,
        contentLength: head.ContentLength,
        lastModified: head.LastModified,
      };
    } catch (err) {
      if (isS3NotFound(err)) {
        return undefined;
      }
      throw err;
    }
  }

  async getBytes(key: string): Promise<Uint8Array | undefined> {
    const object = await this.s3.send(
      new GetObjectCommand({Bucket: this.bucket, Key: key})
    );
    return object.Body ? object.Body.transformToByteArray() : undefined;
  }
}

// Parses the recorded pool count, undefined when missing or not a
// non-negative integer.
export function parseSnapshotPoolCount(
  raw: string | undefined
): number | undefined {
  if (raw === undefined || !/^\d+$/.test(raw)) {
    return undefined;
  }
  const count = Number(raw);
  return Number.isSafeInteger(count) ? count : undefined;
}

// Counts the pools in a deflated snapshot body, undefined when it does not
// inflate to a JSON array.
export function countSnapshotPools(body: Uint8Array): number | undefined {
  try {
    const parsed: unknown = JSON.parse(zlib.inflateSync(body).toString('utf8'));
    return Array.isArray(parsed) ? parsed.length : undefined;
  } catch {
    return undefined;
  }
}

export class IncumbentSnapshotReader implements IIncumbentSnapshotReader {
  private readonly retainedHeads = new Map<string, SnapshotObjectHead>();

  constructor(
    private readonly store: ISnapshotObjectStore,
    private readonly keyFor: (chainId: number, protocol: Protocol) => string,
    private readonly logger: Logger
  ) {}

  async read(
    chainId: number,
    protocol: Protocol,
    options?: {retainHead?: boolean}
  ): Promise<IncumbentSnapshot | undefined> {
    const key = this.keyFor(chainId, protocol);
    try {
      const head = await this.store.head(key);
      if (head === undefined) {
        return undefined;
      }
      if (options?.retainHead) {
        this.retainedHeads.set(key, head);
      }
      return {
        poolCount: await this.poolCount(key, head),
        fetchStartMs:
          parseSnapshotFetchStart(
            head.metadata?.[FETCH_START_METADATA_KEY],
            Date.now()
          )?.getTime() ?? head.lastModified?.getTime(),
      };
    } catch (err) {
      this.logger.warn(
        `Could not read the incumbent pool snapshot ${key}: ${err instanceof Error ? err.name : 'unknown'}`
      );
      return undefined;
    }
  }

  takeRetainedHead(key: string): SnapshotObjectHead | undefined {
    const head = this.retainedHeads.get(key);
    this.retainedHeads.delete(key);
    return head;
  }

  private async poolCount(
    key: string,
    head: SnapshotObjectHead
  ): Promise<number | undefined> {
    const labelled = parseSnapshotPoolCount(
      head.metadata?.[SNAPSHOT_SOURCE_POOL_COUNT_METADATA_KEY]
    );
    if (labelled !== undefined) {
      return labelled;
    }
    if (
      head.contentLength === undefined ||
      head.contentLength > UNLABELLED_SNAPSHOT_MAX_COUNT_BYTES
    ) {
      return undefined;
    }
    const body = await this.store.getBytes(key);
    const counted = body === undefined ? undefined : countSnapshotPools(body);
    if (counted === undefined) {
      this.logger.warn(
        `Incumbent pool snapshot ${key} has no pool-count and its body could not be counted`
      );
    }
    return counted;
  }
}
