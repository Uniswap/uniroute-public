/**
 * Subgraph provider for aggregator hook pools (e.g. FLUID_DEX, STABLE_SWAP_NG).
 *
 * These pools use external liquidity, so the subgraph returns 0 for
 * totalValueLockedUSD / totalValueLockedETH. Instead, each hook contract
 * exposes a `pseudoTotalValueLocked(bytes32 poolId)` view method returning
 * (amount0, amount1) in raw token units. We combine those amounts with
 * per-token `derivedETH` from the subgraph and the global `ethPriceUSD`
 * from the subgraph bundle to compute tvlETH / tvlUSD.
 */

import {Protocol} from '@uniswap/router-sdk';
import {ChainId} from '@uniswap/sdk-core';
import retry from 'async-retry';
import Timeout from 'await-timeout';
import {ethers} from 'ethers';
import {gql, GraphQLClient} from 'graphql-request';
import _ from 'lodash';

import {ProviderConfig} from '../provider';
import {PAGE_SIZE} from '../subgraphProvider';
import {Logger} from '../util/log';
import {IMetric} from '../util/metric';
import {SUBGRAPH_URL_BY_CHAIN, V4SubgraphPool} from './subgraphProvider';

const PSEUDO_TVL_ABI = [
  {
    type: 'function',
    name: 'pseudoTotalValueLocked',
    inputs: [{name: 'poolId', type: 'bytes32', internalType: 'PoolId'}],
    outputs: [
      {name: 'amount0', type: 'uint256', internalType: 'uint256'},
      {name: 'amount1', type: 'uint256', internalType: 'uint256'},
    ],
    stateMutability: 'view',
  },
] as const;

interface AggHooksRawPool {
  id: string;
  feeTier: string;
  tickSpacing: string;
  hooks: string;
  liquidity: string;
  token0: {
    symbol: string;
    id: string;
    name: string;
    decimals: string;
    derivedETH: string;
  };
  token1: {
    symbol: string;
    id: string;
    name: string;
    decimals: string;
    derivedETH: string;
  };
  totalValueLockedUSD: string;
  totalValueLockedETH: string;
}

export interface IAggHooksSubgraphProvider {
  getPools(providerConfig?: ProviderConfig): Promise<V4SubgraphPool[]>;
}

export class AggHooksSubgraphProvider implements IAggHooksSubgraphProvider {
  private client: GraphQLClient;
  private protocol = Protocol.V4;
  private metricTags: Record<string, string>;

  constructor(
    private chainId: ChainId,
    private hookAddresses: string[],
    private ethersProvider: ethers.providers.BaseProvider,
    private retries = 2,
    private timeout = 30000,
    private rollback = true,
    subgraphUrlOverride?: string,
    bearerToken?: string,
    private logger?: Logger,
    private metric?: IMetric
  ) {
    const url = subgraphUrlOverride ?? SUBGRAPH_URL_BY_CHAIN[chainId];
    if (!url) {
      throw new Error(`No subgraph url for chain id: ${chainId}`);
    }

    this.client = bearerToken
      ? new GraphQLClient(url, {
          headers: {authorization: `Bearer ${bearerToken}`},
        })
      : new GraphQLClient(url);

    this.metricTags = {chainId: String(chainId), protocol: 'v4'};
  }

