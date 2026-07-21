import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {S3Client} from '@aws-sdk/client-s3';
import {buildTestContext} from '@uniswap/lib-testhelpers';
import {Context} from '@uniswap/lib-uni/context';
import {
  CcaScheduledPoolsRepository,
  CcaScheduledPoolsRepositoryConfig,
} from './CcaScheduledPoolsRepository';
import {CcaScheduledPoolEntry} from '../../lib/poolCaching/ccaScheduledPools';
import {ChainId} from '../../lib/config';

const ZERO = '0x0000000000000000000000000000000000000000';
const NOW = 1_800_000_000_000;

const makeEntry = (
  overrides: Partial<CcaScheduledPoolEntry> = {}
): CcaScheduledPoolEntry => ({
  id: '0xPoolId',
  token0: {id: ZERO},
  token1: {id: '0xToken'},
  feeTier: '10000',
  tickSpacing: '200',
  hooks: ZERO,
  liquidity: '1',
  tvlETH: 0,
  tvlUSD: 0,
  migrationBlock: '2000',
  activateAtMs: NOW - 1_000,
  expiresAtMs: NOW + 60_000,
  auctionAddress: '0xAuction',
  strategyAddress: '0xStrategy',
  launchedToken: '0xToken',
  ...overrides,
});

describe('CcaScheduledPoolsRepository', () => {
  let ctx: Context;
  let s3: S3Client;
  let config: CcaScheduledPoolsRepositoryConfig;
  let entries: CcaScheduledPoolEntry[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    ctx = buildTestContext();
    entries = [makeEntry()];
    s3 = {
      send: vi.fn(async () => ({
        Body: {transformToString: async () => JSON.stringify(entries)},
      })),
    } as unknown as S3Client;
    config = {
      mergeEnabled: true,
      s3Bucket: 'pool-bucket',
      s3BaseKey: 'ccaScheduledPools.json',
      cacheTtlMs: 45_000,
      activationSlackMs: 30_000,
      coldStartMaxWaitMs: 250,
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns [] without touching S3 when merge is disabled', async () => {
    const repository = new CcaScheduledPoolsRepository(s3, {
      ...config,
      mergeEnabled: false,
    });

    expect(await repository.getActivePools(ChainId.MAINNET, ctx)).toEqual([]);
    expect(s3.send).not.toHaveBeenCalled();
  });

  it('serves active entries as V4PoolInfo with the launched token', async () => {
    const repository = new CcaScheduledPoolsRepository(s3, config);

    const pools = await repository.getActivePools(ChainId.MAINNET, ctx);

    expect(pools).toEqual([
      {
        pool: {
          id: '0xpoolid',
          feeTier: '10000',
          liquidity: '1',
          tickSpacing: '200',
          hooks: ZERO,
          token0: {id: ZERO},
          token1: {id: '0xtoken'},
          tvlETH: 0,
          tvlUSD: 0,
        },
        launchedToken: '0xtoken',
      },
    ]);
  });

  it('skips malformed entries without a launched token', async () => {
    entries = [
      makeEntry({
        launchedToken: undefined as unknown as string,
        id: '0xLegacy',
      }),
      makeEntry(),
    ];
    const repository = new CcaScheduledPoolsRepository(s3, config);

    const pools = await repository.getActivePools(ChainId.MAINNET, ctx);

    expect(pools.map(p => p.pool.id)).toEqual(['0xpoolid']);
  });

  it('skips entries missing numeric tvl fields (schema skew)', async () => {
    entries = [
      makeEntry({tvlETH: undefined as unknown as number, id: '0xNoTvl'}),
      makeEntry(),
    ];
    const repository = new CcaScheduledPoolsRepository(s3, config);

    const pools = await repository.getActivePools(ChainId.MAINNET, ctx);

    expect(pools.map(p => p.pool.id)).toEqual(['0xpoolid']);
  });

  it('fails open past coldStartMaxWaitMs when the first fetch is slow, then serves once warm', async () => {
    let resolveFetch!: (value: {
      Body: {transformToString: () => Promise<string>};
    }) => void;
    vi.mocked(s3.send).mockImplementationOnce(
      () => new Promise(resolve => (resolveFetch = resolve)) as never
    );
    const repository = new CcaScheduledPoolsRepository(s3, config);

    const firstCall = repository.getActivePools(ChainId.MAINNET, ctx);
    await vi.advanceTimersByTimeAsync(config.coldStartMaxWaitMs);
    expect(await firstCall).toEqual([]);

    // The coalesced fetch keeps running and warms the cache.
    resolveFetch({
      Body: {transformToString: async () => JSON.stringify(entries)},
    });
    await vi.advanceTimersByTimeAsync(0);
    const second = await repository.getActivePools(ChainId.MAINNET, ctx);
    expect(second.map(p => p.pool.id)).toEqual(['0xpoolid']);
  });

  it('applies the activation slack and expiry window', async () => {
    entries = [
      makeEntry({id: '0xTooEarly', activateAtMs: NOW + 31_000}),
      makeEntry({id: '0xWithinSlack', activateAtMs: NOW + 29_000}),
      makeEntry({id: '0xExpired', expiresAtMs: NOW - 1}),
    ];
    const repository = new CcaScheduledPoolsRepository(s3, config);

    const pools = await repository.getActivePools(ChainId.MAINNET, ctx);

    expect(pools.map(p => p.pool.id)).toEqual(['0xwithinslack']);
  });

  it('caches the registry per chain within cacheTtlMs', async () => {
    const repository = new CcaScheduledPoolsRepository(s3, config);

    await repository.getActivePools(ChainId.MAINNET, ctx);
    await repository.getActivePools(ChainId.MAINNET, ctx);
    expect(s3.send).toHaveBeenCalledTimes(1);

    vi.setSystemTime(NOW + 46_000);
    await repository.getActivePools(ChainId.MAINNET, ctx);
    expect(s3.send).toHaveBeenCalledTimes(2);
  });

  it('fails open (and caches the miss) on S3 errors', async () => {
    const metricsSpy = vi.spyOn(ctx.metrics, 'count');
    vi.mocked(s3.send).mockRejectedValue(new Error('s3 down') as never);
    const repository = new CcaScheduledPoolsRepository(s3, config);

    expect(await repository.getActivePools(ChainId.MAINNET, ctx)).toEqual([]);
    expect(await repository.getActivePools(ChainId.MAINNET, ctx)).toEqual([]);
    expect(s3.send).toHaveBeenCalledTimes(1);
    expect(metricsSpy).toHaveBeenCalledWith(
      expect.stringContaining('CcaScheduledPools.fetchError'),
      1,
      expect.anything()
    );
  });

  it('serves stale entries when the TTL has lapsed and the refresh fails', async () => {
    const repository = new CcaScheduledPoolsRepository(s3, config);
    // Prime the cache.
    await repository.getActivePools(ChainId.MAINNET, ctx);

    vi.mocked(s3.send).mockRejectedValue(new Error('s3 down') as never);
    vi.setSystemTime(NOW + 46_000);

    // TTL expired: stale entries served immediately (no blocking on S3), and
    // the failed background refresh keeps them rather than clearing to [].
    const stale = await repository.getActivePools(ChainId.MAINNET, ctx);
    expect(stale.map(p => p.pool.id)).toEqual(['0xpoolid']);
    const after = await repository.getActivePools(ChainId.MAINNET, ctx);
    expect(after.map(p => p.pool.id)).toEqual(['0xpoolid']);
  });

  it('treats NoSuchKey as an empty registry without the error metric', async () => {
    const metricsSpy = vi.spyOn(ctx.metrics, 'count');
    const noSuchKey = new Error('NoSuchKey');
    noSuchKey.name = 'NoSuchKey';
    vi.mocked(s3.send).mockRejectedValue(noSuchKey as never);
    const repository = new CcaScheduledPoolsRepository(s3, config);

    expect(await repository.getActivePools(ChainId.MAINNET, ctx)).toEqual([]);
    expect(metricsSpy).not.toHaveBeenCalled();
  });
});
