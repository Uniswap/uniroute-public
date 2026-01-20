import {ChainId} from '../../lib/config';
import {CurrencyAmount as CurrencyAmountRaw, Token} from '@uniswap/sdk-core';
import {Pair} from '@uniswap/v2-sdk';
import {Pool as V3SDKPool} from '@uniswap/v3-sdk';
import {Pool as V4SDKPool} from '@uniswap/v4-sdk';

import {
  CUSD_CELO,
  DAI_ARBITRUM,
  DAI_AVAX,
  DAI_BNB,
  DAI_MAINNET,
  DAI_OPTIMISM,
  DAI_SEPOLIA,
  DAI_UNICHAIN,
  DAI_ZKSYNC,
  USDB_BLAST,
  USDC_ARBITRUM,
  USDC_AVAX,
  USDC_BASE,
  USDC_BASE_SEPOLIA,
  USDC_BNB,
  USDC_BRIDGED_AVAX,
  USDC_CELO,
  USDC_MAINNET,
  USDC_MONAD,
  USDC_NATIVE_ARBITRUM,
  USDC_NATIVE_AVAX,
  USDC_NATIVE_BASE,
  USDC_NATIVE_CELO,
  USDC_NATIVE_OPTIMISM,
  USDC_NATIVE_POLYGON,
  USDC_OPTIMISM,
  USDC_POLYGON,
  USDC_SEPOLIA,
  USDC_SONEIUM,
  USDC_UNICHAIN,
  USDC_UNICHAIN_SEPOLIA,
  USDC_WORLDCHAIN,
  USDC_WORMHOLE_CELO,
  USDC_XLAYER,
  USDC_ZKSYNC,
  USDC_ZORA,
  USDCE_ZKSYNC,
  USDT_ARBITRUM,
  USDT_BNB,
  USDT_MAINNET,
  USDT_MONAD_TESTNET,
  USDT_OPTIMISM,
  WRAPPED_NATIVE_CURRENCY,
} from '../../lib/tokenUtils';
import {Context} from '@uniswap/lib-uni/context';
import {IPoolsRepository} from '../../stores/pool/IPoolsRepository';
import {V3Pool} from '../../models/pool/V3Pool';
import {Address} from '../../models/address/Address';
import {V2Pool} from '../../models/pool/V2Pool';
import {V4Pool} from '../../models/pool/V4Pool';

export const ARB_GASINFO_ADDRESS = '0x000000000000000000000000000000000000006C';

// When adding new usd gas tokens, ensure the tokens are ordered
// from tokens with highest decimals to lowest decimals. For example,
// DAI_AVAX has 18 decimals and comes before USDC_AVAX which has 6 decimals.
export const usdGasTokensByChain: {[chainId in ChainId]?: Token[]} = {
  [ChainId.MAINNET]: [DAI_MAINNET, USDC_MAINNET, USDT_MAINNET],
  [ChainId.ARBITRUM]: [
    DAI_ARBITRUM,
    USDC_ARBITRUM,
    USDC_NATIVE_ARBITRUM,
    USDT_ARBITRUM,
  ],
  [ChainId.OPTIMISM]: [
    DAI_OPTIMISM,
    USDC_OPTIMISM,
    USDC_NATIVE_OPTIMISM,
    USDT_OPTIMISM,
  ],
  [ChainId.SEPOLIA]: [USDC_SEPOLIA, DAI_SEPOLIA],
  [ChainId.POLYGON]: [USDC_POLYGON, USDC_NATIVE_POLYGON],
  [ChainId.CELO]: [CUSD_CELO, USDC_CELO, USDC_NATIVE_CELO, USDC_WORMHOLE_CELO],
  [ChainId.BNB]: [USDT_BNB, USDC_BNB, DAI_BNB],
  [ChainId.AVAX]: [DAI_AVAX, USDC_AVAX, USDC_NATIVE_AVAX, USDC_BRIDGED_AVAX],
  [ChainId.BASE]: [USDC_BASE, USDC_NATIVE_BASE],
  [ChainId.BLAST]: [USDB_BLAST],
  [ChainId.ZORA]: [USDC_ZORA],
  [ChainId.ZKSYNC]: [DAI_ZKSYNC, USDCE_ZKSYNC, USDC_ZKSYNC],
  [ChainId.WORLDCHAIN]: [USDC_WORLDCHAIN],
  [ChainId.UNICHAIN_SEPOLIA]: [USDC_UNICHAIN_SEPOLIA],
  [ChainId.MONAD_TESTNET]: [USDT_MONAD_TESTNET],
  [ChainId.BASE_SEPOLIA]: [USDC_BASE_SEPOLIA],
  [ChainId.UNICHAIN]: [DAI_UNICHAIN, USDC_UNICHAIN],
  [ChainId.SONEIUM]: [USDC_SONEIUM],
  [ChainId.MONAD]: [USDC_MONAD],
  [ChainId.XLAYER]: [USDC_XLAYER],
};

