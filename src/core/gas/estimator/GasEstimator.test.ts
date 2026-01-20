import {describe, it, expect} from 'vitest';
import {V2GasEstimator} from './V2GasEstimator';
import {V3GasEstimator} from './V3GasEstimator';
import {V4GasEstimator} from './V4GasEstimator';
import {MixedGasEstimator} from './MixedGasEstimator';
import {RouteBasic} from '../../../models/route/RouteBasic';
import {ChainId} from '../../../lib/config';
import {UniProtocol} from '../../../models/pool/UniProtocol';
import {QuoteBasic} from '../../../models/quote/QuoteBasic';
import {JsonRpcProvider} from '@ethersproject/providers';
import {V2Pool} from '../../../models/pool/V2Pool';
import {V3Pool} from '../../../models/pool/V3Pool';
import {V4Pool} from '../../../models/pool/V4Pool';
import {Address} from '../../../models/address/Address';
import {IFreshPoolDetailsWrapper} from '../../../stores/pool/FreshPoolDetailsWrapper';

describe('GasEstimators', () => {
  const mockProvider = new Map<ChainId, JsonRpcProvider>();

  // Create mock pools
  const token0 = new Address('0x1000000000000000000000000000000000000000');
  const token1 = new Address('0x2000000000000000000000000000000000000000');
  const token2 = new Address('0x3000000000000000000000000000000000000000');

  const v2Pool1 = new V2Pool(
    token0,
    token1,
    new Address('0x1234567890123456789012345678901234567890'),
    BigInt(1000),
    BigInt(1000)
  );
  const v2Pool2 = new V2Pool(
    token1,
    token2,
    new Address('0x2234567890123456789012345678901234567890'),
    BigInt(1000),
    BigInt(1000)
  );

  const v3Pool1 = new V3Pool(
    token0,
    token1,
    500,
    new Address('0x3234567890123456789012345678901234567890'),
    BigInt(1000),
    BigInt(1000),
    BigInt(0)
  );
  const v3Pool2 = new V3Pool(
    token1,
    token2,
    500,
    new Address('0x4234567890123456789012345678901234567890'),
    BigInt(1000),
    BigInt(1000),
    BigInt(0)
  );

  const v4Pool1 = new V4Pool(
    token0,
    token1,
    500,
    60,
    '0x5234567890123456789012345678901234567890',
    BigInt(1000),
    '0x6234567890123456789012345678901234567890',
    BigInt(1000),
    BigInt(0)
  );

  describe('V2GasEstimator', () => {
    const v2Estimator = new V2GasEstimator(
      mockProvider,
      {} as IFreshPoolDetailsWrapper
    );

    it('should estimate gas for single hop V2 route', async () => {
      const route = new RouteBasic(UniProtocol.V2, [v2Pool1]);
      const quote = new QuoteBasic(route, BigInt(1000), undefined, undefined);

      const gasDetails = await v2Estimator.estimateRouteGas(
        quote,
        ChainId.MAINNET,
        1000
      );

      // Single hop should only have BASE_SWAP_COST
      expect(gasDetails.gasUse).toBe(BigInt(135000));
    });

    it('should estimate gas for multi-hop V2 route', async () => {
      const route = new RouteBasic(UniProtocol.V2, [v2Pool1, v2Pool2]);
      const quote = new QuoteBasic(route, BigInt(1000), undefined, undefined);

      const gasDetails = await v2Estimator.estimateRouteGas(
        quote,
        ChainId.MAINNET,
        1000
      );

      // Should be BASE_SWAP_COST + COST_PER_EXTRA_HOP
      expect(gasDetails.gasUse).toBe(BigInt(185000)); // 135000 + 50000
    });
  });

  describe('V3GasEstimator', () => {
    const v3Estimator = new V3GasEstimator(
      mockProvider,
      {} as IFreshPoolDetailsWrapper
    );

    it('should estimate gas for single hop V3 route', async () => {
      const route = new RouteBasic(UniProtocol.V3, [v3Pool1]);
      const quote = new QuoteBasic(
        route,
        BigInt(1000),
        {initializedTicksCrossedList: [2]}, // 1 tick crossed
        undefined
      );

      const gasDetails = await v3Estimator.estimateRouteGas(
        quote,
        ChainId.MAINNET,
        1000
      );

      // Should include BASE_SWAP_COST + COST_PER_HOP + SINGLE_HOP_OVERHEAD + tick costs
      expect(gasDetails.gasUse).toBe(BigInt(128000)); // 2000 + 80000 + 15000 + 31000
    });
  });

  describe('V4GasEstimator', () => {
    const v4Estimator = new V4GasEstimator(
      mockProvider,
      {} as IFreshPoolDetailsWrapper
    );

    it('should estimate gas for single hop V4 route', async () => {
      const route = new RouteBasic(UniProtocol.V4, [v4Pool1]);
      const quote = new QuoteBasic(route, BigInt(1000), undefined, undefined);

      const gasDetails = await v4Estimator.estimateRouteGas(
        quote,
        ChainId.MAINNET,
        1000
      );

      // Should be similar to V3 without tick crossing
      expect(gasDetails.gasUse).toBe(BigInt(97000)); // 2000 + 80000 + 15000
    });
  });

  describe('MixedGasEstimator', () => {
    const mixedEstimator = new MixedGasEstimator(
      mockProvider,
      {} as IFreshPoolDetailsWrapper
    );
    const v2Estimator = new V2GasEstimator(
      mockProvider,
      {} as IFreshPoolDetailsWrapper
    );
    const v3Estimator = new V3GasEstimator(
      mockProvider,
      {} as IFreshPoolDetailsWrapper
    );

    it('should estimate gas for mixed V2-V3 route', async () => {
      const route = new RouteBasic(UniProtocol.MIXED, [v2Pool1, v3Pool2]);
      const quote = new QuoteBasic(
        route,
        BigInt(1000),
        {initializedTicksCrossedList: [2]}, // 1 tick crossed
        undefined
      );

      const gasDetails = await mixedEstimator.estimateRouteGas(
        quote,
        ChainId.MAINNET,
        1000
      );

      // Should include:
      // V2 section: BASE_SWAP_COST_V2
      // V3 section: BASE_SWAP_COST + COST_PER_HOP + SINGLE_HOP_OVERHEAD + tick costs
      expect(gasDetails.gasUse).toBe(BigInt(263000)); // 135000 + 2000 + 80000 + 15000 + 31000
    });

    it('should estimate gas for mixed V3-V4 route', async () => {
      const route = new RouteBasic(UniProtocol.MIXED, [v3Pool1, v4Pool1]);
      const quote = new QuoteBasic(
        route,
        BigInt(1000),
        {initializedTicksCrossedList: [2]}, // 1 tick crossed
        undefined
      );

      const gasDetails = await mixedEstimator.estimateRouteGas(
        quote,
        ChainId.MAINNET,
        1000
      );

      // Should include:
      // V3 section: BASE_SWAP_COST + COST_PER_HOP + SINGLE_HOP_OVERHEAD + tick costs
      // V4 section: BASE_SWAP_COST + COST_PER_HOP + SINGLE_HOP_OVERHEAD
      expect(gasDetails.gasUse).toBe(BigInt(225000)); // (2000 + 80000 + 15000 + 31000) + (2000 + 80000 + 15000)
    });

    it('should estimate gas consistently across individual and mixed routes', async () => {
      // Test V2 route alone
      const v2Route = new RouteBasic(UniProtocol.V2, [v2Pool1]);
      const v2Quote = new QuoteBasic(
        v2Route,
        BigInt(1000),
        undefined,
        undefined
      );
      const v2GasDetails = await v2Estimator.estimateRouteGas(
        v2Quote,
        ChainId.MAINNET,
        1000
      );

      // Test V3 route alone
      const v3Route = new RouteBasic(UniProtocol.V3, [v3Pool2]);
      const v3Quote = new QuoteBasic(
        v3Route,
        BigInt(1000),
        {initializedTicksCrossedList: [2]}, // 1 tick crossed
        undefined
      );
      const v3GasDetails = await v3Estimator.estimateRouteGas(
        v3Quote,
        ChainId.MAINNET,
        1000
      );

      // Test mixed V2-V3 route
      const mixedRoute = new RouteBasic(UniProtocol.MIXED, [v2Pool1, v3Pool2]);
      const mixedQuote = new QuoteBasic(
        mixedRoute,
        BigInt(1000),
        {initializedTicksCrossedList: [2]}, // 1 tick crossed
        undefined
      );
      const mixedGasDetails = await mixedEstimator.estimateRouteGas(
        mixedQuote,
        ChainId.MAINNET,
        1000
      );

      // Individual estimates
      expect(v2GasDetails.gasUse).toBe(BigInt(135000)); // BASE_SWAP_COST_V2
      expect(v3GasDetails.gasUse).toBe(BigInt(128000)); // BASE_SWAP_COST + COST_PER_HOP + SINGLE_HOP_OVERHEAD + tick costs

      // Mixed route estimate
      expect(mixedGasDetails.gasUse).toBe(BigInt(263000)); // Should equal sum of individual estimates
      expect(mixedGasDetails.gasUse).toBe(
        v2GasDetails.gasUse + v3GasDetails.gasUse
      );
    });
  });
});
