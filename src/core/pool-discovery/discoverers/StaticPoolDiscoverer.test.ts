import {describe, beforeEach, it, expect, vi} from 'vitest';
import {
  StaticPoolDiscovererV2,
  StaticPoolDiscovererV3,
  StaticPoolDiscovererV4,
} from './StaticPoolDiscoverer';
import {ChainId} from '../../../lib/config';
import {Context} from '@uniswap/lib-uni/context';
import {IPoolsRepository} from '../../../stores/pool/IPoolsRepository';
import {V2Pool} from '../../../models/pool/V2Pool';
import {Address} from '../../../models/address/Address';
import {
  DAI_MAINNET,
  USDC_MAINNET,
  USDT_MAINNET,
  WRAPPED_NATIVE_CURRENCY,
} from '../../../lib/tokenUtils';
import {V3Pool} from 'src/models/pool/V3Pool';
import {V4Pool} from 'src/models/pool/V4Pool';
import {IRedisCache} from '@uniswap/lib-cache';
import {FeatureGatedTokensRepository} from '../../../stores/compliance/FeatureGatedTokensRepository';
import {
  getUniRouteTestConfig,
  IUniRouteServiceConfig,
} from '../../../lib/config';
import {
  ITopPoolsSelector,
  PoolsForTokensCacheDirective,
  UniPoolInfo,
} from '../interface';
import {buildTestContext} from '@uniswap/lib-testhelpers';
import {HooksOptions} from 'src/models/hooks/HooksOptions';
import {Protocol} from 'src/models/pool/Protocol';
import {
  EMPTY_NAMESPACE_CONTEXT,
  RouteNamespaceContext,
} from '../../../models/hooks/namespaces';
import {DiscoveryDegradedReason} from '../discoveryDegraded';

// Two base tokens (not tokenIn/tokenOut in these tests) that
// createUniquePairs will always probe as a pair, used to simulate one failed
// probe among many in the fixed base-token x tokenIn/tokenOut grid.
const FAILING_BASE_PAIR_ADDRESSES = new Set(
  [WRAPPED_NATIVE_CURRENCY[ChainId.MAINNET]!.address, DAI_MAINNET.address].map(
    address => address.toLowerCase()
  )
);

