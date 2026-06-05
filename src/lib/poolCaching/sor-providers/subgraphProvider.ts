/**
 * Ported from @uniswap/smart-order-router/src/providers/subgraph-provider.ts
 * Base abstract class for V3 and V4 subgraph providers.
 */

import {Protocol} from '@uniswap/router-sdk';
import {ChainId, Currency, Token} from '@uniswap/sdk-core';
import {
  getPermissionedAdapterTokens,
  getPermissionedHookAddresses,
} from '@uniswap/lib-sharedconfig/permissionedTokens';
import {getMajorTokens} from '../util/majorTokens';
import retry from 'async-retry';
import Timeout from 'await-timeout';
import {gql, GraphQLClient} from 'graphql-request';
import _ from 'lodash';

import {Logger} from './util/log';
import {IMetric} from './util/metric';
import {ProviderConfig} from './provider';

export interface ISubgraphProvider<TSubgraphPool> {
  getPools(
    tokenIn?: Token,
    tokenOut?: Token,
    providerConfig?: ProviderConfig
  ): Promise<TSubgraphPool[]>;
}

export const PAGE_SIZE = 1000; // 1k is max possible query size from subgraph.
export const BASE_V4_PAGE_SIZE = 500; // TheGraph v4 base max pagesize is 3600, but ellipfra query page size perf better with smaller page size

// Minimum TVL threshold applied at the subgraph query level for V4 pools.
// V4 pools with totalValueLockedETH <= this value are excluded from queries.
export const V4_MIN_TVL_ETH = 0.001;

export type V3V4SubgraphPool = {
  id: string;
  feeTier: string;
  liquidity: string;
  token0: {
    id: string;
  };
  token1: {
    id: string;
  };
  tvlETH: number;
  tvlUSD: number;
};

export type V3V4RawSubgraphPool = {
  id: string;
  feeTier: string;
  liquidity: string;
  token0: {
    symbol: string;
    id: string;
  };
  token1: {
    symbol: string;
    id: string;
  };
  totalValueLockedUSD: string;
  totalValueLockedETH: string;
  totalValueLockedUSDUntracked: string;
};

export abstract class SubgraphProvider<
  TRawSubgraphPool extends V3V4RawSubgraphPool,
  TSubgraphPool extends V3V4SubgraphPool,
