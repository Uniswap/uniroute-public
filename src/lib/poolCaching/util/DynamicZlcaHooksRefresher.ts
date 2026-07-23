import {ethers} from 'ethers';
import type {JsonRpcProvider} from '@ethersproject/providers';

import type {Logger} from '../sor-providers/util/log';
import {IMetric, MetricLoggerUnit} from '../sor-providers/util/metric';
import {withTimeout} from './withTimeout';
import {FactoryHookEnumerator} from './factoryHookEnumerator';
import {setDynamicZlcaHooks} from './dynamicZlcaHooks';
import {
  TRUSTED_ZLCA_HOOK_FACTORIES_PER_CHAIN,
  TrustedZlcaHookFactory,
} from './trustedZlcaHookFactories';

export type ProviderFactory = (chainId: number) => JsonRpcProvider | undefined;

export type EnumeratorFactory = (
  chainId: number,
  provider: JsonRpcProvider,
  factories: TrustedZlcaHookFactory[],
  logger: Logger,
  metric?: IMetric
) => FactoryHookEnumerator;

const defaultEnumeratorFactory: EnumeratorFactory = (
  chainId,
  provider,
  factories,
  logger,
  metric
) => new FactoryHookEnumerator(chainId, provider, factories, logger, metric);

/**
 * Keeps the process-wide dynamic ZLCA hook store (`dynamicZlcaHooks.ts`) in
 * sync with on-chain state by enumerating the trusted factories for every
 * chain in `TRUSTED_ZLCA_HOOK_FACTORIES_PER_CHAIN`.
 *
 * Both containers run one of these: the serving/SQS processes via `start()`
 * (immediate refresh + interval, see dependencies.ts), the pool-caching
 * cron via a `refreshOnce()` await at the top of each run (see
 * cachePools.ts). Fail-open per chain: a failed refresh keeps that chain's
 * last-known-good set (empty at boot = today's behavior) and never throws.
 */
