import {describe, expect, it} from 'vitest';
import {ADDRESS_ZERO} from '@uniswap/router-sdk';
import type {V4PoolKey} from '@uniswap/lib-data-ingestion-aurora';

import type {S3Client} from '@aws-sdk/client-s3';

import {
  MAX_REGISTRY_ENTRIES_PER_PAIR,
  buildV4PoolKeyRegistry,
  isRowCountCollapse,
  materializeV4PoolKeyRegistries,
  selectRetainedEntries,
} from './v4PoolKeyRegistry';
import {IMetric, MetricLoggerUnit} from './sor-providers/util/metric';
import type {Logger} from './sor-providers/util/log';
import {
  parseV4PoolKeyRegistryFile,
  v4PoolKeyRegistryChainsFromEnv,
  v4RegistryPairKey,
} from './util/v4PoolKeyRegistryFormat';
import {Pool as V4SDKPool} from '@uniswap/v4-sdk';
import {Token} from '@uniswap/sdk-core';
import {nativeOnChain} from './util/nativeOnChain';

// ROUTE-1579's SIERRA/USDC mainnet pool: fee 375, tickSpacing 4, hookless.
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const SIERRA = '0xbceb5f6877d979ec621ae694da1102cb95691ad3';
const SIERRA_POOL_ID =
  '0xb2bc5c469dc818e9d3f34cae42d4229d89fc5e5e35297158e909aae0db238a8f';

const GENERATED_AT = 1_754_000_000_000;

function poolIdFor(
  chainId: number,
  token0: string,
  token1: string,
  fee: number,
  tickSpacing: number
): string {
  return V4SDKPool.getPoolId(
    new Token(chainId, token0, 18),
    new Token(chainId, token1, 18),
    fee,
    tickSpacing,
    ADDRESS_ZERO
  ).toLowerCase();
}

function row(overrides: Partial<V4PoolKey>): V4PoolKey {
  return {
    poolId: SIERRA_POOL_ID,
    token0Address: USDC,
    token1Address: SIERRA,
    feeBips: 375,
    tickSpacing: 4,
    hooksAddress: null,
    poolCreatedAtBlockTimestamp: new Date('2026-07-01T00:00:00Z'),
    ...overrides,
  };
}

