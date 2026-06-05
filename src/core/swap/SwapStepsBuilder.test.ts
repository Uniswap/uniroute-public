import {describe, it, expect} from 'vitest';
import {
  CurrencyAmount,
  Ether,
  Token,
  TradeType as SdkTradeType,
} from '@uniswap/sdk-core';
import {
  TokenTransferMode,
  UniversalRouterVersion,
} from '@uniswap/universal-router-sdk';
import {
  buildSwapSpecification,
  buildSwapStepsMethodParameters,
} from './SwapStepsBuilder';
import {buildSwapSteps} from './SwapStepsFactory';
import {SwapOptionsFactory} from './SwapOptionsFactory';
import {getUniversalRouterAddress} from '../../lib/universalRouterAddress';
import {QuoteBasic} from '../../models/quote/QuoteBasic';
import {QuoteSplit} from '../../models/quote/QuoteSplit';
import {RouteBasic} from '../../models/route/RouteBasic';
import {Protocol} from '../../models/pool/Protocol';
import {V2Pool} from '../../models/pool/V2Pool';
import {V3Pool, V3Fee} from '../../models/pool/V3Pool';
import {V4Pool} from '../../models/pool/V4Pool';
import {Address} from '../../models/address/Address';
import {TradeType} from '../../models/quote/TradeType';
import {CurrencyInfo} from '../../models/currency/CurrencyInfo';

// === Fixtures ================================================================

const CHAIN = 1;
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const DAI = '0x6B175474E89094C44Da98b954EedeAC495271d0F';
const USER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const ZERO_HOOKS = '0x0000000000000000000000000000000000000000';
const POOL_1 = '0x0000000000000000000000000000000000001111';
const POOL_2 = '0x0000000000000000000000000000000000002222';
const POOL_ID_V4 =
  '0x0000000000000000000000000000000000000000000000000000000000004001';

const wethToken = new Token(CHAIN, WETH, 18);
const usdcToken = new Token(CHAIN, USDC, 6);
const daiToken = new Token(CHAIN, DAI, 18);
const ether = Ether.onChain(CHAIN);

function v2Pool(token0: string, token1: string, address: string): V2Pool {
  return new V2Pool(
    new Address(token0),
    new Address(token1),
    new Address(address),
    1_000_000_000_000n,
    1_000_000_000_000n
  );
}

function v3Pool(t0: string, t1: string, fee: V3Fee, addr: string): V3Pool {
  return new V3Pool(
    new Address(t0),
    new Address(t1),
    fee,
    new Address(addr),
    1_000_000_000_000n,
    79228162514264337593543950336n,
    0n
  );
}

function v4Pool(t0: string, t1: string, fee: number, poolId: string): V4Pool {
  return new V4Pool(
    new Address(t0),
    new Address(t1),
    fee,
    10,
    ZERO_HOOKS,
    1_000_000_000_000n,
    poolId,
    79228162514264337593543950336n,
    0n
  );
}

function tokenCI(address: string, isNative = false): CurrencyInfo {
  return new CurrencyInfo(isNative, new Address(address));
}

function swapOptions(
  overrides: Partial<
    Parameters<typeof SwapOptionsFactory.createUniversalRouterOptions_2_0>[0]
  > = {}
) {
  const opts = SwapOptionsFactory.createUniversalRouterOptions_2_0({
    chainId: CHAIN,
    tradeType: TradeType.ExactIn,
    amountIn: '1000000',
    tokenInWrappedAddress: USDC,
    slippageTolerance: '0.5',
    recipient: USER,
    deadline: '600',
    tokenInIsNative: false,
    universalRouterSwapsteps: true,
    ...overrides,
  });
  if (!opts) throw new Error('swapOptions fixture returned undefined');
  return opts;
}

// === buildSwapSpecification ==================================================

describe('buildSwapSpecification', () => {
  it('maps EXACT_IN: exact side = input, slippage side = output, fee-neutral', () => {
    const spec = buildSwapSpecification({
      swapOptions: swapOptions(),
      inputAmount: CurrencyAmount.fromRawAmount(usdcToken, '1000000'),
      outputAmount: CurrencyAmount.fromRawAmount(
        wethToken,
        '500000000000000000'
      ),
      tradeType: SdkTradeType.EXACT_INPUT,
      chainId: CHAIN,
    });

    expect(spec.tradeType).toBe(SdkTradeType.EXACT_INPUT);
    expect(spec.routing.inputToken.equals(usdcToken)).toBe(true);
    expect(spec.routing.outputToken.equals(wethToken)).toBe(true);
    expect(spec.routing.amount.currency.equals(usdcToken)).toBe(true);
    expect(spec.routing.quote.currency.equals(wethToken)).toBe(true);
    expect(spec.fee).toBeUndefined();
    expect(spec.recipient).toBe(USER);
    expect(spec.tokenTransferMode).toBe(TokenTransferMode.Permit2);
    expect(spec.chainId).toBe(CHAIN);
    expect(spec.urVersion).toBe(UniversalRouterVersion.V2_0);
  });

  it('maps EXACT_OUT: exact side = output, slippage side = input', () => {
    const spec = buildSwapSpecification({
      swapOptions: swapOptions({tradeType: TradeType.ExactOut}),
      inputAmount: CurrencyAmount.fromRawAmount(usdcToken, '2000000'),
      outputAmount: CurrencyAmount.fromRawAmount(
        wethToken,
        '500000000000000000'
      ),
      tradeType: SdkTradeType.EXACT_OUTPUT,
      chainId: CHAIN,
    });

    expect(spec.routing.amount.currency.equals(wethToken)).toBe(true);
    expect(spec.routing.quote.currency.equals(usdcToken)).toBe(true);
  });
});

