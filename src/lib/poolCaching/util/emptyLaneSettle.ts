// A combo whose served snapshot holds at most this many pools can genuinely
// lose every one of them (an LP withdraws the only liquid pool), and no amount
// of waiting brings them back. Above it, an empty Aurora read is treated as an
// ingestion outage and the previous snapshot keeps serving.
export const TINY_SNAPSHOT_MAX_POOLS = 3;

// Consecutive empty reads before a tiny combo's empty result is accepted. Each
// one is a full cron tick, so a brief ingestion gap does not wipe the combo.
export const EMPTY_READ_SETTLE_TICKS = 3;

export enum EmptyReadOutcome {
  // The incumbent snapshot is already empty: keep it empty and fresh.
  ALREADY_EMPTY = 'already_empty',
  // A tiny combo read empty for EMPTY_READ_SETTLE_TICKS ticks in a row while
  // a sibling combo on the same chain kept being served.
  SETTLED = 'settled',
}

export enum EmptyReadHoldReason {
  // Still inside the settle window for a tiny combo.
  SETTLING = 'settling',
  // The incumbent holds more than TINY_SNAPSHOT_MAX_POOLS pools.
  INCUMBENT_NOT_TINY = 'incumbent_not_tiny',
  // No incumbent, or its pool count could not be read. Leaves the window
  // where it is, so a passing S3 failure does not restart it.
  INCUMBENT_UNKNOWN = 'incumbent_unknown',
  // No sibling combo on the chain wrote a non-empty snapshot since this
  // combo started reading empty, so the chain's ingestion or pricing may be
  // down rather than this combo's pools being gone.
  CHAIN_UNCONFIRMED = 'chain_unconfirmed',
}

export type EmptyReadDecision =
  | {action: 'accept'; outcome: EmptyReadOutcome}
  | {action: 'hold'; reason: EmptyReadHoldReason};

// What the settle window needs checked before it can accept.
export type EmptyReadStep =
  | EmptyReadDecision
  | {action: 'confirm_chain'; firstEmptyAtMs: number};

// The snapshot a sibling combo last wrote, as far as the settle check needs.
export interface SiblingSnapshot {
  poolCount: number | undefined;
  fetchStartMs: number | undefined;
}

// Consecutive empty reads per combo key, module level because cacheAllPools
// rebuilds its providers every tick. A cron restart resets a streak, which
// only delays a settle; the tiny-or-not decision itself comes from S3.
const emptyReadStreakByTarget = new Map<
  string,
  {reads: number; firstEmptyAtMs: number}
>();

export function resetEmptyReadStreaksForTesting(): void {
  emptyReadStreakByTarget.clear();
}

// Any non-empty result for the combo, served or rejected, ends its streak.
export function clearEmptyReadStreak(key: string): void {
  emptyReadStreakByTarget.delete(key);
}

// Advances the combo's settle window for one empty read. Returns
// confirm_chain once the window is full: the caller accepts only if a sibling
// combo confirms the chain is still being ingested (siblingConfirmsIngestion).
export function advanceEmptyRead(
  key: string,
  incumbentPoolCount: number | undefined,
  nowMs: number
): EmptyReadStep {
  if (incumbentPoolCount === undefined) {
    return {action: 'hold', reason: EmptyReadHoldReason.INCUMBENT_UNKNOWN};
  }
  if (incumbentPoolCount === 0) {
    emptyReadStreakByTarget.delete(key);
    return {action: 'accept', outcome: EmptyReadOutcome.ALREADY_EMPTY};
  }
  if (incumbentPoolCount > TINY_SNAPSHOT_MAX_POOLS) {
    emptyReadStreakByTarget.delete(key);
    return {action: 'hold', reason: EmptyReadHoldReason.INCUMBENT_NOT_TINY};
  }
  const previous = emptyReadStreakByTarget.get(key);
  const streak = {
    reads: (previous?.reads ?? 0) + 1,
    firstEmptyAtMs: previous?.firstEmptyAtMs ?? nowMs,
  };
  emptyReadStreakByTarget.set(key, streak);
  if (streak.reads < EMPTY_READ_SETTLE_TICKS) {
    return {action: 'hold', reason: EmptyReadHoldReason.SETTLING};
  }
  return {action: 'confirm_chain', firstEmptyAtMs: streak.firstEmptyAtMs};
}

// A sibling confirms the chain is still ingested and priced when it wrote a
// snapshot with pools from a read that started after this combo's first empty
// read. A chain-wide ingestion or price outage leaves every sibling either
// rejected (no write) or empty, so none of them can confirm it.
export function siblingConfirmsIngestion(
  sibling: SiblingSnapshot | undefined,
  firstEmptyAtMs: number
): boolean {
  return (
    sibling !== undefined &&
    sibling.fetchStartMs !== undefined &&
    sibling.fetchStartMs > firstEmptyAtMs &&
    sibling.poolCount !== 0
  );
}
