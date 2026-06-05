import {Pool} from '../../models/pool/Pool';
import {QuoteSplit, allocateAmounts} from '../../models/quote/QuoteSplit';
import {QuoteBasic} from '../../models/quote/QuoteBasic';
import {Protocol} from '../../models/pool/Protocol';
import {V2Pool} from '../../models/pool/V2Pool';
import {V3Pool} from '../../models/pool/V3Pool';
import {V4Pool} from '../../models/pool/V4Pool';
import {TradeType} from '../../models/quote/TradeType';
import {CurrencyInfo} from '../../models/currency/CurrencyInfo';
import {
  PathKey,
  PoolKey,
  ROUTER_AS_RECIPIENT,
  SwapStep,
  V4Action,
} from '@uniswap/universal-router-sdk';

const NATIVE_ADDRESS = '0x0000000000000000000000000000000000000000';

// CONTRACT_BALANCE sentinel (2**255): consume the router's full balance of the
// currency. Used for V2/V3 chained amountIn and V4 chained SETTLE.amount.
const SENTINEL_AMOUNT = (1n << 255n).toString();

// V4 open-delta sentinel: amountIn=0 consumes the open delta. V4's int128
// amount field can't hold 2**255, so chained V4 swaps use this instead.
const V4_OPEN_DELTA = '0';

/**
 * Builds the route-local `SwapStep[]` representation of a `QuoteSplit` for
 * `SwapRouter.encodeSwaps`. Pure function — no fee math, no slippage; all
 * recipients are `ROUTER_AS_RECIPIENT` and Trading owns the
 * `SwapSpecification` half of the contract.
 *
 * For EXACT_IN, `amount` is the user-funded input amount, divided proportionally
 * across `quoteSplit.quotes` by `route.percentage`. For EXACT_OUT, `amount` is
 * the user's desired output, and each quote's `quote.amount` carries the
 * routed input required to produce that output.
 */
export function buildSwapSteps(
  quoteSplit: QuoteSplit,
  tradeType: TradeType,
  amount: bigint,
  tokenInCurrencyInfo: CurrencyInfo,
  tokenOutCurrencyInfo: CurrencyInfo
): SwapStep[] {
  const allocatedAmounts = allocateAmounts(quoteSplit, amount);
  const innerSteps: SwapStep[] = [];

  // Per-quote, the actual tokenIn/tokenOut used for routing may differ from
  // the user's currency. For native input, V2/V3 pools route through WETH
  // (`wrappedAddress`) and need a leading WRAP_ETH; V4 pools may route
  // through native (`0x0`) directly with no wrap. We sum allocations (in
  // input units) for wrapped-input quotes to compute the WRAP_ETH amount.
  let wrapEthAmount = 0n;
  let needsUnwrapWeth = false;

  for (let i = 0; i < quoteSplit.quotes.length; i++) {
    const quote = quoteSplit.quotes[i];
    const allocatedAmount = allocatedAmounts[i];
    const inferredTokenIn = inferRouteTokenAddress(
      quote.route.path[0],
      tokenInCurrencyInfo
    );
    const inferredTokenOut = inferRouteTokenAddress(
      quote.route.path[quote.route.path.length - 1],
      tokenOutCurrencyInfo
    );

    // Wrap accounting works on the *input* amount: for ExactIn the
    // allocated amount is already input; for ExactOut the route's input is
    // `quote.amount`.
    const routeInputAmount =
      tradeType === TradeType.ExactIn ? allocatedAmount : quote.amount;

    if (
      tokenInCurrencyInfo.isNative &&
      addressEq(inferredTokenIn, tokenInCurrencyInfo.wrappedAddress.address)
    ) {
      wrapEthAmount += routeInputAmount;
    }
    if (
      tokenOutCurrencyInfo.isNative &&
      addressEq(inferredTokenOut, tokenOutCurrencyInfo.wrappedAddress.address)
    ) {
      needsUnwrapWeth = true;
    }

    innerSteps.push(
      ...buildStepsForQuote(quote, tradeType, allocatedAmount, inferredTokenIn)
    );
  }

  const steps: SwapStep[] = [];
  if (wrapEthAmount > 0n) {
    steps.push({
      type: 'WRAP_ETH',
      recipient: ROUTER_AS_RECIPIENT,
      amount: wrapEthAmount.toString(),
    });
  }
  steps.push(...innerSteps);
  if (needsUnwrapWeth) {
    steps.push({
      type: 'UNWRAP_WETH',
      recipient: ROUTER_AS_RECIPIENT,
      amountMin: '0',
    });
  }
  return steps;
}

// === Per-quote dispatch ======================================================

