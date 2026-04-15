import {V4PoolInfo} from '../interface';
import {ChainId} from '../../../lib/config';
import hardcodedV4Pools from './hardcoded-v4-pools.json';

interface HardcodedV4PoolData {
  id: string;
  feeTier: number;
  tickSpacing: string;
  hooks: string;
  liquidity: string;
  token0: {id: string};
  token1: {id: string};
  tvlETH: number;
  tvlUSD: number;
}

export function getHardcodedV4Pools(chainId: ChainId): V4PoolInfo[] {
  const pools =
    (hardcodedV4Pools as Record<string, HardcodedV4PoolData[]>)[
      chainId.toString()
    ] ?? [];
  return pools.map(p => ({
    id: p.id.toLowerCase(),
    feeTier: String(p.feeTier),
    tickSpacing: p.tickSpacing,
    hooks: p.hooks,
    liquidity: p.liquidity,
    token0: {id: p.token0.id.toLowerCase()},
    token1: {id: p.token1.id.toLowerCase()},
    tvlETH: p.tvlETH,
    tvlUSD: p.tvlUSD,
  }));
}
