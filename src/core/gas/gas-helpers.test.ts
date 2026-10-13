import {describe, it, expect} from 'vitest';
import {Token} from '@uniswap/sdk-core';
import {ADDRESS_ZERO} from '@uniswap/v3-sdk';
import {buildTestContext} from '@uniswap/lib-testhelpers';
import {Context as UniContext} from '@uniswap/lib-uni/context';
import {
  getHighestLiquidityV2NativePool,
  getHighestLiquidityV3NativePool,
  getHighestLiquidityV4NativePool,
} from './gas-helpers';
import {GasConverter} from './converter/GasConverter';
import {IPoolsRepository} from '../../stores/pool/IPoolsRepository';
import {Pool} from '../../models/pool/Pool';
import {V2Pool} from '../../models/pool/V2Pool';
import {V3Pool} from '../../models/pool/V3Pool';
import {V4Pool} from '../../models/pool/V4Pool';
import {Address} from '../../models/address/Address';
import {Erc20Token} from '../../models/token/Erc20Token';
import {GasDetails} from '../../models/gas/GasDetails';
import {QuoteBasic} from '../../models/quote/QuoteBasic';
import {QuoteSplit} from '../../models/quote/QuoteSplit';
import {RouteBasic} from '../../models/route/RouteBasic';
import {Protocol} from '../../models/pool/Protocol';
import {buildMetricKey, ChainId} from '../../lib/config';
import {PATHUSD_TEMPO} from '../../lib/tokenUtils';

class FakePoolsRepository<TPool extends Pool>
  implements IPoolsRepository<TPool>
{
  public calls = 0;
  constructor(private readonly pools: TPool[]) {}
  async getPools(_ctx: UniContext, _chain: ChainId): Promise<TPool[]> {
    this.calls++;
    return this.pools;
  }
}

const ALL_EMPTY_METRIC = buildMetricKey('GasConverter.AllGasPoolsEmpty');
const NO_GAS_POOL_METRIC = buildMetricKey('GasConverter.NoGasPool');

// Tempo pathUSD/cbBTC v4 pools as StateView reported them on 2026-10-01.
// fee 500 / ts 10 was swapped through its last position to MAX tick on
// 2026-09-30 and has held zero in-range liquidity since; fee 3000 / ts 10
// sits at ~$75k/BTC with its seeded position in range.
const PATHUSD = new Address(PATHUSD_TEMPO.address);
const CBBTC_TEMPO = new Address('0x20C000000000000000000000c412Ec89D0c08be5');
const strandedFee500Pool = new V4Pool(
  PATHUSD,
  CBBTC_TEMPO,
  500,
  10,
  ADDRESS_ZERO,
  0n,
  '0x6cb3a301006d08b58076c2ca5ba13999a860a85e2c1816a140dd6a5922eedecb',
  1461446703485210103287273052203988822378723970341n,
  887271n
);
const seededFee3000Pool = new V4Pool(
  PATHUSD,
  CBBTC_TEMPO,
  3000,
  10,
  ADDRESS_ZERO,
  2238809n,
  '0x51d5133ef1f7317b98228f02f49a5a828035f2c2081584c553db622faa4c6830',
  289217156773386901315892783n,
  -112264n
);
const cbBtcToken = new Token(ChainId.TEMPO, CBBTC_TEMPO.address, 6, 'cbBTC');

describe('getHighestLiquidityV4NativePool', () => {
  it('returns null when every candidate pool has zero in-range liquidity', async () => {
    const ctx = buildTestContext();
    const pool = await getHighestLiquidityV4NativePool(
      cbBtcToken,
      new FakePoolsRepository([strandedFee500Pool]),
      ctx
    );

    expect(pool).toBeNull();
    expect(ctx.metrics.countStore[ALL_EMPTY_METRIC]).toBe(1);
  });

  it('picks the pool with in-range liquidity over a stranded pool', async () => {
    const ctx = buildTestContext();
    const pool = await getHighestLiquidityV4NativePool(
      cbBtcToken,
      new FakePoolsRepository([strandedFee500Pool, seededFee3000Pool]),
      ctx
    );

    expect(pool?.poolId).toBe(seededFee3000Pool.poolId);
    // A dead tier next to a funded pool degrades nothing, so it isn't counted.
    expect(ctx.metrics.countStore[ALL_EMPTY_METRIC]).toBeUndefined();
  });

  it('returns null without counting when no pool exists at all', async () => {
    const ctx = buildTestContext();
    const pool = await getHighestLiquidityV4NativePool(
      cbBtcToken,
      new FakePoolsRepository<V4Pool>([]),
      ctx
    );

    expect(pool).toBeNull();
    expect(ctx.metrics.countStore[ALL_EMPTY_METRIC]).toBeUndefined();
  });
});

