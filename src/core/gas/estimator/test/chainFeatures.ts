import {ChainFeatures} from '@uniswap/lib-chain-features';
import {
  featuresAtFork,
  getForkLineage,
} from '@uniswap/lib-sharedconfig/chainFeatures';
import {ChainId} from '../../../../lib/config';
import {AMSTERDAM_GAS_FEATURES, GasRegime} from '../../gas-costs';

const lineage = getForkLineage('ethereum');
if (lineage === undefined) throw new Error('Missing Ethereum lineage');
export const osakaFeatures = [...featuresAtFork(lineage, 'osaka')];
export const amsterdamFeatures = [...osakaFeatures, ...AMSTERDAM_GAS_FEATURES];

export function forcedChainFeatures(regime: GasRegime): ChainFeatures {
  return new ChainFeatures({
    forced: new Map([
      [ChainId.MAINNET, regime === 'osaka' ? osakaFeatures : amsterdamFeatures],
    ]),
  });
}
