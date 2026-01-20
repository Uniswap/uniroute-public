import {getEnv} from './otherUtils';

export const UniRouteServiceName = 'uniroute';

export enum QuoteService {
  UniRoute = 'uniroute',
  QuickRoute = 'quickroute',
}

export enum LambdaType {
  Sync = 'sync',
  Async = 'async',
}

export const DefaultSlippageToleranceForAsync = __PLACEHOLDER__;

// TODO: use this ChainId enum for now
// Once all monorepo projects switch to PartialChainIdMap<T> from @uniswap/lib-sharedconfig/chainConfig
// we can switch to using ChainId from there.
export enum ChainId {
  MAINNET = __PLACEHOLDER__,
  OPTIMISM = __PLACEHOLDER__,
  POLYGON = __PLACEHOLDER__,
  ARBITRUM = __PLACEHOLDER__,
  BNB = __PLACEHOLDER__,
  BASE = __PLACEHOLDER__,
  BLAST = __PLACEHOLDER__,
  AVAX = __PLACEHOLDER__,
  CELO = __PLACEHOLDER__,
  ZORA = __PLACEHOLDER__,
  ZKSYNC = __PLACEHOLDER__,
  SEPOLIA = __PLACEHOLDER__,
  UNICHAIN_SEPOLIA = __PLACEHOLDER__,
  WORLDCHAIN = __PLACEHOLDER__,
  MONAD_TESTNET = __PLACEHOLDER__,
  BASE_SEPOLIA = __PLACEHOLDER__,
  UNICHAIN = __PLACEHOLDER__,
  SONEIUM = __PLACEHOLDER__,
  MONAD = __PLACEHOLDER__,
  XLAYER = __PLACEHOLDER__,
}

export interface IUniRouteServiceConfig {
  QuoteService: QuoteService;
  // The timeout for the unirpc lambda route.
  UniRpcTimeoutInMilliseconds: number;
  Lambda: {
    Type: LambdaType;
    ProvisionedConcurrentExecutions: number;
    TimeoutSeconds: number;
    MemorySize: number;
  };
  RedisCache: {
    // The namespace for the redis cache.
    Namespace?: string;
    // The timeout for the redis cache.
    RedisTimeoutInMilliseconds: number;
    // The TTL for the token cache entry.
    TokenCacheEntryTtlSeconds: number;
    // All pools/Chain/Protocol Ttl (uniRoutes)
    AllPoolsCacheEntryTtlSeconds: number;
    // TokenIn/TokenOut/Chain/Protocol pools Ttl (uniRoutes)
    TokenInOutPoolsCacheEntryTtlSeconds: number;
  };
  CachedRoutes: {
    // Whether to enable cached routes.
    Enabled: boolean;
    // The TTL for the route cache entry refresh.
    RouteCacheEntryRefreshSeconds: number;
    // The TTL for the cached routes.
    RouteCacheEntryTtlSeconds: number;
    // Cached routes to retrieve
    CachedRoutesToRetrieve: number;
    // Cached routes to keep after scoring
    CachedRoutesToKeepAfterScoring: number;
    // Skip async cache update call (to be used only for local debugging purposes)
    SkipAsyncCacheUpdateCall: boolean;
  };
  RouteFinder: {
    // The max number of raw routes to consider (before splitting).
    MaxRoutes: number;
    // The max number of hops allowed in a route.
    MaxHops: number;
    // The max number of splits allowed.
    MaxSplits: number;
    // The max number of candidate best routes before applying gas estimates.
    MaxSplitRoutes: number;
    // The timeout for the route splitting.
    RouteSplitTimeoutMs: number;
    // The percentage increment to try split routing (must divide __PLACEHOLDER__ evenly).
    RouteSplitPercentage: number;
    // Allow mixed pools in the route finder
    AllowMixedPools: boolean;
    // Chains to enable/consider cross-chain liquidity pools. Caution: this increases runtime.
    CrossChainLiquidityPoolsEnabled: Set<ChainId>;
  };
  S3: {
    // The S3 bucket name containing pool data
    poolBucketName: string;
    // The base key for pool data files
    poolBaseKey: string;
    // AWS region where the bucket is located
    region: string;
  };
  Simulation: {
    TopNQuotes: number;
    Enabled: boolean;
  };
  TopPoolsSelector: {
    PoolSelectionConfig: Record<ChainId, IPoolSelectionConfig>;
  };
  OnChainQuoteFetcher: {
    // Maximum number of retries when encountering "out of gas" errors, while reducing batchSize
    maxRetries: number;
    // Minimum batch size to use when retrying (never go below this value)
    minBatchSize: number;
  };
  L1L2GasCostFetcher: {
    // Enable L1 gas cost fetching for Optimism Stack chains (careful, will cause latency increase)
    OpStackEnabled: boolean;
    // Enable L1 gas cost fetching for Arbitrum
    ArbitrumEnabled: boolean;
    // Skips call data generation per candidate quote, and uses approximation for fee calculation (preferred true, lower latency)
    SkipArbitrumCallDataGenerationAndApproximate: boolean;
    // Approximate size of the call data in bytes for Arbitrum (used when SkipArbitrumCallDataGenerationAndApproximate is true)
    ArbitrumCallDataApproximateSize: number;
  };
  GasEstimation: {
    Enabled: boolean;
  };
  ResponseRequirements: {
    // Whether the quote response needs block number
    NeedsBlockNumber: boolean;
    // Whether the quote response needs up to date pool info for routes picked
    NeedsUpToDatePoolsInfo: boolean;
  };
}

