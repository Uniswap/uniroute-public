import {UniPool} from '../../models/pool/UniPool';
import {ChainId} from '../../lib/config';
import {QuoteBasic} from '../../models/quote/QuoteBasic';
import {Context as UniContext} from '@uniswap/lib-uni/context';
import {RouteBasic} from '../../models/route/RouteBasic';
import {TradeType} from '../../models/quote/TradeType';

export interface IQuoteBestSplitFinder<TPool extends UniPool> {
  findBestSplits(
    chainId: ChainId,
    percentageToSortedQuotes: Map<number, QuoteBasic[]>,
    percentageStep: number,
    maxSplits: number,
    maxSplitRoutes: number,
    timeoutMs: number,
    tradeType: TradeType,
    metricTags: string[],
    ctx: UniContext
  ): Promise<RouteBasic<TPool>[][]>;
}
