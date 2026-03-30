import {ChainId} from '@uniswap/sdk-core';

type MajorTokensByChain = Partial<Record<ChainId, string[]>> &
  Record<number, string[]>;

// TEMPO is not yet in sdk-core 7.11.0 — define locally until sdk-core is upgraded
const CHAIN_ID_TEMPO = 4217 as ChainId;

const MAJOR_TOKENS_BY_CHAIN: MajorTokensByChain = {
  // Source: https://github.com/Uniswap/v4-subgraph/blob/main/src/utils/chains.ts (whitelistTokens)
  [ChainId.MAINNET]: [
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // WETH
    '0x6b175474e89094c44da98b954eedeac495271d0f', // DAI
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
    '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT
    '0x0000000000085d4780b73119b644ae5ecd22b376', // TUSD
    '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', // WBTC
    '0x5d3a536e4d6dbd6114cc1ead35777bab948e3643', // cDAI
    '0x39aa39c021dfbae8fac545936693ac917d5e7563', // cUSDC
    '0x86fadb80d8d2cff3c3680819e4da99c10232ba0f', // EBASE
    '0x57ab1ec28d129707052df4df418d58a2d46d5f51', // sUSD
    '0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2', // MKR
    '0xc00e94cb662c3520282e6f5717214004a7f26888', // COMP
    '0x514910771af9ca656af840dff83e8264ecf986ca', // LINK
    '0xc011a73ee8576fb46f5e1c5751ca3b9fe0af2a6f', // SNX
    '0x0bc529c00c6401aef6d220be8c6ea1667f6ad93e', // YFI
    '0x111111111117dc0aa78b770fa6a738034120c302', // 1INCH
    '0xdf5e0e81dff6faf3a7e52ba697820c5e32d806a8', // yCurv
    '0x956f47f50a910163d8bf957cf5846d573e7f87ca', // FEI
    '0x7d1afa7b718fb893db30a3abc0cfc608aacfebb0', // MATIC
    '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9', // AAVE
    '0xfe2e637202056d30016725477c5da089ab0a043a', // sETH2
    '0x0000000000000000000000000000000000000000', // Native ETH
  ],
  [ChainId.SEPOLIA]: [
    '0x0000000000000000000000000000000000000000', // Native ETH
    '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238', // USDC
    '0xaa8e23fb1079ea71e0a56f48a2aa51851d8433d0', // USDT
    '0xfff9976782d46cc05630d1f6ebab18b2324d6b14', // WETH
  ],
  [ChainId.ARBITRUM_ONE]: [
    '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', // WETH
    '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8', // USDC.e
    '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1', // DAI
    '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', // USDT
    '0xaf88d065e77c8cc2239327c5edb3a432268e5831', // USDC
    '0x0000000000000000000000000000000000000000', // Native ETH
  ],
  [ChainId.BASE]: [
    '0x4200000000000000000000000000000000000006', // WETH
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC
    '0x0000000000000000000000000000000000000000', // Native ETH
    '0x1111111111166b7fe7bd91427724b487980afc69', // ZORA
  ],
  [ChainId.POLYGON]: [
    '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270', // WMATIC
    '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619', // WETH
    '0x2791bca1f2de4661ed88a30c99a7a9449aa84174', // USDC.e
    '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063', // DAI
    '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', // USDC
    '0x0000000000000000000000000000000000000000', // Native POL
  ],
  [ChainId.BNB]: [
    '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', // WBNB
    '0x55d398326f99059ff775485246999027b3197955', // USDT
    '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', // USDC
    '0x0000000000000000000000000000000000000000', // Native BNB
  ],
  [ChainId.OPTIMISM]: [
    '0x4200000000000000000000000000000000000006', // WETH
    '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1', // DAI
    '0x7f5c764cbc14f9669b88837ca1490cca17c31607', // USDC.e
    '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58', // USDT
    '0x4200000000000000000000000000000000000042', // OP
    '0x9e1028f5f1d5ede59748ffcee5532509976840e0', // PERP
    '0x50c5725949a6f0c72e6c4a641f24049a917db0cb', // LYRA
    '0x68f180fcce6836688e9084f035309e29bf0a2095', // WBTC
    '0x0b2c639c533813f4aa9d7837caf62653d097ff85', // USDC
    '0x0000000000000000000000000000000000000000', // Native ETH
  ],
  [ChainId.AVALANCHE]: [
    '0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7', // WAVAX
    '0xd586e7f844cea2f87f50152665bcbc2c279d8d70', // DAI.e
    '0xba7deebbfc5fa1100fb055a87773e1e99cd3507a', // DAI
    '0xa7d7079b0fead91f3e65f86e8915cb59c1a4c664', // USDC.e
    '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e', // USDC
    '0xc7198437980c041c805a1edcba50c1ce5db95118', // USDT.e
    '0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7', // USDT
    '0x130966628846bfd36ff31a822705796e8cb8c18d', // MIM
    '0x0000000000000000000000000000000000000000', // Native AVAX
  ],
  [ChainId.UNICHAIN]: [
    '0x4200000000000000000000000000000000000006', // WETH
    '0x078d782b760474a361dda0af3839290b0ef57ad6', // USDC
    '0x20cab320a855b39f724131c69424240519573f81', // DAI
    '0x0000000000000000000000000000000000000000', // Native ETH
    '0x9151434b16b9763660705744891fa906f660ecc5', // USDT0
    '0x927b51f251480a681271180da4de28d44ec4afb8', // WBTC
  ],
  [ChainId.MONAD]: [
    '0x3bd359c1119da7da1d913d1c4d2b7c461115433a', // WMON
    '0x754704bc059f8c67012fed69bc8a327a5aafb603', // USDC
    '0x00000000efe302beaa2b3e6e1b18d08d69a9012a', // AUSD
    '0x0000000000000000000000000000000000000000', // Native MON
    '0xe7cd86e13ac4309349f30b3435a9d337750fc82d', // USDT
    '0xee8c0e9f1bffb4eb878d8f15f368a02a35481242', // WETH
    '0xea17e5a9efebf1477db45082d67010e2245217f1', // WSOL
    '0x0555e30da8f98308edb960aa94c0db47230d2b9c', // WBTC
  ],
  [ChainId.XLAYER]: [
    '0xe538905cf8410324e03a5a23c1c177a474d59b2b', // WOKB
    '0x5a77f1443d16ee5761d310e38b62f77f726bc71c', // WETH
    '0x1e4a5963abfd975d8c9021ce480b42188849d41d', // USDT
    '0x779ded0c9e1022225f8e0630b35a9b54be713736', // USDT0
    '0x74b7f16337b8972027f6196a17a631ac6de26d22', // USDC
    '0xa8ce8aee21bc2a48a5ef670afcc9274c7bbbc035', // USDC.e
    '0xea034fb02eb1808c2cc3adbc15f447b93cbe08e1', // WBTC
    '0xc5015b9d9161dca7e18e32f6f25c4ad850731fd4', // DAI
    '0xe7b000003a45145decf8a28fc755ad5ec5ea025a', // xETH
    '0x505000008de8748dbd4422ff4687a4fc9beba15b', // xSOL
  ],
  [CHAIN_ID_TEMPO]: [
    '0x20c0000000000000000000000000000000000000', // pathUSD
    '0x20c00000000000000000000014f22ca97301eb73', // USDT0
    '0x20c000000000000000000000b9537d11c60e8b50', // USDC.e
    '0x20c0000000000000000000001621e21f71cf12fb', // EURC
    '0x20c0000000000000000000003554d28269e0f3c2', // frxUSD
  ],
};