function buildStepsForQuote(
  quote: QuoteBasic,
  tradeType: TradeType,
  allocatedAmount: bigint,
  routeTokenIn: string
): SwapStep[] {
  if (tradeType === TradeType.ExactIn) {
    return buildExactInSteps(quote, allocatedAmount, routeTokenIn);
  }
  return buildExactOutSteps(quote, allocatedAmount, routeTokenIn);
}

function buildExactInSteps(
  quote: QuoteBasic,
  allocatedAmountIn: bigint,
  routeTokenIn: string
): SwapStep[] {
  switch (quote.route.protocol) {
    case Protocol.V2:
      return [
        buildV2ExactInStep(
          quote.route.path as V2Pool[],
          allocatedAmountIn,
          routeTokenIn
        ),
      ];
    case Protocol.V3:
      return [
        buildV3ExactInStep(
          quote.route.path as V3Pool[],
          allocatedAmountIn,
          routeTokenIn
        ),
      ];
    case Protocol.V4:
      return [
        buildV4ExactInStep(
          quote.route.path as V4Pool[],
          allocatedAmountIn,
          routeTokenIn
        ),
      ];
    case Protocol.MIXED:
      return buildMixedExactInSteps(quote, allocatedAmountIn, routeTokenIn);
    default:
      throw new Error(
        `SwapStepsFactory: unsupported protocol '${quote.route.protocol}' for EXACT_IN`
      );
  }
}

function buildExactOutSteps(
  quote: QuoteBasic,
  allocatedAmountOut: bigint,
  routeTokenIn: string
): SwapStep[] {
  if (quote.route.protocol === Protocol.MIXED) {
    throw new Error(
      'SwapStepsFactory: MIXED routes do not support EXACT_OUT (rejected upstream by buildTrade)'
    );
  }
  // For ExactOut, `quote.amount` is the route-required input amount (from
  // the reverse routing math); `allocatedAmountOut` is the user's desired
  // output share for this quote.
  const routeInputAmount = quote.amount;
  switch (quote.route.protocol) {
    case Protocol.V2:
      return [
        buildV2ExactOutStep(
          quote.route.path as V2Pool[],
          allocatedAmountOut,
          routeInputAmount,
          routeTokenIn
        ),
      ];
    case Protocol.V3:
      return [
        buildV3ExactOutStep(
          quote.route.path as V3Pool[],
          allocatedAmountOut,
          routeInputAmount,
          routeTokenIn
        ),
      ];
    case Protocol.V4:
      return [
        buildV4ExactOutStep(
          quote.route.path as V4Pool[],
          allocatedAmountOut,
          routeInputAmount,
          routeTokenIn
        ),
      ];
    default:
      throw new Error(
        `SwapStepsFactory: unsupported protocol '${quote.route.protocol}' for EXACT_OUT`
      );
  }
}

// === Path-walking shared helper ==============================================

type Hop<TPool extends Pool> = {
  pool: TPool;
  tokenIn: string;
  tokenOut: string;
};

/**
 * Threads the input token through pools in path order, producing one hop per
 * pool with `tokenIn` and `tokenOut` resolved against each pool's token pair.
 * Throws if any pool doesn't contain the threaded input token (would
 * indicate a malformed route).
 */
function walkRoutePath<TPool extends Pool>(
  pools: TPool[],
  initialTokenIn: string
): Hop<TPool>[] {
  const hops: Hop<TPool>[] = [];
  let current = initialTokenIn;
  for (const pool of pools) {
    const tokenOut = otherTokenForPool(
      pool.token0.address,
      pool.token1.address,
      current,
      pool.address.address
    );
    hops.push({pool, tokenIn: current, tokenOut});
    current = tokenOut;
  }
  return hops;
}

// === V2 ======================================================================

function buildV2ExactInStep(
  pools: V2Pool[],
  amountIn: bigint,
  tokenIn: string
): SwapStep {
  const hops = walkRoutePath(pools, tokenIn);
  const path = [tokenIn, ...hops.map(h => h.tokenOut)];
  return {
    type: 'V2_SWAP_EXACT_IN',
    recipient: ROUTER_AS_RECIPIENT,
    amountIn: amountIn.toString(),
    amountOutMin: '0',
    path,
  };
}

// === V3 ======================================================================

/**
 * V3 packed path: `tokenIn | fee(3 bytes) | tokenOut | fee(3 bytes) | ...`.
 * Addresses lowercased, no `0x` separators between fields. Same path format
 * the Universal Router SDK's V3 encoder produces.
 */
