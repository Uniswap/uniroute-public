import {describe, it, expect, vi, beforeEach} from 'vitest';
import {cacheTokenLists} from './cacheTokenLists';
import type {Logger} from './sor-providers/util/log';

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

vi.mock('axios', () => ({
  default: {
    get: vi.fn().mockResolvedValue({data: {tokens: [{name: 'Test Token'}]}}),
  },
}));

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
  };
}

describe('cacheTokenLists', () => {
  let mockLogger: Logger;

  beforeEach(() => {
    mockLogger = createMockLogger();
    sendMock.mockClear();
  });

  it('fetches token lists and uploads to S3', async () => {
    await cacheTokenLists(mockLogger, {s3Bucket: 'test-bucket'});

    // Should have called send for each of the 3 token list URLs
    expect(sendMock).toHaveBeenCalledTimes(3);

    // Verify S3 bucket name via the PutObjectCommand input
    const firstCmd = sendMock.mock.calls[0][0];
    expect(firstCmd.input.Bucket).toBe('test-bucket');
    expect(firstCmd.input.Body).toContain('Test Token');
  });

  it('logs errors for failed fetches but continues', async () => {
    const axios = await import('axios');
    vi.mocked(axios.default.get)
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValue({data: {tokens: []}});

    await cacheTokenLists(mockLogger, {s3Bucket: 'test-bucket'});

    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    // Still uploads the other 2 successfully
    expect(sendMock).toHaveBeenCalledTimes(2);
  });
});