describe('buildV4PoolKeyRegistry', () => {
  it('includes a non-canonical hookless pool under its sorted pair key', () => {
    const {file, stats} = buildV4PoolKeyRegistry(1, [row({})], GENERATED_AT);
    expect(stats.included).toBe(1);
    expect(file.pairs[v4RegistryPairKey(SIERRA, USDC)]).toEqual([[375, 4]]);
    expect(file.chainId).toBe(1);
    expect(file.generatedAtMs).toBe(GENERATED_AT);
  });

  it('verifies the PoolKey against the stored pool id (keccak preimage)', () => {
    // The real SIERRA PoolKey must reproduce the real pool id.
    const {stats} = buildV4PoolKeyRegistry(1, [row({})], GENERATED_AT);
    expect(stats.skippedInvalidId).toBe(0);

    // A corrupt row (same id, wrong fee) must be dropped, not registered.
    const corrupt = buildV4PoolKeyRegistry(
      1,
      [row({feeBips: 475})],
      GENERATED_AT
    );
    expect(corrupt.stats.skippedInvalidId).toBe(1);
    expect(corrupt.stats.included).toBe(0);
  });

  it('skips canonical-grid pools and hooked pools', () => {
    const canonical = row({
      feeBips: 3000,
      tickSpacing: 60,
      poolId: poolIdFor(1, USDC, SIERRA, 3000, 60),
    });
    const hooked = row({
      hooksAddress: '0x0000000000000000000000000000000000000abc',
    });
    const {stats, file} = buildV4PoolKeyRegistry(
      1,
      [canonical, hooked],
      GENERATED_AT
    );
    expect(stats.skippedCanonical).toBe(1);
    expect(stats.skippedHooked).toBe(1);
    expect(Object.keys(file.pairs)).toHaveLength(0);
  });

  it('handles native-currency pools (currency0 = zero address)', () => {
    const fee = 42;
    const tickSpacing = 7;
    const nativePoolId = V4SDKPool.getPoolId(
      nativeOnChain(1),
      new Token(1, USDC, 18),
      fee,
      tickSpacing,
      ADDRESS_ZERO
    ).toLowerCase();
    const {stats, file} = buildV4PoolKeyRegistry(
      1,
      [
        row({
          token0Address: ADDRESS_ZERO,
          token1Address: USDC,
          feeBips: fee,
          tickSpacing,
          poolId: nativePoolId,
        }),
      ],
      GENERATED_AT
    );
    expect(stats.included).toBe(1);
    expect(file.pairs[v4RegistryPairKey(ADDRESS_ZERO, USDC)]).toEqual([
      [fee, tickSpacing],
    ]);
  });

  it('caps entries per pair by age: oldest slice + newest window', () => {
    // An established old pool (highest legal fee — the ROUTE-1581 shape) plus
    // a flood of newer low-fee spam initializations. A fee-ordered policy
    // would evict the real pool; age-ordered retention must keep it.
    const realPool = row({
      feeBips: 199000,
      tickSpacing: 1990,
      poolId: poolIdFor(1, USDC, SIERRA, 199000, 1990),
      poolCreatedAtBlockTimestamp: new Date('2026-06-01T00:00:00Z'),
    });
    const spam: V4PoolKey[] = [];
    for (let i = 0; i < MAX_REGISTRY_ENTRIES_PER_PAIR + 4; i++) {
      const fee = 111 + i;
      spam.push(
        row({
          feeBips: fee,
          tickSpacing: 3,
          poolId: poolIdFor(1, USDC, SIERRA, fee, 3),
          poolCreatedAtBlockTimestamp: new Date(
            `2026-08-0${1 + (i % 9)}T00:00:00Z`
          ),
        })
      );
    }
    const {file, stats} = buildV4PoolKeyRegistry(
      1,
      [...spam, realPool],
      GENERATED_AT
    );
    const entries = file.pairs[v4RegistryPairKey(USDC, SIERRA)]!;
    expect(entries).toHaveLength(MAX_REGISTRY_ENTRIES_PER_PAIR);
    expect(entries).toContainEqual([199000, 1990]);
    expect(stats.truncatedPairs).toBe(1);
    expect(stats.included).toBe(MAX_REGISTRY_ENTRIES_PER_PAIR);
  });

  it('retention keeps a newest window so fresh pools on noisy pairs survive', () => {
    const candidates = Array.from({length: 20}, (_, i) => ({
      fee: 100 + i,
      tickSpacing: 3,
      createdAtMs: 1_000 + i,
    }));
    const retained = selectRetainedEntries(candidates);
    expect(retained).toHaveLength(MAX_REGISTRY_ENTRIES_PER_PAIR);
    // Oldest six...
    for (let i = 0; i < 6; i++) {
      expect(retained.map(e => e.createdAtMs)).toContain(1_000 + i);
    }
    // ...plus the two newest.
    expect(retained.map(e => e.createdAtMs)).toContain(1_019);
    expect(retained.map(e => e.createdAtMs)).toContain(1_018);
  });

  it('an entry without a provable age cannot displace the oldest slice', () => {
    const candidates = [
      ...Array.from({length: 8}, (_, i) => ({
        fee: 200 + i,
        tickSpacing: 3,
        createdAtMs: 1_000 + i,
      })),
      {fee: 999, tickSpacing: 3, createdAtMs: Number.MAX_SAFE_INTEGER},
    ];
    const retained = selectRetainedEntries(candidates);
    const oldest = retained.filter(e => e.createdAtMs <= 1_005);
    expect(oldest).toHaveLength(6);
  });

  it('flags a row-count collapse against the strongest baseline', () => {
    // Durable incumbent baseline protects a cold container (no process
    // baseline yet) from accepting a partial mid-backfill read.
    expect(isRowCountCollapse(400, undefined, 1000)).toBe(true);
    expect(isRowCountCollapse(400, 1000, undefined)).toBe(true);
    expect(isRowCountCollapse(400, 300, 1000)).toBe(true);
    // At/above half the strongest baseline is accepted.
    expect(isRowCountCollapse(500, 1000, undefined)).toBe(false);
    expect(isRowCountCollapse(999, 300, 1000)).toBe(false);
    // No baseline at all: nothing to collapse against.
    expect(isRowCountCollapse(1, undefined, undefined)).toBe(false);
  });

  it('dedupes identical PoolKeys', () => {
    const {stats} = buildV4PoolKeyRegistry(1, [row({}), row({})], GENERATED_AT);
    expect(stats.included).toBe(1);
  });
});

