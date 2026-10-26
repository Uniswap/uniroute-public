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
} from '@aws-sdk/client-s3';
import * as zlib from 'zlib';
import {promisify} from 'node:util';
import _ from 'lodash';
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

// Async inflate is unconditional (not behind the snapshot SWR flag): it keeps
// the decompressed output identical to inflateSync while moving the work off
// the event loop, so it changes flag-off request timing but not results.
const inflateAsync = promisify(zlib.inflate);

const SNAPSHOT_AGE_METRIC = buildMetricKey(
  'S3SubgraphPoolDiscoverer.SnapshotAgeSeconds'
);

interface BasePoolData {
  id: string;
  token0: {id: string};
  token1: {id: string};
}

interface V2PoolData extends BasePoolData {
  liquidity?: string;
  supply?: number;
  reserve?: number;
  reserveUSD?: number;
}

interface V3PoolData extends BasePoolData {
  liquidity: string;
  tvlETH: number;
  tvlUSD: number;
  feeTier: number;
}

interface V4PoolData extends V3PoolData {
  tickSpacing: string;
  hooks: string;
  isExternalLiquidity?: boolean;
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

export const S3_POOL_CACHE_KEY = (
  baseKey: string,
  chain: ChainId,
  protocol: Protocol
) => `${baseKey}-${chain}-${protocol.toUpperCase()}`;

abstract class BaseS3SubgraphPoolDiscoverer<
  TPoolInfo extends UniPoolInfo,
  TPoolData extends BasePoolData,
> extends BaseCachingPoolDiscoverer<TPoolInfo> {
  constructor(
    protected serviceConfig: IUniRouteServiceConfig,
    protected getPoolsCache: IRedisCache<string, string>,
    protected getPoolsForTokensCache: IRedisCache<string, string>,
    protected featureGatedTokensRepository: FeatureGatedTokensRepository,
    protected readonly s3: S3Client,
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

  protected readonly TrackedEthThreshold: number = 0.01;

  // Fetch start of the object last loaded per S3 key so a 304 refresh can still report its age
  private readonly snapshotFetchStartMsByKey = new Map<string, number>();

  protected getDiscovererName(): string {
    return 'BaseS3SubgraphPoolDiscoverer';
  }

  protected abstract convertToPoolInfo(
    rawPool: TPoolData
  ): TPoolInfo | undefined;

  // Inputs of forceSelectSpecialPools that can change at runtime, as a
  // comparable string; the base filter has none.
  protected snapshotFilterVersion(_chainId: ChainId): string {
    return '';
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
    const load = await this.fetchSnapshot(chainId, protocol, ifNoneMatch, ctx);
    // The hook set moved while the request was in flight, so the unchanged
    // object still has to be filtered again.
    if (
      load.status === SnapshotLoadStatus.UNCHANGED &&
      this.snapshotFilterVersion(chainId) !== filterVersion
    ) {
      return this.fetchSnapshot(chainId, protocol, undefined, ctx);
    }
    return load;
  }

  protected override async _getPools(
    chainId: ChainId,
    protocol: Protocol,
    ctx: Context
  ): Promise<TPoolInfo[]> {
    const load = await this.fetchSnapshot(chainId, protocol, undefined, ctx);
    return load.status === SnapshotLoadStatus.LOADED ? load.pools : [];
  }

  private async fetchSnapshot(
    chainId: ChainId,
    protocol: Protocol,
    ifNoneMatch: string | undefined,
    ctx: Context
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
        this.emitSnapshotAge(s3Key, snapshotAgeTags, ctx);
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

      // Decompress and parse the data
      const before2 = Date.now();
      const poolString = (await inflateAsync(poolsBytes)).toString('utf-8');
      const poolsData = JSON.parse(poolString) as TPoolData[];
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

      // Process pools using the subclass-specific conversion
      const poolAddressSet = new Set<string>();
      const poolInfos: TPoolInfo[] = _(poolsData)
        .map(pool => {
          const {id} = pool;
          if (poolAddressSet.has(id)) {
            return undefined;
          }
          poolAddressSet.add(id);

          return this.convertToPoolInfo(pool);
        })
        .compact()
        .value();

      ctx.logger.debug(
        `Got subgraph pools from S3 for protocol ${protocol} on ${chainId}. Num: ${poolInfos.length}`,
        {bucket: this.serviceConfig.S3.poolBucketName, key: s3Key}
      );

      // Read with no await between here and the filter below, so the
      // version stored with this snapshot is exactly what the filter used.
      const filterVersion = this.snapshotFilterVersion(chainId);
      // Keep only pools with > `TrackedEthThreshold` TVL
      // TODO: In the future we might consider removing all filtering from here (and just trust whatever is in the S3)
      // as we already do similar filtering there
      let filteredPools: TPoolInfo[] = [];
      switch (protocol) {
        case Protocol.V2:
          filteredPools = (poolInfos as V2PoolInfo[]).filter(
            pool =>
              pool.reserve > this.TrackedEthThreshold ||
              this.forceSelectSpecialPools(pool as TPoolInfo, chainId)
          ) as TPoolInfo[];
          break;
        case Protocol.V3:
          // Special treatment for all V3 pools in order to reduce latency due to thousands of pools with very low TVL locked
          // - Include "parseFloat(pool.totalValueLockedETH) === 0" as in certain occasions we have no way of calculating derivedETH so this is 0
          filteredPools = (poolInfos as V3PoolInfo[]).filter(
            pool =>
              (parseInt(pool.liquidity) > 0 && pool.tvlETH === 0) ||
              pool.tvlETH > this.TrackedEthThreshold ||
              this.forceSelectSpecialPools(pool as TPoolInfo, chainId)
          ) as TPoolInfo[];
          break;
        case Protocol.V4:
          filteredPools = (poolInfos as V4PoolInfo[]).filter(
            pool =>
              pool.isExternalLiquidity ||
              parseInt(pool.liquidity) > 0 ||
              pool.tvlETH > this.TrackedEthThreshold ||
              this.forceSelectSpecialPools(pool as TPoolInfo, chainId)
          ) as TPoolInfo[];
          break;
        default:
          throw new Error('Unsupported protocol: ' + protocol);
      }

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

      this.recordSnapshotFetchStart(s3Key, response, ctx);
      this.emitSnapshotAge(s3Key, snapshotAgeTags, ctx);
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

  // Remembers when the loaded object's data was fetched, LastModified standing in for objects written without the metadata
  private recordSnapshotFetchStart(
    s3Key: string,
    response: GetObjectCommandOutput,
    ctx: Context
  ): void {
    const fetchStart =
      parseSnapshotFetchStart(
        response.Metadata?.[FETCH_START_METADATA_KEY],
        Date.now()
      ) ?? response.LastModified;
    if (fetchStart === undefined) {
      ctx.logger.warn(
        'Pool snapshot carries neither a fetch start nor LastModified',
        {s3Key}
      );
      this.snapshotFetchStartMsByKey.delete(s3Key);
      return;
    }
    this.snapshotFetchStartMsByKey.set(s3Key, fetchStart.getTime());
  }

  // Gauges how old the snapshot this process serves is, which is the staleness users see when the cron stops writing
  private emitSnapshotAge(
    s3Key: string,
    snapshotAgeTags: string[],
    ctx: Context
  ): void {
    const fetchStartMs = this.snapshotFetchStartMsByKey.get(s3Key);
    // Only an object with neither timestamp leaves nothing to report, and that load already warned
    if (fetchStartMs === undefined) {
      return;
    }
    const ageSeconds = Math.max(0, (Date.now() - fetchStartMs) / 1000);
    void ctx.metrics
      .gauge(SNAPSHOT_AGE_METRIC, ageSeconds, {tags: snapshotAgeTags})
      .catch(error => {
        ctx.logger.warn('Failed to emit pool snapshot age gauge', {
          s3Key,
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

  /**
   * To be implemented by the sub-classes.
   * @param _pool - The pool to check.
   * @param _chainId - The chain ID of the pool.
   * @returns - Whether to force select the pool.
   */
  protected forceSelectSpecialPools(
    _pool: TPoolInfo,

    _chainId: ChainId
  ): boolean {
    return false;
  }
}

export class S3SubgraphPoolDiscovererV2 extends BaseS3SubgraphPoolDiscoverer<
  V2PoolInfo,
  V2PoolData
> {
  protected override getDiscovererName(): string {
    return 'S3SubgraphPoolDiscovererV2';
  }

  protected override convertToPoolInfo(
    pool: V2PoolData
  ): V2PoolInfo | undefined {
    const {token0, token1, id} = pool;
    return {
      id: id.toLowerCase(),
      token0: {
        id: token0.id.toLowerCase(),
      },
      token1: {
        id: token1.id.toLowerCase(),
      },
      supply: pool.supply || 100,
      reserve: pool.reserve || 100,
      reserveUSD: pool.reserveUSD || 100,
    };
  }

  /**
   * Force select pools that contain the certain token.
   * @param pool - The pool to check.
   * @param chainId - The chain ID of the pool.
   * @returns - Whether to force select the pool.
   */
  protected override forceSelectSpecialPools(
    pool: V2PoolInfo,
    chainId: ChainId
  ): boolean {
    // TODO: Remove. Temporary fix to ensure tokens without trackedReserveETH are in the list.
    const FEI = '0x956f47f50a910163d8bf957cf5846d573e7f87ca';

    return (
      pool.token0.id === FEI ||
      pool.token1.id === FEI ||
      this.isVirtualPairBaseV2Pool(pool, chainId)
    );
  }

  // This method checks if a given pool contains the VIRTUAL token.
  private isVirtualPairBaseV2Pool(pool: V2PoolInfo, chainId: ChainId): boolean {
    const virtualTokenAddress =
      '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b'.toLowerCase();

    return (
      chainId === ChainId.BASE &&
      (pool.token0.id.toLowerCase() === virtualTokenAddress ||
        pool.token1.id.toLowerCase() === virtualTokenAddress)
    );
  }
}

export class S3SubgraphPoolDiscovererV3 extends BaseS3SubgraphPoolDiscoverer<
  V3PoolInfo,
  V3PoolData
> {
  protected override getDiscovererName(): string {
    return 'S3SubgraphPoolDiscovererV3';
  }

  protected override convertToPoolInfo(
    pool: V3PoolData
  ): V3PoolInfo | undefined {
    const {token0, token1, id, liquidity, feeTier, tvlETH, tvlUSD} = pool;

    return {
      id: id.toLowerCase(),
      feeTier: feeTier.toString(),
      liquidity: liquidity.toString(),
      token0: {
        id: token0.id.toLowerCase(),
      },
      token1: {
        id: token1.id.toLowerCase(),
      },
      tvlETH: tvlETH,
      tvlUSD: tvlUSD,
    };
  }
}

export class S3SubgraphPoolDiscovererV4 extends BaseS3SubgraphPoolDiscoverer<
  V4PoolInfo,
  V4PoolData
> {
  constructor(
    serviceConfig: IUniRouteServiceConfig,
    getPoolsCache: IRedisCache<string, string>,
    getPoolsForTokensCache: IRedisCache<string, string>,
    featureGatedTokensRepository: FeatureGatedTokensRepository,
    s3: S3Client,
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

  /**
   * Force select TVL-bypass hook pools (ZLCA hooks + zero-measured-TVL
   * hooks — see the ZLCA_HOOKS_PER_CHAIN and
   * ZERO_MEASURED_TVL_HOOKS_PER_CHAIN doc comments in
   * hooksAddressesAllowlist.ts). Their `liquidity` is structurally 0 and
   * `tvlETH` doesn't reflect their real economic backing, so the liquidity/TVL
   * filter above would otherwise silently drop them here — even though they
   * already cleared the pool-caching pipeline's own exemptions for the same
   * reason.
   */
  protected override forceSelectSpecialPools(
    pool: V4PoolInfo,
    chainId: ChainId
  ): boolean {
    const bypassHooks = getTvlBypassHookAddresses(chainId);
    if (!bypassHooks) return false;
    return bypassHooks.has(pool.hooks.toLowerCase());
  }

  protected override convertToPoolInfo(
    pool: V4PoolData
  ): V4PoolInfo | undefined {
    const {
      token0,
      token1,
      id,
      liquidity,
      feeTier,
      tvlETH,
      tvlUSD,
      tickSpacing,
      hooks,
      isExternalLiquidity,
    } = pool;
    // TODO: We need to know if a pool is DYNAMIC_FEE_FLAG with a subgraph field.
    // https://linear.app/uniswap/issue/ROUTE-607/
    // Currently dynamic fee hooked pools don't return the dynamic fee flag as feeTier but whatever feeTier is current.
    return {
      id: id.toLowerCase(),
      feeTier: feeTier.toString(),
      liquidity: liquidity.toString(),
      tickSpacing: tickSpacing.toString(),
      hooks: hooks.toString(),
      token0: {
        id: token0.id.toLowerCase(),
      },
      token1: {
        id: token1.id.toLowerCase(),
      },
      tvlETH: tvlETH,
      tvlUSD: tvlUSD,
      // Conditional spread: don't materialize an undefined-valued key. Most
      // pools lack this S3 field, and an always-present undefined key would
      // force the memo-path normalization in BaseCachingPoolDiscoverer to
      // mass-delete it across the snapshot (delete also degrades V8 object
      // shapes on the served, memoized pools).
      ...(isExternalLiquidity !== undefined && {isExternalLiquidity}),
    };
  }
}
