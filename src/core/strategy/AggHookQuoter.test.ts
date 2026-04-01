import {describe, expect, it, vi} from 'vitest';
import {buildTestContext} from '@uniswap/lib-testhelpers';
import {ethers} from 'ethers';
import {JsonRpcProvider} from '@ethersproject/providers';

import {Address} from '../../models/address/Address';
import {RouteBasic} from '../../models/route/RouteBasic';
import {V2Pool} from '../../models/pool/V2Pool';
import {V3Pool} from '../../models/pool/V3Pool';
import {V4Pool} from '../../models/pool/V4Pool';
import {Protocol} from '../../models/pool/Protocol';
import {TradeType} from '../../models/quote/TradeType';
import {Chain} from '../../models/chain/Chain';
import {NativeCurrency} from '../../models/chain/NativeCurrency';
import {CurrencyInfo} from '../../models/currency/CurrencyInfo';
import {ChainId} from '../../lib/config';
import {UNISWAP_AGG_HOOK_ON_TEMPO} from '../../lib/poolCaching/util/aggHooksAddressesAllowlist';

import {isTempoAggHook} from '../../lib/helpers';
import {
  isSingleHopTempoAggHookRoute,
  partitionAggHookRoutes,
  fetchAggHookQuotes,
  HookContractFactory,
} from './AggHookQuoter';

// ----- Test constants -----

const PATH_USD = new Address('0x20C0000000000000000000000000000000000000');
const USDC_E = new Address('0x20C000000000000000000000b9537d11c60E8b50');
const WETH = new Address('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2');
const USDC = new Address('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');

const TEMPO_HOOK = UNISWAP_AGG_HOOK_ON_TEMPO; // lowercased
const TEMPO_POOL_ID =
  '0xdb82e743b9d5986a72b2c3ed5ce8ea89bc24caa0c8c73cf6cbbfe8f817ed7b8a';

function makeTempoAggPool(): V4Pool {
  return new V4Pool(
    PATH_USD,
    USDC_E,
    500,
    10,
    TEMPO_HOOK,
    0n,
    TEMPO_POOL_ID,
    79228162514264337593543950336n,
    0n
  );
}

function makeVanillaV4Pool(): V4Pool {
  return new V4Pool(
    WETH,
    USDC,
    500,
    10,
    '0x0000000000000000000000000000000000000000',
    1000000n,
    '0x0000000000000000000000000000000000000001',
    79228162514264337593543950336n,
    0n
  );
}

function makeV2Pool(): V2Pool {
  return new V2Pool(
    WETH,
    USDC,
    new Address('0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640'),
    1000000000000n,
    1000000000000n
  );
}

function makeV3Pool(): V3Pool {
  return new V3Pool(
    WETH,
    USDC,
    3000,
    new Address('0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8'),
    1000000000000n,
    79228162514264337593543950336n,
    0n
  );
}

// ----- Unit tests: isTempoAggHook -----

describe('isTempoAggHook', () => {
  it('returns true for a V4 pool with a known agg hook address', () => {
    expect(isTempoAggHook(makeTempoAggPool())).toBe(true);
  });

  it('returns false for a V4 pool with address zero hooks', () => {
    expect(isTempoAggHook(makeVanillaV4Pool())).toBe(false);
  });

  it('returns false for a V2 pool', () => {
    expect(isTempoAggHook(makeV2Pool())).toBe(false);
  });

  it('returns false for a V3 pool', () => {
    expect(isTempoAggHook(makeV3Pool())).toBe(false);
  });

  it('is case-insensitive on hook address', () => {
    const pool = new V4Pool(
      PATH_USD,
      USDC_E,
      500,
      10,
      TEMPO_HOOK.toUpperCase(),
      0n,
      TEMPO_POOL_ID,
      79228162514264337593543950336n,
      0n
    );
    expect(isTempoAggHook(pool)).toBe(true);
  });
});

// ----- Unit tests: isSingleHopTempoAggHookRoute -----

describe('isSingleHopTempoAggHookRoute', () => {
  it('returns true for a single-hop route through an agg hook pool', () => {
    const route = new RouteBasic(Protocol.V4, [makeTempoAggPool()]);
    expect(isSingleHopTempoAggHookRoute(route)).toBe(true);
  });

  it('returns false for a single-hop route through a vanilla V4 pool', () => {
    const route = new RouteBasic(Protocol.V4, [makeVanillaV4Pool()]);
    expect(isSingleHopTempoAggHookRoute(route)).toBe(false);
  });

  it('returns false for a multi-hop route even if first pool is agg hook', () => {
    const route = new RouteBasic(Protocol.MIXED, [
      makeTempoAggPool(),
      makeVanillaV4Pool(),
    ]);
    expect(isSingleHopTempoAggHookRoute(route)).toBe(false);
  });

  it('returns false for a V2 single-hop route', () => {
    const route = new RouteBasic(Protocol.V2, [makeV2Pool()]);
    expect(isSingleHopTempoAggHookRoute(route)).toBe(false);
  });

  it('returns false for an empty route', () => {
    const route = new RouteBasic(Protocol.V4, []);
    expect(isSingleHopTempoAggHookRoute(route)).toBe(false);
  });
});

