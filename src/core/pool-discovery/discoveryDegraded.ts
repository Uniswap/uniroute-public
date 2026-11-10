import {Context} from '@uniswap/lib-uni/context';
import {buildMetricKey, ChainId} from '../../lib/config';
import {Protocol} from '../../models/pool/Protocol';

export enum DiscoveryDegradedReason {
  PROBE_ERROR = 'probe_error',
  PRIMARY_DISCOVERER_ERROR = 'primary_discoverer_error',
}

export type DiscoveryResult<TPool> = {
  pools: TPool[];
  degradedReasons: DiscoveryDegradedReason[];
  // Number of probes whose eth_call threw (any node-answered or transport error).
  // A successful empty reply is an absent pool. Carried alongside the
  // `degradedReasons` signal so callers that count degraded discoveries
  // (PoolDiscoverer, QuickRoutesRepository) can report how many probes
  // failed separately. `0` where nothing was probed (e.g. a
  // primary-discoverer exception, or a merge step that adds no new probes).
  failedProbeCount: number;
};

/**
 * Emits `PoolDiscoverer.DegradedDiscovery` once per distinct degraded reason.
 * Shared by `PoolDiscoverer` (the /quote and /quoteLong discovery path) and
 * `QuickRoutesRepository` (which does not go through `PoolDiscoverer`, so
 * without this call its own probe failures were never counted). The metric
 * value is 1 per affected discovery for every reason. For `PROBE_ERROR`,
 * `PoolDiscoverer.DegradedDiscovery.FailedProbes` also reports the failed-probe
 * count with the same tags. Both counters re-emit on degraded cache hits
 * inside the 10 s window, so they count affected discoveries and replay the
 * stored failed-probe count rather than counting unique outages.
 * Fire-and-forget: a metrics-backend failure must never affect discovery.
 */
export function countDegradedDiscovery(
  ctx: Context,
  chainId: ChainId,
  protocol: Protocol,
  reasons: DiscoveryDegradedReason[],
  failedProbeCount: number
): void {
  for (const reason of new Set(reasons)) {
    const tags = [
      `chain:${ChainId[chainId]}`,
      `protocol:${protocol}`,
      'status:failure',
      `reason:${reason}`,
    ];
    void ctx.metrics
      .count(buildMetricKey('PoolDiscoverer.DegradedDiscovery'), 1, {
        tags,
      })
      .catch(() => {});
    if (reason === DiscoveryDegradedReason.PROBE_ERROR) {
      void ctx.metrics
        .count(
          buildMetricKey('PoolDiscoverer.DegradedDiscovery.FailedProbes'),
          failedProbeCount,
          {tags}
        )
        .catch(() => {});
    }
  }
}
