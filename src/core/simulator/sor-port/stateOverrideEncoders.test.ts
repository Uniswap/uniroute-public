import {describe, expect, it} from 'vitest';
import {encodeGethStateOverrides} from './stateOverrideEncoders';

const SLOT =
  '0x0000000000000000000000000000000000000000000000000000000000000005';
const VAL =
  '0x0000000000000000000000000000000000000000000000000000000000000001';

describe('encodeGethStateOverrides', () => {
  it('returns undefined for empty / missing input', () => {
    expect(encodeGethStateOverrides(undefined)).toBeUndefined();
    expect(encodeGethStateOverrides([])).toBeUndefined();
  });

  it('encodes balance override into hex `balance` field', () => {
    const out = encodeGethStateOverrides([
      {contractAddress: '0xAaAa', balance: 1000n},
    ]);
    expect(out).toEqual({'0xaaaa': {balance: '0x3e8'}});
  });

  it('encodes ERC-20 stateDiff + code, lower-cased keys', () => {
    const out = encodeGethStateOverrides([
      {
        contractAddress: '0xBbBb',
        stateDiff: new Map([[SLOT, VAL]]),
        codeOverride: '0x60aa',
      },
    ]);
    expect(out).toEqual({
      '0xbbbb': {stateDiff: {[SLOT]: VAL}, code: '0x60aa'},
    });
  });

  it('merges multiple entries on the same contract', () => {
    const out = encodeGethStateOverrides([
      {contractAddress: '0xCcCc', stateDiff: new Map([[SLOT, VAL]])},
      {contractAddress: '0xcccc', codeOverride: '0xdead'},
    ]);
    expect(out).toEqual({
      '0xcccc': {stateDiff: {[SLOT]: VAL}, code: '0xdead'},
    });
  });
});
