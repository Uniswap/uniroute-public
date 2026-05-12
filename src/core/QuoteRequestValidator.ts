import {
  QuoteRequest,
  QuoteResponse,
  StateOverride,
} from '../../gen/uniroute/v1/api_pb';
import {SUPPORTED_CHAINS} from '../lib/config';
import {EnumUtils} from '../lib/EnumUtils';
import {Protocol} from '../models/pool/Protocol';
import {isAddress} from 'ethers/lib/utils';
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
    private readonly tokenProvider: ITokenProvider
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

    _ctx: Context
  ): {message: string; reason: string} | undefined {
    if (overrides.length === 0) return undefined;
    if (overrides.length > MAX_STATE_OVERRIDES) {
      return {
        message: `stateOverrides exceeds max of ${MAX_STATE_OVERRIDES}`,
        reason: 'too_many',
      };
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
