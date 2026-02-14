import {ChainId} from '../../../lib/config';
import {Erc20Token} from '../../../models/token/Erc20Token';
import {QuoteSplit} from '../../../models/quote/QuoteSplit';
import {Context} from '@uniswap/lib-uni/context';
import {GasPools} from '../gas-helpers';

export interface IGasConverter {
  prefetchGasPools(
    chainId: ChainId,
    quoteTokenAddress: string,
    ctx: Context
  ): Promise<GasPools>;

  updateQuotesGasDetails(
    chainId: ChainId,
    quoteTokenAddress: string,
    tokensInfo: Map<string, Erc20Token | null>,
    quotes: QuoteSplit[],
    ctx: Context,
    prefetchedGasPools?: GasPools
  ): Promise<void>;
}

export class NoGasConverter implements IGasConverter {
  async prefetchGasPools(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _chainId: ChainId,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _quoteTokenAddress: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _ctx: Context
  ): Promise<GasPools> {
    return {
      nativeAndQuoteTokenV2Pool: null,
      nativeAndQuoteTokenV3Pool: null,
      nativeAndQuoteTokenV4Pool: null,
    };
  }

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
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    prefetchedGasPools?: GasPools
  ): Promise<void> {
    return;
  }
}
