/**
 * Ported from routing-api/lib/util/hooksAddressesAllowlist.ts
 */

import {ChainId} from '@uniswap/sdk-core';
import {ADDRESS_ZERO} from '@uniswap/router-sdk';
import {
  AGG_HOOKS_ON_TEMPO,
  FLUID_DEX_1,
  FLUID_DEX_LITE,
  PANCAKESWAP_V3,
  SLIPSTREAM,
  STABLE_SWAP,
  STABLE_SWAP_NG,
} from './aggHooksAddressesAllowlist';
import {Protocol} from '../../../models/pool/Protocol';

// ARC is not yet in sdk-core — define locally until sdk-core is upgraded
const CHAIN_ID_ARC = 5042 as ChainId;
// INK is not yet in sdk-core — define locally until sdk-core is upgraded
const CHAIN_ID_INK = 57073 as ChainId;
// Protocols listed here are excluded from cached-routes retrieval inside
// CachedRoutesRepository.  All external (agg hook) protocols are included
// because production metrics show cached routes still containing agg hook
// pools that should be filtered out before being returned to callers.
// Remove a protocol from this list to start serving its cached routes again.
//
// NOTE: Do NOT replace this with EXTERNAL_PROTOCOLS from ../../helpers —
// helpers.ts imports from this file, creating a circular dependency that
// causes this set to be undefined at runtime.
export const AGG_HOOKS_PROTOCOL_CACHED_ROUTES_FILTER_OUT_LIST: ReadonlySet<Protocol> =
  new Set<Protocol>();

/**
 * Per-protocol, per-chain map of aggregator hook addresses.
 *
 * Keyed first by the external Protocol that owns the hook contract, then by
 * chainId.  This lets callers look up the exact hook set for a specific
 * protocol/chain pair.
 *
 * Use `getAllAggHooksForChain(chainId)` when you need the full union of all
 * agg-hook addresses for a given chain (e.g. for exclusion filters).
 *
 * Add a new entry here when agg hook support expands to additional chains or
 * protocols.
 */
export const AGG_HOOKS_PER_CHAIN: Partial<
  Record<Protocol, Partial<Record<number, string[]>>>
> = {
  [Protocol.CURVESTABLESWAP]: {
    [ChainId.MAINNET]: STABLE_SWAP,
  },
  [Protocol.CURVESTABLESWAPNG]: {
    [ChainId.MAINNET]: STABLE_SWAP_NG,
  },
  [Protocol.FLUIDDEXT1]: {
    [ChainId.MAINNET]: FLUID_DEX_1,
  },
  [Protocol.FLUIDDEXLITE]: {
    [ChainId.MAINNET]: FLUID_DEX_LITE,
  },
  [Protocol.SLIPSTREAM]: {
    [ChainId.BASE]: SLIPSTREAM,
  },
  [Protocol.PANCAKESWAPV3]: {
    [ChainId.BASE]: PANCAKESWAP_V3,
  },
  // NOTE: TEMPOEXCHANGE is intentionally omitted here. Tempo agg hook pools
  // are a special case — they are meant to be mixed with V4 pools rather than
  // treated as a separate agg hook protocol in routing.
};

// Reverse lookup built once at module load: chainId -> hookAddress(lowercase) -> Protocol.
// O(1) per-pool lookups replace O(protocols * addresses) set construction on every request.
const AGG_HOOKS_REVERSE_LOOKUP = new Map<number, Map<string, Protocol>>();
for (const [protocol, perChain] of Object.entries(AGG_HOOKS_PER_CHAIN) as [
  Protocol,
  Partial<Record<number, string[]>>,
][]) {
  for (const [chainIdStr, addresses] of Object.entries(perChain ?? {})) {
    const chainId = Number(chainIdStr);
    if (!AGG_HOOKS_REVERSE_LOOKUP.has(chainId)) {
      AGG_HOOKS_REVERSE_LOOKUP.set(chainId, new Map());
    }
    const chainMap = AGG_HOOKS_REVERSE_LOOKUP.get(chainId)!;
    for (const address of addresses ?? []) {
      chainMap.set(address.toLowerCase(), protocol);
    }
  }
}

/**
 * Returns the Protocol that owns a given hook address on a given chain,
 * or undefined if the address is not a known agg hook.
 */
export function getProtocolForAggHookAddress(
  hookAddress: string,
  chainId: number
): Protocol | undefined {
  return AGG_HOOKS_REVERSE_LOOKUP.get(chainId)?.get(hookAddress.toLowerCase());
}

// all hook addresses need to be lower case, since the check in isHooksPoolRoutable assumes lower case
export const extraHooksAddressesOnSepolia =
  '0x0000000000000000000000000000000000000020';
export const ETH_FLETH_AUTO_WRAP_HOOKS_ADDRESS_ON_BASE =
  '0x9e433f32bb5481a9ca7dff5b3af74a7ed041a888';

export const FLAUNCH_POSM_V1_ON_BASE =
  '0x51bba15255406cfe7099a42183302640ba7dafdc';
export const FLAUNCH_POSM_V2_ON_BASE =
  '0xf785bb58059fab6fb19bdda2cb9078d9e546efdc';
export const FLAUNCH_POSM_V3_ON_BASE =
  '0xb903b0ab7bcee8f5e4d8c9b10a71aac7135d6fdc';
export const FLAUNCH_POSM_V4_ON_BASE =
  '0x23321f11a6d44fd1ab790044fdfde5758c902fdc';
export const FLAUNCH_ANYPOSM_V1_ON_BASE =
  '0x8dc3b85e1dc1c846ebf3971179a751896842e5dc';

export const FLAUNCH_POSM_ON_ROBINHOOD =
  '0x5cf8e499c7c466c7e2cf127bdf129f57151e65dc';

export const GRADUATION_HOOKS_ADDRESS_ON_BASE =
  '0xc5a48b447f01e9ce3ede71e4c1c2038c38bd9000';
export const TWAMM_HOOKS_ADDRESS_ON_BASE =
  '0xed1698c29928a6c44cddb0c75ab0e5d47eb72a80';
export const BTC_ACC_ON_BASE = '0x704268ac7043aeef50f47b6a03ae68ccf808e044';

export const SLIPPAGE_FEE_HOOK_ON_ARBITRUM =
  '0xc4bf39a096a1b610dd6186935f3ad99c66239080';

export const CLANKER_DYNAMIC_FEE_HOOKS_ADDRESS_ON_BASE =
  '0x34a45c6b61876d739400bd71228cbcbd4f53e8cc';
export const CLANKER_STATIC_FEE_HOOKS_ADDRESS_ON_BASE =
  '0xdd5eeaff7bd481ad55db083062b13a3cdf0a68cc';
export const CLANKER_DYNAMIC_FEE_HOOKS_ADDRESS_ON_BASE_v2 =
  '0xd60d6b218116cfd801e28f78d011a203d2b068cc';
export const CLANKER_STATIC_FEE_HOOKS_ADDRESS_ON_BASE_v2 =
  '0xb429d62f8f3bffb98cdb9569533ea23bf0ba28cc';
export const CLANKER_DYNAMIC_FEE_HOOKS_ADDRESS_ON_ARBITRUM =
  '0xfd213be7883db36e1049dc42f5bd6a0ec66b68cc';
export const CLANKER_STATIC_FEE_HOOKS_ADDRESS_ON_ARBITRUM =
  '0xf7ac669593d2d9d01026fa5b756dd5b4f7aaa8cc';
export const CLANKER_DYNAMIC_FEE_HOOKS_ADDRESS_ON_UNICHAIN =
  '0x9b37a43422d7bbd4c8b231be11e50ad1ace828cc';
export const CLANKER_STATIC_FEE_HOOKS_ADDRESS_ON_UNICHAIN =
  '0xbc6e5abda425309c2534bc2bc92562f5419ce8cc';
export const CLANKER_STATIC_FEE_HOOKS_ADDRESS_ON_MAINNET =
  '0x6c24d0bcc264ef6a740754a11ca579b9d225e8cc';
export const CLANKER_STATIC_FEE_HOOKS_ADDRESS_ON_MONAD =
  '0x94f802a9efe4dd542fdbd77a25d8e69a6dc828cc';
export const CLANKER_DYNAMIC_FEE_HOOKS_ADDRESS_ON_BSC =
  '0x011a8ed40095f2d7e9c19125b8254b19678d68cc';

export const WETH_HOOKS_ADDRESS_ON_OP_MAINNET =
  '0x480dafdb4d6092ef3217595b75784ec54b52e888';
