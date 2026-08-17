import {describe, it, expect, vi} from 'vitest';
import {ClientError} from 'graphql-request';
import {
  emitSalvagedSubgraphMetaBlock,
  salvageAllowedSubgraphError,
  salvageAllowedSubgraphErrorOrRethrow,
} from './allowedSubgraphError';
import type {Logger} from './log';
import {IMetric, MetricLoggerUnit} from './metric';

const request = {query: 'query { pools { id } }'};

describe('salvageAllowedSubgraphError', () => {
  it('returns the data and error messages for a ClientError carrying the root-field list', () => {
    const err = new ClientError(
      {
        data: {pools: [{id: '0xabc'}]},
        errors: [{message: 'indexing_error'}],
        status: 200,
      },
      request
    );
    const salvaged = salvageAllowedSubgraphError<{pools: {id: string}[]}>(
      err,
      'pools'
    );
    expect(salvaged).toEqual({
      data: {pools: [{id: '0xabc'}]},
      errorMessages: ['indexing_error'],
    });
  });

  it('salvages an empty root-field list (last pagination page)', () => {
    const err = new ClientError(
      {
        data: {pools: []},
        errors: [{message: 'indexing_error'}],
        status: 200,
      },
      request
    );
    expect(
      salvageAllowedSubgraphError<{pools: unknown[]}>(err, 'pools')
    ).toEqual({data: {pools: []}, errorMessages: ['indexing_error']});
  });

  it('salvages a single-entity root field with expect: entity, including null', () => {
    const withEntity = new ClientError(
      {
        data: {bundle: {ethPriceUSD: '4000'}},
        errors: [{message: 'indexing_error'}],
        status: 200,
      },
      request
    );
    expect(
      salvageAllowedSubgraphError<{bundle: {ethPriceUSD: string} | null}>(
        withEntity,
        'bundle',
        'entity'
      )?.data
    ).toEqual({bundle: {ethPriceUSD: '4000'}});

    const withNull = new ClientError(
      {
        data: {bundle: null},
        errors: [{message: 'indexing_error'}],
        status: 200,
      },
      request
    );
    expect(
      salvageAllowedSubgraphError<{bundle: null}>(withNull, 'bundle', 'entity')
        ?.data
    ).toEqual({bundle: null});
  });

  it('returns undefined for a ClientError with no data (fatal subgraph error)', () => {
    const err = new ClientError(
      {errors: [{message: 'indexing_error'}], status: 200},
      request
    );
    expect(
      salvageAllowedSubgraphError<{pools: unknown[]}>(err, 'pools')
    ).toBeUndefined();
  });

  it('returns undefined when the root field is not a list', () => {
    const err = new ClientError(
      {
        data: {pools: 'nope'},
        errors: [{message: 'indexing_error'}],
        status: 200,
      },
      request
    );
    expect(
      salvageAllowedSubgraphError<{pools: unknown[]}>(err, 'pools')
    ).toBeUndefined();
  });

  it('returns undefined for entity expectation when the root field key is absent', () => {
    const err = new ClientError(
      {
        data: {other: null},
        errors: [{message: 'indexing_error'}],
        status: 200,
      },
      request
    );
    expect(
      salvageAllowedSubgraphError<{bundle: null}>(err, 'bundle', 'entity')
    ).toBeUndefined();
  });

  it('returns undefined for non-ClientError errors (transport failures)', () => {
    expect(
      salvageAllowedSubgraphError<{pools: unknown[]}>(
        new Error('ECONNRESET'),
        'pools'
      )
    ).toBeUndefined();
  });

  it('returns undefined when data is present but no errors array exists (server error)', () => {
    const err = new ClientError({data: {pools: []}, status: 500}, request);
    expect(
      salvageAllowedSubgraphError<{pools: unknown[]}>(err, 'pools')
    ).toBeUndefined();
  });

  it('returns undefined when any error is not an indexing error, even with data', () => {
    // Data presence alone must not salvage: a data-carrying resolver error
    // could ignore the pagination cursor and be accepted forever.
    const err = new ClientError(
      {
        data: {pools: [{id: '0xabc'}]},
        errors: [{message: 'indexing_error'}, {message: 'some other failure'}],
        status: 200,
      },
      request
    );
    expect(
      salvageAllowedSubgraphError<{pools: unknown[]}>(err, 'pools')
    ).toBeUndefined();
  });

  it('matches indexing-error wording loosely (spacing, case, block-pinned variant)', () => {
    for (const message of [
      'Indexing Error',
      'indexing-error',
      'Failed to decode; subgraph only indexed up to block 25709273',
    ]) {
      const err = new ClientError(
        {data: {pools: []}, errors: [{message}], status: 200},
        request
      );
      expect(
        salvageAllowedSubgraphError<{pools: unknown[]}>(err, 'pools')?.data
      ).toEqual({pools: []});
    }
  });
});

