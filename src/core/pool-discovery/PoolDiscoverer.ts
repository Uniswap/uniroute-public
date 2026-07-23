import {Context} from '@uniswap/lib-uni/context';
import {
  IPoolDiscoverer,
  ITopPoolsSelector,
  PoolsForTokensCacheDirective,
  UniPoolInfo,
  V2PoolInfo,
  V3PoolInfo,
  V4PoolInfo,
} from './interface';
import {ChainId} from '../../lib/config';
import {Protocol} from '../../models/pool/Protocol';
import {Address} from '../../models/address/Address';
import {HooksOptions} from '../../models/hooks/HooksOptions';
import {RouteNamespaceContext} from '../../models/hooks/namespaces';

// Main class that delegates pool discovery to the appropriate pool discoverer based on the protocol.
// Different implementations can be plugged in during init and passed down to BL.
export class PoolDiscoverer implements IPoolDiscoverer<UniPoolInfo> {
  /**
   * Run the direct exact-pair probe concurrently with the primary
   * (S3/cached) discovery instead of after it. The two are independent —
   * separate cache namespaces, and the merge in `getPoolsForTokens` is
   * order-preserving either way — but sequential execution puts the direct
   * probe's on-chain RPC wall (V4: 2 StateView calls x 4 fee tiers on a
   * cold pair) on top of the primary path for every call. Kill switch:
   * set POOL_DISCOVERY_PARALLEL_DIRECT_ENABLED to 'false' and redeploy.
   */
  private readonly parallelDirectDiscoveryEnabled =
    process.env.POOL_DISCOVERY_PARALLEL_DIRECT_ENABLED === 'true';

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
    protocol: Protocol,
    ctx: Context
  ): Promise<UniPoolInfo[]> {
    switch (protocol) {
      case Protocol.V2:
        return this.v2PoolDiscoverer.getPools(chainId, protocol, ctx);
      case Protocol.V3:
        return this.v3PoolDiscoverer.getPools(chainId, protocol, ctx);
      case Protocol.V4:
        return this.v4PoolDiscoverer.getPools(chainId, protocol, ctx);
      default:
        throw new Error(`Unsupported protocol ${protocol}`);
    }
  }

  public async getPoolsForTokens(
    chainId: ChainId,
    protocol: Protocol,
    tokenIn: Address,
    tokenOut: Address,
    topPoolsSelector: ITopPoolsSelector<UniPoolInfo>,
    hooksOptions: HooksOptions | undefined,
    skipPoolsForTokensCache: boolean,
    nsCtx: RouteNamespaceContext,
    ctx: Context
  ): Promise<UniPoolInfo[]> {
    // Start the direct exact-pair probe concurrently with the primary
    // discovery when enabled (see parallelDirectDiscoveryEnabled). The
    // no-op catch prevents an unhandled rejection if the primary path
    // throws before this promise is awaited; the await below still
    // rethrows the original error.
    let directPoolsPromise: Promise<UniPoolInfo[]> | undefined;
    if (this.parallelDirectDiscoveryEnabled) {
      directPoolsPromise = this.fetchDirectPools(
        chainId,
        protocol,
        tokenIn,
        tokenOut,
        topPoolsSelector,
        hooksOptions,
        skipPoolsForTokensCache,
        nsCtx,
        ctx
      );
      directPoolsPromise.catch(() => {});
    }

    // Get protocol-specific pools
    let protocolPools: UniPoolInfo[] = [];
    switch (protocol) {
      case Protocol.V2: {
        const v2Selector: ITopPoolsSelector<V2PoolInfo> = {
          filterPools: async (
            pools: V2PoolInfo[],
            chainId: ChainId,
            tIn: Address,
            tOut: Address,
            protocol: Protocol,
            hooksOptions: HooksOptions | undefined,
            nsCtx: RouteNamespaceContext,
            ctx: Context,
            cacheDirective: PoolsForTokensCacheDirective
          ) =>
            (await topPoolsSelector.filterPools(
              pools,
              chainId,
              tIn,
              tOut,
              protocol,
              hooksOptions,
              nsCtx,
              ctx,
              cacheDirective
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
          nsCtx,
          ctx
        );
        break;
      }
      case Protocol.V3: {
        const v3Selector: ITopPoolsSelector<V3PoolInfo> = {
          filterPools: async (
            pools: V3PoolInfo[],
            chainId: ChainId,
            tIn: Address,
            tOut: Address,
            protocol: Protocol,
            hooksOptions: HooksOptions | undefined,
            nsCtx: RouteNamespaceContext,
            ctx: Context,
            cacheDirective: PoolsForTokensCacheDirective
          ) =>
            (await topPoolsSelector.filterPools(
              pools,
              chainId,
              tIn,
              tOut,
              protocol,
              hooksOptions,
              nsCtx,
              ctx,
              cacheDirective
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
          nsCtx,
          ctx
        );
        break;
      }
      case Protocol.V4: {
        const v4Selector: ITopPoolsSelector<V4PoolInfo> = {
          // Forward the marker — S3SubgraphPoolDiscovererV4's CCA merge gate
          // reads it through this adapter.
          aggHooksOnly: topPoolsSelector.aggHooksOnly,
          filterPools: async (
            pools: V4PoolInfo[],
            chainId: ChainId,
            tIn: Address,
            tOut: Address,
            protocol: Protocol,
            hooksOptions: HooksOptions | undefined,
            nsCtx: RouteNamespaceContext,
            ctx: Context,
            cacheDirective: PoolsForTokensCacheDirective
          ) =>
            (await topPoolsSelector.filterPools(
              pools,
              chainId,
              tIn,
              tOut,
              protocol,
              hooksOptions,
              nsCtx,
              ctx,
              cacheDirective
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
          nsCtx,
          ctx
        );
        break;
      }
      default:
        throw new Error(`Unsupported protocol ${protocol}`);
    }

    // Always add direct pools for each protocol
    const directPools =
      directPoolsPromise !== undefined
        ? await directPoolsPromise
        : await this.fetchDirectPools(
            chainId,
            protocol,
            tokenIn,
            tokenOut,
            topPoolsSelector,
            hooksOptions,
            skipPoolsForTokensCache,
            nsCtx,
            ctx
          );

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

  private async fetchDirectPools(
    chainId: ChainId,
    protocol: Protocol,
    tokenIn: Address,
    tokenOut: Address,
    topPoolsSelector: ITopPoolsSelector<UniPoolInfo>,
    hooksOptions: HooksOptions | undefined,
    skipPoolsForTokensCache: boolean,
    nsCtx: RouteNamespaceContext,
    ctx: Context
  ): Promise<UniPoolInfo[]> {
    switch (protocol) {
      case Protocol.V2:
        return this.v2DirectPoolDiscoverer.getPoolsForTokens(
          chainId,
          protocol,
          tokenIn,
          tokenOut,
          topPoolsSelector,
          hooksOptions,
          skipPoolsForTokensCache,
          nsCtx,
          ctx
        );
      case Protocol.V3:
        return this.v3DirectPoolDiscoverer.getPoolsForTokens(
          chainId,
          protocol,
          tokenIn,
          tokenOut,
          topPoolsSelector,
          hooksOptions,
          skipPoolsForTokensCache,
          nsCtx,
          ctx
        );
      case Protocol.V4:
        if (hooksOptions !== HooksOptions.HOOKS_ONLY) {
          return this.v4DirectPoolDiscoverer.getPoolsForTokens(
            chainId,
            protocol,
            tokenIn,
            tokenOut,
            topPoolsSelector,
            hooksOptions,
            skipPoolsForTokensCache,
            nsCtx,
            ctx
          );
        }
        return [];
      default:
        return [];
    }
  }
}
