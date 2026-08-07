import {
  Erc4626WrapperAsset,
  getErc4626HookCodeOverrides,
  getErc4626RoutingHookBytecode,
  getErc4626WrapperAssets,
} from '@uniswap/lib-sharedconfig/erc4626WrapperHooks';
import {Context} from '@uniswap/lib-uni/context';

export interface Erc4626RegistrySnapshot {
  readonly assets: ReadonlyArray<Erc4626WrapperAsset>;
  readonly excludedAssetCount: number;
  getByXStock(token: string): Erc4626WrapperAsset | undefined;
  getByWxStock(token: string): Erc4626WrapperAsset | undefined;
  getByHook(hook: string): Erc4626WrapperAsset | undefined;
  isWrapperHook(hook: string): boolean;
  /**
   * True for an identity belonging to an active or recently retired asset.
   * Used only to invalidate stale cached routes; routing admission stays active-only.
   */
  wasEverKnownIdentity(value: string): boolean;
  readonly hookCodeOverrides: Readonly<Record<string, string>>;
}

export interface Erc4626WrapperRegistrySource {
  getSnapshot(chainId: number, ctx?: Context): Promise<Erc4626RegistrySnapshot>;
}

export interface Erc4626WrapperRegistryConfig {
  enabled: boolean;
  chainIds: number[];
}

export function shouldMergeDynamicErc4626Assets(
  config: Erc4626WrapperRegistryConfig,
  mergeEnabled: boolean
): boolean {
  return config.enabled && mergeEnabled;
}

export interface Erc4626WrapperRegistryStaticData {
  getAssets(chainId: number): readonly Erc4626WrapperAsset[];
  getHookCodeOverrides(chainId: number): Record<string, string>;
  getHookBytecode?(chainId: number): string | undefined;
}

export interface Erc4626WrapperChainConfig {
  hookCodeOverrides: Record<string, string>;
  hookAddresses: ReadonlySet<string>;
}

export function filterValidErc4626Assets(
  assets: readonly Erc4626WrapperAsset[]
): {accepted: Erc4626WrapperAsset[]; excludedCount: number} {
  const normalizedAssets = assets.map(asset => ({
    ...asset,
    xStock: asset.xStock.toLowerCase(),
    wxStock: asset.wxStock.toLowerCase(),
    hookAddress: asset.hookAddress.toLowerCase(),
    poolId: asset.poolId.toLowerCase(),
  }));
  const uniqueAssets = Array.from(
    new Map(
      normalizedAssets.map(asset => [assetIdentityKey(asset), asset])
    ).values()
  );
  const identityCounts = new Map<string, number>();

  for (const asset of uniqueAssets) {
    for (const identity of assetIdentities(asset)) {
      increment(identityCounts, identity);
    }
  }

  const accepted = uniqueAssets.filter(asset =>
    assetIdentities(asset).every(identity => identityCounts.get(identity) === 1)
  );
  return {accepted, excludedCount: uniqueAssets.length - accepted.length};
}

class StaticErc4626RegistrySnapshot implements Erc4626RegistrySnapshot {
  public readonly assets: ReadonlyArray<Erc4626WrapperAsset>;
  public readonly excludedAssetCount: number;
  public readonly hookCodeOverrides: Readonly<Record<string, string>>;
  private readonly byXStock: ReadonlyMap<string, Erc4626WrapperAsset>;
  private readonly byWxStock: ReadonlyMap<string, Erc4626WrapperAsset>;
  private readonly byHook: ReadonlyMap<string, Erc4626WrapperAsset>;
  private readonly knownIdentities: ReadonlySet<string>;

  constructor(
    acceptedAssets: readonly Erc4626WrapperAsset[],
    excludedAssetCount: number,
    hookCodeOverrides: Record<string, string>,
    knownIdentities: ReadonlySet<string> = new Set()
  ) {
    const accepted = acceptedAssets.map(asset => Object.freeze(asset));
    this.excludedAssetCount = excludedAssetCount;
    this.assets = Object.freeze(accepted);
    this.byXStock = new Map(accepted.map(asset => [asset.xStock, asset]));
    this.byWxStock = new Map(accepted.map(asset => [asset.wxStock, asset]));
    this.byHook = new Map(accepted.map(asset => [asset.hookAddress, asset]));
    this.knownIdentities = new Set(
      [
        ...knownIdentities,
        ...accepted.flatMap(asset => assetIdentities(asset)),
      ].map(identity => identity.toLowerCase())
    );

    // Assets are lowercased above; normalize the incoming map too so callers
    // (e.g. dynamic registry sources) can't key it with checksummed addresses
    // and silently lose overrides — a lost override fail-closes the pool.
    const availableOverrides = Object.fromEntries(
      Object.entries(hookCodeOverrides).map(([hook, bytecode]) => [
        hook.toLowerCase(),
        bytecode,
      ])
    );
    const overrides: Record<string, string> = {};
    for (const asset of accepted) {
      const bytecode = availableOverrides[asset.hookAddress];
      if (bytecode !== undefined) overrides[asset.hookAddress] = bytecode;
    }
    this.hookCodeOverrides = Object.freeze(overrides);
    Object.freeze(this);
  }

  getByXStock(token: string): Erc4626WrapperAsset | undefined {
    return this.byXStock.get(token.toLowerCase());
  }

  getByWxStock(token: string): Erc4626WrapperAsset | undefined {
    return this.byWxStock.get(token.toLowerCase());
  }

