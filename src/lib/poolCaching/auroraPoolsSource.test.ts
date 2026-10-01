import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {ADDRESS_ZERO, Protocol} from '@uniswap/router-sdk';

import {
  AURORA_SUPPORTED_TARGETS,
  AsyncSemaphore,
  AuroraSourcedProvider,
  AuroraV2PoolsProvider,
  AuroraV3PoolsProvider,
  AuroraV4PoolsProvider,
  IMPLIED_PRICE_SOURCE_TOKENS_BY_CHAIN,
  WRAPPED_NATIVE_BY_CHAIN,
  applyAuroraPoolSources,
  auroraPoolsSourceConfigFromEnv,
  computePoolParity,
  guardPricedTvlUsd,
  impliedOneHopTvlUsd,
  resetAuroraPoolCountBaselinesForTesting,
  resolveAuroraMode,
  resolveAuroraModeWithPrimaryFloor,
  settlePendingAuroraShadowsForTesting,
  targetKey,
  tvlGuardAnchorTokens,
  poolCachingAuroraStatementTimeoutMsFromEnv,
} from './auroraPoolsSource';
import {getTvlBypassHookAddresses} from './util/hooksAddressesAllowlist';
import {createChainProtocols} from './cacheConfig';
import {
  resetDynamicZlcaHooksForTest,
  setDynamicZlcaHooks,
} from './util/dynamicZlcaHooks';
import {
  ISubgraphProvider,
  V2SubgraphPool,
  V3SubgraphPool,
  V4SubgraphPool,
} from './sor-providers';
import {Logger} from './sor-providers/util/log';
import {IMetric, MetricLoggerUnit} from './sor-providers/util/metric';
import type {RoutablePoolsService} from '@uniswap/lib-data-ingestion-aurora';

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
  // Which call emitted each key, so a test can pin the emission type.
  readonly gaugeKeys = new Set<string>();
  readonly putMetricKeys = new Set<string>();

  putDimensions(): void {}
  putProperties(): void {}
  putMetric(
    key: string,
    value: number,
    _unit?: MetricLoggerUnit,
    tags?: Record<string, string>
  ): void {
    this.putMetricKeys.add(key);
    this.emitted.push({key, value, tags});
  }
  override putGauge(
    key: string,
    value: number,
    tags?: Record<string, string>
  ): void {
    this.gaugeKeys.add(key);
    this.emitted.push({key, value, tags});
  }
  setProperty(): void {}

  byKey(key: string) {
    return this.emitted.filter(m => m.key === key);
  }
}

class FakeV2RoutablePools
  implements Pick<RoutablePoolsService, 'listAllV2RoutablePools'>
{
  constructor(
    private readonly rows: Awaited<
      ReturnType<RoutablePoolsService['listAllV2RoutablePools']>
    >
  ) {}
  async listAllV2RoutablePools() {
    return this.rows;
  }
}

class FakeV3RoutablePools
  implements Pick<RoutablePoolsService, 'listAllV3RoutablePools'>
{
  constructor(
    private readonly rows: Awaited<
      ReturnType<RoutablePoolsService['listAllV3RoutablePools']>
    >
  ) {}
  async listAllV3RoutablePools() {
    return this.rows;
  }
}

