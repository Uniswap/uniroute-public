import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {Protocol} from '@uniswap/router-sdk';

import {
  AURORA_SUPPORTED_TARGETS,
  AuroraSourcedProvider,
  AuroraV4PoolsProvider,
  auroraPoolsSourceConfigFromEnv,
  computePoolParity,
  impliedOneHopTvlUsd,
  resetAuroraPoolCountBaselinesForTesting,
  resolveAuroraMode,
  targetKey,
} from './auroraPoolsSource';
import {getTvlBypassHookAddresses} from './util/hooksAddressesAllowlist';
import {
  ISubgraphProvider,
  V3SubgraphPool,
  V4SubgraphPool,
} from './sor-providers';
import {Logger} from './sor-providers/util/log';
import {IMetric, MetricLoggerUnit} from './sor-providers/util/metric';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  fatal: () => {},
};

class FakeMetric extends IMetric {
  readonly emitted: Array<{
    key: string;
    value: number;
    tags?: Record<string, string>;
  }> = [];

  putDimensions(): void {}
  putProperties(): void {}
  putMetric(
    key: string,
    value: number,
    _unit?: MetricLoggerUnit,
    tags?: Record<string, string>
  ): void {
    this.emitted.push({key, value, tags});
  }
  setProperty(): void {}

  byKey(key: string) {
    return this.emitted.filter(m => m.key === key);
  }
}

function fakeProvider<TPool>(
  responses: Array<TPool[] | Error>
): ISubgraphProvider<TPool> & {calls: number} {
  let call = 0;
  return {
    get calls() {
      return call;
    },
    async getPools(): Promise<TPool[]> {
      const response = responses[Math.min(call, responses.length - 1)];
      call++;
      if (response instanceof Error) throw response;
      return response as TPool[];
    },
  };
}

function v3Pool(id: string, tvlUSD: number): V3SubgraphPool {
  return {
    id,
    feeTier: '3000',
    liquidity: '1',
    token0: {id: '0xa'},
    token1: {id: '0xb'},
    tvlETH: tvlUSD / 2000,
    tvlUSD,
  };
}

describe('auroraPoolsSourceConfigFromEnv', () => {
  const ENV_KEYS = [
    'POOL_CACHING_AURORA_SHADOW_TARGETS',
    'POOL_CACHING_AURORA_PRIMARY_TARGETS',
    'POOL_CACHING_AURORA_MIN_POOL_COUNT_RATIO',
  ];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('returns undefined when no targets are set', () => {
    expect(auroraPoolsSourceConfigFromEnv()).toBeUndefined();
  });

  it('parses comma-separated targets case-insensitively', () => {
    process.env.POOL_CACHING_AURORA_SHADOW_TARGETS = '1:v3, 8453:V4';
    const config = auroraPoolsSourceConfigFromEnv()!;
    expect(resolveAuroraMode(config, 1, Protocol.V3)).toBe('shadow');
    expect(resolveAuroraMode(config, 8453, Protocol.V4)).toBe('shadow');
    expect(resolveAuroraMode(config, 1, Protocol.V2)).toBeUndefined();
  });

  it('supports the * wildcard and primary-over-shadow precedence', () => {
    process.env.POOL_CACHING_AURORA_SHADOW_TARGETS = '*';
    process.env.POOL_CACHING_AURORA_PRIMARY_TARGETS = '4663:V4';
    const config = auroraPoolsSourceConfigFromEnv()!;
    expect(resolveAuroraMode(config, 4663, Protocol.V4)).toBe('primary');
    expect(resolveAuroraMode(config, 1, Protocol.V3)).toBe('shadow');
  });

  it('clamps a bad ratio to the 0.5 default', () => {
    process.env.POOL_CACHING_AURORA_PRIMARY_TARGETS = '1:V3';
    process.env.POOL_CACHING_AURORA_MIN_POOL_COUNT_RATIO = '7';
    expect(auroraPoolsSourceConfigFromEnv()!.minPoolCountRatio).toBe(0.5);
  });
});

