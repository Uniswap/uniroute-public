import {ChainId} from '../../lib/config';
import {Protocol} from '../../models/pool/Protocol';
import {Context} from '@uniswap/lib-uni/context';
import {buildMetricKey, IUniRouteServiceConfig} from '../../lib/config';
import {IPoolDiscoverer, ITopPoolsSelector, UniPoolInfo} from './interface';
import {Address} from '../../models/address/Address';
import {ErrorNotFound, IRedisCache} from '@uniswap/lib-cache';
import {HooksOptions} from '../../models/hooks/HooksOptions';
import {RouteNamespaceContext} from '../../models/hooks/namespaces';

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
    protected unsupportedTokens: Set<string>,
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

  protected filterUnsupportedTokenPools(pools: TPool[]): TPool[] {
    const filteredPools = pools.filter(pool => {
      return (
        !this.unsupportedTokens.has(pool.token0.id.toLowerCase()) &&
        !this.unsupportedTokens.has(pool.token1.id.toLowerCase())
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
        retrievedPools = this.filterUnsupportedTokenPools(retrievedPools!);
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
      retrievedPools = this.filterUnsupportedTokenPools(retrievedPools);
      const retrievedPoolsStr = JSON.stringify(retrievedPools);
      ctx.logger.debug(
        `[${this.discovererName}] Caching retrieved ${protocol} pools`,
        {
          cacheKey,
        }
      );
      await this.getPoolsCache.set(cacheKey, retrievedPoolsStr, {
        ttl: this.serviceConfig.RedisCache.AllPoolsCacheEntryTtlSeconds,
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

  // Gets pools for the requested token pair. The cache stores the raw,
  // namespace-independent pool universe; `topPoolSelector.filterPools`
  // (which applies the permissioned-hook filter and then the top-TVL
  // selection heuristic) runs on every request, so namespace activation
  // cannot poison the cache.
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

    let rawPools: TPool[] | undefined;
    try {
      if (!skipPoolsForTokensCache) {
        const cachedStr = await this.getPoolsForTokensCache.get(cacheKey);
        if (cachedStr !== undefined) {
          rawPools = JSON.parse(cachedStr);
          rawPools = this.filterUnsupportedTokenPools(rawPools!);
          ctx.logger.debug(
            `[${this.discovererName}] Retrieved ${protocol} pools for tokens from cache`,
            {cacheKey}
          );
        }
      }
    } catch (e) {
      if (!(e instanceof ErrorNotFound)) {
        throw e;
      }
    }

    if (rawPools === undefined || rawPools.length === 0) {
      status = 'miss';
      rawPools = await this._getPoolsForTokens(
        chainId,
        protocol,
        tokenIn,
        tokenOut,
        ctx
      );
      rawPools = this.filterUnsupportedTokenPools(rawPools);

      if (!skipPoolsForTokensCache) {
        const serialized = JSON.stringify(rawPools);
        ctx.logger.debug(
          `[${this.discovererName}] Caching retrieved ${protocol} pools for tokens`,
          {cacheKey}
        );
        await this.getPoolsForTokensCache.set(cacheKey, serialized, {
          ttl: this.serviceConfig.RedisCache
            .TokenInOutPoolsCacheEntryTtlSeconds,
        });
      }
    }

    // Run the selector on every request (both cache-hit and cache-miss
    // paths) on the raw, namespace-independent cached universe so that
    // header-present and header-absent requests each produce their own
    // correctly filtered result from the same cached entry.
    const filterPoolsStartTime = Date.now();
    const selectedPools = await topPoolSelector.filterPools(
      rawPools,
      chainId,
      tokenIn,
      tokenOut,
      protocol,
      hooksOptions,
      nsCtx,
      ctx
    );
    const filterPoolsElapsed = Date.now() - filterPoolsStartTime;
    ctx.logger.debug(
      `[Latency] TopPoolsSelector.filterPools took ${filterPoolsElapsed}ms`
    );
    await ctx.metrics.timer(
      buildMetricKey('TopPoolsSelector.filterPools.Latency'),
      filterPoolsElapsed,
      {tags: [`chain:${chainId}`, `protocol:${protocol}`]}
    );

    await ctx.metrics.count(
      buildMetricKey('PoolDiscoverer.getPoolsForTokens.Cache'),
      1,
      {tags: ['result', status]}
    );

    return selectedPools;
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