  getByHook(hook: string): Erc4626WrapperAsset | undefined {
    return this.byHook.get(hook.toLowerCase());
  }

  isWrapperHook(hook: string): boolean {
    return this.byHook.has(hook.toLowerCase());
  }

  wasEverKnownIdentity(value: string): boolean {
    return this.knownIdentities.has(value.toLowerCase());
  }
}

function assetIdentities(asset: Erc4626WrapperAsset): readonly string[] {
  return [asset.xStock, asset.wxStock, asset.hookAddress, asset.poolId];
}

function assetIdentityKey(asset: Erc4626WrapperAsset): string {
  return assetIdentities(asset).join(':');
}

function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

export const EMPTY_ERC4626_SNAPSHOT: Erc4626RegistrySnapshot =
  new StaticErc4626RegistrySnapshot([], 0, {});

/** Creates an immutable, indexed snapshot shared by static and dynamic sources. */
export function createErc4626RegistrySnapshot(
  assets: readonly Erc4626WrapperAsset[],
  excludedAssetCount: number,
  hookCodeOverrides: Record<string, string> = {},
  knownIdentities: ReadonlySet<string> = new Set()
): Erc4626RegistrySnapshot {
  return new StaticErc4626RegistrySnapshot(
    assets,
    excludedAssetCount,
    hookCodeOverrides,
    knownIdentities
  );
}

const sharedConfigData: Erc4626WrapperRegistryStaticData = {
  getAssets: getErc4626WrapperAssets,
  getHookCodeOverrides: getErc4626HookCodeOverrides,
  getHookBytecode: getErc4626RoutingHookBytecode,
};

export function buildErc4626HookCodeOverrides(
  chainId: number,
  assets: readonly Erc4626WrapperAsset[],
  data: Erc4626WrapperRegistryStaticData = sharedConfigData
): Record<string, string> {
  const bytecode =
    data.getHookBytecode?.(chainId) ??
    Object.values(data.getHookCodeOverrides(chainId))[0];
  if (bytecode === undefined) return {};
  return Object.fromEntries(
    assets.map(asset => [asset.hookAddress.toLowerCase(), bytecode])
  );
}

/** Computes the configured, conflict-free wrapper hooks for one chain. */
export function computeErc4626WrapperChainConfig(
  chainId: number,
  config: Erc4626WrapperRegistryConfig,
  data: Erc4626WrapperRegistryStaticData = sharedConfigData
): Erc4626WrapperChainConfig {
  if (!config.enabled || !config.chainIds.includes(chainId)) {
    return {hookCodeOverrides: {}, hookAddresses: new Set()};
  }

  const {accepted} = filterValidErc4626Assets(data.getAssets(chainId));
  const hookCodeOverrides = buildErc4626HookCodeOverrides(
    chainId,
    accepted,
    data
  );
  const hookAddresses = new Set<string>();

  for (const asset of accepted) {
    hookAddresses.add(asset.hookAddress);
  }

  return {hookCodeOverrides, hookAddresses};
}

/** Static shared-config source; later sources can union into its snapshots. */
export class StaticErc4626WrapperRegistry
  implements Erc4626WrapperRegistrySource
{
  private readonly snapshots = new Map<number, Erc4626RegistrySnapshot>();

  constructor(
    private readonly config: Erc4626WrapperRegistryConfig,
    private readonly data: Erc4626WrapperRegistryStaticData = sharedConfigData
  ) {}

  async getSnapshot(
    chainId: number,
    _ctx?: Context
  ): Promise<Erc4626RegistrySnapshot> {
    if (!this.isChainInScope(chainId)) {
      return EMPTY_ERC4626_SNAPSHOT;
    }

    const cached = this.snapshots.get(chainId);
    if (cached) return cached;

    const filtered = filterValidErc4626Assets(this.data.getAssets(chainId));
    const hookCodeOverrides = this.getHookCodeOverridesForAssets(
      chainId,
      filtered.accepted
    );

    const snapshot = createErc4626RegistrySnapshot(
      filtered.accepted,
      filtered.excludedCount,
      hookCodeOverrides
    );
    this.snapshots.set(chainId, snapshot);
    return snapshot;
  }

  getHookCodeOverridesForAssets(
    chainId: number,
    assets: readonly Erc4626WrapperAsset[]
  ): Record<string, string> {
    if (!this.isChainInScope(chainId)) {
      return {};
    }
    return buildErc4626HookCodeOverrides(chainId, assets, this.data);
  }

  /** True iff routing is enabled and this chain is in the configured scope. */
  isChainInScope(chainId: number): boolean {
    return this.config.enabled && this.config.chainIds.includes(chainId);
  }
}

export function erc4626WrapperConfigFromEnv(): Erc4626WrapperRegistryConfig {
  const rawChainIds = process.env.XSTOCKS_CHAIN_IDS;
  return {
    enabled: process.env.XSTOCKS_ROUTING_ENABLED === 'true',
    chainIds:
      rawChainIds === undefined || rawChainIds.trim() === ''
        ? []
        : parseChainIds(rawChainIds),
  };
}

function parseChainIds(raw: string): number[] {
  const chainIds = raw.split(',').map(value => value.trim());
  if (
    chainIds.some(chainId => !/^\d+$/.test(chainId) || Number(chainId) <= 0)
  ) {
    return [];
  }
  return [...new Set(chainIds.map(Number))];
}