function buildV3ExactInStep(
  pools: V3Pool[],
  amountIn: bigint,
  tokenIn: string
): SwapStep {
  const hops = walkRoutePath(pools, tokenIn);
  const path =
    '0x' +
    tokenIn.slice(2).toLowerCase() +
    hops
      .map(h => encodeV3Fee(h.pool.fee) + h.tokenOut.slice(2).toLowerCase())
      .join('');
  return {
    type: 'V3_SWAP_EXACT_IN',
    recipient: ROUTER_AS_RECIPIENT,
    amountIn: amountIn.toString(),
    amountOutMin: '0',
    path,
  };
}

function encodeV3Fee(fee: number): string {
  return fee.toString(16).padStart(6, '0');
}

function buildV2ExactOutStep(
  pools: V2Pool[],
  amountOut: bigint,
  amountInMax: bigint,
  tokenIn: string
): SwapStep {
  const hops = walkRoutePath(pools, tokenIn);
  const path = [tokenIn, ...hops.map(h => h.tokenOut)];
  return {
    type: 'V2_SWAP_EXACT_OUT',
    recipient: ROUTER_AS_RECIPIENT,
    amountOut: amountOut.toString(),
    // Raw route-required input — Trading's `SwapSpecification` owns slippage,
    // so we don't pad at the step level.
    amountInMax: amountInMax.toString(),
    path,
  };
}

/**
 * V3 exact-out packed path is reversed: tokenOut first, then `(fee, tokenIn)`
 * pairs in reverse pool order. Same encoding as
 * `Route.encodeRouteToPath(route, exactOutput=true)` in the V3 SDK.
 */
function buildV3ExactOutStep(
  pools: V3Pool[],
  amountOut: bigint,
  amountInMax: bigint,
  tokenIn: string
): SwapStep {
  const hops = walkRoutePath(pools, tokenIn);
  const tokenOut = hops[hops.length - 1].tokenOut;
  // Reverse hop order; for each hop emit `fee | hop.tokenIn` (which is the
  // upstream token from the reversed perspective).
  const path =
    '0x' +
    tokenOut.slice(2).toLowerCase() +
    [...hops]
      .reverse()
      .map(h => encodeV3Fee(h.pool.fee) + h.tokenIn.slice(2).toLowerCase())
      .join('');
  return {
    type: 'V3_SWAP_EXACT_OUT',
    recipient: ROUTER_AS_RECIPIENT,
    amountOut: amountOut.toString(),
    amountInMax: amountInMax.toString(),
    path,
  };
}

// === V4 ======================================================================

/**
 * V4 segment encoding follows Guidestar's bracket pattern:
 * `[SETTLE(input, amountIn), SWAP_EXACT_IN[_SINGLE](...), TAKE(output, recipient: ROUTER, amount: 0)]`.
 *
 * Single-pool emits `SWAP_EXACT_IN_SINGLE`; multi-hop emits `SWAP_EXACT_IN`
 * with a `PathKey[]`. `hookData` is the empty string (`''`), matching
 * Guidestar's payload — narrow SDK boundary normalizes to `0x` if required.
 */
function buildV4ExactInStep(
  pools: V4Pool[],
  amountIn: bigint,
  tokenIn: string
): SwapStep {
  const hops = walkRoutePath(pools, tokenIn);
  const outputCurrency = hops[hops.length - 1].tokenOut;

  const swapAction: V4Action =
    pools.length === 1
      ? {
          action: 'SWAP_EXACT_IN_SINGLE',
          poolKey: poolKeyFromV4(pools[0]),
          // V4 pools store token0 < token1 (UniRoute's `Address.sorted`
          // convention). zeroForOne is true when swapping currency0 -> currency1.
          zeroForOne: addressEq(pools[0].token0.address, tokenIn),
          amountIn: amountIn.toString(),
          amountOutMinimum: '0',
          hookData: '',
        }
      : {
          action: 'SWAP_EXACT_IN',
          currencyIn: tokenIn,
          path: hops.map(pathKeyFromHop),
          amountIn: amountIn.toString(),
          amountOutMinimum: '0',
        };

  const v4Actions: V4Action[] = [
    {action: 'SETTLE', currency: tokenIn, amount: amountIn.toString()},
    swapAction,
    {
      action: 'TAKE',
      currency: outputCurrency,
      recipient: ROUTER_AS_RECIPIENT,
      amount: '0',
    },
  ];

  return {type: 'V4_SWAP', v4Actions};
}

/**
 * V4 exact-out action layout differs from exact-in: SWAP first, then
 * SETTLE_ALL (input, maxAmount), then TAKE_ALL (output, minAmount). The
 * input amount isn't known until the swap runs, so SETTLE_ALL absorbs
 * whatever the swap consumed (up to `maxAmount`). The SDK accepts either
 * ordering as long as deltas net to zero.
 */
