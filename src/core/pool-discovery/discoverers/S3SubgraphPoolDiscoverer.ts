import {V2PoolInfo, V3PoolInfo, V4PoolInfo, UniPoolInfo} from '../interface';
import {Context} from '@uniswap/lib-uni/context';
import {ChainId} from '../../../lib/config';
import {Protocol} from '../../../models/pool/Protocol';
import {Address} from '../../../models/address/Address';
import {
  BaseCachingPoolDiscoverer,
  SnapshotLoad,
  SnapshotLoadStatus,
} from '../BaseCachingPoolDiscoverer';
import {FeatureGatedTokensRepository} from '../../../stores/compliance/FeatureGatedTokensRepository';
import {CanonicalPools} from '../../../lib/CanonicalPools';
import {IRedisCache} from '@uniswap/lib-cache';
import {buildMetricKey, IUniRouteServiceConfig} from '../../../lib/config';
import {
  S3Client,
  GetObjectCommand,
  GetObjectCommandOutput,
  HeadObjectCommand,
  HeadObjectCommandOutput,
} from '@aws-sdk/client-s3';
import * as zlib from 'zlib';
import {promisify} from 'node:util';
import {getTvlBypassHookAddresses} from '../../../lib/poolCaching/util/hooksAddressesAllowlist';
import {
  isDenylistedCcaHook,
  isAutoApprovedCcaHook,
} from '../../../lib/poolCaching/ccaScheduledPools';
import {CcaScheduledPoolsRepository} from '../CcaScheduledPoolsRepository';
import {HooksOptions} from '../../../models/hooks/HooksOptions';
import {IPoolSnapshotWarmer, ITopPoolsSelector} from '../interface';
import {RouteNamespaceContext} from '../../../models/hooks/namespaces';
import {ADDRESS_ZERO} from '@uniswap/router-sdk';
import {
  getErc4626WrapperDiscoveryPairs,
  shouldUseErc4626Namespace,
  synthesizeErc4626WrapperPools,
} from '../../../models/hooks/Erc4626WrapperHooks';
import {isStaticFeeWithinSanityCeiling} from '../../../lib/poolCaching/util/feeTierSanityCeiling';
import {
  FETCH_START_METADATA_KEY,
  parseSnapshotFetchStart,
} from '../../../lib/poolCaching/util/snapshotFetchStart';
import {
  SnapshotRecordSkipCounts,
  SnapshotTransformParams,
  SnapshotTransformResult,
  transformSnapshotPoolBytes,
} from './s3SnapshotTransform';
import {
  ISnapshotParseOffloader,
  SnapshotParseOffloadError,
  SnapshotParseOffloadFailureReason,
} from './SnapshotParseOffloader';

// Async inflate is unconditional (not behind the snapshot SWR flag): it keeps
// the decompressed output identical to inflateSync while moving the work off
// the event loop, so it changes flag-off request timing but not results.
const inflateAsync = promisify(zlib.inflate);

const SNAPSHOT_AGE_METRIC = buildMetricKey(
  'S3SubgraphPoolDiscoverer.SnapshotAgeSeconds'
);

const SNAPSHOT_PARSE_FALLBACK_METRIC = buildMetricKey(
  'S3SubgraphPoolDiscoverer.SnapshotParseFallback'
);

const SKIPPED_SNAPSHOT_RECORD_METRIC = buildMetricKey(
  'S3SubgraphPoolDiscoverer.SkippedSnapshotRecord'
);

// What a refresh served after the snapshot parse offload failed.
enum SnapshotParseFallback {
  KEPT_HELD_SNAPSHOT = 'kept_held_snapshot',
  MAIN_THREAD_PARSE = 'main_thread_parse',
}

// GetObject with IfNoneMatch answers 304 for an unchanged object, which the
// SDK surfaces as a thrown service exception carrying the HTTP status.
function isS3NotModified(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    '$metadata' in error &&
    typeof error.$metadata === 'object' &&
    error.$metadata !== null &&
    'httpStatusCode' in error.$metadata &&
    error.$metadata.httpStatusCode === 304
  );
}

// The object fields the snapshot age is read from, as GetObject and HeadObject both report them
type SnapshotObjectTimestamps = Pick<
  GetObjectCommandOutput,
  'Metadata' | 'LastModified'
