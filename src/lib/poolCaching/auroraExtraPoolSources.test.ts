import {Protocol} from '@uniswap/router-sdk';
import {ChainId} from '@uniswap/sdk-core';
import {Context} from '@uniswap/lib-uni/context';
import {createAddress, toExtendedChainId} from '@uniswap/lib-data-api';
import {
  canonicalTokenKey,
  type ListV3RoutablePoolsByAddressesOptions,
  type ListV4RoutablePoolsByHooksOptions,
  type RoutablePoolsService,
  type V3RoutablePool,
  type V4RoutablePool,
} from '@uniswap/lib-data-ingestion-aurora';
import {ethers} from 'ethers';
import {beforeEach, describe, expect, it} from 'vitest';

import {
  applyAuroraExtraPoolSources,
  AuroraAggHooksPoolsProvider,
  AuroraEulerSwapPoolsProvider,
  type AuroraExtraSourceDeps,
  type ExtraPoolsCoverage,
  type ExtraSourceChainProtocol,
  AuroraSourcedExtraPoolsProvider,
  AuroraV3PoolIdsProvider,
} from './auroraExtraPoolSources';
import {applyAuroraPoolSources} from './auroraPoolsSource';
import {
  EULER_SWAP_TVL_ETH,
  EULER_SWAP_TVL_USD,
  ExtraPoolSourceName,
  type ExtraPoolsSource,
  MAINNET_V3_MANUAL_POOL_IDS,
  extraSourceKey,
  resetExtraPoolSourceMemoryForTesting,
} from './extraPoolSources';
import {ExtraPoolSourceMemory} from './extraPoolSourceMemory';
import type {
  ISubgraphProvider,
  V3SubgraphPool,
  V4SubgraphPool,
} from './sor-providers';
import type {
  PseudoTvlAmounts,
  PseudoTvlReader,
} from './sor-providers/v4/pseudoTvlReader';
import {Logger} from './sor-providers/util/log';
import {IMetric, MetricLoggerUnit} from './sor-providers/util/metric';
import {EULER_SWAP_HOOKS_BY_CHAIN} from './util/eulerSwapHooksRegistry';

const CHAIN_ID_TEMPO = 4217;
const NATIVE_PRICE_USD = 2500;

class RecordingLogger implements Logger {
  readonly warnings: Array<{msg: string; extra: unknown[]}> = [];
  info(): void {}
  warn(msg: string, ...extra: unknown[]): void {
    this.warnings.push({msg, extra});
  }
  error(): void {}
  debug(): void {}
  fatal(): void {}
}

class FakeMetric extends IMetric {
  readonly emitted: Array<{
    key: string;
    value: number;
    tags?: Record<string, string>;
  }> = [];
  putDimensions(): void {}
  setProperty(): void {}
  putMetric(
    key: string,
    value: number,
    _unit?: MetricLoggerUnit,
    tags?: Record<string, string>
  ): void {
    this.emitted.push({key, value, tags});
  }
  byKey(key: string) {
    return this.emitted.filter(entry => entry.key === key);
  }
}

class FakeRoutablePools implements Pick<
  RoutablePoolsService,
  'listV4RoutablePoolsByHooks' | 'listV3RoutablePoolsByAddresses'
> {
  readonly v4Calls: ListV4RoutablePoolsByHooksOptions[] = [];
  readonly v3Calls: ListV3RoutablePoolsByAddressesOptions[] = [];
  constructor(
    private readonly v4Rows: V4RoutablePool[] | Error = [],
    private readonly v3Rows: V3RoutablePool[] | Error = []
  ) {}
  async listV4RoutablePoolsByHooks(
    _ctx: Context,
    options: ListV4RoutablePoolsByHooksOptions
  ): Promise<V4RoutablePool[]> {
    this.v4Calls.push(options);
    if (this.v4Rows instanceof Error) throw this.v4Rows;
    return this.v4Rows;
  }
  async listV3RoutablePoolsByAddresses(
    _ctx: Context,
    options: ListV3RoutablePoolsByAddressesOptions
  ): Promise<V3RoutablePool[]> {
    this.v3Calls.push(options);
    if (this.v3Rows instanceof Error) throw this.v3Rows;
    return this.v3Rows;
  }
}

