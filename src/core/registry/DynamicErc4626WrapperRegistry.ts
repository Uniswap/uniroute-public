import {GetObjectCommand, S3Client} from '@aws-sdk/client-s3';
import {Context} from '@uniswap/lib-uni/context';
import {buildMetricKey} from '../../lib/config';
import {
  XStocksAssetEntry,
  XSTOCKS_ASSETS_REGISTRY_S3_KEY,
  DEFAULT_XSTOCKS_ASSETS_REGISTRY_BASE_KEY,
  isWellFormedXStocksAssetEntry,
} from '../../lib/poolCaching/xstocksAssetsRegistry';
import {withTimeout} from '../../lib/poolCaching/util/withTimeout';

export interface DynamicErc4626WrapperRegistryConfig {
  s3Bucket: string;
  s3BaseKey: string;
  cacheTtlMs: number;
  coldStartMaxWaitMs: number;
}

export function dynamicErc4626WrapperRegistryConfigFromEnv(): DynamicErc4626WrapperRegistryConfig {
  return {
    s3Bucket: process.env.POOL_CACHING_S3_BUCKET || '',
    s3BaseKey:
      process.env.XSTOCKS_ASSETS_REGISTRY_S3_BASE_KEY ||
      DEFAULT_XSTOCKS_ASSETS_REGISTRY_BASE_KEY,
    cacheTtlMs: 45_000,
    coldStartMaxWaitMs: 250,
  };
}

interface CachedEntries {
  entries: XStocksAssetEntry[];
  fetchedAtMs: number;
}

/**
 * SWR reader for the xStocks registry. Unlike discovery registries, a read
 * failure retains the last-known-good value: losing admission data must never
 * silently broaden routing eligibility.
 */
export class DynamicErc4626WrapperRegistry {
  private readonly cache = new Map<number, CachedEntries>();
  private readonly inflight = new Map<number, Promise<XStocksAssetEntry[]>>();

  constructor(
    private readonly s3: S3Client,
    private readonly config: DynamicErc4626WrapperRegistryConfig
  ) {}

  async getActiveAssets(
    chainId: number,
    ctx?: Context
  ): Promise<XStocksAssetEntry[]> {
    if (!this.config.s3Bucket) return [];
    const entries = await this.getEntries(chainId, ctx);
    return entries.filter(entry => entry.status === 'active');
  }

  async getKnownIdentities(
    chainId: number,
    ctx?: Context
  ): Promise<ReadonlySet<string>> {
    if (!this.config.s3Bucket) return new Set();
    const entries = await this.getEntries(chainId, ctx);
    return new Set(
      entries
        .flatMap(entry => [
          entry.xStock,
          entry.wxStock,
          entry.hookAddress,
          entry.poolId,
        ])
        .map(identity => identity.toLowerCase())
    );
  }

  private async getEntries(
    chainId: number,
    ctx?: Context
  ): Promise<XStocksAssetEntry[]> {
    const cached = this.cache.get(chainId);
    if (cached) {
      if (Date.now() - cached.fetchedAtMs >= this.config.cacheTtlMs) {
        void this.refresh(chainId, ctx);
      }
      return cached.entries;
    }
    return withTimeout(
      this.refresh(chainId, ctx),
      this.config.coldStartMaxWaitMs
    ).catch(() => []);
  }

  private refresh(
    chainId: number,
    ctx?: Context
  ): Promise<XStocksAssetEntry[]> {
    const existing = this.inflight.get(chainId);
    if (existing) return existing;
    const refresh = this.fetchEntries(chainId, ctx).finally(() =>
      this.inflight.delete(chainId)
    );
    this.inflight.set(chainId, refresh);
    return refresh;
  }

  private async fetchEntries(
    chainId: number,
    ctx?: Context
  ): Promise<XStocksAssetEntry[]> {
    const key = XSTOCKS_ASSETS_REGISTRY_S3_KEY(this.config.s3BaseKey, chainId);
    try {
      const response = await this.s3.send(
        new GetObjectCommand({Bucket: this.config.s3Bucket, Key: key})
      );
      const raw = response.Body
        ? await response.Body.transformToString('utf-8')
        : undefined;
      if (!raw) throw new Error('xStocks registry has an empty body');
      const parsed: unknown = JSON.parse(raw);
      if (
        !Array.isArray(parsed) ||
        !parsed.every(isWellFormedXStocksAssetEntry)
      ) {
        throw new Error('xStocks registry has an invalid body');
      }
      const entries = parsed as XStocksAssetEntry[];
      this.cache.set(chainId, {entries, fetchedAtMs: Date.now()});
      return entries;
    } catch (error) {
      const previous = this.cache.get(chainId)?.entries;
      if (ctx) {
        ctx.logger.warn(
          'Failed to fetch xStocks assets registry; retaining LKG',
          {
            chainId,
            key,
            error,
          }
        );
        await ctx.metrics
          .count(
            buildMetricKey('XStocksAssetsRegistry.DynamicFetchFailed'),
            1,
            {
              tags: ['status:failure'],
            }
          )
          .catch(() => undefined);
      }
      // Do not cache an empty cold-start failure: a later request should retry.
      // A warm failure is LKG and gets a new TTL to avoid S3 retry storms.
      if (previous) {
        this.cache.set(chainId, {entries: previous, fetchedAtMs: Date.now()});
        return previous;
      }
      return [];
    }
  }
}
