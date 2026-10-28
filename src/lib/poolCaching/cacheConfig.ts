/**
 * Ported from routing-api/lib/cron/cache-config.ts
 * Defines the chain+protocol matrix the pool-caching cron writes a snapshot
 * for. Every combo reads its pools from data-ingestion Aurora:
 * applyAuroraPoolSources (auroraPoolsSource.ts) installs each combo's
 * provider, and applyAuroraExtraPoolSources (auroraExtraPoolSources.ts) the
 * extra sources (EulerSwap hooks, aggregator hooks, the mainnet V3 manual
 * pools) layered on top of it.
 */

import {Protocol} from '@uniswap/router-sdk';
import {ChainId} from '@uniswap/sdk-core';
import {ethers} from 'ethers';

// TEMPO is not yet in sdk-core 7.11.0 — define locally until sdk-core is upgraded
const CHAIN_ID_TEMPO = 4217 as ChainId;
// MEGAETH is not in sdk-core — define locally until sdk-core is upgraded
const CHAIN_ID_MEGAETH = 4326 as ChainId;
// ROBINHOOD is not in sdk-core — define locally until sdk-core is upgraded
export const CHAIN_ID_ROBINHOOD = 4663 as ChainId;
// ARC is not in sdk-core — define locally until sdk-core is upgraded
const CHAIN_ID_ARC = 5042 as ChainId;

import type {
  ISubgraphProvider,
  V2SubgraphPool,
  V3SubgraphPool,
  V4SubgraphPool,
} from './sor-providers';
import type {ExtraPoolSources} from './extraPoolSources';

import {
  AGG_HOOKS_ON_BASE,
  AGG_HOOKS_ON_MAINNET,
  AGG_HOOKS_ON_TEMPO,
} from './util/aggHooksAddressesAllowlist';

// --- Threshold constants ---

export const v4TrackedEthThreshold = 0.01;
export const v4BaseTrackedEthThreshold = 0.1;
const v4UntrackedUsdThreshold = 0;

export const v3TrackedEthThreshold = 0.01;
export const v3BaseTrackedEthThreshold = 0.1;
const v3UntrackedUsdThreshold = 25000;

export const v2TrackedEthThreshold = 0.025;
export const v2BaseTrackedEthThreshold = 0.1;
export const v2UntrackedUsdThreshold = Number.MAX_VALUE;

// --- Chain protocol definitions ---

// Per-(protocol, chain) TVL floor in native-token units. The Aurora pool
// source (auroraPoolsSource.ts) uses this as the tracked-ETH threshold in its
// TS-replicated admission union — it deliberately fetches unfloored from SQL,
// since a SQL floor would drop the high-liquidity band and bypass-hook pools.
export function trackedEthThresholdFor(
  protocol: Protocol,
  chainId: number
): number {
  const isBase = chainId === ChainId.BASE;
  switch (protocol) {
    case Protocol.V2:
      return isBase ? v2BaseTrackedEthThreshold : v2TrackedEthThreshold;
    case Protocol.V3:
      return isBase ? v3BaseTrackedEthThreshold : v3TrackedEthThreshold;
    default:
      return isBase ? v4BaseTrackedEthThreshold : v4TrackedEthThreshold;
  }
}

// The per-protocol untracked-USD admission threshold of Aurora's admission
// union.
export function untrackedUsdThresholdFor(
  protocol: Protocol,
  _chainId: number
): number {
  switch (protocol) {
    case Protocol.V2:
      return v2UntrackedUsdThreshold;
    case Protocol.V3:
      return v3UntrackedUsdThreshold;
    default:
      return v4UntrackedUsdThreshold;
  }
}

// The aggregator-hook pools of a V4 combo: the hooks whose pools are read,
// and the RPC provider that values them through each hook's
// pseudoTotalValueLocked.
export interface AggHooksPoolSourceConfig {
  hookAddresses: readonly string[];
  ethersProvider: ethers.providers.BaseProvider;
  // Keep only the pools whose hook reports liquidity it holds outside the
  // PoolManager.
  useExternalLiquidity: boolean;
}

export interface ChainProtocol {
  protocol: Protocol;
  chainId: ChainId;
  // V4 combos with listed aggregator hooks; the source is built by
  // applyAuroraExtraPoolSources.
  aggHooks?: AggHooksPoolSourceConfig;
  // The combo's pool source, installed by applyAuroraPoolSources. A combo
  // left without one (no Aurora read for it, or the Aurora client failed to
  // initialize) is skipped by cacheAllPools and keeps its previous snapshot.
  provider?:
    | ISubgraphProvider<V2SubgraphPool>
    | ISubgraphProvider<V3SubgraphPool>
    | ISubgraphProvider<V4SubgraphPool>;
  // Set by applyAuroraExtraPoolSources, never here.
  extraPoolSources?: ExtraPoolSources;
}

