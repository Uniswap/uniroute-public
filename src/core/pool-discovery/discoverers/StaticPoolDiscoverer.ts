// Note: most of the logic here was copied from Routing API implementation.
import _ from 'lodash';
import {V2PoolInfo, V3PoolInfo, V4PoolInfo} from '../interface';
import {Context} from '@uniswap/lib-uni/context';
import {ChainId} from '../../../lib/config';
import {UniProtocol} from '../../../models/pool/UniProtocol';
import {IPoolsRepository} from '../../../stores/pool/IPoolsRepository';
import {V3Pool} from '../../../models/pool/V3Pool';
import {Address} from '../../../models/address/Address';
import {V4Pool} from '../../../models/pool/V4Pool';
import {V2Pool} from '../../../models/pool/V2Pool';
import {BaseCachingPoolDiscoverer} from '../BaseCachingPoolDiscoverer';
import {IRedisCache} from '@uniswap/lib-cache';
import {IUniRouteServiceConfig} from '../../../lib/config';
import {BASE_TOKENS_PER_CHAIN} from '../../../lib/tokenUtils';

function createUniquePairs(tokens: Address[]): [Address, Address][] {
  const pairs: [Address, Address][] = [];
  const seen = new Set<string>();

  // Generate unique pairs by only pairing each token with tokens that come after it
  for (let i = 0; i < tokens.length; i++) {
    for (let j = i + 1; j < tokens.length; j++) {
      const token1 = tokens[i];
      const token2 = tokens[j];

      // Create a unique key for this pair (ordered by address to ensure consistency)
      const pairKey = [token1.toString(), token2.toString()].sort().join('-');

      if (!seen.has(pairKey)) {
        pairs.push([token1, token2]);
        seen.add(pairKey);
      }
    }
  }

  return pairs;
}

export class StaticPoolDiscovererV2 extends BaseCachingPoolDiscoverer<V2PoolInfo> {
  constructor(
    protected serviceConfig: IUniRouteServiceConfig,
    private readonly poolRepository: IPoolsRepository<V2Pool>,
    protected getPoolsCache: IRedisCache<string, string>,
    protected getPoolsForTokensCache: IRedisCache<string, string>,
    protected unsupportedTokens: Set<string> = new Set()
  ) {
    super(
      serviceConfig,
      getPoolsCache,
      getPoolsForTokensCache,
      unsupportedTokens,
      'StaticPoolDiscovererV2'
    );
  }

  protected getDiscovererName(): string {
    return 'StaticPoolDiscovererV2';
  }

  // Static pool discoverers are used when we don't have a subgraph to query for pools, so there is no use for this method.
  public override async getPools(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    chainId: ChainId,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    protocol: UniProtocol,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ctx: Context
  ): Promise<V2PoolInfo[]> {
    return [];
  }

  protected override async _getPools(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    chainId: ChainId,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    protocol: UniProtocol,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ctx: Context
  ): Promise<V2PoolInfo[]> {
    return [];
  }

  public override async _getPoolsForTokens(
    chainId: ChainId,
    protocol: UniProtocol,
    tokenIn: Address,
    tokenOut: Address,
    ctx: Context
  ): Promise<V2PoolInfo[]> {
    const bases = BASE_TOKENS_PER_CHAIN[chainId];
    const basesAddresses = bases.map(
      base => new Address(base.address.toLowerCase())
    );

    // Create pairs from all relevant tokens at once
    const allTokens = Array.from(
      new Set([
        tokenIn.toString(),
        tokenOut.toString(),
        ...basesAddresses.map(addr => addr.toString()),
      ])
    ).map(addr => new Address(addr));

    const allPairs = createUniquePairs(allTokens);

    ctx.logger.debug('relevantTokens v2', allTokens);
    ctx.logger.debug('allPairs v2', allPairs);

    const pools = (
      await Promise.all(
        allPairs.map(async ([tokenA, tokenB]) => {
          return this.poolRepository.getPools(ctx, chainId, tokenA, tokenB);
        })
      )
    ).flat();

    const poolAddressSet = new Set<string>();
    const poolInfos: V2PoolInfo[] = _(pools)
      .map(pool => {
        const {token0, token1} = pool;
        // TODO: how to use reserves for TVL?

        const poolAddress = pool.address.address;

        if (poolAddressSet.has(poolAddress)) {
          return undefined;
        }
        poolAddressSet.add(poolAddress);

        return {
          id: poolAddress,
          liquidity: '100',
          token0: {
            id: token0.address,
          },
          token1: {
            id: token1.address,
          },
          supply: 100,
          reserve: 100,
          reserveUSD: 100,
        };
      })
      .compact()
      .value();

    return poolInfos;
  }
}

export class StaticPoolDiscovererV3 extends BaseCachingPoolDiscoverer<V3PoolInfo> {
  constructor(
    protected serviceConfig: IUniRouteServiceConfig,
    private readonly poolRepository: IPoolsRepository<V3Pool>,
    protected getPoolsCache: IRedisCache<string, string>,
    protected getPoolsForTokensCache: IRedisCache<string, string>,
    protected unsupportedTokens: Set<string> = new Set()
  ) {
    super(
      serviceConfig,
      getPoolsCache,
      getPoolsForTokensCache,
      unsupportedTokens,
      'StaticPoolDiscovererV3'
    );
  }

