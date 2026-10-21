import {JsonRpcProvider, StaticJsonRpcProvider} from '@ethersproject/providers';
import {constants} from 'ethers';
import {LRUCache} from 'lru-cache';
import {ChainId} from '../../../lib/config';
import {findJsonRpcError} from './simulationErrorBreakDown';

/** unirpc-go seeds every sender of the request with this asset and answers -32602 when it cannot */
export const BALANCE_OVERRIDE_HEADER = 'x-unirpc-balance-override';
export const NATIVE_BALANCE_OVERRIDE_ASSET = constants.AddressZero;

const JSON_RPC_INVALID_PARAMS_CODE = -32602;
const BALANCE_OVERRIDE_REFUSAL_MESSAGE_PREFIX = 'balance override';
// Bounded because the asset is the request's tokenIn
const SEEDED_PROVIDER_CACHE_SIZE = 256;

/** Gives the header-bearing provider for an asset so the simulator never builds one itself */
export type SeededProviderFactory = (asset: string) => JsonRpcProvider;

export enum BalanceOverrideRefusalReason {
  /** unirpc-go could not seed the sender for this token, method or chain */
  REFUSED = 'balance_override_refused',
  /** A -32602 that is the request's own fault rather than a refused seed */
  INVALID_PARAMS = 'invalid_params',
}

/** The seeded simulation never ran so only the sender's real balance is known */
export class BalanceOverrideRefusedError extends Error {
  constructor(
    readonly reason: BalanceOverrideRefusalReason,
    message: string
  ) {
    super(message);
    this.name = 'BalanceOverrideRefusedError';
  }
}

/** Any -32602 on a seeded call means nothing ran and the message prefix only picks the metric reason */
export function describeBalanceOverrideRefusal(
  error: unknown
): BalanceOverrideRefusedError | undefined {
  const jsonRpcError = findJsonRpcError(error);
  if (
    jsonRpcError === undefined ||
    jsonRpcError.code !== JSON_RPC_INVALID_PARAMS_CODE
  ) {
    return undefined;
  }
  const message =
    typeof jsonRpcError.message === 'string' ? jsonRpcError.message : '';
  const reason = message
    .toLowerCase()
    .startsWith(BALANCE_OVERRIDE_REFUSAL_MESSAGE_PREFIX)
    ? BalanceOverrideRefusalReason.REFUSED
    : BalanceOverrideRefusalReason.INVALID_PARAMS;
  return new BalanceOverrideRefusedError(reason, message);
}

/** ethers freezes a provider's connection so a per-request header needs its own pinned instance */
export function withBalanceOverride(
  provider: JsonRpcProvider,
  chainId: ChainId,
  asset: string
): JsonRpcProvider {
  return new StaticJsonRpcProvider(
    {
      ...provider.connection,
      headers: {
        ...provider.connection.headers,
        [BALANCE_OVERRIDE_HEADER]: asset,
      },
    },
    chainId
  );
}

/** One header-bearing provider per asset, reused across requests and built from the injected provider */
export function createSeededProviderFactory(
  provider: JsonRpcProvider,
  chainId: ChainId
): SeededProviderFactory {
  const providers = new LRUCache<string, JsonRpcProvider>({
    max: SEEDED_PROVIDER_CACHE_SIZE,
  });
  return asset => {
    const key = asset.toLowerCase();
    const cached = providers.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const created = withBalanceOverride(provider, chainId, asset);
    providers.set(key, created);
    return created;
  };
}