>;

// A snapshot's source version is the object's ETag joined with the runtime
// inputs of the load-time filter; an ETag never contains the separator.
const SNAPSHOT_VERSION_SEPARATOR = '|';

function encodeSnapshotVersion(etag: string, filterVersion: string): string {
  return `${etag}${SNAPSHOT_VERSION_SEPARATOR}${filterVersion}`;
}

function decodeSnapshotVersion(
  version: string
): {etag: string; filterVersion: string} | undefined {
  const separatorAt = version.indexOf(SNAPSHOT_VERSION_SEPARATOR);
  if (separatorAt < 0) {
    return undefined;
  }
  return {
    etag: version.slice(0, separatorAt),
    filterVersion: version.slice(separatorAt + 1),
  };
}

// Runtime check standing in for what the TPoolInfo generic can't prove at
// compile time: that a UniPoolInfo[] produced for a given `protocol` is
// actually shaped like that protocol's pool type (V2PoolInfo has no feeTier;
// V3/V4PoolInfo always do). Throws rather than silently mis-shaping data —
// matches transformSnapshotPoolBytes's own "throws on malformed input"
// contract.
function assertPoolShapeMatchesProtocol(
  pools: UniPoolInfo[],
  protocol: Protocol
): void {
  for (const pool of pools) {
    const hasFeeTier = 'feeTier' in pool;
    const expectsFeeTier = protocol === Protocol.V3 || protocol === Protocol.V4;
    if (hasFeeTier !== expectsFeeTier) {
      throw new Error(
        `Snapshot parse offloader returned a pool shape inconsistent with protocol ${protocol}: ${pool.id}`
      );
    }
  }
}

export const S3_POOL_CACHE_KEY = (
  baseKey: string,
  chain: ChainId,
  protocol: Protocol
) => `${baseKey}-${chain}-${protocol.toUpperCase()}`;

abstract class BaseS3SubgraphPoolDiscoverer<
  TPoolInfo extends UniPoolInfo,
