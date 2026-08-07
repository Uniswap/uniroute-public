import {Erc4626WrapperAsset} from '@uniswap/lib-sharedconfig/erc4626WrapperHooks';
import {Context} from '@uniswap/lib-uni/context';
import {
  createErc4626RegistrySnapshot,
  Erc4626RegistrySnapshot,
  Erc4626WrapperRegistrySource,
  filterValidErc4626Assets,
  StaticErc4626WrapperRegistry,
} from './Erc4626WrapperRegistry';
import {DynamicErc4626WrapperRegistry} from './DynamicErc4626WrapperRegistry';

/** Combines audited static assets with S3-synced assets behind one source. */
export class UnionErc4626WrapperRegistry
  implements Erc4626WrapperRegistrySource
{
  constructor(
    private readonly staticSource: StaticErc4626WrapperRegistry,
    private readonly dynamicSource: DynamicErc4626WrapperRegistry,
    private readonly dynamicEnabled: boolean
  ) {}

  async getSnapshot(
    chainId: number,
    ctx?: Context
  ): Promise<Erc4626RegistrySnapshot> {
    const staticSnapshot = await this.staticSource.getSnapshot(chainId, ctx);
    // A chain outside the configured routing scope must be a complete
    // no-op, same as the static-only case -- never merge dynamic assets
    // for a chain routing itself hasn't been enabled for.
    if (!this.dynamicEnabled || !this.staticSource.isChainInScope(chainId)) {
      return staticSnapshot;
    }
    const [dynamicAssets, dynamicKnownIdentities] = await Promise.all([
      this.dynamicSource.getActiveAssets(chainId, ctx),
      this.dynamicSource.getKnownIdentities(chainId, ctx),
    ]);
    const knownIdentities = new Set([
      ...dynamicKnownIdentities,
      ...staticSnapshot.assets.flatMap(asset => [
        asset.xStock,
        asset.wxStock,
        asset.hookAddress,
        asset.poolId,
      ]),
    ]);
    const filtered = filterValidErc4626Assets([
      ...staticSnapshot.assets,
      ...(dynamicAssets as Erc4626WrapperAsset[]),
    ]);
    return createErc4626RegistrySnapshot(
      filtered.accepted,
      staticSnapshot.excludedAssetCount + filtered.excludedCount,
      this.staticSource.getHookCodeOverridesForAssets(
        chainId,
        filtered.accepted
      ),
      knownIdentities
    );
  }
}
