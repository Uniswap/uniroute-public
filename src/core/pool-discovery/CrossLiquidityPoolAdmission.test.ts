import {describe, expect, it} from 'vitest';
import {MetricOptions} from '@uniswap/lib-uni';
import {buildTestContext} from '@uniswap/lib-testhelpers';
import {TestMetric} from '@uniswap/lib-testhelpers/testMetrics';
import {Erc4626WrapperAsset} from '@uniswap/lib-sharedconfig/erc4626WrapperHooks';

import {Erc4626RegistrySnapshot} from '../registry/Erc4626WrapperRegistry';
import {UniPoolInfo, V2PoolInfo, V3PoolInfo, V4PoolInfo} from './interface';
import {buildMetricKey, ChainId} from '../../lib/config';
import {
  AGG_HOOKS_PER_CHAIN,
  getProtocolForAggHookAddress,
} from '../../lib/poolCaching/util/hooksAddressesAllowlist';
import {matchesHooksOptions} from '../../lib/poolUtils';
import {Address} from '../../models/address/Address';
import {Chain} from '../../models/chain/Chain';
import {NativeCurrency} from '../../models/chain/NativeCurrency';
import {maybeDropErc4626Pools} from '../../models/hooks/Erc4626WrapperHooks';
import {HooksOptions} from '../../models/hooks/HooksOptions';
import {
  createNamespaceContext,
  EMPTY_NAMESPACE_CONTEXT,
  PermissionedHooksNamespace,
  RouteNamespaceContext,
} from '../../models/hooks/namespaces';
import {maybeDropPermissionedPools} from '../../models/hooks/PermissionedHooks';
import {Protocol} from '../../models/pool/Protocol';
import {V4Pool} from '../../models/pool/V4Pool';
import {CrossLiquidityPoolAdmission} from './CrossLiquidityPoolAdmission';

const ERC4626_METRIC = buildMetricKey(
  'CrossLiquidity.Erc4626WrapperHooks.poolDropped'
);
const PERMISSIONED_METRIC = buildMetricKey(
  'CrossLiquidity.PermissionedPoolDropped'
);

const ADDRESS_ZERO = '0x0000000000000000000000000000000000000000';
// The mainnet permissioned hook and an adapter token it owns, per the shared
// registry, so the namespace-active admission path can actually admit.
const PERMISSIONED_HOOK = '0x499a724ab630549f14c995ec41a8e04fa3fd28c0';
const USCC = '0x14d60e7fdc0d71d8611742720e4c50e7a974020c';
const USDC = '0x3333333333333333333333333333333333333333';
const USDT = '0x4444444444444444444444444444444444444444';
const OTHER_HOOK = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const FLUID_HOOK =
  AGG_HOOKS_PER_CHAIN[Protocol.FLUIDDEXT1]?.[ChainId.MAINNET]?.[0];

// ERC-4626 wrapper registry entry: xStock X wrapped as WX behind HOOK.
const X = '0x0000000000000000000000000000000000000001';
const WX = '0x0000000000000000000000000000000000000002';
const WRAPPER_HOOK = '0x0000000000000000000000000000000000000004';
const WRAPPER_POOL_ID = V4Pool.computePoolId(
  new Address(X),
  new Address(WX),
  0,
  0,
  WRAPPER_HOOK
);
const WRAPPER_ASSET: Erc4626WrapperAsset = {
  xStock: X,
  wxStock: WX,
  hookAddress: WRAPPER_HOOK,
  poolId: WRAPPER_POOL_ID,
  feeTier: '0',
  tickSpacing: '0',
};

function erc4626Snapshot(
  hookCodeOverrides: Record<string, string> = {[WRAPPER_HOOK]: '0x6000'}
): Erc4626RegistrySnapshot {
  return {
    assets: [WRAPPER_ASSET],
    excludedAssetCount: 0,
    hookCodeOverrides,
    getByXStock: token =>
      token.toLowerCase() === X ? WRAPPER_ASSET : undefined,
    getByWxStock: token =>
      token.toLowerCase() === WX ? WRAPPER_ASSET : undefined,
    getByHook: hook =>
      hook.toLowerCase() === WRAPPER_HOOK ? WRAPPER_ASSET : undefined,
    isWrapperHook: hook => hook.toLowerCase() === WRAPPER_HOOK,
    wasEverKnownIdentity: value =>
      [X, WX, WRAPPER_HOOK, WRAPPER_POOL_ID].includes(value.toLowerCase()),
  };
}

