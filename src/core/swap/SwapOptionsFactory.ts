import {ChainId} from '../../lib/config';
import {parseDeadline, parseSlippageTolerance} from './shared';
import {PermitSingle} from '@uniswap/permit2-sdk';
import {
  UNIVERSAL_ROUTER_ADDRESS,
  UniversalRouterVersion,
} from '@uniswap/universal-router-sdk';
import {
  SwapOptionsUniversalRouter,
  SwapType,
} from '../simulator/sor-port/simulation-provider';
import {computePortionAmount, populateFeeOptions} from '../../lib/portionUtils';
import {TradeType} from '../../models/quote/TradeType';

export type SwapOptionsUniversalRouterInput = {
  chainId: ChainId;
  tradeType: TradeType;
  amountIn: string;
  tokenInWrappedAddress: string;
  slippageTolerance?: string;
  portionBips?: number;
  portionRecipient?: string;
  deadline?: string;
  recipient?: string;
  permitSignature?: string;
  permitNonce?: string;
  permitExpiration?: string;
  permitAmount?: string;
  permitSigDeadline?: string;
  simulateFromAddress?: string;
};

export class SwapOptionsFactory {
  static createUniversalRouterOptions_2_0({
    chainId,
    tradeType,
    amountIn,
    tokenInWrappedAddress,
    slippageTolerance,
    portionBips,
    portionRecipient,
    deadline,
    recipient,
    permitSignature,
    permitNonce,
    permitExpiration,
    permitAmount,
    permitSigDeadline,
    simulateFromAddress,
  }: SwapOptionsUniversalRouterInput): SwapOptionsUniversalRouter | undefined {
    if (!slippageTolerance) {
      return undefined;
    }

    const allFeeOptions = populateFeeOptions(
      tradeType,
      portionBips,
      portionRecipient,
      computePortionAmount(amountIn, portionBips)
    );

    const swapParams: SwapOptionsUniversalRouter = {
      type: SwapType.UNIVERSAL_ROUTER,
      version: UniversalRouterVersion.V2_0,
      deadlineOrPreviousBlockhash: deadline
        ? parseDeadline(deadline)
        : undefined,
      recipient: recipient,
      slippageTolerance: parseSlippageTolerance(slippageTolerance),
      ...allFeeOptions,
    };

    if (
      permitSignature &&
      permitNonce &&
      permitExpiration &&
      permitAmount &&
      permitSigDeadline
    ) {
      // in case of v4 native input, we might not want to compose permit2 at all, because native currency cannot be issued permit2.
      // however there's still a chance, for v4, a native input has a wrapped pool has best routing. in that case, we still need permit2.
      // for now, SOR v4 routing cannot support native currency input with the wrapped pool routing, although v4-sdk can support that.
      // so we just leave as is here. ud-sdk should be able to tell to not issue permit2 because it could go through the v4 native pool in the route object
      // as part of routing-api response.
      const permit: PermitSingle = {
        details: {
          token: tokenInWrappedAddress,
          amount: permitAmount,
          expiration: permitExpiration,
          nonce: permitNonce,
        },
        spender: UNIVERSAL_ROUTER_ADDRESS(UniversalRouterVersion.V2_0, chainId),
        sigDeadline: permitSigDeadline,
      };

      swapParams.inputTokenPermit = {
        ...permit,
        signature: permitSignature,
      };
    }

    if (simulateFromAddress) {
      swapParams.simulate = {fromAddress: simulateFromAddress};
    }

    return swapParams;
  }
}
