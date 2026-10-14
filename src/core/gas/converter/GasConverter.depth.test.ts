import {describe, expect, it} from 'vitest';
import {buildTestContext} from '@uniswap/lib-testhelpers';
import {CurrencyAmount} from '@uniswap/sdk-core';
import {Pair} from '@uniswap/v2-sdk';
import {GasConverter} from './GasConverter';
import {IPoolsRepository} from '../../../stores/pool/IPoolsRepository';
import {Pool} from '../../../models/pool/Pool';
import {V2Pool} from '../../../models/pool/V2Pool';
import {V3Pool} from '../../../models/pool/V3Pool';
import {V4Pool} from '../../../models/pool/V4Pool';
import {Erc20Token} from '../../../models/token/Erc20Token';
import {GasDetails} from '../../../models/gas/GasDetails';
import {QuoteBasic} from '../../../models/quote/QuoteBasic';
import {RouteBasic} from '../../../models/route/RouteBasic';
import {Protocol} from '../../../models/pool/Protocol';
import {buildMetricKey, ChainId} from '../../../lib/config';
import {
  createDawaePools,
  createRplPools,
  createV4Pool,
  gasToken,
  rpl,
  weth,
} from '../../../../tests/fixtures/nativeGasPools';
import {Context} from '@uniswap/lib-uni/context';
import {Address} from '../../../models/address/Address';

class FakePoolsRepository<T extends Pool> implements IPoolsRepository<T> {
  constructor(
    private readonly getFixedPools: (blockNumber?: number) => T[] | Promise<T[]>
  ) {}
  async getPools(
    _ctx: Context,
    _chain: ChainId,
    _tokenIn: Address,
    _tokenOut: Address,
    _fees?: number[],
    _tickSpacings?: number[],
    _hooks?: string[],
    _poolIds?: string[],
    blockNumber?: number
  ): Promise<T[]> {
    return this.getFixedPools(blockNumber);
  }
}

// Exercise the real Price.quote division-by-zero path after SDK conversion.
class FakeZeroReserveSdkPool extends V2Pool implements V2Pool {
  override toV2SDKPool(): Pair {
    return new Pair(
      CurrencyAmount.fromRawAmount(gasToken, '0'),
      CurrencyAmount.fromRawAmount(
        new Erc20Token(rpl, 18, 'RPL', 'Rocket Pool').toSdkToken(
          ChainId.MAINNET
        ),
        '1'
      )
    );
  }
}

const gasCostInWei = 54_000_000_000_000n;
const expectedRplCost = gasCostInWei * 1430n;
function expectRplCost(actual: bigint | undefined) {
  expect(actual).toBeDefined();
  expect(actual).toBeGreaterThan((expectedRplCost * 97n) / 100n);
  expect(actual).toBeLessThan((expectedRplCost * 103n) / 100n);
}
function createConverter(
  v2: V2Pool[] = [],
  v3: V3Pool[] = [],
  v4: V4Pool[] = []
) {
  return new GasConverter(
    new FakePoolsRepository(() => v2),
    new FakePoolsRepository(() => v3),
    new FakePoolsRepository(() => v4)
  );
}
function createTokensInfo(priceUSD?: number) {
  return new Map<string, Erc20Token | null>([
    [
      weth.address,
      new Erc20Token(weth, 18, 'WETH', 'Wrapped Ether', undefined, 2000),
    ],
    [
      rpl.address,
      new Erc20Token(rpl, 18, 'RPL', 'Rocket Pool', undefined, priceUSD),
    ],
  ]);
}
function createQuote(details: GasDetails) {
  return new QuoteBasic(
    new RouteBasic(Protocol.V3, []),
    1n,
    undefined,
    details
  );
}

