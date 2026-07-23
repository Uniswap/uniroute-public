import {ethers} from 'ethers';
import type {JsonRpcProvider} from '@ethersproject/providers';

import type {Logger} from '../sor-providers/util/log';
import {IMetric, MetricLoggerUnit} from '../sor-providers/util/metric';
import type {TrustedZlcaHookFactory} from './trustedZlcaHookFactories';

/**
 * Minimal ABI for Uniswap/v4-hooks-public `AllowlistedFactory`. Enumeration
 * (`allDeploymentsLength` / `allDeployments`) is the discovery path;
 * `isFromFactory` is included for a possible future pool-driven
 * verification path but is unused today.
 */
export const ALLOWLISTED_FACTORY_ABI = [
  'function allDeploymentsLength() view returns (uint256)',
  'function allDeployments(uint256 index) view returns (address deployed)',
  'function isFromFactory(address deployed) view returns (bool)',
];

// Injectable for tests, mirroring AggHookQuoter's HookContractFactory.
export type FactoryContractFactory = (
  factoryAddress: string,
  provider: JsonRpcProvider
) => ethers.Contract;

const defaultContractFactory: FactoryContractFactory = (
  factoryAddress,
  provider
) => new ethers.Contract(factoryAddress, ALLOWLISTED_FACTORY_ABI, provider);

// Index reads per RPC batch — bounds concurrent eth_calls on a cold read.
const INDEX_READ_CHUNK_SIZE = 50;

/**
 * Enumerates hooks deployed by the chain's trusted ZLCA hook factories.
 *
 * Incremental with an in-memory cursor: the factory's `allDeployments`
 * array is append-only with immutable entries, so each call reads
 * `allDeploymentsLength()` and pages only indices past the last count seen
 * by THIS instance. The first call after process boot (cursor 0) is a full
 * read. A per-factory RPC failure leaves that factory's cursor and
 * accumulated hooks unchanged — errors are never cached, the next call
 * retries the same range.
 */
export class FactoryHookEnumerator {
  private readonly lastCountByFactory = new Map<string, number>();
  private readonly hooks = new Map<string, bigint>();
  private readonly contracts = new Map<string, ethers.Contract>();
  // Deployment count last warned about per factory — the cap condition
  // persists forever once hit, and warning every 60s tick is pure noise.
  private readonly capWarnedAtLength = new Map<string, number>();
  private inFlight = false;

  constructor(
    private readonly chainId: number,
    private readonly provider: JsonRpcProvider,
    private readonly factories: TrustedZlcaHookFactory[],
    private readonly logger: Logger,
    private readonly metric?: IMetric,
    private readonly contractFactory: FactoryContractFactory = defaultContractFactory,
    private readonly maxDeploymentsPerFactory = 500
  ) {}

  /**
   * Returns the accumulated hook map (lowercased hook address → per-hop gas
   * overhead inherited from the deploying factory). Never throws; failed
   * factories keep their prior state and are retried on the next call.
   * Concurrency-guarded: a caller-abandoned (timed-out) run keeps exclusive
   * ownership of the cursor state — overlapping calls return the current
   * snapshot instead of interleaving reads.
   */
  async enumerate(): Promise<ReadonlyMap<string, bigint>> {
    if (this.inFlight) return new Map(this.hooks);
    this.inFlight = true;
    try {
      for (const factory of this.factories) {
        const factoryLower = factory.factoryAddress.toLowerCase();
        try {
          const contract = this.getContract(factoryLower);
          const lengthBn: ethers.BigNumber =
            await contract.callStatic.allDeploymentsLength();
          let length = lengthBn.toNumber();
          if (length > this.maxDeploymentsPerFactory) {
            if (this.capWarnedAtLength.get(factoryLower) !== length) {
              this.capWarnedAtLength.set(factoryLower, length);
              this.logger.error(
                `FactoryHookEnumerator: factory ${factory.name} (${factoryLower}) on chain ${this.chainId} has ${length} deployments, capping at ${this.maxDeploymentsPerFactory} — deployments past the cap will not be admitted; raise the cap (or split factories) after verifying the growth is legitimate`
              );
              this.metric?.putMetric(
                'FactoryZlcaHooks.enumerate.capped',
                1,
                MetricLoggerUnit.Count,
                {chainId: this.chainId.toString(), status: 'failure'}
              );
            }
            length = this.maxDeploymentsPerFactory;
          }

          const start = this.lastCountByFactory.get(factoryLower) ?? 0;
          if (length > start) {
            const deployed = await this.readDeployments(
              contract,
              start,
              length
            );
            for (const hook of deployed) {
              this.hooks.set(hook.toLowerCase(), factory.gasOverheadPerHop);
            }
            this.lastCountByFactory.set(factoryLower, length);
            this.logger.info(
              `FactoryHookEnumerator: discovered ${deployed.length} new hook(s) from factory ${factory.name} (${factoryLower}) on chain ${this.chainId}: ${deployed.join(', ')}`
            );
            this.metric?.putMetric(
              'FactoryZlcaHooks.enumerate.newHooks',
              deployed.length,
              MetricLoggerUnit.Count,
              {chainId: this.chainId.toString(), status: 'success'}
            );
          }
        } catch (error) {
          // Cursor and accumulated hooks untouched — retried next call.
          this.logger.warn(
            `FactoryHookEnumerator: enumeration failed for factory ${factory.name} (${factoryLower}) on chain ${this.chainId}: ${error}`
          );
          this.metric?.putMetric(
            'FactoryZlcaHooks.enumerate.error',
            1,
            MetricLoggerUnit.Count,
            {
              chainId: this.chainId.toString(),
              status: 'failure',
              reason: 'rpc_error',
            }
          );
        }
      }
      return new Map(this.hooks);
    } finally {
      this.inFlight = false;
    }
  }

  private getContract(factoryLower: string): ethers.Contract {
    let contract = this.contracts.get(factoryLower);
    if (!contract) {
      contract = this.contractFactory(factoryLower, this.provider);
      this.contracts.set(factoryLower, contract);
    }
    return contract;
  }

  private async readDeployments(
    contract: ethers.Contract,
    start: number,
    end: number
  ): Promise<string[]> {
    const deployed: string[] = [];
    for (
      let chunkStart = start;
      chunkStart < end;
      chunkStart += INDEX_READ_CHUNK_SIZE
    ) {
      const chunkEnd = Math.min(chunkStart + INDEX_READ_CHUNK_SIZE, end);
      const indices = Array.from(
        {length: chunkEnd - chunkStart},
        (_, i) => chunkStart + i
      );
      const addresses: string[] = await Promise.all(
        indices.map(index => contract.callStatic.allDeployments(index))
      );
      deployed.push(...addresses);
    }
    return deployed;
  }
}