function mainnetChain(permissioned: boolean): Chain {
  return Chain.create({
    chainId: ChainId.MAINNET,
    chainName: 'Ethereum',
    nativeCurrency: NativeCurrency.ETH,
    wrappedNativeToken: new Address(
      '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
    ),
    v3FactoryAddress: new Address('0x1F98431c8aD98523631AE4a59f267346ea31F984'),
    v3QuoterAddress: new Address('0x61fFE014bA17989E743c5F6cB21bF9697530B21e'),
    multicallAddress: new Address('0x5BA1e12693Dc8F9c48aAD8770482f4739bEeD696'),
    multicallGasLimitPerCall: 20_000_000,
    multicallBatchSize: 75,
    permissionedHookAddresses: permissioned
      ? [new Address(PERMISSIONED_HOOK)]
      : undefined,
  });
}

function v4Pool(id: string, hooks: string, token0: string, token1: string) {
  const pool: V4PoolInfo = {
    id,
    feeTier: '0',
    tickSpacing: '0',
    hooks,
    liquidity: '1',
    token0: {id: token0},
    token1: {id: token1},
    tvlETH: 0,
    tvlUSD: 0,
  };
  return pool;
}

function v2Pool(id: string, token0: string, token1: string) {
  const pool: V2PoolInfo = {
    id,
    token0: {id: token0},
    token1: {id: token1},
    reserveUSD: 1,
    supply: 1,
    reserve: 1,
  };
  return pool;
}

function v3Pool(id: string, token0: string, token1: string) {
  const pool: V3PoolInfo = {
    id,
    token0: {id: token0},
    token1: {id: token1},
    liquidity: '1',
    feeTier: '3000',
    tvlETH: 0,
    tvlUSD: 0,
  };
  return pool;
}

// Every rule gets pools on both sides of it.
const V4_POOLS: V4PoolInfo[] = [
  v4Pool('0xa1', ADDRESS_ZERO, USDC, USDT),
  v4Pool('0xa2', OTHER_HOOK, USDC, USDT),
  v4Pool('0xa3', FLUID_HOOK ?? OTHER_HOOK, USDC, USDT),
  v4Pool('0xa4', PERMISSIONED_HOOK, USCC, USDC),
  v4Pool('0xa5', PERMISSIONED_HOOK, USDC, USDT),
  v4Pool(WRAPPER_POOL_ID, WRAPPER_HOOK, X, WX),
  v4Pool('0xa7', WRAPPER_HOOK, X, USDC),
  v4Pool('0xa8', ADDRESS_ZERO, X, USDC),
];
const V2_POOLS: V2PoolInfo[] = [
  v2Pool('0xb1', USDC, USDT),
  v2Pool('0xb2', X, USDC),
  v2Pool('0xb3', WX, USDT),
];
// Hookless V3 pools holding an xStock are rejected like V2 ones.
const V3_POOLS: V3PoolInfo[] = [
  v3Pool('0xc1', USDC, USDT),
  v3Pool('0xc2', USDC, X),
  v3Pool('0xc3', WX, USDC),
];

/** TestMetric, but keeping each count's value keyed by name and tags. */
class FakeRecordingMetrics extends TestMetric {
  public readonly counts = new Map<string, number>();

  override async count(
    metric_name: string,
    val: number,
    opts?: MetricOptions
  ): Promise<void> {
    const key = `${metric_name}|${[...(opts?.tags ?? [])].sort().join(',')}`;
    this.counts.set(key, (this.counts.get(key) ?? 0) + val);
    await super.count(metric_name, val, opts);
  }
}

function recordingContext() {
  const ctx = buildTestContext();
  const metrics = new FakeRecordingMetrics();
  ctx.metrics = metrics;
  return {ctx, metrics};
}

interface Scenario {
  name: string;
  permissionedChain: boolean;
  nsCtx: RouteNamespaceContext;
  protocols: Protocol[];
  hooksOptions: HooksOptions | undefined;
  tokenIn: string;
  tokenOut: string;
}

