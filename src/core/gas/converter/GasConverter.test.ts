import {describe, beforeEach, it, expect, vi} from 'vitest';
import {GasConverter} from './GasConverter';
import {IPoolsRepository} from '../../../stores/pool/IPoolsRepository';
import {V3Pool} from '../../../models/pool/V3Pool';
import {ChainId} from '../../../lib/config';
import {buildTestContext} from '@uniswap/lib-testhelpers';
import {Erc20Token} from '../../../models/token/Erc20Token';
import {QuoteSplit} from '../../../models/quote/QuoteSplit';
import {WRAPPED_NATIVE_CURRENCY, PATHUSD_TEMPO} from '../../../lib/tokenUtils';
import {GasDetails} from '../../../models/gas/GasDetails';
import {Address} from '../../../models/address/Address';
import {QuoteBasic} from '../../../models/quote/QuoteBasic';
import {RouteBasic} from '../../../models/route/RouteBasic';
import {UniProtocol} from '../../../models/pool/UniProtocol';
import {V2Pool} from '../../../models/pool/V2Pool';
import {V4Pool} from '../../../models/pool/V4Pool';
import {buildMetricKey} from '../../../lib/config';

vi.mock('../gas-helpers', async () => {
  const actual = await vi.importActual('../gas-helpers');
  return {
    ...actual,
    getQuoteThroughNativePool: vi.fn(),
  };
});

import {getQuoteThroughNativePool} from '../gas-helpers';

