import {Percent} from '@uniswap/sdk-core';

export function parseSlippageTolerance(slippageTolerance: string): Percent {
  // e.g. Inputs of form "1.25%" with 2dp max. Convert to fractional representation => 1.25 => 125 / 10000
  const slippagePer10k = Math.round(parseFloat(slippageTolerance) * 100);
  return new Percent(slippagePer10k, 10_000);
}

export function parseDeadline(deadline: string): number {
  return Math.floor(Date.now() / 1000) + parseInt(deadline);
}
