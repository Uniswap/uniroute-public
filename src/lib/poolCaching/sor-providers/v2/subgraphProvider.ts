/**
 * Ported from @uniswap/smart-order-router/src/providers/v2/subgraph-provider.ts
 * V2 subgraph provider - standalone implementation (does not extend base SubgraphProvider).
 */

import {ChainId, Token} from '@uniswap/sdk-core';
import retry from 'async-retry';
import Timeout from 'await-timeout';
import {gql, GraphQLClient} from 'graphql-request';
import _ from 'lodash';

import {Logger} from '../util/log';
import {IMetric} from '../util/metric';
import {ProviderConfig} from '../provider';

export interface V2SubgraphPool {
  id: string;
  token0: {
    id: string;
  };
  token1: {
    id: string;
  };
  supply: number;
  reserve: number;
  reserveUSD: number;
}

type RawV2SubgraphPool = {
  id: string;
  token0: {
    symbol: string;
    id: string;
  };
  token1: {
    symbol: string;
    id: string;
  };
  totalSupply: string;
  trackedReserveETH: string;
  reserveUSD: string;
};

const SUBGRAPH_URL_BY_CHAIN: {[chainId in ChainId]?: string} = {
  [ChainId.MAINNET]:
    'https://api.thegraph.com/subgraphs/name/ianlapham/uniswap-v2-dev',
};

const PAGE_SIZE = 1000; // 1k is max possible query size from subgraph.

/**
 * Provider for getting V2 pools from the Subgraph
 *
 * @export
 * @interface IV2SubgraphProvider
 */
export interface IV2SubgraphProvider {
  getPools(
    tokenIn?: Token,
    tokenOut?: Token,
    providerConfig?: ProviderConfig
  ): Promise<V2SubgraphPool[]>;
}

export class V2SubgraphProvider implements IV2SubgraphProvider {
  private client: GraphQLClient;
  private metricTags: Record<string, string>;

  constructor(
    private chainId: ChainId,
    private retries = 2,
    private timeout = 360000,
    private rollback = true,
    private pageSize = PAGE_SIZE,
    private trackedEthThreshold = 0.025,
    private untrackedUsdThreshold = Number.MAX_VALUE,
    private subgraphUrlOverride?: string,
    private bearerToken?: string,
    private logger?: Logger,
    private metric?: IMetric
  ) {
    this.metricTags = {chainId: String(chainId), protocol: 'v2'};
    if (this.logger) {
      const orig = this.logger;
      this.logger = {
        info: (msg, ...extra) => orig.info(`[${chainId}_V2] ${msg}`, ...extra),
        warn: (msg, ...extra) => orig.warn(`[${chainId}_V2] ${msg}`, ...extra),
        error: (msg, ...extra) =>
          orig.error(`[${chainId}_V2] ${msg}`, ...extra),
        debug: (msg, ...extra) =>
          orig.debug(`[${chainId}_V2] ${msg}`, ...extra),
        fatal: (msg, ...extra) =>
          orig.fatal(`[${chainId}_V2] ${msg}`, ...extra),
      };
    }
    const subgraphUrl =
      this.subgraphUrlOverride ?? SUBGRAPH_URL_BY_CHAIN[this.chainId];
    if (!subgraphUrl) {
      throw new Error(`No subgraph url for chain id: ${this.chainId}`);
    }
    this.logger?.info('bearerToken is', this.bearerToken);
    if (this.bearerToken) {
      this.client = new GraphQLClient(subgraphUrl, {
        headers: {
          authorization: `Bearer ${this.bearerToken}`,
        },
      });
    } else {
      this.client = new GraphQLClient(subgraphUrl);
    }
  }

