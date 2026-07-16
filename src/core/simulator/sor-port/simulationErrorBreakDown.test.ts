import {describe, it, expect} from 'vitest';
import {breakDownSimulationError} from './simulationErrorBreakDown';
import {SimulationStatus} from '../ISimulator';
import {VIRTUAL_BASE} from '../../../lib/tokenUtils';

const USDC_ADDRESS = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const WETH_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

// V4TooLittleReceived(uint256 minAmountOutReceived, uint256 amountReceived)
// with minAmountOutReceived=1000000, amountReceived=999999
const V4_TOO_LITTLE_RECEIVED_WITH_ARGS =
  '0x8b063d73' +
  '00000000000000000000000000000000000000000000000000000000000f4240' +
  '00000000000000000000000000000000000000000000000000000000000f423f';

// V2TooLittleReceivedPerHop(uint256 hopIndex, uint256 minPrice, uint256 price)
const V2_TOO_LITTLE_RECEIVED_PER_HOP_WITH_ARGS =
  '0x65d564a5' +
  '0000000000000000000000000000000000000000000000000000000000000001' +
  '00000000000000000000000000000000000000000000000000000000000f4240' +
  '00000000000000000000000000000000000000000000000000000000000f423f';

const INSUFFICIENT_OUTPUT_AMOUNT_PAYLOAD =
  '0x08c379a000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000025556e697377617056323a20494e53554646494349454e545f4f55545055545f414d4f554e54000000000000000000000000000000000000000000000000000000';
const IIA_PAYLOAD =
  '0x08c379a0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000034949410000000000000000000000000000000000000000000000000000000000';
const TRANSFER_FROM_FAILED_PAYLOAD =
  '0x08c379a0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000145452414e534645525f46524f4d5f4641494c4544000000000000000000000000';

describe('breakDownSimulationError', () => {
  describe('slippage selectors', () => {
    it.each([
      ['0x849eaf98', 'V2TooLittleReceived()'],
      ['0x8ab0bc16', 'V2TooMuchRequested()'],
      ['0x65d564a5', 'V2TooLittleReceivedPerHop(uint256,uint256,uint256)'],
      ['0x39d35496', 'V3TooLittleReceived()'],
      ['0x739dbe52', 'V3TooMuchRequested()'],
      ['0x8b063d73', 'V4TooLittleReceived(uint256,uint256)'],
      ['0x12bacdd3', 'V4TooMuchRequested(uint256,uint256)'],
      ['0x4713c18b', 'V4TooLittleReceivedPerHopSingle(uint256,uint256)'],
      ['0xefc8d8eb', 'V4TooMuchRequestedPerHopSingle(uint256,uint256)'],
    ])('classifies bare selector %s (%s) as SLIPPAGE_TOO_LOW', selector => {
      expect(
        breakDownSimulationError(USDC_ADDRESS, WETH_ADDRESS, selector)
      ).toBe(SimulationStatus.SLIPPAGE_TOO_LOW);
    });

    it('classifies V4TooLittleReceived with encoded args as SLIPPAGE_TOO_LOW', () => {
      expect(
        breakDownSimulationError(
          USDC_ADDRESS,
          WETH_ADDRESS,
          V4_TOO_LITTLE_RECEIVED_WITH_ARGS
        )
      ).toBe(SimulationStatus.SLIPPAGE_TOO_LOW);
    });

    it('classifies V2TooLittleReceivedPerHop with encoded args as SLIPPAGE_TOO_LOW', () => {
      expect(
        breakDownSimulationError(
          USDC_ADDRESS,
          WETH_ADDRESS,
          V2_TOO_LITTLE_RECEIVED_PER_HOP_WITH_ARGS
        )
      ).toBe(SimulationStatus.SLIPPAGE_TOO_LOW);
    });

    it('matches selectors case-insensitively', () => {
      expect(
        breakDownSimulationError(
          USDC_ADDRESS,
          WETH_ADDRESS,
          '0x8B063D73' +
            '00000000000000000000000000000000000000000000000000000000000F4240' +
            '00000000000000000000000000000000000000000000000000000000000F423F'
        )
      ).toBe(SimulationStatus.SLIPPAGE_TOO_LOW);
    });
  });

  describe('Error(string) payloads', () => {
    it('classifies UniswapV2 INSUFFICIENT_OUTPUT_AMOUNT as SLIPPAGE_TOO_LOW', () => {
      expect(
        breakDownSimulationError(
          USDC_ADDRESS,
          WETH_ADDRESS,
          INSUFFICIENT_OUTPUT_AMOUNT_PAYLOAD
        )
      ).toBe(SimulationStatus.SLIPPAGE_TOO_LOW);
    });

    it('classifies IIA as SLIPPAGE_TOO_LOW', () => {
      expect(
        breakDownSimulationError(USDC_ADDRESS, WETH_ADDRESS, IIA_PAYLOAD)
      ).toBe(SimulationStatus.SLIPPAGE_TOO_LOW);
    });

    it('classifies TRANSFER_FROM_FAILED as TRANSFER_FROM_FAILED', () => {
      expect(
        breakDownSimulationError(
          USDC_ADDRESS,
          WETH_ADDRESS,
          TRANSFER_FROM_FAILED_PAYLOAD
        )
      ).toBe(SimulationStatus.TRANSFER_FROM_FAILED);
    });

    it('returns FAILED for an unrecognized Error(string) payload', () => {
      expect(
        breakDownSimulationError(
          USDC_ADDRESS,
          WETH_ADDRESS,
          '0x08c379a00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000b736f6d65206572726f72000000000000000000000000000000000000000000000000'
        )
      ).toBe(SimulationStatus.FAILED);
    });
  });

  describe('InsufficientToken', () => {
    it('classifies InsufficientToken as SLIPPAGE_TOO_LOW when trading VIRTUAL', () => {
      expect(
        breakDownSimulationError(
          VIRTUAL_BASE.address,
          WETH_ADDRESS,
          '0x675cae38'
        )
      ).toBe(SimulationStatus.SLIPPAGE_TOO_LOW);
      expect(
        breakDownSimulationError(
          USDC_ADDRESS,
          VIRTUAL_BASE.address.toLowerCase(),
          '0x675cae38'
        )
      ).toBe(SimulationStatus.SLIPPAGE_TOO_LOW);
    });

    it('returns FAILED for InsufficientToken on other pairs', () => {
      expect(
        breakDownSimulationError(USDC_ADDRESS, WETH_ADDRESS, '0x675cae38')
      ).toBe(SimulationStatus.FAILED);
    });
  });

  describe('fallbacks', () => {
    it('returns FAILED when no data is present', () => {
      expect(
        breakDownSimulationError(USDC_ADDRESS, WETH_ADDRESS, undefined)
      ).toBe(SimulationStatus.FAILED);
      expect(breakDownSimulationError(USDC_ADDRESS, WETH_ADDRESS, '')).toBe(
        SimulationStatus.FAILED
      );
    });

    it('returns FAILED for an unknown selector', () => {
      expect(
        breakDownSimulationError(USDC_ADDRESS, WETH_ADDRESS, '0xdeadbeef')
      ).toBe(SimulationStatus.FAILED);
    });

    it('returns FAILED for truncated data', () => {
      expect(breakDownSimulationError(USDC_ADDRESS, WETH_ADDRESS, '0x')).toBe(
        SimulationStatus.FAILED
      );
    });
  });
});
