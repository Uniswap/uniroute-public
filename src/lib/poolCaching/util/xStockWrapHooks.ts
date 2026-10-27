// xStock (Monad) ERC-4626 vault wrap hooks — one hook per vault, one per
// ticker. These are the real wrap/unwrap pool hooks (the "Hook" column of the
// xStocks-Monad address sheet), NOT the quote-only "routing hook" twins, which
// we deliberately do not allowlist.
//
// `hooksAddressesAllowlist.ts` pulls this list into both
// `HOOKS_ADDRESSES_ALLOWLIST` and `ZLCA_HOOKS_PER_CHAIN` (keyed with the shared
// `XSTOCK_VAULT_WRAP_ZLCA_CONFIG`). Add later waves by appending here — the
// addresses flow into the allowlist + ZLCA automatically. Addresses are
// lowercased; the allowlist/ZLCA lookups are case-insensitive.

export interface XStockWrapHook {
  /** Wrapped-stock ticker, e.g. "SPYx". */
  symbol: string;
  /** The wrap hook address on Monad (lowercased). */
  hook: string;
}

// Wave 1.
export const XSTOCK_WRAP_HOOKS_ON_MONAD: readonly XStockWrapHook[] = [
  {symbol: 'EWYx', hook: '0x882acfceba2724a01da07b7c691d13fbb171a888'},
  {symbol: 'MUx', hook: '0xea16647fc1681a16ca38c01a48af072db6f5e888'},
  {symbol: 'NVDAx', hook: '0xac0ea29430f8adee4e3d654efdf1ed346270e888'},
  {symbol: 'QQQx', hook: '0x288064a3b5225e37228e355d422cbaa634be2888'},
  {symbol: 'SGOVx', hook: '0x68196453c7e0a66cbba9b4c1490b88b6acb72888'},
  {symbol: 'SKHYx', hook: '0x84a87e5408e4c012e59b77e68bf8b5259f11a888'},
  {symbol: 'SMHx', hook: '0x2e11384ab31389c66818eb9a4a71c9bacba76888'},
  {symbol: 'SPCXx', hook: '0x456cc230ff01bd407cf494a55682f4cfb4ce2888'},
  {symbol: 'SPYx', hook: '0xcb1baa4592cb90bd2fe3ca540abe95983168a888'},
  {symbol: 'TSLAx', hook: '0x54de9022ffafbe2ff7074f6de4d46831bdffa888'},
];

/** Flat lowercased hook-address list, for the allowlist + ZLCA builders. */
export const XSTOCK_WRAP_HOOK_ADDRESSES_ON_MONAD: readonly string[] =
  XSTOCK_WRAP_HOOKS_ON_MONAD.map(h => h.hook);
