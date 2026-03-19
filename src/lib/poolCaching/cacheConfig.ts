/**
 * Ported from routing-api/lib/cron/cache-config.ts
 * Defines chain+protocol matrix and subgraph provider instantiation for pool caching.
 */

import { Protocol } from '@uniswap/router-sdk';
import { ChainId } from '@uniswap/sdk-core';

// TEMPO is not yet in sdk-core 7.11.0 — define locally until sdk-core is upgraded
const CHAIN_ID_TEMPO = 4217 as ChainId;

import {
  V2SubgraphProvider,
  V3SubgraphProvider,
  V4SubgraphProvider,
  EulerSwapHooksSubgraphProvider,
} from './sor-providers';

import { Logger } from './sor-providers/util/log';
import { IMetric } from './sor-providers/util/metric';

import {
  ZORA_CREATOR_HOOK_ON_BASE_v1,
  ZORA_CREATOR_HOOK_ON_BASE_v1_0_0_1,
  ZORA_CREATOR_HOOK_ON_BASE_v1_1_1,
  ZORA_CREATOR_HOOK_ON_BASE_v1_1_1_1,
  ZORA_CREATOR_HOOK_ON_BASE_v1_1_2,
  ZORA_CREATOR_HOOK_ON_BASE_v2_2,
  ZORA_CREATOR_HOOK_ON_BASE_v2_2_1,
  ZORA_POST_HOOK_ON_BASE_v1,
  ZORA_POST_HOOK_ON_BASE_v1_0_0_1,
  ZORA_POST_HOOK_ON_BASE_v1_0_0_2,
  ZORA_POST_HOOK_ON_BASE_v1_1_1,
  ZORA_POST_HOOK_ON_BASE_v1_1_1_1,
  ZORA_POST_HOOK_ON_BASE_v1_1_2,
  ZORA_POST_HOOK_ON_BASE_v2_2,
  ZORA_POST_HOOK_ON_BASE_v2_2_1,
  ZORA_POST_HOOK_ON_BASE_v2_3_0,
  CLANKER_DYNAMIC_FEE_HOOKS_ADDRESS_ON_BASE,
  CLANKER_STATIC_FEE_HOOKS_ADDRESS_ON_BASE,
  CLANKER_DYNAMIC_FEE_HOOKS_ADDRESS_ON_BASE_v2,
  CLANKER_STATIC_FEE_HOOKS_ADDRESS_ON_BASE_v2,
  CLANKER_DYNAMIC_FEE_HOOKS_ADDRESS_ON_ARBITRUM,
  CLANKER_STATIC_FEE_HOOKS_ADDRESS_ON_ARBITRUM,
  CLANKER_DYNAMIC_FEE_HOOKS_ADDRESS_ON_UNICHAIN,
  CLANKER_STATIC_FEE_HOOKS_ADDRESS_ON_UNICHAIN,
  CLANKER_STATIC_FEE_HOOKS_ADDRESS_ON_MAINNET,
  CLANKER_STATIC_FEE_HOOKS_ADDRESS_ON_MONAD,
  DOPPLER_HOOKS_ADDRESS_ON_BASE,
  DOPPLER_HOOKS_ADDRESS_ON_BASE_V2,
} from './util/hooksAddressesAllowlist';

// Zora hooks addresses for V4 filtering - MUST be lowercase
export const ZORA_HOOKS_FOR_V4_SUBGRAPH_FILTERING = new Set([
  ZORA_CREATOR_HOOK_ON_BASE_v1,
  ZORA_CREATOR_HOOK_ON_BASE_v1_0_0_1,
  ZORA_CREATOR_HOOK_ON_BASE_v1_1_1,
  ZORA_CREATOR_HOOK_ON_BASE_v1_1_1_1,
  ZORA_CREATOR_HOOK_ON_BASE_v1_1_2,
  ZORA_CREATOR_HOOK_ON_BASE_v2_2,
  ZORA_CREATOR_HOOK_ON_BASE_v2_2_1,
  ZORA_POST_HOOK_ON_BASE_v1,
  ZORA_POST_HOOK_ON_BASE_v1_0_0_1,
  ZORA_POST_HOOK_ON_BASE_v1_0_0_2,
  ZORA_POST_HOOK_ON_BASE_v1_1_1,
  ZORA_POST_HOOK_ON_BASE_v1_1_1_1,
  ZORA_POST_HOOK_ON_BASE_v1_1_2,
  ZORA_POST_HOOK_ON_BASE_v2_2,
  ZORA_POST_HOOK_ON_BASE_v2_2_1,
  ZORA_POST_HOOK_ON_BASE_v2_3_0,
]);

// Per-chain hooks sets for V4SubgraphProvider low-TVL filtering (uses trackedZoraEthThreshold = 0.001)
export const HOOKS_FOR_V4_SUBGRAPH_LOW_TVL_FILTERING_ON_BASE = new Set([
  ...ZORA_HOOKS_FOR_V4_SUBGRAPH_FILTERING,
  CLANKER_DYNAMIC_FEE_HOOKS_ADDRESS_ON_BASE,
  CLANKER_STATIC_FEE_HOOKS_ADDRESS_ON_BASE,
  CLANKER_DYNAMIC_FEE_HOOKS_ADDRESS_ON_BASE_v2,
  CLANKER_STATIC_FEE_HOOKS_ADDRESS_ON_BASE_v2,
  DOPPLER_HOOKS_ADDRESS_ON_BASE,
  DOPPLER_HOOKS_ADDRESS_ON_BASE_V2,
]);

