import {JsonRpcProvider} from '@ethersproject/providers';
import {permit2Address} from '@uniswap/permit2-sdk';
import {getUniversalRouterAddress} from '../../../lib/universalRouterAddress';

import {
  SWAP_PROXY_ADDRESS,
  SwapOptions as UniversalRouterSwapOptions,
  TokenTransferMode,
} from '@uniswap/universal-router-sdk';

import {ERC20__factory} from '../../../../abis/src/generated/contracts';
import {Permit2__factory} from '../../../../abis/src/generated/contracts';
import {Context} from '@uniswap/lib-uni/context';
import {TradeType} from '../../../models/quote/TradeType';
import {QuoteSplit} from '../../../models/quote/QuoteSplit';
import {
  ChainId,
  TAG_STATUS_FAILURE,
  TAG_STATUS_SUCCESS,
} from '../../../lib/config';
import {CurrencyInfo} from '../../../models/currency/CurrencyInfo';
import {SimulationStatus} from '../ISimulator';
import {
  classifySimulationException,
  describeSimulationException,
  extractRevertData,
  isSimulationBackendUnavailable,
  simulationExceptionLogFields,
} from './simulationErrorBreakDown';
import {ResolvedStateOverride} from '../ResolvedStateOverride';
import {getUnderlyingPermissionedTokenOrSelf} from '@uniswap/lib-sharedconfig/permissionedTokens';
import {
  BalanceOverrideRefusalReason,
  describeBalanceOverrideRefusal,
  NATIVE_BALANCE_OVERRIDE_ASSET,
} from './balanceOverride';

export enum SwapType {
  UNIVERSAL_ROUTER,
  SWAP_ROUTER_02, // Not supported in UniRoute
}

// Raw names like SimulationBalanceCheckSkipped without the UniRouteService.Metric prefix
// A seeded run that executed is status success with the swap's outcome, reverts included, and one that never ran is a failure with a reason
const METRIC_SEEDED_BALANCE_SIMULATION = 'SimulationSeededBalance';
// Underfunded senders answered without a seeded run, by reason
const METRIC_SEEDED_BALANCE_SKIPPED = 'SimulationSeededBalanceSkipped';

const INSUFFICIENT_BALANCE_DESCRIPTION =
  'User does not have sufficient balance to simulate.';
const OVERRIDE_INSUFFICIENT_DESCRIPTION =
  'State override sets account balance below needed amount.';
const SEED_REFUSED_DESCRIPTION =
  'User does not have sufficient balance and the simulation could not seed it.';
const SEEDED_SIMULATION_SUCCESS_DESCRIPTION =
  'Simulation succeeded with a seeded balance; user does not have sufficient balance.';

/** Why an underfunded sender was answered without a seeded run */
export enum SeededSkipReason {
  DISABLED = 'disabled',
  CHAIN_UNSUPPORTED = 'chain_unsupported',
  BALANCE_UNKNOWN = 'balance_unknown',
  OVERRIDE_INSUFFICIENT = 'override_insufficient',
}

/** A seeded run that threw before executing, with no revert data */
const SEEDED_REASON_EXCEPTION = 'exception';
type SeededRunFailureReason =
  | BalanceOverrideRefusalReason
  | SimulationStatus
  | typeof SEEDED_REASON_EXCEPTION;

/** Statuses of a run that never executed the swap */
const SIMULATION_NOT_RUN_STATUSES: ReadonlySet<SimulationStatus> = new Set([
  SimulationStatus.UNATTEMPTED,
  SimulationStatus.UNKNOWN,
  SimulationStatus.NOT_SUPPORTED,
  SimulationStatus.NOT_APPROVED,
  SimulationStatus.SYSTEM_DOWN,
]);

/**
 * Result of the pre-sim balance-override probe (`evaluateBalanceOverride`).
 * Decides whether to skip the live RPC balance check, return
 * INSUFFICIENT_BALANCE directly, or fall through to the live check.
 */
export enum BalanceOverrideOutcome {
  /** balanceTarget covers (fromAddress, tokenIn) with amount >= needed. */
  Sufficient = 'override-sufficient',
  /** balanceTarget covers the pair but amount < needed; skip sim. */
  Insufficient = 'override-insufficient',
  /** No matching balanceTarget; fall through to live RPC check. */
  NoAuthoritativeOverride = 'no-authoritative-override',
}

