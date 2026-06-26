import {Pool} from '../../models/pool/Pool';
import {QuoteSplit, allocateAmounts} from '../../models/quote/QuoteSplit';
import {QuoteBasic} from '../../models/quote/QuoteBasic';
import {Protocol} from '../../models/pool/Protocol';
import {V2Pool} from '../../models/pool/V2Pool';
import {V3Pool} from '../../models/pool/V3Pool';
import {V4Pool} from '../../models/pool/V4Pool';
import {Address} from '../../models/address/Address';
import {TradeType} from '../../models/quote/TradeType';
import {CurrencyInfo} from '../../models/currency/CurrencyInfo';
import {
  isAtLeastV2_1_1,
  PathKey,
  PoolKey,
  ROUTER_AS_RECIPIENT,
  SwapStep,
  UniversalRouterVersion,
  V4Action,
} from '@uniswap/universal-router-sdk';

const NATIVE_ADDRESS = '0x0000000000000000000000000000000000000000';

// CONTRACT_BALANCE sentinel (2**255): consume the router's full balance of the
// currency. Used for V2/V3 chained amountIn and V4 chained SETTLE.amount.
const SENTINEL_AMOUNT = (1n << 255n).toString();

// V4 open-delta sentinel: amountIn=0 consumes the open delta. V4's int128
// amount field can't hold 2**255, so chained V4 swaps use this instead.
const V4_OPEN_DELTA = '0';

const PRICE_PRECISION = 10n ** 36n;

// 0-slippage per-hop price (amountOut * 1e36 / amountIn) for a single-hop quote.
// Trading applies the per-pair slippage at encode. Multi-hop has no intermediate
// amounts, so it opts out (matches the legacy flow). Returns undefined for
// degenerate amounts (treated as a per-hop opt-out).
function singleHopMinHopPriceX36(
  tradeType: TradeType,
  allocatedAmount: bigint,
  quoteAmount: bigint
): string | undefined {
  const amountIn =
    tradeType === TradeType.ExactIn ? allocatedAmount : quoteAmount;
  const amountOut =
    tradeType === TradeType.ExactIn ? quoteAmount : allocatedAmount;
  if (amountIn <= 0n || amountOut <= 0n) {
    return undefined;
  }
  return ((amountOut * PRICE_PRECISION) / amountIn).toString();
}

// Attaches a computed minHopPriceX36 to a single-hop quote's swap action:
// scalar for V4 *_SINGLE actions, single-element array for V2/V3 (matches the
// SDK SwapStep shape).
function attachMinHopPriceX36(
  steps: SwapStep[],
  minHopPriceX36: string
): SwapStep[] {
  return steps.map(step => {
    if (step.type === 'V4_SWAP') {
      return {
        ...step,
        v4Actions: step.v4Actions.map(action =>
          action.action === 'SWAP_EXACT_IN_SINGLE' ||
          action.action === 'SWAP_EXACT_OUT_SINGLE'
            ? {...action, minHopPriceX36}
            : action
        ),
      };
    }
    if (
      step.type === 'V2_SWAP_EXACT_IN' ||
      step.type === 'V2_SWAP_EXACT_OUT' ||
      step.type === 'V3_SWAP_EXACT_IN' ||
      step.type === 'V3_SWAP_EXACT_OUT'
    ) {
      return {...step, minHopPriceX36: [minHopPriceX36]};
    }
    return step;
  });
}

/**
 * Builds the route-local `SwapStep[]` representation of a `QuoteSplit` for
 * `SwapRouter.encodeSwaps`. Pure function, no fee math; recipients are
 * `ROUTER_AS_RECIPIENT` and Trading owns the `SwapSpecification` half of the
 * contract.
 *
 * Slippage-free: the steps carry raw amounts (EXACT_IN per-leg mins are `0`;
 * EXACT_OUT per-leg caps + WRAP_ETH are the unpadded routed input;
 * minHopPriceX36 is the 0-slippage price). Trading owns all slippage
 * application at encode (per-hop price, exact-out caps, and WRAP_ETH).
 */
