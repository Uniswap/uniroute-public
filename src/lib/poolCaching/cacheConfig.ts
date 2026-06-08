/**
 * Ported from routing-api/lib/cron/cache-config.ts
 * Defines chain+protocol matrix and subgraph provider instantiation for pool caching.
 */

import {Protocol} from '@uniswap/router-sdk';
import {ChainId} from '@uniswap/sdk-core';
import {ethers} from 'ethers';

// TEMPO is not yet in sdk-core 7.11.0 — define locally until sdk-core is upgraded
const CHAIN_ID_TEMPO = 4217 as ChainId;
// MEGAETH is not in sdk-core — define locally until sdk-core is upgraded
const CHAIN_ID_MEGAETH = 4326 as ChainId;
// ROBINHOOD is not in sdk-core — define locally until sdk-core is upgraded
const CHAIN_ID_ROBINHOOD = 4663 as ChainId;
// ARC is not in sdk-core — define locally until sdk-core is upgraded
const CHAIN_ID_ARC = 5042 as ChainId;

import {
  V2SubgraphProvider,
  V3SubgraphProvider,
  V4SubgraphProvider,
  EulerSwapHooksSubgraphProvider,
  AggHooksSubgraphProvider,
} from './sor-providers';

import {Logger} from './sor-providers/util/log';
import {IMetric} from './sor-providers/util/metric';

import {
  AGG_HOOKS_ON_BASE,
  AGG_HOOKS_ON_MAINNET,
  AGG_HOOKS_ON_TEMPO,
} from './util/aggHooksAddressesAllowlist';

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
      return `https://gateway.thegraph.com/api/subgraphs/id/${process.env.GRAPH_BNB_V4_ID}`;
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
    case CHAIN_ID_MEGAETH:
      return `https://api.goldsky.com/api/private/${process.env.GOLD_SKY_API_KEY}/subgraphs/uniswap-v4-megaeth-mainnet/prod/gn`;
    case CHAIN_ID_ROBINHOOD:
      return `https://api.goldsky.com/api/private/${process.env.GOLD_SKY_API_KEY}/subgraphs/uniswap-v4-robinhood-mainnet/prod/gn`;
    case CHAIN_ID_ARC:
      return `https://api.goldsky.com/api/private/${process.env.GOLD_SKY_API_KEY}/subgraphs/uniswap-v4-arc-mainnet/prod/gn`;
    default:
      return undefined;
  }
};

export const v3SubgraphUrlOverride = (chainId: ChainId): string | undefined => {
  switch (chainId) {
    case ChainId.MAINNET:
      return `https://api.aws-us-east-1.goldsky.com/c/uniswap2/gn/subgraphs/id/${process.env.GOLD_SKY_ETHEREUM_V3_ID}`;
    case ChainId.ARBITRUM_ONE:
      return `https://gateway.thegraph.com/api/deployments/id/${process.env.GRAPH_ARBITRUM_V3_DEPLOYMENT_ID}/indexers/id/${process.env.GRAPH_ARBITRUM_V3_INDEX_ID}`;
    // TODO(ROUTE-1201): migrate POLYGON V3 to TheGraph once Ellipfra new version is synced.
    case ChainId.POLYGON:
      return `https://api.aws-us-east-1.goldsky.com/c/uniswap2/gn/subgraphs/id/${process.env.GOLD_SKY_POLYGON_V3_ID}`;
    // TODO(ROUTE-1201): migrate OPTIMISM V3 to TheGraph once Ellipfra new version is synced.
    case ChainId.OPTIMISM:
      return `https://api.aws-us-east-1.goldsky.com/c/uniswap2/gn/subgraphs/id/${process.env.GOLD_SKY_OPTIMISM_V3_ID}`;
    case ChainId.AVALANCHE:
      return `https://api.aws-us-east-1.goldsky.com/c/uniswap2/gn/subgraphs/id/${process.env.GOLD_SKY_AVALANCHE_V3_ID}`;
    case ChainId.BNB:
      return `https://gateway.thegraph.com/api/deployments/id/${process.env.GRAPH_BNB_V3_DEPLOYMENT_ID}/indexers/id/${process.env.GRAPH_BNB_V3_INDEX_ID}`;
    case ChainId.BLAST:
      return `https://api.aws-us-east-1.goldsky.com/c/uniswap2/gn/subgraphs/id/${process.env.GOLD_SKY_BLAST_V3_ID}`;
    case ChainId.BASE:
      return `https://gateway.thegraph.com/api/deployments/id/${process.env.GRAPH_BASE_V3_DEPLOYMENT_ID}/indexers/id/${process.env.GRAPH_BASE_V3_INDEX_ID}`;
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
    case CHAIN_ID_MEGAETH:
      return `https://api.goldsky.com/api/private/${process.env.GOLD_SKY_API_KEY}/subgraphs/uniswap-v3-megaeth-mainnet/prod/gn`;
    case CHAIN_ID_ROBINHOOD:
      return `https://api.goldsky.com/api/private/${process.env.GOLD_SKY_API_KEY}/subgraphs/uniswap-v3-robinhood-mainnet/prod/gn`;
    case CHAIN_ID_ARC:
      return `https://api.goldsky.com/api/private/${process.env.GOLD_SKY_API_KEY}/subgraphs/uniswap-v3-arc-mainnet/prod/gn`;
    default:
      return undefined;
  }
};

