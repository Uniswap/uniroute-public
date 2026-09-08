import {UniversalRouterVersion} from '@uniswap/universal-router-sdk';
import {
  QuoteRequest,
  QuoteResponse,
  GetCachedRoutesRequest,
  GetCachedRoutesResponse,
  DeleteCachedRoutesRequest,
  DeleteCachedRoutesResponse,
  InspectCacheKeyResponse,
  InspectCacheKeyRequest,
} from '../../gen/uniroute/v1/api_pb';
import {Context} from '@uniswap/lib-uni/context';
import {Experiment} from '../models/hooks/Experiment';

export type QuoteOptions = {
  permit2Disabled?: boolean;
  requestSource?: string;
  universalRouterVersion?: UniversalRouterVersion;
  testAggHooks?: boolean;
  // Opts the request into experimental-hook routing (ExperimentalHooks cache
  // namespace + EXPERIMENT_HOOKS force-append). Sourced from the
  // `x-hook-experiment` header and forwarded on the async refresh message.
  experiment?: Experiment;
  // When true, UniRoute returns a fee-neutral quote (raw amounts, no portion
  // fields, no `fee`/`flatFee` populated for the legacy router builder) and
  // attaches `swapSteps` to the response. Trading owns fee math in this
  // mode. Sourced from the `x-universal-router-swapsteps` header.
  universalRouterSwapsteps?: boolean;
};

export interface IUniRoutedBL {
  quote(
    ctx: Context,
    request: QuoteRequest,
    options?: QuoteOptions
  ): Promise<QuoteResponse>;
  getCachedRoutes(
    ctx: Context,
    request: GetCachedRoutesRequest
  ): Promise<GetCachedRoutesResponse>;
  deleteCachedRoutes(
    ctx: Context,
    request: DeleteCachedRoutesRequest
  ): Promise<DeleteCachedRoutesResponse>;
  inspectCacheKey(
    request: InspectCacheKeyRequest
  ): Promise<InspectCacheKeyResponse>;
}
