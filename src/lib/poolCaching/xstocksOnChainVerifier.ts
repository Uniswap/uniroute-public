import {JsonRpcProvider} from '@ethersproject/providers';
import {BigNumber} from '@ethersproject/bignumber';
import {Contract, utils} from 'ethers';
import {UniswapV4StateView__factory} from '../../../abis/src/generated/contracts';
import {Chain} from '../../models/chain/Chain';
import {Address} from '../../models/address/Address';
import {V4Pool} from '../../models/pool/V4Pool';
import type {XStocksAssetEntry} from './xstocksAssetsRegistry';

const ERC4626_ASSET_ABI = ['function asset() view returns (address)'];

export interface XStocksOnChainVerifierDeps {
  getChain(chainId: number): Chain | undefined | Promise<Chain | undefined>;
  getProvider(chainId: number): JsonRpcProvider | undefined;
  /**
   * keccak256 of the deployed ERC4626WrapperHook runtime bytecode, per chain
   * (wrapper hooks are uniform per-vault deployments of one implementation).
   * A chain with no configured codehash fails verification for every entry.
   */
  expectedHookCodehashByChain?: Readonly<Record<number, string>>;
  readVaultAsset?: (
    wxStock: string,
    provider: JsonRpcProvider
  ) => Promise<string>;
  readHookCodehash?: (
    hookAddress: string,
    provider: JsonRpcProvider
  ) => Promise<string>;
  getPoolSqrtPriceX96?: (
    poolId: string,
    stateViewAddress: string,
    provider: JsonRpcProvider
  ) => Promise<bigint>;
}

export function computeXStocksPoolId(entry: XStocksAssetEntry): string {
  return V4Pool.computePoolId(
    new Address(entry.xStock),
    new Address(entry.wxStock),
    Number(entry.feeTier),
    Number(entry.tickSpacing),
    entry.hookAddress
  );
}

/** Verifies the API claim against the canonical ERC-4626 vault and V4 state. */
export async function verifyXStocksAssetOnChain(
  chainId: number,
  entry: XStocksAssetEntry,
  deps: XStocksOnChainVerifierDeps
): Promise<boolean> {
  const chain = await deps.getChain(chainId);
  const provider = deps.getProvider(chainId);
  if (!chain?.v4StateViewLibraryAddress || !provider) return false;

  if (
    computeXStocksPoolId(entry).toLowerCase() !== entry.poolId.toLowerCase()
  ) {
    return false;
  }

  // The quote path deliberately replaces the hook's code with the trusted
  // RoutingHook bytecode, so quoting can never expose a hostile hook — which
  // makes the API claim the only other trust anchor for the code that
  // EXECUTES user swaps. Pin the hook to the per-chain expected codehash so
  // verification covers that component too. Fail closed: no configured
  // codehash for the chain (or no code at the address) rejects the entry.
  const expectedCodehash = deps.expectedHookCodehashByChain?.[chainId];
  if (!expectedCodehash) return false;
  const codehash = deps.readHookCodehash
    ? await deps.readHookCodehash(entry.hookAddress, provider)
    : utils.keccak256(await provider.getCode(entry.hookAddress));
  if (codehash.toLowerCase() !== expectedCodehash.toLowerCase()) return false;

  const asset = deps.readVaultAsset
    ? await deps.readVaultAsset(entry.wxStock, provider)
    : ((await new Contract(
        entry.wxStock,
        ERC4626_ASSET_ABI,
        provider
      ).asset()) as string);
  if (asset.toLowerCase() !== entry.xStock.toLowerCase()) return false;

  const sqrtPriceX96 = deps.getPoolSqrtPriceX96
    ? await deps.getPoolSqrtPriceX96(
        entry.poolId,
        chain.v4StateViewLibraryAddress.address,
        provider
      )
    : ((
        await UniswapV4StateView__factory.connect(
          chain.v4StateViewLibraryAddress.address,
          provider
        ).getSlot0(entry.poolId)
      )[0] as BigNumber);
  return typeof sqrtPriceX96 === 'bigint'
    ? sqrtPriceX96 !== 0n
    : sqrtPriceX96.toBigInt() !== 0n;
}