describe('computePoolParity', () => {
  it('computes counts, jaccard, top-100 missing, and tvl drift', () => {
    const subgraph = [
      v3Pool('0xA1', 1000),
      v3Pool('0xa2', 500),
      v3Pool('0xa3', 10),
    ];
    const aurora = [
      v3Pool('0xa1', 1100),
      v3Pool('0xA2', 500),
      v3Pool('0xa4', 5),
    ];

    const parity = computePoolParity(subgraph, aurora);
    expect(parity.subgraphCount).toBe(3);
    expect(parity.auroraCount).toBe(3);
    // intersection {a1, a2} = 2, union = 4
    expect(parity.jaccardBps).toBe(5000);
    expect(parity.missingTop100).toBe(1); // a3
    expect(parity.missingInAurora).toBe(1); // a3
    expect(parity.extraInAurora).toBe(1); // a4
    // drifts: a1 = 10% = 1000bps, a2 = 0 → p50 = 1000 (upper median)
    expect(parity.tvlDriftBpsP50).toBe(1000);
    // Diagnostic samples: what's missing/extra by id, and the matched pools
    // AT the median drift (sample starts at the median, ascending).
    expect(parity.missingSample).toEqual(['0xa3']);
    expect(parity.extraSample).toEqual(['0xa4']);
    expect(parity.driftSample).toEqual(['0xa1:1000.00:1100.00']);
  });

  it('handles empty results', () => {
    const parity = computePoolParity([], []);
    expect(parity.jaccardBps).toBe(0);
    expect(parity.missingTop100).toBe(0);
  });
});

describe('AuroraSourcedProvider primary mode', () => {
  beforeEach(() => {
    resetAuroraPoolCountBaselinesForTesting();
  });

  const mk = (
    aurora: ISubgraphProvider<V3SubgraphPool>,
    subgraph: ISubgraphProvider<V3SubgraphPool>,
    metric: FakeMetric
  ) =>
    new AuroraSourcedProvider(
      'primary',
      aurora,
      subgraph,
      1,
      Protocol.V3,
      0.5,
      noopLogger,
      metric
    );

  it('serves Aurora pools and does not call the subgraph', async () => {
    const aurora = fakeProvider([[v3Pool('0x1', 100), v3Pool('0x2', 50)]]);
    const subgraph = fakeProvider<V3SubgraphPool>([[v3Pool('0x9', 1)]]);
    const metric = new FakeMetric();

    const pools = await mk(aurora, subgraph, metric).getPools();
    expect(pools.map(p => p.id)).toEqual(['0x1', '0x2']);
    expect(subgraph.calls).toBe(0);
    expect(metric.byKey('CachePools.aurora.served')).toHaveLength(1);
  });

  it('falls back to the subgraph on Aurora error', async () => {
    const aurora = fakeProvider<V3SubgraphPool>([new Error('boom')]);
    const subgraph = fakeProvider([[v3Pool('0x9', 1)]]);
    const metric = new FakeMetric();

    const pools = await mk(aurora, subgraph, metric).getPools();
    expect(pools.map(p => p.id)).toEqual(['0x9']);
    expect(metric.byKey('CachePools.aurora.fallback')[0]!.tags?.reason).toBe(
      'error'
    );
  });

  it('falls back on empty Aurora result', async () => {
    const aurora = fakeProvider<V3SubgraphPool>([[]]);
    const subgraph = fakeProvider([[v3Pool('0x9', 1)]]);
    const metric = new FakeMetric();

    const pools = await mk(aurora, subgraph, metric).getPools();
    expect(pools.map(p => p.id)).toEqual(['0x9']);
    expect(metric.byKey('CachePools.aurora.fallback')[0]!.tags?.reason).toBe(
      'empty'
    );
  });

  it('falls back when the pool count collapses below the ratio', async () => {
    const tenPools = Array.from({length: 10}, (_, i) => v3Pool(`0x${i}`, 10));
    const aurora = fakeProvider([tenPools, [v3Pool('0x1', 10)]]);
    const subgraph = fakeProvider([[v3Pool('0x9', 1)]]);
    const metric = new FakeMetric();
    const provider = mk(aurora, subgraph, metric);

    expect(await provider.getPools()).toHaveLength(10); // baseline
    const second = await provider.getPools(); // 1 < 0.5 * 10 → fallback
    expect(second.map(p => p.id)).toEqual(['0x9']);
    expect(metric.byKey('CachePools.aurora.fallback')[0]!.tags?.reason).toBe(
      'low_count'
    );
  });

  it('shares the collapse baseline across provider instances (cron re-wires each run)', async () => {
    const tenPools = Array.from({length: 10}, (_, i) => v3Pool(`0x${i}`, 10));
    const metric = new FakeMetric();

    // Run 1: fresh provider instance establishes the baseline.
    const first = mk(
      fakeProvider([tenPools]),
      fakeProvider<V3SubgraphPool>([[v3Pool('0x9', 1)]]),
      metric
    );
    expect(await first.getPools()).toHaveLength(10);

    // Run 2: a DIFFERENT instance (as cacheAllPools rebuilds providers every
    // tick) must still see run 1's baseline and reject the collapsed result.
    const second = mk(
      fakeProvider([[v3Pool('0x1', 10)]]),
      fakeProvider([[v3Pool('0x9', 1)]]),
      metric
    );
    const pools = await second.getPools();
    expect(pools.map(p => p.id)).toEqual(['0x9']);
    expect(metric.byKey('CachePools.aurora.fallback')[0]!.tags?.reason).toBe(
      'low_count'
    );
  });
});