export const WETH_HOOKS_ADDRESS_ON_UNICHAIN =
  '0x730b109bad65152c67ecc94eb8b0968603dba888';
export const WETH_HOOKS_ADDRESS_ON_BASE =
  '0xb08211d57032dd10b1974d4b876851a7f7596888';
export const WETH_HOOKS_ADDRESS_ON_MAINNET =
  '0x57991106cb7aa27e2771beda0d6522f68524a888';
export const WETH_HOOKS_ADDRESS_ON_MONAD =
  '0x3fad8a7205f943528915e67cf94fc792c8fce888';
export const WETH_HOOKS_ADDRESS_ON_ARBITRUM =
  '0x2a4adf825bd96598487dbb6b2d8d882a4eb86888';

// TODO(megaeth): temporary — AGNTTEST/USDm test pool hook; remove once real pools are seeded.
export const TEST_HOOK_ON_MEGAETH =
  '0x14faad03bbbc089f694bdfad9826d36f30ce80c4';

export const RENZO_ON_UNICHAIN = '0x09dea99d714a3a19378e3d80d1ad22ca46085080';
export const AEGIS_ON_UNICHAIN_V1 =
  '0x27bfccf7fdd8215ce5dd86c2a36651d05c8450cc';
export const AEGIS_ON_UNICHAIN_V2 =
  '0xa0b0d2d00fd544d8e0887f1a3cedd6e24baf10cc';
export const AEGIS_V3 = '0x88c9ff9fc0b22cca42265d3f1d1c2c39e41cdacc';
export const AEGIS_V1_1_ON_POLYGON =
  '0x15cD9520D0fAF71c938Db4426F8C58B5cBAa9ACc';

export const AEGIS_ENGINE_ON_MAINNET =
  '0x8f29bd5c8429730fa4c46e6295c4e679ededd0cc';
export const AEGIS_ENGINE_ON_MONAD =
  '0xe449e013004db4a5681e9622ca10c5ba0ea610cc';

export const ZORA_CREATOR_HOOK_ON_BASE_v1 =
  '0xfbce3d80c659c765bc6c55e29e87d839c7609040';
export const ZORA_CREATOR_HOOK_ON_BASE_v1_0_0_1 =
  '0x854f820475b229b7805a386f758cfb285023d040';
export const ZORA_CREATOR_HOOK_ON_BASE_v1_1_1 =
  '0x9301690be9ac901de52c5ebff883862bbfc99040';
export const ZORA_CREATOR_HOOK_ON_BASE_v1_1_1_1 =
  '0x5e5d19d22c85a4aef7c1fdf25fb22a5a38f71040';
export const ZORA_CREATOR_HOOK_ON_BASE_v1_1_2 =
  '0xd61a675f8a0c67a73dc3b54fb7318b4d91409040';
export const ZORA_CREATOR_HOOK_ON_BASE_v2_2 =
  '0x8218fa8d7922e22aed3556a09d5a715f16ad5040';
export const ZORA_CREATOR_HOOK_ON_BASE_v2_2_1 =
  '0x1258e5f3c71ca9dce95ce734ba5759532e46d040';

export const ZORA_POST_HOOK_ON_BASE_v1 =
  '0xa1ebdd5ca6470bbd67114331387f2dda7bfad040';
export const ZORA_POST_HOOK_ON_BASE_v1_0_0_1 =
  '0xb030fd8c2f8576f8ab05cfbbe659285e7d7a1040';
export const ZORA_POST_HOOK_ON_BASE_v1_0_0_2 =
  '0xe61bdf0c9e665f02df20fede6dcef379cb751040';
export const ZORA_POST_HOOK_ON_BASE_v1_1_1 =
  '0x81542dc43aff247eff4a0ecefc286a2973ae1040';
export const ZORA_POST_HOOK_ON_BASE_v1_1_1_1 =
  '0x5bf219b3cc11e3f6dd8dc8fc89d7d1deb0431040';
export const ZORA_POST_HOOK_ON_BASE_v1_1_2 =
  '0x9ea932730a7787000042e34390b8e435dd839040';
export const ZORA_POST_HOOK_ON_BASE_v2_2 =
  '0xff74be9d3596ea7a33bb4983dd7906fb34135040';
export const ZORA_POST_HOOK_ON_BASE_v2_2_1 =
  '0x2b15a16b3ef024005ba899bb51764fcd58cf9040';
export const ZORA_POST_HOOK_ON_BASE_v2_3_0 =
  '0xc8d077444625eb300a427a6dfb2b1dbf9b159040';
export const ZORA_POST_HOOK_ON_BASE_v2_4_0 =
  '0xf6d0a13609bb5779bc5d639f2ba3bfda83d4d0c0';

export const DOPPLER_HOOKS_ADDRESS_ON_BASE =
  '0x77bb2a8f1ab2a384918a4c090cd8ae82dc5078e0';
export const DOPPLER_HOOKS_ADDRESS_ON_BASE_V2 =
  '0xbb7784a4d481184283ed89619a3e3ed143e1adc0';
export const DOPPLER_HOOKS_ADDRESS_ON_BASE_V3 =
  '0xbdf938149ac6a781f94faa0ed45e6a0e984c6544';
export const DOPPLER_HOOKS_ADDRESS_ON_MONAD =
  '0x580ca49389d83b019d07E17e99454f2F218e2dc0';

export const LIMIT_ORDER_HOOKS_ADDRESS_ON_ARBITRUM =
  '0xd73339564ac99f3e09b0ebc80603ff8b796500c0';
export const LIMIT_ORDER_HOOKS_ADDRESS_ON_UNICHAIN =
  '0x2016c0e4f8bb1d6fea777dc791be919e2eda40c0';
export const LIMIT_ORDER_HOOKS_ADDRESS_ON_BASE =
  '0x9d11f9505ca92f4b6983c1285d1ac0aaff7ec0c0';

export const PANOPTIC_ORACLE_HOOK_ON_UNICHAIN =
  '0x79330fe369c32a03e3b8516aff35b44706e39080';

export const FEY_ON_SEPOLIA = '0x932d55d7b86d27eedd0934503e49f5f362faa8cc';
export const FEY_ON_BASE = '0x5b409184204b86f708d3aebb3cad3f02835f68cc';

export const PUBHOUSE_HOOK_ON_BASE =
  '0x4ab61d774b170d0610fdcc5559aae2c356c600c8';

export const TOKENWORKS_HOOK_ON_MAINNET_1 =
  '0xfaaad5b731f52cdc9746f2414c823eca9b06e844';
export const TOKENWORKS_HOOK_ON_MAINNET_2 =
  '0xbd15e4d324f8d02479a5ff53b52ef4048a79e444';
export const TOKENWORKS_HOOK_ON_MAINNET_3 =
  '0xd6a45df0c82c9a686ab1e58fb28d8fc0cf106444';
export const TOKENWORKS_HOOK_ON_MAINNET_4 =
  '0xe3c63a9813ac03be0e8618b627cb8170cfa468c4';
export const TOKENWORKS_HOOK_ON_MAINNET_5 =
  '0x5d8a61fa2ced43eeabffc00c85f705e3e08c28c4';

export const STRATEGICRESERVE_HOOK_ON_MAINNET =
  '0x6e1babe41d708f6d46a89cda1ae46de95458e444';
export const ENS_WHEEL_HOOK_ON_MAINNET =
  '0xf13bdafb90c79f2201e2ce42010c8ef75fede8c4';
export const ENS_WHEEL_HOOK_ON_MAINNET_2 =
  '0xA312884b73862377317f0071eC6eB5404025A8C4';
export const CULT_FEE_HOOK_ADDRESS_ON_MONAD =
  '0x7A2524cE937F206844b9508EEc8f6486800a40CC';
export const AEGIS_DFM_HOOK_ON_MONAD =
  '0xe620421bde7d6a367d2c3b7e8dfa09b90aea90cc';
export const AQUINAS_HOOK_ADDRESS_ON_BASE =
  '0xd3c1f2174f37f88811f99b1b1b4c1356c0246000';
export const AQUINAS_HOOK_ADDRESS_ON_BASE_2 =
  '0x98Aa253a44497dfa77ec1170e69f851cB17C2000';
export const ASTERIX_HOOK_ADDRESS_ON_MAINNET =
  '0xdad7ea85ff786b389a13f4714a56b1721b56c044';
export const AZTEC_HOOK_ADDRESS_ON_MAINNET =
  '0xd53006d1e3110fd319a79aeec4c527a0d265e080';

export const DELI_HOOK_ADDRESS_ON_BASE =
  '0x570a48f96035c2874de1c0f13c5075a05683b0cc';
