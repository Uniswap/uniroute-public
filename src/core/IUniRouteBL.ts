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

export type QuoteOptions = {
  permit2Disabled?: boolean;
  requestSource?: string;
  universalRouterVersion?: UniversalRouterVersion;
  testAggHooks?: boolean;
  stableStableHookEnabled?: boolean;
  /**
   * Value of the `x-is-user-allowlisted` header, or `undefined` if absent.
   *
   * TAPI sends this header iff tokenIn or tokenOut is a permissioned adapter
   * token (e.g. a Superstate Security Token); the boolean indicates whether
   * the caller is allowlisted to swap through the adapter. Header **presence**
   * activates the `PermissionedHooks` cache namespace and unlocks routing
   * through permissioned-hook pools. The boolean value itself is reserved for
   * the simulator short-circuit (separate follow-up); it is not consumed in
   * this stage of the rollout.
   *
   * Distinguish `undefined` (absent) from `false` (present-but-not-allowlisted)
   * carefully — only presence drives namespace activation.
   */
  isUserAllowlisted?: boolean;
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
