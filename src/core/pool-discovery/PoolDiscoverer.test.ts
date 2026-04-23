import {describe, beforeEach, it, expect, vi} from 'vitest';
import {PoolDiscoverer} from './PoolDiscoverer';
import {ChainId} from '../../lib/config';
import {Protocol} from '../../models/pool/Protocol';
import {Context} from '@uniswap/lib-uni/context';
import {
  IPoolDiscoverer,
  ITopPoolsSelector,
  UniPoolInfo,
  V2PoolInfo,
  V3PoolInfo,
  V4PoolInfo,
} from './interface';
import {Address} from '../../models/address/Address';
import {HooksOptions} from '../../models/hooks/HooksOptions';

const TOKEN_IN = new Address('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
const TOKEN_OUT = new Address('0xdac17f958d2ee523a2206206994597c13d831ec7');

function makeDiscoverer<T extends UniPoolInfo>(
  getPoolsResult: T[] = [],
  getPoolsForTokensResult: T[] = []
): IPoolDiscoverer<T> {
  return {
    getPools: vi.fn().mockResolvedValue(getPoolsResult),
    getPoolsForTokens: vi.fn().mockResolvedValue(getPoolsForTokensResult),
  } as unknown as IPoolDiscoverer<T>;
}

function makeSelector(): ITopPoolsSelector<UniPoolInfo> {
  return {
    filterPools: vi
      .fn()
      .mockImplementation(async (pools: UniPoolInfo[]) => pools),
  };
}

describe('PoolDiscoverer', () => {
  let v2PoolDiscoverer: IPoolDiscoverer<V2PoolInfo>;
  let v3PoolDiscoverer: IPoolDiscoverer<V3PoolInfo>;
  let v4PoolDiscoverer: IPoolDiscoverer<V4PoolInfo>;
  let v2DirectPoolDiscoverer: IPoolDiscoverer<V2PoolInfo>;
  let v3DirectPoolDiscoverer: IPoolDiscoverer<V3PoolInfo>;
  let v4DirectPoolDiscoverer: IPoolDiscoverer<V4PoolInfo>;
  let poolDiscoverer: PoolDiscoverer;
  let ctx: Context;

  beforeEach(() => {
    v2PoolDiscoverer = makeDiscoverer<V2PoolInfo>([
      {id: 'v2-pool'} as V2PoolInfo,
    ]);
    v3PoolDiscoverer = makeDiscoverer<V3PoolInfo>([
      {id: 'v3-pool'} as V3PoolInfo,
    ]);
    v4PoolDiscoverer = makeDiscoverer<V4PoolInfo>([
      {id: 'v4-pool'} as V4PoolInfo,
    ]);
    v2DirectPoolDiscoverer = makeDiscoverer<V2PoolInfo>([
      {id: 'v2-pool'} as V2PoolInfo,
    ]);
    v3DirectPoolDiscoverer = makeDiscoverer<V3PoolInfo>([
      {id: 'v3-pool'} as V3PoolInfo,
    ]);
    v4DirectPoolDiscoverer = makeDiscoverer<V4PoolInfo>([
      {id: 'v4-pool'} as V4PoolInfo,
    ]);

    poolDiscoverer = new PoolDiscoverer(
      v2PoolDiscoverer,
      v3PoolDiscoverer,
      v4PoolDiscoverer,
      v2DirectPoolDiscoverer,
      v3DirectPoolDiscoverer,
      v4DirectPoolDiscoverer
    );

    ctx = {
      metrics: {
        count: vi.fn(),
      },
    } as unknown as Context;
  });

  // ── getPools ──────────────────────────────────────────────────────────────

  describe('getPools', () => {
    it('should delegate to v2PoolDiscoverer for Protocol.V2', async () => {
      const pools = await poolDiscoverer.getPools(
        ChainId.MAINNET,
        Protocol.V2,
        ctx
      );

      expect(pools).toEqual([{id: 'v2-pool'}]);
      expect(v2PoolDiscoverer.getPools).toHaveBeenCalledWith(
        ChainId.MAINNET,
        Protocol.V2,
        ctx
      );
    });

    it('should delegate to v3PoolDiscoverer for Protocol.V3', async () => {
      const pools = await poolDiscoverer.getPools(
        ChainId.MAINNET,
        Protocol.V3,
        ctx
      );

      expect(pools).toEqual([{id: 'v3-pool'}]);
      expect(v3PoolDiscoverer.getPools).toHaveBeenCalledWith(
        ChainId.MAINNET,
        Protocol.V3,
        ctx
      );
    });

    it('should delegate to v4PoolDiscoverer for Protocol.V4', async () => {
      const pools = await poolDiscoverer.getPools(
        ChainId.MAINNET,
        Protocol.V4,
        ctx
      );

      expect(pools).toEqual([{id: 'v4-pool'}]);
      expect(v4PoolDiscoverer.getPools).toHaveBeenCalledWith(
        ChainId.MAINNET,
        Protocol.V4,
        ctx
      );
    });

    it('should throw for external protocols', async () => {
      const externalProtocols = [
        Protocol.CURVESTABLESWAPNG,
        Protocol.FLUIDDEXT1,
        Protocol.FLUIDDEXLITE,
        Protocol.FLUIDDEXV2,
        Protocol.CURVESTABLESWAP,
        Protocol.TEMPOEXCHANGE,
      ];

      for (const protocol of externalProtocols) {
        await expect(
          poolDiscoverer.getPools(ChainId.MAINNET, protocol, ctx)
        ).rejects.toThrow(`Unsupported protocol ${protocol}`);
      }
    });

    it('should throw for unsupported protocol', async () => {
      const protocol = 'unsupported-protocol' as Protocol;

      await expect(
        poolDiscoverer.getPools(ChainId.MAINNET, protocol, ctx)
      ).rejects.toThrow(`Unsupported protocol ${protocol}`);
    });
  });

  // ── getPoolsForTokens ────────────────────────────────────────────────────

  describe('getPoolsForTokens', () => {
    it('should call v2PoolDiscoverer and v2DirectPoolDiscoverer for Protocol.V2', async () => {
      v2PoolDiscoverer = makeDiscoverer<V2PoolInfo>(
        [],
        [{id: 'v2-subgraph'} as V2PoolInfo]
      );
      v2DirectPoolDiscoverer = makeDiscoverer<V2PoolInfo>(
        [],
        [{id: 'v2-direct'} as V2PoolInfo]
      );
      poolDiscoverer = new PoolDiscoverer(
        v2PoolDiscoverer,
        v3PoolDiscoverer,
        v4PoolDiscoverer,
        v2DirectPoolDiscoverer,
        v3DirectPoolDiscoverer,
        v4DirectPoolDiscoverer
      );
      const selector = makeSelector();

      const result = await poolDiscoverer.getPoolsForTokens(
        ChainId.MAINNET,
        Protocol.V2,
        TOKEN_IN,
        TOKEN_OUT,
        selector,
        undefined,
        false,
        ctx
      );

      expect(v2PoolDiscoverer.getPoolsForTokens).toHaveBeenCalledWith(
        ChainId.MAINNET,
        Protocol.V2,
        TOKEN_IN,
        TOKEN_OUT,
        expect.any(Object),
        undefined,
        false,
        ctx,
        undefined
      );
      expect(v2DirectPoolDiscoverer.getPoolsForTokens).toHaveBeenCalled();
      expect(result).toEqual(
        expect.arrayContaining([{id: 'v2-subgraph'}, {id: 'v2-direct'}])
      );
    });

    it('should call v3PoolDiscoverer and v3DirectPoolDiscoverer for Protocol.V3', async () => {
      v3PoolDiscoverer = makeDiscoverer<V3PoolInfo>(
        [],
        [{id: 'v3-subgraph'} as V3PoolInfo]
      );
      v3DirectPoolDiscoverer = makeDiscoverer<V3PoolInfo>(
        [],
        [{id: 'v3-direct'} as V3PoolInfo]
      );
      poolDiscoverer = new PoolDiscoverer(
        v2PoolDiscoverer,
        v3PoolDiscoverer,
        v4PoolDiscoverer,
        v2DirectPoolDiscoverer,
        v3DirectPoolDiscoverer,
        v4DirectPoolDiscoverer
      );
      const selector = makeSelector();

      const result = await poolDiscoverer.getPoolsForTokens(
        ChainId.MAINNET,
        Protocol.V3,
        TOKEN_IN,
        TOKEN_OUT,
        selector,
        undefined,
        false,
        ctx
      );

      expect(v3PoolDiscoverer.getPoolsForTokens).toHaveBeenCalledWith(
        ChainId.MAINNET,
        Protocol.V3,
        TOKEN_IN,
        TOKEN_OUT,
        expect.any(Object),
        undefined,
        false,
        ctx,
        undefined
      );
      expect(v3DirectPoolDiscoverer.getPoolsForTokens).toHaveBeenCalled();
      expect(result).toEqual(
        expect.arrayContaining([{id: 'v3-subgraph'}, {id: 'v3-direct'}])
      );
    });

    it('should call v4PoolDiscoverer and v4DirectPoolDiscoverer for Protocol.V4', async () => {
      v4PoolDiscoverer = makeDiscoverer<V4PoolInfo>(
        [],
        [{id: 'v4-subgraph'} as V4PoolInfo]
      );
      v4DirectPoolDiscoverer = makeDiscoverer<V4PoolInfo>(
        [],
        [{id: 'v4-direct'} as V4PoolInfo]
      );
      poolDiscoverer = new PoolDiscoverer(
        v2PoolDiscoverer,
        v3PoolDiscoverer,
        v4PoolDiscoverer,
        v2DirectPoolDiscoverer,
        v3DirectPoolDiscoverer,
        v4DirectPoolDiscoverer
      );
      const selector = makeSelector();

      const result = await poolDiscoverer.getPoolsForTokens(
        ChainId.MAINNET,
        Protocol.V4,
        TOKEN_IN,
        TOKEN_OUT,
        selector,
        HooksOptions.HOOKS_INCLUSIVE,
        false,
        ctx
      );

      expect(v4PoolDiscoverer.getPoolsForTokens).toHaveBeenCalledWith(
        ChainId.MAINNET,
        Protocol.V4,
        TOKEN_IN,
        TOKEN_OUT,
        expect.any(Object),
        HooksOptions.HOOKS_INCLUSIVE,
        false,
        ctx,
        undefined
      );
      expect(v4DirectPoolDiscoverer.getPoolsForTokens).toHaveBeenCalled();
      expect(result).toEqual(
        expect.arrayContaining([{id: 'v4-subgraph'}, {id: 'v4-direct'}])
      );
    });

    it('should skip v4DirectPoolDiscoverer when hooksOptions is HOOKS_ONLY', async () => {
      const selector = makeSelector();

      await poolDiscoverer.getPoolsForTokens(
        ChainId.MAINNET,
        Protocol.V4,
        TOKEN_IN,
        TOKEN_OUT,
        selector,
        HooksOptions.HOOKS_ONLY,
        false,
        ctx
      );

      expect(v4PoolDiscoverer.getPoolsForTokens).toHaveBeenCalled();
      expect(v4DirectPoolDiscoverer.getPoolsForTokens).not.toHaveBeenCalled();
    });

    it('should throw for external protocol', async () => {
      const selector = makeSelector();

      await expect(
        poolDiscoverer.getPoolsForTokens(
          ChainId.MAINNET,
          Protocol.CURVESTABLESWAPNG,
          TOKEN_IN,
          TOKEN_OUT,
          selector,
          HooksOptions.HOOKS_INCLUSIVE,
          false,
          ctx
        )
      ).rejects.toThrow(`Unsupported protocol ${Protocol.CURVESTABLESWAPNG}`);
    });

    it('should throw for all external protocols', async () => {
      const externalProtocols = [
        Protocol.CURVESTABLESWAPNG,
        Protocol.FLUIDDEXT1,
        Protocol.FLUIDDEXLITE,
        Protocol.FLUIDDEXV2,
        Protocol.CURVESTABLESWAP,
        Protocol.TEMPOEXCHANGE,
      ];
      const selector = makeSelector();

      for (const protocol of externalProtocols) {
        await expect(
          poolDiscoverer.getPoolsForTokens(
            ChainId.MAINNET,
            protocol,
            TOKEN_IN,
            TOKEN_OUT,
            selector,
            undefined,
            false,
            ctx
          )
        ).rejects.toThrow(`Unsupported protocol ${protocol}`);
      }
    });

    it('should deduplicate pools with the same id from subgraph and direct discoverers', async () => {
      const sharedPool = {id: 'shared-pool'} as V4PoolInfo;
      const onlySubgraph = {id: 'subgraph-only'} as V4PoolInfo;
      const onlyDirect = {id: 'direct-only'} as V4PoolInfo;

      v4PoolDiscoverer = makeDiscoverer<V4PoolInfo>(
        [],
        [sharedPool, onlySubgraph]
      );
      v4DirectPoolDiscoverer = makeDiscoverer<V4PoolInfo>(
        [],
        [sharedPool, onlyDirect]
      );
      poolDiscoverer = new PoolDiscoverer(
        v2PoolDiscoverer,
        v3PoolDiscoverer,
        v4PoolDiscoverer,
        v2DirectPoolDiscoverer,
        v3DirectPoolDiscoverer,
        v4DirectPoolDiscoverer
      );
      const selector = makeSelector();

      const result = await poolDiscoverer.getPoolsForTokens(
        ChainId.MAINNET,
        Protocol.V4,
        TOKEN_IN,
        TOKEN_OUT,
        selector,
        HooksOptions.HOOKS_INCLUSIVE,
        false,
        ctx
      );

      expect(result).toHaveLength(3);
      expect(result.map(p => p.id)).toEqual(
        expect.arrayContaining(['shared-pool', 'subgraph-only', 'direct-only'])
      );
    });

    it('should pass through the wrapped selector to the protocol discoverer', async () => {
      const filteredPool = {id: 'filtered-v3'} as V3PoolInfo;
      const unfilteredPool = {id: 'unfiltered-v3'} as V3PoolInfo;

      v3PoolDiscoverer = {
        getPools: vi.fn().mockResolvedValue([]),
        getPoolsForTokens: vi
          .fn()
          .mockImplementation(
            async (_chainId, _protocol, _tIn, _tOut, selector) => {
              // Call the selector passed by PoolDiscoverer to verify it wraps correctly
              const result = await selector.filterPools(
                [filteredPool, unfilteredPool],
                ChainId.MAINNET,
                TOKEN_IN,
                TOKEN_OUT,
                Protocol.V3,
                undefined,
                ctx
              );
              return result;
            }
          ),
      } as unknown as IPoolDiscoverer<V3PoolInfo>;

      poolDiscoverer = new PoolDiscoverer(
        v2PoolDiscoverer,
        v3PoolDiscoverer,
        v4PoolDiscoverer,
        v2DirectPoolDiscoverer,
        v3DirectPoolDiscoverer,
        v4DirectPoolDiscoverer
      );

      // Selector that only keeps 'filtered-v3'
      const selector: ITopPoolsSelector<UniPoolInfo> = {
        filterPools: vi
          .fn()
          .mockImplementation(async (pools: UniPoolInfo[]) =>
            pools.filter(p => p.id === 'filtered-v3')
          ),
      };

      await poolDiscoverer.getPoolsForTokens(
        ChainId.MAINNET,
        Protocol.V3,
        TOKEN_IN,
        TOKEN_OUT,
        selector,
        undefined,
        false,
        ctx
      );

      // The outer selector must have been invoked by the inner wrapper
      expect(selector.filterPools).toHaveBeenCalled();
    });

    it('should throw for unsupported protocol', async () => {
      const protocol = 'unknown' as Protocol;
      const selector = makeSelector();

      await expect(
        poolDiscoverer.getPoolsForTokens(
          ChainId.MAINNET,
          protocol,
          TOKEN_IN,
          TOKEN_OUT,
          selector,
          undefined,
          false,
          ctx
        )
      ).rejects.toThrow(`Unsupported protocol ${protocol}`);
    });
  });
});
