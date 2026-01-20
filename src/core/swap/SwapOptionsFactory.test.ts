import {describe, it, expect} from 'vitest';
import {
  SwapOptionsFactory,
  SwapOptionsUniversalRouterInput,
} from './SwapOptionsFactory';
import {ChainId} from '../../lib/config';
import {TradeType} from '../../models/quote/TradeType';
import {UniversalRouterVersion} from '@uniswap/universal-router-sdk';
import {SwapType} from '../simulator/sor-port/simulation-provider';

describe('SwapOptionsFactory', () => {
  describe('createUniversalRouterOptions_2_0', () => {
    const baseInput: SwapOptionsUniversalRouterInput = {
      chainId: ChainId.MAINNET,
      tradeType: TradeType.ExactIn,
      amountIn: '1000000000000000000', // 1 ETH
      tokenInWrappedAddress: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
      slippageTolerance: '0.5',
    };

    it('should return undefined when slippageTolerance is not provided', () => {
      const input: SwapOptionsUniversalRouterInput = {
        ...baseInput,
        slippageTolerance: undefined,
      };

      const result = SwapOptionsFactory.createUniversalRouterOptions_2_0(input);

      expect(result).toBeUndefined();
    });

    it('should return undefined when slippageTolerance is empty string', () => {
      const input: SwapOptionsUniversalRouterInput = {
        ...baseInput,
        slippageTolerance: '',
      };

      const result = SwapOptionsFactory.createUniversalRouterOptions_2_0(input);

      expect(result).toBeUndefined();
    });

    it('should create basic swap options with slippage tolerance', () => {
      const result =
        SwapOptionsFactory.createUniversalRouterOptions_2_0(baseInput);

      expect(result).toBeDefined();
      expect(result!.type).toBe(SwapType.UNIVERSAL_ROUTER);
      expect(result!.version).toBe(UniversalRouterVersion.V2_0);
      expect(result!.slippageTolerance.toFixed(2)).toBe('0.50'); // 0.5%
    });

    it('should parse various slippage tolerance values correctly', () => {
      const testCases = [
        {slippage: '0.1', expected: '0.10'},
        {slippage: '0.5', expected: '0.50'},
        {slippage: '1', expected: '1.00'},
        {slippage: '1.25', expected: '1.25'},
        {slippage: '5', expected: '5.00'},
        {slippage: '10', expected: '10.00'},
      ];

      for (const {slippage, expected} of testCases) {
        const input = {...baseInput, slippageTolerance: slippage};
        const result =
          SwapOptionsFactory.createUniversalRouterOptions_2_0(input);
        expect(result!.slippageTolerance.toFixed(2)).toBe(expected);
      }
    });

    it('should set recipient when provided', () => {
      const input: SwapOptionsUniversalRouterInput = {
        ...baseInput,
        recipient: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
      };

      const result = SwapOptionsFactory.createUniversalRouterOptions_2_0(input);

      expect(result!.recipient).toBe(
        '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'
      );
    });

    it('should set deadline when provided', () => {
      const now = Math.floor(Date.now() / 1000);
      const input: SwapOptionsUniversalRouterInput = {
        ...baseInput,
        deadline: '1800', // 30 minutes
      };

      const result = SwapOptionsFactory.createUniversalRouterOptions_2_0(input);

      expect(result!.deadlineOrPreviousBlockhash).toBeDefined();
      expect(result!.deadlineOrPreviousBlockhash).toBeGreaterThan(now);
      expect(result!.deadlineOrPreviousBlockhash).toBeLessThanOrEqual(
        now + 1800 + 10
      ); // Allow 10 sec margin
    });

    it('should not set deadline when not provided', () => {
      const result =
        SwapOptionsFactory.createUniversalRouterOptions_2_0(baseInput);

      expect(result!.deadlineOrPreviousBlockhash).toBeUndefined();
    });

    it('should add permit data when all permit fields are provided', () => {
      const input: SwapOptionsUniversalRouterInput = {
        ...baseInput,
        permitSignature: '0x1234567890abcdef',
        permitNonce: '1',
        permitExpiration: '1700000000',
        permitAmount: '1000000000000000000',
        permitSigDeadline: '1700001000',
      };

      const result = SwapOptionsFactory.createUniversalRouterOptions_2_0(input);

      expect(result!.inputTokenPermit).toBeDefined();
      expect(result!.inputTokenPermit!.signature).toBe('0x1234567890abcdef');
      expect(result!.inputTokenPermit!.details.token).toBe(
        '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
      );
      expect(result!.inputTokenPermit!.details.amount).toBe(
        '1000000000000000000'
      );
      expect(result!.inputTokenPermit!.details.expiration).toBe('1700000000');
      expect(result!.inputTokenPermit!.details.nonce).toBe('1');
      expect(result!.inputTokenPermit!.sigDeadline).toBe('1700001000');
    });

    it('should not add permit data when some permit fields are missing', () => {
      // Missing permitSignature
      const input1: SwapOptionsUniversalRouterInput = {
        ...baseInput,
        permitNonce: '1',
        permitExpiration: '1700000000',
        permitAmount: '1000000000000000000',
        permitSigDeadline: '1700001000',
      };

      const result1 =
        SwapOptionsFactory.createUniversalRouterOptions_2_0(input1);
      expect(result1!.inputTokenPermit).toBeUndefined();

      // Missing permitNonce
      const input2: SwapOptionsUniversalRouterInput = {
        ...baseInput,
        permitSignature: '0x1234567890abcdef',
        permitExpiration: '1700000000',
        permitAmount: '1000000000000000000',
        permitSigDeadline: '1700001000',
      };

      const result2 =
        SwapOptionsFactory.createUniversalRouterOptions_2_0(input2);
      expect(result2!.inputTokenPermit).toBeUndefined();

      // Missing permitExpiration
      const input3: SwapOptionsUniversalRouterInput = {
        ...baseInput,
        permitSignature: '0x1234567890abcdef',
        permitNonce: '1',
        permitAmount: '1000000000000000000',
        permitSigDeadline: '1700001000',
      };

      const result3 =
        SwapOptionsFactory.createUniversalRouterOptions_2_0(input3);
      expect(result3!.inputTokenPermit).toBeUndefined();

      // Missing permitAmount
      const input4: SwapOptionsUniversalRouterInput = {
        ...baseInput,
        permitSignature: '0x1234567890abcdef',
        permitNonce: '1',
        permitExpiration: '1700000000',
        permitSigDeadline: '1700001000',
      };

      const result4 =
        SwapOptionsFactory.createUniversalRouterOptions_2_0(input4);
      expect(result4!.inputTokenPermit).toBeUndefined();

      // Missing permitSigDeadline
      const input5: SwapOptionsUniversalRouterInput = {
        ...baseInput,
        permitSignature: '0x1234567890abcdef',
        permitNonce: '1',
        permitExpiration: '1700000000',
        permitAmount: '1000000000000000000',
      };

      const result5 =
        SwapOptionsFactory.createUniversalRouterOptions_2_0(input5);
      expect(result5!.inputTokenPermit).toBeUndefined();
    });

    it('should add simulate option when simulateFromAddress is provided', () => {
      const input: SwapOptionsUniversalRouterInput = {
        ...baseInput,
        simulateFromAddress: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
      };

      const result = SwapOptionsFactory.createUniversalRouterOptions_2_0(input);

      expect(result!.simulate).toBeDefined();
      expect(result!.simulate!.fromAddress).toBe(
        '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'
      );
    });

    it('should not add simulate option when simulateFromAddress is not provided', () => {
      const result =
        SwapOptionsFactory.createUniversalRouterOptions_2_0(baseInput);

      expect(result!.simulate).toBeUndefined();
    });

    it('should handle portion fees for EXACT_INPUT', () => {
      const input: SwapOptionsUniversalRouterInput = {
        ...baseInput,
        tradeType: TradeType.ExactIn,
        portionBips: 100, // 1%
        portionRecipient: '0xFeeRecipient123456789012345678901234567890',
      };

      const result = SwapOptionsFactory.createUniversalRouterOptions_2_0(input);

      expect(result).toBeDefined();
      // The fee options should be populated based on portionUtils
    });

    it('should handle portion fees for EXACT_OUTPUT', () => {
      const input: SwapOptionsUniversalRouterInput = {
        ...baseInput,
        tradeType: TradeType.ExactOut,
        portionBips: 50, // 0.5%
        portionRecipient: '0xFeeRecipient123456789012345678901234567890',
      };

      const result = SwapOptionsFactory.createUniversalRouterOptions_2_0(input);

      expect(result).toBeDefined();
    });

    it('should work for different chain IDs', () => {
      const chainIds = [
        ChainId.MAINNET,
        ChainId.ARBITRUM,
        ChainId.OPTIMISM,
        ChainId.BASE,
        ChainId.POLYGON,
      ];

      for (const chainId of chainIds) {
        const input: SwapOptionsUniversalRouterInput = {
          ...baseInput,
          chainId,
          permitSignature: '0x1234567890abcdef',
          permitNonce: '1',
          permitExpiration: '1700000000',
          permitAmount: '1000000000000000000',
          permitSigDeadline: '1700001000',
        };

        const result =
          SwapOptionsFactory.createUniversalRouterOptions_2_0(input);

        expect(result).toBeDefined();
        expect(result!.inputTokenPermit).toBeDefined();
        // The spender address will be different per chain
      }
    });

    it('should handle full configuration with all options', () => {
      const input: SwapOptionsUniversalRouterInput = {
        chainId: ChainId.MAINNET,
        tradeType: TradeType.ExactIn,
        amountIn: '1000000000000000000',
        tokenInWrappedAddress: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        slippageTolerance: '0.5',
        portionBips: 100,
        portionRecipient: '0xFeeRecipient123456789012345678901234567890',
        deadline: '1800',
        recipient: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
        permitSignature: '0x1234567890abcdef',
        permitNonce: '1',
        permitExpiration: '1700000000',
        permitAmount: '1000000000000000000',
        permitSigDeadline: '1700001000',
        simulateFromAddress: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
      };

      const result = SwapOptionsFactory.createUniversalRouterOptions_2_0(input);

      expect(result).toBeDefined();
      expect(result!.type).toBe(SwapType.UNIVERSAL_ROUTER);
      expect(result!.version).toBe(UniversalRouterVersion.V2_0);
      expect(result!.recipient).toBe(
        '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'
      );
      expect(result!.deadlineOrPreviousBlockhash).toBeDefined();
      expect(result!.inputTokenPermit).toBeDefined();
      expect(result!.simulate).toBeDefined();
    });
  });
});
