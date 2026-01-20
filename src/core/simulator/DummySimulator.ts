import {ISimulator, SimulationStatus} from './ISimulator';
import {QuoteSplit} from '../../models/quote/QuoteSplit';
import {ChainId} from '../../lib/config';
import {SwapOptionsUniversalRouter} from './sor-port/simulation-provider';
import {Context} from '@uniswap/lib-uni/context';
import {CurrencyInfo} from '../../models/currency/CurrencyInfo';

export class DummySimulator implements ISimulator {
  async simulate(
    chainId: ChainId,
    swapOptions: SwapOptionsUniversalRouter,
    quote: QuoteSplit,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    tokenInCurrencyInfo: CurrencyInfo,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    tokenOutCurrencyInfo: CurrencyInfo,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    inputAmount: bigint,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    quoteAmount: bigint,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ctx: Context
  ): Promise<QuoteSplit> {
    const gasCostInQuoteToken = quote.quotes.reduce(
      (sum, q) => sum + (q.gasDetails?.gasCostInQuoteToken ?? 0n),
      0n
    );
    const estimatedGasUsed = quote.quotes.reduce(
      (sum, q) => sum + (q.gasDetails?.gasUse ?? 0n),
      0n
    );

    return new QuoteSplit(quote.quotes, undefined, {
      estimatedGasUsed: estimatedGasUsed,
      estimatedGasUsedInQuoteToken: gasCostInQuoteToken,
      status: SimulationStatus.SUCCESS,
      description: 'Simulation completed successfully',
    });
  }
}
