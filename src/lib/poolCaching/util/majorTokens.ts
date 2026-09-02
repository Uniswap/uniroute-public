import {ChainId} from '@uniswap/sdk-core';

type MajorTokensByChain = Partial<Record<ChainId, string[]>>;

/**
 * Hooked-pool trust boundary per V4 chain (see v4HooksPoolsFiltering): a
 * hooked pool between two majors is admitted only via the explicit hooks
 * allowlist; a pool with a non-major leg may be auto-admitted. Majors are the
 * pairs that anchor routing flow — (wrapped) native/gas token, top stables,
 * deep BTC/ETH representations, the chain's canonical token — with the zero
 * address covering V4 native-currency pools. Every V4-cached chain needs an
 * entry (a chain without one has no major pairs, so nothing there is gated);
 * enforced by majorTokens.test.ts.
 */
const MAJOR_TOKENS_BY_CHAIN: MajorTokensByChain = {
  [ChainId.MAINNET]: [
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // WETH
    '0x6b175474e89094c44da98b954eedeac495271d0f', // DAI
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
    '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT
    '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', // WBTC
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
    '0x0000000000000000000000000000000000000000', // Native OKB
  ],
  // No zero-address entry: Tempo has no native token (pathUSD is the gas token).
  [ChainId.TEMPO]: [
    '0x20c0000000000000000000000000000000000000', // pathUSD
    '0x20c00000000000000000000014f22ca97301eb73', // USDT0
    '0x20c000000000000000000000b9537d11c60e8b50', // USDC.e
    '0x20c0000000000000000000001621e21f71cf12fb', // EURC
    '0x20c0000000000000000000003554d28269e0f3c2', // frxUSD
  ],
  // No zero-address entry: the CELO ERC-20 below IS the native asset.
  // cUSD (Mento) now reports the USDm symbol on-chain.
  [ChainId.CELO]: [
    '0x471ece3750da237f93b8e339c536989b8978a438', // CELO
    '0x765de816845861e75a25fca122bb6898b8b1282a', // cUSD
    '0xceba9300f2b948710d2653dd7b07f33a8b32118c', // USDC
    '0xef4229c8c3250c675f21bcefa42f58efbff6002a', // USDC (bridged)
    '0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e', // USDT
    '0xd221812de1bd094f35587ee8e174b07b6167d9af', // WETH
    '0xbaab46e28388d2779e6e31fd00cf0e5ad95e327b', // WBTC
  ],
  [ChainId.WORLDCHAIN]: [
    '0x4200000000000000000000000000000000000006', // WETH
    '0x79a02482a880bce3f13e09da970dc34db4cd24d1', // USDC.e
    '0x03c7054bcb39f7b2e5b2c7acb37583e32d70cfa3', // WBTC
    '0x2cfc85d8e48f8eab294be644d9e25c3030863003', // WLD
    '0x859dbe24b90c9f2f7742083d3cf59ca41f55be5d', // sDAI
    '0x0000000000000000000000000000000000000000', // Native ETH
  ],
  [ChainId.ZORA]: [
    '0x4200000000000000000000000000000000000006', // WETH
    '0xcccccccc7021b32ebb4e8c08314bd62f7c653ec4', // USDzC
    '0x0000000000000000000000000000000000000000', // Native ETH
  ],
  [ChainId.BLAST]: [
    '0x4300000000000000000000000000000000000004', // WETH
    '0x4300000000000000000000000000000000000003', // USDB
    '0x0000000000000000000000000000000000000000', // Native ETH
  ],
  [ChainId.SONEIUM]: [
    '0x4200000000000000000000000000000000000006', // WETH
    '0xba9986d2381edf1da03b0b9c1f8b00dc4aacc369', // USDC.e
    '0x0000000000000000000000000000000000000000', // Native ETH
  ],
  // The upstream whitelist's USDCE entry (0x79a02482a880bce3f13e09da970dc34db4cd24d1)
  // has no contract deployed on Linea (it is Worldchain's USDC.e address) and is
  // deliberately excluded here.
  [ChainId.LINEA]: [
    '0xe5d7c2a44ffddf6b295a15c148167daaaf5cf34f', // WETH
    '0x176211869ca2b568f2a7d4ee941e073a821ee1ff', // USDC
    '0xa219439258ca9da29e9cc4ce5596924745e12b93', // USDT
    '0x3aab2285ddcddad8edf438c1bab47e1a9d05a9b4', // WBTC
    '0x1789e0043623282d5dcc7f213d703c6d8bafbb04', // LINEA
    '0xaca92e438df0b2401ff60da7e4337b687a2435da', // mUSD
    '0x0000000000000000000000000000000000000000', // Native ETH
  ],
  [ChainId.MEGAETH]: [
    '0x4200000000000000000000000000000000000006', // WETH
    '0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb', // USDT0
    '0xfafddbb3fc7688494971a79cc65dca3ef82079e7', // USDm
    '0x28b7e77f82b25b95953825f1e3ea0e36c1c29861', // MEGA
    '0x0000000000000000000000000000000000000000', // Native ETH
  ],
  // SPY is the chain's RWA/RWA routing intermediary (see BASE_TOKENS_PER_CHAIN),
  // so its pairs carry major flow and need hook vetting like the stable pairs.
  [ChainId.ROBINHOOD]: [
    '0x0bd7d308f8e1639fab988df18a8011f41eacad73', // WETH
    '0x5fc5360d0400a0fd4f2af552add042d716f1d168', // USDG
    '0x117cc2133c37b721f49de2a7a74833232b3b4c0c', // SPY
    '0x0000000000000000000000000000000000000000', // Native ETH
  ],
  // No zero-address entry: Arc has no native token (USDC is the gas token).
  [ChainId.ARC]: [
    '0x3600000000000000000000000000000000000000', // USDC
    '0x89b50855aa3be2f677cd6303cec089b5f319d72a', // EURC
    '0xe9185f0c5f296ed1797aae4238d26ccabeadb86c', // USYC
    '0x171a4217b86a807a64eb94757db6849fb4bdbaa0', // CIRBTC
    '0x128cc466b61f542da60c70e3aa11c10e19b84edb', // WETH
  ],
  [ChainId.INK]: [
    '0x4200000000000000000000000000000000000006', // WETH
    '0x0200c29006150606b650577bbe7b6248f58470c1', // USDT0
    '0xf1815bd50389c46847f0bda824ec8da914045d14', // USDC.e
    '0x0000000000000000000000000000000000000000', // Native ETH
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
