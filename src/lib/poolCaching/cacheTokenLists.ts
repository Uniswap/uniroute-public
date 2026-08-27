/**
 * Ported from routing-api/lib/cron/cache-token-lists.ts
 * Converted from Lambda handler to plain async function for ECS cron sidecar.
 */

import {S3Client, PutObjectCommand} from '@aws-sdk/client-s3';
import {Context} from '@uniswap/lib-uni/context';

import {unirouteFetch} from '../unirouteFetch';

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
 *
 * Takes the cron tick's context so the fetches carry client.* metrics and
 * tracing. The caller must have a fetcher installed on it (workerFetcher.ts) —
 * cron contexts get logger and metrics only.
 */
export async function cacheTokenLists(
  ctx: Context,
  config: CacheTokenListsConfig
): Promise<void> {
  const s3 = new S3Client({region: process.env.AWS_REGION || 'us-east-2'});

  for (const tokenListURI of TOKEN_LISTS) {
    ctx.logger.info(`Getting tokenList from ${tokenListURI}.`);
    try {
      const response = await unirouteFetch<unknown>(ctx, {
        method: 'GET',
        url: tokenListURI,
        metricTags: {vendor: 'token-list'},
      });
      // Both checks are explicit because fetch resolves on any status and
      // decodes nothing: writing a vendor error page to S3 under a token-list
      // key would poison every reader of the cached object.
      if (!response.ok || response.data === undefined) {
        throw new Error(
          `Unexpected HTTP ${response.status} from ${tokenListURI}`
        );
      }
      ctx.logger.info(`Got tokenList from ${tokenListURI}.`);

      await s3.send(
        new PutObjectCommand({
          Bucket: config.s3Bucket,
          Key: encodeURIComponent(tokenListURI),
          Body: JSON.stringify(response.data),
        })
      );
    } catch (err) {
      ctx.logger.error(`Could not get tokenlist ${tokenListURI}`, {err});
    }
  }
}
