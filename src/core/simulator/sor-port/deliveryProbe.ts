import {TradeType} from '../../../models/quote/TradeType';
import {DeliveryUnmeasuredReason, SimulatedDelivery} from '../ISimulator';

/**
 * Multicall3 sits at this address on every chain it is deployed to. Its
 * `getEthBalance` is how a simulated bundle reads a native balance; on a
 * chain without it the read returns nothing and the delivery is unmeasured.
 */
export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';

// Both reads take one address and return one uint256, so the calldata is
// the selector followed by the address left-padded to a word.
const ERC20_BALANCE_OF_SELECTOR = '0x70a08231'; // balanceOf(address)
const MULTICALL3_GET_ETH_BALANCE_SELECTOR = '0x4d2301cc'; // getEthBalance(address)

function encodeAddressCall(selector: string, address: string): string {
  return `${selector}${address.slice(2).toLowerCase().padStart(64, '0')}`;
}

/** One balance the probe reads before and after the swap */
interface BalanceRead {
  holder: string;
  /** undefined reads the native balance */
  token: string | undefined;
}

export interface DeliveryProbeInput {
  tradeType: TradeType;
  /** The address the swap is sent from, after any substitution (mainnet ETH input sends from the beacon deposit address) */
  sender: string;
  /** The swap's recipient, undefined when the router pays the sender */
  recipient: string | undefined;
  /** Who receives each exact-in output portion the calldata takes */
  portionRecipients: readonly string[];
  tokenInWrappedAddress: string;
  tokenInIsNative: boolean;
  tokenOutWrappedAddress: string;
  tokenOutIsNative: boolean;
}

/**
 * The balance reads that bracket a simulated swap, and how to turn their
 * results into what the swap delivered: for exact-in, the output token
 * received by the recipient and the portion recipient together (the quote is
 * gross of the portion); for exact-out, the input token the sender spent net
 * of what the router refunds. The router takes the slippage-padded maximum
 * and sends the unspent input to the swap's recipient, so a recipient other
 * than the sender is read too and its gain subtracted.
 */
export class DeliveryProbe {
  private constructor(
    private readonly tradeType: TradeType,
    private readonly reads: readonly BalanceRead[]
  ) {}

  static for(input: DeliveryProbeInput): DeliveryProbe {
    if (input.tradeType === TradeType.ExactOut) {
      const tokenIn = input.tokenInIsNative
        ? undefined
        : input.tokenInWrappedAddress;
      const holders = new Set(
        [input.sender, input.recipient ?? input.sender].map(holder =>
          holder.toLowerCase()
        )
      );
      return new DeliveryProbe(
        TradeType.ExactOut,
        [...holders].map(holder => ({holder, token: tokenIn}))
      );
    }
    const token = input.tokenOutIsNative
      ? undefined
      : input.tokenOutWrappedAddress;
    const holders = new Set(
      [input.recipient ?? input.sender, ...input.portionRecipients].map(
        holder => holder.toLowerCase()
      )
    );
    return new DeliveryProbe(
      TradeType.ExactIn,
      [...holders].map(holder => ({holder, token}))
    );
  }

  /** How many calls `calls` returns, the same before and after the swap */
  get callCount(): number {
    return this.reads.length;
  }

  /** The eth_simulateV1 calls that read every bracketed balance */
  calls(from: string): {from: string; to: string; data: string}[] {
    return this.reads.map(({holder, token}) =>
      token === undefined
        ? {
            from,
            to: MULTICALL3_ADDRESS,
            data: encodeAddressCall(
              MULTICALL3_GET_ETH_BALANCE_SELECTOR,
              holder
            ),
          }
        : {
            from,
            to: token,
            data: encodeAddressCall(ERC20_BALANCE_OF_SELECTOR, holder),
          }
    );
  }

  /**
   * What the swap delivered, from the return data of the reads before and
   * after it (each list in `calls` order). `gasCharged` is true when the
   * simulated block charged gas, which would make a native balance of the
   * sender move by more than the swap.
   */
  measure(
    before: readonly (string | undefined)[],
    after: readonly (string | undefined)[],
    gasCharged: boolean,
    sender: string
  ): SimulatedDelivery {
    if (
      gasCharged &&
      this.reads.some(
        read =>
          read.token === undefined &&
          read.holder.toLowerCase() === sender.toLowerCase()
      )
    ) {
      return unmeasured(DeliveryUnmeasuredReason.GAS_CHARGED);
    }
    let total = 0n;
    for (const [index] of this.reads.entries()) {
      const balanceBefore = decodeBalance(before[index]);
      const balanceAfter = decodeBalance(after[index]);
      if (balanceBefore === undefined || balanceAfter === undefined) {
        return unmeasured(DeliveryUnmeasuredReason.BALANCE_READ_FAILED);
      }
      total +=
        this.tradeType === TradeType.ExactIn
          ? balanceAfter - balanceBefore
          : balanceBefore - balanceAfter;
    }
    // An exact-in swap that executed and delivered nothing is the full
    // shortfall; an exact-out swap that spent nothing did not trade.
    const minimum = this.tradeType === TradeType.ExactIn ? 0n : 1n;
    if (total < minimum) {
      return unmeasured(DeliveryUnmeasuredReason.NO_BALANCE_CHANGE);
    }
    return {kind: 'measured', amount: total};
  }
}

function unmeasured(reason: DeliveryUnmeasuredReason): SimulatedDelivery {
  return {kind: 'unmeasured', reason};
}

const UINT256_HEX = /^0x[0-9a-fA-F]{64}$/;

// Both reads return one uint256; anything else (an empty reply from a chain
// without Multicall3, a revert) is not a balance.
function decodeBalance(returnData: string | undefined): bigint | undefined {
  return returnData !== undefined && UINT256_HEX.test(returnData)
    ? BigInt(returnData)
    : undefined;
}
