import {utils} from 'ethers';
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

const MAX_REVERT_DATA_SEARCH_DEPTH = 5;
const REVERT_DATA_REGEX = /^0x[0-9a-f]{8,}$/i;
const HTTP_SERVER_ERROR_MIN_STATUS = 500;
// unirpc-go answers a request that every upstream provider failed with HTTP
// 200 and this JSON-RPC error (unirpc-go src/api/handler.go, ForwardError).
// Nodes reuse -32000 for errors they did evaluate (execution reverted, header
// not found), so the message has to match exactly as well.
const UNIRPC_UPSTREAM_FAILURE_CODE = -32000;
const UNIRPC_UPSTREAM_FAILURE_MESSAGE = 'upstream request failed';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Extracts revert bytes across ethers v5's bounded error-wrapper shapes. */
export function extractRevertData(
  value: unknown,
  depth = 0
): string | undefined {
  if (
    value === null ||
    value === undefined ||
    depth > MAX_REVERT_DATA_SEARCH_DEPTH
  ) {
    return undefined;
  }
  if (typeof value === 'string') {
    try {
      return extractRevertData(JSON.parse(value), depth + 1);
    } catch {
      return undefined;
    }
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const data = value.data;
  if (typeof data === 'string' && REVERT_DATA_REGEX.test(data)) {
    return data;
  }
  return (
    extractRevertData(data, depth + 1) ??
    extractRevertData(value.error, depth + 1) ??
    extractRevertData(value.body, depth + 1)
  );
}

function findJsonRpcError(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const nestedError = value.error;
  if (
    isRecord(nestedError) &&
    (typeof nestedError.code === 'number' ||
      typeof nestedError.message === 'string')
  ) {
    return nestedError;
  }
  if (typeof value.body !== 'string') {
    return undefined;
  }
  try {
    const body: unknown = JSON.parse(value.body);
    return isRecord(body) && isRecord(body.error) ? body.error : undefined;
  } catch {
    return undefined;
  }
}

function hasEthersErrorCode(value: unknown, code: string): boolean {
  return isRecord(value) && value.code === code;
}

function isUniRpcUpstreamFailure(jsonRpcError: Record<string, unknown>) {
  return (
    jsonRpcError.code === UNIRPC_UPSTREAM_FAILURE_CODE &&
    jsonRpcError.message === UNIRPC_UPSTREAM_FAILURE_MESSAGE
  );
}

// ethers wraps both HTTP-level failures and JSON-RPC error responses as
// SERVER_ERROR. A 5xx status, a missing JSON-RPC error object, or unirpc-go's
// all-providers-failed error means the backend never evaluated the
// transaction; any other JSON-RPC error means it did.
function isTransportServerError(value: unknown): boolean {
  if (!hasEthersErrorCode(value, utils.Logger.errors.SERVER_ERROR)) {
    return false;
  }
  if (
    isRecord(value) &&
    typeof value.status === 'number' &&
    value.status >= HTTP_SERVER_ERROR_MIN_STATUS
  ) {
    return true;
  }
  const jsonRpcError = findJsonRpcError(value);
  return jsonRpcError === undefined || isUniRpcUpstreamFailure(jsonRpcError);
}

/**
 * True when the RPC call behind a simulation step never reached a node that
 * evaluated it: ethers TIMEOUT / NETWORK_ERROR, or a transport-level
 * SERVER_ERROR. Contract reads (balanceOf, allowance) surface the same
 * failures wrapped in a CALL_EXCEPTION, which is unwrapped one level.
 */
export function isSimulationBackendUnavailable(error: unknown): boolean {
  const transportError =
    hasEthersErrorCode(error, utils.Logger.errors.CALL_EXCEPTION) &&
    isRecord(error)
      ? error.error
      : error;
  return (
    hasEthersErrorCode(transportError, utils.Logger.errors.TIMEOUT) ||
    hasEthersErrorCode(transportError, utils.Logger.errors.NETWORK_ERROR) ||
    isTransportServerError(transportError)
  );
}

type SimulationExceptionLogFields = {
  errorName: string;
  errorCode?: string;
  upstreamStatus?: number;
};

// Outage errors carry the request body and URL, so only these fields are
// logged. The HTTP status is named upstreamStatus because Datadog remaps a
// numeric `status` attribute to the log's severity.
export function simulationExceptionLogFields(
  error: unknown
): SimulationExceptionLogFields {
  if (!isRecord(error)) {
    return {errorName: 'UnknownError'};
  }
  const fields: SimulationExceptionLogFields = {
    errorName: typeof error.name === 'string' ? error.name : 'UnknownError',
  };
  if (typeof error.code === 'string' || typeof error.code === 'number') {
    fields.errorCode = String(error.code);
  }
  if (typeof error.status === 'number') {
    fields.upstreamStatus = error.status;
  }
  return fields;
}

/**
 * Status plus log fields for an exception thrown by a simulation call. Outage
 * errors log only the redacted fields; anything else logs the raw error,
 * which carries the revert details needed to debug the route.
 */
export function describeSimulationException(
  error: unknown,
  tokenInAddress: string,
  tokenOutAddress: string
): {status: SimulationStatus; logFields: Record<string, unknown>} {
  const status = classifySimulationException(
    error,
    tokenInAddress,
    tokenOutAddress
  );
  return {
    status,
    logFields:
      status === SimulationStatus.SYSTEM_DOWN
        ? simulationExceptionLogFields(error)
        : {e: error},
  };
}

export function classifySimulationException(
  error: unknown,
  tokenInAddress: string,
  tokenOutAddress: string
): SimulationStatus {
  const revertData = extractRevertData(error);
  if (revertData) {
    return breakDownSimulationError(
      tokenInAddress,
      tokenOutAddress,
      revertData
    );
  }
  if (isSimulationBackendUnavailable(error)) {
    return SimulationStatus.SYSTEM_DOWN;
  }
  return SimulationStatus.FAILED;
}
