import {describe, it, expect, vi, beforeEach} from 'vitest';
import {buildTestContext} from '@uniswap/lib-testhelpers';
import {BigNumber} from '@ethersproject/bignumber';
import {ArbitrumGasDataProvider} from './gas-data-provider';
import {BaseProvider} from '@ethersproject/providers';
import {ARB_GASINFO_ADDRESS} from './gas-helpers';

// Mock the factory
vi.mock(
  '../../../abis/src/generated/contracts/factories/GasDataArbitrum__factory',
  () => ({
    GasDataArbitrum__factory: {
      connect: vi.fn(),
    },
  })
);

describe('ArbitrumGasDataProvider', () => {
  let provider: ArbitrumGasDataProvider;
  let mockBaseProvider: BaseProvider;
  let mockContract: {getPricesInWei: ReturnType<typeof vi.fn>};

  beforeEach(async () => {
    vi.clearAllMocks();

    mockBaseProvider = {} as BaseProvider;
    mockContract = {
      getPricesInWei: vi.fn(),
    };

    // Setup the mock factory
    const {GasDataArbitrum__factory} = await import(
      '../../../abis/src/generated/contracts/factories/GasDataArbitrum__factory'
    );
    vi.mocked(GasDataArbitrum__factory.connect).mockReturnValue(
      mockContract as unknown as ReturnType<
        typeof GasDataArbitrum__factory.connect
      >
    );

    provider = new ArbitrumGasDataProvider(mockBaseProvider);
  });

  describe('constructor', () => {
    it('should create instance with provider', () => {
      expect(provider).toBeInstanceOf(ArbitrumGasDataProvider);
    });
  });

  describe('getGasData', () => {
    it('should return gas data with correct structure', async () => {
      const mockGasData = [
        BigNumber.from('100000000'), // perL2TxFee (index 0)
        BigNumber.from('16000000'), // perL1CalldataByte (index 1)
        BigNumber.from('0'), // unused
        BigNumber.from('0'), // unused
        BigNumber.from('0'), // unused
        BigNumber.from('500000'), // perArbGasTotal (index 5)
      ];

      mockContract.getPricesInWei.mockResolvedValue(mockGasData);

      const ctx = buildTestContext();
      const result = await provider.getGasData(ctx);

      expect(result).toHaveProperty('perL2TxFee');
      expect(result).toHaveProperty('perL1CalldataFee');
      expect(result).toHaveProperty('perArbGasTotal');
      expect(
        ctx.metrics.countStore['UniRouteService.Metric.ArbitrumGasData.RpcCall']
      ).toBe(1);
      expect(ctx.metrics.distStore).toContainEqual(
        expect.objectContaining({
          metric_name:
            'UniRouteService.Metric.ArbitrumGasData.RpcCall.Latency.dist',
          opts: expect.objectContaining({tags: ['status:success']}),
        })
      );
    });

    it('should return perL2TxFee from gasData[0]', async () => {
      const perL2TxFee = BigNumber.from('123456789');
      const mockGasData = [
        perL2TxFee,
        BigNumber.from('16000000'),
        BigNumber.from('0'),
        BigNumber.from('0'),
        BigNumber.from('0'),
        BigNumber.from('500000'),
      ];

      mockContract.getPricesInWei.mockResolvedValue(mockGasData);

      const result = await provider.getGasData(buildTestContext());

      expect(result.perL2TxFee.eq(perL2TxFee)).toBe(true);
    });

    it('should return perL1CalldataFee as gasData[1] divided by 16', async () => {
      const perL1CalldataByte = BigNumber.from('1600000'); // 1600000 / 16 = 100000
      const mockGasData = [
        BigNumber.from('100000000'),
        perL1CalldataByte,
        BigNumber.from('0'),
        BigNumber.from('0'),
        BigNumber.from('0'),
        BigNumber.from('500000'),
      ];

      mockContract.getPricesInWei.mockResolvedValue(mockGasData);

      const result = await provider.getGasData(buildTestContext());

      // 1600000 / 16 = 100000
      expect(result.perL1CalldataFee.eq(BigNumber.from('100000'))).toBe(true);
    });

    it('should return perArbGasTotal from gasData[5]', async () => {
      const perArbGasTotal = BigNumber.from('999888777');
      const mockGasData = [
        BigNumber.from('100000000'),
        BigNumber.from('16000000'),
        BigNumber.from('0'),
        BigNumber.from('0'),
        BigNumber.from('0'),
        perArbGasTotal,
      ];

      mockContract.getPricesInWei.mockResolvedValue(mockGasData);

      const result = await provider.getGasData(buildTestContext());

      expect(result.perArbGasTotal.eq(perArbGasTotal)).toBe(true);
    });

    it('should call contract with correct address', async () => {
      const {GasDataArbitrum__factory} = await import(
        '../../../abis/src/generated/contracts/factories/GasDataArbitrum__factory'
      );

      const mockGasData = [
        BigNumber.from('100000000'),
        BigNumber.from('16000000'),
        BigNumber.from('0'),
        BigNumber.from('0'),
        BigNumber.from('0'),
        BigNumber.from('500000'),
      ];
      mockContract.getPricesInWei.mockResolvedValue(mockGasData);

      await provider.getGasData(buildTestContext());

      expect(GasDataArbitrum__factory.connect).toHaveBeenCalledWith(
        ARB_GASINFO_ADDRESS,
        mockBaseProvider
      );
    });

    it('should handle large gas values', async () => {
      const largeValue = BigNumber.from('999999999999999999999');
      const mockGasData = [
        largeValue,
        BigNumber.from('16000000000000000000'),
        BigNumber.from('0'),
        BigNumber.from('0'),
        BigNumber.from('0'),
        largeValue,
      ];

      mockContract.getPricesInWei.mockResolvedValue(mockGasData);

      const result = await provider.getGasData(buildTestContext());

      expect(result.perL2TxFee.eq(largeValue)).toBe(true);
      expect(result.perArbGasTotal.eq(largeValue)).toBe(true);
    });

    it('should handle zero values', async () => {
      const mockGasData = [
        BigNumber.from('0'),
        BigNumber.from('0'),
        BigNumber.from('0'),
        BigNumber.from('0'),
        BigNumber.from('0'),
        BigNumber.from('0'),
      ];

      mockContract.getPricesInWei.mockResolvedValue(mockGasData);

      const result = await provider.getGasData(buildTestContext());

      expect(result.perL2TxFee.eq(BigNumber.from('0'))).toBe(true);
      expect(result.perL1CalldataFee.eq(BigNumber.from('0'))).toBe(true);
      expect(result.perArbGasTotal.eq(BigNumber.from('0'))).toBe(true);
    });

    it('should throw when contract call fails', async () => {
      mockContract.getPricesInWei.mockRejectedValue(
        new Error('Contract call failed')
      );

      const ctx = buildTestContext();
      await expect(provider.getGasData(ctx)).rejects.toThrow(
        'Contract call failed'
      );
      expect(
        ctx.metrics.countStore['UniRouteService.Metric.ArbitrumGasData.RpcCall']
      ).toBe(1);
      expect(ctx.metrics.distStore).toContainEqual(
        expect.objectContaining({
          metric_name:
            'UniRouteService.Metric.ArbitrumGasData.RpcCall.Latency.dist',
          opts: expect.objectContaining({
            tags: ['status:failure', 'reason:rpc_error'],
          }),
        })
      );
    });
  });
});