export const HOOKS_FOR_V4_SUBGRAPH_LOW_TVL_FILTERING_ON_UNICHAIN = new Set([
  CLANKER_DYNAMIC_FEE_HOOKS_ADDRESS_ON_UNICHAIN,
  CLANKER_STATIC_FEE_HOOKS_ADDRESS_ON_UNICHAIN,
]);

export const HOOKS_FOR_V4_SUBGRAPH_LOW_TVL_FILTERING_ON_ARBITRUM = new Set([
  CLANKER_DYNAMIC_FEE_HOOKS_ADDRESS_ON_ARBITRUM,
  CLANKER_STATIC_FEE_HOOKS_ADDRESS_ON_ARBITRUM,
]);

export const HOOKS_FOR_V4_SUBGRAPH_LOW_TVL_FILTERING_ON_MAINNET = new Set([
  CLANKER_STATIC_FEE_HOOKS_ADDRESS_ON_MAINNET,
]);

export const HOOKS_FOR_V4_SUBGRAPH_LOW_TVL_FILTERING_ON_MONAD = new Set([
  CLANKER_STATIC_FEE_HOOKS_ADDRESS_ON_MONAD,
]);

// --- Subgraph URL overrides (read from environment at init time) ---

export const v4SubgraphUrlOverride = (chainId: ChainId): string | undefined => {
  switch (chainId) {
    case ChainId.SEPOLIA:
      return `https://api.aws-us-east-1.goldsky.com/c/uniswap2/gn/subgraphs/id/${process.env.GOLD_SKY_ETHEREUM_SEPOLIA_V4_ID}`;
    case ChainId.ARBITRUM_ONE:
      return `https://api.aws-us-east-1.goldsky.com/c/uniswap2/gn/subgraphs/id/${process.env.GOLD_SKY_ARBITRUM_V4_ID}`;
    case ChainId.BASE:
      return `https://gateway.thegraph.com/api/deployments/id/${process.env.GRAPH_BASE_V4_DEPLOYMENT_ID}/indexers/id/${process.env.GRAPH_BASE_V4_INDEX_ID}`;
    case ChainId.POLYGON:
      return `https://api.aws-us-east-1.goldsky.com/c/uniswap2/gn/subgraphs/id/${process.env.GOLD_SKY_POLYGON_V4_ID}`;
    case ChainId.WORLDCHAIN:
      return `https://api.aws-us-east-1.goldsky.com/c/uniswap2/gn/subgraphs/id/${process.env.GOLD_SKY_WORLDCHAIN_V4_ID}`;
    case ChainId.ZORA:
      return `https://api.aws-us-east-1.goldsky.com/c/uniswap2/gn/subgraphs/id/${process.env.GOLD_SKY_ZORA_V4_ID}`;
    case ChainId.UNICHAIN:
      return `https://api.aws-us-east-1.goldsky.com/c/uniswap2/gn/subgraphs/id/${process.env.GOLD_SKY_UNICHAIN_V4_ID}`;
    case ChainId.BNB:
      return `https://api.aws-us-east-1.goldsky.com/c/uniswap2/gn/subgraphs/id/${process.env.GOLD_SKY_BNB_V4_ID}`;
    case ChainId.BLAST:
      return `https://api.aws-us-east-1.goldsky.com/c/uniswap2/gn/subgraphs/id/${process.env.GOLD_SKY_BLAST_V4_ID}`;
    case ChainId.MAINNET:
      return `https://api.aws-us-east-1.goldsky.com/c/uniswap2/gn/subgraphs/id/${process.env.GOLD_SKY_ETHEREUM_V4_ID}`;
    case ChainId.SONEIUM:
      return `https://api.aws-us-east-1.goldsky.com/c/uniswap2/gn/subgraphs/id/${process.env.GOLD_SKY_SONEIUM_V4_ID}`;
    case ChainId.OPTIMISM:
      return `https://api.aws-us-east-1.goldsky.com/c/uniswap2/gn/subgraphs/id/${process.env.GOLD_SKY_OPTIMISM_V4_ID}`;
    case ChainId.MONAD:
      return `https://api.goldsky.com/api/private/${process.env.GOLD_SKY_API_KEY}/subgraphs/uniswap-v4-monad/prod/gn`;
    case CHAIN_ID_TEMPO:
      return `https://api.goldsky.com/api/private/${process.env.GOLD_SKY_API_KEY}/subgraphs/uniswap-v4-tempo/prod/gn`;
    case ChainId.XLAYER:
      return `https://gateway.thegraph.com/api/subgraphs/id/${process.env.GRAPH_XLAYER_V4_ID}`;
    case ChainId.AVALANCHE:
      return `https://api.aws-us-east-1.goldsky.com/c/uniswap2/gn/subgraphs/id/${process.env.GOLD_SKY_AVALANCHE_V4_ID}`;
    case ChainId.LINEA:
      return `https://api.goldsky.com/api/private/${process.env.GOLD_SKY_API_KEY}/subgraphs/uniswap-v4-linea/prod/gn`;
    default:
      return undefined;
  }
};

