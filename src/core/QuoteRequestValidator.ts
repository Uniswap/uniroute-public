import {QuoteRequest, QuoteResponse} from '../../gen/uniroute/v1/api_pb';
import {SUPPORTED_CHAINS} from '../lib/config';
import {EnumUtils} from '../lib/EnumUtils';
import {UniProtocol} from '../models/pool/UniProtocol';
import {isAddress} from 'ethers/lib/utils';
import {IChainRepository} from '../stores/chain/IChainRepository';
import {ITokenProvider} from '../stores/token/provider/TokenProvider';
import {Context} from '@uniswap/lib-uni/context';

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
      .map(p => EnumUtils.stringToEnum(UniProtocol, p));
    if (protocols.length === 1 && protocols[0] === UniProtocol.MIXED) {
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
}