class FakePseudoTvlReader implements PseudoTvlReader {
  readonly reads: Array<{hook: string; poolId: string}> = [];
  constructor(
    private readonly byPoolId: ReadonlyMap<string, PseudoTvlAmounts | Error>
  ) {}
  async read(hook: string, poolId: string): Promise<PseudoTvlAmounts> {
    this.reads.push({hook, poolId});
    const result = this.byPoolId.get(poolId);
    if (result === undefined) throw new Error(`no amounts for ${poolId}`);
    if (result instanceof Error) throw result;
    return result;
  }
}

class FakeSource<TPool> implements ExtraPoolsSource<TPool> {
  calls = 0;
  constructor(private readonly result: TPool[] | Error) {}
  async getPools(): Promise<TPool[]> {
    this.calls++;
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

function deps(
  routablePools: FakeRoutablePools,
  metric: FakeMetric,
  logger: Logger = new RecordingLogger(),
  nativeUsdPrice: AuroraExtraSourceDeps['nativeUsdPrice'] = async () =>
    NATIVE_PRICE_USD
): AuroraExtraSourceDeps {
  return {
    routablePools,
    nativeUsdPrice,
    newContext: () => Context.Background(),
    logger,
    metric,
  };
}

// Prod rows (data-ingestion Aurora, read-only lookups): an EulerSwap pool on
// Unichain and the Uniswap aggregator hook's pathUSD/USDC.e pool on Tempo,
// both with nothing locked in the PoolManager, and the mainnet manual
// wstETH/USDC V3 pool.
const UNICHAIN_EULER_ROW: V4RoutablePool = {
  poolId: '0xa6e5e1040a00cca1a74f845400947c416038489542d7195c80b772508d06f22d',
  token0Address: '0x078D782b760474a361dDA0AF3839290b0EF57AD6',
  token1Address: '0x4200000000000000000000000000000000000006',
  feeBips: 500,
  tickSpacing: 1,
  hooksAddress: '0x0222155E00e159A6A12613ee7c7B1021F9F568a8',
  liquidity: '0',
  tvlUsd: 0,
  sqrtPriceX96: '79228162514264337593543950336',
  tvlToken0: '0',
  tvlToken1: '0',
  token0PriceUsd: 1,
  token1PriceUsd: 2500,
  token0Decimals: 6,
  token1Decimals: 18,
  token0Symbol: 'USDC',
  token1Symbol: 'WETH',
  token0Name: 'USD Coin',
  token1Name: 'Wrapped Ether',
  stateAsOfTimestamp: new Date('2026-10-09T00:00:00Z'),
};

const TEMPO_AGG_ROW: V4RoutablePool = {
  poolId: '0x00cdb9b18686cc49430bd3ea24a241633baf4af84029a014f2be22ec5e295588',
  token0Address: '0x20C0000000000000000000000000000000000000',
  token1Address: '0x20C000000000000000000000b9537d11c60E8b50',
  feeBips: 500,
  tickSpacing: 10,
  hooksAddress: '0x7169A78A59f136876e724b648fbb339A42F46888',
  liquidity: '0',
  tvlUsd: 0,
  sqrtPriceX96: '79228162514264337593543950336',
  tvlToken0: '0',
  tvlToken1: '0',
  token0PriceUsd: 1.000050742582467,
  token1PriceUsd: 1,
  token0Decimals: 6,
  token1Decimals: 6,
  token0Symbol: 'pathUSD',
  token1Symbol: 'USDC.e',
  token0Name: 'pathUSD',
  token1Name: 'USDC.e',
  stateAsOfTimestamp: new Date('2026-10-09T00:00:00Z'),
};

const MAINNET_MANUAL_V3_ROW: V3RoutablePool = {
  poolAddress: '0x4622Df6fB2d9Bee0DCDaCF545aCDB6a2b2f4f863',
  token0Address: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0',
  token1Address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  feeTier: 500,
  tickSpacing: 10,
  liquidity: '304277235117237',
  tvlUsd: 12_500,
  sqrtPriceX96: '79228162514264337593543950336',
  tvlToken0: '1192466540624278804',
  tvlToken1: '9250162928',
  token0PriceUsd: 2_700,
  token1PriceUsd: 1,
  token0Decimals: 18,
  token1Decimals: 6,
  token0Symbol: 'wstETH',
  token1Symbol: 'USDC',
  token0Name: 'Wrapped liquid staked Ether 2.0',
  token1Name: 'USD Coin',
  stateAsOfTimestamp: new Date('2026-10-09T00:00:00Z'),
};

beforeEach(() => {
  resetExtraPoolSourceMemoryForTesting();
});

describe('AuroraEulerSwapPoolsProvider', () => {
  it('reads the registry hooks and returns subgraph-shaped pools at the fixed EulerSwap TVL', async () => {
    const routablePools = new FakeRoutablePools([UNICHAIN_EULER_ROW]);
    const hooks = EULER_SWAP_HOOKS_BY_CHAIN.get(ChainId.UNICHAIN) ?? [];
    const pools = await new AuroraEulerSwapPoolsProvider(
      ChainId.UNICHAIN,
      hooks,
      deps(routablePools, new FakeMetric())
    ).getPools();

    expect(routablePools.v4Calls).toEqual([
      {chainId: toExtendedChainId(ChainId.UNICHAIN), hooks},
    ]);
    expect(pools).toEqual([
      {
        id: UNICHAIN_EULER_ROW.poolId,
        feeTier: '500',
        tickSpacing: '1',
        hooks: '0x0222155e00e159a6a12613ee7c7b1021f9f568a8',
        liquidity: '0',
        token0: {
          id: '0x078d782b760474a361dda0af3839290b0ef57ad6',
          symbol: 'USDC',
          name: 'USD Coin',
          decimals: '6',
        },
        token1: {
          id: '0x4200000000000000000000000000000000000006',
          symbol: 'WETH',
          name: 'Wrapped Ether',
          decimals: '18',
        },
        tvlUSD: EULER_SWAP_TVL_USD,
        tvlETH: EULER_SWAP_TVL_ETH,
      },
    ]);
  });

  it('drops a row without token decimals and counts it', async () => {
    const metric = new FakeMetric();
    const pools = await new AuroraEulerSwapPoolsProvider(
      ChainId.UNICHAIN,
      ['0x0222155E00e159A6A12613ee7c7B1021F9F568a8'],
      deps(
        new FakeRoutablePools([{...UNICHAIN_EULER_ROW, token1Decimals: null}]),
        metric
      )
    ).getPools();
    expect(pools).toEqual([]);
    expect(metric.byKey('CachePools.aurora.extra_source_dropped')).toEqual([
      {
        key: 'CachePools.aurora.extra_source_dropped',
        value: 1,
        tags: {source: 'euler_hooks', chainId: '130', reason: 'null_decimals'},
      },
    ]);
  });

  it('rejects when the Aurora read fails', async () => {
    await expect(
      new AuroraEulerSwapPoolsProvider(
        ChainId.UNICHAIN,
        ['0x0222155E00e159A6A12613ee7c7B1021F9F568a8'],
        deps(
          new FakeRoutablePools(new Error('statement timeout')),
          new FakeMetric()
        )
      ).getPools()
    ).rejects.toThrow('statement timeout');
  });
});

describe('AuroraAggHooksPoolsProvider', () => {
  const hookAddresses = ['0x7169a78a59f136876e724b648fbb339a42f46888'];

  it('values the hook-reported amounts at fresh Aurora prices', async () => {
    const reader = new FakePseudoTvlReader(
      new Map([
        [TEMPO_AGG_ROW.poolId, {amount0: 2_000_000n, amount1: 3_000_000n}],
      ])
    );
    const metric = new FakeMetric();
    const pools = await new AuroraAggHooksPoolsProvider(
      CHAIN_ID_TEMPO,
      {hookAddresses, pseudoTvl: reader, externalLiquidityOnly: true},
      deps(new FakeRoutablePools([TEMPO_AGG_ROW]), metric)
    ).getPools();

    const expectedUsd = 2 * 1.000050742582467 + 3 * 1;
    expect(reader.reads).toEqual([
      {
        hook: '0x7169a78a59f136876e724b648fbb339a42f46888',
        poolId: TEMPO_AGG_ROW.poolId,
      },
    ]);
    expect(pools).toHaveLength(1);
    expect(pools[0]?.tvlUSD).toBeCloseTo(expectedUsd, 9);
    expect(pools[0]?.tvlETH).toBeCloseTo(expectedUsd / NATIVE_PRICE_USD, 12);
    expect(pools[0]?.liquidity).toBe('5');
    expect(pools[0]?.isExternalLiquidity).toBe(true);
    expect(pools[0]?.token0.decimals).toBe('6');
    expect(metric.byKey('CachePools.aurora.agg_hooks_pseudo_tvl')).toEqual([
      {
        key: 'CachePools.aurora.agg_hooks_pseudo_tvl',
        value: 1,
        tags: {chainId: '4217', status: 'success'},
      },
    ]);
  });

  it('counts a side without a fresh price as 0, and counts the unpriced side', async () => {
    const reader = new FakePseudoTvlReader(
      new Map([
        [TEMPO_AGG_ROW.poolId, {amount0: 2_000_000n, amount1: 3_000_000n}],
      ])
    );
    const metric = new FakeMetric();
    const pools = await new AuroraAggHooksPoolsProvider(
      CHAIN_ID_TEMPO,
      {hookAddresses, pseudoTvl: reader, externalLiquidityOnly: false},
      deps(
        new FakeRoutablePools([{...TEMPO_AGG_ROW, token0PriceUsd: null}]),
        metric
      )
    ).getPools();
    expect(pools[0]?.tvlUSD).toBe(3);
    expect(metric.byKey('CachePools.aurora.extra_source_degraded')).toEqual([
      {
        key: 'CachePools.aurora.extra_source_degraded',
        value: 1,
        tags: {source: 'agg_hooks', chainId: '4217', reason: 'unpriced_side'},
      },
    ]);
  });

  it('keeps the PoolManager values when every side the hook reports is unpriced', async () => {
    const reader = new FakePseudoTvlReader(
      new Map([
        [TEMPO_AGG_ROW.poolId, {amount0: 2_000_000n, amount1: 3_000_000n}],
      ])
    );
    const metric = new FakeMetric();
    // The prod row with both price rows past the freshness cutoff, and some
    // liquidity in the PoolManager itself.
    const unpricedRow = {
      ...TEMPO_AGG_ROW,
      token0PriceUsd: null,
      token1PriceUsd: null,
      liquidity: '4200',
      tvlUsd: 42,
    };
    const pools = await new AuroraAggHooksPoolsProvider(
      CHAIN_ID_TEMPO,
      {hookAddresses, pseudoTvl: reader, externalLiquidityOnly: true},
      deps(new FakeRoutablePools([unpricedRow]), metric)
    ).getPools();

    expect(pools).toHaveLength(1);
    expect(pools[0]?.liquidity).toBe('4200');
    expect(pools[0]?.tvlUSD).toBe(42);
    expect(pools[0]?.tvlETH).toBeCloseTo(42 / NATIVE_PRICE_USD, 12);
    expect(
      metric
        .byKey('CachePools.aurora.extra_source_degraded')
        .map(entry => [entry.tags?.reason, entry.value])
    ).toEqual([
      ['unpriced_side', 2],
      ['unpriced_pseudo_tvl', 1],
    ]);
  });

  it('drops pools with no external liquidity when only external liquidity counts', async () => {
    const zeroRow = {...TEMPO_AGG_ROW, poolId: '0x' + '11'.repeat(32)};
    const failingRow = {...TEMPO_AGG_ROW, poolId: '0x' + '22'.repeat(32)};
    const reader = new FakePseudoTvlReader(
      new Map<string, PseudoTvlAmounts | Error>([
        [zeroRow.poolId, {amount0: 0n, amount1: 0n}],
        [failingRow.poolId, new Error('execution reverted')],
      ])
    );
    const metric = new FakeMetric();
    const pools = await new AuroraAggHooksPoolsProvider(
      CHAIN_ID_TEMPO,
      {hookAddresses, pseudoTvl: reader, externalLiquidityOnly: true},
      deps(new FakeRoutablePools([zeroRow, failingRow]), metric)
    ).getPools();

    expect(pools).toEqual([]);
    expect(metric.byKey('CachePools.aurora.extra_source_dropped')).toEqual([
      {
        key: 'CachePools.aurora.extra_source_dropped',
        value: 2,
        tags: {
          source: 'agg_hooks',
          chainId: '4217',
          reason: 'pseudo_tvl_unavailable',
        },
      },
    ]);
    expect(
      metric
        .byKey('CachePools.aurora.agg_hooks_pseudo_tvl')
        .map(entry => entry.tags)
    ).toEqual(
      expect.arrayContaining([
        {chainId: '4217', status: 'failure', reason: 'rpc_error'},
      ])
    );
  });

  it('keeps a pool at the PoolManager TVL when the read fails and external liquidity is not required', async () => {
    const pools = await new AuroraAggHooksPoolsProvider(
      ChainId.MAINNET,
      {
        hookAddresses,
        pseudoTvl: new FakePseudoTvlReader(new Map()),
        externalLiquidityOnly: false,
      },
      deps(
        new FakeRoutablePools([
          {...TEMPO_AGG_ROW, liquidity: '42', tvlUsd: 10},
        ]),
        new FakeMetric()
      )
    ).getPools();
    expect(pools).toHaveLength(1);
    expect(pools[0]?.liquidity).toBe('42');
    expect(pools[0]?.tvlUSD).toBe(10);
    expect(pools[0]?.isExternalLiquidity).toBe(false);
  });

  it('rejects when the native price is unavailable', async () => {
    await expect(
      new AuroraAggHooksPoolsProvider(
        CHAIN_ID_TEMPO,
        {
          hookAddresses,
          pseudoTvl: new FakePseudoTvlReader(new Map()),
          externalLiquidityOnly: true,
        },
        deps(
          new FakeRoutablePools([TEMPO_AGG_ROW]),
          new FakeMetric(),
          new RecordingLogger(),
          async () => {
            throw new Error('Stale native token price');
          }
        )
      ).getPools()
    ).rejects.toThrow('Stale native token price');
  });
});

describe('AuroraV3PoolIdsProvider', () => {
  it('reads the listed pools and values them like the main V3 source', async () => {
    const routablePools = new FakeRoutablePools([], [MAINNET_MANUAL_V3_ROW]);
    const pools = await new AuroraV3PoolIdsProvider(
      ChainId.MAINNET,
      MAINNET_V3_MANUAL_POOL_IDS,
      deps(routablePools, new FakeMetric())
    ).getPools();
    expect(routablePools.v3Calls).toEqual([
      {
        chainId: toExtendedChainId(ChainId.MAINNET),
        poolAddresses: MAINNET_V3_MANUAL_POOL_IDS,
      },
    ]);
    expect(pools).toEqual([
      {
        id: '0x4622df6fb2d9bee0dcdacf545acdb6a2b2f4f863',
        feeTier: '500',
        liquidity: '304277235117237',
        token0: {id: '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0'},
        token1: {id: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'},
        tvlUSD: 12_500,
        tvlETH: 12_500 / NATIVE_PRICE_USD,
      },
    ]);
  });
});

describe('AuroraSourcedExtraPoolsProvider', () => {
  type TestPool = {id: string; tvlUSD: number};
  const auroraPool: TestPool = {id: '0xAA', tvlUSD: 1000};
  const tags = {source: 'euler_hooks', chainId: '130'};

  function wrapper(
    aurora: FakeSource<TestPool>,
    metric: FakeMetric,
    logger = new RecordingLogger(),
    coverage?: ExtraPoolsCoverage<TestPool>
  ) {
    return new AuroraSourcedExtraPoolsProvider(
      ExtraPoolSourceName.EULER_HOOKS,
      ChainId.UNICHAIN,
      aurora,
      logger,
      metric,
      coverage
    );
  }

  it('serves the Aurora read', async () => {
    const metric = new FakeMetric();
    const pools = await wrapper(
      new FakeSource([auroraPool]),
      metric
    ).getPools();
    expect(pools).toEqual([auroraPool]);
    expect(metric.byKey('CachePools.aurora.extra_source')).toEqual([
      {
        key: 'CachePools.aurora.extra_source',
        value: 1,
        tags: {...tags, status: 'success'},
      },
    ]);
  });

  it('rethrows an Aurora error and counts it', async () => {
    const metric = new FakeMetric();
    const logger = new RecordingLogger();
    const timeout = new Error('statement timeout');
    await expect(
      wrapper(new FakeSource<TestPool>(timeout), metric, logger).getPools()
    ).rejects.toBe(timeout);
    expect(metric.byKey('CachePools.aurora.extra_source')[0]?.tags).toEqual({
      ...tags,
      status: 'failure',
      reason: 'error',
    });
    expect(logger.warnings).toEqual([
      {
        msg: 'Aurora extra pool source euler_hooks:130 failed: Error',
        extra: [],
      },
    ]);
  });

  it('returns an empty Aurora result and counts it', async () => {
    const metric = new FakeMetric();
    const pools = await wrapper(
      new FakeSource<TestPool>([]),
      metric
    ).getPools();
    expect(pools).toEqual([]);
    expect(metric.byKey('CachePools.aurora.extra_source')[0]?.tags).toEqual({
      ...tags,
      status: 'failure',
      reason: 'empty',
    });
  });

  it('reports coverage of a partial result and still serves it', async () => {
    const metric = new FakeMetric();
    const logger = new RecordingLogger();
    const pools = await wrapper(new FakeSource([auroraPool]), metric, logger, {
      kind: 'expected_keys',
      expectedKeys: ['0xAA', '0xdd'],
      coverageKey: pool => pool.id,
      warnOnMissing: true,
    }).getPools();

    expect(pools).toEqual([auroraPool]);
    const coverage = (name: string) =>
      metric.byKey(`CachePools.aurora.extra_source_coverage.${name}`);
    expect(coverage('served')).toEqual([
      {key: 'CachePools.aurora.extra_source_coverage.served', value: 1, tags},
    ]);
    expect(coverage('expected')[0]?.value).toBe(2);
    expect(coverage('missing')[0]?.value).toBe(1);
    expect(
      metric.byKey('CachePools.aurora.extra_source_coverage_check')
    ).toEqual([
      {
        key: 'CachePools.aurora.extra_source_coverage_check',
        value: 1,
        tags: {...tags, status: 'failure', reason: 'missing_expected'},
      },
    ]);
    expect(logger.warnings).toEqual([
      {
        msg: 'Aurora extra pool source incomplete euler_hooks:130: missing=1 of 2',
        extra: [{missingKeys: ['0xdd']}],
      },
    ]);
  });

  it('reports full coverage as success, and counts a gap without a warn where a key may have no pool', async () => {
    const complete = new FakeMetric();
    const completeLogger = new RecordingLogger();
    await wrapper(new FakeSource([auroraPool]), complete, completeLogger, {
      kind: 'expected_keys',
      expectedKeys: ['0xaa'],
      coverageKey: pool => pool.id,
      warnOnMissing: true,
    }).getPools();
    expect(
      complete.byKey('CachePools.aurora.extra_source_coverage_check')[0]?.tags
    ).toEqual({...tags, status: 'success'});
    expect(completeLogger.warnings).toEqual([]);

    const quiet = new FakeMetric();
    const quietLogger = new RecordingLogger();
    await wrapper(new FakeSource([auroraPool]), quiet, quietLogger, {
      kind: 'expected_keys',
      expectedKeys: ['0xaa', '0xdd'],
      coverageKey: pool => pool.id,
      warnOnMissing: false,
    }).getPools();
    expect(
      quiet.byKey('CachePools.aurora.extra_source_coverage.missing')[0]?.value
    ).toBe(1);
    expect(quietLogger.warnings).toEqual([]);
  });

  it('reports no coverage for an empty result', async () => {
    const metric = new FakeMetric();
    await wrapper(new FakeSource<TestPool>([]), metric, new RecordingLogger(), {
      kind: 'expected_keys',
      expectedKeys: ['0xaa'],
      coverageKey: pool => pool.id,
      warnOnMissing: true,
    }).getPools();
    expect(
      metric.byKey('CachePools.aurora.extra_source_coverage_check')
    ).toEqual([]);
  });

  describe('recent pool-id coverage', () => {
    const NOW_MS = Date.UTC(2026, 9, 13, 12);
    const key = extraSourceKey(ExtraPoolSourceName.EULER_HOOKS, 130);
    // Tempo-shaped: one hook, five pools.
    const fivePools: TestPool[] = ['0x01', '0x02', '0x03', '0x04', '0x05'].map(
      id => ({id, tvlUSD: 1000})
    );

    function recentWrapper(
      aurora: FakeSource<TestPool>,
      memory: ExtraPoolSourceMemory<TestPool>,
      metric: FakeMetric,
      logger: RecordingLogger
    ) {
      return new AuroraSourcedExtraPoolsProvider(
        ExtraPoolSourceName.EULER_HOOKS,
        ChainId.UNICHAIN,
        aurora,
        logger,
        metric,
        {kind: 'recent_pool_ids', recent: memory, warnOnMissing: true},
        () => NOW_MS
      );
    }

    it('counts losing 4 of 5 recently served pools as missing, though the hook still has a pool', async () => {
      const memory = new ExtraPoolSourceMemory<TestPool>();
      memory.recordGood(key, fivePools, NOW_MS - 20 * 60_000);
      const metric = new FakeMetric();
      const logger = new RecordingLogger();

      const pools = await recentWrapper(
        new FakeSource([{id: '0x01', tvlUSD: 1000}]),
        memory,
        metric,
        logger
      ).getPools();

      expect(pools.map(pool => pool.id)).toEqual(['0x01']);
      expect(
        metric.byKey('CachePools.aurora.extra_source_coverage.missing')[0]
          ?.value
      ).toBe(4);
      expect(
        metric.byKey('CachePools.aurora.extra_source_coverage_check')[0]?.tags
      ).toMatchObject({status: 'failure', reason: 'missing_expected'});
      expect(logger.warnings).toEqual([
        {
          msg: 'Aurora extra pool source incomplete euler_hooks:130: missing=4 of 5',
          extra: [{missingKeys: ['0x02', '0x03', '0x04', '0x05']}],
        },
      ]);
    });

    it('does not fail for a hook that has no pools, and starts from full coverage after a restart', async () => {
      const metric = new FakeMetric();
      const logger = new RecordingLogger();
      // A restart: nothing recorded yet, so nothing is expected.
      await recentWrapper(
        new FakeSource(fivePools),
        new ExtraPoolSourceMemory<TestPool>(),
        metric,
        logger
      ).getPools();

      // Same five pools again after a good read; a second, empty hook adds no
      // expected key.
      const memory = new ExtraPoolSourceMemory<TestPool>();
      memory.recordGood(key, fivePools, NOW_MS - 20 * 60_000);
      await recentWrapper(
        new FakeSource(fivePools),
        memory,
        metric,
        logger
      ).getPools();

      expect(
        metric
          .byKey('CachePools.aurora.extra_source_coverage_check')
          .map(entry => entry.tags?.status)
      ).toEqual(['success', 'success']);
      expect(logger.warnings).toEqual([]);
    });

    it('stops expecting a pool once its last good read is older than the window', async () => {
      const memory = new ExtraPoolSourceMemory<TestPool>(60 * 60_000);
      memory.recordGood(key, fivePools, NOW_MS - 2 * 60 * 60_000);
      const metric = new FakeMetric();

      await recentWrapper(
        new FakeSource([{id: '0x01', tvlUSD: 1000}]),
        memory,
        metric,
        new RecordingLogger()
      ).getPools();

      expect(
        metric.byKey('CachePools.aurora.extra_source_coverage.expected')[0]
          ?.value
      ).toBe(0);
    });
  });
});

describe('applyAuroraExtraPoolSources', () => {
  const ethersProvider = new ethers.providers.JsonRpcProvider(
    'http://127.0.0.1:1'
  );

  it('installs a source for every combo that has one', async () => {
    const metric = new FakeMetric();
    const routablePools = new FakeRoutablePools(
      [UNICHAIN_EULER_ROW],
      [MAINNET_MANUAL_V3_ROW]
    );
    const unichainV4: ExtraSourceChainProtocol = {
      protocol: Protocol.V4,
      chainId: ChainId.UNICHAIN,
    };
    const tempoV4: ExtraSourceChainProtocol = {
      protocol: Protocol.V4,
      chainId: CHAIN_ID_TEMPO,
      aggHooks: {
        hookAddresses: ['0x7169a78a59f136876e724b648fbb339a42f46888'],
        ethersProvider,
        useExternalLiquidity: true,
      },
    };
    const mainnetV3: ExtraSourceChainProtocol = {
      protocol: Protocol.V3,
      chainId: ChainId.MAINNET,
    };
    const baseV3: ExtraSourceChainProtocol = {
      protocol: Protocol.V3,
      chainId: ChainId.BASE,
    };
    const polygonV4: ExtraSourceChainProtocol = {
      protocol: Protocol.V4,
      chainId: ChainId.POLYGON,
    };
    applyAuroraExtraPoolSources(
      [unichainV4, tempoV4, mainnetV3, baseV3, polygonV4],
      deps(routablePools, metric),
      new RecordingLogger(),
      metric
    );

    expect(Object.keys(unichainV4.extraPoolSources ?? {})).toEqual(['euler']);
    expect(Object.keys(tempoV4.extraPoolSources ?? {})).toEqual(['aggHooks']);
    expect(Object.keys(mainnetV3.extraPoolSources ?? {})).toEqual(['v3Manual']);
    expect(baseV3.extraPoolSources).toBeUndefined();
    expect(polygonV4.extraPoolSources).toBeUndefined();

    const euler = await unichainV4.extraPoolSources?.euler?.getPools();
    expect(euler?.map(pool => pool.id)).toEqual([UNICHAIN_EULER_ROW.poolId]);
    expect(routablePools.v4Calls[0]?.hooks).toEqual(
      EULER_SWAP_HOOKS_BY_CHAIN.get(ChainId.UNICHAIN)
    );
    const manual = await mainnetV3.extraPoolSources?.v3Manual?.getPools();
    expect(manual?.map(pool => pool.id)).toEqual([
      '0x4622df6fb2d9bee0dcdacf545acdb6a2b2f4f863',
    ]);
  });
});

describe('applyAuroraPoolSources → extra pool sources', () => {
  const unichainWrappedNative = '0x4200000000000000000000000000000000000006';
  const prices = {
    batchGet: async () =>
      new Map([
        [
          canonicalTokenKey(ChainId.UNICHAIN, unichainWrappedNative),
          {
            chainId: toExtendedChainId(ChainId.UNICHAIN),
            tokenAddress: createAddress(
              unichainWrappedNative,
              toExtendedChainId(ChainId.UNICHAIN)
            ),
            priceUsd: NATIVE_PRICE_USD,
            timestamp: new Date(),
            updatedAt: new Date(),
          },
        ],
      ]),
  };

  function unichainV4(): {
    protocol: Protocol;
    chainId: number;
    provider?: ISubgraphProvider<V4SubgraphPool>;
    extraPoolSources?: {
      euler?: ExtraPoolsSource<V4SubgraphPool>;
      v3Manual?: ExtraPoolsSource<V3SubgraphPool>;
    };
  } {
    return {protocol: Protocol.V4, chainId: ChainId.UNICHAIN};
  }

  const providerDeps = (metric: FakeMetric) => ({
    routablePools: {
      batchGetPoolVolumeUsd30d: async () => new Map<string, number>(),
      listAllV2RoutablePools: async () => [],
      listAllV3RoutablePools: async () => [],
      listAllV4RoutablePools: async () => [],
    },
    prices,
    logger: new RecordingLogger(),
    metric,
  });

  it('serves EulerSwap pools from Aurora beside the main provider', async () => {
    const metric = new FakeMetric();
    const routablePools = new FakeRoutablePools([UNICHAIN_EULER_ROW]);
    const chainProtocol = unichainV4();
    applyAuroraPoolSources(
      [chainProtocol],
      {trackedEthThresholdFor: () => 0.01, untrackedUsdThresholdFor: () => 0},
      new RecordingLogger(),
      metric,
      {
        scopedRun: true,
        providerDeps: providerDeps(metric),
        extraSourceRoutablePools: routablePools,
      }
    );

    expect(chainProtocol.provider).toBeDefined();
    const served = await chainProtocol.extraPoolSources?.euler?.getPools();
    expect(served?.map(pool => pool.id)).toEqual([UNICHAIN_EULER_ROW.poolId]);
    expect(routablePools.v4Calls[0]?.hooks).toEqual(
      EULER_SWAP_HOOKS_BY_CHAIN.get(ChainId.UNICHAIN)
    );
  });

  it('installs no extra source when no extra-source reader is available', () => {
    const metric = new FakeMetric();
    const chainProtocol = unichainV4();
    applyAuroraPoolSources(
      [chainProtocol],
      {trackedEthThresholdFor: () => 0.01, untrackedUsdThresholdFor: () => 0},
      new RecordingLogger(),
      metric,
      {scopedRun: true, providerDeps: providerDeps(metric)}
    );
    expect(chainProtocol.provider).toBeDefined();
    expect(chainProtocol.extraPoolSources).toBeUndefined();
  });
});

// The registry is consumed as-is by the Aurora read: every entry must be a
// valid address, and each chain's list must have no duplicates.
describe('EULER_SWAP_HOOKS_BY_CHAIN', () => {
  it.each([...EULER_SWAP_HOOKS_BY_CHAIN.entries()])(
    'chain %s lists distinct valid hook addresses',
    (chainId, hooks) => {
      const lowered = hooks.map(hook =>
        createAddress(
          hook,
          toExtendedChainId(chainId)
        ).checksummed.toLowerCase()
      );
      expect(new Set(lowered).size).toBe(hooks.length);
    }
  );

  it('covers exactly the chains with EulerSwap pools', () => {
    expect([...EULER_SWAP_HOOKS_BY_CHAIN.keys()].sort((a, b) => a - b)).toEqual(
      [ChainId.MAINNET, ChainId.UNICHAIN]
    );
  });
});
