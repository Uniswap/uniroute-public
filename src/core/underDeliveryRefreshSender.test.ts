import {create} from '@bufbuild/protobuf';
import {describe, expect, it} from 'vitest';
import {QuoteRequestSchema} from '../../gen/uniroute/v1/api_pb';
import {ChainId} from '../lib/config';
import {
  UNDER_DELIVERY_REFRESH_SENDER,
  withUnderDeliveryRefreshSender,
} from './underDeliveryRefreshSender';

// The payload CachedRoutesRepository.sendFreshQuoteUniRouteEvent sends for a
// caller that named no sender.
const refreshPayload = {
  tokenInAddress: '0x0000000000000000000000000000000000000001',
  tokenInChainId: ChainId.ROBINHOOD,
  tokenOutAddress: '0x0000000000000000000000000000000000000002',
  tokenOutChainId: ChainId.ROBINHOOD,
  tradeType: 'EXACT_IN',
  amount: '1000',
  quoteType: 'FRESH',
  protocols: 'v2,v3,v4,mixed',
  slippageTolerance: 0.5,
};

describe('withUnderDeliveryRefreshSender', () => {
  it('gives an unchecked refresh on a checked chain the refresh sender', () => {
    const request = withUnderDeliveryRefreshSender(
      create(QuoteRequestSchema, refreshPayload),
      new Set([ChainId.ROBINHOOD])
    );

    expect(request.simulateFromAddress).toBe(UNDER_DELIVERY_REFRESH_SENDER);
    expect(request.recipient).toBe(UNDER_DELIVERY_REFRESH_SENDER);
    expect(request.amount).toBe('1000');
  });

  it('keeps the caller sender and recipient', () => {
    const sender = '0x1234567890123456789012345678901234567890';
    const request = withUnderDeliveryRefreshSender(
      create(QuoteRequestSchema, {
        ...refreshPayload,
        simulateFromAddress: sender,
        recipient: sender,
      }),
      'all'
    );

    expect(request.simulateFromAddress).toBe(sender);
    expect(request.recipient).toBe(sender);
  });

  it('leaves a chain off the list, and an empty list, unchecked', () => {
    for (const chains of [new Set([ChainId.MAINNET]), new Set<number>()]) {
      const request = withUnderDeliveryRefreshSender(
        create(QuoteRequestSchema, refreshPayload),
        chains
      );
      expect(request.simulateFromAddress).toBeUndefined();
      expect(request.recipient).toBeUndefined();
    }
  });
});
