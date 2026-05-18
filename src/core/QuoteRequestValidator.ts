import {
  QuoteRequest,
  QuoteResponse,
  StateOverride,
} from '../../gen/uniroute/v1/api_pb';
import {ChainId, SUPPORTED_CHAINS} from '../lib/config';
import {EnumUtils} from '../lib/EnumUtils';
import {Protocol} from '../models/pool/Protocol';
import {isAddress} from 'ethers/lib/utils';
import {isNativeAddress} from '../lib/helpers';
import {IChainRepository} from '../stores/chain/IChainRepository';
import {ITokenProvider} from '../stores/token/provider/TokenProvider';
import {Context} from '@uniswap/lib-uni/context';

const MAX_STATE_OVERRIDES = 16;
const MAX_STATE_DIFF_ENTRIES = 32;
const HEX_32 = /^0x[0-9a-fA-F]{64}$/;
// Spurious Dragon contract size limit is 24576 bytes; with `0x` prefix and
// 2 hex chars per byte that's 49154. We allow a small margin for trusted
// mock contracts but reject obviously-pathological blobs early — sim
// backends would otherwise carry them over the wire on every retry.
const MAX_CODE_OVERRIDE_HEX_LEN = 49154;
// Bigint amounts fit comfortably in 80 decimal digits (2^256 is 78 digits).
// Any longer is either a parser bug or a probe; bound first by length to
// keep the BigInt parser from chewing on pathological inputs, then by
// numeric uint256 max so the resolver can always encode into 32 bytes.
const MAX_AMOUNT_LEN = 80;
const MAX_UINT256 = (1n << 256n) - 1n;

export interface IQuoteRequestValidator {
  /**
   * Validates the QuoteRequest.
   * Returns a QuoteResponse with an error if the request is invalid, otherwise returns undefined.
   * @param request - The QuoteRequest to validate.
   * @param ctx - The context to use for logging and metrics.
   * @returns A QuoteResponse with an error if the request is invalid, otherwise returns undefined.
   */
  validateInputs(
    request: QuoteRequest,
    ctx: Context
  ): Promise<QuoteResponse | undefined>;
}

export class QuoteRequestValidator {
  constructor(
    private readonly chainRepository: IChainRepository,
    private readonly tokenProvider: ITokenProvider,
    // Chains where state-override-bearing requests will reach a backend
    // that supports overrides (eth_simulateV1 or Tenderly node
    // `tenderly_estimateGasBundle`). Reject overrides on other chains
    // rather than routing them into a path that would throw at sim time.
    // Configured by dependencies.ts → `stateOverridesSupportedChains`.
    private readonly stateOverridesSupportedChains: ChainId[] = []
  ) {}
  // Validates the QuoteRequest.
  // Returns a QuoteResponse with an error if the request is invalid, otherwise returns undefined.
  public async validateInputs(
    request: QuoteRequest,
    ctx: Context
  ): Promise<QuoteResponse | undefined> {
    // Check if chainId is supported
    if (!SUPPORTED_CHAINS.some(chainId => chainId === request.tokenInChainId)) {
      return new QuoteResponse({
        error: {
          code: 400,
          message: `Unsupported chainId: ${request.tokenInChainId}`,
        },
      });
    }

    // Slippage tolerance must not exceed 20%
    if (
      request.slippageTolerance !== undefined &&
      request.slippageTolerance > 20
    ) {
      return new QuoteResponse({
        error: {
          code: 400,
          message: 'Slippage tolerance must not exceed 20%',
        },
      });
    }

    // Only mixed protocol is not allowed
    const protocols = request.protocols
      .split(',')
      .map(p => EnumUtils.stringToEnum(Protocol, p));
    if (protocols.length === 1 && protocols[0] === Protocol.MIXED) {
      return new QuoteResponse({
        error: {
          code: 400,
          message: 'Mixed protocol cannot be specified explicitly',
        },
      });
    }

    // Input amount must be greater than zero
    if (BigInt(request.amount) <= 0) {
      return new QuoteResponse({
        error: {
          code: 400,
          message: 'Amount must be greater than zero',
        },
      });
    }

    // Token in and out must not be the same
    if (
      request.tokenInAddress.toLowerCase() ===
      request.tokenOutAddress.toLowerCase()
    ) {
      return new QuoteResponse({
        error: {
          code: 400,
          message: 'Token in and out must not be the same',
        },
      });
    }

    // recipient must not be an invalid address
    if (request.recipient && !isAddress(request.recipient)) {
      return new QuoteResponse({
        error: {
          code: 400,
          message: 'Recipient must be a valid address',
        },
      });
    }

    // check if tokenInChainId and tokenOutChainId are the same
    if (request.tokenInChainId !== request.tokenOutChainId) {
      return new QuoteResponse({
        error: {
          code: 400,
          message: 'TokenInChainId and TokenOutChainId must be the same',
        },
      });
    }

    const stateOverrideError = this.validateStateOverrides(
      request.stateOverrides,
      request.tokenInChainId,
      request.tokenInAddress,
      ctx
    );
    if (stateOverrideError) {
      await ctx.metrics.count('StateOverride.ValidationFailed', 1, {
        tags: [
          `chain:${request.tokenInChainId}`,
          `reason:${stateOverrideError.reason}`,
        ],
      });
      return new QuoteResponse({
        error: {code: 400, message: stateOverrideError.message},
      });
    }

    // tokens must not be the same after getting wrapped
    const chain = await this.chainRepository.getChain(request.tokenInChainId);
    const tokenInWrappedAddress = (
      await this.tokenProvider.searchForToken(
        chain,
        request.tokenInAddress,
        ctx
      )
    ).wrappedAddress;
    const tokenOutWrappedAddress = (
      await this.tokenProvider.searchForToken(
        chain,
        request.tokenOutAddress,
        ctx
      )
    ).wrappedAddress;
    if (
      tokenInWrappedAddress.address.toLowerCase() ===
      tokenOutWrappedAddress.address.toLowerCase()
    ) {
      return new QuoteResponse({
        error: {
          code: 400,
          message: 'Token in and out must not be the same',
        },
      });
    }

    return undefined;
  }

