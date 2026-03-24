/**
 * Ported from routing-api/lib/cron/cache-token-lists.ts
 * Converted from Lambda handler to plain async function for ECS cron sidecar.
 */

import {S3Client, PutObjectCommand} from '@aws-sdk/client-s3';
import axios from 'axios';

import {Logger} from './sor-providers/util/log';

const TOKEN_LISTS = [
  'https://raw.githubusercontent.com/The-Blockchain-Association/sec-notice-list/master/ba-sec-list.json',
  'https://tokens.coingecko.com/uniswap/all.json',
  'https://gateway.ipfs.io/ipns/tokens.uniswap.org',
];

export interface CacheTokenListsConfig {
  s3Bucket: string;
}

/**
 * Fetches token lists from well-known URLs and caches them in S3.
 */
export async function cacheTokenLists(
  logger: Logger,
  config: CacheTokenListsConfig
): Promise<void> {
  const s3 = new S3Client({region: process.env.AWS_REGION || 'us-east-2'});

  for (const tokenListURI of TOKEN_LISTS) {
    logger.info(`Getting tokenList from ${tokenListURI}.`);
    try {
      const {data: tokenList} = await axios.get(tokenListURI);
      logger.info(`Got tokenList from ${tokenListURI}.`);

      await s3.send(
        new PutObjectCommand({
          Bucket: config.s3Bucket,
          Key: encodeURIComponent(tokenListURI),
          Body: JSON.stringify(tokenList),
        })
      );
    } catch (err) {
      logger.error(`Could not get tokenlist ${tokenListURI}`, {err});
    }
  }
}
