import {beforeEach, describe, expect, it, vi} from 'vitest';
import {RouteFinder} from './RouteFinder';
import {UniPool} from '../../models/pool/UniPool';
import {UniProtocol} from '../../models/pool/UniProtocol';
import {Address} from '../../models/address/Address';
import {getUniRouteTestConfig} from '../../lib/config';
import {ChainId} from '../../lib/config';
import {ADDRESS_ZERO} from '@uniswap/v3-sdk';
import {V4Pool} from 'src/models/pool/V4Pool';
import {FAKE_TICK_SPACING} from 'src/lib/poolUtils';
import {Context as UniContext} from '@uniswap/lib-uni/context';

// Mock context for metrics testing
const createMockContext = (): UniContext => {
  return {
    metrics: {
      count: vi.fn().mockResolvedValue(undefined),
      gauge: vi.fn().mockResolvedValue(undefined),
      timer: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as UniContext;
};

describe('RouteFinder', () => {
  let routeFinder: RouteFinder<UniPool>;
  let pools: UniPool[];
  const serviceConfig = {
    ...getUniRouteTestConfig(),
    RouteFinder: {
      MaxHops: 2,
      MaxHopsExtended: 2, // Disabled for tests (same as MaxHops)
      MinRoutesThreshold: 0, // Disabled for tests
      MaxExtendedRoutes: 0, // Disabled for tests
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

  it('should find direct route between tokens', async () => {
    const routes = await routeFinder.generateRoutes(
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

  it('should find indirect routes through intermediate tokens', async () => {
    const routes = await routeFinder.generateRoutes(
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

  it('should respect maxHops limit', async () => {
    const routeFinder = new RouteFinder(serviceConfig);
    const routes = await routeFinder.generateRoutes(
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

  it('should not create routes with cycles', async () => {
    const routes = await routeFinder.generateRoutes(
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

  it('should find all possible routes within maxHops', async () => {
    const routes = await routeFinder.generateRoutes(
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

  it('should only return routes with same protocol when allowMixedPools is false', async () => {
    const routes = await routeFinder.generateRoutes(
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

  it('should find V2-only routes when allowMixedPools is false', async () => {
    const routes = await routeFinder.generateRoutes(
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

  it('should find mixed protocol routes when allowMixedPools is true', async () => {
    const routes = await routeFinder.generateRoutes(
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

  it('should use fake ETH/WETH pool when V4 pools are involved and mixed pools are allowed', async () => {
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
    const routes = await routeFinder.generateRoutes(
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

  it('should not use fake ETH/WETH pool when mixed pools are not allowed', async () => {
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
    const routes = await routeFinder.generateRoutes(
      ChainId.MAINNET,
      testPools,
      tokenA,
      tokenB,
      false
    );

    // We should not find any routes since the fake ETH/WETH pool is not added
    expect(routes.length).toBe(0);
  });

  describe('Extended hops (lazy deepening)', () => {
    // Test addresses for extended hops tests
    const tokenA = new Address('0x000000000000000000000000000000000000000A');
    const tokenB = new Address('0x000000000000000000000000000000000000000B');
    const tokenC = new Address('0x000000000000000000000000000000000000000C');
    const tokenD = new Address('0x000000000000000000000000000000000000000D');
    const tokenE = new Address('0x000000000000000000000000000000000000000E');

    it('should extend search when routes found < MinRoutesThreshold', async () => {
      // Config with MaxHops=2, but only a 3-hop path exists
      const extendedConfig = {
        ...getUniRouteTestConfig(),
        RouteFinder: {
          MaxHops: 2,
          MaxHopsExtended: 3,
          MinRoutesThreshold: 1, // Trigger extension if 0 routes found
          MaxExtendedRoutes: 10,
          MaxRoutes: 30,
          MaxSplits: 4,
          MaxSplitRoutes: 250,
          RouteSplitPercentage: 50,
          RouteSplitTimeoutMs: 10000,
          AllowMixedPools: false,
          CrossChainLiquidityPoolsEnabled: new Set<ChainId>(),
        },
      };

      // Create a pool network where only a 3-hop path exists between tokenA and tokenD
      const testPools: UniPool[] = [
        {token0: tokenA, token1: tokenB, protocol: UniProtocol.V2} as UniPool,
        {token0: tokenB, token1: tokenC, protocol: UniProtocol.V2} as UniPool,
        {token0: tokenC, token1: tokenD, protocol: UniProtocol.V2} as UniPool,
      ];

      const extendedRouteFinder = new RouteFinder(extendedConfig);
      const routes = await extendedRouteFinder.generateRoutes(
        ChainId.MAINNET,
        testPools,
        tokenA,
        tokenD,
        false
      );

      // Should find the 3-hop route via extended search
      expect(routes.length).toBe(1);
      expect(routes[0].path.length).toBe(3);
    });

    it('should extend search when all routes are 1-hop only (direct pair) even if route count meets MinRoutesThreshold', async () => {
      // Config: normal search limited to 1 hop, so we only get direct pairs. We have 2 direct
      // pools (A-B V2 and A-B V3), so route count (2) meets MinRoutesThreshold. Extended search
      // should still trigger because all routes are single-hop, and we should discover the 2-hop path.
      const extendedConfig = {
        ...getUniRouteTestConfig(),
        RouteFinder: {
          MaxHops: 1,
          MaxHopsExtended: 2,
          MinRoutesThreshold: 2, // We will have 2 routes, so below-threshold would NOT trigger
          MaxExtendedRoutes: 10,
          MaxRoutes: 30,
          MaxSplits: 4,
          MaxSplitRoutes: 250,
          RouteSplitPercentage: 50,
          RouteSplitTimeoutMs: 10000,
          AllowMixedPools: false,
          CrossChainLiquidityPoolsEnabled: new Set<ChainId>(),
        },
      };

      // Direct A-B (two pools so we get 2 normal routes, both 1-hop). Plus A-C and C-B for a 2-hop path.
      const testPools: UniPool[] = [
        {token0: tokenA, token1: tokenB, protocol: UniProtocol.V2} as UniPool,
        {token0: tokenA, token1: tokenB, protocol: UniProtocol.V3} as UniPool,
        {token0: tokenA, token1: tokenC, protocol: UniProtocol.V2} as UniPool,
        {token0: tokenC, token1: tokenB, protocol: UniProtocol.V2} as UniPool,
      ];

      const extendedRouteFinder = new RouteFinder(extendedConfig);
      const routes = await extendedRouteFinder.generateRoutes(
        ChainId.MAINNET,
        testPools,
        tokenA,
        tokenB,
        false
      );

      // Normal search finds 2 routes (both 1-hop: A-B V2, A-B V3). All are single-hop so extended
      // search runs and adds the 2-hop route A->C->B (path.length 2 > MaxHops 1).
      expect(routes.length).toBe(3);

      const oneHopRoutes = routes.filter(r => r.path.length === 1);
      const twoHopRoutes = routes.filter(r => r.path.length === 2);

      expect(oneHopRoutes.length).toBe(2);
      expect(twoHopRoutes.length).toBe(1);
      expect(twoHopRoutes[0].path[0].token0.address).toBe(tokenA.address);
      expect(twoHopRoutes[0].path[0].token1.address).toBe(tokenC.address);
      expect(twoHopRoutes[0].path[1].token0.address).toBe(tokenC.address);
      expect(twoHopRoutes[0].path[1].token1.address).toBe(tokenB.address);
    });

    it('should not extend search when routes found >= MinRoutesThreshold', async () => {
      // Config where we have enough routes at MaxHops
      const extendedConfig = {
        ...getUniRouteTestConfig(),
        RouteFinder: {
          MaxHops: 2,
          MaxHopsExtended: 3,
          MinRoutesThreshold: 1, // Only need 1 route
          MaxExtendedRoutes: 10,
          MaxRoutes: 30,
          MaxSplits: 4,
          MaxSplitRoutes: 250,
          RouteSplitPercentage: 50,
          RouteSplitTimeoutMs: 10000,
          AllowMixedPools: false,
          CrossChainLiquidityPoolsEnabled: new Set<ChainId>(),
        },
      };

      // Create pools with both a 2-hop and 3-hop path
      const testPools: UniPool[] = [
        // 2-hop path: A -> B -> D
        {token0: tokenA, token1: tokenB, protocol: UniProtocol.V2} as UniPool,
        {token0: tokenB, token1: tokenD, protocol: UniProtocol.V2} as UniPool,
        // 3-hop path: A -> B -> C -> D
        {token0: tokenB, token1: tokenC, protocol: UniProtocol.V2} as UniPool,
        {token0: tokenC, token1: tokenD, protocol: UniProtocol.V2} as UniPool,
      ];

      const extendedRouteFinder = new RouteFinder(extendedConfig);
      const routes = await extendedRouteFinder.generateRoutes(
        ChainId.MAINNET,
        testPools,
        tokenA,
        tokenD,
        false
      );

      // Should only find the 2-hop route (no extension needed)
      expect(routes.length).toBe(1);
      expect(routes[0].path.length).toBe(2);
    });

    it('should cap extended routes at MaxExtendedRoutes', async () => {
      const extendedConfig = {
        ...getUniRouteTestConfig(),
        RouteFinder: {
          MaxHops: 1,
          MaxHopsExtended: 2,
          MinRoutesThreshold: 1, // Trigger extension if 0 routes found
          MaxExtendedRoutes: 2, // Only allow 2 extended routes
          MaxRoutes: 30,
          MaxSplits: 4,
          MaxSplitRoutes: 250,
          RouteSplitPercentage: 50,
          RouteSplitTimeoutMs: 10000,
          AllowMixedPools: false,
          CrossChainLiquidityPoolsEnabled: new Set<ChainId>(),
        },
      };

      // Create multiple 2-hop paths (no direct path)
      const testPools: UniPool[] = [
        // Path 1: A -> B -> E
        {token0: tokenA, token1: tokenB, protocol: UniProtocol.V2} as UniPool,
        {token0: tokenB, token1: tokenE, protocol: UniProtocol.V2} as UniPool,
        // Path 2: A -> C -> E
        {token0: tokenA, token1: tokenC, protocol: UniProtocol.V2} as UniPool,
        {token0: tokenC, token1: tokenE, protocol: UniProtocol.V2} as UniPool,
        // Path 3: A -> D -> E
        {token0: tokenA, token1: tokenD, protocol: UniProtocol.V2} as UniPool,
        {token0: tokenD, token1: tokenE, protocol: UniProtocol.V2} as UniPool,
      ];

      const extendedRouteFinder = new RouteFinder(extendedConfig);
      const routes = await extendedRouteFinder.generateRoutes(
        ChainId.MAINNET,
        testPools,
        tokenA,
        tokenE,
        false
      );

      // Should be capped at MaxExtendedRoutes (2)
      expect(routes.length).toBe(2);
      routes.forEach(route => {
        expect(route.path.length).toBe(2);
      });
    });

    it('should not include duplicate routes from extended search', async () => {
      const extendedConfig = {
        ...getUniRouteTestConfig(),
        RouteFinder: {
          MaxHops: 2,
          MaxHopsExtended: 3,
          MinRoutesThreshold: 5, // High threshold to always trigger extension
          MaxExtendedRoutes: 10,
          MaxRoutes: 30,
          MaxSplits: 4,
          MaxSplitRoutes: 250,
          RouteSplitPercentage: 50,
          RouteSplitTimeoutMs: 10000,
          AllowMixedPools: false,
          CrossChainLiquidityPoolsEnabled: new Set<ChainId>(),
        },
      };

      // Create pools with both 2-hop and 3-hop paths
      const testPools: UniPool[] = [
        // 2-hop path: A -> B -> D
        {token0: tokenA, token1: tokenB, protocol: UniProtocol.V2} as UniPool,
        {token0: tokenB, token1: tokenD, protocol: UniProtocol.V2} as UniPool,
        // 3-hop path: A -> B -> C -> D
        {token0: tokenB, token1: tokenC, protocol: UniProtocol.V2} as UniPool,
        {token0: tokenC, token1: tokenD, protocol: UniProtocol.V2} as UniPool,
      ];

      const extendedRouteFinder = new RouteFinder(extendedConfig);
      const routes = await extendedRouteFinder.generateRoutes(
        ChainId.MAINNET,
        testPools,
        tokenA,
        tokenD,
        false
      );

      // Should find 2 routes total: one 2-hop and one 3-hop
      expect(routes.length).toBe(2);

      const twoHopRoutes = routes.filter(r => r.path.length === 2);
      const threeHopRoutes = routes.filter(r => r.path.length === 3);

      // Should have exactly one of each (no duplicates)
      expect(twoHopRoutes.length).toBe(1);
      expect(threeHopRoutes.length).toBe(1);
    });

    it('should not extend when MaxHopsExtended equals MaxHops', async () => {
      const noExtendConfig = {
        ...getUniRouteTestConfig(),
        RouteFinder: {
          MaxHops: 2,
          MaxHopsExtended: 2, // Same as MaxHops - no extension
          MinRoutesThreshold: 5,
          MaxExtendedRoutes: 10,
          MaxRoutes: 30,
          MaxSplits: 4,
          MaxSplitRoutes: 250,
          RouteSplitPercentage: 50,
          RouteSplitTimeoutMs: 10000,
          AllowMixedPools: false,
          CrossChainLiquidityPoolsEnabled: new Set<ChainId>(),
        },
      };

      // Only a 3-hop path exists
      const testPools: UniPool[] = [
        {token0: tokenA, token1: tokenB, protocol: UniProtocol.V2} as UniPool,
        {token0: tokenB, token1: tokenC, protocol: UniProtocol.V2} as UniPool,
        {token0: tokenC, token1: tokenD, protocol: UniProtocol.V2} as UniPool,
      ];

      const noExtendRouteFinder = new RouteFinder(noExtendConfig);
      const routes = await noExtendRouteFinder.generateRoutes(
        ChainId.MAINNET,
        testPools,
        tokenA,
        tokenD,
        false
      );

      // Should find no routes (3-hop path not reachable with MaxHops=2)
      expect(routes.length).toBe(0);
    });

    it('should emit metrics when context is provided', async () => {
      const extendedConfig = {
        ...getUniRouteTestConfig(),
        RouteFinder: {
          MaxHops: 2,
          MaxHopsExtended: 3,
          MinRoutesThreshold: 1, // Trigger extension if 0 routes found
          MaxExtendedRoutes: 10,
          MaxRoutes: 30,
          MaxSplits: 4,
          MaxSplitRoutes: 250,
          RouteSplitPercentage: 50,
          RouteSplitTimeoutMs: 10000,
          AllowMixedPools: false,
          CrossChainLiquidityPoolsEnabled: new Set<ChainId>(),
        },
      };

      // Create a pool network where only a 3-hop path exists
      const testPools: UniPool[] = [
        {token0: tokenA, token1: tokenB, protocol: UniProtocol.V2} as UniPool,
        {token0: tokenB, token1: tokenC, protocol: UniProtocol.V2} as UniPool,
        {token0: tokenC, token1: tokenD, protocol: UniProtocol.V2} as UniPool,
      ];

      const mockCtx = createMockContext();
      const extendedRouteFinder = new RouteFinder(extendedConfig);
      const routes = await extendedRouteFinder.generateRoutes(
        ChainId.MAINNET,
        testPools,
        tokenA,
        tokenD,
        false,
        mockCtx
      );

      expect(routes.length).toBe(1);

      // Verify metrics were emitted
      expect(mockCtx.metrics.count).toHaveBeenCalledWith(
        'UniRouteService.Metric.RouteFinder.NormalRoutesCount',
        0, // No routes found with normal MaxHops
        {tags: ['chainId:1']}
      );
      expect(mockCtx.metrics.count).toHaveBeenCalledWith(
        'UniRouteService.Metric.RouteFinder.ExtendedSearchTriggered',
        1, // Extended search was triggered
        {tags: ['chainId:1']}
      );
      expect(mockCtx.metrics.count).toHaveBeenCalledWith(
        'UniRouteService.Metric.RouteFinder.ExtendedRoutesCount',
        1, // 1 extended route found
        {tags: ['chainId:1']}
      );
    });

    it('should emit metrics showing no extension when routes found', async () => {
      const extendedConfig = {
        ...getUniRouteTestConfig(),
        RouteFinder: {
          MaxHops: 2,
          MaxHopsExtended: 3,
          MinRoutesThreshold: 1,
          MaxExtendedRoutes: 10,
          MaxRoutes: 30,
          MaxSplits: 4,
          MaxSplitRoutes: 250,
          RouteSplitPercentage: 50,
          RouteSplitTimeoutMs: 10000,
          AllowMixedPools: false,
          CrossChainLiquidityPoolsEnabled: new Set<ChainId>(),
        },
      };

      // Create pools with a 2-hop path (no extension needed)
      const testPools: UniPool[] = [
        {token0: tokenA, token1: tokenB, protocol: UniProtocol.V2} as UniPool,
        {token0: tokenB, token1: tokenD, protocol: UniProtocol.V2} as UniPool,
      ];

      const mockCtx = createMockContext();
      const extendedRouteFinder = new RouteFinder(extendedConfig);
      const routes = await extendedRouteFinder.generateRoutes(
        ChainId.MAINNET,
        testPools,
        tokenA,
        tokenD,
        false,
        mockCtx
      );

      expect(routes.length).toBe(1);

      // Verify metrics show no extension triggered
      expect(mockCtx.metrics.count).toHaveBeenCalledWith(
        'UniRouteService.Metric.RouteFinder.NormalRoutesCount',
        1, // 1 route found with normal MaxHops
        {tags: ['chainId:1']}
      );
      expect(mockCtx.metrics.count).toHaveBeenCalledWith(
        'UniRouteService.Metric.RouteFinder.ExtendedSearchTriggered',
        0, // Extended search NOT triggered
        {tags: ['chainId:1']}
      );
      // ExtendedRoutesCount should NOT be called since extension wasn't triggered
      expect(mockCtx.metrics.count).not.toHaveBeenCalledWith(
        'UniRouteService.Metric.RouteFinder.ExtendedRoutesCount',
        expect.any(Number),
        expect.any(Object)
      );
    });
  });
});
