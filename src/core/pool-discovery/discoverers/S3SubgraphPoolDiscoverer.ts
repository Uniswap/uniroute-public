import {V2PoolInfo, V3PoolInfo, V4PoolInfo, UniPoolInfo} from '../interface';
import {Context} from '@uniswap/lib-uni/context';
import {ChainId} from '../../../lib/config';
import {Protocol} from '../../../models/pool/Protocol';
import {Address} from '../../../models/address/Address';
import {BaseCachingPoolDiscoverer} from '../BaseCachingPoolDiscoverer';
import {FeatureGatedTokensRepository} from '../../../stores/compliance/FeatureGatedTokensRepository';
import {IRedisCache} from '@uniswap/lib-cache';
import {buildMetricKey, IUniRouteServiceConfig} from '../../../lib/config';
import {S3Client, GetObjectCommand} from '@aws-sdk/client-s3';
import * as zlib from 'zlib';
import _ from 'lodash';
import {
  PARITY_HOOKS_PER_CHAIN,
  ZERO_MEASURED_TVL_HOOKS_PER_CHAIN,
} from '../../../lib/poolCaching/util/hooksAddressesAllowlist';

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
    protected readonly s3: S3Client
  ) {
    super(
      serviceConfig,
      getPoolsCache,
      getPoolsForTokensCache,
      featureGatedTokensRepository,
      'BaseS3SubgraphPoolDiscoverer',
      [Protocol.V2, Protocol.V3, Protocol.V4]
    );
  }

  protected readonly TrackedEthThreshold: number = 0.01;

  protected getDiscovererName(): string {
    return 'BaseS3SubgraphPoolDiscoverer';
  }

  protected abstract convertToPoolInfo(
    rawPool: TPoolData
  ): TPoolInfo | undefined;

  protected override async _getPools(
    chainId: ChainId,
    protocol: Protocol,
    ctx: Context
  ): Promise<TPoolInfo[]> {
    // Guard before try/catch so programming errors propagate instead of being swallowed
    if (!this.supportedProtocols.includes(protocol)) {
      throw new Error(`Unsupported protocol: ${protocol}`);
    }

    const poolCallStartTime = Date.now();
    const metricTags = [`chain:${ChainId[chainId]}`, `protocol:${protocol}`];
    let success = false;

    try {
      // Fetch gzipped data from S3
      const s3Key = S3_POOL_CACHE_KEY(
        this.serviceConfig.S3.poolBaseKey,
        chainId,
        protocol
      );
      const before = Date.now();
      const response = await this.s3.send(
        new GetObjectCommand({
          Bucket: this.serviceConfig.S3.poolBucketName,
          Key: s3Key,
        })
      );
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
        return [];
      }

      // Convert stream to Buffer
      const poolsBuffer = Buffer.from(await bodyStream.transformToByteArray());

      // Decompress and parse the data
      const before2 = Date.now();
      const poolString = zlib.inflateSync(poolsBuffer).toString('utf-8');
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

      success = true;
      return filteredPools;
    } catch (error) {
      ctx.logger.error('Error fetching pools from S3', {
        chainId,
        protocol,
        error,
      });
      return [];
    } finally {
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
  protected override getDiscovererName(): string {
    return 'S3SubgraphPoolDiscovererV4';
  }

  /**
   * Force select TVL-bypass hook pools (parity hooks + zero-measured-TVL
   * hooks — see the PARITY_HOOKS_PER_CHAIN and
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
    const bypassHooks = [
      ...(PARITY_HOOKS_PER_CHAIN[chainId] ?? []),
      ...(ZERO_MEASURED_TVL_HOOKS_PER_CHAIN[chainId] ?? []),
    ];
    if (bypassHooks.length === 0) return false;
    const hooks = pool.hooks.toLowerCase();
    return bypassHooks.some(hook => hook.toLowerCase() === hooks);
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
      isExternalLiquidity,
    };
  }
}