  private validateStateOverrides(
    overrides: StateOverride[],
    chainId: number,
    tokenInAddress: string,
    _ctx: Context
  ): {message: string; reason: string} | undefined {
    if (overrides.length === 0) return undefined;
    if (!this.stateOverridesSupportedChains.includes(chainId)) {
      return {
        message: `stateOverrides are not supported on chainId ${chainId}`,
        reason: 'chain_unsupported',
      };
    }
    if (overrides.length > MAX_STATE_OVERRIDES) {
      return {
        message: `stateOverrides exceeds max of ${MAX_STATE_OVERRIDES}`,
        reason: 'too_many',
      };
    }
    // Reject ALL TokenBalanceOverride entries on mainnet ETH input. The
    // simulator unconditionally substitutes `from` with
    // BEACON_CHAIN_DEPOSIT_ADDRESS for that case (backwards-compat
    // requirement per the rollout plan), so any balance override —
    // native OR ERC-20 — credits the swapper account that the simulator
    // never reads. Letting these through would silently produce a
    // simulation against a different account state than the client
    // intended. Surface the mismatch at the API boundary.
    //
    // RawStateOverride is still allowed: many raw writes (hook
    // permissions, adapter allowlists, contract code) are independent
    // of the sender. Clients using sender-dependent raw writes on
    // mainnet ETH input get unexpected results — accepted tradeoff
    // until BEACON substitution moves to the TAPI side.
    //
    // The API accepts native input as either the zero address OR the
    // chain's native-currency symbol (e.g. `"ETH"`), so the precheck
    // must catch both forms.
    const isMainnetEthInput =
      chainId === ChainId.MAINNET &&
      (isNativeAddress(tokenInAddress) ||
        tokenInAddress.toUpperCase() === 'ETH');
    if (
      isMainnetEthInput &&
      overrides.some(o => o.kind.case === 'tokenBalance')
    ) {
      return {
        message:
          'TokenBalanceOverride is not supported on mainnet ETH input; simulation uses BEACON_CHAIN_DEPOSIT_ADDRESS as sender so the override would credit an account the simulator never reads',
        reason: 'token_balance_override_unsupported_for_mainnet_eth_input',
      };
    }
    // Reject multiple TokenBalanceOverride entries that target the same
    // logical (token, account) pair, even with different
    // balanceMappingSlot values. Each entry produces a separate storage
    // write at the resolver level, but only the slot matching the token's
    // real balance layout is meaningful — the others are dead storage
    // writes. Picking which one is "authoritative" for the pre-sim guard
    // would be order-dependent and nondeterministic from the API
    // consumer's perspective. Forcing the client to pick one collapses
    // the ambiguity at the boundary.
    const seenBalanceTargets = new Set<string>();
    for (const override of overrides) {
      if (override.kind.case !== 'tokenBalance') continue;
      const {tokenAddress, accountAddress} = override.kind.value;
      if (!isAddress(tokenAddress) || !isAddress(accountAddress)) continue;
      const key = `${tokenAddress.toLowerCase()}:${accountAddress.toLowerCase()}`;
      if (seenBalanceTargets.has(key)) {
        return {
          message:
            'Multiple TokenBalanceOverride entries for the same (tokenAddress, accountAddress) are not allowed',
          reason: 'duplicate_balance_target',
        };
      }
      seenBalanceTargets.add(key);
    }
    for (const override of overrides) {
      const kind = override.kind;
      if (kind.case === 'tokenBalance') {
        const {tokenAddress, accountAddress, amount, balanceMappingSlot} =
          kind.value;
        if (!isAddress(tokenAddress)) {
          return {
            message:
              'TokenBalanceOverride.tokenAddress must be a valid address',
            reason: 'invalid_address',
          };
        }
        if (!isAddress(accountAddress)) {
          return {
            message:
              'TokenBalanceOverride.accountAddress must be a valid address',
            reason: 'invalid_address',
          };
        }
        if (amount.length > MAX_AMOUNT_LEN) {
          return {
            message: `TokenBalanceOverride.amount must be at most ${MAX_AMOUNT_LEN} digits`,
            reason: 'amount_too_long',
          };
        }
        let parsed: bigint;
        try {
          parsed = BigInt(amount);
        } catch {
          return {
            message: 'TokenBalanceOverride.amount must be a decimal bigint',
            reason: 'invalid_amount',
          };
        }
        if (parsed < 0n) {
          return {
            message: 'TokenBalanceOverride.amount must be non-negative',
            reason: 'invalid_amount',
          };
        }
        if (parsed > MAX_UINT256) {
          return {
            message:
              'TokenBalanceOverride.amount must fit in uint256 (max 2^256-1)',
            reason: 'amount_exceeds_uint256',
          };
        }
        // balanceMappingSlot is ignored for the native sentinel; required
        // for ERC-20 overrides. We validate shape eagerly here so a
        // malformed slot becomes a 400 instead of a sim-time resolver
        // failure.
        const isNative =
          tokenAddress === '0x0000000000000000000000000000000000000000';
        if (!isNative) {
          if (balanceMappingSlot === '') {
            return {
              message:
                'TokenBalanceOverride.balanceMappingSlot is required for ERC-20 overrides',
              reason: 'missing_slot',
            };
          }
          if (balanceMappingSlot.length > MAX_AMOUNT_LEN) {
            return {
              message: `TokenBalanceOverride.balanceMappingSlot must be at most ${MAX_AMOUNT_LEN} digits`,
              reason: 'slot_too_long',
            };
          }
          let parsedSlot: bigint;
          try {
            parsedSlot = BigInt(balanceMappingSlot);
          } catch {
            return {
              message:
                'TokenBalanceOverride.balanceMappingSlot must be a decimal bigint',
              reason: 'invalid_slot',
            };
          }
          if (parsedSlot < 0n) {
            return {
              message:
                'TokenBalanceOverride.balanceMappingSlot must be non-negative',
              reason: 'invalid_slot',
            };
          }
          if (parsedSlot > MAX_UINT256) {
            return {
              message:
                'TokenBalanceOverride.balanceMappingSlot must fit in uint256 (max 2^256-1)',
              reason: 'slot_exceeds_uint256',
            };
          }
        }
      } else if (kind.case === 'rawState') {
        const {contractAddress, stateDiff, codeOverride} = kind.value;
        if (!isAddress(contractAddress)) {
          return {
            message: 'RawStateOverride.contractAddress must be a valid address',
            reason: 'invalid_address',
          };
        }
        const entries = Object.entries(stateDiff);
        // Reject no-op entries: a RawStateOverride with neither
        // stateDiff entries nor a codeOverride applies no state but
        // would still flip override-path gating (e.g. skips the
        // eth_estimateGas fast path) and incur extra latency for no
        // semantic effect. Force the client to omit empty entries.
        if (entries.length === 0 && codeOverride === undefined) {
          return {
            message:
              'RawStateOverride must contain at least one stateDiff entry or a codeOverride',
            reason: 'empty_raw_state',
          };
        }
        if (entries.length > MAX_STATE_DIFF_ENTRIES) {
          return {
            message: `RawStateOverride.stateDiff exceeds max of ${MAX_STATE_DIFF_ENTRIES} entries`,
            reason: 'too_many_slots',
          };
        }
        for (const [slot, value] of entries) {
          if (!HEX_32.test(slot)) {
            return {
              message: 'RawStateOverride.stateDiff slot must be 32-byte hex',
              reason: 'invalid_slot',
            };
          }
          if (!HEX_32.test(value)) {
            return {
              message: 'RawStateOverride.stateDiff value must be 32-byte hex',
              reason: 'invalid_value',
            };
          }
        }
        if (codeOverride !== undefined) {
          if (codeOverride.length > MAX_CODE_OVERRIDE_HEX_LEN) {
            return {
              message: `RawStateOverride.codeOverride exceeds max byte size (${
                (MAX_CODE_OVERRIDE_HEX_LEN - 2) / 2
              } bytes)`,
              reason: 'code_too_large',
            };
          }
          if (!/^0x([0-9a-fA-F]{2})*$/.test(codeOverride)) {
            return {
              message: 'RawStateOverride.codeOverride must be hex bytecode',
              reason: 'invalid_code',
            };
          }
        }
      } else {
        return {
          message: 'StateOverride.kind must be set',
          reason: 'missing_kind',
        };
      }
    }
    return undefined;
  }
}
