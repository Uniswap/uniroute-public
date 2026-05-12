import {utils} from 'ethers';
import {ResolvedStateOverride} from '../ResolvedStateOverride';

/**
 * Geth-style state-override block — the second arg of `eth_simulateV1`,
 * also accepted by `tenderly_estimateGasBundle` as its third positional
 * arg. Tenderly Sim API uses the same fields under `state_objects`.
 *
 * Multiple overrides on the same contract are merged (storage maps
 * union). `balance` and `code` of duplicates are last-wins (resolver
 * already produces deduped entries today; merging defensively keeps
 * downstream RPCs from rejecting on duplicate keys).
 */
export interface GethStateOverrideEntry {
  stateDiff?: Record<string, string>;
  code?: string;
  balance?: string; // hex
}

export type GethStateOverrideMap = Record<string, GethStateOverrideEntry>;

export function encodeGethStateOverrides(
  overrides: ResolvedStateOverride[] | undefined
): GethStateOverrideMap | undefined {
  if (!overrides || overrides.length === 0) return undefined;
  const out: GethStateOverrideMap = {};
  for (const o of overrides) {
    const key = o.contractAddress.toLowerCase();
    const entry: GethStateOverrideEntry = out[key] ?? {};
    if (o.stateDiff && o.stateDiff.size > 0) {
      const stateDiff = entry.stateDiff ?? {};
      for (const [slot, val] of o.stateDiff) {
        stateDiff[slot.toLowerCase()] = val.toLowerCase();
      }
      entry.stateDiff = stateDiff;
    }
    if (o.codeOverride !== undefined) entry.code = o.codeOverride;
    if (o.balance !== undefined) {
      entry.balance = '0x' + o.balance.toString(16);
    }
    out[key] = entry;
  }
  return out;
}

/**
 * Tenderly Sim API expects `state_objects` per call with `storage`
 * instead of `stateDiff`. Otherwise identical shape.
 */
export interface TenderlyStateObjectEntry {
  storage?: Record<string, string>;
  code?: string;
  balance?: string;
}

export type TenderlyStateObjects = Record<string, TenderlyStateObjectEntry>;

export function encodeTenderlyStateObjects(
  overrides: ResolvedStateOverride[] | undefined
): TenderlyStateObjects | undefined {
  const geth = encodeGethStateOverrides(overrides);
  if (!geth) return undefined;
  const out: TenderlyStateObjects = {};
  for (const [addr, entry] of Object.entries(geth)) {
    const t: TenderlyStateObjectEntry = {};
    if (entry.stateDiff) t.storage = entry.stateDiff;
    if (entry.code !== undefined) t.code = entry.code;
    if (entry.balance !== undefined) t.balance = entry.balance;
    out[addr] = t;
  }
  return out;
}

// Re-export for tests / callers that need to format a single value.
export function toHex32(value: bigint): string {
  return utils.hexZeroPad(utils.hexlify(value), 32);
}
