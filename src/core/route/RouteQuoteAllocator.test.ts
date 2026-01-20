import {describe, beforeEach, it, expect} from 'vitest';
import {IRouteQuoteAllocator, RouteQuoteAllocator} from './RouteQuoteAllocator';
import {RouteBasic} from '../../models/route/RouteBasic';
import {UniPool} from '../../models/pool/UniPool';
import {UniProtocol} from '../../models/pool/UniProtocol';
import {Address} from '../../models/address/Address';
import {V2Pool} from '../../models/pool/V2Pool';

describe('RouteQuoteAllocator', () => {
  let routeManager: IRouteQuoteAllocator<UniPool>;
  let mockRoutes: RouteBasic<UniPool>[];

  beforeEach(() => {
    routeManager = new RouteQuoteAllocator();
    // Create unique pools for each route
    mockRoutes = [
      new RouteBasic(UniProtocol.V2, [
        new V2Pool(
          new Address('0x1000000000000000000000000000000000000000'),
          new Address('0x2000000000000000000000000000000000000000'),
          new Address('0x3000000000000000000000000000000000000000'),
          0n,
          0n
        ),
      ]),
      new RouteBasic(UniProtocol.V2, [
        new V2Pool(
          new Address('0x4000000000000000000000000000000000000000'),
          new Address('0x5000000000000000000000000000000000000000'),
          new Address('0x6000000000000000000000000000000000000000'),
          0n,
          0n
        ),
      ]),
      new RouteBasic(UniProtocol.V2, [
        new V2Pool(
          new Address('0x7000000000000000000000000000000000000000'),
          new Address('0x8000000000000000000000000000000000000000'),
          new Address('0x9000000000000000000000000000000000000000'),
          0n,
          0n
        ),
      ]),
    ];
  });

  describe('getAllPercentageRoutes', () => {
    it('should generate all possible partial routes per percentage step', () => {
      const routes = mockRoutes.slice(0, 2);
      const percentageStep = 25;

      const result = routeManager.getAllPercentageRoutes(
        routes,
        percentageStep
      );

      // For each route, we should get routes with percentages: 100, 75, 50, 25
      // So for 2 input routes, we should get 8 total routes
      expect(result).toHaveLength(8);

      // Verify the percentages for each route
      const route1Variants = result.filter(r =>
        r.path[0].address.equals(routes[0].path[0].address)
      );
      const route2Variants = result.filter(r =>
        r.path[0].address.equals(routes[1].path[0].address)
      );

      expect(route1Variants).toHaveLength(4);
      expect(route2Variants).toHaveLength(4);

      // Check that each route has the expected percentages
      const expectedPercentages = [100, 75, 50, 25];
      route1Variants.forEach(route => {
        expect(expectedPercentages).toContain(route.percentage);
      });
      route2Variants.forEach(route => {
        expect(expectedPercentages).toContain(route.percentage);
      });
    });

    it('should handle a single route correctly', () => {
      const routes = [mockRoutes[0]];
      const percentageStep = 50;

      const result = routeManager.getAllPercentageRoutes(
        routes,
        percentageStep
      );

      // For percentageStep 50, we should get routes with percentages: 100, 50
      expect(result).toHaveLength(2);

      const percentages = result.map(r => r.percentage).sort((a, b) => b - a);
      expect(percentages).toEqual([100, 50]);

      // All routes should be variants of the input route
      result.forEach(route => {
        expect(route.path[0].address.equals(routes[0].path[0].address)).toBe(
          true
        );
      });
    });
  });
});
