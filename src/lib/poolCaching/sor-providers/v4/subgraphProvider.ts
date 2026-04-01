/**
 * Ported from @uniswap/smart-order-router/src/providers/v4/subgraph-provider.ts
 */

import {Protocol} from '@uniswap/router-sdk';
import {ChainId, Currency} from '@uniswap/sdk-core';

import {Logger} from '../util/log';
import {IMetric} from '../util/metric';
import {ProviderConfig} from '../provider';
import {SubgraphProvider} from '../subgraphProvider';

export interface V4SubgraphPool {
  id: string; // v4 pool id is the internal PoolId from pool manager
  feeTier: string;
  tickSpacing: string;
  hooks: string;
  liquidity: string;
  token0: {
    symbol?: string;
    id: string;
    name?: string;
    decimals: string;
  };
  token1: {
    symbol?: string;
    id: string;
    name?: string;
    decimals: string;
  };
  tvlETH: number;
  tvlUSD: number;
  isExternalLiquidity?: boolean;
}

export type V4RawSubgraphPool = {
  id: string;
  feeTier: string;
  tickSpacing: string;
  hooks: string;
  liquidity: string;
  token0: {
    symbol: string;
    id: string;
    name: string;
    decimals: string;
  };
  token1: {
    symbol: string;
    id: string;
    name: string;
    decimals: string;
  };
  totalValueLockedUSD: string;
  totalValueLockedETH: string;
  totalValueLockedUSDUntracked: string;
};

export const SUBGRAPH_URL_BY_CHAIN: {[chainId in ChainId]?: string} = {
  [ChainId.SEPOLIA]: '',
};

/**
 * Provider for getting V4 pools from the Subgraph
 *
 * @export
 * @interface IV4SubgraphProvider
 */
export interface IV4SubgraphProvider {
  getPools(
    currencyIn?: Currency,
    currencyOut?: Currency,
    providerConfig?: ProviderConfig
  ): Promise<V4SubgraphPool[]>;
}

export class V4SubgraphProvider
  extends SubgraphProvider<V4RawSubgraphPool, V4SubgraphPool>
  implements IV4SubgraphProvider
{
  constructor(
    chainId: ChainId,
    retries = 2,
    timeout = 30000,
    rollback = true,
    trackedEthThreshold = 0.01,
    untrackedUsdThreshold = Number.MAX_VALUE,
    subgraphUrlOverride?: string,
    bearerToken?: string,
    logger?: Logger,
    metric?: IMetric
  ) {
    super(
      Protocol.V4,
      chainId,
      retries,
      timeout,
      rollback,
      trackedEthThreshold,
      untrackedUsdThreshold,
      subgraphUrlOverride ?? SUBGRAPH_URL_BY_CHAIN[chainId],
      bearerToken,
      logger!,
      metric!
    );
  }

  protected override mapSubgraphPool(
    rawPool: V4RawSubgraphPool
  ): V4SubgraphPool {
    return {
      id: rawPool.id,
      feeTier: rawPool.feeTier,
      tickSpacing: rawPool.tickSpacing,
      hooks: rawPool.hooks,
      liquidity: rawPool.liquidity,
      token0: {
        symbol: rawPool.token0.symbol,
        id: rawPool.token0.id,
        name: rawPool.token0.name,
        decimals: rawPool.token0.decimals,
      },
      token1: {
        symbol: rawPool.token1.symbol,
        id: rawPool.token1.id,
        name: rawPool.token1.name,
        decimals: rawPool.token1.decimals,
      },
      tvlETH: parseFloat(rawPool.totalValueLockedETH),
      tvlUSD: parseFloat(rawPool.totalValueLockedUSD),
    };
  }

  // Override to include V4-specific fields
  protected override getPoolFields(): string {
    return `
      id
      token0 {
        symbol
        id
        name
        decimals
      }
      token1 {
        symbol
        id
        name
        decimals
      }
      feeTier
      tickSpacing
      hooks
      liquidity
      totalValueLockedUSD
      totalValueLockedETH
    `;
  }
}