// ----- Unit tests: partitionAggHookRoutes -----

describe('partitionAggHookRoutes', () => {
  it('separates agg hook routes from other routes', () => {
    const aggRoute = new RouteBasic(Protocol.V4, [makeTempoAggPool()], 100);
    const v2Route = new RouteBasic(Protocol.V2, [makeV2Pool()], 100);
    const v4Route = new RouteBasic(Protocol.V4, [makeVanillaV4Pool()], 100);

    const {aggHookRoutes, otherRoutes} = partitionAggHookRoutes([
      aggRoute,
      v2Route,
      v4Route,
    ]);

    expect(aggHookRoutes).toHaveLength(1);
    expect(aggHookRoutes[0]).toBe(aggRoute);
    expect(otherRoutes).toHaveLength(2);
    expect(otherRoutes).toContain(v2Route);
    expect(otherRoutes).toContain(v4Route);
  });

  it('handles all agg hook routes', () => {
    const route1 = new RouteBasic(Protocol.V4, [makeTempoAggPool()], 100);
    const route2 = new RouteBasic(Protocol.V4, [makeTempoAggPool()], 50);

    const {aggHookRoutes, otherRoutes} = partitionAggHookRoutes([
      route1,
      route2,
    ]);

    expect(aggHookRoutes).toHaveLength(2);
    expect(otherRoutes).toHaveLength(0);
  });

  it('handles no agg hook routes', () => {
    const route1 = new RouteBasic(Protocol.V2, [makeV2Pool()], 100);

    const {aggHookRoutes, otherRoutes} = partitionAggHookRoutes([route1]);

    expect(aggHookRoutes).toHaveLength(0);
    expect(otherRoutes).toHaveLength(1);
  });

  it('handles empty input', () => {
    const {aggHookRoutes, otherRoutes} = partitionAggHookRoutes([]);

    expect(aggHookRoutes).toHaveLength(0);
    expect(otherRoutes).toHaveLength(0);
  });

  it('puts multi-hop routes with agg hook into otherRoutes', () => {
    const multiHop = new RouteBasic(
      Protocol.MIXED,
      [makeTempoAggPool(), makeVanillaV4Pool()],
      100
    );

    const {aggHookRoutes, otherRoutes} = partitionAggHookRoutes([multiHop]);

    expect(aggHookRoutes).toHaveLength(0);
    expect(otherRoutes).toHaveLength(1);
  });
});

// ----- Unit tests: fetchAggHookQuotes (mocked provider) -----

