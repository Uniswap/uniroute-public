/**
 * Ported from @uniswap/smart-order-router/src/providers/v4/euler-swap-hooks-subgraph-provider.ts
 */

import {Protocol} from '@uniswap/router-sdk';
import {ChainId} from '@uniswap/sdk-core';
import retry from 'async-retry';
import Timeout from 'await-timeout';
import {gql, GraphQLClient} from 'graphql-request';
import _ from 'lodash';

import {Logger} from '../util/log';
import {IMetric} from '../util/metric';
import {ProviderConfig} from '../provider';
import {PAGE_SIZE} from '../subgraphProvider';

import {SUBGRAPH_URL_BY_CHAIN, V4SubgraphPool} from './subgraphProvider';

export interface EulerSwapHooks {
  id: string; // euler id
  hook: string; // euler hooks address
  asset0: string; // euler token0
  asset1: string; // euler token1
  eulerAccount: string; // euler account address
}

export interface IEulerSwapHooksSubgraphProvider {
  getHooks(providerConfig?: ProviderConfig): Promise<EulerSwapHooks[]>;
  getPoolByHook(
    hook: string,
    providerConfig?: ProviderConfig
  ): Promise<V4SubgraphPool | undefined>;
}

export class EulerSwapHooksSubgraphProvider
  implements IEulerSwapHooksSubgraphProvider
{
  private client: GraphQLClient;
  private protocol = Protocol.V4;

  constructor(
    private chainId: ChainId,
    private retries = 2,
    private timeout = 30000,
    private rollback = true,
    subgraphUrlOverride = SUBGRAPH_URL_BY_CHAIN[chainId],
    private logger?: Logger,
    private metric?: IMetric
  ) {
    if (!subgraphUrlOverride) {
      throw new Error(`No subgraph url for chain id: ${chainId}`);
    }
    this.client = new GraphQLClient(subgraphUrlOverride);
    this.metricTags = {chainId: String(chainId), protocol: 'v4'};
  }

  private metricTags: Record<string, string>;

  async getHooks(providerConfig?: ProviderConfig): Promise<EulerSwapHooks[]> {
    const beforeAll = Date.now();
    let blockNumber = providerConfig?.blockNumber
      ? await providerConfig.blockNumber
      : undefined;

    const query = gql`
      query getEulerSwapHooks($pageSize: Int!, $id: String) {
        eulerSwapHooks(
          first: $pageSize,
          ${blockNumber ? `block: { number: ${blockNumber} }` : ''}
          where: { id_gt: $id }
        ) {
          id
          hook
          asset0
          asset1
          eulerAccount
        }
      }
    `;

    let hooks: EulerSwapHooks[] = [];

    this.logger?.info(
      `Getting hooks from the subgraph with page size ${PAGE_SIZE}${
        providerConfig?.blockNumber
          ? ` as of block ${providerConfig?.blockNumber}`
          : ''
      }.`
    );

    let retries = 0;

    await retry(
      async () => {
        const timeout = new Timeout();

        const getHooks = async (): Promise<EulerSwapHooks[]> => {
          let lastId = '';
          let hooks: EulerSwapHooks[] = [];
          let hooksPage: EulerSwapHooks[] = [];

          // metrics variables
          let totalPages = 0;

          do {
            totalPages += 1;

            const hooksResult = await this.client.request<{
              eulerSwapHooks: EulerSwapHooks[];
            }>(query, {
              pageSize: PAGE_SIZE,
              id: lastId,
            });

            hooksPage = hooksResult.eulerSwapHooks;

            hooks = hooks.concat(hooksPage);

            lastId = hooks[hooks.length - 1]!.id;
            this.metric?.putMetric(
              'SubgraphProvider.getHooks.paginate.pageSize',
              hooksPage.length,
              undefined,
              this.metricTags
            );
          } while (hooksPage.length > 0);

          this.metric?.putMetric(
            'SubgraphProvider.getHooks.paginate',
            totalPages,
            undefined,
            this.metricTags
          );
          this.metric?.putMetric(
            'SubgraphProvider.getHooks.hooks.length',
            hooks.length,
            undefined,
            this.metricTags
          );

          return hooks;
        };

        try {
          const getHooksPromise = getHooks();
          const timerPromise = timeout.set(this.timeout).then(() => {
            throw new Error(
              `Timed out getting hooks from subgraph: ${this.timeout}`
            );
          });
          hooks = await Promise.race([getHooksPromise, timerPromise]);
          return;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (err: any) {
          this.logger?.error(
            `Error fetching ${this.protocol} Subgraph Hooks.`,
            {err}
          );
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
            this.metric?.putMetric(
              'SubgraphProvider.getHooks.indexError',
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
            'SubgraphProvider.getHooks.timeout',
            1,
            undefined,
            this.metricTags
          );
          hooks = [];
          this.logger?.info(
            `Failed to get hooks from subgraph. Retry attempt: ${retry}`,
            {err}
          );
        },
      }
    );

    this.metric?.putMetric(
      'SubgraphProvider.getHooks.retries',
      retries,
      undefined,
      this.metricTags
    );
    this.metric?.putMetric(
      'SubgraphProvider.getHooks.latency',
      Date.now() - beforeAll,
      undefined,
      this.metricTags
    );

    return hooks;
  }

  async getPoolByHook(
    hook: string,
    providerConfig?: ProviderConfig
  ): Promise<V4SubgraphPool | undefined> {
    const beforeAll = Date.now();
    const blockNumber = providerConfig?.blockNumber
      ? await providerConfig.blockNumber
      : undefined;

    const query = gql`
      query getPools($pageSize: Int!, $hooks: String) {
        pools(
          first: $pageSize,
          ${blockNumber ? `block: { number: ${blockNumber} }` : ''}
          where: {hooks: $hooks}
        ) {
          id
          token0 {
            symbol
            id
            derivedETH
          }
          token1 {
            symbol
            id
            derivedETH
          }
          feeTier
          tick
          tickSpacing
          liquidity
          hooks
          totalValueLockedUSD
          totalValueLockedETH
          totalValueLockedUSDUntracked
          sqrtPrice
        }
      }
    `;

    let pool: V4SubgraphPool | undefined = undefined;

    this.logger?.info(
      `Getting pool by hook from the subgraph with page size ${PAGE_SIZE}${
        providerConfig?.blockNumber
          ? ` as of block ${providerConfig?.blockNumber}`
          : ''
      }.`
    );

    const poolResult = await this.client.request<{
      pools: V4SubgraphPool[];
    }>(query, {
      pageSize: PAGE_SIZE,
      hooks: hook.toLowerCase(),
    });

    pool = poolResult.pools[0];

    this.metric?.putMetric(
      'SubgraphProvider.getPoolByHook.pools.length',
      poolResult.pools.length,
      undefined,
      this.metricTags
    );
    this.metric?.putMetric(
      'SubgraphProvider.getPoolByHook.latency',
      Date.now() - beforeAll,
      undefined,
      this.metricTags
    );

    return pool;
  }
}
