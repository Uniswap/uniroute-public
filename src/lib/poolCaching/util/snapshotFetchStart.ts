// S3 metadata key for when a snapshot's subgraph fetch started, kept lowercase because S3 lowercases metadata keys
export const FETCH_START_METADATA_KEY = 'fetch-start-time';

// A fetch start further ahead of the clock than this comes from a broken writer clock and is treated as absent
export const FETCH_START_MAX_FUTURE_SKEW_MS = 5 * 60_000;

// Parses the recorded fetch start, undefined when missing, unparseable or implausibly in the future
export function parseSnapshotFetchStart(
  raw: string | undefined,
  nowMs: number
): Date | undefined {
  if (raw === undefined || raw === '') {
    return undefined;
  }
  const parsed = new Date(raw);
  const parsedMs = parsed.getTime();
  if (
    Number.isNaN(parsedMs) ||
    parsedMs > nowMs + FETCH_START_MAX_FUTURE_SKEW_MS
  ) {
    return undefined;
  }
  return parsed;
}