function buildV4ExactOutStep(
  pools: V4Pool[],
  amountOut: bigint,
  amountInMax: bigint,
  tokenIn: string
): SwapStep {
  const hops = walkRoutePath(pools, tokenIn);
  const outputCurrency = hops[hops.length - 1].tokenOut;

  const swapAction: V4Action =
    pools.length === 1
      ? {
          action: 'SWAP_EXACT_OUT_SINGLE',
          poolKey: poolKeyFromV4(pools[0]),
          zeroForOne: addressEq(pools[0].token0.address, tokenIn),
          amountOut: amountOut.toString(),
          amountInMaximum: amountInMax.toString(),
          hookData: '',
        }
      : {
          action: 'SWAP_EXACT_OUT',
          currencyOut: outputCurrency,
          // V4 exact-out PathKey[] is reversed: starts at the output side
          // and walks back toward input. Each entry's `intermediateCurrency`
          // is the upstream token from the reversed perspective.
          path: [...hops].reverse().map(h => ({
            intermediateCurrency: h.tokenIn,
            fee: h.pool.fee,
            tickSpacing: h.pool.tickSpacing,
            hooks: h.pool.hooks,
            hookData: '',
          })),
          amountOut: amountOut.toString(),
          amountInMaximum: amountInMax.toString(),
        };

  return {
    type: 'V4_SWAP',
    v4Actions: [
      swapAction,
      {
        action: 'SETTLE_ALL',
        currency: tokenIn,
        maxAmount: amountInMax.toString(),
      },
      {
        action: 'TAKE_ALL',
        currency: outputCurrency,
        minAmount: amountOut.toString(),
      },
    ],
  };
}

function poolKeyFromV4(pool: V4Pool): PoolKey {
  return {
    currency0: pool.token0.address,
    currency1: pool.token1.address,
    fee: pool.fee,
    tickSpacing: pool.tickSpacing,
    hooks: pool.hooks,
  };
}

function pathKeyFromHop(hop: Hop<V4Pool>): PathKey {
  return {
    intermediateCurrency: hop.tokenOut,
    fee: hop.pool.fee,
    tickSpacing: hop.pool.tickSpacing,
    hooks: hop.pool.hooks,
    hookData: '',
  };
}

// === Address helpers =========================================================

/**
 * Resolves the address a route uses for a given user currency, based on the
 * pool's contained tokens. Non-native currencies always use `wrappedAddress`.
 * For native currencies, V2/V3 pools route through wrapped (WETH); V4 pools
 * may route through native (`0x0`) directly.
 */
function inferRouteTokenAddress(pool: Pool, ci: CurrencyInfo): string {
  if (!ci.isNative) {
    return ci.wrappedAddress.address;
  }
  const wrapped = ci.wrappedAddress.address;
  if (poolContains(pool, wrapped)) {
    return wrapped;
  }
  return NATIVE_ADDRESS;
}

function poolContains(pool: Pool, address: string): boolean {
  return (
    addressEq(pool.token0.address, address) ||
    addressEq(pool.token1.address, address)
  );
}

function otherTokenForPool(
  token0: string,
  token1: string,
  inputToken: string,
  poolAddress: string
): string {
  if (addressEq(token0, inputToken)) return token1;
  if (addressEq(token1, inputToken)) return token0;
  throw new Error(
    `Pool ${poolAddress} does not contain expected input token ${inputToken}`
  );
}

