import {describe, expect, it, vi} from 'vitest';
import {Context} from '@uniswap/lib-uni/context';
import {IRedisCache} from '@uniswap/lib-cache';
import {ADDRESS_ZERO} from '@uniswap/router-sdk';

import {DirectPoolDiscovererV4} from './DirectPoolDiscoverer';
import {ChainId, getUniRouteTestConfig} from '../../../lib/config';
import {Protocol} from '../../../models/pool/Protocol';
import {Address} from '../../../models/address/Address';
import {V4Pool} from '../../../models/pool/V4Pool';
import {IPoolsRepository} from '../../../stores/pool/IPoolsRepository';
import {FeatureGatedTokensRepository} from '../../../stores/compliance/FeatureGatedTokensRepository';
import {
  IV4PoolKeyRegistry,
  V4RegistryPoolKey,
} from '../../../stores/pool/V4PoolKeyRegistryStore';

const USDC = new Address('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
const SIERRA = new Address('0xbceb5f6877d979ec621ae694da1102cb95691ad3');

interface RecordedCall {
  feeAmounts?: number[];
  tickSpacings?: number[];
  hooks?: string[];
}

// Closure-based fake repository: records the probe-combo arguments and
// returns one synthetic pool per call so the mapping path is exercised.
// `failExplicitCombos` makes the registry-shaped call (explicit fee args)
// reject, mimicking the repository's wholesale Promise.all rejection.
function fakeRepository(failExplicitCombos = false): {
  repository: IPoolsRepository<V4Pool>;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let poolCounter = 0;
  const repository: IPoolsRepository<V4Pool> = {
    getPools: async (
      _ctx,
      _chain,
      tokenIn,
      tokenOut,
      feeAmounts,
      tickSpacings,
      hooks
    ) => {
      calls.push({feeAmounts, tickSpacings, hooks});
      if (failExplicitCombos && feeAmounts !== undefined) {
        throw new Error('registry candidate read failed');
      }
      return [
        new V4Pool(
          tokenIn,
          tokenOut,
          feeAmounts?.[0] ?? 100,
          tickSpacings?.[0] ?? 1,
          hooks?.[0] ?? ADDRESS_ZERO,
          1000n,
          `0xb2bc5c469dc818e9d3f34cae42d4229d89fc5e5e35297158e909aae0db2${(poolCounter++).toString(16).padStart(5, '0')}`,
          1n,
          0n
        ),
      ];
    },
  };
  return {repository, calls};
}

function fakeRegistry(keys: V4RegistryPoolKey[]): IV4PoolKeyRegistry {
  return {
    getPoolKeysForPair: async () => keys,
  };
}

function makeDiscoverer(
  repository: IPoolsRepository<V4Pool>,
  registry?: IV4PoolKeyRegistry
): DirectPoolDiscovererV4 {
  const noopCache = {
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
  } as unknown as IRedisCache<string, string>;
  return new DirectPoolDiscovererV4(
    getUniRouteTestConfig(),
    repository,
    noopCache,
    noopCache,
    {} as FeatureGatedTokensRepository,
    registry
  );
}

function probe(discoverer: DirectPoolDiscovererV4): Promise<unknown[]> {
  const ctx = {
    logger: {debug: vi.fn(), warn: vi.fn(), error: vi.fn()},
    metrics: {count: vi.fn(), dist: vi.fn()},
  } as unknown as Context;
  // _getPoolsForTokens is the uncached probe under test; the public wrapper
  // adds Redis caching and feature gating that are covered elsewhere.
  return (
    discoverer as unknown as {
      _getPoolsForTokens: (
        chainId: ChainId,
        protocol: Protocol,
        tokenIn: Address,
        tokenOut: Address,
        ctx: Context
      ) => Promise<unknown[]>;
    }
  )._getPoolsForTokens(ChainId.MAINNET, Protocol.V4, USDC, SIERRA, ctx);
}

describe('DirectPoolDiscovererV4 PoolKey registry union', () => {
  it('probes the default canonical grid when no registry is wired', async () => {
    const {repository, calls} = fakeRepository();
    await probe(makeDiscoverer(repository));
    expect(calls).toHaveLength(1);
    // No explicit combos: the repository applies its own canonical defaults.
    expect(calls[0]!.feeAmounts).toBeUndefined();
  });

  it('probes the default grid when the registry has nothing for the pair', async () => {
    const {repository, calls} = fakeRepository();
    await probe(makeDiscoverer(repository, fakeRegistry([])));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.feeAmounts).toBeUndefined();
  });

  it('probes registry PoolKeys in a second, isolated repository call', async () => {
    const {repository, calls} = fakeRepository();
    const pools = await probe(
      makeDiscoverer(
        repository,
        fakeRegistry([{fee: 375, tickSpacing: 4, hooks: ADDRESS_ZERO}])
      )
    );
    expect(calls).toHaveLength(2);
    const canonicalCall = calls.find(call => call.feeAmounts === undefined);
    const registryCall = calls.find(call => call.feeAmounts !== undefined);
    expect(canonicalCall).toBeDefined();
    expect(registryCall!.feeAmounts).toEqual([375]);
    expect(registryCall!.tickSpacings).toEqual([4]);
    expect(registryCall!.hooks).toEqual([ADDRESS_ZERO]);
    expect(pools).toHaveLength(2);
  });

  it('keeps canonical results when the registry probe fails', async () => {
    const {repository, calls} = fakeRepository(true);
    const pools = await probe(
      makeDiscoverer(
        repository,
        fakeRegistry([{fee: 375, tickSpacing: 4, hooks: ADDRESS_ZERO}])
      )
    );
    expect(calls).toHaveLength(2);
    expect(pools).toHaveLength(1);
  });

  it('keeps canonical results when the registry lookup itself throws', async () => {
    const {repository} = fakeRepository();
    const throwingRegistry: IV4PoolKeyRegistry = {
      getPoolKeysForPair: async () => {
        throw new Error('registry backend exploded');
      },
    };
    const pools = await probe(makeDiscoverer(repository, throwingRegistry));
    expect(pools).toHaveLength(1);
  });
});