describe('v4PoolKeyRegistryFormat', () => {
  it('pair key is order-insensitive and lowercased', () => {
    expect(v4RegistryPairKey(USDC.toUpperCase(), SIERRA)).toBe(
      v4RegistryPairKey(SIERRA, USDC)
    );
  });

  it('round-trips through serialization and rejects mismatched chains', () => {
    const {file} = buildV4PoolKeyRegistry(1, [row({})], GENERATED_AT);
    const json = JSON.stringify(file);
    expect(parseV4PoolKeyRegistryFile(json, 1)).toEqual(file);
    expect(parseV4PoolKeyRegistryFile(json, 137)).toBeUndefined();
    expect(parseV4PoolKeyRegistryFile('not json', 1)).toBeUndefined();
  });

  it('sanitizes malformed pair values instead of passing them through', () => {
    const json = JSON.stringify({
      version: 1,
      chainId: 1,
      generatedAtMs: GENERATED_AT,
      pairs: {
        'a:b': 'not-an-array',
        'c:d': [[375, 4], ['x', 4], [375], [1.5, 4], [-1, 4], [375, 0], null],
        'e:f': Array.from({length: 50}, (_, i) => [100 + i, 3]),
        'g:h': [{fee: 375}],
      },
    });
    const parsed = parseV4PoolKeyRegistryFile(json, 1)!;
    expect(parsed.pairs['a:b']).toBeUndefined();
    expect(parsed.pairs['c:d']).toEqual([[375, 4]]);
    expect(parsed.pairs['e:f']).toHaveLength(MAX_REGISTRY_ENTRIES_PER_PAIR);
    expect(parsed.pairs['g:h']).toBeUndefined();
  });

  it('rejects fees and tick spacings outside v4-core bounds', () => {
    const json = JSON.stringify({
      version: 1,
      chainId: 1,
      generatedAtMs: GENERATED_AT,
      pairs: {
        'a:b': [
          [8388608, 60], // dynamic-fee sentinel — out of registry scope
          [1000001, 60], // > MAX_LP_FEE
          [3000, 40000], // > MAX_TICK_SPACING
          [199000, 1990], // legal high-fee pool stays
        ],
      },
    });
    expect(parseV4PoolKeyRegistryFile(json, 1)!.pairs['a:b']).toEqual([
      [199000, 1990],
    ]);
  });

  it('parses the chains env: unset off, ids parsed, junk dropped', () => {
    const prev = process.env.V4_POOLKEY_REGISTRY_CHAINS;
    try {
      delete process.env.V4_POOLKEY_REGISTRY_CHAINS;
      expect(v4PoolKeyRegistryChainsFromEnv().size).toBe(0);
      process.env.V4_POOLKEY_REGISTRY_CHAINS = ' 1, 137 ,junk,-5,';
      expect([...v4PoolKeyRegistryChainsFromEnv()].sort()).toEqual([1, 137]);
    } finally {
      if (prev === undefined) delete process.env.V4_POOLKEY_REGISTRY_CHAINS;
      else process.env.V4_POOLKEY_REGISTRY_CHAINS = prev;
    }
  });

  describe('materializeV4PoolKeyRegistries init failures', () => {
    class CollectingMetric extends IMetric {
      readonly emitted: Array<{
        key: string;
        tags?: Record<string, string>;
      }> = [];
      putDimensions(): void {}
      setProperty(): void {}
      putMetric(
        key: string,
        _value: number,
        _unit?: MetricLoggerUnit,
        tags?: Record<string, string>
      ): void {
        this.emitted.push({key, tags});
      }
    }

    const noopLogger: Logger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      fatal: () => {},
    };

    it('emits one chainId-tagged error per enabled chain when Aurora is unavailable', async () => {
      // With no DATA_INGESTION_AURORA_HOST, getOrCreateUnirouteAuroraDb
      // latches env_missing — the exact "enabled but inert" state the
      // materialization monitor must be able to see. Its query groups by
      // {chainid, reason}, and metric group-by drops untagged points, so
      // each emission MUST carry a chainId.
      const savedChains = process.env.V4_POOLKEY_REGISTRY_CHAINS;
      const savedHost = process.env.DATA_INGESTION_AURORA_HOST;
      try {
        delete process.env.DATA_INGESTION_AURORA_HOST;
        process.env.V4_POOLKEY_REGISTRY_CHAINS = '1,137';
        const metric = new CollectingMetric();
        // S3 is never reached on this path; a bare object suffices.
        await materializeV4PoolKeyRegistries(
          {} as S3Client,
          {s3Bucket: 'unused'},
          noopLogger,
          metric
        );
        const errors = metric.emitted.filter(
          e => e.key === 'CachePools.v4PoolKeyRegistry.error'
        );
        expect(errors).toHaveLength(2);
        expect(errors.map(e => e.tags?.chainId).sort()).toEqual(['1', '137']);
        for (const e of errors) {
          expect(e.tags?.reason).toBe('env_missing');
        }
      } finally {
        if (savedChains === undefined) {
          delete process.env.V4_POOLKEY_REGISTRY_CHAINS;
        } else {
          process.env.V4_POOLKEY_REGISTRY_CHAINS = savedChains;
        }
        if (savedHost !== undefined) {
          process.env.DATA_INGESTION_AURORA_HOST = savedHost;
        }
      }
    });
  });
});
