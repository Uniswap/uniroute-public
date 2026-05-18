import {Context} from '@uniswap/lib-uni/context';
import {
  RawStateOverride,
  StateOverride,
  TokenBalanceOverride,
} from '../../../gen/uniroute/v1/api_pb';
import {ChainId} from '../../lib/config';
import {ResolvedStateOverride} from './ResolvedStateOverride';
import {
  SlotResolutionError,
  TokenBalanceSlotResolver,
} from './TokenBalanceSlotResolver';

export interface StateOverrideResolutionResult {
  resolved: ResolvedStateOverride[];
  // Number of input overrides that could not be resolved. Sim still runs
  // with the resolved subset — failures are surfaced via
  // `STATE_OVERRIDE_NOT_APPLIED` warns + `StateOverride.ResolveFailed`
  // metrics (tagged by `kind` for dashboard breakdowns). If a dropped override turns out to be sim-critical, the
  // simulator returns the real revert reason (more informative than a
  // generic abort); if it was irrelevant to the trade shape, sim succeeds
  // anyway.
  failedCount: number;
}

/**
 * Top-level resolver: takes the proto `StateOverride[]` from a request and
 * dispatches by `oneof.kind`, producing the post-resolved internal shape
 * the simulator backends consume. Per-entry failures are logged + metered
 * and counted; the caller decides what to do with `failedCount`.
 */
export class StateOverrideResolver {
  constructor(
    private readonly slotResolver: TokenBalanceSlotResolver = new TokenBalanceSlotResolver()
  ) {}

  async resolve(
    overrides: StateOverride[],
    chainId: ChainId,
    ctx: Context
  ): Promise<StateOverrideResolutionResult> {
    const resolved: ResolvedStateOverride[] = [];
    let failedCount = 0;
    for (let i = 0; i < overrides.length; i++) {
      const override = overrides[i];
      try {
        const r = this.resolveOne(override, chainId);
        if (r !== undefined) {
          resolved.push(r);
          continue;
        }
        // resolveOne returned undefined → kind is unset OR the proto has
        // added a new oneof variant we don't recognize here yet. Either
        // way the request asked us to apply state we don't know how to
        // apply; warn so we catch missing implementation work fast.
        failedCount++;
        ctx.logger.warn('STATE_OVERRIDE_NOT_APPLIED', {
          index: i,
          kind: override.kind.case ?? 'unset',
          reason: 'unimplemented_kind',
          chainId,
          message:
            override.kind.case === undefined
              ? 'StateOverride.kind is unset'
              : `StateOverride.kind '${override.kind.case}' has no resolver implementation`,
        });
        await ctx.metrics.count('StateOverride.ResolveFailed', 1, {
          tags: [
            `chain:${chainId}`,
            `kind:${override.kind.case ?? 'unset'}`,
            'reason:unimplemented_kind',
          ],
        });
      } catch (err) {
        failedCount++;
        const reason =
          err instanceof SlotResolutionError ? err.reason : 'invalid_slot';
        // Clear, structured warn so the TAPI team can pinpoint which override
        // we dropped and why without re-deriving from metrics. No raw
        // account/wallet addresses — only override `kind` + `index` +
        // `reason` + the failure message.
        ctx.logger.warn('STATE_OVERRIDE_NOT_APPLIED', {
          index: i,
          kind: override.kind.case ?? 'unset',
          reason,
          chainId,
          message: err instanceof Error ? err.message : String(err),
        });
        await ctx.metrics.count('StateOverride.ResolveFailed', 1, {
          tags: [
            `chain:${chainId}`,
            `kind:${override.kind.case ?? 'unset'}`,
            `reason:${reason}`,
          ],
        });
      }
    }
    return {resolved, failedCount};
  }

  private resolveOne(
    override: StateOverride,
    chainId: ChainId
  ): ResolvedStateOverride | undefined {
    const kind = override.kind;
    if (kind.case === 'tokenBalance') {
      return this.slotResolver.resolve(
        kind.value as TokenBalanceOverride,
        chainId
      );
    }
    if (kind.case === 'rawState') {
      const raw = kind.value as RawStateOverride;
      const stateDiff = new Map<string, string>();
      for (const [slot, val] of Object.entries(raw.stateDiff)) {
        stateDiff.set(slot.toLowerCase(), val.toLowerCase());
      }
      const result: ResolvedStateOverride = {
        contractAddress: raw.contractAddress,
      };
      if (stateDiff.size > 0) result.stateDiff = stateDiff;
      if (raw.codeOverride !== undefined)
        result.codeOverride = raw.codeOverride;
      return result;
    }
    // Unknown / unset kind — caller logs + meters this.
    return undefined;
  }
}

/**
 * Detects duplicate writes across a resolved bundle. Two entries collide
 * when they target the same `(contractAddress, slot)`, `(contractAddress,
 * balance)`, or `(contractAddress, code)` field. The encoder applies
 * same-target writes last-wins, so any duplicate is ambiguous from the
 * client's perspective: caller intent is unclear, and a same-value
 * duplicate would otherwise confuse the pre-sim balance guard. Returns
 * a human-readable target identifier on collision, or `null` if all
 * targets are unique.
 */
export function detectDuplicateResolvedWrites(
  resolved: ResolvedStateOverride[]
): string | null {
  const seen = new Set<string>();
  for (const o of resolved) {
    const contract = o.contractAddress.toLowerCase();
    if (o.stateDiff) {
      for (const slot of o.stateDiff.keys()) {
        const key = `${contract}:slot:${slot.toLowerCase()}`;
        if (seen.has(key)) return `${contract}/slot/${slot}`;
        seen.add(key);
      }
    }
    if (o.balance !== undefined) {
      const key = `${contract}:balance`;
      if (seen.has(key)) return `${contract}/balance`;
      seen.add(key);
    }
    if (o.codeOverride !== undefined) {
      const key = `${contract}:code`;
      if (seen.has(key)) return `${contract}/code`;
      seen.add(key);
    }
  }
  return null;
}
