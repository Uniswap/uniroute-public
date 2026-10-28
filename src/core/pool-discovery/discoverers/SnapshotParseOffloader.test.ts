import {describe, expect, it} from 'vitest';
import {buildTestContext} from '@uniswap/lib-testhelpers';
import {MainThreadSnapshotParseOffloader} from './SnapshotParseOffloader';
import {transformSnapshotPoolBytes} from './s3SnapshotTransform';
import {ChainId} from '../../../lib/config';
import {Protocol} from '../../../models/pool/Protocol';

describe('MainThreadSnapshotParseOffloader', () => {
  it('returns exactly what transformSnapshotPoolBytes computes for the same input', async () => {
    const poolBytes = new TextEncoder().encode(
      JSON.stringify([
        {
          id: '0xabc',
          token0: {id: '0xdef'},
          token1: {id: '0x123'},
          liquidity: '1',
          tvlETH: 1,
          tvlUSD: 1,
          feeTier: 3000,
        },
      ])
    );
    const params = {chainId: ChainId.MAINNET, protocol: Protocol.V3};
    const offloader = new MainThreadSnapshotParseOffloader();

    const result = await offloader.parseAndFilterSnapshot(
      poolBytes,
      params,
      buildTestContext()
    );

    expect(result).toEqual(transformSnapshotPoolBytes(poolBytes, params));
  });

  it('propagates a transform failure instead of swallowing it (failure path)', async () => {
    const offloader = new MainThreadSnapshotParseOffloader();

    await expect(
      offloader.parseAndFilterSnapshot(
        new TextEncoder().encode('{not valid json'),
        {chainId: ChainId.MAINNET, protocol: Protocol.V3},
        buildTestContext()
      )
    ).rejects.toThrow();
  });

  it('close() resolves without doing anything (no resources to release)', async () => {
    const offloader = new MainThreadSnapshotParseOffloader();
    await expect(offloader.close()).resolves.toBeUndefined();
  });
});
