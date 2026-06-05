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
  V4Action,
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

// The factory emits `hookData: ''` (Guidestar convention, what the response
// carries), but ethers' encoder arrayifies hookData and rejects ''. Normalize
// to '0x' only for the encode call; the response swapSteps keep ''.
function withEncodableHookData(steps: SwapStep[]): SwapStep[] {
  const hd = (h: string): string => (h === '' ? '0x' : h);
  return steps.map(step => {
    if (step.type !== 'V4_SWAP') return step;
    return {
      ...step,
      v4Actions: step.v4Actions.map((a): V4Action => {
        switch (a.action) {
          case 'SWAP_EXACT_IN_SINGLE':
          case 'SWAP_EXACT_OUT_SINGLE':
            return {...a, hookData: hd(a.hookData)};
          case 'SWAP_EXACT_IN':
          case 'SWAP_EXACT_OUT':
            return {
              ...a,
              path: a.path.map(p => ({...p, hookData: hd(p.hookData)})),
            };
          default:
            return a;
        }
      }),
    };
  });
}

// Encodes swapSteps into Universal Router calldata, resolving `to` the same way
// the legacy builder does: UR for Permit2, SwapProxy for ApproveProxy.
export function buildSwapStepsMethodParameters(
  swapSteps: SwapStep[],
  spec: SwapSpecification,
  chainId: ChainId
): MethodParameters {
  const {calldata, value} = SwapRouter.encodeSwaps(
    spec,
    withEncodableHookData(swapSteps)
  );
  const to =
    spec.tokenTransferMode === TokenTransferMode.ApproveProxy
      ? SWAP_PROXY_ADDRESS(chainId)
      : getUniversalRouterAddress(spec.urVersion, chainId);
  return {calldata, value, to};
}