export const v3SubgraphUrlOverride = (chainId: ChainId): string | undefined => {
  switch (chainId) {
    case ChainId.MAINNET:
      return `https://api.aws-us-east-1.goldsky.com/c/uniswap2/gn/subgraphs/id/${process.env.GOLD_SKY_ETHEREUM_V3_ID}`;
    case ChainId.ARBITRUM_ONE:
      return `https://api.aws-us-east-1.goldsky.com/c/uniswap2/gn/subgraphs/id/${process.env.GOLD_SKY_ARBITRUM_V3_ID}`;
    case ChainId.POLYGON:
      return `https://api.aws-us-east-1.goldsky.com/c/uniswap2/gn/subgraphs/id/${process.env.GOLD_SKY_POLYGON_V3_ID}`;
    case ChainId.OPTIMISM:
      return `https://api.aws-us-east-1.goldsky.com/c/uniswap2/gn/subgraphs/id/${process.env.GOLD_SKY_OPTIMISM_V3_ID}`;
    case ChainId.AVALANCHE:
      return `https://api.aws-us-east-1.goldsky.com/c/uniswap2/gn/subgraphs/id/${process.env.GOLD_SKY_AVALANCHE_V3_ID}`;
    case ChainId.BNB:
      return `https://api.aws-us-east-1.goldsky.com/c/uniswap2/gn/subgraphs/id/${process.env.GOLD_SKY_BNB_V3_ID}`;
    case ChainId.BLAST:
      return `https://api.aws-us-east-1.goldsky.com/c/uniswap2/gn/subgraphs/id/${process.env.GOLD_SKY_BLAST_V3_ID}`;
    case ChainId.BASE:
      return `https://api.aws-us-east-1.goldsky.com/c/uniswap2/gn/subgraphs/id/${process.env.GOLD_SKY_BASE_V3_ID}`;
    case ChainId.CELO:
      return `https://api.aws-us-east-1.goldsky.com/c/uniswap2/gn/subgraphs/id/${process.env.GOLD_SKY_CELO_V3_ID}`;
    case ChainId.WORLDCHAIN:
      return `https://api.aws-us-east-1.goldsky.com/c/uniswap2/gn/subgraphs/id/${process.env.GOLD_SKY_WORLDCHAIN_V3_ID}`;
    case ChainId.UNICHAIN_SEPOLIA:
      return `https://api.aws-us-east-1.goldsky.com/c/uniswap2/gn/subgraphs/id/${process.env.GOLD_SKY_ASTROCHAIN_SEPOLIA_V3_ID}`;
    case ChainId.UNICHAIN:
      return `https://api.aws-us-east-1.goldsky.com/c/uniswap2/gn/subgraphs/id/${process.env.GOLD_SKY_UNICHAIN_V3_ID}`;
    case ChainId.ZORA:
      return `https://api.aws-us-east-1.goldsky.com/c/uniswap2/gn/subgraphs/id/${process.env.GOLD_SKY_ZORA_V3_ID}`;
    case ChainId.SONEIUM:
      return `https://api.aws-us-east-1.goldsky.com/c/uniswap2/gn/subgraphs/id/${process.env.GOLD_SKY_SONEIUM_V3_ID}`;
    case ChainId.MONAD:
      return `https://api.goldsky.com/api/private/${process.env.GOLD_SKY_API_KEY}/subgraphs/uniswap-v3-monad/prod/gn`;
    case CHAIN_ID_TEMPO:
      return `https://api.goldsky.com/api/private/${process.env.GOLD_SKY_API_KEY}/subgraphs/uniswap-v3-tempo/prod/gn`;
    case ChainId.XLAYER:
      return `https://gateway.thegraph.com/api/subgraphs/id/${process.env.GRAPH_XLAYER_V3_ID}`;
    case ChainId.LINEA:
      return `https://api.goldsky.com/api/private/${process.env.GOLD_SKY_API_KEY}/subgraphs/uniswap-v3-linea/prod/gn`;
    default:
      return undefined;
  }
};

