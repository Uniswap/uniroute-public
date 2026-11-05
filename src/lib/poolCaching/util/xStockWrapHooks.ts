// xStock (Monad) ERC-4626 vault wrap hooks — one hook per vault, one per
// ticker. These are the real wrap/unwrap pool hooks (the "Hook" column of the
// xStocks-Monad address sheet).
//
// `hooksAddressesAllowlist.ts` pulls this list into both
// `HOOKS_ADDRESSES_ALLOWLIST` and `ZLCA_HOOKS_PER_CHAIN` (keyed with the shared
// `XSTOCK_VAULT_WRAP_ZLCA_CONFIG`). Add later waves by appending here — the
// addresses flow into the allowlist + ZLCA automatically. Addresses are
// lowercased; the allowlist/ZLCA lookups are case-insensitive.

// Storage slots of the `balanceOf` mappings, read from the deployed tokens:
// every xStock token keeps balances at slot 263 and every wrapper vault at
// slot 101. Quotes fund the PoolManager through these slots.
export const XSTOCK_BALANCE_SLOT = 263n;
export const XSTOCK_VAULT_BALANCE_SLOT = 101n;

export interface XStockWrapHook {
  /** Wrapped-stock ticker, e.g. "SPYx". */
  symbol: string;
  /** The wrap hook address on Monad (lowercased). */
  hook: string;
  /** The xStock token the hook wraps, the hook's `underlyingCurrency` (lowercased). */
  underlying: string;
  /** The ERC-4626 vault share token, the hook's `wrapperCurrency` (lowercased). */
  wrapper: string;
}

// Wave 1.
export const XSTOCK_WRAP_HOOKS_ON_MONAD: readonly XStockWrapHook[] = [
  {
    symbol: 'EWYx',
    hook: '0x882acfceba2724a01da07b7c691d13fbb171a888',
    underlying: '0x299c95eb52bfd5bc98d924bce17197b64864589b',
    wrapper: '0x021b40617982074748c81a19d22046cc2548c3be',
  },
  {
    symbol: 'MUx',
    hook: '0xea16647fc1681a16ca38c01a48af072db6f5e888',
    underlying: '0xf6a873bae4ba1b304e45df52a4b7d176e1c6a8c4',
    wrapper: '0xe2047ee3bddb5c99ae428ab83df63f8730698e30',
  },
  {
    symbol: 'NVDAx',
    hook: '0xac0ea29430f8adee4e3d654efdf1ed346270e888',
    underlying: '0xc845b2894dbddd03858fd2d643b4ef725fe0849d',
    wrapper: '0xa8ddb5cd96b5222afe198316e9a57caa642850d5',
  },
  {
    symbol: 'QQQx',
    hook: '0x288064a3b5225e37228e355d422cbaa634be2888',
    underlying: '0xa753a7395cae905cd615da0b82a53e0560f250af',
    wrapper: '0x4c1ae29c159838fc1b224636e28e086eb69101f7',
  },
  {
    symbol: 'SGOVx',
    hook: '0x68196453c7e0a66cbba9b4c1490b88b6acb72888',
    underlying: '0x2dafa4732c8c1b25701a33b05f10f437f9599326',
    wrapper: '0x4ac39e0881e5967822cce9d166d1b7ac12402ba1',
  },
  {
    symbol: 'SKHYx',
    hook: '0x84a87e5408e4c012e59b77e68bf8b5259f11a888',
    underlying: '0x58100046a4afcd4ee4fadbd4244f3f895a341c56',
    wrapper: '0x6215a58ed045d71f2561aaabe54f4c885c522998',
  },
  {
    symbol: 'SMHx',
    hook: '0x2e11384ab31389c66818eb9a4a71c9bacba76888',
    underlying: '0x8d512a03600981b8e86556fd5c0fbdd726fe1821',
    wrapper: '0x23c4bddea5e7e284fb4027c6050bc5e6f7fae23f',
  },
  {
    symbol: 'SPCXx',
    hook: '0x456cc230ff01bd407cf494a55682f4cfb4ce2888',
    underlying: '0x68fa48b1c2fe52b3d776e1953e0e782b5044ce28',
    wrapper: '0x8e2eed8b8b5e13ea7bf38e50d7821d2c57309072',
  },
  {
    symbol: 'SPYx',
    hook: '0xcb1baa4592cb90bd2fe3ca540abe95983168a888',
    underlying: '0x90a2a4c76b5d8c0bc892a69ea28aa775a8f2dd48',
    wrapper: '0xe7e553cd128f0011777323a0b44a7b96ea1cb540',
  },
  {
    symbol: 'TSLAx',
    hook: '0x54de9022ffafbe2ff7074f6de4d46831bdffa888',
    underlying: '0x8ad3c73f833d3f9a523ab01476625f269aeb7cf0',
    wrapper: '0xc3fdbe3a68ee5de461d30415a8165cf9aefe1171',
  },
];

/** Flat lowercased hook-address list, for the allowlist + ZLCA builders. */
export const XSTOCK_WRAP_HOOK_ADDRESSES_ON_MONAD: readonly string[] =
  XSTOCK_WRAP_HOOKS_ON_MONAD.map(h => h.hook);