export const DELI_HOOK_CONSTANT_PRODUCT_ON_BASE =
  '0x95afbc0fccf974b41380f24e562f15b6dd90fac8';

export const FINDEX_HOOK_ON_OPTIMISM =
  '0xb35297543d357ef62df204d8c3bd0e96038cf440';
export const FINDEX_HOOK_V2_ON_OPTIMISM =
  '0x4e4ecde86fc904b6e7be363e0f4bf127fd7195d8';
export const DYNAMIC_VOLUME_HOOK_ON_OPTIMISM =
  '0x2c3254da64956f495356a482d51e7311347f5044';
export const FINDEX_HOOK_ON_BSC = '0x85c2be3c314d90316f88b559fe087265f09c7440';
export const FINDEX_HOOK_V2_ON_BNB =
  '0x91fb28d8f4906df4e8c71806dfeb882dd82815d8';
export const FINDEX_HOOK_V2_ON_POLYGON =
  '0x6c67d89c4efdc7b88e5b066b7f3d5a99060a55d8';
export const ACTION_HOOK_ON_MAINNET =
  '0x00bbc6fc07342cf80d14b60695cf0e1aa8de00cc';
export const M0_ALLOWLIST_HOOKS_ADDRESS_ON_MAINNET =
  '0xaf53cb78035a8e0acce38441793e2648b15b88a0';
export const M0_TICK_RANGE_HOOKS_ADDRESS_ON_MAINNET =
  '0xde400595199e6dae55a1bcb742b3eb249af00800';
export const UNIDERP_HOOK_ON_UNICHAIN =
  '0xcc2efb167503f2d7df0eae906600066aec9e8444';
export const SUPERSTRATEGY_HOOK_ON_BASE =
  '0x1e0c810a30fb82391df936602c1161421381b0c8';
export const WASSBLASTER_HOOK_ON_BASE =
  '0x35b9b5b023897da8c7375ba6141245b8416460cc';
export const SIMPLE_SELL_TAX_HOOK_ON_BASE =
  '0xca975b9daf772c71161f3648437c3616e5be0088';

export const RING_FEW_ETH_HOOK_ON_MAINNET =
  '0x044301939deb7ca53c4733dd4d9b3bc5ea0c6888';
export const RING_FEW_UNI_HOOK_ON_MAINNET =
  '0x4b3e2a8cf36c7eb0fba2a5b39b20c896c6f22888';
export const RING_FEW_WBTC_HOOK_ON_MAINNET =
  '0x0fe942afdb2f51e25cbf892aad175c6a574f2888';
export const RING_FEW_CBBTC_HOOK_ON_MAINNET =
  '0x8347b7a3807c681513d2b51b8223e59aa16a2888';
export const RING_FEW_USDC_HOOK_ON_MAINNET =
  '0x4b2eb653d13e6c9ac5a0a01fde22f2c8d6592888';
export const RING_FEW_USDT_HOOK_ON_MAINNET =
  '0xbadf77d50478b4432ef1f243b9c0bc7869486888';
export const RING_FEW_DAI_HOOK_ON_MAINNET =
  '0x85b648a64aed6307d5d5ce26e6ae086c17bde888';
export const RING_FEW_WEETH_HOOK_ON_MAINNET =
  '0x877323adbf747f85eb8d182d42f01f34a5492888';
export const RING_FEW_WSTETH_HOOK_ON_MAINNET =
  '0x75ae0292e8ad3ab60b9a1a7b3046d3f4abdfa888';

export const BVCC_DYNAMIC_FEE_HOOK_ON_BSC =
  '0x8a36d8408f5285c3f81509947bc187b3c0efd0c4';
export const BVCC_DYNAMIC_FEE_HOOK_ON_MAINNET =
  '0xf9ced7d0f5292af02385410eda5b7570b10b50c4';
export const BVCC_DYNAMIC_FEE_HOOK_ON_ARBITRUM =
  '0x2097d7329389264a1542ad50802bb0de84a650c4';
export const BVCC_DYNAMIC_FEE_HOOK_ON_BASE =
  '0x2c56c1302b6224b2bb1906c46f554622e12f10c4';

export const MEME_STRATEGY_HOOK_ON_MAINNET =
  '0x3ba779bad405d9b68a7a7a86ff6916c806a200cc';
export const FARSTR_HOOKS_ADDRESS_ON_BASE =
  '0xc3b8e77ac038aa260035a1911827086c34a9e844';
export const UNIVERSAL_HOOK_ON_UNICHAIN =
  '0xcdfcab084b2d29025772141d3bf473bd9673aaa8';
export const AVAXSTRATEGIES_STATIC_FEE_HOOKS_ADDRESS_ON_AVAX =
  '0x3b48f794a1d67febe95f66b6dff38c0a7e934044';
export const ARTACLE_INDEX_TOKEN_HOOK_ON_BASE =
  '0xd577f945b6025ce1e60ac1a82f2ee8ff3fb428c4';
export const TOKEN_FLOW_TAX_HOOK_ON_MAINNET =
  '0x74803bd586fa5ce3a9ab38b49a7ca633af8700cc';
export const GPO_HOOKS = '0x6cabe2fd9fb60c5afcab7de732b0a224fc382eec';
export const GPX_HOOKS = '0x4519e2b040ff1b64fa03abe2aef0bc99d7cceaa8';
export const LIQUID_LAUNCH_HOOK_ON_BASE =
  '0xea9346e83952840e69beb36df365c4e68de0e080';
export const ARRAKIS_PRIVATE_HOOK_ON_BASE =
  '0xf9527fb5a34ac6fbc579e4fbc3bf292ed57d4880';
export const ARRAKIS_PRIVATE_HOOK_ON_MAINNET =
  '0xf9527fb5a34ac6fbc579e4fbc3bf292ed57d4880';
export const CUSTOM_FEE_MEV_PROTECTION_HOOK_ON_MAINNET =
  '0xd5770936a6678353f1b17c342b29c4416b029080';
export const DORY_BURN_AND_MINT_POWER_HOOK_ON_ARBITRUM =
  '0x6b70fef40d3925881251c018164dbcec6bc94040';
export const ZOO_FINANCE_LNT_VATH_ATH_HOOKS_ADDRESS_ON_ARBITRUM =
  '0xbf4b4a83708474528a93c123f817e7f2a0637a88';
export const BUY_HOOK_V1_ON_BNB = '0xabf1f4421f2c4893a7fa9b411c59ddf248508080';
export const BUY_HOOK_V2_ON_BNB = '0x21f4ee7f81ba98f613f54486d5362ec533b00080';
export const BUY_HOOK_V3_ON_BNB = '0xdf4e5f77ebbe97bdee477d685b946ca27a538080';
export const BASEMEME_HOOK_ADDRESS_ON_BASE =
  '0x755776c51399f7ee15d47ddaf47347d26f5ca840';
export const AI_PROTOCOL_SWAP_FEE_HOOK_V1_ON_BASE =
  '0x121f94835dab08ebaf084809a97e525b69e400cc';
export const CLAUNCH_HOOK_ON_BASE =
  '0x2f9354bbb0edef5c2a5c4b78d0c59d73412a28cc';
export const SEEDIFY_SPARK_HOOK_ON_BASE =
  '0x2fd54aaf84023eda60bd65edb5914c1a306850cc';
export const LAUNCHLY_BNB_HOOKS_ADDRESS_ON_BNB =
  '0xe1b70e28a596972afe25087c062f459a0f4b40cc';
export const ANSTROM_HOOK_ON_BASE =
  '0x631352aaa9d6554848af674106bcd8bb9e59a5cf';
export const TETRIS_CUSTOM_DYNAMIC_FEE_HOOK_ON_MAINNET =
  '0x3a3a9a072ab438335a52e0cf064f7ec91d824080';
export const ACCUMULATE_HOOK_ON_BASE =
  '0x64b54C01afCb36A405a2615e65B5E22A52b28044';
export const AUTO_LIQUIDITY_GENERATOR_HOOK_ON_MAINNET =
  '0x5725dF570e0008997daCef46bC179bbFc4D125cc';
export const ADAPTIVE_BURN_HOOK_ON_BASE =
  '0x5798a5e371346c8e4af1dbc166549d360e008044';
export const LAUNCHLY_HOOK_ON_BASE =
  '0xa62A40569a2b8ccA3A5557734BCAEc54441500CC';
