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
import {EMPTY_NAMESPACE_CONTEXT} from '../../models/hooks/namespaces';

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
        EMPTY_NAMESPACE_CONTEXT,
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
        EMPTY_NAMESPACE_CONTEXT,
        ctx
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
        EMPTY_NAMESPACE_CONTEXT,
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
        EMPTY_NAMESPACE_CONTEXT,
        ctx
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
        EMPTY_NAMESPACE_CONTEXT,
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
        EMPTY_NAMESPACE_CONTEXT,
        ctx
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
        EMPTY_NAMESPACE_CONTEXT,
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
          EMPTY_NAMESPACE_CONTEXT,
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
            EMPTY_NAMESPACE_CONTEXT,
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
        EMPTY_NAMESPACE_CONTEXT,
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
                EMPTY_NAMESPACE_CONTEXT,
                ctx,
                {shouldUseCache: true}
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
        EMPTY_NAMESPACE_CONTEXT,
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
          EMPTY_NAMESPACE_CONTEXT,
          ctx
        )
      ).rejects.toThrow(`Unsupported protocol ${protocol}`);
    });
  });

  describe('parallel direct discovery (POOL_DISCOVERY_PARALLEL_DIRECT_ENABLED)', () => {
    // The flag is read at construction, so each test constructs its own
    // instance after setting the env var.
    const buildDiscoverer = (parallel: boolean) => {
      if (parallel) {
        vi.stubEnv('POOL_DISCOVERY_PARALLEL_DIRECT_ENABLED', 'true');
      } else {
        vi.stubEnv('POOL_DISCOVERY_PARALLEL_DIRECT_ENABLED', 'false');
      }
      const discoverer = new PoolDiscoverer(
        v2PoolDiscoverer,
        v3PoolDiscoverer,
        v4PoolDiscoverer,
        v2DirectPoolDiscoverer,
        v3DirectPoolDiscoverer,
        v4DirectPoolDiscoverer
      );
      vi.unstubAllEnvs();
      return discoverer;
    };

    it.each([Protocol.V2, Protocol.V3, Protocol.V4])(
      'returns identical merged pools with the flag on and off (%s)',
      async protocol => {
        v2PoolDiscoverer = makeDiscoverer<V2PoolInfo>(
          [],
          [{id: 'v2-primary'} as V2PoolInfo]
        );
        v3PoolDiscoverer = makeDiscoverer<V3PoolInfo>(
          [],
          [{id: 'v3-primary'} as V3PoolInfo]
        );
        v4PoolDiscoverer = makeDiscoverer<V4PoolInfo>(
          [],
          [{id: 'v4-primary'} as V4PoolInfo]
        );
        v2DirectPoolDiscoverer = makeDiscoverer<V2PoolInfo>(
          [],
          [{id: 'v2-direct'} as V2PoolInfo]
        );
        v3DirectPoolDiscoverer = makeDiscoverer<V3PoolInfo>(
          [],
          [{id: 'v3-direct'} as V3PoolInfo]
        );
        v4DirectPoolDiscoverer = makeDiscoverer<V4PoolInfo>(
          [],
          [{id: 'v4-direct'} as V4PoolInfo]
        );
        const run = (parallel: boolean) =>
          buildDiscoverer(parallel).getPoolsForTokens(
            ChainId.MAINNET,
            protocol,
            TOKEN_IN,
            TOKEN_OUT,
            makeSelector(),
            undefined,
            false,
            EMPTY_NAMESPACE_CONTEXT,
            ctx
          );
        const sequential = await run(false);
        const parallel = await run(true);
        expect(parallel).toEqual(sequential);
        expect(parallel).toHaveLength(2);
      }
    );

    it('direct pools still override primary pools on id collision', async () => {
      const primaryPool = {id: 'shared', tvlUSD: 1} as unknown as V4PoolInfo;
      const directPool = {id: 'shared', tvlUSD: 2} as unknown as V4PoolInfo;
      v4PoolDiscoverer = makeDiscoverer<V4PoolInfo>([], [primaryPool]);
      v4DirectPoolDiscoverer = makeDiscoverer<V4PoolInfo>([], [directPool]);

      const result = await buildDiscoverer(true).getPoolsForTokens(
        ChainId.MAINNET,
        Protocol.V4,
        TOKEN_IN,
        TOKEN_OUT,
        makeSelector(),
        undefined,
        false,
        EMPTY_NAMESPACE_CONTEXT,
        ctx
      );

      expect(result).toHaveLength(1);
      expect((result[0] as V4PoolInfo).tvlUSD).toBe(2);
    });

    it('still skips the V4 direct probe for HOOKS_ONLY under the flag', async () => {
      await buildDiscoverer(true).getPoolsForTokens(
        ChainId.MAINNET,
        Protocol.V4,
        TOKEN_IN,
        TOKEN_OUT,
        makeSelector(),
        HooksOptions.HOOKS_ONLY,
        false,
        EMPTY_NAMESPACE_CONTEXT,
        ctx
      );
      expect(v4DirectPoolDiscoverer.getPoolsForTokens).not.toHaveBeenCalled();
    });

    it('rethrows the primary error without an unhandled rejection when the pre-started direct probe also fails', async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on('unhandledRejection', onUnhandled);
      try {
        v4PoolDiscoverer.getPoolsForTokens = vi
          .fn()
          .mockRejectedValue(new Error('primary boom'));
        v4DirectPoolDiscoverer.getPoolsForTokens = vi
          .fn()
          .mockRejectedValue(new Error('direct boom'));

        await expect(
          buildDiscoverer(true).getPoolsForTokens(
            ChainId.MAINNET,
            Protocol.V4,
            TOKEN_IN,
            TOKEN_OUT,
            makeSelector(),
            undefined,
            false,
            EMPTY_NAMESPACE_CONTEXT,
            ctx
          )
        ).rejects.toThrow('primary boom');

        // Give the loop a tick so a leaked rejection would surface.
        await new Promise(resolve => setImmediate(resolve));
        expect(unhandled).toHaveLength(0);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    });

    it('rethrows the direct probe error when the primary succeeds', async () => {
      v4DirectPoolDiscoverer.getPoolsForTokens = vi
        .fn()
        .mockRejectedValue(new Error('direct boom'));

      await expect(
        buildDiscoverer(true).getPoolsForTokens(
          ChainId.MAINNET,
          Protocol.V4,
          TOKEN_IN,
          TOKEN_OUT,
          makeSelector(),
          undefined,
          false,
          EMPTY_NAMESPACE_CONTEXT,
          ctx
        )
      ).rejects.toThrow('direct boom');
    });
  });
});