/** Outcome of the live RPC balance read in `checkUserBalance`. */
export enum UserBalanceCheck {
  Sufficient = 'sufficient',
  Insufficient = 'insufficient',
  /** The balance read never reached a node; the balance is unknown. */
  BackendUnavailable = 'backend-unavailable',
  /** The node answered but the balance could not be read, so nothing is known about it */
  Unknown = 'unknown',
}

/** The quote split with a simulation that produced no gas estimate. */
export function withZeroGasSimulationResult(
  quoteSplit: QuoteSplit,
  status: SimulationStatus,
  description: string
): QuoteSplit {
  return {
    ...quoteSplit,
    simulationResult: {
      estimatedGasUsed: 0n,
      estimatedGasUsedInQuoteToken: 0n,
      estimatedGasUsedInUSD: 0,
      status,
      description,
    },
  };
}

/** Counts without awaiting so a metrics failure can never change a simulation answer */
export function countInBackground(
  ctx: Context,
  metric: string,
  tags: string[]
): void {
  void Promise.resolve()
    .then(() => ctx.metrics.count(metric, 1, {tags}))
    .catch(() => undefined);
}

/** Flags a result as coming from a seeded run so the BL can cap seeded attempts per request */
function markSeeded(quoteSplit: QuoteSplit): QuoteSplit {
  const {simulationResult} = quoteSplit;
  return simulationResult === undefined
    ? quoteSplit
    : {...quoteSplit, simulationResult: {...simulationResult, seeded: true}};
}

// Swap options for Universal Router and Permit2.
export type SwapOptionsUniversalRouter = UniversalRouterSwapOptions & {
  type: SwapType.UNIVERSAL_ROUTER;
  simulate?: {fromAddress: string};
  // Carried so the simulator providers can tag metrics for swapsteps mode.
  universalRouterSwapsteps?: boolean;
};

export type SimulationResult = {
  transaction: {
    hash: string;
    gas_used: number;
    gas: number;
    error_message: string;
  };
  simulation: {state_overrides: Record<string, unknown>};
};

/**
 * Provider for dry running transactions.
 *
 * @export
 * @class Simulator
 */
export abstract class Simulator {
  protected provider: JsonRpcProvider;

  /**
   * Returns a new SwapRoute with simulated gas estimates
   * @returns SwapRoute
   */
  constructor(
    provider: JsonRpcProvider,
    protected chainId: ChainId,
    protected readonly seededBalanceEnabled: boolean
  ) {
    this.provider = provider;
  }