> {
  private client: GraphQLClient;

  constructor(
    private protocol: Protocol,
    private chainId: ChainId,
    private retries = 2,
    private timeout = 30000,
    private rollback = true,
    private trackedEthThreshold = 0.01,
    private untrackedUsdThreshold = Number.MAX_VALUE,
    private subgraphUrl: string | undefined,
    private bearerToken: string | undefined,
    protected logger: Logger,
    protected metric: IMetric
  ) {
    this.protocol = protocol;
    this.logger = {
      info: (msg, ...extra) =>
        logger.info(`[${chainId}_${protocol}] ${msg}`, ...extra),
      warn: (msg, ...extra) =>
        logger.warn(`[${chainId}_${protocol}] ${msg}`, ...extra),
      error: (msg, ...extra) =>
        logger.error(`[${chainId}_${protocol}] ${msg}`, ...extra),
      debug: (msg, ...extra) =>
        logger.debug(`[${chainId}_${protocol}] ${msg}`, ...extra),
      fatal: (msg, ...extra) =>
        logger.fatal(`[${chainId}_${protocol}] ${msg}`, ...extra),
    };
    if (!this.subgraphUrl) {
      throw new Error(`No subgraph url for chain id: ${this.chainId}`);
    }
    this.logger.info('bearerToken is', this.bearerToken);

    if (this.bearerToken) {
      this.client = new GraphQLClient(this.subgraphUrl, {
        headers: {
          authorization: `Bearer ${this.bearerToken}`,
        },
      });
    } else {
      this.client = new GraphQLClient(this.subgraphUrl);
    }
    this.metricTags = {chainId: String(chainId), protocol: String(protocol)};
  }

  /** Tags passed to every putMetric call so chain+protocol are Datadog tags, not baked into metric name */
  private metricTags: Record<string, string>;

  public async getPools(
    _currencyIn?: Currency,
    _currencyOut?: Currency,
    providerConfig?: ProviderConfig
  ): Promise<TSubgraphPool[]> {
    const beforeAll = Date.now();
    let blockNumber = providerConfig?.blockNumber
      ? await providerConfig.blockNumber
      : undefined;

    const pageSizeToUse =
      this.protocol === Protocol.V4 && this.chainId === ChainId.BASE
        ? BASE_V4_PAGE_SIZE
        : PAGE_SIZE;

    this.logger.info(
      `Getting ${
        this.protocol
      } pools from the subgraph with page size ${pageSizeToUse}${
        providerConfig?.blockNumber
          ? ` as of block ${providerConfig?.blockNumber}`
          : ''
      }.`
    );

    // Permissioned-hook (e.g. Superstate) V4 pools are admitted by their hook,
    // not by tracked liquidity. An adapter↔adapter pool (e.g. PA1/PA2) holds no
    // whitelisted base token, so its totalValueLockedETH is structurally ~0 and
    // it can never clear V4_MIN_TVL_ETH — the floor would drop it from the
    // snapshot, making it unroutable. So fetch these by hook with no TVL floor.
    // But permissioned hook addresses are PUBLIC: an unconstrained fetch is
    // externally bloateable (anyone can initialize pools under the hook). Bound
    // the fetch to the SAME finite pair set the cache admits: BOTH sides must be
    // a "known" token (a registered adapter OR a major/base token) and one side
    // must be a registered adapter. Two split queries (one per adapter side;
    // GraphQL `where` is AND-only) — a PA1/arbitrary-token pool matches neither,
    // so junk is never paged. feeTier/tickSpacing are also constrained to the
    // canonical V4 set so the PoolKey space is fully finite (and matches what
    // quickRoute probes). Per-hook adapter OWNERSHIP is enforced downstream in
    // v4HooksPoolsFiltering. Sourced from the shared registry + major tokens.
    const permissionedHooks =
      this.protocol === Protocol.V4
        ? getPermissionedHookAddresses(this.chainId)
        : [];
    const permissionedAdapters =
      this.protocol === Protocol.V4
        ? Array.from(getPermissionedAdapterTokens(this.chainId))
        : [];
    // Known counter-tokens = adapters ∪ chain major/base tokens (all lowercased).
    const knownTokens =
      this.protocol === Protocol.V4
        ? Array.from(
            new Set([...permissionedAdapters, ...getMajorTokens(this.chainId)])
          )
        : [];
    const includePermissionedQuery =
      permissionedHooks.length > 0 && permissionedAdapters.length > 0;
    const permissionedHookQuery = (adapterField: 'token0_in' | 'token1_in') => {
      const knownField =
        adapterField === 'token0_in' ? 'token1_in' : 'token0_in';
      return {
        name: `V4 permissioned hook pools ${adapterField}`,
        query: gql`
          query getV4PermissionedHookPools($pageSize: Int!, $id: String, $permissionedHooks: [String!]!, $permissionedAdapters: [String!]!, $knownTokens: [String!]!) {
            pools(
              first: $pageSize
              ${blockNumber ? `block: { number: ${blockNumber} }` : ''}
              where: {
                id_gt: $id,
                liquidity_gt: "0",
                hooks_in: $permissionedHooks,
                ${adapterField}: $permissionedAdapters,
                ${knownField}: $knownTokens,
                feeTier_in: ["100", "500", "3000", "10000"],
                tickSpacing_in: [1, 10, 60, 200]
              }
            ) {
              ${this.getPoolFields()}
            }
          }
        `,
        variables: {permissionedHooks, permissionedAdapters, knownTokens},
      };
    };

    // Define separate queries for each filtering condition
    const queries = [
      // 1. Pools with high tracked ETH (for both V3 and V4)
      {
        name: 'High tracked ETH pools',
        query: gql`
          query getHighTrackedETHPools($pageSize: Int!, $id: String, $threshold: String!) {
            pools(
              first: $pageSize
              ${blockNumber ? `block: { number: ${blockNumber} }` : ''}
              where: {
                id_gt: $id,
                totalValueLockedETH_gt: $threshold
              }
            ) {
              ${this.getPoolFields()}
            }
          }
        `,
        variables: {threshold: this.trackedEthThreshold.toString()},
      },
      // 2. V4: All pools with liquidity > 0 and TVL above minimum.
      // Previously split into zora vs non-zora queries, but the
      // V4_MIN_TVL_ETH threshold now applies uniformly to all V4 pools.
      ...(this.protocol === Protocol.V4
        ? [
            {
              name: 'V4 high liquidity pools',
              query: gql`
          query getV4HighLiquidityPools($pageSize: Int!, $id: String, $minTvl: String!) {
            pools(
              first: $pageSize
              ${blockNumber ? `block: { number: ${blockNumber} }` : ''}
              where: {
                id_gt: $id,
                liquidity_gt: "0",
                totalValueLockedETH_gt: $minTvl
              }
            ) {
              ${this.getPoolFields()}
            }
          }
        `,
              variables: {
                minTvl: V4_MIN_TVL_ETH.toString(),
              },
            },
          ]
        : []),
      // 3. V3: Pools with liquidity > 0 AND totalValueLockedETH = 0 (special V3 condition)
      ...(this.protocol === Protocol.V3
        ? [
            {
              name: 'V3 zero ETH pools',
              query: gql`
          query getV3ZeroETHPools($pageSize: Int!, $id: String) {
            pools(
              first: $pageSize
              ${blockNumber ? `block: { number: ${blockNumber} }` : ''}
              where: {
                id_gt: $id,
                liquidity_gt: "0",
                totalValueLockedETH: "0"
              }
            ) {
              ${this.getPoolFields()}
            }
          }
        `,
              variables: {},
            },
          ]
        : []),
      // 4. V4: Permissioned-hook pools regardless of TVL, bounded to registered
      // adapter endpoints (token0 OR token1) so a public hooks_in-only fetch
      // can't be bloated by arbitrary pools initialized under the hook. Two
      // split queries because GraphQL `where` is AND-only. Skipped on chains
      // with no permissioned hooks/adapters configured.
      ...(includePermissionedQuery
        ? [
            permissionedHookQuery('token0_in'),
            permissionedHookQuery('token1_in'),
          ]
        : []),
    ];

    let allPools: TRawSubgraphPool[] = [];
    let retries = 0;

    await retry(
      async () => {
        const timeout = new Timeout();

        const fetchPoolsForQuery = async (
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          queryConfig: any
        ): Promise<TRawSubgraphPool[]> => {
          let lastId = '';
          let pools: TRawSubgraphPool[] = [];
          let poolsPage: TRawSubgraphPool[] = [];
          let totalPages = 0;

          do {
            totalPages += 1;

            const start = Date.now();
            this.logger.info(
              `Starting fetching for ${queryConfig.name} page ${totalPages} with page size ${pageSizeToUse}`
            );

            const poolsResult = await this.client.request<{
              pools: TRawSubgraphPool[];
            }>(queryConfig.query, {
              pageSize: pageSizeToUse,
              id: lastId,
              ...queryConfig.variables,
            });

            poolsPage = poolsResult.pools;

            pools = pools.concat(poolsPage);

            if (pools.length > 0) {
              lastId = pools[pools.length - 1]!.id;
            }

            this.metric.putMetric(
              `SubgraphProvider.getPools.${queryConfig.name
                .replace(/\s+/g, '_')
                .toLowerCase()}.paginate.pageSize`,
              poolsPage.length,
              undefined,
              this.metricTags
            );
            this.logger.info(
              `Fetched ${poolsPage.length} pools for ${queryConfig.name} in ${
                Date.now() - start
              }ms`
            );
          } while (poolsPage.length > 0);

          this.metric.putMetric(
            `SubgraphProvider.getPools.${queryConfig.name
              .replace(/\s+/g, '_')
              .toLowerCase()}.paginate`,
            totalPages,
            undefined,
            this.metricTags
          );
          this.metric.putMetric(
            `SubgraphProvider.getPools.${queryConfig.name
              .replace(/\s+/g, '_')
              .toLowerCase()}.pools.length`,
            pools.length,
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
          const poolMap = new Map<string, TRawSubgraphPool>();
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
          this.logger.error(`Error fetching ${this.protocol} Subgraph Pools.`, {
            err,
          });
          throw err;
        } finally {
          timeout.clear();
        }
      },
      {
        retries: this.retries,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onRetry: (err: any, retry: number) => {
          retries += 1;
          if (
            this.rollback &&
            blockNumber &&
            _.includes(err.message, 'indexed up to')
          ) {
            this.metric.putMetric(
              'SubgraphProvider.getPools.indexError',
              1,
              undefined,
              this.metricTags
            );
            blockNumber = blockNumber - 10;
            this.logger.info(
              `Detected subgraph indexing error. Rolled back block number to: ${blockNumber}`
            );
          }
          this.metric.putMetric(
            'SubgraphProvider.getPools.timeout',
            1,
            undefined,
            this.metricTags
          );
          allPools = [];
          this.logger.info(
            `Failed to get pools from subgraph. Retry attempt: ${retry}`,
            {err}
          );
        },
      }
    );

    this.metric.putMetric(
      'SubgraphProvider.getPools.retries',
      retries,
      undefined,
      this.metricTags
    );

    const beforeFilter = Date.now();
    let poolsSanitized: TSubgraphPool[] = [];
    if (this.protocol === Protocol.V3) {
      // Special treatment for all V3 pools in order to reduce latency due to thousands of pools with very low TVL locked
      // - Include "parseFloat(pool.totalValueLockedETH) === 0" as in certain occasions we have no way of calculating derivedETH so this is 0
      poolsSanitized = allPools
        .filter(
          pool =>
            (parseInt(pool.liquidity) > 0 &&
              parseFloat(pool.totalValueLockedETH) === 0) ||
            parseFloat(pool.totalValueLockedETH) > this.trackedEthThreshold
        )
        .map(pool => {
          return this.mapSubgraphPool(pool);
        });
    } else if (this.protocol === Protocol.V4) {
      // Include pools that either have positive liquidity or exceed the per-chain
      // tracked ETH threshold. The V4_MIN_TVL_ETH floor at the subgraph query
      // level already excludes V4 pools with totalValueLockedETH <= 0.001.
      poolsSanitized = allPools
        .filter(pool => {
          const liquidity = parseInt(pool.liquidity);
          const tvl = parseFloat(pool.totalValueLockedETH);
          return liquidity > 0 || tvl > this.trackedEthThreshold;
        })
        .map(pool => {
          return this.mapSubgraphPool(pool);
        });
    }

    this.metric.putMetric(
      'SubgraphProvider.getPools.filter.latency',
      Date.now() - beforeFilter,
      undefined,
      this.metricTags
    );
    this.metric.putMetric(
      'SubgraphProvider.getPools.filter.length',
      poolsSanitized.length,
      undefined,
      this.metricTags
    );
    this.metric.putMetric(
      'SubgraphProvider.getPools.filter.percent',
      (poolsSanitized.length / allPools.length) * 100,
      undefined,
      this.metricTags
    );
    this.metric.putMetric(
      'SubgraphProvider.getPools',
      1,
      undefined,
      this.metricTags
    );
    this.metric.putMetric(
      'SubgraphProvider.getPools.latency',
      Date.now() - beforeAll,
      undefined,
      this.metricTags
    );

    this.logger.info(
      `Got ${allPools.length} ${this.protocol} pools from the subgraph (after deduplication). ${poolsSanitized.length} after filtering`
    );

    return poolsSanitized;
  }

  protected abstract mapSubgraphPool(
    rawSubgraphPool: TRawSubgraphPool
  ): TSubgraphPool;

  // Helper method to get the pool fields for GraphQL queries
  protected getPoolFields(): string {
    return `
      id
      token0 {
        symbol
        id
      }
      token1 {
        symbol
        id
      }
      feeTier
      liquidity
      totalValueLockedUSD
      totalValueLockedETH
    `;
  }
}
