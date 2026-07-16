import {SimulationStatus} from '../ISimulator';
import {VIRTUAL_BASE} from '../../../lib/tokenUtils';

// Universal Router slippage-check custom errors across V2/V3/V4, matched on
// their 4-byte selector so arg-bearing variants classify too. Mirrors
// guidestar-router's slippage revert set
// (packages/services/guidestar-router/src/bin/rpc.rs `is_slippage_revert`).
const SLIPPAGE_ERROR_SELECTORS = new Set([
  '0x849eaf98', // V2TooLittleReceived()
  '0x8ab0bc16', // V2TooMuchRequested()
  '0x65d564a5', // V2TooLittleReceivedPerHop(uint256,uint256,uint256)
  '0x39d35496', // V3TooLittleReceived()
  '0x739dbe52', // V3TooMuchRequested()
  '0x8b063d73', // V4TooLittleReceived(uint256,uint256)
  '0x12bacdd3', // V4TooMuchRequested(uint256,uint256)
  '0x4713c18b', // V4TooLittleReceivedPerHopSingle(uint256,uint256)
  '0xefc8d8eb', // V4TooMuchRequestedPerHopSingle(uint256,uint256)
]);

const INSUFFICIENT_TOKEN_SELECTOR = '0x675cae38'; // InsufficientToken()

// Error(string) payloads (selector 0x08c379a0) matched on the full
// ABI-encoded blob since the revert string carries the classification.
const ERROR_STRING_PAYLOAD_STATUSES: Record<string, SimulationStatus> = {
  // UniswapV2: INSUFFICIENT_OUTPUT_AMOUNT
  '0x08c379a000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000025556e697377617056323a20494e53554646494349454e545f4f55545055545f414d4f554e54000000000000000000000000000000000000000000000000000000':
    SimulationStatus.SLIPPAGE_TOO_LOW,
  // IIA
  '0x08c379a0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000034949410000000000000000000000000000000000000000000000000000000000':
    SimulationStatus.SLIPPAGE_TOO_LOW,
  // TRANSFER_FROM_FAILED
  '0x08c379a0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000145452414e534645525f46524f4d5f4641494c4544000000000000000000000000':
    SimulationStatus.TRANSFER_FROM_FAILED,
};

export function breakDownSimulationError(
  tokenInAddress: string,
  tokenOutAddress: string,
  data?: string
): SimulationStatus {
  if (!data) {
    return SimulationStatus.FAILED;
  }

  const revertData = data.toLowerCase();

  const errorStringStatus = ERROR_STRING_PAYLOAD_STATUSES[revertData];
  if (errorStringStatus) {
    return errorStringStatus;
  }

  const selector = revertData.slice(0, 10);

  if (SLIPPAGE_ERROR_SELECTORS.has(selector)) {
    return SimulationStatus.SLIPPAGE_TOO_LOW;
  }

  if (selector === INSUFFICIENT_TOKEN_SELECTOR) {
    if (
      tokenInAddress.toLowerCase() === VIRTUAL_BASE.address.toLowerCase() ||
      tokenOutAddress.toLowerCase() === VIRTUAL_BASE.address.toLowerCase()
    ) {
      // if this is from virtual, we'd guess it's due to slippage too low, although it might be due to something else
      return SimulationStatus.SLIPPAGE_TOO_LOW;
    }

    // Otherwise we don't wanna guess, just return generic failed.
    return SimulationStatus.FAILED;
  }

  // we don't know why onchain execution reverted, just return generic failed.
  return SimulationStatus.FAILED;
}