export const DRXGAI_HOOK_ON_BASE = '0x66E51DEab56975Bb1c64413bd3AB01FA95B82acc';
export const INT_FEE_HOOK_ON_BASE =
  '0x9850de90445233c2561dd29fc67aaa353b48a888';
export const ALPHIX_LVR_FEE_HOOK_ON_BASE =
  '0x7cbbff9c4fcd74b221c535f4fb4b1db04f1b9044';
export const ALPHIX_LVR_FEE_HOOK_ON_ARBITRUM =
  '0x7cbbff9c4fcd74b221c535f4fb4b1db04f1b9044';
export const ANGSTROM_L2_HOOK_1_ON_BASE =
  '0xcd256a2f4574cb6aca4837313ad225d2fe1de5cf';
export const ANGSTROM_L2_HOOK_2_ON_BASE =
  '0x7fa49d29481b6d168505ccde26635e204c09e5cf';
export const LIQUID_PROTOCOL_HOOK_ON_BASE =
  '0x80e2f7dc8c2c880bbc4bdf80a5fb0eb8b1db68cc';
export const LIQUID_PROTOCOL_HOOK_STATIC_ON_BASE =
  '0x9811f10cd549c754fa9e5785989c422a762c28cc';
export const TOKENS_FUN_ON_BASE = '0x7debe6943acefe85c4ee81aadd736466e07528cc';
export const TOKENS_FUN_2_ON_BASE =
  '0x1f6c7744a0b0393db8e96d3aaa023146828028cc';
export const TOKENS_FUN_3_ON_BASE =
  '0xab29e4cb49980a6ac152515bb69470e0dedc68cc';
export const TOKENS_FUN_4_ON_BASE =
  '0x73e74c090446ad7c9745eba3c26f3e1a9680e8cc';
export const APEX_YIELD_HOOK_ON_BASE =
  '0x1216eefa98a268d5c610ffdd9c0eb2d6b1290aec';
export const UPEG_HOOK_ON_MAINNET =
  '0xe54082DfBf044B6a8F584bdDdb90a22d5613C440';

// GuideStar hooks -
// stable-stable hooks
export const GUIDESTAR_STABLE_STABLE_HOOK_ON_MAINNET =
  '0x4509b7eb3f9641226804fea4976963435d1c6080';
export const ETIM_TAX_HOOK_ON_MAINNET =
  '0x41a9bf2969af822942a553babd6d8dda0dff80cc';
export const ASH_HOOK_ON_MAINNET = '0xebac1d1a384d3ae1a162fdf30788fcfa228380cc';
export const LIVO_SWAP_HOOK_ON_MAINNET =
  '0x627fa6f76fa96b10bae1b6fba280a3c9264500cc';
export const LIVO_SWAP_HOOK_V2_ON_MAINNET =
  '0x068241d20c59980abeaeded990d2441f05f5c0cc';
export const LIVO_SWAP_HOOK_V3_ON_MAINNET =
  '0x10392843021a1af0abe3b1a21f14673dc05340cc';

export const ESTATE_BONDING_CURVE_HOOK_ON_BASE =
  '0x66799c2eb2590006820f6cb826133176ecdda888';

export const JANPU_STATIC_FEE_V2_ON_BASE =
  '0xb67f057bfbcb27ff9908dbf2d3d9dbd89d29e8cc';
export const JANPU_HOOK_DYNAMIC_FEE_V2_ON_BASE =
  '0x49659b737c672324a221623f8d3f29e5687f28cc';

export const UNIAGENT_V4_HOOK_ON_MAINNET =
  '0xa5db9bd1eac09894c680fe56bc5db26078c800cc';

export const TTTHOOK_ON_MAINNET = '0xdee7a2ffa963f82facbb12a4e3e8909e4a51a444';

export const JRNY_HOOK_ON_MAINNET =
  '0x8cec12bc7ea6b92cd330b77e163fe5dbde88c0cc';

export const A51PEG_HOOK_ON_BASE = '0x1c0c00db76140b4e7deb997ccf1246d8d6b80440';

// Aegis DFM — same address across all supported chains
const AEGIS_DFM_ADDRESS = '0xb4f4949e8d0a177bb6d2fea33e9516bb219610cc';
export const AEGIS_DFM_ON_MAINNET = AEGIS_DFM_ADDRESS;
export const AEGIS_DFM_ON_UNICHAIN = AEGIS_DFM_ADDRESS;
export const AEGIS_DFM_ON_OPTIMISM = AEGIS_DFM_ADDRESS;
export const AEGIS_DFM_ON_BASE = AEGIS_DFM_ADDRESS;
export const AEGIS_DFM_ON_ARBITRUM = AEGIS_DFM_ADDRESS;
export const AEGIS_DFM_ON_POLYGON = AEGIS_DFM_ADDRESS;
export const AEGIS_DFM_ON_BLAST = AEGIS_DFM_ADDRESS;
export const AEGIS_DFM_ON_ZORA = AEGIS_DFM_ADDRESS;
export const AEGIS_DFM_ON_WORLDCHAIN = AEGIS_DFM_ADDRESS;
export const AEGIS_DFM_ON_XLAYER = AEGIS_DFM_ADDRESS;
export const AEGIS_DFM_ON_SONEIUM = AEGIS_DFM_ADDRESS;
export const AEGIS_DFM_ON_AVALANCHE = AEGIS_DFM_ADDRESS;
export const AEGIS_DFM_ON_BNB = AEGIS_DFM_ADDRESS;
export const AEGIS_DFM_ON_CELO = AEGIS_DFM_ADDRESS;

export const ONCHAIN_RAID_ON_MAINNET =
  '0x319c49f68df3da28edceb691dac45e0a16d1d0cc';

export const SNAPBACK_PROTOCOL_ON_BASE =
  '0x2063a2b535a59911532cdf4d1cf28501099f0aec';

export const DEPLOYERTAXHOOK_ON_MAINNET =
  '0x990a91c744d50fe05a123a80f5a5a6a966f28088';

export const STABLE_PROTECTION_ON_UNICHAIN =
  '0x1510926ba6986cb3c93bfff25839c0ef740820c0';

export const SUPER_STRATEGY_ON_BASE =
  '0xca51c787e7136db1cbfd92a24287ea8e9363b0c8';
export const SUPER_STRATEGY_V2_ON_BASE =
  '0x5c062f56e7f1a5cf25b95e626af15176f52fb0c8';
export const SUPER_STRATEGY_V3_ON_BASE =
  '0x6646b048fba0a70a692f7690ae6dad83bcacb0c8';

// BackGeoOracle — per-chain CREATE2 deployments with different address per
// chain (permission-flag vanity ending in ...ac4), so no shared constant.
export const BACKGEOORACLE_ON_MAINNET =
  '0xb13250f0dc8ec6de297e81cda8142db51860bac4';
export const BACKGEOORACLE_ON_BASE =
  '0x59f39091fd6f47e9d0bcb466f74e305f1709bac4';
export const BACKGEOORACLE_ON_BNB =
  '0x77b2051204306786934be8bec29a48584e133ac4';
export const BACKGEOORACLE_ON_ARBITRUM =
  '0x3043e182047f8696dfe483535785ed1c3681bac4';
export const BACKGEOORACLE_ON_OPTIMISM =
  '0x79234983ded8eaa571873fffe94e437e11c7fac4';
export const BACKGEOORACLE_ON_UNICHAIN =
  '0x54bd666ea7fd8d5404c0593eab3dcf9b6e2a3ac4';

export const JRNY_HOOK_V2_ON_MAINNET =
  '0x49c4ab474dc5519bfe120acb4098d3e6f61b40cc';

export const ETIMTAXHOOK_V2_ON_MAINNET =
  '0x05388fb8b99b66867f08b2841d6baaea58b040cc';

export const PAMHOOK_ON_MAINNET = '0x34052720fd88197718251765fe03611d740c00cc';

export const TAXHOOK_ON_MAINNET = '0x6fb14025194d3921942b269ba49c988fbd3fc0cc';

export const SETHHOOK_ON_BASE = '0xe0e522e5888e398d9e5d4d90a48c489425cb2888';

export const CLANKER_STATIC_FEE_HOOKS_ADDRESS_ON_BSC_v2 =
  '0x0fcb2c049786054fd35330db361a75a88903a8cc';
export const CLANKER_STATIC_FEE_HOOKS_ADDRESS_ON_ROBINHOOD =
  '0x48b8f6ad3a1b4aa477314c9a23035b8f84dde8cc';
export const CLANKER_DYNAMIC_FEE_HOOKS_ADDRESS_ON_ROBINHOOD =
  '0x65efdf8cce99b53c925df878df275df21cb6e8cc';

