/**
 * Barrel export for ported smart-order-router subgraph provider classes.
 *
 * These classes were ported from @uniswap/smart-order-router to avoid
 * a runtime dependency on the full SOR package. Only the essential
 * subgraph provider classes needed for pool caching are included.
 */

// V2
export {
  V2SubgraphProvider,
  type V2SubgraphPool,
  type IV2SubgraphProvider,
} from './v2/subgraphProvider';

// V3
export {
  V3SubgraphProvider,
  type V3SubgraphPool,
  type V3RawSubgraphPool,
  type IV3SubgraphProvider,
} from './v3/subgraphProvider';

// V4
export {
  V4SubgraphProvider,
  type V4SubgraphPool,
  type V4RawSubgraphPool,
  type IV4SubgraphProvider,
  SUBGRAPH_URL_BY_CHAIN,
} from './v4/subgraphProvider';

// V4 Euler Hooks
export {
  EulerSwapHooksSubgraphProvider,
  type EulerSwapHooks,
  type IEulerSwapHooksSubgraphProvider,
} from './v4/eulerSwapHooksSubgraphProvider';

// Base class and types
export {
  SubgraphProvider,
  type ISubgraphProvider,
  type V3V4SubgraphPool,
  type V3V4RawSubgraphPool,
  PAGE_SIZE,
  BASE_V4_PAGE_SIZE,
} from './subgraphProvider';

// Provider config
export { type ProviderConfig, type LocalCacheEntry } from './provider';

// Logger and metrics (types only — no globals)
export { type Logger } from './util/log';
export {
  MetricLoggerUnit,
  IMetric,
} from './util/metric';
