import {describe, expect, it} from 'vitest';
import {ChainFeatures} from '@uniswap/lib-chain-features';
import {ChainId} from '@uniswap/lib-sharedconfig/chainConfig';
import {
  CHAIN_FEATURE_CONFIGS,
  chainFeaturesAt,
  getForkLineage,
} from '@uniswap/lib-sharedconfig/chainFeatures';
import {ChainId as UniRouteChainId} from '../../lib/config';
import {AMSTERDAM_GAS_FEATURES, gasRegimeForChain} from './gas-costs';

describe('Amsterdam gas regime', () => {
  it.each(AMSTERDAM_GAS_FEATURES)(
    'keeps Osaka constants when %s is missing',
    missing => {
      const features = AMSTERDAM_GAS_FEATURES.filter(
        feature => feature !== missing
      );
      const client = new ChainFeatures({
        forced: new Map([[ChainId.MAINNET, features]]),
      });
      expect(gasRegimeForChain(UniRouteChainId.MAINNET, client)).toBe('osaka');
    }
  );

  it('requires all four features on the requested chain', () => {
    const client = new ChainFeatures({
      forced: new Map([[ChainId.BASE, AMSTERDAM_GAS_FEATURES]]),
    });
    expect(gasRegimeForChain(UniRouteChainId.BASE, client)).toBe('amsterdam');
    expect(gasRegimeForChain(UniRouteChainId.MAINNET, client)).toBe('osaka');
  });

  for (const [chainId, config] of Object.entries(CHAIN_FEATURE_CONFIGS)) {
    const lineage = getForkLineage(config.lineage);
    if (lineage === undefined)
      throw new Error(`Missing lineage ${config.lineage}`);
    const boundaries = new Set([0]);
    for (const override of config.overrides ?? []) {
      if (override.from !== undefined) {
        boundaries.add(override.from);
        boundaries.add(Math.max(0, override.from - 1));
      }
    }
    for (const fork of lineage.forks) {
      it.each([...boundaries])(
        `chain ${chainId}, fork ${fork.name}, timestamp %i has a measured feature set`,
        timestamp => {
          const features = chainFeaturesAt(
            Number(chainId),
            fork.name,
            timestamp
          );
          const enabled = AMSTERDAM_GAS_FEATURES.filter(feature =>
            features.has(feature)
          );
          expect(
            enabled.length === 0 ||
              enabled.length === AMSTERDAM_GAS_FEATURES.length,
            `Chain ${chainId}, fork ${fork.name}, timestamp ${timestamp} enables ${enabled.join(', ')}. Amsterdam gas constants were measured as one set. A partial set must not ship without separately measured constants.`
          ).toBe(true);
        }
      );
    }
  }
});