function addressEq(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

// === MIXED routes (exact-in only) ============================================

/**
 * Splits a MIXED route's `path` into protocol-pure segments (consecutive
 * same-protocol pools), then emits one step per segment. The first segment
 * is funded by the user's allocated `amountIn`; subsequent segments are
 * "chained" — they consume whatever currency delta the prior segment left
 * in the router's custody.
 *
 * Chained-segment amount conventions (matching Guidestar's payload):
 * - V2/V3 `amountIn`: `SENTINEL_AMOUNT` (Universal Router's
 *   `CONTRACT_BALANCE = 2**255` — "swap the router's full token balance")
 * - V4 `SETTLE.amount`: `SENTINEL_AMOUNT` (Guidestar uses the same
 *   sentinel here; the V4 router treats it as "use open delta")
 * - V4 `SWAP.amountIn`: `OPEN_DELTA = 0` (V4-specific sentinel; SENTINEL
 *   would overflow `int128`)
 */
function buildMixedExactInSteps(
  quote: QuoteBasic,
  allocatedAmountIn: bigint,
  routeTokenIn: string
): SwapStep[] {
  const segments = segmentByProtocol(quote.route.path);
  let currentTokenIn = routeTokenIn;
  return segments.map((segment, i) => {
    const isLeaf = i === 0;
    const step = buildSegmentStep(
      segment.protocol,
      segment.pools,
      isLeaf ? allocatedAmountIn.toString() : null,
      currentTokenIn
    );
    // Thread tokenOut to the next segment's tokenIn.
    const segmentHops = walkRoutePath(segment.pools, currentTokenIn);
    currentTokenIn = segmentHops[segmentHops.length - 1].tokenOut;
    return step;
  });
}

type Segment = {
  protocol: Protocol;
  pools: Pool[];
};

function segmentByProtocol(path: Pool[]): Segment[] {
  if (path.length === 0) {
    return [];
  }
  const segments: Segment[] = [];
  let current: Segment = {protocol: path[0].protocol, pools: [path[0]]};
  for (let i = 1; i < path.length; i++) {
    if (path[i].protocol === current.protocol) {
      current.pools.push(path[i]);
    } else {
      segments.push(current);
      current = {protocol: path[i].protocol, pools: [path[i]]};
    }
  }
  segments.push(current);
  return segments;
}

/**
 * Builds an exact-in step for a single protocol-pure segment of a MIXED
 * route. `leafAmountInStr` is non-null for the first segment (user-funded);
 * null for chained segments (which emit per-protocol sentinels).
 */
function buildSegmentStep(
  protocol: Protocol,
  pools: Pool[],
  leafAmountInStr: string | null,
  tokenIn: string
): SwapStep {
  const placeholder = (() => {
    switch (protocol) {
      case Protocol.V2:
        return buildV2ExactInStep(pools as V2Pool[], 0n, tokenIn);
      case Protocol.V3:
        return buildV3ExactInStep(pools as V3Pool[], 0n, tokenIn);
      case Protocol.V4:
        return buildV4ExactInStep(pools as V4Pool[], 0n, tokenIn);
      default:
        throw new Error(
          `SwapStepsFactory: unsupported protocol '${protocol}' inside MIXED route`
        );
    }
  })();
  return leafAmountInStr !== null
    ? withLeafAmount(placeholder, leafAmountInStr)
    : withChainedAmounts(placeholder);
}

/**
 * Sets amount fields on a leaf segment (user-funded). V2/V3 `amountIn`,
 * V4 `SETTLE.amount`, and V4 `SWAP.amountIn` all get the exact amount.
 */
function withLeafAmount(step: SwapStep, amountInStr: string): SwapStep {
  switch (step.type) {
    case 'V2_SWAP_EXACT_IN':
    case 'V3_SWAP_EXACT_IN':
      return {...step, amountIn: amountInStr};
    case 'V4_SWAP':
      return {
        ...step,
        v4Actions: step.v4Actions.map((a): V4Action => {
          if (a.action === 'SETTLE') return {...a, amount: amountInStr};
          if (
            a.action === 'SWAP_EXACT_IN' ||
            a.action === 'SWAP_EXACT_IN_SINGLE'
          ) {
            return {...a, amountIn: amountInStr};
          }
          return a;
        }),
      };
    default:
      throw new Error(
        `SwapStepsFactory: cannot set leaf amount on step type '${step.type}'`
      );
  }
}

/**
 * Sets amount fields on a chained segment (downstream of a prior segment).
 * V2/V3 `amountIn` uses `SENTINEL_AMOUNT` (Universal Router's
 * `CONTRACT_BALANCE`). V4 `SETTLE.amount` uses `SENTINEL_AMOUNT` (matches
 * Guidestar). V4 `SWAP.amountIn` uses `V4_OPEN_DELTA = '0'`.
 */
function withChainedAmounts(step: SwapStep): SwapStep {
  switch (step.type) {
    case 'V2_SWAP_EXACT_IN':
    case 'V3_SWAP_EXACT_IN':
      return {...step, amountIn: SENTINEL_AMOUNT};
    case 'V4_SWAP':
      return {
        ...step,
        v4Actions: step.v4Actions.map((a): V4Action => {
          if (a.action === 'SETTLE') {
            return {...a, amount: SENTINEL_AMOUNT};
          }
          if (
            a.action === 'SWAP_EXACT_IN' ||
            a.action === 'SWAP_EXACT_IN_SINGLE'
          ) {
            return {...a, amountIn: V4_OPEN_DELTA};
          }
          return a;
        }),
      };
    default:
      throw new Error(
        `SwapStepsFactory: cannot set chained amount on step type '${step.type}'`
      );
  }
}
