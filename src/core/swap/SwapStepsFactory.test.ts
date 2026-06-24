import {describe, it, expect} from 'vitest';
import {buildSwapSteps} from './SwapStepsFactory';
import {QuoteSplit} from '../../models/quote/QuoteSplit';
import {QuoteBasic} from '../../models/quote/QuoteBasic';
import {RouteBasic} from '../../models/route/RouteBasic';
import {Protocol} from '../../models/pool/Protocol';
import {V2Pool} from '../../models/pool/V2Pool';
import {V3Pool, V3Fee} from '../../models/pool/V3Pool';
import {V4Pool} from '../../models/pool/V4Pool';
import {Address} from '../../models/address/Address';
import {TradeType} from '../../models/quote/TradeType';
import {CurrencyInfo} from '../../models/currency/CurrencyInfo';
import {ROUTER_AS_RECIPIENT} from '@uniswap/universal-router-sdk';
import {
  Pool as V4SdkPool,
  Route as V4SdkRoute,
  encodeRouteToPath,
} from '@uniswap/v4-sdk';
import {Percent, Token} from '@uniswap/sdk-core';

// === Test fixtures ============================================================

const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const DAI = '0x6B175474E89094C44Da98b954EedeAC495271d0F';
const NATIVE = '0x0000000000000000000000000000000000000000';

function v2Pool(token0: string, token1: string, address: string): V2Pool {
  return new V2Pool(
    new Address(token0),
    new Address(token1),
    new Address(address),
    1_000_000_000_000n,
    1_000_000_000_000n
  );
}

function v3Pool(
  token0: string,
  token1: string,
  fee: V3Fee,
  address: string
): V3Pool {
  return new V3Pool(
    new Address(token0),
    new Address(token1),
    fee,
    new Address(address),
    1_000_000_000_000n,
    79228162514264337593543950336n,
    0n
  );
}

function v4Pool(
  token0: string,
  token1: string,
  fee: number,
  tickSpacing: number,
  hooks: string,
  poolId: string
): V4Pool {
  return new V4Pool(
    new Address(token0),
    new Address(token1),
    fee,
    tickSpacing,
    hooks,
    1_000_000_000_000n,
    poolId,
    79228162514264337593543950336n,
    0n
  );
}

function tokenCI(address: string, isNative = false): CurrencyInfo {
  return new CurrencyInfo(isNative, new Address(address));
}

const POOL_ADDR_1 = '0x0000000000000000000000000000000000001111';
const POOL_ADDR_2 = '0x0000000000000000000000000000000000002222';
const POOL_ADDR_3 = '0x0000000000000000000000000000000000003333';

// Zero slippage => caps unpadded (x1), so structural tests assert raw amounts.
// The padded-cap behavior is covered by the "exact-out slippage buffer" block.
const ZERO_SLIPPAGE = new Percent(0, 1);

const ZERO_HOOKS = '0x0000000000000000000000000000000000000000';
const POOL_ID_V4_1 =
  '0x0000000000000000000000000000000000000000000000000000000000004001';
const POOL_ID_V4_2 =
  '0x0000000000000000000000000000000000000000000000000000000000004002';

// === V2 ======================================================================

describe('SwapStepsFactory - V2', () => {
  it('emits V2_SWAP_EXACT_IN for a single-pool exact-in route (tokenIn = pool.token0)', () => {
    const quote = new QuoteBasic(
      new RouteBasic(Protocol.V2, [v2Pool(USDC, WETH, POOL_ADDR_1)]),
      999n
    );
    const split = new QuoteSplit([quote]);

    const steps = buildSwapSteps(
      split,
      TradeType.ExactIn,
      1_000_000n,
      tokenCI(USDC),
      tokenCI(WETH),
      ZERO_SLIPPAGE
    );

    expect(steps).toEqual([
      {
        type: 'V2_SWAP_EXACT_IN',
        recipient: ROUTER_AS_RECIPIENT,
        amountIn: '1000000',
        amountOutMin: '0',
        path: [USDC, WETH],
      },
    ]);
  });

  it('reverses path direction when route tokenIn is pool.token1 (WETH -> USDC)', () => {
    // Same pool as above (token0=USDC, token1=WETH), but the user is selling
    // WETH for USDC. Path must be [WETH, USDC], not [USDC, WETH].
    const quote = new QuoteBasic(
      new RouteBasic(Protocol.V2, [v2Pool(USDC, WETH, POOL_ADDR_1)]),
      999n
    );
    const split = new QuoteSplit([quote]);

    const steps = buildSwapSteps(
      split,
      TradeType.ExactIn,
      1_000_000_000_000_000_000n,
      tokenCI(WETH),
      tokenCI(USDC),
      ZERO_SLIPPAGE
    );

    expect(steps).toEqual([
      {
        type: 'V2_SWAP_EXACT_IN',
        recipient: ROUTER_AS_RECIPIENT,
        amountIn: '1000000000000000000',
        amountOutMin: '0',
        path: [WETH, USDC],
      },
    ]);
  });

  it('emits V2_SWAP_EXACT_IN for a multi-hop route (USDC -> WETH -> DAI)', () => {
    // Hop 1: pool token0=USDC, token1=WETH; tokenIn=USDC -> path emits [USDC, WETH]
    // Hop 2: pool token0=DAI, token1=WETH; tokenIn=WETH -> path emits [..., DAI]
    const quote = new QuoteBasic(
      new RouteBasic(Protocol.V2, [
        v2Pool(USDC, WETH, POOL_ADDR_1),
        v2Pool(DAI, WETH, POOL_ADDR_2),
      ]),
      999n
    );
    const split = new QuoteSplit([quote]);

    const steps = buildSwapSteps(
      split,
      TradeType.ExactIn,
      1_000_000n,
      tokenCI(USDC),
      tokenCI(DAI),
      ZERO_SLIPPAGE
    );

    expect(steps).toEqual([
      {
        type: 'V2_SWAP_EXACT_IN',
        recipient: ROUTER_AS_RECIPIENT,
        amountIn: '1000000',
        amountOutMin: '0',
        path: [USDC, WETH, DAI],
      },
    ]);
  });
});

// === V3 ======================================================================

