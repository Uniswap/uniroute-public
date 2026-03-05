import brotli from 'brotli';
import {estimateL1Gas, estimateL1GasCost} from '@eth-optimism/sdk';
import {BigNumber} from '@ethersproject/bignumber';
import {Currency, Percent, TradeType} from '@uniswap/sdk-core';
import {
  ChainId,
  IUniRouteServiceConfig,
  OPTIMISM_STACK_CHAINS,
} from '../../lib/config';

import {AAVE_MAINNET, LIDO_MAINNET} from '../../lib/tokenUtils';
import {RouteBasic} from '../../models/route/RouteBasic';
import {UniProtocol} from '../../models/pool/UniProtocol';
import {V3Pool} from '../../models/pool/V3Pool';
import {V4Pool} from '../../models/pool/V4Pool';
import {ArbitrumGasData} from './gas-data-provider';
import {BaseProvider, TransactionRequest} from '@ethersproject/providers';
import {
  buildSwapMethodParameters,
  buildTrade,
} from '../../lib/methodParameters';
import {Erc20Token} from '../../models/token/Erc20Token';
import {QuoteSplit} from '../../models/quote/QuoteSplit';
import {Context} from '@uniswap/lib-uni/context';
import {
  SwapOptionsUniversalRouter,
  SwapType,
} from '../simulator/sor-port/simulation-provider';
import {UniversalRouterVersion} from '@uniswap/universal-router-sdk';

// Cost for crossing an uninitialized tick.
export const COST_PER_UNINIT_TICK = BigNumber.from(0);

//l2 execution fee on optimism is roughly the same as mainnet
export const BASE_SWAP_COST = (id: ChainId): BigNumber => {
  switch (id) {
    case ChainId.MAINNET:
    case ChainId.SEPOLIA:
    case ChainId.OPTIMISM:
    case ChainId.BNB:
    case ChainId.AVAX:
    case ChainId.BASE:
    case ChainId.ZORA:
    case ChainId.BLAST:
    case ChainId.ZKSYNC:
    case ChainId.UNICHAIN:
    case ChainId.WORLDCHAIN:
    case ChainId.UNICHAIN_SEPOLIA:
    case ChainId.MONAD_TESTNET:
    case ChainId.MONAD:
    case ChainId.BASE_SEPOLIA:
    case ChainId.SONEIUM:
    case ChainId.XLAYER:
      return BigNumber.from(2000);
    case ChainId.ARBITRUM:
      return BigNumber.from(5000);
    case ChainId.POLYGON:
      return BigNumber.from(2000);
    case ChainId.CELO:
      return BigNumber.from(2000);
  }
};
export const COST_PER_INIT_TICK = (id: ChainId): BigNumber => {
  switch (id) {
    case ChainId.MAINNET:
    case ChainId.SEPOLIA:
    case ChainId.BNB:
    case ChainId.AVAX:
      return BigNumber.from(31000);
    case ChainId.OPTIMISM:
    case ChainId.BASE:
    case ChainId.ZORA:
    case ChainId.BLAST:
    case ChainId.ZKSYNC:
    case ChainId.UNICHAIN:
    case ChainId.WORLDCHAIN:
    case ChainId.UNICHAIN_SEPOLIA:
    case ChainId.MONAD_TESTNET:
    case ChainId.MONAD:
    case ChainId.BASE_SEPOLIA:
    case ChainId.SONEIUM:
    case ChainId.XLAYER:
      return BigNumber.from(31000);
    case ChainId.ARBITRUM:
      return BigNumber.from(31000);
    case ChainId.POLYGON:
      return BigNumber.from(31000);
    case ChainId.CELO:
      return BigNumber.from(31000);
  }
};

