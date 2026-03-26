import {CurrencyAmount as CurrencyAmountRaw, Token} from '@uniswap/sdk-core';
import {
  GasPools,
  getHighestLiquidityV2NativePool,
  getHighestLiquidityV3NativePool,
  getHighestLiquidityV4NativePool,
  getQuoteThroughNativePool,
} from '../gas-helpers';
import {Erc20Token} from 'src/models/token/Erc20Token';
import {Context} from '@uniswap/lib-uni/context';
import {buildMetricKey, ChainId} from '../../../lib/config';
import {IPoolsRepository} from '../../../stores/pool/IPoolsRepository';
import {V3Pool} from '../../../models/pool/V3Pool';
import {getGasToken} from '../../../lib/tokenUtils';
import {QuoteSplit} from '../../../models/quote/QuoteSplit';
import {IGasConverter} from './IGasConverter';
import {V2Pool} from '../../../models/pool/V2Pool';
import {V4Pool} from '../../../models/pool/V4Pool';
import {Pair} from '@uniswap/v2-sdk';
import {Pool as V3SDKPool} from '@uniswap/v3-sdk';
import {Pool as V4SDKPool} from '@uniswap/v4-sdk';

export class GasConverter implements IGasConverter {
  constructor(
    private readonly v2PoolRepository: IPoolsRepository<V2Pool>,
    private readonly v3PoolRepository: IPoolsRepository<V3Pool>,
    private readonly v4PoolRepository: IPoolsRepository<V4Pool>
  ) {}

  private async convertPoolsToSDK(
    chainId: ChainId,
    tokensInfo: Map<string, Erc20Token | null>,
    gasPools: GasPools,
    ctx: Context
  ): Promise<{
    nativeAndQuoteTokenV2PoolSDK: Pair | null;
    nativeAndQuoteTokenV3PoolSDK: V3SDKPool | null;
    nativeAndQuoteTokenV4PoolSDK: V4SDKPool | null;
  }> {
    const nativeAndQuoteTokenV2PoolSDK: Pair | null =
      gasPools.nativeAndQuoteTokenV2Pool
        ? gasPools.nativeAndQuoteTokenV2Pool.toV2SDKPool(
            chainId,
            tokensInfo,
            ctx
          )
        : null;
    const nativeAndQuoteTokenV3PoolSDK: V3SDKPool | null =
      gasPools.nativeAndQuoteTokenV3Pool
        ? gasPools.nativeAndQuoteTokenV3Pool.toV3SDKPool(
            chainId,
            tokensInfo,
            ctx
          )
        : null;
    const nativeAndQuoteTokenV4PoolSDK: V4SDKPool | null =
      gasPools.nativeAndQuoteTokenV4Pool
        ? gasPools.nativeAndQuoteTokenV4Pool.toV4SDKPool(
            chainId,
            tokensInfo,
            ctx
          )
        : null;

    return {
      nativeAndQuoteTokenV2PoolSDK,
      nativeAndQuoteTokenV3PoolSDK,
      nativeAndQuoteTokenV4PoolSDK,
    };
  }

