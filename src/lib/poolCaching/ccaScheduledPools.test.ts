import {describe, it, expect, beforeEach, vi} from 'vitest';
import {GetObjectCommand, PutObjectCommand, S3Client} from '@aws-sdk/client-s3';
import {
  buildCcaScheduledPools,
  computeCcaPoolId,
  CcaScheduledPoolEntry,
  CcaScheduledPoolsWriterConfig,
  CcaScheduledPoolsWriterDeps,
  CCA_SCHEDULED_POOLS_S3_KEY,
  LbpInitializerInfo,
  PendingLbpAuction,
} from './ccaScheduledPools';
import {Logger} from './sor-providers/util/log';
import {IMetric, MetricLoggerUnit} from './sor-providers/util/metric';

const ZERO = '0x0000000000000000000000000000000000000000';
const UNI = '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984';
const AUCTION = '0xaaaa00000000000000000000000000000000aaaa';
const STRATEGY = '0xbbbb00000000000000000000000000000000bbbb';

const testLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  fatal: () => {},
};

class TestMetric extends IMetric {
  public metrics: Array<{
    key: string;
    value: number;
    tags?: Record<string, string>;
  }> = [];
  setProperty(): void {}
  putDimensions(): void {}
  putMetric(
    key: string,
    value: number,
    _unit?: MetricLoggerUnit,
    tags?: Record<string, string>
  ): void {
    this.metrics.push({key, value, tags});
  }
}

describe('computeCcaPoolId', () => {
  it('matches PoolKey.toId (keccak of sorted currencies + fee + tickSpacing + hook)', () => {
    // Precomputed via ethers keccak256(abi.encode(0x0, UNI, 10000, 200, 0x0)).
    const expected =
      '0x769e91db8fd7a01802909e8ca8de65275bd04bc7b3640d093bca453f15912f0f';
    expect(computeCcaPoolId(ZERO, UNI, 10000, 200, ZERO)).toBe(expected);
  });

  it('sorts currencies ascending regardless of argument order', () => {
    expect(computeCcaPoolId(ZERO, UNI, 500, 10, ZERO)).toBe(
      computeCcaPoolId(UNI, ZERO, 500, 10, ZERO)
    );
  });
});