// Order is the cron's batch order: the V3 sets first, then V2, then V4.
const V3_CHAIN_IDS: readonly ChainId[] = [
  ChainId.MAINNET,
  ChainId.ARBITRUM_ONE,
  ChainId.POLYGON,
  ChainId.OPTIMISM,
  ChainId.CELO,
  ChainId.BNB,
  ChainId.AVALANCHE,
  ChainId.BASE,
  ChainId.BLAST,
  ChainId.UNICHAIN,
  ChainId.WORLDCHAIN,
  ChainId.ZORA,
  ChainId.SONEIUM,
  ChainId.MONAD,
  CHAIN_ID_TEMPO,
  ChainId.XLAYER,
  ChainId.LINEA,
  CHAIN_ID_MEGAETH,
  CHAIN_ID_ROBINHOOD,
  CHAIN_ID_ARC,
  ChainId.INK,
];

const V2_CHAIN_IDS: readonly ChainId[] = [
  ChainId.MAINNET,
  ChainId.ARBITRUM_ONE,
  ChainId.POLYGON,
  ChainId.OPTIMISM,
  ChainId.BNB,
  ChainId.AVALANCHE,
  ChainId.BASE,
  ChainId.BLAST,
  ChainId.WORLDCHAIN,
  ChainId.UNICHAIN,
  ChainId.SONEIUM,
  ChainId.MONAD,
  CHAIN_ID_TEMPO,
  ChainId.XLAYER,
  ChainId.LINEA,
  CHAIN_ID_MEGAETH,
  CHAIN_ID_ROBINHOOD,
  CHAIN_ID_ARC,
  ChainId.INK,
];

const V4_CHAIN_IDS: readonly ChainId[] = [
  ChainId.SEPOLIA,
  ChainId.ARBITRUM_ONE,
  ChainId.BASE,
  ChainId.POLYGON,
  ChainId.WORLDCHAIN,
  ChainId.ZORA,
  ChainId.UNICHAIN,
  ChainId.BLAST,
  ChainId.MAINNET,
  ChainId.SONEIUM,
  ChainId.OPTIMISM,
  ChainId.BNB,
  ChainId.MONAD,
  CHAIN_ID_TEMPO,
  ChainId.XLAYER,
  ChainId.AVALANCHE,
  ChainId.CELO,
  ChainId.LINEA,
  CHAIN_ID_MEGAETH,
  CHAIN_ID_ROBINHOOD,
  CHAIN_ID_ARC,
  ChainId.INK,
];

// The chains with an aggregator-hook allowlist. A chain whose list is empty
// (Base, while PancakeSwapV3's singleton is expired) has no source to read
// until a replacement is listed. Tempo's hook holds its liquidity outside the
// PoolManager, so only pools with external liquidity are kept there.
const AGG_HOOKS_BY_CHAIN: ReadonlyMap<
  ChainId,
  Omit<AggHooksPoolSourceConfig, 'ethersProvider'>
> = new Map([
  [
    ChainId.BASE,
    {hookAddresses: AGG_HOOKS_ON_BASE, useExternalLiquidity: false},
  ],
  [
    ChainId.MAINNET,
    {hookAddresses: AGG_HOOKS_ON_MAINNET, useExternalLiquidity: false},
  ],
  [
    CHAIN_ID_TEMPO,
    {hookAddresses: AGG_HOOKS_ON_TEMPO, useExternalLiquidity: true},
  ],
]);

export function createChainProtocols(): ChainProtocol[] {
  // The RPC endpoint for the chains that need on-chain pseudoTotalValueLocked
  // calls. Prefers the v2-internal gateway, like cronService's CCA reads and
  // DynamicZlcaHooksRefresher: UNI_RPC_ENDPOINT's hostname does not resolve
  // from the cron container (getaddrinfo ENOTFOUND on every pseudoTVL read
  // since 2026-06-16, ROUTE-2067).
  const uniRpcEndpoint =
    process.env.UNI_RPC_V2_INTERNAL_ENDPOINT || process.env.UNI_RPC_ENDPOINT;
  const aggHooksFor = (
    chainId: ChainId
  ): AggHooksPoolSourceConfig | undefined => {
    const hooks = AGG_HOOKS_BY_CHAIN.get(chainId);
    if (!hooks || hooks.hookAddresses.length === 0 || !uniRpcEndpoint) {
      return undefined;
    }
    return {
      ...hooks,
      ethersProvider: new ethers.providers.StaticJsonRpcProvider(
        `${uniRpcEndpoint}/rpc/${chainId}`,
        chainId
      ),
    };
  };

  return [
    ...V3_CHAIN_IDS.map(chainId => ({protocol: Protocol.V3, chainId})),
    ...V2_CHAIN_IDS.map(chainId => ({protocol: Protocol.V2, chainId})),
    ...V4_CHAIN_IDS.map((chainId): ChainProtocol => {
      const aggHooks = aggHooksFor(chainId);
      return aggHooks
        ? {protocol: Protocol.V4, chainId, aggHooks}
        : {protocol: Protocol.V4, chainId};
    }),
  ];
}
