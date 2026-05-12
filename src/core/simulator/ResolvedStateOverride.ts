/**
 * Post-resolver shape: one entry per overridden account/contract. Each
 * field maps directly to a Geth-style state-override field; per-backend
 * translators serialize as appropriate (eth_simulateV1 `stateOverrides`,
 * Tenderly Sim API `state_objects`, Tenderly Node bundle-level overrides).
 */
export interface ResolvedStateOverride {
  contractAddress: string;
  // 32-byte hex slot -> 32-byte hex value (overlay, not full replacement).
  stateDiff?: Map<string, string>;
  // Optional bytecode replacement (e.g. hook stub, Sec mock).
  codeOverride?: string;
  // Top-level account balance (wei) for native-currency overrides.
  balance?: bigint;
  // Set only when this override was produced from a TokenBalanceOverride
  // (resolver-issued, never from RawStateOverride). The pre-sim balance
  // check uses this to verify the override actually funds (account,
  // tokenIn) with >= neededAmount — string match on contractAddress alone
  // is too loose (any unrelated stateDiff slot would suppress the live
  // check).
  //
  // `slot` is the 32-byte hex storage key produced by the slot resolver
  // for ERC-20 balances. Omitted for the native sentinel case — there
  // the funded value lives in the top-level `balance` field on the
  // account, not in a storage slot. Used by the conflict guard to flag
  // a same-slot overwrite from a later RawStateOverride (and ignore
  // unrelated codeOverride / different-slot patches).
  balanceTarget?: {
    account: string;
    amount: bigint;
    slot?: string;
  };
}
