import {describe, it, expect, vi, beforeEach} from 'vitest';
import {
  buildTestContext,
  TestContext,
  TestFetchResponse,
} from '@uniswap/lib-testhelpers';
import {FetchLike} from '@uniswap/lib-uni';
import {cacheTokenLists} from './cacheTokenLists';

const sendMock = vi.fn().mockResolvedValue({});

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class MockS3Client {
    send = sendMock;
  },
  PutObjectCommand: class MockPutObjectCommand {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(public readonly input: any) {}
  },
}));

/**
 * Closure-based fake for the context fetcher. `results` is consumed one entry
 * per call, the last entry repeating, so a first-call failure can be followed
 * by successes.
 */
function fakeFetcher(
  results: Array<{body: string; status?: number} | Error>
): FetchLike {
  let index = 0;
  return async () => {
    const next = results[Math.min(index++, results.length - 1)];
    if (next instanceof Error) throw next;
    const status = next.status ?? 200;
    return new TestFetchResponse({
      status,
      ok: status >= 200 && status < 300,
      text: () => Promise.resolve(next.body),
    });
  };
}

const TOKEN_LIST_BODY = JSON.stringify({tokens: [{name: 'Test Token'}]});

const errorCount = (ctx: TestContext): number =>
  ctx.logger.outputs.filter(o => o.prefix === 'ERROR:').length;

describe('cacheTokenLists', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = buildTestContext();
    sendMock.mockClear();
  });

  it('fetches token lists and uploads to S3', async () => {
    ctx.fetcher = fakeFetcher([{body: TOKEN_LIST_BODY}]);

    await cacheTokenLists(ctx, {s3Bucket: 'test-bucket'});

    // Should have called send for each of the 3 token list URLs
    expect(sendMock).toHaveBeenCalledTimes(3);

    // Verify S3 bucket name via the PutObjectCommand input
    const firstCmd = sendMock.mock.calls[0][0];
    expect(firstCmd.input.Bucket).toBe('test-bucket');
    expect(firstCmd.input.Body).toContain('Test Token');
  });

  it('logs errors for failed fetches but continues', async () => {
    ctx.fetcher = fakeFetcher([
      new Error('network error'),
      {body: '{"tokens":[]}'},
    ]);

    await cacheTokenLists(ctx, {s3Bucket: 'test-bucket'});

    expect(errorCount(ctx)).toBe(1);
    // Still uploads the other 2 successfully
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it('does not cache a non-2xx response body as a token list', async () => {
    ctx.fetcher = fakeFetcher([{status: 500, body: 'upstream exploded'}]);

    await cacheTokenLists(ctx, {s3Bucket: 'test-bucket'});

    expect(sendMock).not.toHaveBeenCalled();
    expect(errorCount(ctx)).toBe(3);
  });

  it('does not cache a 200 whose body is not JSON', async () => {
    ctx.fetcher = fakeFetcher([{status: 200, body: '<html>nope</html>'}]);

    await cacheTokenLists(ctx, {s3Bucket: 'test-bucket'});

    expect(sendMock).not.toHaveBeenCalled();
    expect(errorCount(ctx)).toBe(3);
  });
});
