import {ethers} from 'ethers';
import {describe, expect, it} from 'vitest';

import {EthersPseudoTvlReader} from './pseudoTvlReader';

// Tempo's Uniswap aggregator hook and its pathUSD/USDC.e pool (prod).
const HOOK = '0x7169a78a59f136876e724b648fbb339a42f46888';
const POOL_ID =
  '0x00cdb9b18686cc49430bd3ea24a241633baf4af84029a014f2be22ec5e295588';

// Answers every eth_call with (amount0, amount1) once the test releases it,
// and counts how many calls reached the node.
class GatedProvider extends ethers.providers.StaticJsonRpcProvider {
  callsReceived = 0;
  private releaseAll: () => void = () => {};
  private readonly gate = new Promise<void>(resolve => {
    this.releaseAll = resolve;
  });

  constructor() {
    super('http://127.0.0.1:1', 4217);
  }

  release(): void {
    this.releaseAll();
  }

  override async call(): Promise<string> {
    this.callsReceived++;
    await this.gate;
    return ethers.utils.defaultAbiCoder.encode(
      ['uint256', 'uint256'],
      [2_000_000, 3_000_000]
    );
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('EthersPseudoTvlReader', () => {
  it('sends reads through the shared limit', async () => {
    const provider = new GatedProvider();
    const reader = new EthersPseudoTvlReader(provider);

    const reads = [reader.read(HOOK, POOL_ID), reader.read(HOOK, POOL_ID)];
    await settle();
    expect(provider.callsReceived).toBe(2);

    provider.release();
    await Promise.all(reads);
  });

  it('rejects a result that is not two amounts', async () => {
    class MalformedProvider extends ethers.providers.StaticJsonRpcProvider {
      constructor() {
        super('http://127.0.0.1:1', 4217);
      }
      override async call(): Promise<string> {
        return '0x';
      }
    }
    await expect(
      new EthersPseudoTvlReader(new MalformedProvider()).read(HOOK, POOL_ID)
    ).rejects.toThrow();
  });
});
