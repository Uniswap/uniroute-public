import {utils} from 'ethers';
import {TokenBalanceOverride} from '../../../gen/uniroute/v1/api_pb';
import {ChainId} from '../../lib/config';
import {ResolvedStateOverride} from './ResolvedStateOverride';

export const NATIVE_TOKEN_SENTINEL =
  '0x0000000000000000000000000000000000000000';

export class SlotResolutionError extends Error {
  constructor(
    public readonly reason: 'missing_slot' | 'invalid_slot' | 'invalid_amount',
    message: string
  ) {
    super(message);
  }
}

/**
 * Resolves a `TokenBalanceOverride` intent into a concrete
 * `ResolvedStateOverride`:
 *   - tokenAddress == 0x0 -> top-level account `balance` override; the
 *     caller's `balanceMappingSlot` is ignored.
 *   - ERC-20 contract     -> stateDiff patch at
 *     `keccak256(pad32(account) ++ pad32(balanceMappingSlot))`. The
 *     caller is the source of truth for the token's storage layout —
 *     uniroute does not maintain a registry and does not default to
 *     slot 0 (that would silently patch the wrong storage key on
 *     non-standard layouts).
 */
export class TokenBalanceSlotResolver {
  resolve(
    override: TokenBalanceOverride,

    _chainId: ChainId
  ): ResolvedStateOverride {
    let amount: bigint;
    try {
      amount = BigInt(override.amount);
    } catch {
      throw new SlotResolutionError(
        'invalid_amount',
        `TokenBalanceOverride.amount must be a decimal bigint; got ${override.amount}`
      );
    }
    if (amount < 0n) {
      throw new SlotResolutionError(
        'invalid_amount',
        'TokenBalanceOverride.amount must be non-negative'
      );
    }

    if (override.tokenAddress.toLowerCase() === NATIVE_TOKEN_SENTINEL) {
      return {
        contractAddress: override.accountAddress,
        balance: amount,
        balanceTarget: {account: override.accountAddress, amount},
      };
    }

    if (override.balanceMappingSlot === '') {
      throw new SlotResolutionError(
        'missing_slot',
        `TokenBalanceOverride for ERC-20 ${override.tokenAddress} requires balanceMappingSlot; supply the storage slot of the token's balances mapping, or use RawStateOverride directly`
      );
    }
    let slot: bigint;
    try {
      slot = BigInt(override.balanceMappingSlot);
    } catch {
      throw new SlotResolutionError(
        'invalid_slot',
        `TokenBalanceOverride.balanceMappingSlot must be a decimal bigint; got ${override.balanceMappingSlot}`
      );
    }
    if (slot < 0n) {
      throw new SlotResolutionError(
        'invalid_slot',
        'TokenBalanceOverride.balanceMappingSlot must be non-negative'
      );
    }

    const storageKey = utils.keccak256(
      utils.solidityPack(
        ['uint256', 'uint256'],
        [override.accountAddress, slot]
      )
    );
    const value = utils.hexZeroPad(utils.hexlify(amount), 32);

    return {
      contractAddress: override.tokenAddress,
      stateDiff: new Map([[storageKey, value]]),
      balanceTarget: {
        account: override.accountAddress,
        amount,
        slot: storageKey.toLowerCase(),
      },
    };
  }
}
