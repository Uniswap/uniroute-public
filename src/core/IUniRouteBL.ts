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
  permit2Enabled?: boolean;
  requestSource?: string;
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
