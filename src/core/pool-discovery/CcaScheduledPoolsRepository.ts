import {GetObjectCommand, S3Client} from '@aws-sdk/client-s3';
import {Context} from '@uniswap/lib-uni/context';
import {buildMetricKey, ChainId} from '../../lib/config';
import {V4PoolInfo} from './interface';
import {
  CcaScheduledPoolEntry,
  CCA_SCHEDULED_POOLS_S3_KEY,
  DEFAULT_CCA_SCHEDULED_POOLS_BASE_KEY,
  isWellFormedCcaEntry,
} from '../../lib/poolCaching/ccaScheduledPools';
import {withTimeout} from '../../lib/poolCaching/util/withTimeout';

export interface CcaScheduledPoolsRepositoryConfig {
  mergeEnabled: boolean;
  s3Bucket: string;
  s3BaseKey: string;
  // In-process cache TTL for the (tiny) registry object. Bounds serve-time
  // activation latency together with activationSlackMs.
  cacheTtlMs: number;
  // Include entries slightly before their estimated activation: quoting a
  // not-yet-initialized pool just fails that candidate, while being late
  // means missing the first post-migration blocks.
  activationSlackMs: number;
  // Max time the FIRST request per chain per task waits on the inline S3
  // fetch before failing open to []. A slow-but-succeeding GET never hits
  // the fail-open catch, and an unbounded inline await would eat the sync
  // /quote budget on every cold start; the fetch keeps running and warms
  // the cache for the next request.
  coldStartMaxWaitMs: number;
}

export function ccaScheduledPoolsRepositoryConfigFromEnv(): CcaScheduledPoolsRepositoryConfig {
  return {
    mergeEnabled: process.env.CCA_SCHEDULED_POOLS_MERGE_ENABLED === 'true',
    // Same bucket the cron writer targets (the pool-cache bucket), NOT the
    // legacy S3_POOL_BUCKET_NAME serving bucket.
    s3Bucket: process.env.POOL_CACHING_S3_BUCKET || '',
    s3BaseKey:
      process.env.CCA_SCHEDULED_POOLS_S3_BASE_KEY ||
      DEFAULT_CCA_SCHEDULED_POOLS_BASE_KEY,
    cacheTtlMs: 45_000,
    activationSlackMs: 30_000,
    coldStartMaxWaitMs: 250,
  };
}

interface CachedEntries {
  entries: CcaScheduledPoolEntry[];
  fetchedAtMs: number;
}

export interface CcaScheduledActivePool {
  pool: V4PoolInfo;
  // The auctioned token. The merge appends the pool only to quotes whose
  // tokenIn/tokenOut IS this token, so the paired currency (usually native
  // ETH) doesn't drag the pool into every quote touching that currency.
  launchedToken: string;
}

/**
 * Serves the CCA scheduled-pools registry written by the cca-scheduled-pools
 * cron (see lib/poolCaching/ccaScheduledPools.ts). Read at serve time by
 * S3SubgraphPoolDiscovererV4 — AFTER its Redis/in-process pool caches, so a
 * pool becomes routable within ~cacheTtlMs of its migration block instead of
 * a full pool-cache cycle. Fail-open: any S3/parse error returns [] and
 * routing behaves exactly as without the feature. ROUTE-1134.
 */
export class CcaScheduledPoolsRepository {
  private readonly cache = new Map<number, CachedEntries>();
  private readonly inflight = new Map<
    number,
    Promise<CcaScheduledPoolEntry[]>
  >();

  constructor(
    private readonly s3: S3Client,
    private readonly config: CcaScheduledPoolsRepositoryConfig
  ) {}

  public isEnabled(ctx: Context): boolean {
    if (this.config.mergeEnabled && this.config.s3Bucket === '') {
      // Misconfiguration is boot-static — one structured error per process.
      if (!this.warnedMisconfigured) {
        this.warnedMisconfigured = true;
        ctx.logger.error(
          'CCA scheduled pools merge is enabled but POOL_CACHING_S3_BUCKET is empty; merge disabled'
        );
      }
      return false;
    }
    return this.config.mergeEnabled;
  }

  private warnedMisconfigured = false;

