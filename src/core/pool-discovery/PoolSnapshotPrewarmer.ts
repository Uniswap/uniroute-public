import {Context} from '@uniswap/lib-uni/context';
import {ChainId} from '../../lib/config';
import {Protocol} from '../../models/pool/Protocol';
import {BaseCachingPoolDiscoverer} from './BaseCachingPoolDiscoverer';
import {UniPoolInfo} from './interface';

export interface PoolSnapshotPrewarmTarget {
  chainId: ChainId;
  protocol: Protocol;
}

export type PoolDiscovererByProtocol = Partial<
  Record<Protocol, BaseCachingPoolDiscoverer<UniPoolInfo>>
>;

/**
 * Proactively keeps the in-process pool-snapshot memo warm for a configured
 * set of (chainId, protocol) pairs, so a live request is never the unlucky
 * first one that finds no servable stale snapshot — on a freshly booted task
 * (empty memo) or after a sparsely-trafficked chain's memo ages past
 * SnapshotMaxStaleSeconds — and has to block on a cold S3 fetch+parse
 * (multi-second for a large snapshot; see BaseCachingPoolDiscoverer's SWR
 * mechanism). Same shape as DynamicZlcaHooksRefresher: boot + interval,
 * fail-open per target (a bad target can't block the others or the loop),
 * bounded concurrency so boot doesn't fire every configured target as one
 * unbounded Promise.all.
 *
 * `prewarm()` on the underlying discoverer reuses the exact
 * single-flight/parse/memo path a live request's cache miss would take — no
 * separate fetch logic, so this can never diverge from serving behavior.
 */
export class PoolSnapshotPrewarmer {
  private timer: NodeJS.Timeout | undefined;
  private inFlight = false;

  constructor(
    private readonly targets: readonly PoolSnapshotPrewarmTarget[],
    private readonly discoverers: PoolDiscovererByProtocol,
    private readonly ctx: Context,
    private readonly intervalMs: number,
    private readonly concurrency = 4
  ) {}

  async refreshOnce(): Promise<void> {
    // In-flight guard: a slow prewarm pass (e.g. several cold multi-second
    // fetches) must not pile a second full pass on top of it every interval
    // tick — targets already in flight are joined via the discoverer's own
    // single-flight, so a concurrent pass would mostly just wait on the same
    // promises, but the guard keeps this loop's own concurrency bound
    // meaningful.
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      let nextIndex = 0;
      const worker = async (): Promise<void> => {
        while (nextIndex < this.targets.length) {
          const target = this.targets[nextIndex++];
          const discoverer = this.discoverers[target.protocol];
          if (!discoverer) {
            this.ctx.logger.warn(
              `PoolSnapshotPrewarmer: no discoverer registered for protocol ${target.protocol}, skipping chain ${target.chainId}`
            );
            continue;
          }
          try {
            // prewarm() is already fail-open internally (catches + logs +
            // emits its own status metric) — this try/catch is defense in
            // depth, matching DynamicZlcaHooksRefresher's per-item guard, so
            // a discoverer that ever violates that contract can't reject
            // this whole pass (and, on an interval tick, become an
            // unhandled rejection).
            await discoverer.prewarm(target.chainId, target.protocol, this.ctx);
          } catch (error) {
            this.ctx.logger.warn(
              `PoolSnapshotPrewarmer: prewarm threw unexpectedly for chainId=${target.chainId}, protocol=${target.protocol}`,
              {error}
            );
          }
        }
      };
      const workerCount = Math.min(this.concurrency, this.targets.length);
      await Promise.all(Array.from({length: workerCount}, worker));
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Starts the interval and returns the initial pass's promise so boot
   * sequences can await first population (bounded by the caller — see
   * init.ts) before serving quotes.
   */
  start(): Promise<void> {
    if (this.timer) return Promise.resolve();
    const initialRefresh = this.refreshOnce();
    this.timer = setInterval(() => void this.refreshOnce(), this.intervalMs);
    this.timer.unref?.();
    return initialRefresh;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
