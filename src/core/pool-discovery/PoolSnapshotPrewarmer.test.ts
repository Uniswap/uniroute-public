import {describe, it, expect, vi} from 'vitest';
import {Context} from '@uniswap/lib-uni/context';
import {ChainId} from '../../lib/config';
import {Protocol} from '../../models/pool/Protocol';
import {
  PoolDiscovererByProtocol,
  PoolSnapshotPrewarmer,
} from './PoolSnapshotPrewarmer';
import {BaseCachingPoolDiscoverer} from './BaseCachingPoolDiscoverer';
import {UniPoolInfo} from './interface';

const buildCtx = (): Context =>
  ({
    logger: {debug: vi.fn(), warn: vi.fn(), error: vi.fn()},
    metrics: {count: vi.fn()},
  }) as unknown as Context;

const fakeDiscoverer = (
  prewarm: (chainId: ChainId, protocol: Protocol) => Promise<void>
): BaseCachingPoolDiscoverer<UniPoolInfo> =>
  ({prewarm}) as unknown as BaseCachingPoolDiscoverer<UniPoolInfo>;

describe('PoolSnapshotPrewarmer', () => {
  it('calls prewarm on the registered discoverer for every configured target', async () => {
    const calls: Array<[ChainId, Protocol]> = [];
    const discoverers: PoolDiscovererByProtocol = {
      [Protocol.V3]: fakeDiscoverer(async (chainId, protocol) => {
        calls.push([chainId, protocol]);
      }),
      [Protocol.V4]: fakeDiscoverer(async (chainId, protocol) => {
        calls.push([chainId, protocol]);
      }),
    };
    const prewarmer = new PoolSnapshotPrewarmer(
      [
        {chainId: ChainId.BASE, protocol: Protocol.V3},
        {chainId: ChainId.BASE, protocol: Protocol.V4},
      ],
      discoverers,
      buildCtx(),
      900_000
    );

    await prewarmer.refreshOnce();

    expect(calls).toHaveLength(2);
    expect(calls).toContainEqual([ChainId.BASE, Protocol.V3]);
    expect(calls).toContainEqual([ChainId.BASE, Protocol.V4]);
  });

  it('skips a target whose protocol has no registered discoverer, without failing the pass', async () => {
    const calls: Protocol[] = [];
    const ctx = buildCtx();
    const discoverers: PoolDiscovererByProtocol = {
      [Protocol.V3]: fakeDiscoverer(async (_chainId, protocol) => {
        calls.push(protocol);
      }),
    };
    const prewarmer = new PoolSnapshotPrewarmer(
      [
        {chainId: ChainId.BASE, protocol: Protocol.V4}, // no V4 discoverer registered
        {chainId: ChainId.BASE, protocol: Protocol.V3},
      ],
      discoverers,
      ctx,
      900_000
    );

    await prewarmer.refreshOnce();

    expect(calls).toEqual([Protocol.V3]);
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('no discoverer registered for protocol')
    );
  });

  it('is a no-op with an empty target list', async () => {
    const prewarmer = new PoolSnapshotPrewarmer([], {}, buildCtx(), 900_000);
    await expect(prewarmer.refreshOnce()).resolves.toBeUndefined();
  });

  it('never rejects even if a discoverer violates its fail-open contract (defense in depth)', async () => {
    const ctx = buildCtx();
    const discoverers: PoolDiscovererByProtocol = {
      [Protocol.V3]: fakeDiscoverer(async () => {
        throw new Error(
          'discoverer bug — prewarm() should never actually throw'
        );
      }),
      [Protocol.V4]: fakeDiscoverer(async () => {
        // Confirms one bad target doesn't stop the rest of the pass.
      }),
    };
    const prewarmer = new PoolSnapshotPrewarmer(
      [
        {chainId: ChainId.BASE, protocol: Protocol.V3},
        {chainId: ChainId.BASE, protocol: Protocol.V4},
      ],
      discoverers,
      ctx,
      900_000
    );

    await expect(prewarmer.refreshOnce()).resolves.toBeUndefined();
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('prewarm threw unexpectedly'),
      expect.anything()
    );
  });

  it('skips a tick while a pass is already in flight', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => (release = resolve));
    const discoverers: PoolDiscovererByProtocol = {
      [Protocol.V3]: fakeDiscoverer(async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await gate;
        concurrent -= 1;
      }),
    };
    const prewarmer = new PoolSnapshotPrewarmer(
      [{chainId: ChainId.BASE, protocol: Protocol.V3}],
      discoverers,
      buildCtx(),
      900_000
    );

    const first = prewarmer.refreshOnce();
    const second = prewarmer.refreshOnce(); // must be a no-op
    release();
    await Promise.all([first, second]);
    expect(maxConcurrent).toBe(1);
  });

  it('bounds intra-pass concurrency to the configured limit', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const targets = Array.from({length: 10}, (_, i) => ({
      chainId: (1000 + i) as ChainId,
      protocol: Protocol.V3,
    }));
    const discoverers: PoolDiscovererByProtocol = {
      [Protocol.V3]: fakeDiscoverer(async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise(resolve => setTimeout(resolve, 5));
        concurrent -= 1;
      }),
    };
    const prewarmer = new PoolSnapshotPrewarmer(
      targets,
      discoverers,
      buildCtx(),
      900_000,
      3 // concurrency
    );

    await prewarmer.refreshOnce();
    expect(maxConcurrent).toBeLessThanOrEqual(3);
  });

  it('start() runs an immediate pass and stop() clears the interval', async () => {
    let calls = 0;
    const discoverers: PoolDiscovererByProtocol = {
      [Protocol.V3]: fakeDiscoverer(async () => {
        calls += 1;
      }),
    };
    const prewarmer = new PoolSnapshotPrewarmer(
      [{chainId: ChainId.BASE, protocol: Protocol.V3}],
      discoverers,
      buildCtx(),
      60_000
    );

    await prewarmer.start();
    void prewarmer.start(); // idempotent — must not schedule a second timer
    expect(calls).toBe(1);
    prewarmer.stop();
  });

  it('start() returns the initial pass promise (awaitable boot readiness)', async () => {
    let resolved = false;
    const discoverers: PoolDiscovererByProtocol = {
      [Protocol.V3]: fakeDiscoverer(async () => {
        resolved = true;
      }),
    };
    const prewarmer = new PoolSnapshotPrewarmer(
      [{chainId: ChainId.BASE, protocol: Protocol.V3}],
      discoverers,
      buildCtx(),
      60_000
    );

    await prewarmer.start();
    expect(resolved).toBe(true);
    prewarmer.stop();
  });
});
