import {ChainId, defaultPoolSelectionConfig} from '../../lib/config';
import {Protocol} from '../../models/pool/Protocol';
import {Context} from '@uniswap/lib-uni/context';
import {buildMetricKey, IUniRouteServiceConfig} from '../../lib/config';
import {
  IPoolDiscoverer,
  isPoolsArrayMemoStable,
  ITopPoolsSelector,
  markPoolsArrayMemoStable,
  markPoolsForTokensUncacheable,
  PoolsForTokensCacheDirective,
  PoolsForTokensCacheSkipReason,
  trackPoolsForTokensCacheSkip,
  UniPoolInfo,
} from './interface';
import {Address} from '../../models/address/Address';
import {ErrorNotFound, IRedisCache} from '@uniswap/lib-cache';
import {HooksOptions} from '../../models/hooks/HooksOptions';
import {RouteNamespaceContext} from '../../models/hooks/namespaces';
import {getMaxFilteredPoolCount} from './TopPoolsSelector';
import {FeatureGatedTokensRepository} from '../../stores/compliance/FeatureGatedTokensRepository';

// Upper bound on serialized size of a getPoolsForTokens cache entry, derived
// from the selector's pool-count cap and a pessimistic per-pool byte estimate.
//
// Per-pool byte estimate: V4 worst case ≈ 280-330 bytes JSON-stringified
// (id+feeTier+tickSpacing+hooks+liquidity+token0+token1+tvlETH+tvlUSD with
// 0x-prefixed addresses). Round up to 400 for safety.
//
// Safety multiplier: 4x covers experiment-hook pools (V4 + experiment opt-in,
// unbounded by config) and any future selector tweaks that don't update the
// formula. Observed prod p100 is ~21 KB — well under the derived ceiling.
const POOLS_FOR_TOKENS_CACHE_BYTES_PER_POOL_ESTIMATE = 400;
const POOLS_FOR_TOKENS_CACHE_SIZE_SAFETY_MULTIPLIER = 4;
export const POOLS_FOR_TOKENS_CACHE_VALUE_MAX_BYTES =
  getMaxFilteredPoolCount(defaultPoolSelectionConfig) *
  POOLS_FOR_TOKENS_CACHE_BYTES_PER_POOL_ESTIMATE *
  POOLS_FOR_TOKENS_CACHE_SIZE_SAFETY_MULTIPLIER;

