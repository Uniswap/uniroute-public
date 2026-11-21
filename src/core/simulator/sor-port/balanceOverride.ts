import {JsonRpcProvider, StaticJsonRpcProvider} from '@ethersproject/providers';
import {constants} from 'ethers';
import {LRUCache} from 'lru-cache';
import {ChainId} from '../../../lib/config';
import {findJsonRpcError} from './simulationErrorBreakDown';

// unirpc-go request headers carried on an ethers provider. ethers freezes a
// provider's connection, so a header that varies per call or per request
// needs its own provider instance.
/**
 * unirpc-go's block-number floor: a decimal block the serving node must have
 * reached, so a pinned read is routed to a caught-up node (or waits briefly)
 * instead of answering `block not found` from a lagging one. Absent or
 * unparseable means no floor.
 */
export const MIN_BLOCK_NUMBER_HEADER = 'X-Min-Block-Number';

// Position of the block tag in each pinned method's params
const BLOCK_TAG_PARAM_INDEX: Readonly<Record<string, number>> = {
  eth_call: 1,
  eth_estimateGas: 1,
  eth_simulateV1: 1,
  unirpc_simulateV0: 1,
  eth_getBalance: 1,
  eth_getCode: 1,
  eth_getTransactionCount: 1,
  eth_getStorageAt: 2,
};

type ProviderConnection = ConstructorParameters<
  typeof StaticJsonRpcProvider
>[0];

const HEX_QUANTITY = /^0x[0-9a-fA-F]+$/;
// One provider per recent block: concurrent requests pinned to the same block
// share it, and an evicted one is just rebuilt (construction makes no RPC).
const FLOOR_PROVIDER_CACHE_SIZE = 64;

/**
 * The decimal block a call is pinned to, or undefined for `latest` and the
 * other named tags, which need no floor.
 */
export function pinnedBlockOf(
  method: string,
  params: unknown
): string | undefined {
  const index = BLOCK_TAG_PARAM_INDEX[method];
  if (index === undefined || !Array.isArray(params)) {
    return undefined;
  }
  const blockTag: unknown = params[index];
  return typeof blockTag === 'string' && HEX_QUANTITY.test(blockTag)
    ? BigInt(blockTag).toString()
    : undefined;
}

/**
 * Sends `X-Min-Block-Number` with every call pinned to a block number. ethers
 * freezes a provider's connection, so a pinned call is sent through a provider
 * built for its block with the header added; every other call goes out as
 * before.
 */
export class MinBlockFloorJsonRpcProvider extends StaticJsonRpcProvider {
  private readonly floorProviders = new LRUCache<string, StaticJsonRpcProvider>(
    {max: FLOOR_PROVIDER_CACHE_SIZE}
  );

  constructor(
    connection: ProviderConnection,
    private readonly chainIdForFloor: number
  ) {
    super(connection, chainIdForFloor);
  }

  override send(method: string, params: Array<unknown>): Promise<unknown> {
    const pinnedBlock = pinnedBlockOf(method, params);
    return pinnedBlock === undefined
      ? super.send(method, params)
      : this.floorProvider(pinnedBlock).send(method, params);
  }

  private floorProvider(pinnedBlock: string): StaticJsonRpcProvider {
    const cached = this.floorProviders.get(pinnedBlock);
    if (cached !== undefined) {
      return cached;
    }
    const provider = new StaticJsonRpcProvider(
      {
        ...this.connection,
        headers: {
          ...this.connection.headers,
          [MIN_BLOCK_NUMBER_HEADER]: pinnedBlock,
        },
      },
      this.chainIdForFloor
    );
    this.floorProviders.set(pinnedBlock, provider);
    return provider;
  }
}

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
  // Keeps the block floor the injected provider sends on pinned calls
  return new MinBlockFloorJsonRpcProvider(
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
