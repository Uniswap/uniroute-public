import {describe, beforeEach, it, expect, vi} from 'vitest';
import {PoolDiscoverer} from './PoolDiscoverer';
import {ChainId} from '../../lib/config';
import {UniProtocol} from '../../models/pool/UniProtocol';
import {Context} from '@uniswap/lib-uni/context';
import {IPoolDiscoverer, V2PoolInfo, V3PoolInfo, V4PoolInfo} from './interface';

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
    v2PoolDiscoverer = {
      getPools: vi.fn().mockResolvedValue([{id: 'v2-pool'}]),
    } as unknown as IPoolDiscoverer<V2PoolInfo>;

    v3PoolDiscoverer = {
      getPools: vi.fn().mockResolvedValue([{id: 'v3-pool'}]),
    } as unknown as IPoolDiscoverer<V3PoolInfo>;

    v4PoolDiscoverer = {
      getPools: vi.fn().mockResolvedValue([{id: 'v4-pool'}]),
    } as unknown as IPoolDiscoverer<V4PoolInfo>;

    v2DirectPoolDiscoverer = {
      getPools: vi.fn().mockResolvedValue([{id: 'v2-pool'}]),
    } as unknown as IPoolDiscoverer<V2PoolInfo>;

    v3DirectPoolDiscoverer = {
      getPools: vi.fn().mockResolvedValue([{id: 'v3-pool'}]),
    } as unknown as IPoolDiscoverer<V3PoolInfo>;

    v4DirectPoolDiscoverer = {
      getPools: vi.fn().mockResolvedValue([{id: 'v4-pool'}]),
    } as unknown as IPoolDiscoverer<V4PoolInfo>;

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

  it('should delegate to v2PoolDiscoverer for UniProtocol.V2', async () => {
    const chainId = ChainId.MAINNET;
    const protocol = UniProtocol.V2;

    const pools = await poolDiscoverer.getPools(chainId, protocol, ctx);

    expect(pools).toEqual([{id: 'v2-pool'}]);
    expect(v2PoolDiscoverer.getPools).toHaveBeenCalledWith(
      chainId,
      protocol,
      ctx
    );
  });

  it('should delegate to v3PoolDiscoverer for UniProtocol.V3', async () => {
    const chainId = ChainId.MAINNET;
    const protocol = UniProtocol.V3;

    const pools = await poolDiscoverer.getPools(chainId, protocol, ctx);

    expect(pools).toEqual([{id: 'v3-pool'}]);
    expect(v3PoolDiscoverer.getPools).toHaveBeenCalledWith(
      chainId,
      protocol,
      ctx
    );
  });

  it('should delegate to v4PoolDiscoverer for UniProtocol.V4', async () => {
    const chainId = ChainId.MAINNET;
    const protocol = UniProtocol.V4;

    const pools = await poolDiscoverer.getPools(chainId, protocol, ctx);

    expect(pools).toEqual([{id: 'v4-pool'}]);
    expect(v4PoolDiscoverer.getPools).toHaveBeenCalledWith(
      chainId,
      protocol,
      ctx
    );
  });

  it('should throw an error for unsupported protocol', async () => {
    const chainId = ChainId.MAINNET;
    const protocol = 'unsupported-protocol' as UniProtocol;

    await expect(
      poolDiscoverer.getPools(chainId, protocol, ctx)
    ).rejects.toThrow(`Unsupported protocol ${protocol}`);
  });
});
