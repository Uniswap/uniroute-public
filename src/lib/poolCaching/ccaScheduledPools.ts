/**
 * CCA (liquidity-launcher / candle auction) scheduled-pool registry writer.
 *
 * A CCA launch migrates auction liquidity into a brand-new V4 pool at a
 * migrationBlock known well in advance. The subgraph→S3 pool cron (+ serve
 * caches) takes ~20-50 min to surface that pool, so this job pre-registers it:
 * it polls data-api for auctions pending LBP migration, completes the PoolKey
 * with one authoritative `LBPStrategy.initializers(auction)` eth_call, and
 * publishes a small per-chain registry object to the pool-cache S3 bucket.
 * `S3SubgraphPoolDiscovererV4` merges active entries into routing at serve
 * time (see CcaScheduledPoolsRepository). ROUTE-1134.
 */

import {S3Client, PutObjectCommand, GetObjectCommand} from '@aws-sdk/client-s3';
import axios from 'axios';
import {ethers} from 'ethers';
import {V4Pool} from '../../models/pool/V4Pool';
import {Address} from '../../models/address/Address';
import {Logger} from './sor-providers/util/log';
import {IMetric, MetricLoggerUnit} from './sor-providers/util/metric';
import {ChainId} from '../config';

export const DEFAULT_CCA_SCHEDULED_POOLS_BASE_KEY = 'ccaScheduledPools.json';

// Uncompressed JSON (the object holds at most a few hundred small entries),
// keyed like the main pool cache objects for bucket-listing consistency.
export const CCA_SCHEDULED_POOLS_S3_KEY = (
  baseKey: string,
  chainId: number
): string => `${baseKey}-${chainId}-V4`;

/**
 * Registry entry: the V4PoolData fields S3SubgraphPoolDiscovererV4 serves
 * (liquidity synthesized to '1' so the serving-side liquidity>0 filter keeps
 * it; real pool state is always read on-chain at quote time) plus scheduling
 * metadata for activation/expiry.
 */
export interface CcaScheduledPoolEntry {
  id: string; // V4 poolId (lowercase)
  token0: {id: string};
  token1: {id: string};
  feeTier: string;
  tickSpacing: string;
  hooks: string;
  liquidity: string;
  tvlETH: number;
  tvlUSD: number;
  migrationBlock: string;
  // Estimated wall-clock activation (migrationBlock reached); re-estimated
  // every run so the error converges to ~0 near migration.
  activateAtMs: number;
  expiresAtMs: number;
  auctionAddress: string;
  // The LBP strategy holding this auction's registration; used to re-verify
  // initializers(auction) on-chain when the auction leaves data-api's window
  // before activation.
  strategyAddress: string;
  // The auctioned token (vs the paired currency). The serve-time merge only
  // appends this pool to quotes whose tokenIn/tokenOut IS this token — a
  // launch's paired currency (usually native ETH) must not drag the pool into
  // every quote touching that currency.
  launchedToken: string;
}

/**
 * Single shape validator shared by the writer's read-modify-write and the
 * serve-side repository — two divergent validators would let schema skew
 * round-trip entries the reader silently drops. Covers every field either
 * side dereferences (numeric-string pool params parse downstream; undefined
 * tvl would escape the merge's fail-open boundary as NaN ranking input).
 */
export function isWellFormedCcaEntry(entry: CcaScheduledPoolEntry): boolean {
  return (
    typeof entry?.id === 'string' &&
    typeof entry.token0?.id === 'string' &&
    typeof entry.token1?.id === 'string' &&
    typeof entry.hooks === 'string' &&
    typeof entry.launchedToken === 'string' &&
    typeof entry.feeTier === 'string' &&
    typeof entry.tickSpacing === 'string' &&
    typeof entry.liquidity === 'string' &&
    typeof entry.tvlETH === 'number' &&
    typeof entry.tvlUSD === 'number' &&
    typeof entry.migrationBlock === 'string' &&
    typeof entry.auctionAddress === 'string' &&
    typeof entry.strategyAddress === 'string' &&
    typeof entry.activateAtMs === 'number' &&
    typeof entry.expiresAtMs === 'number'
  );
}

