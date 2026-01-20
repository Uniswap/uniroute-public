import {TradeType} from '../../../models/quote/TradeType';
import {Context as UniContext} from '@uniswap/lib-uni/context';
import {QuoteSplit} from '../../../models/quote/QuoteSplit';

export interface IQuoteSelector {
  getBestQuotes(
    quotes: QuoteSplit[],
    tradeType: TradeType,
    topN: number,
    metricTags: string[],
    ctx: UniContext
  ): Promise<QuoteSplit[]>;
}