describe('fetchAggHookQuotes', () => {
  const ctx = buildTestContext();
  const chain = new Chain(
    ChainId.MAINNET,
    'Ethereum',
    NativeCurrency.ETH,
    new Address('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'),
    new Address('0x1F98431c8aD98523631AE4a59f267346ea31F984'),
    new Address('0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6'),
    new Address('0x5BA1e12693Dc8F9c48aAD8770482f4739bEeD696'),
    1000000,
    75,
    new Address('0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f')
  );

  function makeProviderMap(): Map<ChainId, JsonRpcProvider> {
    const providerMap = new Map<ChainId, JsonRpcProvider>();
    providerMap.set(ChainId.MAINNET, {} as JsonRpcProvider);
    return providerMap;
  }

  function makeMockContractFactory(
    quoteFn: ReturnType<typeof vi.fn>
  ): HookContractFactory {
    return () =>
      ({
        callStatic: {quote: quoteFn},
      }) as unknown as ethers.Contract;
  }

  it('returns quotes for exact-in with correct amount', async () => {
    const quoteFn = vi.fn().mockResolvedValue(ethers.BigNumber.from('999900'));
    const route = new RouteBasic(Protocol.V4, [makeTempoAggPool()], 100);

    const quotes = await fetchAggHookQuotes(
      chain,
      [route],
      1000000n,
      TradeType.ExactIn,
      new CurrencyInfo(false, PATH_USD),
      makeProviderMap(),
      ctx,
      ['chain:TEMPO'],
      makeMockContractFactory(quoteFn)
    );

    expect(quotes).toHaveLength(1);
    expect(quotes[0].amount).toBe(999900n);
    expect(quotes[0].route).toBe(route);
    expect(quotes[0].v3QuoterResponseDetails).toBeUndefined();
  });

  it('applies percentage allocation to amount', async () => {
    const quoteFn = vi.fn().mockResolvedValue(ethers.BigNumber.from('499950'));
    const route = new RouteBasic(Protocol.V4, [makeTempoAggPool()], 50);

    await fetchAggHookQuotes(
      chain,
      [route],
      1000000n,
      TradeType.ExactIn,
      new CurrencyInfo(false, PATH_USD),
      makeProviderMap(),
      ctx,
      ['chain:TEMPO'],
      makeMockContractFactory(quoteFn)
    );

    // amountSpecified should be -(1000000 * 50 / 100) = -500000
    expect(quoteFn).toHaveBeenCalledWith(
      true, // zeroForOne (PATH_USD is token0, which is tokenIn)
      -500000n,
      TEMPO_POOL_ID
    );
  });

  it('uses positive amountSpecified for exact-out', async () => {
    const quoteFn = vi.fn().mockResolvedValue(ethers.BigNumber.from('1000100'));
    const route = new RouteBasic(Protocol.V4, [makeTempoAggPool()], 100);

    await fetchAggHookQuotes(
      chain,
      [route],
      1000000n,
      TradeType.ExactOut,
      new CurrencyInfo(false, PATH_USD),
      makeProviderMap(),
      ctx,
      ['chain:TEMPO'],
      makeMockContractFactory(quoteFn)
    );

    // exact-out: amountSpecified is positive
    expect(quoteFn).toHaveBeenCalledWith(true, 1000000n, TEMPO_POOL_ID);
  });

  it('handles individual quote failures gracefully', async () => {
    let callCount = 0;
    const quoteFn = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(ethers.BigNumber.from('999900'));
      }
      return Promise.reject(new Error('InsufficientLiquidity'));
    });
    const route1 = new RouteBasic(Protocol.V4, [makeTempoAggPool()], 100);
    const route2 = new RouteBasic(Protocol.V4, [makeTempoAggPool()], 50);

    const quotes = await fetchAggHookQuotes(
      chain,
      [route1, route2],
      1000000n,
      TradeType.ExactIn,
      new CurrencyInfo(false, PATH_USD),
      makeProviderMap(),
      ctx,
      ['chain:TEMPO'],
      makeMockContractFactory(quoteFn)
    );

    // First succeeds, second fails — only 1 quote returned
    expect(quotes).toHaveLength(1);
    expect(quotes[0].amount).toBe(999900n);
  });

  it('determines zeroForOne correctly when tokenIn is token1', async () => {
    const quoteFn = vi.fn().mockResolvedValue(ethers.BigNumber.from('1000000'));
    const route = new RouteBasic(Protocol.V4, [makeTempoAggPool()], 100);

    // tokenIn = USDC_E (token1), so zeroForOne should be false
    await fetchAggHookQuotes(
      chain,
      [route],
      1000000n,
      TradeType.ExactIn,
      new CurrencyInfo(false, USDC_E),
      makeProviderMap(),
      ctx,
      ['chain:TEMPO'],
      makeMockContractFactory(quoteFn)
    );

    expect(quoteFn).toHaveBeenCalledWith(
      false, // zeroForOne = false (USDC_E is not token0)
      -1000000n,
      TEMPO_POOL_ID
    );
  });

  it('returns empty array when all quotes fail', async () => {
    const quoteFn = vi.fn().mockRejectedValue(new Error('RPC timeout'));
    const route = new RouteBasic(Protocol.V4, [makeTempoAggPool()], 100);

    const quotes = await fetchAggHookQuotes(
      chain,
      [route],
      1000000n,
      TradeType.ExactIn,
      new CurrencyInfo(false, PATH_USD),
      makeProviderMap(),
      ctx,
      ['chain:TEMPO'],
      makeMockContractFactory(quoteFn)
    );

    expect(quotes).toHaveLength(0);
  });

  it('returns empty array when no provider available for chain', async () => {
    const emptyProviderMap = new Map<ChainId, JsonRpcProvider>();
    const route = new RouteBasic(Protocol.V4, [makeTempoAggPool()], 100);

    const quotes = await fetchAggHookQuotes(
      chain,
      [route],
      1000000n,
      TradeType.ExactIn,
      new CurrencyInfo(false, PATH_USD),
      emptyProviderMap,
      ctx,
      ['chain:TEMPO']
    );

    expect(quotes).toHaveLength(0);
  });
});