describe('getHighestLiquidityV3NativePool', () => {
  const v3Pool = (address: string, liquidity: bigint) =>
    new V3Pool(
      PATHUSD,
      CBBTC_TEMPO,
      3000,
      new Address(address),
      liquidity,
      79228162514264337593543950336n,
      0n
    );

  it('skips zero-liquidity pools even when they are the only candidates', async () => {
    const ctx = buildTestContext();
    const pool = await getHighestLiquidityV3NativePool(
      cbBtcToken,
      new FakePoolsRepository([
        v3Pool('0x1111111111111111111111111111111111111111', 0n),
      ]),
      ctx
    );

    expect(pool).toBeNull();
    expect(ctx.metrics.countStore[ALL_EMPTY_METRIC]).toBe(1);
  });

  it('picks the highest-liquidity pool among those with liquidity', async () => {
    const ctx = buildTestContext();
    const deeper = v3Pool('0x2222222222222222222222222222222222222222', 500n);
    const pool = await getHighestLiquidityV3NativePool(
      cbBtcToken,
      new FakePoolsRepository([
        v3Pool('0x1111111111111111111111111111111111111111', 0n),
        v3Pool('0x3333333333333333333333333333333333333333', 100n),
        deeper,
      ]),
      ctx
    );

    expect(pool?.address.address).toBe(deeper.address.address);
  });
});

describe('getHighestLiquidityV2NativePool', () => {
  const v2Pair = (address: string, reserve0: bigint, reserve1: bigint) =>
    new V2Pool(PATHUSD, CBBTC_TEMPO, new Address(address), reserve0, reserve1);

  it('returns null when every pair has an empty reserve', async () => {
    const ctx = buildTestContext();
    const pool = await getHighestLiquidityV2NativePool(
      cbBtcToken,
      new FakePoolsRepository([
        v2Pair('0x1111111111111111111111111111111111111111', 0n, 0n),
        v2Pair('0x2222222222222222222222222222222222222222', 10n ** 9n, 0n),
      ]),
      ctx
    );

    expect(pool).toBeNull();
    expect(ctx.metrics.countStore[ALL_EMPTY_METRIC]).toBe(1);
  });

  it('skips an empty pair in favour of a funded one', async () => {
    const ctx = buildTestContext();
    const funded = v2Pair(
      '0x3333333333333333333333333333333333333333',
      10n ** 9n,
      10n ** 4n
    );
    const pool = await getHighestLiquidityV2NativePool(
      cbBtcToken,
      new FakePoolsRepository([
        v2Pair('0x1111111111111111111111111111111111111111', 0n, 0n),
        funded,
      ]),
      ctx
    );

    expect(pool?.address.address).toBe(funded.address.address);
    expect(ctx.metrics.countStore[ALL_EMPTY_METRIC]).toBeUndefined();
  });
});

