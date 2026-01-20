import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {parseSlippageTolerance, parseDeadline} from './shared';
import {Percent} from '@uniswap/sdk-core';

describe('shared', () => {
  describe('parseSlippageTolerance', () => {
    it('should parse whole number percentages correctly', () => {
      const result1 = parseSlippageTolerance('1');
      expect(result1.toFixed(2)).toBe('1.00');

      const result5 = parseSlippageTolerance('5');
      expect(result5.toFixed(2)).toBe('5.00');

      const result10 = parseSlippageTolerance('10');
      expect(result10.toFixed(2)).toBe('10.00');
    });

    it('should parse decimal percentages correctly', () => {
      const result = parseSlippageTolerance('0.5');
      expect(result.toFixed(2)).toBe('0.50');
    });

    it('should parse percentages with 2 decimal places', () => {
      const result = parseSlippageTolerance('1.25');
      expect(result.toFixed(2)).toBe('1.25');

      const result2 = parseSlippageTolerance('0.01');
      expect(result2.toFixed(2)).toBe('0.01');

      const result3 = parseSlippageTolerance('2.99');
      expect(result3.toFixed(2)).toBe('2.99');
    });

    it('should handle zero slippage', () => {
      const result = parseSlippageTolerance('0');
      expect(result.toFixed(2)).toBe('0.00');
    });

    it('should return a Percent instance', () => {
      const result = parseSlippageTolerance('1');
      expect(result).toBeInstanceOf(Percent);
    });

    it('should handle very small slippage values', () => {
      const result = parseSlippageTolerance('0.01');
      expect(result.toFixed(2)).toBe('0.01');
    });

    it('should handle large slippage values', () => {
      const result = parseSlippageTolerance('50');
      expect(result.toFixed(2)).toBe('50.00');

      const result100 = parseSlippageTolerance('100');
      expect(result100.toFixed(2)).toBe('100.00');
    });

    it('should round to nearest basis point for 3+ decimal places', () => {
      // 1.234% should round to 1.23% (123 basis points)
      const result = parseSlippageTolerance('1.234');
      // Due to Math.round: 1.234 * 100 = 123.4 -> rounds to 123 -> 123/10000 = 0.0123 = 1.23%
      expect(result.toFixed(2)).toBe('1.23');

      // 1.235% should round to 1.24% (124 basis points)
      const result2 = parseSlippageTolerance('1.235');
      // 1.235 * 100 = 123.5 -> rounds to 124 -> 124/10000 = 0.0124 = 1.24%
      expect(result2.toFixed(2)).toBe('1.24');
    });

    it('should use numerator/denominator representation', () => {
      const result = parseSlippageTolerance('1');
      // 1% = 100/10000
      expect(result.numerator.toString()).toBe('100');
      expect(result.denominator.toString()).toBe('10000');

      const result2 = parseSlippageTolerance('0.5');
      // 0.5% = 50/10000
      expect(result2.numerator.toString()).toBe('50');
      expect(result2.denominator.toString()).toBe('10000');
    });
  });

  describe('parseDeadline', () => {
    const mockTimestamp = 1700000000000; // Fixed timestamp for testing

    beforeEach(() => {
      vi.spyOn(Date, 'now').mockReturnValue(mockTimestamp);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should add deadline seconds to current timestamp', () => {
      const result = parseDeadline('1800'); // 30 minutes

      // Current time in seconds + 1800
      const expectedDeadline = Math.floor(mockTimestamp / 1000) + 1800;
      expect(result).toBe(expectedDeadline);
    });

    it('should handle zero deadline', () => {
      const result = parseDeadline('0');

      const expectedDeadline = Math.floor(mockTimestamp / 1000);
      expect(result).toBe(expectedDeadline);
    });

    it('should handle small deadline values', () => {
      const result = parseDeadline('60'); // 1 minute

      const expectedDeadline = Math.floor(mockTimestamp / 1000) + 60;
      expect(result).toBe(expectedDeadline);
    });

    it('should handle large deadline values', () => {
      const result = parseDeadline('86400'); // 24 hours

      const expectedDeadline = Math.floor(mockTimestamp / 1000) + 86400;
      expect(result).toBe(expectedDeadline);
    });

    it('should return a number (Unix timestamp)', () => {
      const result = parseDeadline('300');

      expect(typeof result).toBe('number');
      expect(Number.isInteger(result)).toBe(true);
    });

    it('should parse string deadline correctly', () => {
      // Various string formats
      const testCases = [
        {input: '300', expected: 300},
        {input: '600', expected: 600},
        {input: '1200', expected: 1200},
        {input: '3600', expected: 3600},
      ];

      const baseTimestamp = Math.floor(mockTimestamp / 1000);

      for (const {input, expected} of testCases) {
        const result = parseDeadline(input);
        expect(result).toBe(baseTimestamp + expected);
      }
    });

    it('should handle decimal deadline (parseInt behavior)', () => {
      // parseInt will truncate decimals
      const result = parseDeadline('300.9');
      const expectedDeadline = Math.floor(mockTimestamp / 1000) + 300;
      expect(result).toBe(expectedDeadline);
    });

    it('should handle negative deadline strings', () => {
      // Negative deadline would result in past timestamp
      const result = parseDeadline('-60');
      const expectedDeadline = Math.floor(mockTimestamp / 1000) - 60;
      expect(result).toBe(expectedDeadline);
    });
  });
});