describe('SwapStepsFactory - V3', () => {
  it('emits V3_SWAP_EXACT_IN with packed path for a single-pool route', () => {
    // Pool token0=USDC, token1=WETH, fee=500 (0x0001f4 packed)
    const quote = new QuoteBasic(
      new RouteBasic(Protocol.V3, [v3Pool(USDC, WETH, 500, POOL_ADDR_1)]),
      999n
    );
    const split = new QuoteSplit([quote]);

    const steps = buildSwapSteps(
      split,
      TradeType.ExactIn,
      1_000_000n,
      tokenCI(USDC),
      tokenCI(WETH),
      ZERO_SLIPPAGE
    );

    expect(steps).toEqual([
      {
        type: 'V3_SWAP_EXACT_IN',
        recipient: ROUTER_AS_RECIPIENT,
        amountIn: '1000000',
        amountOutMin: '0',
        // path = tokenIn (20 bytes) + fee (3 bytes) + tokenOut (20 bytes), all
        // lowercase, no '0x' between segments.
        path: `0x${USDC.slice(2).toLowerCase()}0001f4${WETH.slice(2).toLowerCase()}`,
      },
    ]);
  });

  it('reverses path when route tokenIn is pool.token1 (WETH -> USDC, fee=500)', () => {
    // Same pool (token0=USDC, token1=WETH, fee=500), reversed direction.
    const quote = new QuoteBasic(
      new RouteBasic(Protocol.V3, [v3Pool(USDC, WETH, 500, POOL_ADDR_1)]),
      999n
    );
    const split = new QuoteSplit([quote]);

    const steps = buildSwapSteps(
      split,
      TradeType.ExactIn,
      1_000_000_000_000_000_000n,
      tokenCI(WETH),
      tokenCI(USDC),
      ZERO_SLIPPAGE
    );

    expect(steps).toEqual([
      {
        type: 'V3_SWAP_EXACT_IN',
        recipient: ROUTER_AS_RECIPIENT,
        amountIn: '1000000000000000000',
        amountOutMin: '0',
        path: `0x${WETH.slice(2).toLowerCase()}0001f4${USDC.slice(2).toLowerCase()}`,
      },
    ]);
  });

  it('emits V3_SWAP_EXACT_IN with multi-hop packed path (USDC -> WETH -> DAI)', () => {
    // Hop 1: USDC->WETH, fee=500 (0x0001f4)
    // Hop 2: WETH->DAI, fee=3000 (0x000bb8)
    const quote = new QuoteBasic(
      new RouteBasic(Protocol.V3, [
        v3Pool(USDC, WETH, 500, POOL_ADDR_1),
        v3Pool(DAI, WETH, 3000, POOL_ADDR_2),
      ]),
      999n
    );
    const split = new QuoteSplit([quote]);

    const steps = buildSwapSteps(
      split,
      TradeType.ExactIn,
      1_000_000n,
      tokenCI(USDC),
      tokenCI(DAI),
      ZERO_SLIPPAGE
    );

    expect(steps).toEqual([
      {
        type: 'V3_SWAP_EXACT_IN',
        recipient: ROUTER_AS_RECIPIENT,
        amountIn: '1000000',
        amountOutMin: '0',
        path:
          `0x${USDC.slice(2).toLowerCase()}` +
          '0001f4' +
          WETH.slice(2).toLowerCase() +
          '000bb8' +
          DAI.slice(2).toLowerCase(),
      },
    ]);
  });
});

// === V4 ======================================================================

