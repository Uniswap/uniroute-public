import {ChainId, defaultPoolSelectionConfig} from '../../lib/config';
import {Protocol} from '../../models/pool/Protocol';
import {Context} from '@uniswap/lib-uni/context';
import {buildMetricKey, IUniRouteServiceConfig} from '../../lib/config';
import {
  IPoolDiscoverer,
  ITopPoolsSelector,
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

  protected async filterUnsupportedTokenPools(
    pools: TPool[],
    ctx: Context
  ): Promise<TPool[]> {
    const {globalSet} =
      await this.featureGatedTokensRepository.getSnapshot(ctx);
    const filteredPools = pools.filter(pool => {
      return (
        !globalSet.has(pool.token0.id.toLowerCase()) &&
        !globalSet.has(pool.token1.id.toLowerCase())
      );
    });
    return filteredPools;
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
        retrievedPools = JSON.parse(retrievedPoolsStr);
        retrievedPools = await this.filterUnsupportedTokenPools(
          retrievedPools!,
          ctx
        );
        ctx.logger.debug(
          `[${this.discovererName}] Retrieved ${protocol} pools from cache`,
          {
            cacheKey,
          }
        );
      }
    } catch (e) {
      if (!(e instanceof ErrorNotFound)) {
        throw e;
      }
    }
    if (retrievedPools === undefined) {
      status = 'miss';
      retrievedPools = await this._getPools(chainId, protocol, ctx);
      retrievedPools = await this.filterUnsupportedTokenPools(
        retrievedPools,
        ctx
      );
      const retrievedPoolsStr = JSON.stringify(retrievedPools);
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

      // Filter out pools with unsupported tokens
      retrievedPools = await this.filterUnsupportedTokenPools(
        retrievedPools,
        ctx
      );

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
