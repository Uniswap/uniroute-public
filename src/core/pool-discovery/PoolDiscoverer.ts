import {Context} from '@uniswap/lib-uni/context';
import {
  IPoolDiscoverer,
  ITopPoolsSelector,
  UniPoolInfo,
  V2PoolInfo,
  V3PoolInfo,
  V4PoolInfo,
} from './interface';
import {ChainId} from '../../lib/config';
import {UniProtocol} from '../../models/pool/UniProtocol';
import {Address} from '../../models/address/Address';
import {HooksOptions} from '../../models/hooks/HooksOptions';

// Main class that delegates pool discovery to the appropriate pool discoverer based on the protocol.
// Different implementations can be plugged in during init and passed down to BL.
export class PoolDiscoverer implements IPoolDiscoverer<UniPoolInfo> {
  constructor(
    private readonly v2PoolDiscoverer: IPoolDiscoverer<V2PoolInfo>,
    private readonly v3PoolDiscoverer: IPoolDiscoverer<V3PoolInfo>,
    private readonly v4PoolDiscoverer: IPoolDiscoverer<V4PoolInfo>,
    private readonly v2DirectPoolDiscoverer: IPoolDiscoverer<UniPoolInfo>,
    private readonly v3DirectPoolDiscoverer: IPoolDiscoverer<UniPoolInfo>,
    private readonly v4DirectPoolDiscoverer: IPoolDiscoverer<UniPoolInfo>
  ) {}

  public async getPools(
    chainId: ChainId,
    protocol: UniProtocol,
    ctx: Context
  ): Promise<UniPoolInfo[]> {
    switch (protocol) {
      case UniProtocol.V2:
        return this.v2PoolDiscoverer.getPools(chainId, protocol, ctx);
      case UniProtocol.V3:
        return this.v3PoolDiscoverer.getPools(chainId, protocol, ctx);
      case UniProtocol.V4:
        return this.v4PoolDiscoverer.getPools(chainId, protocol, ctx);
      default:
        throw new Error(`Unsupported protocol ${protocol}`);
    }
  }

  public async getPoolsForTokens(
    chainId: ChainId,
    protocol: UniProtocol,
    tokenIn: Address,
    tokenOut: Address,
    topPoolsSelector: ITopPoolsSelector<UniPoolInfo>,
    hooksOptions: HooksOptions | undefined,
    skipPoolsForTokensCache: boolean,
    ctx: Context
  ): Promise<UniPoolInfo[]> {
    // Get protocol-specific pools
    let protocolPools: UniPoolInfo[] = [];
    switch (protocol) {
      case UniProtocol.V2: {
        const v2Selector: ITopPoolsSelector<V2PoolInfo> = {
          filterPools: async (
            pools: V2PoolInfo[],
            chainId: ChainId,
            tIn: Address,
            tOut: Address,
            protocol: UniProtocol,
            hooksOptions: HooksOptions | undefined,
            ctx: Context
          ) =>
            (await topPoolsSelector.filterPools(
              pools,
              chainId,
              tIn,
              tOut,
              protocol,
              hooksOptions,
              ctx
            )) as V2PoolInfo[],
        };
        protocolPools = await this.v2PoolDiscoverer.getPoolsForTokens(
          chainId,
          protocol,
          tokenIn,
          tokenOut,
          v2Selector,
          hooksOptions,
          skipPoolsForTokensCache,
          ctx
        );
        break;
      }
      case UniProtocol.V3: {
        const v3Selector: ITopPoolsSelector<V3PoolInfo> = {
          filterPools: async (
            pools: V3PoolInfo[],
            chainId: ChainId,
            tIn: Address,
            tOut: Address,
            protocol: UniProtocol,
            hooksOptions: HooksOptions | undefined,
            ctx: Context
          ) =>
            (await topPoolsSelector.filterPools(
              pools,
              chainId,
              tIn,
              tOut,
              protocol,
              hooksOptions,
              ctx
            )) as V3PoolInfo[],
        };
        protocolPools = await this.v3PoolDiscoverer.getPoolsForTokens(
          chainId,
          protocol,
          tokenIn,
          tokenOut,
          v3Selector,
          hooksOptions,
          skipPoolsForTokensCache,
          ctx
        );
        break;
      }
      case UniProtocol.V4: {
        const v4Selector: ITopPoolsSelector<V4PoolInfo> = {
          filterPools: async (
            pools: V4PoolInfo[],
            chainId: ChainId,
            tIn: Address,
            tOut: Address,
            protocol: UniProtocol,
            hooksOptions: HooksOptions | undefined,
            ctx: Context
          ) =>
            (await topPoolsSelector.filterPools(
              pools,
              chainId,
              tIn,
              tOut,
              protocol,
              hooksOptions,
              ctx
            )) as V4PoolInfo[],
        };
        protocolPools = await this.v4PoolDiscoverer.getPoolsForTokens(
          chainId,
          protocol,
          tokenIn,
          tokenOut,
          v4Selector,
          hooksOptions,
          skipPoolsForTokensCache,
          ctx
        );
        break;
      }
      default:
        throw new Error(`Unsupported protocol ${protocol}`);
    }

    // Always add direct pools for each protocol
    let directPools: UniPoolInfo[] = [];
    switch (protocol) {
      case UniProtocol.V2:
        directPools = await this.v2DirectPoolDiscoverer.getPoolsForTokens(
          chainId,
          protocol,
          tokenIn,
          tokenOut,
          topPoolsSelector,
          hooksOptions,
          skipPoolsForTokensCache,
          ctx
        );
        break;
      case UniProtocol.V3:
        directPools = await this.v3DirectPoolDiscoverer.getPoolsForTokens(
          chainId,
          protocol,
          tokenIn,
          tokenOut,
          topPoolsSelector,
          hooksOptions,
          skipPoolsForTokensCache,
          ctx
        );
        break;
      case UniProtocol.V4:
        if (hooksOptions !== HooksOptions.HOOKS_ONLY) {
          directPools = await this.v4DirectPoolDiscoverer.getPoolsForTokens(
            chainId,
            protocol,
            tokenIn,
            tokenOut,
            topPoolsSelector,
            hooksOptions,
            skipPoolsForTokensCache,
            ctx
          );
        }
        break;
    }

    // Combine/Dedup protocol-specific pools with direct pools
    const uniquePools = new Map<string, UniPoolInfo>();
    for (const pool of protocolPools) {
      uniquePools.set(pool.id, pool);
    }
    for (const pool of directPools) {
      uniquePools.set(pool.id, pool);
    }

    return Array.from(uniquePools.values());
  }
}
