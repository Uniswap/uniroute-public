import {describe, it, expect, vi} from 'vitest';
import {GasEstimateProvider} from './GasEstimateProvider';
import {RouteBasic} from '../../../models/route/RouteBasic';
import {
  ChainId,
  getUniRouteSyncConfig,
  IUniRouteServiceConfig,
} from '../../../lib/config';
import {GasDetails} from '../../../models/gas/GasDetails';
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
import {Protocol} from '../../../models/pool/Protocol';

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
  async getCurrentGasPrice(_ctx: Context, _chainId: ChainId): Promise<number> {
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

    const dummyRouteV2 = new RouteBasic(Protocol.V2, []);
    const dummyRouteV3 = new RouteBasic(Protocol.V3, []);
    const dummyRouteV4 = new RouteBasic(Protocol.V4, []);
    const dummyRouteMixed = new RouteBasic(Protocol.MIXED, []);

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

    const dummyRouteV2 = new RouteBasic(Protocol.V2, []);
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

    const dummyRouteV3 = new RouteBasic(Protocol.V3, []);
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

    const dummyRouteV3 = new RouteBasic(Protocol.V3, []);
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

const buildProvider = (
  send: (method: string, params: unknown[]) => Promise<unknown>
) => {
  const rpcProviderMap = new Map<ChainId, JsonRpcProvider>();
  rpcProviderMap.set(ChainId.MAINNET, {
    send,
  } as unknown as JsonRpcProvider);
  return new GasEstimateProvider(
    rpcProviderMap,
    new OnDemandGasEstimator(BigInt(2)),
    new OnDemandGasEstimator(BigInt(3)),
    new OnDemandGasEstimator(BigInt(4)),
    new OnDemandGasEstimator(BigInt(5))
  );
};

describe('GasEstimateProvider.getCurrentGasPrice gas oracle metrics', () => {
  it('emits success metrics for eth_gasPrice', async () => {
    const provider = buildProvider(async () => '0x3b9aca00');
    const ctx = buildTestContext();

    const gasPrice = await provider.getCurrentGasPrice(ctx, ChainId.MAINNET);

    expect(gasPrice).toBe(1000000000);
    expect(
      ctx.metrics.countStore['UniRouteService.Metric.GasOracle.RpcCall']
    ).toBe(1);
    expect(ctx.metrics.distStore).toContainEqual(
      expect.objectContaining({
        metric_name: 'UniRouteService.Metric.GasOracle.RpcCall.Latency.dist',
        opts: expect.objectContaining({
          tags: ['chain:MAINNET', 'rpc:eth_gasPrice', 'status:success'],
        }),
      })
    );
  });

  it('emits success metrics for eth_feeHistory when a block number is given', async () => {
    const provider = buildProvider(async (method: string) =>
      method === 'eth_feeHistory' ? {baseFeePerGas: ['0x77359400']} : '0x0'
    );
    const ctx = buildTestContext();

    const gasPrice = await provider.getCurrentGasPrice(
      ctx,
      ChainId.MAINNET,
      12345
    );

    expect(gasPrice).toBe(2000000000);
    expect(ctx.metrics.distStore).toContainEqual(
      expect.objectContaining({
        metric_name: 'UniRouteService.Metric.GasOracle.RpcCall.Latency.dist',
        opts: expect.objectContaining({
          tags: ['chain:MAINNET', 'rpc:eth_feeHistory', 'status:success'],
        }),
      })
    );
  });

  it('emits failure metrics and rethrows when the RPC send rejects', async () => {
    const provider = buildProvider(async () => {
      throw new Error('rpc down');
    });
    const ctx = buildTestContext();

    await expect(
      provider.getCurrentGasPrice(ctx, ChainId.MAINNET)
    ).rejects.toThrow('rpc down');

    expect(
      ctx.metrics.countStore['UniRouteService.Metric.GasOracle.RpcCall']
    ).toBe(1);
    expect(ctx.metrics.distStore).toContainEqual(
      expect.objectContaining({
        metric_name: 'UniRouteService.Metric.GasOracle.RpcCall.Latency.dist',
        opts: expect.objectContaining({
          tags: [
            'chain:MAINNET',
            'rpc:eth_gasPrice',
            'status:failure',
            'reason:rpc_error',
          ],
        }),
      })
    );
  });
});

describe('GasEstimateProvider.getCurrentGasPrice with a priority fee', () => {
  const METAMASK_TIP_WEI = 2_050_000_000n;
  // Mainnet responses to eth_feeHistory ["0x1", "latest", []] and
  // eth_gasPrice, captured from a public RPC at block 0x191dea2.
  const MAINNET_FEE_HISTORY = {
    baseFeePerGas: ['0x313534c', '0x2f78333'],
    gasUsedRatio: [0.35869681666666664],
    baseFeePerBlobGas: ['0x3238c0', '0x2b6830'],
    blobGasUsedRatio: [0.047619047619047616],
    oldestBlock: '0x191dea2',
    reward: [[]],
  };
  const MAINNET_GAS_PRICE = '0x31355d9';
  // BNB Chain's response to the same eth_feeHistory call: zero base fee.
  const BNB_FEE_HISTORY = {
    baseFeePerGas: ['0x0', '0x0'],
    gasUsedRatio: [0.16010154285714287],
    baseFeePerBlobGas: ['0x1', '0x1'],
    blobGasUsedRatio: [0.16666666666666666],
    oldestBlock: '0x7d6973f',
    reward: [[]],
  };

  const recordingProvider = (feeHistory: () => Promise<unknown>) => {
    const calls: {method: string; params: unknown[]}[] = [];
    const provider = buildProvider(async (method, params) => {
      calls.push({method, params});
      return method === 'eth_feeHistory' ? feeHistory() : MAINNET_GAS_PRICE;
    });
    return {provider, calls};
  };

  const priorityFeeCountTags = (countSpy: {
    mock: {calls: unknown[][]};
  }): unknown[] =>
    countSpy.mock.calls
      .filter(
        ([metricName]) =>
          metricName === 'UniRouteService.Metric.GasOracle.PriorityFee'
      )
      .map(([, , opts]) => opts);

  it('prices gas at the next block base fee plus the tip', async () => {
    const {provider, calls} = recordingProvider(
      async () => MAINNET_FEE_HISTORY
    );
    const ctx = buildTestContext();
    const countSpy = vi.spyOn(ctx.metrics, 'count');

    const gasPrice = await provider.getCurrentGasPrice(
      ctx,
      ChainId.MAINNET,
      undefined,
      METAMASK_TIP_WEI
    );

    expect(gasPrice).toBe(Number(0x2f78333n + METAMASK_TIP_WEI));
    expect(calls).toEqual([
      {method: 'eth_feeHistory', params: ['0x1', 'latest', []]},
    ]);
    expect(priorityFeeCountTags(countSpy)).toEqual([
      {tags: ['chain:MAINNET', 'status:success']},
    ]);
  });

  it('adds the tip to the pinned block base fee', async () => {
    const {provider, calls} = recordingProvider(
      async () => MAINNET_FEE_HISTORY
    );

    const gasPrice = await provider.getCurrentGasPrice(
      buildTestContext(),
      ChainId.MAINNET,
      12345,
      METAMASK_TIP_WEI
    );

    expect(gasPrice).toBe(Number(0x313534cn + METAMASK_TIP_WEI));
    expect(calls).toEqual([
      {method: 'eth_feeHistory', params: ['0x1', '0x3039', []]},
    ]);
  });

  it('returns the tip alone on a chain whose base fee is zero', async () => {
    const {provider} = recordingProvider(async () => BNB_FEE_HISTORY);

    const gasPrice = await provider.getCurrentGasPrice(
      buildTestContext(),
      ChainId.MAINNET,
      undefined,
      50_000_000n
    );

    expect(gasPrice).toBe(50_000_000);
  });

  it('prices a zero tip at the base fee, below eth_gasPrice', async () => {
    const {provider} = recordingProvider(async () => MAINNET_FEE_HISTORY);

    const gasPrice = await provider.getCurrentGasPrice(
      buildTestContext(),
      ChainId.MAINNET,
      undefined,
      0n
    );

    expect(gasPrice).toBe(Number(0x2f78333n));
    expect(gasPrice).toBeLessThan(Number(MAINNET_GAS_PRICE));
  });

  it.each([
    [
      'eth_feeHistory rejects',
      async () => {
        throw new Error('method not supported');
      },
    ],
    ['the response has no baseFeePerGas', async () => ({oldestBlock: '0x1'})],
    [
      'the response has no next-block base fee',
      async () => ({baseFeePerGas: ['0x313534c']}),
    ],
    [
      'the base fee is not a hex quantity',
      async () => ({baseFeePerGas: ['0x313534c', 51598156]}),
    ],
  ])(
    'drops the tip and uses eth_gasPrice when %s',
    async (_name, feeHistory) => {
      const {provider, calls} = recordingProvider(feeHistory);
      const ctx = buildTestContext();
      const countSpy = vi.spyOn(ctx.metrics, 'count');

      const gasPrice = await provider.getCurrentGasPrice(
        ctx,
        ChainId.MAINNET,
        undefined,
        METAMASK_TIP_WEI
      );

      expect(gasPrice).toBe(Number(MAINNET_GAS_PRICE));
      expect(calls.map(call => call.method)).toEqual([
        'eth_feeHistory',
        'eth_gasPrice',
      ]);
      expect(priorityFeeCountTags(countSpy)).toEqual([
        {
          tags: [
            'chain:MAINNET',
            'status:failure',
            'reason:base_fee_unavailable',
          ],
        },
      ]);
    }
  );

  it('reads the pinned block base fee through the same shape check without a tip', async () => {
    const {provider, calls} = recordingProvider(
      async () => MAINNET_FEE_HISTORY
    );

    const gasPrice = await provider.getCurrentGasPrice(
      buildTestContext(),
      ChainId.MAINNET,
      12345
    );

    expect(gasPrice).toBe(Number(0x313534cn));
    expect(calls).toEqual([
      {method: 'eth_feeHistory', params: ['0x1', '0x3039', []]},
    ]);
  });

  it('uses eth_gasPrice at a pinned block without a tip when the base fee is not a hex quantity', async () => {
    const {provider, calls} = recordingProvider(async () => ({
      baseFeePerGas: [51598156, 49775411],
    }));

    const gasPrice = await provider.getCurrentGasPrice(
      buildTestContext(),
      ChainId.MAINNET,
      12345
    );

    expect(gasPrice).toBe(Number(MAINNET_GAS_PRICE));
    expect(calls.map(call => call.method)).toEqual([
      'eth_feeHistory',
      'eth_gasPrice',
    ]);
  });

  it('still fails a pinned-block quote without a tip when eth_feeHistory rejects', async () => {
    const {provider} = recordingProvider(async () => {
      throw new Error('method not supported');
    });

    await expect(
      provider.getCurrentGasPrice(buildTestContext(), ChainId.MAINNET, 12345)
    ).rejects.toThrow('method not supported');
  });

  it('keeps eth_gasPrice and emits no priority-fee metric without a tip', async () => {
    const {provider, calls} = recordingProvider(
      async () => MAINNET_FEE_HISTORY
    );
    const ctx = buildTestContext();
    const countSpy = vi.spyOn(ctx.metrics, 'count');

    const gasPrice = await provider.getCurrentGasPrice(ctx, ChainId.MAINNET);

    expect(gasPrice).toBe(Number(MAINNET_GAS_PRICE));
    expect(calls.map(call => call.method)).toEqual(['eth_gasPrice']);
    expect(priorityFeeCountTags(countSpy)).toEqual([]);
  });
});
