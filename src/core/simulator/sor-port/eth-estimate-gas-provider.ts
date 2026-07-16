import {JsonRpcProvider} from '@ethersproject/providers';
import {ChainId} from '../../../lib/config';

import {
  Simulator,
  SwapOptionsUniversalRouter,
  SwapType,
} from './simulation-provider';
import {Context} from '@uniswap/lib-uni/context';
import {BEACON_CHAIN_DEPOSIT_ADDRESS} from '../../../lib/helpers';
import {QuoteSplit} from '../../../models/quote/QuoteSplit';
import {TradeType} from '../../../models/quote/TradeType';
import {GasConverter} from '../../gas/converter/GasConverter';
import {BigNumber} from '@ethersproject/bignumber';
import {SimulationStatus} from '../ISimulator';
import {ResolvedStateOverride} from '../ResolvedStateOverride';
import {breakDownSimulationError} from './simulationErrorBreakDown';

// We multiply eth estimate gas by this to add a buffer for gas limits
const DEFAULT_ESTIMATE_MULTIPLIER = 1.2;

const MAX_REVERT_DATA_SEARCH_DEPTH = 5;
const REVERT_DATA_REGEX = /^0x[0-9a-f]{8,}$/i;

/**
 * Digs the JSON-RPC revert data out of an ethers v5 estimateGas error.
 * Depending on how the provider wraps the failure, the data sits at
 * `e.data`, `e.error.data`, `e.error.error.data`, or inside the raw JSON
 * `body` string, so search those keys recursively (bounded).
 */
export function extractRevertData(
  value: unknown,
  depth = 0
): string | undefined {
  if (
    value === null ||
    value === undefined ||
    depth > MAX_REVERT_DATA_SEARCH_DEPTH
  ) {
    return undefined;
  }
  if (typeof value === 'string') {
    try {
      return extractRevertData(JSON.parse(value), depth + 1);
    } catch {
      return undefined;
    }
  }
  if (typeof value !== 'object') {
    return undefined;
  }
  const candidate = value as {data?: unknown; error?: unknown; body?: unknown};
  if (
    typeof candidate.data === 'string' &&
    REVERT_DATA_REGEX.test(candidate.data)
  ) {
    return candidate.data;
  }
  return (
    extractRevertData(candidate.data, depth + 1) ??
    extractRevertData(candidate.error, depth + 1) ??
    extractRevertData(candidate.body, depth + 1)
  );
}

export class EthEstimateGasSimulator extends Simulator {
  private overrideEstimateMultiplier: {[chainId in ChainId]?: number};
  private gasConverter: GasConverter;

  constructor(
    chainId: ChainId,
    provider: JsonRpcProvider,
    gasConverter: GasConverter,
    overrideEstimateMultiplier?: {[chainId in ChainId]?: number}
  ) {
    super(provider, chainId);
    this.gasConverter = gasConverter;
    this.overrideEstimateMultiplier = overrideEstimateMultiplier ?? {};
  }

