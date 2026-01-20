import {
  V2PoolInfo,
  V3PoolInfo,
  V4PoolInfo,
  UniPoolInfo,
  IPoolDiscoverer,
  ITopPoolsSelector,
} from '../interface';
import {Context} from '@uniswap/lib-uni/context';
import {ChainId} from '../../../lib/config';
import {UniProtocol} from '../../../models/pool/UniProtocol';
import {Address} from '../../../models/address/Address';
import {BaseCachingPoolDiscoverer} from '../BaseCachingPoolDiscoverer';
import {IUniRouteServiceConfig} from '../../../lib/config';
import {HooksOptions} from '../../../models/hooks/HooksOptions';

abstract class BasePoolDiscovererWithFallback<TPoolInfo extends UniPoolInfo>
  implements IPoolDiscoverer<TPoolInfo>
{
  constructor(
    protected serviceConfig: IUniRouteServiceConfig,
    protected primaryDiscoverer: BaseCachingPoolDiscoverer<TPoolInfo>,
    protected fallbackDiscoverer: BaseCachingPoolDiscoverer<TPoolInfo>
  ) {}

  public async getPools(
    chainId: ChainId,
    protocol: UniProtocol,
    ctx: Context
  ): Promise<TPoolInfo[]> {
    try {
      const primaryPools = await this.primaryDiscoverer.getPools(
        chainId,
        protocol,
        ctx
      );
      if (primaryPools.length > 0) {
        ctx.logger.debug('Using primary discoverer pools', {
          chainId,
          protocol,
          poolCount: primaryPools.length,
        });
        return primaryPools;
      }

      ctx.logger.info('Primary discoverer returned no pools, falling back', {
        chainId,
        protocol,
      });
    } catch (error) {
      ctx.logger.warn('Primary discoverer failed, falling back', {
        chainId,
        protocol,
        error,
      });
    }

    // If we get here, either primary failed or returned no pools
    const fallbackPools = await this.fallbackDiscoverer.getPools(
      chainId,
      protocol,
      ctx
    );
    ctx.logger.debug('Using fallback discoverer pools', {
      chainId,
      protocol,
      poolCount: fallbackPools.length,
    });
    return fallbackPools;
  }

  public async getPoolsForTokens(
    chainId: ChainId,
    protocol: UniProtocol,
    tokenIn: Address,
    tokenOut: Address,
    topPoolSelector: ITopPoolsSelector<TPoolInfo>,
    hooksOptions: HooksOptions | undefined,
    skipPoolsForTokensCache: boolean,
    ctx: Context
  ): Promise<TPoolInfo[]> {
    try {
      const primaryPools = await this.primaryDiscoverer.getPoolsForTokens(
        chainId,
        protocol,
        tokenIn,
        tokenOut,
        topPoolSelector,
        hooksOptions,
        skipPoolsForTokensCache,
        ctx
      );
      if (primaryPools.length > 0) {
        ctx.logger.debug('Using primary discoverer pools for tokens', {
          chainId,
          protocol,
          tokenIn: tokenIn.toString(),
          tokenOut: tokenOut.toString(),
          poolCount: primaryPools.length,
        });
        return primaryPools;
      }

      ctx.logger.info(
        'Primary discoverer returned no pools for tokens, falling back',
        {
          chainId,
          protocol,
          tokenIn: tokenIn.toString(),
          tokenOut: tokenOut.toString(),
        }
      );
    } catch (error) {
      ctx.logger.warn('Primary discoverer failed for tokens, falling back', {
        chainId,
        protocol,
        tokenIn: tokenIn.toString(),
        tokenOut: tokenOut.toString(),
        error,
      });
    }

    // If we get here, either primary failed or returned no pools
    const fallbackPools = await this.fallbackDiscoverer.getPoolsForTokens(
      chainId,
      protocol,
      tokenIn,
      tokenOut,
      topPoolSelector,
      hooksOptions,
      skipPoolsForTokensCache,
      ctx
    );
    ctx.logger.debug('Using fallback discoverer pools for tokens', {
      chainId,
      protocol,
      tokenIn: tokenIn.toString(),
      tokenOut: tokenOut.toString(),
      poolCount: fallbackPools.length,
    });
    return fallbackPools;
  }
}

export class PoolDiscovererWithFallbackV2 extends BasePoolDiscovererWithFallback<V2PoolInfo> {
  constructor(
    serviceConfig: IUniRouteServiceConfig,
    primaryDiscoverer: BaseCachingPoolDiscoverer<V2PoolInfo>,
    fallbackDiscoverer: BaseCachingPoolDiscoverer<V2PoolInfo>
  ) {
    super(serviceConfig, primaryDiscoverer, fallbackDiscoverer);
  }
}

export class PoolDiscovererWithFallbackV3 extends BasePoolDiscovererWithFallback<V3PoolInfo> {
  constructor(
    serviceConfig: IUniRouteServiceConfig,
    primaryDiscoverer: BaseCachingPoolDiscoverer<V3PoolInfo>,
    fallbackDiscoverer: BaseCachingPoolDiscoverer<V3PoolInfo>
  ) {
    super(serviceConfig, primaryDiscoverer, fallbackDiscoverer);
  }
}

export class PoolDiscovererWithFallbackV4 extends BasePoolDiscovererWithFallback<V4PoolInfo> {
  constructor(
    serviceConfig: IUniRouteServiceConfig,
    primaryDiscoverer: BaseCachingPoolDiscoverer<V4PoolInfo>,
    fallbackDiscoverer: BaseCachingPoolDiscoverer<V4PoolInfo>
  ) {
    super(serviceConfig, primaryDiscoverer, fallbackDiscoverer);
  }
}