describe('SwapStepsFactory - V4', () => {
  it('emits V4_SWAP with SWAP_EXACT_IN_SINGLE for a single-pool route (USDC -> WETH)', () => {
    // Pool token0=USDC, token1=WETH, fee=500, tickSpacing=10. Route is
    // USDC -> WETH, so zeroForOne = true (tokenIn = currency0).
    const quote = new QuoteBasic(
      new RouteBasic(Protocol.V4, [
        v4Pool(USDC, WETH, 500, 10, ZERO_HOOKS, POOL_ID_V4_1),
      ]),
      999n
    );
    const split = new QuoteSplit([quote]);

    const steps = buildSwapSteps(
      split,
      TradeType.ExactIn,
      1_000_000n,
      tokenCI(USDC),
      tokenCI(WETH),
      ZERO_SLIPPAGE
    );

    expect(steps).toEqual([
      {
        type: 'V4_SWAP',
        v4Actions: [
          {action: 'SETTLE', currency: USDC, amount: '1000000'},
          {
            action: 'SWAP_EXACT_IN_SINGLE',
            poolKey: {
              currency0: USDC,
              currency1: WETH,
              fee: 500,
              tickSpacing: 10,
              hooks: ZERO_HOOKS,
            },
            zeroForOne: true,
            amountIn: '1000000',
            amountOutMinimum: '0',
            hookData: '0x',
          },
          {
            action: 'TAKE',
            currency: WETH,
            recipient: ROUTER_AS_RECIPIENT,
            amount: '0',
          },
        ],
      },
    ]);
  });

  it('flips zeroForOne when route tokenIn is pool.currency1 (WETH -> USDC)', () => {
    // Same pool (token0=USDC, token1=WETH). Route reversed -> zeroForOne=false.
    const quote = new QuoteBasic(
      new RouteBasic(Protocol.V4, [
        v4Pool(USDC, WETH, 500, 10, ZERO_HOOKS, POOL_ID_V4_1),
      ]),
      999n
    );
    const split = new QuoteSplit([quote]);

    const steps = buildSwapSteps(
      split,
      TradeType.ExactIn,
      1_000_000_000_000_000_000n,
      tokenCI(WETH),
      tokenCI(USDC),
      ZERO_SLIPPAGE
    );

    expect(steps).toEqual([
      {
        type: 'V4_SWAP',
        v4Actions: [
          {action: 'SETTLE', currency: WETH, amount: '1000000000000000000'},
          {
            action: 'SWAP_EXACT_IN_SINGLE',
            poolKey: {
              currency0: USDC,
              currency1: WETH,
              fee: 500,
              tickSpacing: 10,
              hooks: ZERO_HOOKS,
            },
            zeroForOne: false,
            amountIn: '1000000000000000000',
            amountOutMinimum: '0',
            hookData: '0x',
          },
          {
            action: 'TAKE',
            currency: USDC,
            recipient: ROUTER_AS_RECIPIENT,
            amount: '0',
          },
        ],
      },
    ]);
  });

  it('emits V4_SWAP with SWAP_EXACT_IN + PathKey[] for a multi-hop route', () => {
    // Hop 1: USDC->WETH, fee=500, tickSpacing=10, ZERO_HOOKS
    // Hop 2: WETH->DAI, fee=3000, tickSpacing=60, ZERO_HOOKS
    const quote = new QuoteBasic(
      new RouteBasic(Protocol.V4, [
        v4Pool(USDC, WETH, 500, 10, ZERO_HOOKS, POOL_ID_V4_1),
        v4Pool(DAI, WETH, 3000, 60, ZERO_HOOKS, POOL_ID_V4_2),
      ]),
      999n
    );
    const split = new QuoteSplit([quote]);

    const steps = buildSwapSteps(
      split,
      TradeType.ExactIn,
      1_000_000n,
      tokenCI(USDC),
      tokenCI(DAI),
      ZERO_SLIPPAGE
    );

    expect(steps).toEqual([
      {
        type: 'V4_SWAP',
        v4Actions: [
          {action: 'SETTLE', currency: USDC, amount: '1000000'},
          {
            action: 'SWAP_EXACT_IN',
            currencyIn: USDC,
            path: [
              {
                intermediateCurrency: WETH,
                fee: 500,
                tickSpacing: 10,
                hooks: ZERO_HOOKS,
                hookData: '0x',
              },
              {
                intermediateCurrency: DAI,
                fee: 3000,
                tickSpacing: 60,
                hooks: ZERO_HOOKS,
                hookData: '0x',
              },
            ],
            amountIn: '1000000',
            amountOutMinimum: '0',
          },
          {
            action: 'TAKE',
            currency: DAI,
            recipient: ROUTER_AS_RECIPIENT,
            amount: '0',
          },
        ],
      },
    ]);
  });

  it('emits one V4_SWAP per parallel split with allocated amountIn', () => {
    // 60/40 split between two V4 pools, both USDC->WETH but different fees.
    // Trade amountIn = 100 USDC -> 60% allocated to first quote, 40% to second.
    const quote1 = new QuoteBasic(
      new RouteBasic(
        Protocol.V4,
        [v4Pool(USDC, WETH, 500, 10, ZERO_HOOKS, POOL_ID_V4_1)],
        60
      ),
      0n
    );
    const quote2 = new QuoteBasic(
      new RouteBasic(
        Protocol.V4,
        [v4Pool(USDC, WETH, 3000, 60, ZERO_HOOKS, POOL_ID_V4_2)],
        40
      ),
      0n
    );
    const split = new QuoteSplit([quote1, quote2]);

    const steps = buildSwapSteps(
      split,
      TradeType.ExactIn,
      100_000_000n, // 100 USDC (6 decimals)
      tokenCI(USDC),
      tokenCI(WETH),
      ZERO_SLIPPAGE
    );

    expect(steps).toHaveLength(2);
    // First quote: 60_000_000 (60% of 100M)
    expect(steps[0]).toMatchObject({
      type: 'V4_SWAP',
      v4Actions: [
        {action: 'SETTLE', currency: USDC, amount: '60000000'},
        expect.objectContaining({amountIn: '60000000'}),
        expect.objectContaining({action: 'TAKE'}),
      ],
    });
    // Second quote: 40_000_000 (last quote absorbs remainder)
    expect(steps[1]).toMatchObject({
      type: 'V4_SWAP',
      v4Actions: [
        {action: 'SETTLE', currency: USDC, amount: '40000000'},
        expect.objectContaining({amountIn: '40000000'}),
        expect.objectContaining({action: 'TAKE'}),
      ],
    });
  });

  it('preserves native currency 0x0 in V4 pool key (no WRAP_ETH)', () => {
    // V4 pool with native ETH as token0 (the convention for native pools).
    // No WRAP_ETH should be emitted because V4 handles native directly.
    const quote = new QuoteBasic(
      new RouteBasic(Protocol.V4, [
        v4Pool(NATIVE, USDC, 500, 10, ZERO_HOOKS, POOL_ID_V4_1),
      ]),
      999n
    );
    const split = new QuoteSplit([quote]);

    const steps = buildSwapSteps(
      split,
      TradeType.ExactIn,
      1_000_000_000_000_000_000n,
      // Native input — `wrappedAddress` is the chain's WETH (production
      // convention); `isNative` distinguishes native vs wrapped intent.
      new CurrencyInfo(true, new Address(WETH)),
      tokenCI(USDC),
      ZERO_SLIPPAGE
    );

    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      type: 'V4_SWAP',
      v4Actions: [
        {action: 'SETTLE', currency: NATIVE, amount: '1000000000000000000'},
        {
          action: 'SWAP_EXACT_IN_SINGLE',
          poolKey: {
            currency0: NATIVE,
            currency1: USDC,
            fee: 500,
            tickSpacing: 10,
            hooks: ZERO_HOOKS,
          },
          zeroForOne: true,
          amountIn: '1000000000000000000',
          amountOutMinimum: '0',
          hookData: '0x',
        },
        {
          action: 'TAKE',
          currency: USDC,
          recipient: ROUTER_AS_RECIPIENT,
          amount: '0',
        },
      ],
    });
  });

  // Pool objects from the on-chain discoverer carry token0/token1 in
  // tokenIn/tokenOut request order rather than canonical sorted order. The
  // emitted poolKey must be canonicalized regardless — an unsorted key
  // hashes to a nonexistent pool and reverts with PoolNotInitialized().
  it('canonicalizes the poolKey when the pool carries unsorted token0/token1 (WETH -> USDC)', () => {
    // Same WETH/USDC pool, but constructed with token0=WETH, token1=USDC
    // (unsorted: USDC < WETH). Route WETH -> USDC: tokenIn is currency1 of
    // the canonical key, so zeroForOne = false.
    const quote = new QuoteBasic(
      new RouteBasic(Protocol.V4, [
        v4Pool(WETH, USDC, 500, 10, ZERO_HOOKS, POOL_ID_V4_1),
      ]),
      999n
    );
    const split = new QuoteSplit([quote]);

    const steps = buildSwapSteps(
      split,
      TradeType.ExactIn,
      1_000_000_000_000_000_000n,
      tokenCI(WETH),
      tokenCI(USDC),
      ZERO_SLIPPAGE
    );

    expect(steps).toEqual([
      {
        type: 'V4_SWAP',
        v4Actions: [
          {action: 'SETTLE', currency: WETH, amount: '1000000000000000000'},
          {
            action: 'SWAP_EXACT_IN_SINGLE',
            poolKey: {
              currency0: USDC,
              currency1: WETH,
              fee: 500,
              tickSpacing: 10,
              hooks: ZERO_HOOKS,
            },
            zeroForOne: false,
            amountIn: '1000000000000000000',
            amountOutMinimum: '0',
            hookData: '0x',
          },
          {
            action: 'TAKE',
            currency: USDC,
            recipient: ROUTER_AS_RECIPIENT,
            amount: '0',
          },
        ],
      },
    ]);
  });

  it('sorts the poolKey numerically, not by raw ASCII (checksum case must not matter)', () => {
    // Checksummed forms: 0xa0…02 starts lowercase 'a', 0xB0…04 starts
    // uppercase 'B'. Numerically a0…02 < B0…04, but raw ASCII puts 'B'
    // (0x42) before 'a' (0x61) — a case-sensitive sort would emit the
    // flipped key (and zeroForOne=false) and revert PoolNotInitialized().
    const TOKEN_LOWER_A = '0xa000000000000000000000000000000000000002';
    const TOKEN_UPPER_B = '0xB000000000000000000000000000000000000004';
    const quote = new QuoteBasic(
      new RouteBasic(Protocol.V4, [
        v4Pool(TOKEN_UPPER_B, TOKEN_LOWER_A, 500, 10, ZERO_HOOKS, POOL_ID_V4_1),
      ]),
      999n
    );
    const split = new QuoteSplit([quote]);

    const steps = buildSwapSteps(
      split,
      TradeType.ExactIn,
      1_000_000n,
      tokenCI(TOKEN_LOWER_A),
      tokenCI(TOKEN_UPPER_B),
      ZERO_SLIPPAGE
    );

    expect(steps).toEqual([
      {
        type: 'V4_SWAP',
        v4Actions: [
          {action: 'SETTLE', currency: TOKEN_LOWER_A, amount: '1000000'},
          {
            action: 'SWAP_EXACT_IN_SINGLE',
            poolKey: {
              currency0: TOKEN_LOWER_A,
              currency1: TOKEN_UPPER_B,
              fee: 500,
              tickSpacing: 10,
              hooks: ZERO_HOOKS,
            },
            zeroForOne: true,
            amountIn: '1000000',
            amountOutMinimum: '0',
            hookData: '0x',
          },
          {
            action: 'TAKE',
            currency: TOKEN_UPPER_B,
            recipient: ROUTER_AS_RECIPIENT,
            amount: '0',
          },
        ],
      },
    ]);
  });

  it('canonicalizes the poolKey when the pool carries unsorted token0/token1 (USDC -> WETH)', () => {
    // Unsorted pool again, opposite direction. tokenIn (USDC) is currency0
    // of the canonical key, so zeroForOne = true — the raw pool fields
    // would have said false.
    const quote = new QuoteBasic(
      new RouteBasic(Protocol.V4, [
        v4Pool(WETH, USDC, 500, 10, ZERO_HOOKS, POOL_ID_V4_1),
      ]),
      999n
    );
    const split = new QuoteSplit([quote]);

    const steps = buildSwapSteps(
      split,
      TradeType.ExactIn,
      1_000_000n,
      tokenCI(USDC),
      tokenCI(WETH),
      ZERO_SLIPPAGE
    );

    expect(steps).toEqual([
      {
        type: 'V4_SWAP',
        v4Actions: [
          {action: 'SETTLE', currency: USDC, amount: '1000000'},
          {
            action: 'SWAP_EXACT_IN_SINGLE',
            poolKey: {
              currency0: USDC,
              currency1: WETH,
              fee: 500,
              tickSpacing: 10,
              hooks: ZERO_HOOKS,
            },
            zeroForOne: true,
            amountIn: '1000000',
            amountOutMinimum: '0',
            hookData: '0x',
          },
          {
            action: 'TAKE',
            currency: WETH,
            recipient: ROUTER_AS_RECIPIENT,
            amount: '0',
          },
        ],
      },
    ]);
  });
});