describe('buildCcaScheduledPools', () => {
  const NOW = 1_800_000_000_000;
  const CURRENT_BLOCK = 1_000;

  let config: CcaScheduledPoolsWriterConfig;
  let metric: TestMetric;
  let putBodies: Map<string, string>;
  let previousObjects: Map<string, CcaScheduledPoolEntry[]>;
  let pendingAuctions: PendingLbpAuction[];
  let initializerInfo: LbpInitializerInfo;
  let deps: CcaScheduledPoolsWriterDeps;

  const makeS3 = (): S3Client =>
    ({
      send: vi.fn(async (command: GetObjectCommand | PutObjectCommand) => {
        if (command instanceof PutObjectCommand) {
          putBodies.set(command.input.Key!, command.input.Body as string);
          return {};
        }
        const previous = previousObjects.get(
          (command as GetObjectCommand).input.Key!
        );
        if (!previous) {
          const error = new Error('NoSuchKey');
          error.name = 'NoSuchKey';
          throw error;
        }
        return {
          Body: {transformToString: async () => JSON.stringify(previous)},
        };
      }),
    }) as unknown as S3Client;

  beforeEach(() => {
    metric = new TestMetric();
    putBodies = new Map();
    previousObjects = new Map();
    pendingAuctions = [
      {
        auctionId: '1-aaaa',
        chainId: 1,
        address: AUCTION,
        lbpStrategyAddress: STRATEGY,
        hasMigrated: false,
      },
    ];
    initializerInfo = {
      migrationBlock: 2_000n,
      token: UNI,
      currency: ZERO,
      fee: 10000,
      tickSpacing: 200,
      hook: ZERO,
    };
    config = {
      s3Bucket: 'pool-bucket',
      s3BaseKey: 'ccaScheduledPools.json',
      chainIds: [1],
      entryTtlAfterActivationMs: 24 * 60 * 60 * 1000,
    };
    deps = {
      s3: makeS3(),
      fetchPendingAuctions: vi.fn(async () => pendingAuctions),
      readLbpInitializer: vi.fn(async () => initializerInfo),
      getBlockNumber: vi.fn(async () => CURRENT_BLOCK),
      nowMs: () => NOW,
    };
  });

  const writtenEntries = (chainId: number): CcaScheduledPoolEntry[] => {
    const body = putBodies.get(
      CCA_SCHEDULED_POOLS_S3_KEY(config.s3BaseKey, chainId)
    );
    return body ? JSON.parse(body) : [];
  };

  it('writes an entry with the computed poolId, sorted tokens, and schedule', async () => {
    await buildCcaScheduledPools(testLogger, metric, config, deps);

    const entries = writtenEntries(1);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.id).toBe(computeCcaPoolId(ZERO, UNI, 10000, 200, ZERO));
    expect(entry.token0.id).toBe(ZERO);
    expect(entry.token1.id).toBe(UNI.toLowerCase());
    expect(entry.feeTier).toBe('10000');
    expect(entry.tickSpacing).toBe('200');
    expect(entry.hooks).toBe(ZERO);
    expect(entry.liquidity).toBe('1');
    expect(entry.tvlETH).toBe(0);
    expect(entry.migrationBlock).toBe('2000');
    expect(entry.launchedToken).toBe(UNI.toLowerCase());
    // 1000 blocks out on mainnet (12s blocks).
    expect(entry.activateAtMs).toBe(NOW + 1_000 * 12_000);
    expect(entry.expiresAtMs).toBe(
      entry.activateAtMs + config.entryTtlAfterActivationMs
    );
    expect(deps.readLbpInitializer).toHaveBeenCalledWith(1, STRATEGY, AUCTION);
  });

  it('anchors expiry at write time when migration is permitted but overdue', async () => {
    // migrationBlock long past (migrate() not run yet): activateAtMs is in
    // the past, but the entry must stay servable for a full TTL from NOW so
    // a late migrate() is still bridged.
    initializerInfo = {...initializerInfo, migrationBlock: 500n};

    await buildCcaScheduledPools(testLogger, metric, config, deps);

    const entry = writtenEntries(1)[0];
    expect(entry.activateAtMs).toBeLessThan(NOW);
    expect(entry.expiresAtMs).toBe(NOW + config.entryTtlAfterActivationMs);
  });

  it('skips auctions with migrationBlock 0 (not registered)', async () => {
    initializerInfo = {...initializerInfo, migrationBlock: 0n};

    await buildCcaScheduledPools(testLogger, metric, config, deps);

    expect(writtenEntries(1)).toHaveLength(0);
  });

  it('keeps unexpired previous entries and lets fresh entries win by poolId', async () => {
    const freshId = computeCcaPoolId(ZERO, UNI, 10000, 200, ZERO);
    const stale: CcaScheduledPoolEntry = {
      id: freshId,
      token0: {id: ZERO},
      token1: {id: UNI.toLowerCase()},
      feeTier: '10000',
      tickSpacing: '200',
      hooks: ZERO,
      liquidity: '1',
      tvlETH: 0,
      tvlUSD: 0,
      migrationBlock: '2000',
      activateAtMs: NOW - 1,
      expiresAtMs: NOW + 1000,
      auctionAddress: AUCTION,
      strategyAddress: STRATEGY,
      launchedToken: UNI.toLowerCase(),
    };
    // Activated but absent from data-api (trailing window over): must persist
    // to bridge until the subgraph serves the real pool.
    const activatedSurvivor: CcaScheduledPoolEntry = {
      ...stale,
      id: '0xother',
      auctionAddress: '0xother-auction',
    };
    const expired: CcaScheduledPoolEntry = {
      ...stale,
      id: '0xexpired',
      expiresAtMs: NOW - 1,
    };
    // Not yet activated, no longer reported by data-api, and the on-chain
    // re-verification shows a zeroed registration: reorged away — dropped.
    const reorgedAway: CcaScheduledPoolEntry = {
      ...stale,
      id: '0xreorged',
      // >1h pre-activation: a zeroed registration this far out cannot be a
      // just-consumed migration, so it qualifies for the drop verdict.
      activateAtMs: NOW + 2 * 60 * 60 * 1000,
      auctionAddress: '0xreorged-auction',
    };
    // Not yet activated, aged past data-api's 14-day pending window, but the
    // on-chain registration is still live (long-scheduled launch): REBUILT
    // with a fresh schedule (a verbatim carry-forward would let the estimate
    // drift for days).
    const LONG_TOKEN = '0x9999999999999999999999999999999999999999';
    const agedOutStillScheduled: CcaScheduledPoolEntry = {
      ...stale,
      id: computeCcaPoolId(ZERO, LONG_TOKEN, 10000, 200, ZERO).toLowerCase(),
      activateAtMs: NOW + 60_000,
      auctionAddress: '0xlongschedule-auction',
      launchedToken: LONG_TOKEN,
    };
    previousObjects.set(CCA_SCHEDULED_POOLS_S3_KEY(config.s3BaseKey, 1), [
      stale,
      activatedSurvivor,
      expired,
      reorgedAway,
      agedOutStillScheduled,
    ]);
    vi.mocked(deps.readLbpInitializer).mockImplementation(
      async (_chainId, _strategy, auctionAddress) => {
        if (auctionAddress === '0xreorged-auction') {
          return {...initializerInfo, migrationBlock: 0n};
        }
        if (auctionAddress === '0xlongschedule-auction') {
          return {
            ...initializerInfo,
            token: LONG_TOKEN,
            migrationBlock: 3_000n,
          };
        }
        if (auctionAddress === '0xother-auction') {
          // Activated bridge entry: migrate() consumed the struct.
          return {...initializerInfo, migrationBlock: 0n};
        }
        return initializerInfo;
      }
    );

    await buildCcaScheduledPools(testLogger, metric, config, deps);

    const entries = writtenEntries(1);
    expect(entries.map(e => e.id).sort()).toEqual(
      [freshId, '0xother', agedOutStillScheduled.id].sort()
    );
    // Fresh entry replaced the stale one (activateAtMs re-estimated).
    const fresh = entries.find(e => e.id === freshId)!;
    expect(fresh.activateAtMs).toBe(NOW + 1_000 * 12_000);
    // The orphan was rebuilt with a fresh estimate from its live on-chain
    // registration, not carried forward verbatim.
    const rebuilt = entries.find(e => e.id === agedOutStillScheduled.id)!;
    expect(rebuilt.activateAtMs).toBe(NOW + 2_000 * 12_000);
    expect(rebuilt.migrationBlock).toBe('3000');
  });

  it('keeps the bridge entry of a just-migrated auction whose initializers read back zeroed', async () => {
    // migrate() CONSUMES the initializers struct, so the on-chain read is 0
    // while data-api's trailing window still reports the auction with
    // pool_key_hash set. The activated previous entry is the routing bridge
    // until the subgraph serves the real pool — it must NOT be pruned.
    pendingAuctions = [{...pendingAuctions[0], hasMigrated: true}];
    initializerInfo = {...initializerInfo, migrationBlock: 0n};
    const bridgeEntry: CcaScheduledPoolEntry = {
      id: '0xbridge',
      token0: {id: ZERO},
      token1: {id: UNI.toLowerCase()},
      feeTier: '10000',
      tickSpacing: '200',
      hooks: ZERO,
      liquidity: '1',
      tvlETH: 0,
      tvlUSD: 0,
      migrationBlock: '900',
      activateAtMs: NOW - 10_000,
      expiresAtMs: NOW + 1_000_000,
      auctionAddress: AUCTION,
      strategyAddress: STRATEGY,
      launchedToken: UNI.toLowerCase(),
    };
    previousObjects.set(CCA_SCHEDULED_POOLS_S3_KEY(config.s3BaseKey, 1), [
      bridgeEntry,
    ]);

    await buildCcaScheduledPools(testLogger, metric, config, deps);

    // Entry survived unchanged → redundant PUT skipped.
    expect(putBodies.has(CCA_SCHEDULED_POOLS_S3_KEY(config.s3BaseKey, 1))).toBe(
      false
    );
  });

  it('prunes a bridge entry whose migrated pool key differs from the registration (strategy-as-hook rewrite)', async () => {
    const registeredId = `0x${'a'.repeat(64)}`;
    const migratedId = `0x${'b'.repeat(64)}`;
    pendingAuctions = [
      {...pendingAuctions[0], hasMigrated: true, migratedPoolId: migratedId},
    ];
    initializerInfo = {...initializerInfo, migrationBlock: 0n};
    const bridgeEntry: CcaScheduledPoolEntry = {
      id: registeredId,
      token0: {id: ZERO},
      token1: {id: UNI.toLowerCase()},
      feeTier: '10000',
      tickSpacing: '200',
      hooks: ZERO,
      liquidity: '1',
      tvlETH: 0,
      tvlUSD: 0,
      migrationBlock: '900',
      activateAtMs: NOW - 10_000,
      expiresAtMs: NOW + 1_000_000,
      auctionAddress: AUCTION,
      strategyAddress: STRATEGY,
      launchedToken: UNI.toLowerCase(),
    };
    previousObjects.set(CCA_SCHEDULED_POOLS_S3_KEY(config.s3BaseKey, 1), [
      bridgeEntry,
    ]);

    await buildCcaScheduledPools(testLogger, metric, config, deps);

    const written = JSON.parse(
      putBodies.get(CCA_SCHEDULED_POOLS_S3_KEY(config.s3BaseKey, 1))!
    ) as CcaScheduledPoolEntry[];
    expect(written.map(entry => entry.id)).not.toContain(registeredId);
    expect(
      metric.metrics.find(
        m =>
          m.key === 'CcaScheduledPools.poolKeyMismatch' &&
          m.tags?.reason === 'pool_key_mismatch'
      )
    ).toBeDefined();
  });

  it('keeps a bridge entry whose migrated pool key matches the registration', async () => {
    const poolId = `0x${'c'.repeat(64)}`;
    pendingAuctions = [
      {...pendingAuctions[0], hasMigrated: true, migratedPoolId: poolId},
    ];
    initializerInfo = {...initializerInfo, migrationBlock: 0n};
    const bridgeEntry: CcaScheduledPoolEntry = {
      id: poolId,
      token0: {id: ZERO},
      token1: {id: UNI.toLowerCase()},
      feeTier: '10000',
      tickSpacing: '200',
      hooks: ZERO,
      liquidity: '1',
      tvlETH: 0,
      tvlUSD: 0,
      migrationBlock: '900',
      activateAtMs: NOW - 10_000,
      expiresAtMs: NOW + 1_000_000,
      auctionAddress: AUCTION,
      strategyAddress: STRATEGY,
      launchedToken: UNI.toLowerCase(),
    };
    previousObjects.set(CCA_SCHEDULED_POOLS_S3_KEY(config.s3BaseKey, 1), [
      bridgeEntry,
    ]);

    await buildCcaScheduledPools(testLogger, metric, config, deps);

    // Entry survived unchanged → redundant PUT skipped.
    expect(putBodies.has(CCA_SCHEDULED_POOLS_S3_KEY(config.s3BaseKey, 1))).toBe(
      false
    );
  });

  it('prunes a cleared (not migrated) registration only when activation is comfortably in the future', async () => {
    pendingAuctions = [
      {...pendingAuctions[0], hasMigrated: false},
      {
        auctionId: '1-near',
        chainId: 1,
        address: '0xnear0000000000000000000000000000000near0',
        lbpStrategyAddress: STRATEGY,
        hasMigrated: false,
      },
    ];
    initializerInfo = {...initializerInfo, migrationBlock: 0n};
    const base = {
      token0: {id: ZERO},
      token1: {id: UNI.toLowerCase()},
      feeTier: '10000',
      tickSpacing: '200',
      hooks: ZERO,
      liquidity: '1',
      tvlETH: 0,
      tvlUSD: 0,
      migrationBlock: '2000',
      expiresAtMs: NOW + 100_000_000,
      strategyAddress: STRATEGY,
      launchedToken: UNI.toLowerCase(),
    };
    previousObjects.set(CCA_SCHEDULED_POOLS_S3_KEY(config.s3BaseKey, 1), [
      // Far pre-activation: a zeroed read cannot be a consumed migration —
      // genuinely cleared, pruned.
      {
        ...base,
        id: '0xcanceled',
        activateAtMs: NOW + 2 * 60 * 60 * 1000,
        auctionAddress: AUCTION,
      },
      // Near activation: the zeroed read may be a just-consumed migrate()
      // racing data-api's hasMigrated snapshot — kept (TOCTOU guard).
      {
        ...base,
        id: '0xnearlaunch',
        activateAtMs: NOW + 60_000,
        auctionAddress: '0xnear0000000000000000000000000000000near0',
      },
    ]);

    await buildCcaScheduledPools(testLogger, metric, config, deps);

    expect(writtenEntries(1).map(e => e.id)).toEqual(['0xnearlaunch']);
  });

  it('supersedes a previous entry whose on-chain pool params changed (new poolId)', async () => {
    // Previous entry was built from old params (fee 500 → different poolId);
    // this run reads fee 10000. The stale-id duplicate must be dropped.
    const oldId = computeCcaPoolId(ZERO, UNI, 500, 10, ZERO).toLowerCase();
    const newId = computeCcaPoolId(ZERO, UNI, 10000, 200, ZERO).toLowerCase();
    previousObjects.set(CCA_SCHEDULED_POOLS_S3_KEY(config.s3BaseKey, 1), [
      {
        id: oldId,
        token0: {id: ZERO},
        token1: {id: UNI.toLowerCase()},
        feeTier: '500',
        tickSpacing: '10',
        hooks: ZERO,
        liquidity: '1',
        tvlETH: 0,
        tvlUSD: 0,
        migrationBlock: '2000',
        activateAtMs: NOW + 60_000,
        expiresAtMs: NOW + 1_000_000,
        auctionAddress: AUCTION,
        strategyAddress: STRATEGY,
        launchedToken: UNI.toLowerCase(),
      },
    ]);

    await buildCcaScheduledPools(testLogger, metric, config, deps);

    expect(writtenEntries(1).map(e => e.id)).toEqual([newId]);
  });

  it('resurrects an aged-out orphan whose stale estimate expired but whose registration is live', async () => {
    // Absent from data-api (past the 14-day window), estimate drifted so far
    // the entry looks activated AND expired — but on-chain the migration is
    // still scheduled. It must be rebuilt, not silently dropped.
    previousObjects.set(CCA_SCHEDULED_POOLS_S3_KEY(config.s3BaseKey, 1), [
      {
        id: computeCcaPoolId(ZERO, UNI, 10000, 200, ZERO).toLowerCase(),
        token0: {id: ZERO},
        token1: {id: UNI.toLowerCase()},
        feeTier: '10000',
        tickSpacing: '200',
        hooks: ZERO,
        liquidity: '1',
        tvlETH: 0,
        tvlUSD: 0,
        migrationBlock: '2000',
        activateAtMs: NOW - 48 * 60 * 60 * 1000,
        expiresAtMs: NOW - 24 * 60 * 60 * 1000,
        auctionAddress: '0xagedout-auction',
        strategyAddress: STRATEGY,
        launchedToken: UNI.toLowerCase(),
      },
    ]);
    pendingAuctions = [];

    await buildCcaScheduledPools(testLogger, metric, config, deps);

    const entries = writtenEntries(1);
    expect(entries).toHaveLength(1);
    expect(entries[0].activateAtMs).toBe(NOW + 1_000 * 12_000);
    expect(entries[0].expiresAtMs).toBeGreaterThan(NOW);
  });

  it('skips hooked launches at write time (serve merge is hookless-only)', async () => {
    initializerInfo = {
      ...initializerInfo,
      hook: '0x9999999999999999999999999999999999999999',
    };

    await buildCcaScheduledPools(testLogger, metric, config, deps);

    expect(writtenEntries(1)).toHaveLength(0);
    expect(
      metric.metrics.filter(
        m =>
          m.key === 'CcaScheduledPools.hookedLaunchSkipped' &&
          m.tags?.status === 'failure' &&
          m.tags?.reason === 'hooked_launch'
      )
    ).toHaveLength(1);
  });

  it('prunes the previous hookless entry of an auction re-registered with a hook', async () => {
    initializerInfo = {
      ...initializerInfo,
      hook: '0x9999999999999999999999999999999999999999',
    };
    const staleHookless: CcaScheduledPoolEntry = {
      id: `0x${'d'.repeat(64)}`,
      token0: {id: ZERO},
      token1: {id: UNI.toLowerCase()},
      feeTier: '10000',
      tickSpacing: '200',
      hooks: ZERO,
      liquidity: '1',
      tvlETH: 0,
      tvlUSD: 0,
      migrationBlock: '900',
      activateAtMs: NOW + 500_000,
      expiresAtMs: NOW + 1_000_000,
      auctionAddress: AUCTION,
      strategyAddress: STRATEGY,
      launchedToken: UNI.toLowerCase(),
    };
    previousObjects.set(CCA_SCHEDULED_POOLS_S3_KEY(config.s3BaseKey, 1), [
      staleHookless,
    ]);

    await buildCcaScheduledPools(testLogger, metric, config, deps);

    expect(writtenEntries(1)).toHaveLength(0);
  });

  it('keeps a pre-activation entry when its initializers() read fails transiently', async () => {
    // The auction IS still in data-api's response, but this run's on-chain
    // read fails — the previous entry must survive rather than vanish right
    // before its migration block.
    const previousEntry: CcaScheduledPoolEntry = {
      id: '0xtransient',
      token0: {id: ZERO},
      token1: {id: UNI.toLowerCase()},
      feeTier: '10000',
      tickSpacing: '200',
      hooks: ZERO,
      liquidity: '1',
      tvlETH: 0,
      tvlUSD: 0,
      migrationBlock: '2000',
      activateAtMs: NOW + 60_000,
      expiresAtMs: NOW + 60_000 + 1_000_000,
      auctionAddress: AUCTION,
      strategyAddress: STRATEGY,
      launchedToken: UNI.toLowerCase(),
    };
    previousObjects.set(CCA_SCHEDULED_POOLS_S3_KEY(config.s3BaseKey, 1), [
      previousEntry,
    ]);
    vi.mocked(deps.readLbpInitializer).mockRejectedValue(
      new Error('rpc flake')
    );

    await buildCcaScheduledPools(testLogger, metric, config, deps);

    // The entry survived unchanged, so the writer skipped the redundant PUT
    // entirely (a dropped entry would have PUT an empty registry instead).
    expect(putBodies.has(CCA_SCHEDULED_POOLS_S3_KEY(config.s3BaseKey, 1))).toBe(
      false
    );
  });

  it('continues past per-auction read failures and counts them', async () => {
    pendingAuctions = [
      {
        auctionId: '1-bad',
        chainId: 1,
        address: '0xbad000000000000000000000000000000000bad0',
        lbpStrategyAddress: STRATEGY,
        hasMigrated: false,
      },
      ...pendingAuctions,
    ];
    vi.mocked(deps.readLbpInitializer)
      .mockRejectedValueOnce(new Error('rpc revert'))
      .mockResolvedValueOnce(initializerInfo);

    await buildCcaScheduledPools(testLogger, metric, config, deps);

    expect(writtenEntries(1)).toHaveLength(1);
    expect(
      metric.metrics.filter(m => m.key === 'CcaScheduledPools.auctionReadError')
    ).toHaveLength(1);
  });

  it('conditions the write on the read object version and defaults to create-only', async () => {
    const putInputs: Array<{IfMatch?: string; IfNoneMatch?: string}> = [];
    vi.mocked(deps.s3.send).mockImplementation(async command => {
      if (command instanceof PutObjectCommand) {
        putInputs.push(command.input);
        return {} as never;
      }
      const error = new Error('NoSuchKey');
      error.name = 'NoSuchKey';
      throw error;
    });

    // No previous object → the PUT must be create-only (IfNoneMatch: '*').
    await buildCcaScheduledPools(testLogger, metric, config, deps);
    expect(putInputs).toHaveLength(1);
    expect(putInputs[0].IfNoneMatch).toBe('*');
    expect(putInputs[0].IfMatch).toBeUndefined();

    // Existing object → the PUT must carry its exact ETag.
    putInputs.length = 0;
    vi.mocked(deps.s3.send).mockImplementation(async command => {
      if (command instanceof PutObjectCommand) {
        putInputs.push(command.input);
        return {} as never;
      }
      return {
        Body: {transformToString: async () => JSON.stringify([])},
        ETag: '"etag-1"',
      } as never;
    });
    await buildCcaScheduledPools(testLogger, metric, config, deps);
    expect(putInputs).toHaveLength(1);
    expect(putInputs[0].IfMatch).toBe('"etag-1"');
    expect(putInputs[0].IfNoneMatch).toBeUndefined();
  });

  it('skips a stale write when the registry advanced concurrently (lost-update guard)', async () => {
    vi.mocked(deps.s3.send).mockImplementation(async command => {
      if (command instanceof PutObjectCommand) {
        const error = new Error('PreconditionFailed');
        error.name = 'PreconditionFailed';
        throw error;
      }
      const error = new Error('NoSuchKey');
      error.name = 'NoSuchKey';
      throw error;
    });

    // The chain's write was dropped: the run is not a success. With every
    // chain conflicting (single-chain config) the job-level guard escalates —
    // persistent all-chains conflict (long-lived twin writers) must alert,
    // while brief deploy overlap stays under the monitor thresholds.
    await expect(
      buildCcaScheduledPools(testLogger, metric, config, deps)
    ).rejects.toThrow('failed for all');

    expect(
      metric.metrics.find(
        m =>
          m.key === 'CcaScheduledPools.staleWriteSkipped' &&
          m.tags?.reason === 'stale_write_conflict'
      )
    ).toBeDefined();
    // The per-chain series stays continuous through conflicts.
    expect(
      metric.metrics.find(
        m =>
          m.key === 'CcaScheduledPools.chainRun' &&
          m.tags?.status === 'failure' &&
          m.tags?.reason === 'stale_write_conflict'
      )
    ).toBeDefined();
  });

  it('isolates a single-chain failure but surfaces it via the per-chain metric', async () => {
    config = {...config, chainIds: [1, 8453]};
    // Chain 1's PUT fails; chain 8453 (no pending auctions) succeeds.
    vi.mocked(deps.s3.send).mockImplementation(async command => {
      if (
        command instanceof PutObjectCommand &&
        command.input.Key === CCA_SCHEDULED_POOLS_S3_KEY(config.s3BaseKey, 1)
      ) {
        throw new Error('s3 down');
      }
      if (command instanceof PutObjectCommand) {
        putBodies.set(command.input.Key!, command.input.Body as string);
        return {} as never;
      }
      const error = new Error('NoSuchKey');
      error.name = 'NoSuchKey';
      throw error;
    });

    await expect(
      buildCcaScheduledPools(testLogger, metric, config, deps)
    ).resolves.toBeUndefined();

    expect(
      metric.metrics.find(
        m =>
          m.key === 'CcaScheduledPools.chainRun' && m.tags?.status === 'failure'
      )
    ).toBeDefined();
  });

  it('rebuilds from fresh state when the previous registry object is corrupt', async () => {
    vi.mocked(deps.s3.send).mockImplementation(async command => {
      if (command instanceof PutObjectCommand) {
        putBodies.set(command.input.Key!, command.input.Body as string);
        return {} as never;
      }
      return {
        Body: {transformToString: async () => 'not-json{{{'},
      } as never;
    });

    await buildCcaScheduledPools(testLogger, metric, config, deps);

    // The corrupt object is overwritten with the fresh entry (self-heal), not
    // frozen by an aborted run.
    expect(writtenEntries(1).map(e => e.auctionAddress)).toEqual([AUCTION]);
  });

  it('drops a fresh entry whose id mismatches the recorded migrated pool (lagging RPC race)', async () => {
    const migratedId = `0x${'e'.repeat(64)}`;
    // data-api already recorded the migration under a DIFFERENT poolId, but
    // the (lagging) RPC still returns a live non-zero registration — the
    // fresh entry it builds must not re-publish the wrong id.
    pendingAuctions = [
      {...pendingAuctions[0], hasMigrated: true, migratedPoolId: migratedId},
    ];

    await buildCcaScheduledPools(testLogger, metric, config, deps);

    expect(writtenEntries(1)).toHaveLength(0);
  });

  it('heals an existing registry object with an empty body even on an idle chain', async () => {
    pendingAuctions = [];
    vi.mocked(deps.s3.send).mockImplementation(async command => {
      if (command instanceof PutObjectCommand) {
        putBodies.set(command.input.Key!, command.input.Body as string);
        return {} as never;
      }
      // Object exists but has no body — the serve-side JSON.parse('') throws
      // on every refresh until this is rewritten.
      return {Body: undefined, ETag: '"empty"'} as never;
    });

    await buildCcaScheduledPools(testLogger, metric, config, deps);

    expect(writtenEntries(1)).toEqual([]);
  });

  it('overwrites a corrupt registry object even when the rebuilt state is empty', async () => {
    // No pending auctions → merged state is [] which equals the sanitized
    // previous — without the sanitized-forced PUT the corrupt object would
    // persist and the serve-side reader would error on it every ~45s forever.
    pendingAuctions = [];
    vi.mocked(deps.s3.send).mockImplementation(async command => {
      if (command instanceof PutObjectCommand) {
        putBodies.set(command.input.Key!, command.input.Body as string);
        return {} as never;
      }
      return {
        Body: {transformToString: async () => 'not-json{{{'},
      } as never;
    });

    await buildCcaScheduledPools(testLogger, metric, config, deps);

    expect(writtenEntries(1)).toEqual([]);
  });

  it('throws when every chain fails so the cron job records an error', async () => {
    vi.mocked(deps.s3.send).mockRejectedValue(new Error('s3 down') as never);

    await expect(
      buildCcaScheduledPools(testLogger, metric, config, deps)
    ).rejects.toThrow('failed for all 1 chains');
  });

  it('writes an empty registry for chains with no pending auctions without an RPC call', async () => {
    pendingAuctions = [];

    await buildCcaScheduledPools(testLogger, metric, config, deps);

    expect(writtenEntries(1)).toHaveLength(0);
    expect(deps.getBlockNumber).not.toHaveBeenCalled();
  });
});
