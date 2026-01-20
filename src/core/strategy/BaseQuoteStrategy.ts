import {IQuoteSelector} from '../quote/selector/IQuoteSelector';
import {IQuoteFetcher} from '../../stores/quote/IQuoteFetcher';
import {IGasEstimateProvider} from '../gas/estimator/GasEstimateProvider';
import {IGasConverter} from '../gas/converter/IGasConverter';
import {IRouteQuoteAllocator} from '../route/RouteQuoteAllocator';
import {IQuoteStrategy} from './IQuoteStrategy';
import {QuoteSplit} from '../../models/quote/QuoteSplit';
import {UniPool} from '../../models/pool/UniPool';
import {IUniRouteServiceConfig} from 'src/lib/config';
import {Chain} from '../../models/chain/Chain';
import {TradeType} from '../../models/quote/TradeType';
import {UniProtocol} from '../../models/pool/UniProtocol';
import {Context} from '@uniswap/lib-uni/context';
import {RouteBasic} from '../../models/route/RouteBasic';
import {Erc20Token} from '../../models/token/Erc20Token';
import {CurrencyInfo} from '../../models/currency/CurrencyInfo';
import {ITokenHandler} from '../../stores/token/ITokenHandler';
import {ArbitrumGasDataProvider} from '../gas/gas-data-provider';
import {IFreshPoolDetailsWrapper} from '../../stores/pool/FreshPoolDetailsWrapper';

export abstract class BaseQuoteStrategy implements IQuoteStrategy {
  constructor(
    protected readonly quoteFetcher: IQuoteFetcher,
    protected readonly gasEstimateProvider: IGasEstimateProvider,
    protected readonly gasConverter: IGasConverter,
    protected readonly routeQuoteAllocator: IRouteQuoteAllocator<UniPool>,
    protected readonly quoteSelector: IQuoteSelector,
    protected readonly tokenHandler: ITokenHandler,
    protected readonly arbitrumGasDataProvider: ArbitrumGasDataProvider,
    protected readonly freshPoolDetailsWrapper: IFreshPoolDetailsWrapper
  ) {}

  abstract findBestQuoteCandidates(
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

  abstract name(): string;
}
