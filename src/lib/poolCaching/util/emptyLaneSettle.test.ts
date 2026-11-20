import {beforeEach, describe, expect, it} from 'vitest';
import {
  advanceEmptyRead,
  clearEmptyReadStreak,
  EMPTY_READ_SETTLE_TICKS,
  EmptyReadHoldReason,
  EmptyReadOutcome,
  resetEmptyReadStreaksForTesting,
  siblingConfirmsIngestion,
  TINY_SNAPSHOT_MAX_POOLS,
} from './emptyLaneSettle';

const KEY = '4326:V3';
const T0 = Date.parse('2026-11-19T21:00:00Z');
const TICK_MS = 6 * 60_000;

describe('advanceEmptyRead', () => {
  beforeEach(() => {
    resetEmptyReadStreaksForTesting();
  });

  it('asks for chain confirmation once a tiny combo fills the window, anchored at its first empty read', () => {
    for (let tick = 1; tick < EMPTY_READ_SETTLE_TICKS; tick++) {
      expect(advanceEmptyRead(KEY, 1, T0 + (tick - 1) * TICK_MS)).toEqual({
        action: 'hold',
        reason: EmptyReadHoldReason.SETTLING,
      });
    }
    expect(advanceEmptyRead(KEY, 1, T0 + 10 * TICK_MS)).toEqual({
      action: 'confirm_chain',
      firstEmptyAtMs: T0,
    });
  });

  it('keeps asking for confirmation past the window without moving the anchor', () => {
    for (let tick = 0; tick < EMPTY_READ_SETTLE_TICKS; tick++) {
      advanceEmptyRead(KEY, 1, T0 + tick * TICK_MS);
    }
    expect(advanceEmptyRead(KEY, 1, T0 + 20 * TICK_MS)).toEqual({
      action: 'confirm_chain',
      firstEmptyAtMs: T0,
    });
  });

  it('fills the window at the largest tiny pool count', () => {
    for (let tick = 1; tick < EMPTY_READ_SETTLE_TICKS; tick++) {
      advanceEmptyRead(KEY, TINY_SNAPSHOT_MAX_POOLS, T0);
    }
    expect(advanceEmptyRead(KEY, TINY_SNAPSHOT_MAX_POOLS, T0).action).toBe(
      'confirm_chain'
    );
  });

  it('never advances a combo above the tiny bound', () => {
    for (let tick = 0; tick < EMPTY_READ_SETTLE_TICKS * 2; tick++) {
      expect(advanceEmptyRead(KEY, TINY_SNAPSHOT_MAX_POOLS + 1, T0)).toEqual({
        action: 'hold',
        reason: EmptyReadHoldReason.INCUMBENT_NOT_TINY,
      });
    }
  });

  it('never advances when the incumbent count is unknown', () => {
    for (let tick = 0; tick < EMPTY_READ_SETTLE_TICKS * 2; tick++) {
      expect(advanceEmptyRead(KEY, undefined, T0)).toEqual({
        action: 'hold',
        reason: EmptyReadHoldReason.INCUMBENT_UNKNOWN,
      });
    }
  });

  it('accepts an already-empty incumbent at once', () => {
    expect(advanceEmptyRead(KEY, 0, T0)).toEqual({
      action: 'accept',
      outcome: EmptyReadOutcome.ALREADY_EMPTY,
    });
  });

  it('restarts the window, and its anchor, after the streak is cleared', () => {
    for (let tick = 1; tick < EMPTY_READ_SETTLE_TICKS; tick++) {
      advanceEmptyRead(KEY, 1, T0);
    }
    clearEmptyReadStreak(KEY);
    const later = T0 + 5 * TICK_MS;
    for (let tick = 1; tick < EMPTY_READ_SETTLE_TICKS; tick++) {
      expect(advanceEmptyRead(KEY, 1, later).action).toBe('hold');
    }
    expect(advanceEmptyRead(KEY, 1, later)).toEqual({
      action: 'confirm_chain',
      firstEmptyAtMs: later,
    });
  });

  it('restarts the window when the incumbent stops reading as tiny', () => {
    for (let tick = 1; tick < EMPTY_READ_SETTLE_TICKS; tick++) {
      advanceEmptyRead(KEY, 1, T0);
    }
    advanceEmptyRead(KEY, TINY_SNAPSHOT_MAX_POOLS + 1, T0);
    expect(advanceEmptyRead(KEY, 1, T0).action).toBe('hold');
  });

  it('keeps the window, and its anchor, across an unreadable incumbent', () => {
    for (let tick = 1; tick < EMPTY_READ_SETTLE_TICKS; tick++) {
      advanceEmptyRead(KEY, 1, T0);
    }
    // A passing S3 throttle between two empty reads.
    expect(advanceEmptyRead(KEY, undefined, T0 + TICK_MS).action).toBe('hold');
    expect(advanceEmptyRead(KEY, 1, T0 + 2 * TICK_MS)).toEqual({
      action: 'confirm_chain',
      firstEmptyAtMs: T0,
    });
  });

  it('keeps windows separate per combo', () => {
    for (let tick = 1; tick < EMPTY_READ_SETTLE_TICKS; tick++) {
      advanceEmptyRead(KEY, 1, T0);
    }
    expect(advanceEmptyRead('4326:V2', 1, T0).action).toBe('hold');
    expect(advanceEmptyRead(KEY, 1, T0).action).toBe('confirm_chain');
  });
});

describe('siblingConfirmsIngestion', () => {
  it('confirms with a non-empty snapshot fetched after the first empty read', () => {
    expect(
      siblingConfirmsIngestion({poolCount: 8, fetchStartMs: T0 + 1}, T0)
    ).toBe(true);
  });

  it('confirms with an unlabelled snapshot fetched after the first empty read', () => {
    expect(
      siblingConfirmsIngestion(
        {poolCount: undefined, fetchStartMs: T0 + TICK_MS},
        T0
      )
    ).toBe(true);
  });

  it('does not confirm with a snapshot fetched at or before the first empty read', () => {
    // A chain-wide outage that began with this combo's first empty read
    // leaves the sibling's last write at or before it.
    expect(siblingConfirmsIngestion({poolCount: 8, fetchStartMs: T0}, T0)).toBe(
      false
    );
    expect(
      siblingConfirmsIngestion({poolCount: 8, fetchStartMs: T0 - TICK_MS}, T0)
    ).toBe(false);
  });

  it('does not confirm with an empty sibling snapshot', () => {
    expect(
      siblingConfirmsIngestion({poolCount: 0, fetchStartMs: T0 + TICK_MS}, T0)
    ).toBe(false);
  });

  it('does not confirm without a sibling snapshot or its fetch start', () => {
    expect(siblingConfirmsIngestion(undefined, T0)).toBe(false);
    expect(
      siblingConfirmsIngestion({poolCount: 8, fetchStartMs: undefined}, T0)
    ).toBe(false);
  });
});