export const v2SubgraphUrlOverride = (chainId: ChainId): string | undefined => {
  switch (chainId) {
    case ChainId.MAINNET:
      return `https://api.aws-us-east-1.goldsky.com/c/uniswap/gn/subgraphs/id/${process.env.GOLD_SKY_ETHEREUM_V2_ID}`;
    case ChainId.ARBITRUM_ONE:
      return `https://api.aws-us-east-1.goldsky.com/c/uniswap/gn/subgraphs/id/${process.env.GOLD_SKY_ARBITRUM_V2_ID}`;
    case ChainId.POLYGON:
      return `https://api.aws-us-east-1.goldsky.com/c/uniswap/gn/subgraphs/id/${process.env.GOLD_SKY_POLYGON_V2_ID}`;
    case ChainId.OPTIMISM:
      return `https://api.aws-us-east-1.goldsky.com/c/uniswap/gn/subgraphs/id/${process.env.GOLD_SKY_OPTIMISM_V2_ID}`;
    case ChainId.AVALANCHE:
      return `https://api.aws-us-east-1.goldsky.com/c/uniswap/gn/subgraphs/id/${process.env.GOLD_SKY_AVALANCHE_V2_ID}`;
    case ChainId.BNB:
      return `https://api.aws-us-east-1.goldsky.com/c/uniswap/gn/subgraphs/id/${process.env.GOLD_SKY_BNB_V2_ID}`;
    case ChainId.BLAST:
      return `https://api.aws-us-east-1.goldsky.com/c/uniswap/gn/subgraphs/id/${process.env.GOLD_SKY_BLAST_V2_ID}`;
    case ChainId.BASE:
      return `https://api.aws-us-east-1.goldsky.com/c/uniswap/gn/subgraphs/id/${process.env.GOLD_SKY_BASE_V2_ID}`;
    case ChainId.WORLDCHAIN:
      return `https://api.aws-us-east-1.goldsky.com/c/uniswap/gn/subgraphs/id/${process.env.GOLD_SKY_WORLDCHAIN_V2_ID}`;
    case ChainId.UNICHAIN_SEPOLIA:
      return `https://api.aws-us-east-1.goldsky.com/c/uniswap/gn/subgraphs/id/${process.env.GOLD_SKY_ASTROCHAIN_SEPOLIA_V2_ID}`;
    case ChainId.MONAD_TESTNET:
      return `https://api.aws-us-east-1.goldsky.com/c/uniswap/gn/subgraphs/id/${process.env.GOLD_SKY_MONAD_TESTNET_V2_ID}`;
    case ChainId.UNICHAIN:
      return `https://api.aws-us-east-1.goldsky.com/c/uniswap/gn/subgraphs/id/${process.env.GOLD_SKY_UNICHAIN_V2_ID}`;
    case ChainId.SONEIUM:
      return `https://api.aws-us-east-1.goldsky.com/c/uniswap/gn/subgraphs/id/${process.env.GOLD_SKY_SONEIUM_V2_ID}`;
    case ChainId.MONAD:
      return `https://api.goldsky.com/api/private/${process.env.GOLD_SKY_API_KEY}/subgraphs/uniswap-v2-monad/prod/gn`;
    case CHAIN_ID_TEMPO:
      return `https://api.goldsky.com/api/private/${process.env.GOLD_SKY_API_KEY}/subgraphs/uniswap-v2-tempo/prod/gn`;
    case ChainId.XLAYER:
      return `https://gateway.thegraph.com/api/subgraphs/id/${process.env.GRAPH_XLAYER_V2_ID}`;
    case ChainId.LINEA:
      return `https://api.goldsky.com/api/private/${process.env.GOLD_SKY_API_KEY}/subgraphs/uniswap-v2-linea/prod/gn`;
    default:
      return undefined;
  }
};

// --- Threshold constants ---

const v4TrackedEthThreshold = 0.01;
const v4BaseTrackedEthThreshold = 0.1;
const v4BaseZoraTrackedEthThreshold = 0.001;
const v4UntrackedUsdThreshold = 0;

export const v3TrackedEthThreshold = 0.01;
export const v3BaseTrackedEthThreshold = 0.1;
const v3UntrackedUsdThreshold = 25000;

export const v2TrackedEthThreshold = 0.025;
export const v2BaseTrackedEthThreshold = 0.1;
const v2UntrackedUsdThreshold = Number.MAX_VALUE;

// --- Chain protocol definitions ---

export interface ChainProtocol {
  protocol: Protocol;
  chainId: ChainId;
  timeout: number;
  provider: V2SubgraphProvider | V3SubgraphProvider | V4SubgraphProvider;
  eulerHooksProvider?: EulerSwapHooksSubgraphProvider;
}