export const v2SubgraphUrlOverride = (chainId: ChainId): string | undefined => {
  switch (chainId) {
    case ChainId.MAINNET:
      return `https://gateway.thegraph.com/api/deployments/id/${process.env.GRAPH_MAINNET_V2_DEPLOYMENT_ID}/indexers/id/${process.env.GRAPH_MAINNET_V2_INDEX_ID}`;
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
      return `https://gateway.thegraph.com/api/deployments/id/${process.env.GRAPH_BASE_V2_DEPLOYMENT_ID}/indexers/id/${process.env.GRAPH_BASE_V2_INDEX_ID}`;
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
    case CHAIN_ID_MEGAETH:
      return `https://api.goldsky.com/api/private/${process.env.GOLD_SKY_API_KEY}/subgraphs/uniswap-v2-megaeth-mainnet/prod/gn`;
    case CHAIN_ID_ROBINHOOD:
      return `https://api.goldsky.com/api/private/${process.env.GOLD_SKY_API_KEY}/subgraphs/uniswap-v2-robinhood-mainnet/prod/gn`;
    case CHAIN_ID_ARC:
      return `https://api.goldsky.com/api/private/${process.env.GOLD_SKY_API_KEY}/subgraphs/uniswap-v2-arc-mainnet/prod/gn`;
    default:
      return undefined;
  }
};

// --- Threshold constants ---

const v4TrackedEthThreshold = 0.01;
const v4BaseTrackedEthThreshold = 0.1;
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
  aggHooksProvider?: AggHooksSubgraphProvider;
}

