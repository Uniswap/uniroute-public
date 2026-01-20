import {QuoteSplit} from '../../models/quote/QuoteSplit';
import {ChainId} from '../../lib/config';
import {SwapOptionsUniversalRouter} from './sor-port/simulation-provider';
import {Context} from '@uniswap/lib-uni/context';
import {CurrencyInfo} from '../../models/currency/CurrencyInfo';

export enum SimulationStatus {
  UNATTEMPTED = 'UNATTEMPTED',
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
  INSUFFICIENT_BALANCE = 'INSUFFICIENT_BALANCE',
  NOT_SUPPORTED = 'NOT_SUPPORTED',
  NOT_APPROVED = 'NOT_APPROVED',
  SYSTEM_DOWN = 'SYSTEM_DOWN',
  SLIPPAGE_TOO_LOW = 'SLIPPAGE_TOO_LOW',
  TRANSFER_FROM_FAILED = 'TRANSFER_FROM_FAILED',
}

export interface SimulationResult {
  estimatedGasUsed: bigint;
  estimatedGasUsedInQuoteToken: bigint;
  status: SimulationStatus;
  description?: string;
}

export interface ISimulator {
  simulate(
    chainId: ChainId,
    swapOptions: SwapOptionsUniversalRouter,
    quote: QuoteSplit,
    tokenInCurrencyInfo: CurrencyInfo,
    tokenOutCurrencyInfo: CurrencyInfo,
    inputAmount: bigint,
    quoteAmount: bigint,
    ctx: Context,
    gasPrice?: bigint,
    blockNumber?: number
  ): Promise<QuoteSplit>;
}
