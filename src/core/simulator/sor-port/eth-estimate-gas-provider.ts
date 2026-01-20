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

// We multiply eth estimate gas by this to add a buffer for gas limits
const DEFAULT_ESTIMATE_MULTIPLIER = 1.2;

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
    ctx: Context
  ): Promise<QuoteSplit> {
    let estimatedGasUsed: BigNumber;
    if (swapOptions.type === SwapType.UNIVERSAL_ROUTER) {
      if (
        quoteSplit.swapInfo!.tokenInIsNative &&
        this.chainId === ChainId.MAINNET
      ) {
        // w/o this gas estimate differs by a lot depending on if user holds enough native balance
        // always estimate gas as if user holds enough balance
        // so that gas estimate is consistent for UniswapX
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
        });
      } catch (e) {
        ctx.logger.error('Error estimating gas', {e});
        return {
          ...quoteSplit,
          simulationResult: {
            estimatedGasUsed: 0n,
            estimatedGasUsedInQuoteToken: 0n,
            status: SimulationStatus.FAILED,
            description: 'Error estimating gas',
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
    const gasCostInQuoteToken =
      await this.gasConverter.getGasCostInQuoteTokenBasedOnGasCostInWei(
        this.chainId,
        quoteTokenAddress,
        quoteSplit.tokensInfo!,
        estimatedGasUsed.mul(BigNumber.from(gasPriceWei)).toBigInt(),
        ctx
      );

    return {
      ...quoteSplit,
      simulationResult: {
        estimatedGasUsed: estimatedGasUsed.toBigInt(),
        estimatedGasUsedInQuoteToken: gasCostInQuoteToken,
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
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    gasPrice?: bigint,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    blockNumber?: number
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
        ctx
      );
    } else {
      ctx.logger.info('Token not approved, skipping simulation');
      return {
        ...quoteSplit,
        simulationResult: {
          estimatedGasUsed: 0n,
          estimatedGasUsedInQuoteToken: 0n,
          status: SimulationStatus.NOT_APPROVED,
          description: 'Token not approved, skipping simulation',
        },
      };
    }
  }
}
