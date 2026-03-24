/**
 * E2E test for AggHookQuoter against the live Tempo aggregator hook.
 *
 * Calls hook.quote() on the deployed TempoExchangeAggregator at
 * 0x717c31c3ea5f9070297f239fafd63d21afdaa888 on Tempo mainnet (chainId 4217).
 *
 * Requires network access to https://rpc.tempo.xyz.
 * Run with: npx vitest run src/core/strategy/AggHookQuoter.e2e.test.ts
 */

import {describe, expect, it} from 'vitest';
import {buildTestContext} from '@uniswap/lib-testhelpers';
import {ethers} from 'ethers';

import {Address} from '../../models/address/Address';
import {RouteBasic} from '../../models/route/RouteBasic';
import {V4Pool} from '../../models/pool/V4Pool';
import {Protocol} from '../../models/pool/Protocol';
import {TradeType} from '../../models/quote/TradeType';
import {Chain} from '../../models/chain/Chain';
import {NativeCurrency} from '../../models/chain/NativeCurrency';
import {CurrencyInfo} from '../../models/currency/CurrencyInfo';
import {ChainId} from '../../lib/config';
import {UNISWAP_AGG_HOOK_ON_TEMPO} from '../../lib/poolCaching/util/hooksAddressesAllowlist';

import {fetchAggHookQuotes} from './AggHookQuoter';

// ----- Tempo mainnet constants -----

const TEMPO_RPC = 'https://rpc.tempo.xyz';
const PATH_USD = new Address('0x20C0000000000000000000000000000000000000');
const USDC_E = new Address('0x20C000000000000000000000b9537d11c60E8b50');
const HOOK_ADDRESS = UNISWAP_AGG_HOOK_ON_TEMPO;
const POOL_ID =
  '0xdb82e743b9d5986a72b2c3ed5ce8ea89bc24caa0c8c73cf6cbbfe8f817ed7b8a';

function makeTempoPool(): V4Pool {
  return new V4Pool(
    PATH_USD,
    USDC_E,
    500,
    10,
    HOOK_ADDRESS,
    0n,
    POOL_ID,
    79228162514264337593543950336n,
    0n
  );
}

// Use a minimal Chain object — only chainId matters for AggHookQuoter
const tempoChain = new Chain(
  ChainId.TEMPO,
  'Tempo',
  NativeCurrency.ETH,
  new Address('0x20C0000000000000000000000000000000000000'), // wrapped native = pathUSD
  new Address('0x0000000000000000000000000000000000000000'), // v3Factory (unused)
  new Address('0x0000000000000000000000000000000000000000'), // quoterV2 (unused)
  new Address('0x0000000000000000000000000000000000000000'), // multicall (unused)
  1000000,
  75,
  new Address('0x0000000000000000000000000000000000000000') // v2Factory (unused)
);

