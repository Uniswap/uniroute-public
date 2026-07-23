import {describe, it, expect, vi} from 'vitest';
import {ethers} from 'ethers';
import type {JsonRpcProvider} from '@ethersproject/providers';

import {
  FactoryHookEnumerator,
  FactoryContractFactory,
} from './factoryHookEnumerator';
import type {TrustedZlcaHookFactory} from './trustedZlcaHookFactories';
import type {Logger} from '../sor-providers/util/log';

const mockLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
};

const FACTORY_A = '0x00000000000000000000000000000000000000f1';
const FACTORY_B = '0x00000000000000000000000000000000000000f2';

const factoryEntry = (
  factoryAddress: string,
  gasOverheadPerHop: bigint
): TrustedZlcaHookFactory => ({
  factoryAddress,
  name: `factory-${factoryAddress.slice(-2)}`,
  gasOverheadPerHop,
});

// Closure-based fake for the AllowlistedFactory contract: deployments is the
// live backing array so tests can append to simulate new on-chain deploys.
function fakeFactoryContracts(
  deploymentsByFactory: Record<string, string[]>,
  options: {failLength?: Set<string>} = {}
): {
  contractFactory: FactoryContractFactory;
  lengthCalls: string[];
  indexCalls: Array<{factory: string; index: number}>;
} {
  const lengthCalls: string[] = [];
  const indexCalls: Array<{factory: string; index: number}> = [];
  const contractFactory: FactoryContractFactory = (
    factoryAddress,
    _provider
  ) => {
    const deployments = deploymentsByFactory[factoryAddress] ?? [];
    return {
      callStatic: {
        allDeploymentsLength: async () => {
          lengthCalls.push(factoryAddress);
          if (options.failLength?.has(factoryAddress)) {
            throw new Error('rpc failure');
          }
          return ethers.BigNumber.from(deployments.length);
        },
        allDeployments: async (index: number) => {
          indexCalls.push({factory: factoryAddress, index});
          return deployments[index]!;
        },
      },
    } as unknown as ethers.Contract;
  };
  return {contractFactory, lengthCalls, indexCalls};
}

const provider = {} as JsonRpcProvider;

