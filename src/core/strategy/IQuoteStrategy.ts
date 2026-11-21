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
import {QuoteFetchReport} from '../../stores/quote/IQuoteFetcher';

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
    metricTags: string[],
    // Pins the quotes and pool reads; the routing gas price reads
    // gasPriceBlockNumber instead, latest when it is undefined.
    blockNumber?: number,
    testAggHooks?: boolean,
    supplementalHookCodeOverrides?: Readonly<Record<string, string>>,
    priorityFeePerGasWei?: bigint,
    fetchReport?: QuoteFetchReport,
    abortSignal?: AbortSignal,
    gasPriceBlockNumber?: number
  ): Promise<QuoteSplit[]>;

  name(): string;
}