export interface PendingLbpAuction {
  auctionId: string;
  chainId: number;
  address: string;
  lbpStrategyAddress: string;
  // True once migrate() ran (data-api pool_key_hash set). Disambiguates an
  // initializers() read of migrationBlock 0: the strategy CONSUMES the
  // per-auction struct on migrate(), so 0 means either "registration
  // cleared/reorged" (prune) or "already migrated" (keep the entry — it's
  // the bridge until the subgraph serves the real pool).
  hasMigrated: boolean;
  // The ACTUAL migrated pool's V4 poolId (data-api pool_key_hash, from the
  // Migrated event). Can differ from the poolId we pre-registered:
  // LBPStrategy.migrate() rewrites key.hooks to the strategy address when
  // the canonical hookless pool already exists at migrate time
  // (SelfInitializerMixin), so even a hookless-registered launch can land in
  // a hooked pool. A mismatched bridge entry points at the wrong pool and
  // must be pruned, not served until expiry.
  migratedPoolId?: string;
}

export interface LbpInitializerInfo {
  migrationBlock: bigint;
  token: string;
  currency: string;
  fee: number;
  tickSpacing: number;
  hook: string;
}

export interface CcaScheduledPoolsWriterConfig {
  s3Bucket: string;
  s3BaseKey: string;
  chainIds: number[];
  // How long an entry survives past its estimated activation. Backstop for
  // migrations that never execute; normal retirement is dedup against the
  // real subgraph entry at serve time.
  entryTtlAfterActivationMs: number;
}

export interface CcaScheduledPoolsWriterDeps {
  s3: S3Client;
  fetchPendingAuctions: (chainIds: number[]) => Promise<PendingLbpAuction[]>;
  readLbpInitializer: (
    chainId: number,
    strategyAddress: string,
    auctionAddress: string
  ) => Promise<LbpInitializerInfo>;
  getBlockNumber: (chainId: number) => Promise<number>;
  nowMs?: () => number;
}

export function ccaScheduledPoolsWriterConfigFromEnv(): CcaScheduledPoolsWriterConfig {
  return {
    s3Bucket: process.env.POOL_CACHING_S3_BUCKET || '',
    s3BaseKey:
      process.env.CCA_SCHEDULED_POOLS_S3_BASE_KEY ||
      DEFAULT_CCA_SCHEDULED_POOLS_BASE_KEY,
    chainIds: parseChainIds(process.env.CCA_SCHEDULED_POOLS_CHAIN_IDS),
    entryTtlAfterActivationMs: 24 * 60 * 60 * 1000,
  };
}

// Launcher chains ∩ uniroute V4 chains. Env-overridable so a new launch chain
// doesn't need a code change.
const DEFAULT_CCA_CHAIN_IDS = [
  ChainId.MAINNET,
  ChainId.UNICHAIN,
  ChainId.BASE,
  ChainId.ARBITRUM,
  ChainId.AVAX,
  ChainId.XLAYER,
  ChainId.ROBINHOOD,
  ChainId.SEPOLIA,
];

function parseChainIds(raw: string | undefined): number[] {
  if (!raw) return DEFAULT_CCA_CHAIN_IDS;
  const parsed = raw
    .split(',')
    .map(s => Number.parseInt(s.trim(), 10))
    .filter(n => Number.isFinite(n) && n > 0);
  if (parsed.length === 0) {
    // Fail CLOSED on an explicitly-set-but-invalid value: silently widening
    // to the full default list would invert an operator's intent to narrow
    // (or effectively disable) the chain set.
    console.error(
      `CCA_SCHEDULED_POOLS_CHAIN_IDS is set but contains no valid chain ids: "${raw}"; running with no chains`
    );
    return [];
  }
  return parsed;
}

// Approximate seconds per block, only used to estimate activateAtMs; the
// estimate self-corrects every cron run so precision doesn't matter far out.
const BLOCK_TIME_SECONDS_BY_CHAIN: Record<number, number> = {
  [ChainId.MAINNET]: 12,
  [ChainId.UNICHAIN]: 1,
  [ChainId.BASE]: 2,
  [ChainId.ARBITRUM]: 0.25,
  [ChainId.AVAX]: 2,
  [ChainId.XLAYER]: 3,
  [ChainId.ROBINHOOD]: 2,
  [ChainId.SEPOLIA]: 12,
};
const DEFAULT_BLOCK_TIME_SECONDS = 2;