// Returns the configuration object for uniroute sync service.
export const getUniRouteSyncConfig = (
  s3PoolBucketName?: string
): IUniRouteServiceConfig => {
  return {
    QuoteService: QuoteService.UniRoute,
    UniRpcTimeoutInMilliseconds: __PLACEHOLDER__,
    Lambda: {
      Type: LambdaType.Sync,
      ProvisionedConcurrentExecutions: __PLACEHOLDER__,
      TimeoutSeconds: __PLACEHOLDER__,
      MemorySize: __PLACEHOLDER__,
    },
    RedisCache: {
      Namespace: undefined,
      RedisTimeoutInMilliseconds: __PLACEHOLDER__,
      TokenCacheEntryTtlSeconds: __PLACEHOLDER__ * __PLACEHOLDER__ * __PLACEHOLDER__,
      AllPoolsCacheEntryTtlSeconds: __PLACEHOLDER__ * __PLACEHOLDER__ * __PLACEHOLDER__,
      TokenInOutPoolsCacheEntryTtlSeconds: __PLACEHOLDER__ * __PLACEHOLDER__ * __PLACEHOLDER__,
    },
    CachedRoutes: {
      Enabled: true,
      RouteCacheEntryRefreshSeconds: __PLACEHOLDER__,
      RouteCacheEntryTtlSeconds: __PLACEHOLDER__ * __PLACEHOLDER__ * __PLACEHOLDER__,
      CachedRoutesToRetrieve: __PLACEHOLDER__,
      CachedRoutesToKeepAfterScoring: __PLACEHOLDER__,
      SkipAsyncCacheUpdateCall: false, // always false in prod
    },
    RouteFinder: {
      MaxHops: __PLACEHOLDER__,
      MaxRoutes: __PLACEHOLDER__,
      MaxSplits: __PLACEHOLDER__,
      MaxSplitRoutes: __PLACEHOLDER__,
      RouteSplitPercentage: __PLACEHOLDER__,
      RouteSplitTimeoutMs: __PLACEHOLDER__,
      AllowMixedPools: true,
      CrossChainLiquidityPoolsEnabled: new Set<ChainId>(MIXED_SUPPORTED),
    },
    S3: {
      poolBucketName: s3PoolBucketName || getEnv('S3_POOL_BUCKET_NAME', 'N/A'),
      poolBaseKey: 'poolCacheGzip.json',
      region: 'us-east-__PLACEHOLDER__',
    },
    Simulation: {
      TopNQuotes: __PLACEHOLDER__,
      Enabled: true,
    },
    TopPoolsSelector: {
      PoolSelectionConfig: poolSelectionConfig,
    },
    OnChainQuoteFetcher: {
      maxRetries: __PLACEHOLDER__,
      minBatchSize: __PLACEHOLDER__,
    },
    L1L2GasCostFetcher: {
      // Note: Enabling this will increase latency, use caution. We need some better mechanism for calldata generation - it's too costly (rpc calls, fresh pool details per candidate).
      OpStackEnabled: false,
      // This is fine as long as SkipArbitrumCallDataGenerationAndApproximate = true.
      ArbitrumEnabled: true,
      // Note: Disabling this will increase latency, use caution. We need some better mechanism for calldata generation - it's too costly (rpc calls, fresh pool details per candidate).
      SkipArbitrumCallDataGenerationAndApproximate: true,
      // Checked on a sample calldata for a __PLACEHOLDER__ way split quote, ith multiple hops, and it's __PLACEHOLDER__ chars. Let's be conservative and use __PLACEHOLDER__.
      ArbitrumCallDataApproximateSize: __PLACEHOLDER__,
    },
    GasEstimation: {
      Enabled: true,
    },
    ResponseRequirements: {
      NeedsBlockNumber: true,
      NeedsUpToDatePoolsInfo: true,
    },
  };
};

