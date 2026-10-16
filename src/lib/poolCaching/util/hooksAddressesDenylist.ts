import {ChainId} from '@uniswap/sdk-core';

// TEMPO is not yet in sdk-core 7.11.0 — define locally until sdk-core is upgraded
const CHAIN_ID_TEMPO = 4217 as ChainId;

// THBT (TrueMoney Baht) hook on Base. Its address flags (0x0ac0) carry swap
// callbacks, so it is not routable without an allowlist entry; this entry
// keeps it un-routable against a future allowlist edit. The contract does off-book PoolManager
// settlement via its own unlockCallback, guarded by a reentrancy lock that is
// not scoped for the hook being called on two hops of a single route. A multi-hop route that touches this hook twice reverts on the
// second beforeSwap with HookCallFailed() (empty-returndata revert from the
// guard) — observed in a sim at Base block 50437751 (~2026-08-25) on an
// EURC/cbBTC route. Deny until the hook is fixed and re-reviewed.
export const THBT_HOOK_ON_BASE = '0xf0930639457a2e64b4fa08fabe055b8dc840cac0';

// Spiral Hook on Ethereum. Known critical vulnerability (operator directive) —
// must never be routed through. Its address flags (0x2acc) carry the swap-delta
// bits, so it does not auto-route and simply omitting it from the allowlist keeps
// it un-routable; this denylist entry is defence-in-depth against a future
// allowlist edit re-introducing it. Deployed on Ethereum only.
export const SPIRAL_HOOK_ON_MAINNET =
  '0x1725577dc9b1ee2d95db49c2193226471594aacc';

// Quoter-exempt hooks: one contract and a later revision of it, deployed on
// several chains by a single operator
// (0x35f3e17c7b21389520fb55114886e534b5ceb112), which creates every pool
// itself. Each one's address flags (0x2ac0) carry swap callbacks, so it is
// not routable without an allowlist entry; this entry keeps it un-routable
// against a future allowlist edit. The contract keeps a storage-mapped exemption for the
// quoter contracts: quotes price clean while Universal Router swaps take a
// haircut keyed on tx.origin and amount (~2.5-2.8% measured on Robinhood).
// Every quote through these hooks overstates the executable output, so they
// must never be routed through. Listed by hook, not pool, because the
// operator keeps adding pools.
export const QUOTER_EXEMPT_HOOKS_ON_ROBINHOOD = [
  '0xa735d365630987d86789d5aefbd91b244a7feac0',
  '0x8e21aff7115d3a91259897db144db7fe841d6ac0',
];
export const QUOTER_EXEMPT_HOOKS_ON_BASE = [
  '0x2940c82a3be9ebf56946c488348bd3a413486ac0',
  '0xff7aaf1e66bf9f5ac479464c9643162e915ceac0',
  '0xc6340a6e50a2c233e175c9b27ed8eea4e0196ac0',
];
export const QUOTER_EXEMPT_HOOKS_ON_MAINNET = [
  '0xdc766448ff29b8cd12ae12d8252762d93ecd2ac0',
];

// Manual per-chain denylist for hooks that should never be routed through.
// Keep only chains that currently have explicit allowlisted hooks.
export const HOOKS_ADDRESSES_DENYLIST: Partial<Record<ChainId, Array<string>>> &
  Record<number, Array<string>> = {
  [ChainId.MAINNET]: [
    SPIRAL_HOOK_ON_MAINNET,
    ...QUOTER_EXEMPT_HOOKS_ON_MAINNET,
  ],
  [ChainId.SEPOLIA]: [],
  [ChainId.OPTIMISM]: [],
  [ChainId.ARBITRUM_ONE]: [],
  [ChainId.POLYGON]: [],
  [ChainId.BNB]: [],
  [ChainId.AVALANCHE]: [],
  [ChainId.BASE]: [THBT_HOOK_ON_BASE, ...QUOTER_EXEMPT_HOOKS_ON_BASE],
  [ChainId.UNICHAIN]: [],
  [ChainId.MONAD]: [],
  [ChainId.XLAYER]: [],
  [ChainId.ROBINHOOD]: [...QUOTER_EXEMPT_HOOKS_ON_ROBINHOOD],
  [CHAIN_ID_TEMPO]: [],
};
