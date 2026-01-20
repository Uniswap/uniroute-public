import {describe, it, expect} from 'vitest';
import {GasEstimateProvider} from './GasEstimateProvider';
import {RouteBasic} from '../../../models/route/RouteBasic';
import {
  ChainId,
  getUniRouteSyncConfig,
  IUniRouteServiceConfig,
} from '../../../lib/config';
import {GasDetails} from '../../../models/gas/GasDetails';
import {UniProtocol} from '../../../models/pool/UniProtocol';
import {QuoteBasic} from '../../../models/quote/QuoteBasic';
import {BaseProvider, JsonRpcProvider} from '@ethersproject/providers';
import {Context} from '@uniswap/lib-uni/context';
import {Erc20Token} from 'src/models/token/Erc20Token';
import {ArbitrumGasData} from '../gas-data-provider';
import {CurrencyInfo} from '../../../models/currency/CurrencyInfo';
import {Address} from '../../../models/address/Address';
import {TradeType} from '../../../models/quote/TradeType';
import {buildTestContext} from '@uniswap/lib-testhelpers';
import {BaseGasEstimator} from './BaseGasEstimator';
import {FreshPoolDetailsWrapper} from '../../../stores/pool/FreshPoolDetailsWrapper';

class OnDemandGasEstimator extends BaseGasEstimator {
  constructor(private readonly returnValue: bigint) {
    super(new Map<ChainId, JsonRpcProvider>(), {} as FreshPoolDetailsWrapper);
  }
  async estimateRouteGas(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    quote: QuoteBasic,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    chainId: ChainId,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    gasPriceWei: number
  ): Promise<GasDetails> {
    return new GasDetails(
      this.returnValue,
      this.returnValue,
      Number(this.returnValue),
      this.returnValue
    );
  }
  async estimateL1L2Gas(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    serviceConfig: IUniRouteServiceConfig,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    tokenInCurrencyInfo: CurrencyInfo,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    tokenOutCurrencyInfo: CurrencyInfo,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    amountIn: bigint,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    chainId: ChainId,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    tokensInfo: Map<string, Erc20Token | null>,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    tradeType: TradeType,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    quote: QuoteBasic,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    provider: BaseProvider,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    gasPriceWei: number,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ctx: Context,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    l2GasData?: ArbitrumGasData
  ): Promise<GasDetails> {
    return new GasDetails(
      this.returnValue,
      this.returnValue,
      Number(this.returnValue),
      this.returnValue
    );
  }
}

class OnDemandGasEstimateProvider extends GasEstimateProvider {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async getCurrentGasPrice(chainId: ChainId): Promise<number> {
    return 0;
  }
}

