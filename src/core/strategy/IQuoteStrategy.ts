import {Context} from '@uniswap/lib-uni/context';
import {Chain} from '../../models/chain/Chain';
import {TradeType} from '../../models/quote/TradeType';
import {UniProtocol} from '../../models/pool/UniProtocol';
import {QuoteSplit} from '../../models/quote/QuoteSplit';
import {IUniRouteServiceConfig} from '../../lib/config';
import {RouteBasic} from '../../models/route/RouteBasic';
import {UniPool} from '../../models/pool/UniPool';
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
    protocols: UniProtocol[],
    serviceConfig: IUniRouteServiceConfig,
    routes: RouteBasic<UniPool>[],
    tokensInfo: Map<string, Erc20Token | null>,
    metricTags: string[]
  ): Promise<QuoteSplit[]>;

  name(): string;
}