const ADDRESS_ZERO_LOWER = '0x0000000000000000000000000000000000000000';

// A zeroed initializers() read is ambiguous: the strategy consumes the struct
// on migrate(), and both the data-api snapshot (read-replica + pubsub
// ingestion lag) and the on-chain read race the actual migration. Since
// migrate() is only possible at/after migrationBlock, a zero read is provably
// "cleared/reorged" only when the entry's estimated activation is comfortably
// in the future — inside this margin, keep the entry (it may be the
// post-migration bridge) and let the expiry backstop bound a wrong keep.
const CLEARED_DROP_SAFETY_MARGIN_MS = 60 * 60 * 1000;

// Struct layout mirrors liquidity-launcher LbpStrategies.initializers
// (MigratorParameters); same read as liquidity's AuctionRpcClient.
export const LBP_STRATEGY_INITIALIZERS_ABI = [
  'function initializers(address initializer) view returns (tuple(address token, address currency, uint64 migrationBlock, uint128 reservedTokenAmountForLP, address recipient, address positionRecipient, tuple(uint24 fee, int24 tickSpacing, address hook) poolParameters, bytes positionDefinitions, bytes lpAllocationSchedule))',
];

/**
 * Compute the Uniswap v4 PoolId for an LBP migration pool, matching on-chain
 * `PoolKey.toId()`. Delegates to the in-service V4Pool.computePoolId (same
 * keccak over the sorted PoolKey); kept as a named wrapper because callers
 * here hold raw address strings from the initializers() read.
 */
export function computeCcaPoolId(
  currency: string,
  token: string,
  fee: number,
  tickSpacing: number,
  hook: string
): string {
  return V4Pool.computePoolId(
    new Address(currency),
    new Address(token),
    fee,
    tickSpacing,
    hook
  );
}

export function makeDataApiPendingAuctionsFetcher(
  dataApiUrl: string
): (chainIds: number[]) => Promise<PendingLbpAuction[]> {
  return async (chainIds: number[]) => {
    // Cron container: no request context, so no ctx.axios (same bare-axios
    // pattern as the other pool-caching jobs' outbound HTTP). Wire shape
    // mirrors data.v1.AuctionService/ListAuctionsPendingLbpMigration
    // (data-api proto/data/v1/auction.proto) — the same local-interface
    // consumption pattern liquidity's DataApiClient uses; there is no
    // published data-api client package.
    const response = await axios.post<{
      auctions?: Array<{
        auctionId?: string;
        chainId?: number;
        address?: string;
        lbpStrategyAddress?: string;
        poolKeyHash?: string;
      }>;
    }>(
      `${dataApiUrl}/data.v1.AuctionService/ListAuctionsPendingLbpMigration`,
      {chainIds},
      {timeout: 10_000}
    );
    return (response.data.auctions ?? [])
      .filter(a => a.address && a.lbpStrategyAddress && a.chainId)
      .map(a => ({
        auctionId: a.auctionId ?? '',
        chainId: a.chainId!,
        address: a.address!,
        lbpStrategyAddress: a.lbpStrategyAddress!,
        hasMigrated: Boolean(a.poolKeyHash),
        // Only trust a well-formed 32-byte hash for the mismatch prune — a
        // malformed value must not delete a good entry.
        migratedPoolId: /^0x[0-9a-fA-F]{64}$/.test(a.poolKeyHash ?? '')
          ? a.poolKeyHash!.toLowerCase()
          : undefined,
      }));
  };
}

export function makeOnChainLbpInitializerReader(uniRpcEndpoint: string): {
  readLbpInitializer: CcaScheduledPoolsWriterDeps['readLbpInitializer'];
  getBlockNumber: CcaScheduledPoolsWriterDeps['getBlockNumber'];
} {
  const providers = new Map<number, ethers.providers.StaticJsonRpcProvider>();
  const providerFor = (chainId: number) => {
    let provider = providers.get(chainId);
    if (!provider) {
      provider = new ethers.providers.StaticJsonRpcProvider(
        `${uniRpcEndpoint}/rpc/${chainId}`,
        chainId
      );
      providers.set(chainId, provider);
    }
    return provider;
  };

  return {
    readLbpInitializer: async (chainId, strategyAddress, auctionAddress) => {
      const strategy = new ethers.Contract(
        strategyAddress,
        LBP_STRATEGY_INITIALIZERS_ABI,
        providerFor(chainId)
      );
      const info = await strategy.initializers(auctionAddress);
      return {
        migrationBlock: BigInt(info.migrationBlock.toString()),
        token: info.token as string,
        currency: info.currency as string,
        fee: Number(info.poolParameters.fee),
        tickSpacing: Number(info.poolParameters.tickSpacing),
        hook: info.poolParameters.hook as string,
      };
    },
    getBlockNumber: chainId => providerFor(chainId).getBlockNumber(),
  };
}