describe('AggHookQuoter E2E — Tempo mainnet', () => {
  const ctx = buildTestContext();
  const provider = new ethers.providers.JsonRpcProvider(TEMPO_RPC);

  it(
    'quotes pathUSD -> USDC.e at $1 with ~1 bps spread',
    async () => {
      const route = new RouteBasic(Protocol.V4, [makeTempoPool()], 100);
      const amountIn = 1_000_000n; // $1 (6 decimals)

      const quotes = await fetchAggHookQuotes(
        tempoChain,
        [route],
        amountIn,
        TradeType.ExactIn,
        new CurrencyInfo(false, PATH_USD),
        new CurrencyInfo(false, USDC_E),
        provider,
        ctx,
        ['chain:TEMPO', 'e2e:true']
      );

      expect(quotes).toHaveLength(1);
      const amountOut = quotes[0].amount;

      // Expected: ~999900 (1 bps fee on pathUSD -> USDC.e direction)
      expect(amountOut).toBeGreaterThan(999_000n); // within 0.1%
      expect(amountOut).toBeLessThanOrEqual(amountIn);

      const spreadBps =
        Number((amountIn - amountOut) * 10_000n) / Number(amountIn);
      console.log(
        `$1 pathUSD -> USDC.e: ${amountIn} -> ${amountOut} (spread: ${spreadBps.toFixed(2)} bps)`
      );
      expect(spreadBps).toBeCloseTo(1.0, 0); // ~1 bps
    },
    30_000
  );

  it(
    'quotes USDC.e -> pathUSD at $1 with 0 bps spread',
    async () => {
      const route = new RouteBasic(Protocol.V4, [makeTempoPool()], 100);
      const amountIn = 1_000_000n;

      const quotes = await fetchAggHookQuotes(
        tempoChain,
        [route],
        amountIn,
        TradeType.ExactIn,
        new CurrencyInfo(false, USDC_E), // tokenIn = USDC.e (token1)
        new CurrencyInfo(false, PATH_USD),
        provider,
        ctx,
        ['chain:TEMPO', 'e2e:true']
      );

      expect(quotes).toHaveLength(1);
      const amountOut = quotes[0].amount;

      // USDC.e -> pathUSD has 0 spread on Tempo DEX
      console.log(
        `$1 USDC.e -> pathUSD: ${amountIn} -> ${amountOut} (expected 1:1)`
      );
      expect(amountOut).toBe(amountIn);
    },
    30_000
  );

  it(
    'quotes pathUSD -> USDC.e at $10k — no slippage vs Tempo DEX',
    async () => {
      const route = new RouteBasic(Protocol.V4, [makeTempoPool()], 100);
      const amountIn = 10_000_000_000n; // $10k

      const quotes = await fetchAggHookQuotes(
        tempoChain,
        [route],
        amountIn,
        TradeType.ExactIn,
        new CurrencyInfo(false, PATH_USD),
        new CurrencyInfo(false, USDC_E),
        provider,
        ctx,
        ['chain:TEMPO', 'e2e:true']
      );

      expect(quotes).toHaveLength(1);
      const amountOut = quotes[0].amount;

      // At $10k the V4Quoter returned 72% slippage. Hook.quote() should
      // return ~1 bps spread — same as $1.
      const spreadBps =
        Number((amountIn - amountOut) * 10_000n) / Number(amountIn);
      console.log(
        `$10k pathUSD -> USDC.e: ${amountIn} -> ${amountOut} (spread: ${spreadBps.toFixed(2)} bps)`
      );

      // Must be within 2 bps — NOT the 72%+ slippage the V4Quoter gave
      expect(spreadBps).toBeLessThan(2);
      expect(spreadBps).toBeGreaterThanOrEqual(0);
    },
    30_000
  );

  it(
    'quotes pathUSD -> USDC.e at $100k — still flat spread',
    async () => {
      const route = new RouteBasic(Protocol.V4, [makeTempoPool()], 100);
      const amountIn = 100_000_000_000n; // $100k

      const quotes = await fetchAggHookQuotes(
        tempoChain,
        [route],
        amountIn,
        TradeType.ExactIn,
        new CurrencyInfo(false, PATH_USD),
        new CurrencyInfo(false, USDC_E),
        provider,
        ctx,
        ['chain:TEMPO', 'e2e:true']
      );

      expect(quotes).toHaveLength(1);
      const amountOut = quotes[0].amount;

      const spreadBps =
        Number((amountIn - amountOut) * 10_000n) / Number(amountIn);
      console.log(
        `$100k pathUSD -> USDC.e: ${amountIn} -> ${amountOut} (spread: ${spreadBps.toFixed(2)} bps)`
      );

      expect(spreadBps).toBeLessThan(2);
    },
    30_000
  );

  it(
    'handles multiple percentage routes in parallel',
    async () => {
      const routes = [100, 50, 25].map(
        pct => new RouteBasic(Protocol.V4, [makeTempoPool()], pct)
      );
      const amount = 10_000_000n; // $10

      const quotes = await fetchAggHookQuotes(
        tempoChain,
        routes,
        amount,
        TradeType.ExactIn,
        new CurrencyInfo(false, PATH_USD),
        new CurrencyInfo(false, USDC_E),
        provider,
        ctx,
        ['chain:TEMPO', 'e2e:true']
      );

      expect(quotes).toHaveLength(3);

      // Verify proportional amounts
      const q100 = quotes.find(q => q.route.percentage === 100)!;
      const q50 = quotes.find(q => q.route.percentage === 50)!;
      const q25 = quotes.find(q => q.route.percentage === 25)!;

      console.log(
        `Multi-pct: 100%=${q100.amount}, 50%=${q50.amount}, 25%=${q25.amount}`
      );

      // 50% quote should be roughly half of 100% quote
      expect(Number(q50.amount)).toBeCloseTo(Number(q100.amount) / 2, -2);
      expect(Number(q25.amount)).toBeCloseTo(Number(q100.amount) / 4, -2);
    },
    30_000
  );

  it(
    'reverts gracefully for amounts exceeding DEX liquidity',
    async () => {
      const route = new RouteBasic(Protocol.V4, [makeTempoPool()], 100);
      // $500k exceeds Tempo DEX USDC.e balance (~$777k), should revert
      // with InsufficientLiquidity at some point
      const amountIn = 500_000_000_000n;

      const quotes = await fetchAggHookQuotes(
        tempoChain,
        [route],
        amountIn,
        TradeType.ExactIn,
        new CurrencyInfo(false, PATH_USD),
        new CurrencyInfo(false, USDC_E),
        provider,
        ctx,
        ['chain:TEMPO', 'e2e:true']
      );

      // Should either succeed with a quote or gracefully return empty
      // (the hook reverts with InsufficientLiquidity at ~$777k)
      console.log(
        `$500k quote: ${quotes.length > 0 ? quotes[0].amount : 'REVERTED (expected)'}`
      );
      expect(quotes.length).toBeLessThanOrEqual(1);
    },
    30_000
  );
});
