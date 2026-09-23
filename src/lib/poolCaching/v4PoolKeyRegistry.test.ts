import * as zlib from 'zlib';
import {beforeEach, describe, expect, it} from 'vitest';
import {ADDRESS_ZERO} from '@uniswap/router-sdk';
import type {
  ListPoolKeysOptions,
  ListRoutablePoolsOptions,
  RoutablePoolsService,
  V2RoutablePool,
  V3RoutablePool,
  V4PoolKey,
  V4RoutablePool,
} from '@uniswap/lib-data-ingestion-aurora';
import type {Context} from '@uniswap/lib-uni/context';

import {
  HeadObjectCommand,
  HeadObjectCommandOutput,
  NotFound,
  PutObjectCommand,
  PutObjectCommandOutput,
  type S3Client,
} from '@aws-sdk/client-s3';

import {
  GENERATED_AT_METADATA_KEY,
  MAX_REGISTRY_ENTRIES_PER_PAIR,
  ROW_COUNT_METADATA_KEY,
  RegistryObjectClient,
  V4PoolKeyRegistryAccumulator,
  V4PoolKeyRegistryBuildStats,
  isRowCountCollapse,
  materializeV4PoolKeyRegistries,
  materializeV4PoolKeyRegistriesFrom,
  resetV4PoolKeyRegistryBaselinesForTesting,
  selectRetainedEntries,
} from './v4PoolKeyRegistry';
import {IMetric, MetricLoggerUnit} from './sor-providers/util/metric';
import type {Logger} from './sor-providers/util/log';
import {
  V4PoolKeyRegistryFile,
  isRegistryAdmissibleHook,
  parseV4PoolKeyRegistryFile,
  registryAdmissibleHookAddresses,
  DEFAULT_REGISTRY_HOOK_RESTRICTIONS,
  RestrictedRegistryHooksByChain,
  v4PoolKeyRegistryChainsFromEnv,
  v4PoolKeyRegistryHookedChainsFromEnv,
  v4PoolKeyRegistryHookRestrictionsFromEnv,
  v4RegistryPairKey,
} from './util/v4PoolKeyRegistryFormat';
import {DYNAMIC_FEE_FLAG, Pool as V4SDKPool} from '@uniswap/v4-sdk';
import {Token} from '@uniswap/sdk-core';
import {nativeOnChain} from './util/nativeOnChain';
import {V4TickSpacing} from '../../models/pool/V4Pool';
import {HOOKS_ADDRESSES_ALLOWLIST} from './util/hooksAddressesAllowlist';

// ROUTE-1579's SIERRA/USDC fixture, re-keyed off the canonical grid.
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const SIERRA = '0xbceb5f6877d979ec621ae694da1102cb95691ad3';

const GENERATED_AT = 1_754_000_000_000;
const ARRAKIS_PRIVATE_HOOK_V2 = '0xa4e6f5500e88691fdcb289aa0e99067481434880';

/**
 * An allowlisted Base hook that is NOT in Base's code-default restriction:
 * exactly what an override would have to name to put a launchpad hook (and
 * its millions of pairs) back into the registry.
 */
function allowlistedBaseHookOutsideDefault(): string {
  const codeDefault = new Set(
    DEFAULT_REGISTRY_HOOK_RESTRICTIONS[8453].map(hook => hook.toLowerCase())
  );
  const foreign = (HOOKS_ADDRESSES_ALLOWLIST[8453] ?? [])
    .map(hook => hook.toLowerCase())
    .find(hook => !codeDefault.has(hook));
  if (foreign === undefined) {
    throw new Error('Base allowlist has no hook outside the code default');
  }
  return foreign;
}

function poolIdFor(
  chainId: number,
  token0: string,
  token1: string,
  fee: number,
  tickSpacing: number,
  hooks: string = ADDRESS_ZERO
): string {
  return V4SDKPool.getPoolId(
    new Token(chainId, token0, 18),
    new Token(chainId, token1, 18),
    fee,
    tickSpacing,
    hooks
  ).toLowerCase();
}

/**
 * The batch shape the production code used to expose: every row folded
 * through one accumulator, hooked-chain gating from the same env var the
 * cron reads. Kept here so the behavioural assertions below stay verbatim.
 */
function buildV4PoolKeyRegistry(
  chainId: number,
  rows: V4PoolKey[],
  generatedAtMs: number
): {file: V4PoolKeyRegistryFile; stats: V4PoolKeyRegistryBuildStats} {
  const accumulator = new V4PoolKeyRegistryAccumulator(
    chainId,
    v4PoolKeyRegistryHookedChainsFromEnv()
  );
  for (const r of rows) accumulator.add(r);
  return accumulator.finish(generatedAtMs);
}

class CollectingMetric extends IMetric {
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
  withKey(key: string) {
    return this.emitted.filter(e => e.key === key);
  }
}

class CollectingLogger implements Logger {
  readonly lines: Array<{level: string; message: string}> = [];
  info = (message: string) => {
    this.lines.push({level: 'info', message});
  };
  warn = (message: string) => {
    this.lines.push({level: 'warn', message});
  };
  error = (message: string) => {
    this.lines.push({level: 'error', message});
  };
  debug = (message: string) => {
    this.lines.push({level: 'debug', message});
  };
  fatal = (message: string) => {
    this.lines.push({level: 'fatal', message});
  };
}

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  fatal: () => {},
};

function row(overrides: Partial<V4PoolKey>): V4PoolKey {
  return {
    poolId: poolIdFor(1, USDC, SIERRA, 1234, 7),
    token0Address: USDC,
    token1Address: SIERRA,
    feeBips: 1234,
    tickSpacing: 7,
    hooksAddress: null,
    poolCreatedAtBlockTimestamp: new Date('2026-07-01T00:00:00Z'),
    ...overrides,
  };
}