class FakeV4RoutablePools
  implements Pick<RoutablePoolsService, 'listAllV4RoutablePools'>
{
  constructor(
    private readonly rows: Awaited<
      ReturnType<RoutablePoolsService['listAllV4RoutablePools']>
    >
  ) {}
  async listAllV4RoutablePools() {
    return this.rows;
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

// A provider whose single getPools call settles when the test says so, to
// model an Aurora read still queued or running after the subgraph returns.
function deferredProvider<TPool>(): ISubgraphProvider<TPool> & {
  resolve(pools: TPool[]): void;
  reject(err: Error): void;
} {
  let settle: {resolve(pools: TPool[]): void; reject(err: Error): void} = {
    resolve: () => {},
    reject: () => {},
  };
  const result = new Promise<TPool[]>((resolve, reject) => {
    settle = {resolve, reject};
  });
  return {
    getPools: () => result,
    resolve: pools => settle.resolve(pools),
    reject: err => settle.reject(err),
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

function v4Pool(
  id: string,
  tvlUSD: number,
  hooks: string,
  liquidity: string
): V4SubgraphPool {
  return {
    id,
    feeTier: '3000',
    tickSpacing: '60',
    hooks,
    liquidity,
    token0: {id: '0xa', decimals: '18'},
    token1: {id: '0xb', decimals: '18'},
    tvlETH: tvlUSD / 2000,
    tvlUSD,
  };
}

describe('auroraPoolsSourceConfigFromEnv', () => {
  const ENV_KEYS = [
    'POOL_CACHING_AURORA_SHADOW_TARGETS',
    'POOL_CACHING_AURORA_PRIMARY_TARGETS',
    'POOL_CACHING_AURORA_TVL_GUARD_TARGETS',
    'POOL_CACHING_AURORA_MIN_POOL_COUNT_RATIO',
    'POOL_CACHING_AURORA_MIN_POOL_COUNT_BY_TARGET',
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
    process.env.POOL_CACHING_AURORA_TVL_GUARD_TARGETS = '*';
    expect(auroraPoolsSourceConfigFromEnv()).toBeUndefined();
  });

  it('parses guard targets independently of source targets', () => {
    process.env.POOL_CACHING_AURORA_SHADOW_TARGETS = '*';
    const unset = auroraPoolsSourceConfigFromEnv();
    expect(unset?.tvlGuardTargets).toEqual(new Set());
    process.env.POOL_CACHING_AURORA_TVL_GUARD_TARGETS = '4663:v4,10:V3';
    expect(auroraPoolsSourceConfigFromEnv()?.tvlGuardTargets).toEqual(
      new Set(['4663:V4', '10:V3'])
    );
    process.env.POOL_CACHING_AURORA_TVL_GUARD_TARGETS = '*';
    expect(auroraPoolsSourceConfigFromEnv()?.tvlGuardTargets).toBe('all');
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

  it('parses the per-target absolute floor map, normalizing keys', () => {
    process.env.POOL_CACHING_AURORA_PRIMARY_TARGETS = '4663:V4';
    process.env.POOL_CACHING_AURORA_MIN_POOL_COUNT_BY_TARGET =
      '{"4663:v4": 40000.7, "1:V3": 0, "8453:V4": -5}';
    const floors = auroraPoolsSourceConfigFromEnv()!.minPoolCountByTarget;
    // Fractional floors truncate; non-positive entries are dropped.
    expect(floors.get('4663:V4')).toBe(40000);
    expect(floors.has('1:V3')).toBe(false);
    expect(floors.has('8453:V4')).toBe(false);
    // Dropped entries are tracked per key so a value typo cannot silently
    // downgrade ITS serving primary combo — while other targets keep the
    // strict missing-floor rule.
    const config = auroraPoolsSourceConfigFromEnv()!;
    expect(config.minPoolCountFloorInvalidKeys).toEqual(
      new Set(['1:V3', '8453:V4'])
    );
    expect(config.minPoolCountFloorUnparseable).toBe(false);
  });

  it('treats malformed floor JSON as no floors but flags it unparseable', () => {
    process.env.POOL_CACHING_AURORA_PRIMARY_TARGETS = '4663:V4';
    process.env.POOL_CACHING_AURORA_MIN_POOL_COUNT_BY_TARGET = 'not json';
    const config = auroraPoolsSourceConfigFromEnv()!;
    expect(config.minPoolCountByTarget.size).toBe(0);
    expect(config.minPoolCountFloorUnparseable).toBe(true);
  });

  it('treats a JSON array as unparseable, not as index-keyed entries', () => {
    // '[40000]' parses to an object with key "0" — without the array guard a
    // primary target would read as primary_without_floor (deliberate absence)
    // instead of primary_floor_config_invalid (typo), and #12443's monitor
    // keys off that distinction.
    process.env.POOL_CACHING_AURORA_PRIMARY_TARGETS = '4663:V4';
    process.env.POOL_CACHING_AURORA_MIN_POOL_COUNT_BY_TARGET = '[40000]';
    const config = auroraPoolsSourceConfigFromEnv()!;
    expect(config.minPoolCountByTarget.size).toBe(0);
    expect(config.minPoolCountFloorUnparseable).toBe(true);
  });
});

describe('poolCachingAuroraStatementTimeoutMsFromEnv', () => {
  const KEY = 'POOL_CACHING_AURORA_STATEMENT_TIMEOUT_MS';
  let saved: string | undefined;
  let warnings: string[];
  const logger = {warn: (message: string) => warnings.push(message)};

  beforeEach(() => {
    saved = process.env[KEY];
    delete process.env[KEY];
    warnings = [];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  it('defaults to 30s when unset or blank, without warning', () => {
    expect(poolCachingAuroraStatementTimeoutMsFromEnv(logger)).toBe(30_000);
    process.env[KEY] = '  ';
    expect(poolCachingAuroraStatementTimeoutMsFromEnv(logger)).toBe(30_000);
    expect(warnings).toEqual([]);
  });

  it('applies an in-range integer override', () => {
    process.env[KEY] = '90000';
    expect(poolCachingAuroraStatementTimeoutMsFromEnv(logger)).toBe(90_000);
    expect(warnings).toEqual([]);
  });

  it.each(['abc', '30000.5', '0', '4999', '100001', '-30000'])(
    'refuses %s with a warn and keeps the default',
    raw => {
      process.env[KEY] = raw;
      expect(poolCachingAuroraStatementTimeoutMsFromEnv(logger)).toBe(30_000);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(`got "${raw}"`);
    }
  );
});

describe('resolveAuroraModeWithPrimaryFloor', () => {
  it('downgrades a primary target without an absolute floor to shadow', () => {
    const metric = new FakeMetric();
    const warnings: string[] = [];
    const logger: Logger = {
      ...noopLogger,
      warn: message => warnings.push(message),
    };
    const config = {
      shadowTargets: new Set<string>(),
      primaryTargets: new Set([targetKey(1, Protocol.V3)]),
      tvlGuardTargets: new Set<string>(),
      minPoolCountRatio: 0.5,
      minPoolCountByTarget: new Map<string, number>(),
      minPoolCountFloorInvalidKeys: new Set<string>(),
      minPoolCountFloorUnparseable: false,
    };

    expect(
      resolveAuroraModeWithPrimaryFloor(config, 1, Protocol.V3, logger, metric)
    ).toBe('shadow');
    expect(warnings[0]).toMatch(/^Aurora pool source primary_without_floor/);
    expect(
      metric.byKey('CachePools.aurora.primary_without_floor')[0]!.tags
    ).toEqual({
      chainId: '1',
      protocol: String(Protocol.V3),
    });
  });

  it('downgrades an invalid floor entry to shadow (fail closed), scoped to that key', () => {
    const metric = new FakeMetric();
    const warnings: string[] = [];
    const logger: Logger = {
      ...noopLogger,
      warn: message => warnings.push(message),
    };
    const config = {
      shadowTargets: new Set<string>(),
      primaryTargets: new Set([
        targetKey(4663, Protocol.V4),
        targetKey(1, Protocol.V3),
      ]),
      tvlGuardTargets: new Set<string>(),
      minPoolCountRatio: 0.5,
      minPoolCountByTarget: new Map<string, number>(),
      minPoolCountFloorInvalidKeys: new Set([targetKey(4663, Protocol.V4)]),
      minPoolCountFloorUnparseable: false,
    };

    // The typo'd entry downgrades ITS combo to shadow — a floorless primary
    // is unprotected on the first post-deploy tick — under the typo-specific
    // metric...
    expect(
      resolveAuroraModeWithPrimaryFloor(
        config,
        4663,
        Protocol.V4,
        logger,
        metric
      )
    ).toBe('shadow');
    expect(warnings[0]).toMatch(
      /^Aurora pool source primary_floor_config_invalid/
    );
    expect(
      metric.byKey('CachePools.aurora.primary_floor_config_invalid')
    ).toHaveLength(1);
    // ...while a target with NO entry at all downgrades under the
    // absence-specific metric.
    expect(
      resolveAuroraModeWithPrimaryFloor(config, 1, Protocol.V3, logger, metric)
    ).toBe('shadow');
    expect(
      metric.byKey('CachePools.aurora.primary_without_floor')
    ).toHaveLength(1);
  });

  it('downgrades every primary target to shadow on an unparseable floor env', () => {
    const metric = new FakeMetric();
    const config = {
      shadowTargets: new Set<string>(),
      primaryTargets: new Set([targetKey(4663, Protocol.V4)]),
      tvlGuardTargets: new Set<string>(),
      minPoolCountRatio: 0.5,
      minPoolCountByTarget: new Map<string, number>(),
      minPoolCountFloorInvalidKeys: new Set<string>(),
      minPoolCountFloorUnparseable: true,
    };
    expect(
      resolveAuroraModeWithPrimaryFloor(
        config,
        4663,
        Protocol.V4,
        noopLogger,
        metric
      )
    ).toBe('shadow');
    expect(
      metric.byKey('CachePools.aurora.primary_floor_config_invalid')
    ).toHaveLength(1);
  });

  it('a valid floor entry keeps primary untouched', () => {
    const metric = new FakeMetric();
    const config = {
      shadowTargets: new Set<string>(),
      primaryTargets: new Set([targetKey(4663, Protocol.V4)]),
      tvlGuardTargets: new Set<string>(),
      minPoolCountRatio: 0.5,
      minPoolCountByTarget: new Map([[targetKey(4663, Protocol.V4), 40000]]),
      minPoolCountFloorInvalidKeys: new Set<string>(),
      minPoolCountFloorUnparseable: false,
    };
    expect(
      resolveAuroraModeWithPrimaryFloor(
        config,
        4663,
        Protocol.V4,
        noopLogger,
        metric
      )
    ).toBe('primary');
    expect(metric.emitted).toHaveLength(0);
  });
});

describe('AsyncSemaphore', () => {
  it('holds a fourth Aurora fetch until one of three active fetches completes', async () => {
    const semaphore = new AsyncSemaphore(3);
    const releaseFirst = await semaphore.acquire();
    const releaseSecond = await semaphore.acquire();
    const releaseThird = await semaphore.acquire();
    let fourthAcquired = false;
    const fourth = semaphore.acquire().then(release => {
      fourthAcquired = true;
      return release;
    });

    await Promise.resolve();
    expect(fourthAcquired).toBe(false);
    releaseFirst();
    const releaseFourth = await fourth;
    expect(fourthAcquired).toBe(true);
    releaseSecond();
    releaseThird();
    releaseFourth();
  });

  it('releases the slot when run() work throws, so a queued acquire still proceeds', async () => {
    const semaphore = new AsyncSemaphore(1);
    let queuedRan = false;
    const queued = semaphore.run(async () => {
      queuedRan = true;
      return 'ok';
    });
    await expect(
      semaphore.run(async () => {
        throw new Error('fetch failed');
      })
    ).rejects.toThrow('fetch failed');
    // The rejecting run above held the only slot; if rejection leaked the
    // slot, this await would hang and the pool-sizing math (one connection
    // always free for the fast job) would be violated in production.
    await expect(queued).resolves.toBe('ok');
    expect(queuedRan).toBe(true);
  });

  it('grants a freed slot to a normal waiter before an earlier low-priority waiter', async () => {
    const semaphore = new AsyncSemaphore(1);
    const releaseHolder = await semaphore.acquire();
    const order: string[] = [];
    const lowPriority = semaphore.lowPriority().run(async () => {
      order.push('shadow');
    });
    const normal = semaphore.run(async () => {
      order.push('registry');
    });

    releaseHolder();
    await Promise.all([lowPriority, normal]);
    expect(order).toEqual(['registry', 'shadow']);
  });

  it('runs low-priority work immediately when a slot is free', async () => {
    const semaphore = new AsyncSemaphore(1);
    await expect(semaphore.lowPriority().run(async () => 'ran')).resolves.toBe(
      'ran'
    );
    // The low-priority run released its slot: a normal acquire must not hang.
    const release = await semaphore.acquire();
    release();
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

    const parity = computePoolParity(subgraph, aurora, undefined);
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
    const parity = computePoolParity([], [], undefined);
    expect(parity.jaccardBps).toBe(0);
    expect(parity.missingTop100).toBe(0);
    expect(parity.missingTop100Live).toBe(0);
  });

  it('excludes emptied pools from the live top-100 gap and its sample', () => {
    // The subgraph keeps ranking a drained pool by stale TVL, as it does for
    // Mainnet V3 WETH/TRUMP (0x1b942ce8…, on-chain liquidity 0).
    const drained = {...v3Pool('0xDEAD', 50_000), liquidity: '0'};
    const liveMissing = v3Pool('0xb2', 900);
    const subgraph = [drained, liveMissing, v3Pool('0xb1', 1000)];
    const aurora = [v3Pool('0xb1', 1000)];

    const parity = computePoolParity(subgraph, aurora, undefined);
    expect(parity.missingTop100).toBe(2);
    expect(parity.missingTop100Live).toBe(1);
    expect(parity.missingSample).toEqual(['0xdead', '0xb2']);
    expect(parity.missingLiveSample).toEqual(['0xb2']);
  });

  it('counts a zero-liquidity TVL-bypass hook pool as live', () => {
    // A wrapper hook keeps its liquidity outside the PoolManager, so the
    // pool reads liquidity 0 however much the hook holds. The registry is
    // lowercase; the pool carries the checksummed form.
    const bypassHook = '0xB0B0000000000000000000000000000000000001';
    const bypassPool = v4Pool('0xd1', 0, bypassHook, '0');
    const drainedHookless = v4Pool('0xd2', 800, ADDRESS_ZERO, '0');
    const subgraph = [
      drainedHookless,
      bypassPool,
      v4Pool('0xd3', 900, ADDRESS_ZERO, '5'),
    ];
    const aurora = [v4Pool('0xd3', 900, ADDRESS_ZERO, '5')];

    const parity = computePoolParity(
      subgraph,
      aurora,
      new Set([bypassHook.toLowerCase()])
    );
    expect(parity.missingTop100).toBe(2);
    expect(parity.missingTop100Live).toBe(1);
    expect(parity.missingLiveSample).toEqual(['0xd1']);
  });

  it('treats a zero-liquidity hooked pool as not live when its hook is not a TVL-bypass hook', () => {
    const hooked = v4Pool(
      '0xe1',
      50,
      '0xB0B0000000000000000000000000000000000002',
      '0'
    );
    const parity = computePoolParity(
      [hooked],
      [],
      new Set(['0xb0b0000000000000000000000000000000000001'])
    );
    expect(parity.missingTop100).toBe(1);
    expect(parity.missingTop100Live).toBe(0);
  });

  it('counts every V2 pool as live (V2 carries no liquidity field)', () => {
    const v2Pool = (id: string, reserveUSD: number): V2SubgraphPool => ({
      id,
      token0: {id: '0xa'},
      token1: {id: '0xb'},
      supply: 1,
      reserve: reserveUSD / 2000,
      reserveUSD,
    });
    const parity = computePoolParity(
      [v2Pool('0xc1', 500), v2Pool('0xc2', 400)],
      [v2Pool('0xc1', 500)],
      undefined
    );
    expect(parity.missingTop100).toBe(1);
    expect(parity.missingTop100Live).toBe(1);
  });

  it('counts a junk-priced Aurora-only pool at the top in extraTop100 while missingTop100 stays 0', () => {
    // The Arc V3 shape: Aurora admits a fake-USDC pool the subgraph never
    // serves and values it at $27.6B, above every real pool.
    const junk = v3Pool('0x70CDF71E240CC073DB471A94B9514A0AD54B0C48', 27.6e9);
    const subgraph = [v3Pool('0xe1', 1000), v3Pool('0xe2', 900)];
    const aurora = [junk, v3Pool('0xE1', 1000), v3Pool('0xe2', 900)];

    const parity = computePoolParity(subgraph, aurora, undefined);
    expect(parity.missingTop100).toBe(0);
    expect(parity.extraTop100).toBe(1);
    expect(parity.extraSample).toEqual([
      '0x70cdf71e240cc073db471a94b9514a0ad54b0c48',
    ]);
  });

  it('only counts Aurora extras inside its own top 100 by TVL', () => {
    const shared = Array.from({length: 100}, (_, i) =>
      v3Pool(`0xf${i}`, 1000 - i)
    );
    const extraAtRank101 = v3Pool('0xextra', 1);
    expect(
      computePoolParity(shared, [...shared, extraAtRank101], undefined)
        .extraTop100
    ).toBe(0);
    const extraAtRank100 = v3Pool('0xextra', 850);
    expect(
      computePoolParity(
        shared,
        [...shared.slice(0, 99), extraAtRank100],
        undefined
      ).extraTop100
    ).toBe(1);
  });

  it('reports the top-100 drift apart from a dust-dominated median', () => {
    // 150 large pools that agree exactly and 150 dust pools Aurora values at
    // half: the full median lands on dust, the top 100 are all large pools.
    const large = Array.from({length: 150}, (_, i) =>
      v3Pool(`0xa${i}`, 1_000_000 + i)
    );
    const dustSubgraph = Array.from({length: 150}, (_, i) =>
      v3Pool(`0xd${i}`, 0.5)
    );
    const dustAurora = dustSubgraph.map(pool => v3Pool(pool.id, 0.25));

    const parity = computePoolParity(
      [...large, ...dustSubgraph],
      [...large, ...dustAurora],
      undefined
    );
    expect(parity.tvlDriftBpsP50).toBe(5000);
    expect(parity.tvlDriftBpsTop100P50).toBe(0);
  });

  it('reports no top-100 drift, not 0, on empty inputs', () => {
    const parity = computePoolParity([], [], undefined);
    expect(parity.extraTop100).toBe(0);
    expect(parity.tvlDriftBpsTop100P50).toBeUndefined();
  });

  it('reports no top-100 drift when no top-100 pool has a drift sample', () => {
    // A shared pool the subgraph values at $0 has no drift sample, however
    // far Aurora is from it. That must not read as perfect agreement.
    const parity = computePoolParity(
      [v3Pool('0xe1', 0)],
      [v3Pool('0xe1', 1e9)],
      undefined
    );
    expect(parity.missingTop100).toBe(0);
    expect(parity.extraTop100).toBe(0);
    expect(parity.tvlDriftBpsTop100P50).toBeUndefined();
  });

  it('counts equal-TVL pools at the cutoff the same way in any input order', () => {
    // 100 shared pools and one Aurora-only pool, all at the same TVL: which
    // one falls off at rank 101 must not depend on the source's row order.
    const shared = Array.from({length: 100}, (_, i) =>
      v3Pool(`0xb${String(i).padStart(3, '0')}`, 500)
    );
    const extra = v3Pool('0xa000', 500);
    const extraFirst = computePoolParity(
      shared,
      [extra, ...shared],
      undefined
    ).extraTop100;
    const extraLast = computePoolParity(
      shared,
      [...shared, extra],
      undefined
    ).extraTop100;
    expect(extraFirst).toBe(extraLast);
    // '0xa000' sorts before every '0xb…' id, so it keeps its top-100 place.
    expect(extraFirst).toBe(1);
  });
});

describe('guardPricedTvlUsd', () => {
  // Fixtures are prod Aurora rows (dataingestion_v1, 2026-09-30), with each
  // side's raw amount chosen so amount x price reproduces the side's USD.
  const POLYGON = 137;
  const ARC = 5042;
  const ROBINHOOD = 4663;
  const WPOL_CHECKSUMMED = '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270';
  const ARC_USDC = '0x3600000000000000000000000000000000000000';
  const ROBINHOOD_WETH_CHECKSUMMED =
    '0x0BD7D308f8E1639fab988DF18A8011f41eaCad73';

  // One whole token (18 decimals) at priceUsd is a side worth priceUsd.
  const ONE_TOKEN = '1000000000000000000';
  const row = (overrides: {
    token0Address: string;
    token1Address: string;
    amount0: string;
    amount1: string;
    token0PriceUsd: number | null;
    token1PriceUsd: number | null;
    tvlUsd: number;
    token0Decimals?: number;
    token1Decimals?: number;
  }) => ({
    token0Decimals: 18,
    token1Decimals: 18,
    ...overrides,
  });

  it('collapses a junk side paired with an empty anchor side (Polygon V3 WPOL/"BTC")', () => {
    const polygonAnchors = tvlGuardAnchorTokens(POLYGON);
    expect(
      guardPricedTvlUsd(
        row({
          token0Address: WPOL_CHECKSUMMED,
          token1Address: '0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6',
          amount0: '0',
          amount1: ONE_TOKEN,
          token0PriceUsd: 0.2,
          token1PriceUsd: 5701837764,
          tvlUsd: 5701837764,
        }),
        polygonAnchors,
        2500
      )
    ).toEqual({tvlUsd: 2500, reason: 'unanchored_one_side'});
  });

  it('caps a both-priced junk pair to its smaller side (Polygon V3 SNP/SHT)', () => {
    const guarded = guardPricedTvlUsd(
      row({
        token0Address: '0x0d7e84beedb5f5f66295ae46ad12f905441b1152',
        token1Address: '0x0d7e84beedb5f5f66295ae46ad12f905441b1153',
        amount0: ONE_TOKEN,
        amount1: ONE_TOKEN,
        token0PriceUsd: 3555,
        token1PriceUsd: 10810958061,
        tvlUsd: 3555 + 10810958061,
      }),
      tvlGuardAnchorTokens(POLYGON),
      2500
    );
    expect(guarded.reason).toBe('side_imbalance');
    expect(guarded.tvlUsd).toBeCloseTo(11 * 3555, 6);
  });

  it('collapses a fake stablecoin against an empty real one (Arc V3 USDC/"USDC")', () => {
    expect(
      guardPricedTvlUsd(
        row({
          token0Address: ARC_USDC,
          token1Address: '0x70cdf71e240cc073db471a94b9514a0ad54b0c48',
          amount0: '0',
          amount1: '66968757820000000000000000000',
          token0PriceUsd: 1,
          token1PriceUsd: 0.41214756440581884,
          tvlUsd: 27601006470.18,
          token0Decimals: 6,
        }),
        tvlGuardAnchorTokens(ARC),
        2500
      )
    ).toEqual({tvlUsd: 2500, reason: 'unanchored_one_side'});
  });

  it('leaves balanced and legitimately imbalanced pools unchanged', () => {
    // Optimism V3 USDC/WETH ($3.49M / $2.51M) and wstETH/USDC.e (6.2:1).
    for (const [usd0, usd1] of [
      [3486223, 2514831],
      [4059, 652],
    ]) {
      expect(
        guardPricedTvlUsd(
          row({
            token0Address: '0x0b2c639c533813f4aa9d7837caf62653d097ff85',
            token1Address: '0x4200000000000000000000000000000000000006',
            amount0: ONE_TOKEN,
            amount1: ONE_TOKEN,
            token0PriceUsd: usd0,
            token1PriceUsd: usd1,
            tvlUsd: usd0 + usd1,
          }),
          tvlGuardAnchorTokens(10),
          2500
        )
      ).toEqual({tvlUsd: usd0 + usd1, reason: undefined});
    }
  });

  it('caps a lone priced side that is not an anchor (Polygon V3 XRP/"USDC")', () => {
    expect(
      guardPricedTvlUsd(
        row({
          token0Address: '0xa54c8afdd6000000000000000000000000000001',
          token1Address: '0xa54c8afdd6000000000000000000000000000002',
          amount0: ONE_TOKEN,
          amount1: ONE_TOKEN,
          token0PriceUsd: 386614730,
          token1PriceUsd: null,
          tvlUsd: 386614730,
        }),
        tvlGuardAnchorTokens(POLYGON),
        2500
      )
    ).toEqual({tvlUsd: 2500, reason: 'unanchored_one_side'});
  });

  it('trusts a lone priced anchor side, whatever its address casing', () => {
    // The anchor set is lowercase; the row carries the checksummed address.
    const pool = row({
      token0Address: ROBINHOOD_WETH_CHECKSUMMED,
      token1Address: '0x00000000000000000000000000000000000c0ffe',
      amount0: ONE_TOKEN,
      amount1: ONE_TOKEN,
      token0PriceUsd: 1000000,
      token1PriceUsd: null,
      tvlUsd: 1000000,
    });
    expect(
      guardPricedTvlUsd(pool, tvlGuardAnchorTokens(ROBINHOOD), 2500)
    ).toEqual({
      tvlUsd: 1000000,
      reason: undefined,
    });
  });

  it('skips only the one-side check on a chain without anchor tokens', () => {
    const unknownChain = 999999;
    expect(tvlGuardAnchorTokens(unknownChain)).toBeUndefined();
    const lonePriced = row({
      token0Address: '0x0000000000000000000000000000000000000abc',
      token1Address: '0x0000000000000000000000000000000000000def',
      amount0: ONE_TOKEN,
      amount1: ONE_TOKEN,
      token0PriceUsd: 386614730,
      token1PriceUsd: null,
      tvlUsd: 386614730,
    });
    expect(guardPricedTvlUsd(lonePriced, undefined, 2500)).toEqual({
      tvlUsd: 386614730,
      reason: undefined,
    });
    // A side below $1 is unpriced, so without anchors no cap applies.
    expect(
      guardPricedTvlUsd(
        {...lonePriced, amount1: '0', token1PriceUsd: 1},
        undefined,
        2500
      ).tvlUsd
    ).toBe(386614730);
  });

  it('fails closed on an amount that does not parse', () => {
    expect(
      guardPricedTvlUsd(
        row({
          token0Address: '0x4200000000000000000000000000000000000006',
          token1Address: '0x0000000000000000000000000000000000000bad',
          amount0: 'not-a-number',
          amount1: ONE_TOKEN,
          token0PriceUsd: 2500,
          token1PriceUsd: 2500,
          tvlUsd: 5000,
        }),
        tvlGuardAnchorTokens(10),
        2500
      )
    ).toEqual({tvlUsd: 2500, reason: 'unanchored_one_side'});
  });

  it('caps a single-sided launch pool while trusting a sub-dollar anchor opposite a large anchor', () => {
    const anchors = tvlGuardAnchorTokens(ROBINHOOD);
    expect(
      guardPricedTvlUsd(
        row({
          token0Address: ROBINHOOD_WETH_CHECKSUMMED,
          token1Address: '0x0000000000000000000000000000000000000bad',
          amount0: '0',
          amount1: ONE_TOKEN,
          token0PriceUsd: 2000,
          token1PriceUsd: 40000,
          tvlUsd: 40000,
        }),
        anchors,
        2500
      )
    ).toEqual({tvlUsd: 2500, reason: 'unanchored_one_side'});
    expect(
      guardPricedTvlUsd(
        row({
          token0Address: '0x4200000000000000000000000000000000000006',
          token1Address: '0x0b2c639c533813f4aa9d7837caf62653d097ff85',
          amount0: '250000000000000',
          amount1: '1000000000000',
          token0PriceUsd: 2000,
          token1PriceUsd: 1,
          token1Decimals: 6,
          tvlUsd: 1000000.5,
        }),
        tvlGuardAnchorTokens(10),
        2500
      )
    ).toEqual({tvlUsd: 1000000.5, reason: undefined});
  });

  it('floors both-priced imbalance at $2,500 and preserves a 95/5 pool at $550,000', () => {
    const pool = row({
      token0Address: '0x0000000000000000000000000000000000000001',
      token1Address: '0x0000000000000000000000000000000000000002',
      amount0: ONE_TOKEN,
      amount1: ONE_TOKEN,
      token0PriceUsd: 2,
      token1PriceUsd: 1e9,
      tvlUsd: 1e9 + 2,
    });
    expect(guardPricedTvlUsd(pool, undefined, 2500)).toEqual({
      tvlUsd: 2500,
      reason: 'side_imbalance',
    });
    expect(
      guardPricedTvlUsd(
        {...pool, token0PriceUsd: 50000, token1PriceUsd: 950000, tvlUsd: 1e6},
        undefined,
        2500
      )
    ).toEqual({tvlUsd: 550000, reason: 'side_imbalance'});
    expect(
      guardPricedTvlUsd(
        {...pool, token0PriceUsd: 2, token1PriceUsd: 2000, tvlUsd: 2002},
        undefined,
        2500
      )
    ).toEqual({tvlUsd: 2002, reason: undefined});
  });

  it('respects the ratio, $1 side, and $2,500 raw boundaries', () => {
    const pool = row({
      token0Address: '0x0000000000000000000000000000000000000001',
      token1Address: '0x0000000000000000000000000000000000000002',
      amount0: ONE_TOKEN,
      amount1: ONE_TOKEN,
      token0PriceUsd: 300,
      token1PriceUsd: 3000,
      tvlUsd: 3300,
    });
    expect(guardPricedTvlUsd(pool, undefined, 2500).reason).toBeUndefined();
    expect(
      guardPricedTvlUsd(
        {...pool, token0PriceUsd: 1, token1PriceUsd: 10000, tvlUsd: 10001},
        undefined,
        2500
      )
    ).toEqual({tvlUsd: 2500, reason: 'side_imbalance'});
    const anchors = new Set([pool.token1Address]);
    expect(
      guardPricedTvlUsd(
        {
          ...pool,
          token0PriceUsd: 0.99,
          token1PriceUsd: 10000,
          tvlUsd: 10000.99,
        },
        anchors,
        2500
      )
    ).toEqual({tvlUsd: 10000.99, reason: undefined});
    expect(
      guardPricedTvlUsd(
        {...pool, token0PriceUsd: 2500, token1PriceUsd: null, tvlUsd: 2500},
        anchors,
        2500
      )
    ).toEqual({tvlUsd: 2500, reason: undefined});
  });

  it('never raises TVL or lowers it below the cap floor across side values and anchors', () => {
    const values = [null, 0, 0.99, 1, 2, 100, 2500, 50000, 1e9];
    const capUsd = 5000;
    for (const usd0 of values) {
      for (const usd1 of values) {
        for (const anchors of [
          undefined,
          new Set<string>(),
          new Set(['0xa']),
        ]) {
          const raw = (usd0 ?? 0) + (usd1 ?? 0);
          const guarded = guardPricedTvlUsd(
            row({
              token0Address: '0xa',
              token1Address: '0xb',
              amount0: ONE_TOKEN,
              amount1: ONE_TOKEN,
              token0PriceUsd: usd0,
              token1PriceUsd: usd1,
              tvlUsd: raw,
            }),
            anchors,
            capUsd
          ).tvlUsd;
          expect(guarded).toBeLessThanOrEqual(raw);
          expect(guarded).toBeGreaterThanOrEqual(Math.min(raw, capUsd));
        }
      }
    }
  });
});

describe('tvlGuardAnchorTokens', () => {
  it('covers every live and candidate Aurora-primary chain, wrapped native included', () => {
    for (const chainId of [137, 5042, 10, 130, 143, 42220, 4663]) {
      const anchors = tvlGuardAnchorTokens(chainId);
      const wrappedNative = WRAPPED_NATIVE_BY_CHAIN.get(chainId);
      expect(wrappedNative, `chain ${chainId}`).toBeDefined();
      expect(anchors?.has(wrappedNative ?? ''), `chain ${chainId}`).toBe(true);
      expect(
        anchors?.has('0x0000000000000000000000000000000000000000'),
        `chain ${chainId}`
      ).toBe(true);
    }
  });
});

describe('AuroraSourcedProvider primary mode', () => {
  beforeEach(() => {
    resetAuroraPoolCountBaselinesForTesting();
  });

  const mk = (
    aurora: ISubgraphProvider<V3SubgraphPool>,
    subgraph: ISubgraphProvider<V3SubgraphPool>,
    metric: FakeMetric,
    minPoolCount = 0
  ) =>
    new AuroraSourcedProvider(
      'primary',
      aurora,
      subgraph,
      1,
      Protocol.V3,
      0.5,
      minPoolCount,
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

  it('falls back below the absolute floor on the FIRST tick and never poisons the baseline', async () => {
    const metric = new FakeMetric();
    const fivePools = Array.from({length: 5}, (_, i) => v3Pool(`0x${i}`, 10));
    const tenPools = Array.from({length: 10}, (_, i) => v3Pool(`0x${i}`, 10));

    // Tick 1 (fresh process, no ratio baseline): 5 < floor 8 → fallback.
    const first = mk(
      fakeProvider([fivePools]),
      fakeProvider<V3SubgraphPool>([[v3Pool('0x9', 1)]]),
      metric,
      8
    );
    expect((await first.getPools()).map(p => p.id)).toEqual(['0x9']);
    expect(metric.byKey('CachePools.aurora.fallback')[0]!.tags?.reason).toBe(
      'below_floor'
    );

    // Tick 2 recovers above the floor: served, and the rejected 5-count must
    // not have become the ratio baseline (10 vs baseline 5 would still pass,
    // but a later 4-count against a poisoned 5-baseline would NOT fire the
    // ratio guard — the floor result must leave the baseline unset).
    const second = mk(
      fakeProvider([tenPools]),
      fakeProvider<V3SubgraphPool>([[v3Pool('0x9', 1)]]),
      metric,
      8
    );
    expect(await second.getPools()).toHaveLength(10);
    expect(metric.byKey('CachePools.aurora.served')).toHaveLength(1);
  });

  it('applies no absolute floor when the target has no entry', async () => {
    const metric = new FakeMetric();
    const provider = mk(
      fakeProvider([[v3Pool('0x1', 10)]]),
      fakeProvider<V3SubgraphPool>([[v3Pool('0x9', 1)]]),
      metric,
      0
    );
    expect((await provider.getPools()).map(p => p.id)).toEqual(['0x1']);
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
      0,
      noopLogger,
      metric
    );

  afterEach(settlePendingAuroraShadowsForTesting);

  it('returns the subgraph result and emits parity metrics', async () => {
    const aurora = fakeProvider([[v3Pool('0x1', 100)]]);
    const subgraph = fakeProvider([[v3Pool('0x1', 100), v3Pool('0x2', 50)]]);
    const metric = new FakeMetric();

    const pools = await mk(aurora, subgraph, metric).getPools();
    await settlePendingAuroraShadowsForTesting();
    expect(pools).toHaveLength(2);
    expect(metric.byKey('CachePools.parity.subgraph_count')[0]!.value).toBe(2);
    expect(metric.byKey('CachePools.parity.aurora_count')[0]!.value).toBe(1);
    expect(metric.byKey('CachePools.parity.jaccard_bps')[0]!.value).toBe(5000);
  });

  it('emits the live top-100 gap next to the raw one', async () => {
    const drained = {...v3Pool('0x9', 5000), liquidity: '0'};
    const aurora = fakeProvider([[v3Pool('0x1', 100)]]);
    const subgraph = fakeProvider([[drained, v3Pool('0x1', 100)]]);
    const metric = new FakeMetric();

    await mk(aurora, subgraph, metric).getPools();
    await settlePendingAuroraShadowsForTesting();
    expect(metric.byKey('CachePools.parity.missing_top100')[0]!.value).toBe(1);
    expect(metric.byKey('CachePools.parity.missing_top100_live')).toEqual([
      {
        key: 'CachePools.parity.missing_top100_live',
        value: 0,
        tags: {chainId: '1', protocol: String(Protocol.V3), mode: 'shadow'},
      },
    ]);
  });

  it('emits the reverse top-100 gap and the top-100 drift with the shadow tags', async () => {
    const junk = v3Pool('0xjunk', 27.6e9);
    const aurora = fakeProvider([[junk, v3Pool('0x1', 50)]]);
    const subgraph = fakeProvider([[v3Pool('0x1', 100)]]);
    const metric = new FakeMetric();

    await mk(aurora, subgraph, metric).getPools();
    await settlePendingAuroraShadowsForTesting();
    const tags = {chainId: '1', protocol: String(Protocol.V3), mode: 'shadow'};
    expect(metric.byKey('CachePools.parity.missing_top100')[0]!.value).toBe(0);
    expect(metric.byKey('CachePools.parity.extra_top100')).toEqual([
      {key: 'CachePools.parity.extra_top100', value: 1, tags},
    ]);
    expect(metric.byKey('CachePools.parity.tvl_drift_bps_top100_p50')).toEqual([
      {key: 'CachePools.parity.tvl_drift_bps_top100_p50', value: 5000, tags},
    ]);
    // A gauge: a unit-less putMetric would land as an unallowlisted `.dist`.
    expect(
      metric.gaugeKeys.has('CachePools.parity.tvl_drift_bps_top100_p50')
    ).toBe(true);
    expect(
      metric.putMetricKeys.has('CachePools.parity.tvl_drift_bps_top100_p50')
    ).toBe(false);
  });

  it('does not emit the top-100 drift gauge without a drift sample', async () => {
    const aurora = fakeProvider([[v3Pool('0x1', 1e9)]]);
    const subgraph = fakeProvider([[v3Pool('0x1', 0)]]);
    const metric = new FakeMetric();

    await mk(aurora, subgraph, metric).getPools();
    await settlePendingAuroraShadowsForTesting();
    expect(metric.byKey('CachePools.parity.extra_top100')).toHaveLength(1);
    expect(
      metric.byKey('CachePools.parity.tvl_drift_bps_top100_p50')
    ).toHaveLength(0);
  });

  it('counts a zero-liquidity pool of a registered TVL-bypass hook in the live gap', async () => {
    const robinhood = 4663;
    const bypassHook = [...getTvlBypassHookAddresses(robinhood)!][0]!;
    const hookPool = v4Pool(
      '0xf1',
      0,
      bypassHook.toUpperCase().replace('0X', '0x'),
      '0'
    );
    const shared = v4Pool('0xf2', 100, ADDRESS_ZERO, '7');
    const metric = new FakeMetric();
    const provider = new AuroraSourcedProvider(
      'shadow',
      fakeProvider([[shared]]),
      fakeProvider([[hookPool, shared]]),
      robinhood,
      Protocol.V4,
      0.5,
      0,
      noopLogger,
      metric
    );

    await provider.getPools();
    await settlePendingAuroraShadowsForTesting();
    expect(
      metric.byKey('CachePools.parity.missing_top100_live')[0]!.value
    ).toBe(1);
  });

  it('still returns the subgraph result when the Aurora fetch fails', async () => {
    const aurora = fakeProvider<V3SubgraphPool>([new Error('boom')]);
    const subgraph = fakeProvider([[v3Pool('0x2', 50)]]);
    const metric = new FakeMetric();

    const pools = await mk(aurora, subgraph, metric).getPools();
    await settlePendingAuroraShadowsForTesting();
    expect(pools.map(p => p.id)).toEqual(['0x2']);
    expect(metric.byKey('CachePools.aurora.shadow_error')).toHaveLength(1);
    expect(metric.byKey('CachePools.parity.subgraph_count')).toHaveLength(0);
  });

  it('names the failing combo in the shadow fetch failure log', async () => {
    const warnings: Array<{message: string; fields: unknown}> = [];
    const logger: Logger = {
      ...noopLogger,
      warn: (message, fields) => warnings.push({message, fields}),
    };
    const provider = new AuroraSourcedProvider(
      'shadow',
      fakeProvider<V3SubgraphPool>([
        new Error('canceling statement due to statement timeout'),
      ]),
      fakeProvider([[v3Pool('0x2', 50)]]),
      42161,
      Protocol.V3,
      0.5,
      0,
      logger,
      new FakeMetric()
    );

    await provider.getPools();
    await settlePendingAuroraShadowsForTesting();
    expect(warnings).toEqual([
      {
        message: 'Aurora shadow fetch failed',
        fields: {
          target: '42161:V3',
          error: 'canceling statement due to statement timeout',
        },
      },
    ]);
  });

  it('returns the subgraph result without waiting for a slow Aurora fetch', async () => {
    const aurora = deferredProvider<V3SubgraphPool>();
    const subgraph = fakeProvider([[v3Pool('0x1', 100), v3Pool('0x2', 50)]]);
    const metric = new FakeMetric();

    const pools = await mk(aurora, subgraph, metric).getPools();
    expect(pools).toHaveLength(2);
    expect(metric.byKey('CachePools.parity.subgraph_count')).toHaveLength(0);

    aurora.resolve([v3Pool('0x1', 100)]);
    await settlePendingAuroraShadowsForTesting();
    expect(metric.byKey('CachePools.parity.subgraph_count')[0]!.value).toBe(2);
    expect(metric.byKey('CachePools.parity.aurora_count')[0]!.value).toBe(1);
  });

  it('counts an Aurora failure that lands after the job returned', async () => {
    const aurora = deferredProvider<V3SubgraphPool>();
    const subgraph = fakeProvider([[v3Pool('0x2', 50)]]);
    const metric = new FakeMetric();

    await mk(aurora, subgraph, metric).getPools();
    aurora.reject(new Error('canceling statement due to statement timeout'));
    await settlePendingAuroraShadowsForTesting();
    expect(metric.byKey('CachePools.aurora.shadow_error')).toHaveLength(1);
  });

  it('skips a combo whose previous shadow comparison is still pending, across provider instances', async () => {
    const slowAurora = deferredProvider<V3SubgraphPool>();
    const metric = new FakeMetric();
    await mk(slowAurora, fakeProvider([[v3Pool('0x1', 1)]]), metric).getPools();

    // The next tick rebuilds the provider; the combo's earlier read is still
    // queued, so this tick must not add a second one behind it.
    const nextAurora = fakeProvider([[v3Pool('0x1', 1)]]);
    const pools = await mk(
      nextAurora,
      fakeProvider([[v3Pool('0x9', 1)]]),
      metric
    ).getPools();
    expect(pools.map(p => p.id)).toEqual(['0x9']);
    expect(nextAurora.calls).toBe(0);
    expect(metric.byKey('CachePools.aurora.shadow_skipped')).toEqual([
      {
        key: 'CachePools.aurora.shadow_skipped',
        value: 1,
        tags: {
          chainId: '1',
          protocol: String(Protocol.V3),
          mode: 'shadow',
          reason: 'previous_pending',
        },
      },
    ]);

    // Once the earlier comparison settles, the combo shadows again.
    slowAurora.resolve([v3Pool('0x1', 1)]);
    await settlePendingAuroraShadowsForTesting();
    await mk(nextAurora, fakeProvider([[v3Pool('0x9', 1)]]), metric).getPools();
    expect(nextAurora.calls).toBe(1);
  });

  it('rejects with the subgraph error and emits no shadow metrics', async () => {
    const aurora = fakeProvider([[v3Pool('0x1', 1)]]);
    const subgraph = fakeProvider<V3SubgraphPool>([new Error('subgraph 502')]);
    const metric = new FakeMetric();

    await expect(mk(aurora, subgraph, metric).getPools()).rejects.toThrow(
      'subgraph 502'
    );
    await settlePendingAuroraShadowsForTesting();
    expect(metric.byKey('CachePools.aurora.shadow_error')).toHaveLength(0);
    expect(metric.byKey('CachePools.parity.subgraph_count')).toHaveLength(0);
  });
});

describe('AuroraV4PoolsProvider', () => {
  const ROBINHOOD = 4663;
  const ROBINHOOD_WRAPPED_NATIVE = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
  const ROBINHOOD_WRAPPED_NATIVE_KEY =
    '4663_0x0bd7d308f8e1639fab988df18a8011f41eacad73';

  function v4Row(
    overrides: Partial<{
      poolId: string;
      token0Address: string;
      token1Address: string;
      liquidity: string;
      tvlUsd: number;
      hooksAddress: string | null;
      feeBips: number;
      tickSpacing: number;
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
      token1Address:
        overrides.token1Address ?? '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      feeBips: overrides.feeBips ?? 3000,
      tickSpacing: overrides.tickSpacing ?? 60,
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

  it.each([false, true])(
    'serves V4 junk TVL with apply=%s, including malformed empty sides',
    async apply => {
      const metric = new FakeMetric();
      const rows = ['0', 'malformed'].map((amount, index) =>
        v4Row({
          poolId: `0xjunk${index}`,
          token0Address: '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
          token1Address: '0x0000000000000000000000000000000000000bad',
          tvlToken0: amount,
          tvlToken1: '40000000000',
          token0PriceUsd: 2000,
          token1PriceUsd: 1,
          tvlUsd: 40000,
        })
      );
      const pools = await new AuroraV4PoolsProvider(
        ROBINHOOD,
        0.01,
        {
          routablePools: new FakeV4RoutablePools(rows),
          prices: freshPrices(),
          logger: noopLogger,
          metric,
        },
        undefined,
        apply
      ).getPools();
      expect(pools.map(pool => pool.tvlUSD)).toEqual([
        apply ? 2500 : 40000,
        apply ? 2500 : 40000,
      ]);
      if (!apply) {
        expect(pools.map(pool => pool.tvlETH)).toEqual([20, 20]);
      }
      expect(metric.byKey('CachePools.aurora.tvl_guarded')).toEqual([
        expect.objectContaining({
          value: 2,
          tags: expect.objectContaining({
            reason: 'unanchored_one_side',
            applied: String(apply),
          }),
        }),
      ]);
    }
  );

  it('keeps a V4 threshold-family pool admitted when the native price raises the cap', async () => {
    const row = v4Row({
      poolId: '0xhighprice',
      token0Address: ROBINHOOD_WRAPPED_NATIVE,
      token1Address: '0x0000000000000000000000000000000000000bad',
      liquidity: '0',
      tvlToken0: '0',
      tvlToken1: '40000000000',
      token0PriceUsd: 250000,
      token1PriceUsd: 1,
      tvlUsd: 40000,
    });
    const pools = await new AuroraV4PoolsProvider(
      ROBINHOOD,
      0.01,
      {
        routablePools: new FakeV4RoutablePools([row]),
        prices: freshPrices(250000),
        logger: noopLogger,
        metric: new FakeMetric(),
      },
      undefined,
      true
    ).getPools();
    expect(pools.map(pool => [pool.id, pool.tvlUSD, pool.tvlETH])).toEqual([
      ['0xhighprice', 5000, 0.02],
    ]);
  });

  it('wires listed V3 into apply mode and unlisted V4 into shadow from env through provider wrapping', async () => {
    const keys = [
      'POOL_CACHING_AURORA_PRIMARY_TARGETS',
      'POOL_CACHING_AURORA_MIN_POOL_COUNT_BY_TARGET',
      'POOL_CACHING_AURORA_TVL_GUARD_TARGETS',
    ];
    const saved = new Map(keys.map(key => [key, process.env[key]]));
    const junkV4 = v4Row({
      poolId: '0xv4',
      token0Address: '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
      token1Address: '0x0000000000000000000000000000000000000bad',
      tvlToken0: '0',
      tvlToken1: '40000000000',
      token0PriceUsd: 2000,
      token1PriceUsd: 1,
      tvlUsd: 40000,
    });
    class FakeRoutablePools
      implements
        Pick<
          RoutablePoolsService,
          | 'listAllV2RoutablePools'
          | 'listAllV3RoutablePools'
          | 'listAllV4RoutablePools'
        >
    {
      async listAllV2RoutablePools() {
        return [];
      }
      async listAllV3RoutablePools() {
        return [{...junkV4, poolAddress: '0xv3', feeTier: 3000}];
      }
      async listAllV4RoutablePools() {
        return [junkV4];
      }
    }
    try {
      process.env.POOL_CACHING_AURORA_PRIMARY_TARGETS = '4663:V3,4663:V4';
      process.env.POOL_CACHING_AURORA_MIN_POOL_COUNT_BY_TARGET =
        '{"4663:V3":1,"4663:V4":1}';
      process.env.POOL_CACHING_AURORA_TVL_GUARD_TARGETS = '4663:v3';
      resetAuroraPoolCountBaselinesForTesting();
      const metric = new FakeMetric();
      const chainProtocols = [
        {
          chainId: ROBINHOOD,
          protocol: Protocol.V3,
          provider: fakeProvider<V3SubgraphPool>([[]]),
        },
        {
          chainId: ROBINHOOD,
          protocol: Protocol.V4,
          provider: fakeProvider<V4SubgraphPool>([[]]),
        },
      ];
      applyAuroraPoolSources(
        chainProtocols,
        {trackedEthThresholdFor: () => 0.01, untrackedUsdThresholdFor: () => 0},
        noopLogger,
        metric,
        {
          scopedRun: true,
          providerDeps: {
            routablePools: new FakeRoutablePools(),
            prices: freshPrices(),
            logger: noopLogger,
            metric,
          },
        }
      );
      const v3Pools = await chainProtocols[0].provider.getPools();
      const v4Pools = await chainProtocols[1].provider.getPools();
      expect(v3Pools[0]?.tvlUSD).toBe(2500);
      expect(v4Pools[0]?.tvlUSD).toBe(40000);
      expect(metric.byKey('CachePools.aurora.tvl_guarded')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            tags: expect.objectContaining({
              protocol: String(Protocol.V3),
              applied: 'true',
            }),
          }),
          expect.objectContaining({
            tags: expect.objectContaining({
              protocol: String(Protocol.V4),
              applied: 'false',
            }),
          }),
        ])
      );
    } finally {
      for (const key of keys) {
        const value = saved.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('serves raw values from every wrapped protocol when guard targets are unset', async () => {
    const keys = [
      'POOL_CACHING_AURORA_PRIMARY_TARGETS',
      'POOL_CACHING_AURORA_MIN_POOL_COUNT_BY_TARGET',
      'POOL_CACHING_AURORA_TVL_GUARD_TARGETS',
    ];
    const saved = new Map(keys.map(key => [key, process.env[key]]));
    const junk = v4Row({
      poolId: '0xv4',
      token0Address: ROBINHOOD_WRAPPED_NATIVE,
      token1Address: '0x0000000000000000000000000000000000000bad',
      tvlToken0: '0',
      tvlToken1: '40000000000',
      token0PriceUsd: 2000,
      token1PriceUsd: 1,
      tvlUsd: 40000,
    });
    class FakeRoutablePools
      implements
        Pick<
          RoutablePoolsService,
          | 'listAllV2RoutablePools'
          | 'listAllV3RoutablePools'
          | 'listAllV4RoutablePools'
        >
    {
      async listAllV2RoutablePools() {
        return [
          {
            pairAddress: '0xv2',
            token0Address: junk.token0Address,
            token1Address: junk.token1Address,
            reserve0: '0',
            reserve1: '40000000000',
            totalSupply: '1000000000000000000',
            tvlUsd: 40000,
            token0PriceUsd: 2000,
            token1PriceUsd: 1,
            token0HasStalePrice: false,
            token1HasStalePrice: false,
            token0Decimals: 18,
            token1Decimals: 6,
            token0Symbol: 'WETH',
            token1Symbol: 'JUNK',
            token0Name: 'Wrapped Ether',
            token1Name: 'Junk',
            stateAsOfTimestamp: new Date(),
          },
        ];
      }
      async listAllV3RoutablePools() {
        return [{...junk, poolAddress: '0xv3', feeTier: 3000}];
      }
      async listAllV4RoutablePools() {
        return [junk];
      }
    }
    try {
      process.env.POOL_CACHING_AURORA_PRIMARY_TARGETS =
        '4663:V2,4663:V3,4663:V4';
      process.env.POOL_CACHING_AURORA_MIN_POOL_COUNT_BY_TARGET =
        '{"4663:V2":1,"4663:V3":1,"4663:V4":1}';
      delete process.env.POOL_CACHING_AURORA_TVL_GUARD_TARGETS;
      resetAuroraPoolCountBaselinesForTesting();
      const metric = new FakeMetric();
      const v2Target = {
        chainId: ROBINHOOD,
        protocol: Protocol.V2,
        provider: fakeProvider<V2SubgraphPool>([[]]),
      };
      const v3Target = {
        chainId: ROBINHOOD,
        protocol: Protocol.V3,
        provider: fakeProvider<V3SubgraphPool>([[]]),
      };
      const v4Target = {
        chainId: ROBINHOOD,
        protocol: Protocol.V4,
        provider: fakeProvider<V4SubgraphPool>([[]]),
      };
      const chainProtocols = [v2Target, v3Target, v4Target];
      applyAuroraPoolSources(
        chainProtocols,
        {trackedEthThresholdFor: () => 0.01, untrackedUsdThresholdFor: () => 0},
        noopLogger,
        metric,
        {
          scopedRun: true,
          providerDeps: {
            routablePools: new FakeRoutablePools(),
            prices: freshPrices(),
            logger: noopLogger,
            metric,
          },
        }
      );
      const v2Pools = await v2Target.provider.getPools();
      const v3Pools = await v3Target.provider.getPools();
      const v4Pools = await v4Target.provider.getPools();
      expect(v2Pools[0]?.reserveUSD).toBe(40000);
      expect(v2Pools[0]?.reserve).toBe(20);
      expect(v3Pools[0]?.tvlUSD).toBe(40000);
      expect(v3Pools[0]?.tvlETH).toBe(20);
      expect(v4Pools[0]?.tvlUSD).toBe(40000);
      expect(v4Pools[0]?.tvlETH).toBe(20);
    } finally {
      for (const key of keys) {
        const value = saved.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

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
    const metric = new FakeMetric();
    const provider = new AuroraV4PoolsProvider(ROBINHOOD, 0.01, {
      routablePools: {
        listAllV4RoutablePools: async (_ctx, options) => {
          capturedMinTvlUsd = options.minTvlUsd;
          return rows;
        },
      },
      prices: freshPrices(),
      logger: noopLogger,
      metric,
    });

    const pools = await provider.getPools();
    expect(capturedMinTvlUsd).toBe(0); // full set fetched, union applied in TS
    expect(pools.map(p => p.id).sort()).toEqual(['0xa1', '0xa2', '0xa5']);
    const families = metric.byKey('CachePools.aurora.admitted_by_family');
    expect(families).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: 1,
          tags: expect.objectContaining({family: 'threshold'}),
        }),
        expect.objectContaining({
          value: 1,
          tags: expect.objectContaining({family: 'liquidity_band'}),
        }),
        expect.objectContaining({
          value: 1,
          tags: expect.objectContaining({family: 'bypass_hook'}),
        }),
        expect.objectContaining({
          value: 0,
          tags: expect.objectContaining({family: 'permissioned'}),
        }),
      ])
    );
  });

  it('admits the zero-TVL ETH/WETH pool under a WETH wrapper hook, as Aurora stores it', async () => {
    const ARBITRUM = 42161;
    const wrappedNative = WRAPPED_NATIVE_BY_CHAIN.get(ARBITRUM)!;
    // Prod v4_pool_metadata row for Arbitrum's ETH/WETH wrapper pool
    // (0xc1c77784…, 2026-09-28): checksummed hooks_address, zero PoolManager
    // liquidity and zero measured TVL, because the hook wraps 1:1.
    const rows = [
      v4Row({
        poolId:
          '0xc1c777843809a8e77a398fd79ecddcefbdad6a5676003ae2eedf3a33a56589e9',
        tvlUsd: 0,
        liquidity: '0',
        hooksAddress: '0x2A4aDf825Bd96598487dBb6b2d8D882A4EB86888',
      }),
      // Same zero state without the hook: nothing admits it.
      v4Row({poolId: '0xb1', tvlUsd: 0, liquidity: '0', hooksAddress: null}),
    ];
    const provider = new AuroraV4PoolsProvider(ARBITRUM, 0.01, {
      routablePools: {listAllV4RoutablePools: async () => rows},
      prices: {
        batchGet: async () =>
          new Map([
            [
              `${ARBITRUM}_${wrappedNative.toLowerCase()}`,
              {
                chainId: ARBITRUM,
                tokenAddress: undefined as never,
                priceUsd: 2000,
                timestamp: new Date(),
                updatedAt: new Date(),
              },
            ],
          ]),
      },
      logger: noopLogger,
      metric: new FakeMetric(),
    });

    const pools = await provider.getPools();
    expect(pools.map(p => p.id)).toEqual([
      '0xc1c777843809a8e77a398fd79ecddcefbdad6a5676003ae2eedf3a33a56589e9',
    ]);
  });

  it('admits only bounded canonical permissioned-hook pairs', async () => {
    const chainId = 1;
    const hook = '0x0000000000000000000000000000000000000abc';
    const adapter = '0x0000000000000000000000000000000000000a11';
    const major = '0x0000000000000000000000000000000000000b22';
    const unknown = '0x0000000000000000000000000000000000000c33';
    const deps = {
      permissionedHookAddresses: () => [hook],
      permissionedAdapterTokens: () => [adapter],
      majorTokens: () => [major],
    };
    const mkProvider = (row: ReturnType<typeof v4Row>) =>
      new AuroraV4PoolsProvider(
        chainId,
        0.01,
        {
          routablePools: {listAllV4RoutablePools: async () => [row]},
          prices: {
            batchGet: async () =>
              new Map([
                [
                  '1_0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
                  {
                    chainId,
                    tokenAddress: undefined as never,
                    priceUsd: 2000,
                    timestamp: new Date(),
                    updatedAt: new Date(),
                  },
                ],
              ]),
          },
          logger: noopLogger,
          metric: new FakeMetric(),
        },
        deps
      );
    const admitted = v4Row({
      hooksAddress: hook.toUpperCase(),
      token0Address: adapter,
      token1Address: major,
      tvlUsd: 0,
      liquidity: '1',
    });
    await expect(mkProvider(admitted).getPools()).resolves.toHaveLength(1);
    await expect(
      mkProvider({
        ...admitted,
        token0Address: major,
        token1Address: adapter,
      }).getPools()
    ).resolves.toHaveLength(1);
    await expect(
      mkProvider({...admitted, token1Address: adapter}).getPools()
    ).resolves.toHaveLength(1);
    await expect(
      mkProvider({...admitted, hooksAddress: unknown}).getPools()
    ).resolves.toHaveLength(0);
    await expect(
      mkProvider({
        ...admitted,
        token0Address: major,
        token1Address: major,
      }).getPools()
    ).resolves.toHaveLength(0);
    await expect(
      mkProvider({...admitted, token1Address: unknown}).getPools()
    ).resolves.toHaveLength(0);
    await expect(
      mkProvider({...admitted, feeBips: 42}).getPools()
    ).resolves.toHaveLength(0);
    await expect(
      mkProvider({...admitted, tickSpacing: 42}).getPools()
    ).resolves.toHaveLength(0);
    await expect(
      mkProvider({...admitted, liquidity: '0'}).getPools()
    ).resolves.toHaveLength(0);
  });

  it('admits a dynamic ZLCA hook through the live bypass registry', async () => {
    const chainId = 1;
    const hook = '0x0000000000000000000000000000000000000d44';
    setDynamicZlcaHooks(chainId, new Map([[hook, 1n]]));
    try {
      const provider = new AuroraV4PoolsProvider(chainId, 0.01, {
        routablePools: {
          listAllV4RoutablePools: async () => [
            v4Row({hooksAddress: hook, tvlUsd: 0, liquidity: '0'}),
          ],
        },
        prices: {
          batchGet: async () =>
            new Map([
              [
                '1_0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
                {
                  chainId,
                  tokenAddress: undefined as never,
                  priceUsd: 2000,
                  timestamp: new Date(),
                  updatedAt: new Date(),
                },
              ],
            ]),
        },
        logger: noopLogger,
        metric: new FakeMetric(),
      });
      await expect(provider.getPools()).resolves.toHaveLength(1);
    } finally {
      resetDynamicZlcaHooksForTest();
    }
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
        listAllV4RoutablePools: async () => [],
      },
      prices: {batchGet: async () => new Map()},
      logger: noopLogger,
      metric: new FakeMetric(),
    });
    await expect(provider.getPools()).rejects.toThrow(/native token price/);
  });

  it('throws for chains without a known wrapped-native address', async () => {
    const provider = new AuroraV4PoolsProvider(999999, 0.01, {
      routablePools: {
        listAllV4RoutablePools: async () => [],
      },
      prices: {batchGet: async () => new Map()},
      logger: noopLogger,
      metric: new FakeMetric(),
    });
    await expect(provider.getPools()).rejects.toThrow(/wrapped-native/);
  });
});

describe('AuroraV3PoolsProvider', () => {
  const ROBINHOOD = 4663;
  const ROBINHOOD_WRAPPED_NATIVE = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
  const ROBINHOOD_WRAPPED_NATIVE_KEY = `4663_${ROBINHOOD_WRAPPED_NATIVE}`;

  function v3Row(
    overrides: Partial<{
      poolAddress: string;
      token0Address: string;
      liquidity: string;
      tvlUsd: number;
      sqrtPriceX96: string;
      tvlToken1: string;
      token0PriceUsd: number | null;
    }>
  ) {
    return {
      poolAddress: overrides.poolAddress ?? '0xPOOL',
      token0Address:
        overrides.token0Address ?? '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      token1Address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      feeTier: 3000,
      tickSpacing: 60,
      liquidity: overrides.liquidity ?? '42',
      tvlUsd: overrides.tvlUsd ?? 4000,
      // sqrtPrice 0 disables implied pricing unless a test opts in.
      sqrtPriceX96: overrides.sqrtPriceX96 ?? '0',
      tvlToken0: '0',
      tvlToken1: overrides.tvlToken1 ?? '0',
      token0PriceUsd:
        overrides.token0PriceUsd !== undefined
          ? overrides.token0PriceUsd
          : null,
      token1PriceUsd: null,
      token0Decimals: 18,
      token1Decimals: 6,
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

  const mkProvider = (
    rows: ReturnType<typeof v3Row>[],
    metric = new FakeMetric()
  ) =>
    new AuroraV3PoolsProvider(ROBINHOOD, 0.01, {
      routablePools: {listAllV3RoutablePools: async () => rows},
      prices: freshPrices(),
      logger: noopLogger,
      metric,
    });

  it('replicates the V3 admission union (threshold / exact-zero-TVL with liquidity)', async () => {
    // Native price 2000 → tvlETH = tvlUsd / 2000.
    const rows = [
      // (a) above tracked threshold (0.01 ETH = $20): kept
      v3Row({poolAddress: '0xA1', tvlUsd: 4000, liquidity: '42'}),
      // (b) EXACT zero raw TVL with liquidity: kept ("V3 zero ETH pools")
      v3Row({poolAddress: '0xA2', tvlUsd: 0, liquidity: '1'}),
      // Small nonzero TVL below threshold + liquidity: DROPPED — V3 has no
      // (0, threshold) band, unlike V4's V4_MIN_TVL_ETH family.
      v3Row({poolAddress: '0xA3', tvlUsd: 10, liquidity: '9'}),
      // Zero TVL without liquidity: dropped
      v3Row({poolAddress: '0xA4', tvlUsd: 0, liquidity: '0'}),
    ];
    const metric = new FakeMetric();
    const pools = await mkProvider(rows, metric).getPools();
    expect(pools.map(p => p.id).sort()).toEqual(['0xa1', '0xa2']);
    const a1 = pools.find(p => p.id === '0xa1')!;
    expect(a1.feeTier).toBe('3000');
    expect(a1.token0.id).toBe('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2');
    expect(a1.tvlETH).toBeCloseTo(2, 9);
    expect(a1.tvlUSD).toBe(4000);
    expect(metric.byKey('CachePools.aurora.admitted_by_family')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: 1,
          tags: expect.objectContaining({family: 'threshold'}),
        }),
        expect.objectContaining({
          value: 1,
          tags: expect.objectContaining({family: 'exact_zero'}),
        }),
      ])
    );
  });

  it('admits a launchpad-shaped pool via implied pricing and counts only flips', async () => {
    const metric = new FakeMetric();
    const rows = [
      // Raw $1 (fails (a); fails (b) since raw != 0). Token0 = wrapped
      // native (a designated implied source) priced $2000; token1 unpriced;
      // sqrtPrice 2^96 with 1e17 raw token1 → implied ≈ $200 → admitted.
      v3Row({
        poolAddress: '0xF1',
        tvlUsd: 1,
        liquidity: '7',
        token0Address: ROBINHOOD_WRAPPED_NATIVE,
        token0PriceUsd: 2000,
        sqrtPriceX96: '79228162514264337593543950336',
        tvlToken1: '100000000000000000',
      }),
      // Same implied ingredients but raw tvlUsd = 0 with liquidity: admitted
      // via family (b) either way → NOT a flip.
      v3Row({
        poolAddress: '0xF2',
        tvlUsd: 0,
        liquidity: '7',
        token0Address: ROBINHOOD_WRAPPED_NATIVE,
        token0PriceUsd: 2000,
        sqrtPriceX96: '79228162514264337593543950336',
        tvlToken1: '100000000000000000',
      }),
    ];
    const pools = await mkProvider(rows, metric).getPools();
    expect(pools.map(p => p.id).sort()).toEqual(['0xf1', '0xf2']);
    const flips = metric.byKey('CachePools.aurora.implied_priced');
    expect(flips).toHaveLength(1);
    expect(flips[0]!.value).toBe(1);
    expect(flips[0]!.tags?.protocol).toBe(String(Protocol.V3));
  });

  it.each([false, true])(
    'serves V3 junk TVL with apply=%s and counts the guard',
    async apply => {
      // Polygon V3 WPOL/"BTC" (prod: WPOL side 0, "BTC" side $5.7B) next to a
      // real WPOL/USDC pool. WPOL is Polygon's wrapped native, priced $0.2.
      const POLYGON = 137;
      const WPOL = '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270';
      const junk = {
        ...v3Row({poolAddress: '0x6871AC26595F6128bb15d4C6344D55Ff1BbB7e06'}),
        token0Address: WPOL,
        token1Address: '0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6',
        tvlUsd: 5701837764,
        tvlToken0: '0',
        tvlToken1: '100000000',
        token0PriceUsd: 0.2,
        token1PriceUsd: 57.01837764,
        token0Decimals: 18,
        token1Decimals: 0,
      };
      const real = {
        ...v3Row({poolAddress: '0xREAL'}),
        token0Address: WPOL,
        token1Address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
        tvlUsd: 2000,
        tvlToken0: '5000000000000000000000',
        tvlToken1: '1000000000',
        token0PriceUsd: 0.2,
        token1PriceUsd: 1,
        token0Decimals: 18,
        token1Decimals: 6,
      };
      const wpolKey = `${POLYGON}_0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270`;
      const metric = new FakeMetric();
      const pools = await new AuroraV3PoolsProvider(
        POLYGON,
        0.01,
        {
          routablePools: new FakeV3RoutablePools([junk, real]),
          prices: {
            batchGet: async () =>
              new Map([
                [
                  wpolKey,
                  {
                    chainId: POLYGON,
                    tokenAddress: undefined as never,
                    priceUsd: 0.2,
                    timestamp: new Date(),
                    updatedAt: new Date(),
                  },
                ],
              ]),
          },
          logger: noopLogger,
          metric,
        },
        apply
      ).getPools();

      expect(pools.map(p => [p.id, p.tvlUSD])).toEqual([
        [
          '0x6871ac26595f6128bb15d4c6344d55ff1bbb7e06',
          apply ? 2500 : 5701837764,
        ],
        ['0xreal', 2000],
      ]);
      if (!apply) {
        expect(pools.map(pool => pool.tvlETH)).toEqual([
          5701837764 / 0.2,
          2000 / 0.2,
        ]);
      }
      expect(metric.byKey('CachePools.aurora.tvl_guarded')).toEqual([
        {
          key: 'CachePools.aurora.tvl_guarded',
          value: 1,
          tags: {
            chainId: '137',
            protocol: String(Protocol.V3),
            reason: 'unanchored_one_side',
            applied: String(apply),
          },
        },
      ]);
      expect(metric.byKey('CachePools.aurora.tvl_guard_skipped')).toHaveLength(
        0
      );
      expect(
        metric.byKey('CachePools.aurora.tvl_guard_top100_displaced')
      ).toEqual([
        expect.objectContaining({
          value: 0,
          tags: expect.objectContaining({applied: String(apply)}),
        }),
      ]);
    }
  );

  it('keeps a V3 threshold-family pool admitted when the native price raises the cap', async () => {
    const row = {
      ...v3Row({poolAddress: '0xhighprice', tvlUsd: 40000}),
      token0Address: ROBINHOOD_WRAPPED_NATIVE,
      token1Address: '0x0000000000000000000000000000000000000bad',
      tvlToken0: '0',
      tvlToken1: '40000000000',
      token0PriceUsd: 250000,
      token1PriceUsd: 1,
    };
    const pools = await new AuroraV3PoolsProvider(
      ROBINHOOD,
      0.01,
      {
        routablePools: new FakeV3RoutablePools([row]),
        prices: freshPrices(250000),
        logger: noopLogger,
        metric: new FakeMetric(),
      },
      true
    ).getPools();
    expect(pools.map(pool => [pool.id, pool.tvlUSD, pool.tvlETH])).toEqual([
      ['0xhighprice', 5000, 0.02],
    ]);
  });

  it('keeps input order for guard-capped ties at the top-100 boundary', async () => {
    const normal = Array.from({length: 99}, (_, index) =>
      v3Row({poolAddress: `0xnormal${index}`, tvlUsd: 6000})
    );
    const junk = ['0xzzz0', '0xzzz1'].map(poolAddress => ({
      ...v3Row({poolAddress, tvlUsd: 40000}),
      token0Address: ROBINHOOD_WRAPPED_NATIVE,
      token1Address: '0x0000000000000000000000000000000000000bad',
      tvlToken0: '0',
      tvlToken1: '40000000000',
      token0PriceUsd: 2000,
      token1PriceUsd: 1,
    }));
    const metric = new FakeMetric();
    const pools = await new AuroraV3PoolsProvider(
      ROBINHOOD,
      0.01,
      {
        routablePools: new FakeV3RoutablePools([
          ...normal,
          ...junk,
          v3Row({poolAddress: '0xaaa', tvlUsd: 2500}),
        ]),
        prices: freshPrices(),
        logger: noopLogger,
        metric,
      },
      true
    ).getPools();
    expect(pools).toHaveLength(102);
    expect(
      metric.byKey('CachePools.aurora.tvl_guard_top100_displaced')
    ).toEqual([expect.objectContaining({value: 1})]);
  });

  it.each([false, true])(
    'reports three raw top-100 pools displaced in V3 with apply=%s',
    async apply => {
      const normal = Array.from({length: 101}, (_, index) => ({
        ...v3Row({
          poolAddress: `0xgood${String(index).padStart(3, '0')}`,
          tvlUsd: 5000,
        }),
        token0Address: ROBINHOOD_WRAPPED_NATIVE,
        tvlToken0: '2500000000000000000',
        token0PriceUsd: 2000,
      }));
      const junk = Array.from({length: 3}, (_, index) => ({
        ...v3Row({poolAddress: `0xjunk${index}`, tvlUsd: 10000}),
        token0Address: ROBINHOOD_WRAPPED_NATIVE,
        token1Address: '0x0000000000000000000000000000000000000bad',
        tvlToken0: '0',
        tvlToken1: '10000000000',
        token0PriceUsd: 2000,
        token1PriceUsd: 1,
      }));
      const metric = new FakeMetric();
      const pools = await new AuroraV3PoolsProvider(
        ROBINHOOD,
        0.01,
        {
          routablePools: new FakeV3RoutablePools([...normal, ...junk]),
          prices: freshPrices(),
          logger: noopLogger,
          metric,
        },
        apply
      ).getPools();
      expect(pools).toHaveLength(104);
      expect(
        metric.byKey('CachePools.aurora.tvl_guard_top100_displaced')
      ).toEqual([
        expect.objectContaining({
          value: 3,
          tags: {
            chainId: String(ROBINHOOD),
            protocol: String(Protocol.V3),
            applied: String(apply),
          },
        }),
      ]);
      const unguardedMetric = new FakeMetric();
      await new AuroraV3PoolsProvider(
        ROBINHOOD,
        0.01,
        {
          routablePools: new FakeV3RoutablePools(normal),
          prices: freshPrices(),
          logger: noopLogger,
          metric: unguardedMetric,
        },
        apply
      ).getPools();
      expect(
        unguardedMetric.byKey('CachePools.aurora.tvl_guard_top100_displaced')
      ).toEqual([]);
    }
  );

  it('treats a malformed V3 side as empty and only lowers TVL in apply mode', async () => {
    const row = {
      ...v3Row({poolAddress: '0xmalformed', tvlUsd: 40000}),
      token0Address: ROBINHOOD_WRAPPED_NATIVE,
      token1Address: '0x0000000000000000000000000000000000000bad',
      tvlToken0: 'malformed',
      tvlToken1: '40000000000',
      token0PriceUsd: 2000,
      token1PriceUsd: 1,
    };
    const metric = new FakeMetric();
    const pools = await new AuroraV3PoolsProvider(
      ROBINHOOD,
      0.01,
      {
        routablePools: new FakeV3RoutablePools([row]),
        prices: freshPrices(),
        logger: noopLogger,
        metric,
      },
      true
    ).getPools();
    expect(pools[0]?.tvlUSD).toBe(2500);
    expect(metric.byKey('CachePools.aurora.tvl_guarded')).toEqual([
      expect.objectContaining({
        tags: expect.objectContaining({applied: 'true'}),
      }),
    ]);
  });

  it('throws on a stale native price (primary mode falls back upstream)', async () => {
    const staleTs = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const provider = new AuroraV3PoolsProvider(ROBINHOOD, 0.01, {
      routablePools: {listAllV3RoutablePools: async () => [v3Row({})]},
      prices: {
        batchGet: async () =>
          new Map([
            [
              ROBINHOOD_WRAPPED_NATIVE_KEY,
              {
                chainId: ROBINHOOD,
                tokenAddress: undefined as never,
                priceUsd: 2000,
                timestamp: staleTs,
                updatedAt: staleTs,
              },
            ],
          ]),
      },
      logger: noopLogger,
      metric: new FakeMetric(),
    });
    await expect(provider.getPools()).rejects.toThrow(/Stale native/);
  });
});

describe('targetKey', () => {
  it('builds CHAINID:PROTOCOL keys', () => {
    expect(targetKey(8453, Protocol.V4)).toBe('8453:V4');
  });
});

describe('AuroraV2PoolsProvider', () => {
  const CHAIN_ID_ROBINHOOD = 4663;
  const ROBINHOOD_WRAPPED_NATIVE = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
  const FEI = '0x956f47f50a910163d8bf957cf5846d573e7f87ca';
  const VIRTUAL = '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b';

  function v2Row(
    overrides: Partial<{
      pairAddress: string;
      token0Address: string;
      token1Address: string;
      totalSupply: string;
      tvlUsd: number;
      token0PriceUsd: number | null;
      token1PriceUsd: number | null;
      token0HasStalePrice: boolean;
      token1HasStalePrice: boolean;
    }> = {}
  ) {
    const tvlUsd = overrides.tvlUsd ?? 4000;
    const token0PriceUsd =
      overrides.token0PriceUsd === undefined ? 2000 : overrides.token0PriceUsd;
    const token1PriceUsd =
      overrides.token1PriceUsd === undefined ? 1 : overrides.token1PriceUsd;
    // The SQL derives tvlUsd from the reserves and prices, so the fixture
    // does too: a constant-product pair holds equal value on both sides, and
    // each priced side carries its share of tvlUsd.
    const pricedSides =
      (token0PriceUsd !== null ? 1 : 0) + (token1PriceUsd !== null ? 1 : 0);
    const sideUsd = pricedSides > 0 ? tvlUsd / pricedSides : 0;
    const rawAmount = (
      usd: number,
      priceUsd: number | null,
      decimals: number
    ) =>
      BigInt(Math.round((usd / (priceUsd ?? 1)) * 10 ** decimals)).toString();
    return {
      pairAddress: overrides.pairAddress ?? '0xPAIR',
      token0Address: overrides.token0Address ?? ROBINHOOD_WRAPPED_NATIVE,
      token1Address:
        overrides.token1Address ?? '0x0000000000000000000000000000000000000001',
      reserve0: rawAmount(sideUsd, token0PriceUsd, 18),
      reserve1: rawAmount(sideUsd, token1PriceUsd, 6),
      totalSupply: overrides.totalSupply ?? '1234500000000000000',
      tvlUsd,
      token0PriceUsd,
      token1PriceUsd,
      token0HasStalePrice: overrides.token0HasStalePrice ?? false,
      token1HasStalePrice: overrides.token1HasStalePrice ?? false,
      token0Decimals: 18,
      token1Decimals: 6,
      token0Symbol: 'WNATIVE',
      token1Symbol: 'USD',
      token0Name: 'Wrapped Native',
      token1Name: 'USD',
      stateAsOfTimestamp: new Date(),
    };
  }

  function freshNativePrice(chainId: number, priceUsd = 2000) {
    const wrappedNative = WRAPPED_NATIVE_BY_CHAIN.get(chainId)!;
    return {
      batchGet: async () =>
        new Map([
          [
            `${chainId}_${wrappedNative}`,
            {
              chainId,
              tokenAddress: undefined as never,
              priceUsd,
              timestamp: new Date(),
              updatedAt: new Date(),
            },
          ],
        ]),
    };
  }

  function provider(
    chainId: number,
    rows: ReturnType<typeof v2Row>[],
    trackedEthThreshold = 0.025,
    untrackedUsdThreshold = Number.MAX_VALUE,
    metric = new FakeMetric()
  ) {
    return new AuroraV2PoolsProvider(
      chainId,
      trackedEthThreshold,
      untrackedUsdThreshold,
      {
        routablePools: {listAllV2RoutablePools: async () => rows},
        prices: freshNativePrice(chainId),
        logger: noopLogger,
        metric,
      }
    );
  }

  it.each([false, true])(
    'serves V2 junk reserveUSD with apply=%s, including malformed empty sides',
    async apply => {
      const metric = new FakeMetric();
      const rows = ['0', 'malformed'].map((amount, index) => ({
        ...v2Row({
          pairAddress: `0xjunk${index}`,
          token1Address: '0x0000000000000000000000000000000000000bad',
          tvlUsd: 40000,
          token1PriceUsd: 1,
        }),
        reserve0: amount,
        reserve1: '40000000000',
      }));
      const pools = await new AuroraV2PoolsProvider(
        CHAIN_ID_ROBINHOOD,
        0.025,
        Number.MAX_VALUE,
        {
          routablePools: new FakeV2RoutablePools(rows),
          prices: freshNativePrice(CHAIN_ID_ROBINHOOD),
          logger: noopLogger,
          metric,
        },
        apply
      ).getPools();
      expect(pools.map(pool => pool.reserveUSD)).toEqual([
        apply ? 2500 : 40000,
        apply ? 2500 : 40000,
      ]);
      if (!apply) {
        expect(pools.map(pool => pool.reserve)).toEqual([20, 20]);
        expect(pools.map(pool => pool.reserveUSD)).toEqual([40000, 40000]);
      }
      expect(metric.byKey('CachePools.aurora.tvl_guarded')).toEqual([
        expect.objectContaining({
          value: 2,
          tags: expect.objectContaining({
            reason: 'unanchored_one_side',
            applied: String(apply),
          }),
        }),
      ]);
    }
  );

  it('keeps a V2 tracked-family pool admitted when the native price raises the cap', async () => {
    const row = {
      ...v2Row({
        pairAddress: '0xhighprice',
        token1Address: '0x0000000000000000000000000000000000000bad',
        tvlUsd: 40000,
        token0PriceUsd: 250000,
        token1PriceUsd: 1,
      }),
      reserve0: '0',
      reserve1: '40000000000',
    };
    const metric = new FakeMetric();
    const pools = await new AuroraV2PoolsProvider(
      CHAIN_ID_ROBINHOOD,
      0.01,
      Number.MAX_VALUE,
      {
        routablePools: new FakeV2RoutablePools([row]),
        prices: freshNativePrice(CHAIN_ID_ROBINHOOD, 250000),
        logger: noopLogger,
        metric,
      },
      true
    ).getPools();
    expect(pools.map(pool => [pool.id, pool.reserveUSD, pool.reserve])).toEqual(
      [['0xhighprice', 5000, 0.02]]
    );
    expect(metric.byKey('CachePools.aurora.admitted_by_family')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tags: expect.objectContaining({family: 'tracked_reserve'}),
        }),
      ])
    );
  });

  it('mirrors V2 special-case and threshold families, and maps supply/reserves', async () => {
    const metric = new FakeMetric();
    const pools = await provider(
      CHAIN_ID_ROBINHOOD,
      [
        v2Row({pairAddress: '0xFEI', token0Address: FEI, tvlUsd: 0}),
        v2Row({pairAddress: '0xTRACKED', tvlUsd: 51}), // strict > $50
        v2Row({pairAddress: '0xEQUAL', tvlUsd: 50}),
        v2Row({pairAddress: '0xVIRTUAL', token0Address: VIRTUAL, tvlUsd: 0}),
      ],
      0.025,
      Number.MAX_VALUE,
      metric
    ).getPools();

    expect(pools.map(pool => pool.id).sort()).toEqual(['0xfei', '0xtracked']);
    const tracked = pools.find(pool => pool.id === '0xtracked')!;
    expect(tracked.token0.id).toBe(ROBINHOOD_WRAPPED_NATIVE);
    expect(tracked.supply).toBeCloseTo(1.2345, 9);
    expect(tracked.reserve).toBeCloseTo(51 / 2000, 9);
    expect(tracked.reserveUSD).toBe(51);
    expect(metric.byKey('CachePools.aurora.admitted_by_family')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: 1,
          tags: expect.objectContaining({family: 'fei'}),
        }),
        expect.objectContaining({
          value: 1,
          tags: expect.objectContaining({family: 'tracked_reserve'}),
        }),
      ])
    );
  });

  it('keeps virtual-token pools Base-only and wires the otherwise inert untracked threshold', async () => {
    const basePools = await provider(8453, [
      v2Row({pairAddress: '0xVIRTUAL', token0Address: VIRTUAL, tvlUsd: 0}),
    ]).getPools();
    expect(basePools.map(pool => pool.id)).toEqual(['0xvirtual']);

    const metric = new FakeMetric();
    const untrackedPools = await provider(
      CHAIN_ID_ROBINHOOD,
      [v2Row({pairAddress: '0xUNTRACKED', tvlUsd: 101})],
      1,
      100,
      metric
    ).getPools();
    expect(untrackedPools.map(pool => pool.id)).toEqual(['0xuntracked']);
    expect(metric.byKey('CachePools.aurora.admitted_by_family')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: 1,
          tags: expect.objectContaining({family: 'untracked_usd'}),
        }),
      ])
    );
  });

  it('doubles a one-priced-side pool for admission and reserve, like trackedReserveETH, but exports the priced-side sum as reserveUSD', async () => {
    // Threshold $50-native-equivalent (0.025 * $2000). A $30 one-sided pool
    // doubles to $60 tracked and is admitted; the same value with both sides
    // priced stays $30 and is rejected; an unpriced pool tracks $0. The
    // doubling stops at admission and `reserve`: `reserveUSD` is what
    // TopPoolsSelector ranks against V3/V4, and V2SubgraphProvider fills it
    // from the subgraph's undoubled reserveUSD.
    const pools = await provider(CHAIN_ID_ROBINHOOD, [
      v2Row({
        pairAddress: '0xONESIDED',
        tvlUsd: 30,
        token1PriceUsd: null,
      }),
      v2Row({pairAddress: '0xBOTHSIDES', tvlUsd: 30}),
      v2Row({
        pairAddress: '0xUNPRICED',
        tvlUsd: 0,
        token0PriceUsd: null,
        token1PriceUsd: null,
      }),
    ]).getPools();

    expect(pools.map(pool => pool.id)).toEqual(['0xonesided']);
    expect(pools[0]!.reserve).toBeCloseTo(60 / 2000, 9);
    expect(pools[0]!.reserveUSD).toBe(30);
  });

  it('judges the untracked family on the undoubled sum, like reserveUSD_gt on the subgraph', async () => {
    // Tracked threshold out of reach (1 native = $2000), untracked threshold
    // $100. A one-sided $60 pool doubles to $120 tracked, which must not
    // sneak it past the $100 untracked bar the subgraph applies to the
    // undoubled reserveUSD; a both-sides $101 pool passes it.
    const metric = new FakeMetric();
    const pools = await provider(
      CHAIN_ID_ROBINHOOD,
      [
        v2Row({pairAddress: '0xONESIDED', tvlUsd: 60, token1PriceUsd: null}),
        v2Row({pairAddress: '0xBOTHSIDES', tvlUsd: 101}),
      ],
      1,
      100,
      metric
    ).getPools();

    expect(pools.map(pool => pool.id)).toEqual(['0xbothsides']);
    expect(pools[0]!.reserveUSD).toBe(101);
    expect(metric.byKey('CachePools.aurora.admitted_by_family')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: 1,
          tags: expect.objectContaining({family: 'untracked_usd'}),
        }),
      ])
    );
  });
});