export function createChainProtocols(
  logger: Logger,
  metric: IMetric
): ChainProtocol[] {
  // Build an ethers provider for chains that need on-chain pseudoTotalValueLocked calls.
  // Uses the same UNI_RPC_ENDPOINT pattern as the main service (see dependencies.ts).
  const uniRpcEndpoint = process.env.UNI_RPC_ENDPOINT;
  const mainnetEthersProvider = uniRpcEndpoint
    ? new ethers.providers.StaticJsonRpcProvider(
        `${uniRpcEndpoint}/rpc/${ChainId.MAINNET}`,
        ChainId.MAINNET
      )
    : undefined;
  const baseEthersProvider = uniRpcEndpoint
    ? new ethers.providers.StaticJsonRpcProvider(
        `${uniRpcEndpoint}/rpc/${ChainId.BASE}`,
        ChainId.BASE
      )
    : undefined;
  const tempoEthersProvider = uniRpcEndpoint
    ? new ethers.providers.StaticJsonRpcProvider(
        `${uniRpcEndpoint}/rpc/${CHAIN_ID_TEMPO}`,
        CHAIN_ID_TEMPO
      )
    : undefined;

  return [
    // V3
    {
      protocol: Protocol.V3,
      chainId: ChainId.MAINNET,
      timeout: 90000,
      provider: new V3SubgraphProvider(
        ChainId.MAINNET,
        3,
        90000,
        true,
        v3TrackedEthThreshold,
        v3UntrackedUsdThreshold,
        v3SubgraphUrlOverride(ChainId.MAINNET),
        undefined,
        logger,
        metric
      ),
    },
    {
      protocol: Protocol.V3,
      chainId: ChainId.ARBITRUM_ONE,
      timeout: 90000,
      provider: new V3SubgraphProvider(
        ChainId.ARBITRUM_ONE,
        5,
        90000,
        true,
        v3TrackedEthThreshold,
        v3UntrackedUsdThreshold,
        v3SubgraphUrlOverride(ChainId.ARBITRUM_ONE),
        process.env.GRAPH_BEARER_TOKEN,
        logger,
        metric
      ),
    },
    {
      protocol: Protocol.V3,
      chainId: ChainId.POLYGON,
      timeout: 90000,
      provider: new V3SubgraphProvider(
        ChainId.POLYGON,
        3,
        90000,
        true,
        v3TrackedEthThreshold,
        v3UntrackedUsdThreshold,
        v3SubgraphUrlOverride(ChainId.POLYGON),
        undefined,
        logger,
        metric
      ),
    },
    {
      protocol: Protocol.V3,
      chainId: ChainId.OPTIMISM,
      timeout: 90000,
      provider: new V3SubgraphProvider(
        ChainId.OPTIMISM,
        3,
        90000,
        true,
        v3TrackedEthThreshold,
        v3UntrackedUsdThreshold,
        v3SubgraphUrlOverride(ChainId.OPTIMISM),
        undefined,
        logger,
        metric
      ),
    },
    {
      protocol: Protocol.V3,
      chainId: ChainId.CELO,
      timeout: 90000,
      provider: new V3SubgraphProvider(
        ChainId.CELO,
        3,
        90000,
        true,
        v3TrackedEthThreshold,
        v3UntrackedUsdThreshold,
        v3SubgraphUrlOverride(ChainId.CELO),
        undefined,
        logger,
        metric
      ),
    },
    {
      protocol: Protocol.V3,
      chainId: ChainId.BNB,
      timeout: 90000,
      provider: new V3SubgraphProvider(
        ChainId.BNB,
        3,
        90000,
        true,
        v3TrackedEthThreshold,
        v3UntrackedUsdThreshold,
        v3SubgraphUrlOverride(ChainId.BNB),
        process.env.GRAPH_BEARER_TOKEN,
        logger,
        metric
      ),
    },
    {
      protocol: Protocol.V3,
      chainId: ChainId.AVALANCHE,
      timeout: 90000,
      provider: new V3SubgraphProvider(
        ChainId.AVALANCHE,
        3,
        90000,
        true,
        v3TrackedEthThreshold,
        v3UntrackedUsdThreshold,
        v3SubgraphUrlOverride(ChainId.AVALANCHE),
        undefined,
        logger,
        metric
      ),
    },
    {
      protocol: Protocol.V3,
      chainId: ChainId.BASE,
      timeout: 90000,
      provider: new V3SubgraphProvider(
        ChainId.BASE,
        3,
        900000,
        true,
        v3BaseTrackedEthThreshold,
        v3UntrackedUsdThreshold,
        v3SubgraphUrlOverride(ChainId.BASE),
        process.env.GRAPH_BEARER_TOKEN,
        logger,
        metric
      ),
    },
    {
      protocol: Protocol.V3,
      chainId: ChainId.BLAST,
      timeout: 90000,
      provider: new V3SubgraphProvider(
        ChainId.BLAST,
        3,
        90000,
        true,
        v3TrackedEthThreshold,
        v3UntrackedUsdThreshold,
        v3SubgraphUrlOverride(ChainId.BLAST),
        undefined,
        logger,
        metric
      ),
    },
    {
      protocol: Protocol.V3,
      chainId: ChainId.UNICHAIN,
      timeout: 90000,
      provider: new V3SubgraphProvider(
        ChainId.UNICHAIN,
        3,
        90000,
        true,
        v3TrackedEthThreshold,
        v3UntrackedUsdThreshold,
        v3SubgraphUrlOverride(ChainId.UNICHAIN),
        undefined,
        logger,
        metric
      ),
    },
    {
      protocol: Protocol.V3,
      chainId: ChainId.WORLDCHAIN,
      timeout: 90000,
      provider: new V3SubgraphProvider(
        ChainId.WORLDCHAIN,
        3,
        90000,
        true,
        v3TrackedEthThreshold,
        v3UntrackedUsdThreshold,
        v3SubgraphUrlOverride(ChainId.WORLDCHAIN),
        undefined,
        logger,
        metric
      ),
    },
    {
      protocol: Protocol.V3,
      chainId: ChainId.ZORA,
      timeout: 90000,
      provider: new V3SubgraphProvider(
        ChainId.ZORA,
        3,
        360000,
        true,
        v3TrackedEthThreshold,
        v3UntrackedUsdThreshold,
        v3SubgraphUrlOverride(ChainId.ZORA),
        undefined,
        logger,
        metric
      ),
    },
    {
      protocol: Protocol.V3,
      chainId: ChainId.SONEIUM,
      timeout: 90000,
      provider: new V3SubgraphProvider(
        ChainId.SONEIUM,
        3,
        90000,
        true,
        v3TrackedEthThreshold,
        v3UntrackedUsdThreshold,
        v3SubgraphUrlOverride(ChainId.SONEIUM),
        undefined,
        logger,
        metric
      ),
    },
    {
      protocol: Protocol.V3,
      chainId: ChainId.MONAD,
      timeout: 90000,
      provider: new V3SubgraphProvider(
        ChainId.MONAD,
        3,
        90000,
        true,
        v3TrackedEthThreshold,
        v3UntrackedUsdThreshold,
        v3SubgraphUrlOverride(ChainId.MONAD),
        process.env.GOLD_SKY_BEARER_TOKEN,
        logger,
        metric
      ),
    },
    {
      protocol: Protocol.V3,
      chainId: CHAIN_ID_TEMPO,
      timeout: 90000,
      provider: new V3SubgraphProvider(
        CHAIN_ID_TEMPO,
        3,
        90000,
        true,
        v3TrackedEthThreshold,
        v3UntrackedUsdThreshold,
        v3SubgraphUrlOverride(CHAIN_ID_TEMPO),
        process.env.GOLD_SKY_BEARER_TOKEN,
        logger,
        metric
      ),
    },
    {
      protocol: Protocol.V3,
      chainId: ChainId.XLAYER,
      timeout: 90000,
      provider: new V3SubgraphProvider(
        ChainId.XLAYER,
        3,
        90000,
        true,
        v3TrackedEthThreshold,
        v3UntrackedUsdThreshold,
        v3SubgraphUrlOverride(ChainId.XLAYER),
        process.env.GRAPH_BEARER_TOKEN,
        logger,
        metric
      ),
    },
    {
      protocol: Protocol.V3,
      chainId: ChainId.LINEA,
      timeout: 90000,
      provider: new V3SubgraphProvider(
        ChainId.LINEA,
        3,
        90000,
        true,
        v3TrackedEthThreshold,
        v3UntrackedUsdThreshold,
        v3SubgraphUrlOverride(ChainId.LINEA),
        process.env.GOLD_SKY_BEARER_TOKEN,
        logger,
        metric
      ),
    },
    {
      protocol: Protocol.V3,
      chainId: CHAIN_ID_MEGAETH,
      timeout: 90000,
      provider: new V3SubgraphProvider(
        CHAIN_ID_MEGAETH,
        3,
        90000,
        true,
        v3TrackedEthThreshold,
        v3UntrackedUsdThreshold,
        v3SubgraphUrlOverride(CHAIN_ID_MEGAETH),
        process.env.GOLD_SKY_BEARER_TOKEN,
        logger,
        metric
      ),
    },
    {
      protocol: Protocol.V3,
      chainId: CHAIN_ID_ROBINHOOD,
      timeout: 90000,
      provider: new V3SubgraphProvider(
        CHAIN_ID_ROBINHOOD,
        3,
        90000,
        true,
        v3TrackedEthThreshold,
        v3UntrackedUsdThreshold,
        v3SubgraphUrlOverride(CHAIN_ID_ROBINHOOD),
        process.env.GOLD_SKY_BEARER_TOKEN,
        logger,
        metric
      ),
    },
    {
      protocol: Protocol.V3,
      chainId: CHAIN_ID_ARC,
      timeout: 90000,
      provider: new V3SubgraphProvider(
        CHAIN_ID_ARC,
        3,
        90000,
        true,
        v3TrackedEthThreshold,
        v3UntrackedUsdThreshold,
        v3SubgraphUrlOverride(CHAIN_ID_ARC),
        undefined,
        logger,
        metric
      ),
    },
    // V2
    {
      protocol: Protocol.V2,
      chainId: ChainId.MAINNET,
      timeout: 1200000,
      provider: new V2SubgraphProvider(
        ChainId.MAINNET,
        5,
        1200000,
        true,
        1000,
        v2TrackedEthThreshold,
        v2UntrackedUsdThreshold,
        v2SubgraphUrlOverride(ChainId.MAINNET),
        process.env.GRAPH_BEARER_TOKEN,
        logger,
        metric
      ),
    },
    {
      protocol: Protocol.V2,
      chainId: ChainId.ARBITRUM_ONE,
      timeout: 90000,
      provider: new V2SubgraphProvider(
        ChainId.ARBITRUM_ONE,
        3,
        90000,
        true,
        1000,
        v2TrackedEthThreshold,
        v2UntrackedUsdThreshold,
        v2SubgraphUrlOverride(ChainId.ARBITRUM_ONE),
        undefined,
        logger,
        metric
      ),
    },
    {
      protocol: Protocol.V2,
      chainId: ChainId.POLYGON,
      timeout: 90000,
      provider: new V2SubgraphProvider(
        ChainId.POLYGON,
        3,
        90000,
        true,
        1000,
        v2TrackedEthThreshold,
        v2UntrackedUsdThreshold,
        v2SubgraphUrlOverride(ChainId.POLYGON),
        undefined,
        logger,
        metric
      ),
    },
    {
      protocol: Protocol.V2,
      chainId: ChainId.OPTIMISM,
      timeout: 90000,
      provider: new V2SubgraphProvider(
        ChainId.OPTIMISM,
        3,
        90000,
        true,
        1000,
        v2TrackedEthThreshold,
        v2UntrackedUsdThreshold,
        v2SubgraphUrlOverride(ChainId.OPTIMISM),
        undefined,
        logger,
        metric
      ),
    },
    {
      protocol: Protocol.V2,
      chainId: ChainId.BNB,
      timeout: 90000,
      provider: new V2SubgraphProvider(
        ChainId.BNB,
        3,
        90000,
        true,
        1000,
        v2TrackedEthThreshold,
        v2UntrackedUsdThreshold,
        v2SubgraphUrlOverride(ChainId.BNB),
        undefined,
        logger,
        metric
      ),
    },
    {
      protocol: Protocol.V2,
      chainId: ChainId.AVALANCHE,
      timeout: 90000,
      provider: new V2SubgraphProvider(
        ChainId.AVALANCHE,
        3,
        90000,
        true,
        1000,
        v2TrackedEthThreshold,
        v2UntrackedUsdThreshold,
        v2SubgraphUrlOverride(ChainId.AVALANCHE),
        undefined,
        logger,
        metric
      ),
    },
    {
      protocol: Protocol.V2,
      chainId: ChainId.BASE,
      timeout: 840000,
      provider: new V2SubgraphProvider(
        ChainId.BASE,
        5,
        900000,
        true,
        3000,
        v2BaseTrackedEthThreshold,
        v2UntrackedUsdThreshold,
        v2SubgraphUrlOverride(ChainId.BASE),
        process.env.GRAPH_BEARER_TOKEN,
        logger,
        metric
      ),
    },
    {
      protocol: Protocol.V2,
      chainId: ChainId.BLAST,
      timeout: 90000,
      provider: new V2SubgraphProvider(
        ChainId.BLAST,
        3,
        90000,
        true,
        1000,
        v2TrackedEthThreshold,
        v2UntrackedUsdThreshold,
        v2SubgraphUrlOverride(ChainId.BLAST),
        undefined,
        logger,
        metric
      ),
    },
    {
      protocol: Protocol.V2,
      chainId: ChainId.WORLDCHAIN,
      timeout: 90000,
      provider: new V2SubgraphProvider(
        ChainId.WORLDCHAIN,
        3,
        90000,
        true,
        1000,
        v2TrackedEthThreshold,
        v2UntrackedUsdThreshold,
        v2SubgraphUrlOverride(ChainId.WORLDCHAIN),
        undefined,
        logger,
        metric
      ),
    },
    {
      protocol: Protocol.V2,
      chainId: ChainId.MONAD_TESTNET,
      timeout: 90000,
      provider: new V2SubgraphProvider(
        ChainId.MONAD_TESTNET,
        3,
        90000,
        true,
        1000,
        v2TrackedEthThreshold,
        v2UntrackedUsdThreshold,
        v2SubgraphUrlOverride(ChainId.MONAD_TESTNET),
        undefined,
        logger,
        metric
      ),
    },
    {
      protocol: Protocol.V2,
      chainId: ChainId.UNICHAIN,
      timeout: 90000,
      provider: new V2SubgraphProvider(
        ChainId.UNICHAIN,
        3,
        90000,
        true,
        1000,
        v2TrackedEthThreshold,
        v2UntrackedUsdThreshold,
        v2SubgraphUrlOverride(ChainId.UNICHAIN),
        undefined,
        logger,
        metric
      ),
    },
    {
      protocol: Protocol.V2,
      chainId: ChainId.SONEIUM,
      timeout: 90000,
      provider: new V2SubgraphProvider(
        ChainId.SONEIUM,
        3,
        90000,
        true,
        1000,
        v2TrackedEthThreshold,
        v2UntrackedUsdThreshold,
        v2SubgraphUrlOverride(ChainId.SONEIUM),
        undefined,
        logger,
        metric
      ),
    },
    {
      protocol: Protocol.V2,
      chainId: ChainId.MONAD,
      timeout: 90000,
      provider: new V2SubgraphProvider(
        ChainId.MONAD,
        3,
        90000,
        true,
        1000,
        v2TrackedEthThreshold,
        v2UntrackedUsdThreshold,
        v2SubgraphUrlOverride(ChainId.MONAD),
        process.env.GOLD_SKY_BEARER_TOKEN,
        logger,
        metric
      ),
    },
    {
      protocol: Protocol.V2,
      chainId: CHAIN_ID_TEMPO,
      timeout: 90000,
      provider: new V2SubgraphProvider(
        CHAIN_ID_TEMPO,
        3,
        90000,
        true,
        1000,
        v2TrackedEthThreshold,
        v2UntrackedUsdThreshold,
        v2SubgraphUrlOverride(CHAIN_ID_TEMPO),
        process.env.GOLD_SKY_BEARER_TOKEN,
        logger,
        metric
      ),
    },
    {
      protocol: Protocol.V2,
      chainId: ChainId.XLAYER,
      timeout: 90000,
      provider: new V2SubgraphProvider(
        ChainId.XLAYER,
        3,
        90000,
        true,
        1000,
        v2TrackedEthThreshold,
        v2UntrackedUsdThreshold,
        v2SubgraphUrlOverride(ChainId.XLAYER),
        process.env.GRAPH_BEARER_TOKEN,
        logger,
        metric
      ),
    },
    {
      protocol: Protocol.V2,
      chainId: ChainId.LINEA,
      timeout: 90000,
      provider: new V2SubgraphProvider(
        ChainId.LINEA,
        3,
        90000,
        true,
        1000,
        v2TrackedEthThreshold,
        v2UntrackedUsdThreshold,
        v2SubgraphUrlOverride(ChainId.LINEA),
        process.env.GOLD_SKY_BEARER_TOKEN,
        logger,
        metric
      ),
    },
    {
      protocol: Protocol.V2,
      chainId: CHAIN_ID_MEGAETH,
      timeout: 90000,
      provider: new V2SubgraphProvider(
        CHAIN_ID_MEGAETH,
        3,
        90000,
        true,
        1000,
        v2TrackedEthThreshold,
        v2UntrackedUsdThreshold,
        v2SubgraphUrlOverride(CHAIN_ID_MEGAETH),
        process.env.GOLD_SKY_BEARER_TOKEN,
        logger,
        metric
      ),
    },
    {
      protocol: Protocol.V2,
      chainId: CHAIN_ID_ROBINHOOD,
      timeout: 90000,
      provider: new V2SubgraphProvider(
        CHAIN_ID_ROBINHOOD,
        3,
        90000,
        true,
        1000,
        v2TrackedEthThreshold,
        v2UntrackedUsdThreshold,
        v2SubgraphUrlOverride(CHAIN_ID_ROBINHOOD),
        process.env.GOLD_SKY_BEARER_TOKEN,
        logger,
        metric
      ),
    },
    {
      protocol: Protocol.V2,
      chainId: CHAIN_ID_ARC,
      timeout: 90000,
      provider: new V2SubgraphProvider(
        CHAIN_ID_ARC,
        3,
        90000,
        true,
        1000,
        v2TrackedEthThreshold,
        v2UntrackedUsdThreshold,
        v2SubgraphUrlOverride(CHAIN_ID_ARC),
        undefined,
        logger,
        metric
      ),
    },
    // V4
    {
      protocol: Protocol.V4,
      chainId: ChainId.SEPOLIA,
      timeout: 90000,
      provider: new V4SubgraphProvider(
        ChainId.SEPOLIA,
        3,
        90000,
        true,
        v4TrackedEthThreshold,
        v4UntrackedUsdThreshold,
        v4SubgraphUrlOverride(ChainId.SEPOLIA),
        undefined,
        logger,
        metric
      ),
    },
    {
      protocol: Protocol.V4,
      chainId: ChainId.ARBITRUM_ONE,
      timeout: 90000,
      provider: new V4SubgraphProvider(
        ChainId.ARBITRUM_ONE,
        3,
        90000,
        true,
        v4TrackedEthThreshold,
        v4UntrackedUsdThreshold,
        v4SubgraphUrlOverride(ChainId.ARBITRUM_ONE),
        undefined,
        logger,
        metric
      ),
    },
    {
      protocol: Protocol.V4,
      chainId: ChainId.BASE,
      timeout: 90000,
      provider: new V4SubgraphProvider(
        ChainId.BASE,
        3,
        90000,
        true,
        v4BaseTrackedEthThreshold,
        v4UntrackedUsdThreshold,
        v4SubgraphUrlOverride(ChainId.BASE),
        process.env.GRAPH_BEARER_TOKEN,
        logger,
        metric
      ),
      aggHooksProvider: baseEthersProvider
        ? new AggHooksSubgraphProvider(
            ChainId.BASE,
            AGG_HOOKS_ON_BASE,
            baseEthersProvider,
            3,
            90000,
            true,
            v4SubgraphUrlOverride(ChainId.BASE),
            process.env.GRAPH_BEARER_TOKEN,
            logger,
            metric
          )
        : undefined,
    },
    {
      protocol: Protocol.V4,
      chainId: ChainId.POLYGON,
      timeout: 90000,
      provider: new V4SubgraphProvider(
        ChainId.POLYGON,
        3,
        90000,
        true,
        v4TrackedEthThreshold,
        v4UntrackedUsdThreshold,
        v4SubgraphUrlOverride(ChainId.POLYGON),
        undefined,
        logger,
        metric
      ),
    },
    {
      protocol: Protocol.V4,
      chainId: ChainId.WORLDCHAIN,
      timeout: 90000,
      provider: new V4SubgraphProvider(
        ChainId.WORLDCHAIN,
        3,
        90000,
        true,
        v4TrackedEthThreshold,
        v4UntrackedUsdThreshold,
        v4SubgraphUrlOverride(ChainId.WORLDCHAIN),
        undefined,
        logger,
        metric
      ),
    },
    {
      protocol: Protocol.V4,
      chainId: ChainId.ZORA,
      timeout: 90000,
      provider: new V4SubgraphProvider(
        ChainId.ZORA,
        3,
        90000,
        true,
        v4TrackedEthThreshold,
        v4UntrackedUsdThreshold,
        v4SubgraphUrlOverride(ChainId.ZORA),
        undefined,
        logger,
        metric
      ),
    },
    {
      protocol: Protocol.V4,
      chainId: ChainId.UNICHAIN,
      timeout: 90000,
      provider: new V4SubgraphProvider(
        ChainId.UNICHAIN,
        3,
        90000,
        true,
        v4TrackedEthThreshold,
        v4UntrackedUsdThreshold,
        v4SubgraphUrlOverride(ChainId.UNICHAIN),
        undefined,
        logger,
        metric
      ),
      eulerHooksProvider: new EulerSwapHooksSubgraphProvider(
        ChainId.UNICHAIN,
        3,
        90000,
        true,
        v4SubgraphUrlOverride(ChainId.UNICHAIN),
        logger,
        metric
      ),
    },
    {
      protocol: Protocol.V4,
      chainId: ChainId.BLAST,
      timeout: 90000,
      provider: new V4SubgraphProvider(
        ChainId.BLAST,
        3,
        90000,
        true,
        v4TrackedEthThreshold,
        v4UntrackedUsdThreshold,
        v4SubgraphUrlOverride(ChainId.BLAST),
        undefined,
        logger,
        metric
      ),
    },
    {
      protocol: Protocol.V4,
      chainId: ChainId.MAINNET,
      timeout: 90000,
      provider: new V4SubgraphProvider(
        ChainId.MAINNET,
        3,
        90000,
        true,
        v4TrackedEthThreshold,
        v4UntrackedUsdThreshold,
        v4SubgraphUrlOverride(ChainId.MAINNET),
        undefined,
        logger,
        metric
      ),
      eulerHooksProvider: new EulerSwapHooksSubgraphProvider(
        ChainId.MAINNET,
        3,
        90000,
        true,
        v4SubgraphUrlOverride(ChainId.MAINNET),
        logger,
        metric
      ),
      aggHooksProvider: mainnetEthersProvider
        ? new AggHooksSubgraphProvider(
            ChainId.MAINNET,
            AGG_HOOKS_ON_MAINNET,
            mainnetEthersProvider,
            3,
            90000,
            true,
            v4SubgraphUrlOverride(ChainId.MAINNET),
            undefined,
            logger,
            metric
          )
        : undefined,
    },
    {
      protocol: Protocol.V4,
      chainId: ChainId.SONEIUM,
      timeout: 90000,
      provider: new V4SubgraphProvider(
        ChainId.SONEIUM,
        3,
        90000,
        true,
        v4TrackedEthThreshold,
        v4UntrackedUsdThreshold,
        v4SubgraphUrlOverride(ChainId.SONEIUM),
        undefined,
        logger,
        metric
      ),
    },
    {
      protocol: Protocol.V4,
      chainId: ChainId.OPTIMISM,
      timeout: 90000,
      provider: new V4SubgraphProvider(
        ChainId.OPTIMISM,
        3,
        90000,
        true,
        v4TrackedEthThreshold,
        v4UntrackedUsdThreshold,
        v4SubgraphUrlOverride(ChainId.OPTIMISM),
        undefined,
        logger,
        metric
      ),
    },
    {
      protocol: Protocol.V4,
      chainId: ChainId.BNB,
      timeout: 90000,
      provider: new V4SubgraphProvider(
        ChainId.BNB,
        3,
        90000,
        true,
        v4TrackedEthThreshold,
        v4UntrackedUsdThreshold,
        v4SubgraphUrlOverride(ChainId.BNB),
        process.env.GRAPH_BEARER_TOKEN,
        logger,
        metric
      ),
    },
    {
      protocol: Protocol.V4,
      chainId: ChainId.MONAD,
      timeout: 90000,
      provider: new V4SubgraphProvider(
        ChainId.MONAD,
        3,
        90000,
        true,
        v4TrackedEthThreshold,
        v4UntrackedUsdThreshold,
        v4SubgraphUrlOverride(ChainId.MONAD),
        process.env.GOLD_SKY_BEARER_TOKEN,
        logger,
        metric
      ),
    },
    {
      protocol: Protocol.V4,
      chainId: CHAIN_ID_TEMPO,
      timeout: 90000,
      provider: new V4SubgraphProvider(
        CHAIN_ID_TEMPO,
        3,
        90000,
        true,
        v4TrackedEthThreshold,
        v4UntrackedUsdThreshold,
        v4SubgraphUrlOverride(CHAIN_ID_TEMPO),
        process.env.GOLD_SKY_BEARER_TOKEN,
        logger,
        metric
      ),
      aggHooksProvider: tempoEthersProvider
        ? new AggHooksSubgraphProvider(
            CHAIN_ID_TEMPO,
            AGG_HOOKS_ON_TEMPO,
            tempoEthersProvider,
            3,
            90000,
            true,
            v4SubgraphUrlOverride(CHAIN_ID_TEMPO),
            process.env.GOLD_SKY_BEARER_TOKEN,
            logger,
            metric,
            true
          )
        : undefined,
    },
    {
      protocol: Protocol.V4,
      chainId: ChainId.XLAYER,
      timeout: 90000,
      provider: new V4SubgraphProvider(
        ChainId.XLAYER,
        3,
        90000,
        true,
        v4TrackedEthThreshold,
        v4UntrackedUsdThreshold,
        v4SubgraphUrlOverride(ChainId.XLAYER),
        process.env.GRAPH_BEARER_TOKEN,
        logger,
        metric
      ),
    },
    {
      protocol: Protocol.V4,
      chainId: ChainId.AVALANCHE,
      timeout: 90000,
      provider: new V4SubgraphProvider(
        ChainId.AVALANCHE,
        3,
        90000,
        true,
        v4TrackedEthThreshold,
        v4UntrackedUsdThreshold,
        v4SubgraphUrlOverride(ChainId.AVALANCHE),
        undefined,
        logger,
        metric
      ),
    },
    {
      protocol: Protocol.V4,
      chainId: ChainId.LINEA,
      timeout: 90000,
      provider: new V4SubgraphProvider(
        ChainId.LINEA,
        3,
        90000,
        true,
        v4TrackedEthThreshold,
        v4UntrackedUsdThreshold,
        v4SubgraphUrlOverride(ChainId.LINEA),
        process.env.GOLD_SKY_BEARER_TOKEN,
        logger,
        metric
      ),
    },
    {
      protocol: Protocol.V4,
      chainId: CHAIN_ID_MEGAETH,
      timeout: 90000,
      provider: new V4SubgraphProvider(
        CHAIN_ID_MEGAETH,
        3,
        90000,
        true,
        v4TrackedEthThreshold,
        v4UntrackedUsdThreshold,
        v4SubgraphUrlOverride(CHAIN_ID_MEGAETH),
        process.env.GOLD_SKY_BEARER_TOKEN,
        logger,
        metric
      ),
    },
    {
      protocol: Protocol.V4,
      chainId: CHAIN_ID_ROBINHOOD,
      timeout: 90000,
      provider: new V4SubgraphProvider(
        CHAIN_ID_ROBINHOOD,
        3,
        90000,
        true,
        v4TrackedEthThreshold,
        v4UntrackedUsdThreshold,
        v4SubgraphUrlOverride(CHAIN_ID_ROBINHOOD),
        process.env.GOLD_SKY_BEARER_TOKEN,
        logger,
        metric
      ),
    },
    {
      protocol: Protocol.V4,
      chainId: CHAIN_ID_ARC,
      timeout: 90000,
      provider: new V4SubgraphProvider(
        CHAIN_ID_ARC,
        3,
        90000,
        true,
        v4TrackedEthThreshold,
        v4UntrackedUsdThreshold,
        v4SubgraphUrlOverride(CHAIN_ID_ARC),
        undefined,
        logger,
        metric
      ),
    },
  ];
}