  /**
   * Entries whose migration block has (approximately) been reached and that
   * haven't expired, as servable V4PoolInfo. The synthesized liquidity '1' /
   * tvl 0 only affect candidate ranking — pool state is read on-chain at
   * quote time, and a pre-migration quote candidate fails harmlessly.
   */
  public async getActivePools(
    chainId: ChainId,
    ctx: Context
  ): Promise<CcaScheduledActivePool[]> {
    if (!this.isEnabled(ctx)) {
      return [];
    }
    const entries = await this.getEntries(chainId, ctx);
    const nowMs = Date.now();
    return entries
      .filter(
        entry =>
          // Shape-validate before dereferencing: a malformed entry (writer /
          // reader schema skew, manual S3 edit) must be skipped, not throw a
          // TypeError into the quote path — this feature is strictly
          // additive.
          isWellFormedCcaEntry(entry) &&
          nowMs >= entry.activateAtMs - this.config.activationSlackMs &&
          nowMs <= entry.expiresAtMs
      )
      .map(entry => ({
        pool: {
          id: entry.id.toLowerCase(),
          feeTier: entry.feeTier,
          liquidity: entry.liquidity,
          tickSpacing: entry.tickSpacing,
          hooks: entry.hooks,
          token0: {id: entry.token0.id.toLowerCase()},
          token1: {id: entry.token1.id.toLowerCase()},
          tvlETH: entry.tvlETH,
          tvlUSD: entry.tvlUSD,
        },
        launchedToken: entry.launchedToken.toLowerCase(),
      }));
  }

  /**
   * Stale-while-revalidate: only the very first request per chain awaits S3;
   * afterwards stale entries are served immediately and refreshed in the
   * background, so cache expiry never blocks the quote path.
   */
  private async getEntries(
    chainId: ChainId,
    ctx: Context
  ): Promise<CcaScheduledPoolEntry[]> {
    const cached = this.cache.get(chainId);
    if (cached) {
      if (Date.now() - cached.fetchedAtMs >= this.config.cacheTtlMs) {
        void this.refresh(chainId, ctx);
      }
      return cached.entries;
    }
    // Cold start: bound the inline wait, fail open to [] past the window
    // (the coalesced fetch keeps running and warms the cache). refresh()
    // never rejects, so the only rejection is the timeout.
    return withTimeout(
      this.refresh(chainId, ctx),
      this.config.coldStartMaxWaitMs
    ).catch(() => []);
  }

  // Coalesces concurrent refreshes for the same chain. Never rejects.
  private refresh(
    chainId: ChainId,
    ctx: Context
  ): Promise<CcaScheduledPoolEntry[]> {
    const existing = this.inflight.get(chainId);
    if (existing) {
      return existing;
    }
    const fetchPromise = this.fetchEntries(chainId, ctx).finally(() =>
      this.inflight.delete(chainId)
    );
    this.inflight.set(chainId, fetchPromise);
    return fetchPromise;
  }

  private async fetchEntries(
    chainId: ChainId,
    ctx: Context
  ): Promise<CcaScheduledPoolEntry[]> {
    const s3Key = CCA_SCHEDULED_POOLS_S3_KEY(this.config.s3BaseKey, chainId);
    try {
      const response = await this.s3.send(
        new GetObjectCommand({Bucket: this.config.s3Bucket, Key: s3Key})
      );
      const raw = response.Body
        ? await response.Body.transformToString('utf-8')
        : '[]';
      const parsed = JSON.parse(raw);
      const entries = Array.isArray(parsed)
        ? (parsed as CcaScheduledPoolEntry[])
        : [];
      this.cache.set(chainId, {entries, fetchedAtMs: Date.now()});
      return entries;
    } catch (error) {
      // NoSuchKey just means the writer hasn't published this chain yet —
      // expected, not an error signal.
      const isNoSuchKey = (error as {name?: string})?.name === 'NoSuchKey';
      if (!isNoSuchKey) {
        ctx.logger.warn('Failed to fetch CCA scheduled pools registry', {
          chainId,
          s3Key,
          error,
        });
        await ctx.metrics.count(
          buildMetricKey('CcaScheduledPools.fetchError'),
          1,
          {
            tags: [
              `chain:${ChainId[chainId]}`,
              'status:failure',
              'reason:s3_fetch_failed',
            ],
          }
        );
      }
      // Keep serving the previous entries through an S3 blip (an active
      // launch pool must not vanish on a transient error); bump fetchedAtMs
      // so the next refresh waits a full TTL instead of hammering S3.
      const previous = isNoSuchKey
        ? []
        : this.cache.get(chainId)?.entries ?? [];
      this.cache.set(chainId, {entries: previous, fetchedAtMs: Date.now()});
      return previous;
    }
  }
}
