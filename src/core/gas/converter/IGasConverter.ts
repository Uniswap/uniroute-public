import {ChainId} from '../../../lib/config';
import {Erc20Token} from '../../../models/token/Erc20Token';
import {QuoteBasic} from '../../../models/quote/QuoteBasic';
import {QuoteSplit} from '../../../models/quote/QuoteSplit';
import {Context} from '@uniswap/lib-uni/context';

export interface IGasConverter {
  updateQuotesGasDetails(
    chainId: ChainId,
    quoteTokenAddress: string,
    tokensInfo: Map<string, Erc20Token | null>,
    quotes: QuoteSplit[],
    ctx: Context,
    blockNumber?: number
  ): Promise<void>;

  /**
   * Per-`QuoteBasic` variant of `updateQuotesGasDetails`. Used by
   * `DeepQuoteStrategy` to populate `gasCostInQuoteToken` BEFORE
   * `findBestSplits` runs, so `scoreAndSortCombinations` can rank
   * combinations by gas-adjusted total amount rather than raw amount.
   * Same conversion logic as the split-level variant; modifies each
   * quote's `gasDetails.gasCostInQuoteToken` in place.
   */
  updateQuoteBasicsGasDetails(
    chainId: ChainId,
    quoteTokenAddress: string,
    tokensInfo: Map<string, Erc20Token | null>,
    quotes: QuoteBasic[],
    ctx: Context,
    blockNumber?: number
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
    ctx: Context,

    _blockNumber?: number
  ): Promise<void> {
    return;
  }

  async updateQuoteBasicsGasDetails(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    chainId: ChainId,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    quoteTokenAddress: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    tokensInfo: Map<string, Erc20Token | null>,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    quotes: QuoteBasic[],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ctx: Context,
    _blockNumber?: number
  ): Promise<void> {
    return;
  }
}