// Returns the configuration object for quickroute sync service.
export const getQuickRouteSyncConfig = (
  s3PoolBucketName?: string
): IUniRouteServiceConfig => {
  return {
    QuoteService: QuoteService.QuickRoute,
    UniRpcTimeoutInMilliseconds: __PLACEHOLDER__,
    Lambda: {
      Type: LambdaType.Sync,
      ProvisionedConcurrentExecutions: __PLACEHOLDER__,
      TimeoutSeconds: __PLACEHOLDER__,
      MemorySize: __PLACEHOLDER__,
    },
    RedisCache: {
      Namespace: 'quickroute-',
      RedisTimeoutInMilliseconds: __PLACEHOLDER__,
      TokenCacheEntryTtlSeconds: __PLACEHOLDER__ * __PLACEHOLDER__ * __PLACEHOLDER__,
      AllPoolsCacheEntryTtlSeconds: __PLACEHOLDER__ * __PLACEHOLDER__ * __PLACEHOLDER__,
      TokenInOutPoolsCacheEntryTtlSeconds: __PLACEHOLDER__ * __PLACEHOLDER__ * __PLACEHOLDER__,
    },
    CachedRoutes: {
      Enabled: true,
      RouteCacheEntryRefreshSeconds: __PLACEHOLDER__ * __PLACEHOLDER__ * __PLACEHOLDER__,
      RouteCacheEntryTtlSeconds: __PLACEHOLDER__ * __PLACEHOLDER__ * __PLACEHOLDER__,
      CachedRoutesToRetrieve: __PLACEHOLDER__,
      CachedRoutesToKeepAfterScoring: __PLACEHOLDER__,
      SkipAsyncCacheUpdateCall: false, // always false in prod
    },
    RouteFinder: {
      MaxHops: __PLACEHOLDER__,
      MaxRoutes: __PLACEHOLDER__,
      MaxSplits: __PLACEHOLDER__,
      MaxSplitRoutes: __PLACEHOLDER__,
      RouteSplitPercentage: __PLACEHOLDER__,
      RouteSplitTimeoutMs: __PLACEHOLDER__,
      AllowMixedPools: false,
      CrossChainLiquidityPoolsEnabled: new Set<ChainId>(),
    },
    S3: {
      poolBucketName: s3PoolBucketName || getEnv('S3_POOL_BUCKET_NAME', 'N/A'),
      poolBaseKey: 'poolCacheGzip.json',
      region: 'us-east-__PLACEHOLDER__',
    },
    Simulation: {
      TopNQuotes: __PLACEHOLDER__,
      Enabled: false,
    },
    TopPoolsSelector: {
      PoolSelectionConfig: poolSelectionConfig,
    },
    OnChainQuoteFetcher: {
      maxRetries: __PLACEHOLDER__,
      minBatchSize: __PLACEHOLDER__,
    },
    L1L2GasCostFetcher: {
      // Note: Enabling this will increase latency, use caution. We need some better mechanism for calldata generation - it's too costly (rpc calls, fresh pool details per candidate).
      OpStackEnabled: false,
      // This is fine as long as SkipArbitrumCallDataGenerationAndApproximate = true.
      ArbitrumEnabled: false,
      // Note: Disabling this will increase latency, use caution. We need some better mechanism for calldata generation - it's too costly (rpc calls, fresh pool details per candidate).
      SkipArbitrumCallDataGenerationAndApproximate: true,
      // Checked on a sample calldata for a __PLACEHOLDER__ way split quote, ith multiple hops, and it's __PLACEHOLDER__ chars. Let's be conservative and use __PLACEHOLDER__.
      ArbitrumCallDataApproximateSize: __PLACEHOLDER__,
    },
    GasEstimation: {
      Enabled: false,
    },
    ResponseRequirements: {
      NeedsBlockNumber: false,
      NeedsUpToDatePoolsInfo: false,
    },
  };
};

