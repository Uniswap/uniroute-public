import {beforeEach, describe, expect, it} from 'vitest';
import {RouteFinder} from './RouteFinder';
import {UniPool} from '../../models/pool/UniPool';
import {UniProtocol} from '../../models/pool/UniProtocol';
import {Address} from '../../models/address/Address';
import {getUniRouteTestConfig} from '../../lib/config';
import {ChainId} from '../../lib/config';
import {ADDRESS_ZERO} from '@uniswap/v3-sdk';
import {V4Pool} from 'src/models/pool/V4Pool';
import {FAKE_TICK_SPACING} from 'src/lib/poolUtils';

describe('RouteFinder', () => {
  let routeFinder: RouteFinder<UniPool>;
  let pools: UniPool[];
  const serviceConfig = {
    ...getUniRouteTestConfig(),
    RouteFinder: {
      MaxHops: 2,
      MaxRoutes: 30,
      MaxRoutesQuoteLong: 100,
      MaxSplitRoutes: 250,
      RouteSplitPercentage: 50,
      MaxSplits: 4,
      RouteSplitTimeoutMs: 10000,
      RouteSplitTimeoutMsQuoteLong: 16000,
      AllowMixedPools: false,
      CrossChainLiquidityPoolsEnabled: new Set<ChainId>([ChainId.BASE]),
    },
  };

  // Test addresses
  const token0 = new Address('0x0000000000000000000000000000000000000001');
  const token1 = new Address('0x0000000000000000000000000000000000000002');
  const token2 = new Address('0x0000000000000000000000000000000000000003');
  const token3 = new Address('0x0000000000000000000000000000000000000004');
  const token4 = new Address('0x0000000000000000000000000000000000000005');

  beforeEach(() => {
    // Create a network of pools
    pools = [
      // Direct path: token0 -> token1 (V2)
      {
        token0: token0,
        token1: token1,
        protocol: UniProtocol.V2,
      } as UniPool,
      // Mixed protocol path: token0 -> token2 (V2) -> token1 (V3)
      {
        token0: token0,
        token1: token2,
        protocol: UniProtocol.V2,
      } as UniPool,
      {
        token0: token2,
        token1: token1,
        protocol: UniProtocol.V3,
      } as UniPool,
      // Alternative path through token3
      {
        token0: token0,
        token1: token3,
        protocol: UniProtocol.V2,
      } as UniPool,
      {
        token0: token3,
        token1: token1,
        protocol: UniProtocol.V2,
      } as UniPool,
      // Longer path: token0 -> token2 -> token3 -> token4 -> token1
      {
        token0: token2,
        token1: token3,
        protocol: UniProtocol.V3,
      } as UniPool,
      {
        token0: token3,
        token1: token4,
        protocol: UniProtocol.V2,
      } as UniPool,
      {
        token0: token4,
        token1: token1,
        protocol: UniProtocol.V3,
      } as UniPool,
      // Dead-end pools (to test handling of invalid paths)
      {
        token0: token3,
        token1: token4,
        protocol: UniProtocol.V4,
      } as UniPool,
      {
        token0: token4,
        token1: token2,
        protocol: UniProtocol.V4,
      } as UniPool,
    ];

    routeFinder = new RouteFinder(serviceConfig);
  });

  it('should find direct route between tokens', () => {
    const routes = routeFinder.generateRoutes(
      ChainId.MAINNET,
      pools,
      token0,
      token1,
      true
    );

    expect(routes.length).toBeGreaterThan(0);
    expect(routes).toContainEqual(
      expect.objectContaining({
        path: [
          expect.objectContaining({
            token0: {address: token0.address},
            token1: {address: token1.address},
          }),
        ],
      })
    );
  });

  it('should find indirect routes through intermediate tokens', () => {
    const routes = routeFinder.generateRoutes(
      ChainId.MAINNET,
      pools,
      token0,
      token1,
      true
    );

    // Should find path through token2
    expect(routes).toContainEqual(
      expect.objectContaining({
        path: [
          expect.objectContaining({
            token0: {address: token0.address},
            token1: {address: token2.address},
          }),
          expect.objectContaining({
            token0: {address: token2.address},
            token1: {address: token1.address},
          }),
        ],
      })
    );
  });

  it('should respect maxHops limit', () => {
    const routeFinder = new RouteFinder(serviceConfig);
    const routes = routeFinder.generateRoutes(
      ChainId.MAINNET,
      pools,
      token0,
      token1,
      true
    );

    // All routes should have 2 or fewer hops
    routes.forEach(route => {
      expect(route.path.length).toBeLessThanOrEqual(
        serviceConfig.RouteFinder.MaxHops
      );
    });

    // Should not find the 3-hop path
    const longRoutes = routes.filter(route => route.path.length > 2);
    expect(longRoutes.length).toBe(0);
  });

  it('should not create routes with cycles', () => {
    const routes = routeFinder.generateRoutes(
      ChainId.MAINNET,
      pools,
      token0,
      token1,
      true
    );

    // Check that no route contains the same token twice
    routes.forEach(route => {
      const tokens = new Set<string>();
      route.path.forEach(pool => {
        tokens.add(pool.token0.address);
        tokens.add(pool.token1.address);
      });
      // Number of unique tokens should be number of pools + 1
      expect(tokens.size).toBe(route.path.length + 1);
    });
  });

  it('should find all possible routes within maxHops', () => {
    const routes = routeFinder.generateRoutes(
      ChainId.MAINNET,
      pools,
      token0,
      token1,
      true
    );

    // We should find at least:
    // 1. Direct route (1 hop)
    // 2. Route through token2 (2 hops)
    // 3. Route through token3 (2 hops)
    expect(routes.length).toBeGreaterThanOrEqual(3);

    // Verify we have routes of different lengths
    const routeLengths = new Set(routes.map(route => route.path.length));
    expect(routeLengths.size).toBeGreaterThan(1);
  });

  it('should only return routes with same protocol when allowMixedPools is false', () => {
    const routes = routeFinder.generateRoutes(
      ChainId.MAINNET,
      pools,
      token0,
      token1,
      false
    );

    // Check that each route only contains pools of the same protocol
    routes.forEach(route => {
      const protocols = new Set(route.path.map(pool => pool.protocol));
      expect(protocols.size).toBe(1);
    });
  });

  it('should find V2-only routes when allowMixedPools is false', () => {
    const routes = routeFinder.generateRoutes(
      ChainId.MAINNET,
      pools,
      token0,
      token1,
      false
    );

    // Find routes that only use V2 protocol
    const v2Routes = routes.filter(route =>
      route.path.every(pool => pool.protocol === UniProtocol.V2)
    );

    // We should have at least one V2-only route (token0 -> token3 -> token1)
    expect(v2Routes.length).toBeGreaterThan(0);

    // Verify the V2-only route
    const expectedV2Route = v2Routes.find(
      route =>
        route.path.length === 2 &&
        route.path[0].token1.address === token3.address &&
        route.path[1].token1.address === token1.address
    );
    expect(expectedV2Route).toBeDefined();
  });

  it('should find mixed protocol routes when allowMixedPools is true', () => {
    const routes = routeFinder.generateRoutes(
      ChainId.MAINNET,
      pools,
      token0,
      token1,
      true
    );

    // Find routes that mix V2 and V3 protocols
    const mixedRoutes = routes.filter(route => {
      const protocols = new Set(route.path.map(pool => pool.protocol));
      return protocols.size > 1;
    });

    // We should have at least one mixed protocol route
    expect(mixedRoutes.length).toBeGreaterThan(0);

    // Verify we can find a specific mixed protocol route
    // This could be token0 -> token2 (V3) -> token3 (V3) -> token4 (V2) -> token1 (V3)
    const hasMixedProtocolRoute = mixedRoutes.some(
      route =>
        route.path.some(pool => pool.protocol === UniProtocol.V2) &&
        route.path.some(pool => pool.protocol === UniProtocol.V3) &&
        route.protocol === UniProtocol.MIXED
    );
    expect(hasMixedProtocolRoute).toBe(true);
  });

  it('should use fake ETH/WETH pool when V4 pools are involved and mixed pools are allowed', () => {
    // Create ETH and WETH addresses
    const ethAddress = new Address(ADDRESS_ZERO);
    const wethAddress = new Address(
      '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
    );

    // Create tokenA and tokenB that will need to be connected via ETH/WETH
    const tokenA = new Address('0x0000000000000000000000000000000000000006');
    const tokenB = new Address('0x0000000000000000000000000000000000000007');

    // Create pools that connect tokenA to ETH and WETH to tokenB
    const testPools = [
      // TokenA to ETH pool (V4)
      {
        token0: tokenA,
        token1: ethAddress,
        protocol: UniProtocol.V4,
      } as UniPool,
      // WETH to TokenB pool (V4)
      {
        token0: wethAddress,
        token1: tokenB,
        protocol: UniProtocol.V4,
      } as UniPool,
    ];

    // Generate routes with mixed pools allowed
    const routes = routeFinder.generateRoutes(
      ChainId.MAINNET,
      testPools,
      tokenA,
      tokenB,
      true
    );

    // We should find at least one route
    expect(routes.length).toBeGreaterThan(0);

    // Find routes that use the fake ETH/WETH pool
    const routesWithFakePool = routes.filter(route =>
      route.path.some(
        pool =>
          pool.protocol === UniProtocol.V4 &&
          (pool as unknown as V4Pool).tickSpacing === FAKE_TICK_SPACING &&
          ((pool.token0.address === ethAddress.address &&
            pool.token1.address === wethAddress.address) ||
            (pool.token0.address === wethAddress.address &&
              pool.token1.address === ethAddress.address))
      )
    );

    // Verify that we found at least one route using the fake ETH/WETH pool
    expect(routesWithFakePool.length).toBeGreaterThan(0);

    // Verify the complete path: tokenA -> ETH -> WETH -> tokenB
    const completeRoute = routesWithFakePool.find(
      route =>
        route.path.length === 3 &&
        route.path[0].token0.address === tokenA.address &&
        route.path[2].token1.address === tokenB.address
    );

    expect(completeRoute).toBeDefined();

    // Verify that the route is marked as V4 protocol
    expect(completeRoute?.protocol).toBe(UniProtocol.V4);
  });

  it('should not use fake ETH/WETH pool when mixed pools are not allowed', () => {
    // Create ETH and WETH addresses
    const ethAddress = new Address(ADDRESS_ZERO);
    const wethAddress = new Address(
      '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
    );

    // Create tokenA and tokenB that would need to be connected via ETH/WETH
    const tokenA = new Address('0x0000000000000000000000000000000000000006');
    const tokenB = new Address('0x0000000000000000000000000000000000000007');

    // Create pools that connect tokenA to ETH and WETH to tokenB
    const testPools = [
      // TokenA to ETH pool (V4)
      {
        token0: tokenA,
        token1: ethAddress,
        protocol: UniProtocol.V4,
      } as UniPool,
      // WETH to TokenB pool (V4)
      {
        token0: wethAddress,
        token1: tokenB,
        protocol: UniProtocol.V4,
      } as UniPool,
    ];

    // Generate routes with mixed pools NOT allowed
    const routes = routeFinder.generateRoutes(
      ChainId.MAINNET,
      testPools,
      tokenA,
      tokenB,
      false
    );

    // We should not find any routes since the fake ETH/WETH pool is not added
    expect(routes.length).toBe(0);
  });
});
