import {describe, beforeEach, it, expect, vi} from 'vitest';
import {BaseCachingPoolDiscoverer} from './BaseCachingPoolDiscoverer';
import {ChainId} from '../../lib/config';
import {UniProtocol} from '../../models/pool/UniProtocol';
import {Context} from '@uniswap/lib-uni/context';
import {ITopPoolsSelector, UniPoolInfo} from './interface';
import {IRedisCache} from '@uniswap/lib-cache';
import {Address} from '../../models/address/Address';
import {getUniRouteTestConfig, IUniRouteServiceConfig} from '../../lib/config';
import {HooksOptions} from '../../models/hooks/HooksOptions';

class TestTopPoolsSelector implements ITopPoolsSelector<UniPoolInfo> {
  async filterPools(
    pools: UniPoolInfo[],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    chainId: ChainId,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    tokenIn: Address,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    tokenOut: Address,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    protocol: UniProtocol,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    hooksOptions: HooksOptions | undefined,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ctx: Context
  ): Promise<UniPoolInfo[]> {
    return Promise.resolve(pools);
  }
}

class TestPoolDiscoverer extends BaseCachingPoolDiscoverer<UniPoolInfo> {
  constructor(
    protected serviceConfig: IUniRouteServiceConfig,
    protected getPoolsCache: IRedisCache<string, string>,
    protected getPoolsForTokensCache: IRedisCache<string, string>,
    protected unsupportedTokens: Set<string> = new Set()
  ) {
    super(
      serviceConfig,
      getPoolsCache,
      getPoolsForTokensCache,
      unsupportedTokens,
      'TestPoolDiscoverer'
    );
  }

  protected getDiscovererName(): string {
    return 'TestPoolDiscoverer';
  }

  protected async _getPools(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    chainId: ChainId,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    protocol: UniProtocol,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ctx: Context
  ): Promise<UniPoolInfo[]> {
    return [
      {
        id: 'test-pool',
        feeTier: '3000',
        tickSpacing: '1',
        hooks: '0x1111111111111111111111111111111111111111',
        liquidity: '1000',
        token0: {id: '0x1111111111111111111111111111111111111111'},
        token1: {id: '0x2222222222222222222222222222222222222222'},
        tvlETH: 1000,
        tvlUSD: 1000,
      },
    ];
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
  ): Promise<UniPoolInfo[]> {
    return [
      {
        id: 'test-pool-for-tokens',
        feeTier: '3000',
        tickSpacing: '1',
        hooks: '0x1111111111111111111111111111111111111111',
        liquidity: '1000',
        token0: {id: '0x1111111111111111111111111111111111111111'},
        token1: {id: '0x2222222222222222222222222222222222222222'},
        tvlETH: 1000,
        tvlUSD: 1000,
      },
    ];
  }
}

