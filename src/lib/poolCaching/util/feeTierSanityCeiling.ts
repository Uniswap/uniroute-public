import {DYNAMIC_FEE_FLAG} from '@uniswap/v4-sdk';

// V4 permits any static LP fee up to LPFeeLibrary.MAX_LP_FEE (1,000,000 ppm =
// 100%), with or without a hook, and permissionless pool creation means
// nothing on-chain stops a fee tier that is orders of magnitude above any
// real trading fee. v3's highest enabled tier tops out at 10000 (1%,
// FeeAmount.HIGH). A pool above this ceiling is routable-but-destructive
// (quotes a user 90%+ of their input) rather than a genuine high-fee market,
// so it is excluded from candidate routes regardless of hook status.
export const MAX_REASONABLE_V4_FEE_TIER_PPM = 110000; // 11%

export function isStaticFeeWithinSanityCeiling(fee: number): boolean {
  // DYNAMIC_FEE_FLAG is a sentinel bit marking "fee set by the hook at swap
  // time", not a fee amount.
  if (fee === DYNAMIC_FEE_FLAG) return true;
  return fee <= MAX_REASONABLE_V4_FEE_TIER_PPM;
}
