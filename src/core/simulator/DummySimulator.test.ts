import {describe, it, expect, vi, beforeEach} from 'vitest';
import {DummySimulator} from './DummySimulator';
import {SimulationStatus} from './ISimulator';
import {QuoteSplit} from '../../models/quote/QuoteSplit';
import {QuoteBasic} from '../../models/quote/QuoteBasic';
import {RouteBasic} from '../../models/route/RouteBasic';
import {GasDetails} from '../../models/gas/GasDetails';
import {UniProtocol} from '../../models/pool/UniProtocol';
import {ChainId} from '../../lib/config';
import {SwapOptionsUniversalRouter} from './sor-port/simulation-provider';
import {CurrencyInfo} from '../../models/currency/CurrencyInfo';
import {Context} from '@uniswap/lib-uni/context';

// Helper to create a mock route
function createMockRoute(): RouteBasic {
  return new RouteBasic(UniProtocol.V3, [], 100);
}

// Helper to create gas details
function createGasDetails(
  gasCostInQuoteToken: bigint,
  gasUse: bigint
): GasDetails {
  return new GasDetails(
    1000000000n, // gasPriceInWei (1 gwei)
    gasUse * 1000000000n, // gasCostInWei
    0.001, // gasCostInEth
    gasUse,
    gasCostInQuoteToken,
    10 // gasCostInUSD
  );
}

// Helper to create a quote
function createQuote(gasCostInQuoteToken: bigint, gasUse: bigint): QuoteBasic {
  return new QuoteBasic(
    createMockRoute(),
    1000000000000000000n, // 1 token amount
    undefined,
    createGasDetails(gasCostInQuoteToken, gasUse)
  );
}

// Helper to create mock context
function createMockContext(): Context {
  return {
    logger: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
    metrics: {
      count: vi.fn(),
    },
  } as unknown as Context;
}