export type GasPools = {
  nativeAndQuoteTokenV2Pool: V2Pool | null;
  nativeAndQuoteTokenV3Pool: V3Pool | null;
  nativeAndQuoteTokenV4Pool: V4Pool | null;
};

// Determines if native currency is token0
// Gets the native price of the pool, dependent on 0 or 1
// quotes across the pool
//
// NOTE: This function can throw a "Division by zero" error if the pool has zero liquidity
// or is in an invalid state, causing the price denominator to be zero. When Price.quote()
// is called, it internally performs a division operation via Fraction.divide() -> JSBI.divide(),
// which throws RangeError if the denominator is zero. This error is caught and handled
// in GasConverter.convertGasCostToQuoteToken().
export const getQuoteThroughNativePool = (
  chainId: ChainId,
  nativeTokenAmount: CurrencyAmountRaw<Token>,
  nativeTokenPool: V3SDKPool | V4SDKPool | Pair
): CurrencyAmountRaw<Token> => {
  const nativeCurrency = WRAPPED_NATIVE_CURRENCY[chainId];
  const isToken0 = nativeTokenPool.token0.equals(nativeCurrency);
  // returns mid price in terms of the native currency (the ratio of token/nativeToken)
  const nativeTokenPrice = isToken0
    ? nativeTokenPool.token0Price
    : nativeTokenPool.token1Price;
  // return gas cost in terms of the non native currency
  // This can throw RangeError: Division by zero if price denominator is zero
  return nativeTokenPrice.quote(nativeTokenAmount) as CurrencyAmountRaw<Token>;
};

export async function getHighestLiquidityV2NativePool(
  token: Token,
  v2PoolsRepository: IPoolsRepository<V2Pool>,
  ctx: Context
): Promise<V2Pool | null> {
  const nativeCurrency = WRAPPED_NATIVE_CURRENCY[token.chainId as ChainId]!;

  const pools = await v2PoolsRepository.getPools(
    ctx,
    token.chainId,
    new Address(nativeCurrency.address),
    new Address(token.address)
  );

  if (pools.length === 0) {
    return null;
  }

  return pools[0];
}

export async function getHighestLiquidityV3NativePool(
  token: Token,
  v3PoolsRepository: IPoolsRepository<V3Pool>,
  ctx: Context
): Promise<V3Pool | null> {
  const nativeCurrency = WRAPPED_NATIVE_CURRENCY[token.chainId as ChainId]!;

  const pools = await v3PoolsRepository.getPools(
    ctx,
    token.chainId,
    new Address(nativeCurrency.address),
    new Address(token.address)
  );

  if (pools.length === 0) {
    return null;
  }

  return pools.reduce((prev, current) => {
    return prev.liquidity > current.liquidity ? prev : current;
  });
}

export async function getHighestLiquidityV4NativePool(
  token: Token,
  v4PoolsRepository: IPoolsRepository<V4Pool>,
  ctx: Context
): Promise<V4Pool | null> {
  const nativeCurrency = WRAPPED_NATIVE_CURRENCY[token.chainId as ChainId]!;

  const pools = await v4PoolsRepository.getPools(
    ctx,
    token.chainId,
    new Address(nativeCurrency.address),
    new Address(token.address)
  );

  if (pools.length === 0) {
    return null;
  }

  return pools.reduce((prev, current) => {
    return prev.liquidity > current.liquidity ? prev : current;
  });
}