// === Native input / output (WRAP_ETH / UNWRAP_WETH) ==========================

describe('SwapStepsFactory - native input/output', () => {
  it('emits WRAP_ETH at the start when native input feeds a V3 (WETH) route', () => {
    // User sells native ETH for USDC via V3 (USDC, WETH pool). V3 needs
    // WETH, so we wrap up front.
    const quote = new QuoteBasic(
      new RouteBasic(Protocol.V3, [v3Pool(USDC, WETH, 500, POOL_ADDR_1)]),
      999n
    );
    const split = new QuoteSplit([quote]);

    const steps = buildSwapSteps(
      split,
      TradeType.ExactIn,
      1_000_000_000_000_000_000n,
      new CurrencyInfo(true, new Address(WETH)),
      tokenCI(USDC),
      ZERO_SLIPPAGE
    );

    expect(steps).toEqual([
      {
        type: 'WRAP_ETH',
        recipient: ROUTER_AS_RECIPIENT,
        amount: '1000000000000000000',
      },
      {
        type: 'V3_SWAP_EXACT_IN',
        recipient: ROUTER_AS_RECIPIENT,
        amountIn: '1000000000000000000',
        amountOutMin: '0',
        path: `0x${WETH.slice(2).toLowerCase()}0001f4${USDC.slice(2).toLowerCase()}`,
      },
    ]);
  });

  it('emits UNWRAP_WETH at the end when native output is fed by a V3 (WETH) route', () => {
    // User sells USDC for native ETH via V3. Last step gives router WETH;
    // then UNWRAP_WETH delivers ETH (next-step recipient = router; final
    // recipient is set by the SwapSpecification).
    const quote = new QuoteBasic(
      new RouteBasic(Protocol.V3, [v3Pool(USDC, WETH, 500, POOL_ADDR_1)]),
      999n
    );
    const split = new QuoteSplit([quote]);

    const steps = buildSwapSteps(
      split,
      TradeType.ExactIn,
      1_000_000n,
      tokenCI(USDC),
      new CurrencyInfo(true, new Address(WETH)),
      ZERO_SLIPPAGE
    );

    expect(steps).toEqual([
      {
        type: 'V3_SWAP_EXACT_IN',
        recipient: ROUTER_AS_RECIPIENT,
        amountIn: '1000000',
        amountOutMin: '0',
        path: `0x${USDC.slice(2).toLowerCase()}0001f4${WETH.slice(2).toLowerCase()}`,
      },
      {
        type: 'UNWRAP_WETH',
        recipient: ROUTER_AS_RECIPIENT,
        amountMin: '0',
      },
    ]);
  });

  it('does not emit WRAP_ETH for V4 native-pool routes', () => {
    // Already exercised above; this case asserts the outer wrapper makes no
    // wrap when the V4 segment uses 0x0 directly.
    const quote = new QuoteBasic(
      new RouteBasic(Protocol.V4, [
        v4Pool(NATIVE, USDC, 500, 10, ZERO_HOOKS, POOL_ID_V4_1),
      ]),
      999n
    );
    const split = new QuoteSplit([quote]);

    const steps = buildSwapSteps(
      split,
      TradeType.ExactIn,
      1_000_000_000_000_000_000n,
      new CurrencyInfo(true, new Address(WETH)),
      tokenCI(USDC),
      ZERO_SLIPPAGE
    );

    // Length 1: no WRAP_ETH, just the V4 step.
    expect(steps).toHaveLength(1);
    expect(steps[0].type).toBe('V4_SWAP');
  });

  it('emits partial WRAP_ETH amount only for V3 leg in a mixed V3+V4 native split', () => {
    // 30/70 split: 30% V3 (WETH route, needs wrap) + 70% V4 native (no wrap).
    // The WRAP_ETH must cover only the 30% V3 allocation; the remaining 70%
    // stays as native and feeds the V4 SETTLE directly.
    const v3Quote = new QuoteBasic(
      new RouteBasic(Protocol.V3, [v3Pool(USDC, WETH, 500, POOL_ADDR_1)], 30),
      0n
    );
    const v4Quote = new QuoteBasic(
      new RouteBasic(
        Protocol.V4,
        [v4Pool(NATIVE, USDC, 500, 10, ZERO_HOOKS, POOL_ID_V4_1)],
        70
      ),
      0n
    );
    const split = new QuoteSplit([v3Quote, v4Quote]);

    const steps = buildSwapSteps(
      split,
      TradeType.ExactIn,
      1_000_000_000_000_000_000n, // 1 ETH
      new CurrencyInfo(true, new Address(WETH)),
      tokenCI(USDC),
      ZERO_SLIPPAGE
    );

    // Order: WRAP_ETH (30% only), V3 step (using WETH), V4 step (using NATIVE).
    expect(steps).toHaveLength(3);
    expect(steps[0]).toEqual({
      type: 'WRAP_ETH',
      recipient: ROUTER_AS_RECIPIENT,
      amount: '300000000000000000', // 30% of 1e18
    });
    expect(steps[1]).toMatchObject({
      type: 'V3_SWAP_EXACT_IN',
      amountIn: '300000000000000000',
      // V3 path threads WETH (not native).
      path: `0x${WETH.slice(2).toLowerCase()}0001f4${USDC.slice(2).toLowerCase()}`,
    });
    expect(steps[2]).toMatchObject({
      type: 'V4_SWAP',
      v4Actions: [
        // V4 SETTLEs the *native* leftover — last quote absorbs remainder
        // of allocation (700_000_000_000_000_000 = 70% of 1e18).
        {action: 'SETTLE', currency: NATIVE, amount: '700000000000000000'},
        expect.objectContaining({action: 'SWAP_EXACT_IN_SINGLE'}),
        expect.objectContaining({action: 'TAKE'}),
      ],
    });
  });

  it('appends UNWRAP_WETH for native-input exact-out via a WETH route (recover over-wrap)', () => {
    // Over-wrapped leftover (padded max - consumed) is unwrapped to native.
    const quote = new QuoteBasic(
      new RouteBasic(Protocol.V3, [v3Pool(USDC, WETH, 500, POOL_ADDR_1)]),
      1_000_000_000_000_000n
    );
    const split = new QuoteSplit([quote]);

    const steps = buildSwapSteps(
      split,
      TradeType.ExactOut,
      2_000_000n,
      new CurrencyInfo(true, new Address(WETH)),
      tokenCI(USDC),
      ZERO_SLIPPAGE
    );

    expect(steps.map(s => s.type)).toEqual([
      'WRAP_ETH',
      'V3_SWAP_EXACT_OUT',
      'UNWRAP_WETH',
    ]);
  });

  it('does not unwrap for WETH-input exact-out (input SWEEP returns WETH directly)', () => {
    // ERC20 input is never wrapped, so nothing to unwrap.
    const quote = new QuoteBasic(
      new RouteBasic(Protocol.V3, [v3Pool(USDC, WETH, 500, POOL_ADDR_1)]),
      1_000_000_000_000_000n
    );
    const split = new QuoteSplit([quote]);

    const steps = buildSwapSteps(
      split,
      TradeType.ExactOut,
      2_000_000n,
      tokenCI(WETH),
      tokenCI(USDC),
      ZERO_SLIPPAGE
    );

    expect(steps.map(s => s.type)).toEqual(['V3_SWAP_EXACT_OUT']);
  });

  it('does not unwrap for native-input exact-out when the output IS WETH', () => {
    // Output WETH shares the leftover's currency, so unwrapping would clobber
    // the output. Route: WETH -> USDC -> WETH.
    const quote = new QuoteBasic(
      new RouteBasic(Protocol.V3, [
        v3Pool(USDC, WETH, 500, POOL_ADDR_1),
        v3Pool(USDC, WETH, 3000, POOL_ADDR_2),
      ]),
      1_000_000_000_000_000n
    );
    const split = new QuoteSplit([quote]);

    const steps = buildSwapSteps(
      split,
      TradeType.ExactOut,
      1_000_000_000_000_000n,
      new CurrencyInfo(true, new Address(WETH)),
      tokenCI(WETH),
      ZERO_SLIPPAGE
    );

    expect(steps.map(s => s.type)).toEqual(['WRAP_ETH', 'V3_SWAP_EXACT_OUT']);
  });
});

