import {describe, it, expect, vi} from 'vitest';
import {ChainId} from '@uniswap/sdk-core';
import {V4SubgraphProvider, V4RawSubgraphPool} from './subgraphProvider';
import {UNISWAP_AGG_HOOK_ON_TEMPO} from '../../util/hooksAddressesAllowlist';
import type {Logger} from '../util/log';
import {IMetric} from '../util/metric';

const CHAIN_ID_TEMPO = 4217 as ChainId;

const mockLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
};

class MockMetric extends IMetric {
  setProperty(_key: string, _value: unknown): void {}
  putDimensions(_dimensions: Record<string, string>): void {}
  putMetric(_key: string, _value: number, _unit?: any, _tags?: Record<string, string>): void {}
}

/** Expose protected mapSubgraphPool for unit testing */
class TestableV4SubgraphProvider extends V4SubgraphProvider {
  public testMapSubgraphPool(rawPool: V4RawSubgraphPool) {
    return this.mapSubgraphPool(rawPool);
  }
}

function createProvider(chainId: ChainId): TestableV4SubgraphProvider {
  return new TestableV4SubgraphProvider(
    chainId,
    1,
    1000,
    false,
    0.01,
    0.001,
    new Set<string>(),
    Number.MAX_VALUE,
    'https://fake-subgraph-url.test/graphql',
    undefined,
    mockLogger,
    new MockMetric()
  );
}

function makeRawPool(overrides: Partial<V4RawSubgraphPool> = {}): V4RawSubgraphPool {
  return {
    id: '0xpool1',
    feeTier: '3000',
    tickSpacing: '60',
    hooks: '0x0000000000000000000000000000000000000000',
    liquidity: '0',
    token0: {symbol: 'WETH', id: '0xtoken0', name: 'Wrapped Ether', decimals: '18'},
    token1: {symbol: 'USDC', id: '0xtoken1', name: 'USD Coin', decimals: '6'},
    totalValueLockedUSD: '50000',
    totalValueLockedETH: '12.5',
    totalValueLockedUSDUntracked: '0',
    ...overrides,
  };
}

describe('V4SubgraphProvider mapSubgraphPool — Tempo agg hook liquidity override', () => {
  it('overrides liquidity with ethTVL for Tempo agg hook pools', () => {
    const provider = createProvider(CHAIN_ID_TEMPO);
    const rawPool = makeRawPool({
      hooks: UNISWAP_AGG_HOOK_ON_TEMPO,
      liquidity: '0',
      totalValueLockedETH: '12.5',
    });

    const mapped = provider.testMapSubgraphPool(rawPool);
    expect(mapped.liquidity).toBe('12.5');
  });

  it('overrides liquidity with ethTVL when hook address has different casing', () => {
    const provider = createProvider(CHAIN_ID_TEMPO);
    const rawPool = makeRawPool({
      hooks: UNISWAP_AGG_HOOK_ON_TEMPO.toUpperCase(),
      liquidity: '0',
      totalValueLockedETH: '8.3',
    });

    const mapped = provider.testMapSubgraphPool(rawPool);
    expect(mapped.liquidity).toBe('8.3');
  });

  it('does NOT override liquidity for Tempo pools with a different hook', () => {
    const provider = createProvider(CHAIN_ID_TEMPO);
    const rawPool = makeRawPool({
      hooks: '0x0000000000000000000000000000000000000000',
      liquidity: '0',
      totalValueLockedETH: '12.5',
    });

    const mapped = provider.testMapSubgraphPool(rawPool);
    expect(mapped.liquidity).toBe('0');
  });

  it('does NOT override liquidity for non-Tempo chains even with the same hook address', () => {
    const provider = createProvider(ChainId.MAINNET);
    const rawPool = makeRawPool({
      hooks: UNISWAP_AGG_HOOK_ON_TEMPO,
      liquidity: '0',
      totalValueLockedETH: '12.5',
    });

    const mapped = provider.testMapSubgraphPool(rawPool);
    expect(mapped.liquidity).toBe('0');
  });

  it('preserves original liquidity for normal pools on Tempo', () => {
    const provider = createProvider(CHAIN_ID_TEMPO);
    const rawPool = makeRawPool({
      hooks: '0x0000000000000000000000000000000000000000',
      liquidity: '999999',
      totalValueLockedETH: '5.0',
    });

    const mapped = provider.testMapSubgraphPool(rawPool);
    expect(mapped.liquidity).toBe('999999');
  });

  it('preserves original liquidity for normal pools on other chains', () => {
    const provider = createProvider(ChainId.MAINNET);
    const rawPool = makeRawPool({
      liquidity: '123456',
      totalValueLockedETH: '10.0',
    });

    const mapped = provider.testMapSubgraphPool(rawPool);
    expect(mapped.liquidity).toBe('123456');
  });
});
