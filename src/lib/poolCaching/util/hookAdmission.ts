import {blocksUnvettedHookAdmission} from '@uniswap/lib-v4-hooks';
import {getPermissionedHookAddresses} from '@uniswap/lib-sharedconfig/permissionedTokens';
import {ADDRESS_ZERO} from '@uniswap/router-sdk';
import {getDynamicZlcaHooks} from './dynamicZlcaHooks';
import {HOOKS_ADDRESSES_ALLOWLIST} from './hooksAddressesAllowlist';
import {HOOKS_ADDRESSES_DENYLIST} from './hooksAddressesDenylist';

type LowercasedHookLists = {
  allowlisted: ReadonlySet<string>;
  denylisted: ReadonlySet<string>;
  permissioned: ReadonlySet<string>;
};

const hookListsByChain = new Map<number, LowercasedHookLists>();

const lowercasedSet = (hooks: readonly string[]): ReadonlySet<string> =>
  new Set(hooks.map(hook => hook.toLowerCase()));

/**
 * The chain's HOOKS_ADDRESSES_ALLOWLIST, HOOKS_ADDRESSES_DENYLIST and
 * permissioned-hook registry, lowercased; built once per chain.
 */
function getLowercasedHookLists(chainId: number): LowercasedHookLists {
  let lists = hookListsByChain.get(chainId);
  if (lists === undefined) {
    lists = {
      allowlisted: lowercasedSet(HOOKS_ADDRESSES_ALLOWLIST[chainId] ?? []),
      denylisted: lowercasedSet(HOOKS_ADDRESSES_DENYLIST[chainId] ?? []),
      permissioned: lowercasedSet(getPermissionedHookAddresses(chainId)),
    };
    hookListsByChain.set(chainId, lists);
  }
  return lists;
}

/** Drops the per-chain lists so a test that edits a list sees the edit. */
export function resetHookListsForTest(): void {
  hookListsByChain.clear();
}

/** The chain's HOOKS_ADDRESSES_ALLOWLIST, lowercased; built once per chain. */
export function getLowercasedAllowlistedHooks(
  chainId: number
): ReadonlySet<string> {
  return getLowercasedHookLists(chainId).allowlisted;
}

/**
 * The admission a hooked pool gets without any vetting: hookless, or a hook
 * with no swap or custom-accounting bits on a static-fee pool. A dynamic-fee
 * pool fails because the hook sets the LP fee with no permission bit.
 * `isDynamicFee` runs only for a bit-clean hook, since callers derive it from
 * the pool id.
 */
export function passesUnvettedHookGate(
  hook: string,
  isDynamicFee: () => boolean,
  isUnvettedAdmissionBlocked: (
    hook: string
  ) => boolean = blocksUnvettedHookAdmission
): boolean {
  return (
    hook === ADDRESS_ZERO ||
    (!isUnvettedAdmissionBlocked(hook) && !isDynamicFee())
  );
}

/**
 * Whether pool-caching admission (v4HooksPoolsFiltering) still lets a pool
 * with this hook into routing on this chain: not denylisted, and either
 * explicitly admitted (HOOKS_ADDRESSES_ALLOWLIST, a factory-discovered ZLCA
 * hook in this process's store, or the permissioned-hook registry) or through
 * the unvetted gate. Hook-level only: the per-pool rules (TVL ranking, the fee
 * ceiling, permissioned adapter ownership) stay with their own callers.
 */
export function isHookAdmissible(
  chainId: number,
  hook: string,
  isDynamicFee: () => boolean
): boolean {
  const lowered = hook.toLowerCase();
  if (lowered === ADDRESS_ZERO) {
    return true;
  }
  const lists = getLowercasedHookLists(chainId);
  if (lists.denylisted.has(lowered)) {
    return false;
  }
  return (
    lists.allowlisted.has(lowered) ||
    getDynamicZlcaHooks(chainId)?.has(lowered) === true ||
    lists.permissioned.has(lowered) ||
    passesUnvettedHookGate(lowered, isDynamicFee)
  );
}