/** The snapshot filters cross-liquidity ran before this change, verbatim. */
async function oldPipeline(
  scenario: Scenario,
  chain: Chain,
  ctx: ReturnType<typeof buildTestContext>
): Promise<{v2: UniPoolInfo[]; v3: UniPoolInfo[]; v4: UniPoolInfo[]}> {
  const tokenIn = new Address(scenario.tokenIn);
  const tokenOut = new Address(scenario.tokenOut);
  let v2: UniPoolInfo[] = V2_POOLS;
  let v3: UniPoolInfo[] = V3_POOLS;
  let v4: UniPoolInfo[] = V4_POOLS;
  if (scenario.nsCtx.erc4626Snapshot) {
    const snapshot = scenario.nsCtx.erc4626Snapshot;
    v2 = (
      await maybeDropErc4626Pools(
        v2,
        snapshot,
        tokenIn,
        tokenOut,
        ctx,
        ERC4626_METRIC
      )
    ).filteredPools;
    v3 = (
      await maybeDropErc4626Pools(
        v3,
        snapshot,
        tokenIn,
        tokenOut,
        ctx,
        ERC4626_METRIC
      )
    ).filteredPools;
    v4 = (
      await maybeDropErc4626Pools(
        v4,
        snapshot,
        tokenIn,
        tokenOut,
        ctx,
        ERC4626_METRIC
      )
    ).filteredPools;
  }
  const protocolFiltered = V4_POOLS.filter(pool => v4.includes(pool)).filter(
    pool => {
      const hookProtocol = getProtocolForAggHookAddress(
        pool.hooks,
        chain.chainId
      );
      return (
        (hookProtocol === undefined ||
          scenario.protocols.includes(hookProtocol)) &&
        matchesHooksOptions(pool, Protocol.V4, scenario.hooksOptions)
      );
    }
  );
  const {filteredPools} = await maybeDropPermissionedPools(
    protocolFiltered,
    chain,
    scenario.nsCtx,
    tokenIn,
    tokenOut,
    ctx,
    PERMISSIONED_METRIC
  );
  return {v2, v3, v4: filteredPools};
}

const permissionedActive = createNamespaceContext([
  new PermissionedHooksNamespace(),
]);
const allRulesActive = createNamespaceContext(
  [new PermissionedHooksNamespace()],
  erc4626Snapshot()
);

const SCENARIOS: Scenario[] = [
  {
    name: 'no namespaces, no permissioned hooks',
    permissionedChain: false,
    nsCtx: EMPTY_NAMESPACE_CONTEXT,
    protocols: [Protocol.V2, Protocol.V3, Protocol.V4],
    hooksOptions: undefined,
    tokenIn: USDC,
    tokenOut: USDT,
  },
  {
    name: 'agg protocol requested, NO_HOOKS',
    permissionedChain: false,
    nsCtx: EMPTY_NAMESPACE_CONTEXT,
    protocols: [Protocol.V4, Protocol.FLUIDDEXT1],
    hooksOptions: HooksOptions.NO_HOOKS,
    tokenIn: USDC,
    tokenOut: USDT,
  },
  {
    name: 'HOOKS_ONLY, permissioned namespace inactive',
    permissionedChain: true,
    nsCtx: EMPTY_NAMESPACE_CONTEXT,
    protocols: [Protocol.V2, Protocol.V4],
    hooksOptions: HooksOptions.HOOKS_ONLY,
    tokenIn: USCC,
    tokenOut: USDC,
  },
  {
    name: 'permissioned namespace active',
    permissionedChain: true,
    nsCtx: permissionedActive,
    protocols: [Protocol.V2, Protocol.V4],
    hooksOptions: HooksOptions.HOOKS_INCLUSIVE,
    tokenIn: USCC,
    tokenOut: USDC,
  },
  {
    name: 'every rule active, xStock endpoint',
    permissionedChain: true,
    nsCtx: allRulesActive,
    protocols: [Protocol.V2, Protocol.V4, Protocol.FLUIDDEXT1],
    hooksOptions: undefined,
    tokenIn: X,
    tokenOut: USDC,
  },
  {
    name: 'ERC-4626 hook without bytecode',
    permissionedChain: false,
    nsCtx: createNamespaceContext([], erc4626Snapshot({})),
    protocols: [Protocol.V2, Protocol.V4],
    hooksOptions: undefined,
    tokenIn: X,
    tokenOut: USDC,
  },
];