// === Exact-output ============================================================

describe('SwapStepsFactory - V2 exact-out', () => {
  it('emits V2_SWAP_EXACT_OUT for a single-pool route', () => {
    // User wants exactly amountOut tokens; route consumes quote.amount input.
    // V2 path is forward order (same as exact-in).
    const quote = new QuoteBasic(
      new RouteBasic(Protocol.V2, [v2Pool(USDC, WETH, POOL_ADDR_1)]),
      // quote.amount = route input required to produce desired output
      1_500_000n
    );
    const split = new QuoteSplit([quote]);

    const steps = buildSwapSteps(
      split,
      TradeType.ExactOut,
      // For exact-out, `amountIn` here is the user's *desired output*.
      1_000_000n,
      tokenCI(USDC),
      tokenCI(WETH),
      ZERO_SLIPPAGE
    );

    expect(steps).toEqual([
      {
        type: 'V2_SWAP_EXACT_OUT',
        recipient: ROUTER_AS_RECIPIENT,
        amountOut: '1000000',
        amountInMax: '1500000', // raw; Trading's SwapSpecification owns slippage
        path: [USDC, WETH],
      },
    ]);
  });

  it('emits V2_SWAP_EXACT_OUT with multi-hop path (USDC -> WETH -> DAI)', () => {
    const quote = new QuoteBasic(
      new RouteBasic(Protocol.V2, [
        v2Pool(USDC, WETH, POOL_ADDR_1),
        v2Pool(DAI, WETH, POOL_ADDR_2),
      ]),
      2_000_000n
    );
    const split = new QuoteSplit([quote]);

    const steps = buildSwapSteps(
      split,
      TradeType.ExactOut,
      1_000_000n,
      tokenCI(USDC),
      tokenCI(DAI),
      ZERO_SLIPPAGE
    );

    expect(steps).toEqual([
      {
        type: 'V2_SWAP_EXACT_OUT',
        recipient: ROUTER_AS_RECIPIENT,
        amountOut: '1000000',
        amountInMax: '2000000',
        path: [USDC, WETH, DAI],
      },
    ]);
  });
});

describe('SwapStepsFactory - V3 exact-out', () => {
  it('emits V3_SWAP_EXACT_OUT with reversed packed path for a single-pool route', () => {
    // V3 exact-out path is REVERSED: tokenOut first, fees in reverse pool
    // order, ending at tokenIn. Single hop = same bytes as exact-in just
    // mirrored.
    const quote = new QuoteBasic(
      new RouteBasic(Protocol.V3, [v3Pool(USDC, WETH, 500, POOL_ADDR_1)]),
      1_500_000n
    );
    const split = new QuoteSplit([quote]);

    const steps = buildSwapSteps(
      split,
      TradeType.ExactOut,
      1_000_000n,
      tokenCI(USDC),
      tokenCI(WETH),
      ZERO_SLIPPAGE
    );

    expect(steps).toEqual([
      {
        type: 'V3_SWAP_EXACT_OUT',
        recipient: ROUTER_AS_RECIPIENT,
        amountOut: '1000000',
        amountInMax: '1500000',
        // Reversed: WETH | fee 500 (0x0001f4) | USDC
        path: `0x${WETH.slice(2).toLowerCase()}0001f4${USDC.slice(2).toLowerCase()}`,
      },
    ]);
  });

  it('reverses pool order for multi-hop exact-out (USDC -> WETH -> DAI)', () => {
    // Forward route order: USDC -hop1(fee=500)-> WETH -hop2(fee=3000)-> DAI
    // Exact-out packed path reverses: DAI | fee2(0x000bb8) | WETH | fee1(0x0001f4) | USDC
    const quote = new QuoteBasic(
      new RouteBasic(Protocol.V3, [
        v3Pool(USDC, WETH, 500, POOL_ADDR_1),
        v3Pool(DAI, WETH, 3000, POOL_ADDR_2),
      ]),
      2_000_000n
    );
    const split = new QuoteSplit([quote]);

    const steps = buildSwapSteps(
      split,
      TradeType.ExactOut,
      1_000_000n,
      tokenCI(USDC),
      tokenCI(DAI),
      ZERO_SLIPPAGE
    );

    expect(steps).toEqual([
      {
        type: 'V3_SWAP_EXACT_OUT',
        recipient: ROUTER_AS_RECIPIENT,
        amountOut: '1000000',
        amountInMax: '2000000',
        path:
          `0x${DAI.slice(2).toLowerCase()}` +
          '000bb8' +
          WETH.slice(2).toLowerCase() +
          '0001f4' +
          USDC.slice(2).toLowerCase(),
      },
    ]);
  });
});

