import {describe, expect, it} from 'vitest';
import {buildTestContext} from '@uniswap/lib-testhelpers';
import {RouteFinder} from './RouteFinder';
import {
  buildMetricKey,
  ChainId,
  getUniRouteTestConfig,
  LambdaType,
} from '../../lib/config';
import {Address} from '../../models/address/Address';
import {Pool} from '../../models/pool/Pool';
import {V3Pool} from '../../models/pool/V3Pool';

// Robinhood Chain V3 pools as deployed: HOOKR -> wHOOKR -> WETH is the route
// QuoterV2 overprices; HOOKR/WETH fee 3000 is the direct pool.
describe('RouteFinder routing block list', () => {
  const hookr = new Address('0x18e674231a58c239dc7daedcffe15ec3a24cff5c');
  const wHookr = new Address('0x0cB7b36476d577C683f7Ec03994ddC0e006a97bd');
  const weth = new Address('0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73');
  const hookrWHookrPool = new Address(
    '0xdd0ebece3c0cca47a21e552da73a8a0a1f14f613'
  );
  const wHookrWethPool = new Address(
    '0x7aa37359d6d6ed87f6762b91ba3d57bcac91dac3'
  );
  const hookrWethPool = new Address(
    '0xd8b750f564321ce68b4b3d8498616da96fad798d'
  );

  const pools: Pool[] = [
    new V3Pool(hookr, wHookr, 100, hookrWHookrPool, 1000n, 0n, 0n),
    new V3Pool(wHookr, weth, 100, wHookrWethPool, 1000n, 0n, 0n),
    new V3Pool(hookr, weth, 3000, hookrWethPool, 1000n, 0n, 0n),
  ];

  const routeFinder = new RouteFinder<Pool>(
    getUniRouteTestConfig(LambdaType.Sync)
  );

  const droppedMetric = buildMetricKey('RouteFinder.BlockedRoutingTokenPool');

  const findRoutes = async (chainId: ChainId) => {
    const ctx = buildTestContext();
    const routes = await routeFinder.generateRoutes(
      chainId,
      [...pools],
      hookr,
      weth,
      false,
      ctx
    );
    return {
      poolIds: routes.map(route =>
        route.path.map(pool => pool.address.toString().toLowerCase())
      ),
      dropped: ctx.metrics.countStore[droppedMetric],
    };
  };

  it('never routes through wHOOKR on Robinhood, keeping the direct route', async () => {
    const {poolIds, dropped} = await findRoutes(ChainId.ROBINHOOD);

    expect(poolIds).toEqual([[hookrWethPool.toString().toLowerCase()]]);
    expect(dropped).toBe(2);
  });

  it('only blocks the token on the chain it is listed for', async () => {
    const {poolIds, dropped} = await findRoutes(ChainId.MAINNET);

    expect(poolIds).toHaveLength(2);
    expect(poolIds).toContainEqual([
      hookrWHookrPool.toString().toLowerCase(),
      wHookrWethPool.toString().toLowerCase(),
    ]);
    expect(dropped).toBeUndefined();
  });

  it('yields no route when the only path crosses wHOOKR', async () => {
    const routes = await routeFinder.generateRoutes(
      ChainId.ROBINHOOD,
      pools.slice(0, 2),
      hookr,
      weth,
      false
    );

    expect(routes).toEqual([]);
  });
});
