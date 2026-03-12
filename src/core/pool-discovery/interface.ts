import {ChainId} from '../../lib/config';
import {Context} from '@uniswap/lib-uni/context';
import {Address} from '../../models/address/Address';
import {HooksOptions} from 'src/models/hooks/HooksOptions';
import {Protocol} from 'src/models/pool/Protocol';

export type UniPoolInfo = V2PoolInfo | V3PoolInfo | V4PoolInfo;

export interface IPoolDiscoverer<TPool extends UniPoolInfo> {
  getPools(
    chainId: ChainId,
    protocol: Protocol,
    ctx: Context
  ): Promise<TPool[]>;
  getPoolsForTokens(
    chainId: ChainId,
    protocol: Protocol,
    tokenIn: Address,
    tokenOut: Address,
    topPoolSelector: ITopPoolsSelector<TPool>,
    hooksOptions: HooksOptions | undefined,
    skipPoolsForTokensCache: boolean,
    ctx: Context
  ): Promise<TPool[]>;
}

export interface ITopPoolsSelector<TPool extends UniPoolInfo> {
  filterPools(
    pools: TPool[],
    chainId: ChainId,
    tokenIn: Address,
    tokenOut: Address,
    protocol: Protocol,
    hooksOptions: HooksOptions | undefined,
    ctx: Context
  ): Promise<TPool[]>;
}

export interface V2PoolInfo {
  id: string;
  token0: {
    id: string;
  };
  token1: {
    id: string;
  };
  supply: number;
  reserve: number;
  reserveUSD: number;
}

export interface V3PoolInfo {
  id: string;
  feeTier: string;
  liquidity: string;
  token0: {
    id: string;
  };
  token1: {
    id: string;
  };
  tvlETH: number;
  tvlUSD: number;
}

export interface V4PoolInfo {
  id: string; // v4 pool id is the internal PoolId from pool manager
  feeTier: string;
  tickSpacing: string;
  hooks: string;
  liquidity: string;
  token0: {
    id: string;
  };
  token1: {
    id: string;
  };
  tvlETH: number;
  tvlUSD: number;
}
