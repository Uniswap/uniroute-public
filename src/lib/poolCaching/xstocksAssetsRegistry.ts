import {GetObjectCommand, PutObjectCommand, S3Client} from '@aws-sdk/client-s3';
import axios from 'axios';
import {ChainId} from '../config';
import {Logger} from './sor-providers/util/log';
import {IMetric, MetricLoggerUnit} from './sor-providers/util/metric';
import {
  verifyXStocksAssetOnChain,
  XStocksOnChainVerifierDeps,
} from './xstocksOnChainVerifier';

export const DEFAULT_XSTOCKS_ASSETS_REGISTRY_BASE_KEY =
  'xstocksAssetsRegistry.json';
export const XSTOCKS_RETIREMENT_SAFETY_MARGIN_MS = 60 * 60 * 1000;
export const XSTOCKS_RETIRED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export const XSTOCKS_ASSETS_REGISTRY_S3_KEY = (
  baseKey: string,
  chainId: number
): string => `${baseKey}-${chainId}-V4`;

export const XSTOCKS_ASSETS_REGISTRY_WRITER_MARKER_S3_KEY = (
  baseKey: string
): string => `${baseKey}-writer-last-successful-run`;

export interface XStocksAssetEntry {
  xStock: string;
  wxStock: string;
  hookAddress: string;
  poolId: string;
  feeTier: string;
  tickSpacing: string;
  status: 'active' | 'retired';
  updatedAtMs: number;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const POOL_ID = /^0x[0-9a-fA-F]{64}$/;
const INTEGER = /^\d+$/;

export function isWellFormedXStocksAssetEntry(
  entry: unknown
): entry is XStocksAssetEntry {
  const candidate = entry as Partial<XStocksAssetEntry> | undefined;
  return (
    candidate !== undefined &&
    typeof candidate.xStock === 'string' &&
    ADDRESS.test(candidate.xStock) &&
    typeof candidate.wxStock === 'string' &&
    ADDRESS.test(candidate.wxStock) &&
    typeof candidate.hookAddress === 'string' &&
    ADDRESS.test(candidate.hookAddress) &&
    typeof candidate.poolId === 'string' &&
    POOL_ID.test(candidate.poolId) &&
    typeof candidate.feeTier === 'string' &&
    INTEGER.test(candidate.feeTier) &&
    typeof candidate.tickSpacing === 'string' &&
    INTEGER.test(candidate.tickSpacing) &&
    (candidate.status === 'active' || candidate.status === 'retired') &&
    typeof candidate.updatedAtMs === 'number' &&
    Number.isFinite(candidate.updatedAtMs) &&
    candidate.updatedAtMs >= 0
  );
}

export interface XStocksApiAsset {
  xStockAddress: string;
  tokenDeployments: Array<{
    chainId: number;
    wrapperAddress: string;
    hookAddress?: string;
    poolId?: string;
    feeTier?: string;
    tickSpacing?: string;
    version?: string;
  }>;
}

/** Best-effort integration-doc mapping; only this boundary changes with the final API. */
export function makeXStocksAssetsApiFetcher(
  apiUrl: string
): () => Promise<XStocksApiAsset[]> {
  return async () => {
    const response = await axios.get<{assets?: XStocksApiAsset[]}>(apiUrl, {
      timeout: 10_000,
    });
    return filterLegacyV1Deployments(response.data.assets ?? []);
  };
}

export function filterLegacyV1Deployments(
  assets: XStocksApiAsset[]
): XStocksApiAsset[] {
  return assets.map(asset => ({
    ...asset,
    tokenDeployments: (asset.tokenDeployments ?? []).filter(
      deployment => deployment.version !== 'v1'
    ),
  }));
}

export interface XStocksAssetsRegistryWriterConfig {
  s3Bucket: string;
  s3BaseKey: string;
  chainIds: number[];
  retirementSafetyMarginMs: number;
  retiredRetentionMs: number;
  runIntervalMs?: number;
  expectedHookCodehashByChain: Readonly<Record<number, string>>;
}

export interface XStocksAssetsRegistryWriterDeps
  extends XStocksOnChainVerifierDeps {
  s3: S3Client;
  fetchAssets: () => Promise<XStocksApiAsset[]>;
  verifyAsset?: (chainId: number, entry: XStocksAssetEntry) => Promise<boolean>;
  nowMs?: () => number;
}

export function xstocksAssetsRegistryWriterConfigFromEnv(): XStocksAssetsRegistryWriterConfig {
  return {
    s3Bucket: process.env.POOL_CACHING_S3_BUCKET || '',
    s3BaseKey:
      process.env.XSTOCKS_ASSETS_REGISTRY_S3_BASE_KEY ||
      DEFAULT_XSTOCKS_ASSETS_REGISTRY_BASE_KEY,
    // Writer scope is intentionally independent of XSTOCKS_CHAIN_IDS: the
    // registry must be able to discover a newly-supported xStock chain.
    chainIds: [
      ChainId.MAINNET,
      ChainId.UNICHAIN,
      ChainId.BASE,
      ChainId.ARBITRUM,
      ChainId.AVAX,
      ChainId.XLAYER,
      ChainId.ROBINHOOD,
      ChainId.SEPOLIA,
    ],
    retirementSafetyMarginMs: XSTOCKS_RETIREMENT_SAFETY_MARGIN_MS,
    retiredRetentionMs: XSTOCKS_RETIRED_RETENTION_MS,
    runIntervalMs: 5 * 60 * 1000,
    expectedHookCodehashByChain: parseExpectedHookCodehashByChain(
      process.env.XSTOCKS_EXPECTED_HOOK_CODEHASH_BY_CHAIN
    ),
  };
}

const CODEHASH = /^0x[0-9a-fA-F]{64}$/;

/**
 * `{"1": "0x…", "196": "0x…"}` → chainId→codehash. Malformed input (or a
 * malformed value) yields no entry, and the verifier fails closed on chains
 * without one — a config typo reads as "nothing verifiable", never as
 * "skip the check".
 */
export function parseExpectedHookCodehashByChain(
  raw: string | undefined
): Readonly<Record<number, string>> {
  if (!raw || raw.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  const result: Record<number, string> = {};
  for (const [chainId, codehash] of Object.entries(parsed)) {
    if (
      INTEGER.test(chainId) &&
      typeof codehash === 'string' &&
      CODEHASH.test(codehash)
    ) {
      result[Number(chainId)] = codehash.toLowerCase();
    }
  }
  return result;
}

interface PreviousRegistryRead {
  entries: XStocksAssetEntry[];
  sanitized: boolean;
  etag: string | undefined;
  objectExists: boolean;
}

async function readPreviousEntries(
  s3: S3Client,
  bucket: string,
  key: string,
  logger: Logger
): Promise<PreviousRegistryRead> {
  let raw: string | undefined;
  let etag: string | undefined;
  try {
    const response = await s3.send(
      new GetObjectCommand({Bucket: bucket, Key: key})
    );
    etag = response.ETag;
    raw = response.Body
      ? await response.Body.transformToString('utf-8')
      : undefined;
  } catch (error) {
    if ((error as {name?: string}).name === 'NoSuchKey') {
      return {
        entries: [],
        etag: undefined,
        sanitized: false,
        objectExists: false,
      };
    }
    throw error;
  }
  if (!raw) return {entries: [], etag, sanitized: true, objectExists: true};
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return {entries: [], etag, sanitized: true, objectExists: true};
    }
    const entries = parsed.filter(isWellFormedXStocksAssetEntry);
    if (entries.length !== parsed.length) {
      logger.warn('Dropping malformed xStocks registry entries', {key});
    }
    return {
      entries,
      etag,
      sanitized: entries.length !== parsed.length,
      objectExists: true,
    };
  } catch (error) {
    logger.warn(
      'Corrupt xStocks registry object; rebuilding from fresh state',
      {
        key,
        error,
      }
    );
    return {entries: [], etag, sanitized: true, objectExists: true};
  }
}