describe('BaseCachingPoolDiscoverer', () => {
  let getPoolsCache: IRedisCache<string, string>;
  let getPoolsForTokensCache: IRedisCache<string, string>;
  let poolDiscoverer: TestPoolDiscoverer;
  let ctx: Context;
  const serviceConfig = getUniRouteTestConfig();
  const topPoolSelector = new TestTopPoolsSelector();

  beforeEach(() => {
    getPoolsCache = {
      get: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockResolvedValue(undefined),
    } as unknown as IRedisCache<string, string>;

    getPoolsForTokensCache = {
      get: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockResolvedValue(undefined),
    } as unknown as IRedisCache<string, string>;

    poolDiscoverer = new TestPoolDiscoverer(
      serviceConfig,
      getPoolsCache,
      getPoolsForTokensCache
    );

    ctx = {
      metrics: {
        count: vi.fn(),
      },
      logger: {
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    } as unknown as Context;
  });

  it('should return pools from cache if available', async () => {
    const chainId = ChainId.MAINNET;
    const protocol = UniProtocol.V2;
    const cachedPools = [
      {
        id: 'cached-pool',
        feeTier: '3000',
        tickSpacing: '1',
        hooks: '0x1111111111111111111111111111111111111111',
        liquidity: '1000',
        token0: {id: '0x1111111111111111111111111111111111111111'},
        token1: {id: '0x2222222222222222222222222222222222222222'},
        tvlETH: 1000,
        tvlUSD: 1000,
      },
    ];

    getPoolsCache.get = vi.fn().mockResolvedValue(JSON.stringify(cachedPools));

    const pools = await poolDiscoverer.getPools(chainId, protocol, ctx);

    expect(pools).toEqual(cachedPools);
    expect(ctx.metrics.count).toHaveBeenCalledWith(expect.any(String), 1, {
      tags: ['result', 'hit'],
    });
  });

  it('should fetch pools and cache them if not available in cache', async () => {
    const chainId = ChainId.MAINNET;
    const protocol = UniProtocol.V2;
    const expectedPools = [
      {
        id: 'test-pool',
        feeTier: '3000',
        tickSpacing: '1',
        hooks: '0x1111111111111111111111111111111111111111',
        liquidity: '1000',
        token0: {id: '0x1111111111111111111111111111111111111111'},
        token1: {id: '0x2222222222222222222222222222222222222222'},
        tvlETH: 1000,
        tvlUSD: 1000,
      },
    ];

    const pools = await poolDiscoverer.getPools(chainId, protocol, ctx);

    expect(pools).toEqual(expectedPools);
    expect(getPoolsCache.set).toHaveBeenCalledWith(
      expect.any(String),
      JSON.stringify(expectedPools),
      expect.any(Object)
    );
    expect(ctx.metrics.count).toHaveBeenCalledWith(expect.any(String), 1, {
      tags: ['result', 'miss'],
    });
  });

  it('should return pools for tokens from cache if available', async () => {
    const chainId = ChainId.MAINNET;
    const protocol = UniProtocol.V2;
    const tokenIn = new Address('0x1111111111111111111111111111111111111111');
    const tokenOut = new Address('0x2222222222222222222222222222222222222222');
    const cachedPools = [
      {
        id: 'cached-pool-for-tokens',
        feeTier: '3000',
        tickSpacing: '1',
        hooks: '0x1111111111111111111111111111111111111111',
        liquidity: '1000',
        token0: {id: '0x1111111111111111111111111111111111111111'},
        token1: {id: '0x2222222222222222222222222222222222222222'},
        tvlETH: 1000,
        tvlUSD: 1000,
      },
    ];

    getPoolsForTokensCache.get = vi
      .fn()
      .mockResolvedValue(JSON.stringify(cachedPools));

    const pools = await poolDiscoverer.getPoolsForTokens(
      chainId,
      protocol,
      tokenIn,
      tokenOut,
      topPoolSelector,
      undefined,
      false,
      ctx
    );

    expect(pools).toEqual(cachedPools);
    expect(ctx.metrics.count).toHaveBeenCalledWith(expect.any(String), 1, {
      tags: ['result', 'hit'],
    });
  });

  it('should fetch pools for tokens and cache them if not available in cache', async () => {
    const chainId = ChainId.MAINNET;
    const protocol = UniProtocol.V2;
    const tokenIn = new Address('0x1111111111111111111111111111111111111111');
    const tokenOut = new Address('0x2222222222222222222222222222222222222222');
    const expectedPools = [
      {
        id: 'test-pool-for-tokens',
        feeTier: '3000',
        tickSpacing: '1',
        hooks: '0x1111111111111111111111111111111111111111',
        liquidity: '1000',
        token0: {id: '0x1111111111111111111111111111111111111111'},
        token1: {id: '0x2222222222222222222222222222222222222222'},
        tvlETH: 1000,
        tvlUSD: 1000,
      },
    ];

    const pools = await poolDiscoverer.getPoolsForTokens(
      chainId,
      protocol,
      tokenIn,
      tokenOut,
      topPoolSelector,
      undefined,
      false,
      ctx
    );

    expect(pools).toEqual(expectedPools);
    expect(getPoolsForTokensCache.set).toHaveBeenCalledWith(
      expect.any(String),
      JSON.stringify(expectedPools),
      expect.any(Object)
    );
    expect(ctx.metrics.count).toHaveBeenCalledWith(expect.any(String), 1, {
      tags: ['result', 'miss'],
    });
  });

  it('should generate different cache keys for different discoverer implementations', () => {
    const chainId = ChainId.MAINNET;
    const protocol = UniProtocol.V2;
    const tokenIn = new Address('0x1111111111111111111111111111111111111111');
    const tokenOut = new Address('0x2222222222222222222222222222222222222222');

    // Test that cache keys include the discoverer name as prefix
    const poolsCacheKey = poolDiscoverer.getPoolsCacheKey(chainId, protocol);
    const poolsForTokensCacheKey = poolDiscoverer.getPoolsForTokensCacheKey(
      chainId,
      protocol,
      tokenIn,
      tokenOut
    );

    expect(poolsCacheKey).toContain('TestPoolDiscoverer#POOLS#');
    expect(poolsForTokensCacheKey).toContain(
      'TestPoolDiscoverer#POOLSFORTOKENS#'
    );

    // Verify the full cache key format
    expect(poolsCacheKey).toBe('TestPoolDiscoverer#POOLS#1#v2');
    expect(poolsForTokensCacheKey).toBe(
      'TestPoolDiscoverer#POOLSFORTOKENS#1#v2#0x1111111111111111111111111111111111111111#0x2222222222222222222222222222222222222222'
    );
  });
});