export class DynamicZlcaHooksRefresher {
  private readonly enumerators = new Map<number, FactoryHookEnumerator>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly providerFactory: ProviderFactory,
    private readonly logger: Logger,
    private readonly metric?: IMetric,
    private readonly intervalMs = 60_000,
    private readonly perChainTimeoutMs = 15_000,
    private readonly enumeratorFactory: EnumeratorFactory = defaultEnumeratorFactory
  ) {}

  private inFlight = false;

  async refreshOnce(): Promise<void> {
    // In-flight guard: withTimeout abandons (cannot cancel) a slow
    // enumerate(), so without this, ticks pile concurrent enumerations onto
    // an already-degraded RPC (each cold chunk = up to 50 parallel eth_calls).
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      for (const [chainIdStr, factories] of Object.entries(
        TRUSTED_ZLCA_HOOK_FACTORIES_PER_CHAIN
      )) {
        if (factories.length === 0) continue;
        const chainId = Number(chainIdStr);
        try {
          const enumerator = this.getEnumerator(chainId, factories);
          if (!enumerator) continue;
          const hooks = await withTimeout(
            enumerator.enumerate(),
            this.perChainTimeoutMs,
            `zlcaFactoryHooks-${chainId}`
          );
          setDynamicZlcaHooks(chainId, hooks);
          this.metric?.putMetric(
            'zlcaDynamicHooks.refresh',
            1,
            MetricLoggerUnit.Count,
            {chainId: chainId.toString(), status: 'success'}
          );
          // Deliberately a Count, NOT unit None: None maps to a `.dist`
          // distribution, and uniroute has strict DIST_METRIC_ALLOWLISTS
          // enforcement — an unallowlisted dist auto-allowlists infra tags
          // on first emission (the ~85× timeseries spike class). The
          // fleet-summed default view is imperfect; diagnose a single
          // empty store via `by {host}` (dogstatsd host tag) or the
          // per-host zlcaDynamicHooks.refresh{status:failure} signal.
          this.metric?.putMetric(
            'zlcaDynamicHooks.active',
            hooks.size,
            MetricLoggerUnit.Count,
            {chainId: chainId.toString()}
          );
        } catch (error) {
          // Last-known-good state for this chain is kept; retried next tick.
          this.logger.warn(
            `DynamicZlcaHooksRefresher: refresh failed for chain ${chainId}: ${error}`
          );
          this.metric?.putMetric(
            'zlcaDynamicHooks.refresh',
            1,
            MetricLoggerUnit.Count,
            {
              chainId: chainId.toString(),
              status: 'failure',
              reason: 'refresh_error',
            }
          );
        }
      }
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Starts the interval and returns the initial refresh's promise so boot
   * sequences can await first population of the dynamic store (bounded by
   * the caller — see init.ts) before serving quotes.
   */
  start(): Promise<void> {
    if (this.timer) return Promise.resolve();
    const initialRefresh = this.refreshOnce();
    this.timer = setInterval(() => void this.refreshOnce(), this.intervalMs);
    this.timer.unref?.();
    return initialRefresh;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private getEnumerator(
    chainId: number,
    factories: TrustedZlcaHookFactory[]
  ): FactoryHookEnumerator | undefined {
    let enumerator = this.enumerators.get(chainId);
    if (!enumerator) {
      const provider = this.providerFactory(chainId);
      if (!provider) {
        this.logger.warn(
          `DynamicZlcaHooksRefresher: no RPC provider for chain ${chainId}, skipping factory enumeration`
        );
        return undefined;
      }
      enumerator = this.enumeratorFactory(
        chainId,
        provider,
        factories,
        this.logger,
        this.metric
      );
      this.enumerators.set(chainId, enumerator);
    }
    return enumerator;
  }
}

/**
 * Builds a refresher whose providers point at the UniRPC gateway
 * (`<endpoint>/rpc/<chainId>`, like dependencies.ts). Used by the
 * pool-caching cron; the serving path instead injects its
 * `uniRpcProviderMap` directly. Returns undefined when no endpoint env is
 * set or no chain has trusted factories configured — callers treat that as
 * feature-inactive.
 *
 * Endpoint choice: prefer UNI_RPC_V2_INTERNAL_ENDPOINT — it is the endpoint
 * every working serving-path provider uses, and observed in dev that
 * enumeration via UNI_RPC_ENDPOINT fails from the cron container (steady
 * FactoryZlcaHooks.enumerate.error on the cron cadence) while the same
 * calls through the v2-internal endpoint succeed.
 */
export function createDynamicZlcaHooksRefresherFromEnv(
  logger: Logger,
  metric?: IMetric,
  intervalMs?: number
): DynamicZlcaHooksRefresher | undefined {
  const uniRpcEndpoint =
    process.env.UNI_RPC_V2_INTERNAL_ENDPOINT || process.env.UNI_RPC_ENDPOINT;
  if (!uniRpcEndpoint) return undefined;
  const hasFactories = Object.values(
    TRUSTED_ZLCA_HOOK_FACTORIES_PER_CHAIN
  ).some(factories => factories.length > 0);
  if (!hasFactories) return undefined;

  const providers = new Map<number, JsonRpcProvider>();
  const providerFactory: ProviderFactory = chainId => {
    let provider = providers.get(chainId);
    if (!provider) {
      provider = new ethers.providers.StaticJsonRpcProvider(
        // skipFetchSetup + timeout + service-id header mirror
        // dependencies.ts — ethers v5's fetch path is unreliable in the ECS
        // runtime, and a hung socket must not outlive the per-chain
        // withTimeout that abandons it. The header is optional attribution
        // (unirpc-v2 falls back to 'unspecified').
        {
          url: `${uniRpcEndpoint}/rpc/${chainId}`,
          skipFetchSetup: true,
          timeout: 10_000,
          headers: {['x-uni-service-id']: 'uniroute-pool-caching'},
        },
        chainId
      );
      providers.set(chainId, provider);
    }
    return provider;
  };

  return new DynamicZlcaHooksRefresher(
    providerFactory,
    logger,
    metric,
    intervalMs
  );
}
