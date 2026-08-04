import {
  Erc4626WrapperAsset,
  getErc4626HookCodeOverrides,
  getErc4626WrapperAssets,
} from '@uniswap/lib-sharedconfig/erc4626WrapperHooks';

export interface Erc4626RegistrySnapshot {
  readonly assets: ReadonlyArray<Erc4626WrapperAsset>;
  readonly excludedAssetCount: number;
  getByXStock(token: string): Erc4626WrapperAsset | undefined;
  getByWxStock(token: string): Erc4626WrapperAsset | undefined;
  getByHook(hook: string): Erc4626WrapperAsset | undefined;
  isWrapperHook(hook: string): boolean;
  readonly hookCodeOverrides: Readonly<Record<string, string>>;
}

export interface Erc4626WrapperRegistrySource {
  getSnapshot(chainId: number): Promise<Erc4626RegistrySnapshot>;
}

export interface Erc4626WrapperRegistryConfig {
  enabled: boolean;
  chainIds: number[];
}

export interface Erc4626WrapperRegistryStaticData {
  getAssets(chainId: number): readonly Erc4626WrapperAsset[];
  getHookCodeOverrides(chainId: number): Record<string, string>;
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
  const identityCounts = new Map<string, number>();

  for (const asset of normalizedAssets) {
    for (const identity of assetIdentities(asset)) {
      increment(identityCounts, identity);
    }
  }

  const accepted = normalizedAssets.filter(asset =>
    assetIdentities(asset).every(identity => identityCounts.get(identity) === 1)
  );
  return {accepted, excludedCount: normalizedAssets.length - accepted.length};
}

class StaticErc4626RegistrySnapshot implements Erc4626RegistrySnapshot {
  public readonly assets: ReadonlyArray<Erc4626WrapperAsset>;
  public readonly excludedAssetCount: number;
  public readonly hookCodeOverrides: Readonly<Record<string, string>>;
  private readonly byXStock: ReadonlyMap<string, Erc4626WrapperAsset>;
  private readonly byWxStock: ReadonlyMap<string, Erc4626WrapperAsset>;
  private readonly byHook: ReadonlyMap<string, Erc4626WrapperAsset>;

  constructor(
    assets: readonly Erc4626WrapperAsset[],
    hookCodeOverrides: Record<string, string>
  ) {
    const filtered = filterValidErc4626Assets(assets);
    const accepted = filtered.accepted.map(asset => Object.freeze(asset));
    this.excludedAssetCount = filtered.excludedCount;
    this.assets = Object.freeze(accepted);
    this.byXStock = new Map(accepted.map(asset => [asset.xStock, asset]));
    this.byWxStock = new Map(accepted.map(asset => [asset.wxStock, asset]));
    this.byHook = new Map(accepted.map(asset => [asset.hookAddress, asset]));

    const overrides: Record<string, string> = {};
    for (const asset of accepted) {
      const bytecode = hookCodeOverrides[asset.hookAddress];
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
}

function assetIdentities(asset: Erc4626WrapperAsset): readonly string[] {
  return [asset.xStock, asset.wxStock, asset.hookAddress, asset.poolId];
}

function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

export const EMPTY_ERC4626_SNAPSHOT: Erc4626RegistrySnapshot =
  new StaticErc4626RegistrySnapshot([], {});

const sharedConfigData: Erc4626WrapperRegistryStaticData = {
  getAssets: getErc4626WrapperAssets,
  getHookCodeOverrides: getErc4626HookCodeOverrides,
};

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
  const availableOverrides = normalizeOverrides(
    data.getHookCodeOverrides(chainId)
  );
  const hookCodeOverrides: Record<string, string> = {};
  const hookAddresses = new Set<string>();

  for (const asset of accepted) {
    hookAddresses.add(asset.hookAddress);
    const bytecode = availableOverrides[asset.hookAddress];
    if (bytecode !== undefined) {
      hookCodeOverrides[asset.hookAddress] = bytecode;
    }
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

  async getSnapshot(chainId: number): Promise<Erc4626RegistrySnapshot> {
    const chainConfig = computeErc4626WrapperChainConfig(
      chainId,
      this.config,
      this.data
    );
    if (!this.config.enabled || !this.config.chainIds.includes(chainId)) {
      return EMPTY_ERC4626_SNAPSHOT;
    }

    const cached = this.snapshots.get(chainId);
    if (cached) return cached;

    const snapshot = new StaticErc4626RegistrySnapshot(
      this.data.getAssets(chainId),
      chainConfig.hookCodeOverrides
    );
    this.snapshots.set(chainId, snapshot);
    return snapshot;
  }
}

function normalizeOverrides(
  overrides: Record<string, string>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(overrides).map(([hook, bytecode]) => [
      hook.toLowerCase(),
      bytecode,
    ])
  );
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
