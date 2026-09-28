import {Context as UniContext} from '@uniswap/lib-uni/context';
import {ADDRESS_ZERO} from '@uniswap/v3-sdk';
import {Erc4626RegistrySnapshot} from '../registry/Erc4626WrapperRegistry';
import {UniPoolInfo} from './interface';
import {buildMetricKey} from '../../lib/config';
import {getProtocolForAggHookAddress} from '../../lib/poolCaching/util/hooksAddressesAllowlist';
import {matchesHooksOptions} from '../../lib/poolUtils';
import {Address} from '../../models/address/Address';
import {Chain} from '../../models/chain/Chain';
import {canIncludeErc4626Pool} from '../../models/hooks/Erc4626WrapperHooks';
import {HooksOptions} from '../../models/hooks/HooksOptions';
import {RouteNamespaceContext} from '../../models/hooks/namespaces';
import {canIncludePermissionedPool} from '../../models/hooks/PermissionedHooks';
import {Protocol} from '../../models/pool/Protocol';

const METRIC_ERC4626_POOL_DROPPED = buildMetricKey(
  'CrossLiquidity.Erc4626WrapperHooks.poolDropped'
);
const METRIC_PERMISSIONED_POOL_DROPPED = buildMetricKey(
  'CrossLiquidity.PermissionedPoolDropped'
);

export interface CrossLiquidityPoolAdmissionRequest {
  chain: Chain;
  protocols: Protocol[];
  hooksOptions: HooksOptions | undefined;
  nsCtx: RouteNamespaceContext;
  tokenIn: Address;
  tokenOut: Address;
}

/**
 * Decides which snapshot pools cross-liquidity may pick, one pool at a time.
 *
 * Every rule is a per-pool check, so cross-liquidity evaluates it only for the
 * few pools that already match a bridge pair instead of filtering a copy of
 * each whole snapshot per request. The rules and their order are those of the
 * snapshot filters they replace:
 *
 *   1. ERC-4626 wrapper admission (every protocol), when the request carries a
 *      registry snapshot with assets.
 *   2. V4 only: drop aggregator-hook pools whose protocol was not requested,
 *      then apply `hooksOptions`.
 *   3. V4 only: permissioned-hook admission, when the chain has permissioned
 *      hooks.
 *
 * The drop counters keep their names and tags but count drops among the pools
 * actually evaluated, not across the whole snapshot, so they are drop-volume
 * signals for this path only. In particular `reason:bytecode_unready` fires
 * here only when a misconfigured wrapper pool happens to match a bridge pair;
 * a zero on the `CrossLiquidity.` counter does not mean the registry is
 * healthy. Alert on the main-path counters (`UniRoutes.`, `TopPoolsSelector.`,
 * `QuickRoutes.Erc4626WrapperHooks.poolDropped`), which see every wrapper pool.
 */
export class CrossLiquidityPoolAdmission {
  private readonly erc4626Snapshot: Erc4626RegistrySnapshot | undefined;
  private readonly permissionedHooksConfigured: boolean;
  private readonly tokenIn: string;
  private readonly tokenOut: string;
  private erc4626Dropped = 0;
  private erc4626BytecodeUnready = 0;
  private permissionedDropped = 0;

  constructor(private readonly request: CrossLiquidityPoolAdmissionRequest) {
    const snapshot = request.nsCtx.erc4626Snapshot;
    this.erc4626Snapshot =
      snapshot !== undefined && snapshot.assets.length > 0
        ? snapshot
        : undefined;
    this.permissionedHooksConfigured =
      (request.chain.permissionedHookAddresses?.length ?? 0) > 0;
    this.tokenIn = request.tokenIn.toString();
    this.tokenOut = request.tokenOut.toString();
  }

  /** Whether cross-liquidity may pick `pool` from `protocol`'s snapshot. */
  public admits(pool: UniPoolInfo, protocol: Protocol): boolean {
    if (!this.passesErc4626(pool)) {
      return false;
    }
    if (protocol !== Protocol.V4) {
      return true;
    }

    // A V4 pool without a `hooks` field is judged as hookless, so the V4 rules
    // still run on it rather than failing open.
    const hooks = 'hooks' in pool ? pool.hooks : ADDRESS_ZERO;
    const {chain, protocols, hooksOptions} = this.request;
    const hookProtocol = getProtocolForAggHookAddress(hooks, chain.chainId);
    if (
      (hookProtocol !== undefined && !protocols.includes(hookProtocol)) ||
      !matchesHooksOptions({...pool, hooks}, Protocol.V4, hooksOptions)
    ) {
      return false;
    }

    return this.passesPermissioned(hooks, pool);
  }

  /**
   * Emits the drop counters for everything `admits` has rejected since the
   * last call, then resets them, so calling it again never re-sends a drop.
   */
  public async emitDropMetrics(ctx: UniContext): Promise<void> {
    const erc4626Dropped = this.erc4626Dropped;
    const erc4626BytecodeUnready = this.erc4626BytecodeUnready;
    const permissionedDropped = this.permissionedDropped;
    this.erc4626Dropped = 0;
    this.erc4626BytecodeUnready = 0;
    this.permissionedDropped = 0;

    if (erc4626Dropped > 0) {
      await ctx.metrics.count(METRIC_ERC4626_POOL_DROPPED, erc4626Dropped, {
        tags: ['status:success'],
      });
    }
    // Assets registered before their RoutingHook bytecode is configured. On
    // this path it fires only for a wrapper pool that matched a bridge pair;
    // see the class doc for which counters to alert on instead.
    if (erc4626BytecodeUnready > 0) {
      await ctx.metrics.count(
        METRIC_ERC4626_POOL_DROPPED,
        erc4626BytecodeUnready,
        {tags: ['status:failure', 'reason:bytecode_unready']}
      );
    }
    if (permissionedDropped > 0) {
      await ctx.metrics.count(
        METRIC_PERMISSIONED_POOL_DROPPED,
        permissionedDropped,
        {tags: [`chain:${this.request.chain.chainId}`]}
      );
    }
  }

  private passesErc4626(pool: UniPoolInfo): boolean {
    if (this.erc4626Snapshot === undefined) {
      return true;
    }
    const decision = canIncludeErc4626Pool(
      pool,
      this.tokenIn,
      this.tokenOut,
      this.erc4626Snapshot
    );
    if (!decision.canInclude) {
      this.erc4626Dropped++;
      if (decision.dropReason === 'bytecode_unready') {
        this.erc4626BytecodeUnready++;
      }
    }
    return decision.canInclude;
  }

  private passesPermissioned(hooks: string, pool: UniPoolInfo): boolean {
    if (!this.permissionedHooksConfigured) {
      return true;
    }
    const {chain, nsCtx} = this.request;
    const decision = canIncludePermissionedPool(
      hooks,
      pool.token0.id,
      pool.token1.id,
      chain,
      nsCtx,
      this.tokenIn,
      this.tokenOut,
      chain.chainId
    );
    if (!decision.canInclude) {
      this.permissionedDropped++;
    }
    return decision.canInclude;
  }
}