export function createChainProtocols(logger: Logger, metric: IMetric): ChainProtocol[] {
  return [
  // V3
  {
    protocol: Protocol.V3,
    chainId: ChainId.MAINNET,
    timeout: 90000,
    provider: new V3SubgraphProvider(ChainId.MAINNET, 3, 90000, true, v3TrackedEthThreshold, v3UntrackedUsdThreshold, v3SubgraphUrlOverride(ChainId.MAINNET), undefined, logger, metric),
  },
  {
    protocol: Protocol.V3,
    chainId: ChainId.ARBITRUM_ONE,
    timeout: 90000,
    provider: new V3SubgraphProvider(ChainId.ARBITRUM_ONE, 5, 90000, true, v3TrackedEthThreshold, v3UntrackedUsdThreshold, v3SubgraphUrlOverride(ChainId.ARBITRUM_ONE), undefined, logger, metric),
  },
  {
    protocol: Protocol.V3,
    chainId: ChainId.POLYGON,
    timeout: 90000,
    provider: new V3SubgraphProvider(ChainId.POLYGON, 3, 90000, true, v3TrackedEthThreshold, v3UntrackedUsdThreshold, v3SubgraphUrlOverride(ChainId.POLYGON), undefined, logger, metric),
  },
  {
    protocol: Protocol.V3,
    chainId: ChainId.OPTIMISM,
    timeout: 90000,
    provider: new V3SubgraphProvider(ChainId.OPTIMISM, 3, 90000, true, v3TrackedEthThreshold, v3UntrackedUsdThreshold, v3SubgraphUrlOverride(ChainId.OPTIMISM), undefined, logger, metric),
  },
  {
    protocol: Protocol.V3,
    chainId: ChainId.CELO,
    timeout: 90000,
    provider: new V3SubgraphProvider(ChainId.CELO, 3, 90000, true, v3TrackedEthThreshold, v3UntrackedUsdThreshold, v3SubgraphUrlOverride(ChainId.CELO), undefined, logger, metric),
  },
  {
    protocol: Protocol.V3,
    chainId: ChainId.BNB,
    timeout: 90000,
    provider: new V3SubgraphProvider(ChainId.BNB, 3, 90000, true, v3TrackedEthThreshold, v3UntrackedUsdThreshold, v3SubgraphUrlOverride(ChainId.BNB), undefined, logger, metric),
  },
  {
    protocol: Protocol.V3,
    chainId: ChainId.AVALANCHE,
    timeout: 90000,
    provider: new V3SubgraphProvider(ChainId.AVALANCHE, 3, 90000, true, v3TrackedEthThreshold, v3UntrackedUsdThreshold, v3SubgraphUrlOverride(ChainId.AVALANCHE), undefined, logger, metric),
  },
  {
    protocol: Protocol.V3,
    chainId: ChainId.BASE,
    timeout: 90000,
    provider: new V3SubgraphProvider(ChainId.BASE, 3, 900000, true, v3BaseTrackedEthThreshold, v3UntrackedUsdThreshold, v3SubgraphUrlOverride(ChainId.BASE), undefined, logger, metric),
  },
  {
    protocol: Protocol.V3,
    chainId: ChainId.BLAST,
    timeout: 90000,
    provider: new V3SubgraphProvider(ChainId.BLAST, 3, 90000, true, v3TrackedEthThreshold, v3UntrackedUsdThreshold, v3SubgraphUrlOverride(ChainId.BLAST), undefined, logger, metric),
  },
  {
    protocol: Protocol.V3,
    chainId: ChainId.UNICHAIN,
    timeout: 90000,
    provider: new V3SubgraphProvider(ChainId.UNICHAIN, 3, 90000, true, v3TrackedEthThreshold, v3UntrackedUsdThreshold, v3SubgraphUrlOverride(ChainId.UNICHAIN), undefined, logger, metric),
  },
  {
    protocol: Protocol.V3,
    chainId: ChainId.WORLDCHAIN,
    timeout: 90000,
    provider: new V3SubgraphProvider(ChainId.WORLDCHAIN, 3, 90000, true, v3TrackedEthThreshold, v3UntrackedUsdThreshold, v3SubgraphUrlOverride(ChainId.WORLDCHAIN), undefined, logger, metric),
  },
  {
    protocol: Protocol.V3,
    chainId: ChainId.ZORA,
    timeout: 90000,
    provider: new V3SubgraphProvider(ChainId.ZORA, 3, 360000, true, v3TrackedEthThreshold, v3UntrackedUsdThreshold, v3SubgraphUrlOverride(ChainId.ZORA), undefined, logger, metric),
  },
  {
    protocol: Protocol.V3,
    chainId: ChainId.SONEIUM,
    timeout: 90000,
    provider: new V3SubgraphProvider(ChainId.SONEIUM, 3, 90000, true, v3TrackedEthThreshold, v3UntrackedUsdThreshold, v3SubgraphUrlOverride(ChainId.SONEIUM), undefined, logger, metric),
  },
  {
    protocol: Protocol.V3,
    chainId: ChainId.MONAD,
    timeout: 90000,
    provider: new V3SubgraphProvider(ChainId.MONAD, 3, 90000, true, v3TrackedEthThreshold, v3UntrackedUsdThreshold, v3SubgraphUrlOverride(ChainId.MONAD), process.env.GOLD_SKY_BEARER_TOKEN, logger, metric),
  },
  {
    protocol: Protocol.V3,
    chainId: CHAIN_ID_TEMPO,
    timeout: 90000,
    provider: new V3SubgraphProvider(CHAIN_ID_TEMPO, 3, 90000, true, v3TrackedEthThreshold, v3UntrackedUsdThreshold, v3SubgraphUrlOverride(CHAIN_ID_TEMPO), process.env.GOLD_SKY_BEARER_TOKEN, logger, metric),
  },
  {
    protocol: Protocol.V3,
    chainId: ChainId.XLAYER,
    timeout: 90000,
    provider: new V3SubgraphProvider(ChainId.XLAYER, 3, 90000, true, v3TrackedEthThreshold, v3UntrackedUsdThreshold, v3SubgraphUrlOverride(ChainId.XLAYER), process.env.GRAPH_BEARER_TOKEN, logger, metric),
  },
  {
    protocol: Protocol.V3,
    chainId: ChainId.LINEA,
    timeout: 90000,
    provider: new V3SubgraphProvider(ChainId.LINEA, 3, 90000, true, v3TrackedEthThreshold, v3UntrackedUsdThreshold, v3SubgraphUrlOverride(ChainId.LINEA), process.env.GOLD_SKY_BEARER_TOKEN, logger, metric),
  },
  // V2
  {
    protocol: Protocol.V2,
    chainId: ChainId.MAINNET,
    timeout: 840000,
    provider: new V2SubgraphProvider(ChainId.MAINNET, 5, 900000, true, 1000, v2TrackedEthThreshold, v2UntrackedUsdThreshold, v2SubgraphUrlOverride(ChainId.MAINNET), undefined, logger, metric),
  },
  {
    protocol: Protocol.V2,
    chainId: ChainId.ARBITRUM_ONE,
    timeout: 90000,
    provider: new V2SubgraphProvider(ChainId.ARBITRUM_ONE, 3, 90000, true, 1000, v2TrackedEthThreshold, v2UntrackedUsdThreshold, v2SubgraphUrlOverride(ChainId.ARBITRUM_ONE), undefined, logger, metric),
  },
  {
    protocol: Protocol.V2,
    chainId: ChainId.POLYGON,
    timeout: 90000,
    provider: new V2SubgraphProvider(ChainId.POLYGON, 3, 90000, true, 1000, v2TrackedEthThreshold, v2UntrackedUsdThreshold, v2SubgraphUrlOverride(ChainId.POLYGON), undefined, logger, metric),
  },
  {
    protocol: Protocol.V2,
    chainId: ChainId.OPTIMISM,
    timeout: 90000,
    provider: new V2SubgraphProvider(ChainId.OPTIMISM, 3, 90000, true, 1000, v2TrackedEthThreshold, v2UntrackedUsdThreshold, v2SubgraphUrlOverride(ChainId.OPTIMISM), undefined, logger, metric),
  },
  {
    protocol: Protocol.V2,
    chainId: ChainId.BNB,
    timeout: 90000,
    provider: new V2SubgraphProvider(ChainId.BNB, 3, 90000, true, 1000, v2TrackedEthThreshold, v2UntrackedUsdThreshold, v2SubgraphUrlOverride(ChainId.BNB), undefined, logger, metric),
  },
  {
    protocol: Protocol.V2,
    chainId: ChainId.AVALANCHE,
    timeout: 90000,
    provider: new V2SubgraphProvider(ChainId.AVALANCHE, 3, 90000, true, 1000, v2TrackedEthThreshold, v2UntrackedUsdThreshold, v2SubgraphUrlOverride(ChainId.AVALANCHE), undefined, logger, metric),
  },
  {
    protocol: Protocol.V2,
    chainId: ChainId.BASE,
    timeout: 840000,
    provider: new V2SubgraphProvider(ChainId.BASE, 5, 900000, true, 10000, v2BaseTrackedEthThreshold, v2UntrackedUsdThreshold, v2SubgraphUrlOverride(ChainId.BASE), undefined, logger, metric),
  },
  {
    protocol: Protocol.V2,
    chainId: ChainId.BLAST,
    timeout: 90000,
    provider: new V2SubgraphProvider(ChainId.BLAST, 3, 90000, true, 1000, v2TrackedEthThreshold, v2UntrackedUsdThreshold, v2SubgraphUrlOverride(ChainId.BLAST), undefined, logger, metric),
  },
  {
    protocol: Protocol.V2,
    chainId: ChainId.WORLDCHAIN,
    timeout: 90000,
    provider: new V2SubgraphProvider(ChainId.WORLDCHAIN, 3, 90000, true, 1000, v2TrackedEthThreshold, v2UntrackedUsdThreshold, v2SubgraphUrlOverride(ChainId.WORLDCHAIN), undefined, logger, metric),
  },
  {
    protocol: Protocol.V2,
    chainId: ChainId.MONAD_TESTNET,
    timeout: 90000,
    provider: new V2SubgraphProvider(ChainId.MONAD_TESTNET, 3, 90000, true, 1000, v2TrackedEthThreshold, v2UntrackedUsdThreshold, v2SubgraphUrlOverride(ChainId.MONAD_TESTNET), undefined, logger, metric),
  },
  {
    protocol: Protocol.V2,
    chainId: ChainId.UNICHAIN,
    timeout: 90000,
    provider: new V2SubgraphProvider(ChainId.UNICHAIN, 3, 90000, true, 1000, v2TrackedEthThreshold, v2UntrackedUsdThreshold, v2SubgraphUrlOverride(ChainId.UNICHAIN), undefined, logger, metric),
  },
  {
    protocol: Protocol.V2,
    chainId: ChainId.SONEIUM,
    timeout: 90000,
    provider: new V2SubgraphProvider(ChainId.SONEIUM, 3, 90000, true, 1000, v2TrackedEthThreshold, v2UntrackedUsdThreshold, v2SubgraphUrlOverride(ChainId.SONEIUM), undefined, logger, metric),
  },
  {
    protocol: Protocol.V2,
    chainId: ChainId.MONAD,
    timeout: 90000,
    provider: new V2SubgraphProvider(ChainId.MONAD, 3, 90000, true, 1000, v2TrackedEthThreshold, v2UntrackedUsdThreshold, v2SubgraphUrlOverride(ChainId.MONAD), process.env.GOLD_SKY_BEARER_TOKEN, logger, metric),
  },
  {
    protocol: Protocol.V2,
    chainId: CHAIN_ID_TEMPO,
    timeout: 90000,
    provider: new V2SubgraphProvider(CHAIN_ID_TEMPO, 3, 90000, true, 1000, v2TrackedEthThreshold, v2UntrackedUsdThreshold, v2SubgraphUrlOverride(CHAIN_ID_TEMPO), process.env.GOLD_SKY_BEARER_TOKEN, logger, metric),
  },
  {
    protocol: Protocol.V2,
    chainId: ChainId.XLAYER,
    timeout: 90000,
    provider: new V2SubgraphProvider(ChainId.XLAYER, 3, 90000, true, 1000, v2TrackedEthThreshold, v2UntrackedUsdThreshold, v2SubgraphUrlOverride(ChainId.XLAYER), process.env.GRAPH_BEARER_TOKEN, logger, metric),
  },
  {
    protocol: Protocol.V2,
    chainId: ChainId.LINEA,
    timeout: 90000,
    provider: new V2SubgraphProvider(ChainId.LINEA, 3, 90000, true, 1000, v2TrackedEthThreshold, v2UntrackedUsdThreshold, v2SubgraphUrlOverride(ChainId.LINEA), process.env.GOLD_SKY_BEARER_TOKEN, logger, metric),
  },
  // V4
  {
    protocol: Protocol.V4,
    chainId: ChainId.SEPOLIA,
    timeout: 90000,
    provider: new V4SubgraphProvider(ChainId.SEPOLIA, 3, 90000, true, v4TrackedEthThreshold, v4BaseZoraTrackedEthThreshold, undefined, v4UntrackedUsdThreshold, v4SubgraphUrlOverride(ChainId.SEPOLIA), undefined, logger, metric),
  },
  {
    protocol: Protocol.V4,
    chainId: ChainId.ARBITRUM_ONE,
    timeout: 90000,
    provider: new V4SubgraphProvider(ChainId.ARBITRUM_ONE, 3, 90000, true, v4TrackedEthThreshold, v4BaseZoraTrackedEthThreshold, HOOKS_FOR_V4_SUBGRAPH_LOW_TVL_FILTERING_ON_ARBITRUM, v4UntrackedUsdThreshold, v4SubgraphUrlOverride(ChainId.ARBITRUM_ONE), undefined, logger, metric),
  },
  {
    protocol: Protocol.V4,
    chainId: ChainId.BASE,
    timeout: 90000,
    provider: new V4SubgraphProvider(ChainId.BASE, 3, 90000, true, v4BaseTrackedEthThreshold, v4BaseZoraTrackedEthThreshold, HOOKS_FOR_V4_SUBGRAPH_LOW_TVL_FILTERING_ON_BASE, v4UntrackedUsdThreshold, v4SubgraphUrlOverride(ChainId.BASE), process.env.GRAPH_BEARER_TOKEN, logger, metric),
  },
  {
    protocol: Protocol.V4,
    chainId: ChainId.POLYGON,
    timeout: 90000,
    provider: new V4SubgraphProvider(ChainId.POLYGON, 3, 90000, true, v4TrackedEthThreshold, v4BaseZoraTrackedEthThreshold, undefined, v4UntrackedUsdThreshold, v4SubgraphUrlOverride(ChainId.POLYGON), undefined, logger, metric),
  },
  {
    protocol: Protocol.V4,
    chainId: ChainId.WORLDCHAIN,
    timeout: 90000,
    provider: new V4SubgraphProvider(ChainId.WORLDCHAIN, 3, 90000, true, v4TrackedEthThreshold, v4BaseZoraTrackedEthThreshold, undefined, v4UntrackedUsdThreshold, v4SubgraphUrlOverride(ChainId.WORLDCHAIN), undefined, logger, metric),
  },
  {
    protocol: Protocol.V4,
    chainId: ChainId.ZORA,
    timeout: 90000,
    provider: new V4SubgraphProvider(ChainId.ZORA, 3, 90000, true, v4TrackedEthThreshold, v4BaseZoraTrackedEthThreshold, undefined, v4UntrackedUsdThreshold, v4SubgraphUrlOverride(ChainId.ZORA), undefined, logger, metric),
  },
  {
    protocol: Protocol.V4,
    chainId: ChainId.UNICHAIN,
    timeout: 90000,
    provider: new V4SubgraphProvider(ChainId.UNICHAIN, 3, 90000, true, v4TrackedEthThreshold, v4BaseZoraTrackedEthThreshold, HOOKS_FOR_V4_SUBGRAPH_LOW_TVL_FILTERING_ON_UNICHAIN, v4UntrackedUsdThreshold, v4SubgraphUrlOverride(ChainId.UNICHAIN), undefined, logger, metric),
    eulerHooksProvider: new EulerSwapHooksSubgraphProvider(ChainId.UNICHAIN, 3, 90000, true, v4SubgraphUrlOverride(ChainId.UNICHAIN), logger, metric),
  },
  {
    protocol: Protocol.V4,
    chainId: ChainId.BLAST,
    timeout: 90000,
    provider: new V4SubgraphProvider(ChainId.BLAST, 3, 90000, true, v4TrackedEthThreshold, v4BaseZoraTrackedEthThreshold, undefined, v4UntrackedUsdThreshold, v4SubgraphUrlOverride(ChainId.BLAST), undefined, logger, metric),
  },
  {
    protocol: Protocol.V4,
    chainId: ChainId.MAINNET,
    timeout: 90000,
    provider: new V4SubgraphProvider(ChainId.MAINNET, 3, 90000, true, v4TrackedEthThreshold, v4BaseZoraTrackedEthThreshold, HOOKS_FOR_V4_SUBGRAPH_LOW_TVL_FILTERING_ON_MAINNET, v4UntrackedUsdThreshold, v4SubgraphUrlOverride(ChainId.MAINNET), undefined, logger, metric),
    eulerHooksProvider: new EulerSwapHooksSubgraphProvider(ChainId.MAINNET, 3, 90000, true, v4SubgraphUrlOverride(ChainId.MAINNET), logger, metric),
  },
  {
    protocol: Protocol.V4,
    chainId: ChainId.SONEIUM,
    timeout: 90000,
    provider: new V4SubgraphProvider(ChainId.SONEIUM, 3, 90000, true, v4TrackedEthThreshold, v4BaseZoraTrackedEthThreshold, undefined, v4UntrackedUsdThreshold, v4SubgraphUrlOverride(ChainId.SONEIUM), undefined, logger, metric),
  },
  {
    protocol: Protocol.V4,
    chainId: ChainId.OPTIMISM,
    timeout: 90000,
    provider: new V4SubgraphProvider(ChainId.OPTIMISM, 3, 90000, true, v4TrackedEthThreshold, v4BaseZoraTrackedEthThreshold, undefined, v4UntrackedUsdThreshold, v4SubgraphUrlOverride(ChainId.OPTIMISM), undefined, logger, metric),
  },
  {
    protocol: Protocol.V4,
    chainId: ChainId.BNB,
    timeout: 90000,
    provider: new V4SubgraphProvider(ChainId.BNB, 3, 90000, true, v4TrackedEthThreshold, v4BaseZoraTrackedEthThreshold, undefined, v4UntrackedUsdThreshold, v4SubgraphUrlOverride(ChainId.BNB), undefined, logger, metric),
  },
  {
    protocol: Protocol.V4,
    chainId: ChainId.MONAD,
    timeout: 90000,
    provider: new V4SubgraphProvider(ChainId.MONAD, 3, 90000, true, v4TrackedEthThreshold, v4BaseZoraTrackedEthThreshold, HOOKS_FOR_V4_SUBGRAPH_LOW_TVL_FILTERING_ON_MONAD, v4UntrackedUsdThreshold, v4SubgraphUrlOverride(ChainId.MONAD), process.env.GOLD_SKY_BEARER_TOKEN, logger, metric),
  },
  {
    protocol: Protocol.V4,
    chainId: CHAIN_ID_TEMPO,
    timeout: 90000,
    provider: new V4SubgraphProvider(CHAIN_ID_TEMPO, 3, 90000, true, v4TrackedEthThreshold, v4BaseZoraTrackedEthThreshold, undefined, v4UntrackedUsdThreshold, v4SubgraphUrlOverride(CHAIN_ID_TEMPO), process.env.GOLD_SKY_BEARER_TOKEN, logger, metric),
  },
  {
    protocol: Protocol.V4,
    chainId: ChainId.XLAYER,
    timeout: 90000,
    provider: new V4SubgraphProvider(ChainId.XLAYER, 3, 90000, true, v4TrackedEthThreshold, v4BaseZoraTrackedEthThreshold, undefined, v4UntrackedUsdThreshold, v4SubgraphUrlOverride(ChainId.XLAYER), process.env.GRAPH_BEARER_TOKEN, logger, metric),
  },
  {
    protocol: Protocol.V4,
    chainId: ChainId.AVALANCHE,
    timeout: 90000,
    provider: new V4SubgraphProvider(ChainId.AVALANCHE, 3, 90000, true, v4TrackedEthThreshold, v4BaseZoraTrackedEthThreshold, undefined, v4UntrackedUsdThreshold, v4SubgraphUrlOverride(ChainId.AVALANCHE), undefined, logger, metric),
  },
  {
    protocol: Protocol.V4,
    chainId: ChainId.LINEA,
    timeout: 90000,
    provider: new V4SubgraphProvider(ChainId.LINEA, 3, 90000, true, v4TrackedEthThreshold, v4BaseZoraTrackedEthThreshold, undefined, v4UntrackedUsdThreshold, v4SubgraphUrlOverride(ChainId.LINEA), process.env.GOLD_SKY_BEARER_TOKEN, logger, metric),
  },
  ];
}