  public async simulate(
    fromAddress: string,
    swapOptions: SwapOptionsUniversalRouter,
    quoteSplit: QuoteSplit,
    tokenInCurrencyInfo: CurrencyInfo,
    tokenOutCurrencyInfo: CurrencyInfo,
    inputAmount: bigint,
    quoteAmount: bigint,
    ctx: Context,
    gasPrice?: bigint,
    blockNumber?: number,
    stateOverrides?: ResolvedStateOverride[]
  ): Promise<QuoteSplit> {
    const balanceOverrideOutcome = this.evaluateBalanceOverride(
      fromAddress,
      quoteSplit.swapInfo!.tradeType,
      tokenInCurrencyInfo,
      inputAmount,
      quoteAmount,
      stateOverrides
    );

    // Override says the account is not funded enough — sim would revert
    // against the overridden state, no point spending a sim call.
    if (balanceOverrideOutcome === BalanceOverrideOutcome.Insufficient) {
      ctx.logger.info(
        'Authoritative balance override is below needed amount; skipping sim.'
      );
      this.countSeededSkip(ctx, SeededSkipReason.OVERRIDE_INSUFFICIENT);
      return withZeroGasSimulationResult(
        quoteSplit,
        SimulationStatus.INSUFFICIENT_BALANCE,
        OVERRIDE_INSUFFICIENT_DESCRIPTION
      );
    }

    if (balanceOverrideOutcome === BalanceOverrideOutcome.Sufficient) {
      await ctx.metrics.count('SimulationBalanceCheckSkipped', 1, {
        tags: [`chain:${this.chainId}`],
      });
    }

    const userBalance =
      balanceOverrideOutcome === BalanceOverrideOutcome.Sufficient ||
      // we assume we always have enough eth mainnet balance because we use beacon address later
      (tokenInCurrencyInfo.isNative && this.chainId === ChainId.MAINNET)
        ? UserBalanceCheck.Sufficient
        : await this.checkUserBalance(
            fromAddress,
            quoteSplit.swapInfo!.tradeType,
            tokenInCurrencyInfo,
            tokenOutCurrencyInfo,
            inputAmount,
            quoteAmount,
            ctx
          );

    if (userBalance === UserBalanceCheck.BackendUnavailable) {
      return withZeroGasSimulationResult(
        quoteSplit,
        SimulationStatus.SYSTEM_DOWN,
        'Simulation backend unavailable during balance check'
      );
    }

    if (userBalance === UserBalanceCheck.Unknown) {
      // A read error says nothing about the wallet, so nothing is seeded on it
      ctx.logger.warn(INSUFFICIENT_BALANCE_DESCRIPTION);
      this.countSeededSkip(ctx, SeededSkipReason.BALANCE_UNKNOWN);
      return withZeroGasSimulationResult(
        quoteSplit,
        SimulationStatus.INSUFFICIENT_BALANCE,
        INSUFFICIENT_BALANCE_DESCRIPTION
      );
    }

    if (userBalance === UserBalanceCheck.Insufficient) {
      const skipReason = this.seededRunSkipReason();
      if (skipReason !== undefined) {
        ctx.logger.warn(INSUFFICIENT_BALANCE_DESCRIPTION);
        this.countSeededSkip(ctx, skipReason);
        return withZeroGasSimulationResult(
          quoteSplit,
          SimulationStatus.INSUFFICIENT_BALANCE,
          INSUFFICIENT_BALANCE_DESCRIPTION
        );
      }
      return this.simulateWithSeededBalance(
        fromAddress,
        swapOptions,
        quoteSplit,
        tokenInCurrencyInfo,
        ctx,
        gasPrice,
        blockNumber,
        stateOverrides
      );
    }

    ctx.logger.info(
      'User has sufficient balance to simulate. Simulating transaction.'
    );
    try {
      return await this.simulateTransaction(
        fromAddress,
        swapOptions,
        quoteSplit,
        ctx,
        gasPrice,
        blockNumber,
        stateOverrides
      );
    } catch (e) {
      return this.describeFailedSimulation(e, quoteSplit, ctx);
    }
  }

  /** Why an underfunded sender keeps the plain INSUFFICIENT_BALANCE answer, undefined when the seeded run goes ahead */
  private seededRunSkipReason(): SeededSkipReason | undefined {
    if (!this.seededBalanceEnabled) {
      return SeededSkipReason.DISABLED;
    }
    if (!this.supportsSimulation()) {
      return SeededSkipReason.CHAIN_UNSUPPORTED;
    }
    return undefined;
  }

  /** Whether this simulator has a backend for the chain, a seeded run is pointless without one */
  protected abstract supportsSimulation(): boolean;

  /** Checks the route with unirpc seeding tokenIn for a sender that cannot fund the swap */
  private async simulateWithSeededBalance(
    fromAddress: string,
    swapOptions: SwapOptionsUniversalRouter,
    quoteSplit: QuoteSplit,
    tokenInCurrencyInfo: CurrencyInfo,
    ctx: Context,
    gasPrice?: bigint,
    blockNumber?: number,
    stateOverrides?: ResolvedStateOverride[]
  ): Promise<QuoteSplit> {
    // A permissioned token is pulled on its underlying, so that is what the seed must fund
    const asset = tokenInCurrencyInfo.isNative
      ? NATIVE_BALANCE_OVERRIDE_ASSET
      : getUnderlyingPermissionedTokenOrSelf(
          tokenInCurrencyInfo.wrappedAddress.address,
          this.chainId
        );
    ctx.logger.info(
      'User does not have sufficient balance; simulating with a seeded balance.'
    );
    let simulated: QuoteSplit;
    try {
      simulated = await this.simulateTransaction(
        fromAddress,
        swapOptions,
        quoteSplit,
        ctx,
        gasPrice,
        blockNumber,
        stateOverrides,
        asset
      );
    } catch (e) {
      // The provider rethrows every seeded failure unclassified, so the seeded policy lives here
      return markSeeded(this.describeSeededThrow(e, quoteSplit, ctx));
    }
    return markSeeded(this.reportSeededRun(simulated, ctx));
  }

