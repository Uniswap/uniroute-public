import {describe, beforeEach, afterEach, it, expect, vi} from 'vitest';
import {JsonRpcProvider} from '@ethersproject/providers';
import {BigNumber} from '@ethersproject/bignumber';
import {
  EthEstimateGasSimulator,
  extractRevertData,
} from './eth-estimate-gas-provider';
import {SwapOptionsUniversalRouter, SwapType} from './simulation-provider';
import {ChainId} from '../../../lib/config';
import {Context} from '@uniswap/lib-uni/context';
import {QuoteSplit} from '../../../models/quote/QuoteSplit';
import {TradeType} from '../../../models/quote/TradeType';
import {GasConverter} from '../../gas/converter/GasConverter';
import {
  TokenTransferMode,
  UniversalRouterVersion,
} from '@uniswap/universal-router-sdk';
import {Percent} from '@uniswap/sdk-core';
import {SimulationStatus} from '../ISimulator';
import {Erc20Token} from '../../../models/token/Erc20Token';
import {RouteBasic} from 'src/models/route/RouteBasic';
import {GasDetails} from 'src/models/gas/GasDetails';
import {Address} from 'src/models/address/Address';
import {Protocol} from '../../../models/pool/Protocol';

const USDC_ADDRESS = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const WETH_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const USER_ADDRESS = '0x1234567890123456789012345678901234567890';

// V4TooLittleReceived(uint256,uint256) with encoded args
const V4_TOO_LITTLE_RECEIVED_WITH_ARGS =
  '0x8b063d73' +
  '00000000000000000000000000000000000000000000000000000000000f4240' +
  '00000000000000000000000000000000000000000000000000000000000f423f';

/**
 * Shape thrown by ethers v5 estimateGas on a revert: the
 * UNPREDICTABLE_GAS_LIMIT wrapper carries the original JSON-RPC error
 * (with `data`) on its `error` property.
 */
const makeEthersEstimateGasError = (data?: string): Error => {
  const rpcError = Object.assign(new Error('execution reverted'), {
    code: -32000,
    ...(data !== undefined ? {data} : {}),
  });
  return Object.assign(
    new Error(
      'cannot estimate gas; transaction may fail or may require manual gas limit'
    ),
    {
      code: 'UNPREDICTABLE_GAS_LIMIT',
      reason: 'execution reverted',
      method: 'estimateGas',
      error: rpcError,
    }
  );
};

describe('extractRevertData', () => {
  it('finds data directly on the error', () => {
    expect(extractRevertData({data: '0x8b063d73'})).toBe('0x8b063d73');
  });

  it('finds data nested under error (ethers UNPREDICTABLE_GAS_LIMIT shape)', () => {
    expect(
      extractRevertData(
        makeEthersEstimateGasError(V4_TOO_LITTLE_RECEIVED_WITH_ARGS)
      )
    ).toBe(V4_TOO_LITTLE_RECEIVED_WITH_ARGS);
  });

  it('finds data nested two levels deep (fetchJson SERVER_ERROR shape)', () => {
    const serverError = {
      code: 'SERVER_ERROR',
      error: {code: -32000, data: '0x739dbe52', message: 'reverted'},
      body: '{"jsonrpc":"2.0","error":{"code":-32000,"data":"0x739dbe52"}}',
    };
    expect(extractRevertData({error: serverError})).toBe('0x739dbe52');
  });

  it('finds data inside a raw JSON body string', () => {
    expect(
      extractRevertData({
        body: '{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"execution reverted","data":"0x849eaf98"}}',
      })
    ).toBe('0x849eaf98');
  });

  it('returns undefined when no revert data is present', () => {
    expect(extractRevertData(new Error('timeout'))).toBeUndefined();
    expect(extractRevertData(makeEthersEstimateGasError())).toBeUndefined();
    expect(extractRevertData(undefined)).toBeUndefined();
    expect(extractRevertData('not json')).toBeUndefined();
  });

  it('ignores empty or non-hex data fields', () => {
    expect(extractRevertData({data: '0x'})).toBeUndefined();
    expect(extractRevertData({data: 'execution reverted'})).toBeUndefined();
  });

  it('stops on cyclic errors instead of recursing forever', () => {
    const cyclic: {error?: unknown} = {};
    cyclic.error = cyclic;
    expect(extractRevertData(cyclic)).toBeUndefined();
  });
});