interface WriterMarkerRead {
  lastSuccessfulRunAtMs: number | undefined;
  etag: string | undefined;
}

async function readWriterMarker(
  s3: S3Client,
  bucket: string,
  baseKey: string
): Promise<WriterMarkerRead> {
  try {
    const response = await s3.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: XSTOCKS_ASSETS_REGISTRY_WRITER_MARKER_S3_KEY(baseKey),
      })
    );
    const raw = response.Body
      ? await response.Body.transformToString('utf-8')
      : undefined;
    const parsed: unknown = raw ? JSON.parse(raw) : undefined;
    const lastSuccessfulRunAtMs = (parsed as {lastSuccessfulRunAtMs?: unknown})
      ?.lastSuccessfulRunAtMs;
    return {
      lastSuccessfulRunAtMs:
        typeof lastSuccessfulRunAtMs === 'number' &&
        Number.isFinite(lastSuccessfulRunAtMs)
          ? lastSuccessfulRunAtMs
          : undefined,
      etag: response.ETag,
    };
  } catch (error) {
    if ((error as {name?: string}).name === 'NoSuchKey') {
      return {lastSuccessfulRunAtMs: undefined, etag: undefined};
    }
    throw error;
  }
}

function entryFromDeployment(
  xStock: string,
  deployment: XStocksApiAsset['tokenDeployments'][number],
  updatedAtMs: number
): XStocksAssetEntry | undefined {
  if (
    !deployment.hookAddress ||
    !deployment.poolId ||
    !deployment.feeTier ||
    !deployment.tickSpacing
  ) {
    return undefined;
  }
  const entry: XStocksAssetEntry = {
    xStock,
    wxStock: deployment.wrapperAddress,
    hookAddress: deployment.hookAddress,
    poolId: deployment.poolId,
    feeTier: deployment.feeTier,
    tickSpacing: deployment.tickSpacing,
    status: 'active',
    updatedAtMs,
  };
  return isWellFormedXStocksAssetEntry(entry) ? entry : undefined;
}

