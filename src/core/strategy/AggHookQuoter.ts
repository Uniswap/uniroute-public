/**
 * AggHookQuoter — calls `quote()` on aggregator hook contracts directly.
 *
 * The V4Quoter simulates swaps via poolManager.swap(), which requires the
 * PoolManager to hold sufficient token balances. Aggregator hooks source
 * liquidity externally (e.g. Tempo DEX), so the PoolManager balance is near
 * zero and the V4Quoter reverts. This module calls the hook's own quote()
 * function instead, which queries the external liquidity source directly.
 *
 * Phase 1: single-hop routes only.
 */

import {ethers} from 'ethers';
import {Context} from '@uniswap/lib-uni/context';

import {RouteBasic} from '../../models/route/RouteBasic';
import {QuoteBasic} from '../../models/quote/QuoteBasic';
import {Pool} from '../../models/pool/Pool';
import {V4Pool} from '../../models/pool/V4Pool';
import {TradeType} from '../../models/quote/TradeType';
import {Chain} from '../../models/chain/Chain';
import {CurrencyInfo} from '../../models/currency/CurrencyInfo';
import {buildMetricKey} from '../../lib/config';
import {withTimeout} from '../../lib/poolCaching/util/withTimeout';

import {
  AGG_HOOKS_ON_MAINNET,
  FLUID_DEX_1,
  FLUID_DEX_LITE,
  STABLE_SWAP,
  STABLE_SWAP_NG,
} from '../../lib/poolCaching/util/aggHooksAddressesAllowlist';
import {UNISWAP_AGG_HOOK_ON_TEMPO} from '../../lib/poolCaching/util/hooksAddressesAllowlist';

const AGG_HOOK_QUOTE_ABI = [
  {
    type: 'function',
    name: 'quote',
    inputs: [
      {name: 'zeroToOne', type: 'bool'},
      {name: 'amountSpecified', type: 'int256'},
      {name: 'poolId', type: 'bytes32'},
    ],
    outputs: [{name: 'amountUnspecified', type: 'uint256'}],
    stateMutability: 'payable',
  },
] as const;

/** Timeout for each individual hook.quote() RPC call. */
const HOOK_QUOTE_TIMEOUT_MS = 5_000;

/** All known aggregator hook addresses (lowercased). */
const AGG_HOOK_ADDRESSES = new Set<string>([
  ...AGG_HOOKS_ON_MAINNET,
  ...FLUID_DEX_1,
  ...FLUID_DEX_LITE,
  ...STABLE_SWAP,
  ...STABLE_SWAP_NG,
  UNISWAP_AGG_HOOK_ON_TEMPO,
].map(a => a.toLowerCase()));

/**
 * Returns true if the pool is a V4 pool backed by a known aggregator hook.
 */
export function isAggHookPool(pool: Pool): pool is V4Pool {
  if (!(pool instanceof V4Pool)) return false;
  return AGG_HOOK_ADDRESSES.has(pool.hooks.toLowerCase());
}

/**
 * Returns true if the route is a single-hop through an aggregator hook pool.
 */
export function isSingleHopAggHookRoute(route: RouteBasic<Pool>): boolean {
  if (route.path.length !== 1) return false;
  const pool = route.path[0];
  return pool !== undefined && isAggHookPool(pool);
}

/**
 * Partition routes into agg-hook single-hop routes and everything else.
 *
 * // TODO(Phase 2): multi-hop routes where one leg is an agg hook pool
 * // currently fall through to otherRoutes and will fail in the V4Quoter.
 * // Phase 2 should detect these and compose hook.quote() with V4Quoter
 * // calls serially.
 */
export function partitionAggHookRoutes(
  routes: RouteBasic<Pool>[]
): {
  aggHookRoutes: RouteBasic<Pool>[];
  otherRoutes: RouteBasic<Pool>[];
} {
  const aggHookRoutes: RouteBasic<Pool>[] = [];
  const otherRoutes: RouteBasic<Pool>[] = [];

  for (const route of routes) {
    if (isSingleHopAggHookRoute(route)) {
      aggHookRoutes.push(route);
    } else {
      otherRoutes.push(route);
    }
  }

  return {aggHookRoutes, otherRoutes};
}

