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
import {UniProtocol} from '../../../models/pool/UniProtocol';
import {UniPool} from '../../../models/pool/UniPool';
import {RouteBasic} from '../../../models/route/RouteBasic';
import {BaseGasEstimator} from './BaseGasEstimator';
import {IFreshPoolDetailsWrapper} from '../../../stores/pool/FreshPoolDetailsWrapper';

// V2-specific constants
const COST_PER_EXTRA_HOP_V2 = BigNumber.from(50000);
const BASE_SWAP_COST_V2 = BigNumber.from(135000);

export class MixedGasEstimator extends BaseGasEstimator {
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
  ): Promise<GasDetails> {
    // Partition the route by protocol sections
    const sections = this.partitionRouteByProtocol(quote.route.path);

    let baseGasUse = BigNumber.from(0);
    let totalInitializedTicksCrossed = 0;

    // Process each section based on its protocol
    sections.forEach(section => {
      if (section.length === 0) return;

      const protocol = section[0].protocol;
      const hops = BigNumber.from(section.length);

      // Prepare variables used in multiple cases
      let hopsGasUse: BigNumber;
      let sectionRoute: RouteBasic<UniPool>;
      let tokenOverhead: BigNumber;

      switch (protocol) {
        case UniProtocol.V2:
          // V2 gas calculation
          baseGasUse = baseGasUse
            .add(COST_PER_EXTRA_HOP_V2.mul(section.length - 1))
            .add(BASE_SWAP_COST_V2);
          break;

        case UniProtocol.V3:
        case UniProtocol.V4:
          // V3/V4 gas calculation
          hopsGasUse = COST_PER_HOP(chainId).mul(hops);

          // Add single hop overhead if section is single hop
          if (hops.eq(1)) {
            hopsGasUse = hopsGasUse.add(SINGLE_HOP_OVERHEAD(chainId));
          }

          // Create a route object for the section for token overhead calculation
          sectionRoute = new RouteBasic(protocol, section);

          // Add token overhead for known expensive tokens
          tokenOverhead = TOKEN_OVERHEAD(chainId, sectionRoute);

          // Count initialized ticks crossed for V3 sections
          if (protocol === UniProtocol.V3) {
            const sectionTicksCrossed =
              this.getInitializedTicksCrossedForSection(
                quote.v3QuoterResponseDetails?.initializedTicksCrossedList ||
                  [],
                section
              );
            totalInitializedTicksCrossed += sectionTicksCrossed;
          }

          baseGasUse = baseGasUse
            .add(hopsGasUse)
            .add(tokenOverhead)
            .add(BASE_SWAP_COST(chainId));
          break;
      }
    });

    // Add tick crossing costs
    const tickGasUse = COST_PER_INIT_TICK(chainId).mul(
      totalInitializedTicksCrossed
    );
    const uninitializedTickGasUse = COST_PER_UNINIT_TICK.mul(0);

    baseGasUse = baseGasUse.add(tickGasUse).add(uninitializedTickGasUse);

    // Calculate final gas costs
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

  private partitionRouteByProtocol(path: UniPool[]): UniPool[][] {
    if (path.length === 0) return [];

    const sections: UniPool[][] = [];
    let currentSection: UniPool[] = [path[0]];
    let currentProtocol = path[0].protocol;

    for (let i = 1; i < path.length; i++) {
      if (path[i].protocol === currentProtocol) {
        currentSection.push(path[i]);
      } else {
        sections.push(currentSection);
        currentSection = [path[i]];
        currentProtocol = path[i].protocol;
      }
    }
    sections.push(currentSection);

    return sections;
  }

  private getInitializedTicksCrossedForSection(
    initializedTicksCrossedList: number[],
    section: UniPool[]
  ): number {
    let ticksCrossed = 0;
    let v3PoolCount = 0;

    // Count how many V3 pools we've seen before this section
    for (const pool of section) {
      if (pool.protocol === UniProtocol.V3) {
        // The quoter returns Array<number of calls to crossTick + 1>, so subtract 1
        if (initializedTicksCrossedList[v3PoolCount]) {
          ticksCrossed += Math.max(
            0,
            initializedTicksCrossedList[v3PoolCount]! - 1
          );
        }
        v3PoolCount++;
      }
    }

    return ticksCrossed;
  }
}