  async ethEstimateGas(
    fromAddress: string,
    swapOptions: SwapOptionsUniversalRouter,
    quoteSplit: QuoteSplit,
    ctx: Context,
    blockNumber?: number
  ): Promise<QuoteSplit> {
    // `stateOverrides` is intentionally not threaded here — `eth_estimateGas`
    // state-override support is a non-standard Geth extension and provider-
    // dependent. Override-bearing requests are routed to eth_simulateV1 /
    // Tenderly upstream in `FallbackTenderlySimulator`.
    let estimatedGasUsed: BigNumber;
    if (swapOptions.type === SwapType.UNIVERSAL_ROUTER) {
      if (
        quoteSplit.swapInfo!.tokenInIsNative &&
        this.chainId === ChainId.MAINNET
      ) {
        // w/o this gas estimate differs by a lot depending on if user holds enough native balance
        // always estimate gas as if user holds enough balance
        // so that gas estimate is consistent for UniswapX. Override-bearing
        // requests never reach this fast path — FallbackTenderlySimulator
        // routes them to eth_simulateV1/Tenderly where overrides apply.
        fromAddress = BEACON_CHAIN_DEPOSIT_ADDRESS;
      }
      ctx.logger.info('Simulating using eth_estimateGas on Universal Router', {
        addr: fromAddress,
        methodParameters: quoteSplit.swapInfo!.methodParameters,
      });
      try {
        estimatedGasUsed = await this.provider.estimateGas({
          data: quoteSplit.swapInfo!.methodParameters!.calldata,
          to: quoteSplit.swapInfo!.methodParameters!.to,
          from: fromAddress,
          value: BigInt(
            quoteSplit.swapInfo!.tokenInIsNative
              ? quoteSplit.swapInfo!.methodParameters!.value
              : '0'
          ),
          ...(blockNumber !== undefined ? {blockTag: blockNumber} : {}),
        });
      } catch (e) {
        const revertData = extractRevertData(e);
        ctx.logger.error('Error estimating gas', {e, revertData});
        // Parity with the eth_simulateV1 path: map the revert data to a
        // specific SimulationStatus (e.g. SLIPPAGE_TOO_LOW) instead of a
        // generic FAILED, so callers can distinguish slippage from real
        // failures.
        return {
          ...quoteSplit,
          simulationResult: {
            estimatedGasUsed: 0n,
            estimatedGasUsedInQuoteToken: 0n,
            estimatedGasUsedInUSD: 0,
            status: breakDownSimulationError(
              quoteSplit.swapInfo!.tokenInWrappedAddress,
              quoteSplit.swapInfo!.tokenOutWrappedAddress,
              revertData
            ),
            description: revertData
              ? 'Transaction reverted during eth_estimateGas'
              : 'Error estimating gas',
          },
        };
      }
    } else {
      throw new Error(`Unsupported swap type ${swapOptions}`);
    }

    estimatedGasUsed = this.adjustGasEstimate(estimatedGasUsed);
    ctx.logger.info('Simulated using eth_estimateGas', {
      methodParameters: quoteSplit.swapInfo!.methodParameters,
      estimatedGasUsed: estimatedGasUsed.toString(),
    });

    // Get the gas cost in terms of the quote token based on the estimatedGasUsed
    const quoteTokenAddress =
      quoteSplit.swapInfo!.tradeType === TradeType.ExactIn
        ? quoteSplit.swapInfo!.tokenOutWrappedAddress
        : quoteSplit.swapInfo!.tokenInWrappedAddress;

    // Use gas price from first quote since it should be the same for all quotes
    const gasPriceWei = quoteSplit.quotes[0]!.gasDetails!.gasPriceInWei;
    const gasCostInWei = estimatedGasUsed
      .mul(BigNumber.from(gasPriceWei))
      .toBigInt();
    const gasCostInQuoteToken =
      await this.gasConverter.getGasCostInQuoteTokenBasedOnGasCostInWei(
        this.chainId,
        quoteTokenAddress,
        quoteSplit.tokensInfo!,
        gasCostInWei,
        ctx
      );
    const gasCostInUSD = this.gasConverter.getGasCostInUSDBasedOnGasCostInWei(
      this.chainId,
      quoteSplit.tokensInfo!,
      gasCostInWei
    );

    return {
      ...quoteSplit,
      simulationResult: {
        estimatedGasUsed: estimatedGasUsed.toBigInt(),
        estimatedGasUsedInQuoteToken: gasCostInQuoteToken,
        estimatedGasUsedInUSD: gasCostInUSD,
        status: SimulationStatus.SUCCESS,
        description: 'Simulation succeeded via eth_estimateGas',
      },
    };
  }

  private adjustGasEstimate(gasLimit: BigNumber): BigNumber {
    const estimateMultiplier =
      this.overrideEstimateMultiplier[this.chainId] ??
      DEFAULT_ESTIMATE_MULTIPLIER;

    return BigNumber.from(gasLimit)
      .mul(estimateMultiplier * 100)
      .div(100);
  }

  protected async simulateTransaction(
    fromAddress: string,
    swapOptions: SwapOptionsUniversalRouter,
    quoteSplit: QuoteSplit,
    ctx: Context,
    gasPrice?: bigint,
    blockNumber?: number,
    _stateOverrides?: ResolvedStateOverride[]
  ): Promise<QuoteSplit> {
    const inputAmount = quoteSplit.swapInfo!.inputAmount;
    if (
      quoteSplit.swapInfo!.tokenInIsNative ||
      (await this.checkTokenApproved(
        fromAddress,
        quoteSplit.swapInfo!.tokenInWrappedAddress,
        inputAmount,
        swapOptions,
        this.provider,
        ctx
      ))
    ) {
      return await this.ethEstimateGas(
        fromAddress,
        swapOptions,
        quoteSplit,
        ctx,
        blockNumber
      );
    } else {
      ctx.logger.info('Token not approved, skipping simulation');
      return {
        ...quoteSplit,
        simulationResult: {
          estimatedGasUsed: 0n,
          estimatedGasUsedInQuoteToken: 0n,
          estimatedGasUsedInUSD: 0,
          status: SimulationStatus.NOT_APPROVED,
          description: 'Token not approved, skipping simulation',
        },
      };
    }
  }
}
