import {describe, it, expect} from 'vitest';
import {S3_POOL_CACHE_KEY} from './poolCacheKey';
import {ChainId} from '@uniswap/sdk-core';
import {Protocol} from '@uniswap/router-sdk';

describe('S3_POOL_CACHE_KEY', () => {
  it('constructs correct key format', () => {
    const key = S3_POOL_CACHE_KEY('poolCacheGzip.json', ChainId.MAINNET, Protocol.V3);
    expect(key).toBe('poolCacheGzip.json-1-V3');
  });

  it('works with different chains and protocols', () => {
    expect(S3_POOL_CACHE_KEY('base', ChainId.BASE, Protocol.V2)).toBe('base-8453-V2');
    expect(S3_POOL_CACHE_KEY('base', ChainId.ARBITRUM_ONE, Protocol.V4)).toBe('base-42161-V4');
  });
});
