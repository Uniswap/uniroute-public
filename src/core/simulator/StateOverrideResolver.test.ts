import {describe, expect, it, vi} from 'vitest';
import {Context} from '@uniswap/lib-uni/context';
import {
  RawStateOverride,
  StateOverride,
  TokenBalanceOverride,
} from '../../../gen/uniroute/v1/api_pb';
import {ChainId} from '../../lib/config';
import {NATIVE_TOKEN_SENTINEL} from './TokenBalanceSlotResolver';
import {StateOverrideResolver} from './StateOverrideResolver';

function fakeCtx(): Context {
  return {
    logger: {info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn()},
    metrics: {count: vi.fn(), dist: vi.fn()},
  } as unknown as Context;
}

const SLOT =
  '0x0000000000000000000000000000000000000000000000000000000000000005';
const VAL =
  '0x0000000000000000000000000000000000000000000000000000000000000001';

describe('StateOverrideResolver', () => {
  it('dispatches TokenBalanceOverride (native) to a balance entry', async () => {
    const r = new StateOverrideResolver();
    const out = await r.resolve(
      [
        new StateOverride({
          kind: {
            case: 'tokenBalance',
            value: new TokenBalanceOverride({
              tokenAddress: NATIVE_TOKEN_SENTINEL,
              accountAddress: '0x000000000000000000000000000000000000dEaD',
              amount: '42',
            }),
          },
        }),
      ],
      ChainId.MAINNET,
      fakeCtx()
    );
    expect(out.failedCount).toBe(0);
    expect(out.resolved).toHaveLength(1);
    expect(out.resolved[0].balance).toBe(42n);
    expect(out.resolved[0].stateDiff).toBeUndefined();
  });

  it('dispatches TokenBalanceOverride (ERC-20 with client-supplied slot) to a stateDiff entry', async () => {
    const r = new StateOverrideResolver();
    const out = await r.resolve(
      [
        new StateOverride({
          kind: {
            case: 'tokenBalance',
            value: new TokenBalanceOverride({
              tokenAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
              accountAddress: '0x000000000000000000000000000000000000dEaD',
              amount: '7',
              balanceMappingSlot: '9', // e.g. USDC layout
            }),
          },
        }),
      ],
      ChainId.MAINNET,
      fakeCtx()
    );
    expect(out.failedCount).toBe(0);
    expect(out.resolved).toHaveLength(1);
    expect(out.resolved[0].stateDiff?.size).toBe(1);
    expect(out.resolved[0].balance).toBeUndefined();
  });

  it('reports failedCount + structured warn when an ERC-20 TokenBalanceOverride omits balanceMappingSlot', async () => {
    const r = new StateOverrideResolver();
    const ctx = fakeCtx();
    const out = await r.resolve(
      [
        new StateOverride({
          kind: {
            case: 'tokenBalance',
            value: new TokenBalanceOverride({
              tokenAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
              accountAddress: '0x000000000000000000000000000000000000dEaD',
              amount: '7',
              // balanceMappingSlot omitted — required for ERC-20
            }),
          },
        }),
      ],
      ChainId.MAINNET,
      ctx
    );
    expect(out.resolved).toHaveLength(0);
    expect(out.failedCount).toBe(1);
    expect(ctx.metrics.count).toHaveBeenCalledWith(
      'StateOverride.ResolveFailed',
      1,
      expect.objectContaining({
        tags: expect.arrayContaining([
          'chain:1',
          'kind:tokenBalance',
          'reason:missing_slot',
        ]),
      })
    );
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      'STATE_OVERRIDE_NOT_APPLIED',
      expect.objectContaining({
        index: 0,
        kind: 'tokenBalance',
        reason: 'missing_slot',
        chainId: ChainId.MAINNET,
      })
    );
  });

  it('dispatches RawStateOverride preserving stateDiff + codeOverride', async () => {
    const r = new StateOverrideResolver();
    const out = await r.resolve(
      [
        new StateOverride({
          kind: {
            case: 'rawState',
            value: new RawStateOverride({
              contractAddress: '0x1111111111111111111111111111111111111111',
              stateDiff: {[SLOT]: VAL},
              codeOverride: '0xdead',
            }),
          },
        }),
      ],
      ChainId.MAINNET,
      fakeCtx()
    );
    expect(out.resolved).toHaveLength(1);
    expect(out.resolved[0].codeOverride).toBe('0xdead');
    expect(out.resolved[0].stateDiff?.get(SLOT)).toBe(VAL);
  });

  it('warns on a StateOverride with no kind set (unimplemented variant guard)', async () => {
    const r = new StateOverrideResolver();
    const ctx = fakeCtx();
    const out = await r.resolve(
      [new StateOverride()], // kind unset
      ChainId.MAINNET,
      ctx
    );
    expect(out.resolved).toHaveLength(0);
    expect(out.failedCount).toBe(1);
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      'STATE_OVERRIDE_NOT_APPLIED',
      expect.objectContaining({
        index: 0,
        kind: 'unset',
        reason: 'unimplemented_kind',
      })
    );
    expect(ctx.metrics.count).toHaveBeenCalledWith(
      'StateOverride.ResolveFailed',
      1,
      expect.objectContaining({
        tags: expect.arrayContaining([
          'kind:unset',
          'reason:unimplemented_kind',
        ]),
      })
    );
  });

  it('counts failures separately from resolved, returns both halves', async () => {
    const r = new StateOverrideResolver();
    const ctx = fakeCtx();
    const out = await r.resolve(
      [
        new StateOverride({
          kind: {
            case: 'tokenBalance',
            value: new TokenBalanceOverride({
              tokenAddress: NATIVE_TOKEN_SENTINEL,
              accountAddress: '0x000000000000000000000000000000000000dEaD',
              amount: '-1', // invalid
            }),
          },
        }),
        new StateOverride({
          kind: {
            case: 'tokenBalance',
            value: new TokenBalanceOverride({
              tokenAddress: NATIVE_TOKEN_SENTINEL,
              accountAddress: '0x000000000000000000000000000000000000dEaD',
              amount: '5',
            }),
          },
        }),
      ],
      ChainId.MAINNET,
      ctx
    );
    expect(out.resolved).toHaveLength(1);
    expect(out.resolved[0].balance).toBe(5n);
    expect(out.failedCount).toBe(1);
    expect(ctx.metrics.count).toHaveBeenCalledWith(
      'StateOverride.ResolveFailed',
      1,
      expect.objectContaining({
        tags: expect.arrayContaining(['chain:1']),
      })
    );
  });
});
