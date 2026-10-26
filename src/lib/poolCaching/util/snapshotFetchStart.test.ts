import {describe, expect, it} from 'vitest';
import {
  FETCH_START_MAX_FUTURE_SKEW_MS,
  parseSnapshotFetchStart,
} from './snapshotFetchStart';

describe('parseSnapshotFetchStart', () => {
  const nowMs = Date.parse('2026-10-23T14:00:00Z');

  it('parses the ISO timestamp the cron writes', () => {
    const written = new Date(nowMs - 10 * 60_000).toISOString();
    expect(parseSnapshotFetchStart(written, nowMs)?.getTime()).toBe(
      nowMs - 10 * 60_000
    );
  });

  it('accepts a fetch start slightly ahead of the clock', () => {
    const skewed = new Date(nowMs + FETCH_START_MAX_FUTURE_SKEW_MS);
    expect(parseSnapshotFetchStart(skewed.toISOString(), nowMs)).toEqual(
      skewed
    );
  });

  it('rejects a fetch start further in the future than the skew allowance', () => {
    const tooFar = new Date(nowMs + FETCH_START_MAX_FUTURE_SKEW_MS + 1);
    expect(
      parseSnapshotFetchStart(tooFar.toISOString(), nowMs)
    ).toBeUndefined();
  });

  it('rejects a value that is not a date', () => {
    expect(parseSnapshotFetchStart('yesterday', nowMs)).toBeUndefined();
  });

  it('treats a missing or empty value as absent', () => {
    expect(parseSnapshotFetchStart(undefined, nowMs)).toBeUndefined();
    expect(parseSnapshotFetchStart('', nowMs)).toBeUndefined();
  });
});
