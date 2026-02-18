import {JsonRpcProvider} from '@ethersproject/providers';
import {permit2Address} from '@uniswap/permit2-sdk';
import {UNIVERSAL_ROUTER_ADDRESS} from '@uniswap/universal-router-sdk';

import {
  SwapOptions as UniversalRouterSwapOptions,
  UniversalRouterVersion,
} from '@uniswap/universal-router-sdk';

import {ERC20__factory} from '../../../../abis/src/generated/contracts';
import {Permit2__factory} from '../../../../abis/src/generated/contracts';
import {Context} from '@uniswap/lib-uni/context';
import {TradeType} from '../../../models/quote/TradeType';
import {QuoteSplit} from '../../../models/quote/QuoteSplit';
import {ChainId} from '../../../lib/config';
import {CurrencyInfo} from '../../../models/currency/CurrencyInfo';
import {SimulationStatus} from '../ISimulator';

export enum SwapType {
  UNIVERSAL_ROUTER,
  SWAP_ROUTER_02, // Not supported in UniRoute
}

// Swap options for Universal Router and Permit2.
export type SwapOptionsUniversalRouter = UniversalRouterSwapOptions & {
  type: SwapType.UNIVERSAL_ROUTER;
  version: UniversalRouterVersion;
  simulate?: {fromAddress: string};
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
    blockNumber?: number
  ): Promise<QuoteSplit> {
    if (
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
          blockNumber
        );
      } catch (e) {
        ctx.logger.error('Error simulating transaction', {e});
        return {
          ...quoteSplit,
          simulationResult: {
            estimatedGasUsed: 0n,
            estimatedGasUsedInQuoteToken: 0n,
            status: SimulationStatus.FAILED,
            description: 'Error simulating transaction',
          },
        };
      }
    } else {
      ctx.logger.error('User does not have sufficient balance to simulate.');
      return {
        ...quoteSplit,
        simulationResult: {
          estimatedGasUsed: 0n,
          estimatedGasUsedInQuoteToken: 0n,
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
    blockNumber?: number
  ): Promise<QuoteSplit>;

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
      ctx.logger.info('Result of balance check for simulation', {
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
    // Check token has approved Permit2 more than expected amount.
    const tokenContract = ERC20__factory.connect(tokenInAddress, provider);

    if (swapOptions.type === SwapType.UNIVERSAL_ROUTER) {
      const permit2Allowance = (
        await tokenContract.allowance(fromAddress, permit2Address(this.chainId))
      ).toBigInt();

      // If a permit has been provided we don't need to check if UR has already been allowed.
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

      // Check UR has been approved from Permit2.
      const permit2Contract = Permit2__factory.connect(
        permit2Address(this.chainId),
        provider
      );

      const {amount: universalRouterAllowance, expiration: tokenExpiration} =
        await permit2Contract.allowance(
          fromAddress,
          tokenInAddress,
          UNIVERSAL_ROUTER_ADDRESS(swapOptions.version, this.chainId)
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
