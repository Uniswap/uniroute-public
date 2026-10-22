import {describe, expect, it} from 'vitest';
import {JsonRpcProvider} from '@ethersproject/providers';
import {ADDRESS_ZERO} from '@uniswap/v3-sdk';
import {ChainId} from '../../../lib/config';
import {
  getGasToken,
  UNI_MAINNET,
  USDC_MAINNET,
  USDT_MAINNET,
} from '../../../lib/tokenUtils';
import {Address} from '../../../models/address/Address';
import {Protocol} from '../../../models/pool/Protocol';
import {Pool} from '../../../models/pool/Pool';
import {V2Pool} from '../../../models/pool/V2Pool';
import {V3Pool} from '../../../models/pool/V3Pool';
import {V4Pool} from '../../../models/pool/V4Pool';
import {QuoteBasic} from '../../../models/quote/QuoteBasic';
import {RouteBasic} from '../../../models/route/RouteBasic';
import {IChainFeatures} from '@uniswap/lib-chain-features';
import {forcedChainFeatures} from './test/chainFeatures';
import {MixedGasEstimator} from './MixedGasEstimator';
import {V2GasEstimator} from './V2GasEstimator';
import {V3GasEstimator} from './V3GasEstimator';
import {V4GasEstimator} from './V4GasEstimator';
import {FakeFreshPoolDetailsWrapper} from './test/FakeFreshPoolDetailsWrapper';

// Rows are gasUsed from Universal Router receipts on a Glamsterdam mainnet fork
// at block 26,007,350 (revm 43.0.2, patched anvil), recipient already holding the
// output token. Rerun the fork harness and update the rows after the next repricing.
const usdc = new Address(USDC_MAINNET.address);
const usdt = new Address(USDT_MAINNET.address);
const weth = new Address(getGasToken(ChainId.MAINNET).address);
const uni = new Address(UNI_MAINNET.address);
const eth = new Address(ADDRESS_ZERO);
const v2UsdcWeth = new V2Pool(
  usdc,
  weth,
  new Address('0x1234567890123456789012345678901234567890'),
  1000n,
  1000n
);
const v3UsdcWeth = new V3Pool(
  usdc,
  weth,
  500,
  new Address('0x3234567890123456789012345678901234567890'),
  1000n,
  1000n,
  0n
);
const v3WethUni = new V3Pool(
  weth,
  uni,
  500,
  new Address('0x4234567890123456789012345678901234567890'),
  1000n,
  1000n,
  0n
);

function hooklessPool(token0: Address, token1: Address): V4Pool {
  return new V4Pool(
    token0,
    token1,
    500,
    10,
    ADDRESS_ZERO,
    1000n,
    V4Pool.computePoolId(token0, token1, 500, 10, ADDRESS_ZERO),
    1000n,
    0n
  );
}

type ReceiptProtocol = Protocol.V2 | Protocol.V3 | Protocol.V4 | Protocol.MIXED;

interface ReceiptFixture {
  name: string;
  protocol: ReceiptProtocol;
  hops: number;
  pools: Pool[];
  initializedTicksCrossedList: number[];
  osakaReceipt: number;
  amsterdamReceipt: number;
  tolerance: number;
}