describe('salvageAllowedSubgraphErrorOrRethrow', () => {
  const mockLogger: Logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
  };

  class RecordingMetric extends IMetric {
    metrics: {
      key: string;
      value: number;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      unit?: any;
      tags?: Record<string, string>;
    }[] = [];
    gauges: {key: string; value: number; tags?: Record<string, string>}[] = [];
    setProperty(_key: string, _value: unknown): void {}
    putDimensions(_dimensions: Record<string, string>): void {}
    putMetric(
      key: string,
      value: number,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      unit?: any,
      tags?: Record<string, string>
    ): void {
      this.metrics.push({key, value, unit, tags});
    }
    putGauge(key: string, value: number, tags?: Record<string, string>): void {
      this.gauges.push({key, value, tags});
    }
  }

  it('returns the salvaged data and emits the warn log and metric', () => {
    const metric = new RecordingMetric();
    const err = new ClientError(
      {
        data: {pools: [{id: '0xabc'}]},
        errors: [{message: 'indexing_error'}],
        status: 200,
      },
      request
    );
    const data = salvageAllowedSubgraphErrorOrRethrow<{
      pools: {id: string}[];
    }>({
      err,
      rootField: 'pools',
      label: 'test query page 1',
      logger: mockLogger,
      metric,
      metricTags: {chainId: '1', protocol: 'V4'},
    });
    expect(data.pools).toEqual([{id: '0xabc'}]);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('test query page 1'),
      {subgraphErrorMessages: ['indexing_error']}
    );
    expect(metric.metrics).toEqual([
      {
        key: 'SubgraphProvider.subgraphErrorAllowed',
        value: 1,
        // A count, not a unit-less dist — the datadog-cloud monitor queries
        // it with .as_count(), and dists are allowlist-gated.
        unit: MetricLoggerUnit.Count,
        tags: {chainId: '1', protocol: 'V4'},
      },
    ]);
  });

  it('rethrows the original error when it is not salvageable', () => {
    const err = new Error('ECONNRESET');
    expect(() =>
      salvageAllowedSubgraphErrorOrRethrow<{pools: unknown[]}>({
        err,
        rootField: 'pools',
        label: 'test query',
      })
    ).toThrow(err);
  });

  describe('emitSalvagedSubgraphMetaBlock', () => {
    const metaResponse = {_meta: {block: {number: 25741310}}};

    it('emits the metaBlock gauge from a clean _meta response', async () => {
      const metric = new RecordingMetric();
      await emitSalvagedSubgraphMetaBlock({
        client: {request: async () => metaResponse},
        logger: mockLogger,
        metric,
        metricTags: {chainId: '1', protocol: 'V4'},
      });
      expect(metric.gauges).toEqual([
        {
          key: 'SubgraphProvider.subgraphErrorAllowed.metaBlock',
          value: 25741310,
          tags: {chainId: '1', protocol: 'V4'},
        },
      ]);
    });

    it('salvages _meta from a data-plus-errors ClientError', async () => {
      const metric = new RecordingMetric();
      await emitSalvagedSubgraphMetaBlock({
        client: {
          request: async () => {
            throw new ClientError(
              {
                data: metaResponse,
                errors: [{message: 'indexing_error'}],
                status: 200,
              },
              request
            );
          },
        },
        metric,
      });
      expect(metric.gauges.map(g => g.value)).toEqual([25741310]);
    });

    it('emits nothing and does not throw on transport failure or null _meta', async () => {
      const metric = new RecordingMetric();
      await emitSalvagedSubgraphMetaBlock({
        client: {
          request: async () => {
            throw new Error('ECONNRESET');
          },
        },
        metric,
      });
      await emitSalvagedSubgraphMetaBlock({
        client: {request: async () => ({_meta: null})},
        metric,
      });
      expect(metric.gauges).toEqual([]);
    });
  });
});