// Base class for pool discoverers that fetch pools from a remote source and caches them.
// Will be used in the future to fetch/cache pools from different sources (e.g. subgraph, s3, indexer etc.).
// All pools (returned by `_getPools`) will be lazily fetched from the remote source and cached.
// Local cache items will expire after a certain time controlled by config.
// `getPoolsForTokens` is the main method that will be called externally to get all pools involving any of the given tokens.
// This method will filter the pools based on the given tokens and return a small number of pools (TopN logic) and cached as well.
export abstract class BaseCachingPoolDiscoverer<TPool extends UniPoolInfo>
  implements IPoolDiscoverer<TPool>
{
  protected constructor(
    protected serviceConfig: IUniRouteServiceConfig,
    protected getPoolsCache: IRedisCache<string, string>,
    protected getPoolsForTokensCache: IRedisCache<string, string>,
    protected featureGatedTokensRepository: FeatureGatedTokensRepository,
    protected discovererName: string,
    protected supportedProtocols: Protocol[] = [
      Protocol.V2,
      Protocol.V3,
      Protocol.V4,
      Protocol.MIXED,
    ]
  ) {}

  // Memoizes the parsed full-snapshot array per getPools cache key so a
  // per-pair cache miss doesn't re-JSON.parse a multi-MB snapshot string.
  // Entries are replaced in place when the underlying cache string rotates;
  // size is bounded by the (chainId, protocol) keys this discoverer serves.
  private readonly snapshotParseMemo = new Map<
    string,
    {source: string; parsed: TPool[]; fetchedAtMs: number}
  >();

  // In-flight fetches joinable for coalescing. Entries older than the join
  // max age are replaced rather than joined: the S3 client has no default
  // socket timeout, so a hung fetch must not pin the key until restart.
  private static readonly SNAPSHOT_REFRESH_JOIN_MAX_AGE_MS = 60_000;
  private readonly snapshotRefreshPromises = new Map<
    string,
    {promise: Promise<TPool[]>; startedAtMs: number}
  >();

  // Memoizes filterUnsupportedTokenPools output per (pools array, deny-list
  // payload) identity. Deny-list payloads are content-addressed and shared
  // by FeatureGatedTokensRepository, so reference keying is correct and
  // bounded; old entries are GC'd with their snapshot arrays.
  private readonly complianceFilterMemo = new WeakMap<
    TPool[],
    WeakMap<Set<string>, TPool[]>
  >();

  protected get snapshotMemoEnabled(): boolean {
    return this.serviceConfig.PoolDiscovery?.SnapshotMemoEnabled ?? false;
  }

  protected get snapshotSwrEnabled(): boolean {
    return this.serviceConfig.PoolDiscovery?.SnapshotSwrEnabled ?? false;
  }

  protected get snapshotSkipReparseEnabled(): boolean {
    return (
      this.serviceConfig.PoolDiscovery?.SnapshotSkipReparseEnabled ?? false
    );
  }

  // Makes a plain parsed/literal object graph identical to its JSON
  // round-trip without re-parsing: the only divergences for such data are
  // undefined-valued keys (kept in memory, dropped by JSON — and
  // `'key' in pool` checks downstream are sensitive to that) and undefined
  // array elements (null after JSON). O(keys) vs a multi-MB JSON.parse.
  //
  // PRECONDITIONS (unguarded — hold for every _getPools implementer):
  // 1. JSON-plain data only. For NaN/Infinity, Date/toJSON, or frozen
  //    objects this is NOT round-trip-equivalent (stringify would coerce
  //    those; the strip preserves them / delete throws on frozen), and a
  //    cyclic graph recurses forever. All current implementers return
  //    freshly JSON.parsed + literal-constructed graphs.
  // 2. No aliasing: the strip mutates in place, so implementers must not
  //    retain or share the returned array or any nested object.
  // Converters should avoid materializing undefined-valued keys in the
  // first place (see V4 isExternalLiquidity conditional spread) — mass
  // `delete` degrades V8 object shapes on the served pools; this strip is
  // defense-in-depth and should be a no-op walk in practice.
  private static stripUndefinedValuedKeysInPlace(value: unknown): void {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        if (value[i] === undefined) {
          value[i] = null;
        } else {
          BaseCachingPoolDiscoverer.stripUndefinedValuedKeysInPlace(value[i]);
        }
      }
      return;
    }
    if (value !== null && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        if (record[key] === undefined) {
          delete record[key];
        } else {
          BaseCachingPoolDiscoverer.stripUndefinedValuedKeysInPlace(
            record[key]
          );
        }
      }
    }
  }

  private get snapshotMaxStaleMs(): number {
    return (
      (this.serviceConfig.PoolDiscovery?.SnapshotMaxStaleSeconds ?? 2700) * 1000
    );
  }

  private assertSupportedProtocol(protocol: Protocol): void {
    if (!this.supportedProtocols.includes(protocol)) {
      throw new Error(
        `[${this.discovererName}] Unsupported protocol: ${protocol}. Supported protocols: ${this.supportedProtocols.join(', ')}`
      );
    }
  }

  // To be implemented by subclasses to provide a unique name for this discoverer implementation.
  // This name will be used as a prefix in cache keys to avoid conflicts between different implementations.
  protected abstract getDiscovererName(): string;

  private static filterByDenySet<T extends UniPoolInfo>(
    pools: T[],
    globalSet: Set<string>
  ): T[] {
    return pools.filter(pool => {
      return (
        !globalSet.has(pool.token0.id.toLowerCase()) &&
        !globalSet.has(pool.token1.id.toLowerCase())
      );
    });
  }

  protected async filterUnsupportedTokenPools(
    pools: TPool[],
    ctx: Context
  ): Promise<TPool[]> {
    const {globalSet} =
      await this.featureGatedTokensRepository.getSnapshot(ctx);
    return BaseCachingPoolDiscoverer.filterByDenySet(pools, globalSet);
  }

  // Same output as filterUnsupportedTokenPools, but memoized on the identity
  // of (pools, deny-list payload). For a fixed snapshot + deny payload this
  // returns a STABLE array reference, which downstream selection-view memos
  // key on.
  protected async filterUnsupportedTokenPoolsMemoized(
    pools: TPool[],
    ctx: Context
  ): Promise<TPool[]> {
    const {globalSet} =
      await this.featureGatedTokensRepository.getSnapshot(ctx);
    let byDenySet = this.complianceFilterMemo.get(pools);
    if (byDenySet === undefined) {
      byDenySet = new WeakMap();
      this.complianceFilterMemo.set(pools, byDenySet);
    }
    const memoized = byDenySet.get(globalSet);
    if (memoized !== undefined) {
      return memoized;
    }
    const filtered = BaseCachingPoolDiscoverer.filterByDenySet(
      pools,
      globalSet
    );
    byDenySet.set(globalSet, filtered);
    // Stability PROPAGATES: only outputs derived from an identity-stable
    // input can themselves recur. The per-pair getPoolsForTokens miss path
    // also runs through here with fresh per-request arrays from
    // Direct/Static discoverers — marking those would defeat the
    // selector-side gate. For stable inputs, also self-seed: re-filtering
    // the output with the same deny payload is a no-op, so callers that
    // filter an already-filtered array (the S3 getPoolsForTokens miss
    // path) get the same reference back instead of a duplicate full-chain
    // array per snapshot rotation.
    if (isPoolsArrayMemoStable(pools)) {
      const selfSeed = new WeakMap<Set<string>, TPool[]>();
      selfSeed.set(globalSet, filtered);
      this.complianceFilterMemo.set(filtered, selfSeed);
      markPoolsArrayMemoStable(filtered);
    }
    return filtered;
  }

  // Reuses the previously parsed snapshot when the cached string is unchanged
  // (InMemoryRedisCache returns the same string object until the entry is
  // rewritten, so the comparison is a pointer check in the steady state).
  private async getParsedSnapshot(
    cacheKey: string,
    source: string,
    chainId: ChainId,
    protocol: Protocol,
    ctx: Context
  ): Promise<TPool[]> {
    // Parse and publish before any await: with no suspension point between
    // the memo read and write, concurrent same-tick misses cannot each
    // re-parse the snapshot — the second caller sees the first one's entry.
    const memo = this.snapshotParseMemo.get(cacheKey);
    const result =
      memo !== undefined && memo.source === source ? 'hit' : 'miss';
    let parsed: TPool[];
    if (memo !== undefined && result === 'hit') {
      parsed = memo.parsed;
    } else {
      parsed = JSON.parse(source) as TPool[];
      this.snapshotParseMemo.set(cacheKey, {
        source,
        parsed,
        fetchedAtMs: Date.now(),
      });
      // The parsed snapshot is the stability ROOT: it recurs for the cache
      // entry's lifetime, and the compliance filter propagates the mark to
      // its derived arrays.
      markPoolsArrayMemoStable(parsed);
    }
    await ctx.metrics.count(
      buildMetricKey('PoolDiscoverer.SnapshotParse.Cache'),
      1,
      {tags: [`chain:${chainId}`, `protocol:${protocol}`, `result:${result}`]}
    );
    return parsed;
  }

  private async loadAndCachePools(
    cacheKey: string,
    chainId: ChainId,
    protocol: Protocol,
    ctx: Context
  ): Promise<TPool[]> {
    let retrievedPools = await this._getPools(chainId, protocol, ctx);
    let retrievedPoolsStr: string;
    let memoGlobalSet: Set<string> | undefined;
    if (this.snapshotMemoEnabled) {
      const {globalSet} =
        await this.featureGatedTokensRepository.getSnapshot(ctx);
      memoGlobalSet = globalSet;
      const filtered = BaseCachingPoolDiscoverer.filterByDenySet(
        retrievedPools,
        globalSet
      );
      if (this.snapshotSkipReparseEnabled) {
        // Same normalization as the round-trip below, without re-parsing
        // the just-stringified snapshot: strip undefined-valued keys in
        // place (a no-op walk when converters already omit them — see the
        // helper's preconditions) and memoize the filtered array directly.
        // In-place mutation is safe — _getPools builds fresh arrays AND
        // fresh objects per call, and deleting an undefined-valued key is
        // invisible to `=== undefined` reads.
        // Kill switch: POOL_DISCOVERY_SNAPSHOT_SKIP_REPARSE_ENABLED.
        BaseCachingPoolDiscoverer.stripUndefinedValuedKeysInPlace(filtered);
      }
      // The cache string is identical in both flag states (the strip
      // reproduces exactly the normalization JSON.stringify applies).
      retrievedPoolsStr = JSON.stringify(filtered);
      if (this.snapshotSkipReparseEnabled) {
        retrievedPools = filtered;
      } else {
        // Round-trip through JSON before memoizing so flag-on serves the
        // exact objects flag-off would (a cache read always JSON.parses):
        // e.g. a property explicitly set to undefined keeps its key on the
        // in-memory graph but is dropped by JSON — and `'tvlUSD' in pool`
        // checks are sensitive to that difference.
        retrievedPools = JSON.parse(retrievedPoolsStr) as TPool[];
      }
    } else {
      retrievedPools = await this.filterUnsupportedTokenPools(
        retrievedPools,
        ctx
      );
      retrievedPoolsStr = JSON.stringify(retrievedPools);
    }
    ctx.logger.debug(
      `[${this.discovererName}] Caching retrieved ${protocol} pools`,
      {
        cacheKey,
      }
    );
    await this.getPoolsCache.set(cacheKey, retrievedPoolsStr, {
      ttl:
        this.serviceConfig.RedisCache.PoolsCacheEntryTtlSecondsByChain?.[
          chainId
        ] ?? this.serviceConfig.RedisCache.AllPoolsCacheEntryTtlSeconds,
    });

    if (this.snapshotMemoEnabled) {
      if (memoGlobalSet === undefined) {
        throw new Error('Snapshot memo deny-list payload missing');
      }
      this.snapshotParseMemo.set(cacheKey, {
        source: retrievedPoolsStr,
        parsed: retrievedPools,
        fetchedAtMs: Date.now(),
      });
      // Seed both memos with the exact string written to the cache so the
      // first post-miss read is a memo hit. Re-filtering with the same
      // deny payload is a no-op, so the array seeds its own
      // compliance-memo entry.
      const byDenySet = new WeakMap<Set<string>, TPool[]>();
      byDenySet.set(memoGlobalSet, retrievedPools);
      this.complianceFilterMemo.set(retrievedPools, byDenySet);
      markPoolsArrayMemoStable(retrievedPools);
    }

    return retrievedPools;
  }

  private getOrStartSnapshotRefresh(
    cacheKey: string,
    chainId: ChainId,
    protocol: Protocol,
    ctx: Context
  ): Promise<TPool[]> {
    const joinable = this.getJoinableSnapshotRefresh(cacheKey);
    if (joinable !== undefined) {
      return joinable;
    }
    const entry = {
      startedAtMs: Date.now(),
      promise: undefined as unknown as Promise<TPool[]>,
    };
    entry.promise = this.loadAndCachePools(
      cacheKey,
      chainId,
      protocol,
      ctx
    ).finally(() => {
      // Identity check: an aged-out entry replaced by a newer fetch must
      // not delete the newer fetch's registration when it finally settles.
      //
      // Caveat: an aged-out fetch is not cancelled (the S3 SDK has no socket
      // timeout), so if it eventually resolves it still runs loadAndCachePools
      // to completion and can overwrite the newer fetch's cache + parse-memo
      // entry with older data, re-stamping fetchedAtMs as fresh. This is
      // bounded (requires a >SNAPSHOT_REFRESH_JOIN_MAX_AGE_MS hang that later
      // succeeds) and self-heals on the next refresh; a fetch-start timestamp
      // or a registration guard on the write path would close it fully.
      if (this.snapshotRefreshPromises.get(cacheKey) === entry) {
        this.snapshotRefreshPromises.delete(cacheKey);
      }
    });
    this.snapshotRefreshPromises.set(cacheKey, entry);
    return entry.promise;
  }

  // Returns the memoized snapshot when it is still within the stale-serve
  // window (and SWR + memo are both on), otherwise undefined. Callers get the
  // entry back so they can serve `parsed` without re-reading the memo.
  private getServableStaleSnapshot(
    cacheKey: string
  ): {source: string; parsed: TPool[]; fetchedAtMs: number} | undefined {
    const memo = this.snapshotParseMemo.get(cacheKey);
    if (
      this.snapshotSwrEnabled &&
      this.snapshotMemoEnabled &&
      memo !== undefined &&
      Date.now() - memo.fetchedAtMs <= this.snapshotMaxStaleMs
    ) {
      return memo;
    }
    return undefined;
  }

  private getJoinableSnapshotRefresh(
    cacheKey: string
  ): Promise<TPool[]> | undefined {
    const existing = this.snapshotRefreshPromises.get(cacheKey);
    if (
      existing !== undefined &&
      Date.now() - existing.startedAtMs <=
        BaseCachingPoolDiscoverer.SNAPSHOT_REFRESH_JOIN_MAX_AGE_MS
    ) {
      return existing.promise;
    }
    return undefined;
  }

  private startBackgroundSnapshotRefresh(
    cacheKey: string,
    chainId: ChainId,
    protocol: Protocol,
    ctx: Context
  ): void {
    // A joinable in-flight fetch already has a metric-emitting starter;
    // returning avoids double-counting SnapshotRefresh for the same fetch.
    if (this.getJoinableSnapshotRefresh(cacheKey) !== undefined) {
      return;
    }
    const refreshPromise = this.getOrStartSnapshotRefresh(
      cacheKey,
      chainId,
      protocol,
      ctx
    );
    void (async () => {
      try {
        await refreshPromise;
      } catch (error) {
        ctx.logger.error(
          `[${this.discovererName}] Background pool snapshot refresh failed`,
          {cacheKey, chainId, protocol, error}
        );
        try {
          await ctx.metrics.count(
            buildMetricKey('PoolDiscoverer.SnapshotRefresh'),
            1,
            {
              tags: [
                `chain:${ChainId[chainId]}`,
                `protocol:${protocol}`,
                'status:failure',
                'reason:fetch_error',
              ],
            }
          );
        } catch (metricError) {
          ctx.logger.warn(
            `[${this.discovererName}] Failed to emit snapshot refresh failure metric`,
            {cacheKey, chainId, protocol, metricError}
          );
        }
        return;
      }
      try {
        await ctx.metrics.count(
          buildMetricKey('PoolDiscoverer.SnapshotRefresh'),
          1,
          {
            tags: [
              `chain:${ChainId[chainId]}`,
              `protocol:${protocol}`,
              'status:success',
            ],
          }
        );
      } catch (metricError) {
        ctx.logger.warn(
          `[${this.discovererName}] Failed to emit snapshot refresh success metric`,
          {cacheKey, chainId, protocol, metricError}
        );
      }
    })();
  }

  // Gets pools from the cache if available, otherwise fetches them from the _getPools implementation.
  public async getPools(
    chainId: ChainId,
    protocol: Protocol,
    ctx: Context
  ): Promise<TPool[]> {
    this.assertSupportedProtocol(protocol);
    const cacheKey = this.getPoolsCacheKey(chainId, protocol);
    let status = 'hit';

    ctx.logger.debug(
      `[${this.discovererName}] Getting pools for chainId=${chainId}, protocol=${protocol}`
    );

    let retrievedPools: TPool[] | undefined = undefined;
    try {
      const retrievedPoolsStr = await this.getPoolsCache.get(cacheKey);
      if (retrievedPoolsStr !== undefined) {
        if (this.snapshotMemoEnabled) {
          const parsed = await this.getParsedSnapshot(
            cacheKey,
            retrievedPoolsStr,
            chainId,
            protocol,
            ctx
          );
          retrievedPools = await this.filterUnsupportedTokenPoolsMemoized(
            parsed,
            ctx
          );
        } else {
          retrievedPools = JSON.parse(retrievedPoolsStr);
          retrievedPools = await this.filterUnsupportedTokenPools(
            retrievedPools!,
            ctx
          );
        }
        ctx.logger.debug(
          `[${this.discovererName}] Retrieved ${protocol} pools from cache`,
          {
            cacheKey,
          }
        );
      }
    } catch (e) {
      if (!(e instanceof ErrorNotFound)) {
        // A cache-layer failure is when stale serving matters most; fall
        // through to the SWR path if it has usable data, else preserve the
        // original throw.
        if (this.getServableStaleSnapshot(cacheKey) === undefined) {
          throw e;
        }
        ctx.logger.warn(
          `[${this.discovererName}] Pool snapshot cache read failed; serving stale snapshot`,
          {cacheKey, chainId, protocol, error: e}
        );
      }
    }
    if (retrievedPools === undefined) {
      status = 'miss';
      const staleSnapshot = this.getServableStaleSnapshot(cacheKey);
      if (staleSnapshot !== undefined) {
        status = 'stale';
        this.startBackgroundSnapshotRefresh(cacheKey, chainId, protocol, ctx);
        retrievedPools = await this.filterUnsupportedTokenPoolsMemoized(
          staleSnapshot.parsed,
          ctx
        );
      } else {
        retrievedPools = this.snapshotSwrEnabled
          ? await this.getOrStartSnapshotRefresh(
              cacheKey,
              chainId,
              protocol,
              ctx
            )
          : await this.loadAndCachePools(cacheKey, chainId, protocol, ctx);
      }
    }

    await ctx.metrics.count(
      buildMetricKey('PoolDiscoverer.getPools.Cache'),
      1,
      {
        tags: ['result', status],
      }
    );

    return retrievedPools;
  }

  // To be implemented by the sub-classes.
  protected abstract _getPools(
    chainId: ChainId,
    protocol: Protocol,
    ctx: Context
  ): Promise<TPool[]>;

  // To be implemented by the sub-classes.
  protected abstract _getPoolsForTokens(
    chainId: ChainId,
    protocol: Protocol,
    tokenIn: Address,
    tokenOut: Address,
    ctx: Context
  ): Promise<TPool[]>;

  // Gets pools from the cache if available, otherwise fetches them from the _getPoolsForTokens implementation.
  // Filters the pools based on the given tokens and returns a small number of pools (topPoolSelector logic) before caching them.
  public async getPoolsForTokens(
    chainId: ChainId,
    protocol: Protocol,
    tokenIn: Address,
    tokenOut: Address,
    topPoolSelector: ITopPoolsSelector<TPool>,
    hooksOptions: HooksOptions | undefined,
    skipPoolsForTokensCache: boolean,
    nsCtx: RouteNamespaceContext,
    ctx: Context
  ): Promise<TPool[]> {
    this.assertSupportedProtocol(protocol);
    ctx.logger.debug(
      `[${this.discovererName}] Getting pools for tokens: ${tokenIn.toString()} and ${tokenOut.toString()} on chainId=${chainId}, protocol=${protocol}`
    );
    let status = 'hit';
    const cacheKey = this.getPoolsForTokensCacheKey(
      chainId,
      protocol,
      tokenIn,
      tokenOut
    );

    // Single source of truth for whether to write the cache. Initialize
    // from the caller's skipPoolsForTokensCache intent; the selector and
    // size-limit check may further flip it during the miss path.
    const cacheDirective: PoolsForTokensCacheDirective = {shouldUseCache: true};
    if (skipPoolsForTokensCache) {
      markPoolsForTokensUncacheable(
        cacheDirective,
        PoolsForTokensCacheSkipReason.CallerOptOut
      );
    }

    let retrievedPools: TPool[] | undefined;
    try {
      // Cache READ also honors the directive — CallerOptOut means bypass
      // both the read and the write.
      if (cacheDirective.shouldUseCache) {
        const retrievedPoolsStr =
          await this.getPoolsForTokensCache.get(cacheKey);
        if (retrievedPoolsStr !== undefined) {
          retrievedPools = JSON.parse(retrievedPoolsStr);
          retrievedPools = await this.filterUnsupportedTokenPools(
            retrievedPools!,
            ctx
          );
          ctx.logger.debug(
            `[${this.discovererName}] Retrieved ${protocol} pools for tokens from cache`,
            {
              cacheKey,
            }
          );
        }
      }
    } catch (e) {
      if (!(e instanceof ErrorNotFound)) {
        throw e;
      }
    }

    if (retrievedPools === undefined || retrievedPools.length === 0) {
      status = 'miss';
      retrievedPools = await this._getPoolsForTokens(
        chainId,
        protocol,
        tokenIn,
        tokenOut,
        ctx
      );

      // Filter out pools with unsupported tokens. The memoized variant keys
      // on the array identity _getPoolsForTokens returned — for S3
      // discoverers that's the stable full-snapshot array, so this full pass
      // runs once per (snapshot, deny payload) instead of per request.
      retrievedPools = this.snapshotMemoEnabled
        ? await this.filterUnsupportedTokenPoolsMemoized(retrievedPools, ctx)
        : await this.filterUnsupportedTokenPools(retrievedPools, ctx);

      // use topPoolSelector to filter pools - we need to make sure a small number of pools is returned here.
      // The selector may flip cacheDirective.shouldUseCache to signal that the
      // filtered list is namespace-state-dependent (e.g. permissioned-hook
      // pools dropped while the namespace is inactive).
      const filterPoolsStartTime = Date.now();
      retrievedPools = await topPoolSelector.filterPools(
        retrievedPools,
        chainId,
        tokenIn,
        tokenOut,
        protocol,
        hooksOptions,
        nsCtx,
        ctx,
        cacheDirective
      );
      const filterPoolsElapsed = Date.now() - filterPoolsStartTime;
      ctx.logger.debug(
        `[Latency] TopPoolsSelector.filterPools took ${filterPoolsElapsed}ms`
      );
      await ctx.metrics.dist(
        buildMetricKey('TopPoolsSelector.filterPools.Latency.dist'),
        filterPoolsElapsed,
        {tags: [`chain:${chainId}`, `protocol:${protocol}`]}
      );

      const retrievedPoolsStr = JSON.stringify(retrievedPools);
      const cacheValueBytes = Buffer.byteLength(retrievedPoolsStr, 'utf8');
      ctx.logger.debug(
        `[${this.discovererName}] Caching retrieved ${protocol} pools for tokens`,
        {
          cacheKey,
          chainId,
          protocol,
          poolCount: retrievedPools.length,
          cacheValueBytes,
          cacheValueLimitBytes: POOLS_FOR_TOKENS_CACHE_VALUE_MAX_BYTES,
          cacheValuePctOfLimit: Math.round(
            (cacheValueBytes / POOLS_FOR_TOKENS_CACHE_VALUE_MAX_BYTES) * 100
          ),
        }
      );

      if (cacheValueBytes > POOLS_FOR_TOKENS_CACHE_VALUE_MAX_BYTES) {
        markPoolsForTokensUncacheable(
          cacheDirective,
          PoolsForTokensCacheSkipReason.ValueTooLarge
        );
      }

      // Single skip-emission point — fires after all directive mutations are
      // settled (caller opt-out at init, selector flips during filterPools,
      // size-limit verdict above). Handles both logging and metrics.
      await trackPoolsForTokensCacheSkip(cacheDirective, ctx, {
        discovererName: this.discovererName,
        cacheKey,
        chainId,
        protocol,
        cacheValueBytes,
        cacheValueLimitBytes: POOLS_FOR_TOKENS_CACHE_VALUE_MAX_BYTES,
      });

      if (cacheDirective.shouldUseCache) {
        await this.getPoolsForTokensCache.set(cacheKey, retrievedPoolsStr, {
          ttl:
            this.serviceConfig.RedisCache.PoolsCacheEntryTtlSecondsByChain?.[
              chainId
            ] ??
            this.serviceConfig.RedisCache.TokenInOutPoolsCacheEntryTtlSeconds,
        });
      }
    }

    await ctx.metrics.count(
      buildMetricKey('PoolDiscoverer.getPoolsForTokens.Cache'),
      1,
      {
        tags: ['result', status],
      }
    );

    return retrievedPools;
  }

  public getPoolsCacheKey(chainId: ChainId, protocol: Protocol) {
    return `${this.getDiscovererName()}#POOLS#${chainId}#${protocol}`;
  }

  public getPoolsForTokensCacheKey(
    chainId: ChainId,
    protocol: Protocol,
    tokenIn: Address,
    tokenOut: Address
  ) {
    // sort tokens to ensure consistency of cache keys
    const sortedTokens = [tokenIn, tokenOut].sort((a, b) =>
      a.toString().localeCompare(b.toString())
    );

    return `${this.getDiscovererName()}#POOLSFORTOKENS#${chainId}#${protocol}#${sortedTokens[0].toString()}#${sortedTokens[1].toString()}`;
  }
}