export const COST_PER_HOP = (id: ChainId): BigNumber => {
  switch (id) {
    case ChainId.MAINNET:
    case ChainId.SEPOLIA:
    case ChainId.BNB:
    case ChainId.OPTIMISM:
    case ChainId.AVAX:
    case ChainId.BASE:
    case ChainId.ZORA:
    case ChainId.BLAST:
    case ChainId.ZKSYNC:
    case ChainId.UNICHAIN:
    case ChainId.WORLDCHAIN:
    case ChainId.UNICHAIN_SEPOLIA:
    case ChainId.MONAD_TESTNET:
    case ChainId.MONAD:
    case ChainId.BASE_SEPOLIA:
    case ChainId.SONEIUM:
    case ChainId.XLAYER:
      return BigNumber.from(80000);
    case ChainId.ARBITRUM:
      return BigNumber.from(80000);
    case ChainId.POLYGON:
      return BigNumber.from(80000);
    case ChainId.CELO:
      return BigNumber.from(80000);
  }
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const SINGLE_HOP_OVERHEAD = (_id: ChainId): BigNumber => {
  return BigNumber.from(15000);
};

export const TOKEN_OVERHEAD = (id: ChainId, route: RouteBasic): BigNumber => {
  let containsAave = false;
  let containsLido = false;
  if (route.protocol === UniProtocol.V3) {
    const pools: V3Pool[] = route.path as V3Pool[];
    containsAave = pools.some((pool: V3Pool) => {
      return (
        pool.token0.address.toLowerCase() ===
          AAVE_MAINNET.address.toLowerCase() ||
        pool.token1.address.toLowerCase() === AAVE_MAINNET.address.toLowerCase()
      );
    });
    containsLido = pools.some((pool: V3Pool) => {
      return (
        pool.token0.address.toLowerCase() ===
          LIDO_MAINNET.address.toLowerCase() ||
        pool.token1.address.toLowerCase() === LIDO_MAINNET.address.toLowerCase()
      );
    });
  } else {
    const pools: V4Pool[] = route.path as V4Pool[];
    containsAave = pools.some((pool: V4Pool) => {
      return (
        pool.token0.address.toLowerCase() ===
          AAVE_MAINNET.address.toLowerCase() ||
        pool.token1.address.toLowerCase() === AAVE_MAINNET.address.toLowerCase()
      );
    });
    containsLido = pools.some((pool: V4Pool) => {
      return (
        pool.token0.address.toLowerCase() ===
          LIDO_MAINNET.address.toLowerCase() ||
        pool.token1.address.toLowerCase() === LIDO_MAINNET.address.toLowerCase()
      );
    });
  }

  let overhead = BigNumber.from(0);

  if (id === ChainId.MAINNET) {
    // AAVE's transfer contains expensive governance snapshotting logic. We estimate
    // it at around 150k.
    if (containsAave) {
      overhead = overhead.add(150000);
    }

    // LDO's reaches out to an external token controller which adds a large overhead
    // of around 150k.
    if (containsLido) {
      overhead = overhead.add(150000);
    }
  }

  return overhead;
};

// TODO: change per chain
export const NATIVE_WRAP_OVERHEAD = (id: ChainId): BigNumber => {
  switch (id) {
    default:
      return BigNumber.from(27938);
  }
};

export const NATIVE_UNWRAP_OVERHEAD = (id: ChainId): BigNumber => {
  switch (id) {
    default:
      return BigNumber.from(36000);
  }
};

export const NATIVE_OVERHEAD = (
  chainId: ChainId,
  amount: Currency,
  quote: Currency
): BigNumber => {
  if (amount.isNative) {
    // need to wrap eth in
    return NATIVE_WRAP_OVERHEAD(chainId);
  }
  if (quote.isNative) {
    // need to unwrap eth out
    return NATIVE_UNWRAP_OVERHEAD(chainId);
  }
  return BigNumber.from(0);
};

// Ported from SOR
export const calculateL1GasFeesHelper = async (
  serviceConfig: IUniRouteServiceConfig,
  tokenInCurrency: Currency,
  tokenOutCurrency: Currency,
  amountIn: bigint,
  chainId: ChainId,
  tokensInfo: Map<string, Erc20Token | null>,
  tradeType: TradeType,
  quoteSplit: QuoteSplit,
  provider: BaseProvider,
  ctx: Context,
  l2GasData?: ArbitrumGasData
): Promise<{
  gasUsedL1: BigNumber;
  gasCostWeiL1: BigNumber;
  gasUsedL1OnL2: BigNumber;
}> => {
  const swapOptions: SwapOptionsUniversalRouter = {
    type: SwapType.UNIVERSAL_ROUTER,
    version: UniversalRouterVersion.V2_0,
    recipient: '0x0000000000000000000000000000000000000001',
    deadlineOrPreviousBlockhash: 100,
    slippageTolerance: new Percent(5, 10_000),
  };
  let mainnetGasUsed = BigNumber.from(0);
  let mainnetFeeInWei = BigNumber.from(0);
  let gasUsedL1OnL2 = BigNumber.from(0);

  try {
    if (
      OPTIMISM_STACK_CHAINS.includes(chainId) &&
      serviceConfig.L1L2GasCostFetcher.OpStackEnabled
    ) {
      [mainnetGasUsed, mainnetFeeInWei] =
        await calculateOptimismToL1SecurityFee(
          serviceConfig,
          tokenInCurrency,
          tokenOutCurrency,
          amountIn,
          chainId,
          tokensInfo,
          tradeType,
          quoteSplit,
          swapOptions,
          provider,
          ctx
        );
    } else if (
      chainId === ChainId.ARBITRUM &&
      serviceConfig.L1L2GasCostFetcher.ArbitrumEnabled
    ) {
      [mainnetGasUsed, mainnetFeeInWei, gasUsedL1OnL2] =
        calculateArbitrumToL1SecurityFee(
          serviceConfig,
          tokenInCurrency,
          tokenOutCurrency,
          amountIn,
          chainId,
          tokensInfo,
          tradeType,
          quoteSplit,
          swapOptions,
          provider,
          ctx,
          l2GasData!
        );
    }
  } catch (error) {
    ctx.logger.error('Error calculating L1 gas fees', {
      error,
      chainId,
    });
    mainnetGasUsed = BigNumber.from(0);
    gasUsedL1OnL2 = BigNumber.from(0);
    mainnetFeeInWei = BigNumber.from(0);
  }

  return {
    gasUsedL1: mainnetGasUsed,
    gasCostWeiL1: mainnetFeeInWei,
    gasUsedL1OnL2: gasUsedL1OnL2,
  };
};

/**
 * To avoid having a call to optimism's L1 security fee contract for every route and amount combination,
 * we replicate the gas cost accounting here.
 * Ported from SOR
 */
async function calculateOptimismToL1SecurityFee(
  serviceConfig: IUniRouteServiceConfig,
  tokenInCurrency: Currency,
  tokenOutCurrency: Currency,
  amountIn: bigint,
  chainId: ChainId,
  tokensInfo: Map<string, Erc20Token | null>,
  tradeType: TradeType,
  quoteSplit: QuoteSplit,
  swapConfig: SwapOptionsUniversalRouter,
  provider: BaseProvider,
  ctx: Context
): Promise<[BigNumber, BigNumber]> {
  // build trade for swap calldata
  const trade = buildTrade(
    tokenInCurrency,
    tokenOutCurrency,
    amountIn,
    chainId,
    tokensInfo,
    tradeType,
    quoteSplit,
    false, // percentageSumCheck
    ctx
  );
  const data = buildSwapMethodParameters(
    ctx,
    swapConfig,
    ChainId.OPTIMISM,
    trade
  ).calldata;

  const [l1GasUsed, l1GasCost] = await calculateOptimismToL1FeeFromCalldata(
    data,
    chainId,
    provider
  );
  return [l1GasUsed, l1GasCost];
}

// Ported from SOR
function calculateArbitrumToL1SecurityFee(
  serviceConfig: IUniRouteServiceConfig,
  tokenInCurrency: Currency,
  tokenOutCurrency: Currency,
  amountIn: bigint,
  chainId: ChainId,
  tokensInfo: Map<string, Erc20Token | null>,
  tradeType: TradeType,
  quoteSplit: QuoteSplit,
  swapConfig: SwapOptionsUniversalRouter,
  provider: BaseProvider,
  ctx: Context,
  gasData: ArbitrumGasData
): [BigNumber, BigNumber, BigNumber] {
  if (
    serviceConfig.L1L2GasCostFetcher
      .SkipArbitrumCallDataGenerationAndApproximate
  ) {
    // in this case we approximate the gas cost by using generic gas data size
    const data =
      '0x' +
      'a'.repeat(
        serviceConfig.L1L2GasCostFetcher.ArbitrumCallDataApproximateSize
      );
    return calculateArbitrumToL1FeeFromCalldata(data, gasData, chainId);
  } else {
    // build trade for swap calldata
    const trade = buildTrade(
      tokenInCurrency,
      tokenOutCurrency,
      amountIn,
      chainId,
      tokensInfo,
      tradeType,
      quoteSplit,
      false, // percentageSumCheck
      ctx
    );
    const data = buildSwapMethodParameters(
      ctx,
      swapConfig,
      ChainId.ARBITRUM,
      trade
    ).calldata;
    return calculateArbitrumToL1FeeFromCalldata(data, gasData, chainId);
  }
}

// Optimism related gas helper methods
// Ported from SOR
export async function calculateOptimismToL1FeeFromCalldata(
  calldata: string,
  chainId: ChainId,
  provider: BaseProvider
): Promise<[BigNumber, BigNumber]> {
  const tx: TransactionRequest = {
    data: calldata,
    chainId: chainId,
    type: 2, // sign the transaction as EIP-1559, otherwise it will fail at maxFeePerGas
  };
  const [l1GasUsed, l1GasCost] = await Promise.all([
    estimateL1Gas(provider, tx),
    estimateL1GasCost(provider, tx),
  ]);
  return [l1GasUsed, l1GasCost];
}

// Arbitrum related gas helper methods
// Ported from SOR
export function calculateArbitrumToL1FeeFromCalldata(
  calldata: string,
  gasData: ArbitrumGasData,
  chainId: ChainId
): [BigNumber, BigNumber, BigNumber] {
  const {perL2TxFee, perL1CalldataFee, perArbGasTotal} = gasData;
  // calculates gas amounts based on bytes of calldata, use 0 as overhead.
  const l1GasUsed = getL2ToL1GasUsed(calldata, chainId);
  // multiply by the fee per calldata and add the flat l2 fee
  const l1Fee = l1GasUsed.mul(perL1CalldataFee).add(perL2TxFee);
  const gasUsedL1OnL2 = l1Fee.div(perArbGasTotal);
  return [l1GasUsed, l1Fee, gasUsedL1OnL2];
}

// Ported from SOR
export function getL2ToL1GasUsed(data: string, chainId: ChainId): BigNumber {
  switch (chainId) {
    case ChainId.ARBITRUM: {
      // calculates bytes of compressed calldata
      const l1ByteUsed = getArbitrumBytes(data);
      return l1ByteUsed.mul(16);
    }
    default:
      return BigNumber.from(0);
  }
}

// Ported from SOR
export function getArbitrumBytes(data: string): BigNumber {
  if (data === '') return BigNumber.from(0);
  const compressed = brotli.compress(
    Buffer.from(data.replace('0x', ''), 'hex'),
    {
      mode: 0,
      quality: 1,
      lgwin: 22,
    }
  );
  // TODO: This is a rough estimate of the compressed size
  // Brotli 0 should be used, but this brotli library doesn't support it
  // https://github.com/foliojs/brotli.js/issues/38
  // There are other brotli libraries that do support it, but require async
  // We workaround by using Brotli 1 with a 20% bump in size
  return BigNumber.from(compressed.length).mul(120).div(100);
}
