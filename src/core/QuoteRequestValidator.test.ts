import {describe, expect, it, beforeEach, vi} from 'vitest';

import {
  QuoteRequest,
  RawStateOverride,
  StateOverride,
  TokenBalanceOverride,
} from '../../gen/uniroute/v1/api_pb';
import {QuoteRequestValidator} from './QuoteRequestValidator';
import {IChainRepository} from '../stores/chain/IChainRepository';
import {ITokenProvider} from '../stores/token/provider/TokenProvider';
import {Chain} from '../models/chain/Chain';
import {Address} from '../models/address/Address';
import {CurrencyInfo} from '../models/currency/CurrencyInfo';
import {buildTestContext} from '@uniswap/lib-testhelpers';
import {Context} from '@uniswap/lib-uni/context';
import {ChainId, SUPPORTED_CHAINS} from '../lib/config';
import {Protocol} from '../models/pool/Protocol';

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
      mockTokenProvider,
      [ChainId.MAINNET, ChainId.BASE, ChainId.SEPOLIA]
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
      request.protocols = Protocol.MIXED;

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

    describe('stateOverrides', () => {
      const VALID_SLOT =
        '0x0000000000000000000000000000000000000000000000000000000000000005';
      const VALID_VALUE =
        '0x0000000000000000000000000000000000000000000000000000000000000001';

      function setupValidChain() {
        const mockChain = createMockChain(ChainId.MAINNET);
        vi.mocked(mockChainRepository.getChain).mockResolvedValue(mockChain);
        vi.mocked(mockTokenProvider.searchForToken).mockImplementation(
          async (chain, tokenRaw) => {
            if (tokenRaw === '0x1111111111111111111111111111111111111111') {
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
      }

      it('accepts a well-formed TokenBalanceOverride + RawStateOverride pair', async () => {
        setupValidChain();
        const request = createValidRequest();
        request.stateOverrides = [
          new StateOverride({
            kind: {
              case: 'tokenBalance',
              value: new TokenBalanceOverride({
                tokenAddress: '0x0000000000000000000000000000000000000000',
                accountAddress: '0x000000000000000000000000000000000000dEaD',
                amount: '1000',
              }),
            },
          }),
          new StateOverride({
            kind: {
              case: 'rawState',
              value: new RawStateOverride({
                contractAddress: '0x3333333333333333333333333333333333333333',
                stateDiff: {[VALID_SLOT]: VALID_VALUE},
                codeOverride: '0x60aa',
              }),
            },
          }),
        ];

        const result = await validator.validateInputs(request, ctx);
        expect(result).toBeUndefined();
      });

      it('rejects stateOverrides on an unsupported chain', async () => {
        // Validator was constructed with [MAINNET, BASE, SEPOLIA] as the
        // override-supported allowlist; POLYGON is outside it. Even a
        // perfectly well-formed override bundle must be rejected so we
        // don't route it into a sim backend that can't apply overrides.
        const mockChain = createMockChain(ChainId.POLYGON);
        vi.mocked(mockChainRepository.getChain).mockResolvedValue(mockChain);
        const request = createValidRequest();
        request.tokenInChainId = ChainId.POLYGON;
        request.tokenOutChainId = ChainId.POLYGON;
        request.stateOverrides = [
          new StateOverride({
            kind: {
              case: 'tokenBalance',
              value: new TokenBalanceOverride({
                tokenAddress: '0x0000000000000000000000000000000000000000',
                accountAddress: '0x000000000000000000000000000000000000dEaD',
                amount: '1',
              }),
            },
          }),
        ];
        const result = await validator.validateInputs(request, ctx);
        expect(result?.error?.code).toBe(400);
        expect(result?.error?.message).toMatch(/not supported on chainId/);
      });

      it('rejects ERC-20 TokenBalanceOverride on mainnet ETH input (broadened rule — any tokenBalance fails)', async () => {
        // ALL TokenBalanceOverride entries are rejected on mainnet ETH
        // input, not just native ones. ERC-20 balance overrides credit
        // the swapper's slot, but the simulator runs as BEACON so the
        // override is wasted regardless of token kind.
        setupValidChain();
        const request = createValidRequest();
        request.tokenInAddress = 'ETH';
        request.stateOverrides = [
          new StateOverride({
            kind: {
              case: 'tokenBalance',
              value: new TokenBalanceOverride({
                // ERC-20 (USDC) — not native.
                tokenAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
                accountAddress: '0x000000000000000000000000000000000000dEaD',
                amount: '1000000',
                balanceMappingSlot: '9',
              }),
            },
          }),
        ];
        const result = await validator.validateInputs(request, ctx);
        expect(result?.error?.code).toBe(400);
        expect(result?.error?.message).toMatch(/BEACON_CHAIN_DEPOSIT_ADDRESS/);
      });

      it('rejects native TokenBalanceOverride on mainnet ETH input (zero address form)', async () => {
        // BEACON_CHAIN_DEPOSIT_ADDRESS substitution on mainnet ETH input
        // means simulation never reads the swapper's native balance.
        // Accepting this combination would either falsely reject pre-sim
        // (override < needed) or falsely succeed (override >= needed)
        // without the override actually applying. Surface at the API.
        setupValidChain();
        const request = createValidRequest();
        request.tokenInAddress = '0x0000000000000000000000000000000000000000';
        request.stateOverrides = [
          new StateOverride({
            kind: {
              case: 'tokenBalance',
              value: new TokenBalanceOverride({
                tokenAddress: '0x0000000000000000000000000000000000000000',
                accountAddress: '0x000000000000000000000000000000000000dEaD',
                amount: '1000000000000000000',
              }),
            },
          }),
        ];
        const result = await validator.validateInputs(request, ctx);
        expect(result?.error?.code).toBe(400);
        expect(result?.error?.message).toMatch(/BEACON_CHAIN_DEPOSIT_ADDRESS/);
      });

      it('rejects native TokenBalanceOverride on mainnet ETH input (symbol form)', async () => {
        // The API also accepts the native-currency symbol as
        // `tokenInAddress`. The guard must catch both forms — clients
        // commonly send `"ETH"` rather than the zero address.
        setupValidChain();
        const request = createValidRequest();
        request.tokenInAddress = 'ETH';
        request.stateOverrides = [
          new StateOverride({
            kind: {
              case: 'tokenBalance',
              value: new TokenBalanceOverride({
                tokenAddress: '0x0000000000000000000000000000000000000000',
                accountAddress: '0x000000000000000000000000000000000000dEaD',
                amount: '1000000000000000000',
              }),
            },
          }),
        ];
        const result = await validator.validateInputs(request, ctx);
        expect(result?.error?.code).toBe(400);
        expect(result?.error?.message).toMatch(/BEACON_CHAIN_DEPOSIT_ADDRESS/);
      });

      it('allows native TokenBalanceOverride on non-mainnet (e.g. Sepolia)', async () => {
        // Sepolia: swapper is always `from`, so native overrides are
        // real. Must not be caught by the mainnet-specific guard.
        const mockChain = createMockChain(ChainId.SEPOLIA);
        vi.mocked(mockChainRepository.getChain).mockResolvedValue(mockChain);
        vi.mocked(mockTokenProvider.searchForToken).mockImplementation(
          async (chain, tokenRaw) => {
            return new CurrencyInfo(
              tokenRaw === '0x0000000000000000000000000000000000000000',
              new Address(
                tokenRaw === '0x0000000000000000000000000000000000000000'
                  ? '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14'
                  : '0x2222222222222222222222222222222222222222'
              )
            );
          }
        );
        const request = createValidRequest();
        request.tokenInChainId = ChainId.SEPOLIA;
        request.tokenOutChainId = ChainId.SEPOLIA;
        request.tokenInAddress = '0x0000000000000000000000000000000000000000';
        request.stateOverrides = [
          new StateOverride({
            kind: {
              case: 'tokenBalance',
              value: new TokenBalanceOverride({
                tokenAddress: '0x0000000000000000000000000000000000000000',
                accountAddress: '0x000000000000000000000000000000000000dEaD',
                amount: '1000000000000000000',
              }),
            },
          }),
        ];
        const result = await validator.validateInputs(request, ctx);
        expect(result).toBeUndefined();
      });

      it('allows native TokenBalanceOverride on mainnet ERC-20 input', async () => {
        // Mainnet ERC-20 input: swapper is still `from` (no BEACON swap),
        // so a native override on the swapper is real (e.g. fund gas).
        setupValidChain();
        const request = createValidRequest();
        // tokenInAddress is a non-native ERC-20 (already set non-native
        // by createValidRequest with 0x1111...).
        request.stateOverrides = [
          new StateOverride({
            kind: {
              case: 'tokenBalance',
              value: new TokenBalanceOverride({
                tokenAddress: '0x0000000000000000000000000000000000000000',
                accountAddress: '0x000000000000000000000000000000000000dEaD',
                amount: '1000000000000000000',
              }),
            },
          }),
        ];
        const result = await validator.validateInputs(request, ctx);
        expect(result).toBeUndefined();
      });

      it('rejects duplicate (token, account) across TokenBalanceOverride entries', async () => {
        // Even with different balanceMappingSlot values, two entries
        // targeting the same logical balance are ambiguous: only one
        // slot is the token's real balance slot, and the pre-sim guard
        // would pick a candidate by request order. Force the client to
        // collapse the ambiguity.
        setupValidChain();
        const request = createValidRequest();
        const sharedToken = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
        const sharedAccount = '0x000000000000000000000000000000000000dEaD';
        request.stateOverrides = [
          new StateOverride({
            kind: {
              case: 'tokenBalance',
              value: new TokenBalanceOverride({
                tokenAddress: sharedToken,
                accountAddress: sharedAccount,
                amount: '1000',
                balanceMappingSlot: '5',
              }),
            },
          }),
          new StateOverride({
            kind: {
              case: 'tokenBalance',
              value: new TokenBalanceOverride({
                tokenAddress: sharedToken,
                accountAddress: sharedAccount,
                amount: '2000',
                balanceMappingSlot: '10',
              }),
            },
          }),
        ];
        const result = await validator.validateInputs(request, ctx);
        expect(result?.error?.code).toBe(400);
        expect(result?.error?.message).toMatch(/Multiple TokenBalanceOverride/);
      });

      it('rejects an empty RawStateOverride (no stateDiff and no codeOverride)', async () => {
        // A rawState entry with valid contractAddress but no actual
        // state writes is a no-op that would still flip override-path
        // gating (skipping the eth_estimateGas fast path, etc.) for no
        // semantic effect. Reject so clients don't pay latency for an
        // empty payload.
        setupValidChain();
        const request = createValidRequest();
        request.stateOverrides = [
          new StateOverride({
            kind: {
              case: 'rawState',
              value: new RawStateOverride({
                contractAddress: '0x3333333333333333333333333333333333333333',
                // stateDiff and codeOverride both omitted.
              }),
            },
          }),
        ];
        const result = await validator.validateInputs(request, ctx);
        expect(result?.error?.code).toBe(400);
        expect(result?.error?.message).toMatch(
          /at least one stateDiff entry or a codeOverride/
        );
      });

      it('rejects > 16 entries', async () => {
        setupValidChain();
        const request = createValidRequest();
        request.stateOverrides = Array.from(
          {length: 17},
          () =>
            new StateOverride({
              kind: {
                case: 'tokenBalance',
                value: new TokenBalanceOverride({
                  tokenAddress: '0x0000000000000000000000000000000000000000',
                  accountAddress: '0x000000000000000000000000000000000000dEaD',
                  amount: '1',
                }),
              },
            })
        );
        const result = await validator.validateInputs(request, ctx);
        expect(result?.error?.message).toMatch(/exceeds max of 16/);
      });

      it('rejects invalid hex slot in RawStateOverride.stateDiff', async () => {
        setupValidChain();
        const request = createValidRequest();
        request.stateOverrides = [
          new StateOverride({
            kind: {
              case: 'rawState',
              value: new RawStateOverride({
                contractAddress: '0x3333333333333333333333333333333333333333',
                stateDiff: {'0xnothex': VALID_VALUE},
              }),
            },
          }),
        ];
        const result = await validator.validateInputs(request, ctx);
        expect(result?.error?.message).toMatch(/slot must be 32-byte hex/);
      });

      it('rejects codeOverride larger than the contract size cap', async () => {
        setupValidChain();
        const request = createValidRequest();
        // Over 24KB + 0x prefix.
        const tooLarge = '0x' + 'aa'.repeat(24577);
        request.stateOverrides = [
          new StateOverride({
            kind: {
              case: 'rawState',
              value: new RawStateOverride({
                contractAddress: '0x3333333333333333333333333333333333333333',
                stateDiff: {},
                codeOverride: tooLarge,
              }),
            },
          }),
        ];
        const result = await validator.validateInputs(request, ctx);
        expect(result?.error?.message).toMatch(/exceeds max byte size/);
      });

      it('rejects balanceMappingSlot above uint256 max', async () => {
        setupValidChain();
        const request = createValidRequest();
        request.stateOverrides = [
          new StateOverride({
            kind: {
              case: 'tokenBalance',
              value: new TokenBalanceOverride({
                tokenAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
                accountAddress: '0x000000000000000000000000000000000000dEaD',
                amount: '1',
                balanceMappingSlot: (1n << 256n).toString(),
              }),
            },
          }),
        ];
        const result = await validator.validateInputs(request, ctx);
        expect(result?.error?.message).toMatch(/uint256/);
      });

      it('requires balanceMappingSlot for ERC-20 TokenBalanceOverride', async () => {
        setupValidChain();
        const request = createValidRequest();
        request.stateOverrides = [
          new StateOverride({
            kind: {
              case: 'tokenBalance',
              value: new TokenBalanceOverride({
                tokenAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
                accountAddress: '0x000000000000000000000000000000000000dEaD',
                amount: '1',
                // balanceMappingSlot omitted
              }),
            },
          }),
        ];
        const result = await validator.validateInputs(request, ctx);
        expect(result?.error?.message).toMatch(
          /balanceMappingSlot is required/
        );
      });

      it('rejects amounts above uint256 max', async () => {
        setupValidChain();
        const request = createValidRequest();
        const overUint256 = (1n << 256n).toString();
        request.stateOverrides = [
          new StateOverride({
            kind: {
              case: 'tokenBalance',
              value: new TokenBalanceOverride({
                tokenAddress: '0x0000000000000000000000000000000000000000',
                accountAddress: '0x000000000000000000000000000000000000dEaD',
                amount: overUint256,
              }),
            },
          }),
        ];
        const result = await validator.validateInputs(request, ctx);
        expect(result?.error?.message).toMatch(/uint256/);
      });

      it('rejects pathologically long amount strings', async () => {
        setupValidChain();
        const request = createValidRequest();
        request.stateOverrides = [
          new StateOverride({
            kind: {
              case: 'tokenBalance',
              value: new TokenBalanceOverride({
                tokenAddress: '0x0000000000000000000000000000000000000000',
                accountAddress: '0x000000000000000000000000000000000000dEaD',
                amount: '1'.repeat(81),
              }),
            },
          }),
        ];
        const result = await validator.validateInputs(request, ctx);
        expect(result?.error?.message).toMatch(/at most 80 digits/);
      });

      it('rejects invalid addresses on TokenBalanceOverride', async () => {
        setupValidChain();
        const request = createValidRequest();
        request.stateOverrides = [
          new StateOverride({
            kind: {
              case: 'tokenBalance',
              value: new TokenBalanceOverride({
                tokenAddress: 'not-an-address',
                accountAddress: '0x000000000000000000000000000000000000dEaD',
                amount: '1',
              }),
            },
          }),
        ];
        const result = await validator.validateInputs(request, ctx);
        expect(result?.error?.message).toMatch(/must be a valid address/);
      });
    });
  });
});