export const THE_POOL_ON_ARBITRUM =
  '0x486579de6391053df88a073cebd673dd545200cc';

export const VORTEXHOOK_ON_MAINNET =
  '0x068f3dd75f3537bc5b396bc0ead71b832c0c2acc';

export const DIAMONDHANDSHOOK_ON_MAINNET =
  '0x1df8e3ce04a62922506e4ba303e1338583155044';

export const LITEPSM_AGGREGATOR_HOOK_USDS_ON_MAINNET =
  '0x958a0904940f744f8c6b72c043ceee3ea34ae888';
export const LITEPSM_AGGREGATOR_HOOK_DAI_ON_MAINNET =
  '0x958942af77dcd973b815b2a16bd88a5134c46888';

export const DUALPOOL_HOOK_ON_MAINNET =
  '0x00000078bd49d5279a99b5f4011a5c61ee8caac0';

/**
 * "ZLCA Hooks" — Zero-Liquidity Custom-Accounting hooks: V4 hooks whose
 * custom accounting (e.g. a PSM-style fixed-parity conversion via
 * BeforeSwapReturnsDelta like the LitePSM hooks, or JIT-provisioned
 * liquidity like the dualpool hook) means their pools hold no ordinary LP
 * positions, so the standard concentrated-liquidity `liquidity` field is
 * structurally always 0 — and their subgraph `totalValueLockedETH` may not
 * reflect real economic backing either. Neither is a usable admission
 * signal, so they are admitted to routing purely by membership in this
 * registry (a small, explicitly curated list — same trust model as the
 * plain `HOOKS_ADDRESSES_ALLOWLIST`, and every address here must ALSO
 * appear there). Their reserves are custodied inside the PoolManager, so
 * the standard V4Quoter prices them fine — no
 * AggHookQuoter/AGG_HOOKS_PER_CHAIN treatment needed.
 *
 * Routing behavior tied to this category: exemption from BOTH the
 * subgraph's V4_MIN_TVL_ETH floor at the query level AND the post-fetch
 * liquidity/TVL sanitize filter during pool-cache discovery (see
 * `subgraphProvider.ts`), plus force-selection past TVL-ranked topN cuts
 * (see `TopPoolsSelector.ts` / `S3SubgraphPoolDiscovererV4`). This matters
 * for their use as intermediate-hop candidates (direct-pair requests
 * already find them via DirectPoolDiscoverer regardless of TVL/liquidity).
 * Unlike the permissioned-hook query, no adapter/known-token bounding is
 * applied — safe only while no hook here can have compliance-sensitive
 * pools. Do not add a hook whose pools can involve permissioned or
 * compliance-sensitive tokens without adding bounding like the
 * permissioned-hook query's.
 *
 * The map value is the hook's per-hop gas overhead (gas units), added on
 * the HEURISTIC estimation path for every leg through one of its pools
 * (see `zlcaHookGasCalibration.ts`). These hooks do real work in their
 * swap callbacks that the V3-style heuristic (tuned for plain
 * concentrated-liquidity hops at ~60-97k) cannot see, and an
 * under-estimated `gasUseEstimate` becomes the tx gas limit downstream
 * (trading uses it verbatim instead of simulating) — so a shortfall
 * reverts user swaps (OOG at the final Permit2 settle,
 * TRANSFER_FROM_FAILED), not just mis-ranks routes. Over-estimating is
 * safe (unused gas is refunded) at the cost of a gas-ranking penalty
 * against the hook's routes — the right direction to err. Quoter-based
 * estimates must NOT add it: the V4Quoter's `gasEstimate` already includes
 * the hook callback.
 *
 * Values: the LitePSM 500k was calibrated 2026-07-06 on mainnet — hook
 * callback frame ~218k in a reverted prod-shape trace, V4Quoter view-call
 * 258-275k for the full hop vs a ~60-97k heuristic base, doubled for
 * headroom since quoter view-calls understate tx-context cost by
 * +67k..+188k in the agg-hook calibration. The dualpool 3M is per the hook
 * team's guidance.
 *
 * Add future zero-liquidity custom-accounting hooks here to pick up the
 * same treatment automatically.
 */
// Intersected with Record<number, ...> (matching HOOKS_ADDRESSES_ALLOWLIST's
// shape) so this can be indexed by both this file's @uniswap/sdk-core ChainId
// and the separate, numerically-overlapping ChainId enum in lib/config.ts.
export const ZLCA_HOOKS_PER_CHAIN: Partial<
  Record<ChainId, Record<string, bigint>>
> &
  Record<number, Record<string, bigint>> = {
  [ChainId.MAINNET]: {
    [LITEPSM_AGGREGATOR_HOOK_USDS_ON_MAINNET]: 500_000n,
    [LITEPSM_AGGREGATOR_HOOK_DAI_ON_MAINNET]: 500_000n,
    [DUALPOOL_HOOK_ON_MAINNET]: 3_000_000n,
  },
};

export const ARMSYS_ON_BASE = '0x7fb4846d3987476577319f112731bb04f45880c8';

// MEV-X Homelander — same address across all supported chains
const MEV_X_HOMELANDER_ADDRESS = '0xdfe0f6d6cdda8f8ea47d6c5bddbdea51425290c0';
export const MEV_X_HOMELANDER_ON_MAINNET = MEV_X_HOMELANDER_ADDRESS;
export const MEV_X_HOMELANDER_ON_BNB = MEV_X_HOMELANDER_ADDRESS;
export const MEV_X_HOMELANDER_ON_BASE = MEV_X_HOMELANDER_ADDRESS;
export const MEV_X_HOMELANDER_ON_POLYGON = MEV_X_HOMELANDER_ADDRESS;
export const MEV_X_HOMELANDER_ON_ARBITRUM = MEV_X_HOMELANDER_ADDRESS;
export const MEV_X_HOMELANDER_ON_UNICHAIN = MEV_X_HOMELANDER_ADDRESS;
export const MEV_X_HOMELANDER_ON_MONAD = MEV_X_HOMELANDER_ADDRESS;

export const BASEDBID_PROGRAMMABLE_FEE_HOOK_ON_BASE =
  '0x4d667e420bd4a42969cb27251a3f9a24661fd0cc';
export const BASEDBID_PROGRAMMABLE_FEE_HOOK_ON_BNB =
  '0x8e6b0a1b73f8ecf08bbb910c283cb3f4077d50cc';
export const BASEDBID_PROGRAMMABLE_FEE_HOOK_ON_MAINNET =
  '0xe4544f99e39b0d120366814f9c84a6beab2350cc';

export const VERSUS_PROTECTED_HOOK_ON_BNB =
  '0xeb67fef5b5dc83bffc4059bdbbfb8b368ac650cc';

export const FWATOKENHOOK_ON_MAINNET =
  '0x3a84bc99fd208bdc0fee2eb72a9d6c9a7271a444';
export const FWATOKENHOOK_ON_MAINNET_2 =
  '0x2c67eba8a50af0db5fba55f725247a75cbda6444';

export const BONKER_DYNAMIC_FEE_HOOK_ON_BASE =
  '0x963e91a45148b39737b9df10c5b897b55ca9e8cc';
export const BONKER_STATIC_FEE_HOOK_ON_BASE =
  '0xc9156c1868e122ef5b3e6ed946e1e88ff7da68cc';

export const URULAUNCH_HOOK_ON_BASE =
  '0x367bf580a1a6cc784f30a77713e02eca76210044';

export const DOPPLER_HOOKS_ADDRESS_ON_ROBINHOOD =
  '0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544';
export const INDEX_FEE_HOOK_ON_ROBINHOOD =
  '0x2cd91bd228ff4c537031d6b8204782090c84c0cc';
export const PENSION_TAX_HOOK_ON_ROBINHOOD =
  '0x2539029365c03b131cca25cb10ff4519a1dcc0cc';
export const RIVERS_LAUNCH_HOOK_ON_ROBINHOOD =
  '0x12783b423b9cf1a136bd7e0f8baca5944f5baacc';
export const SHARES_HOOK_ON_ROBINHOOD =
  '0x25a1bb2313e4b24307e8259b177431a61bfe04cc';
export const PLEB_INDEX_FEE_HOOK_ON_ROBINHOOD =
  '0xa507e8c472918338c6c15eb894c9703581b060cc';
// LivoSwapHook — multiple Robinhood deployments of the same verified contract
// (different LP fee tiers / versions).
export const LIVO_SWAP_HOOK_ON_ROBINHOOD =
  '0xbffe76cc9e506285032b2e5d1b74b579e39ac0cc';