describe('GasConverter pool fallback on Tempo', () => {
  // 237 raw pathUSD of gas: the figure behind the 2026-10-01 rejection, which
  // the stranded pool's MAX-tick price turned into ~8.06e40 raw cbBTC.
  const GAS_COST_IN_WEI = 237n * 10n ** 12n;

  const tokensInfo = new Map<string, Erc20Token | null>([
    [
      PATHUSD.address,
      new Erc20Token(PATHUSD, 6, 'pathUSD', 'pathUSD', undefined, 1),
    ],
    // No priceUSD: cbBTC had none once it went 24h without a Tempo trade,
    // which is what sends gas conversion down the pool path.
    [CBBTC_TEMPO.address, new Erc20Token(CBBTC_TEMPO, 6, 'cbBTC', 'cbBTC')],
  ]);

  const quoteWithGas = (gasCostInWei: bigint) =>
    new QuoteSplit([
      new QuoteBasic(
        new RouteBasic(Protocol.V4, []),
        17n,
        undefined,
        new GasDetails(600000000n, gasCostInWei, 0, 396541n)
      ),
    ]);

  const converterWithV4Pools = (pools: V4Pool[], v3Pools: V3Pool[] = []) => {
    const v4Repository = new FakePoolsRepository(pools);
    return {
      v4Repository,
      converter: new GasConverter(
        new FakePoolsRepository<V2Pool>([]),
        new FakePoolsRepository<V3Pool>(v3Pools),
        v4Repository
      ),
    };
  };

  it('prices gas at zero instead of through the stranded pool', async () => {
    const ctx = buildTestContext();
    const {converter, v4Repository} = converterWithV4Pools([
      strandedFee500Pool,
    ]);
    const quoteSplit = quoteWithGas(GAS_COST_IN_WEI);

    await converter.updateQuotesGasDetails(
      ChainId.TEMPO,
      CBBTC_TEMPO.address,
      tokensInfo,
      [quoteSplit],
      ctx
    );

    expect(v4Repository.calls).toBe(1);
    expect(quoteSplit.quotes[0].gasDetails?.gasCostInQuoteToken).toBe(0n);
    expect(ctx.metrics.countStore[ALL_EMPTY_METRIC]).toBe(1);
    expect(ctx.metrics.countStore[NO_GAS_POOL_METRIC]).toBe(1);
  });

  it('prices gas at zero on the simulation path too', async () => {
    const ctx = buildTestContext();
    const {converter} = converterWithV4Pools([strandedFee500Pool]);

    const gasCostInQuoteToken =
      await converter.getGasCostInQuoteTokenBasedOnGasCostInWei(
        ChainId.TEMPO,
        CBBTC_TEMPO.address,
        tokensInfo,
        GAS_COST_IN_WEI,
        ctx
      );

    expect(gasCostInQuoteToken).toBe(0n);
  });

  it('falls through an empty V3 pool to a funded V4 pool', async () => {
    const ctx = buildTestContext();
    // V3 outranks V4 in the conversion order, so an empty V3 pool that still
    // qualified would shadow the funded V4 pool.
    const emptyV3Pool = new V3Pool(
      PATHUSD,
      CBBTC_TEMPO,
      3000,
      new Address('0x4444444444444444444444444444444444444444'),
      0n,
      1461446703485210103287273052203988822378723970341n,
      887271n
    );
    const {converter} = converterWithV4Pools(
      [seededFee3000Pool],
      [emptyV3Pool]
    );
    const quoteSplit = quoteWithGas(1_000_000_000n * 10n ** 12n);

    await converter.updateQuotesGasDetails(
      ChainId.TEMPO,
      CBBTC_TEMPO.address,
      tokensInfo,
      [quoteSplit],
      ctx
    );

    const gasCostInQuoteToken =
      quoteSplit.quotes[0].gasDetails?.gasCostInQuoteToken ?? 0n;
    expect(gasCostInQuoteToken).toBeGreaterThan(13_000n);
    expect(gasCostInQuoteToken).toBeLessThan(13_700n);
  });

  it('still converts through a pool with in-range liquidity', async () => {
    const ctx = buildTestContext();
    const {converter} = converterWithV4Pools([
      strandedFee500Pool,
      seededFee3000Pool,
    ]);
    // $1,000 of gas, so the conversion lands well clear of rounding to zero.
    const quoteSplit = quoteWithGas(1_000_000_000n * 10n ** 12n);

    await converter.updateQuotesGasDetails(
      ChainId.TEMPO,
      CBBTC_TEMPO.address,
      tokensInfo,
      [quoteSplit],
      ctx
    );

    // ~$75k/BTC puts $1,000 at roughly 0.0133 cbBTC (13,3xx raw units).
    const gasCostInQuoteToken =
      quoteSplit.quotes[0].gasDetails?.gasCostInQuoteToken ?? 0n;
    expect(gasCostInQuoteToken).toBeGreaterThan(13_000n);
    expect(gasCostInQuoteToken).toBeLessThan(13_700n);
  });
});
