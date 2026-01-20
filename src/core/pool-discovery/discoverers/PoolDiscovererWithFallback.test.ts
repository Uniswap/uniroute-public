import {describe, beforeEach, it, expect, vi} from 'vitest';
import {
  PoolDiscovererWithFallbackV2,
  PoolDiscovererWithFallbackV3,
  PoolDiscovererWithFallbackV4,
} from './PoolDiscovererWithFallback';
import {ChainId} from '../../../lib/config';
import {UniProtocol} from '../../../models/pool/UniProtocol';
import {buildTestContext} from '@uniswap/lib-testhelpers';
import {
  getUniRouteTestConfig,
  IUniRouteServiceConfig,
} from '../../../lib/config';
import {BaseCachingPoolDiscoverer} from '../BaseCachingPoolDiscoverer';
import {V2PoolInfo, V3PoolInfo, V4PoolInfo} from '../interface';
import {Address} from '../../../models/address/Address';
import {USDC_MAINNET, USDT_MAINNET} from '../../../lib/tokenUtils';
import {ITopPoolsSelector} from '../interface';
import {Context} from '@uniswap/lib-uni/context';
import {HooksOptions} from '../../../models/hooks/HooksOptions';

// Mock pool data
const mockV2Pool: V2PoolInfo = {
  id: '0x1234',
  token0: {id: USDC_MAINNET.address},
  token1: {id: USDT_MAINNET.address},
  supply: 100,
  reserve: 100,
  reserveUSD: 100,
};

const mockV3Pool: V3PoolInfo = {
  id: '0x5678',
  feeTier: '3000',
  liquidity: '1000',
  token0: {id: USDC_MAINNET.address},
  token1: {id: USDT_MAINNET.address},
  tvlETH: 1000,
  tvlUSD: 1000,
};

const mockV4Pool: V4PoolInfo = {
  id: '0x9abc',
  feeTier: '3000',
  liquidity: '1000',
  tickSpacing: '60',
  hooks: '0x0000',
  token0: {id: USDC_MAINNET.address},
  token1: {id: USDT_MAINNET.address},
  tvlETH: 1000,
  tvlUSD: 1000,
};

// Test implementations of TopPoolsSelector for each version
class TestTopPoolsSelectorV2 implements ITopPoolsSelector<V2PoolInfo> {
  async filterPools(
    pools: V2PoolInfo[],
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
  ): Promise<V2PoolInfo[]> {
    return Promise.resolve(pools);
  }
}

class TestTopPoolsSelectorV3 implements ITopPoolsSelector<V3PoolInfo> {
  async filterPools(
    pools: V3PoolInfo[],
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
  ): Promise<V3PoolInfo[]> {
    return Promise.resolve(pools);
  }
}

class TestTopPoolsSelectorV4 implements ITopPoolsSelector<V4PoolInfo> {
  async filterPools(
    pools: V4PoolInfo[],
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
  ): Promise<V4PoolInfo[]> {
    return Promise.resolve(pools);
  }
}

