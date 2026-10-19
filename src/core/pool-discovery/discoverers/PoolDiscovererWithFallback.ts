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
import {Protocol} from '../../../models/pool/Protocol';
import {Address} from '../../../models/address/Address';
import {IUniRouteServiceConfig} from '../../../lib/config';
import {HooksOptions} from '../../../models/hooks/HooksOptions';
import {RouteNamespaceContext} from '../../../models/hooks/namespaces';
import {summarizeBatchError} from '../../../stores/quote/OnChainQuoteFetchError';

type PrimaryFailureLogFields = {
  errorName: string;
  errorMessage: string;
  errorCode?: string;
};

/**
 * Flattens a primary-discoverer failure into string log fields. The serving
 * logger serializes only an Error passed as its own argument; one nested in
 * the fields object reaches pino as `{}` and Datadog drops it. The message is
 * reduced by `summarizeBatchError` (ethers details block cut, URLs reduced to
 * their origin, length capped) so provider text cannot carry a key into logs.
 */
function toPrimaryFailureLogFields(error: unknown): PrimaryFailureLogFields {
  const {message, code} = summarizeBatchError(error);
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage: message,
    ...(code !== undefined ? {errorCode: code} : {}),
  };
}

abstract class BasePoolDiscovererWithFallback<TPoolInfo extends UniPoolInfo>
  implements IPoolDiscoverer<TPoolInfo>
{
  constructor(
    protected serviceConfig: IUniRouteServiceConfig,
    protected primaryDiscoverer: IPoolDiscoverer<TPoolInfo>,
    protected fallbackDiscoverer: IPoolDiscoverer<TPoolInfo>
  ) {}

  public async getPools(
    chainId: ChainId,
    protocol: Protocol,
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
        ...toPrimaryFailureLogFields(error),
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
    protocol: Protocol,
    tokenIn: Address,
    tokenOut: Address,
    topPoolSelector: ITopPoolsSelector<TPoolInfo>,
    hooksOptions: HooksOptions | undefined,
    skipPoolsForTokensCache: boolean,
    nsCtx: RouteNamespaceContext,
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
        nsCtx,
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
        ...toPrimaryFailureLogFields(error),
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
      nsCtx,
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
    primaryDiscoverer: IPoolDiscoverer<V2PoolInfo>,
    fallbackDiscoverer: IPoolDiscoverer<V2PoolInfo>
  ) {
    super(serviceConfig, primaryDiscoverer, fallbackDiscoverer);
  }
}

export class PoolDiscovererWithFallbackV3 extends BasePoolDiscovererWithFallback<V3PoolInfo> {
  constructor(
    serviceConfig: IUniRouteServiceConfig,
    primaryDiscoverer: IPoolDiscoverer<V3PoolInfo>,
    fallbackDiscoverer: IPoolDiscoverer<V3PoolInfo>
  ) {
    super(serviceConfig, primaryDiscoverer, fallbackDiscoverer);
  }
}

export class PoolDiscovererWithFallbackV4 extends BasePoolDiscovererWithFallback<V4PoolInfo> {
  constructor(
    serviceConfig: IUniRouteServiceConfig,
    primaryDiscoverer: IPoolDiscoverer<V4PoolInfo>,
    fallbackDiscoverer: IPoolDiscoverer<V4PoolInfo>
  ) {
    super(serviceConfig, primaryDiscoverer, fallbackDiscoverer);
  }
}