  protected getDiscovererName(): string {
    return 'StaticPoolDiscovererV3';
  }

  // Static pool discoverers are used when we don't have a subgraph to query for pools, so there is no use for this method.
  protected override async _getPools(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    chainId: ChainId,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    protocol: UniProtocol,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ctx: Context
  ): Promise<V3PoolInfo[]> {
    return [];
  }

  protected override async _getPoolsForTokens(
    chainId: ChainId,
    protocol: UniProtocol,
    tokenIn: Address,
    tokenOut: Address,
    ctx: Context
  ): Promise<V3PoolInfo[]> {
    const bases = BASE_TOKENS_PER_CHAIN[chainId];
    const basesAddresses = bases.map(
      base => new Address(base.address.toLowerCase())
    );

    // Create pairs from all relevant tokens at once
    const allTokens = Array.from(
      new Set([
        tokenIn.toString(),
        tokenOut.toString(),
        ...basesAddresses.map(addr => addr.toString()),
      ])
    ).map(addr => new Address(addr));

    const allPairs = createUniquePairs(allTokens);

    ctx.logger.debug('relevantTokens v3', allTokens);
    ctx.logger.debug('allPairs v3', allPairs);

    const pools = (
      await Promise.all(
        allPairs.map(async ([tokenA, tokenB]) => {
          return this.poolRepository.getPools(ctx, chainId, tokenA, tokenB);
        })
      )
    ).flat();

    const poolAddressSet = new Set<string>();
    const poolInfos: V3PoolInfo[] = _(pools)
      .map(pool => {
        const {token0, token1, liquidity} = pool;

        const poolAddress = pool.address.address;

        if (poolAddressSet.has(poolAddress)) {
          return undefined;
        }
        poolAddressSet.add(poolAddress);

        const liquidityNumber = Number(pool.liquidity);

        return {
          id: poolAddress,
          feeTier: pool.fee.toString(),
          liquidity: liquidity.toString(),
          token0: {
            id: token0.address,
          },
          token1: {
            id: token1.address,
          },
          // As a very rough proxy we just use liquidity for TVL.
          tvlETH: liquidityNumber,
          tvlUSD: liquidityNumber,
        };
      })
      .compact()
      .value();

    return poolInfos;
  }
}

export class StaticPoolDiscovererV4 extends BaseCachingPoolDiscoverer<V4PoolInfo> {
  constructor(
    protected serviceConfig: IUniRouteServiceConfig,
    private readonly poolRepository: IPoolsRepository<V4Pool>,
    protected getPoolsCache: IRedisCache<string, string>,
    protected getPoolsForTokensCache: IRedisCache<string, string>,
    protected unsupportedTokens: Set<string> = new Set()
  ) {
    super(
      serviceConfig,
      getPoolsCache,
      getPoolsForTokensCache,
      unsupportedTokens,
      'StaticPoolDiscovererV4'
    );
  }

  protected getDiscovererName(): string {
    return 'StaticPoolDiscovererV4';
  }

  // Static pool discoverers are used when we don't have a subgraph to query for pools, so there is no use for this method.
  protected override async _getPools(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    chainId: ChainId,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    protocol: UniProtocol,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ctx: Context
  ): Promise<V4PoolInfo[]> {
    return [];
  }

  protected override async _getPoolsForTokens(
    chainId: ChainId,
    protocol: UniProtocol,
    tokenIn: Address,
    tokenOut: Address,
    ctx: Context
  ): Promise<V4PoolInfo[]> {
    const bases = BASE_TOKENS_PER_CHAIN[chainId];
    const basesAddresses = bases.map(
      base => new Address(base.address.toLowerCase())
    );

    // Create pairs from all relevant tokens at once
    const allTokens = Array.from(
      new Set([
        tokenIn.toString(),
        tokenOut.toString(),
        ...basesAddresses.map(addr => addr.toString()),
      ])
    ).map(addr => new Address(addr));

    const allPairs = createUniquePairs(allTokens);

    ctx.logger.debug('relevantTokens v4', allTokens);
    ctx.logger.debug('allPairs v4', allPairs);

    const pools = (
      await Promise.all(
        allPairs.map(async ([tokenA, tokenB]) => {
          return this.poolRepository.getPools(ctx, chainId, tokenA, tokenB);
        })
      )
    ).flat();

    const poolAddressSet = new Set<string>();
    const poolInfos: V4PoolInfo[] = _(pools)
      .map(pool => {
        const {token0, token1, liquidity} = pool;

        const poolAddress = pool.address.address;

        if (poolAddressSet.has(poolAddress)) {
          return undefined;
        }
        poolAddressSet.add(poolAddress);

        const liquidityNumber = Number(pool.liquidity);

        return {
          id: poolAddress,
          feeTier: pool.fee.toString(),
          liquidity: liquidity.toString(),
          tickSpacing: pool.tickSpacing.toString(),
          hooks: pool.hooks.toString(),
          token0: {
            id: token0.address,
          },
          token1: {
            id: token1.address,
          },
          // As a very rough proxy we just use liquidity for TVL.
          tvlETH: liquidityNumber,
          tvlUSD: liquidityNumber,
        };
      })
      .compact()
      .value();

    return poolInfos;
  }
}