> extends BaseCachingPoolDiscoverer<TPoolInfo> {
  constructor(
    protected serviceConfig: IUniRouteServiceConfig,
    protected getPoolsCache: IRedisCache<string, string>,
    protected getPoolsForTokensCache: IRedisCache<string, string>,
    protected featureGatedTokensRepository: FeatureGatedTokensRepository,
    protected readonly s3: S3Client,
    protected readonly snapshotParseOffloader: ISnapshotParseOffloader,
    snapshotWarmer?: IPoolSnapshotWarmer
  ) {
    super(
      serviceConfig,
      getPoolsCache,
      getPoolsForTokensCache,
      featureGatedTokensRepository,
      'BaseS3SubgraphPoolDiscoverer',
      [Protocol.V2, Protocol.V3, Protocol.V4],
      snapshotWarmer
    );
  }

  protected getDiscovererName(): string {
    return 'BaseS3SubgraphPoolDiscoverer';
  }

  // Inputs of the snapshot's force-select filter (forceSelectV2Pool /
  // forceSelectV4Pool in s3SnapshotTransform.ts) that can change at runtime,
  // as a comparable string; the base filter has none.
  protected snapshotFilterVersion(_chainId: ChainId): string {
    return '';
  }

  // Runtime inputs the snapshot transform needs beyond (poolString, protocol,
  // chainId) — e.g. V4's TVL-bypass hook set, which lives in a module-level
  // store a worker thread cannot see (see SnapshotTransformParams). The base
  // filter has none.
  protected buildSnapshotTransformExtras(
    _chainId: ChainId
  ): Partial<SnapshotTransformParams> {
    return {};
  }

  // A conditional GET on the known ETag, but only while the filter inputs
  // it was filtered with still hold: a changed hook set needs the object
  // re-filtered even when S3 would answer 304.
  protected override async loadSnapshot(
    chainId: ChainId,
    protocol: Protocol,
    knownVersion: string | undefined,
    ctx: Context
  ): Promise<SnapshotLoad<TPoolInfo>> {
    const filterVersion = this.snapshotFilterVersion(chainId);
    const known =
      knownVersion === undefined
        ? undefined
        : decodeSnapshotVersion(knownVersion);
    const ifNoneMatch =
      known?.filterVersion === filterVersion ? known.etag : undefined;
    const load = await this.fetchSnapshot(chainId, protocol, ifNoneMatch, {
      allowDeferral: true,
      ctx,
    });
    // The hook set moved while the request was in flight, so the unchanged
    // object still has to be filtered again.
    if (
      load.status === SnapshotLoadStatus.UNCHANGED &&
      this.snapshotFilterVersion(chainId) !== filterVersion
    ) {
      return this.fetchSnapshot(chainId, protocol, undefined, {
        allowDeferral: true,
        ctx,
      });
    }
    return load;
  }

  protected override async _getPools(
    chainId: ChainId,
    protocol: Protocol,
    ctx: Context
  ): Promise<TPoolInfo[]> {
    // A caller of _getPools has no held snapshot to keep, so the load never
    // defers.
    const load = await this.fetchSnapshot(chainId, protocol, undefined, {
      allowDeferral: false,
      ctx,
    });
    return load.status === SnapshotLoadStatus.LOADED ? load.pools : [];
  }

  private async fetchSnapshot(
    chainId: ChainId,
    protocol: Protocol,
    ifNoneMatch: string | undefined,
    {allowDeferral, ctx}: {allowDeferral: boolean; ctx: Context}
  ): Promise<SnapshotLoad<TPoolInfo>> {
    // Guard before try/catch so programming errors propagate instead of being swallowed
    if (!this.supportedProtocols.includes(protocol)) {
      throw new Error(`Unsupported protocol: ${protocol}`);
    }

    const poolCallStartTime = Date.now();
    const metricTags = [`chain:${ChainId[chainId]}`, `protocol:${protocol}`];
    // The gauge also carries the numeric chain id so the pool cache monitors key on the same lane tags as the cron metrics
    const snapshotAgeTags = [...metricTags, `chainid:${chainId}`];
    let success = false;
    let shouldEmitDownloadMetrics = true;

    try {
      // Fetch gzipped data from S3
      const s3Key = S3_POOL_CACHE_KEY(
        this.serviceConfig.S3.poolBaseKey,
        chainId,
        protocol
      );
      const before = Date.now();
      let response: GetObjectCommandOutput;
      try {
        response = await this.s3.send(
          new GetObjectCommand({
            Bucket: this.serviceConfig.S3.poolBucketName,
            Key: s3Key,
            IfNoneMatch: ifNoneMatch,
          })
        );
      } catch (error) {
        if (ifNoneMatch === undefined || !isS3NotModified(error)) {
          throw error;
        }
        // No object was downloaded, so the download metrics skip a 304. It
        // gets its own latency, so a slow conditional GET stays visible.
        shouldEmitDownloadMetrics = false;
        void ctx.metrics
          .count(
            buildMetricKey('S3SubgraphPoolDiscoverer.NotModified.Latency'),
            Date.now() - before,
            {tags: metricTags}
          )
          .catch(() => undefined);
        await this.emitSnapshotAgeAfterNotModified(s3Key, snapshotAgeTags, ctx);
        return {status: SnapshotLoadStatus.UNCHANGED};
      }
      const after = Date.now();

      ctx.logger.debug(
        `[Latency] Downloaded s3 object for ${protocol} on ${chainId} with latency ${after - before} milliseconds.`,
        {bucket: this.serviceConfig.S3.poolBucketName, key: s3Key}
      );
      await ctx.metrics.count(
        buildMetricKey('S3SubgraphPoolDiscoverer.DownloadPoolObject.Latency'),
        after - before,
        {
          tags: metricTags,
        }
      );

      const {Body: bodyStream} = response;

      if (!bodyStream) {
        ctx.logger.warn('No pools data found in S3', {chainId, protocol});
        return {status: SnapshotLoadStatus.LOADED, pools: []};
      }

      const poolsBytes = await bodyStream.transformToByteArray();

      // Decompression stays here (already off the event loop via inflateAsync
      // — see the module comment). The utf-8 decode of these bytes happens
      // wherever the offloader actually runs the parse (main thread or a
      // worker — see snapshotParseWorker.ts), not here, so a large snapshot's
      // decode cost moves with the rest of the CPU-bound work. Read
      // filterVersion/extras synchronously, no await between them and the
      // transform call below, so the version stored with this snapshot is
      // exactly what the filter used — a background DynamicZlcaHooksRefresher
      // update landing mid-call must not desync the two.
      const inflatedBytes = await inflateAsync(poolsBytes);
      const filterVersion = this.snapshotFilterVersion(chainId);
      const transformExtras = this.buildSnapshotTransformExtras(chainId);

      // The CPU-bound utf-8 decode + JSON.parse + per-pool conversion +
      // TVL/liquidity filter (the actual event-loop stall on a large
      // snapshot — ~300k V4 pools on Robinhood) is delegated to
      // snapshotParseOffloader, which may run it on a worker thread instead
      // of this one (see WorkerThreadSnapshotParseOffloader). Behavior is
      // identical either way: both implementations call the same pure
      // transformSnapshotPoolBytes.
      const before2 = Date.now();
      const transformParams = {chainId, protocol, ...transformExtras};
      let transformResult: SnapshotTransformResult;
      try {
        transformResult =
          await this.snapshotParseOffloader.parseAndFilterSnapshot(
            inflatedBytes,
            transformParams,
            ctx
          );
      } catch (error) {
        if (!(error instanceof SnapshotParseOffloadError)) {
          throw error;
        }
        // The worker could not parse this snapshot. Keep serving the held
        // one while it is inside the stale-serve bound, so the stall the
        // worker exists to remove is not put back on the event loop; with
        // nothing servable, parse here, since an empty snapshot is worse
        // than a slow one.
        const keepHeld =
          allowDeferral && this.hasServableStaleSnapshot(chainId, protocol);
        this.recordSnapshotParseFallback(
          metricTags,
          error.reason,
          keepHeld
            ? SnapshotParseFallback.KEPT_HELD_SNAPSHOT
            : SnapshotParseFallback.MAIN_THREAD_PARSE,
          ctx
        );
        if (keepHeld) {
          return {status: SnapshotLoadStatus.DEFERRED};
        }
        transformResult = transformSnapshotPoolBytes(
          inflatedBytes,
          transformParams
        );
      }
      this.recordSkippedSnapshotRecords(
        metricTags,
        transformResult.skippedRecords,
        ctx
      );
      const parsedPools = transformResult.pools;
      // transformSnapshotPoolBytes returns UniPoolInfo[] regardless of
      // protocol (it is shared across every BaseS3SubgraphPoolDiscoverer<T>
      // subclass); `protocol` here always matches the generic TPoolInfo this
      // particular subclass was instantiated with (S3SubgraphPoolDiscovererV2
      // only ever calls this with Protocol.V2, etc.), but TypeScript can't
      // see that invariant through the generic boundary. Verify it at
      // runtime instead of asserting it away with a bare cast.
      assertPoolShapeMatchesProtocol(parsedPools, protocol);
      const filteredPools = parsedPools as TPoolInfo[];
      const after2 = Date.now();

      ctx.logger.debug(
        `[Latency] Parsed subgraph pools from S3 for protocol ${protocol} on ${chainId} with latency ${after2 - before2} milliseconds.`,
        {bucket: this.serviceConfig.S3.poolBucketName, key: s3Key}
      );
      await ctx.metrics.count(
        buildMetricKey('S3SubgraphPoolDiscoverer.ParsePoolObject.Latency'),
        after2 - before2,
        {
          tags: metricTags,
        }
      );

      ctx.logger.debug(`Kept ${filteredPools.length} pools`, {
        chainId,
        protocol,
      });

      // Whole-snapshot check: the one place "registry id is wrong / the
      // snapshot lacks the canonical pool" can be evaluated without the
      // protocol-scoped or per-request false alarms a candidate-set check
      // would raise.
      CanonicalPools.checkRegistryCoverage(
        chainId,
        protocol,
        filteredPools,
        ctx
      );

      this.emitSnapshotAge(
        this.snapshotFetchStartMs(s3Key, response, ctx),
        snapshotAgeTags,
        ctx
      );
      success = true;
      return {
        status: SnapshotLoadStatus.LOADED,
        pools: filteredPools,
        sourceVersion:
          response.ETag === undefined
            ? undefined
            : encodeSnapshotVersion(response.ETag, filterVersion),
      };
    } catch (error) {
      ctx.logger.error('Error fetching pools from S3', {
        chainId,
        protocol,
        error,
      });
      return {status: SnapshotLoadStatus.LOADED, pools: []};
    } finally {
      if (shouldEmitDownloadMetrics) {
        metricTags.push(`status:${success ? 'success' : 'error'}`);
        await ctx.metrics.count(
          buildMetricKey('S3SubgraphPoolDiscoverer.Call'),
          1,
          {
            tags: metricTags,
          }
        );
        await ctx.metrics.dist(
          buildMetricKey('S3SubgraphPoolDiscoverer.Latency.dist'),
          Date.now() - poolCallStartTime,
          {
            tags: metricTags,
          }
        );
      }
    }
  }

  private recordSnapshotParseFallback(
    metricTags: readonly string[],
    reason: SnapshotParseOffloadFailureReason,
    fallback: SnapshotParseFallback,
    ctx: Context
  ): void {
    ctx.logger.warn(
      `[${this.getDiscovererName()}] Snapshot parse offload failed; ${fallback === SnapshotParseFallback.KEPT_HELD_SNAPSHOT ? 'keeping the held snapshot' : 'parsing on the main thread'}`,
      {metricTags, reason, fallback}
    );
    void ctx.metrics
      .count(SNAPSHOT_PARSE_FALLBACK_METRIC, 1, {
        tags: [
          ...metricTags,
          'status:failure',
          `reason:${reason}`,
          `fallback:${fallback}`,
        ],
      })
      .catch(() => undefined);
  }

  // One count per skip reason per load, and one warn line naming the counts
  // (never the records themselves).
  private recordSkippedSnapshotRecords(
    metricTags: readonly string[],
    skippedRecords: SnapshotRecordSkipCounts,
    ctx: Context
  ): void {
    const entries = Object.entries(skippedRecords).filter(
      ([, count]) => count !== undefined && count > 0
    );
    if (entries.length === 0) {
      return;
    }
    ctx.logger.warn(
      `[${this.getDiscovererName()}] Skipped malformed pool snapshot records`,
      {metricTags, skippedRecords}
    );
    for (const [reason, count] of entries) {
      void ctx.metrics
        .count(SKIPPED_SNAPSHOT_RECORD_METRIC, count ?? 0, {
          tags: [...metricTags, 'status:failure', `reason:${reason}`],
        })
        .catch(() => undefined);
    }
  }

  // When the object's data was fetched, LastModified standing in for objects written without the metadata
  private snapshotFetchStartMs(
    s3Key: string,
    object: SnapshotObjectTimestamps,
    ctx: Context
  ): number | undefined {
    const fetchStart =
      parseSnapshotFetchStart(
        object.Metadata?.[FETCH_START_METADATA_KEY],
        Date.now()
      ) ?? object.LastModified;
    if (fetchStart === undefined) {
      ctx.logger.warn(
        'Pool snapshot carries neither a fetch start nor LastModified',
        {s3Key}
      );
      return undefined;
    }
    return fetchStart.getTime();
  }

  // A 304 only says the bytes are unchanged. The cron rewrites a quiet lane's
  // snapshot with the same bytes every tick, so the ETag stays put while the
  // fetch start moves, and only the object's current metadata gives the age
  // of what this process serves.
  private async emitSnapshotAgeAfterNotModified(
    s3Key: string,
    snapshotAgeTags: string[],
    ctx: Context
  ): Promise<void> {
    let head: HeadObjectCommandOutput;
    try {
      head = await this.s3.send(
        new HeadObjectCommand({
          Bucket: this.serviceConfig.S3.poolBucketName,
          Key: s3Key,
        })
      );
    } catch (error) {
      ctx.logger.warn(
        'Pool snapshot HEAD after a 304 failed, skipping the age gauge',
        {
          s3Key,
          errorName: error instanceof Error ? error.name : typeof error,
        }
      );
      return;
    }
    this.emitSnapshotAge(
      this.snapshotFetchStartMs(s3Key, head, ctx),
      snapshotAgeTags,
      ctx
    );
  }

  // Gauges how old the snapshot this process serves is, which is the staleness users see when the cron stops writing
  private emitSnapshotAge(
    fetchStartMs: number | undefined,
    snapshotAgeTags: string[],
    ctx: Context
  ): void {
    // Only an object with neither timestamp leaves nothing to report, and that read already warned
    if (fetchStartMs === undefined) {
      return;
    }
    const ageSeconds = Math.max(0, (Date.now() - fetchStartMs) / 1000);
    void ctx.metrics
      .gauge(SNAPSHOT_AGE_METRIC, ageSeconds, {tags: snapshotAgeTags})
      .catch(error => {
        ctx.logger.warn('Failed to emit pool snapshot age gauge', {
          tags: snapshotAgeTags,
          error,
        });
      });
  }

  public override async _getPoolsForTokens(
    chainId: ChainId,
    protocol: Protocol,
    _tokenIn: Address,
    _tokenOut: Address,
    ctx: Context
  ): Promise<TPoolInfo[]> {
    // Use all retrieved pools (using BaseCachingPoolDiscoverer caching layer).
    // Filtering takes place in BaseCachingPoolDiscoverer.getPoolsForTokens, then cached.
    return await this.getPools(chainId, protocol, ctx);
  }
}

