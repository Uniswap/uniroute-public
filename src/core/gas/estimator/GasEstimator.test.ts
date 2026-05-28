import {describe, it, expect} from 'vitest';
import {V2GasEstimator} from './V2GasEstimator';
import {V3GasEstimator} from './V3GasEstimator';
import {V4GasEstimator} from './V4GasEstimator';
import {MixedGasEstimator} from './MixedGasEstimator';
import {RouteBasic} from '../../../models/route/RouteBasic';
import {ChainId} from '../../../lib/config';
import {QuoteBasic} from '../../../models/quote/QuoteBasic';
import {JsonRpcProvider} from '@ethersproject/providers';
import {V2Pool} from '../../../models/pool/V2Pool';
import {V3Pool} from '../../../models/pool/V3Pool';
import {V4Pool} from '../../../models/pool/V4Pool';
import {Address} from '../../../models/address/Address';
import {IFreshPoolDetailsWrapper} from '../../../stores/pool/FreshPoolDetailsWrapper';
import {Protocol} from '../../../models/pool/Protocol';

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
      const route = new RouteBasic(Protocol.V2, [v2Pool1]);
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
      const route = new RouteBasic(Protocol.V2, [v2Pool1, v2Pool2]);
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
      const route = new RouteBasic(Protocol.V3, [v3Pool1]);
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
      const route = new RouteBasic(Protocol.V4, [v4Pool1]);
      const quote = new QuoteBasic(route, BigInt(1000), undefined, undefined);

      const gasDetails = await v4Estimator.estimateRouteGas(
        quote,
        ChainId.MAINNET,
        1000
      );

      // Should be similar to V3 without tick crossing
      expect(gasDetails.gasUse).toBe(BigInt(97000)); // 2000 + 80000 + 15000
    });

    describe('agg-hook gas calibration', () => {
      // FluidDexT1 mainnet hook (from FLUID_DEX_1 list)
      const FLUID_DEX_T1_HOOK = '0xf1abe2961CCf73B55be164054E7ADC985a52A888';

      const v4PoolWithFluidHook = new V4Pool(
        token0,
        token1,
        500,
        60,
        FLUID_DEX_T1_HOOK,
        BigInt(1000),
        '0x9234567890123456789012345678901234567890',
        BigInt(1000),
        BigInt(0)
      );

      it('should NOT apply calibration when kill-switch is off (default)', async () => {
        const estimator = new V4GasEstimator(
          mockProvider,
          {} as IFreshPoolDetailsWrapper
        );
        const route = new RouteBasic(Protocol.V4, [v4PoolWithFluidHook]);
        const quote = new QuoteBasic(route, BigInt(1000), undefined, undefined);

        const gasDetails = await estimator.estimateRouteGas(
          quote,
          ChainId.MAINNET,
          1000
        );

        expect(gasDetails.gasUse).toBe(BigInt(97000));
      });

      it('should apply FluidDexT1 calibration when kill-switch is on', async () => {
        const estimator = new V4GasEstimator(
          mockProvider,
          {} as IFreshPoolDetailsWrapper,
          true
        );
        const route = new RouteBasic(Protocol.V4, [v4PoolWithFluidHook]);
        const quote = new QuoteBasic(route, BigInt(1000), undefined, undefined);

        const gasDetails = await estimator.estimateRouteGas(
          quote,
          ChainId.MAINNET,
          1000
        );

        // Base V4 single-hop gasUse 97_000 + FluidDexT1 overhead 172_000
        expect(gasDetails.gasUse).toBe(BigInt(97000 + 172000));
        // gasCostInWei must be recomputed against the adjusted gasUse
        expect(gasDetails.gasCostInWei).toBe(
          BigInt(1000) * BigInt(97000 + 172000)
        );
      });

      it('should NOT apply calibration when kill-switch is on but no agg hook present', async () => {
        const estimator = new V4GasEstimator(
          mockProvider,
          {} as IFreshPoolDetailsWrapper,
          true
        );
        const route = new RouteBasic(Protocol.V4, [v4Pool1]);
        const quote = new QuoteBasic(route, BigInt(1000), undefined, undefined);

        const gasDetails = await estimator.estimateRouteGas(
          quote,
          ChainId.MAINNET,
          1000
        );

        expect(gasDetails.gasUse).toBe(BigInt(97000));
      });
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
      const route = new RouteBasic(Protocol.MIXED, [v2Pool1, v3Pool2]);
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
      const route = new RouteBasic(Protocol.MIXED, [v3Pool1, v4Pool1]);
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
      const v2Route = new RouteBasic(Protocol.V2, [v2Pool1]);
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
      const v3Route = new RouteBasic(Protocol.V3, [v3Pool2]);
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
      const mixedRoute = new RouteBasic(Protocol.MIXED, [v2Pool1, v3Pool2]);
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

    describe('agg-hook gas calibration', () => {
      // Mainnet hook addresses from aggHooksAddressesAllowlist
      const FLUID_DEX_T1_HOOK = '0xf1abe2961CCf73B55be164054E7ADC985a52A888';
      const STABLE_SWAP_NG_HOOK = '0xc24cf69d2f636db53b57342709bdcb01fbd3a088';

      const v4PoolWithFluidHook = new V4Pool(
        token1,
        token2,
        500,
        60,
        FLUID_DEX_T1_HOOK,
        BigInt(1000),
        '0x9234567890123456789012345678901234567890',
        BigInt(1000),
        BigInt(0)
      );

      const v4PoolWithCurveNGHook = new V4Pool(
        token0,
        token1,
        500,
        60,
        STABLE_SWAP_NG_HOOK,
        BigInt(1000),
        '0xa234567890123456789012345678901234567890',
        BigInt(1000),
        BigInt(0)
      );

      it('should NOT apply calibration when kill-switch is off (default)', async () => {
        const estimator = new MixedGasEstimator(
          mockProvider,
          {} as IFreshPoolDetailsWrapper
        );
        const route = new RouteBasic(Protocol.MIXED, [
          v3Pool1,
          v4PoolWithFluidHook,
        ]);
        const quote = new QuoteBasic(
          route,
          BigInt(1000),
          {initializedTicksCrossedList: [2]},
          undefined
        );

        const baseline = await estimator.estimateRouteGas(
          quote,
          ChainId.MAINNET,
          1000
        );
        // V3 hop (2000+80000+15000+31000=128000) + V4 hop (2000+80000+15000=97000) = 225000
        expect(baseline.gasUse).toBe(BigInt(225000));
      });

      it('should apply per-protocol overhead to V4 agg-hook leg when kill-switch is on', async () => {
        const estimator = new MixedGasEstimator(
          mockProvider,
          {} as IFreshPoolDetailsWrapper,
          true
        );
        const route = new RouteBasic(Protocol.MIXED, [
          v3Pool1,
          v4PoolWithFluidHook,
        ]);
        const quote = new QuoteBasic(
          route,
          BigInt(1000),
          {initializedTicksCrossedList: [2]},
          undefined
        );

        const calibrated = await estimator.estimateRouteGas(
          quote,
          ChainId.MAINNET,
          1000
        );

        // 225000 base + 172000 FluidDexT1 overhead
        expect(calibrated.gasUse).toBe(BigInt(225000 + 172000));
      });

      it('sums per-leg overhead across multi-protocol V4 legs in a mixed route', async () => {
        const estimator = new MixedGasEstimator(
          mockProvider,
          {} as IFreshPoolDetailsWrapper,
          true
        );
        const route = new RouteBasic(Protocol.MIXED, [
          v4PoolWithCurveNGHook,
          v4PoolWithFluidHook,
        ]);
        const quote = new QuoteBasic(route, BigInt(1000), undefined, undefined);

        const calibrated = await estimator.estimateRouteGas(
          quote,
          ChainId.MAINNET,
          1000
        );

        // Two V4 hops in a single V4 section: BASE_SWAP_COST (2000)
        //   + COST_PER_HOP * 2 (80000 * 2 = 160000) = 162000
        // (no SINGLE_HOP_OVERHEAD since hops > 1, no tick costs since not V3)
        // + FluidDexT1 (172000) + CurveStableSwapNG (188000) = 522000
        expect(calibrated.gasUse).toBe(BigInt(162000 + 172000 + 188000));
      });

      it('should NOT apply calibration on a non-mainnet chainId', async () => {
        const calibratedEstimator = new MixedGasEstimator(
          mockProvider,
          {} as IFreshPoolDetailsWrapper,
          true
        );
        const baselineEstimator = new MixedGasEstimator(
          mockProvider,
          {} as IFreshPoolDetailsWrapper,
          false
        );
        const route = new RouteBasic(Protocol.MIXED, [
          v3Pool1,
          v4PoolWithFluidHook,
        ]);
        const quote = new QuoteBasic(
          route,
          BigInt(1000),
          {initializedTicksCrossedList: [2]},
          undefined
        );

        const calibrated = await calibratedEstimator.estimateRouteGas(
          quote,
          ChainId.ARBITRUM,
          1000
        );
        const baseline = await baselineEstimator.estimateRouteGas(
          quote,
          ChainId.ARBITRUM,
          1000
        );

        // No calibration on non-mainnet (FluidDexT1 hook addrs only registered
        // on MAINNET). Chain-specific gas constants may differ from mainnet,
        // so we compare against the baseline estimator on the same chainId
        // rather than a hard-coded mainnet baseline.
        expect(calibrated.gasUse).toBe(baseline.gasUse);
      });
    });
  });
});
