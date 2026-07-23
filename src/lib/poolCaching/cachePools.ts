/**
 * Ported from routing-api/lib/cron/cache-pools.ts
 * Converted from Lambda handler to plain async function for ECS cron sidecar.
 */

import {Protocol} from '@uniswap/router-sdk';
import {ChainId} from '@uniswap/sdk-core';
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import * as zlib from 'zlib';

import {
  V2SubgraphPool,
  V2SubgraphProvider,
  V3SubgraphPool,
  V3SubgraphProvider,
  V4SubgraphPool,
} from './sor-providers';

import {
  createChainProtocols,
  v2SubgraphUrlOverride,
  v2TrackedEthThreshold,
  v3SubgraphUrlOverride,
  v3TrackedEthThreshold,
  ChainProtocol,
} from './cacheConfig';
import {S3_POOL_CACHE_KEY} from './util/poolCacheKey';
import {withTimeout} from './util/withTimeout';
import {v4HooksPoolsFiltering} from './util/v4HooksPoolsFiltering';
import {Logger} from './sor-providers/util/log';
import {IMetric, MetricLoggerUnit} from './sor-providers/util/metric';
import {GUIDESTAR_STABLE_STABLE_HOOK_ON_MAINNET} from './util/hooksAddressesAllowlist';
import {getDynamicZlcaHooks} from './util/dynamicZlcaHooks';
import {
  createDynamicZlcaHooksRefresherFromEnv,
  DynamicZlcaHooksRefresher,
} from './util/DynamicZlcaHooksRefresher';

export interface CachePoolsConfig {
  s3Bucket: string;
  s3CacheKey: string;
}

// S3 object-metadata key recording when a snapshot's subgraph fetch STARTED.
// Freshness arbitration between concurrent writers compares these, not write
// times. S3 lowercases metadata keys (x-amz-meta-*), so keep this lowercase.
export const FETCH_START_METADATA_KEY = 'fetch-start-time';

// A recorded fetch start meaningfully in the future is corrupt (a writer
// with a broken clock); trusting it would freeze the key until that time.
// Beyond this tolerance the metadata is treated as absent.
const FETCH_START_MAX_FUTURE_SKEW_MS = 5 * 60_000;

function prefixedLogger(logger: Logger, prefix: string): Logger {
  return {
    info: (msg, ...extra) => logger.info(`${prefix} ${msg}`, ...extra),
    warn: (msg, ...extra) => logger.warn(`${prefix} ${msg}`, ...extra),
    error: (msg, ...extra) => logger.error(`${prefix} ${msg}`, ...extra),
    debug: (msg, ...extra) => logger.debug(`${prefix} ${msg}`, ...extra),
    fatal: (msg, ...extra) => logger.fatal(`${prefix} ${msg}`, ...extra),
  };
}