export class S3SubgraphPoolDiscovererV2 extends BaseS3SubgraphPoolDiscoverer<V2PoolInfo> {
  protected override getDiscovererName(): string {
    return 'S3SubgraphPoolDiscovererV2';
  }
}

export class S3SubgraphPoolDiscovererV3 extends BaseS3SubgraphPoolDiscoverer<V3PoolInfo> {
  protected override getDiscovererName(): string {
    return 'S3SubgraphPoolDiscovererV3';
  }
}

export class S3SubgraphPoolDiscovererV4 extends BaseS3SubgraphPoolDiscoverer<V4PoolInfo> {
  constructor(
    serviceConfig: IUniRouteServiceConfig,
    getPoolsCache: IRedisCache<string, string>,
    getPoolsForTokensCache: IRedisCache<string, string>,
    featureGatedTokensRepository: FeatureGatedTokensRepository,
    s3: S3Client,
    snapshotParseOffloader: ISnapshotParseOffloader,
    // Optional: CCA launch pools pre-registered at a known migrationBlock
    // (ROUTE-1134). Merged AFTER the caching layers so activation isn't
    // delayed by the pool-cache TTLs.
    private readonly ccaScheduledPoolsRepository?: CcaScheduledPoolsRepository,
    snapshotWarmer?: IPoolSnapshotWarmer
  ) {
    super(
      serviceConfig,
      getPoolsCache,
      getPoolsForTokensCache,
      featureGatedTokensRepository,
      s3,
      snapshotParseOffloader,
      snapshotWarmer
    );
  }

