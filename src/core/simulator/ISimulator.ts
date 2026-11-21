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

/** Why a simulation that executed the swap could not say what it delivered */
export enum DeliveryUnmeasuredReason {
  /** A bracketing balance read reverted or returned something other than a uint256 */
  BALANCE_READ_FAILED = 'balance_read_failed',
  /** The balance moved the wrong way, or an exact-out swap spent nothing */
  NO_BALANCE_CHANGE = 'no_balance_change',
  /** The simulated block charged gas, so the sender's native balance moved by more than the swap */
  GAS_CHARGED = 'gas_charged',
}

/**
 * What the simulated swap actually moved: for exact-in the output received
 * (recipient plus portion recipients), for exact-out the input spent net of
 * the refund to the recipient.
 */
export type SimulatedDelivery =
  | {kind: 'measured'; amount: bigint}
  | {kind: 'unmeasured'; reason: DeliveryUnmeasuredReason};

export interface SimulationResult {
  estimatedGasUsed: bigint;
  estimatedGasUsedInQuoteToken: bigint;
  estimatedGasUsedInUSD: number;
  status: SimulationStatus;
  description?: string;
  /** Set when the run seeded the sender balance through unirpc */
  seeded?: boolean;
  /**
   * Set when the swap reverted on a SWEEP or UNWRAP_WETH minimum, which the
   * status reports as FAILED
   */
  routerBalanceFloorReverted?: boolean;
  /** Set when the swap executed on a chain whose simulator measures delivery */
  delivery?: SimulatedDelivery;
}

/** True when the swap executed and measured gas, which includes INSUFFICIENT_BALANCE from a seeded run */
export function hasSimulatedGasEstimate(
  result?: SimulationResult
): result is SimulationResult {
  return (
    result !== undefined &&
    (result.status === SimulationStatus.SUCCESS ||
      result.status === SimulationStatus.INSUFFICIENT_BALANCE) &&
    result.estimatedGasUsedInQuoteToken !== 0n
  );
}

/**
 * True when the swap reverted on an amount limit: a slippage check
 * (SLIPPAGE_TOO_LOW) or a SWEEP / UNWRAP_WETH minimum
 */
export function revertedOnAmountLimit(result?: SimulationResult): boolean {
  return (
    result !== undefined &&
    (result.status === SimulationStatus.SLIPPAGE_TOO_LOW ||
      result.routerBalanceFloorReverted === true)
  );
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
