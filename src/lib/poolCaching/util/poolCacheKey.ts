/**
 * Ported from routing-api/lib/util/pool-cache-key.ts
 */

import {ChainId} from '@uniswap/sdk-core';
import {Protocol} from '@uniswap/router-sdk';

export const S3_POOL_CACHE_KEY = (
  baseKey: string,
  chain: ChainId,
  protocol: Protocol
) => `${baseKey}-${chain}-${protocol}`;