  /** A seeded throw is a refused seed, an outage, a revert that executed, or an exception before execution */
  private describeSeededThrow(
    error: unknown,
    quoteSplit: QuoteSplit,
    ctx: Context
  ): QuoteSplit {
    const refusal = describeBalanceOverrideRefusal(error);
    if (refusal !== undefined) {
      // Only unirpc's own refusal text is static enough to log
      ctx.logger.warn('Balance override refused; simulation not supported', {
        reason: refusal.reason,
        ...(refusal.reason === BalanceOverrideRefusalReason.REFUSED && {
          upstreamMessage: refusal.message,
        }),
      });
      this.countSeededSimulation(ctx, TAG_STATUS_FAILURE, refusal.reason);
      return withZeroGasSimulationResult(
        quoteSplit,
        SimulationStatus.NOT_SUPPORTED,
        SEED_REFUSED_DESCRIPTION
      );
    }
    const status = classifySimulationException(
      error,
      quoteSplit.swapInfo!.tokenInWrappedAddress,
      quoteSplit.swapInfo!.tokenOutWrappedAddress
    );
    if (status === SimulationStatus.SYSTEM_DOWN) {
      ctx.logger.error(
        'Seeded simulation backend unavailable',
        simulationExceptionLogFields(error)
      );
      this.countSeededSimulation(ctx, TAG_STATUS_FAILURE, status);
      return withZeroGasSimulationResult(
        quoteSplit,
        status,
        'Simulation backend unavailable'
      );
    }
    if (extractRevertData(error) !== undefined) {
      // The swap executed and reverted, which is the answer the caller needs
      ctx.logger.warn('Seeded simulation reverted', {simulationStatus: status});
      return this.reportSeededRun(
        withZeroGasSimulationResult(
          quoteSplit,
          status,
          'Error simulating transaction'
        ),
        ctx
      );
    }
    // No revert data means the swap never executed, so it is not a route failure
    ctx.logger.warn(
      'Seeded simulation threw before executing; route unverified',
      simulationExceptionLogFields(error)
    );
    this.countSeededSimulation(
      ctx,
      TAG_STATUS_FAILURE,
      SEEDED_REASON_EXCEPTION
    );
    return withZeroGasSimulationResult(
      quoteSplit,
      SimulationStatus.INSUFFICIENT_BALANCE,
      INSUFFICIENT_BALANCE_DESCRIPTION
    );
  }

  /** Counts the seeded run and turns an executed SUCCESS into INSUFFICIENT_BALANCE */
  private reportSeededRun(simulated: QuoteSplit, ctx: Context): QuoteSplit {
    const {simulationResult} = simulated;
    if (
      simulationResult === undefined ||
      SIMULATION_NOT_RUN_STATUSES.has(simulationResult.status)
    ) {
      this.countSeededSimulation(
        ctx,
        TAG_STATUS_FAILURE,
        simulationResult?.status ?? SimulationStatus.UNATTEMPTED
      );
      return simulated;
    }
    this.countSeededSimulation(
      ctx,
      TAG_STATUS_SUCCESS,
      undefined,
      simulationResult.status
    );
    if (simulationResult.status !== SimulationStatus.SUCCESS) {
      return simulated;
    }
    return {
      ...simulated,
      simulationResult: {
        ...simulationResult,
        status: SimulationStatus.INSUFFICIENT_BALANCE,
        description: SEEDED_SIMULATION_SUCCESS_DESCRIPTION,
      },
    };
  }

  private countSeededSimulation(
    ctx: Context,
    statusTag: string,
    reason?: SeededRunFailureReason,
    outcome?: SimulationStatus
  ): void {
    countInBackground(ctx, METRIC_SEEDED_BALANCE_SIMULATION, [
      `chain:${this.chainId}`,
      statusTag,
      ...(reason === undefined ? [] : [`reason:${reason}`]),
      ...(outcome === undefined ? [] : [`outcome:${outcome}`]),
    ]);
  }

  private countSeededSkip(ctx: Context, reason: SeededSkipReason): void {
    countInBackground(ctx, METRIC_SEEDED_BALANCE_SKIPPED, [
      `chain:${this.chainId}`,
      `reason:${reason}`,
    ]);
  }