describe('SwapStepsFactory - V4 exact-out', () => {
  it('emits V4_SWAP with SWAP_EXACT_OUT_SINGLE for a single-pool route', () => {
    // Action order: SWAP, then SETTLE (input) and TAKE (output) via OPEN_DELTA.
    const quote = new QuoteBasic(
      new RouteBasic(Protocol.V4, [
        v4Pool(USDC, WETH, 500, 10, ZERO_HOOKS, POOL_ID_V4_1),
      ]),
      // Route input required to produce 1e18 WETH out:
      230_000_000n
    );
    const split = new QuoteSplit([quote]);

    const steps = buildSwapSteps(
      split,
      TradeType.ExactOut,
      1_000_000_000_000_000_000n, // 1 WETH desired
      tokenCI(USDC),
      tokenCI(WETH),
      ZERO_SLIPPAGE
    );

    expect(steps).toEqual([
      {
        type: 'V4_SWAP',
        v4Actions: [
          {
            action: 'SWAP_EXACT_OUT_SINGLE',
            poolKey: {
              currency0: USDC,
              currency1: WETH,
              fee: 500,
              tickSpacing: 10,
              hooks: ZERO_HOOKS,
            },
            zeroForOne: true,
            amountOut: '1000000000000000000',
            amountInMaximum: '230000000',
            hookData: '0x',
          },
          {
            action: 'SETTLE',
            currency: USDC,
            amount: '0',
          },
          {
            action: 'TAKE',
            currency: WETH,
            recipient: ROUTER_AS_RECIPIENT,
            amount: '0',
          },
        ],
      },
    ]);
  });

  it('flips zeroForOne for V4 exact-out when route tokenIn is currency1 (WETH -> USDC)', () => {
    const quote = new QuoteBasic(
      new RouteBasic(Protocol.V4, [
        v4Pool(USDC, WETH, 500, 10, ZERO_HOOKS, POOL_ID_V4_1),
      ]),
      // Route input (WETH) for 1000 USDC out:
      500_000_000_000_000_000n
    );
    const split = new QuoteSplit([quote]);

    const steps = buildSwapSteps(
      split,
      TradeType.ExactOut,
      1_000_000_000n, // 1000 USDC desired
      tokenCI(WETH),
      tokenCI(USDC),
      ZERO_SLIPPAGE
    );

    expect(steps).toEqual([
      {
        type: 'V4_SWAP',
        v4Actions: [
          expect.objectContaining({
            action: 'SWAP_EXACT_OUT_SINGLE',
            zeroForOne: false,
            amountOut: '1000000000',
            amountInMaximum: '500000000000000000',
          }),
          {
            action: 'SETTLE',
            currency: WETH,
            amount: '0',
          },
          {
            action: 'TAKE',
            currency: USDC,
            recipient: ROUTER_AS_RECIPIENT,
            amount: '0',
          },
        ],
      },
    ]);
  });

  it('emits V4_SWAP with SWAP_EXACT_OUT + PathKey[] for a multi-hop route', () => {
    // Hop 1: USDC->WETH, fee=500, tickSpacing=10
    // Hop 2: WETH->DAI, fee=3000, tickSpacing=60
    const quote = new QuoteBasic(
      new RouteBasic(Protocol.V4, [
        v4Pool(USDC, WETH, 500, 10, ZERO_HOOKS, POOL_ID_V4_1),
        v4Pool(DAI, WETH, 3000, 60, ZERO_HOOKS, POOL_ID_V4_2),
      ]),
      2_000_000n
    );
    const split = new QuoteSplit([quote]);

    const steps = buildSwapSteps(
      split,
      TradeType.ExactOut,
      1_000_000n,
      tokenCI(USDC),
      tokenCI(DAI),
      ZERO_SLIPPAGE
    );

    expect(steps).toEqual([
      {
        type: 'V4_SWAP',
        v4Actions: [
          {
            action: 'SWAP_EXACT_OUT',
            currencyOut: DAI,
            // Forward (input->output) order; the router walks it in reverse.
            path: [
              {
                intermediateCurrency: USDC,
                fee: 500,
                tickSpacing: 10,
                hooks: ZERO_HOOKS,
                hookData: '0x',
              },
              {
                intermediateCurrency: WETH,
                fee: 3000,
                tickSpacing: 60,
                hooks: ZERO_HOOKS,
                hookData: '0x',
              },
            ],
            amountOut: '1000000',
            amountInMaximum: '2000000',
          },
          {action: 'SETTLE', currency: USDC, amount: '0'},
          {
            action: 'TAKE',
            currency: DAI,
            recipient: ROUTER_AS_RECIPIENT,
            amount: '0',
          },
        ],
      },
    ]);
  });

  it('canonicalizes the poolKey for exact-out when the pool carries unsorted token0/token1', () => {
    // Pool constructed token0=WETH, token1=USDC (unsorted). Route
    // WETH -> USDC exact-out: canonical key sorts to (USDC, WETH) and
    // tokenIn (WETH) is currency1, so zeroForOne = false.
    const quote = new QuoteBasic(
      new RouteBasic(Protocol.V4, [
        v4Pool(WETH, USDC, 500, 10, ZERO_HOOKS, POOL_ID_V4_1),
      ]),
      // Route input (WETH) for 1000 USDC out:
      500_000_000_000_000_000n
    );
    const split = new QuoteSplit([quote]);

    const steps = buildSwapSteps(
      split,
      TradeType.ExactOut,
      1_000_000_000n,
      tokenCI(WETH),
      tokenCI(USDC),
      ZERO_SLIPPAGE
    );

    expect(steps).toEqual([
      {
        type: 'V4_SWAP',
        v4Actions: [
          {
            action: 'SWAP_EXACT_OUT_SINGLE',
            poolKey: {
              currency0: USDC,
              currency1: WETH,
              fee: 500,
              tickSpacing: 10,
              hooks: ZERO_HOOKS,
            },
            zeroForOne: false,
            amountOut: '1000000000',
            amountInMaximum: '500000000000000000',
            hookData: '0x',
          },
          {
            action: 'SETTLE',
            currency: WETH,
            amount: '0',
          },
          {
            action: 'TAKE',
            currency: USDC,
            recipient: ROUTER_AS_RECIPIENT,
            amount: '0',
          },
        ],
      },
    ]);
  });

  it('multi-hop SWAP_EXACT_OUT path matches v4-sdk encodeRouteToPath (oracle)', () => {
    // Pins our cloned path ordering to the SDK's canonical builder so the
    // convention can't silently drift. Route: USDC -> WETH -> DAI.
    const steps = buildSwapSteps(
      new QuoteSplit([
        new QuoteBasic(
          new RouteBasic(Protocol.V4, [
            v4Pool(USDC, WETH, 500, 10, ZERO_HOOKS, POOL_ID_V4_1),
            v4Pool(DAI, WETH, 3000, 60, ZERO_HOOKS, POOL_ID_V4_2),
          ]),
          2_000_000n
        ),
      ]),
      TradeType.ExactOut,
      1_000_000n,
      tokenCI(USDC),
      tokenCI(DAI),
      ZERO_SLIPPAGE
    );
    const step = steps[0];
    if (step.type !== 'V4_SWAP') throw new Error('expected V4_SWAP');
    const swap = step.v4Actions[0];
    if (swap.action !== 'SWAP_EXACT_OUT')
      throw new Error('expected SWAP_EXACT_OUT');

    // sqrtPriceX96 at tick 0 (satisfies the SDK Pool price/tick invariant).
    const sqrtPriceAtTickZero = (2n ** 96n).toString();
    const liquidity = '1000000000000';
    const usdc = new Token(1, USDC, 6);
    const weth = new Token(1, WETH, 18);
    const dai = new Token(1, DAI, 18);
    const route = new V4SdkRoute(
      [
        new V4SdkPool(
          usdc,
          weth,
          500,
          10,
          ZERO_HOOKS,
          sqrtPriceAtTickZero,
          liquidity,
          0
        ),
        new V4SdkPool(
          dai,
          weth,
          3000,
          60,
          ZERO_HOOKS,
          sqrtPriceAtTickZero,
          liquidity,
          0
        ),
      ],
      usdc,
      dai
    );
    const toComparablePathKey = (k: {
      intermediateCurrency: string;
      fee: number | string;
      tickSpacing: number;
      hooks: string;
      hookData: string;
    }) => ({
      intermediateCurrency: k.intermediateCurrency.toLowerCase(),
      fee: Number(k.fee),
      tickSpacing: k.tickSpacing,
      hooks: k.hooks.toLowerCase(),
      hookData: k.hookData,
    });
    expect(swap.path.map(toComparablePathKey)).toEqual(
      encodeRouteToPath(route, true).map(toComparablePathKey)
    );
  });
});