// Returns the configuration object for uniroute async service.
export const getUniRouteAsyncConfig = (
  s3PoolBucketName?: string
): IUniRouteServiceConfig => {
  // Use the sync config as a base and override the async specific fields
  const syncConfig = getUniRouteSyncConfig(s3PoolBucketName);

  return {
    ...syncConfig,
    Lambda: {
      ...syncConfig.Lambda,
      Type: LambdaType.Async,
      TimeoutSeconds: __PLACEHOLDER__,
    },
    RouteFinder: {
      ...syncConfig.RouteFinder,
      MaxRoutes: __PLACEHOLDER__,
      MaxSplitRoutes: __PLACEHOLDER__,
      RouteSplitTimeoutMs: __PLACEHOLDER__,
    },
  };
};

export const getQuickRouteAsyncConfig = (
  s3PoolBucketName?: string
): IUniRouteServiceConfig => {
  const syncConfig = getQuickRouteSyncConfig(s3PoolBucketName);
  return {
    ...syncConfig,
    Lambda: {
      ...syncConfig.Lambda,
      Type: LambdaType.Async,
    },
  };
};

export const getUniRouteTestConfig = (
  lambdaType: LambdaType = LambdaType.Sync,
  s3PoolBucketName?: string
): IUniRouteServiceConfig => {
  if (lambdaType === LambdaType.Async) {
    return getUniRouteAsyncConfig(s3PoolBucketName);
  } else if (lambdaType === LambdaType.Sync) {
    return getUniRouteSyncConfig(s3PoolBucketName);
  }
  throw new Error(`Unknown lambda type: ${lambdaType}`);
};

export const buildMetricKey = (metric: string) => {
  return `UniRouteService.Metric.${metric}`;
};

export const SUPPORTED_CHAINS: ChainId[] = [
  ChainId.MAINNET,
  ChainId.OPTIMISM,
  ChainId.ARBITRUM,
  ChainId.POLYGON,
  ChainId.SEPOLIA,
  ChainId.CELO,
  ChainId.BNB,
  ChainId.AVAX,
  ChainId.BASE,
  ChainId.BLAST,
  ChainId.ZORA,
  ChainId.ZKSYNC,
  ChainId.WORLDCHAIN,
  ChainId.UNICHAIN_SEPOLIA,
  ChainId.MONAD_TESTNET,
  ChainId.MONAD,
  ChainId.BASE_SEPOLIA,
  ChainId.UNICHAIN,
  ChainId.SONEIUM,
  ChainId.XLAYER,
];

export const V2_SUPPORTED = [
  ChainId.MAINNET,
  ChainId.SEPOLIA,
  ChainId.ARBITRUM,
  ChainId.OPTIMISM,
  ChainId.POLYGON,
  ChainId.BASE,
  ChainId.BNB,
  ChainId.AVAX,
  ChainId.MONAD_TESTNET,
  ChainId.MONAD,
  ChainId.UNICHAIN_SEPOLIA,
  ChainId.UNICHAIN,
  ChainId.SONEIUM,
  ChainId.BLAST,
  ChainId.WORLDCHAIN,
  ChainId.XLAYER,
];

export const V4_SUPPORTED = [
  ChainId.MAINNET,
  ChainId.SEPOLIA,
  ChainId.ARBITRUM,
  ChainId.OPTIMISM,
  ChainId.POLYGON,
  ChainId.BASE,
  ChainId.BNB,
  ChainId.AVAX,
  ChainId.MONAD_TESTNET,
  ChainId.MONAD,
  ChainId.UNICHAIN_SEPOLIA,
  ChainId.UNICHAIN,
  ChainId.SONEIUM,
  ChainId.CELO,
  ChainId.WORLDCHAIN,
  ChainId.ZORA,
  ChainId.BLAST,
  ChainId.XLAYER,
];

export const MIXED_SUPPORTED = [
  ChainId.MAINNET,
  ChainId.SEPOLIA,
  ChainId.BASE,
  ChainId.UNICHAIN,
  ChainId.ARBITRUM,
  ChainId.POLYGON,
  ChainId.OPTIMISM,
  ChainId.AVAX,
  ChainId.BNB,
  ChainId.WORLDCHAIN,
  ChainId.ZORA,
  ChainId.SONEIUM,
  ChainId.XLAYER,
];

export const OPTIMISM_STACK_CHAINS = [
  ChainId.OPTIMISM,
  ChainId.BASE,
  ChainId.BLAST,
  ChainId.ZORA,
  ChainId.WORLDCHAIN,
  ChainId.UNICHAIN_SEPOLIA,
  ChainId.UNICHAIN,
  ChainId.SONEIUM,
  ChainId.XLAYER,
];

