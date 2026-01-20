import {describe, beforeEach, it, expect, vi} from 'vitest';
import {
  StaticPoolDiscovererV2,
  StaticPoolDiscovererV3,
  StaticPoolDiscovererV4,
} from './StaticPoolDiscoverer';
import {ChainId} from '../../../lib/config';
import {UniProtocol} from '../../../models/pool/UniProtocol';
import {Context} from '@uniswap/lib-uni/context';
import {IPoolsRepository} from '../../../stores/pool/IPoolsRepository';
import {V2Pool} from '../../../models/pool/V2Pool';
import {Address} from '../../../models/address/Address';
import {USDC_MAINNET, USDT_MAINNET} from '../../../lib/tokenUtils';
import {V3Pool} from 'src/models/pool/V3Pool';
import {V4Pool} from 'src/models/pool/V4Pool';
import {IRedisCache} from '@uniswap/lib-cache';
import {
  getUniRouteTestConfig,
  IUniRouteServiceConfig,
} from '../../../lib/config';
import {ITopPoolsSelector, UniPoolInfo} from '../interface';
import {buildTestContext} from '@uniswap/lib-testhelpers';
import {HooksOptions} from 'src/models/hooks/HooksOptions';

class TestTopPoolsSelector implements ITopPoolsSelector<UniPoolInfo> {
  async filterPools(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pools: any[],
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any[]> {
    return Promise.resolve(pools);
  }
}

describe('StaticPoolDiscovererV2', () => {
  let poolRepositoryV2: IPoolsRepository<V2Pool>;
  let discoverer: StaticPoolDiscovererV2;
  let ctx: Context;
  let getPoolsCache: IRedisCache<string, string>;
  let getPoolsForTokensCache: IRedisCache<string, string>;
  const serviceConfig: IUniRouteServiceConfig = getUniRouteTestConfig();
  const topPoolsSelector = new TestTopPoolsSelector();

  beforeEach(() => {
    poolRepositoryV2 = {
      getPools: vi.fn().mockResolvedValue([]),
    } as unknown as IPoolsRepository<V2Pool>;

    getPoolsCache = {
      get: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockResolvedValue(undefined),
    } as unknown as IRedisCache<string, string>;

    getPoolsForTokensCache = {
      get: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockResolvedValue(undefined),
    } as unknown as IRedisCache<string, string>;

    discoverer = new StaticPoolDiscovererV2(
      serviceConfig,
      poolRepositoryV2,
      getPoolsCache,
      getPoolsForTokensCache
    );

    ctx = buildTestContext();
  });

  it('should return a dummy pool for getPoolsForTokens', async () => {
    const dummyPool = new V2Pool(
      new Address(USDC_MAINNET.address),
      new Address(USDT_MAINNET.address),
      new Address('0x1111111111111111111111111111111111111111'),
      BigInt(1000),
      BigInt(2000)
    );

    poolRepositoryV2.getPools = vi.fn().mockResolvedValue([dummyPool]);

    const tokenIn = new Address(USDC_MAINNET.address);
    const tokenOut = new Address(USDT_MAINNET.address);
    const pools = await discoverer.getPoolsForTokens(
      ChainId.MAINNET,
      UniProtocol.V2,
      tokenIn,
      tokenOut,
      topPoolsSelector,
      undefined,
      false,
      ctx
    );

    expect(pools.length).toEqual(1);

    expect(pools[0].token0.id.toLowerCase()).toEqual(
      tokenIn.address.toLowerCase()
    );
    expect(pools[0].token1.id.toLowerCase()).toEqual(
      tokenOut.address.toLowerCase()
    );
    expect(pools[0].id).toEqual(dummyPool.address.address);
  });

  it('should use cache for getPoolsForTokens when available', async () => {
    const cachedPool = {
      id: '0x1111111111111111111111111111111111111111',
      token0: {id: USDC_MAINNET.address},
      token1: {id: USDT_MAINNET.address},
      liquidity: '100',
      supply: 100,
      reserve: 100,
      reserveUSD: 100,
    };

    getPoolsForTokensCache.get = vi
      .fn()
      .mockResolvedValue(JSON.stringify([cachedPool]));

    const tokenIn = new Address(USDC_MAINNET.address);
    const tokenOut = new Address(USDT_MAINNET.address);
    const pools = await discoverer.getPoolsForTokens(
      ChainId.MAINNET,
      UniProtocol.V2,
      tokenIn,
      tokenOut,
      topPoolsSelector,
      undefined,
      false,
      ctx
    );

    expect(pools.length).toEqual(1);
    expect(pools[0]).toEqual(cachedPool);
    expect(poolRepositoryV2.getPools).not.toHaveBeenCalled();
  });
});

describe('StaticPoolDiscovererV3', () => {
  let poolRepositoryV3: IPoolsRepository<V3Pool>;
  let discoverer: StaticPoolDiscovererV3;
  let ctx: Context;
  let getPoolsCache: IRedisCache<string, string>;
  let getPoolsForTokensCache: IRedisCache<string, string>;
  const serviceConfig: IUniRouteServiceConfig = getUniRouteTestConfig();
  const topPoolsSelector = new TestTopPoolsSelector();

  beforeEach(() => {
    poolRepositoryV3 = {
      getPools: vi.fn().mockResolvedValue([]),
    } as unknown as IPoolsRepository<V3Pool>;

    getPoolsCache = {
      get: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockResolvedValue(undefined),
    } as unknown as IRedisCache<string, string>;

    getPoolsForTokensCache = {
      get: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockResolvedValue(undefined),
    } as unknown as IRedisCache<string, string>;

    discoverer = new StaticPoolDiscovererV3(
      serviceConfig,
      poolRepositoryV3,
      getPoolsCache,
      getPoolsForTokensCache
    );

    ctx = buildTestContext();
  });

  it('should return a dummy pool for getPoolsForTokens', async () => {
    const dummyPool = new V3Pool(
      new Address(USDC_MAINNET.address),
      new Address(USDT_MAINNET.address),
      3000, // fee
      new Address('0x1111111111111111111111111111111111111111'),
      BigInt(1000), // liquidity,
      BigInt(1000), // sqrtPriceX96
      BigInt(1000) // tickCurrent
    );

    poolRepositoryV3.getPools = vi.fn().mockResolvedValue([dummyPool]);

    const tokenIn = new Address(USDC_MAINNET.address);
    const tokenOut = new Address(USDT_MAINNET.address);
    const pools = await discoverer.getPoolsForTokens(
      ChainId.MAINNET,
      UniProtocol.V3,
      tokenIn,
      tokenOut,
      topPoolsSelector,
      undefined,
      false,
      ctx
    );

    expect(pools.length).toEqual(1);

    expect(pools[0].token0.id.toLowerCase()).toEqual(
      tokenIn.address.toLowerCase()
    );
    expect(pools[0].token1.id.toLowerCase()).toEqual(
      tokenOut.address.toLowerCase()
    );
    expect(pools[0].id).toEqual(dummyPool.address.address);
  });

  it('should use cache for getPoolsForTokens when available', async () => {
    const cachedPool = {
      id: '0x1111111111111111111111111111111111111111',
      token0: {id: USDC_MAINNET.address},
      token1: {id: USDT_MAINNET.address},
      feeTier: '3000',
      liquidity: '1000',
      tvlETH: 1000,
      tvlUSD: 1000,
    };

    getPoolsForTokensCache.get = vi
      .fn()
      .mockResolvedValue(JSON.stringify([cachedPool]));

    const tokenIn = new Address(USDC_MAINNET.address);
    const tokenOut = new Address(USDT_MAINNET.address);
    const pools = await discoverer.getPoolsForTokens(
      ChainId.MAINNET,
      UniProtocol.V3,
      tokenIn,
      tokenOut,
      topPoolsSelector,
      undefined,
      false,
      ctx
    );

    expect(pools.length).toEqual(1);
    expect(pools[0]).toEqual(cachedPool);
    expect(poolRepositoryV3.getPools).not.toHaveBeenCalled();
  });
});

describe('StaticPoolDiscovererV4', () => {
  let poolRepositoryV4: IPoolsRepository<V4Pool>;
  let discoverer: StaticPoolDiscovererV4;
  let ctx: Context;
  let getPoolsCache: IRedisCache<string, string>;
  let getPoolsForTokensCache: IRedisCache<string, string>;
  const serviceConfig: IUniRouteServiceConfig = getUniRouteTestConfig();
  const topPoolsSelector = new TestTopPoolsSelector();

  beforeEach(() => {
    poolRepositoryV4 = {
      getPools: vi.fn().mockResolvedValue([]),
    } as unknown as IPoolsRepository<V4Pool>;

    getPoolsCache = {
      get: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockResolvedValue(undefined),
    } as unknown as IRedisCache<string, string>;

    getPoolsForTokensCache = {
      get: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockResolvedValue(undefined),
    } as unknown as IRedisCache<string, string>;

    discoverer = new StaticPoolDiscovererV4(
      serviceConfig,
      poolRepositoryV4,
      getPoolsCache,
      getPoolsForTokensCache
    );

    ctx = buildTestContext();
  });

  it('should return a dummy pool for getPoolsForTokens', async () => {
    const dummyPool = new V4Pool(
      new Address(USDC_MAINNET.address),
      new Address(USDT_MAINNET.address),
      3000, // fee
      1, // tickSpacing
      '0x1111111111111111111111111111111111111111', // hooks
      1000n, // liquidity
      '0x1111111111111111111111111111111111111111', // poolId,
      1000n, // sqrtPriceX96
      1000n // tickCurrent
    );

    poolRepositoryV4.getPools = vi.fn().mockResolvedValue([dummyPool]);

    const tokenIn = new Address(USDC_MAINNET.address);
    const tokenOut = new Address(USDT_MAINNET.address);
    const pools = await discoverer.getPoolsForTokens(
      ChainId.MAINNET,
      UniProtocol.V4,
      tokenIn,
      tokenOut,
      topPoolsSelector,
      undefined,
      false,
      ctx
    );

    expect(pools.length).toEqual(1);

    expect(pools[0].token0.id.toLowerCase()).toEqual(
      tokenIn.address.toLowerCase()
    );
    expect(pools[0].token1.id.toLowerCase()).toEqual(
      tokenOut.address.toLowerCase()
    );
    expect(pools[0].id).toEqual(dummyPool.address.address);
  });

  it('should use cache for getPoolsForTokens when available', async () => {
    const cachedPool = {
      id: '0x1111111111111111111111111111111111111111',
      token0: {id: USDC_MAINNET.address},
      token1: {id: USDT_MAINNET.address},
      feeTier: '3000',
      liquidity: '1000',
      tickSpacing: '1',
      hooks: '0x1111111111111111111111111111111111111111',
      tvlETH: 1000,
      tvlUSD: 1000,
    };

    getPoolsForTokensCache.get = vi
      .fn()
      .mockResolvedValue(JSON.stringify([cachedPool]));

    const tokenIn = new Address(USDC_MAINNET.address);
    const tokenOut = new Address(USDT_MAINNET.address);
    const pools = await discoverer.getPoolsForTokens(
      ChainId.MAINNET,
      UniProtocol.V4,
      tokenIn,
      tokenOut,
      topPoolsSelector,
      undefined,
      false,
      ctx
    );

    expect(pools.length).toEqual(1);
    expect(pools[0]).toEqual(cachedPool);
    expect(poolRepositoryV4.getPools).not.toHaveBeenCalled();
  });
});