describe('AuroraV2PoolsProvider stale-price side', () => {
  const CHAIN_ID_TEMPO = 4217;
  // Tempo TIMECOIN/USDC.e as prod Aurora stored it on 2026-09-30: TIMECOIN's
  // price row is 29.7h old, USDC.e is fresh, and the fresh side holds $12,549.
  // The subgraph reported this pair's reserveUSD as 25,098.70.
  const TIMECOIN = '0x20C00000000000000000000000000000000000A1';
  const USDC_E = '0x20C000000000000000000000B9537d11c60E8b50';

  function tempoRow(
    overrides: Partial<{
      pairAddress: string;
      tvlUsd: number;
      token0PriceUsd: number | null;
      token1PriceUsd: number | null;
      token0HasStalePrice: boolean;
      token1HasStalePrice: boolean;
      reserve0: string;
    }> = {}
  ) {
    return {
      pairAddress:
        overrides.pairAddress ?? '0x88EfeFDDEB6925b53A8D959DaD64D952d2045779',
      token0Address: TIMECOIN,
      token1Address: USDC_E,
      reserve0: overrides.reserve0 ?? '338578000000000000000000000',
      reserve1: '12549000000',
      totalSupply: '1000000000000000000',
      tvlUsd: overrides.tvlUsd ?? 12549,
      token0PriceUsd:
        overrides.token0PriceUsd === undefined
          ? null
          : overrides.token0PriceUsd,
      token1PriceUsd:
        overrides.token1PriceUsd === undefined ? 1 : overrides.token1PriceUsd,
      token0HasStalePrice: overrides.token0HasStalePrice ?? true,
      token1HasStalePrice: overrides.token1HasStalePrice ?? false,
      token0Decimals: 18,
      token1Decimals: 6,
      token0Symbol: 'TIMECOIN',
      token1Symbol: 'USDC.e',
      token0Name: 'TIMECOIN',
      token1Name: 'USDC.e',
      stateAsOfTimestamp: new Date(),
    };
  }

  function tempoProvider(
    rows: ReturnType<typeof tempoRow>[],
    trackedEthThreshold: number,
    untrackedUsdThreshold: number,
    metric = new FakeMetric(),
    applyTvlGuard = false
  ) {
    const wrappedNative = WRAPPED_NATIVE_BY_CHAIN.get(CHAIN_ID_TEMPO)!;
    return new AuroraV2PoolsProvider(
      CHAIN_ID_TEMPO,
      trackedEthThreshold,
      untrackedUsdThreshold,
      {
        routablePools: {listAllV2RoutablePools: async () => rows},
        prices: {
          batchGet: async () =>
            new Map([
              [
                `${CHAIN_ID_TEMPO}_${wrappedNative}`,
                {
                  chainId: CHAIN_ID_TEMPO,
                  tokenAddress: undefined as never,
                  priceUsd: 1,
                  timestamp: new Date(),
                  updatedAt: new Date(),
                },
              ],
            ]),
        },
        logger: noopLogger,
        metric,
      },
      applyTvlGuard
    );
  }

  it.each([false, true])(
    'feeds the selected V2 TVL into stale-side doubling with apply=%s',
    async apply => {
      const metric = new FakeMetric();
      const row = {
        ...tempoRow({tvlUsd: 40000}),
        token1Address: '0x0000000000000000000000000000000000000bad',
        reserve1: '40000000000',
      };
      const pools = await tempoProvider(
        [row],
        0,
        Number.MAX_VALUE,
        metric,
        apply
      ).getPools();
      expect(pools[0]?.reserveUSD).toBe(apply ? 5000 : 80000);
      expect(metric.byKey('CachePools.aurora.tvl_guarded')).toEqual([
        expect.objectContaining({
          tags: expect.objectContaining({applied: String(apply)}),
        }),
      ]);
    }
  );

  it('values an idle side at the fresh side, restoring the subgraph reserveUSD', async () => {
    const metric = new FakeMetric();
    const pools = await tempoProvider(
      [tempoRow()],
      0,
      Number.MAX_VALUE,
      metric
    ).getPools();

    expect(pools).toHaveLength(1);
    expect(pools[0]!.id).toBe('0x88efefddeb6925b53a8d959dad64d952d2045779');
    expect(pools[0]!.token0.id).toBe(TIMECOIN.toLowerCase());
    expect(pools[0]!.reserveUSD).toBe(25098);
    // The tracked number already doubled a one-sided pool; it does not change.
    expect(pools[0]!.reserve).toBe(25098);
    expect(metric.byKey('CachePools.aurora.implied_stale_side')).toEqual([
      {
        key: 'CachePools.aurora.implied_stale_side',
        value: 1,
        tags: {chainId: String(CHAIN_ID_TEMPO), protocol: String(Protocol.V2)},
      },
    ]);
  });

  it('keeps an idle side with a zero reserve at 0, whatever its old price row says', async () => {
    const metric = new FakeMetric();
    const pools = await tempoProvider(
      [tempoRow({reserve0: '0'})],
      0,
      Number.MAX_VALUE,
      metric
    ).getPools();

    expect(pools[0]!.reserveUSD).toBe(12549);
    expect(metric.byKey('CachePools.aurora.implied_stale_side')).toEqual([]);
  });

  it('keeps a never-priced side at 0, so the one-sided sum is not doubled', async () => {
    const metric = new FakeMetric();
    const pools = await tempoProvider(
      [tempoRow({token0HasStalePrice: false})],
      0,
      Number.MAX_VALUE,
      metric
    ).getPools();

    expect(pools[0]!.reserveUSD).toBe(12549);
    expect(metric.byKey('CachePools.aurora.implied_stale_side')).toEqual([]);
  });

  it('leaves a pair with both sides fresh unchanged', async () => {
    const pools = await tempoProvider(
      [
        tempoRow({
          token0PriceUsd: 0.00003706,
          token0HasStalePrice: false,
          tvlUsd: 25098,
        }),
      ],
      0,
      Number.MAX_VALUE
    ).getPools();

    expect(pools[0]!.reserveUSD).toBe(25098);
  });

  it('implies nothing when neither side is fresh: there is no anchor to copy', async () => {
    const metric = new FakeMetric();
    const pools = await tempoProvider(
      [tempoRow({token1PriceUsd: null, token1HasStalePrice: true, tvlUsd: 0})],
      -1,
      -1,
      metric
    ).getPools();

    expect(pools[0]!.reserveUSD).toBe(0);
    expect(metric.byKey('CachePools.aurora.implied_stale_side')).toEqual([]);
  });

  it('admits an idle pair through the untracked family on the implied value only', async () => {
    // Tracked threshold out of reach; untracked bar at $20,000. The implied
    // $25,098 clears it. The same pair with a never-priced side ($12,549)
    // does not.
    const metric = new FakeMetric();
    const pools = await tempoProvider(
      [
        tempoRow(),
        tempoRow({pairAddress: '0xNEVERPRICED', token0HasStalePrice: false}),
      ],
      Number.MAX_VALUE,
      20000,
      metric
    ).getPools();

    expect(pools.map(pool => pool.id)).toEqual([
      '0x88efefddeb6925b53a8d959dad64d952d2045779',
    ]);
    expect(metric.byKey('CachePools.aurora.admitted_by_family')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: 1,
          tags: expect.objectContaining({family: 'untracked_usd'}),
        }),
      ])
    );
  });
});