describe('EthEstimateGasSimulator', () => {
  let provider: JsonRpcProvider;
  let gasConverter: GasConverter;
  let simulator: EthEstimateGasSimulator;
  let ctx: Context;

  const createQuoteSplit = (): QuoteSplit => ({
    quotes: [
      {
        route: new RouteBasic(Protocol.V3, [], 100),
        amount: 1000000n,
        gasDetails: new GasDetails(50000000000n, 150000n, 0.001, 150000n),
      },
    ],
    swapInfo: {
      tradeType: TradeType.ExactIn,
      tokenInWrappedAddress: USDC_ADDRESS,
      tokenOutWrappedAddress: WETH_ADDRESS,
      tokenInIsNative: false,
      tokenOutIsNative: false,
      inputAmount: 1000000n,
      priceImpact: 0.01,
      methodParameters: {
        calldata: '0xswapCalldata',
        value: '0x0',
        to: '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD',
      },
    },
    tokensInfo: new Map<string, Erc20Token>([
      [
        USDC_ADDRESS.toLowerCase(),
        {
          address: new Address(USDC_ADDRESS),
          decimals: 6,
          symbol: 'USDC',
          name: 'USD Coin',
        } as unknown as Erc20Token,
      ],
      [
        WETH_ADDRESS.toLowerCase(),
        {
          address: new Address(WETH_ADDRESS),
          decimals: 18,
          symbol: 'WETH',
          name: 'Wrapped Ether',
        } as Erc20Token,
      ],
    ]),
  });

  const swapOptions: SwapOptionsUniversalRouter = {
    type: SwapType.UNIVERSAL_ROUTER,
    urVersion: UniversalRouterVersion.V1_2,
    simulate: {fromAddress: USER_ADDRESS},
    slippageTolerance: new Percent(5, 100),
    tokenTransferMode: TokenTransferMode.Permit2,
  };

  beforeEach(() => {
    provider = new JsonRpcProvider();
    provider.estimateGas = vi.fn();

    gasConverter = {
      getGasCostInQuoteTokenBasedOnGasCostInWei: vi
        .fn()
        .mockResolvedValue(2000n),
      getGasCostInUSDBasedOnGasCostInWei: vi.fn().mockReturnValue(3.88),
    } as unknown as GasConverter;

    simulator = new EthEstimateGasSimulator(
      ChainId.MAINNET,
      provider,
      gasConverter
    );

    ctx = {
      logger: {
        info: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      metrics: {
        dist: vi.fn(),
        count: vi.fn(),
      },
    } as unknown as Context;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('ethEstimateGas', () => {
    it('returns SUCCESS with adjusted gas estimate on success', async () => {
      vi.mocked(provider.estimateGas).mockResolvedValue(BigNumber.from(150000));

      const result = await simulator.ethEstimateGas(
        USER_ADDRESS,
        swapOptions,
        createQuoteSplit(),
        ctx
      );

      expect(result.simulationResult?.status).toBe(SimulationStatus.SUCCESS);
      // 150000 * 1.2 default multiplier
      expect(result.simulationResult?.estimatedGasUsed).toBe(180000n);
    });

    it('returns SLIPPAGE_TOO_LOW when the revert carries a V4TooLittleReceived error', async () => {
      vi.mocked(provider.estimateGas).mockRejectedValue(
        makeEthersEstimateGasError(V4_TOO_LITTLE_RECEIVED_WITH_ARGS)
      );

      const result = await simulator.ethEstimateGas(
        USER_ADDRESS,
        swapOptions,
        createQuoteSplit(),
        ctx
      );

      expect(result.simulationResult?.status).toBe(
        SimulationStatus.SLIPPAGE_TOO_LOW
      );
      expect(result.simulationResult?.description).toBe(
        'Transaction reverted during eth_estimateGas'
      );
      expect(result.simulationResult?.estimatedGasUsed).toBe(0n);
      expect(ctx.logger.error).toHaveBeenCalledWith(
        'Error estimating gas',
        expect.objectContaining({revertData: V4_TOO_LITTLE_RECEIVED_WITH_ARGS})
      );
    });

    it('returns SLIPPAGE_TOO_LOW when the revert carries a V3TooLittleReceived error', async () => {
      vi.mocked(provider.estimateGas).mockRejectedValue(
        makeEthersEstimateGasError('0x39d35496')
      );

      const result = await simulator.ethEstimateGas(
        USER_ADDRESS,
        swapOptions,
        createQuoteSplit(),
        ctx
      );

      expect(result.simulationResult?.status).toBe(
        SimulationStatus.SLIPPAGE_TOO_LOW
      );
    });

    it('returns FAILED when the revert data is unrecognized', async () => {
      vi.mocked(provider.estimateGas).mockRejectedValue(
        makeEthersEstimateGasError('0xdeadbeef')
      );

      const result = await simulator.ethEstimateGas(
        USER_ADDRESS,
        swapOptions,
        createQuoteSplit(),
        ctx
      );

      expect(result.simulationResult?.status).toBe(SimulationStatus.FAILED);
      expect(result.simulationResult?.description).toBe(
        'Transaction reverted during eth_estimateGas'
      );
    });

    it('returns generic FAILED when the error carries no revert data', async () => {
      vi.mocked(provider.estimateGas).mockRejectedValue(new Error('timeout'));

      const result = await simulator.ethEstimateGas(
        USER_ADDRESS,
        swapOptions,
        createQuoteSplit(),
        ctx
      );

      expect(result.simulationResult?.status).toBe(SimulationStatus.FAILED);
      expect(result.simulationResult?.description).toBe('Error estimating gas');
    });
  });
});