describe('CrossLiquidityPoolAdmission', () => {
  it('uses a real aggregator hook address in its fixtures', () => {
    expect(FLUID_HOOK).toBeDefined();
  });

  it.each(SCENARIOS)(
    'admits exactly what the snapshot filters kept, and counts the same drops: $name',
    async scenario => {
      const chain = mainnetChain(scenario.permissionedChain);
      const old = recordingContext();
      const expected = await oldPipeline(scenario, chain, old.ctx);

      const current = recordingContext();
      const admission = new CrossLiquidityPoolAdmission({
        chain,
        protocols: scenario.protocols,
        hooksOptions: scenario.hooksOptions,
        nsCtx: scenario.nsCtx,
        tokenIn: new Address(scenario.tokenIn),
        tokenOut: new Address(scenario.tokenOut),
      });
      const admittedV2 = V2_POOLS.filter(pool =>
        admission.admits(pool, Protocol.V2)
      );
      const admittedV3 = V3_POOLS.filter(pool =>
        admission.admits(pool, Protocol.V3)
      );
      const admittedV4 = V4_POOLS.filter(pool =>
        admission.admits(pool, Protocol.V4)
      );
      await admission.emitDropMetrics(current.ctx);

      expect(admittedV2).toStrictEqual(expected.v2);
      expect(admittedV3).toStrictEqual(expected.v3);
      expect(admittedV4).toStrictEqual(expected.v4);
      // Every pool was evaluated here, so the per-candidate counters must
      // match the whole-snapshot ones exactly.
      expect(current.metrics.counts).toStrictEqual(old.metrics.counts);
    }
  );

  it('fires every drop counter somewhere across the scenarios', async () => {
    // Guards the fixtures: if no scenario ever tripped a rule, the parity
    // cases above would pass vacuously.
    const firedCounters = new Set<string>();
    for (const scenario of SCENARIOS) {
      const admission = new CrossLiquidityPoolAdmission({
        chain: mainnetChain(scenario.permissionedChain),
        protocols: scenario.protocols,
        hooksOptions: scenario.hooksOptions,
        nsCtx: scenario.nsCtx,
        tokenIn: new Address(scenario.tokenIn),
        tokenOut: new Address(scenario.tokenOut),
      });
      for (const pool of V2_POOLS) admission.admits(pool, Protocol.V2);
      for (const pool of V3_POOLS) admission.admits(pool, Protocol.V3);
      for (const pool of V4_POOLS) admission.admits(pool, Protocol.V4);
      const {ctx, metrics} = recordingContext();
      await admission.emitDropMetrics(ctx);
      for (const key of metrics.counts.keys()) {
        firedCounters.add(key);
      }
    }

    expect([...firedCounters].sort()).toStrictEqual(
      [
        `${ERC4626_METRIC}|reason:bytecode_unready,status:failure`,
        `${ERC4626_METRIC}|status:success`,
        `${PERMISSIONED_METRIC}|chain:1`,
      ].sort()
    );
  });

  it('judges a V4 pool without a hooks field as hookless, not as exempt', () => {
    const admission = new CrossLiquidityPoolAdmission({
      chain: mainnetChain(false),
      protocols: [Protocol.V4],
      hooksOptions: HooksOptions.HOOKS_ONLY,
      nsCtx: EMPTY_NAMESPACE_CONTEXT,
      tokenIn: new Address(USDC),
      tokenOut: new Address(USDT),
    });
    const {hooks: _hooks, ...withoutHooks} = v4Pool(
      '0xd1',
      OTHER_HOOK,
      USDC,
      USDT
    );

    // HOOKS_ONLY rejects a hookless pool, so a missing field must not pass.
    expect(admission.admits(withoutHooks, Protocol.V4)).toBe(false);
    expect(admission.admits(V4_POOLS[1], Protocol.V4)).toBe(true);
  });

  it('never re-sends a drop when emitting twice', async () => {
    const {ctx, metrics} = recordingContext();
    const admission = new CrossLiquidityPoolAdmission({
      chain: mainnetChain(true),
      protocols: [Protocol.V4],
      hooksOptions: undefined,
      nsCtx: EMPTY_NAMESPACE_CONTEXT,
      tokenIn: new Address(USCC),
      tokenOut: new Address(USDC),
    });

    admission.admits(V4_POOLS[3], Protocol.V4);
    await admission.emitDropMetrics(ctx);
    await admission.emitDropMetrics(ctx);

    expect(metrics.counts.get(`${PERMISSIONED_METRIC}|chain:1`)).toBe(1);
  });

  it('counts only the pools it evaluated', async () => {
    const {ctx, metrics} = recordingContext();
    const admission = new CrossLiquidityPoolAdmission({
      chain: mainnetChain(true),
      protocols: [Protocol.V4],
      hooksOptions: undefined,
      nsCtx: EMPTY_NAMESPACE_CONTEXT,
      tokenIn: new Address(USCC),
      tokenOut: new Address(USDC),
    });

    expect(admission.admits(V4_POOLS[3], Protocol.V4)).toBe(false);
    await admission.emitDropMetrics(ctx);

    expect(metrics.counts.get(`${PERMISSIONED_METRIC}|chain:1`)).toBe(1);
  });

  it('emits nothing when no pool was dropped', async () => {
    const {ctx, metrics} = recordingContext();
    const admission = new CrossLiquidityPoolAdmission({
      chain: mainnetChain(false),
      protocols: [Protocol.V4],
      hooksOptions: undefined,
      nsCtx: EMPTY_NAMESPACE_CONTEXT,
      tokenIn: new Address(USDC),
      tokenOut: new Address(USDT),
    });

    expect(admission.admits(V4_POOLS[0], Protocol.V4)).toBe(true);
    await admission.emitDropMetrics(ctx);

    expect(metrics.counts.size).toBe(0);
  });
});
