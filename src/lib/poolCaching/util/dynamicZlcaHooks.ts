/**
 * Process-wide store of dynamically discovered ZLCA hooks — the runtime
 * overlay to the static `ZLCA_HOOKS_PER_CHAIN` registry. Populated by
 * `DynamicZlcaHooksRefresher` from on-chain enumeration of the factories in
 * `TRUSTED_ZLCA_HOOK_FACTORIES_PER_CHAIN`; consumed (static ∪ dynamic) by
 * `getTvlBypassHookAddresses` and `zlcaHookGasAdjustment`. Static entries
 * win on conflict.
 *
 * Denylisted hooks are deliberately KEPT here: the denylist gates admission
 * (`getTvlBypassHookAddresses`, `v4HooksPoolsFiltering`), never gas
 * calibration. A freshly denylisted hook's routes keep being served from the
 * route/pair caches until their TTLs expire, and dropping its gas overhead
 * during that window would under-gas exactly the swaps we are trying to stop
 * (the estimate becomes the tx gas limit downstream — a shortfall reverts).
 *
 * Data is per-process and ephemeral (empty until a refresher runs; empty =
 * feature inactive). Node's module cache makes this a single shared Map for
 * every importer in the process.
 */
const store = new Map<number, ReadonlyMap<string, bigint>>();
// Bumped on every mutation so read-side unions (getTvlBypassHookAddresses)
// can memoize per version instead of re-allocating on the hot path.
let storeVersion = 0;

/** Replace the dynamic ZLCA hook set for a chain. Keys are lowercased. */
export function setDynamicZlcaHooks(
  chainId: number,
  hooks: ReadonlyMap<string, bigint>
): void {
  const normalized = new Map<string, bigint>();
  for (const [hook, gasOverheadPerHop] of hooks) {
    normalized.set(hook.toLowerCase(), gasOverheadPerHop);
  }
  store.set(chainId, normalized);
  storeVersion += 1;
}

/**
 * Dynamic hooks for a chain (lowercased → per-hop gas overhead), if any.
 * Includes denylisted hooks (see module doc) — admission-facing consumers
 * must apply `HOOKS_ADDRESSES_DENYLIST` themselves.
 */
export function getDynamicZlcaHooks(
  chainId: number
): ReadonlyMap<string, bigint> | undefined {
  const hooks = store.get(chainId);
  return hooks && hooks.size > 0 ? hooks : undefined;
}

/** Monotonic version of the store; changes whenever the contents change. */
export function getDynamicZlcaHooksVersion(): number {
  return storeVersion;
}

export function resetDynamicZlcaHooksForTest(): void {
  store.clear();
  storeVersion += 1;
}
