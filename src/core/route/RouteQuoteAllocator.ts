import {QuoteBasic} from '../../models/quote/QuoteBasic';
import {RouteBasic} from '../../models/route/RouteBasic';
import {UniPool} from '../../models/pool/UniPool';
import {QuoteSplit} from '../../models/quote/QuoteSplit';
import {Context as UniContext} from '@uniswap/lib-uni/context';

export interface IRouteQuoteAllocator<TPool extends UniPool> {
  getAllPercentageRoutes(
    routes: RouteBasic<TPool>[],
    percentageStep: number
  ): RouteBasic<TPool>[];
  stitchQuotes(
    splitQuotes: QuoteBasic[],
    routeCombinations: RouteBasic<TPool>[][],
    ctx: UniContext
  ): QuoteSplit[];
}

export class RouteQuoteAllocator<TPool extends UniPool>
  implements IRouteQuoteAllocator<TPool>
{
  /**
   * Generates all possible partial routes per percentage step.
   * @param routes Array of routes to generate partial routes from
   * @param percentageStep The percentage step to generate partial routes for
   * @returns Array of RouteBasic, where each RouteBasic contains a partial route
   */
  public getAllPercentageRoutes(
    routes: RouteBasic<TPool>[],
    percentageStep: number
  ): RouteBasic<TPool>[] {
    // Generate all possible partial routes per percentage step
    const pctRoutes: RouteBasic<TPool>[] = [];
    for (const route of routes) {
      for (let pct = 100; pct >= percentageStep; pct -= percentageStep) {
        pctRoutes.push(new RouteBasic(route.protocol, route.path, pct));
      }
    }
    return pctRoutes;
  }

  /**
   * Combines split routes and their quotes back into quote splits.
   * @param splitQuotes Array of quotes for split routes
   * @param routeCombinations Array of route combinations that were used to generate the quotes
   * @param ctx UniContext
   * @returns Array of QuoteSplit, where each QuoteSplit contains the quotes for a route combination
   */
  public stitchQuotes(
    splitQuotes: QuoteBasic[],
    routeCombinations: RouteBasic<TPool>[][],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ctx: UniContext
  ): QuoteSplit[] {
    // Group quotes by their route combination
    const quoteSplits: QuoteSplit[] = [];

    // Process each route combination
    for (const combination of routeCombinations) {
      // Find all quotes that match this combination's routes
      const matchingQuotes = this.findMatchingQuotes(splitQuotes, combination);
      if (matchingQuotes.length !== combination.length) {
        // Skip if we don't have quotes for all routes in this combination
        // TODO: log
        continue;
      }

      quoteSplits.push(new QuoteSplit(matchingQuotes));
    }

    return quoteSplits;
  }

  private findMatchingQuotes(
    quotes: QuoteBasic[],
    routes: RouteBasic<TPool>[]
  ): QuoteBasic[] {
    return routes
      .map(route => {
        // Find the quote that matches this route
        return quotes.find(quote =>
          this.routesMatch(quote.route as RouteBasic<TPool>, route)
        );
      })
      .filter((quote): quote is QuoteBasic => quote !== undefined);
  }

  private routesMatch(
    route1: RouteBasic<TPool>,
    route2: RouteBasic<TPool>
  ): boolean {
    if (route1.path.length !== route2.path.length) {
      return false;
    }

    // Check if percentages match
    if (route1.percentage !== route2.percentage) {
      return false;
    }

    // Check if all pools match in order by comparing their addresses
    return route1.path.every((pool, index) =>
      pool.address.equals(route2.path[index].address)
    );
  }
}