// === buildSwapStepsMethodParameters (encodeSwaps round-trip) ==================

// The point of these tests: prove the factory's SwapStep[] output is actually
// accepted by the real SDK encoder (validateEncodeSwaps + encodeSwapStep), which
// nothing exercised before.

function assertEncodes(
  swapSteps: ReturnType<typeof buildSwapSteps>,
  spec: ReturnType<typeof buildSwapSpecification>
) {
  const mp = buildSwapStepsMethodParameters(swapSteps, spec, CHAIN);
  expect(mp.calldata.startsWith('0x')).toBe(true);
  expect(mp.calldata.length).toBeGreaterThan(2);
  return mp;
}

describe('buildSwapStepsMethodParameters - encodeSwaps round-trip', () => {
  it('V2 single-pool EXACT_IN encodes; to = Universal Router (Permit2)', () => {
    const split = new QuoteSplit([
      new QuoteBasic(
        new RouteBasic(Protocol.V2, [v2Pool(USDC, WETH, POOL_1)]),
        999n
      ),
    ]);
    const steps = buildSwapSteps(
      split,
      TradeType.ExactIn,
      1_000_000n,
      tokenCI(USDC),
      tokenCI(WETH)
    );
    const spec = buildSwapSpecification({
      swapOptions: swapOptions(),
      inputAmount: CurrencyAmount.fromRawAmount(usdcToken, '1000000'),
      outputAmount: CurrencyAmount.fromRawAmount(wethToken, '999'),
      tradeType: SdkTradeType.EXACT_INPUT,
      chainId: CHAIN,
    });
    const mp = assertEncodes(steps, spec);
    expect(mp.to).toBe(
      getUniversalRouterAddress(UniversalRouterVersion.V2_0, CHAIN)
    );
  });

  it('V3 single-pool EXACT_IN encodes', () => {
    const split = new QuoteSplit([
      new QuoteBasic(
        new RouteBasic(Protocol.V3, [v3Pool(USDC, WETH, 500, POOL_1)]),
        999n
      ),
    ]);
    const steps = buildSwapSteps(
      split,
      TradeType.ExactIn,
      1_000_000n,
      tokenCI(USDC),
      tokenCI(WETH)
    );
    const spec = buildSwapSpecification({
      swapOptions: swapOptions(),
      inputAmount: CurrencyAmount.fromRawAmount(usdcToken, '1000000'),
      outputAmount: CurrencyAmount.fromRawAmount(wethToken, '999'),
      tradeType: SdkTradeType.EXACT_INPUT,
      chainId: CHAIN,
    });
    assertEncodes(steps, spec);
  });

  it('V4 single-pool EXACT_IN encodes (grouped SETTLE/SWAP/TAKE)', () => {
    const split = new QuoteSplit([
      new QuoteBasic(
        new RouteBasic(Protocol.V4, [v4Pool(USDC, WETH, 500, POOL_ID_V4)]),
        999n
      ),
    ]);
    const steps = buildSwapSteps(
      split,
      TradeType.ExactIn,
      1_000_000n,
      tokenCI(USDC),
      tokenCI(WETH)
    );
    const spec = buildSwapSpecification({
      swapOptions: swapOptions(),
      inputAmount: CurrencyAmount.fromRawAmount(usdcToken, '1000000'),
      outputAmount: CurrencyAmount.fromRawAmount(wethToken, '999'),
      tradeType: SdkTradeType.EXACT_INPUT,
      chainId: CHAIN,
    });
    assertEncodes(steps, spec);
  });

  it('MIXED EXACT_IN (V3 -> V2) encodes with V2 CONTRACT_BALANCE sentinel', () => {
    const split = new QuoteSplit([
      new QuoteBasic(
        new RouteBasic(Protocol.MIXED, [
          v3Pool(USDC, WETH, 500, POOL_1),
          v2Pool(DAI, WETH, POOL_2),
        ]),
        999n
      ),
    ]);
    const steps = buildSwapSteps(
      split,
      TradeType.ExactIn,
      1_000_000n,
      tokenCI(USDC),
      tokenCI(DAI)
    );
    const spec = buildSwapSpecification({
      swapOptions: swapOptions(),
      inputAmount: CurrencyAmount.fromRawAmount(usdcToken, '1000000'),
      outputAmount: CurrencyAmount.fromRawAmount(daiToken, '999'),
      tradeType: SdkTradeType.EXACT_INPUT,
      chainId: CHAIN,
    });
    assertEncodes(steps, spec);
  });

  it('MIXED EXACT_IN (V3 -> V4) encodes with V4 SETTLE sentinel + OPEN_DELTA', () => {
    const split = new QuoteSplit([
      new QuoteBasic(
        new RouteBasic(Protocol.MIXED, [
          v3Pool(USDC, WETH, 500, POOL_1),
          v4Pool(WETH, DAI, 500, POOL_ID_V4),
        ]),
        999n
      ),
    ]);
    const steps = buildSwapSteps(
      split,
      TradeType.ExactIn,
      1_000_000n,
      tokenCI(USDC),
      tokenCI(DAI)
    );
    const spec = buildSwapSpecification({
      swapOptions: swapOptions(),
      inputAmount: CurrencyAmount.fromRawAmount(usdcToken, '1000000'),
      outputAmount: CurrencyAmount.fromRawAmount(daiToken, '999'),
      tradeType: SdkTradeType.EXACT_INPUT,
      chainId: CHAIN,
    });
    assertEncodes(steps, spec);
  });

  it('V3 EXACT_OUT encodes', () => {
    const split = new QuoteSplit([
      new QuoteBasic(
        new RouteBasic(Protocol.V3, [v3Pool(USDC, WETH, 500, POOL_1)]),
        2_000_000n
      ),
    ]);
    const steps = buildSwapSteps(
      split,
      TradeType.ExactOut,
      500_000_000_000_000_000n,
      tokenCI(USDC),
      tokenCI(WETH)
    );
    const spec = buildSwapSpecification({
      swapOptions: swapOptions({tradeType: TradeType.ExactOut}),
      inputAmount: CurrencyAmount.fromRawAmount(usdcToken, '2000000'),
      outputAmount: CurrencyAmount.fromRawAmount(
        wethToken,
        '500000000000000000'
      ),
      tradeType: SdkTradeType.EXACT_OUTPUT,
      chainId: CHAIN,
    });
    assertEncodes(steps, spec);
  });

  it('native-input EXACT_IN: value equals the exact input amount', () => {
    const amountIn = 1_000_000_000_000_000_000n; // 1 ETH
    const split = new QuoteSplit([
      new QuoteBasic(
        new RouteBasic(Protocol.V3, [v3Pool(USDC, WETH, 500, POOL_1)]),
        1_000_000n
      ),
    ]);
    const steps = buildSwapSteps(
      split,
      TradeType.ExactIn,
      amountIn,
      tokenCI(WETH, true),
      tokenCI(USDC)
    );
    const spec = buildSwapSpecification({
      swapOptions: swapOptions({tokenInWrappedAddress: WETH}),
      inputAmount: CurrencyAmount.fromRawAmount(ether, amountIn.toString()),
      outputAmount: CurrencyAmount.fromRawAmount(usdcToken, '1000000'),
      tradeType: SdkTradeType.EXACT_INPUT,
      chainId: CHAIN,
    });
    const mp = assertEncodes(steps, spec);
    // encodeSwaps returns `value` as a hex string.
    expect(BigInt(mp.value)).toBe(amountIn);
  });

  it('native-input EXACT_OUT: value equals the slippage-padded max input', () => {
    const inputEstimate = 1_000_000_000_000_000_000n; // 1 ETH route-required input
    const amountOut = 1_000_000n; // exact USDC out
    const split = new QuoteSplit([
      new QuoteBasic(
        new RouteBasic(Protocol.V3, [v3Pool(USDC, WETH, 500, POOL_1)]),
        inputEstimate
      ),
    ]);
    const steps = buildSwapSteps(
      split,
      TradeType.ExactOut,
      amountOut,
      tokenCI(WETH, true),
      tokenCI(USDC)
    );
    const spec = buildSwapSpecification({
      swapOptions: swapOptions({
        tradeType: TradeType.ExactOut,
        tokenInWrappedAddress: WETH,
      }),
      inputAmount: CurrencyAmount.fromRawAmount(
        ether,
        inputEstimate.toString()
      ),
      outputAmount: CurrencyAmount.fromRawAmount(
        usdcToken,
        amountOut.toString()
      ),
      tradeType: SdkTradeType.EXACT_OUTPUT,
      chainId: CHAIN,
    });
    const mp = assertEncodes(steps, spec);
    // encodeSwaps returns `value` as hex; slippage 0.5% => padded = estimate * 10050 / 10000
    expect(BigInt(mp.value)).toBe((inputEstimate * 10050n) / 10000n);
  });
});
