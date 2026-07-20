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
import {JsonRpcProvider} from '@ethersproject/providers';
import {Context} from '@uniswap/lib-uni/context';

import {RouteBasic} from '../../models/route/RouteBasic';
import {QuoteBasic} from '../../models/quote/QuoteBasic';
import {Pool} from '../../models/pool/Pool';
import {V4Pool} from '../../models/pool/V4Pool';
import {TradeType} from '../../models/quote/TradeType';
import {Chain} from '../../models/chain/Chain';
import {CurrencyInfo} from '../../models/currency/CurrencyInfo';
import {buildMetricKey, ChainId} from '../../lib/config';
import {isTempoAggHook} from '../../lib/helpers';
import {AGG_HOOK_QUOTE_ABI} from '../../../abis/AggHookQuoteABI';

/**
 * Returns true if the route is a single-hop through a Tempo aggregator hook pool.
 */
export function isSingleHopTempoAggHookRoute(route: RouteBasic<Pool>): boolean {
  if (route.path.length !== 1) return false;
  const pool = route.path[0];
  return pool !== undefined && isTempoAggHook(pool);
}

/**
 * Partition routes into agg-hook single-hop routes and everything else.
 *
 * // TODO(ROUTE-1082): multi-hop routes where one leg is an agg hook pool
 * // currently fall through to otherRoutes and will fail in the V4Quoter.
 * // Phase 2 should detect these and compose hook.quote() with V4Quoter
 * // calls serially.
 */
export function partitionAggHookRoutes(routes: RouteBasic<Pool>[]): {
  aggHookRoutes: RouteBasic<Pool>[];
  otherRoutes: RouteBasic<Pool>[];
} {
  const aggHookRoutes: RouteBasic<Pool>[] = [];
  const otherRoutes: RouteBasic<Pool>[] = [];

  for (const route of routes) {
    if (isSingleHopTempoAggHookRoute(route)) {
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
 * IMPORTANT: This method only supports single-hop routes (exactly one pool per route).
 * The swap direction (zeroForOne) is inferred from tokenIn and the pool's token0/token1.
 * Multi-hop routes are not supported and will produce incorrect results.
 *
 * @param chain       - The chain to query
 * @param routes      - Single-hop agg hook routes (pre-filtered via partitionAggHookRoutes)
 * @param amount      - Total swap amount in raw token units
 * @param tradeType   - ExactIn or ExactOut
 * @param tokenIn     - Input token currency info
 * @param rpcProviderMap - Map of chainId to ethers providers
 * @param ctx            - Logging/metrics context
 * @param metricTags     - Tags for metrics emission
 * @returns QuoteBasic[] with amounts from hook.quote()
 */
export type HookContractFactory = (
  hookAddress: string,
  provider: JsonRpcProvider
) => ethers.Contract;

const defaultContractFactory: HookContractFactory = (hookAddress, provider) =>
  new ethers.Contract(hookAddress, AGG_HOOK_QUOTE_ABI, provider);

export async function fetchAggHookQuotes(
  chain: Chain,
  routes: RouteBasic<Pool>[],
  amount: bigint,
  tradeType: TradeType,
  tokenIn: CurrencyInfo,
  rpcProviderMap: Map<ChainId, JsonRpcProvider>,
  ctx: Context,
  metricTags: string[],
  contractFactory: HookContractFactory = defaultContractFactory
): Promise<QuoteBasic[]> {
  const provider = rpcProviderMap.get(chain.chainId as ChainId);
  if (!provider) {
    ctx.logger.warn(
      `AggHookQuoter: no provider for chainId ${chain.chainId}, skipping ${routes.length} agg hook routes`
    );
    return [];
  }
  const resolvedProvider: JsonRpcProvider = provider;

  const startTime = Date.now();

  // Cache contract instances per hook address to avoid redundant construction
  // (many routes share the same hook — they're just different % allocations).
  const hookContracts = new Map<string, ethers.Contract>();
  function getHookContract(hookAddress: string): ethers.Contract {
    let contract = hookContracts.get(hookAddress);
    if (!contract) {
      contract = contractFactory(hookAddress, resolvedProvider);
      hookContracts.set(hookAddress, contract);
    }
    return contract;
  }

  try {
    void Promise.resolve(
      ctx.metrics.count(
        buildMetricKey('AggHookQuoter.RouteQuoteCalls'),
        routes.length,
        {tags: [`chain:${ChainId[chain.chainId as ChainId]}`]}
      )
    ).catch(() => {});
  } catch {
    // Instrumentation must not affect quote execution.
  }

  const results = await Promise.allSettled(
    routes.map(async route => {
      const pool = route.path[0] as V4Pool;
      const hookContract = getHookContract(pool.hooks);
      const poolId = pool.poolId;

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

      const amountUnspecified: ethers.BigNumber =
        await hookContract.callStatic.quote(
          zeroForOne,
          amountSpecified,
          poolId
        );

      return new QuoteBasic(
        route,
        amountUnspecified.toBigInt(),
        undefined, // no v3QuoterResponseDetails for hook quotes
        undefined // gas details will be filled in later by the strategy
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
        `AggHookQuoter: hook.quote() failed for pool ${pool.poolId} hook ${pool.hooks}`,
        {error: result.reason}
      );
    }
  }

  const latencyMs = Date.now() - startTime;
  ctx.logger.debug(
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
  await ctx.metrics.dist(
    buildMetricKey('AggHookQuoter.latency.dist'),
    latencyMs,
    {tags: metricTags}
  );

  return quotes;
}
