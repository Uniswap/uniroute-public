import {buildMetricKey, ChainId} from '../../lib/config';
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
  USDC_LINEA,
  USDM_MEGAETH,
  USDG_ROBINHOOD,
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
  PATHUSD_TEMPO,
  USDC_ARC,
  USDC_INK,
  getGasToken,
} from '../../lib/tokenUtils';
import {Context} from '@uniswap/lib-uni/context';
import {IPoolsRepository} from '../../stores/pool/IPoolsRepository';
import {V3Pool} from '../../models/pool/V3Pool';
import {Address} from '../../models/address/Address';
import {V2Pool} from '../../models/pool/V2Pool';
import {V4Pool} from '../../models/pool/V4Pool';
import {Protocol} from '../../models/pool/Protocol';

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
  [ChainId.CELO]: [CUSD_CELO, USDC_NATIVE_CELO, USDC_WORMHOLE_CELO],
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
  [ChainId.TEMPO]: [PATHUSD_TEMPO],
  [ChainId.LINEA]: [USDC_LINEA],
  [ChainId.ARC]: [USDC_ARC],
  [ChainId.MEGAETH]: [USDM_MEGAETH],
  [ChainId.ROBINHOOD]: [USDG_ROBINHOOD],
  [ChainId.INK]: [USDC_INK],
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
  const gasToken = getGasToken(chainId);
  const isToken0 = nativeTokenPool.token0.equals(gasToken);
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
  ctx: Context,
  blockNumber?: number
): Promise<V2Pool | null> {
  const gasToken = getGasToken(token.chainId as ChainId);

  const pools = await v2PoolsRepository.getPools(
    ctx,
    token.chainId,
    new Address(gasToken.address),
    new Address(token.address),
    undefined,
    undefined,
    undefined,
    undefined,
    blockNumber
  );

  const fundedPools = pools.filter(
    pool => pool.reserve0 > 0n && pool.reserve1 > 0n
  );
  if (fundedPools.length === 0) {
    if (pools.length > 0) {
      countAllGasPoolsEmpty(ctx, token.chainId, Protocol.V2);
    }
    return null;
  }

  return fundedPools[0];
}

export async function getHighestLiquidityV3NativePool(
  token: Token,
  v3PoolsRepository: IPoolsRepository<V3Pool>,
  ctx: Context,
  blockNumber?: number
): Promise<V3Pool | null> {
  const gasToken = getGasToken(token.chainId as ChainId);

  const pools = await v3PoolsRepository.getPools(
    ctx,
    token.chainId,
    new Address(gasToken.address),
    new Address(token.address),
    undefined,
    undefined,
    undefined,
    undefined,
    blockNumber
  );

  return pickHighestActiveLiquidityPool(pools, token.chainId, ctx);
}

export async function getHighestLiquidityV4NativePool(
  token: Token,
  v4PoolsRepository: IPoolsRepository<V4Pool>,
  ctx: Context,
  blockNumber?: number
): Promise<V4Pool | null> {
  const gasToken = getGasToken(token.chainId as ChainId);

  const pools = await v4PoolsRepository.getPools(
    ctx,
    token.chainId,
    new Address(gasToken.address),
    new Address(token.address),
    undefined,
    undefined,
    undefined,
    undefined,
    blockNumber
  );

  return pickHighestActiveLiquidityPool(pools, token.chainId, ctx);
}

// A concentrated-liquidity pool with no liquidity at its current price has a
// price nothing anchors: a drained pool sits wherever the last swap left it,
// often MIN/MAX tick, a mid price off by dozens of orders of magnitude that
// nothing downstream bounds. Such a pool says nothing about the token's value,
// so it is never a gas-conversion candidate, however few others exist.
//
// Only exactly-zero liquidity is excluded. A pool with dust in-range liquidity
// can still sit at an extreme price and pass; no liquidity floor is applied
// because in-range liquidity alone cannot tell a dust pool from a deep pool
// whose positions are mostly out of range.
function pickHighestActiveLiquidityPool<TPool extends V3Pool | V4Pool>(
  pools: TPool[],
  chainId: number,
  ctx: Context
): TPool | null {
  const activePools = pools.filter(pool => pool.liquidity > 0n);
  if (activePools.length === 0) {
    if (pools.length > 0) {
      countAllGasPoolsEmpty(ctx, chainId, pools[0].protocol);
    }
    return null;
  }

  return activePools.reduce((prev, current) => {
    return prev.liquidity > current.liquidity ? prev : current;
  });
}

// Counted per protocol, only when every candidate of that protocol was empty;
// skipping one dead tier next to a funded pool changes nothing and is not
// counted. Another protocol may still price the gas, so whether the
// conversion as a whole fell back to zero is GasConverter.NoGasPool.
function countAllGasPoolsEmpty(
  ctx: Context,
  chainId: number,
  protocol: Protocol
): void {
  void ctx.metrics
    .count(buildMetricKey('GasConverter.AllGasPoolsEmpty'), 1, {
      tags: [
        `chain:${ChainId[chainId]}`,
        `protocol:${protocol}`,
        'status:failure',
        'reason:zero_liquidity',
      ],
    })
    .catch(() => undefined);
}