  protected override getDiscovererName(): string {
    return 'S3SubgraphPoolDiscovererV4';
  }

  // The TVL-bypass set grows with the dynamic ZLCA hook refresher
  // independently of the S3 object.
  protected override snapshotFilterVersion(chainId: ChainId): string {
    return [...(getTvlBypassHookAddresses(chainId) ?? [])].sort().join(',');
  }

  // Captured synchronously alongside snapshotFilterVersion (same
  // getTvlBypassHookAddresses read) so the two can never observe different
  // states of the bypass set — see fetchSnapshot's call site. Passed as a
  // plain array: a worker thread has its own module registry and would
  // otherwise never see DynamicZlcaHooksRefresher's in-process updates.
  protected override buildSnapshotTransformExtras(
    chainId: ChainId
  ): Partial<SnapshotTransformParams> {
    return {
      v4BypassHookAddresses: [...(getTvlBypassHookAddresses(chainId) ?? [])],
    };
  }

  public override async getPoolsForTokens(
    chainId: ChainId,
    protocol: Protocol,
    tokenIn: Address,
    tokenOut: Address,
    topPoolSelector: ITopPoolsSelector<V4PoolInfo>,
    hooksOptions: HooksOptions | undefined,
    skipPoolsForTokensCache: boolean,
    nsCtx: RouteNamespaceContext,
    ctx: Context
  ): Promise<V4PoolInfo[]> {
    const snapshot = nsCtx.erc4626Snapshot;
    const discoveryPairs =
      snapshot &&
      !nsCtx.erc4626DiscoveryPairsExpanded &&
      hooksOptions !== HooksOptions.NO_HOOKS &&
      topPoolSelector.aggHooksOnly !== true &&
      shouldUseErc4626Namespace(
        tokenIn.toString(),
        tokenOut.toString(),
        snapshot
      )
        ? getErc4626WrapperDiscoveryPairs(tokenIn, tokenOut, snapshot)
        : [[tokenIn, tokenOut] as [Address, Address]];
    const selectedPools = await Promise.all(
      discoveryPairs.map(([pairTokenIn, pairTokenOut]) =>
        super.getPoolsForTokens(
          chainId,
          protocol,
          pairTokenIn,
          pairTokenOut,
          topPoolSelector,
          hooksOptions,
          skipPoolsForTokensCache,
          nsCtx,
          ctx
        )
      )
    );
    const poolsById = new Map<string, V4PoolInfo>();
    for (const pool of selectedPools.flat()) {
      poolsById.set(pool.id.toLowerCase(), pool);
    }
    const pools = Array.from(poolsById.values());
    // The agg-hooks fetch (UniRoutesRepository's external-protocol path)
    // deliberately restricts its result to AGG_HOOKS pools; appending the
    // hookless CCA pool there would leak a plain V4 route into a request
    // whose protocol filter excluded V4. Property check, NOT instanceof:
    // PoolDiscoverer passes selectors through an anonymous adapter object.
    if (topPoolSelector.aggHooksOnly === true) {
      return pools;
    }
    const withCca = await this.mergeCcaScheduledPools(pools, chainId, ctx, {
      tokenIn,
      tokenOut,
      hooksOptions,
    });
    if (
      !snapshot ||
      hooksOptions === HooksOptions.NO_HOOKS ||
      !shouldUseErc4626Namespace(
        tokenIn.toString(),
        tokenOut.toString(),
        snapshot
      )
    ) {
      return withCca;
    }
    const seen = new Set(withCca.map(pool => pool.id.toLowerCase()));
    return [
      ...withCca,
      ...synthesizeErc4626WrapperPools(snapshot, tokenIn, tokenOut).filter(
        pool => !seen.has(pool.id.toLowerCase())
      ),
    ];
  }

