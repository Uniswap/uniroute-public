import {describe, it, expect} from 'vitest';
import {nativeOnChain} from './nativeOnChain';
import {ChainId} from '@uniswap/sdk-core';

describe('nativeOnChain', () => {
  it('returns a native currency for mainnet', () => {
    const native = nativeOnChain(ChainId.MAINNET);
    expect(native.isNative).toBe(true);
    expect(native.chainId).toBe(ChainId.MAINNET);
  });

  it('returns same cached instance for repeated calls', () => {
    const first = nativeOnChain(ChainId.BASE);
    const second = nativeOnChain(ChainId.BASE);
    expect(first).toBe(second);
  });

  it('returns different instances for different chains', () => {
    const mainnet = nativeOnChain(ChainId.MAINNET);
    const optimism = nativeOnChain(ChainId.OPTIMISM);
    expect(mainnet).not.toBe(optimism);
    expect(mainnet.chainId).toBe(ChainId.MAINNET);
    expect(optimism.chainId).toBe(ChainId.OPTIMISM);
  });
});
