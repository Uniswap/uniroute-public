import {ChainId} from '@uniswap/sdk-core';

// TEMPO is not yet in sdk-core 7.11.0 — define locally until sdk-core is upgraded
const CHAIN_ID_TEMPO = 4217 as ChainId;

// THBT (TrueMoney Baht) hook on Base. Auto-routes because its address flags
// (0x0ac0) carry no custom-accounting / returns-delta bits, but the contract
// does off-book PoolManager settlement via its own unlockCallback, guarded by a
// reentrancy lock that is not scoped for the hook being called on two hops of a
// single route. A multi-hop route that touches this hook twice reverts on the
// second beforeSwap with HookCallFailed() (empty-returndata revert from the
// guard) — observed in a sim at Base block 50437751 (~2026-08-25) on an
// EURC/cbBTC route. Deny until the hook is fixed and re-reviewed.
export const THBT_HOOK_ON_BASE = '0xf0930639457a2e64b4fa08fabe055b8dc840cac0';

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
  [ChainId.BASE]: [THBT_HOOK_ON_BASE],
  [ChainId.UNICHAIN]: [],
  [ChainId.MONAD]: [],
  [ChainId.XLAYER]: [],
  [CHAIN_ID_TEMPO]: [],
};
