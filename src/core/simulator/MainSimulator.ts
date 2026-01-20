import {ISimulator} from './ISimulator';
import {QuoteSplit} from '../../models/quote/QuoteSplit';
import {FallbackTenderlySimulator} from './sor-port/tenderly-simulation-provider';
import {ChainId} from '../../lib/config';
import {SwapOptionsUniversalRouter} from './sor-port/simulation-provider';
import {Context} from '@uniswap/lib-uni/context';
import {CurrencyInfo} from '../../models/currency/CurrencyInfo';

// Wrapper for the fallback simulator that was ported from SOR as is.
export class MainSimulator implements ISimulator {
  constructor(
    private readonly fallbackTenderlySimulators: Map<
      ChainId,
      FallbackTenderlySimulator
    >
  ) {}

  async simulate(
    chainId: ChainId,
    swapOptions: SwapOptionsUniversalRouter,
    quote: QuoteSplit,
    tokenInCurrencyInfo: CurrencyInfo,
    tokenOutCurrencyInfo: CurrencyInfo,
    inputAmount: bigint,
    quoteAmount: bigint,
    ctx: Context,
    gasPrice?: bigint,
    blockNumber?: number
  ): Promise<QuoteSplit> {
    const fallbackTenderlySimulator =
      this.fallbackTenderlySimulators.get(chainId)!;
    return await fallbackTenderlySimulator.simulate(
      swapOptions.simulate!.fromAddress,
      swapOptions,
      quote,
      tokenInCurrencyInfo,
      tokenOutCurrencyInfo,
      inputAmount,
      quoteAmount,
      ctx,
      gasPrice,
      blockNumber
    );
  }
}