export function buildSwapSteps(
  quoteSplit: QuoteSplit,
  tradeType: TradeType,
  amount: bigint,
  tokenInCurrencyInfo: CurrencyInfo,
  tokenOutCurrencyInfo: CurrencyInfo,
  universalRouterVersion: UniversalRouterVersion | undefined
): SwapStep[] {
  const allocatedAmounts = allocateAmounts(quoteSplit, amount);
  // UR >= 2.1.1: single-hop quotes carry minHopPriceX36 computed at 0 slippage;
  // Trading applies the per-pair haircut at encode. Multi-hop opts out: only
  // leg-level amounts are known (allocateAmounts + quote.amount), never true
  // per-hop amounts, so each hop can't be priced. This matches legacy, whose
  // per-hop guard also opts out — uniroute's routing-api response only paints
  // the route's boundary amounts (first pool in, last pool out) and leaves
  // intermediate hops undefined. Multi-hop relies on the trade-level output min.
  const includeMinHopPrice = isAtLeastV2_1_1(universalRouterVersion);
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

    // Raw input units (no slippage): ExactIn uses the allocated input, ExactOut
    // the routed input (`quote.amount`). Trading pads exact-out caps + WRAP_ETH.
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

    const quoteSteps = buildStepsForQuote(
      quote,
      tradeType,
      allocatedAmount,
      inferredTokenIn,
      routeInputAmount
    );
    const minHopPriceX36 =
      includeMinHopPrice && quote.route.path.length === 1
        ? singleHopMinHopPriceX36(tradeType, allocatedAmount, quote.amount)
        : undefined;
    innerSteps.push(
      ...(minHopPriceX36
        ? attachMinHopPriceX36(quoteSteps, minHopPriceX36)
        : quoteSteps)
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

  const outputIsWrappedNative =
    !tokenOutCurrencyInfo.isNative &&
    addressEq(
      tokenOutCurrencyInfo.wrappedAddress.address,
      tokenInCurrencyInfo.wrappedAddress.address
    );
  // Exact-out over-wraps native input to the padded max; unwrap the leftover so
  // the input-refund SWEEP (native) recovers it. Skip when the output is WETH —
  // it shares the leftover's currency and its own SWEEP already returns it.
  const recoversWrappedInputLeftover =
    tradeType === TradeType.ExactOut &&
    wrapEthAmount > 0n &&
    !outputIsWrappedNative;
  if (needsUnwrapWeth || recoversWrappedInputLeftover) {
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
  routeTokenIn: string,
  // Slippage-padded per-leg cap; unused for ExactIn.
  amountInMax: bigint
): SwapStep[] {
  if (tradeType === TradeType.ExactIn) {
    return buildExactInSteps(quote, allocatedAmount, routeTokenIn);
  }
  return buildExactOutSteps(quote, allocatedAmount, routeTokenIn, amountInMax);
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
  routeTokenIn: string,
  amountInMax: bigint
): SwapStep[] {
  if (quote.route.protocol === Protocol.MIXED) {
    throw new Error(
      'SwapStepsFactory: MIXED routes do not support EXACT_OUT (rejected upstream by buildTrade)'
    );
  }
  // `allocatedAmountOut` is the user's desired output share for this quote.
  switch (quote.route.protocol) {
    case Protocol.V2:
      return [
        buildV2ExactOutStep(
          quote.route.path as V2Pool[],
          allocatedAmountOut,
          amountInMax,
          routeTokenIn
        ),
      ];
    case Protocol.V3:
      return [
        buildV3ExactOutStep(
          quote.route.path as V3Pool[],
          allocatedAmountOut,
          amountInMax,
          routeTokenIn
        ),
      ];
    case Protocol.V4:
      return [
        buildV4ExactOutStep(
          quote.route.path as V4Pool[],
          allocatedAmountOut,
          amountInMax,
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
 * with a `PathKey[]`. `hookData` is `'0x'` (canonical empty bytes).
 */
function buildV4ExactInStep(
  pools: V4Pool[],
  amountIn: bigint,
  tokenIn: string
): SwapStep {
  const hops = walkRoutePath(pools, tokenIn);
  const outputCurrency = hops[hops.length - 1].tokenOut;
  const singlePoolKey =
    pools.length === 1 ? poolKeyFromV4(pools[0]) : undefined;

  const swapAction: V4Action = singlePoolKey
    ? {
        action: 'SWAP_EXACT_IN_SINGLE',
        poolKey: singlePoolKey,
        // zeroForOne is true when swapping currency0 -> currency1; derive
        // it from the canonical key, not the pool object (see poolKeyFromV4).
        zeroForOne: addressEq(singlePoolKey.currency0, tokenIn),
        amountIn: amountIn.toString(),
        amountOutMinimum: '0',
        hookData: '0x',
      }
    : {
        action: 'SWAP_EXACT_IN',
        currencyIn: tokenIn,
        path: v4PathKeys(hops, false),
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
 * V4 exact-out reverses the exact-in layout: SWAP first (the input amount isn't
 * known until it runs), then SETTLE (input) and TAKE (output) from router
 * custody via the OPEN_DELTA sentinel.
 */
function buildV4ExactOutStep(
  pools: V4Pool[],
  amountOut: bigint,
  amountInMax: bigint,
  tokenIn: string
): SwapStep {
  const hops = walkRoutePath(pools, tokenIn);
  const outputCurrency = hops[hops.length - 1].tokenOut;
  const singlePoolKey =
    pools.length === 1 ? poolKeyFromV4(pools[0]) : undefined;

  const swapAction: V4Action = singlePoolKey
    ? {
        action: 'SWAP_EXACT_OUT_SINGLE',
        poolKey: singlePoolKey,
        // zeroForOne derived from the canonical key (see poolKeyFromV4).
        zeroForOne: addressEq(singlePoolKey.currency0, tokenIn),
        amountOut: amountOut.toString(),
        amountInMaximum: amountInMax.toString(),
        hookData: '0x',
      }
    : {
        action: 'SWAP_EXACT_OUT',
        currencyOut: outputCurrency,
        path: v4PathKeys(hops, true),
        amountOut: amountOut.toString(),
        amountInMaximum: amountInMax.toString(),
      };

  return {
    type: 'V4_SWAP',
    v4Actions: [
      swapAction,
      {action: 'SETTLE', currency: tokenIn, amount: V4_OPEN_DELTA},
      {
        action: 'TAKE',
        currency: outputCurrency,
        recipient: ROUTER_AS_RECIPIENT,
        amount: V4_OPEN_DELTA,
      },
    ],
  };
}

/**
 * On-chain PoolKeys require canonical ordering (currency0 < currency1) — a
 * key with flipped currencies hashes to a nonexistent pool and the swap
 * reverts with `PoolNotInitialized()`. `V4Pool.token0/token1` don't
 * reliably honor that invariant (the on-chain discoverer constructs pools
 * in tokenIn/tokenOut request order; subgraph discovery is sorted), so
 * sort here rather than trusting the source. Mirrors
 * `V4Pool.computePoolId`, which already sorts for the same reason.
 */
function poolKeyFromV4(pool: V4Pool): PoolKey {
  const [currency0, currency1] = Address.sorted([pool.token0, pool.token1]);
  return {
    currency0: currency0.address,
    currency1: currency1.address,
    fee: pool.fee,
    tickSpacing: pool.tickSpacing,
    hooks: pool.hooks,
  };
}

/**
 * V4 multi-hop PathKey[], matching v4-sdk encodeRouteToPath: exact-in keys each
 * hop on its tokenOut (forward); exact-out keys on tokenIn (the SDK's
 * reverse-pools-then-reverse-pathKeys nets to this — the router walks an
 * exact-out path in reverse internally). Pinned to the SDK by an oracle test.
 */
function v4PathKeys(hops: Hop<V4Pool>[], exactOutput: boolean): PathKey[] {
  return hops.map(h => ({
    intermediateCurrency: exactOutput ? h.tokenIn : h.tokenOut,
    fee: h.pool.fee,
    tickSpacing: h.pool.tickSpacing,
    hooks: h.pool.hooks,
    hookData: '0x',
  }));
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
  // A V4 pool may hold native directly — incl. native/WETH wrap-hook pools that
  // hold both, so check native before wrapped. Mirrors v4-sdk getPathCurrency.
  if (poolContains(pool, NATIVE_ADDRESS)) {
    return NATIVE_ADDRESS;
  }
  if (poolContains(pool, ci.wrappedAddress.address)) {
    return ci.wrappedAddress.address;
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