async function cachePoolsForChainProtocol(
  chainProtocol: ChainProtocol,
  s3: S3Client,
  config: CachePoolsConfig,
  logger: Logger,
  metricInstance: IMetric
): Promise<void> {
  const {protocol, chainId, provider, eulerHooksProvider, aggHooksProvider} =
    chainProtocol;
  const metricTags = {chainId: String(chainId), protocol: String(protocol)};
  logger = prefixedLogger(logger, `[${chainId}_${protocol}]`);
  const fetchStartTime = new Date();
  const compressedKey = S3_POOL_CACHE_KEY(config.s3CacheKey, chainId, protocol);

  logger.info('Getting pools');
  metricInstance.putMetric(
    'CachePools.run',
    1,
    MetricLoggerUnit.Count,
    metricTags
  );

  let pools: Array<V2SubgraphPool | V3SubgraphPool | V4SubgraphPool> = [];
  try {
    const beforeGetPool = Date.now();
    pools = (await provider.getPools()) as Array<
      V2SubgraphPool | V3SubgraphPool | V4SubgraphPool
    >;

    if (protocol === Protocol.V2 && chainId === ChainId.MAINNET) {
      const v2MainnetSubgraphProvider = new V2SubgraphProvider(
        ChainId.MAINNET,
        5,
        1200000,
        true,
        1000,
        v2TrackedEthThreshold,
        0, // wstETH/DOG reserveUSD is 0, but the pool balance is sufficiently high
        v2SubgraphUrlOverride(ChainId.MAINNET),
        process.env.GRAPH_BEARER_TOKEN,
        logger,
        metricInstance
      );
      const additionalPools = await v2MainnetSubgraphProvider.getPools();
      const filteredPools = additionalPools.filter(pool => {
        return (
          pool.id.toLowerCase() === '0x801c868ce08fb5b396e6911eac351beb259d386c'
        );
      });
      filteredPools.forEach(pool => pools.push(pool));

      const manuallyIncludedPools: V2SubgraphPool[] = [
        {
          id: '0x801c868ce08fb5b396e6911eac351beb259d386c',
          token0: {id: '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0'},
          token1: {id: '0xbaac2b4491727d78d2b78815144570b9f2fe8899'},
          supply: Number('706196.651729130972764273'),
          reserve: Number('818.040429522105562858'),
          reserveUSD: 5890000,
        },
      ];
      manuallyIncludedPools.forEach(pool => pools.push(pool));

      const filterOutPoolAddresses = [
        '0x029c9f16d219486305716f8c623739f9c75ceabd',
        '0x037555fd11f9ba25b8b2240cac45c340023c0e3e',
        '0x04a3e942702d67f694397d5bbd6d3a724a59bb83',
        '0x08a564924c26d8289503bbaa18714b9c366df9a5',
        '0x0b30c6e9873f6b0611ff322e2a7cc692566059cb',
        '0x10cb5745dbc1a9d40e56b87a89443b7ee5685700',
        '0x1781c9e087b14a59137a13a2fb77b8706c076f8e',
        '0x18027ee162e26aa7dd62d8aa3e863114e123485f',
        '0x20b68e4ebbcf8f4213f2520bd933a9f77fe2ba5c',
        '0x2647b944831091a5e015760d50a5369da1358477',
        '0x2bffdeea4076afd9468488cc2d483b0d9bf390e2',
        '0x39fb8d79d23f338a503d7dfeb22af035465ce6da',
        '0x3db198710c1fd80710a5b95a2f73e347236c2d20',
        '0x3e8c428e378c2ea06db5090ee7484072ee1405e4',
        '0x3f35b1627bfedead1657849544bc94ee907dfc9d',
        '0x419a0d9598a8219990242fcd5ec321a78ade9292',
        '0x53b784d0fb88f53c6af76839a7eaec8e95729375',
        '0x53f364a28e749d3757a61c3bc5529bf5bac4bb76',
        '0x565fb96239c6feed741d5aa351b80bed5aa395b4',
        '0x5ad1445d48b6cc75bc944a42096a67f5e2f89f38',
        '0x5dfdd30458cf9103913876e2babbc0cf8e2ae332',
        '0x60877a93d2c4e6c94efa0c90a10f1279e02052f3',
        '0x6277155437e494b5061dbfa0a4f13516e2cbcb93',
        '0x670dac2a5fb900d799798cb170b0d2517aa410a4',
        '0x6b102aee00ee84e9f2761dae6f7af4cabbd5fc60',
        '0x6d0e791003b16e0b9b970eb9b7c5f2729b3fb4ef',
        '0x730c0867dd268bcb7f2f6618abb82763c2a0cae6',
        '0x758e5020abd493d163e70e30fd70d767dd440e73',
        '0x77552f5f1029c2759c6f250f64d7276bf53c6de1',
        '0x7dd337d3451472e6c94dec8f7c65e41e200f135f',
        '0x7fa64a4be88f9a66401c4a9cce6b0560e5503f17',
        '0x7fe29551bfb700d3ee801eea1a689525d1ea4f58',
        '0x802f1179efade88371ab49bdc5847fa0f45d3fd7',
        '0x81145516ba64c6555f600d7b32e050ea235a7b1e',
        '0x8124adde003aceb997270f936606cfa91c18ae59',
        '0x83503be303ff0e05a5d6dcd1c2a3cdf0a68cc',
        '0x942fd99c4cbc0d17fea386d6435e4ee977f429af',
        '0x95f8ea94c3b5ad4a30a2ccdd393641843e91fde4',
        '0x99e2bd6f2fd5086dc18f5b25a97770d1c407f812',
        '0x9bbb33186788d575cb97ee1b20080f7c56c01a24',
        '0x9c1ceadc487969a9e48eea7222206c6b9514a35c',
        '0xa0a44777b4b95364990fbb29c42990ac24bb9c43',
        '0xa5e7beb5ed26b3e5cd5b5a9e869556cf9d7f772b',
        '0xab7b749a56322e15ecd685077ccb69ac9fc5dc0e',
        '0xabc7d601982b1ff279965a2d0db19b39db4f39ca',
        '0xacb74201fe556ce4b01df104aba3666855d10d09',
        '0xae2a5b2b2a07cc434e95b08a4e2022b1bd42fd4d',
        '0xb360ebbeba4c74eb7c960757127b830091e2567a',
        '0xb450e654e1853dc49fe1d1fa9a94c898d6c5b07f',
        '0xb91224f6b496f9718f92c3a6a8f85f93fa2be78a',
        '0xc27286b35101db690aa48fca4a21a2a5cb109fca',
        '0xc2e0e4eb1fcea463ef20dd0098b745ab5cbd795d',
        '0xc623fcddccc150ff9f4fe12836396fc33d57cd59',
        '0xca5f42c8c500e0b7ea6ea8a97bd43f937daf7aeb',
        '0xcb16c4d61a054db33c73a23125239fffe71c92b4',
        '0xcdc3d2c8c79091b9b63a70a98716e3b40d1299d4',
        '0xd0dfae74a235590bcd10511b7f63222bac772098',
        '0xd18b6f4a4f9f9e5a77514ccf25478b351a95de40',
        '0xd206892ec46a663f5f49ddc7f3761f65aed6fd57',
        '0xda9f285925f96aa8b0deda6607617849b74e1b7a',
        '0xdb4441a35256b270c369ced5ba95aa99ec4623a2',
        '0xe104385168da45bed811d76d2d804e445a891d67',
        '0xe28a8c5227e50157d69c3916b95495307129494f',
        '0xef08deb6fe642b1145e010d3fc08d517d4af1986',
        '0xf0dbd8d468248a9f01690858a421a437f4b99ce1',
        '0xf6735b081f9a0feac40f7689db24ed7e11bff429',
        '0xfa545ce38d18ea4350adb899f380058afad7619e',
        '0xfaa7e98e633a10e90b71a84200e10562e5302a92',
        '0xfdce1a334e5e33167709c5d9c60798a5b7884576',
        '0xfe2aa6db37531042bc4fdcad1fea3f6616a5bd54',
      ].map(address => address.toLowerCase());

      pools = (pools as Array<V2SubgraphPool>).filter(
        (pool: V2SubgraphPool) => {
          const shouldFilterOut = filterOutPoolAddresses.includes(
            pool.id.toLowerCase()
          );
          if (shouldFilterOut) {
            logger.info(`Filtering out pool ${pool.id}`);
          }
          return !shouldFilterOut;
        }
      );
    }

    if (protocol === Protocol.V3 && chainId === ChainId.MAINNET) {
      const v3MainnetSubgraphProvider = new V3SubgraphProvider(
        ChainId.MAINNET,
        3,
        90000,
        true,
        v3TrackedEthThreshold,
        0, // wstETH/USDC totalValueLockedUSDUntracked is 0
        v3SubgraphUrlOverride(ChainId.MAINNET),
        undefined,
        logger,
        metricInstance
      );
      const additionalPools = await v3MainnetSubgraphProvider.getPools();
      const filteredPools = additionalPools.filter((pool: V3SubgraphPool) => {
        return (
          pool.id.toLowerCase() === '0x4622df6fb2d9bee0dcdacf545acdb6a2b2f4f863'
        );
      });
      filteredPools.forEach(pool => pools.push(pool));

      pools = (pools as Array<V3SubgraphPool>).filter(
        (pool: V3SubgraphPool) => {
          const shouldFilterOut =
            pool.token0.id.toLowerCase() ===
              '0xd46ba6d942050d489dbd938a2c909a5d5039a161' ||
            pool.token1.id.toLowerCase() ===
              '0xd46ba6d942050d489dbd938a2c909a5d5039a161' ||
            pool.id.toLowerCase() ===
              '0x0f681f10ab1aa1cde04232a199fe3c6f2652a80c';
          if (shouldFilterOut) {
            logger.info(`Filtering out pool ${pool.id}`);
          }
          return !shouldFilterOut;
        }
      );
    }

    if (protocol === Protocol.V4) {
      const manuallyIncludedV4Pools: V4SubgraphPool[] = [];

      if (eulerHooksProvider) {
        const eulerHooks = await eulerHooksProvider.getHooks();
        if (eulerHooks) {
          metricInstance.putMetric(
            'eulerHooks.length',
            eulerHooks.length,
            MetricLoggerUnit.Count,
            metricTags
          );
          const eulerPools = await Promise.all(
            eulerHooks.map(async eulerHook => {
              const pool = await eulerHooksProvider.getPoolByHook(
                eulerHook.hook
              );
              logger.info(`eulerHooks pool ${JSON.stringify(pool)}`);
              if (pool) {
                (pool as V4SubgraphPool).tvlUSD = 1000;
                (pool as V4SubgraphPool).tvlETH = 5500000;
              }
              return pool;
            })
          );
          eulerPools.forEach(pool => {
            if (pool) {
              manuallyIncludedV4Pools.push(pool as V4SubgraphPool);
            }
          });
        }
      }

      if (aggHooksProvider) {
        const aggHooksPools = await aggHooksProvider.getPools();
        logger.debug(`aggHooksPools ${JSON.stringify(aggHooksPools)}`);
        metricInstance.putMetric(
          'aggHooks.pools.length',
          aggHooksPools.length,
          MetricLoggerUnit.Count,
          metricTags
        );
        aggHooksPools.forEach(pool => manuallyIncludedV4Pools.push(pool));
      }

      if (chainId === ChainId.UNICHAIN) {
        manuallyIncludedV4Pools.push({
          id: '0xba246b8420b5aeb13e586cd7cbd32279fa7584d7f4cbc9bd356a6bb6200d16a6',
          feeTier: '0',
          tickSpacing: '1',
          hooks: '0x730b109bad65152c67ecc94eb8b0968603dba888',
          liquidity: '173747248900',
          token0: {
            symbol: 'ETH',
            id: '0x0000000000000000000000000000000000000000',
            name: 'Ethereum',
            decimals: '18',
          },
          token1: {
            symbol: 'WETH',
            id: '0x4200000000000000000000000000000000000006',
            name: 'Wrapped Ether',
            decimals: '18',
          },
          tvlETH: 33482,
          tvlUSD: 60342168,
        } as V4SubgraphPool);
      }

      if (chainId === ChainId.OPTIMISM) {
        manuallyIncludedV4Pools.push({
          id: '0xbf3d38951e485c811bb1fc7025fcd1ef60c15fda4c4163458facb9bedfe26f83',
          feeTier: '0',
          tickSpacing: '1',
          hooks: '0x480dafdb4d6092ef3217595b75784ec54b52e888',
          liquidity: '173747248900',
          token0: {
            symbol: 'ETH',
            id: '0x0000000000000000000000000000000000000000',
            name: 'Ethereum',
            decimals: '18',
          },
          token1: {
            symbol: 'WETH',
            id: '0x4200000000000000000000000000000000000006',
            name: 'Wrapped Ether',
            decimals: '18',
          },
          tvlETH: 826,
          tvlUSD: 1482475,
        } as V4SubgraphPool);
      }

      if (chainId === ChainId.BASE) {
        manuallyIncludedV4Pools.push({
          id: '0xbb2aefc6c55a0464b944c0478869527ba1a537f05f90a1bb82e1196c6e9403e2',
          feeTier: '0',
          tickSpacing: '1',
          hooks: '0xb08211d57032dd10b1974d4b876851a7f7596888',
          liquidity: '173747248900',
          token0: {
            symbol: 'ETH',
            id: '0x0000000000000000000000000000000000000000',
            name: 'Ethereum',
            decimals: '18',
          },
          token1: {
            symbol: 'WETH',
            id: '0x4200000000000000000000000000000000000006',
            name: 'Wrapped Ether',
            decimals: '18',
          },
          tvlETH: 6992,
          tvlUSD: 12580000,
        } as V4SubgraphPool);
      }

      if (chainId === ChainId.ARBITRUM_ONE) {
        manuallyIncludedV4Pools.push({
          id: '0xc1c777843809a8e77a398fd79ecddcefbdad6a5676003ae2eedf3a33a56589e9',
          feeTier: '0',
          tickSpacing: '1',
          hooks: '0x2a4adf825bd96598487dbb6b2d8d882a4eb86888',
          liquidity: '173747248900',
          token0: {id: '0x0000000000000000000000000000000000000000'},
          token1: {id: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1'},
          tvlETH: 23183,
          tvlUSD: 41820637,
        } as V4SubgraphPool);
      }

      if (chainId === ChainId.MAINNET) {
        manuallyIncludedV4Pools.push({
          id: '0xf6f2314ac16a878e2bf8ef01ef0a3487e714d397d87f702b9a08603eb3252e92',
          feeTier: '0',
          tickSpacing: '1',
          hooks: '0x57991106cb7aa27e2771beda0d6522f68524a888',
          liquidity: '482843960670027606548690',
          token0: {
            symbol: 'ETH',
            id: '0x0000000000000000000000000000000000000000',
            name: 'ETH',
            decimals: '18',
          },
          token1: {
            symbol: 'WETH',
            id: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
            name: 'WETH',
            decimals: '18',
          },
          tvlETH: Number('44000.1795925485023741879813651641809'),
          tvlUSD: Number('95050000.95363442908526427214106054717'),
        } as V4SubgraphPool);
      }

      if (chainId === ChainId.MONAD) {
        manuallyIncludedV4Pools.push({
          id: '0xbe86cc52a3300525c410fa1af308193a4a6fa9536f7a29f62b7d0fe018c94e85',
          feeTier: '0',
          tickSpacing: '1',
          hooks: '0x3fad8a7205f943528915e67cf94fc792c8fce888',
          liquidity: '482843960670027606548690',
          token0: {
            symbol: 'MON',
            id: '0x0000000000000000000000000000000000000000',
            name: 'MON',
            decimals: '18',
          },
          token1: {
            symbol: 'WMON',
            id: '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A',
            name: 'WMON',
            decimals: '18',
          },
          tvlETH: Number('44000.1795925485023741879813651641809'),
          tvlUSD: Number('95050000.95363442908526427214106054717'),
        } as V4SubgraphPool);
      }

      // Also include the 3 graduation hook pools from routing-api
      if (chainId === ChainId.BASE) {
        manuallyIncludedV4Pools.push(
          {
            id: '0xe9eeab9794c33dff3dd8d0951cbe2d36619294af5a3a329f38f91f54be0b6d34',
            feeTier: '10000',
            tickSpacing: '200',
            hooks: '0xc5a48b447f01e9ce3ede71e4c1c2038c38bd9000',
            liquidity: '274563705100803912362733',
            token0: {
              symbol: 'fid:385955',
              id: '0x112cf1cc540eadf234158c0e4044c3b5f2a33e5e',
              name: 'degenfans',
              decimals: '18',
            },
            token1: {
              symbol: 'MOXIE',
              id: '0x8c9037d1ef5c6d1f6816278c7aaf5491d24cd527',
              name: 'Moxie',
              decimals: '18',
            },
            tvlETH: Number('25.33120577965346308313185954009482'),
            tvlUSD: Number('56627.5525783346590219799350683533'),
          } as V4SubgraphPool,
          {
            id: '0x6bac01f0a8fb96eeb56e37506f210628714561113c748d43c6de50dc339edfe9',
            feeTier: '10000',
            tickSpacing: '200',
            hooks: '0xc5a48b447f01e9ce3ede71e4c1c2038c38bd9000',
            liquidity: '621568112474979678301274',
            token0: {
              symbol: 'base-economy',
              id: '0x125490489a27d541e39813c08d260debac071bb7',
              name: 'Base Economy',
              decimals: '18',
            },
            token1: {
              symbol: 'MOXIE',
              id: '0x8c9037d1ef5c6d1f6816278c7aaf5491d24cd527',
              name: 'Moxie',
              decimals: '18',
            },
            tvlETH: Number('142.7576163222032969740638595951846'),
            tvlUSD: Number('316322.6881520965844428159264274397'),
          } as V4SubgraphPool,
          {
            id: '0x31781e65a4bd9ff0161e660f7930beee16026f819cd4d0bc7e17f6c78c29fc27',
            feeTier: '10000',
            tickSpacing: '200',
            hooks: '0xc5a48b447f01e9ce3ede71e4c1c2038c38bd9000',
            liquidity: '482843960670027606548690',
            token0: {
              symbol: 'fid:444067',
              id: '0x15148da22518e40e0d2fabf5d5e6a22269ebcb30',
              name: 'macster',
              decimals: '18',
            },
            token1: {
              symbol: 'MOXIE',
              id: '0x8c9037d1ef5c6d1f6816278c7aaf5491d24cd527',
              name: 'Moxie',
              decimals: '18',
            },
            tvlETH: Number('44.1795925485023741879813651641809'),
            tvlUSD: Number('95050.95363442908526427214106054717'),
          } as V4SubgraphPool
        );
      }

      manuallyIncludedV4Pools.forEach(pool => pools.push(pool));
      // Populated only when FACTORY_ZLCA_HOOKS_ENABLED ran the refresh above.
      const dynamicZlcaHookMap = getDynamicZlcaHooks(chainId);
      pools = v4HooksPoolsFiltering(
        chainId,
        pools as Array<V4SubgraphPool>,
        logger,
        metricInstance,
        dynamicZlcaHookMap ? new Set(dynamicZlcaHookMap.keys()) : undefined
      );

      const guideStarStableStablePools = pools.filter(
        pool =>
          (pool as V4SubgraphPool).hooks?.toLowerCase() ===
          GUIDESTAR_STABLE_STABLE_HOOK_ON_MAINNET.toLowerCase()
      );
      if (guideStarStableStablePools.length > 0) {
        logger.debug(
          `Found GuideStar stable-stable pool ${JSON.stringify(guideStarStableStablePools)}`
        );
      }
    }

    metricInstance.putMetric(
      'CachePools.getPools.latency',
      Date.now() - beforeGetPool,
      MetricLoggerUnit.Milliseconds,
      metricTags
    );
  } catch (err) {
    metricInstance.putMetric(
      'CachePools.getPools.error',
      1,
      MetricLoggerUnit.Count,
      metricTags
    );
    logger.error(
      `Failed to get pools from ${protocol} subgraph provider: ${err instanceof Error ? err.message : String(err)}`,
      {err}
    );
    throw err;
  }

  if (!pools || pools.length === 0) {
    metricInstance.putMetric(
      'CachePools.getPools.empty',
      1,
      MetricLoggerUnit.Count,
      metricTags
    );
    logger.info('No pools found from the subgraph');
    return;
  }

  const beforeS3 = Date.now();
  logger.info(
    `Got ${pools.length} pools from the subgraph. Saving to ${compressedKey}`
  );

  const serializedPools = JSON.stringify(pools);
  const compressedPools = zlib.deflateSync(serializedPools);

  const serializedSizeMB = (
    Buffer.byteLength(serializedPools, 'utf8') /
    (1024 * 1024)
  ).toFixed(2);
  const compressedSizeMB = (
    Buffer.byteLength(compressedPools) /
    (1024 * 1024)
  ).toFixed(2);

  const skipStaleWrite = (why: string) => {
    logger.info(`Skipping S3 write: ${compressedKey} ${why}`);
    metricInstance.putMetric(
      'CachePools.s3.skipped_stale_write',
      1,
      MetricLoggerUnit.Count,
      metricTags
    );
  };

  // Freshness arbitration: several writers can target this key (fast
  // Robinhood cron, all-chains cron, on-demand one-shot, and timed-out runs
  // that withTimeout detached but could not cancel), and write ORDER does
  // not imply data freshness — a detached orphan can write late with older
  // data. The winner is the snapshot with the newest FETCH start: each
  // snapshot records its fetch start in object metadata, we skip when the
  // existing object's recorded fetch start is at least as fresh as ours,
  // and the put is conditioned (IfMatch / IfNoneMatch) on exactly the
  // version the pre-write head observed. A conditional-write conflict means
  // the object changed under us — re-check against the new version and
  // retry. Objects written before this scheme lack the metadata; their
  // LastModified (an upper bound on their fetch start) is the fallback.
  let result;
  const MAX_WRITE_ATTEMPTS = 3;
  for (let attempt = 1; ; attempt++) {
    let putCondition: {IfMatch?: string; IfNoneMatch?: string} = {};
    try {
      const head = await s3.send(
        new HeadObjectCommand({Bucket: config.s3Bucket, Key: compressedKey})
      );
      const existingRaw = head.Metadata?.[FETCH_START_METADATA_KEY];
      const parsedFetchStart = existingRaw ? new Date(existingRaw) : undefined;
      const existingFetchStart =
        parsedFetchStart !== undefined &&
        !Number.isNaN(parsedFetchStart.getTime()) &&
        parsedFetchStart.getTime() <=
          Date.now() + FETCH_START_MAX_FUTURE_SKEW_MS
          ? parsedFetchStart
          : undefined;
      const existingIsFresher =
        existingFetchStart !== undefined
          ? existingFetchStart >= fetchStartTime
          : head.LastModified !== undefined &&
            head.LastModified > fetchStartTime;
      if (existingIsFresher) {
        skipStaleWrite(
          `already holds data fetched at ${existingFetchStart?.toISOString() ?? `<=${head.LastModified?.toISOString()}`}, at least as fresh as this run's ${fetchStartTime.toISOString()}`
        );
        return;
      }
      if (head.ETag) {
        putCondition = {IfMatch: head.ETag};
      }
    } catch (err) {
      const name = (err as {name?: string})?.name;
      const status = (err as {$metadata?: {httpStatusCode?: number}})?.$metadata
        ?.httpStatusCode;
      if (name === 'NotFound' || status === 404) {
        // First write for this key — reject if another writer creates it first.
        putCondition = {IfNoneMatch: '*'};
      } else {
        // Fail CLOSED: without seeing the incumbent we cannot arbitrate,
        // and an unconditional write could clobber fresher data with a
        // stale orphan snapshot. Retry, then surface as a task failure —
        // a missed write ages the snapshot by one cadence and is visible;
        // a stale clobber is silent.
        if (attempt < MAX_WRITE_ATTEMPTS) {
          logger.info(
            `HeadObject failed for ${compressedKey} (attempt ${attempt}); retrying freshness check`
          );
          continue;
        }
        throw err;
      }
    }

    try {
      result = await s3.send(
        new PutObjectCommand({
          Bucket: config.s3Bucket,
          Key: compressedKey,
          Body: compressedPools,
          Metadata: {[FETCH_START_METADATA_KEY]: fetchStartTime.toISOString()},
          ...putCondition,
        })
      );
      break;
    } catch (err) {
      const name = (err as {name?: string})?.name;
      const status = (err as {$metadata?: {httpStatusCode?: number}})?.$metadata
        ?.httpStatusCode;
      const conflict =
        status === 412 ||
        status === 409 ||
        status === 404 || // IfMatch put against a key deleted since the head
        name === 'PreconditionFailed' ||
        name === 'ConditionalRequestConflict' ||
        name === 'NoSuchKey';
      if (conflict && attempt < MAX_WRITE_ATTEMPTS) {
        // The object changed (or vanished) under us. Do NOT assume the
        // competing writer's data is fresher or that its write succeeded —
        // re-head and re-arbitrate against whatever is there now.
        logger.info(
          `Conditional S3 write conflict for ${compressedKey} (attempt ${attempt}); re-checking`
        );
        continue;
      }
      throw err;
    }
  }

  metricInstance.putMetric(
    'CachePools.s3.latency',
    Date.now() - beforeS3,
    MetricLoggerUnit.Milliseconds,
    metricTags
  );
  logger.info(`Done. Cached to S3 bucket ${config.s3Bucket}`, {result});

  logger.info(
    `compression ratio: ${serializedPools.length}:${compressedPools.length} (${serializedSizeMB}MB -> ${compressedSizeMB}MB)`
  );
  metricInstance.putMetric(
    'CachePools.compression_ratio',
    serializedPools.length / compressedPools.length,
    MetricLoggerUnit.None,
    metricTags
  );
  metricInstance.putMetric(
    'CachePools.compressed_size_mb',
    parseFloat(compressedSizeMB),
    MetricLoggerUnit.Megabytes,
    metricTags
  );
  metricInstance.putMetric(
    'CachePools.serialized_size_mb',
    parseFloat(serializedSizeMB),
    MetricLoggerUnit.Megabytes,
    metricTags
  );
}

export interface CacheAllPoolsResult {
  succeeded: number;
  failed: number;
  // Settles only when every underlying per-chain+protocol task has settled,
  // INCLUDING tasks the per-job timeout detached (withTimeout cannot cancel
  // them). Overlap guards must wait on this, not on cacheAllPools itself.
  workSettled: Promise<void>;
}

/**
 * Runs all pool caching jobs in batches of `batchSize` to control memory usage.
 * Each job fetches pools from subgraph for a given chain+protocol, compresses, and uploads to S3.
 * Per-job failures are tolerated (logged + counted); callers decide from the
 * returned counts whether the run as a whole is healthy.
 */
// Module-level so the enumeration cursor survives across runs in the
// long-lived cronService process (a run-once ECS task simply does one full
// read). FACTORY_ZLCA_HOOKS_ENABLED gates the whole feature: this refresh,
// the filter admission below, and the serve-side refresher.
let zlcaHooksRefresher: DynamicZlcaHooksRefresher | undefined;
const ZLCA_HOOKS_REFRESH_TIMEOUT_MS = 20000;

async function refreshDynamicZlcaHooks(
  logger: Logger,
  metricInstance: IMetric
): Promise<void> {
  if (process.env.FACTORY_ZLCA_HOOKS_ENABLED !== 'true') return;
  zlcaHooksRefresher ??= createDynamicZlcaHooksRefresherFromEnv(
    logger,
    metricInstance
  );
  if (!zlcaHooksRefresher) return;
  try {
    // refreshOnce is fail-open per chain; the timeout guards a hung RPC so
    // a bad gateway can't eat the run's budget.
    await withTimeout(
      zlcaHooksRefresher.refreshOnce(),
      ZLCA_HOOKS_REFRESH_TIMEOUT_MS,
      'zlcaFactoryHooksRefresh'
    );
  } catch (error) {
    logger.warn(`Dynamic ZLCA hooks refresh skipped: ${error}`);
  }
}

export async function cacheAllPools(
  logger: Logger,
  metricInstance: IMetric,
  config: CachePoolsConfig,
  batchSize = 5,
  perJobTimeoutMs = 300000,
  only?: Array<{chainId: number; protocol: Protocol}>
): Promise<CacheAllPoolsResult> {
  const s3 = new S3Client({region: process.env.AWS_REGION || 'us-east-2'});
  const cronLogger = prefixedLogger(logger, '[SubgraphCron]');
  // Refresh factory-discovered ZLCA hooks before fetching so this run's
  // tvl-bypass subgraph query and V4 filtering see them (fail-open).
  await refreshDynamicZlcaHooks(cronLogger, metricInstance);
  let chainProtocols = createChainProtocols(cronLogger, metricInstance);
  if (only !== undefined && only.length > 0) {
    chainProtocols = chainProtocols.filter(cp =>
      only.some(o => o.chainId === cp.chainId && o.protocol === cp.protocol)
    );
    if (chainProtocols.length === 0) {
      // Misconfiguration (e.g. the target chain was removed from
      // createChainProtocols): without this the run would silently no-op.
      // Callers see it via the {succeeded: 0, failed: 0} result.
      cronLogger.error(
        `'only' filter (${only.map(o => `${o.chainId}_${o.protocol}`).join(', ')}) matched no configured chain+protocols — nothing will be cached`
      );
    }
  }

  cronLogger.info(
    `Starting pool caching for ${chainProtocols.length} chain+protocol combinations${
      only !== undefined && only.length > 0
        ? ` (only ${only.map(o => `${o.chainId}_${o.protocol}`).join(', ')})`
        : ''
    } (batch size: ${batchSize}, per-job timeout: ${perJobTimeoutMs}ms)`
  );

  let succeeded = 0;
  let failed = 0;
  const allRawTasks: Promise<void>[] = [];
  for (let i = 0; i < chainProtocols.length; i += batchSize) {
    const batch = chainProtocols.slice(i, i + batchSize);
    const batchLabel = `batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(chainProtocols.length / batchSize)}`;

    cronLogger.info(
      `Processing ${batchLabel}: ${batch.map(cp => `${cp.protocol}/${cp.chainId}`).join(', ')}`
    );

    const rawTasks = batch.map(cp =>
      cachePoolsForChainProtocol(cp, s3, config, cronLogger, metricInstance)
    );
    allRawTasks.push(...rawTasks);
    const results = await Promise.allSettled(
      rawTasks.map((task, idx) =>
        withTimeout(
          task,
          perJobTimeoutMs,
          `${batch[idx]!.chainId}_${batch[idx]!.protocol}`
        )
      )
    );

    results.forEach((result, idx) => {
      const cp = batch[idx]!;
      if (result.status === 'rejected') {
        failed += 1;
        const reason = result.reason;
        cronLogger.error(
          `[${cp.chainId}_${cp.protocol}] Failed to cache pools: ${reason instanceof Error ? reason.message : String(reason)}`,
          {err: reason}
        );
        metricInstance.putMetric(
          'CachePools.batch.error',
          1,
          MetricLoggerUnit.Count,
          {chainId: String(cp.chainId), protocol: String(cp.protocol)}
        );
      } else {
        succeeded += 1;
      }
    });
  }

  cronLogger.info(
    `Pool caching complete (${succeeded} succeeded, ${failed} failed)`
  );
  return {
    succeeded,
    failed,
    workSettled: Promise.allSettled(allRawTasks).then(() => undefined),
  };
}