describe('buildV4PoolKeyRegistry', () => {
  it('includes the Base Arrakis dynamic-fee hooked PoolKey when enabled (ROUTE-1837)', () => {
    const previous = process.env.V4_POOLKEY_REGISTRY_HOOKED_CHAINS;
    process.env.V4_POOLKEY_REGISTRY_HOOKED_CHAINS = '8453';
    try {
      // The real pool this fix exists for, verbatim from its Base Initialize
      // event (block 50219544): USDC/DGLD, dynamic-fee sentinel, tickSpacing
      // 5, ArrakisPrivateHook v2. The pinned poolId proves the registry's
      // keccak-preimage check reproduces the on-chain id for hooked rows.
      const baseUsdc = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
      const baseDgld = '0xe908475f8beb7a138b0dc6eb5a05cb27068ffb9a';
      const poolId =
        '0x68ab198bc4c61c8c691a3e35d1b3a5248d8e04acb9e28a1bb2ef0d3fa564fe93';
      const {file, stats} = buildV4PoolKeyRegistry(
        8453,
        [
          row({
            token0Address: baseUsdc,
            token1Address: baseDgld,
            feeBips: DYNAMIC_FEE_FLAG,
            tickSpacing: 5,
            hooksAddress: ARRAKIS_PRIVATE_HOOK_V2,
            poolId,
          }),
        ],
        GENERATED_AT
      );
      expect(file.pairs[v4RegistryPairKey(baseUsdc, baseDgld)]).toEqual([
        [DYNAMIC_FEE_FLAG, 5, ARRAKIS_PRIVATE_HOOK_V2],
      ]);
      expect(stats.includedHooked).toBe(1);
      expect(stats.skippedInvalidId).toBe(0);
    } finally {
      if (previous === undefined)
        delete process.env.V4_POOLKEY_REGISTRY_HOOKED_CHAINS;
      else process.env.V4_POOLKEY_REGISTRY_HOOKED_CHAINS = previous;
    }
  });

  it('skips a hooked pool on a canonical tier (grid cannot guess it, but snapshot admission owns it)', () => {
    const previous = process.env.V4_POOLKEY_REGISTRY_HOOKED_CHAINS;
    process.env.V4_POOLKEY_REGISTRY_HOOKED_CHAINS = '8453';
    try {
      const {file, stats} = buildV4PoolKeyRegistry(
        8453,
        [
          row({
            feeBips: 3000,
            tickSpacing: 60,
            hooksAddress: ARRAKIS_PRIVATE_HOOK_V2,
            poolId: V4SDKPool.getPoolId(
              new Token(8453, USDC, 18),
              new Token(8453, SIERRA, 18),
              3000,
              60,
              ARRAKIS_PRIVATE_HOOK_V2
            ).toLowerCase(),
          }),
        ],
        GENERATED_AT
      );
      expect(stats.skippedCanonical).toBe(1);
      expect(stats.includedHooked).toBe(0);
      expect(file.pairs).toEqual({});
    } finally {
      if (previous === undefined) {
        delete process.env.V4_POOLKEY_REGISTRY_HOOKED_CHAINS;
      } else {
        process.env.V4_POOLKEY_REGISTRY_HOOKED_CHAINS = previous;
      }
    }
  });

  it('under the code-default Base hook restriction the build keeps Arrakis pools and skips launchpad pools (ROUTE-2026)', () => {
    const prevHooked = process.env.V4_POOLKEY_REGISTRY_HOOKED_CHAINS;
    const prevRestricted = process.env.V4_POOLKEY_REGISTRY_HOOKS_BY_CHAIN;
    process.env.V4_POOLKEY_REGISTRY_HOOKED_CHAINS = '8453';
    // No override: the restriction that protects Base must hold with no
    // config value at all, or a lost Pulumi key re-creates the OOM.
    delete process.env.V4_POOLKEY_REGISTRY_HOOKS_BY_CHAIN;
    try {
      const baseUsdc = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
      const baseDgld = '0xe908475f8beb7a138b0dc6eb5a05cb27068ffb9a';
      const zoraCoinHook = '0x0469a4bd3724dc86c9542f4694c976da13c450c0';
      const {file, stats} = buildV4PoolKeyRegistry(
        8453,
        [
          row({
            token0Address: baseUsdc,
            token1Address: baseDgld,
            feeBips: DYNAMIC_FEE_FLAG,
            tickSpacing: 5,
            hooksAddress: ARRAKIS_PRIVATE_HOOK_V2,
            poolId:
              '0x68ab198bc4c61c8c691a3e35d1b3a5248d8e04acb9e28a1bb2ef0d3fa564fe93',
          }),
          // A Zora coin pool on a non-canonical tier: allowlisted for routing,
          // admissible without the restriction, excluded with it.
          row({
            feeBips: 30000,
            tickSpacing: 200,
            hooksAddress: zoraCoinHook,
            poolId: poolIdFor(8453, USDC, SIERRA, 30000, 200, zoraCoinHook),
          }),
        ],
        GENERATED_AT
      );
      expect(file.pairs[v4RegistryPairKey(baseUsdc, baseDgld)]).toEqual([
        [DYNAMIC_FEE_FLAG, 5, ARRAKIS_PRIVATE_HOOK_V2],
      ]);
      expect(file.pairs[v4RegistryPairKey(USDC, SIERRA)]).toBeUndefined();
      expect(stats.includedHooked).toBe(1);
      expect(stats.skippedHooked).toBe(1);
    } finally {
      if (prevHooked === undefined) {
        delete process.env.V4_POOLKEY_REGISTRY_HOOKED_CHAINS;
      } else {
        process.env.V4_POOLKEY_REGISTRY_HOOKED_CHAINS = prevHooked;
      }
      if (prevRestricted === undefined) {
        delete process.env.V4_POOLKEY_REGISTRY_HOOKS_BY_CHAIN;
      } else {
        process.env.V4_POOLKEY_REGISTRY_HOOKS_BY_CHAIN = prevRestricted;
      }
    }
  });

  it('includes a non-canonical hookless pool under its sorted pair key', () => {
    const {file, stats} = buildV4PoolKeyRegistry(1, [row({})], GENERATED_AT);
    expect(stats.included).toBe(1);
    expect(file.pairs[v4RegistryPairKey(SIERRA, USDC)]).toEqual([[1234, 7]]);
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

  it('skips every tier of the serving-path canonical grid (stays in sync with V4TickSpacing)', () => {
    // The local CANONICAL_V4_FEE_TICK_SPACINGS map is a hand-maintained
    // mirror of the serving-path grid; this trips if the copies drift.
    const rows = Object.entries(V4TickSpacing).map(([fee, tickSpacing]) =>
      row({
        feeBips: Number(fee),
        tickSpacing,
        poolId: poolIdFor(1, USDC, SIERRA, Number(fee), tickSpacing),
      })
    );
    const {stats, file} = buildV4PoolKeyRegistry(1, rows, GENERATED_AT);
    expect(rows.length).toBe(8);
    expect(stats.skippedCanonical).toBe(rows.length);
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
      feeBips: 109000,
      tickSpacing: 1090,
      poolId: poolIdFor(1, USDC, SIERRA, 109000, 1090),
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
    expect(entries).toContainEqual([109000, 1090]);
    expect(stats.truncatedPairs).toBe(1);
    expect(stats.included).toBe(MAX_REGISTRY_ENTRIES_PER_PAIR);
  });

  it('retention order is total: hooks breaks exact ties, so the result is arrival-order independent', () => {
    // Nine hooked entries sharing age, fee and tick spacing. Without the
    // hooks tiebreak the sort is stable on arrival order, so which one is
    // evicted would depend on the order rows came back from Aurora.
    const hooks = Array.from(
      {length: MAX_REGISTRY_ENTRIES_PER_PAIR + 1},
      (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`
    );
    const tied = hooks.map(hook => ({
      fee: 3000,
      tickSpacing: 60,
      hooks: hook,
      createdAtMs: 1_000,
    }));
    const forward = selectRetainedEntries(tied).map(e => e.hooks);
    const reversed = selectRetainedEntries([...tied].reverse()).map(
      e => e.hooks
    );
    expect(forward).toHaveLength(MAX_REGISTRY_ENTRIES_PER_PAIR);
    expect([...forward].sort()).toEqual([...reversed].sort());
    // The evicted entry is deterministic: the seventh-smallest hooks address
    // falls out of the oldest slice and is not in the newest window either.
    expect(forward).not.toContain(hooks[6]);
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

  it('incremental retention equals one batch retention over the full list, in any arrival order', () => {
    // A flooded pair in both partitions, with exact-timestamp ties and an
    // unprovable age, arriving out of time order (the read's row order is
    // unspecified and unrelated to Initialize time). The reference is the
    // batch policy itself — selectRetainedEntries over everything — so this
    // pins the streaming fold to the retention contract rather than to a
    // hand-derived list.
    const hookedChains = new Set([1]);
    const mainnetHook = registryAdmissibleHookAddresses(1, hookedChains)[0]!;
    const timestamps = (i: number) =>
      i % 5 === 0
        ? new Date(NaN) // no provable age → sorts newest
        : new Date(1_700_000_000_000 + ((i * 7919) % 13) * 86_400_000);
    const hookless: V4PoolKey[] = Array.from({length: 23}, (_, i) =>
      row({
        feeBips: 111 + i,
        tickSpacing: 3,
        poolId: poolIdFor(1, USDC, SIERRA, 111 + i, 3),
        poolCreatedAtBlockTimestamp: timestamps(i),
      })
    );
    const hooked: V4PoolKey[] = Array.from({length: 17}, (_, i) =>
      row({
        feeBips: 1234 + i,
        tickSpacing: 7,
        hooksAddress: mainnetHook,
        poolId: poolIdFor(1, USDC, SIERRA, 1234 + i, 7, mainnetHook),
        poolCreatedAtBlockTimestamp: timestamps(i + 3),
      })
    );
    const all = [...hookless, ...hooked];
    // Deterministic shuffle: 41 is coprime with 40, so i*41 mod 40 is a
    // permutation.
    const shuffled = all.map((_, i) => all[(i * 41) % all.length]!);

    const accumulator = new V4PoolKeyRegistryAccumulator(1, hookedChains);
    for (const r of shuffled) accumulator.add(r);
    const {file, stats} = accumulator.finish(GENERATED_AT);

    const toCandidate = (r: V4PoolKey) => ({
      fee: r.feeBips,
      tickSpacing: r.tickSpacing,
      hooks: r.hooksAddress ?? undefined,
      createdAtMs: Number.isFinite(r.poolCreatedAtBlockTimestamp.getTime())
        ? r.poolCreatedAtBlockTimestamp.getTime()
        : Number.MAX_SAFE_INTEGER,
    });
    const expected = [
      ...selectRetainedEntries(
        shuffled.filter(r => r.hooksAddress === null).map(toCandidate)
      ).map(e => [e.fee, e.tickSpacing]),
      ...selectRetainedEntries(
        shuffled.filter(r => r.hooksAddress !== null).map(toCandidate)
      ).map(e => [e.fee, e.tickSpacing, e.hooks]),
    ];
    const actual = file.pairs[v4RegistryPairKey(USDC, SIERRA)]!;
    expect(actual).toHaveLength(2 * MAX_REGISTRY_ENTRIES_PER_PAIR);
    expect([...actual].sort()).toEqual([...expected].sort());
    expect(accumulator.rowCount).toBe(all.length);
    expect(stats).toEqual({
      included: 2 * MAX_REGISTRY_ENTRIES_PER_PAIR,
      includedHooked: MAX_REGISTRY_ENTRIES_PER_PAIR,
      skippedCanonical: 0,
      skippedHooked: 0,
      skippedInvalidId: 0,
      truncatedPairs: 1,
      pairs: 1,
    });
  });

  it('counts every offered row, admitted or not, and finish() is repeatable', () => {
    const accumulator = new V4PoolKeyRegistryAccumulator(1, new Set());
    accumulator.add(row({}));
    accumulator.add(row({feeBips: 475})); // fails the keccak check
    accumulator.add(
      row({
        feeBips: 3000,
        tickSpacing: 60,
        poolId: poolIdFor(1, USDC, SIERRA, 3000, 60),
      })
    );
    expect(accumulator.rowCount).toBe(3);
    const first = accumulator.finish(GENERATED_AT);
    const second = accumulator.finish(GENERATED_AT);
    expect(first.stats).toEqual({
      included: 1,
      includedHooked: 0,
      skippedCanonical: 1,
      skippedHooked: 0,
      skippedInvalidId: 1,
      truncatedPairs: 0,
      pairs: 1,
    });
    expect(second).toEqual(first);
  });
});

/**
 * Closure Fake: `forEachV4PoolKeyPage` replays configured pages exactly as
 * the Aurora impl would (sequential, awaiting the callback between pages);
 * the full-set reads are not part of the registry's contract and throw.
 */
class FakeRoutablePoolsService implements RoutablePoolsService {
  readonly calls: ListPoolKeysOptions[] = [];
  constructor(
    private readonly pagesByChain: ReadonlyMap<
      number,
      readonly (readonly V4PoolKey[])[] | Error
    >
  ) {}

  listAllV2RoutablePools(
    _ctx: Context,
    _options: ListRoutablePoolsOptions
  ): Promise<V2RoutablePool[]> {
    return Promise.reject(new Error('not part of the registry contract'));
  }
  listAllV3RoutablePools(
    _ctx: Context,
    _options: ListRoutablePoolsOptions
  ): Promise<V3RoutablePool[]> {
    return Promise.reject(new Error('not part of the registry contract'));
  }
  listAllV4RoutablePools(
    _ctx: Context,
    _options: ListRoutablePoolsOptions
  ): Promise<V4RoutablePool[]> {
    return Promise.reject(new Error('not part of the registry contract'));
  }
  listAllV4PoolKeys(
    _ctx: Context,
    _options: ListPoolKeysOptions
  ): Promise<V4PoolKey[]> {
    return Promise.reject(
      new Error('the registry must stream, never load a whole chain')
    );
  }
  async forEachV4PoolKeyPage(
    _ctx: Context,
    options: ListPoolKeysOptions,
    onPage: (page: readonly V4PoolKey[]) => Promise<void> | void
  ): Promise<void> {
    this.calls.push(options);
    const pages = this.pagesByChain.get(Number(options.chainId));
    if (pages === undefined) return;
    if (pages instanceof Error) throw pages;
    for (const page of pages) await onPage(page);
  }
}

interface RecordedPut {
  key: string;
  body: Buffer;
  metadata: Record<string, string>;
  condition: {IfMatch?: string; IfNoneMatch?: string};
}

/** Answers HEAD from a configurable incumbent and records every PUT. */
class FakeRegistryObjectClient implements RegistryObjectClient {
  readonly puts: RecordedPut[] = [];
  constructor(
    private readonly incumbent?: {
      etag: string;
      generatedAtMs: number;
      rowCount: number;
    }
  ) {}

  send(command: HeadObjectCommand): Promise<HeadObjectCommandOutput>;
  send(command: PutObjectCommand): Promise<PutObjectCommandOutput>;
  send(
    command: HeadObjectCommand | PutObjectCommand
  ): Promise<HeadObjectCommandOutput | PutObjectCommandOutput> {
    if (command instanceof HeadObjectCommand) {
      if (!this.incumbent) {
        return Promise.reject(
          new NotFound({$metadata: {httpStatusCode: 404}, message: 'NotFound'})
        );
      }
      return Promise.resolve({
        $metadata: {httpStatusCode: 200},
        ETag: this.incumbent.etag,
        Metadata: {
          [GENERATED_AT_METADATA_KEY]: String(this.incumbent.generatedAtMs),
          [ROW_COUNT_METADATA_KEY]: String(this.incumbent.rowCount),
        },
      });
    }
    const {Key, Body, Metadata, IfMatch, IfNoneMatch} = command.input;
    if (typeof Key !== 'string' || !Buffer.isBuffer(Body)) {
      return Promise.reject(new Error('unexpected PutObject shape'));
    }
    this.puts.push({
      key: Key,
      body: Body,
      metadata: Metadata ?? {},
      condition: {IfMatch, IfNoneMatch},
    });
    return Promise.resolve({$metadata: {httpStatusCode: 200}, ETag: '"new"'});
  }
}

describe('materializeV4PoolKeyRegistriesFrom', () => {
  const CHAIN = 1;
  const hookedChains = new Set([CHAIN]);
  const config = {s3Bucket: 'pool-cache'};

  function offGrid(fee: number, createdAt: string): V4PoolKey {
    return row({
      feeBips: fee,
      tickSpacing: 3,
      poolId: poolIdFor(CHAIN, USDC, SIERRA, fee, 3),
      poolCreatedAtBlockTimestamp: new Date(createdAt),
    });
  }

  beforeEach(() => {
    resetV4PoolKeyRegistryBaselinesForTesting();
  });

  it('folds every page into one object the serving reader accepts, with the scan size as metadata', async () => {
    const pages = [
      [
        offGrid(111, '2026-01-01T00:00:00Z'),
        offGrid(112, '2026-01-02T00:00:00Z'),
      ],
      [
        offGrid(113, '2026-01-03T00:00:00Z'),
        row({
          feeBips: 3000,
          tickSpacing: 60,
          poolId: poolIdFor(CHAIN, USDC, SIERRA, 3000, 60),
        }),
      ],
      [offGrid(114, '2026-01-04T00:00:00Z')],
    ];
    const pools = new FakeRoutablePoolsService(new Map([[CHAIN, pages]]));
    const s3 = new FakeRegistryObjectClient();
    const metric = new CollectingMetric();
    const logger = new CollectingLogger();

    await materializeV4PoolKeyRegistriesFrom({
      routablePools: pools,
      chains: new Set([CHAIN]),
      hookedChains,
      s3,
      config,
      logger,
      metric,
    });

    expect(s3.puts).toHaveLength(1);
    const put = s3.puts[0]!;
    expect(put.key).toBe('v4PoolKeyRegistryGzip.json-1');
    expect(put.condition).toEqual({IfMatch: undefined, IfNoneMatch: '*'});
    expect(put.metadata[ROW_COUNT_METADATA_KEY]).toBe('5');
    const parsed = parseV4PoolKeyRegistryFile(
      zlib.inflateSync(put.body).toString('utf8'),
      CHAIN
    );
    expect(parsed?.pairs).toEqual({
      [v4RegistryPairKey(USDC, SIERRA)]: [
        [111, 3],
        [112, 3],
        [113, 3],
        [114, 3],
      ],
    });
    expect(metric.withKey('CachePools.v4PoolKeyRegistry.keys')).toEqual([
      {
        key: 'CachePools.v4PoolKeyRegistry.keys',
        value: 4,
        tags: {chainId: '1'},
      },
    ]);
    expect(metric.withKey('CachePools.v4PoolKeyRegistry.error')).toEqual([]);
    expect(
      logger.lines.some(
        line =>
          line.level === 'info' &&
          line.message.startsWith('V4 PoolKey registry chain 1: pairs=1 ') &&
          line.message.includes(' rows=5 ')
      )
    ).toBe(true);
    // The cron's server-side filter must reach the pool source unchanged.
    expect(pools.calls).toHaveLength(1);
    expect(
      pools.calls[0]?.poolKeyFilter?.excludedHooklessFeeTickSpacings
    ).toContainEqual([3000, 60]);
    expect(pools.calls[0]?.poolKeyFilter?.allowedHooks).toEqual(
      expect.arrayContaining(
        registryAdmissibleHookAddresses(CHAIN, hookedChains)
      )
    );
  });

  it('keeps the incumbent when the scan returns no rows', async () => {
    const pools = new FakeRoutablePoolsService(new Map([[CHAIN, []]]));
    const s3 = new FakeRegistryObjectClient({
      etag: '"old"',
      generatedAtMs: 1,
      rowCount: 100,
    });
    const metric = new CollectingMetric();

    await materializeV4PoolKeyRegistriesFrom({
      routablePools: pools,
      chains: new Set([CHAIN]),
      hookedChains,
      s3,
      config,
      logger: noopLogger,
      metric,
    });

    expect(s3.puts).toEqual([]);
    expect(metric.withKey('CachePools.v4PoolKeyRegistry.error')).toEqual([
      {
        key: 'CachePools.v4PoolKeyRegistry.error',
        value: 1,
        tags: {chainId: '1', reason: 'no_metadata_rows'},
      },
    ]);
  });

  it('keeps the incumbent when the scan collapses against its durable row count', async () => {
    const pools = new FakeRoutablePoolsService(
      new Map([[CHAIN, [[offGrid(111, '2026-01-01T00:00:00Z')]]]])
    );
    const s3 = new FakeRegistryObjectClient({
      etag: '"old"',
      generatedAtMs: 1,
      rowCount: 1000,
    });
    const metric = new CollectingMetric();
    const logger = new CollectingLogger();

    await materializeV4PoolKeyRegistriesFrom({
      routablePools: pools,
      chains: new Set([CHAIN]),
      hookedChains,
      s3,
      config,
      logger,
      metric,
    });

    expect(s3.puts).toEqual([]);
    expect(metric.withKey('CachePools.v4PoolKeyRegistry.error')).toEqual([
      {
        key: 'CachePools.v4PoolKeyRegistry.error',
        value: 1,
        tags: {chainId: '1', reason: 'row_count_collapse'},
      },
    ]);
    expect(
      logger.lines.some(
        line =>
          line.level === 'warn' &&
          line.message.includes('1 metadata rows collapsed vs baseline') &&
          line.message.includes('incumbent=1000')
      )
    ).toBe(true);
  });

  it('a failing scan on one chain is contained and the next chain still materializes', async () => {
    const pools = new FakeRoutablePoolsService(
      new Map<number, readonly (readonly V4PoolKey[])[] | Error>([
        [CHAIN, new Error('statement timeout')],
        [137, [[offGrid(111, '2026-01-01T00:00:00Z')]]],
      ])
    );
    const s3 = new FakeRegistryObjectClient();
    const metric = new CollectingMetric();

    await materializeV4PoolKeyRegistriesFrom({
      routablePools: pools,
      chains: new Set([CHAIN, 137]),
      hookedChains,
      s3,
      config,
      logger: noopLogger,
      metric,
    });

    expect(metric.withKey('CachePools.v4PoolKeyRegistry.error')).toEqual([
      {
        key: 'CachePools.v4PoolKeyRegistry.error',
        value: 1,
        tags: {chainId: '1', reason: 'materialize_failed'},
      },
    ]);
    // Chain 137's pool id is derived for chain 1 above, so its row fails the
    // keccak check and is skipped — the object is still written because the
    // scan itself succeeded with rows.
    expect(s3.puts.map(put => put.key)).toEqual([
      'v4PoolKeyRegistryGzip.json-137',
    ]);
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

  it('keeps deployed two-field entries while parsing vetted three-field entries separately', () => {
    const hooked = ARRAKIS_PRIVATE_HOOK_V2;
    const json = JSON.stringify({
      version: 1,
      chainId: 8453,
      generatedAtMs: GENERATED_AT,
      pairs: {
        'a:b': [
          [375, 4],
          [DYNAMIC_FEE_FLAG, 5, hooked],
          [DYNAMIC_FEE_FLAG, 5],
          [375, 4, ADDRESS_ZERO],
          [375, 4, '0xBAD'],
        ],
      },
    });
    expect(parseV4PoolKeyRegistryFile(json, 8453)!.pairs['a:b']).toEqual([
      [375, 4],
      [DYNAMIC_FEE_FLAG, 5, hooked],
    ]);
  });

  it('caps hookless and hooked entries independently', () => {
    const hooked = ARRAKIS_PRIVATE_HOOK_V2;
    const json = JSON.stringify({
      version: 1,
      chainId: 8453,
      generatedAtMs: GENERATED_AT,
      pairs: {
        'a:b': [
          ...Array.from({length: 10}, (_, fee) => [fee + 1, 1]),
          ...Array.from({length: 10}, (_, fee) => [fee + 1, 1, hooked]),
        ],
      },
    });
    expect(parseV4PoolKeyRegistryFile(json, 8453)!.pairs['a:b']).toHaveLength(
      MAX_REGISTRY_ENTRIES_PER_PAIR * 2
    );
  });

  it('admits the X Layer Arrakis pool PoolKey when 196 is hooked-enabled (ROUTE-1926)', () => {
    const previous = process.env.V4_POOLKEY_REGISTRY_HOOKED_CHAINS;
    process.env.V4_POOLKEY_REGISTRY_HOOKED_CHAINS =
      '1,10,56,137,196,4663,8453,42161';
    try {
      // The partner-reported X Layer pool, verbatim from Aurora
      // v4_pool_metadata: dynamic-fee sentinel with tickSpacing 4 — off-grid
      // because the PAIR (fee, tickSpacing) is what canonicality means; 4
      // alone is on the grid (375/4).
      expect(
        registryAdmissibleHookAddresses(196).includes(ARRAKIS_PRIVATE_HOOK_V2)
      ).toBe(true);
      const {file, stats} = buildV4PoolKeyRegistry(
        196,
        [
          row({
            feeBips: DYNAMIC_FEE_FLAG,
            tickSpacing: 4,
            hooksAddress: ARRAKIS_PRIVATE_HOOK_V2,
            poolId: V4SDKPool.getPoolId(
              new Token(196, USDC, 18),
              new Token(196, SIERRA, 18),
              DYNAMIC_FEE_FLAG,
              4,
              ARRAKIS_PRIVATE_HOOK_V2
            ).toLowerCase(),
          }),
        ],
        GENERATED_AT
      );
      expect(stats.includedHooked).toBe(1);
      expect(file.pairs[v4RegistryPairKey(USDC, SIERRA)]).toEqual([
        [DYNAMIC_FEE_FLAG, 4, ARRAKIS_PRIVATE_HOOK_V2],
      ]);
    } finally {
      if (previous === undefined) {
        delete process.env.V4_POOLKEY_REGISTRY_HOOKED_CHAINS;
      } else {
        process.env.V4_POOLKEY_REGISTRY_HOOKED_CHAINS = previous;
      }
    }
  });

  it('registryAdmissibleHookAddresses lists exactly the per-chain admissible set', () => {
    const hookedChains = new Set([8453]);
    const addresses = registryAdmissibleHookAddresses(8453, hookedChains);
    // Every listed address must pass the shared per-hook trust boundary, and
    // the set must include the ROUTE-1837 hook while excluding the aggregator
    // hooks the Base allowlist embeds (Slipstream).
    expect(addresses).toContain(ARRAKIS_PRIVATE_HOOK_V2);
    expect(addresses).not.toContain(
      '0xa167c254ef8a24bda465760dc1969a5ce37ae888'
    );
    for (const hooks of addresses) {
      expect(isRegistryAdmissibleHook(8453, hooks, hookedChains)).toBe(true);
    }
    // Gate off → empty, so the cron's server-side Aurora filter degrades to
    // hookless-only rather than reading hooked rows it would then discard.
    expect(registryAdmissibleHookAddresses(8453, new Set())).toEqual([]);
  });

  it('admits only allowlisted, non-aggregator hooks on hooked-enabled chains', () => {
    const hookedChains = new Set([8453]);
    // ARRAKIS_PRIVATE_HOOK_V2 is in the real Base allowlist and is not an
    // aggregator or permissioned hook — the one class registry probing serves.
    expect(
      isRegistryAdmissibleHook(8453, ARRAKIS_PRIVATE_HOOK_V2, hookedChains)
    ).toBe(true);
    // Chain gate wins over allowlisting: same hook, gate off.
    expect(
      isRegistryAdmissibleHook(8453, ARRAKIS_PRIVATE_HOOK_V2, new Set())
    ).toBe(false);
    // Never in any allowlist.
    expect(
      isRegistryAdmissibleHook(
        8453,
        '0x00000000000000000000000000000000000000ff',
        hookedChains
      )
    ).toBe(false);
    // Slipstream is inside HOOKS_ADDRESSES_ALLOWLIST on Base via the agg-hook
    // spread, but agg-hook pools belong to their own selector and quoting
    // path — synthesizing them as plain V4 pools here would bypass it.
    expect(
      isRegistryAdmissibleHook(
        8453,
        '0xa167c254ef8a24bda465760dc1969a5ce37ae888',
        hookedChains
      )
    ).toBe(false);
    // The zero address is a hookless marker, never a hooked entry.
    expect(isRegistryAdmissibleHook(8453, ADDRESS_ZERO, hookedChains)).toBe(
      false
    );
  });

  it('a per-chain hook restriction narrows admission to the listed hooks and shrinks the Aurora filter with it', () => {
    const hookedChains = new Set([8453, 4663]);
    // Zora's V4 coin hook: allowlisted on Base and admissible with NO
    // restriction — the class of hook that put ~15M pools into the Base read.
    const zoraCoinHook = '0x0469a4bd3724dc86c9542f4694c976da13c450c0';
    const unrestricted: RestrictedRegistryHooksByChain = new Map();
    expect(
      isRegistryAdmissibleHook(8453, zoraCoinHook, hookedChains, unrestricted)
    ).toBe(true);
    // With the defaults (no env) Base is already restricted to Arrakis.
    expect(isRegistryAdmissibleHook(8453, zoraCoinHook, hookedChains)).toBe(
      false
    );

    const restricted: RestrictedRegistryHooksByChain = new Map([
      [8453, new Set([ARRAKIS_PRIVATE_HOOK_V2])],
    ]);
    expect(
      isRegistryAdmissibleHook(8453, zoraCoinHook, hookedChains, restricted)
    ).toBe(false);
    expect(
      isRegistryAdmissibleHook(
        8453,
        ARRAKIS_PRIVATE_HOOK_V2,
        hookedChains,
        restricted
      )
    ).toBe(true);
    // Casing of the row's hook must not matter, same as the allowlist check.
    expect(
      isRegistryAdmissibleHook(
        8453,
        ARRAKIS_PRIVATE_HOOK_V2.toUpperCase().replace('0X', '0x'),
        hookedChains,
        restricted
      )
    ).toBe(true);
    // Narrowing only: a restricted hook that is NOT allowlisted stays out.
    const notAllowlisted = new Map([
      [8453, new Set(['0x00000000000000000000000000000000000000ff'])],
    ]);
    expect(
      isRegistryAdmissibleHook(
        8453,
        '0x00000000000000000000000000000000000000ff',
        hookedChains,
        notAllowlisted
      )
    ).toBe(false);
    // Unlisted chains are untouched by another chain's restriction.
    const robinhoodBefore = registryAdmissibleHookAddresses(
      4663,
      hookedChains,
      unrestricted
    );
    expect(
      registryAdmissibleHookAddresses(4663, hookedChains, restricted)
    ).toEqual(robinhoodBefore);
    expect(robinhoodBefore.length).toBeGreaterThan(1);
    // The cron's server-side filter derives from the same predicate, so the
    // Base read narrows to exactly the restricted set.
    expect(
      registryAdmissibleHookAddresses(8453, hookedChains, restricted)
    ).toEqual([ARRAKIS_PRIVATE_HOOK_V2]);
  });

  it('hook restrictions: code defaults hold with no env, the override only narrows, and failure modes fail closed', () => {
    const prev = process.env.V4_POOLKEY_REGISTRY_HOOKS_BY_CHAIN;
    const arrakisOnBase = new Set(
      DEFAULT_REGISTRY_HOOK_RESTRICTIONS[8453].map(h => h.toLowerCase())
    );
    try {
      // No env: the code defaults are the restriction, with no problems.
      delete process.env.V4_POOLKEY_REGISTRY_HOOKS_BY_CHAIN;
      const defaults = v4PoolKeyRegistryHookRestrictionsFromEnv();
      expect(defaults.problems).toEqual([]);
      expect(defaults.byChain.get(8453)).toEqual(arrakisOnBase);
      expect(arrakisOnBase.has(ARRAKIS_PRIVATE_HOOK_V2)).toBe(true);
      expect(defaults.byChain.has(4663)).toBe(false);

      // Override: a chain without a code default is narrowed to its list
      // (lowercased, junk dropped); a chain whose entries are all invalid is
      // CLOSED, not unrestricted, and reported. Unmentioned chains keep their
      // defaults.
      process.env.V4_POOLKEY_REGISTRY_HOOKS_BY_CHAIN = JSON.stringify({
        4663: [
          ARRAKIS_PRIVATE_HOOK_V2.toUpperCase().replace('0X', '0x'),
          'not-an-address',
          ADDRESS_ZERO,
        ],
        137: ['junk-only'],
      });
      const overridden = v4PoolKeyRegistryHookRestrictionsFromEnv();
      expect([...(overridden.byChain.get(4663) ?? [])]).toEqual([
        ARRAKIS_PRIVATE_HOOK_V2,
      ]);
      expect(overridden.byChain.get(137)?.size).toBe(0);
      expect(
        isRegistryAdmissibleHook(
          137,
          ARRAKIS_PRIVATE_HOOK_V2,
          new Set([137]),
          overridden.byChain
        )
      ).toBe(false);
      expect(overridden.byChain.get(8453)).toEqual(arrakisOnBase);
      expect(overridden.problems).toEqual([
        {kind: 'no_valid_hooks', chainId: 137},
      ]);
      // Same env value → same instance (this runs per hooked row).
      expect(v4PoolKeyRegistryHookRestrictionsFromEnv()).toBe(overridden);

      // Malformed value: defaults stay in force (Base stays restricted) and
      // the problem is reported so the cron can raise the error counter.
      // A non-numeric key rejects the WHOLE object — the valid 4663 sibling
      // is not applied — so `malformed_env` always means "nothing from the
      // env took effect", matching the error's every-chain fan-out. For an
      // override-only chain like 4663 that is its status quo (the full
      // allowlist, asserted below), never a narrowing it was not given.
      const unrestrictedRobinhood = registryAdmissibleHookAddresses(
        4663,
        new Set([4663]),
        defaults.byChain
      );
      expect(unrestrictedRobinhood.length).toBeGreaterThan(1);
      for (const malformed of [
        'not json',
        '[1,2]',
        '{"abc":["0x00"]}',
        JSON.stringify({abc: ['0x00'], 4663: [ARRAKIS_PRIVATE_HOOK_V2]}),
      ]) {
        process.env.V4_POOLKEY_REGISTRY_HOOKS_BY_CHAIN = malformed;
        const result = v4PoolKeyRegistryHookRestrictionsFromEnv();
        expect(result.byChain.get(8453)).toEqual(arrakisOnBase);
        expect(result.byChain.has(4663)).toBe(false);
        expect(
          registryAdmissibleHookAddresses(4663, new Set([4663]), result.byChain)
        ).toEqual(unrestrictedRobinhood);
        expect(result.problems).toEqual([{kind: 'malformed_env'}]);
      }

      // An override that names Base with an empty list closes Base entirely
      // rather than widening it.
      process.env.V4_POOLKEY_REGISTRY_HOOKS_BY_CHAIN = '{"8453":[]}';
      expect(registryAdmissibleHookAddresses(8453, new Set([8453]))).toEqual(
        []
      );

      // An override cannot widen Base past its code default: a well-formed
      // list of an allowlisted launchpad hook is intersected with the default
      // (→ nothing) and reported, so the ~15M-row build can never be
      // re-admitted from config.
      const foreignBaseHook = allowlistedBaseHookOutsideDefault();
      process.env.V4_POOLKEY_REGISTRY_HOOKS_BY_CHAIN = JSON.stringify({
        8453: [foreignBaseHook],
      });
      const widened = v4PoolKeyRegistryHookRestrictionsFromEnv();
      expect(widened.byChain.get(8453)?.size).toBe(0);
      expect(widened.problems).toEqual([
        {kind: 'widens_default', chainId: 8453},
      ]);
      expect(registryAdmissibleHookAddresses(8453, new Set([8453]))).toEqual(
        []
      );
      expect(
        isRegistryAdmissibleHook(8453, foreignBaseHook, new Set([8453]))
      ).toBe(false);

      // A mixed list keeps only the default members, and is still reported.
      process.env.V4_POOLKEY_REGISTRY_HOOKS_BY_CHAIN = JSON.stringify({
        8453: [foreignBaseHook, ARRAKIS_PRIVATE_HOOK_V2],
      });
      const mixed = v4PoolKeyRegistryHookRestrictionsFromEnv();
      expect([...(mixed.byChain.get(8453) ?? [])]).toEqual([
        ARRAKIS_PRIVATE_HOOK_V2,
      ]);
      expect(mixed.problems).toEqual([{kind: 'widens_default', chainId: 8453}]);

      // A pure narrowing of Base is applied without complaint.
      process.env.V4_POOLKEY_REGISTRY_HOOKS_BY_CHAIN = JSON.stringify({
        8453: [ARRAKIS_PRIVATE_HOOK_V2],
      });
      const narrowed = v4PoolKeyRegistryHookRestrictionsFromEnv();
      expect([...(narrowed.byChain.get(8453) ?? [])]).toEqual([
        ARRAKIS_PRIVATE_HOOK_V2,
      ]);
      expect(narrowed.problems).toEqual([]);
    } finally {
      if (prev === undefined) {
        delete process.env.V4_POOLKEY_REGISTRY_HOOKS_BY_CHAIN;
      } else {
        process.env.V4_POOLKEY_REGISTRY_HOOKS_BY_CHAIN = prev;
      }
    }
  });

  it('rejects fees and tick spacings outside v4-core bounds', () => {
    const json = JSON.stringify({
      version: 1,
      chainId: 1,
      generatedAtMs: GENERATED_AT,
      pairs: {
        'a:b': [
          [8388608, 60], // dynamic-fee sentinel — out of registry scope
          [1000001, 60], // > sanity ceiling
          [3000, 40000], // > MAX_TICK_SPACING
          [110000, 1990], // ceiling is inclusive
        ],
      },
    });
    expect(parseV4PoolKeyRegistryFile(json, 1)!.pairs['a:b']).toEqual([
      [110000, 1990],
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

    it('raises a per-chain error for a broken hook-restriction override, then keeps going', async () => {
      // The override fails closed, so the run is not aborted — the counter
      // is what makes the misconfiguration visible. A malformed value hits
      // every enabled chain; an all-invalid list hits only its chain.
      const savedChains = process.env.V4_POOLKEY_REGISTRY_CHAINS;
      const savedHost = process.env.DATA_INGESTION_AURORA_HOST;
      const savedRestriction = process.env.V4_POOLKEY_REGISTRY_HOOKS_BY_CHAIN;
      try {
        delete process.env.DATA_INGESTION_AURORA_HOST;
        process.env.V4_POOLKEY_REGISTRY_CHAINS = '1,137';

        process.env.V4_POOLKEY_REGISTRY_HOOKS_BY_CHAIN = 'not json';
        const malformed = new CollectingMetric();
        await materializeV4PoolKeyRegistries(
          {} as S3Client,
          {s3Bucket: 'unused'},
          noopLogger,
          malformed
        );
        expect(
          malformed.emitted
            .filter(e => e.tags?.reason === 'hook_restriction_malformed_env')
            .map(e => e.tags?.chainId)
            .sort()
        ).toEqual(['1', '137']);

        process.env.V4_POOLKEY_REGISTRY_HOOKS_BY_CHAIN = JSON.stringify({
          137: ['junk'],
          8453: ['also-junk'], // not an enabled chain: no emission for it
        });
        const closed = new CollectingMetric();
        await materializeV4PoolKeyRegistries(
          {} as S3Client,
          {s3Bucket: 'unused'},
          noopLogger,
          closed
        );
        expect(
          closed.emitted
            .filter(e => e.tags?.reason === 'hook_restriction_no_valid_hooks')
            .map(e => e.tags?.chainId)
        ).toEqual(['137']);
        // The Aurora init failure is still reported for both chains.
        expect(
          closed.emitted.filter(e => e.tags?.reason === 'env_missing')
        ).toHaveLength(2);

        // A well-formed override that tries to widen Base is reported for
        // Base alone, and Base still builds with the intersected (empty) set.
        process.env.V4_POOLKEY_REGISTRY_CHAINS = '1,8453';
        process.env.V4_POOLKEY_REGISTRY_HOOKS_BY_CHAIN = JSON.stringify({
          8453: [allowlistedBaseHookOutsideDefault()],
        });
        const widened = new CollectingMetric();
        await materializeV4PoolKeyRegistries(
          {} as S3Client,
          {s3Bucket: 'unused'},
          noopLogger,
          widened
        );
        expect(
          widened.emitted
            .filter(e => e.tags?.reason === 'hook_restriction_widens_default')
            .map(e => e.tags?.chainId)
        ).toEqual(['8453']);
        expect(
          widened.emitted.filter(e => e.tags?.reason === 'env_missing')
        ).toHaveLength(2);
      } finally {
        if (savedChains === undefined) {
          delete process.env.V4_POOLKEY_REGISTRY_CHAINS;
        } else {
          process.env.V4_POOLKEY_REGISTRY_CHAINS = savedChains;
        }
        if (savedHost !== undefined) {
          process.env.DATA_INGESTION_AURORA_HOST = savedHost;
        }
        if (savedRestriction === undefined) {
          delete process.env.V4_POOLKEY_REGISTRY_HOOKS_BY_CHAIN;
        } else {
          process.env.V4_POOLKEY_REGISTRY_HOOKS_BY_CHAIN = savedRestriction;
        }
      }
    });
  });
});
