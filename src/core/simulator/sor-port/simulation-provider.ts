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
import {ChainId} from '../../../lib/config';
import {CurrencyInfo} from '../../../models/currency/CurrencyInfo';
import {SimulationStatus} from '../ISimulator';
import {ResolvedStateOverride} from '../ResolvedStateOverride';

export enum SwapType {
  UNIVERSAL_ROUTER,
  SWAP_ROUTER_02, // Not supported in UniRoute
}

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
    protected chainId: ChainId
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
    // against the overridden state, no point spending a Tenderly call.
    if (balanceOverrideOutcome === BalanceOverrideOutcome.Insufficient) {
      ctx.logger.info(
        'Authoritative balance override is below needed amount; skipping sim.'
      );
      return {
        ...quoteSplit,
        simulationResult: {
          estimatedGasUsed: 0n,
          estimatedGasUsedInQuoteToken: 0n,
          estimatedGasUsedInUSD: 0,
          status: SimulationStatus.INSUFFICIENT_BALANCE,
          description:
            'State override sets account balance below needed amount.',
        },
      };
    }

    if (balanceOverrideOutcome === BalanceOverrideOutcome.Sufficient) {
      await ctx.metrics.count('SimulationBalanceCheckSkipped', 1, {
        tags: [`chain:${this.chainId}`],
      });
    }

    if (
      balanceOverrideOutcome === BalanceOverrideOutcome.Sufficient ||
      // we assume we always have enough eth mainnet balance because we use beacon address later
      (tokenInCurrencyInfo.isNative && this.chainId === ChainId.MAINNET) ||
      (await this.userHasSufficientBalance(
        fromAddress,
        quoteSplit.swapInfo!.tradeType,
        tokenInCurrencyInfo,
        tokenOutCurrencyInfo,
        inputAmount,
        quoteAmount,
        ctx
      ))
    ) {
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
        ctx.logger.error('Error simulating transaction', {e});
        return {
          ...quoteSplit,
          simulationResult: {
            estimatedGasUsed: 0n,
            estimatedGasUsedInQuoteToken: 0n,
            estimatedGasUsedInUSD: 0,
            status: SimulationStatus.FAILED,
            description: 'Error simulating transaction',
          },
        };
      }
    } else {
      // User-input issue (insufficient balance) surfaced to caller — log at warn, not error.
      ctx.logger.warn('User does not have sufficient balance to simulate.');
      return {
        ...quoteSplit,
        simulationResult: {
          estimatedGasUsed: 0n,
          estimatedGasUsedInQuoteToken: 0n,
          estimatedGasUsedInUSD: 0,
          status: SimulationStatus.INSUFFICIENT_BALANCE,
          description: 'User does not have sufficient balance to simulate.',
        },
      };
    }
  }

  protected abstract simulateTransaction(
    fromAddress: string,
    swapOptions: SwapOptionsUniversalRouter,
    quoteSplit: QuoteSplit,
    ctx: Context,
    gasPrice?: bigint,
    blockNumber?: number,
    stateOverrides?: ResolvedStateOverride[]
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

  protected async userHasSufficientBalance(
    fromAddress: string,
    tradeType: TradeType,
    tokenInCurrencyInfo: CurrencyInfo,
    tokenOutCurrencyInfo: CurrencyInfo,
    inputAmount: bigint,
    quoteAmount: bigint,
    ctx: Context
  ): Promise<boolean> {
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
      return hasBalance;
    } catch (e) {
      ctx.logger.error('Error while checking user balance', {e});
      return false;
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
    const tokenContract = ERC20__factory.connect(tokenInAddress, provider);

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
          tokenInAddress,
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