  /**
   * Append active CCA scheduled pools (registry entries whose migrationBlock
   * has been reached) to the pair result. Runs AFTER the pair-level cache
   * (and never feeds either cache), so activation latency is bounded by the
   * registry's own short cache TTL, not the 900s pool-cache TTLs — and a
   * retired entry disappears with the next request instead of lingering in
   * Redis. Dedup prefers the real subgraph entry once it exists (it carries
   * true liquidity/TVL); on-chain quoting remains ground truth either way.
   *
   * Scope guards:
   * - Matching is on the LAUNCHED token only (tokenIn or tokenOut must be the
   *   auctioned token). The paired currency — usually native ETH — must not
   *   drag every active launch pool into every quote touching that currency;
   *   this merge sits after the TopN selector, outside all candidate caps.
   * - Routing-inert hooks only (hookless, or initialize-only permission
   *   bits — e.g. the LBP strategy-as-hook front-run fallback). Hooks with
   *   swap-time or custom-accounting bits go through selector trust
   *   boundaries (agg-hook segregation, permissioned-hook namespaces) that
   *   this post-selector merge bypasses — those need explicit support, not
   *   a silent bypass. Initialize-only bits have provably zero behavior
   *   after pool creation, so admitting them here is safe by construction.
   *   NO_HOOKS fetches still merge only hookless entries.
   */
  private async mergeCcaScheduledPools(
    pools: V4PoolInfo[],
    chainId: ChainId,
    ctx: Context,
    pairFilter: {
      tokenIn: Address;
      tokenOut: Address;
      hooksOptions: HooksOptions | undefined;
    }
  ): Promise<V4PoolInfo[]> {
    // The merge is strictly additive: no failure in it may degrade the base
    // result, so the whole body is fail-open.
    try {
      if (!this.ccaScheduledPoolsRepository?.isEnabled(ctx)) {
        return pools;
      }
      // HOOKS_ONLY fetches are specialized namespace paths (agg hooks,
      // permissioned hooks) — CCA entries, even inert-hooked ones, don't
      // belong there.
      if (pairFilter.hooksOptions === HooksOptions.HOOKS_ONLY) {
        return pools;
      }
      // An empty base result is PoolDiscovererWithFallback's signal to
      // consult the Direct/Static fallbacks (e.g. during an S3 pool-cache
      // outage) — appending here would mask that and serve ONLY the
      // synthesized pool. In the legitimate launch case the base is never
      // empty (the selector returns top native-side pools).
      if (pools.length === 0) {
        return pools;
      }
      const scheduled = await this.ccaScheduledPoolsRepository.getActivePools(
        chainId,
        ctx
      );
      if (scheduled.length === 0) {
        return pools;
      }

      const targets = new Set([
        pairFilter.tokenIn.lowerCased,
        pairFilter.tokenOut.lowerCased,
      ]);
      const existingIds = new Set(pools.map(pool => pool.id.toLowerCase()));
      let hookedSkipped = 0;
      let staticFeeCapSkipped = 0;
      const merged = scheduled
        .filter(({pool, launchedToken}) => {
          if (!targets.has(launchedToken)) {
            return false;
          }
          if (existingIds.has(pool.id.toLowerCase())) {
            return false;
          }
          // Defense in depth — the writer already refuses non-inert /
          // denylisted hooks; re-verify here (bits + dynamic fee + the
          // HOOKS_ADDRESSES_DENYLIST kill switch) so a hand-edited or stale
          // registry entry can't smuggle a behavioral hook past the
          // selector trust boundaries, and a denylisted hook dies on the
          // next deploy instead of surviving until registry expiry. A
          // NO_HOOKS fetch stays strictly hookless. Counted (not logged):
          // this runs per quote request.
          const hookless = pool.hooks.toLowerCase() === ADDRESS_ZERO;
          if (
            pairFilter.hooksOptions === HooksOptions.NO_HOOKS
              ? !hookless
              : !isAutoApprovedCcaHook(pool.hooks, pool.feeTier, chainId) ||
                (!hookless && isDenylistedCcaHook(chainId, pool.hooks))
          ) {
            hookedSkipped++;
            return false;
          }
          // Defense in depth: a hand-edited or stale registry entry must not
          // smuggle a confiscatory-fee pool past selector trust boundaries.
          if (!isStaticFeeWithinSanityCeiling(Number(pool.feeTier))) {
            staticFeeCapSkipped++;
            return false;
          }
          return true;
        })
        .map(({pool}) => pool);

      if (hookedSkipped > 0) {
        await ctx.metrics.count(
          buildMetricKey('CcaScheduledPools.hookedEntrySkipped'),
          hookedSkipped,
          {
            tags: [
              `chain:${ChainId[chainId]}`,
              'status:failure',
              'reason:hooked_entry',
            ],
          }
        );
      }
      if (staticFeeCapSkipped > 0) {
        await ctx.metrics.count(
          buildMetricKey('CcaScheduledPools.staticFeeCapSkipped'),
          staticFeeCapSkipped,
          {
            tags: [
              `chain:${ChainId[chainId]}`,
              'status:failure',
              'reason:static_fee_cap',
            ],
          }
        );
      }
      if (merged.length === 0) {
        return pools;
      }
      // Merged entries must clear the same restricted-token (globalSet)
      // filter every cached/selector-path pool passes through — a launched
      // token later added to the compliance list must not stay quotable via
      // the registry.
      const compliantMerged = CanonicalPools.filterAdmittedPools(
        await this.filterUnsupportedTokenPools(merged, ctx),
        chainId
      );
      if (compliantMerged.length === 0) {
        return pools;
      }
      ctx.logger.debug('Merged CCA scheduled pools into V4 pool set', {
        chainId,
        merged: compliantMerged.map(pool => pool.id),
      });
      await ctx.metrics.count(
        buildMetricKey('CcaScheduledPools.merged'),
        compliantMerged.length,
        {
          tags: [`chain:${ChainId[chainId]}`, 'status:success'],
        }
      );
      return [...pools, ...compliantMerged];
    } catch (error) {
      ctx.logger.warn('CCA scheduled pools merge failed; serving base pools', {
        chainId,
        error,
      });
      await ctx.metrics.count(
        buildMetricKey('CcaScheduledPools.mergeError'),
        1,
        {
          tags: [
            `chain:${ChainId[chainId]}`,
            'status:failure',
            'reason:merge_failed',
          ],
        }
      );
      return pools;
    }
  }
}