describe('AuroraSourcedProvider shadow mode', () => {
  const mk = (
    aurora: ISubgraphProvider<V3SubgraphPool>,
    subgraph: ISubgraphProvider<V3SubgraphPool>,
    metric: FakeMetric
  ) =>
    new AuroraSourcedProvider(
      'shadow',
      aurora,
      subgraph,
      1,
      Protocol.V3,
      0.5,
      noopLogger,
      metric
    );

  it('returns the subgraph result and emits parity metrics', async () => {
    const aurora = fakeProvider([[v3Pool('0x1', 100)]]);
    const subgraph = fakeProvider([[v3Pool('0x1', 100), v3Pool('0x2', 50)]]);
    const metric = new FakeMetric();

    const pools = await mk(aurora, subgraph, metric).getPools();
    expect(pools).toHaveLength(2);
    expect(metric.byKey('CachePools.parity.subgraph_count')[0]!.value).toBe(2);
    expect(metric.byKey('CachePools.parity.aurora_count')[0]!.value).toBe(1);
    expect(metric.byKey('CachePools.parity.jaccard_bps')[0]!.value).toBe(5000);
  });

  it('still returns the subgraph result when the Aurora fetch fails', async () => {
    const aurora = fakeProvider<V3SubgraphPool>([new Error('boom')]);
    const subgraph = fakeProvider([[v3Pool('0x2', 50)]]);
    const metric = new FakeMetric();

    const pools = await mk(aurora, subgraph, metric).getPools();
    expect(pools.map(p => p.id)).toEqual(['0x2']);
    expect(metric.byKey('CachePools.aurora.shadow_error')).toHaveLength(1);
    expect(metric.byKey('CachePools.parity.subgraph_count')).toHaveLength(0);
  });
});