export const LIVO_SWAP_HOOK_ON_ROBINHOOD_2 =
  '0xb00f65499050a4752f7027e578faf690efff40cc';
export const LIVO_SWAP_HOOK_ON_ROBINHOOD_3 =
  '0xdb1902bc975992828616b0224d9c5ff907e9c0cc';
export const PUMP_V4_HOOK_ON_ROBINHOOD =
  '0x14bcc18fdb0e7a427122b9c2f1a40ff7d63eaacc';
export const MEME_ETF_PORTFOLIO_FEE_HOOK_ON_ROBINHOOD =
  '0x29a2a39143f5aafba61bb8c649bc7c7d50b1e0cc';
export const ROB_FEE_HOOK_ON_ROBINHOOD =
  '0x5f794cf7faba3c8526079292726f29e5a88f40cc';
export const LITTLE_JOHN_BONDING_HOOK_ON_ROBINHOOD =
  '0xa8a5c4932ba4cc71347dcab30329c2816ba028cc';
export const LITTLE_JOHN_HOOK_ON_ROBINHOOD =
  '0x23739445e76d83a40f87fe2fd6a53e73badf60cc';
// Rivers LaunchHook — additional Robinhood deployments (V2 / V3) of the
// verified LaunchHook contract, separate from RIVERS_LAUNCH_HOOK_ON_ROBINHOOD.
export const RIVERS_LAUNCH_HOOK_V2_ON_ROBINHOOD =
  '0xcd87186fc4f809241f3e7ff3ca557bb7cc962acc';
export const RIVERS_LAUNCH_HOOK_V3_ON_ROBINHOOD =
  '0x59e2cea84bf858b66d46b22742bef4304ee0aacc';
// StrategyHook — two Robinhood deployments of the same verified contract.
export const STRATEGY_HOOK_ON_ROBINHOOD =
  '0x4a00b5f169eadee5524e819bf418dfd797336544';
export const STRATEGY_HOOK_ON_ROBINHOOD_2 =
  '0xc8fe3570f110d092e86393c095c6998a8d5a6544';
export const BACKED_FEE_HOOK_ON_ROBINHOOD =
  '0xced7aa50727f3cd251985b09a2080db056a8c0cc';
export const KLIK_HOOK_ON_ROBINHOOD =
  '0x745d717620052a97a22deee2e5eba59583f3e0cc';

export const PRICE_IMPACT_DYNAMIC_FEE_HOOK_ON_MAINNET =
  '0x3a9f9e9fcb1377de2c2f88ea0d8166e92bbf60c0';
export const NFTX_V4_HOOK_ON_MAINNET =
  '0xd2094b5cdb1a12b6274e4a4d3a252cd94c51efcc';

/**
 * Allowlisted V4 hooks whose pools hold real liquidity but whose
 * subgraph-reported `totalValueLockedETH` is below `V4_MIN_TVL_ETH` (e.g.
 * hook-accounted reserves or an unpriced counter token), so the standard
 * discovery query would drop them. Addresses listed here are admitted to the
 * routing cache by hook address, bypassing the TVL/liquidity floor — same
 * routing-admission treatment and trust model as `ZLCA_HOOKS_PER_CHAIN`
 * (but with no per-hop gas overhead). Every address must also appear in
 * `HOOKS_ADDRESSES_ALLOWLIST`; remove an entry once its pool clears the
 * floor on its own.
 */
export const ZERO_MEASURED_TVL_HOOKS_PER_CHAIN: Partial<
  Record<ChainId, string[]>
> &
  Record<number, string[]> = {
  [ChainId.ROBINHOOD]: [
    INDEX_FEE_HOOK_ON_ROBINHOOD,
    PENSION_TAX_HOOK_ON_ROBINHOOD,
  ],
};

// Union of both TVL-bypass registries, built once at module load (same
// rationale as AGG_HOOKS_REVERSE_LOOKUP): chainId -> lowercased hook set.
const TVL_BYPASS_HOOKS_BY_CHAIN = new Map<number, Set<string>>();
{
  const addHooks = (chainIdStr: string, hooks: string[]) => {
    if (hooks.length === 0) return;
    const chainId = Number(chainIdStr);
    const set = TVL_BYPASS_HOOKS_BY_CHAIN.get(chainId) ?? new Set<string>();
    hooks.forEach(hook => set.add(hook.toLowerCase()));
    TVL_BYPASS_HOOKS_BY_CHAIN.set(chainId, set);
  };
  for (const [chainIdStr, hooks] of Object.entries(ZLCA_HOOKS_PER_CHAIN)) {
    addHooks(chainIdStr, Object.keys(hooks));
  }
  for (const [chainIdStr, hooks] of Object.entries(
    ZERO_MEASURED_TVL_HOOKS_PER_CHAIN
  )) {
    addHooks(chainIdStr, hooks);
  }
}

/**
 * TVL-bypass hook addresses for a chain (ZLCA ∪ zero-measured-TVL,
 * lowercased), or undefined when neither registry has entries — callers
 * use the undefined to skip bypass handling entirely. Single source of
 * truth for the routing-admission consumers (subgraph fetch + sanitize
 * exemption, top-pool force-selection, cache-read force-select).
 */
export function getTvlBypassHookAddresses(
  chainId: number
): ReadonlySet<string> | undefined {
  return TVL_BYPASS_HOOKS_BY_CHAIN.get(chainId);
}

export const HOOKS_ADDRESSES_ALLOWLIST: Partial<
  Record<ChainId, Array<string>>
