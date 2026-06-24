import {
  Currency,
  CurrencyAmount,
  TradeType as SdkTradeType,
} from '@uniswap/sdk-core';
import {
  SWAP_PROXY_ADDRESS,
  SwapRouter,
  SwapSpecification,
  SwapStep,
  TokenTransferMode,
} from '@uniswap/universal-router-sdk';
import {ChainId} from '../../lib/config';
import {MethodParameters} from '../../lib/methodParameters';
import {getUniversalRouterAddress} from '../../lib/universalRouterAddress';
import {SwapOptionsUniversalRouter} from '../simulator/sor-port/simulation-provider';

// Fee-neutral SwapSpecification for SwapRouter.encodeSwaps. Trading owns fee
// math, so `fee` is always undefined. `routing.amount` is the exact side of the
// trade, `routing.quote` the slippage side (validated by validateEncodeSwaps).
export function buildSwapSpecification(params: {
  swapOptions: SwapOptionsUniversalRouter;
  inputAmount: CurrencyAmount<Currency>;
  outputAmount: CurrencyAmount<Currency>;
  tradeType: SdkTradeType;
  chainId: ChainId;
}): SwapSpecification {
  const {swapOptions, inputAmount, outputAmount, tradeType, chainId} = params;
  const isExactIn = tradeType === SdkTradeType.EXACT_INPUT;
  const {deadlineOrPreviousBlockhash} = swapOptions;
  return {
    tradeType,
    routing: {
      inputToken: inputAmount.currency,
      outputToken: outputAmount.currency,
      amount: isExactIn ? inputAmount : outputAmount,
      quote: isExactIn ? outputAmount : inputAmount,
    },
    slippageTolerance: swapOptions.slippageTolerance,
    recipient: swapOptions.recipient,
    fee: undefined,
    tokenTransferMode: swapOptions.tokenTransferMode,
    permit: swapOptions.inputTokenPermit,
    chainId,
    // SwapOptionsFactory always sets a numeric unix deadline (never a hex
    // previousBlockhash), so only forward the numeric form.
    deadline:
      typeof deadlineOrPreviousBlockhash === 'number'
        ? deadlineOrPreviousBlockhash
        : undefined,
    urVersion: swapOptions.urVersion,
  };
}

// Encodes swapSteps into Universal Router calldata, resolving `to` the same way
// the legacy builder does: UR for Permit2, SwapProxy for ApproveProxy.
export function buildSwapStepsMethodParameters(
  swapSteps: SwapStep[],
  spec: SwapSpecification,
  chainId: ChainId
): MethodParameters {
  const {calldata, value} = SwapRouter.encodeSwaps(spec, swapSteps);
  const to =
    spec.tokenTransferMode === TokenTransferMode.ApproveProxy
      ? SWAP_PROXY_ADDRESS(chainId)
      : getUniversalRouterAddress(spec.urVersion, chainId);
  return {calldata, value, to};
}