describe('AURORA_SUPPORTED_TARGETS', () => {
  it('covers exactly the V2/V3/V4 cron matrix minus Base, Ink, and Monad testnet', () => {
    // Derived from the live cron matrix so adding or removing a cron target
    // fails this test until the Aurora allowlist decision is revisited.
    const CHAIN_ID_BASE = 8453;
    const CHAIN_ID_INK = 57073;
    const CHAIN_ID_MONAD_TESTNET = 10143;
    const UNICHAIN_V2 = targetKey(130, Protocol.V2);
    const expected = new Set(
      createChainProtocols(noopLogger, new FakeMetric())
        .filter(cp =>
          [Protocol.V2, Protocol.V3, Protocol.V4].includes(cp.protocol)
        )
        .filter(
          cp =>
            cp.chainId !== CHAIN_ID_BASE &&
            cp.chainId !== CHAIN_ID_INK &&
            cp.chainId !== CHAIN_ID_MONAD_TESTNET
        )
        .map(cp => targetKey(cp.chainId, cp.protocol))
        .filter(key => key !== UNICHAIN_V2)
    );
    expect(new Set(AURORA_SUPPORTED_TARGETS)).toEqual(expected);
    for (const key of [
      '8453:V4',
      '8453:V3',
      '8453:V2',
      '57073:V4',
      '57073:V3',
      '57073:V2',
      '10143:V2',
      '130:V2',
    ]) {
      expect(AURORA_SUPPORTED_TARGETS.has(key)).toBe(false);
    }
  });
});

