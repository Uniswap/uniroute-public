import {ChainId} from '../../lib/config';
import {UniProtocol} from '../../models/pool/UniProtocol';
import {Context} from '@uniswap/lib-uni/context';
import {buildMetricKey, IUniRouteServiceConfig} from '../../lib/config';
import {IPoolDiscoverer, ITopPoolsSelector, UniPoolInfo} from './interface';
import {Address} from '../../models/address/Address';
import {ErrorNotFound, IRedisCache} from '@uniswap/lib-cache';
import {HooksOptions} from '../../models/hooks/HooksOptions';

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
    protected discovererName: string
  ) {}

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
    protocol: UniProtocol,
    ctx: Context
  ): Promise<TPool[]> {
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
    protocol: UniProtocol,
    ctx: Context
  ): Promise<TPool[]>;

  // To be implemented by the sub-classes.
  protected abstract _getPoolsForTokens(
    chainId: ChainId,
    protocol: UniProtocol,
    tokenIn: Address,
    tokenOut: Address,
    ctx: Context
  ): Promise<TPool[]>;

  // Gets pools from the cache if available, otherwise fetches them from the _getPoolsForTokens implementation.
  // Filters the pools based on the given tokens and returns a small number of pools (topPoolSelector logic) before caching them.
  public async getPoolsForTokens(
    chainId: ChainId,
    protocol: UniProtocol,
    tokenIn: Address,
    tokenOut: Address,
    topPoolSelector: ITopPoolsSelector<TPool>,
    hooksOptions: HooksOptions | undefined,
    skipPoolsForTokensCache: boolean,
    ctx: Context
  ): Promise<TPool[]> {
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

    let retrievedPools: TPool[] | undefined;
    try {
      if (!skipPoolsForTokensCache) {
        const retrievedPoolsStr =
          await this.getPoolsForTokensCache.get(cacheKey);
        if (retrievedPoolsStr !== undefined) {
          retrievedPools = JSON.parse(retrievedPoolsStr);
          retrievedPools = this.filterUnsupportedTokenPools(retrievedPools!);
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
      retrievedPools = this.filterUnsupportedTokenPools(retrievedPools);

      // use topPoolSelector to filter pools - we need to make sure a small number of pools is returned here
      retrievedPools = await topPoolSelector.filterPools(
        retrievedPools,
        chainId,
        tokenIn,
        tokenOut,
        protocol,
        hooksOptions,
        ctx
      );

      // now we are ready to cache
      const retrievedPoolsStr = JSON.stringify(retrievedPools);
      ctx.logger.debug(
        `[${this.discovererName}] Caching retrieved ${protocol} pools for tokens`,
        {
          cacheKey,
        }
      );

      if (!skipPoolsForTokensCache) {
        await this.getPoolsForTokensCache.set(cacheKey, retrievedPoolsStr, {
          ttl: this.serviceConfig.RedisCache
            .TokenInOutPoolsCacheEntryTtlSeconds,
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

  public getPoolsCacheKey(chainId: ChainId, protocol: UniProtocol) {
    return `${this.getDiscovererName()}#POOLS#${chainId}#${protocol}`;
  }

  public getPoolsForTokensCacheKey(
    chainId: ChainId,
    protocol: UniProtocol,
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
