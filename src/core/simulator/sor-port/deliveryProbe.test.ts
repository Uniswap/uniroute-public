import {describe, expect, it} from 'vitest';
import {TradeType} from '../../../models/quote/TradeType';
import {DeliveryUnmeasuredReason} from '../ISimulator';
import {deliveryShortfallBps} from '../../simulatedDelivery';
import {DeliveryProbe, MULTICALL3_ADDRESS} from './deliveryProbe';
import fixture from './deliveryProbe.fixtures.json';
import exactOutFixture from './deliveryProbe.exactOut.fixtures.json';

// The recorded bundle: [Permit2 approve, router approve, balanceOf, swap, balanceOf]
const RECORDED_CALLS = fixture.blockStateCalls[0].calls;
const RECORDED_RESULTS = fixture.response[0].calls;
const BALANCE_BEFORE_INDEX = 2;
const BALANCE_AFTER_INDEX = 4;

const UINT256_ZERO = `0x${'0'.repeat(64)}`;
const asUint256 = (value: bigint) =>
  `0x${value.toString(16).padStart(64, '0')}`;

const OTHER_HOLDER = '0x2222222222222222222222222222222222222223';
const upperCased = (address: string) => `0x${address.slice(2).toUpperCase()}`;

const exactInProbe = (overrides: {
  recipient?: string;
  portionRecipients?: string[];
  tokenOutIsNative?: boolean;
}) =>
  DeliveryProbe.for({
    tradeType: TradeType.ExactIn,
    sender: fixture.sender,
    recipient: overrides.recipient,
    portionRecipients: overrides.portionRecipients ?? [],
    tokenInWrappedAddress: fixture.tokenIn,
    tokenInIsNative: false,
    tokenOutWrappedAddress: fixture.tokenOut,
    tokenOutIsNative: overrides.tokenOutIsNative ?? false,
  });

