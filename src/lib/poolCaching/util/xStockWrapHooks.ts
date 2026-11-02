// xStock (Monad) ERC-4626 vault wrap hooks — one hook per vault, one per
// ticker. These are the real wrap/unwrap pool hooks (the "Hook" column of the
// xStocks-Monad address sheet), NOT the quote-only "routing hook" twins, which
// we deliberately do not allowlist. A twin is used only as the quote-time code
// of its wrap hook (`ZlcaHookConfig.quoteTwinHook`); routes, simulation and
// calldata always go through the wrap hook itself.
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
  /** The hook's ERC4626RoutingHook twin on Monad (lowercased). */
  quoteTwinHook: string;
}

// Wave 1.
export const XSTOCK_WRAP_HOOKS_ON_MONAD: readonly XStockWrapHook[] = [
  {
    symbol: 'EWYx',
    hook: '0x882acfceba2724a01da07b7c691d13fbb171a888',
    quoteTwinHook: '0x451f5726aa816e286fbf0e3d5e22717f85842888',
  },
  {
    symbol: 'MUx',
    hook: '0xea16647fc1681a16ca38c01a48af072db6f5e888',
    quoteTwinHook: '0xcdbef2b7df067aa07b4d1a61eb6baf45eb0e2888',
  },
  {
    symbol: 'NVDAx',
    hook: '0xac0ea29430f8adee4e3d654efdf1ed346270e888',
    quoteTwinHook: '0xf8fcb204e672301312f462c28e4cd1dcd2b8e888',
  },
  {
    symbol: 'QQQx',
    hook: '0x288064a3b5225e37228e355d422cbaa634be2888',
    quoteTwinHook: '0xd08eaa0113cb1b3d00d9e328bb0b670b80eda888',
  },
  {
    symbol: 'SGOVx',
    hook: '0x68196453c7e0a66cbba9b4c1490b88b6acb72888',
    quoteTwinHook: '0xbc1d544f56952d4bc4197bb7402411a63f526888',
  },
  {
    symbol: 'SKHYx',
    hook: '0x84a87e5408e4c012e59b77e68bf8b5259f11a888',
    quoteTwinHook: '0xf852ac0e8fe0a70922250f40e1fd9fd3347f6888',
  },
  {
    symbol: 'SMHx',
    hook: '0x2e11384ab31389c66818eb9a4a71c9bacba76888',
    quoteTwinHook: '0xcce1300d273951c6247131335028bf4a83016888',
  },
  {
    symbol: 'SPCXx',
    hook: '0x456cc230ff01bd407cf494a55682f4cfb4ce2888',
    quoteTwinHook: '0x8b032fce4f32afeeb9abd281c7ec2922ac83e888',
  },
  {
    symbol: 'SPYx',
    hook: '0xcb1baa4592cb90bd2fe3ca540abe95983168a888',
    quoteTwinHook: '0x949c7cf1eaee75e4d5e0770dcbcb763179992888',
  },
  {
    symbol: 'TSLAx',
    hook: '0x54de9022ffafbe2ff7074f6de4d46831bdffa888',
    quoteTwinHook: '0xa6e63341e2c5cbea5b33370557ae42c54e9be888',
  },
];

/** Flat lowercased hook-address list, for the allowlist + ZLCA builders. */
export const XSTOCK_WRAP_HOOK_ADDRESSES_ON_MONAD: readonly string[] =
  XSTOCK_WRAP_HOOKS_ON_MONAD.map(h => h.hook);