describe('FactoryHookEnumerator', () => {
  it('reads all deployments on first call and inherits per-factory overhead', async () => {
    const {contractFactory} = fakeFactoryContracts({
      [FACTORY_A]: [
        '0x00000000000000000000000000000000000000A1',
        '0x00000000000000000000000000000000000000a2',
      ],
      [FACTORY_B]: ['0x00000000000000000000000000000000000000b1'],
    });
    const enumerator = new FactoryHookEnumerator(
      1,
      provider,
      [factoryEntry(FACTORY_A, 500_000n), factoryEntry(FACTORY_B, 3_000_000n)],
      mockLogger,
      undefined,
      contractFactory
    );

    const hooks = await enumerator.enumerate();
    // Addresses lowercased.
    expect(hooks.get('0x00000000000000000000000000000000000000a1')).toBe(
      500_000n
    );
    expect(hooks.get('0x00000000000000000000000000000000000000a2')).toBe(
      500_000n
    );
    expect(hooks.get('0x00000000000000000000000000000000000000b1')).toBe(
      3_000_000n
    );
    expect(hooks.size).toBe(3);
  });

  it('pages only new indices on subsequent calls (in-memory cursor)', async () => {
    const deployments = ['0x00000000000000000000000000000000000000a1'];
    const {contractFactory, indexCalls} = fakeFactoryContracts({
      [FACTORY_A]: deployments,
    });
    const enumerator = new FactoryHookEnumerator(
      1,
      provider,
      [factoryEntry(FACTORY_A, 500_000n)],
      mockLogger,
      undefined,
      contractFactory
    );

    await enumerator.enumerate();
    expect(indexCalls.map(c => c.index)).toEqual([0]);

    // No new deployments: no index reads at all.
    const second = await enumerator.enumerate();
    expect(indexCalls.length).toBe(1);
    expect(second.size).toBe(1);

    // A new on-chain deployment: only the new index is read.
    deployments.push('0x00000000000000000000000000000000000000a2');
    const third = await enumerator.enumerate();
    expect(indexCalls.map(c => c.index)).toEqual([0, 1]);
    expect(third.size).toBe(2);
  });

  it('keeps prior state and retries when a factory read fails', async () => {
    const failLength = new Set([FACTORY_A]);
    const {contractFactory} = fakeFactoryContracts(
      {
        [FACTORY_A]: ['0x00000000000000000000000000000000000000a1'],
        [FACTORY_B]: ['0x00000000000000000000000000000000000000b1'],
      },
      {failLength}
    );
    const enumerator = new FactoryHookEnumerator(
      1,
      provider,
      [factoryEntry(FACTORY_A, 500_000n), factoryEntry(FACTORY_B, 3_000_000n)],
      mockLogger,
      undefined,
      contractFactory
    );

    // Factory A fails; factory B still enumerates.
    const first = await enumerator.enumerate();
    expect(first.has('0x00000000000000000000000000000000000000a1')).toBe(false);
    expect(first.has('0x00000000000000000000000000000000000000b1')).toBe(true);

    // Error was not cached: factory A recovers on the next call.
    failLength.clear();
    const second = await enumerator.enumerate();
    expect(second.has('0x00000000000000000000000000000000000000a1')).toBe(true);
    expect(second.size).toBe(2);
  });

  it('caps deployments per factory', async () => {
    const deployments = Array.from(
      {length: 5},
      (_, i) =>
        `0x000000000000000000000000000000000000${(1000 + i).toString(16)}`
    );
    const {contractFactory, indexCalls} = fakeFactoryContracts({
      [FACTORY_A]: deployments,
    });
    const enumerator = new FactoryHookEnumerator(
      1,
      provider,
      [factoryEntry(FACTORY_A, 500_000n)],
      mockLogger,
      undefined,
      contractFactory,
      3 // maxDeploymentsPerFactory
    );

    const hooks = await enumerator.enumerate();
    expect(hooks.size).toBe(3);
    expect(indexCalls.map(c => c.index)).toEqual([0, 1, 2]);
    expect(mockLogger.error).toHaveBeenCalled();
  });
});

describe('FactoryHookEnumerator guards', () => {
  it('warns about the cap only once per observed length', async () => {
    const deployments = Array.from(
      {length: 5},
      (_, i) =>
        `0x000000000000000000000000000000000000${(2000 + i).toString(16)}`
    );
    const {contractFactory} = fakeFactoryContracts({[FACTORY_A]: deployments});
    const errorLogger = {...mockLogger, error: vi.fn()};
    const enumerator = new FactoryHookEnumerator(
      1,
      provider,
      [factoryEntry(FACTORY_A, 500_000n)],
      errorLogger,
      undefined,
      contractFactory,
      3
    );

    await enumerator.enumerate();
    await enumerator.enumerate();
    await enumerator.enumerate();
    expect(errorLogger.error).toHaveBeenCalledTimes(1);

    // Length grows past the cap again → one more warning.
    deployments.push('0x0000000000000000000000000000000000002fff');
    await enumerator.enumerate();
    expect(errorLogger.error).toHaveBeenCalledTimes(2);
  });

  it('overlapping enumerate calls return a snapshot instead of interleaving', async () => {
    let release: (value: unknown) => void = () => {};
    const gate = new Promise(resolve => (release = resolve));
    let lengthCallCount = 0;
    const contractFactory: FactoryContractFactory = () =>
      ({
        callStatic: {
          allDeploymentsLength: async () => {
            lengthCallCount += 1;
            await gate;
            return ethers.BigNumber.from(0);
          },
          allDeployments: async () => {
            throw new Error('unreachable');
          },
        },
      }) as unknown as ethers.Contract;
    const enumerator = new FactoryHookEnumerator(
      1,
      provider,
      [factoryEntry(FACTORY_A, 500_000n)],
      mockLogger,
      undefined,
      contractFactory
    );

    const first = enumerator.enumerate();
    const second = enumerator.enumerate(); // guarded — returns snapshot
    release(undefined);
    await Promise.all([first, second]);
    expect(lengthCallCount).toBe(1);
  });
});