  async getPools(providerConfig?: ProviderConfig): Promise<V4SubgraphPool[]> {
    const beforeAll = Date.now();
    let blockNumber = providerConfig?.blockNumber
      ? await providerConfig.blockNumber
      : undefined;

    const poolsQuery = gql`
      query getAggHooksPools($pageSize: Int!, $id: String, $hooks: [String!]!) {
        pools(
          first: $pageSize,
          ${blockNumber ? `block: { number: ${blockNumber} }` : ''}
          where: {
            id_gt: $id,
            hooks_in: $hooks
          }
          orderBy: id
        ) {
          id
          feeTier
          tickSpacing
          hooks
          liquidity
          token0 {
            symbol
            id
            name
            decimals
            derivedETH
          }
          token1 {
            symbol
            id
            name
            decimals
            derivedETH
          }
          totalValueLockedUSD
          totalValueLockedETH
        }
      }
    `;

    const bundleQuery = gql`
      query getBundle {
        bundle(id: "1") {
          ethPriceUSD
        }
      }
    `;

    this.logger?.info(
      `Getting AGG hooks pools from the subgraph with page size ${PAGE_SIZE}${
        providerConfig?.blockNumber
          ? ` as of block ${providerConfig?.blockNumber}`
          : ''
      } for ${this.hookAddresses.length} hook address(es).`
    );

    let rawPools: AggHooksRawPool[] = [];
    let ethPriceUSD = 0;
    let retries = 0;

    await retry(
      async () => {
        const timeout = new Timeout();

        const fetchSubgraphData = async (): Promise<{
          pools: AggHooksRawPool[];
          ethPriceUSD: number;
        }> => {
          let lastId = '';
          let pools: AggHooksRawPool[] = [];
          let poolsPage: AggHooksRawPool[] = [];
          let totalPages = 0;

          do {
            totalPages += 1;

            const result = await this.client.request<{
              pools: AggHooksRawPool[];
            }>(poolsQuery, {
              pageSize: PAGE_SIZE,
              id: lastId,
              hooks: this.hookAddresses.map(h => h.toLowerCase()),
            });

            poolsPage = result.pools;
            pools = pools.concat(poolsPage);

            if (pools.length > 0) {
              lastId = pools[pools.length - 1]!.id;
            }

            this.metric?.putMetric(
              'SubgraphProvider.getAggHooksPools.paginate.pageSize',
              poolsPage.length,
              undefined,
              this.metricTags
            );
          } while (poolsPage.length > 0);

          this.metric?.putMetric(
            'SubgraphProvider.getAggHooksPools.paginate',
            totalPages,
            undefined,
            this.metricTags
          );
          this.metric?.putMetric(
            'SubgraphProvider.getAggHooksPools.pools.length',
            pools.length,
            undefined,
            this.metricTags
          );

          const bundleResult = await this.client.request<{
            bundle: {ethPriceUSD: string} | null;
          }>(bundleQuery);

          return {
            pools,
            ethPriceUSD: parseFloat(bundleResult.bundle?.ethPriceUSD ?? '0'),
          };
        };

        try {
          const fetchPromise = fetchSubgraphData();
          const timerPromise = timeout.set(this.timeout).then(() => {
            throw new Error(
              `Timed out getting AGG hooks pools from subgraph: ${this.timeout}`
            );
          });
          const resolved = await Promise.race([fetchPromise, timerPromise]);
          rawPools = resolved.pools;
          ethPriceUSD = resolved.ethPriceUSD;
          return;
        } catch (err: any) {
          this.logger?.error(
            `Error fetching ${this.protocol} AGG Hooks Subgraph Pools.`,
            {err}
          );
          throw err;
        } finally {
          timeout.clear();
        }
      },
      {
        retries: this.retries,
        onRetry: (err: any, retry: number) => {
          retries += 1;
          if (
            this.rollback &&
            blockNumber &&
            _.includes(err.message, 'indexed up to')
          ) {
            this.metric?.putMetric(
              'SubgraphProvider.getAggHooksPools.indexError',
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
            'SubgraphProvider.getAggHooksPools.timeout',
            1,
            undefined,
            this.metricTags
          );
          rawPools = [];
          this.logger?.info(
            `Failed to get AGG hooks pools from subgraph. Retry attempt: ${retry}`,
            {err}
          );
        },
      }
    );

    this.metric?.putMetric(
      'SubgraphProvider.getAggHooksPools.retries',
      retries,
      undefined,
      this.metricTags
    );

    // Enrich each pool's TVL using pseudoTotalValueLocked on the hook contract.
    // The subgraph returns 0 for these pools because their liquidity is held externally.
    const pools = await Promise.all(
      rawPools.map(async rawPool => {
        const pool: V4SubgraphPool = {
          id: rawPool.id,
          feeTier: rawPool.feeTier,
          tickSpacing: rawPool.tickSpacing,
          hooks: rawPool.hooks,
          liquidity: rawPool.liquidity,
          token0: {
            symbol: rawPool.token0.symbol,
            id: rawPool.token0.id,
            name: rawPool.token0.name,
            decimals: rawPool.token0.decimals,
          },
          token1: {
            symbol: rawPool.token1.symbol,
            id: rawPool.token1.id,
            name: rawPool.token1.name,
            decimals: rawPool.token1.decimals,
          },
          // Start from subgraph values; will be overwritten below if contract call succeeds.
          tvlETH: parseFloat(rawPool.totalValueLockedETH),
          tvlUSD: parseFloat(rawPool.totalValueLockedUSD),
        };

        try {
          const hookContract = new ethers.Contract(
            rawPool.hooks,
            PSEUDO_TVL_ABI,
            this.ethersProvider
          );

          const [amount0, amount1]: [ethers.BigNumber, ethers.BigNumber] =
            await hookContract.pseudoTotalValueLocked(rawPool.id);

          const decimals0 = parseInt(rawPool.token0.decimals);
          const decimals1 = parseInt(rawPool.token1.decimals);
          const derivedETH0 = parseFloat(rawPool.token0.derivedETH);
          const derivedETH1 = parseFloat(rawPool.token1.derivedETH);

          const tvl0ETH =
            parseFloat(ethers.utils.formatUnits(amount0, decimals0)) *
            derivedETH0;
          const tvl1ETH =
            parseFloat(ethers.utils.formatUnits(amount1, decimals1)) *
            derivedETH1;

          pool.tvlETH = tvl0ETH + tvl1ETH;
          pool.tvlUSD = pool.tvlETH * ethPriceUSD;
          pool.liquidity = pool.tvlUSD.toString();

          this.logger?.info(
            `AGG hooks pool ${rawPool.id} pseudoTVL: ${pool.tvlETH} ETH / ${pool.tvlUSD} USD`,
            {amount0: amount0.toString(), amount1: amount1.toString()}
          );
          this.metric?.putMetric(
            'SubgraphProvider.getAggHooksPools.pseudoTVL.success',
            1,
            undefined,
            this.metricTags
          );
        } catch (err: any) {
          this.logger?.warn(
            `Failed pseudoTotalValueLocked for pool ${rawPool.id} hook ${rawPool.hooks}; keeping subgraph TVL`,
            {err}
          );
          this.metric?.putMetric(
            'SubgraphProvider.getAggHooksPools.pseudoTVL.error',
            1,
            undefined,
            this.metricTags
          );
        }

        return pool;
      })
    );

    this.metric?.putMetric(
      'SubgraphProvider.getAggHooksPools.latency',
      Date.now() - beforeAll,
      undefined,
      this.metricTags
    );
    this.metric?.putMetric(
      'SubgraphProvider.getAggHooksPools.length',
      pools.length,
      undefined,
      this.metricTags
    );

    this.logger?.info(
      `Got ${pools.length} AGG hooks pools from the subgraph (chainId=${this.chainId})`
    );

    return pools;
  }
}