  public async updateQuotesGasDetails(
    chainId: ChainId,
    quoteTokenAddress: string,
    tokensInfo: Map<string, Erc20Token | null>,
    quotes: QuoteSplit[],
    ctx: Context,
    blockNumber?: number
  ): Promise<void> {
    ctx.logger.debug('GasConverter.updateQuotesGasDetails', {
      tokensInfo,
      quoteTokenAddress,
      chainId,
    });

    if (quotes.length === 0) {
      return;
    }

    const quoteTokenInfo = tokensInfo.get(quoteTokenAddress)!;
    const quoteToken = new Token(
      chainId,
      quoteTokenAddress,
      quoteTokenInfo.decimals,
      quoteTokenInfo.symbol,
      quoteTokenInfo.name
    );
    const wrappedNativeCurrency = getGasToken(chainId);
    const wrappedNativeTokenInfo = tokensInfo.get(
      wrappedNativeCurrency.address
    )!;

    // If both USD prices are available, we can derive gasCostInQuoteToken from USD prices
    // without needing to fetch ETH/quoteToken pools
    const canUseUsdPricing =
      wrappedNativeTokenInfo?.priceUSD && quoteTokenInfo?.priceUSD;

    // Only fetch gas pools if USD pricing is not available for the quote token
    let nativeAndQuoteTokenV2PoolSDK: Pair | null = null;
    let nativeAndQuoteTokenV3PoolSDK: V3SDKPool | null = null;
    let nativeAndQuoteTokenV4PoolSDK: V4SDKPool | null = null;

    if (!canUseUsdPricing) {
      const gasPools = await this.fetchGasRelatedPools(
        chainId,
        quoteToken,
        ctx,
        blockNumber
      );
      ({
        nativeAndQuoteTokenV2PoolSDK,
        nativeAndQuoteTokenV3PoolSDK,
        nativeAndQuoteTokenV4PoolSDK,
      } = await this.convertPoolsToSDK(chainId, tokensInfo, gasPools, ctx));
    }

    for (const quoteSplit of quotes) {
      for (const quote of quoteSplit.quotes) {
        // gasCostInWei is always in 18-decimal EVM precision. Scale to gas token decimals
        // (e.g. pathUSD on Tempo has 6 decimals, so divide by 10^12)
        const decimalDiff = 18 - wrappedNativeCurrency.decimals;
        const scaledGasCost =
          decimalDiff > 0
            ? quote.gasDetails!.gasCostInWei / BigInt(10 ** decimalDiff)
            : quote.gasDetails!.gasCostInWei;
        const totalGasCostNativeCurrency =
          CurrencyAmountRaw.fromRawAmount<Token>(
            wrappedNativeCurrency,
            scaledGasCost.toString()
          );

        // Compute gasCostInUSD first (needed for USD-based quote token conversion)
        quote.gasDetails!.gasCostInUSD = wrappedNativeTokenInfo?.priceUSD
          ? wrappedNativeTokenInfo.priceUSD *
            Number(totalGasCostNativeCurrency.toExact())
          : 0;

        if (canUseUsdPricing) {
          // Derive gasCostInQuoteToken from USD prices:
          // gasCostInQuoteToken = (gasCostInUSD / quoteToken.priceUSD) * 10^quoteToken.decimals
          const gasCostInQuoteTokenDecimal =
            quote.gasDetails!.gasCostInUSD / quoteTokenInfo.priceUSD!;
          quote.gasDetails!.gasCostInQuoteToken = BigInt(
            Math.floor(
              gasCostInQuoteTokenDecimal * 10 ** quoteTokenInfo.decimals
            )
          );
        } else {
          // Fallback: use pool-based conversion when USD pricing is not available
          const gasCostInTermsOfQuoteToken =
            await this.convertGasCostToQuoteToken(
              chainId,
              totalGasCostNativeCurrency,
              quoteToken,
              wrappedNativeCurrency,
              nativeAndQuoteTokenV2PoolSDK,
              nativeAndQuoteTokenV3PoolSDK,
              nativeAndQuoteTokenV4PoolSDK,
              ctx
            );

          quote.gasDetails!.gasCostInQuoteToken = gasCostInTermsOfQuoteToken
            ? BigInt(gasCostInTermsOfQuoteToken.quotient.toString())
            : 0n;
        }
      }
    }
  }

  public async getGasCostInQuoteTokenBasedOnGasCostInWei(
    chainId: ChainId,
    quoteTokenAddress: string,
    tokensInfo: Map<string, Erc20Token | null>,
    gasCostInWei: bigint,
    ctx: Context
  ): Promise<bigint> {
    const quoteTokenInfo = tokensInfo.get(quoteTokenAddress)!;
    const wrappedNativeCurrency = getGasToken(chainId);
    const wrappedNativeTokenInfo = tokensInfo.get(
      wrappedNativeCurrency.address
    )!;

    // gasCostInWei is always in 18-decimal EVM precision. Scale to gas token decimals
    const decimalDiff = 18 - wrappedNativeCurrency.decimals;
    const scaledGasCost =
      decimalDiff > 0 ? gasCostInWei / BigInt(10 ** decimalDiff) : gasCostInWei;
    const totalGasCostNativeCurrency = CurrencyAmountRaw.fromRawAmount<Token>(
      wrappedNativeCurrency,
      scaledGasCost.toString()
    );

    // If both USD prices are available, derive from USD pricing directly
    if (wrappedNativeTokenInfo?.priceUSD && quoteTokenInfo?.priceUSD) {
      const gasCostInUSD =
        wrappedNativeTokenInfo.priceUSD *
        Number(totalGasCostNativeCurrency.toExact());
      const gasCostInQuoteTokenDecimal = gasCostInUSD / quoteTokenInfo.priceUSD;
      return BigInt(
        Math.floor(gasCostInQuoteTokenDecimal * 10 ** quoteTokenInfo.decimals)
      );
    }

    // Fallback: use pool-based conversion
    const quoteToken = new Token(
      chainId,
      quoteTokenAddress,
      quoteTokenInfo.decimals,
      quoteTokenInfo.symbol,
      quoteTokenInfo.name
    );
    const gasPools = await this.fetchGasRelatedPools(chainId, quoteToken, ctx);
    const {
      nativeAndQuoteTokenV2PoolSDK,
      nativeAndQuoteTokenV3PoolSDK,
      nativeAndQuoteTokenV4PoolSDK,
    } = await this.convertPoolsToSDK(chainId, tokensInfo, gasPools, ctx);

    const gasCostInTermsOfQuoteToken = await this.convertGasCostToQuoteToken(
      chainId,
      totalGasCostNativeCurrency,
      quoteToken,
      wrappedNativeCurrency,
      nativeAndQuoteTokenV2PoolSDK,
      nativeAndQuoteTokenV3PoolSDK,
      nativeAndQuoteTokenV4PoolSDK,
      ctx
    );

    return gasCostInTermsOfQuoteToken
      ? BigInt(gasCostInTermsOfQuoteToken.quotient.toString())
      : 0n;
  }