function isFailingBasePair(tokenA: Address, tokenB: Address): boolean {
  return (
    FAILING_BASE_PAIR_ADDRESSES.has(tokenA.address.toLowerCase()) &&
    FAILING_BASE_PAIR_ADDRESSES.has(tokenB.address.toLowerCase())
  );
}

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
    protocol: Protocol,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    hooksOptions: HooksOptions | undefined,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    nsCtx: RouteNamespaceContext,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ctx: Context,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    cacheDirective: PoolsForTokensCacheDirective
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
      probePools: vi.fn().mockResolvedValue({pools: [], failedProbeCount: 0}),
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
      getPoolsForTokensCache,
      FeatureGatedTokensRepository.empty()
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

    poolRepositoryV2.probePools = vi
      .fn()
      .mockResolvedValue({pools: [dummyPool], failedProbeCount: 0});

    const tokenIn = new Address(USDC_MAINNET.address);
    const tokenOut = new Address(USDT_MAINNET.address);
    const {pools} = await discoverer.getPoolsForTokens(
      ChainId.MAINNET,
      Protocol.V2,
      tokenIn,
      tokenOut,
      topPoolsSelector,
      undefined,
      false,
      EMPTY_NAMESPACE_CONTEXT,
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
    const {pools} = await discoverer.getPoolsForTokens(
      ChainId.MAINNET,
      Protocol.V2,
      tokenIn,
      tokenOut,
      topPoolsSelector,
      undefined,
      false,
      EMPTY_NAMESPACE_CONTEXT,
      ctx
    );

    expect(pools.length).toEqual(1);
    expect(pools[0]).toEqual(cachedPool);
    expect(poolRepositoryV2.probePools).not.toHaveBeenCalled();
  });

  it('sums probePools failed-probe counts and keeps pools from the other pairs', async () => {
    const dummyPool = new V2Pool(
      new Address(USDC_MAINNET.address),
      new Address(USDT_MAINNET.address),
      new Address('0x1111111111111111111111111111111111111111'),
      BigInt(1000),
      BigInt(2000)
    );
    class FakeV2PoolsRepositoryWithFailingBasePair implements IPoolsRepository<V2Pool> {
      public probePoolCallCount = 0;

      async probePools(
        _ctx: Context,
        _chainId: ChainId,
        tokenInAddress: Address,
        tokenOutAddress: Address
      ): Promise<{pools: V2Pool[]; failedProbeCount: number}> {
        this.probePoolCallCount += 1;
        if (isFailingBasePair(tokenInAddress, tokenOutAddress)) {
          return {pools: [], failedProbeCount: 1};
        }
        return {pools: [dummyPool], failedProbeCount: 0};
      }

      async getPools(): Promise<V2Pool[]> {
        throw new Error(
          'StaticPoolDiscovererV2 must probe pools through probePools, not getPools'
        );
      }
    }
    const repository = new FakeV2PoolsRepositoryWithFailingBasePair();
    discoverer = new StaticPoolDiscovererV2(
      serviceConfig,
      repository,
      getPoolsCache,
      getPoolsForTokensCache,
      FeatureGatedTokensRepository.empty()
    );

    const tokenIn = new Address(USDC_MAINNET.address);
    const tokenOut = new Address(USDT_MAINNET.address);
    const result = await discoverer.getPoolsForTokens(
      ChainId.MAINNET,
      Protocol.V2,
      tokenIn,
      tokenOut,
      topPoolsSelector,
      undefined,
      false,
      EMPTY_NAMESPACE_CONTEXT,
      ctx
    );

    expect(result.degradedReasons).toEqual([
      DiscoveryDegradedReason.PROBE_ERROR,
    ]);
    // The non-failing pairs all resolve to the same dummyPool object, which
    // StaticPoolDiscovererV2 de-dupes by pool address.
    expect(result.pools).toHaveLength(1);
    expect(result.pools[0].id).toEqual(dummyPool.address.address);
    expect(repository.probePoolCallCount).toBeGreaterThan(1);
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
      probePools: vi.fn().mockResolvedValue({pools: [], failedProbeCount: 0}),
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
      getPoolsForTokensCache,
      FeatureGatedTokensRepository.empty()
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

    poolRepositoryV3.probePools = vi
      .fn()
      .mockResolvedValue({pools: [dummyPool], failedProbeCount: 0});

    const tokenIn = new Address(USDC_MAINNET.address);
    const tokenOut = new Address(USDT_MAINNET.address);
    const {pools} = await discoverer.getPoolsForTokens(
      ChainId.MAINNET,
      Protocol.V3,
      tokenIn,
      tokenOut,
      topPoolsSelector,
      undefined,
      false,
      EMPTY_NAMESPACE_CONTEXT,
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
    const {pools} = await discoverer.getPoolsForTokens(
      ChainId.MAINNET,
      Protocol.V3,
      tokenIn,
      tokenOut,
      topPoolsSelector,
      undefined,
      false,
      EMPTY_NAMESPACE_CONTEXT,
      ctx
    );

    expect(pools.length).toEqual(1);
    expect(pools[0]).toEqual(cachedPool);
    expect(poolRepositoryV3.probePools).not.toHaveBeenCalled();
  });

  it('sums probePools failed-probe counts and keeps pools from the other pairs', async () => {
    const dummyPool = new V3Pool(
      new Address(USDC_MAINNET.address),
      new Address(USDT_MAINNET.address),
      3000,
      new Address('0x1111111111111111111111111111111111111111'),
      BigInt(1000),
      BigInt(1000),
      BigInt(1000)
    );
    class FakeV3PoolsRepositoryWithFailingBasePair implements IPoolsRepository<V3Pool> {
      public probePoolCallCount = 0;

      async probePools(
        _ctx: Context,
        _chainId: ChainId,
        tokenInAddress: Address,
        tokenOutAddress: Address
      ): Promise<{pools: V3Pool[]; failedProbeCount: number}> {
        this.probePoolCallCount += 1;
        if (isFailingBasePair(tokenInAddress, tokenOutAddress)) {
          return {pools: [], failedProbeCount: 1};
        }
        return {pools: [dummyPool], failedProbeCount: 0};
      }

      async getPools(): Promise<V3Pool[]> {
        throw new Error(
          'StaticPoolDiscovererV3 must probe pools through probePools, not getPools'
        );
      }
    }
    const repository = new FakeV3PoolsRepositoryWithFailingBasePair();
    discoverer = new StaticPoolDiscovererV3(
      serviceConfig,
      repository,
      getPoolsCache,
      getPoolsForTokensCache,
      FeatureGatedTokensRepository.empty()
    );

    const tokenIn = new Address(USDC_MAINNET.address);
    const tokenOut = new Address(USDT_MAINNET.address);
    const result = await discoverer.getPoolsForTokens(
      ChainId.MAINNET,
      Protocol.V3,
      tokenIn,
      tokenOut,
      topPoolsSelector,
      undefined,
      false,
      EMPTY_NAMESPACE_CONTEXT,
      ctx
    );

    expect(result.degradedReasons).toEqual([
      DiscoveryDegradedReason.PROBE_ERROR,
    ]);
    expect(result.pools).toHaveLength(1);
    expect(result.pools[0].id).toEqual(dummyPool.address.address);
    expect(repository.probePoolCallCount).toBeGreaterThan(1);
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
      probePools: vi.fn().mockResolvedValue({pools: [], failedProbeCount: 0}),
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
      getPoolsForTokensCache,
      FeatureGatedTokensRepository.empty()
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

    poolRepositoryV4.probePools = vi
      .fn()
      .mockResolvedValue({pools: [dummyPool], failedProbeCount: 0});

    const tokenIn = new Address(USDC_MAINNET.address);
    const tokenOut = new Address(USDT_MAINNET.address);
    const {pools} = await discoverer.getPoolsForTokens(
      ChainId.MAINNET,
      Protocol.V4,
      tokenIn,
      tokenOut,
      topPoolsSelector,
      undefined,
      false,
      EMPTY_NAMESPACE_CONTEXT,
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
    const {pools} = await discoverer.getPoolsForTokens(
      ChainId.MAINNET,
      Protocol.V4,
      tokenIn,
      tokenOut,
      topPoolsSelector,
      undefined,
      false,
      EMPTY_NAMESPACE_CONTEXT,
      ctx
    );

    expect(pools.length).toEqual(1);
    expect(pools[0]).toEqual(cachedPool);
    expect(poolRepositoryV4.probePools).not.toHaveBeenCalled();
  });

  it('sums probePools failed-probe counts and keeps pools from the other pairs', async () => {
    const dummyPool = new V4Pool(
      new Address(USDC_MAINNET.address),
      new Address(USDT_MAINNET.address),
      3000,
      1,
      '0x1111111111111111111111111111111111111111',
      1000n,
      '0x1111111111111111111111111111111111111111',
      1000n,
      1000n
    );
    class FakeV4PoolsRepositoryWithFailingBasePair implements IPoolsRepository<V4Pool> {
      public probePoolCallCount = 0;

      async probePools(
        _ctx: Context,
        _chainId: ChainId,
        tokenInAddress: Address,
        tokenOutAddress: Address
      ): Promise<{pools: V4Pool[]; failedProbeCount: number}> {
        this.probePoolCallCount += 1;
        if (isFailingBasePair(tokenInAddress, tokenOutAddress)) {
          return {pools: [], failedProbeCount: 1};
        }
        return {pools: [dummyPool], failedProbeCount: 0};
      }

      async getPools(): Promise<V4Pool[]> {
        throw new Error(
          'StaticPoolDiscovererV4 must probe pools through probePools, not getPools'
        );
      }
    }
    const repository = new FakeV4PoolsRepositoryWithFailingBasePair();
    discoverer = new StaticPoolDiscovererV4(
      serviceConfig,
      repository,
      getPoolsCache,
      getPoolsForTokensCache,
      FeatureGatedTokensRepository.empty()
    );

    const tokenIn = new Address(USDC_MAINNET.address);
    const tokenOut = new Address(USDT_MAINNET.address);
    const result = await discoverer.getPoolsForTokens(
      ChainId.MAINNET,
      Protocol.V4,
      tokenIn,
      tokenOut,
      topPoolsSelector,
      undefined,
      false,
      EMPTY_NAMESPACE_CONTEXT,
      ctx
    );

    expect(result.degradedReasons).toEqual([
      DiscoveryDegradedReason.PROBE_ERROR,
    ]);
    expect(result.pools).toHaveLength(1);
    expect(result.pools[0].id).toEqual(dummyPool.address.address);
    expect(repository.probePoolCallCount).toBeGreaterThan(1);
  });
});