  private describeFailedSimulation(
    error: unknown,
    quoteSplit: QuoteSplit,
    ctx: Context
  ): QuoteSplit {
    const {status, logFields} = describeSimulationException(
      error,
      quoteSplit.swapInfo!.tokenInWrappedAddress,
      quoteSplit.swapInfo!.tokenOutWrappedAddress
    );
    ctx.logger.error('Error simulating transaction', logFields);
    return withZeroGasSimulationResult(
      quoteSplit,
      status,
      status === SimulationStatus.SYSTEM_DOWN
        ? 'Simulation backend unavailable'
        : 'Error simulating transaction'
    );
  }

  /** fundSenderAsset names the asset unirpc seeds every sender with, and a seeded run rethrows every failure for the base class to classify */
  protected abstract simulateTransaction(
    fromAddress: string,
    swapOptions: SwapOptionsUniversalRouter,
    quoteSplit: QuoteSplit,
    ctx: Context,
    gasPrice?: bigint,
    blockNumber?: number,
    stateOverrides?: ResolvedStateOverride[],
    fundSenderAsset?: string
  ): Promise<QuoteSplit>;

  /**
   * Decide how to handle the pre-sim balance check when state overrides
   * are in play. The override is treated as authoritative — if TAPI says
   * "this account has X balance", we evaluate against X, not against
   * the live on-chain balance.
   *
   * Returns one of (see `BalanceOverrideOutcome`):
   *   - Sufficient: a balanceTarget covers (fromAddress, tokenIn) with
   *     amount >= needed. Skip the live check, run sim.
   *   - Insufficient: a balanceTarget covers the pair but its amount is
   *     < needed. Don't waste a sim call — sim would revert against the
   *     overridden state regardless. Return INSUFFICIENT_BALANCE directly.
   *   - NoAuthoritativeOverride: no balanceTarget for the pair. Fall
   *     through to the live RPC balance check.
   *
   * We rely on the resolver-issued `balanceTarget` rather than a string
   * match on `stateDiff` keys — a bare stateDiff entry on the input-token
   * contract isn't proof the swapper's balance slot was funded (could be
   * an allowance slot, totalSupply, etc.).
   *
   * Same-slot collisions across entries are rejected upstream at the BL
   * via `detectDuplicateResolvedWrites`, so each (contract, slot/balance)
   * target is written by at most one entry by the time we get here. We
   * therefore don't need to reason about last-wins ordering.
   */
  private evaluateBalanceOverride(
    fromAddress: string,
    tradeType: TradeType,
    tokenInCurrencyInfo: CurrencyInfo,
    inputAmount: bigint,
    quoteAmount: bigint,
    stateOverrides?: ResolvedStateOverride[]
  ): BalanceOverrideOutcome {
    if (!stateOverrides || stateOverrides.length === 0) {
      return BalanceOverrideOutcome.NoAuthoritativeOverride;
    }
    const neededAmount =
      tradeType === TradeType.ExactIn ? inputAmount : quoteAmount;
    const from = fromAddress.toLowerCase();
    const tokenInWrapped =
      tokenInCurrencyInfo.wrappedAddress.address.toLowerCase();

    for (const o of stateOverrides) {
      if (!o.balanceTarget) continue;
      if (o.balanceTarget.account.toLowerCase() !== from) continue;
      if (tokenInCurrencyInfo.isNative) {
        if (o.balance === undefined) continue;
      } else if (o.contractAddress.toLowerCase() !== tokenInWrapped) {
        continue;
      }
      return o.balanceTarget.amount >= neededAmount
        ? BalanceOverrideOutcome.Sufficient
        : BalanceOverrideOutcome.Insufficient;
    }
    return BalanceOverrideOutcome.NoAuthoritativeOverride;
  }

