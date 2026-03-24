import {describe, it, expect} from 'vitest';
import {withTimeout} from './withTimeout';

describe('withTimeout', () => {
  it('resolves when promise completes before timeout', async () => {
    const result = await withTimeout(Promise.resolve(42), 1000);
    expect(result).toBe(42);
  });

  it('rejects when promise exceeds timeout', async () => {
    const slowPromise = new Promise<number>(resolve =>
      setTimeout(() => resolve(42), 500)
    );
    await expect(withTimeout(slowPromise, 50, 'test')).rejects.toThrow(
      'Timeout after 50ms [test]'
    );
  });

  it('rejects with original error if promise fails before timeout', async () => {
    const failingPromise = Promise.reject(new Error('original error'));
    await expect(withTimeout(failingPromise, 1000)).rejects.toThrow(
      'original error'
    );
  });

  it('includes label in timeout error message', async () => {
    const slowPromise = new Promise<void>(() => {});
    await expect(withTimeout(slowPromise, 10, 'myLabel')).rejects.toThrow(
      '[myLabel]'
    );
  });

  it('works without label', async () => {
    const slowPromise = new Promise<void>(() => {});
    await expect(withTimeout(slowPromise, 10)).rejects.toThrow(
      'Timeout after 10ms'
    );
  });
});
