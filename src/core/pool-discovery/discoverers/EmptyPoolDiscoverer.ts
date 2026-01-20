import {V2PoolInfo, V3PoolInfo, V4PoolInfo} from '../interface';
import {Context} from '@uniswap/lib-uni/context';
import {ChainId} from '../../../lib/config';
import {UniProtocol} from '../../../models/pool/UniProtocol';
import {BaseCachingPoolDiscoverer} from '../BaseCachingPoolDiscoverer';
import {IRedisCache} from '@uniswap/lib-cache';
import {Address} from '../../../models/address/Address';
import {IUniRouteServiceConfig} from 'src/lib/config';

export class EmptyPoolDiscovererV2 extends BaseCachingPoolDiscoverer<V2PoolInfo> {
  constructor(
    protected serviceConfig: IUniRouteServiceConfig,
    protected getPoolsCache: IRedisCache<string, string>,
    protected getPoolsForTokensCache: IRedisCache<string, string>
  ) {
    super(
      serviceConfig,
      getPoolsCache,
      getPoolsForTokensCache,
      new Set(),
      'EmptyPoolDiscovererV2'
    );
  }

  protected getDiscovererName(): string {
    return 'EmptyPoolDiscovererV2';
  }

  protected async _getPools(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    chainId: ChainId,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    protocol: UniProtocol,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ctx: Context
  ): Promise<V2PoolInfo[]> {
    return [];
  }

  protected async _getPoolsForTokens(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    chainId: ChainId,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    protocol: UniProtocol,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    tokenIn: Address,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    tokenOut: Address,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ctx: Context
  ): Promise<V2PoolInfo[]> {
    return [];
  }
}

export class EmptyPoolDiscovererV3 extends BaseCachingPoolDiscoverer<V3PoolInfo> {
  constructor(
    protected serviceConfig: IUniRouteServiceConfig,
    protected getPoolsCache: IRedisCache<string, string>,
    protected getPoolsForTokensCache: IRedisCache<string, string>
  ) {
    super(
      serviceConfig,
      getPoolsCache,
      getPoolsForTokensCache,
      new Set(),
      'EmptyPoolDiscovererV3'
    );
  }

  protected getDiscovererName(): string {
    return 'EmptyPoolDiscovererV3';
  }

  protected async _getPools(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    chainId: ChainId,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    protocol: UniProtocol,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ctx: Context
  ): Promise<V3PoolInfo[]> {
    return [];
  }

  protected async _getPoolsForTokens(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    chainId: ChainId,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    protocol: UniProtocol,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    tokenIn: Address,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    tokenOut: Address,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ctx: Context
  ): Promise<V3PoolInfo[]> {
    return [];
  }
}

export class EmptyPoolDiscovererV4 extends BaseCachingPoolDiscoverer<V4PoolInfo> {
  constructor(
    protected serviceConfig: IUniRouteServiceConfig,
    protected getPoolsCache: IRedisCache<string, string>,
    protected getPoolsForTokensCache: IRedisCache<string, string>
  ) {
    super(
      serviceConfig,
      getPoolsCache,
      getPoolsForTokensCache,
      new Set(),
      'EmptyPoolDiscovererV4'
    );
  }

  protected getDiscovererName(): string {
    return 'EmptyPoolDiscovererV4';
  }

  protected async _getPools(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    chainId: ChainId,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    protocol: UniProtocol,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ctx: Context
  ): Promise<V4PoolInfo[]> {
    return [];
  }

  protected async _getPoolsForTokens(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    chainId: ChainId,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    protocol: UniProtocol,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    tokenIn: Address,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    tokenOut: Address,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ctx: Context
  ): Promise<V4PoolInfo[]> {
    return [];
  }
}
