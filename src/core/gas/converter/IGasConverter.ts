import {ChainId} from '../../../lib/config';
import {Erc20Token} from '../../../models/token/Erc20Token';
import {QuoteSplit} from '../../../models/quote/QuoteSplit';
import {Context} from '@uniswap/lib-uni/context';

export interface IGasConverter {
  updateQuotesGasDetails(
    chainId: ChainId,
    quoteTokenAddress: string,
    tokensInfo: Map<string, Erc20Token | null>,
    quotes: QuoteSplit[],
    ctx: Context
  ): Promise<void>;
}

export class NoGasConverter implements IGasConverter {
  async updateQuotesGasDetails(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    chainId: ChainId,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    quoteTokenAddress: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    tokensInfo: Map<string, Erc20Token | null>,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    quotes: QuoteSplit[],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ctx: Context
  ): Promise<void> {
    return;
  }
}