describe('GasConverter', () => {
  let v2PoolRepository: IPoolsRepository<V2Pool>;
  let v3PoolRepository: IPoolsRepository<V3Pool>;
  let v4PoolRepository: IPoolsRepository<V4Pool>;
  let gasConverter: GasConverter;
  let ctx: ReturnType<typeof buildTestContext>;

  beforeEach(() => {
    v2PoolRepository = {
      getPools: vi.fn(),
    } as unknown as IPoolsRepository<V2Pool>;
    v3PoolRepository = {
      getPools: vi.fn(),
    } as unknown as IPoolsRepository<V3Pool>;
    v4PoolRepository = {
      getPools: vi.fn(),
    } as unknown as IPoolsRepository<V4Pool>;

    gasConverter = new GasConverter(
      v2PoolRepository,
      v3PoolRepository,
      v4PoolRepository
    );
    ctx = buildTestContext();

    // Reset the mock for getQuoteThroughNativePool
    vi.mocked(getQuoteThroughNativePool).mockReset();
  });

  it('should handle native currency gas conversion correctly', async () => {
    const chainId = ChainId.MAINNET;
    const wrappedNative = WRAPPED_NATIVE_CURRENCY[chainId]!;
    const tokensInfo = new Map<string, Erc20Token | null>([
      [
        wrappedNative.address,
        new Erc20Token(
          new Address(wrappedNative.address),
          wrappedNative.decimals,
          wrappedNative.symbol || 'WETH',
          wrappedNative.name || 'Wrapped Ether',
          undefined, // feeOnTransfer
          2000 // priceUSD - mock price for testing
        ),
      ],
    ]);

    // Mock the repository to return empty pools for USD lookup
    vi.mocked(v3PoolRepository.getPools).mockResolvedValue([]);

    const gasDetails = new GasDetails(100000n, 100000n, 100000, 100000n);
    const route = new RouteBasic(UniProtocol.V3, []);
    const quote = new QuoteBasic(route, 1000000n, undefined, gasDetails);

    const quoteSplit = new QuoteSplit([quote]);

    await gasConverter.updateQuotesGasDetails(
      chainId,
      wrappedNative.address,
      tokensInfo,
      [quoteSplit],
      ctx
    );

    // When quote token is native currency, gas cost in quote token should equal gas cost in wei
    expect(quoteSplit.quotes[0].gasDetails?.gasCostInQuoteToken).toBe(100000n);
    expect(quoteSplit.quotes[0].gasDetails?.gasCostInUSD).toBe(2e-10);
  });

  it('should catch exception and return null when getQuoteThroughNativePool throws', async () => {
    vi.mocked(getQuoteThroughNativePool).mockImplementation(() => {
      throw new Error('Division by zero');
    });

    const chainId = ChainId.MAINNET;
    const wrappedNative = WRAPPED_NATIVE_CURRENCY[chainId]!;
    const quoteTokenAddress = '0x6B175474E89094C44Da98b954EedeAC495271d0F'; // DAI
    const quoteToken = new Erc20Token(
      new Address(quoteTokenAddress),
      18,
      'DAI',
      'Dai Stablecoin',
      undefined,
      1
    );

    const tokensInfo = new Map<string, Erc20Token | null>([
      [
        wrappedNative.address,
        new Erc20Token(
          new Address(wrappedNative.address),
          wrappedNative.decimals,
          wrappedNative.symbol || 'WETH',
          wrappedNative.name || 'Wrapped Ether',
          undefined,
          2000
        ),
      ],
      [quoteTokenAddress, quoteToken],
    ]);

    // Create a mock V3Pool that will be converted to SDK pool
    const mockV3Pool = new V3Pool(
      new Address(wrappedNative.address),
      new Address(quoteTokenAddress),
      3000, // fee
      new Address('0x1234567890123456789012345678901234567890'),
      1000000n, // liquidity
      79228162514264337593543950336n, // sqrtPriceX96
      0n // tickCurrent
    );

    // Mock the repository to return the pool
    vi.mocked(v3PoolRepository.getPools).mockResolvedValue([mockV3Pool]);
    vi.mocked(v2PoolRepository.getPools).mockResolvedValue([]);
    vi.mocked(v4PoolRepository.getPools).mockResolvedValue([]);

    const gasDetails = new GasDetails(100000n, 100000n, 100000, 100000n);
    const route = new RouteBasic(UniProtocol.V3, []);
    const quote = new QuoteBasic(route, 1000000n, undefined, gasDetails);

    const quoteSplit = new QuoteSplit([quote]);

    await gasConverter.updateQuotesGasDetails(
      chainId,
      quoteTokenAddress,
      tokensInfo,
      [quoteSplit],
      ctx
    );

    // Should return null (0n) when exception is caught
    expect(quoteSplit.quotes[0].gasDetails?.gasCostInQuoteToken).toBe(0n);

    // Verify error was logged
    const errorLogs = ctx.logger.outputs.filter(
      output => output.prefix === 'ERROR:'
    );
    expect(errorLogs.length).toBeGreaterThan(0);
    const errorLog = errorLogs.find(
      output =>
        output.msg === 'GasConverter.convertGasCostToQuoteToken' &&
        output.extra.message
          ?.toString()
          .includes('Error converting gas cost to quote token')
    );
    expect(errorLog).toBeDefined();
    expect(errorLog?.extra.error).toBeDefined();
    expect(errorLog?.extra.chainId).toBe(chainId);

    // Verify metric was recorded
    const metricKey = buildMetricKey('GasConverter.ExceptionThrown');
    expect(ctx.metrics.countStore[metricKey]).toBe(1);
  });

  describe('gas token decimal scaling', () => {
    it('should scale gasCostInWei for 6-decimal gas tokens (Tempo/pathUSD)', async () => {
      const chainId = ChainId.TEMPO;
      const pathUSD = PATHUSD_TEMPO; // 6 decimals
      const tokensInfo = new Map<string, Erc20Token | null>([
        [
          pathUSD.address,
          new Erc20Token(
            new Address(pathUSD.address),
            pathUSD.decimals,
            'pathUSD',
            'pathUSD',
            undefined,
            1 // priceUSD = $1
          ),
        ],
      ]);

      vi.mocked(v3PoolRepository.getPools).mockResolvedValue([]);
      vi.mocked(v2PoolRepository.getPools).mockResolvedValue([]);
      vi.mocked(v4PoolRepository.getPools).mockResolvedValue([]);

      // 97000 gas * 20 gwei = 1,940,000,000,000,000 wei
      const gasCostInWei = 97000n * 20_000_000_000n;
      const gasDetails = new GasDetails(
        20_000_000_000n,
        gasCostInWei,
        0.00194,
        97000n
      );
      const route = new RouteBasic(UniProtocol.V4, []);
      const quote = new QuoteBasic(route, 10_000_000n, undefined, gasDetails);
      const quoteSplit = new QuoteSplit([quote]);

      // Quote token = pathUSD (same as gas token), so no pool lookup needed
      await gasConverter.updateQuotesGasDetails(
        chainId,
        pathUSD.address,
        tokensInfo,
        [quoteSplit],
        ctx
      );

      // gasCostInWei = 1.94e15, scaled by 10^(18-6) = 10^12
      // Expected: 1_940_000_000_000_000 / 1_000_000_000_000 = 1940 raw units
      // = 0.001940 pathUSD
      expect(quoteSplit.quotes[0].gasDetails?.gasCostInQuoteToken).toBe(1940n);

      // gasCostInUSD = priceUSD * toExact() = 1 * 0.00194 = 0.00194
      expect(quoteSplit.quotes[0].gasDetails?.gasCostInUSD).toBeCloseTo(
        0.00194,
        5
      );
    });

    it('should not scale gasCostInWei for 18-decimal gas tokens (Mainnet/WETH)', async () => {
      const chainId = ChainId.MAINNET;
      const wrappedNative = WRAPPED_NATIVE_CURRENCY[chainId]!; // 18 decimals
      const tokensInfo = new Map<string, Erc20Token | null>([
        [
          wrappedNative.address,
          new Erc20Token(
            new Address(wrappedNative.address),
            wrappedNative.decimals,
            'WETH',
            'Wrapped Ether',
            undefined,
            2000
          ),
        ],
      ]);

      vi.mocked(v3PoolRepository.getPools).mockResolvedValue([]);
      vi.mocked(v2PoolRepository.getPools).mockResolvedValue([]);
      vi.mocked(v4PoolRepository.getPools).mockResolvedValue([]);

      // 97000 gas * 20 gwei = 1,940,000,000,000,000 wei
      const gasCostInWei = 97000n * 20_000_000_000n;
      const gasDetails = new GasDetails(
        20_000_000_000n,
        gasCostInWei,
        0.00194,
        97000n
      );
      const route = new RouteBasic(UniProtocol.V3, []);
      const quote = new QuoteBasic(route, 1_000_000n, undefined, gasDetails);
      const quoteSplit = new QuoteSplit([quote]);

      // Quote token = WETH (same as gas token), no pool lookup needed
      await gasConverter.updateQuotesGasDetails(
        chainId,
        wrappedNative.address,
        tokensInfo,
        [quoteSplit],
        ctx
      );

      // No scaling for 18-decimal token: raw wei value passed through directly
      expect(quoteSplit.quotes[0].gasDetails?.gasCostInQuoteToken).toBe(
        gasCostInWei
      );
    });

    it('should scale gasCostInWei before pool conversion for non-native quote token on Tempo', async () => {
      const chainId = ChainId.TEMPO;
      const pathUSD = PATHUSD_TEMPO; // 6 decimals
      const usdcAddress = '0x20C000000000000000000000b9537d11c60E8b50';
      const tokensInfo = new Map<string, Erc20Token | null>([
        [
          pathUSD.address,
          new Erc20Token(
            new Address(pathUSD.address),
            pathUSD.decimals,
            'pathUSD',
            'pathUSD',
            undefined,
            1
          ),
        ],
        [
          usdcAddress,
          new Erc20Token(
            new Address(usdcAddress),
            6,
            'USDC.e',
            'USD Coin',
            undefined,
            1
          ),
        ],
      ]);

      // Mock a V3 pool between pathUSD and USDC.e
      const mockV3Pool = new V3Pool(
        new Address(pathUSD.address),
        new Address(usdcAddress),
        3000,
        new Address('0xfbdfb13c871193aa697590a86c70ebceea19ee03'),
        1_500_000_000n,
        79228162514264337593543950336n, // 1:1 price
        0n
      );

      vi.mocked(v3PoolRepository.getPools).mockResolvedValue([mockV3Pool]);
      vi.mocked(v2PoolRepository.getPools).mockResolvedValue([]);
      vi.mocked(v4PoolRepository.getPools).mockResolvedValue([]);

      // 97000 gas * 20 gwei = 1,940,000,000,000,000 wei
      const gasCostInWei = 97000n * 20_000_000_000n;
      const gasDetails = new GasDetails(
        20_000_000_000n,
        gasCostInWei,
        0.00194,
        97000n
      );
      const route = new RouteBasic(UniProtocol.V4, []);
      const quote = new QuoteBasic(route, 10_000_000n, undefined, gasDetails);
      const quoteSplit = new QuoteSplit([quote]);

      // Mock getQuoteThroughNativePool to verify the scaled amount is passed
      const {CurrencyAmount: CurrencyAmountSDK, Token: TokenSDK} = await import(
        '@uniswap/sdk-core'
      );
      const expectedScaledAmount = gasCostInWei / BigInt(10 ** 12); // 1940n
      const mockResult = CurrencyAmountSDK.fromRawAmount(
        new TokenSDK(chainId, usdcAddress, 6, 'USDC.e'),
        expectedScaledAmount.toString()
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(getQuoteThroughNativePool).mockReturnValue(mockResult as any);

      await gasConverter.updateQuotesGasDetails(
        chainId,
        usdcAddress,
        tokensInfo,
        [quoteSplit],
        ctx
      );

      // Verify getQuoteThroughNativePool was called with the scaled amount (1940),
      // not the raw wei amount (1,940,000,000,000,000)
      expect(getQuoteThroughNativePool).toHaveBeenCalled();
      const callArgs = vi.mocked(getQuoteThroughNativePool).mock.calls[0];
      const nativeCurrencyAmount = callArgs[1];
      expect(nativeCurrencyAmount.quotient.toString()).toBe(
        expectedScaledAmount.toString()
      );
    });

    it('should scale gasCostInWei in getGasCostInQuoteTokenBasedOnGasCostInWei for Tempo', async () => {
      const chainId = ChainId.TEMPO;
      const pathUSD = PATHUSD_TEMPO;
      const tokensInfo = new Map<string, Erc20Token | null>([
        [
          pathUSD.address,
          new Erc20Token(
            new Address(pathUSD.address),
            pathUSD.decimals,
            'pathUSD',
            'pathUSD',
            undefined,
            1
          ),
        ],
      ]);

      vi.mocked(v3PoolRepository.getPools).mockResolvedValue([]);
      vi.mocked(v2PoolRepository.getPools).mockResolvedValue([]);
      vi.mocked(v4PoolRepository.getPools).mockResolvedValue([]);

      const gasCostInWei = 97000n * 20_000_000_000n; // 1.94e15

      // Quote token = pathUSD (same as gas token)
      const result =
        await gasConverter.getGasCostInQuoteTokenBasedOnGasCostInWei(
          chainId,
          pathUSD.address,
          tokensInfo,
          gasCostInWei,
          ctx
        );

      // Should be scaled: 1.94e15 / 1e12 = 1940
      expect(result).toBe(1940n);
    });
  });
});