describe('GasConverter native depth selection', () => {
  it.each([undefined, 0])(
    'converts RPL gas through the deeper pool when USD price is %s',
    async priceUSD => {
      const {shallow, deep} = createRplPools();
      const converter = createConverter([], [shallow, deep]);
      const ctx = buildTestContext();
      const tokensInfo = createTokensInfo(priceUSD);
      expectRplCost(
        await converter.getGasCostInQuoteTokenBasedOnGasCostInWei(
          ChainId.MAINNET,
          rpl.address,
          tokensInfo,
          gasCostInWei,
          ctx
        )
      );
      const details = new GasDetails(1n, gasCostInWei, 0, 1n);
      await converter.updateQuoteBasicsGasDetails(
        ChainId.MAINNET,
        rpl.address,
        tokensInfo,
        [createQuote(details)],
        ctx
      );
      expectRplCost(details.gasCostInQuoteToken);
    }
  );

  it('uses the real DAWAE V2 price instead of the empty V3 price', async () => {
    const {dead, live} = createDawaePools();
    const tokensInfo = createTokensInfo();
    tokensInfo.set(
      live.token0.address,
      new Erc20Token(live.token0, 18, 'DAWAE', 'DAWAE')
    );
    const result = await createConverter(
      [live],
      [dead]
    ).getGasCostInQuoteTokenBasedOnGasCostInWei(
      ChainId.MAINNET,
      live.token0.address,
      tokensInfo,
      gasCostInWei,
      buildTestContext()
    );
    expect(result).toBe((gasCostInWei * live.reserve0) / live.reserve1);
  });

  it('uses a deeper hookless V4 pool over V3', async () => {
    const {shallow, deep} = createRplPools();
    expectRplCost(
      await createConverter(
        [],
        [shallow],
        [createV4Pool(deep)]
      ).getGasCostInQuoteTokenBasedOnGasCostInWei(
        ChainId.MAINNET,
        rpl.address,
        createTokensInfo(),
        gasCostInWei,
        buildTestContext()
      )
    );
  });

  it('returns zero and keeps the debug log when all pools have zero depth', async () => {
    const {dead} = createDawaePools();
    const ctx = buildTestContext();
    const tokensInfo = createTokensInfo();
    tokensInfo.set(
      dead.token0.address,
      new Erc20Token(dead.token0, 18, 'DAWAE', 'DAWAE')
    );
    expect(
      await createConverter(
        [],
        [dead]
      ).getGasCostInQuoteTokenBasedOnGasCostInWei(
        ChainId.MAINNET,
        dead.token0.address,
        tokensInfo,
        gasCostInWei,
        ctx
      )
    ).toBe(0n);
    expect(
      ctx.logger.outputs.some(
        output => output.extra.message === 'No gas pools found for quote token'
      )
    ).toBe(true);
  });

  it('returns zero and counts the exception when real pool pricing throws', async () => {
    const {deep} = createRplPools();
    const pool = new FakeZeroReserveSdkPool(weth, rpl, deep.address, 1n, 1n);
    const ctx = buildTestContext();
    const converter = createConverter([pool]);
    expect(
      await converter.getGasCostInQuoteTokenBasedOnGasCostInWei(
        ChainId.MAINNET,
        rpl.address,
        createTokensInfo(),
        gasCostInWei,
        ctx
      )
    ).toBe(0n);
    expect(
      ctx.metrics.countStore[buildMetricKey('GasConverter.ExceptionThrown')]
    ).toBe(1);
    expect(
      ctx.logger.outputs.some(
        output =>
          output.prefix === 'ERROR:' &&
          output.msg === 'GasConverter.convertGasCostToQuoteToken'
      )
    ).toBe(true);
    const details = new GasDetails(1n, gasCostInWei, 0, 1n);
    await converter.updateQuoteBasicsGasDetails(
      ChainId.MAINNET,
      rpl.address,
      createTokensInfo(),
      [createQuote(details)],
      ctx
    );
    expect(details.gasCostInQuoteToken).toBe(0n);
    expect(
      ctx.metrics.countStore[buildMetricKey('GasConverter.ExceptionThrown')]
    ).toBe(2);
  });

  it('starts all repository reads before awaiting any and forwards the block number', async () => {
    const {deep} = createRplPools();
    const started: string[] = [];
    const blocks: Array<number | undefined> = [];
    const pending: Array<() => void> = [];
    const record = <T extends Pool>(protocol: string, pools: T[]) =>
      new FakePoolsRepository<T>(block => {
        started.push(protocol);
        blocks.push(block);
        return new Promise(resolve => pending.push(() => resolve(pools)));
      });
    const converter = new GasConverter(
      record<V2Pool>('V2', []),
      record('V3', [deep]),
      record<V4Pool>('V4', [])
    );
    const details = new GasDetails(1n, gasCostInWei, 0, 1n);
    const update = converter.updateQuoteBasicsGasDetails(
      ChainId.MAINNET,
      rpl.address,
      createTokensInfo(),
      [createQuote(details)],
      buildTestContext(),
      21_000_000
    );
    expect(started).toEqual(['V2', 'V3', 'V4']);
    expect(blocks).toEqual([21_000_000, 21_000_000, 21_000_000]);
    for (const resolve of pending) resolve();
    await update;
    expectRplCost(details.gasCostInQuoteToken);
  });
});
