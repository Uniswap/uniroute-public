import {afterEach, describe, expect, it} from 'vitest';
import {ADDRESS_ZERO} from '@uniswap/v3-sdk';
import {buildTestContext} from '@uniswap/lib-testhelpers';
import {RouteFinder} from './RouteFinder';
import {
  buildMetricKey,
  ChainId,
  getUniRouteTestConfig,
  LambdaType,
} from '../../lib/config';
import {CanonicalPools} from '../../lib/CanonicalPools';
import {Address} from '../../models/address/Address';
import {Pool} from '../../models/pool/Pool';
import {V2Pool} from '../../models/pool/V2Pool';
import {V3Pool} from '../../models/pool/V3Pool';
import {V4Pool} from '../../models/pool/V4Pool';

describe('RouteFinder canonical pools', () => {
  const tokenIn = new Address('0x1000000000000000000000000000000000000000');
  const tokenOut = new Address('0x2000000000000000000000000000000000000000');
  const hop = new Address('0x3000000000000000000000000000000000000000');
  const canonicalV2 = new Address('0x3333333333333333333333333333333333333333');
  const otherV3 = new Address('0x4444444444444444444444444444444444444444');
  const hooklessV4Id = `0x${'55'.repeat(32)}`;
  const hopV2 = new Address('0x6666666666666666666666666666666666666666');
  const droppedMetric = buildMetricKey('RouteFinder.NonCanonicalPool');

  const pools: Pool[] = [
    new V2Pool(tokenIn, tokenOut, canonicalV2, 1000n, 1000n),
    new V3Pool(tokenIn, tokenOut, 3000, otherV3, 1000n, 0n, 0n),
    new V4Pool(
      tokenIn,
      tokenOut,
      3000,
      60,
      ADDRESS_ZERO,
      1000n,
      hooklessV4Id,
      0n,
      0n
    ),
    // tokenIn -> hop -> tokenOut, first leg through a non-canonical pool.
    new V2Pool(tokenIn, hop, hopV2, 1000n, 1000n),
    new V2Pool(hop, tokenOut, otherV3, 1000n, 1000n),
  ];

  const routeFinder = new RouteFinder<Pool>(
    getUniRouteTestConfig(LambdaType.Sync)
  );

  afterEach(() => {
    CanonicalPools.__TEST_ONLY__injectTestData();
  });

  const carriesTokenIn = (pool: Pool) =>
    pool.token0.equals(tokenIn) || pool.token1.equals(tokenIn);

  it('routes through every pool when no token is listed', async () => {
    CanonicalPools.__TEST_ONLY__injectTestData({});
    const ctx = buildTestContext();

    const routes = await routeFinder.generateRoutes(
      ChainId.MAINNET,
      [...pools],
      tokenIn,
      tokenOut,
      false,
      ctx
    );

    const firstLegs = routes.map(route => route.path[0].address.toString());
    expect(new Set(firstLegs)).toEqual(
      new Set([
        canonicalV2.toString(),
        otherV3.toString(),
        hooklessV4Id,
        hopV2.toString(),
      ])
    );
    expect(ctx.metrics.countStore[droppedMetric]).toBeUndefined();
  });

  it('never builds a route leg through a non-canonical pool for a listed token', async () => {
    CanonicalPools.__TEST_ONLY__injectTestData({
      [ChainId.MAINNET]: {[tokenIn.address]: [canonicalV2.address]},
    });
    const ctx = buildTestContext();

    const routes = await routeFinder.generateRoutes(
      ChainId.MAINNET,
      [...pools],
      tokenIn,
      tokenOut,
      false,
      ctx
    );

    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      for (const pool of route.path) {
        if (carriesTokenIn(pool)) {
          expect(pool.address.equals(canonicalV2)).toBe(true);
        }
      }
    }
    // Three tokenIn-carrying pools dropped, canonical one survived: the
    // success count only, no failure reason.
    expect(ctx.metrics.countStore[droppedMetric]).toBe(3);
  });

  it('yields no routes when the canonical pool is missing from the candidates', async () => {
    CanonicalPools.__TEST_ONLY__injectTestData({
      [ChainId.MAINNET]: {[tokenIn.address]: [`0x${'99'.repeat(32)}`]},
    });
    const ctx = buildTestContext();

    const routes = await routeFinder.generateRoutes(
      ChainId.MAINNET,
      [...pools],
      tokenIn,
      tokenOut,
      false,
      ctx
    );

    expect(routes).toEqual([]);
    // 4 dropped (status:success). Whether the canonical pool exists at all
    // is checked once per loaded snapshot, not per candidate set.
    expect(ctx.metrics.countStore[droppedMetric]).toBe(4);
    expect(
      ctx.logger.outputs.filter(entry => entry.prefix === 'WARN:')
    ).toHaveLength(0);
  });

  // allowMixedPools=true so the fake ETH/WETH pool is pushed (the fixture
  // has a V4 pool): the push must land on a copy, whether or not the chain
  // has entries.
  it.each([
    ['a chain with no entries', ChainId.OPTIMISM],
    ['a chain with entries', ChainId.MAINNET],
  ])(
    'does not mutate the caller array on %s',
    async (_label, configuredChain) => {
      CanonicalPools.__TEST_ONLY__injectTestData({
        [configuredChain]: {[tokenIn.address]: [canonicalV2.address]},
      });
      const input = [...pools];

      const routes = await routeFinder.generateRoutes(
        ChainId.MAINNET,
        input,
        tokenIn,
        tokenOut,
        true
      );

      expect(routes.length).toBeGreaterThan(0);
      expect(input).toEqual(pools);
    }
  );
});