  public getGasCostInUSDBasedOnGasCostInWei(
    chainId: ChainId,
    tokensInfo: Map<string, Erc20Token | null>,
    gasCostInWei: bigint
  ): number {
    const wrappedNativeCurrency = getGasToken(chainId);
    const wrappedNativeTokenInfo = tokensInfo.get(
      wrappedNativeCurrency.address
    );

    if (!wrappedNativeTokenInfo?.priceUSD) {
      return 0;
    }

    // gasCostInWei is always in 18-decimal EVM precision. Scale to gas token decimals
    const decimalDiff = 18 - wrappedNativeCurrency.decimals;
    const scaledGasCost =
      decimalDiff > 0 ? gasCostInWei / BigInt(10 ** decimalDiff) : gasCostInWei;
    const totalGasCostNativeCurrency = CurrencyAmountRaw.fromRawAmount<Token>(
      wrappedNativeCurrency,
      scaledGasCost.toString()
    );

    return (
      wrappedNativeTokenInfo.priceUSD *
      Number(totalGasCostNativeCurrency.toExact())
    );
  }

  private async convertGasCostToQuoteToken(
    chainId: ChainId,
    totalGasCostNativeCurrency: CurrencyAmountRaw<Token>,
    quoteToken: Token,
    wrappedNativeCurrency: Token,
    nativeAndQuoteTokenV2PoolSDK: Pair | null,
    nativeAndQuoteTokenV3PoolSDK: V3SDKPool | null,
    nativeAndQuoteTokenV4PoolSDK: V4SDKPool | null,
    ctx: Context
  ): Promise<CurrencyAmountRaw<Token> | null> {
    if (quoteToken.equals(wrappedNativeCurrency)) {
      return totalGasCostNativeCurrency;
    }

    try {
      if (nativeAndQuoteTokenV3PoolSDK) {
        return getQuoteThroughNativePool(
          chainId,
          totalGasCostNativeCurrency,
          nativeAndQuoteTokenV3PoolSDK
        );
      } else if (nativeAndQuoteTokenV2PoolSDK) {
        return getQuoteThroughNativePool(
          chainId,
          totalGasCostNativeCurrency,
          nativeAndQuoteTokenV2PoolSDK
        );
      } else if (nativeAndQuoteTokenV4PoolSDK) {
        return getQuoteThroughNativePool(
          chainId,
          totalGasCostNativeCurrency,
          nativeAndQuoteTokenV4PoolSDK
        );
      } else {
        ctx.logger.debug('GasConverter.convertGasCostToQuoteToken', {
          message: 'No gas pools found for quote token',
          quoteToken,
          chainId,
        });
        return null;
      }
    } catch (error) {
      ctx.logger.error('GasConverter.convertGasCostToQuoteToken', {
        message:
          'Error converting gas cost to quote token (likely division by zero)',
        error,
        quoteToken,
        chainId,
      });
      await ctx.metrics.count(
        buildMetricKey('GasConverter.ExceptionThrown'),
        1,
        {
          tags: [`chain:${ChainId[chainId]}`],
        }
      );
      return null;
    }
  }

  private async fetchGasRelatedPools(
    chainId: ChainId,
    quoteToken: Token,
    ctx: Context,
    blockNumber?: number
  ): Promise<GasPools> {
    const wrappedCurrency = getGasToken(chainId);

    let nativeAndQuoteTokenPoolPromiseV2: Promise<V2Pool | null> | null = null;
    let nativeAndQuoteTokenPoolPromiseV3: Promise<V3Pool | null> | null = null;
    let nativeAndQuoteTokenPoolPromiseV4: Promise<V4Pool | null> | null = null;

    // If the quote token is the wrapped native currency, we don't need to fetch the native and quote token pool
    if (!wrappedCurrency.equals(quoteToken)) {
      nativeAndQuoteTokenPoolPromiseV2 = getHighestLiquidityV2NativePool(
        quoteToken,
        this.v2PoolRepository,
        ctx,
        blockNumber
      );
      nativeAndQuoteTokenPoolPromiseV3 = getHighestLiquidityV3NativePool(
        quoteToken,
        this.v3PoolRepository,
        ctx,
        blockNumber
      );
      nativeAndQuoteTokenPoolPromiseV4 = getHighestLiquidityV4NativePool(
        quoteToken,
        this.v4PoolRepository,
        ctx,
        blockNumber
      );
    }

    const [
      nativeAndQuoteTokenV2Pool,
      nativeAndQuoteTokenV3Pool,
      nativeAndQuoteTokenV4Pool,
    ] = await Promise.all([
      nativeAndQuoteTokenPoolPromiseV2,
      nativeAndQuoteTokenPoolPromiseV3,
      nativeAndQuoteTokenPoolPromiseV4,
    ]);

    return {
      nativeAndQuoteTokenV2Pool,
      nativeAndQuoteTokenV3Pool,
      nativeAndQuoteTokenV4Pool,
    };
  }
}
