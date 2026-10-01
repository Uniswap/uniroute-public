import {QuoteSplit} from '../../models/quote/QuoteSplit';
import {ChainId} from '../../lib/config';
import {SwapOptionsUniversalRouter} from './sor-port/simulation-provider';
import {Context} from '@uniswap/lib-uni/context';
import {CurrencyInfo} from '../../models/currency/CurrencyInfo';
import {ResolvedStateOverride} from './ResolvedStateOverride';

/**
 * Bare wire names of the `SimulationStatus` enum in proto/uniroute/v1/api.proto,
 * which documents each value. UNKNOWN is reserved for consumers coercing an
 * unrecognized value; this router never emits it.
 */
export enum SimulationStatus {
  UNATTEMPTED = 'UNATTEMPTED',
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
  INSUFFICIENT_BALANCE = 'INSUFFICIENT_BALANCE',
  NOT_SUPPORTED = 'NOT_SUPPORTED',
  NOT_APPROVED = 'NOT_APPROVED',
  UNKNOWN = 'UNKNOWN',
  SYSTEM_DOWN = 'SYSTEM_DOWN',
  SLIPPAGE_TOO_LOW = 'SLIPPAGE_TOO_LOW',
  TRANSFER_FROM_FAILED = 'TRANSFER_FROM_FAILED',
}

export function isSimulationError(status?: SimulationStatus): boolean {
  return (
    status !== undefined &&
    status !== SimulationStatus.SUCCESS &&
    status !== SimulationStatus.UNATTEMPTED
  );
}

export interface SimulationResult {
  estimatedGasUsed: bigint;
  estimatedGasUsedInQuoteToken: bigint;
  estimatedGasUsedInUSD: number;
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
    blockNumber?: number,
    stateOverrides?: ResolvedStateOverride[]
  ): Promise<QuoteSplit>;
}
