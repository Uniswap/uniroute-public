import {Context} from '@uniswap/lib-uni/context';
import {Chain} from '../../models/chain/Chain';
import {TradeType} from '../../models/quote/TradeType';
import {Protocol} from '../../models/pool/Protocol';
import {QuoteSplit} from '../../models/quote/QuoteSplit';
import {IUniRouteServiceConfig} from '../../lib/config';
import {RouteBasic} from '../../models/route/RouteBasic';
import {Pool} from '../../models/pool/Pool';
import {Erc20Token} from '../../models/token/Erc20Token';
import {CurrencyInfo} from '../../models/currency/CurrencyInfo';

export interface IQuoteStrategy {
  findBestQuoteCandidates(
    ctx: Context,
    chain: Chain,
    tokenInCurrencyInfo: CurrencyInfo,
    tokenOutCurrencyInfo: CurrencyInfo,
    amount: bigint,
    tradeType: TradeType,
    protocols: Protocol[],
    serviceConfig: IUniRouteServiceConfig,
    routes: RouteBasic<Pool>[],
    tokensInfo: Map<string, Erc20Token | null>,
    metricTags: string[]
  ): Promise<QuoteSplit[]>;

  name(): string;
}