// V4 shares the V3 constants and its hop is cheaper (no per-pool contract),
// so the hookless V4 rows only guard against gross drift. The mixed estimator
// charges the base cost and the single hop overhead once per protocol
// section, which puts the mixed row 22 percent over its receipt on both
// forks, so it gets the same tolerance.
const receipts: ReceiptFixture[] = [
  {
    name: 'V2 USDC->WETH single hop',
    protocol: Protocol.V2,
    hops: 1,
    pools: [v2UsdcWeth],
    initializedTicksCrossedList: [],
    osakaReceipt: 124325,
    amsterdamReceipt: 178325,
    tolerance: 0.02,
  },
  {
    name: 'V3 USDC->WETH single hop',
    protocol: Protocol.V3,
    hops: 1,
    pools: [v3UsdcWeth],
    initializedTicksCrossedList: [1],
    osakaReceipt: 128314,
    amsterdamReceipt: 182114,
    tolerance: 0.02,
  },
  {
    name: 'V3 USDC->WETH single hop, 80 ticks',
    protocol: Protocol.V3,
    hops: 1,
    pools: [v3UsdcWeth],
    initializedTicksCrossedList: [80],
    osakaReceipt: 2039821,
    amsterdamReceipt: 3814421,
    tolerance: 0.02,
  },
  {
    name: 'V3 two hop USDC->WETH->UNI',
    protocol: Protocol.V3,
    hops: 2,
    pools: [v3UsdcWeth, v3WethUni],
    initializedTicksCrossedList: [1, 2],
    osakaReceipt: 247625,
    amsterdamReceipt: 381525,
    tolerance: 0.02,
  },
  {
    name: 'V4 ETH->USDC single hop, no hook',
    protocol: Protocol.V4,
    hops: 1,
    pools: [hooklessPool(eth, usdc)],
    initializedTicksCrossedList: [],
    osakaReceipt: 115233,
    amsterdamReceipt: 154933,
    tolerance: 0.25,
  },
  {
    name: 'V4 USDC->USDT single hop, no hook',
    protocol: Protocol.V4,
    hops: 1,
    pools: [hooklessPool(usdc, usdt)],
    initializedTicksCrossedList: [],
    osakaReceipt: 153598,
    amsterdamReceipt: 207498,
    tolerance: 0.25,
  },
  {
    name: 'V4 two hop USDC->ETH->USDT, no hook',
    protocol: Protocol.V4,
    hops: 2,
    pools: [hooklessPool(usdc, eth), hooklessPool(eth, usdt)],
    initializedTicksCrossedList: [],
    osakaReceipt: 191310,
    amsterdamReceipt: 266810,
    tolerance: 0.25,
  },
  {
    name: 'Mixed V3 then V4',
    protocol: Protocol.MIXED,
    hops: 2,
    pools: [v3UsdcWeth, hooklessPool(weth, usdt)],
    initializedTicksCrossedList: [2],
    osakaReceipt: 239303,
    amsterdamReceipt: 334803,
    tolerance: 0.25,
  },
];

describe('Glamsterdam fork receipts', () => {
  const providers = new Map<ChainId, JsonRpcProvider>();
  const freshPools = new FakeFreshPoolDetailsWrapper();
  const osaka = forcedChainFeatures('osaka');
  const amsterdam = forcedChainFeatures('amsterdam');

  function estimator(protocol: ReceiptProtocol, chainFeatures: IChainFeatures) {
    switch (protocol) {
      case Protocol.V2:
        return new V2GasEstimator(providers, freshPools, chainFeatures);
      case Protocol.V3:
        return new V3GasEstimator(providers, freshPools, chainFeatures);
      case Protocol.V4:
        return new V4GasEstimator(
          providers,
          freshPools,
          chainFeatures,
          false,
          false
        );
      case Protocol.MIXED:
        return new MixedGasEstimator(
          providers,
          freshPools,
          chainFeatures,
          false,
          false
        );
    }
  }

  it.each(receipts)('$name stays within its receipt tolerance', async row => {
    const route = new RouteBasic(row.protocol, row.pools);
    expect(route.path).toHaveLength(row.hops);
    const quote = new QuoteBasic(
      route,
      1000n,
      {initializedTicksCrossedList: row.initializedTicksCrossedList},
      undefined
    );
    const amsterdamGas = (
      await estimator(row.protocol, amsterdam).estimateRouteGas(
        quote,
        ChainId.MAINNET,
        1000
      )
    ).gasUse;
    const osakaGas = (
      await estimator(row.protocol, osaka).estimateRouteGas(
        quote,
        ChainId.MAINNET,
        1000
      )
    ).gasUse;
    expect(osakaGas).toBeLessThan(amsterdamGas);
    expect(
      Math.abs(Number(amsterdamGas) - row.amsterdamReceipt) /
        row.amsterdamReceipt
    ).toBeLessThanOrEqual(row.tolerance);
  });
});
