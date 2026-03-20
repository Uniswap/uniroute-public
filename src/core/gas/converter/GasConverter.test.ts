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
import {Protocol} from '../../../models/pool/Protocol';
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
    const route = new RouteBasic(Protocol.V3, []);
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
      undefined // no priceUSD — forces pool-based fallback
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
    const route = new RouteBasic(Protocol.V3, []);
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
      const route = new RouteBasic(Protocol.V4, []);
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
      const route = new RouteBasic(Protocol.V3, []);
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
            undefined // no priceUSD — forces pool-based fallback
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
      const route = new RouteBasic(Protocol.V4, []);
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

  describe('USD pricing path', () => {
    it('should derive gasCostInQuoteToken from USD prices when both are available', async () => {
      const chainId = ChainId.MAINNET;
      const wrappedNative = WRAPPED_NATIVE_CURRENCY[chainId]!;
      const usdcAddress = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
      const tokensInfo = new Map<string, Erc20Token | null>([
        [
          wrappedNative.address,
          new Erc20Token(
            new Address(wrappedNative.address),
            wrappedNative.decimals,
            'WETH',
            'Wrapped Ether',
            undefined,
            2000 // priceUSD
          ),
        ],
        [
          usdcAddress,
          new Erc20Token(
            new Address(usdcAddress),
            6,
            'USDC',
            'USD Coin',
            undefined,
            1 // priceUSD
          ),
        ],
      ]);

      // 97000 gas * 20 gwei = 1,940,000,000,000,000 wei
      const gasCostInWei = 97000n * 20_000_000_000n;
      const gasDetails = new GasDetails(
        20_000_000_000n,
        gasCostInWei,
        0.00194,
        97000n
      );
      const route = new RouteBasic(Protocol.V3, []);
      const quote = new QuoteBasic(route, 1_000_000n, undefined, gasDetails);
      const quoteSplit = new QuoteSplit([quote]);

      await gasConverter.updateQuotesGasDetails(
        chainId,
        usdcAddress,
        tokensInfo,
        [quoteSplit],
        ctx
      );

      // gasCostInUSD = 2000 * 0.00194 = 3.88
      expect(quoteSplit.quotes[0].gasDetails?.gasCostInUSD).toBeCloseTo(
        3.88,
        5
      );

      // gasCostInQuoteToken = (3.88 / 1) * 10^6 = 3_880_000
      expect(quoteSplit.quotes[0].gasDetails?.gasCostInQuoteToken).toBe(
        3880000n
      );

      // Pool repos should NOT have been called
      expect(v2PoolRepository.getPools).not.toHaveBeenCalled();
      expect(v3PoolRepository.getPools).not.toHaveBeenCalled();
      expect(v4PoolRepository.getPools).not.toHaveBeenCalled();
      expect(getQuoteThroughNativePool).not.toHaveBeenCalled();
    });

    it('should derive gasCostInQuoteToken for non-stablecoin quote token', async () => {
      const chainId = ChainId.MAINNET;
      const wrappedNative = WRAPPED_NATIVE_CURRENCY[chainId]!;
      const linkAddress = '0x514910771AF9Ca656af840dff83E8264EcF986CA';
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
        [
          linkAddress,
          new Erc20Token(
            new Address(linkAddress),
            18,
            'LINK',
            'Chainlink Token',
            undefined,
            15 // priceUSD
          ),
        ],
      ]);

      // 97000 gas * 20 gwei
      const gasCostInWei = 97000n * 20_000_000_000n;
      const gasDetails = new GasDetails(
        20_000_000_000n,
        gasCostInWei,
        0.00194,
        97000n
      );
      const route = new RouteBasic(Protocol.V3, []);
      const quote = new QuoteBasic(route, 1_000_000n, undefined, gasDetails);
      const quoteSplit = new QuoteSplit([quote]);

      await gasConverter.updateQuotesGasDetails(
        chainId,
        linkAddress,
        tokensInfo,
        [quoteSplit],
        ctx
      );

      // gasCostInUSD = 2000 * 0.00194 = 3.88
      // gasCostInQuoteToken = (3.88 / 15) * 10^18 ≈ 2.586e17
      // Use the same computation path as the implementation to avoid floating point divergence
      const gasCostInUSD = quoteSplit.quotes[0].gasDetails?.gasCostInUSD!;
      const expected = BigInt(Math.floor((gasCostInUSD / 15) * 10 ** 18));
      expect(quoteSplit.quotes[0].gasDetails?.gasCostInQuoteToken).toBe(
        expected
      );

      // Pool repos should NOT have been called
      expect(v2PoolRepository.getPools).not.toHaveBeenCalled();
      expect(v3PoolRepository.getPools).not.toHaveBeenCalled();
      expect(v4PoolRepository.getPools).not.toHaveBeenCalled();
    });

    it('should use USD pricing in getGasCostInQuoteTokenBasedOnGasCostInWei when prices available', async () => {
      const chainId = ChainId.MAINNET;
      const wrappedNative = WRAPPED_NATIVE_CURRENCY[chainId]!;
      const usdcAddress = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
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
        [
          usdcAddress,
          new Erc20Token(
            new Address(usdcAddress),
            6,
            'USDC',
            'USD Coin',
            undefined,
            1
          ),
        ],
      ]);

      const gasCostInWei = 97000n * 20_000_000_000n;

      const result =
        await gasConverter.getGasCostInQuoteTokenBasedOnGasCostInWei(
          chainId,
          usdcAddress,
          tokensInfo,
          gasCostInWei,
          ctx
        );

      // gasCostInUSD = 2000 * 0.00194 = 3.88
      // result = (3.88 / 1) * 10^6 = 3_880_000
      expect(result).toBe(3880000n);

      // Pool repos should NOT have been called
      expect(v2PoolRepository.getPools).not.toHaveBeenCalled();
      expect(v3PoolRepository.getPools).not.toHaveBeenCalled();
      expect(v4PoolRepository.getPools).not.toHaveBeenCalled();
    });

    it('should use USD pricing for 6-decimal gas token (Tempo) with non-native quote token', async () => {
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
            1 // priceUSD
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
            1 // priceUSD
          ),
        ],
      ]);

      // 97000 gas * 20 gwei = 1,940,000,000,000,000 wei
      const gasCostInWei = 97000n * 20_000_000_000n;
      const gasDetails = new GasDetails(
        20_000_000_000n,
        gasCostInWei,
        0.00194,
        97000n
      );
      const route = new RouteBasic(Protocol.V4, []);
      const quote = new QuoteBasic(route, 10_000_000n, undefined, gasDetails);
      const quoteSplit = new QuoteSplit([quote]);

      await gasConverter.updateQuotesGasDetails(
        chainId,
        usdcAddress,
        tokensInfo,
        [quoteSplit],
        ctx
      );

      // gasCostInUSD = 1 * 0.00194 = 0.00194
      // gasCostInQuoteToken = (0.00194 / 1) * 10^6 = 1940
      expect(quoteSplit.quotes[0].gasDetails?.gasCostInQuoteToken).toBe(1940n);
      expect(quoteSplit.quotes[0].gasDetails?.gasCostInUSD).toBeCloseTo(
        0.00194,
        5
      );

      // Pool repos should NOT have been called
      expect(v2PoolRepository.getPools).not.toHaveBeenCalled();
      expect(v3PoolRepository.getPools).not.toHaveBeenCalled();
      expect(v4PoolRepository.getPools).not.toHaveBeenCalled();
    });
  });

  describe('pool-based fallback when USD pricing unavailable', () => {
    it('should fall back to pool-based conversion when quoteToken has no priceUSD', async () => {
      const chainId = ChainId.MAINNET;
      const wrappedNative = WRAPPED_NATIVE_CURRENCY[chainId]!;
      const quoteTokenAddress =
        '0x6B175474E89094C44Da98b954EedeAC495271d0F'; // DAI
      const tokensInfo = new Map<string, Erc20Token | null>([
        [
          wrappedNative.address,
          new Erc20Token(
            new Address(wrappedNative.address),
            wrappedNative.decimals,
            'WETH',
            'Wrapped Ether',
            undefined,
            2000 // nativeToken HAS priceUSD
          ),
        ],
        [
          quoteTokenAddress,
          new Erc20Token(
            new Address(quoteTokenAddress),
            18,
            'DAI',
            'Dai Stablecoin',
            undefined,
            undefined // quoteToken has NO priceUSD
          ),
        ],
      ]);

      // Mock a V3 pool between WETH and DAI
      const mockV3Pool = new V3Pool(
        new Address(wrappedNative.address),
        new Address(quoteTokenAddress),
        3000,
        new Address('0x1234567890123456789012345678901234567890'),
        1000000n,
        79228162514264337593543950336n,
        0n
      );

      vi.mocked(v3PoolRepository.getPools).mockResolvedValue([mockV3Pool]);
      vi.mocked(v2PoolRepository.getPools).mockResolvedValue([]);
      vi.mocked(v4PoolRepository.getPools).mockResolvedValue([]);

      const {CurrencyAmount: CurrencyAmountSDK, Token: TokenSDK} =
        await import('@uniswap/sdk-core');
      const mockQuoteResult = CurrencyAmountSDK.fromRawAmount(
        new TokenSDK(chainId, quoteTokenAddress, 18, 'DAI'),
        '5000000000000000000' // 5 DAI
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(getQuoteThroughNativePool).mockReturnValue(
        mockQuoteResult as any
      );

      const gasCostInWei = 97000n * 20_000_000_000n;
      const gasDetails = new GasDetails(
        20_000_000_000n,
        gasCostInWei,
        0.00194,
        97000n
      );
      const route = new RouteBasic(Protocol.V3, []);
      const quote = new QuoteBasic(route, 1_000_000n, undefined, gasDetails);
      const quoteSplit = new QuoteSplit([quote]);

      await gasConverter.updateQuotesGasDetails(
        chainId,
        quoteTokenAddress,
        tokensInfo,
        [quoteSplit],
        ctx
      );

      // Should have used pool-based conversion
      expect(v3PoolRepository.getPools).toHaveBeenCalled();
      expect(getQuoteThroughNativePool).toHaveBeenCalled();
      expect(quoteSplit.quotes[0].gasDetails?.gasCostInQuoteToken).toBe(
        5000000000000000000n
      );
    });

    it('should fall back to pool-based conversion when nativeToken has no priceUSD', async () => {
      const chainId = ChainId.MAINNET;
      const wrappedNative = WRAPPED_NATIVE_CURRENCY[chainId]!;
      const usdcAddress = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
      const tokensInfo = new Map<string, Erc20Token | null>([
        [
          wrappedNative.address,
          new Erc20Token(
            new Address(wrappedNative.address),
            wrappedNative.decimals,
            'WETH',
            'Wrapped Ether',
            undefined,
            undefined // nativeToken has NO priceUSD
          ),
        ],
        [
          usdcAddress,
          new Erc20Token(
            new Address(usdcAddress),
            6,
            'USDC',
            'USD Coin',
            undefined,
            1 // quoteToken HAS priceUSD
          ),
        ],
      ]);

      const mockV3Pool = new V3Pool(
        new Address(wrappedNative.address),
        new Address(usdcAddress),
        3000,
        new Address('0x1234567890123456789012345678901234567890'),
        1000000n,
        79228162514264337593543950336n,
        0n
      );

      vi.mocked(v3PoolRepository.getPools).mockResolvedValue([mockV3Pool]);
      vi.mocked(v2PoolRepository.getPools).mockResolvedValue([]);
      vi.mocked(v4PoolRepository.getPools).mockResolvedValue([]);

      const {CurrencyAmount: CurrencyAmountSDK, Token: TokenSDK} =
        await import('@uniswap/sdk-core');
      const mockQuoteResult = CurrencyAmountSDK.fromRawAmount(
        new TokenSDK(chainId, usdcAddress, 6, 'USDC'),
        '3880000' // 3.88 USDC
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(getQuoteThroughNativePool).mockReturnValue(
        mockQuoteResult as any
      );

      const gasCostInWei = 97000n * 20_000_000_000n;
      const gasDetails = new GasDetails(
        20_000_000_000n,
        gasCostInWei,
        0.00194,
        97000n
      );
      const route = new RouteBasic(Protocol.V3, []);
      const quote = new QuoteBasic(route, 1_000_000n, undefined, gasDetails);
      const quoteSplit = new QuoteSplit([quote]);

      await gasConverter.updateQuotesGasDetails(
        chainId,
        usdcAddress,
        tokensInfo,
        [quoteSplit],
        ctx
      );

      // Should have used pool-based conversion
      expect(v3PoolRepository.getPools).toHaveBeenCalled();
      expect(getQuoteThroughNativePool).toHaveBeenCalled();
      expect(quoteSplit.quotes[0].gasDetails?.gasCostInQuoteToken).toBe(
        3880000n
      );

      // gasCostInUSD should be 0 since nativeToken has no priceUSD
      expect(quoteSplit.quotes[0].gasDetails?.gasCostInUSD).toBe(0);
    });

    it('should fall back in getGasCostInQuoteTokenBasedOnGasCostInWei when quoteToken has no priceUSD', async () => {
      const chainId = ChainId.MAINNET;
      const wrappedNative = WRAPPED_NATIVE_CURRENCY[chainId]!;
      const quoteTokenAddress =
        '0x6B175474E89094C44Da98b954EedeAC495271d0F'; // DAI
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
        [
          quoteTokenAddress,
          new Erc20Token(
            new Address(quoteTokenAddress),
            18,
            'DAI',
            'Dai Stablecoin',
            undefined,
            undefined // no priceUSD
          ),
        ],
      ]);

      // No pools found — should return 0n
      vi.mocked(v3PoolRepository.getPools).mockResolvedValue([]);
      vi.mocked(v2PoolRepository.getPools).mockResolvedValue([]);
      vi.mocked(v4PoolRepository.getPools).mockResolvedValue([]);

      const gasCostInWei = 97000n * 20_000_000_000n;

      const result =
        await gasConverter.getGasCostInQuoteTokenBasedOnGasCostInWei(
          chainId,
          quoteTokenAddress,
          tokensInfo,
          gasCostInWei,
          ctx
        );

      // Fallback used, no pools found → 0n
      expect(result).toBe(0n);

      // Pool repos SHOULD have been called
      expect(v3PoolRepository.getPools).toHaveBeenCalled();
    });
  });
});