  public async getPools(
    _tokenIn?: Token,
    _tokenOut?: Token,
    providerConfig?: ProviderConfig
  ): Promise<V2SubgraphPool[]> {
    const beforeAll = Date.now();
    let blockNumber = providerConfig?.blockNumber
      ? await providerConfig.blockNumber
      : undefined;

    this.logger?.info(
      `Getting V2 pools from the subgraph with page size ${this.pageSize}${
        providerConfig?.blockNumber
          ? ` as of block ${providerConfig?.blockNumber}`
          : ''
      }.`
    );

    // TODO: Remove. Temporary fix to ensure tokens without trackedReserveETH are in the list.
    const FEI = '0x956f47f50a910163d8bf957cf5846d573e7f87ca';
    const virtualTokenAddress =
      '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b'.toLowerCase();

    // Define separate queries for each filtering condition
    // Note: GraphQL doesn't support OR conditions, so we need separate queries for each condition
    const queries = [
      // 1. FEI token pools - split into two queries since OR is not supported
      {
        name: 'FEI pools (token0)',
        query: gql`
          query getFEIPoolsToken0($pageSize: Int!, $id: String, $feiToken: String!) {
            pairs(
              first: $pageSize
              ${blockNumber ? `block: { number: ${blockNumber} }` : ''}
              where: {
                id_gt: $id,
                token0: $feiToken
              }
            ) {
              id
              token0 { id, symbol }
              token1 { id, symbol }
              totalSupply
              trackedReserveETH
              reserveETH
              reserveUSD
            }
          }
        `,
        variables: {feiToken: FEI},
      },
      {
        name: 'FEI pools (token1)',
        query: gql`
          query getFEIPoolsToken1($pageSize: Int!, $id: String, $feiToken: String!) {
            pairs(
              first: $pageSize
              ${blockNumber ? `block: { number: ${blockNumber} }` : ''}
              where: {
                id_gt: $id,
                token1: $feiToken
              }
            ) {
              id
              token0 { id, symbol }
              token1 { id, symbol }
              totalSupply
              trackedReserveETH
              reserveETH
              reserveUSD
            }
          }
        `,
        variables: {feiToken: FEI},
      },
      // 2. Virtual pair pools (only for BASE chain) - split into two queries
      ...(this.chainId === ChainId.BASE
        ? [
            {
              name: 'Virtual pair pools (token0)',
              query: gql`
            query getVirtualPoolsToken0($pageSize: Int!, $id: String, $virtualToken: String!) {
              pairs(
                first: $pageSize
                ${blockNumber ? `block: { number: ${blockNumber} }` : ''}
                where: {
                  id_gt: $id,
                  token0: $virtualToken
                }
              ) {
                id
                token0 { id, symbol }
                token1 { id, symbol }
                totalSupply
                trackedReserveETH
                reserveETH
                reserveUSD
              }
            }
          `,
              variables: {virtualToken: virtualTokenAddress},
            },
            {
              name: 'Virtual pair pools (token1)',
              query: gql`
            query getVirtualPoolsToken1($pageSize: Int!, $id: String, $virtualToken: String!) {
              pairs(
                first: $pageSize
                ${blockNumber ? `block: { number: ${blockNumber} }` : ''}
                where: {
                  id_gt: $id,
                  token1: $virtualToken
                }
              ) {
                id
                token0 { id, symbol }
                token1 { id, symbol }
                totalSupply
                trackedReserveETH
                reserveETH
                reserveUSD
              }
            }
          `,
              variables: {virtualToken: virtualTokenAddress},
            },
          ]
        : []),
      // 3. High tracked reserve ETH pools
      {
        name: 'High tracked reserve ETH pools',
        query: gql`
          query getHighTrackedReservePools($pageSize: Int!, $id: String, $threshold: String!) {
            pairs(
              first: $pageSize
              ${blockNumber ? `block: { number: ${blockNumber} }` : ''}
              where: {
                id_gt: $id,
                trackedReserveETH_gt: $threshold
              }
            ) {
              id
              token0 { id, symbol }
              token1 { id, symbol }
              totalSupply
              trackedReserveETH
              reserveETH
              reserveUSD
            }
          }
        `,
        variables: {threshold: this.trackedEthThreshold.toString()},
      },
      // 4. High untracked USD pools
      {
        name: 'High untracked USD pools',
        query: gql`
          query getHighUSDReservePools($pageSize: Int!, $id: String, $threshold: String!) {
            pairs(
              first: $pageSize
              ${blockNumber ? `block: { number: ${blockNumber} }` : ''}
              where: {
                id_gt: $id,
                reserveUSD_gt: $threshold
              }
            ) {
              id
              token0 { id, symbol }
              token1 { id, symbol }
              totalSupply
              trackedReserveETH
              reserveETH
              reserveUSD
            }
          }
        `,
        variables: {threshold: this.untrackedUsdThreshold.toString()},
      },
    ];

    let allPools: RawV2SubgraphPool[] = [];
    let outerRetries = 0;

    await retry(
      async () => {
        const timeout = new Timeout();

        const fetchPoolsForQuery = async (
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          queryConfig: any
        ): Promise<RawV2SubgraphPool[]> => {
          let lastId = '';
          let pools: RawV2SubgraphPool[] = [];
          let poolsPage: RawV2SubgraphPool[] = [];
          let totalPages = 0;
          let retries = 0;

          do {
            totalPages += 1;

            const start = Date.now();
            this.logger?.info(
              `Starting fetching for ${queryConfig.name} page ${totalPages} with page size ${this.pageSize}`
            );

            await retry(
              async () => {
                const before = Date.now();
                const poolsResult = await this.client.request<{
                  pairs: RawV2SubgraphPool[];
                }>(queryConfig.query, {
                  pageSize: this.pageSize,
                  id: lastId,
                  ...queryConfig.variables,
                });
                this.metric?.putMetric(
                  `SubgraphProvider.getPools.${queryConfig.name
                    .replace(/\s+/g, '_')
                    .toLowerCase()}.paginate.latency`,
                  Date.now() - before,
                  undefined,
                  this.metricTags
                );

                poolsPage = poolsResult.pairs;

                pools = pools.concat(poolsPage);
                if (pools.length > 0) {
                  lastId = pools[pools.length - 1]!.id;
                }

                this.metric?.putMetric(
                  `SubgraphProvider.getPools.${queryConfig.name
                    .replace(/\s+/g, '_')
                    .toLowerCase()}.paginate.pageSize`,
                  poolsPage.length,
                  undefined,
                  this.metricTags
                );
              },
              {
                retries: this.retries,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                onRetry: (err: any, retry: number) => {
                  retries += 1;
                  this.logger?.error(
                    `Failed request for ${queryConfig.name} page of pools from subgraph. Retry attempt: ${retry}. LastId: ${lastId}`,
                    {err, lastId}
                  );
                },
              }
            );
            this.logger?.info(
              `Fetched ${poolsPage.length} pools for ${queryConfig.name} in ${
                Date.now() - start
              }ms`
            );
          } while (poolsPage.length > 0);

          this.metric?.putMetric(
            `SubgraphProvider.getPools.${queryConfig.name
              .replace(/\s+/g, '_')
              .toLowerCase()}.paginate`,
            totalPages,
            undefined,
            this.metricTags
          );
          this.metric?.putMetric(
            `SubgraphProvider.getPools.${queryConfig.name
              .replace(/\s+/g, '_')
              .toLowerCase()}.pairs.length`,
            pools.length,
            undefined,
            this.metricTags
          );
          this.metric?.putMetric(
            `SubgraphProvider.getPools.${queryConfig.name
              .replace(/\s+/g, '_')
              .toLowerCase()}.paginate.retries`,
            retries,
            undefined,
            this.metricTags
          );

          return pools;
        };

        try {
          // Fetch pools for each query in parallel
          const poolPromises = queries.map(queryConfig =>
            fetchPoolsForQuery(queryConfig)
          );
          const allPoolsArrays = await Promise.all(poolPromises);

          // Merge all results and deduplicate by pool ID
          const poolMap = new Map<string, RawV2SubgraphPool>();
          allPoolsArrays.forEach(pools => {
            pools.forEach(pool => {
              poolMap.set(pool.id, pool);
            });
          });

          allPools = Array.from(poolMap.values());

          const getPoolsPromise = Promise.resolve(allPools);
          const timerPromise = timeout.set(this.timeout).then(() => {
            throw new Error(
              `Timed out getting pools from subgraph: ${this.timeout}`
            );
          });
          allPools = await Promise.race([getPoolsPromise, timerPromise]);
          return;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (err: any) {
          this.logger?.error('Error fetching V2 Subgraph Pools.', {err});
          throw err;
        } finally {
          timeout.clear();
        }
      },
      {
        retries: this.retries,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onRetry: (err: any, retry: number) => {
          outerRetries += 1;
          if (
            this.rollback &&
            blockNumber &&
            _.includes(err.message, 'indexed up to')
          ) {
            this.metric?.putMetric(
              'SubgraphProvider.getPools.indexError',
              1,
              undefined,
              this.metricTags
            );
            blockNumber = blockNumber - 10;
            this.logger?.info(
              `Detected subgraph indexing error. Rolled back block number to: ${blockNumber}`
            );
          }
          this.metric?.putMetric(
            'SubgraphProvider.getPools.timeout',
            1,
            undefined,
            this.metricTags
          );
          allPools = [];
          this.logger?.info(
            `Failed to get pools from subgraph. Retry attempt: ${retry}`,
            {err}
          );
        },
      }
    );

    this.metric?.putMetric(
      'SubgraphProvider.getPools.retries',
      outerRetries,
      undefined,
      this.metricTags
    );

    // Apply the same filtering logic to ensure consistency
    const beforeFilter = Date.now();
    const poolsSanitized: V2SubgraphPool[] = allPools
      .filter(pool => {
        return (
          pool.token0.id === FEI ||
          pool.token1.id === FEI ||
          this.isVirtualPairBaseV2Pool(pool) ||
          parseFloat(pool.trackedReserveETH) > this.trackedEthThreshold ||
          parseFloat(pool.reserveUSD) > this.untrackedUsdThreshold
        );
      })
      .map(pool => {
        return {
          id: pool.id.toLowerCase(),
          token0: {
            id: pool.token0.id.toLowerCase(),
          },
          token1: {
            id: pool.token1.id.toLowerCase(),
          },
          supply: parseFloat(pool.totalSupply),
          reserve: parseFloat(pool.trackedReserveETH),
          reserveUSD: parseFloat(pool.reserveUSD),
        };
      });

    this.metric?.putMetric(
      'SubgraphProvider.getPools.filter.latency',
      Date.now() - beforeFilter,
      undefined,
      this.metricTags
    );
    this.metric?.putMetric(
      'SubgraphProvider.getPools.untracked.length',
      poolsSanitized.length,
      undefined,
      this.metricTags
    );
    this.metric?.putMetric(
      'SubgraphProvider.getPools.untracked.percent',
      (poolsSanitized.length / allPools.length) * 100,
      undefined,
      this.metricTags
    );
    this.metric?.putMetric(
      'SubgraphProvider.getPools',
      1,
      undefined,
      this.metricTags
    );
    this.metric?.putMetric(
      'SubgraphProvider.getPools.latency',
      Date.now() - beforeAll,
      undefined,
      this.metricTags
    );

    this.logger?.info(
      `Got ${allPools.length} V2 pools from the subgraph (after deduplication). ${poolsSanitized.length} after filtering`
    );

    return poolsSanitized;
  }

  // This method checks if a given pool contains the VIRTUAL token.
  public isVirtualPairBaseV2Pool(pool: RawV2SubgraphPool): boolean {
    const virtualTokenAddress =
      '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b'.toLowerCase();
    return (
      this.chainId === ChainId.BASE &&
      (pool.token0.id.toLowerCase() === virtualTokenAddress ||
        pool.token1.id.toLowerCase() === virtualTokenAddress)
    );
  }
}
