import {QuoteRequest} from '../../gen/uniroute/v1/api_pb';
import {
  isChainSelected,
  TokenMetadataChainSelection,
} from '../stores/token/storage/tokenMetadataChainSelection';

/**
 * The sender a route-cache refresh simulates from when the request that
 * triggered it named none: the last 20 bytes of
 * keccak256("uniroute.under-delivery-refresh-sender"), checksummed. No one
 * holds its key and it holds no balance, so its simulations run on a seeded
 * balance.
 */
export const UNDER_DELIVERY_REFRESH_SENDER =
  '0x8fd94Dd99Ffa7d19115D335d015cB82edABf8251';

/**
 * Gives a refresh on an under-delivery chain a sender when the triggering
 * request had none, so the refresh runs the under-delivery check and the
 * route cache only ever holds winners that passed it. A request with its own
 * sender, or on another chain, is returned unchanged.
 */
export function withUnderDeliveryRefreshSender(
  request: QuoteRequest,
  underDeliveryChains: TokenMetadataChainSelection | undefined
): QuoteRequest {
  if (
    request.simulateFromAddress ||
    !isChainSelected(underDeliveryChains, request.tokenInChainId)
  ) {
    return request;
  }
  return {
    ...request,
    simulateFromAddress: UNDER_DELIVERY_REFRESH_SENDER,
    // The swap must name a recipient for ApproveProxy calldata; the sender
    // is the only one that cannot fail simulation on its own account.
    recipient: request.recipient || UNDER_DELIVERY_REFRESH_SENDER,
  };
}
