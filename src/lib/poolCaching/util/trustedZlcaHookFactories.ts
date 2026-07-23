import {ChainId} from '@uniswap/sdk-core';

/**
 * Trusted ZLCA hook factories (Uniswap-deployed `AllowlistedFactory`
 * instances — see Uniswap/v4-hooks-public `AllowlistedFactory.sol`).
 *
 * Each factory is a CREATE2 deployer restricted to an immutable allowlist of
 * creation-code hashes, so every address in its `allDeployments` array is a
 * known hook implementation. Hooks enumerated from a factory listed here are
 * auto-admitted to routing as ZLCA hooks (same treatment as
 * `ZLCA_HOOKS_PER_CHAIN` entries — TVL bypass, force-select, per-hop gas
 * overhead) without a per-hook registry PR. See `dynamicZlcaHooks.ts`.
 *
 * Trust model: never trust a hook's `factory()` getter (it is just
 * `msg.sender` at construction) — provenance comes exclusively from
 * enumerating the factories in THIS registry. Factory registration attests
 * bytecode provenance, not operator trustworthiness (deployment through the
 * factory is permissionless); `HOOKS_ADDRESSES_DENYLIST` remains the
 * per-hook kill switch and always wins.
 */
export interface TrustedZlcaHookFactory {
  /** MUST be lowercase (enforced by trustedZlcaHookFactories.test.ts). */
  factoryAddress: string;
  /** For logs only — never a metric tag. */
  name: string;
  /**
   * Per-hop gas overhead (gas units) inherited by every hook this factory
   * deploys — same semantics/calibration guidance as the
   * `ZLCA_HOOKS_PER_CHAIN` map values (see that doc comment): erring high is
   * safe, a shortfall reverts user swaps.
   */
  gasOverheadPerHop: bigint;
}

export const DUALPOOL_ALLOWLISTED_FACTORY_ON_MAINNET =
  '0x0000000000077769c332e0d3ed8bc8e02a0ce108';

// Intersected with Record<number, ...> (matching ZLCA_HOOKS_PER_CHAIN's
// shape) so this can be indexed by both @uniswap/sdk-core's ChainId and the
// numerically-overlapping ChainId enum in lib/config.ts.
export const TRUSTED_ZLCA_HOOK_FACTORIES_PER_CHAIN: Partial<
  Record<ChainId, TrustedZlcaHookFactory[]>
> &
  Record<number, TrustedZlcaHookFactory[]> = {
  [ChainId.MAINNET]: [
    {
      factoryAddress: DUALPOOL_ALLOWLISTED_FACTORY_ON_MAINNET,
      name: 'DualPoolAllowlistedFactory',
      // Per hook-team guidance for the DualPoolHook bytecode this factory's
      // creation-code allowlist pins. Deliberately independent of the
      // directly-deployed DualPool hook's entry in ZLCA_HOOKS_PER_CHAIN
      // (coincidentally also 3M) — the two deployments can be recalibrated
      // separately.
      gasOverheadPerHop: 3_000_000n,
    },
  ],
};

/** Chains with at least one trusted factory configured. */
export function getTrustedZlcaFactoryChainIds(): number[] {
  return Object.entries(TRUSTED_ZLCA_HOOK_FACTORIES_PER_CHAIN)
    .filter(([, factories]) => factories.length > 0)
    .map(([chainIdStr]) => Number(chainIdStr));
}
