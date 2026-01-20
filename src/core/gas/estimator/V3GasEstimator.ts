import {ChainId} from '../../../lib/config';
import {GasDetails} from '../../../models/gas/GasDetails';
import {JsonRpcProvider} from '@ethersproject/providers';
import {BigNumber} from '@ethersproject/bignumber';
import {
  BASE_SWAP_COST,
  COST_PER_HOP,
  COST_PER_INIT_TICK,
  COST_PER_UNINIT_TICK,
  SINGLE_HOP_OVERHEAD,
  TOKEN_OVERHEAD,
} from '../gas-costs';
import {WRAPPED_NATIVE_CURRENCY} from '../../../lib/tokenUtils';
import {CurrencyAmount} from '@uniswap/sdk-core';
import {QuoteBasic} from '../../../models/quote/QuoteBasic';
import {BaseGasEstimator} from './BaseGasEstimator';
import {IFreshPoolDetailsWrapper} from '../../../stores/pool/FreshPoolDetailsWrapper';

export class V3GasEstimator extends BaseGasEstimator {
  constructor(
    protected readonly rpcProviderMap: Map<ChainId, JsonRpcProvider>,
    protected readonly freshPoolDetailsWrapper: IFreshPoolDetailsWrapper
  ) {
    super(rpcProviderMap, freshPoolDetailsWrapper);
  }

  public async estimateRouteGas(
    quote: QuoteBasic,
    chainId: ChainId,
    gasPriceWei: number
  ) {
    const totalInitializedTicksCrossed = this.totalInitializedTicksCrossed(
      quote.v3QuoterResponseDetails?.initializedTicksCrossedList || []
    );
    const totalHops = BigNumber.from(quote.route.path.length);

    let hopsGasUse = COST_PER_HOP(chainId).mul(totalHops);

    // We have observed that this algorithm tends to underestimate single hop swaps.
    // We add a buffer in the case of a single hop swap.
    if (totalHops.eq(1)) {
      hopsGasUse = hopsGasUse.add(SINGLE_HOP_OVERHEAD(chainId));
    }

    // Some tokens have extremely expensive transferFrom functions, which causes
    // us to underestimate them by a large amount. For known tokens, we apply an
    // adjustment.
    const tokenOverhead = TOKEN_OVERHEAD(chainId, quote.route);

    const tickGasUse = COST_PER_INIT_TICK(chainId).mul(
      totalInitializedTicksCrossed
    );
    const uninitializedTickGasUse = COST_PER_UNINIT_TICK.mul(0);

    /*
    // Eventually we can just use the quoter gas estimate for the base gas use
    // It will be more accurate than doing the offchain gas estimate like below
    // It will become more critical when we are going to support v4 hookful routing,
    // where we have no idea how much gas the hook(s) will cost.
    // const baseGasUse = routeWithValidQuote.quoterGasEstimate
    */

    // base estimate gas used based on chainId estimates for hops and ticks gas useage
    const baseGasUse = BASE_SWAP_COST(chainId)
      .add(hopsGasUse)
      .add(tokenOverhead)
      .add(tickGasUse)
      .add(uninitializedTickGasUse);

    const baseGasCostWei = BigNumber.from(gasPriceWei).mul(baseGasUse);

    const wrappedCurrency = WRAPPED_NATIVE_CURRENCY[chainId]!;

    const totalGasCostNativeCurrency = CurrencyAmount.fromRawAmount(
      wrappedCurrency,
      baseGasCostWei.toString()
    );

    return new GasDetails(
      BigInt(gasPriceWei),
      BigInt(baseGasCostWei.toString()),
      Number(totalGasCostNativeCurrency.toExact()),
      BigInt(baseGasUse.toString())
    );
  }

  protected totalInitializedTicksCrossed(
    initializedTicksCrossedList: number[]
  ) {
    let ticksCrossed = 0;
    for (let i = 0; i < initializedTicksCrossedList.length; i++) {
      if (initializedTicksCrossedList[i]! > 0) {
        // Quoter returns Array<number of calls to crossTick + 1>, so we need to subtract 1 here.
        ticksCrossed += Number(initializedTicksCrossedList[i]!) - 1;
      }
    }

    return ticksCrossed;
  }
}