export interface IPoolSelectionConfig {
  topNDirectPairs: number; // Pools with both tokenIn and tokenOut
  topNOneHopPairs: number; // Pools with either tokenIn or tokenOut
  topNSecondHopPairs: number;
  topNPairs: number; // Top N pools with highest liquidity
  topNWithBaseTokenEach: number; // Top N pools with each base token + tokenIn or tokenOut
  topNWithBaseToken: number;
}

// Default pool selection config for all chains
export const defaultPoolSelectionConfig: IPoolSelectionConfig = {
  topNDirectPairs: __PLACEHOLDER__,
  topNOneHopPairs: __PLACEHOLDER__,
  topNSecondHopPairs: __PLACEHOLDER__,
  topNPairs: __PLACEHOLDER__,
  topNWithBaseTokenEach: __PLACEHOLDER__,
  topNWithBaseToken: __PLACEHOLDER__,
};

export const poolSelectionConfig: Record<ChainId, IPoolSelectionConfig> = {
  [ChainId.MAINNET]: {...defaultPoolSelectionConfig},
  [ChainId.OPTIMISM]: {...defaultPoolSelectionConfig},
  [ChainId.ARBITRUM]: {...defaultPoolSelectionConfig},
  [ChainId.POLYGON]: {...defaultPoolSelectionConfig},
  [ChainId.SEPOLIA]: {...defaultPoolSelectionConfig},
  [ChainId.CELO]: {...defaultPoolSelectionConfig},
  [ChainId.BNB]: {...defaultPoolSelectionConfig},
  [ChainId.AVAX]: {...defaultPoolSelectionConfig},
  [ChainId.BASE]: {...defaultPoolSelectionConfig},
  [ChainId.BLAST]: {...defaultPoolSelectionConfig},
  [ChainId.ZORA]: {...defaultPoolSelectionConfig},
  [ChainId.ZKSYNC]: {...defaultPoolSelectionConfig},
  [ChainId.WORLDCHAIN]: {...defaultPoolSelectionConfig},
  [ChainId.UNICHAIN_SEPOLIA]: {...defaultPoolSelectionConfig},
  [ChainId.MONAD_TESTNET]: {...defaultPoolSelectionConfig},
  [ChainId.MONAD]: {...defaultPoolSelectionConfig},
  [ChainId.BASE_SEPOLIA]: {...defaultPoolSelectionConfig},
  [ChainId.UNICHAIN]: {...defaultPoolSelectionConfig},
  [ChainId.SONEIUM]: {...defaultPoolSelectionConfig},
  [ChainId.XLAYER]: {...defaultPoolSelectionConfig},
};

// Mapping of chainId to Set of token addresses that require gasPrice to be passed to simulation
// Token addresses should be in lowercase for comparison
export const needsGasPriceFetchingMapping: Record<ChainId, Set<string>> = {
  [ChainId.MAINNET]: new Set<string>(),
  [ChainId.OPTIMISM]: new Set<string>(),
  [ChainId.ARBITRUM]: new Set<string>(),
  [ChainId.POLYGON]: new Set<string>(),
  [ChainId.SEPOLIA]: new Set<string>(),
  [ChainId.CELO]: new Set<string>(),
  [ChainId.BNB]: new Set<string>(),
  [ChainId.AVAX]: new Set<string>(),
  [ChainId.BASE]: new Set<string>([
    '0x086d596d7062b3cdddaaa3714d656508668028fd', // DEEPR
  ]),
  [ChainId.BLAST]: new Set<string>(),
  [ChainId.ZORA]: new Set<string>(),
  [ChainId.ZKSYNC]: new Set<string>(),
  [ChainId.WORLDCHAIN]: new Set<string>(),
  [ChainId.UNICHAIN_SEPOLIA]: new Set<string>(),
  [ChainId.MONAD_TESTNET]: new Set<string>(),
  [ChainId.MONAD]: new Set<string>(),
  [ChainId.BASE_SEPOLIA]: new Set<string>(),
  [ChainId.UNICHAIN]: new Set<string>(),
  [ChainId.SONEIUM]: new Set<string>(),
  [ChainId.XLAYER]: new Set<string>(),
};

export const needsGasPriceFetching = (
  chainId: ChainId,
  tokenInAddress: string,
  tokenOutAddress: string
): boolean => {
  const tokenSet = needsGasPriceFetchingMapping[chainId];
  if (!tokenSet || tokenSet.size === __PLACEHOLDER__) {
    return false;
  }
  return (
    tokenSet.has(tokenInAddress.toLowerCase()) ||
    tokenSet.has(tokenOutAddress.toLowerCase())
  );
};
