import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {ChainId} from '@uniswap/sdk-core';
import type {JsonRpcProvider} from '@ethersproject/providers';

import {
  DynamicZlcaHooksRefresher,
  EnumeratorFactory,
} from './DynamicZlcaHooksRefresher';
import {FactoryHookEnumerator} from './factoryHookEnumerator';
import {TRUSTED_ZLCA_HOOK_FACTORIES_PER_CHAIN} from './trustedZlcaHookFactories';
import {
  getDynamicZlcaHooks,
  resetDynamicZlcaHooksForTest,
} from './dynamicZlcaHooks';
import type {Logger} from '../sor-providers/util/log';

const mockLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
};

const HOOK_A = '0x00000000000000000000000000000000000000c1';

// The static registry ships empty; tests inject entries and restore after.
function withRegistryEntry(chainId: number): void {
  TRUSTED_ZLCA_HOOK_FACTORIES_PER_CHAIN[chainId] = [
    {
      factoryAddress: '0x00000000000000000000000000000000000000f1',
      name: 'test-factory',
      gasOverheadPerHop: 500_000n,
    },
  ];
}

function fakeEnumeratorFactory(
  enumerate: () => Promise<ReadonlyMap<string, bigint>>
): EnumeratorFactory {
  return () => ({enumerate}) as unknown as FactoryHookEnumerator;
}

const providerFactory = () => ({}) as JsonRpcProvider;

describe('DynamicZlcaHooksRefresher', () => {
  beforeEach(() => {
    withRegistryEntry(ChainId.MAINNET);
  });

  afterEach(() => {
    delete TRUSTED_ZLCA_HOOK_FACTORIES_PER_CHAIN[ChainId.MAINNET];
    resetDynamicZlcaHooksForTest();
  });

  it('refreshOnce populates the dynamic store', async () => {
    const refresher = new DynamicZlcaHooksRefresher(
      providerFactory,
      mockLogger,
      undefined,
      60_000,
      1_000,
      fakeEnumeratorFactory(async () => new Map([[HOOK_A, 500_000n]]))
    );

    await refresher.refreshOnce();
    expect(getDynamicZlcaHooks(ChainId.MAINNET)?.get(HOOK_A)).toBe(500_000n);
  });

  it('keeps last-known-good state when a refresh fails', async () => {
    let shouldFail = false;
    const refresher = new DynamicZlcaHooksRefresher(
      providerFactory,
      mockLogger,
      undefined,
      60_000,
      1_000,
      fakeEnumeratorFactory(async () => {
        if (shouldFail) throw new Error('rpc down');
        return new Map([[HOOK_A, 500_000n]]);
      })
    );

    await refresher.refreshOnce();
    shouldFail = true;
    await refresher.refreshOnce(); // must not throw
    expect(getDynamicZlcaHooks(ChainId.MAINNET)?.get(HOOK_A)).toBe(500_000n);
  });

  it('skips chains without an RPC provider', async () => {
    const enumerate = vi.fn(
      async () => new Map([[HOOK_A, 500_000n]]) as ReadonlyMap<string, bigint>
    );
    const refresher = new DynamicZlcaHooksRefresher(
      () => undefined,
      mockLogger,
      undefined,
      60_000,
      1_000,
      fakeEnumeratorFactory(enumerate)
    );

    await refresher.refreshOnce();
    expect(enumerate).not.toHaveBeenCalled();
    expect(getDynamicZlcaHooks(ChainId.MAINNET)).toBeUndefined();
  });

  it('start() runs an immediate refresh and stop() clears the interval', async () => {
    const enumerate = vi.fn(
      async () => new Map([[HOOK_A, 500_000n]]) as ReadonlyMap<string, bigint>
    );
    const refresher = new DynamicZlcaHooksRefresher(
      providerFactory,
      mockLogger,
      undefined,
      60_000,
      1_000,
      fakeEnumeratorFactory(enumerate)
    );

    void refresher.start();
    void refresher.start(); // idempotent
    await vi.waitFor(() => {
      expect(getDynamicZlcaHooks(ChainId.MAINNET)?.get(HOOK_A)).toBe(500_000n);
    });
    expect(enumerate).toHaveBeenCalledTimes(1);
    refresher.stop();
  });
});

describe('DynamicZlcaHooksRefresher concurrency and boot readiness', () => {
  beforeEach(() => {
    withRegistryEntry(ChainId.MAINNET);
  });

  afterEach(() => {
    delete TRUSTED_ZLCA_HOOK_FACTORIES_PER_CHAIN[ChainId.MAINNET];
    resetDynamicZlcaHooksForTest();
  });

  it('start() returns the initial refresh promise (awaitable readiness)', async () => {
    const refresher = new DynamicZlcaHooksRefresher(
      providerFactory,
      mockLogger,
      undefined,
      60_000,
      1_000,
      fakeEnumeratorFactory(async () => new Map([[HOOK_A, 500_000n]]))
    );
    await refresher.start();
    expect(getDynamicZlcaHooks(ChainId.MAINNET)?.get(HOOK_A)).toBe(500_000n);
    refresher.stop();
  });

  it('skips a tick while a refresh is in flight', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => (release = resolve));
    const refresher = new DynamicZlcaHooksRefresher(
      providerFactory,
      mockLogger,
      undefined,
      60_000,
      5_000,
      fakeEnumeratorFactory(async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await gate;
        concurrent -= 1;
        return new Map([[HOOK_A, 500_000n]]);
      })
    );

    const first = refresher.refreshOnce();
    const second = refresher.refreshOnce(); // must be a no-op
    release();
    await Promise.all([first, second]);
    expect(maxConcurrent).toBe(1);
  });
});