describe('PoolDiscovererWithFallback', () => {
  const ctx = buildTestContext();
  const serviceConfig: IUniRouteServiceConfig = getUniRouteTestConfig();
  const tokenIn = new Address(USDC_MAINNET.address);
  const tokenOut = new Address(USDT_MAINNET.address);

  describe('V2', () => {
    let primaryDiscoverer: BaseCachingPoolDiscoverer<V2PoolInfo>;
    let fallbackDiscoverer: BaseCachingPoolDiscoverer<V2PoolInfo>;
    let discoverer: PoolDiscovererWithFallbackV2;
    const topPoolSelector = new TestTopPoolsSelectorV2();

    beforeEach(() => {
      primaryDiscoverer = {
        getPools: vi.fn(),
        getPoolsForTokens: vi.fn(),
      } as unknown as BaseCachingPoolDiscoverer<V2PoolInfo>;

      fallbackDiscoverer = {
        getPools: vi.fn(),
        getPoolsForTokens: vi.fn(),
      } as unknown as BaseCachingPoolDiscoverer<V2PoolInfo>;

      discoverer = new PoolDiscovererWithFallbackV2(
        serviceConfig,
        primaryDiscoverer,
        fallbackDiscoverer
      );
    });

    describe('getPools', () => {
      it('should use primary discoverer when it returns pools', async () => {
        vi.mocked(primaryDiscoverer.getPools).mockResolvedValue([mockV2Pool]);
        const pools = await discoverer.getPools(
          ChainId.MAINNET,
          UniProtocol.V2,
          ctx
        );
        expect(pools).toEqual([mockV2Pool]);
        expect(primaryDiscoverer.getPools).toHaveBeenCalledTimes(1);
        expect(fallbackDiscoverer.getPools).not.toHaveBeenCalled();
      });

      it('should use fallback discoverer when primary returns empty', async () => {
        vi.mocked(primaryDiscoverer.getPools).mockResolvedValue([]);
        vi.mocked(fallbackDiscoverer.getPools).mockResolvedValue([mockV2Pool]);
        const pools = await discoverer.getPools(
          ChainId.MAINNET,
          UniProtocol.V2,
          ctx
        );
        expect(pools).toEqual([mockV2Pool]);
        expect(primaryDiscoverer.getPools).toHaveBeenCalledTimes(1);
        expect(fallbackDiscoverer.getPools).toHaveBeenCalledTimes(1);
      });

      it('should use fallback discoverer when primary throws', async () => {
        vi.mocked(primaryDiscoverer.getPools).mockRejectedValue(
          new Error('Primary failed')
        );
        vi.mocked(fallbackDiscoverer.getPools).mockResolvedValue([mockV2Pool]);
        const pools = await discoverer.getPools(
          ChainId.MAINNET,
          UniProtocol.V2,
          ctx
        );
        expect(pools).toEqual([mockV2Pool]);
        expect(primaryDiscoverer.getPools).toHaveBeenCalledTimes(1);
        expect(fallbackDiscoverer.getPools).toHaveBeenCalledTimes(1);
      });

      it('should propagate error when both discoverers fail', async () => {
        const error = new Error('Both failed');
        vi.mocked(primaryDiscoverer.getPools).mockRejectedValue(
          new Error('Primary failed')
        );
        vi.mocked(fallbackDiscoverer.getPools).mockRejectedValue(error);
        await expect(
          discoverer.getPools(ChainId.MAINNET, UniProtocol.V2, ctx)
        ).rejects.toThrow(error);
        expect(primaryDiscoverer.getPools).toHaveBeenCalledTimes(1);
        expect(fallbackDiscoverer.getPools).toHaveBeenCalledTimes(1);
      });
    });

    describe('getPoolsForTokens', () => {
      it('should use primary discoverer when it returns pools', async () => {
        vi.mocked(primaryDiscoverer.getPoolsForTokens).mockResolvedValue([
          mockV2Pool,
        ]);
        const pools = await discoverer.getPoolsForTokens(
          ChainId.MAINNET,
          UniProtocol.V2,
          tokenIn,
          tokenOut,
          topPoolSelector,
          undefined,
          false,
          ctx
        );
        expect(pools).toEqual([mockV2Pool]);
        expect(primaryDiscoverer.getPoolsForTokens).toHaveBeenCalledTimes(1);
        expect(fallbackDiscoverer.getPoolsForTokens).not.toHaveBeenCalled();
      });

      it('should use fallback discoverer when primary returns empty', async () => {
        vi.mocked(primaryDiscoverer.getPoolsForTokens).mockResolvedValue([]);
        vi.mocked(fallbackDiscoverer.getPoolsForTokens).mockResolvedValue([
          mockV2Pool,
        ]);
        const pools = await discoverer.getPoolsForTokens(
          ChainId.MAINNET,
          UniProtocol.V2,
          tokenIn,
          tokenOut,
          topPoolSelector,
          undefined,
          false,
          ctx
        );
        expect(pools).toEqual([mockV2Pool]);
        expect(primaryDiscoverer.getPoolsForTokens).toHaveBeenCalledTimes(1);
        expect(fallbackDiscoverer.getPoolsForTokens).toHaveBeenCalledTimes(1);
      });

      it('should use fallback discoverer when primary throws', async () => {
        vi.mocked(primaryDiscoverer.getPoolsForTokens).mockRejectedValue(
          new Error('Primary failed')
        );
        vi.mocked(fallbackDiscoverer.getPoolsForTokens).mockResolvedValue([
          mockV2Pool,
        ]);
        const pools = await discoverer.getPoolsForTokens(
          ChainId.MAINNET,
          UniProtocol.V2,
          tokenIn,
          tokenOut,
          topPoolSelector,
          undefined,
          false,
          ctx
        );
        expect(pools).toEqual([mockV2Pool]);
        expect(primaryDiscoverer.getPoolsForTokens).toHaveBeenCalledTimes(1);
        expect(fallbackDiscoverer.getPoolsForTokens).toHaveBeenCalledTimes(1);
      });

      it('should propagate error when both discoverers fail', async () => {
        const error = new Error('Both failed');
        vi.mocked(primaryDiscoverer.getPoolsForTokens).mockRejectedValue(
          new Error('Primary failed')
        );
        vi.mocked(fallbackDiscoverer.getPoolsForTokens).mockRejectedValue(
          error
        );
        await expect(
          discoverer.getPoolsForTokens(
            ChainId.MAINNET,
            UniProtocol.V2,
            tokenIn,
            tokenOut,
            topPoolSelector,
            undefined,
            false,
            ctx
          )
        ).rejects.toThrow(error);
        expect(primaryDiscoverer.getPoolsForTokens).toHaveBeenCalledTimes(1);
        expect(fallbackDiscoverer.getPoolsForTokens).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('V3', () => {
    let primaryDiscoverer: BaseCachingPoolDiscoverer<V3PoolInfo>;
    let fallbackDiscoverer: BaseCachingPoolDiscoverer<V3PoolInfo>;
    let discoverer: PoolDiscovererWithFallbackV3;
    const topPoolSelector = new TestTopPoolsSelectorV3();

    beforeEach(() => {
      primaryDiscoverer = {
        getPools: vi.fn(),
        getPoolsForTokens: vi.fn(),
      } as unknown as BaseCachingPoolDiscoverer<V3PoolInfo>;

      fallbackDiscoverer = {
        getPools: vi.fn(),
        getPoolsForTokens: vi.fn(),
      } as unknown as BaseCachingPoolDiscoverer<V3PoolInfo>;

      discoverer = new PoolDiscovererWithFallbackV3(
        serviceConfig,
        primaryDiscoverer,
        fallbackDiscoverer
      );
    });

    describe('getPools', () => {
      it('should use primary discoverer when it returns pools', async () => {
        vi.mocked(primaryDiscoverer.getPools).mockResolvedValue([mockV3Pool]);
        const pools = await discoverer.getPools(
          ChainId.MAINNET,
          UniProtocol.V3,
          ctx
        );
        expect(pools).toEqual([mockV3Pool]);
        expect(primaryDiscoverer.getPools).toHaveBeenCalledTimes(1);
        expect(fallbackDiscoverer.getPools).not.toHaveBeenCalled();
      });

      it('should use fallback discoverer when primary returns empty', async () => {
        vi.mocked(primaryDiscoverer.getPools).mockResolvedValue([]);
        vi.mocked(fallbackDiscoverer.getPools).mockResolvedValue([mockV3Pool]);
        const pools = await discoverer.getPools(
          ChainId.MAINNET,
          UniProtocol.V3,
          ctx
        );
        expect(pools).toEqual([mockV3Pool]);
        expect(primaryDiscoverer.getPools).toHaveBeenCalledTimes(1);
        expect(fallbackDiscoverer.getPools).toHaveBeenCalledTimes(1);
      });

      it('should use fallback discoverer when primary throws', async () => {
        vi.mocked(primaryDiscoverer.getPools).mockRejectedValue(
          new Error('Primary failed')
        );
        vi.mocked(fallbackDiscoverer.getPools).mockResolvedValue([mockV3Pool]);
        const pools = await discoverer.getPools(
          ChainId.MAINNET,
          UniProtocol.V3,
          ctx
        );
        expect(pools).toEqual([mockV3Pool]);
        expect(primaryDiscoverer.getPools).toHaveBeenCalledTimes(1);
        expect(fallbackDiscoverer.getPools).toHaveBeenCalledTimes(1);
      });

      it('should propagate error when both discoverers fail', async () => {
        const error = new Error('Both failed');
        vi.mocked(primaryDiscoverer.getPools).mockRejectedValue(
          new Error('Primary failed')
        );
        vi.mocked(fallbackDiscoverer.getPools).mockRejectedValue(error);
        await expect(
          discoverer.getPools(ChainId.MAINNET, UniProtocol.V3, ctx)
        ).rejects.toThrow(error);
        expect(primaryDiscoverer.getPools).toHaveBeenCalledTimes(1);
        expect(fallbackDiscoverer.getPools).toHaveBeenCalledTimes(1);
      });
    });

    describe('getPoolsForTokens', () => {
      it('should use primary discoverer when it returns pools', async () => {
        vi.mocked(primaryDiscoverer.getPoolsForTokens).mockResolvedValue([
          mockV3Pool,
        ]);
        const pools = await discoverer.getPoolsForTokens(
          ChainId.MAINNET,
          UniProtocol.V3,
          tokenIn,
          tokenOut,
          topPoolSelector,
          undefined,
          false,
          ctx
        );
        expect(pools).toEqual([mockV3Pool]);
        expect(primaryDiscoverer.getPoolsForTokens).toHaveBeenCalledTimes(1);
        expect(fallbackDiscoverer.getPoolsForTokens).not.toHaveBeenCalled();
      });

      it('should use fallback discoverer when primary returns empty', async () => {
        vi.mocked(primaryDiscoverer.getPoolsForTokens).mockResolvedValue([]);
        vi.mocked(fallbackDiscoverer.getPoolsForTokens).mockResolvedValue([
          mockV3Pool,
        ]);
        const pools = await discoverer.getPoolsForTokens(
          ChainId.MAINNET,
          UniProtocol.V3,
          tokenIn,
          tokenOut,
          topPoolSelector,
          undefined,
          false,
          ctx
        );
        expect(pools).toEqual([mockV3Pool]);
        expect(primaryDiscoverer.getPoolsForTokens).toHaveBeenCalledTimes(1);
        expect(fallbackDiscoverer.getPoolsForTokens).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('V4', () => {
    let primaryDiscoverer: BaseCachingPoolDiscoverer<V4PoolInfo>;
    let fallbackDiscoverer: BaseCachingPoolDiscoverer<V4PoolInfo>;
    let discoverer: PoolDiscovererWithFallbackV4;
    const topPoolSelector = new TestTopPoolsSelectorV4();

    beforeEach(() => {
      primaryDiscoverer = {
        getPools: vi.fn(),
        getPoolsForTokens: vi.fn(),
      } as unknown as BaseCachingPoolDiscoverer<V4PoolInfo>;

      fallbackDiscoverer = {
        getPools: vi.fn(),
        getPoolsForTokens: vi.fn(),
      } as unknown as BaseCachingPoolDiscoverer<V4PoolInfo>;

      discoverer = new PoolDiscovererWithFallbackV4(
        serviceConfig,
        primaryDiscoverer,
        fallbackDiscoverer
      );
    });

    describe('getPools', () => {
      it('should use primary discoverer when it returns pools', async () => {
        vi.mocked(primaryDiscoverer.getPools).mockResolvedValue([mockV4Pool]);
        const pools = await discoverer.getPools(
          ChainId.MAINNET,
          UniProtocol.V4,
          ctx
        );
        expect(pools).toEqual([mockV4Pool]);
        expect(primaryDiscoverer.getPools).toHaveBeenCalledTimes(1);
        expect(fallbackDiscoverer.getPools).not.toHaveBeenCalled();
      });

      it('should use fallback discoverer when primary returns empty', async () => {
        vi.mocked(primaryDiscoverer.getPools).mockResolvedValue([]);
        vi.mocked(fallbackDiscoverer.getPools).mockResolvedValue([mockV4Pool]);
        const pools = await discoverer.getPools(
          ChainId.MAINNET,
          UniProtocol.V4,
          ctx
        );
        expect(pools).toEqual([mockV4Pool]);
        expect(primaryDiscoverer.getPools).toHaveBeenCalledTimes(1);
        expect(fallbackDiscoverer.getPools).toHaveBeenCalledTimes(1);
      });

      it('should use fallback discoverer when primary throws', async () => {
        vi.mocked(primaryDiscoverer.getPools).mockRejectedValue(
          new Error('Primary failed')
        );
        vi.mocked(fallbackDiscoverer.getPools).mockResolvedValue([mockV4Pool]);
        const pools = await discoverer.getPools(
          ChainId.MAINNET,
          UniProtocol.V4,
          ctx
        );
        expect(pools).toEqual([mockV4Pool]);
        expect(primaryDiscoverer.getPools).toHaveBeenCalledTimes(1);
        expect(fallbackDiscoverer.getPools).toHaveBeenCalledTimes(1);
      });

      it('should propagate error when both discoverers fail', async () => {
        const error = new Error('Both failed');
        vi.mocked(primaryDiscoverer.getPools).mockRejectedValue(
          new Error('Primary failed')
        );
        vi.mocked(fallbackDiscoverer.getPools).mockRejectedValue(error);
        await expect(
          discoverer.getPools(ChainId.MAINNET, UniProtocol.V4, ctx)
        ).rejects.toThrow(error);
        expect(primaryDiscoverer.getPools).toHaveBeenCalledTimes(1);
        expect(fallbackDiscoverer.getPools).toHaveBeenCalledTimes(1);
      });
    });

    describe('getPoolsForTokens', () => {
      it('should use primary discoverer when it returns pools', async () => {
        vi.mocked(primaryDiscoverer.getPoolsForTokens).mockResolvedValue([
          mockV4Pool,
        ]);
        const pools = await discoverer.getPoolsForTokens(
          ChainId.MAINNET,
          UniProtocol.V4,
          tokenIn,
          tokenOut,
          topPoolSelector,
          undefined,
          false,
          ctx
        );
        expect(pools).toEqual([mockV4Pool]);
        expect(primaryDiscoverer.getPoolsForTokens).toHaveBeenCalledTimes(1);
        expect(fallbackDiscoverer.getPoolsForTokens).not.toHaveBeenCalled();
      });

      it('should use fallback discoverer when primary returns empty', async () => {
        vi.mocked(primaryDiscoverer.getPoolsForTokens).mockResolvedValue([]);
        vi.mocked(fallbackDiscoverer.getPoolsForTokens).mockResolvedValue([
          mockV4Pool,
        ]);
        const pools = await discoverer.getPoolsForTokens(
          ChainId.MAINNET,
          UniProtocol.V4,
          tokenIn,
          tokenOut,
          topPoolSelector,
          undefined,
          false,
          ctx
        );
        expect(pools).toEqual([mockV4Pool]);
        expect(primaryDiscoverer.getPoolsForTokens).toHaveBeenCalledTimes(1);
        expect(fallbackDiscoverer.getPoolsForTokens).toHaveBeenCalledTimes(1);
      });
    });
  });
});
