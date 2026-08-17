import {V2PoolInfo, V3PoolInfo, V4PoolInfo} from '../interface';
import {Context} from '@uniswap/lib-uni/context';
import {ChainId} from '../../../lib/config';
import {IPoolsRepository} from '../../../stores/pool/IPoolsRepository';
import {V3Pool} from '../../../models/pool/V3Pool';
import {Address} from '../../../models/address/Address';
import {V4Pool} from '../../../models/pool/V4Pool';
import {V2Pool} from '../../../models/pool/V2Pool';
import {BaseCachingPoolDiscoverer} from '../BaseCachingPoolDiscoverer';
import {FeatureGatedTokensRepository} from '../../../stores/compliance/FeatureGatedTokensRepository';
import {
  IV4PoolKeyRegistry,
  V4RegistryPoolKey,
} from '../../../stores/pool/V4PoolKeyRegistryStore';
import {IRedisCache} from '@uniswap/lib-cache';
import {IUniRouteServiceConfig} from '../../../lib/config';
import _ from 'lodash';
import {Protocol} from 'src/models/pool/Protocol';

export class DirectPoolDiscovererV2 extends BaseCachingPoolDiscoverer<V2PoolInfo> {
  constructor(
    protected serviceConfig: IUniRouteServiceConfig,
    private readonly poolRepository: IPoolsRepository<V2Pool>,
    protected getPoolsCache: IRedisCache<string, string>,
    protected getPoolsForTokensCache: IRedisCache<string, string>,
    protected featureGatedTokensRepository: FeatureGatedTokensRepository
  ) {
    super(
      serviceConfig,
      getPoolsCache,
      getPoolsForTokensCache,
      featureGatedTokensRepository,
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
    protocol: Protocol,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ctx: Context
  ): Promise<V2PoolInfo[]> {
    return [];
  }

  protected override async _getPools(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    chainId: ChainId,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    protocol: Protocol,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ctx: Context
  ): Promise<V2PoolInfo[]> {
    return [];
  }

  public override async _getPoolsForTokens(
    chainId: ChainId,
    protocol: Protocol,
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
    protected featureGatedTokensRepository: FeatureGatedTokensRepository
  ) {
    super(
      serviceConfig,
      getPoolsCache,
      getPoolsForTokensCache,
      featureGatedTokensRepository,
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
    protocol: Protocol,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ctx: Context
  ): Promise<V3PoolInfo[]> {
    return [];
  }

  protected override async _getPoolsForTokens(
    chainId: ChainId,
    protocol: Protocol,
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
    protected featureGatedTokensRepository: FeatureGatedTokensRepository,
    // Optional so existing construction sites keep working; without it the
    // probe set is the canonical grid, exactly as before.
    private readonly poolKeyRegistry?: IV4PoolKeyRegistry
  ) {
    super(
      serviceConfig,
      getPoolsCache,
      getPoolsForTokensCache,
      featureGatedTokensRepository,
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
    protocol: Protocol,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ctx: Context
  ): Promise<V4PoolInfo[]> {
    return [];
  }

  protected override async _getPoolsForTokens(
    chainId: ChainId,
    protocol: Protocol,
    tokenIn: Address,
    tokenOut: Address,
    ctx: Context
  ): Promise<V4PoolInfo[]> {
    // Registry PoolKeys widen the probed (fee, tickSpacing) set beyond the
    // canonical grid for pairs with pools on non-canonical tiers. Strictly
    // additive: the registry lookup and the registry probe are each caught
    // independently — the repository's per-candidate errors reject its
    // whole Promise.all, so folding registry candidates into the canonical
    // call would let one bad registry read take canonical discovery down.
    let registryKeys: V4RegistryPoolKey[] = [];
    try {
      registryKeys =
        (await this.poolKeyRegistry?.getPoolKeysForPair(
          chainId,
          tokenIn.address,
          tokenOut.address,
          ctx
        )) ?? [];
    } catch {
      // The store contract is never-throw; guard other IV4PoolKeyRegistry
      // implementations anyway.
    }

    const registryPoolsPromise =
      registryKeys.length === 0
        ? Promise.resolve([] as V4Pool[])
        : this.poolRepository
            .getPools(
              ctx,
              chainId,
              tokenIn,
              tokenOut,
              registryKeys.map(key => key.fee),
              registryKeys.map(key => key.tickSpacing),
              registryKeys.map(key => key.hooks)
            )
            .catch(err => {
              ctx.logger.warn(
                `V4 PoolKey registry probe failed on chain ${chainId}; keeping canonical results`,
                {err: err instanceof Error ? err.message : String(err)}
              );
              return [] as V4Pool[];
            });
    const [canonicalPools, registryPools] = await Promise.all([
      this.poolRepository.getPools(ctx, chainId, tokenIn, tokenOut),
      registryPoolsPromise,
    ]);
    // Registry keys are non-canonical by construction, so the union is
    // disjoint; the poolAddressSet below dedupes defensively regardless.
    const pools = [...canonicalPools, ...registryPools];

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