// === MIXED routes (exact-in only) ============================================

describe('SwapStepsFactory - MIXED', () => {
  it('emits one step per protocol-pure segment, threading tokens (V3 -> V2)', () => {
    // Path: V3 USDC->WETH (fee 500), then V2 WETH->DAI. Two segments.
    // First: V3 step with user-funded amountIn. Second: V2 step with
    // SENTINEL_AMOUNT (consume router-held WETH from prior segment).
    const quote = new QuoteBasic(
      new RouteBasic(Protocol.MIXED, [
        v3Pool(USDC, WETH, 500, POOL_ADDR_1),
        v2Pool(DAI, WETH, POOL_ADDR_2),
      ]),
      999n
    );
    const split = new QuoteSplit([quote]);

    const steps = buildSwapSteps(
      split,
      TradeType.ExactIn,
      1_000_000n,
      tokenCI(USDC),
      tokenCI(DAI),
      ZERO_SLIPPAGE
    );

    // Sentinel = 2^255 as decimal string.
    const SENTINEL = (1n << 255n).toString();

    expect(steps).toEqual([
      {
        type: 'V3_SWAP_EXACT_IN',
        recipient: ROUTER_AS_RECIPIENT,
        amountIn: '1000000',
        amountOutMin: '0',
        path: `0x${USDC.slice(2).toLowerCase()}0001f4${WETH.slice(2).toLowerCase()}`,
      },
      {
        type: 'V2_SWAP_EXACT_IN',
        recipient: ROUTER_AS_RECIPIENT,
        amountIn: SENTINEL,
        amountOutMin: '0',
        path: [WETH, DAI],
      },
    ]);
  });

  it('emits V4 segment with chained sentinels (SETTLE=SENTINEL, SWAP.amountIn=OPEN_DELTA) after V3', () => {
    // Path: V3 USDC->WETH, then V4 WETH->DAI. The V4 segment is chained:
    // SETTLE uses SENTINEL_AMOUNT (consume router-held WETH delta) and the
    // SWAP uses OPEN_DELTA = '0' (V4 sentinel — SENTINEL would overflow
    // V4's int128 amount field).
    const quote = new QuoteBasic(
      new RouteBasic(Protocol.MIXED, [
        v3Pool(USDC, WETH, 500, POOL_ADDR_1),
        v4Pool(DAI, WETH, 3000, 60, ZERO_HOOKS, POOL_ID_V4_2),
      ]),
      999n
    );
    const split = new QuoteSplit([quote]);

    const steps = buildSwapSteps(
      split,
      TradeType.ExactIn,
      1_000_000n,
      tokenCI(USDC),
      tokenCI(DAI),
      ZERO_SLIPPAGE
    );

    const SENTINEL = (1n << 255n).toString();

    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({
      type: 'V3_SWAP_EXACT_IN',
      amountIn: '1000000',
    });
    expect(steps[1]).toMatchObject({
      type: 'V4_SWAP',
      v4Actions: [
        {action: 'SETTLE', currency: WETH, amount: SENTINEL},
        expect.objectContaining({
          action: 'SWAP_EXACT_IN_SINGLE',
          amountIn: '0', // V4_OPEN_DELTA — consume open delta from SETTLE.
        }),
        {
          action: 'TAKE',
          currency: DAI,
          recipient: ROUTER_AS_RECIPIENT,
          amount: '0',
        },
      ],
    });
  });

  it('emits 3 segments for V3 -> V4 -> V2 mixed route', () => {
    // Three protocols in sequence: each becomes its own segment.
    const quote = new QuoteBasic(
      new RouteBasic(Protocol.MIXED, [
        v3Pool(USDC, WETH, 500, POOL_ADDR_1),
        v4Pool(WETH, DAI, 3000, 60, ZERO_HOOKS, POOL_ID_V4_1),
        v2Pool(DAI, USDC, POOL_ADDR_2),
      ]),
      999n
    );
    const split = new QuoteSplit([quote]);

    const steps = buildSwapSteps(
      split,
      TradeType.ExactIn,
      1_000_000n,
      tokenCI(USDC),
      tokenCI(USDC),
      ZERO_SLIPPAGE
    );

    const SENTINEL = (1n << 255n).toString();

    expect(steps).toHaveLength(3);
    expect(steps[0]).toMatchObject({
      type: 'V3_SWAP_EXACT_IN',
      amountIn: '1000000', // user-funded leaf
    });
    expect(steps[1]).toMatchObject({
      type: 'V4_SWAP',
      v4Actions: [
        {action: 'SETTLE', currency: WETH, amount: SENTINEL},
        expect.objectContaining({action: 'SWAP_EXACT_IN_SINGLE'}),
        expect.objectContaining({action: 'TAKE', currency: DAI}),
      ],
    });
    expect(steps[2]).toMatchObject({
      type: 'V2_SWAP_EXACT_IN',
      amountIn: SENTINEL,
      path: [DAI, USDC],
    });
  });

  it('groups consecutive same-protocol hops into a single segment (V3 -> V3 -> V2)', () => {
    // Two V3 hops then one V2: 2 segments (one V3 multi-hop, one V2).
    const quote = new QuoteBasic(
      new RouteBasic(Protocol.MIXED, [
        v3Pool(USDC, WETH, 500, POOL_ADDR_1),
        v3Pool(WETH, DAI, 3000, POOL_ADDR_2),
        v2Pool(DAI, USDC, POOL_ADDR_3),
      ]),
      999n
    );
    const split = new QuoteSplit([quote]);

    const steps = buildSwapSteps(
      split,
      TradeType.ExactIn,
      1_000_000n,
      tokenCI(USDC),
      tokenCI(USDC),
      ZERO_SLIPPAGE
    );

    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({
      type: 'V3_SWAP_EXACT_IN',
      amountIn: '1000000',
      path:
        `0x${USDC.slice(2).toLowerCase()}` +
        '0001f4' +
        WETH.slice(2).toLowerCase() +
        '000bb8' +
        DAI.slice(2).toLowerCase(),
    });
    expect(steps[1]).toMatchObject({
      type: 'V2_SWAP_EXACT_IN',
      path: [DAI, USDC],
    });
  });

  it('throws on MIXED routes with EXACT_OUT (not supported by buildTrade)', () => {
    const quote = new QuoteBasic(
      new RouteBasic(Protocol.MIXED, [
        v3Pool(USDC, WETH, 500, POOL_ADDR_1),
        v2Pool(DAI, WETH, POOL_ADDR_2),
      ]),
      2_000_000n
    );
    const split = new QuoteSplit([quote]);

    expect(() =>
      buildSwapSteps(
        split,
        TradeType.ExactOut,
        1_000_000n,
        tokenCI(USDC),
        tokenCI(DAI),
        ZERO_SLIPPAGE
      )
    ).toThrow(/MIXED/);
  });
});