describe('DeliveryProbe', () => {
  it('reads the recipient output balance the way the recorded bundle did', () => {
    const probe = exactInProbe({recipient: fixture.sender});

    expect(probe.calls(fixture.sender)).toEqual([
      {
        from: fixture.sender,
        to: fixture.tokenOut,
        data: RECORDED_CALLS[BALANCE_BEFORE_INDEX].data,
      },
    ]);
  });

  it('measures what the recorded KGDS route delivered, 395 bp under the quoter', () => {
    const probe = exactInProbe({recipient: fixture.sender});

    const delivery = probe.measure(
      [RECORDED_RESULTS[BALANCE_BEFORE_INDEX].returnData],
      [RECORDED_RESULTS[BALANCE_AFTER_INDEX].returnData],
      BigInt(fixture.response[0].baseFeePerGas) > 0n,
      fixture.sender
    );

    expect(delivery).toEqual({
      kind: 'measured',
      amount: 7746655602286305109580n,
    });
    if (delivery.kind !== 'measured') return;
    expect(
      deliveryShortfallBps(
        TradeType.ExactIn,
        BigInt(fixture.quotedAmountOut),
        delivery.amount
      )
    ).toBe(395n);
    // Below the 150 bp under-delivery limit, so the check's probe reverts on it.
    const quoted = BigInt(fixture.quotedAmountOut);
    expect(delivery.amount < (quoted * (10_000n - 150n)) / 10_000n).toBe(true);
  });

  it('reads the sender when the router pays the sender', () => {
    const probe = exactInProbe({recipient: undefined});

    expect(probe.calls(fixture.sender)).toHaveLength(1);
    expect(probe.calls(fixture.sender)[0].data).toBe(
      RECORDED_CALLS[BALANCE_BEFORE_INDEX].data
    );
  });

  it('adds every portion recipient once, whatever the casing', () => {
    const probe = exactInProbe({
      recipient: fixture.sender,
      portionRecipients: [
        OTHER_HOLDER,
        upperCased(OTHER_HOLDER),
        upperCased(fixture.sender),
      ],
    });

    expect(probe.callCount).toBe(2);
    const delivery = probe.measure(
      [asUint256(100n), asUint256(5n)],
      [asUint256(1_100n), asUint256(15n)],
      false,
      fixture.sender
    );
    expect(delivery).toEqual({
      kind: 'measured',
      amount: 1_010n,
    });
  });

  it('reads a native output through Multicall3', () => {
    const probe = exactInProbe({
      recipient: fixture.sender,
      tokenOutIsNative: true,
    });

    expect(probe.calls(fixture.sender)).toEqual([
      {
        from: fixture.sender,
        to: MULTICALL3_ADDRESS,
        // cast calldata 'getEthBalance(address)' <sender>
        data: '0x4d2301cc0000000000000000000000001111111111111111111111111111111111111112',
      },
    ]);
  });

  it('nets the refund the router sends the recipient out of a recorded native exact-out', () => {
    // Recorded bundle: [sender ETH, recipient ETH, swap, sender ETH, recipient ETH, recipient USDG]
    const recordedCalls = exactOutFixture.blockStateCalls[0].calls;
    const recordedResults = exactOutFixture.response[0].calls;
    const probe = DeliveryProbe.for({
      tradeType: TradeType.ExactOut,
      sender: exactOutFixture.sender,
      recipient: exactOutFixture.recipient,
      portionRecipients: [],
      tokenInWrappedAddress: fixture.tokenIn,
      tokenInIsNative: true,
      tokenOutWrappedAddress: exactOutFixture.tokenOut,
      tokenOutIsNative: false,
    });

    expect(probe.calls(exactOutFixture.sender).map(call => call.data)).toEqual([
      recordedCalls[0].data,
      recordedCalls[1].data,
    ]);
    const delivery = probe.measure(
      [recordedResults[0].returnData, recordedResults[1].returnData],
      [recordedResults[3].returnData, recordedResults[4].returnData],
      BigInt(exactOutFixture.response[0].baseFeePerGas) > 0n,
      exactOutFixture.sender
    );

    expect(delivery).toEqual({
      kind: 'measured',
      amount: BigInt(exactOutFixture.quotedAmountIn),
    });
    if (delivery.kind !== 'measured') return;
    expect(
      deliveryShortfallBps(
        TradeType.ExactOut,
        BigInt(exactOutFixture.quotedAmountIn),
        delivery.amount
      )
    ).toBe(0n);
  });

  it('measures exact-out as the input the sender spent', () => {
    const probe = DeliveryProbe.for({
      tradeType: TradeType.ExactOut,
      sender: fixture.sender,
      recipient: OTHER_HOLDER,
      portionRecipients: [OTHER_HOLDER],
      tokenInWrappedAddress: fixture.tokenIn,
      tokenInIsNative: false,
      tokenOutWrappedAddress: fixture.tokenOut,
      tokenOutIsNative: false,
    });

    expect(probe.calls(fixture.sender)).toEqual([
      expect.objectContaining({to: fixture.tokenIn}),
      expect.objectContaining({to: fixture.tokenIn}),
    ]);
    // Sender spent 600, the recipient got 50 back.
    expect(
      probe.measure(
        [asUint256(1_000n), asUint256(0n)],
        [asUint256(400n), asUint256(50n)],
        false,
        fixture.sender
      )
    ).toEqual({kind: 'measured', amount: 550n});
  });

  it('is unmeasured when a read returns no balance, as on a chain without Multicall3', () => {
    const probe = exactInProbe({
      recipient: fixture.sender,
      tokenOutIsNative: true,
    });

    expect(
      probe.measure(['0x'], [asUint256(1n)], false, fixture.sender)
    ).toEqual({
      kind: 'unmeasured',
      reason: DeliveryUnmeasuredReason.BALANCE_READ_FAILED,
    });
    expect(
      probe.measure([undefined], [asUint256(1n)], false, fixture.sender)
    ).toEqual({
      kind: 'unmeasured',
      reason: DeliveryUnmeasuredReason.BALANCE_READ_FAILED,
    });
  });

  it('measures an exact-in swap that delivered nothing as zero, the full shortfall', () => {
    const probe = exactInProbe({recipient: fixture.sender});

    expect(
      probe.measure([UINT256_ZERO], [UINT256_ZERO], false, fixture.sender)
    ).toEqual({kind: 'measured', amount: 0n});
  });

  it('is unmeasured when the output balance fell, or an exact-out swap spent nothing', () => {
    const exactIn = exactInProbe({recipient: fixture.sender});
    const exactOut = DeliveryProbe.for({
      tradeType: TradeType.ExactOut,
      sender: fixture.sender,
      recipient: undefined,
      portionRecipients: [],
      tokenInWrappedAddress: fixture.tokenIn,
      tokenInIsNative: false,
      tokenOutWrappedAddress: fixture.tokenOut,
      tokenOutIsNative: false,
    });
    const unmeasured = {
      kind: 'unmeasured',
      reason: DeliveryUnmeasuredReason.NO_BALANCE_CHANGE,
    };

    expect(
      exactIn.measure([asUint256(5n)], [asUint256(1n)], false, fixture.sender)
    ).toEqual(unmeasured);
    expect(
      exactOut.measure([UINT256_ZERO], [UINT256_ZERO], false, fixture.sender)
    ).toEqual(unmeasured);
  });

  it('is unmeasured when gas was charged against a native balance of the sender', () => {
    const nativeToSender = exactInProbe({
      recipient: fixture.sender,
      tokenOutIsNative: true,
    });
    const nativeToOther = exactInProbe({
      recipient: OTHER_HOLDER,
      tokenOutIsNative: true,
    });

    expect(
      nativeToSender.measure(
        [asUint256(1n)],
        [asUint256(9n)],
        true,
        fixture.sender
      )
    ).toEqual({
      kind: 'unmeasured',
      reason: DeliveryUnmeasuredReason.GAS_CHARGED,
    });
    expect(
      nativeToOther.measure(
        [asUint256(1n)],
        [asUint256(9n)],
        true,
        fixture.sender
      )
    ).toEqual({kind: 'measured', amount: 8n});
  });
});