describe('GasEstimateProvider', () => {
  const createTestData = () => {
    const tokenInAddress = new Address(
      '0x1111111111111111111111111111111111111111'
    );
    const tokenOutAddress = new Address(
      '0x2222222222222222222222222222222222222222'
    );
    const tokenInCurrencyInfo = new CurrencyInfo(false, tokenInAddress);
    const tokenOutCurrencyInfo = new CurrencyInfo(false, tokenOutAddress);
    const amountIn = BigInt(1000000);
    const tokensInfo = new Map<string, Erc20Token | null>();
    tokensInfo.set(
      tokenInAddress.address,
      new Erc20Token(tokenInAddress, 18, 'TOKEN_IN', 'Token In')
    );
    tokensInfo.set(
      tokenOutAddress.address,
      new Erc20Token(tokenOutAddress, 18, 'TOKEN_OUT', 'Token Out')
    );
    const tradeType = TradeType.ExactIn;
    const ctx = buildTestContext();

    return {
      tokenInCurrencyInfo,
      tokenOutCurrencyInfo,
      amountIn,
      tokensInfo,
      tradeType,
      ctx,
    };
  };

  it('should estimate gas correctly for non-Arbitrum/non-OP Stack chains (L1L2 gas should be zero)', async () => {
    const rpcProviderMap = new Map<ChainId, JsonRpcProvider>();
    const mockProvider = new JsonRpcProvider();
    rpcProviderMap.set(ChainId.MAINNET, mockProvider);

    const gasEstimateProvider = new OnDemandGasEstimateProvider(
      rpcProviderMap,
      new OnDemandGasEstimator(BigInt(2)),
      new OnDemandGasEstimator(BigInt(3)),
      new OnDemandGasEstimator(BigInt(4)),
      new OnDemandGasEstimator(BigInt(5))
    );

    const dummyRouteV2 = new RouteBasic(UniProtocol.V2, []);
    const dummyRouteV3 = new RouteBasic(UniProtocol.V3, []);
    const dummyRouteV4 = new RouteBasic(UniProtocol.V4, []);
    const dummyRouteMixed = new RouteBasic(UniProtocol.MIXED, []);

    const dummyQuoteV2 = new QuoteBasic(
      dummyRouteV2,
      BigInt(0),
      undefined,
      undefined
    );
    const dummyQuoteV3 = new QuoteBasic(
      dummyRouteV3,
      BigInt(0),
      undefined,
      undefined
    );
    const dummyQuoteV4 = new QuoteBasic(
      dummyRouteV4,
      BigInt(0),
      undefined,
      undefined
    );
    const dummyQuoteMixed = new QuoteBasic(
      dummyRouteMixed,
      BigInt(0),
      undefined,
      undefined
    );

    const testData = createTestData();
    const chainId = ChainId.MAINNET; // Not Arbitrum or OP Stack
    const serviceConfig = getUniRouteSyncConfig();
    // estimateGas = routeGas + l1l2Gas
    // For MAINNET (non-Arbitrum/non-OP Stack): l1l2Gas should be 0
    // For returnValue = 2: routeGas returns 2, l1l2Gas returns 0, total = 2
    expect(
      await gasEstimateProvider.estimateGas(
        serviceConfig,
        testData.tokenInCurrencyInfo,
        testData.tokenOutCurrencyInfo,
        testData.amountIn,
        chainId,
        testData.tokensInfo,
        testData.tradeType,
        dummyQuoteV2,
        testData.ctx
      )
    ).toEqual(new GasDetails(BigInt(0), BigInt(2), 2, BigInt(2)));

    // For returnValue = 3: routeGas returns 3, l1l2Gas returns 0, total = 3
    expect(
      await gasEstimateProvider.estimateGas(
        serviceConfig,
        testData.tokenInCurrencyInfo,
        testData.tokenOutCurrencyInfo,
        testData.amountIn,
        chainId,
        testData.tokensInfo,
        testData.tradeType,
        dummyQuoteV3,
        testData.ctx
      )
    ).toEqual(new GasDetails(BigInt(0), BigInt(3), 3, BigInt(3)));

    // For returnValue = 4: routeGas returns 4, l1l2Gas returns 0, total = 4
    expect(
      await gasEstimateProvider.estimateGas(
        serviceConfig,
        testData.tokenInCurrencyInfo,
        testData.tokenOutCurrencyInfo,
        testData.amountIn,
        chainId,
        testData.tokensInfo,
        testData.tradeType,
        dummyQuoteV4,
        testData.ctx
      )
    ).toEqual(new GasDetails(BigInt(0), BigInt(4), 4, BigInt(4)));

    // For returnValue = 5: routeGas returns 5, l1l2Gas returns 0, total = 5
    expect(
      await gasEstimateProvider.estimateGas(
        serviceConfig,
        testData.tokenInCurrencyInfo,
        testData.tokenOutCurrencyInfo,
        testData.amountIn,
        chainId,
        testData.tokensInfo,
        testData.tradeType,
        dummyQuoteMixed,
        testData.ctx
      )
    ).toEqual(new GasDetails(BigInt(0), BigInt(5), 5, BigInt(5)));
  });

  it('should estimate gas correctly for Arbitrum (L1L2 gas should be calculated)', async () => {
    const rpcProviderMap = new Map<ChainId, JsonRpcProvider>();
    const mockProvider = new JsonRpcProvider();
    rpcProviderMap.set(ChainId.ARBITRUM, mockProvider);

    const gasEstimateProvider = new OnDemandGasEstimateProvider(
      rpcProviderMap,
      new OnDemandGasEstimator(BigInt(2)),
      new OnDemandGasEstimator(BigInt(3)),
      new OnDemandGasEstimator(BigInt(4)),
      new OnDemandGasEstimator(BigInt(5))
    );

    const dummyRouteV2 = new RouteBasic(UniProtocol.V2, []);
    const dummyQuoteV2 = new QuoteBasic(
      dummyRouteV2,
      BigInt(0),
      undefined,
      undefined
    );

    const testData = createTestData();
    const chainId = ChainId.ARBITRUM;
    const serviceConfig = getUniRouteSyncConfig();
    // estimateGas = routeGas + l1l2Gas
    // For Arbitrum: l1l2Gas should be calculated
    // For returnValue = 2: routeGas returns 2, l1l2Gas returns 2, total = 4
    expect(
      await gasEstimateProvider.estimateGas(
        serviceConfig,
        testData.tokenInCurrencyInfo,
        testData.tokenOutCurrencyInfo,
        testData.amountIn,
        chainId,
        testData.tokensInfo,
        testData.tradeType,
        dummyQuoteV2,
        testData.ctx
      )
    ).toEqual(new GasDetails(BigInt(0), BigInt(4), 4, BigInt(4)));
  });

  it('should estimate gas correctly for OP Stack chains (L1L2 gas should be calculated) when OpStackEnabled is true', async () => {
    const rpcProviderMap = new Map<ChainId, JsonRpcProvider>();
    const mockProvider = new JsonRpcProvider();
    rpcProviderMap.set(ChainId.BASE, mockProvider);

    const gasEstimateProvider = new OnDemandGasEstimateProvider(
      rpcProviderMap,
      new OnDemandGasEstimator(BigInt(2)),
      new OnDemandGasEstimator(BigInt(3)),
      new OnDemandGasEstimator(BigInt(4)),
      new OnDemandGasEstimator(BigInt(5))
    );

    const dummyRouteV3 = new RouteBasic(UniProtocol.V3, []);
    const dummyQuoteV3 = new QuoteBasic(
      dummyRouteV3,
      BigInt(0),
      undefined,
      undefined
    );

    const testData = createTestData();
    const chainId = ChainId.BASE; // OP Stack chain
    const serviceConfig = getUniRouteSyncConfig();
    serviceConfig.L1L2GasCostFetcher.OpStackEnabled = true;

    // estimateGas = routeGas + l1l2Gas
    // For OP Stack chains: l1l2Gas should be calculated
    // For returnValue = 3: routeGas returns 3, l1l2Gas returns 3, total = 6
    expect(
      await gasEstimateProvider.estimateGas(
        serviceConfig,
        testData.tokenInCurrencyInfo,
        testData.tokenOutCurrencyInfo,
        testData.amountIn,
        chainId,
        testData.tokensInfo,
        testData.tradeType,
        dummyQuoteV3,
        testData.ctx
      )
    ).toEqual(new GasDetails(BigInt(0), BigInt(6), 6, BigInt(6)));
  });

  it('should return zero GasDetails when GasEstimation is disabled', async () => {
    const rpcProviderMap = new Map<ChainId, JsonRpcProvider>();
    const mockProvider = new JsonRpcProvider();
    rpcProviderMap.set(ChainId.MAINNET, mockProvider);

    const gasEstimateProvider = new OnDemandGasEstimateProvider(
      rpcProviderMap,
      new OnDemandGasEstimator(BigInt(100)),
      new OnDemandGasEstimator(BigInt(100)),
      new OnDemandGasEstimator(BigInt(100)),
      new OnDemandGasEstimator(BigInt(100))
    );

    const dummyRouteV3 = new RouteBasic(UniProtocol.V3, []);
    const dummyQuoteV3 = new QuoteBasic(
      dummyRouteV3,
      BigInt(0),
      undefined,
      undefined
    );

    const testData = createTestData();
    const chainId = ChainId.MAINNET;
    const serviceConfig = getUniRouteSyncConfig();
    serviceConfig.GasEstimation.Enabled = false;

    // When GasEstimation is disabled, should return zero GasDetails
    expect(
      await gasEstimateProvider.estimateGas(
        serviceConfig,
        testData.tokenInCurrencyInfo,
        testData.tokenOutCurrencyInfo,
        testData.amountIn,
        chainId,
        testData.tokensInfo,
        testData.tradeType,
        dummyQuoteV3,
        testData.ctx
      )
    ).toEqual(new GasDetails(BigInt(0), BigInt(0), 0, BigInt(0)));
  });
});
