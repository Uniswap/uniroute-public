/**
 * Allocation-light V4 pool id derivation for bulk verification.
 *
 * `poolId = keccak256(abi.encode(currency0, currency1, fee, tickSpacing,
 * hooks))` with the currencies in ascending address order. The v4-sdk's
 * `Pool.getPoolId` computes the same value, but on the way it constructs two
 * sdk-core `Token`s (each an EIP-55 `getAddress` keccak) and runs the ethers
 * ABI coder, whose address coder re-checksums every address (three more
 * keccaks), before the final hash: six keccaks and a pile of allocations per
 * call. The pool-caching cron verifies millions of rows per run, and that
 * per-row cost was the bulk of its build time. This writes the 160-byte ABI
 * encoding by hand and hashes once.
 *
 * Inputs are the already-lowercased address strings the registry build
 * works with; anything else is rejected rather than normalized, because the
 * caller's lowercase-and-compare is what makes a mismatch mean "corrupt
 * row" and not "casing". `v4PoolIdFast.test.ts` pins equivalence with the
 * SDK across the input space.
 */

import {utils} from 'ethers';

const LOWERCASE_ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const UINT24_MAX = 0xff_ff_ff;
const INT24_MIN = -0x80_00_00;
const INT24_MAX = 0x7f_ff_ff;
const WORD_BYTES = 32;
const ADDRESS_BYTES = 20;
const ENCODED_POOL_KEY_BYTES = 5 * WORD_BYTES;

function isLowercaseAddress(value: string): boolean {
  return LOWERCASE_ADDRESS_PATTERN.test(value);
}

function writeAddressWord(
  buffer: Buffer,
  wordIndex: number,
  address: string
): void {
  buffer.write(
    address.slice(2),
    wordIndex * WORD_BYTES + (WORD_BYTES - ADDRESS_BYTES),
    ADDRESS_BYTES,
    'hex'
  );
}

/**
 * Pool id for the PoolKey, or `undefined` when an input is outside the
 * PoolKey domain (malformed or non-lowercase address, fee outside uint24,
 * tickSpacing outside int24, identical currencies). The SDK throws in
 * exactly those cases; callers that treated a throw as "cannot verify" treat
 * `undefined` the same way.
 */
export function computeV4PoolId(
  currencyA: string,
  currencyB: string,
  fee: number,
  tickSpacing: number,
  hooks: string
): string | undefined {
  if (
    !isLowercaseAddress(currencyA) ||
    !isLowercaseAddress(currencyB) ||
    !isLowercaseAddress(hooks) ||
    currencyA === currencyB ||
    !Number.isInteger(fee) ||
    fee < 0 ||
    fee > UINT24_MAX ||
    !Number.isInteger(tickSpacing) ||
    tickSpacing < INT24_MIN ||
    tickSpacing > INT24_MAX
  ) {
    return undefined;
  }
  // Lowercase lexical order equals numeric order for equal-length hex, and
  // the native currency (the zero address) is the smallest value, so this
  // is the SDK's sortsBefore without the Currency objects.
  const [currency0, currency1] =
    currencyA < currencyB ? [currencyA, currencyB] : [currencyB, currencyA];

  const encoded = Buffer.alloc(ENCODED_POOL_KEY_BYTES);
  writeAddressWord(encoded, 0, currency0);
  writeAddressWord(encoded, 1, currency1);
  encoded.writeUIntBE(fee, 3 * WORD_BYTES - 3, 3);
  if (tickSpacing < 0) {
    // int24 sign extension across the 32-byte word.
    encoded.fill(0xff, 3 * WORD_BYTES, 4 * WORD_BYTES);
  }
  encoded.writeUIntBE(tickSpacing & UINT24_MAX, 4 * WORD_BYTES - 3, 3);
  writeAddressWord(encoded, 4, hooks);
  return utils.keccak256(encoded);
}