interface PreviousRegistryRead {
  entries: CcaScheduledPoolEntry[];
  // True when the stored object was corrupt / non-array / carried malformed
  // entries that were dropped: the sanitized state must be WRITTEN BACK even
  // when it equals the merged result, or the bad object persists and the
  // serve-side reader errors on every ~45s refresh forever.
  sanitized: boolean;
  // ETag of the object these entries came from; undefined when the object
  // does not exist yet. The write back is conditional on it so a stale run
  // (wedged past the overlap-guard ceiling, or deploy-overlap twin) can
  // never clobber a newer run's registry with its old snapshot — a lost
  // update could permanently delete a post-migration bridge entry, which is
  // unreconstructable (initializers() is consumed on-chain).
  etag: string | undefined;
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
    if ((error as {name?: string})?.name === 'NoSuchKey') {
      // First run for this chain — nothing to merge.
      return {entries: [], etag: undefined, sanitized: false};
    }
    // A transient read failure must ABORT this chain's run (skip the PUT):
    // treating it as "no previous entries" would overwrite the registry
    // without activated survivors that data-api's trailing window no longer
    // returns — deleting exactly the entries the feature exists to serve.
    logger.error(
      `Failed to read previous CCA scheduled pools object at ${key}`,
      {error}
    );
    throw error;
  }
  // An existing object with an EMPTY body is corrupt (the serve-side reader's
  // JSON.parse('') throws on every refresh) — force the heal rewrite.
  if (!raw) return {entries: [], etag, sanitized: true};
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return {entries: [], etag, sanitized: true};
    // Per-entry shape validation: a single malformed entry (manual S3 edit,
    // schema skew) must be dropped — not throw later in the merge loop,
    // which would abort every subsequent run and freeze the chain's
    // registry until manual repair.
    const entries = parsed as CcaScheduledPoolEntry[];
    const wellFormed = entries.filter(isWellFormedCcaEntry);
    if (wellFormed.length !== entries.length) {
      logger.error(
        `Dropping ${entries.length - wellFormed.length} malformed CCA scheduled pool entries at ${key}`
      );
    }
    return {
      entries: wellFormed,
      etag,
      sanitized: wellFormed.length !== entries.length,
    };
  } catch (error) {
    // A corrupt object has nothing worth preserving — rebuild from fresh
    // state so the chain self-heals instead of freezing until manual repair.
    logger.error(
      `Corrupt CCA scheduled pools object at ${key}; rebuilding from fresh state`,
      {error}
    );
    return {entries: [], etag, sanitized: true};
  }
}

/**
 * One writer run: fetch pending auctions, confirm each PoolKey on-chain,
 * merge with the previous registry (fresh entries win; expired/cleared
 * entries pruned), and publish one JSON object per chain when it changed.
 */