/** Reconciles the complete verified API view into per-chain S3 tombstone registries. */
export async function buildXStocksAssetsRegistry(
  logger: Logger,
  metric: IMetric,
  config: XStocksAssetsRegistryWriterConfig,
  deps: XStocksAssetsRegistryWriterDeps
): Promise<void> {
  if (!config.s3Bucket) throw new Error('POOL_CACHING_S3_BUCKET must be set');
  const nowMs = (deps.nowMs ?? Date.now)();
  const assets = await deps.fetchAssets();
  const writerMarker = await readWriterMarker(
    deps.s3,
    config.s3Bucket,
    config.s3BaseKey
  );
  const coldResume =
    writerMarker.lastSuccessfulRunAtMs === undefined ||
    nowMs - writerMarker.lastSuccessfulRunAtMs >
      3 * (config.runIntervalMs ?? 5 * 60 * 1000);
  if (coldResume) {
    logger.warn(
      'xStocks registry writer resuming after a long gap; skipping absence-based retirements this run'
    );
  }
  const candidatesByChain = new Map<number, XStocksAssetEntry[]>();
  for (const asset of assets) {
    for (const deployment of asset.tokenDeployments) {
      if (deployment.version === 'v1') continue;
      const entry = entryFromDeployment(asset.xStockAddress, deployment, nowMs);
      if (!entry) continue;
      const list = candidatesByChain.get(deployment.chainId) ?? [];
      list.push(entry);
      candidatesByChain.set(deployment.chainId, list);
    }
  }

  const verifiedByChain = new Map<number, XStocksAssetEntry[]>();
  const verificationFailuresByChain = new Map<number, Set<string>>();
  const verifierDeps: XStocksOnChainVerifierDeps = {
    ...deps,
    expectedHookCodehashByChain:
      deps.expectedHookCodehashByChain ?? config.expectedHookCodehashByChain,
  };
  await Promise.all(
    Array.from(candidatesByChain.entries()).map(
      async ([chainId, candidates]) => {
        const verified = await Promise.all(
          candidates.map(async entry => {
            try {
              const verified = deps.verifyAsset
                ? await deps.verifyAsset(chainId, entry)
                : await verifyXStocksAssetOnChain(chainId, entry, verifierDeps);
              if (!verified) {
                const failures =
                  verificationFailuresByChain.get(chainId) ?? new Set<string>();
                failures.add(entry.xStock.toLowerCase());
                verificationFailuresByChain.set(chainId, failures);
                logger.warn('xStocks asset verification failed', {
                  chainId,
                  xStock: entry.xStock,
                  wxStock: entry.wxStock,
                  hookAddress: entry.hookAddress,
                });
                metric.putMetric(
                  'XStocksAssetsRegistry.verificationFailed',
                  1,
                  MetricLoggerUnit.Count,
                  {
                    chain: ChainId[chainId] ?? 'unknown',
                    status: 'failure',
                  }
                );
              }
              return verified ? entry : undefined;
            } catch (error) {
              const failures =
                verificationFailuresByChain.get(chainId) ?? new Set<string>();
              failures.add(entry.xStock.toLowerCase());
              verificationFailuresByChain.set(chainId, failures);
              logger.warn('xStocks asset verification failed', {
                chainId,
                xStock: entry.xStock,
                wxStock: entry.wxStock,
                hookAddress: entry.hookAddress,
                error,
              });
              metric.putMetric(
                'XStocksAssetsRegistry.verificationFailed',
                1,
                MetricLoggerUnit.Count,
                {chain: ChainId[chainId] ?? 'unknown', status: 'failure'}
              );
              return undefined;
            }
          })
        );
        verifiedByChain.set(
          chainId,
          verified.filter(
            (entry): entry is XStocksAssetEntry => entry !== undefined
          )
        );
      }
    )
  );

  // Include old chains so an API removal can retire their previously-active entry.
  const chainIds = new Set<number>([
    ...config.chainIds,
    ...candidatesByChain.keys(),
    ...verifiedByChain.keys(),
  ]);
  let successfulChains = 0;
  const configuredChainIds = new Set(config.chainIds);
  let failedConfiguredChains = 0;
  await Promise.all(
    Array.from(chainIds).map(async chainId => {
      const tags = {chain: ChainId[chainId] ?? 'unknown'};
      const key = XSTOCKS_ASSETS_REGISTRY_S3_KEY(config.s3BaseKey, chainId);
      try {
        const previousRead = await readPreviousEntries(
          deps.s3,
          config.s3Bucket,
          key,
          logger
        );
        const fresh = verifiedByChain.get(chainId) ?? [];
        const freshByXStock = new Map(
          fresh.map(entry => [entry.xStock.toLowerCase(), entry])
        );
        const verificationFailures =
          verificationFailuresByChain.get(chainId) ?? new Set<string>();
        const merged = new Map<string, XStocksAssetEntry>();
        for (const previous of previousRead.entries) {
          const replacement = freshByXStock.get(previous.xStock.toLowerCase());
          if (replacement) {
            merged.set(replacement.xStock.toLowerCase(), replacement);
          } else if (previous.status === 'active') {
            // updatedAtMs is the last confirmed-present time. It doubles as the
            // missing-since marker, avoiding a schema-only firstMissingAt field.
            const retired =
              verificationFailures.has(previous.xStock.toLowerCase()) ||
              (!coldResume &&
                nowMs - previous.updatedAtMs >=
                  config.retirementSafetyMarginMs);
            merged.set(
              previous.xStock.toLowerCase(),
              retired
                ? {...previous, status: 'retired', updatedAtMs: nowMs}
                : previous
            );
          } else if (nowMs - previous.updatedAtMs < config.retiredRetentionMs) {
            merged.set(previous.xStock.toLowerCase(), previous);
          }
        }
        for (const entry of fresh)
          merged.set(entry.xStock.toLowerCase(), entry);
        const entries = Array.from(merged.values());
        const serialize = (items: XStocksAssetEntry[]) =>
          JSON.stringify(
            [...items].sort((a, b) => a.xStock.localeCompare(b.xStock))
          );
        if (
          !previousRead.objectExists ||
          previousRead.sanitized ||
          serialize(entries) !== serialize(previousRead.entries)
        ) {
          try {
            await deps.s3.send(
              new PutObjectCommand({
                Bucket: config.s3Bucket,
                Key: key,
                Body: JSON.stringify(entries),
                ContentType: 'application/json',
                ...(previousRead.etag !== undefined
                  ? {IfMatch: previousRead.etag}
                  : {IfNoneMatch: '*'}),
              })
            );
          } catch (error) {
            const name = (error as {name?: string}).name;
            const statusCode = (
              error as {$metadata?: {httpStatusCode?: number}}
            ).$metadata?.httpStatusCode;
            if (
              name === 'PreconditionFailed' ||
              name === 'ConditionalRequestConflict' ||
              statusCode === 412 ||
              statusCode === 409
            ) {
              logger.warn(
                'xStocks registry advanced concurrently; skipping stale write',
                {chainId, key}
              );
              metric.putMetric(
                'XStocksAssetsRegistry.staleWriteSkipped',
                1,
                MetricLoggerUnit.Count,
                {...tags, status: 'failure'}
              );
              if (configuredChainIds.has(chainId)) failedConfiguredChains += 1;
              metric.putMetric(
                'XStocksAssetsRegistry.chainRun',
                1,
                MetricLoggerUnit.Count,
                {...tags, status: 'failure', reason: 'stale_write_conflict'}
              );
              return;
            }
            throw error;
          }
        }
        metric.putMetric(
          'XStocksAssetsRegistry.entries',
          entries.length,
          MetricLoggerUnit.None,
          {...tags, status: 'success'}
        );
        successfulChains += 1;
        metric.putMetric(
          'XStocksAssetsRegistry.chainRun',
          1,
          MetricLoggerUnit.Count,
          {...tags, status: 'success'}
        );
      } catch (error) {
        if (configuredChainIds.has(chainId)) failedConfiguredChains += 1;
        logger.error('xStocks registry run failed for chain', {chainId, error});
        metric.putMetric(
          'XStocksAssetsRegistry.chainRun',
          1,
          MetricLoggerUnit.Count,
          {...tags, status: 'failure', reason: 'chain_run_failed'}
        );
      }
    })
  );

  // Scoped to config.chainIds (the writer's authoritative scope), not the
  // broader reconciliation set -- an out-of-scope chain observed only via
  // the API/prior S3 state must never mask every configured chain failing.
  if (
    configuredChainIds.size > 0 &&
    failedConfiguredChains === configuredChainIds.size
  ) {
    throw new Error(
      `xStocks assets registry run failed for all ${failedConfiguredChains} configured chains`
    );
  }

  if (successfulChains > 0) {
    await deps.s3.send(
      new PutObjectCommand({
        Bucket: config.s3Bucket,
        Key: XSTOCKS_ASSETS_REGISTRY_WRITER_MARKER_S3_KEY(config.s3BaseKey),
        Body: JSON.stringify({lastSuccessfulRunAtMs: nowMs}),
        ContentType: 'application/json',
        ...(writerMarker.etag !== undefined
          ? {IfMatch: writerMarker.etag}
          : {IfNoneMatch: '*'}),
      })
    );
  }
}