function parseAddressList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map(address => address.toLowerCase());
}

function getEnvMajorAdditions(chainId: ChainId): string[] {
  const byChainRaw = process.env.V4_HOOKS_EXTRA_MAJOR_TOKENS_BY_CHAIN;
  const globalRaw = process.env.V4_HOOKS_EXTRA_MAJOR_TOKENS;

  const globalAddresses = globalRaw
    ? globalRaw
        .split(',')
        .map(address => address.trim().toLowerCase())
        .filter(Boolean)
    : [];

  if (!byChainRaw) {
    return globalAddresses;
  }

  try {
    const parsed = JSON.parse(byChainRaw) as Record<string, unknown>;
    const byChainAddresses = parseAddressList(parsed[String(chainId)]);
    return globalAddresses.concat(byChainAddresses);
  } catch {
    return globalAddresses;
  }
}

export function getMajorTokens(chainId: ChainId): Set<string> {
  const defaults = MAJOR_TOKENS_BY_CHAIN[chainId] ?? [];
  const additions = getEnvMajorAdditions(chainId);
  return new Set(
    defaults.concat(additions).map(address => address.toLowerCase())
  );
}

export function isMajorPair(
  token0Address: string,
  token1Address: string,
  majorTokens: Set<string>
): boolean {
  return (
    majorTokens.has(token0Address.toLowerCase()) &&
    majorTokens.has(token1Address.toLowerCase())
  );
}