> &
  Record<number, Array<string>> = {
  [ChainId.MAINNET]: [
    ADDRESS_ZERO,
    WETH_HOOKS_ADDRESS_ON_MAINNET,
    CLANKER_STATIC_FEE_HOOKS_ADDRESS_ON_MAINNET,
    TOKENWORKS_HOOK_ON_MAINNET_1,
    TOKENWORKS_HOOK_ON_MAINNET_4,
    TOKENWORKS_HOOK_ON_MAINNET_5,
    STRATEGICRESERVE_HOOK_ON_MAINNET,
    ENS_WHEEL_HOOK_ON_MAINNET,
    ASTERIX_HOOK_ADDRESS_ON_MAINNET,
    ACTION_HOOK_ON_MAINNET,
    M0_ALLOWLIST_HOOKS_ADDRESS_ON_MAINNET,
    M0_TICK_RANGE_HOOKS_ADDRESS_ON_MAINNET,
    RING_FEW_ETH_HOOK_ON_MAINNET,
    RING_FEW_UNI_HOOK_ON_MAINNET,
    RING_FEW_WBTC_HOOK_ON_MAINNET,
    RING_FEW_CBBTC_HOOK_ON_MAINNET,
    RING_FEW_USDC_HOOK_ON_MAINNET,
    RING_FEW_USDT_HOOK_ON_MAINNET,
    RING_FEW_DAI_HOOK_ON_MAINNET,
    RING_FEW_WEETH_HOOK_ON_MAINNET,
    RING_FEW_WSTETH_HOOK_ON_MAINNET,
    MEME_STRATEGY_HOOK_ON_MAINNET,
    TOKEN_FLOW_TAX_HOOK_ON_MAINNET,
    ARRAKIS_PRIVATE_HOOK_ON_MAINNET,
    CUSTOM_FEE_MEV_PROTECTION_HOOK_ON_MAINNET,
    BVCC_DYNAMIC_FEE_HOOK_ON_MAINNET,
    AZTEC_HOOK_ADDRESS_ON_MAINNET,
    TETRIS_CUSTOM_DYNAMIC_FEE_HOOK_ON_MAINNET,
    AUTO_LIQUIDITY_GENERATOR_HOOK_ON_MAINNET,
    ENS_WHEEL_HOOK_ON_MAINNET_2,
    UPEG_HOOK_ON_MAINNET,
    GUIDESTAR_STABLE_STABLE_HOOK_ON_MAINNET,
    ETIM_TAX_HOOK_ON_MAINNET,
    ASH_HOOK_ON_MAINNET,
    LIVO_SWAP_HOOK_ON_MAINNET,
    LIVO_SWAP_HOOK_V2_ON_MAINNET,
    LIVO_SWAP_HOOK_V3_ON_MAINNET,
    UNIAGENT_V4_HOOK_ON_MAINNET,
    MEV_X_HOMELANDER_ON_MAINNET,
    AEGIS_ENGINE_ON_MAINNET,
    TTTHOOK_ON_MAINNET,
    JRNY_HOOK_ON_MAINNET,
    AEGIS_DFM_ON_MAINNET,
    ONCHAIN_RAID_ON_MAINNET,
    DEPLOYERTAXHOOK_ON_MAINNET,
    TOKENWORKS_HOOK_ON_MAINNET_2,
    TOKENWORKS_HOOK_ON_MAINNET_3,
    BACKGEOORACLE_ON_MAINNET,
    JRNY_HOOK_V2_ON_MAINNET,
    ETIMTAXHOOK_V2_ON_MAINNET,
    PAMHOOK_ON_MAINNET,
    TAXHOOK_ON_MAINNET,
    VORTEXHOOK_ON_MAINNET,
    DIAMONDHANDSHOOK_ON_MAINNET,
    LITEPSM_AGGREGATOR_HOOK_USDS_ON_MAINNET,
    LITEPSM_AGGREGATOR_HOOK_DAI_ON_MAINNET,
    DUALPOOL_HOOK_ON_MAINNET,
    BASEDBID_PROGRAMMABLE_FEE_HOOK_ON_MAINNET,
    FWATOKENHOOK_ON_MAINNET,
    PRICE_IMPACT_DYNAMIC_FEE_HOOK_ON_MAINNET,
    NFTX_V4_HOOK_ON_MAINNET,
    FWATOKENHOOK_ON_MAINNET_2,
    ...(AGG_HOOKS_REVERSE_LOOKUP.get(ChainId.MAINNET)?.keys() ?? []),
  ],
  [ChainId.GOERLI]: [ADDRESS_ZERO],
  [ChainId.SEPOLIA]: [
    ADDRESS_ZERO,
    extraHooksAddressesOnSepolia,
    FEY_ON_SEPOLIA,
  ],
  [ChainId.OPTIMISM]: [
    ADDRESS_ZERO,
    WETH_HOOKS_ADDRESS_ON_OP_MAINNET,
    FINDEX_HOOK_ON_OPTIMISM,
    FINDEX_HOOK_V2_ON_OPTIMISM,
    DYNAMIC_VOLUME_HOOK_ON_OPTIMISM,
    AEGIS_DFM_ON_OPTIMISM,
    BACKGEOORACLE_ON_OPTIMISM,
  ],
  [ChainId.OPTIMISM_GOERLI]: [ADDRESS_ZERO],
  [ChainId.OPTIMISM_SEPOLIA]: [ADDRESS_ZERO],
  [ChainId.ARBITRUM_ONE]: [
    ADDRESS_ZERO,
    SLIPPAGE_FEE_HOOK_ON_ARBITRUM,
    CLANKER_DYNAMIC_FEE_HOOKS_ADDRESS_ON_ARBITRUM,
    CLANKER_STATIC_FEE_HOOKS_ADDRESS_ON_ARBITRUM,
    WETH_HOOKS_ADDRESS_ON_ARBITRUM,
    LIMIT_ORDER_HOOKS_ADDRESS_ON_ARBITRUM,
    DORY_BURN_AND_MINT_POWER_HOOK_ON_ARBITRUM,
    BVCC_DYNAMIC_FEE_HOOK_ON_ARBITRUM,
    ZOO_FINANCE_LNT_VATH_ATH_HOOKS_ADDRESS_ON_ARBITRUM,
    ALPHIX_LVR_FEE_HOOK_ON_ARBITRUM,
    MEV_X_HOMELANDER_ON_ARBITRUM,
    AEGIS_DFM_ON_ARBITRUM,
    BACKGEOORACLE_ON_ARBITRUM,
    THE_POOL_ON_ARBITRUM,
  ],
  [ChainId.ARBITRUM_GOERLI]: [ADDRESS_ZERO],
  [ChainId.ARBITRUM_SEPOLIA]: [ADDRESS_ZERO],
  [ChainId.POLYGON]: [
    ADDRESS_ZERO,
    AEGIS_V1_1_ON_POLYGON,
    MEV_X_HOMELANDER_ON_POLYGON,
    AEGIS_DFM_ON_POLYGON,
    FINDEX_HOOK_V2_ON_POLYGON,
  ],
  [ChainId.POLYGON_MUMBAI]: [ADDRESS_ZERO],
  [ChainId.CELO]: [ADDRESS_ZERO, AEGIS_DFM_ON_CELO],
  [ChainId.CELO_ALFAJORES]: [ADDRESS_ZERO],
  [ChainId.GNOSIS]: [ADDRESS_ZERO],
  [ChainId.MOONBEAM]: [ADDRESS_ZERO],
  [ChainId.BNB]: [
    ADDRESS_ZERO,
    BVCC_DYNAMIC_FEE_HOOK_ON_BSC,
    CLANKER_DYNAMIC_FEE_HOOKS_ADDRESS_ON_BSC,
    LAUNCHLY_BNB_HOOKS_ADDRESS_ON_BNB,
    FINDEX_HOOK_ON_BSC,
    FINDEX_HOOK_V2_ON_BNB,
    BUY_HOOK_V1_ON_BNB,
    BUY_HOOK_V2_ON_BNB,
    BUY_HOOK_V3_ON_BNB,
    MEV_X_HOMELANDER_ON_BNB,
    AEGIS_DFM_ON_BNB,
    BACKGEOORACLE_ON_BNB,
    CLANKER_STATIC_FEE_HOOKS_ADDRESS_ON_BSC_v2,
    BASEDBID_PROGRAMMABLE_FEE_HOOK_ON_BNB,
    VERSUS_PROTECTED_HOOK_ON_BNB,
  ],
  [ChainId.AVALANCHE]: [
    ADDRESS_ZERO,
    AVAXSTRATEGIES_STATIC_FEE_HOOKS_ADDRESS_ON_AVAX,
    AEGIS_DFM_ON_AVALANCHE,
  ],
  [ChainId.BASE_GOERLI]: [ADDRESS_ZERO],
  [ChainId.BASE_SEPOLIA]: [ADDRESS_ZERO],
  [ChainId.BASE]: [
    ADDRESS_ZERO,
    FLAUNCH_POSM_V1_ON_BASE,
    FLAUNCH_POSM_V2_ON_BASE,
    FLAUNCH_POSM_V3_ON_BASE,
    FLAUNCH_POSM_V4_ON_BASE,
    FLAUNCH_ANYPOSM_V1_ON_BASE,
    ETH_FLETH_AUTO_WRAP_HOOKS_ADDRESS_ON_BASE,
    GRADUATION_HOOKS_ADDRESS_ON_BASE,
    TWAMM_HOOKS_ADDRESS_ON_BASE,
    BTC_ACC_ON_BASE,
    CLANKER_DYNAMIC_FEE_HOOKS_ADDRESS_ON_BASE,
    CLANKER_STATIC_FEE_HOOKS_ADDRESS_ON_BASE,
    CLANKER_DYNAMIC_FEE_HOOKS_ADDRESS_ON_BASE_v2,
    CLANKER_STATIC_FEE_HOOKS_ADDRESS_ON_BASE_v2,
    WETH_HOOKS_ADDRESS_ON_BASE,
    DOPPLER_HOOKS_ADDRESS_ON_BASE,
    DOPPLER_HOOKS_ADDRESS_ON_BASE_V2,
    DOPPLER_HOOKS_ADDRESS_ON_BASE_V3,
    LIMIT_ORDER_HOOKS_ADDRESS_ON_BASE,
    ZORA_CREATOR_HOOK_ON_BASE_v1,
    ZORA_CREATOR_HOOK_ON_BASE_v1_0_0_1,
    ZORA_CREATOR_HOOK_ON_BASE_v1_1_1,
    ZORA_CREATOR_HOOK_ON_BASE_v1_1_1_1,
    ZORA_CREATOR_HOOK_ON_BASE_v1_1_2,
    ZORA_CREATOR_HOOK_ON_BASE_v2_2,
    ZORA_CREATOR_HOOK_ON_BASE_v2_2_1,
    ZORA_POST_HOOK_ON_BASE_v1,
    ZORA_POST_HOOK_ON_BASE_v1_0_0_1,
    ZORA_POST_HOOK_ON_BASE_v1_0_0_2,
    ZORA_POST_HOOK_ON_BASE_v1_1_1,
    ZORA_POST_HOOK_ON_BASE_v1_1_1_1,
    ZORA_POST_HOOK_ON_BASE_v1_1_2,
    ZORA_POST_HOOK_ON_BASE_v2_2,
    ZORA_POST_HOOK_ON_BASE_v2_2_1,
    ZORA_POST_HOOK_ON_BASE_v2_3_0,
    ZORA_POST_HOOK_ON_BASE_v2_4_0,
    FEY_ON_BASE,
    PUBHOUSE_HOOK_ON_BASE,
    DELI_HOOK_ADDRESS_ON_BASE,
    DELI_HOOK_CONSTANT_PRODUCT_ON_BASE,
    AQUINAS_HOOK_ADDRESS_ON_BASE,
    AQUINAS_HOOK_ADDRESS_ON_BASE_2,
    SUPERSTRATEGY_HOOK_ON_BASE,
    SIMPLE_SELL_TAX_HOOK_ON_BASE,
    WASSBLASTER_HOOK_ON_BASE,
    BVCC_DYNAMIC_FEE_HOOK_ON_BASE,
    AEGIS_V3,
    FARSTR_HOOKS_ADDRESS_ON_BASE,
    ARTACLE_INDEX_TOKEN_HOOK_ON_BASE,
    GPO_HOOKS,
    GPX_HOOKS,
    ARRAKIS_PRIVATE_HOOK_ON_BASE,
    BASEMEME_HOOK_ADDRESS_ON_BASE,
    AI_PROTOCOL_SWAP_FEE_HOOK_V1_ON_BASE,
    LIQUID_LAUNCH_HOOK_ON_BASE,
    BVCC_DYNAMIC_FEE_HOOK_ON_BASE,
    CLAUNCH_HOOK_ON_BASE,
    SEEDIFY_SPARK_HOOK_ON_BASE,
    ANSTROM_HOOK_ON_BASE,
    ACCUMULATE_HOOK_ON_BASE,
    ADAPTIVE_BURN_HOOK_ON_BASE,
    LAUNCHLY_HOOK_ON_BASE,
    DRXGAI_HOOK_ON_BASE,
    INT_FEE_HOOK_ON_BASE,
    ALPHIX_LVR_FEE_HOOK_ON_BASE,
    ANGSTROM_L2_HOOK_1_ON_BASE,
    ANGSTROM_L2_HOOK_2_ON_BASE,
    LIQUID_PROTOCOL_HOOK_ON_BASE,
    LIQUID_PROTOCOL_HOOK_STATIC_ON_BASE,
    TOKENS_FUN_ON_BASE,
    TOKENS_FUN_2_ON_BASE,
    TOKENS_FUN_3_ON_BASE,
    TOKENS_FUN_4_ON_BASE,
    APEX_YIELD_HOOK_ON_BASE,
    ESTATE_BONDING_CURVE_HOOK_ON_BASE,
    MEV_X_HOMELANDER_ON_BASE,
    JANPU_STATIC_FEE_V2_ON_BASE,
    JANPU_HOOK_DYNAMIC_FEE_V2_ON_BASE,
    A51PEG_HOOK_ON_BASE,
    AEGIS_DFM_ON_BASE,
    SNAPBACK_PROTOCOL_ON_BASE,
    BACKGEOORACLE_ON_BASE,
    SUPER_STRATEGY_ON_BASE,
    SUPER_STRATEGY_V2_ON_BASE,
    SUPER_STRATEGY_V3_ON_BASE,
    SETHHOOK_ON_BASE,
    ARMSYS_ON_BASE,
    BASEDBID_PROGRAMMABLE_FEE_HOOK_ON_BASE,
    BONKER_DYNAMIC_FEE_HOOK_ON_BASE,
    BONKER_STATIC_FEE_HOOK_ON_BASE,
    URULAUNCH_HOOK_ON_BASE,
    ...(AGG_HOOKS_REVERSE_LOOKUP.get(ChainId.BASE)?.keys() ?? []),
  ],
  [ChainId.ZORA]: [ADDRESS_ZERO, AEGIS_DFM_ON_ZORA],
  [ChainId.ZORA_SEPOLIA]: [ADDRESS_ZERO],
  [ChainId.ROOTSTOCK]: [ADDRESS_ZERO],
  [ChainId.BLAST]: [ADDRESS_ZERO, AEGIS_DFM_ON_BLAST],
  [ChainId.ZKSYNC]: [ADDRESS_ZERO],
  [ChainId.WORLDCHAIN]: [ADDRESS_ZERO, AEGIS_DFM_ON_WORLDCHAIN],
  [ChainId.UNICHAIN_SEPOLIA]: [ADDRESS_ZERO],
  [ChainId.UNICHAIN]: [
    ADDRESS_ZERO,
    RENZO_ON_UNICHAIN,
    AEGIS_ON_UNICHAIN_V1,
    AEGIS_ON_UNICHAIN_V2,
    AEGIS_V3,
    WETH_HOOKS_ADDRESS_ON_UNICHAIN,
    CLANKER_DYNAMIC_FEE_HOOKS_ADDRESS_ON_UNICHAIN,
    CLANKER_STATIC_FEE_HOOKS_ADDRESS_ON_UNICHAIN,
    LIMIT_ORDER_HOOKS_ADDRESS_ON_UNICHAIN,
    PANOPTIC_ORACLE_HOOK_ON_UNICHAIN,
    UNIDERP_HOOK_ON_UNICHAIN,
    UNIVERSAL_HOOK_ON_UNICHAIN,
    MEV_X_HOMELANDER_ON_UNICHAIN,
    AEGIS_DFM_ON_UNICHAIN,
    STABLE_PROTECTION_ON_UNICHAIN,
    BACKGEOORACLE_ON_UNICHAIN,
  ],
  [ChainId.MONAD_TESTNET]: [ADDRESS_ZERO],
  [ChainId.MONAD]: [
    ADDRESS_ZERO,
    WETH_HOOKS_ADDRESS_ON_MONAD,
    CLANKER_STATIC_FEE_HOOKS_ADDRESS_ON_MONAD,
    DOPPLER_HOOKS_ADDRESS_ON_MONAD,
    CULT_FEE_HOOK_ADDRESS_ON_MONAD,
    AEGIS_DFM_HOOK_ON_MONAD,
    MEV_X_HOMELANDER_ON_MONAD,
    AEGIS_ENGINE_ON_MONAD,
  ],
  [ChainId.SONEIUM]: [ADDRESS_ZERO, AEGIS_DFM_ON_SONEIUM],
  [ChainId.XLAYER]: [ADDRESS_ZERO, AEGIS_V3, AEGIS_DFM_ON_XLAYER],
  [ChainId.LINEA]: [ADDRESS_ZERO],
  [ChainId.MEGAETH]: [ADDRESS_ZERO, TEST_HOOK_ON_MEGAETH],
  [ChainId.ROBINHOOD]: [
    ADDRESS_ZERO,
    DOPPLER_HOOKS_ADDRESS_ON_ROBINHOOD,
    INDEX_FEE_HOOK_ON_ROBINHOOD,
    PENSION_TAX_HOOK_ON_ROBINHOOD,
    CLANKER_STATIC_FEE_HOOKS_ADDRESS_ON_ROBINHOOD,
    CLANKER_DYNAMIC_FEE_HOOKS_ADDRESS_ON_ROBINHOOD,
    RIVERS_LAUNCH_HOOK_ON_ROBINHOOD,
    SHARES_HOOK_ON_ROBINHOOD,
    PLEB_INDEX_FEE_HOOK_ON_ROBINHOOD,
    LIVO_SWAP_HOOK_ON_ROBINHOOD,
    LIVO_SWAP_HOOK_ON_ROBINHOOD_2,
    LIVO_SWAP_HOOK_ON_ROBINHOOD_3,
    PUMP_V4_HOOK_ON_ROBINHOOD,
    MEME_ETF_PORTFOLIO_FEE_HOOK_ON_ROBINHOOD,
    ROB_FEE_HOOK_ON_ROBINHOOD,
    LITTLE_JOHN_BONDING_HOOK_ON_ROBINHOOD,
    LITTLE_JOHN_HOOK_ON_ROBINHOOD,
    RIVERS_LAUNCH_HOOK_V2_ON_ROBINHOOD,
    RIVERS_LAUNCH_HOOK_V3_ON_ROBINHOOD,
    STRATEGY_HOOK_ON_ROBINHOOD,
    STRATEGY_HOOK_ON_ROBINHOOD_2,
    BACKED_FEE_HOOK_ON_ROBINHOOD,
    KLIK_HOOK_ON_ROBINHOOD,
    FLAUNCH_POSM_ON_ROBINHOOD,
  ],
  [CHAIN_ID_INK]: [ADDRESS_ZERO],
  [ChainId.TEMPO]: [ADDRESS_ZERO, ...AGG_HOOKS_ON_TEMPO],
  [CHAIN_ID_ARC]: [ADDRESS_ZERO],
};