// === Exact-out slippage buffer (regression: V3TooMuchRequested on Base) =======
// The per-leg input maximum (amountInMax / amountInMaximum) and the WRAP_ETH
// amount MUST carry the slippage buffer. The SDK's `encodeSwaps` only pads the
// ingress total (msg.value / PERMIT2 pull) — it encodes each step's cap
// verbatim. So with raw (0%) caps, any adverse price movement makes a leg
// exceed its cap and revert `V3TooMuchRequested()`. The V4 SETTLE carries no
// cap (it settles the open delta from router custody); the swap action's
// amountInMaximum is the V4 slippage guard. EXACT_INPUT is unaffected: its
// slippage lives in the final SWEEP min.
describe('SwapStepsFactory - exact-out slippage buffer', () => {
  // 0.5% => padded = raw * 10050 / 10000
  const SLIPPAGE = new Percent(50, 10_000);

  it('pads V3_SWAP_EXACT_OUT amountInMax by slippage', () => {
    const quote = new QuoteBasic(
      new RouteBasic(Protocol.V3, [v3Pool(USDC, WETH, 500, POOL_ADDR_1)]),
      1_500_000n
    );
    const split = new QuoteSplit([quote]);

    const steps = buildSwapSteps(
      split,
      TradeType.ExactOut,
      1_000_000n,
      tokenCI(USDC),
      tokenCI(WETH),
      SLIPPAGE
    );

    expect(steps).toEqual([
      {
        type: 'V3_SWAP_EXACT_OUT',
        recipient: ROUTER_AS_RECIPIENT,
        amountOut: '1000000',
        // 1_500_000 * 1.005 = 1_507_500 (was raw '1500000' => revert)
        amountInMax: '1507500',
        path: `0x${WETH.slice(2).toLowerCase()}0001f4${USDC.slice(2).toLowerCase()}`,
      },
    ]);
  });

  it('pads WRAP_ETH and amountInMax for native-input exact-out (the Base repro)', () => {
    const quote = new QuoteBasic(
      new RouteBasic(Protocol.V3, [v3Pool(USDC, WETH, 500, POOL_ADDR_1)]),
      1_000_000_000_000_000n // 1e15 wei route-required WETH input
    );
    const split = new QuoteSplit([quote]);

    const steps = buildSwapSteps(
      split,
      TradeType.ExactOut,
      2_000_000n,
      new CurrencyInfo(true, new Address(WETH)),
      tokenCI(USDC),
      SLIPPAGE
    );

    expect(steps).toEqual([
      {
        type: 'WRAP_ETH',
        recipient: ROUTER_AS_RECIPIENT,
        // 1e15 * 1.005 — must wrap the buffered max, not the raw input
        amount: '1005000000000000',
      },
      {
        type: 'V3_SWAP_EXACT_OUT',
        recipient: ROUTER_AS_RECIPIENT,
        amountOut: '2000000',
        amountInMax: '1005000000000000',
        path: `0x${USDC.slice(2).toLowerCase()}0001f4${WETH.slice(2).toLowerCase()}`,
      },
      // Unwrap the buffered over-wrap back to native for the input refund.
      {
        type: 'UNWRAP_WETH',
        recipient: ROUTER_AS_RECIPIENT,
        amountMin: '0',
      },
    ]);
  });

  it('pads V4 SWAP_EXACT_OUT_SINGLE amountInMaximum (SETTLE carries no cap)', () => {
    const quote = new QuoteBasic(
      new RouteBasic(Protocol.V4, [
        v4Pool(USDC, WETH, 500, 10, ZERO_HOOKS, POOL_ID_V4_1),
      ]),
      230_000_000n
    );
    const split = new QuoteSplit([quote]);

    const steps = buildSwapSteps(
      split,
      TradeType.ExactOut,
      1_000_000_000_000_000_000n,
      tokenCI(USDC),
      tokenCI(WETH),
      SLIPPAGE
    );

    expect(steps).toEqual([
      {
        type: 'V4_SWAP',
        v4Actions: [
          {
            action: 'SWAP_EXACT_OUT_SINGLE',
            poolKey: {
              currency0: USDC,
              currency1: WETH,
              fee: 500,
              tickSpacing: 10,
              hooks: ZERO_HOOKS,
            },
            zeroForOne: true,
            amountOut: '1000000000000000000',
            // 230_000_000 * 1.005 = 231_150_000
            amountInMaximum: '231150000',
            hookData: '0x',
          },
          {
            action: 'SETTLE',
            currency: USDC,
            amount: '0',
          },
          {
            action: 'TAKE',
            currency: WETH,
            recipient: ROUTER_AS_RECIPIENT,
            amount: '0',
          },
        ],
      },
    ]);
  });
});