export async function buildCcaScheduledPools(
  logger: Logger,
  metric: IMetric,
  config: CcaScheduledPoolsWriterConfig,
  deps: CcaScheduledPoolsWriterDeps
): Promise<void> {
  if (!config.s3Bucket) {
    throw new Error('POOL_CACHING_S3_BUCKET must be set');
  }
  // Fail-closed parseChainIds can yield []. Skip entirely — data-api treats
  // an empty chain_ids filter as "all chains", which would fetch every
  // pending auction across the fleet each tick for nothing.
  if (config.chainIds.length === 0) {
    logger.warn('CCA scheduled pools: no chains configured; skipping run');
    return;
  }
  const nowMs = deps.nowMs ?? Date.now;

  const pendingAuctions = await deps.fetchPendingAuctions(config.chainIds);
  const auctionsByChain = new Map<number, PendingLbpAuction[]>();
  for (const auction of pendingAuctions) {
    const list = auctionsByChain.get(auction.chainId) ?? [];
    list.push(auction);
    auctionsByChain.set(auction.chainId, list);
  }

  let failedChains = 0;
  await Promise.all(
    config.chainIds.map(async chainId => {
      const tags = {chain: ChainId[chainId] ?? String(chainId)};
      try {
        const auctions = auctionsByChain.get(chainId) ?? [];
        const s3Key = CCA_SCHEDULED_POOLS_S3_KEY(config.s3BaseKey, chainId);
        const blockTimeMs =
          (BLOCK_TIME_SECONDS_BY_CHAIN[chainId] ?? DEFAULT_BLOCK_TIME_SECONDS) *
          1000;

        const {
          entries: previous,
          etag: previousEtag,
          sanitized: previousSanitized,
        } = await readPreviousEntries(deps.s3, config.s3Bucket, s3Key, logger);

        // One block-number read per run, fetched lazily (idle chains with an
        // empty registry never touch the RPC).
        let currentBlockPromise: Promise<number> | undefined;
        const getCurrentBlock = () =>
          (currentBlockPromise ??= deps.getBlockNumber(chainId));

        const buildEntry = (
          auctionAddress: string,
          strategyAddress: string,
          info: LbpInitializerInfo,
          currentBlock: number
        ): CcaScheduledPoolEntry => {
          const poolId = computeCcaPoolId(
            info.currency,
            info.token,
            info.fee,
            info.tickSpacing,
            info.hook
          );
          const [token0, token1] =
            BigInt(info.currency) < BigInt(info.token)
              ? [info.currency, info.token]
              : [info.token, info.currency];
          const blocksRemaining = Number(info.migrationBlock) - currentBlock;
          const activateAtMs = nowMs() + blocksRemaining * blockTimeMs;
          return {
            id: poolId.toLowerCase(),
            token0: {id: token0.toLowerCase()},
            token1: {id: token1.toLowerCase()},
            feeTier: String(info.fee),
            tickSpacing: String(info.tickSpacing),
            hooks: info.hook.toLowerCase(),
            liquidity: '1',
            tvlETH: 0,
            tvlUSD: 0,
            migrationBlock: info.migrationBlock.toString(),
            activateAtMs,
            // Anchor expiry at write time, not at estimated activation:
            // migrationBlock is when migrate() becomes PERMITTED, not when
            // it runs. A migration executed days late would otherwise
            // produce entries that are already expired at the moment the
            // pool finally exists. Entries are re-estimated every run (fresh
            // path and orphan-rebuild path both), so expiry only governs
            // entries no longer refreshed at all.
            expiresAtMs:
              Math.max(activateAtMs, nowMs()) +
              config.entryTtlAfterActivationMs,
            auctionAddress,
            strategyAddress,
            launchedToken: info.token.toLowerCase(),
          };
        };

        // Fresh reads run in parallel (same job-timeout rationale as the
        // orphan re-verification below). The strategy CONSUMES the
        // per-auction initializers struct on migrate(), so a migrationBlock-0
        // read is ambiguous and disambiguated via data-api's pool_key_hash:
        // - hasMigrated: the auction migrated — its previous entry is the
        //   bridge until the subgraph serves the real pool; leave it alone.
        // - not migrated: registration cleared/reorged — record it so the
        //   previous entry gets pruned instead of lingering until expiry.
        const freshEntries: CcaScheduledPoolEntry[] = [];
        const clearedAuctions = new Set<string>();
        const hookedAuctions = new Set<string>();
        // Actual migrated poolId per auction, for the mismatch prune below.
        const migratedPoolIdByAuction = new Map<string, string>();
        for (const auction of auctions) {
          if (auction.migratedPoolId !== undefined) {
            migratedPoolIdByAuction.set(
              auction.address.toLowerCase(),
              auction.migratedPoolId
            );
          }
        }
        await Promise.all(
          auctions.map(async auction => {
            try {
              const info = await deps.readLbpInitializer(
                chainId,
                auction.lbpStrategyAddress,
                auction.address
              );
              if (info.migrationBlock === 0n) {
                if (!auction.hasMigrated) {
                  clearedAuctions.add(auction.address.toLowerCase());
                }
                return;
              }
              // The serve-time merge is hookless-only (hooked pools would
              // bypass selector trust boundaries), so publishing a hooked
              // entry is pure registry noise — skip at the source. Also
              // prune a previously-published hookless entry for this
              // auction (re-registered with a hook): its poolId will never
              // exist on-chain, and unlike the cleared read this is an
              // affirmative registration read — no safety margin needed.
              if (info.hook.toLowerCase() !== ADDRESS_ZERO_LOWER) {
                hookedAuctions.add(auction.address.toLowerCase());
                logger.warn(
                  'Skipping CCA pool with hook (hooked launches unsupported)',
                  {chainId, auction: auction.address, hook: info.hook}
                );
                metric.putMetric(
                  'CcaScheduledPools.hookedLaunchSkipped',
                  1,
                  MetricLoggerUnit.Count,
                  {...tags, status: 'failure', reason: 'hooked_launch'}
                );
                return;
              }
              freshEntries.push(
                buildEntry(
                  auction.address,
                  auction.lbpStrategyAddress,
                  info,
                  await getCurrentBlock()
                )
              );
            } catch (error) {
              // Skip this auction; retried on the next run (hours of
              // headroom before migration).
              logger.warn('Failed to read LBP initializer for auction', {
                chainId,
                auction: auction.address,
                error,
              });
              metric.putMetric(
                'CcaScheduledPools.auctionReadError',
                1,
                MetricLoggerUnit.Count,
                {...tags, status: 'failure', reason: 'initializers_read_failed'}
              );
            }
          })
        );

        // Merge previous entries:
        // - expired → dropped (unless resurrected by a rebuild below);
        // - superseded by a fresh entry → fresh wins (re-estimated), and a
        //   fresh entry under a DIFFERENT poolId prunes the stale-id one;
        // - registration read back CLEARED this run and activation is
        //   comfortably in the future → dropped (canceled/reorged; the
        //   safety margin covers migrate() racing data-api's snapshot);
        // - absent from data-api (aged past the 14-day pending window,
        //   reorged, or cleared) → re-verified on-chain in parallel; if
        //   still registered, REBUILT with a fresh schedule estimate (a
        //   verbatim carry-forward would let the estimate drift for days),
        //   else dropped past the safety margin; kept as-is on a transient
        //   re-verification failure;
        // - activated bridge entries (post-migration) → kept until expiry;
        //   dedup against the real subgraph pool retires them at serve time.
        const freshIds = new Set(freshEntries.map(entry => entry.id));
        // auction → fresh pool id, to supersede a previous entry whose
        // on-chain params (and therefore poolId) changed: the old-id entry
        // would otherwise linger as a duplicate until expiry (its auction is
        // still reported by data-api, so it never becomes an orphan).
        const freshIdByAuction = new Map(
          freshEntries.map(entry => [
            entry.auctionAddress.toLowerCase(),
            entry.id,
          ])
        );
        const respondedAuctions = new Set(
          auctions.map(auction => auction.address.toLowerCase())
        );
        // No activation/expiry precondition: an entry whose stale estimate
        // drifted past activation (or even past expiry) must still be
        // re-verified so a live registration gets rebuilt rather than
        // silently dropped.
        const orphans = previous.filter(
          entry =>
            !freshIds.has(entry.id) &&
            !respondedAuctions.has(entry.auctionAddress.toLowerCase()) &&
            !clearedAuctions.has(entry.auctionAddress.toLowerCase()) &&
            entry.strategyAddress
        );
        const orphanRebuilds = new Map<
          string,
          CcaScheduledPoolEntry | 'drop' | 'keep'
        >(
          await Promise.all(
            orphans.map(
              async (
                entry
              ): Promise<[string, CcaScheduledPoolEntry | 'drop' | 'keep']> => {
                try {
                  const info = await deps.readLbpInitializer(
                    chainId,
                    entry.strategyAddress,
                    entry.auctionAddress
                  );
                  if (info.migrationBlock === 0n) {
                    // Zero is ambiguous and this orphan has no data-api row
                    // to disambiguate with — same margin rule as the
                    // cleared-prune above.
                    return [
                      entry.id,
                      entry.activateAtMs - nowMs() >
                      CLEARED_DROP_SAFETY_MARGIN_MS
                        ? 'drop'
                        : 'keep',
                    ];
                  }
                  // Same hookless invariant as the fresh loop: params changed
                  // to a hooked pool means the old hookless pool won't exist
                  // and the new one is unsupported by the serve merge.
                  if (info.hook.toLowerCase() !== ADDRESS_ZERO_LOWER) {
                    return [entry.id, 'drop'];
                  }
                  return [
                    entry.id,
                    buildEntry(
                      entry.auctionAddress,
                      entry.strategyAddress,
                      info,
                      await getCurrentBlock()
                    ),
                  ];
                } catch (error) {
                  // Fail-safe: keep the entry as-is on a transient RPC
                  // failure; the expiry backstop bounds a wrong keep.
                  logger.warn(
                    'CCA orphan re-verification failed; keeping entry',
                    {chainId, auction: entry.auctionAddress, error}
                  );
                  return [entry.id, 'keep'];
                }
              }
            )
          )
        );

        const merged = new Map<string, CcaScheduledPoolEntry>();
        for (const entry of previous) {
          // Rebuild is evaluated before the expiry drop: an orphan whose
          // stale estimate already "expired" but whose registration is still
          // live gets resurrected with a fresh schedule.
          const rebuild = orphanRebuilds.get(entry.id);
          if (rebuild === 'drop') continue;
          if (rebuild !== undefined && rebuild !== 'keep') {
            merged.set(rebuild.id, rebuild);
            continue;
          }
          if (entry.expiresAtMs <= nowMs()) continue;
          const auctionKey = entry.auctionAddress.toLowerCase();
          // Prune a cleared registration only when activation is far enough
          // out that the zero read cannot be a just-consumed migration (see
          // CLEARED_DROP_SAFETY_MARGIN_MS) — data-api's hasMigrated snapshot
          // can lag the on-chain migrate().
          if (
            clearedAuctions.has(auctionKey) &&
            entry.activateAtMs - nowMs() > CLEARED_DROP_SAFETY_MARGIN_MS
          ) {
            continue;
          }
          // Re-registered WITH a hook this run: the previously-published
          // hookless entry's poolId will never exist on-chain — prune it
          // (mirrors the orphan path's hooked 'drop').
          if (hookedAuctions.has(auctionKey)) {
            continue;
          }
          // The auction migrated into a DIFFERENT pool than pre-registered —
          // LBPStrategy.migrate() rewrites key.hooks to the strategy address
          // when the canonical hookless pool already exists (front-runnable),
          // so even our own hookless launches can land hooked. The bridge
          // entry points at the wrong pool; serving it until expiry would
          // mask that the fast pickup silently failed for this launch. No
          // safety margin needed: a present pool_key_hash is affirmative
          // evidence of the migrated key, unlike the ambiguous cleared read.
          const migratedPoolId = migratedPoolIdByAuction.get(auctionKey);
          if (migratedPoolId !== undefined && migratedPoolId !== entry.id) {
            logger.warn(
              'CCA scheduled entry mismatches migrated pool key; pruning',
              {
                chainId,
                auction: entry.auctionAddress,
                registeredPoolId: entry.id,
                migratedPoolId,
              }
            );
            metric.putMetric(
              'CcaScheduledPools.poolKeyMismatch',
              1,
              MetricLoggerUnit.Count,
              {...tags, status: 'failure', reason: 'pool_key_mismatch'}
            );
            continue;
          }
          // Superseded by a fresh entry under a DIFFERENT poolId (on-chain
          // params changed): drop the stale-id duplicate.
          const freshId = freshIdByAuction.get(auctionKey);
          if (freshId !== undefined && freshId !== entry.id) {
            continue;
          }
          merged.set(entry.id, entry);
        }
        for (const entry of freshEntries) {
          // The mismatch prune above only filters `previous`: a lagging RPC
          // read racing data-api's recorded migration would re-publish the
          // pruned wrong-id entry here — filter fresh entries the same way.
          const freshMigratedPoolId = migratedPoolIdByAuction.get(
            entry.auctionAddress.toLowerCase()
          );
          if (
            freshMigratedPoolId !== undefined &&
            freshMigratedPoolId !== entry.id
          ) {
            continue;
          }
          merged.set(entry.id, entry);
        }
        const entries = Array.from(merged.values());

        // Most chains are idle most of the time — don't rewrite an unchanged
        // (usually empty) object every 2 minutes.
        const serialize = (list: CcaScheduledPoolEntry[]) =>
          JSON.stringify([...list].sort((a, b) => a.id.localeCompare(b.id)));
        // sanitized forces the PUT even when merged equals the sanitized
        // previous — the CORRUPT stored object must be replaced or the
        // reader errors on it forever.
        if (previousSanitized || serialize(entries) !== serialize(previous)) {
          try {
            await deps.s3.send(
              new PutObjectCommand({
                Bucket: config.s3Bucket,
                Key: s3Key,
                Body: JSON.stringify(entries),
                ContentType: 'application/json',
                // Conditional on the exact object version this run read: a
                // stale run (wedged past the overlap-guard ceiling, or a
                // deploy-overlap twin container) must not clobber a newer
                // run's write with its old snapshot — that lost update could
                // permanently delete a post-migration bridge entry.
                ...(previousEtag !== undefined
                  ? {IfMatch: previousEtag}
                  : {IfNoneMatch: '*'}),
              })
            );
            logger.info(
              `Wrote ${entries.length} CCA scheduled pool entries for chain ${chainId}`,
              {s3Key, fresh: freshEntries.length, previous: previous.length}
            );
          } catch (error) {
            const name = (error as {name?: string})?.name ?? '';
            const statusCode = (
              error as {$metadata?: {httpStatusCode?: number}}
            )?.$metadata?.httpStatusCode;
            // NoSuchKey/404: IfMatch PUT against a key deleted since the
            // read — same benign arbitration as 412/409 (next tick
            // recreates via IfNoneMatch).
            if (
              name === 'PreconditionFailed' ||
              name === 'ConditionalRequestConflict' ||
              name === 'NoSuchKey' ||
              statusCode === 412 ||
              statusCode === 409 ||
              statusCode === 404
            ) {
              // Another writer advanced the object since our read — drop
              // this run's write; the next tick re-reads and reconciles.
              logger.warn(
                'CCA scheduled pools registry advanced concurrently; skipping stale write',
                {chainId, s3Key}
              );
              metric.putMetric(
                'CcaScheduledPools.staleWriteSkipped',
                1,
                MetricLoggerUnit.Count,
                {...tags, status: 'failure', reason: 'stale_write_conflict'}
              );
              // Keep the per-chain series continuous and let persistent
              // all-chains conflict (long-lived twin writers, incl. single-chain
              // configs — deploy overlap of 2-3 ticks stays under the 5/30m
              // completed-monitor threshold) escalate to
              // the job-level failure below; brief deploy overlap stays
              // under the monitor thresholds.
              failedChains += 1;
              metric.putMetric(
                'CcaScheduledPools.chainRun',
                1,
                MetricLoggerUnit.Count,
                {...tags, status: 'failure', reason: 'stale_write_conflict'}
              );
              return;
            }
            throw error;
          }
        }
        // Level (registry size), not an event count — None maps to a dist so
        // window queries read the current size instead of size x ticks.
        metric.putMetric(
          'CcaScheduledPools.entries',
          entries.length,
          MetricLoggerUnit.None,
          {...tags, status: 'success'}
        );
        metric.putMetric(
          'CcaScheduledPools.chainRun',
          1,
          MetricLoggerUnit.Count,
          {...tags, status: 'success'}
        );
      } catch (error) {
        failedChains += 1;
        logger.error('CCA scheduled pools run failed for chain', {
          chainId,
          error,
        });
        metric.putMetric(
          'CcaScheduledPools.chainRun',
          1,
          MetricLoggerUnit.Count,
          {...tags, status: 'failure', reason: 'chain_run_failed'}
        );
      }
    })
  );

  // Per-chain failures are isolated above, but a run where EVERY chain failed
  // (IAM, data-api, RPC all-down) must surface as a job-level error so the
  // cron completed{status:failure} metric and its monitor fire.
  if (config.chainIds.length > 0 && failedChains === config.chainIds.length) {
    throw new Error(
      `CCA scheduled pools run failed for all ${failedChains} chains`
    );
  }
}
