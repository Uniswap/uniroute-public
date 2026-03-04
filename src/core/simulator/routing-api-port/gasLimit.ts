import {BigNumber} from '@ethersproject/bignumber';
import {ChainId} from '@uniswap/sdk-core';

export const ZKSYNC_UPPER_SWAP_GAS_LIMIT = BigNumber.from(6000000);
// CELO high gas limit from SOR https://github.com/Uniswap/smart-order-router/blob/main/src/routers/alpha-router/alpha-router.ts#L670
export const CELO_UPPER_SWAP_GAS_LIMIT = BigNumber.from(5000000);
// https://github.com/Uniswap/routing-api/blob/fe410751985995cb2904837e24f22da7dca1f518/lib/util/onChainQuoteProviderConfigs.ts#L340 divide by 10
export const WORLDCHAIN_UPPER_SWAP_GAS_LIMIT = BigNumber.from(300000);
// https://github.com/Uniswap/routing-api/blob/fe410751985995cb2904837e24f22da7dca1f518/lib/util/onChainQuoteProviderConfigs.ts#L344 divide by 10
export const UNICHAIN_SEPOLIA_UPPER_SWAP_GAS_LIMIT = BigNumber.from(300000);
export const UNICHAIN_UPPER_SWAP_GAS_LIMIT = BigNumber.from(300000);
// https://github.com/Uniswap/smart-order-router/blob/c77d04d334cc1c6694bd74d88287cc5b6e3a7425/src/util/onchainQuoteProviderConfigs.ts#L83 divide by 10
export const BNB_UPPER_SWAP_GAS_LIMIT = BigNumber.from(200000);
// https://github.com/Uniswap/smart-order-router/blob/c77d04d334cc1c6694bd74d88287cc5b6e3a7425/src/util/onchainQuoteProviderConfigs.ts#L83 divide by 10
export const ZORA_UPPER_SWAP_GAS_LIMIT = BigNumber.from(200000);
export const MONAD_UPPER_SWAP_GAS_LIMIT = BigNumber.from(500000);
export const MAINNET_UPPER_SWAP_GAS_LIMIT = BigNumber.from(200000);
export const OPTIMISM_UPPER_SWAP_GAS_LIMIT = BigNumber.from(200000);
export const ARBITRUM_UPPER_SWAP_GAS_LIMIT = BigNumber.from(200000);
export const POLYGON_UPPER_SWAP_GAS_LIMIT = BigNumber.from(200000);
export const BASE_UPPER_SWAP_GAS_LIMIT = BigNumber.from(200000);
export const BASE_SEPOLIA_UPPER_SWAP_GAS_LIMIT = BigNumber.from(200000);
export const SONIUM_UPPER_SWAP_GAS_LIMIT = BigNumber.from(200000);
export const XLAYER_UPPER_SWAP_GAS_LIMIT = BigNumber.from(200000);
export const ARBITRUM_GOERLI_UPPER_SWAP_GAS_LIMIT = BigNumber.from(200000);
export const ARBITRUM_SEPOLIA_UPPER_SWAP_GAS_LIMIT = BigNumber.from(200000);
export const POLYGON_MUMBAI_UPPER_SWAP_GAS_LIMIT = BigNumber.from(200000);
export const LINEA_UPPER_SWAP_GAS_LIMIT = BigNumber.from(200000);

export const CHAIN_TO_GAS_LIMIT_MAP: {[chainId in ChainId]: BigNumber} = {
  [ChainId.MAINNET]: MAINNET_UPPER_SWAP_GAS_LIMIT,
  [ChainId.GOERLI]: BigNumber.from(200000),
  [ChainId.SEPOLIA]: BigNumber.from(200000),
  [ChainId.OPTIMISM]: OPTIMISM_UPPER_SWAP_GAS_LIMIT,
  [ChainId.OPTIMISM_GOERLI]: BigNumber.from(200000),
  [ChainId.OPTIMISM_SEPOLIA]: BigNumber.from(200000),
  [ChainId.ARBITRUM_ONE]: ARBITRUM_UPPER_SWAP_GAS_LIMIT,
  [ChainId.ARBITRUM_GOERLI]: ARBITRUM_GOERLI_UPPER_SWAP_GAS_LIMIT,
  [ChainId.ARBITRUM_SEPOLIA]: ARBITRUM_SEPOLIA_UPPER_SWAP_GAS_LIMIT,
  [ChainId.POLYGON]: POLYGON_UPPER_SWAP_GAS_LIMIT,
  [ChainId.POLYGON_MUMBAI]: POLYGON_MUMBAI_UPPER_SWAP_GAS_LIMIT,
  [ChainId.CELO]: CELO_UPPER_SWAP_GAS_LIMIT,
  [ChainId.CELO_ALFAJORES]: CELO_UPPER_SWAP_GAS_LIMIT,
  [ChainId.GNOSIS]: BigNumber.from(200000),
  [ChainId.MOONBEAM]: BigNumber.from(200000),
  [ChainId.BNB]: BNB_UPPER_SWAP_GAS_LIMIT,
  [ChainId.AVALANCHE]: BigNumber.from(200000),
  [ChainId.BASE_GOERLI]: BigNumber.from(200000),
  [ChainId.BASE_SEPOLIA]: BASE_SEPOLIA_UPPER_SWAP_GAS_LIMIT,
  [ChainId.BASE]: BASE_UPPER_SWAP_GAS_LIMIT,
  [ChainId.ZORA]: ZORA_UPPER_SWAP_GAS_LIMIT,
  [ChainId.ZORA_SEPOLIA]: BigNumber.from(200000),
  [ChainId.ROOTSTOCK]: BigNumber.from(200000),
  [ChainId.BLAST]: BigNumber.from(200000),
  [ChainId.ZKSYNC]: ZKSYNC_UPPER_SWAP_GAS_LIMIT,
  [ChainId.WORLDCHAIN]: WORLDCHAIN_UPPER_SWAP_GAS_LIMIT,
  [ChainId.UNICHAIN_SEPOLIA]: UNICHAIN_SEPOLIA_UPPER_SWAP_GAS_LIMIT,
  [ChainId.UNICHAIN]: UNICHAIN_UPPER_SWAP_GAS_LIMIT,
  [ChainId.SONEIUM]: SONIUM_UPPER_SWAP_GAS_LIMIT,
  [ChainId.XLAYER]: XLAYER_UPPER_SWAP_GAS_LIMIT,
  [ChainId.MONAD_TESTNET]: MONAD_UPPER_SWAP_GAS_LIMIT,
  [ChainId.MONAD]: MONAD_UPPER_SWAP_GAS_LIMIT,
  [ChainId.LINEA]: LINEA_UPPER_SWAP_GAS_LIMIT,
};
