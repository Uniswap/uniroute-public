import {RouteBasic} from '../../models/route/RouteBasic';
import {UniPool} from '../../models/pool/UniPool';
import {Address} from '../../models/address/Address';
import {IUniRouteServiceConfig} from '../../lib/config';
import {UniProtocol} from '../../models/pool/UniProtocol';
import {FAKE_TICK_SPACING, getV4EthWethFakePool} from '../../lib/poolUtils';
import {ChainId} from '../../lib/config';
import {V4Pool} from '../../models/pool/V4Pool';

export interface IRouteFinder<TPool extends UniPool> {
  generateRoutes(
    chainId: ChainId,
    pools: TPool[],
    tokenIn: Address,
    tokenOut: Address,
    allowMixedPools: boolean
  ): RouteBasic<TPool>[];
}

export class RouteFinder<TPool extends UniPool> implements IRouteFinder<TPool> {
  constructor(private readonly serviceConfig: IUniRouteServiceConfig) {}

  // TODO: https://linear.app/uniswap/issue/ROUTE-410/ (modify for V4 - Support ETH+WETH pools)
  public generateRoutes(
    chainId: ChainId,
    pools: TPool[],
    tokenIn: Address,
    tokenOut: Address,
    allowMixedPools: boolean
  ): RouteBasic<TPool>[] {
    const routes: RouteBasic<TPool>[] = [];

    // If mixed pools are allowed and we have V4 pools, add a fake pool for ETH/WETH to allow connectivity.
    if (
      allowMixedPools &&
      pools.some(pool => pool.protocol === UniProtocol.V4)
    ) {
      pools.push(getV4EthWethFakePool(chainId) as unknown as TPool);
    }

    this.findAllPaths(
      pools,
      tokenIn,
      tokenOut,
      [],
      new Set(),
      routes,
      allowMixedPools
    );

    return routes;
  }

  private findAllPaths(
    pools: TPool[],
    currentToken: Address,
    tokenOut: Address,
    currentPath: TPool[],
    visitedTokens: Set<string>,
    routes: RouteBasic<TPool>[],
    allowMixedPools: boolean
  ): void {
    // Special case for routes that contain the fake eth/weth pool, add an extra hop
    const currentRouteContainsFakeV4Pool = currentPath.some(
      pool =>
        pool.protocol === UniProtocol.V4 &&
        (pool as unknown as V4Pool).tickSpacing === FAKE_TICK_SPACING
    );
    const maxHops = currentRouteContainsFakeV4Pool
      ? this.serviceConfig.RouteFinder.MaxHops + 1
      : this.serviceConfig.RouteFinder.MaxHops;

    // Stop if we've exceeded max hops
    if (currentPath.length >= maxHops) {
      return;
    }

    // Mark current token as visited to prevent cycles
    visitedTokens.add(currentToken.lowerCased);

    // Find all pools that have currentToken as one of their tokens
    const validPools = pools.filter(pool => {
      const hasToken =
        (pool.token0.lowerCased === currentToken.lowerCased ||
          pool.token1.lowerCased === currentToken.lowerCased) &&
        !currentPath.includes(pool);

      // If not allowing mixed pools and we have a current path,
      // check if the pool's protocol matches the protocol of the first pool in the path
      if (!allowMixedPools && currentPath.length > 0) {
        return hasToken && pool.protocol === currentPath[0].protocol;
      }

      return hasToken;
    });

    for (const pool of validPools) {
      // Determine the other token in the pool
      const otherToken =
        pool.token0.lowerCased === currentToken.lowerCased
          ? pool.token1
          : pool.token0;

      // Skip if we've already visited this token
      if (visitedTokens.has(otherToken.lowerCased)) {
        continue;
      }

      // Add this pool to our current path
      currentPath.push(pool);

      // If we've found the target token, create a new route
      if (otherToken.lowerCased === tokenOut.lowerCased) {
        // Create a copy of the current path
        const pathCopy = [...currentPath];

        // Check if we have mixed protocols in the path
        const protocols = new Set(pathCopy.map(pool => pool.protocol));
        const protocol = protocols.size > 1 ? UniProtocol.MIXED : pool.protocol;

        routes.push(new RouteBasic(protocol, pathCopy));
      } else {
        // Otherwise, continue searching from this new token
        this.findAllPaths(
          pools,
          otherToken,
          tokenOut,
          currentPath,
          visitedTokens,
          routes,
          allowMixedPools
        );
      }

      // Backtrack
      currentPath.pop();
    }

    // Remove the current token from visited set when backtracking
    visitedTokens.delete(currentToken.lowerCased);
  }
}
