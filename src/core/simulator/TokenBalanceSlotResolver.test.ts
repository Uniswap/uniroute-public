import {describe, expect, it} from 'vitest';
import {utils} from 'ethers';
import {TokenBalanceOverride} from '../../../gen/uniroute/v1/api_pb';
import {ChainId} from '../../lib/config';
import {
  NATIVE_TOKEN_SENTINEL,
  SlotResolutionError,
  TokenBalanceSlotResolver,
} from './TokenBalanceSlotResolver';

describe('TokenBalanceSlotResolver', () => {
  const resolver = new TokenBalanceSlotResolver();

  it('resolves native (zero-address) override to a balance entry, not stateDiff', () => {
    const account = '0x000000000000000000000000000000000000dEaD';
    const out = resolver.resolve(
      new TokenBalanceOverride({
        tokenAddress: NATIVE_TOKEN_SENTINEL,
        accountAddress: account,
        amount: '1000',
      }),
      ChainId.MAINNET
    );
    expect(out.balance).toBe(1000n);
    expect(out.contractAddress).toBe(account);
    expect(out.stateDiff).toBeUndefined();
    expect(out.balanceTarget).toEqual({account, amount: 1000n});
  });

  it('ignores balanceMappingSlot for the native sentinel', () => {
    // Even if the caller mistakenly passes a slot for native, it's ignored.
    const account = '0x000000000000000000000000000000000000dEaD';
    const out = resolver.resolve(
      new TokenBalanceOverride({
        tokenAddress: NATIVE_TOKEN_SENTINEL,
        accountAddress: account,
        amount: '500',
        balanceMappingSlot: '42',
      }),
      ChainId.MAINNET
    );
    expect(out.balance).toBe(500n);
    expect(out.stateDiff).toBeUndefined();
  });

  it('resolves an ERC-20 override with caller-supplied slot to keccak(pad(account) ++ pad(slot))', () => {
    const token = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
    const account = '0x000000000000000000000000000000000000dEaD';
    const out = resolver.resolve(
      new TokenBalanceOverride({
        tokenAddress: token,
        accountAddress: account,
        amount: '1234',
        balanceMappingSlot: '9', // e.g. USDC fiat-token-v2 layout
      }),
      ChainId.MAINNET
    );
    const expectedKey = utils.keccak256(
      utils.solidityPack(['uint256', 'uint256'], [account, 9n])
    );
    expect(out.contractAddress).toBe(token);
    expect(out.balance).toBeUndefined();
    expect(out.stateDiff?.size).toBe(1);
    expect(out.stateDiff?.get(expectedKey)).toBe(utils.hexZeroPad('0x4d2', 32));
    expect(out.balanceTarget).toEqual({
      account,
      amount: 1234n,
      slot: expectedKey.toLowerCase(),
    });
  });

  it('fails closed when balanceMappingSlot is missing for an ERC-20 override', () => {
    const token = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
    expect(() =>
      resolver.resolve(
        new TokenBalanceOverride({
          tokenAddress: token,
          accountAddress: '0x000000000000000000000000000000000000dEaD',
          amount: '1',
          // balanceMappingSlot omitted
        }),
        ChainId.MAINNET
      )
    ).toThrow(/requires balanceMappingSlot/);
  });

  it('rejects negative amounts with reason invalid_amount', () => {
    try {
      resolver.resolve(
        new TokenBalanceOverride({
          tokenAddress: NATIVE_TOKEN_SENTINEL,
          accountAddress: '0x000000000000000000000000000000000000dEaD',
          amount: '-1',
        }),
        ChainId.MAINNET
      );
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SlotResolutionError);
      expect((err as SlotResolutionError).reason).toBe('invalid_amount');
    }
  });

  it('rejects malformed amount strings with reason invalid_amount', () => {
    // Direct-call path: validator normally gates these, but if a caller
    // bypasses the validator, the resolver must surface this as an
    // amount problem — not fall through to the generic `invalid_slot`
    // fallback in StateOverrideResolver's catch.
    // `BigInt` accepts hex (`'0xff'`) so it isn't malformed; only
    // non-numeric, decimal-point, and scientific-notation inputs throw.
    for (const bad of ['not-a-number', '1.5', '1e10']) {
      try {
        resolver.resolve(
          new TokenBalanceOverride({
            tokenAddress: NATIVE_TOKEN_SENTINEL,
            accountAddress: '0x000000000000000000000000000000000000dEaD',
            amount: bad,
          }),
          ChainId.MAINNET
        );
        throw new Error(`expected throw for amount=${bad}`);
      } catch (err) {
        expect(err).toBeInstanceOf(SlotResolutionError);
        expect((err as SlotResolutionError).reason).toBe('invalid_amount');
      }
    }
  });

  it('rejects negative balanceMappingSlot', () => {
    expect(() =>
      resolver.resolve(
        new TokenBalanceOverride({
          tokenAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
          accountAddress: '0x000000000000000000000000000000000000dEaD',
          amount: '1',
          balanceMappingSlot: '-1',
        }),
        ChainId.MAINNET
      )
    ).toThrow(/non-negative/);
  });

  it('rejects malformed balanceMappingSlot strings', () => {
    expect(() =>
      resolver.resolve(
        new TokenBalanceOverride({
          tokenAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
          accountAddress: '0x000000000000000000000000000000000000dEaD',
          amount: '1',
          balanceMappingSlot: 'not-a-number',
        }),
        ChainId.MAINNET
      )
    ).toThrow(/decimal bigint/);
  });
});