/**
 * Fetch quotes for single-hop aggregator hook routes by calling hook.quote() directly.
 *
 * @param chain       - The chain to query
 * @param routes      - Single-hop agg hook routes (pre-filtered)
 * @param amount      - Total swap amount in raw token units
 * @param tradeType   - ExactIn or ExactOut
 * @param tokenIn     - Input token currency info
 * @param tokenOut    - Output token currency info
 * @param provider    - Ethers provider for the target chain
 * @param ctx         - Logging/metrics context
 * @param metricTags  - Tags for metrics emission
 * @returns QuoteBasic[] with amounts from hook.quote()
 */
export async function fetchAggHookQuotes(
  chain: Chain,
  routes: RouteBasic<Pool>[],
  amount: bigint,
  tradeType: TradeType,
  tokenIn: CurrencyInfo,
  tokenOut: CurrencyInfo,
  provider: ethers.providers.BaseProvider,
  ctx: Context,
  metricTags: string[]
): Promise<QuoteBasic[]> {
  const startTime = Date.now();

  // Cache contract instances per hook address to avoid redundant construction
  // (many routes share the same hook — they're just different % allocations).
  const hookContracts = new Map<string, ethers.Contract>();
  function getHookContract(hookAddress: string): ethers.Contract {
    let contract = hookContracts.get(hookAddress);
    if (!contract) {
      contract = new ethers.Contract(hookAddress, AGG_HOOK_QUOTE_ABI, provider);
      hookContracts.set(hookAddress, contract);
    }
    return contract;
  }

  const results = await Promise.allSettled(
    routes.map(async route => {
      const pool = route.path[0] as V4Pool;
      const hookContract = getHookContract(pool.hooks);
      const poolId = pool.id;

      // Determine swap direction: zeroForOne = tokenIn is token0
      const tokenInLower = tokenIn.wrappedAddress.address.toLowerCase();
      const token0Lower = pool.token0.address.toLowerCase();
      const zeroForOne = tokenInLower === token0Lower;

      // Calculate the amount for this route's percentage allocation
      const routeAmount = (amount * BigInt(route.percentage)) / 100n;

      // amountSpecified: negative for exact-in, positive for exact-out
      const amountSpecified =
        tradeType === TradeType.ExactIn
          ? -BigInt(routeAmount)
          : BigInt(routeAmount);

      const amountUnspecified: ethers.BigNumber = await withTimeout(
        hookContract.callStatic.quote(zeroForOne, amountSpecified, poolId),
        HOOK_QUOTE_TIMEOUT_MS,
        `hook.quote ${pool.hooks} pool ${poolId}`
      );

      return new QuoteBasic(
        route,
        amountUnspecified.toBigInt(),
        undefined, // no v3QuoterResponseDetails for hook quotes
        undefined  // gas details will be filled in later by the strategy
      );
    })
  );

  const quotes: QuoteBasic[] = [];
  let failures = 0;

  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;
    if (result.status === 'fulfilled') {
      quotes.push(result.value);
    } else {
      failures++;
      const pool = routes[i]!.path[0] as V4Pool;
      ctx.logger.warn(
        `AggHookQuoter: hook.quote() failed for pool ${pool.id} hook ${pool.hooks}`,
        {error: result.reason}
      );
    }
  }

  const latencyMs = Date.now() - startTime;
  ctx.logger.info(
    `AggHookQuoter: fetched ${quotes.length}/${routes.length} quotes via hook.quote() in ${latencyMs}ms`
  );

  await ctx.metrics.count(
    buildMetricKey('AggHookQuoter.quotes.success'),
    quotes.length,
    {tags: metricTags}
  );
  await ctx.metrics.count(
    buildMetricKey('AggHookQuoter.quotes.failure'),
    failures,
    {tags: metricTags}
  );
  await ctx.metrics.count(
    buildMetricKey('AggHookQuoter.latency'),
    latencyMs,
    {tags: metricTags}
  );

  return quotes;
}
