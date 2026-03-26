import {ChainId} from '@uniswap/sdk-core';

// TEMPO is not yet in sdk-core 7.11.0 — define locally until sdk-core is upgraded
const CHAIN_ID_TEMPO = 4217 as ChainId;

// Manual per-chain denylist for hooks that should never be routed through.
// Keep only chains that currently have explicit allowlisted hooks.
export const HOOKS_ADDRESSES_DENYLIST: Partial<Record<ChainId, Array<string>>> &
  Record<number, Array<string>> = {
  [ChainId.MAINNET]: [],
  [ChainId.SEPOLIA]: [],
  [ChainId.OPTIMISM]: [],
  [ChainId.ARBITRUM_ONE]: [],
  [ChainId.POLYGON]: [],
  [ChainId.BNB]: [],
  [ChainId.AVALANCHE]: [],
  [ChainId.BASE]: [],
  [ChainId.UNICHAIN]: [],
  [ChainId.MONAD]: [],
  [ChainId.XLAYER]: [],
  [CHAIN_ID_TEMPO]: [],
};