  protected async checkUserBalance(
    fromAddress: string,
    tradeType: TradeType,
    tokenInCurrencyInfo: CurrencyInfo,
    tokenOutCurrencyInfo: CurrencyInfo,
    inputAmount: bigint,
    quoteAmount: bigint,
    ctx: Context
  ): Promise<UserBalanceCheck> {
    try {
      const neededBalanceIsNative = tokenInCurrencyInfo.isNative;
      const neededBalanceWrappedAddress =
        tokenInCurrencyInfo.wrappedAddress.address;
      const neededBalanceAmount =
        tradeType === TradeType.ExactIn ? inputAmount : quoteAmount;
      let balance: bigint;
      if (neededBalanceIsNative) {
        balance = (await this.provider.getBalance(fromAddress)).toBigInt();
      } else {
        const tokenContract = ERC20__factory.connect(
          neededBalanceWrappedAddress,
          this.provider
        );
        balance = (await tokenContract.balanceOf(fromAddress)).toBigInt();
      }

      const hasBalance = balance >= neededBalanceAmount;
      ctx.logger.debug('Result of balance check for simulation', {
        fromAddress,
        balance: balance.toString(),
        neededBalance: neededBalanceAmount.toString(),
        neededAddress: neededBalanceWrappedAddress,
        hasBalance,
      });
      return hasBalance
        ? UserBalanceCheck.Sufficient
        : UserBalanceCheck.Insufficient;
    } catch (e) {
      if (isSimulationBackendUnavailable(e)) {
        ctx.logger.error(
          'Error while checking user balance',
          simulationExceptionLogFields(e)
        );
        return UserBalanceCheck.BackendUnavailable;
      }
      ctx.logger.error('Error while checking user balance', {e});
      return UserBalanceCheck.Unknown;
    }
  }

  protected async checkTokenApproved(
    fromAddress: string,
    tokenInAddress: string,
    inputAmount: bigint,
    swapOptions: SwapOptionsUniversalRouter,
    provider: JsonRpcProvider,
    ctx: Context
  ): Promise<boolean> {
    // Any permit2 approval calls must be on the underlying permissioned token not the adapter token
    const approvalToken = getUnderlyingPermissionedTokenOrSelf(
      tokenInAddress,
      this.chainId
    );
    const tokenContract = ERC20__factory.connect(approvalToken, provider);

    if (swapOptions.type === SwapType.UNIVERSAL_ROUTER) {
      if (swapOptions.tokenTransferMode === TokenTransferMode.ApproveProxy) {
        const proxyAllowance = (
          await tokenContract.allowance(
            fromAddress,
            SWAP_PROXY_ADDRESS(this.chainId)
          )
        ).toBigInt();

        const proxyApproved = proxyAllowance >= inputAmount;
        ctx.logger.info(
          `Simulating on UR with ApproveProxy, Proxy approved: ${proxyApproved}.`,
          {
            proxyAllowance: proxyAllowance.toString(),
            inputAmount: inputAmount.toString(),
            proxyApproved,
          }
        );
        return proxyApproved;
      }

      // Permit2 flow
      const permit2Allowance = (
        await tokenContract.allowance(fromAddress, permit2Address(this.chainId))
      ).toBigInt();

      if (swapOptions.inputTokenPermit) {
        ctx.logger.info(
          'Permit was provided for simulation on UR, checking that Permit2 has been approved.',
          {
            permitAllowance: permit2Allowance.toString(),
            inputAmount: inputAmount.toString(),
          }
        );
        return permit2Allowance >= inputAmount;
      }

      const permit2Contract = Permit2__factory.connect(
        permit2Address(this.chainId),
        provider
      );

      const {amount: universalRouterAllowance, expiration: tokenExpiration} =
        await permit2Contract.allowance(
          fromAddress,
          approvalToken,
          getUniversalRouterAddress(swapOptions.urVersion, this.chainId)
        );

      const nowTimestampS = Math.round(Date.now() / 1000);

      const permit2Approved = permit2Allowance >= inputAmount;
      const universalRouterApproved =
        universalRouterAllowance.toBigInt() >= inputAmount;
      const expirationValid = tokenExpiration > nowTimestampS;
      ctx.logger.info(
        `Simulating on UR, Permit2 approved: ${permit2Approved}, UR approved: ${universalRouterApproved}, Expiraton valid: ${expirationValid}.`,
        {
          permitAllowance: permit2Allowance.toString(),
          tokenAllowance: universalRouterAllowance.toString(),
          tokenExpirationS: tokenExpiration,
          nowTimestampS,
          inputAmount: inputAmount.toString(),
          permit2Approved,
          universalRouterApproved,
          expirationValid,
        }
      );
      return permit2Approved && universalRouterApproved && expirationValid;
    } else {
      throw new Error(`Unsupported swap type ${swapOptions}`);
    }
  }
}