describe('Aurora registry lookups', () => {
  it('derives wrapped-native addresses from hardcoded chain definitions', () => {
    expect(WRAPPED_NATIVE_BY_CHAIN.get(1)).toBe(
      '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
    );
    expect(WRAPPED_NATIVE_BY_CHAIN.get(137)).toBe(
      '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270'
    );
    expect(WRAPPED_NATIVE_BY_CHAIN.get(4663)).toBe(
      '0x0bd7d308f8e1639fab988df18a8011f41eacad73'
    );
  });

  it('has a wrapped-native entry for every Aurora-supported chain', () => {
    // A supported combo without a wrapped-native address fails only at
    // runtime, as a per-tick shadow_error/init failure for that combo — this
    // pins the invariant so a future matrix addition fails HERE instead.
    const missing = [...AURORA_SUPPORTED_TARGETS]
      .map(key => Number(key.split(':')[0]))
      .filter(chainId => !WRAPPED_NATIVE_BY_CHAIN.has(chainId));
    expect(missing).toEqual([]);
  });

  it('keeps implied-price sources opt-in for Robinhood only', () => {
    expect(IMPLIED_PRICE_SOURCE_TOKENS_BY_CHAIN[4663]).toEqual(
      new Set([
        '0x0000000000000000000000000000000000000000',
        '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
        '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
      ])
    );
    expect(IMPLIED_PRICE_SOURCE_TOKENS_BY_CHAIN[1]).toBeUndefined();
  });
});
