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
import _ from 'lodash';

export class DirectPoolDiscovererV2 extends BaseCachingPoolDiscoverer<V2PoolInfo> {
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
      'DirectPoolDiscovererV2'
    );
  }

  protected getDiscovererName(): string {
    return 'DirectPoolDiscovererV2';
  }

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
    const pools = await this.poolRepository.getPools(
      ctx,
      chainId,
      tokenIn,
      tokenOut
    );

    const poolAddressSet = new Set<string>();
    const poolInfos: V2PoolInfo[] = _(pools)
      .map(pool => {
        const {token0, token1} = pool;
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

export class DirectPoolDiscovererV3 extends BaseCachingPoolDiscoverer<V3PoolInfo> {
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
      'DirectPoolDiscovererV3'
    );
  }

  protected getDiscovererName(): string {
    return 'DirectPoolDiscovererV3';
  }

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
    const pools = await this.poolRepository.getPools(
      ctx,
      chainId,
      tokenIn,
      tokenOut
    );

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
          tvlETH: liquidityNumber,
          tvlUSD: liquidityNumber,
        };
      })
      .compact()
      .value();

    return poolInfos;
  }
}

export class DirectPoolDiscovererV4 extends BaseCachingPoolDiscoverer<V4PoolInfo> {
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
      'DirectPoolDiscovererV4'
    );
  }

  protected getDiscovererName(): string {
    return 'DirectPoolDiscovererV4';
  }

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
    const pools = await this.poolRepository.getPools(
      ctx,
      chainId,
      tokenIn,
      tokenOut
    );

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
          tvlETH: liquidityNumber,
          tvlUSD: liquidityNumber,
        };
      })
      .compact()
      .value();

    return poolInfos;
  }
}