describe('DummySimulator', () => {
  let simulator: DummySimulator;
  let mockSwapOptions: SwapOptionsUniversalRouter;
  let mockTokenInCurrencyInfo: CurrencyInfo;
  let mockTokenOutCurrencyInfo: CurrencyInfo;
  let mockContext: Context;

  beforeEach(() => {
    simulator = new DummySimulator();
    mockSwapOptions = {} as SwapOptionsUniversalRouter;
    mockTokenInCurrencyInfo = {} as CurrencyInfo;
    mockTokenOutCurrencyInfo = {} as CurrencyInfo;
    mockContext = createMockContext();
  });

  it('should return a QuoteSplit with SUCCESS status', async () => {
    const quote = new QuoteSplit([createQuote(100n, 50000n)]);

    const result = await simulator.simulate(
      ChainId.MAINNET,
      mockSwapOptions,
      quote,
      mockTokenInCurrencyInfo,
      mockTokenOutCurrencyInfo,
      1000000000000000000n,
      1000000000000000000n,
      mockContext
    );

    expect(result).toBeInstanceOf(QuoteSplit);
    expect(result.simulationResult).toBeDefined();
    expect(result.simulationResult!.status).toBe(SimulationStatus.SUCCESS);
    expect(result.simulationResult!.description).toBe(
      'Simulation completed successfully'
    );
  });

  it('should aggregate gasCostInQuoteToken from all quotes', async () => {
    const quotes = [
      createQuote(100n, 50000n),
      createQuote(200n, 60000n),
      createQuote(300n, 70000n),
    ];
    const quoteSplit = new QuoteSplit(quotes);

    const result = await simulator.simulate(
      ChainId.MAINNET,
      mockSwapOptions,
      quoteSplit,
      mockTokenInCurrencyInfo,
      mockTokenOutCurrencyInfo,
      1000000000000000000n,
      1000000000000000000n,
      mockContext
    );

    // 100 + 200 + 300 = 600
    expect(result.simulationResult!.estimatedGasUsedInQuoteToken).toBe(600n);
  });

  it('should aggregate gasUse from all quotes', async () => {
    const quotes = [
      createQuote(100n, 50000n),
      createQuote(200n, 60000n),
      createQuote(300n, 70000n),
    ];
    const quoteSplit = new QuoteSplit(quotes);

    const result = await simulator.simulate(
      ChainId.MAINNET,
      mockSwapOptions,
      quoteSplit,
      mockTokenInCurrencyInfo,
      mockTokenOutCurrencyInfo,
      1000000000000000000n,
      1000000000000000000n,
      mockContext
    );

    // 50000 + 60000 + 70000 = 180000
    expect(result.simulationResult!.estimatedGasUsed).toBe(180000n);
  });

  it('should handle quotes without gasDetails', async () => {
    const quoteWithoutGas = new QuoteBasic(
      createMockRoute(),
      1000000000000000000n,
      undefined,
      undefined // no gas details
    );
    const quoteSplit = new QuoteSplit([quoteWithoutGas]);

    const result = await simulator.simulate(
      ChainId.MAINNET,
      mockSwapOptions,
      quoteSplit,
      mockTokenInCurrencyInfo,
      mockTokenOutCurrencyInfo,
      1000000000000000000n,
      1000000000000000000n,
      mockContext
    );

    expect(result.simulationResult!.estimatedGasUsed).toBe(0n);
    expect(result.simulationResult!.estimatedGasUsedInQuoteToken).toBe(0n);
    expect(result.simulationResult!.status).toBe(SimulationStatus.SUCCESS);
  });

  it('should handle empty quotes array', async () => {
    const quoteSplit = new QuoteSplit([]);

    const result = await simulator.simulate(
      ChainId.MAINNET,
      mockSwapOptions,
      quoteSplit,
      mockTokenInCurrencyInfo,
      mockTokenOutCurrencyInfo,
      1000000000000000000n,
      1000000000000000000n,
      mockContext
    );

    expect(result.simulationResult!.estimatedGasUsed).toBe(0n);
    expect(result.simulationResult!.estimatedGasUsedInQuoteToken).toBe(0n);
    expect(result.simulationResult!.status).toBe(SimulationStatus.SUCCESS);
  });

  it('should handle mixed quotes with and without gasDetails', async () => {
    const quoteWithGas = createQuote(500n, 100000n);
    const quoteWithoutGas = new QuoteBasic(
      createMockRoute(),
      1000000000000000000n,
      undefined,
      undefined
    );
    const quoteSplit = new QuoteSplit([quoteWithGas, quoteWithoutGas]);

    const result = await simulator.simulate(
      ChainId.MAINNET,
      mockSwapOptions,
      quoteSplit,
      mockTokenInCurrencyInfo,
      mockTokenOutCurrencyInfo,
      1000000000000000000n,
      1000000000000000000n,
      mockContext
    );

    expect(result.simulationResult!.estimatedGasUsed).toBe(100000n);
    expect(result.simulationResult!.estimatedGasUsedInQuoteToken).toBe(500n);
  });

  it('should preserve the original quotes in the result', async () => {
    const originalQuotes = [
      createQuote(100n, 50000n),
      createQuote(200n, 60000n),
    ];
    const quoteSplit = new QuoteSplit(originalQuotes);

    const result = await simulator.simulate(
      ChainId.MAINNET,
      mockSwapOptions,
      quoteSplit,
      mockTokenInCurrencyInfo,
      mockTokenOutCurrencyInfo,
      1000000000000000000n,
      1000000000000000000n,
      mockContext
    );

    expect(result.quotes).toEqual(originalQuotes);
    expect(result.quotes.length).toBe(2);
  });

  it('should work with different chain IDs', async () => {
    const quote = new QuoteSplit([createQuote(100n, 50000n)]);

    const resultMainnet = await simulator.simulate(
      ChainId.MAINNET,
      mockSwapOptions,
      quote,
      mockTokenInCurrencyInfo,
      mockTokenOutCurrencyInfo,
      1000000000000000000n,
      1000000000000000000n,
      mockContext
    );

    const resultArbitrum = await simulator.simulate(
      ChainId.ARBITRUM,
      mockSwapOptions,
      quote,
      mockTokenInCurrencyInfo,
      mockTokenOutCurrencyInfo,
      1000000000000000000n,
      1000000000000000000n,
      mockContext
    );

    expect(resultMainnet.simulationResult!.status).toBe(
      SimulationStatus.SUCCESS
    );
    expect(resultArbitrum.simulationResult!.status).toBe(
      SimulationStatus.SUCCESS
    );
  });

  it('should not include swapInfo in the result', async () => {
    const quoteSplit = new QuoteSplit([createQuote(100n, 50000n)]);

    const result = await simulator.simulate(
      ChainId.MAINNET,
      mockSwapOptions,
      quoteSplit,
      mockTokenInCurrencyInfo,
      mockTokenOutCurrencyInfo,
      1000000000000000000n,
      1000000000000000000n,
      mockContext
    );

    expect(result.swapInfo).toBeUndefined();
  });
});
