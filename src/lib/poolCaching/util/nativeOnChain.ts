/**
 * Simplified port of @uniswap/smart-order-router nativeOnChain utility.
 * For pool ID computation, only the isNative flag matters (address is zero).
 */

import { ChainId, Ether, NativeCurrency, Token } from '@uniswap/sdk-core';

const cachedNativeCurrency: { [chainId: number]: NativeCurrency } = {};

export function nativeOnChain(chainId: number): NativeCurrency {
  if (cachedNativeCurrency[chainId] != undefined) {
    return cachedNativeCurrency[chainId]!;
  }
  cachedNativeCurrency[chainId] = Ether.onChain(chainId);
  return cachedNativeCurrency[chainId]!;
}