describe('AuroraV4PoolsProvider', () => {
  const ROBINHOOD = 4663;
  const ROBINHOOD_WRAPPED_NATIVE_KEY =
    '4663_0x0bd7d308f8e1639fab988df18a8011f41eacad73';

  function v4Row(
    overrides: Partial<{
      poolId: string;
      token0Address: string;
      liquidity: string;
      tvlUsd: number;
      hooksAddress: string | null;
      token1Decimals: number | null;
      sqrtPriceX96: string;
      tvlToken0: string;
      tvlToken1: string;
      token0PriceUsd: number | null;
      token1PriceUsd: number | null;
    }>
  ) {
    return {
      poolId: overrides.poolId ?? '0xABCD',
      token0Address:
        overrides.token0Address ?? '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      token1Address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      feeBips: 3000,
      tickSpacing: 60,
      hooksAddress:
        overrides.hooksAddress !== undefined ? overrides.hooksAddress : null,
      liquidity: overrides.liquidity ?? '42',
      tvlUsd: overrides.tvlUsd ?? 4000,
      // sqrtPrice 0 disables implied one-hop pricing so pre-existing
      // admission tests exercise the SQL-TVL path unchanged.
      sqrtPriceX96: overrides.sqrtPriceX96 ?? '0',
      tvlToken0: overrides.tvlToken0 ?? '0',
      tvlToken1: overrides.tvlToken1 ?? '0',
      token0PriceUsd:
        overrides.token0PriceUsd !== undefined
          ? overrides.token0PriceUsd
          : null,
      token1PriceUsd:
        overrides.token1PriceUsd !== undefined
          ? overrides.token1PriceUsd
          : null,
      token0Decimals: 18,
      token1Decimals:
        overrides.token1Decimals !== undefined ? overrides.token1Decimals : 6,
      token0Symbol: 'WETH',
      token1Symbol: 'USDC',
      token0Name: 'Wrapped Ether',
      token1Name: 'USD Coin',
      stateAsOfTimestamp: new Date(),
    };
  }

  function freshPrices(priceUsd = 2000) {
    return {
      batchGet: async () =>
        new Map([
          [
            ROBINHOOD_WRAPPED_NATIVE_KEY,
            {
              chainId: ROBINHOOD,
              tokenAddress: undefined as never,
              priceUsd,
              timestamp: new Date(),
              updatedAt: new Date(),
            },
          ],
        ]),
    };
  }

  it('replicates the subgraph admission union (threshold / high-liquidity band / bypass hooks)', async () => {
    // Native price 2000 → tvlETH = tvlUsd / 2000.
    const bypassHook = [...getTvlBypassHookAddresses(ROBINHOOD)!][0]!;
    const rows = [
      // (a) above tracked threshold (0.01 ETH = $20): kept
      v4Row({poolId: '0xa1', tvlUsd: 4000, liquidity: '42'}),
      // (b) high-liquidity band [0.001, 0.01) ETH = [$2, $20): kept
      v4Row({poolId: '0xa2', tvlUsd: 10, liquidity: '1'}),
      // liquidity=0 in the same band: dropped (fails both (a) and (b))
      v4Row({poolId: '0xa3', tvlUsd: 10, liquidity: '0'}),
      // below V4_MIN_TVL_ETH with liquidity: dropped
      v4Row({poolId: '0xa4', tvlUsd: 1, liquidity: '9'}),
      // (c) zero-TVL pool under a REAL Robinhood TVL-bypass hook: kept
      v4Row({
        poolId: '0xa5',
        tvlUsd: 0,
        liquidity: '0',
        hooksAddress: bypassHook,
      }),
    ];
    let capturedMinTvlUsd: number | undefined;
    const provider = new AuroraV4PoolsProvider(ROBINHOOD, 0.01, {
      routablePools: {
        listAllV4PoolKeys: async () => [],
        listAllV4RoutablePools: async (_ctx, options) => {
          capturedMinTvlUsd = options.minTvlUsd;
          return rows;
        },
      },
      prices: freshPrices(),
      logger: noopLogger,
      metric: new FakeMetric(),
    });

    const pools = await provider.getPools();
    expect(capturedMinTvlUsd).toBe(0); // full set fetched, union applied in TS
    expect(pools.map(p => p.id).sort()).toEqual(['0xa1', '0xa2', '0xa5']);
  });

  it('admits a launchpad-shaped pool via implied one-hop pricing of the unpriced side', async () => {
    // Robinhood wrapped native (a designated implied-price source) is token0,
    // priced $2000; token1 is a fresh launchpad token with NO price row.
    // Quote side holds only $1 (tvlUsd from SQL) — without implied pricing
    // this pool computes 0.0005 ETH, below the 0.001 floor, and drops (the
    // 27%-jaccard dev-shadow gap). Spot: 1 token0 = 1e6 token1 (both 18dec)
    // → sqrtPriceX96 = 1000 × 2^96. Token1 reserve 5000 → implied
    // 5000 × ($2000/1e6) = $10 → total $11 = 0.0055 ETH → admitted (band b).
    const metric = new FakeMetric();
    const launchpadPool = v4Row({
      poolId: '0xf1',
      token0Address: '0x0bd7D308f8E1639FAb988DF18a8011F41eACAd73',
      tvlUsd: 1,
      liquidity: '1',
      token0PriceUsd: 2000,
      token1PriceUsd: null,
      sqrtPriceX96: '79228162514264337593543950336000',
      tvlToken1: '5000000000000000000000',
      token1Decimals: 18,
    });
    // Same shape, but the priced side is NOT a designated quote asset
    // (default mainnet-WETH address) — implied pricing must not apply, so
    // the pool stays below the floor and drops.
    const memePricedPool = v4Row({
      ...launchpadPool,
      poolId: '0xf2',
      token0Address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    });
    // Already admitted on SQL TVL alone ($4000) AND gets a top-up: kept, but
    // must NOT count toward implied_priced — the metric counts admission
    // FLIPS only, so the shadow readout is comparable to the missing-pool gap.
    const alreadyAdmittedPool = v4Row({
      ...launchpadPool,
      poolId: '0xf3',
      tvlUsd: 4000,
    });
    const provider = new AuroraV4PoolsProvider(ROBINHOOD, 0.01, {
      routablePools: {
        listAllV4PoolKeys: async () => [],
        listAllV4RoutablePools: async () => [
          launchpadPool,
          memePricedPool,
          alreadyAdmittedPool,
        ],
      },
      prices: freshPrices(),
      logger: noopLogger,
      metric,
    });

    const pools = await provider.getPools();
    expect(pools.map(p => p.id).sort()).toEqual(['0xf1', '0xf3']);
    const rescued = pools.find(p => p.id === '0xf1')!;
    expect(rescued.tvlUSD).toBeCloseTo(11, 6);
    expect(rescued.tvlETH).toBeCloseTo(11 / 2000, 9);
    expect(
      metric.emitted.find(m => m.key === 'CachePools.aurora.implied_priced')
        ?.value
    ).toBe(1); // only 0xf1 flipped; 0xf3's top-up fired without flipping
  });

  it('caps the implied top-up so spot-derived phantom TVL cannot dominate ranking', async () => {
    // Junk-shaped pool: allowlisted quote side (wrapped native) holds $1, but
    // an attacker-chosen spot × a huge donated token reserve implies ~$2B.
    // Cap = 1 ETH × $2000 = $2000 → pool is ADMITTED (cap ≫ floors) but its
    // ranking TVL is bounded at base + cap, not the phantom two billion.
    const metric = new FakeMetric();
    const junkPool = v4Row({
      poolId: '0xf9',
      token0Address: '0x0bd7D308f8E1639FAb988DF18a8011F41eACAd73',
      tvlUsd: 1,
      liquidity: '1',
      token0PriceUsd: 2000,
      token1PriceUsd: null,
      // spot: 1 token0 = 1e6 token1 → implied token1 price $0.002
      sqrtPriceX96: '79228162514264337593543950336000',
      // 1e12 token1 in reserve → raw implied 1e12 × $0.002 = $2e9
      tvlToken1: '1000000000000000000000000000000',
      token1Decimals: 18,
    });
    const provider = new AuroraV4PoolsProvider(ROBINHOOD, 0.01, {
      routablePools: {
        listAllV4PoolKeys: async () => [],
        listAllV4RoutablePools: async () => [junkPool],
      },
      prices: freshPrices(),
      logger: noopLogger,
      metric,
    });

    const pools = await provider.getPools();
    expect(pools).toHaveLength(1);
    // base $1 + capped top-up (1 ETH × $2000) = $2001, not $2,000,000,001
    expect(pools[0]!.tvlUSD).toBeCloseTo(2001, 3);
    expect(pools[0]!.tvlETH).toBeCloseTo(2001 / 2000, 6);
    expect(
      metric.emitted.find(m => m.key === 'CachePools.aurora.implied_capped')
        ?.value
    ).toBe(1);
  });

  it('impliedOneHopTvlUsd: direction, gating, and guard edge cases', () => {
    const sources = new Set(['0x0bd7d308f8e1639fab988df18a8011f41eacad73']);
    const base = v4Row({
      token0Address: '0x0bd7D308f8E1639FAb988DF18a8011F41eACAd73',
      token1Decimals: 18,
    });

    // token0 priced, token1 implied: 1 token0 = 4 token1 → sqrtP = 2×2^96.
    // 100 token1 in reserve at $2000/4 each → $50,000.
    const forward = {
      ...base,
      token0PriceUsd: 2000,
      token1PriceUsd: null,
      sqrtPriceX96: '158456325028528675187087900672',
      tvlToken1: '100000000000000000000',
    };
    expect(impliedOneHopTvlUsd(forward, sources)).toBeCloseTo(50000, 6);

    // token1 priced, token0 implied (reverse direction): same spot, token1
    // worth $1 → 1 token0 = 4 token1 = $4; 100 token0 in reserve → $400.
    const reverseSources = new Set([
      base.token1Address.toLowerCase(), // token1 is the quote asset here
    ]);
    const reverse = {
      ...base,
      token0PriceUsd: null,
      token1PriceUsd: 1,
      sqrtPriceX96: '158456325028528675187087900672',
      tvlToken0: '100000000000000000000',
    };
    expect(impliedOneHopTvlUsd(reverse, reverseSources)).toBeCloseTo(400, 6);

    // Decimals adjustment: token1 has 6 decimals; spot raw token1-per-token0
    // = 4e-12 (sqrtP = 2e-6×2^96) → human price 1 token0 = 4 token1.
    // 100 human token1 (1e8 raw) at $2000/4 → $50,000.
    const mixedDecimals = {
      ...base,
      token0PriceUsd: 2000,
      token1PriceUsd: null,
      token1Decimals: 6,
      sqrtPriceX96: '158456325028528675187088',
      tvlToken1: '100000000',
    };
    const mixed = impliedOneHopTvlUsd(mixedDecimals, sources);
    expect(Math.abs(mixed - 50000) / 50000).toBeLessThan(1e-6);

    // Guards: both sides priced / neither priced / zero spot / non-source
    // priced side / missing decimals — all contribute nothing.
    expect(impliedOneHopTvlUsd({...forward, token1PriceUsd: 3}, sources)).toBe(
      0
    );
    expect(
      impliedOneHopTvlUsd({...forward, token0PriceUsd: null}, sources)
    ).toBe(0);
    expect(impliedOneHopTvlUsd({...forward, sqrtPriceX96: '0'}, sources)).toBe(
      0
    );
    expect(impliedOneHopTvlUsd(forward, new Set(['0xother']))).toBe(0);
    expect(impliedOneHopTvlUsd(forward, undefined)).toBe(0);
    expect(
      impliedOneHopTvlUsd({...forward, token1Decimals: null}, sources)
    ).toBe(0);
  });

  it('rejects a stale native price', async () => {
    const provider = new AuroraV4PoolsProvider(ROBINHOOD, 0.01, {
      routablePools: {
        listAllV4PoolKeys: async () => [],
        listAllV4RoutablePools: async () => [],
      },
      prices: {
        batchGet: async () =>
          new Map([
            [
              ROBINHOOD_WRAPPED_NATIVE_KEY,
              {
                chainId: ROBINHOOD,
                tokenAddress: undefined as never,
                priceUsd: 2000,
                timestamp: new Date(Date.now() - 25 * 60 * 60 * 1000), // 25h old
                updatedAt: new Date(),
              },
            ],
          ]),
      },
      logger: noopLogger,
      metric: new FakeMetric(),
    });
    await expect(provider.getPools()).rejects.toThrow(/[Ss]tale native/);
  });

  it('maps rows to V4SubgraphPool shape, lowercases ids, drops null decimals', async () => {
    const metric = new FakeMetric();
    const provider = new AuroraV4PoolsProvider(ROBINHOOD, 0.01, {
      routablePools: {
        listAllV4PoolKeys: async () => [],
        listAllV4RoutablePools: async () => [
          {
            poolId: '0xABCD',
            token0Address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
            token1Address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
            feeBips: 3000,
            tickSpacing: 60,
            hooksAddress: '0xFf00000000000000000000000000000000000123',
            liquidity: '42',
            tvlUsd: 4000,
            sqrtPriceX96: '0',
            tvlToken0: '0',
            tvlToken1: '0',
            token0PriceUsd: null,
            token1PriceUsd: null,
            token0Decimals: 18,
            token1Decimals: 6,
            token0Symbol: 'WETH',
            token1Symbol: 'USDC',
            token0Name: 'Wrapped Ether',
            token1Name: 'USD Coin',
            stateAsOfTimestamp: new Date(),
          },
          {
            poolId: '0xDEAD',
            token0Address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
            token1Address: '0x0000000000000000000000000000000000000001',
            feeBips: 500,
            tickSpacing: 10,
            hooksAddress: null,
            liquidity: '1',
            tvlUsd: 100,
            sqrtPriceX96: '0',
            tvlToken0: '0',
            tvlToken1: '0',
            token0PriceUsd: null,
            token1PriceUsd: null,
            token0Decimals: 18,
            token1Decimals: null, // unknown token → dropped
            token0Symbol: null,
            token1Symbol: null,
            token0Name: null,
            token1Name: null,
            stateAsOfTimestamp: new Date(),
          },
        ],
      },
      prices: {
        batchGet: async () =>
          new Map([
            [
              ROBINHOOD_WRAPPED_NATIVE_KEY,
              {
                chainId: ROBINHOOD,
                tokenAddress: undefined as never,
                priceUsd: 2000,
                timestamp: new Date(),
                updatedAt: new Date(),
              },
            ],
          ]),
      },
      logger: noopLogger,
      metric,
    });

    const pools: V4SubgraphPool[] = await provider.getPools();
    expect(pools).toHaveLength(1);
    const pool = pools[0]!;
    expect(pool.id).toBe('0xabcd');
    expect(pool.feeTier).toBe('3000');
    expect(pool.tickSpacing).toBe('60');
    expect(pool.hooks).toBe('0xff00000000000000000000000000000000000123');
    expect(pool.token0.id).toBe('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2');
    expect(pool.token0.decimals).toBe('18');
    expect(pool.tvlUSD).toBe(4000);
    expect(pool.tvlETH).toBeCloseTo(2, 6); // 4000 USD / 2000 USD-per-native
    expect(
      metric.byKey('CachePools.aurora.dropped_null_decimals')[0]!.value
    ).toBe(1);
  });

  it('throws when no native price is available (wrapper falls back)', async () => {
    const provider = new AuroraV4PoolsProvider(ROBINHOOD, 0.01, {
      routablePools: {
        listAllV4PoolKeys: async () => [],
        listAllV4RoutablePools: async () => [],
      },
      prices: {batchGet: async () => new Map()},
      logger: noopLogger,
      metric: new FakeMetric(),
    });
    await expect(provider.getPools()).rejects.toThrow(/native token price/);
  });

  it('throws for chains without a known wrapped-native address', async () => {
    const provider = new AuroraV4PoolsProvider(1, 0.01, {
      routablePools: {
        listAllV4PoolKeys: async () => [],
        listAllV4RoutablePools: async () => [],
      },
      prices: {batchGet: async () => new Map()},
      logger: noopLogger,
      metric: new FakeMetric(),
    });
    await expect(provider.getPools()).rejects.toThrow(/wrapped-native/);
  });
});

describe('targetKey', () => {
  it('builds CHAINID:PROTOCOL keys', () => {
    expect(targetKey(8453, Protocol.V4)).toBe('8453:V4');
  });
});

describe('AURORA_SUPPORTED_TARGETS', () => {
  it('is scoped to Robinhood V4 only', () => {
    expect([...AURORA_SUPPORTED_TARGETS]).toEqual(['4663:V4']);
  });
});
