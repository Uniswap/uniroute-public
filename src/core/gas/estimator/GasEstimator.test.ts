import {describe, it, expect} from 'vitest';
import {V2GasEstimator} from './V2GasEstimator';
import {V3GasEstimator} from './V3GasEstimator';
import {V4GasEstimator} from './V4GasEstimator';
import {MixedGasEstimator} from './MixedGasEstimator';
import {RouteBasic} from '../../../models/route/RouteBasic';
import {ChainId} from '../../../lib/config';
import {
  QuoteBasic,
  V3QuoterResponseDetails,
} from '../../../models/quote/QuoteBasic';
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

    describe('parity-hook gas overhead', () => {
      // LitePSM USDS mainnet hook (from PARITY_HOOKS_PER_CHAIN)
      const LITEPSM_USDS_HOOK = '0x958a0904940f744f8c6b72c043ceee3ea34ae888';

      const v4PoolWithParityHook = new V4Pool(
        token0,
        token1,
        0,
        1,
        LITEPSM_USDS_HOOK,
        BigInt(0),
        '0xa234567890123456789012345678901234567890',
        BigInt(1000),
        BigInt(0)
      );

      it('applies the overhead on the heuristic path with no kill-switch', async () => {
        const estimator = new V4GasEstimator(
          mockProvider,
          {} as IFreshPoolDetailsWrapper
        );
        const route = new RouteBasic(Protocol.V4, [v4PoolWithParityHook]);
        const quote = new QuoteBasic(route, BigInt(1000), undefined, undefined);

        const gasDetails = await estimator.estimateRouteGas(
          quote,
          ChainId.MAINNET,
          1000
        );

        // Base V4 single-hop gasUse 97_000 + parity hook overhead 250_000
        expect(gasDetails.gasUse).toBe(BigInt(97000 + 250000));
        expect(gasDetails.gasCostInWei).toBe(
          BigInt(1000) * BigInt(97000 + 250000)
        );
      });

      it('does NOT double-apply on the quoter-gas base path', async () => {
        const estimator = new V4GasEstimator(
          mockProvider,
          {} as IFreshPoolDetailsWrapper,
          false,
          true // v4UseQuoterGasAsBase
        );
        const route = new RouteBasic(Protocol.V4, [v4PoolWithParityHook]);
        const quoterGas = 275_000n; // measured V4Quoter return for the hop
        const quote = new QuoteBasic(
          route,
          BigInt(1000),
          new V3QuoterResponseDetails(undefined, undefined, quoterGas),
          undefined
        );

        const gasDetails = await estimator.estimateRouteGas(
          quote,
          ChainId.MAINNET,
          1000
        );

        // Quoter base already includes the hook callback; no fake-token
        // TOKEN_OVERHEAD applies, so gasUse is exactly the quoter return.
        expect(gasDetails.gasUse).toBe(quoterGas);
      });

      it('leaves no-hook V4 routes unchanged', async () => {
        const estimator = new V4GasEstimator(
          mockProvider,
          {} as IFreshPoolDetailsWrapper
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

    describe('V4Quoter-return gas base (V4_USE_QUOTER_GAS_AS_BASE)', () => {
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

      it('uses heuristic when V4_USE_QUOTER_GAS_AS_BASE is off (default)', async () => {
        const estimator = new V4GasEstimator(
          mockProvider,
          {} as IFreshPoolDetailsWrapper
        );
        const route = new RouteBasic(Protocol.V4, [v4Pool1]);
        const quote = new QuoteBasic(
          route,
          BigInt(1000),
          {gasEstimate: BigInt(250_000)}, // V4Quoter return present but ignored
          undefined
        );

        const gasDetails = await estimator.estimateRouteGas(
          quote,
          ChainId.MAINNET,
          1000
        );

        // Should still use 97k heuristic, not the 250k quoter return
        expect(gasDetails.gasUse).toBe(BigInt(97000));
      });

      it('uses V4Quoter return as base when flag is on and gasEstimate is present', async () => {
        const estimator = new V4GasEstimator(
          mockProvider,
          {} as IFreshPoolDetailsWrapper,
          false, // calibration off
          true // V4_USE_QUOTER_GAS_AS_BASE on
        );
        const route = new RouteBasic(Protocol.V4, [v4Pool1]);
        const quote = new QuoteBasic(
          route,
          BigInt(1000),
          {gasEstimate: BigInt(250_000)},
          undefined
        );

        const gasDetails = await estimator.estimateRouteGas(
          quote,
          ChainId.MAINNET,
          1000
        );

        expect(gasDetails.gasUse).toBe(BigInt(250_000));
        expect(gasDetails.gasCostInWei).toBe(BigInt(1000) * BigInt(250_000));
      });

      it('falls back to heuristic when flag is on but quoter gasEstimate is missing', async () => {
        const estimator = new V4GasEstimator(
          mockProvider,
          {} as IFreshPoolDetailsWrapper,
          false,
          true
        );
        const route = new RouteBasic(Protocol.V4, [v4Pool1]);
        const quote = new QuoteBasic(route, BigInt(1000), undefined, undefined);

        const gasDetails = await estimator.estimateRouteGas(
          quote,
          ChainId.MAINNET,
          1000
        );

        // No quoter return → heuristic
        expect(gasDetails.gasUse).toBe(BigInt(97000));
      });

      it('falls back to heuristic when flag is on but quoter gasEstimate is zero', async () => {
        const estimator = new V4GasEstimator(
          mockProvider,
          {} as IFreshPoolDetailsWrapper,
          false,
          true
        );
        const route = new RouteBasic(Protocol.V4, [v4Pool1]);
        const quote = new QuoteBasic(
          route,
          BigInt(1000),
          {gasEstimate: BigInt(0)},
          undefined
        );

        const gasDetails = await estimator.estimateRouteGas(
          quote,
          ChainId.MAINNET,
          1000
        );

        expect(gasDetails.gasUse).toBe(BigInt(97000));
      });

      it('quoter base + agg-hook calibration compose: 250k + 172k = 422k for FluidDexT1', async () => {
        const estimator = new V4GasEstimator(
          mockProvider,
          {} as IFreshPoolDetailsWrapper,
          true, // calibration on
          true // V4_USE_QUOTER_GAS_AS_BASE on
        );
        const route = new RouteBasic(Protocol.V4, [v4PoolWithFluidHook]);
        const quote = new QuoteBasic(
          route,
          BigInt(1000),
          {gasEstimate: BigInt(250_000)},
          undefined
        );

        const gasDetails = await estimator.estimateRouteGas(
          quote,
          ChainId.MAINNET,
          1000
        );

        // 250k quoter base + 172k FluidDexT1 calibration
        expect(gasDetails.gasUse).toBe(BigInt(250_000 + 172_000));
      });

      it('quoter base only (calibration off) on agg-hook route uses quoter value without overhead', async () => {
        const estimator = new V4GasEstimator(
          mockProvider,
          {} as IFreshPoolDetailsWrapper,
          false, // calibration off
          true // V4_USE_QUOTER_GAS_AS_BASE on
        );
        const route = new RouteBasic(Protocol.V4, [v4PoolWithFluidHook]);
        const quote = new QuoteBasic(
          route,
          BigInt(1000),
          {gasEstimate: BigInt(250_000)},
          undefined
        );

        const gasDetails = await estimator.estimateRouteGas(
          quote,
          ChainId.MAINNET,
          1000
        );

        // 250k quoter base, no calibration overhead added
        expect(gasDetails.gasUse).toBe(BigInt(250_000));
      });

      it('flag off + calibration on (the legacy PR #8587 state) keeps the heuristic baseline behavior', async () => {
        const estimator = new V4GasEstimator(
          mockProvider,
          {} as IFreshPoolDetailsWrapper,
          true, // calibration on
          false // V4_USE_QUOTER_GAS_AS_BASE off — pre-fix state
        );
        const route = new RouteBasic(Protocol.V4, [v4PoolWithFluidHook]);
        const quote = new QuoteBasic(
          route,
          BigInt(1000),
          {gasEstimate: BigInt(250_000)},
          undefined
        );

        const gasDetails = await estimator.estimateRouteGas(
          quote,
          ChainId.MAINNET,
          1000
        );

        // Same as PR #8587 baseline-mismatch behavior: heuristic + calibration
        // = 97k + 172k = 269k, NOT 250k + 172k = 422k. Documents the bug
        // surface that this PR's V4_USE_QUOTER_GAS_AS_BASE flag fixes.
        expect(gasDetails.gasUse).toBe(BigInt(97_000 + 172_000));
      });

      // Agg-hook quotes from fetchAggHookQuotes() arrive with
      // v3QuoterResponseDetails=undefined. Without a fallback, the
      // V4_USE_QUOTER_GAS_AS_BASE path silently degrades to the
      // heuristic for the actual production agg-hook routes —
      // exactly the routes this PR is meant to fix.
      it('falls back to per-protocol quoter-gas constant for agg-hook routes with no v3QuoterResponseDetails', async () => {
        const estimator = new V4GasEstimator(
          mockProvider,
          {} as IFreshPoolDetailsWrapper,
          true, // calibration on
          true // V4_USE_QUOTER_GAS_AS_BASE on
        );
        const route = new RouteBasic(Protocol.V4, [v4PoolWithFluidHook]);
        const quote = new QuoteBasic(route, BigInt(1000), undefined, undefined);

        const gasDetails = await estimator.estimateRouteGas(
          quote,
          ChainId.MAINNET,
          1000
        );

        // FluidDexT1 quoter fallback 250k + calibration 172k = 422k
        expect(gasDetails.gasUse).toBe(BigInt(250_000 + 172_000));
      });

      it('agg-hook fallback applies even when calibration is off (still better than heuristic)', async () => {
        const estimator = new V4GasEstimator(
          mockProvider,
          {} as IFreshPoolDetailsWrapper,
          false, // calibration off
          true // V4_USE_QUOTER_GAS_AS_BASE on
        );
        const route = new RouteBasic(Protocol.V4, [v4PoolWithFluidHook]);
        const quote = new QuoteBasic(route, BigInt(1000), undefined, undefined);

        const gasDetails = await estimator.estimateRouteGas(
          quote,
          ChainId.MAINNET,
          1000
        );

        // FluidDexT1 quoter fallback 250k, no calibration
        expect(gasDetails.gasUse).toBe(BigInt(250_000));
      });

      it('non-agg-hook V4 route without quoter gasEstimate still falls back to heuristic', async () => {
        const estimator = new V4GasEstimator(
          mockProvider,
          {} as IFreshPoolDetailsWrapper,
          false,
          true
        );
        const route = new RouteBasic(Protocol.V4, [v4Pool1]); // plain hook
        const quote = new QuoteBasic(route, BigInt(1000), undefined, undefined);

        const gasDetails = await estimator.estimateRouteGas(
          quote,
          ChainId.MAINNET,
          1000
        );

        // No quoter gas, no agg-hook fallback → heuristic 97k
        expect(gasDetails.gasUse).toBe(BigInt(97_000));
      });

      it('adds TOKEN_OVERHEAD on top of the quoter base for mainnet AAVE routes', async () => {
        const AAVE = new Address('0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9');
        const v4PoolWithAave = new V4Pool(
          AAVE,
          token1,
          500,
          60,
          '0x0000000000000000000000000000000000000000',
          BigInt(1000),
          '0xa1b2c3d4e5f607080910111213141516171819aa',
          BigInt(1000),
          BigInt(0)
        );
        const estimator = new V4GasEstimator(
          mockProvider,
          {} as IFreshPoolDetailsWrapper,
          false,
          true
        );
        const route = new RouteBasic(Protocol.V4, [v4PoolWithAave]);
        const quote = new QuoteBasic(
          route,
          BigInt(1000),
          {gasEstimate: BigInt(250_000)},
          undefined
        );

        const gasDetails = await estimator.estimateRouteGas(
          quote,
          ChainId.MAINNET,
          1000
        );

        // 250k quoter base + 150k AAVE TOKEN_OVERHEAD
        expect(gasDetails.gasUse).toBe(BigInt(250_000 + 150_000));
      });

      it('adds TOKEN_OVERHEAD on the agg-hook fallback path as well', async () => {
        const AAVE = new Address('0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9');
        const v4PoolFluidWithAave = new V4Pool(
          AAVE,
          token1,
          500,
          60,
          FLUID_DEX_T1_HOOK,
          BigInt(1000),
          '0xb1b2c3d4e5f607080910111213141516171819bb',
          BigInt(1000),
          BigInt(0)
        );
        const estimator = new V4GasEstimator(
          mockProvider,
          {} as IFreshPoolDetailsWrapper,
          true, // calibration on
          true // V4_USE_QUOTER_GAS_AS_BASE on
        );
        const route = new RouteBasic(Protocol.V4, [v4PoolFluidWithAave]);
        const quote = new QuoteBasic(route, BigInt(1000), undefined, undefined);

        const gasDetails = await estimator.estimateRouteGas(
          quote,
          ChainId.MAINNET,
          1000
        );

        // FluidDexT1 fallback 250k + AAVE 150k + calibration 172k
        expect(gasDetails.gasUse).toBe(BigInt(250_000 + 150_000 + 172_000));
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

    it('applies parity-hook overhead on a mixed route heuristic estimate', async () => {
      const v4ParityPool = new V4Pool(
        token1,
        token2,
        0,
        1,
        '0x958a0904940f744f8c6b72c043ceee3ea34ae888', // LitePSM USDS mainnet
        BigInt(0),
        '0xb234567890123456789012345678901234567890',
        BigInt(1000),
        BigInt(0)
      );
      const route = new RouteBasic(Protocol.MIXED, [v3Pool1, v4ParityPool]);
      const quote = new QuoteBasic(
        route,
        BigInt(1000),
        {initializedTicksCrossedList: [2]},
        undefined
      );

      const gasDetails = await mixedEstimator.estimateRouteGas(
        quote,
        ChainId.MAINNET,
        1000
      );

      // Same V3+V4 heuristic base as above + PARITY_HOOK_GAS_OVERHEAD
      expect(gasDetails.gasUse).toBe(BigInt(225000 + 250000));
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

    describe('V4Quoter-return gas base (V4_USE_QUOTER_GAS_AS_BASE)', () => {
      const FLUID_DEX_T1_HOOK = '0xf1abe2961CCf73B55be164054E7ADC985a52A888';
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

      it('uses heuristic when V4_USE_QUOTER_GAS_AS_BASE is off (default)', async () => {
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
          {gasEstimate: BigInt(400_000)},
          undefined
        );

        const gasDetails = await estimator.estimateRouteGas(
          quote,
          ChainId.MAINNET,
          1000
        );

        // Per-section heuristic: V3 (97k) + V4 (97k) = 194k (no ticks)
        expect(gasDetails.gasUse).toBe(BigInt(194_000));
      });

      it('uses MixedQuoter return as base when flag is on and gasEstimate is present', async () => {
        const estimator = new MixedGasEstimator(
          mockProvider,
          {} as IFreshPoolDetailsWrapper,
          false,
          true
        );
        const route = new RouteBasic(Protocol.MIXED, [
          v3Pool1,
          v4PoolWithFluidHook,
        ]);
        const quote = new QuoteBasic(
          route,
          BigInt(1000),
          {gasEstimate: BigInt(400_000)},
          undefined
        );

        const gasDetails = await estimator.estimateRouteGas(
          quote,
          ChainId.MAINNET,
          1000
        );

        expect(gasDetails.gasUse).toBe(BigInt(400_000));
      });

      it('falls back to heuristic when flag is on but quoter gasEstimate is missing', async () => {
        const estimator = new MixedGasEstimator(
          mockProvider,
          {} as IFreshPoolDetailsWrapper,
          false,
          true
        );
        const route = new RouteBasic(Protocol.MIXED, [
          v3Pool1,
          v4PoolWithFluidHook,
        ]);
        const quote = new QuoteBasic(route, BigInt(1000), undefined, undefined);

        const gasDetails = await estimator.estimateRouteGas(
          quote,
          ChainId.MAINNET,
          1000
        );

        expect(gasDetails.gasUse).toBe(BigInt(194_000));
      });

      it('quoter base + agg-hook calibration compose on mixed route: 400k + 172k = 572k', async () => {
        const estimator = new MixedGasEstimator(
          mockProvider,
          {} as IFreshPoolDetailsWrapper,
          true, // calibration on
          true // V4_USE_QUOTER_GAS_AS_BASE on
        );
        const route = new RouteBasic(Protocol.MIXED, [
          v3Pool1,
          v4PoolWithFluidHook,
        ]);
        const quote = new QuoteBasic(
          route,
          BigInt(1000),
          {gasEstimate: BigInt(400_000)},
          undefined
        );

        const gasDetails = await estimator.estimateRouteGas(
          quote,
          ChainId.MAINNET,
          1000
        );

        expect(gasDetails.gasUse).toBe(BigInt(400_000 + 172_000));
      });

      it('flag off + calibration on (pre-fix #8587 state) preserves heuristic-baseline behavior', async () => {
        const estimator = new MixedGasEstimator(
          mockProvider,
          {} as IFreshPoolDetailsWrapper,
          true, // calibration on
          false // flag off — pre-fix
        );
        const route = new RouteBasic(Protocol.MIXED, [
          v3Pool1,
          v4PoolWithFluidHook,
        ]);
        const quote = new QuoteBasic(
          route,
          BigInt(1000),
          {gasEstimate: BigInt(400_000)},
          undefined
        );

        const gasDetails = await estimator.estimateRouteGas(
          quote,
          ChainId.MAINNET,
          1000
        );

        // Heuristic 194k + FluidDexT1 calibration 172k = 366k. The
        // MixedQuoter return of 400k is ignored. This documents the
        // pre-fix bug surface on mixed routes for regression safety.
        expect(gasDetails.gasUse).toBe(BigInt(194_000 + 172_000));
      });

      it('adds per-section TOKEN_OVERHEAD on top of MixedQuoter base for AAVE routes', async () => {
        const AAVE = new Address('0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9');
        const v3PoolWithAave = new V3Pool(
          AAVE,
          token1,
          500,
          new Address('0xa3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3'),
          BigInt(1000),
          BigInt(1000),
          BigInt(0)
        );
        const estimator = new MixedGasEstimator(
          mockProvider,
          {} as IFreshPoolDetailsWrapper,
          false,
          true
        );
        const route = new RouteBasic(Protocol.MIXED, [
          v3PoolWithAave,
          v4PoolWithFluidHook,
        ]);
        const quote = new QuoteBasic(
          route,
          BigInt(1000),
          {gasEstimate: BigInt(400_000)},
          undefined
        );

        const gasDetails = await estimator.estimateRouteGas(
          quote,
          ChainId.MAINNET,
          1000
        );

        // 400k MixedQuoter base + 150k AAVE TOKEN_OVERHEAD on the V3
        // section (V4 section's tokens are not AAVE/LDO so no extra)
        expect(gasDetails.gasUse).toBe(BigInt(400_000 + 150_000));
      });
    });
  });
});
