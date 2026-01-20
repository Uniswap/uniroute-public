import {describe, expect, it, beforeEach, vi} from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import {QuoteRequest, QuoteResponse} from '../../gen/uniroute/v1/api_pb';
import {QuoteRequestValidator} from './QuoteRequestValidator';
import {IChainRepository} from '../stores/chain/IChainRepository';
import {ITokenProvider} from '../stores/token/provider/TokenProvider';
import {Chain} from '../models/chain/Chain';
import {Address} from '../models/address/Address';
import {CurrencyInfo} from '../models/currency/CurrencyInfo';
import {buildTestContext} from '@uniswap/lib-testhelpers';
import {Context} from '@uniswap/lib-uni/context';
import {ChainId, SUPPORTED_CHAINS} from '../lib/config';
import {UniProtocol} from '../models/pool/UniProtocol';

describe('QuoteRequestValidator', () => {
  let validator: QuoteRequestValidator;
  let mockChainRepository: IChainRepository;
  let mockTokenProvider: ITokenProvider;
  let ctx: Context;

  beforeEach(() => {
    ctx = buildTestContext();

    // Create mock chain repository
    mockChainRepository = {
      getChain: vi.fn(),
    };

    // Create mock token provider
    mockTokenProvider = {
      searchForToken: vi.fn(),
    } as unknown as ITokenProvider;

    validator = new QuoteRequestValidator(
      mockChainRepository,
      mockTokenProvider
    );
  });

  const createValidRequest = (): QuoteRequest => {
    return new QuoteRequest({
      tokenInAddress: '0x1111111111111111111111111111111111111111',
      tokenInChainId: ChainId.MAINNET,
      tokenOutAddress: '0x2222222222222222222222222222222222222222',
      tokenOutChainId: ChainId.MAINNET,
      amount: '1000000000000000000',
      tradeType: 'EXACT_IN',
      quoteType: 'FAST',
      protocols: 'v2,v3',
    });
  };

  const createMockChain = (chainId: ChainId): Chain => {
    return {
      chainId,
      chainName: 'Test Chain',
      wrappedNativeToken: new Address(
        '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
      ),
      v3FactoryAddress: new Address(
        '0x1111111111111111111111111111111111111111'
      ),
      v3QuoterAddress: new Address(
        '0x1111111111111111111111111111111111111111'
      ),
      multicallAddress: new Address(
        '0x1111111111111111111111111111111111111111'
      ),
      multicallGasLimitPerCall: 1000000,
      multicallBatchSize: 10,
    } as Chain;
  };

  describe('validateInputs', () => {
    it('should return undefined for a valid request', async () => {
      const request = createValidRequest();
      const mockChain = createMockChain(ChainId.MAINNET);

      vi.mocked(mockChainRepository.getChain).mockResolvedValue(mockChain);
      vi.mocked(mockTokenProvider.searchForToken).mockImplementation(
        async (chain, tokenRaw) => {
          if (tokenRaw === request.tokenInAddress) {
            return new CurrencyInfo(
              false,
              new Address('0x1111111111111111111111111111111111111111')
            );
          }
          return new CurrencyInfo(
            false,
            new Address('0x2222222222222222222222222222222222222222')
          );
        }
      );

      const result = await validator.validateInputs(request, ctx);

      expect(result).toBeUndefined();
      expect(mockChainRepository.getChain).toHaveBeenCalledWith(
        ChainId.MAINNET
      );
      expect(mockTokenProvider.searchForToken).toHaveBeenCalledTimes(2);
    });

    it('should return error for unsupported chainId', async () => {
      const request = createValidRequest();
      request.tokenInChainId = 99999 as ChainId; // Unsupported chain

      const result = await validator.validateInputs(request, ctx);

      expect(result).toBeDefined();
      expect(result?.error).toBeDefined();
      expect(result?.error?.code).toBe(400);
      expect(result?.error?.message).toBe(
        `Unsupported chainId: ${request.tokenInChainId}`
      );
    });

    it('should return error when mixed protocol is specified explicitly', async () => {
      const request = createValidRequest();
      request.protocols = UniProtocol.MIXED;

      const result = await validator.validateInputs(request, ctx);

      expect(result).toBeDefined();
      expect(result?.error).toBeDefined();
      expect(result?.error?.code).toBe(400);
      expect(result?.error?.message).toBe(
        'Mixed protocol cannot be specified explicitly'
      );
    });

    it('should not return error when mixed protocol is combined with others', async () => {
      const request = createValidRequest();
      request.protocols = 'v2,v3,mixed';
      const mockChain = createMockChain(ChainId.MAINNET);

      vi.mocked(mockChainRepository.getChain).mockResolvedValue(mockChain);
      vi.mocked(mockTokenProvider.searchForToken).mockImplementation(
        async (chain, tokenRaw) => {
          if (tokenRaw === request.tokenInAddress) {
            return new CurrencyInfo(
              false,
              new Address('0x1111111111111111111111111111111111111111')
            );
          }
          return new CurrencyInfo(
            false,
            new Address('0x2222222222222222222222222222222222222222')
          );
        }
      );

      const result = await validator.validateInputs(request, ctx);

      expect(result).toBeUndefined();
    });

    it('should return error when amount is zero', async () => {
      const request = createValidRequest();
      request.amount = '0';

      const result = await validator.validateInputs(request, ctx);

      expect(result).toBeDefined();
      expect(result?.error).toBeDefined();
      expect(result?.error?.code).toBe(400);
      expect(result?.error?.message).toBe('Amount must be greater than zero');
    });

    it('should return error when amount is negative', async () => {
      const request = createValidRequest();
      request.amount = '-1000000000000000000';

      const result = await validator.validateInputs(request, ctx);

      expect(result).toBeDefined();
      expect(result?.error).toBeDefined();
      expect(result?.error?.code).toBe(400);
      expect(result?.error?.message).toBe('Amount must be greater than zero');
    });

    it('should return error when token in and out are the same', async () => {
      const request = createValidRequest();
      request.tokenInAddress = '0x1111111111111111111111111111111111111111';
      request.tokenOutAddress = '0x1111111111111111111111111111111111111111';

      const result = await validator.validateInputs(request, ctx);

      expect(result).toBeDefined();
      expect(result?.error).toBeDefined();
      expect(result?.error?.code).toBe(400);
      expect(result?.error?.message).toBe(
        'Token in and out must not be the same'
      );
    });

    it('should return error when token in and out are the same (case insensitive)', async () => {
      const request = createValidRequest();
      // Use different cases to test case-insensitive comparison
      request.tokenInAddress = '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'; // Mixed case
      request.tokenOutAddress = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'; // Lower case

      const result = await validator.validateInputs(request, ctx);

      expect(result).toBeDefined();
      expect(result?.error).toBeDefined();
      expect(result?.error?.code).toBe(400);
      expect(result?.error?.message).toBe(
        'Token in and out must not be the same'
      );
    });

    it('should return error when recipient is an invalid address', async () => {
      const request = createValidRequest();
      request.recipient = 'invalid-address';

      const result = await validator.validateInputs(request, ctx);

      expect(result).toBeDefined();
      expect(result?.error).toBeDefined();
      expect(result?.error?.code).toBe(400);
      expect(result?.error?.message).toBe('Recipient must be a valid address');
    });

    it('should not return error when recipient is a valid address', async () => {
      const request = createValidRequest();
      request.recipient = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
      const mockChain = createMockChain(ChainId.MAINNET);

      vi.mocked(mockChainRepository.getChain).mockResolvedValue(mockChain);
      vi.mocked(mockTokenProvider.searchForToken).mockImplementation(
        async (chain, tokenRaw) => {
          if (tokenRaw === request.tokenInAddress) {
            return new CurrencyInfo(
              false,
              new Address('0x1111111111111111111111111111111111111111')
            );
          }
          return new CurrencyInfo(
            false,
            new Address('0x2222222222222222222222222222222222222222')
          );
        }
      );

      const result = await validator.validateInputs(request, ctx);

      expect(result).toBeUndefined();
    });

    it('should not return error when recipient is not provided', async () => {
      const request = createValidRequest();
      request.recipient = undefined;
      const mockChain = createMockChain(ChainId.MAINNET);

      vi.mocked(mockChainRepository.getChain).mockResolvedValue(mockChain);
      vi.mocked(mockTokenProvider.searchForToken).mockImplementation(
        async (chain, tokenRaw) => {
          if (tokenRaw === request.tokenInAddress) {
            return new CurrencyInfo(
              false,
              new Address('0x1111111111111111111111111111111111111111')
            );
          }
          return new CurrencyInfo(
            false,
            new Address('0x2222222222222222222222222222222222222222')
          );
        }
      );

      const result = await validator.validateInputs(request, ctx);

      expect(result).toBeUndefined();
    });

    it('should return error when tokenInChainId and tokenOutChainId are different', async () => {
      const request = createValidRequest();
      request.tokenInChainId = ChainId.MAINNET;
      request.tokenOutChainId = ChainId.OPTIMISM;

      const result = await validator.validateInputs(request, ctx);

      expect(result).toBeDefined();
      expect(result?.error).toBeDefined();
      expect(result?.error?.code).toBe(400);
      expect(result?.error?.message).toBe(
        'TokenInChainId and TokenOutChainId must be the same'
      );
    });

    it('should return error when slippage tolerance exceeds 20%', async () => {
      const request = createValidRequest();
      request.slippageTolerance = 21;

      const result = await validator.validateInputs(request, ctx);

      expect(result).toBeDefined();
      expect(result?.error).toBeDefined();
      expect(result?.error?.code).toBe(400);
      expect(result?.error?.message).toBe(
        'Slippage tolerance must not exceed 20%'
      );
    });

    it('should not return error when slippage tolerance is exactly 20%', async () => {
      const request = createValidRequest();
      request.slippageTolerance = 20;
      const mockChain = createMockChain(ChainId.MAINNET);

      vi.mocked(mockChainRepository.getChain).mockResolvedValue(mockChain);
      vi.mocked(mockTokenProvider.searchForToken).mockImplementation(
        async (chain, tokenRaw) => {
          if (tokenRaw === request.tokenInAddress) {
            return new CurrencyInfo(
              false,
              new Address('0x1111111111111111111111111111111111111111')
            );
          }
          return new CurrencyInfo(
            false,
            new Address('0x2222222222222222222222222222222222222222')
          );
        }
      );

      const result = await validator.validateInputs(request, ctx);

      expect(result).toBeUndefined();
    });

    it('should not return error when slippage tolerance is below 20%', async () => {
      const request = createValidRequest();
      request.slippageTolerance = 5;
      const mockChain = createMockChain(ChainId.MAINNET);

      vi.mocked(mockChainRepository.getChain).mockResolvedValue(mockChain);
      vi.mocked(mockTokenProvider.searchForToken).mockImplementation(
        async (chain, tokenRaw) => {
          if (tokenRaw === request.tokenInAddress) {
            return new CurrencyInfo(
              false,
              new Address('0x1111111111111111111111111111111111111111')
            );
          }
          return new CurrencyInfo(
            false,
            new Address('0x2222222222222222222222222222222222222222')
          );
        }
      );

      const result = await validator.validateInputs(request, ctx);

      expect(result).toBeUndefined();
    });

    it('should not return error when slippage tolerance is not provided', async () => {
      const request = createValidRequest();
      request.slippageTolerance = undefined;
      const mockChain = createMockChain(ChainId.MAINNET);

      vi.mocked(mockChainRepository.getChain).mockResolvedValue(mockChain);
      vi.mocked(mockTokenProvider.searchForToken).mockImplementation(
        async (chain, tokenRaw) => {
          if (tokenRaw === request.tokenInAddress) {
            return new CurrencyInfo(
              false,
              new Address('0x1111111111111111111111111111111111111111')
            );
          }
          return new CurrencyInfo(
            false,
            new Address('0x2222222222222222222222222222222222222222')
          );
        }
      );

      const result = await validator.validateInputs(request, ctx);

      expect(result).toBeUndefined();
    });

    it('should return error when tokens are the same after wrapping', async () => {
      const request = createValidRequest();
      request.tokenInAddress = 'ETH';
      request.tokenOutAddress = 'WETH';
      const mockChain = createMockChain(ChainId.MAINNET);
      const wrappedAddress = new Address(
        '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
      );

      vi.mocked(mockChainRepository.getChain).mockResolvedValue(mockChain);
      vi.mocked(mockTokenProvider.searchForToken).mockResolvedValue(
        new CurrencyInfo(false, wrappedAddress)
      );

      const result = await validator.validateInputs(request, ctx);

      expect(result).toBeDefined();
      expect(result?.error).toBeDefined();
      expect(result?.error?.code).toBe(400);
      expect(result?.error?.message).toBe(
        'Token in and out must not be the same'
      );
    });

    it('should not return error when tokens are different after wrapping', async () => {
      const request = createValidRequest();
      const mockChain = createMockChain(ChainId.MAINNET);

      vi.mocked(mockChainRepository.getChain).mockResolvedValue(mockChain);
      vi.mocked(mockTokenProvider.searchForToken).mockImplementation(
        async (chain, tokenRaw) => {
          if (tokenRaw === request.tokenInAddress) {
            return new CurrencyInfo(
              false,
              new Address('0x1111111111111111111111111111111111111111')
            );
          }
          return new CurrencyInfo(
            false,
            new Address('0x2222222222222222222222222222222222222222')
          );
        }
      );

      const result = await validator.validateInputs(request, ctx);

      expect(result).toBeUndefined();
    });

    it('should validate all supported chains', async () => {
      for (const chainId of SUPPORTED_CHAINS) {
        const request = createValidRequest();
        request.tokenInChainId = chainId;
        request.tokenOutChainId = chainId;
        const mockChain = createMockChain(chainId);

        vi.mocked(mockChainRepository.getChain).mockResolvedValue(mockChain);
        vi.mocked(mockTokenProvider.searchForToken).mockImplementation(
          async (chain, tokenRaw) => {
            if (tokenRaw === request.tokenInAddress) {
              return new CurrencyInfo(
                false,
                new Address('0x1111111111111111111111111111111111111111')
              );
            }
            return new CurrencyInfo(
              false,
              new Address('0x2222222222222222222222222222222222222222')
            );
          }
        );

        const result = await validator.validateInputs(request, ctx);

        // Should not fail on chainId validation - result should be undefined (no error)
        // If there's an error, it should not be about unsupported chainId
        if (result?.error) {
          expect(result.error.message).not.toContain('Unsupported chainId');
        } else {
          // Result is undefined, meaning validation passed - this is expected for supported chains
          expect(result).toBeUndefined();
        }
      }
    });

    it('should handle large amounts correctly', async () => {
      const request = createValidRequest();
      request.amount = '999999999999999999999999999999999999999999999999';
      const mockChain = createMockChain(ChainId.MAINNET);

      vi.mocked(mockChainRepository.getChain).mockResolvedValue(mockChain);
      vi.mocked(mockTokenProvider.searchForToken).mockImplementation(
        async (chain, tokenRaw) => {
          if (tokenRaw === request.tokenInAddress) {
            return new CurrencyInfo(
              false,
              new Address('0x1111111111111111111111111111111111111111')
            );
          }
          return new CurrencyInfo(
            false,
            new Address('0x2222222222222222222222222222222222222222')
          );
        }
      );

      const result = await validator.validateInputs(request, ctx);

      expect(result).toBeUndefined();
    });

    it('should handle empty string amount as invalid', async () => {
      const request = createValidRequest();
      request.amount = '';

      const result = await validator.validateInputs(request, ctx);

      expect(result).toBeDefined();
      expect(result?.error).toBeDefined();
      expect(result?.error?.code).toBe(400);
      expect(result?.error?.message).toBe('Amount must be greater than zero');
    });
  });
});
