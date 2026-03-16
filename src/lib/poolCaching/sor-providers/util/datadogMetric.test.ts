import {describe, it, expect, vi} from 'vitest';
import {DatadogPoolCachingMetric} from './datadogMetric';
import {MetricLoggerUnit} from './metric';
import type {IMetrics} from '@uniswap/lib-observability';

function createMockMetrics(): IMetrics & {calls: Record<string, Array<{name: string; val: number; opts: any}>>} {
  const calls: Record<string, Array<{name: string; val: number; opts: any}>> = {
    count: [],
    hist: [],
    gauge: [],
    dist: [],
    timer: [],
  };
  return {
    calls,
    count: vi.fn(async (name, val, opts) => {
      calls.count.push({name, val: val ?? 1, opts});
    }),
    hist: vi.fn(async (name, val, opts) => {
      calls.hist.push({name, val, opts});
    }),
    gauge: vi.fn(async (name, val, opts) => {
      calls.gauge.push({name, val, opts});
    }),
    dist: vi.fn(async (name, val, opts) => {
      calls.dist.push({name, val, opts});
    }),
    timer: vi.fn(async (name, val, opts) => {
      calls.timer.push({name, val, opts});
    }),
    set: vi.fn(async () => {}),
    flush: vi.fn(async () => {}),
  };
}

describe('DatadogPoolCachingMetric', () => {
  it('routes Milliseconds to timer', () => {
    const mock = createMockMetrics();
    const metric = new DatadogPoolCachingMetric(mock);
    metric.putMetric('getPools.latency', 250, MetricLoggerUnit.Milliseconds);
    expect(mock.calls.timer).toHaveLength(1);
    expect(mock.calls.timer[0]!.name).toBe('pool_caching.getPools_latency');
    expect(mock.calls.timer[0]!.val).toBe(250);
  });

  it('converts Seconds to milliseconds for timer', () => {
    const mock = createMockMetrics();
    const metric = new DatadogPoolCachingMetric(mock);
    metric.putMetric('duration', 1.5, MetricLoggerUnit.Seconds);
    expect(mock.calls.timer).toHaveLength(1);
    expect(mock.calls.timer[0]!.val).toBe(1500);
  });

  it('routes Count to count', () => {
    const mock = createMockMetrics();
    const metric = new DatadogPoolCachingMetric(mock);
    metric.putMetric('requests', 5, MetricLoggerUnit.Count);
    expect(mock.calls.count).toHaveLength(1);
    expect(mock.calls.count[0]!.val).toBe(5);
  });

  it('routes Bytes to gauge', () => {
    const mock = createMockMetrics();
    const metric = new DatadogPoolCachingMetric(mock);
    metric.putMetric('size', 1024, MetricLoggerUnit.Bytes);
    expect(mock.calls.gauge).toHaveLength(1);
    expect(mock.calls.gauge[0]!.val).toBe(1024);
  });

  it('routes None/unspecified to dist', () => {
    const mock = createMockMetrics();
    const metric = new DatadogPoolCachingMetric(mock);
    metric.putMetric('compression_ratio', 3.5);
    expect(mock.calls.dist).toHaveLength(1);
    expect(mock.calls.dist[0]!.name).toBe('pool_caching.compression_ratio');
    expect(mock.calls.dist[0]!.val).toBe(3.5);
  });

  it('routes MetricLoggerUnit.None to dist', () => {
    const mock = createMockMetrics();
    const metric = new DatadogPoolCachingMetric(mock);
    metric.putMetric('ratio', 2.0, MetricLoggerUnit.None);
    expect(mock.calls.dist).toHaveLength(1);
  });

  it('includes dimensions and properties as tags', () => {
    const mock = createMockMetrics();
    const metric = new DatadogPoolCachingMetric(mock);
    metric.putDimensions({chainId: '1', protocol: 'V3'});
    metric.setProperty('network', 'mainnet');
    metric.putMetric('pools', 100, MetricLoggerUnit.Count);
    expect(mock.calls.count[0]!.opts).toEqual({
      tags: ['chainId:1', 'protocol:V3', 'network:mainnet'],
    });
  });

  it('normalizes dots in metric keys to underscores', () => {
    const mock = createMockMetrics();
    const metric = new DatadogPoolCachingMetric(mock);
    metric.putMetric('CachePools.getPools.latency', 100, MetricLoggerUnit.Milliseconds);
    expect(mock.calls.timer[0]!.name).toBe('pool_caching.CachePools_getPools_latency');
  });

  it('merges extraTags into tags', () => {
    const mock = createMockMetrics();
    const metric = new DatadogPoolCachingMetric(mock);
    metric.putDimensions({env: 'prod'});
    metric.putMetric('CachePools.getPools.error', 1, MetricLoggerUnit.Count, {chainId: '1', protocol: 'V3'});
    expect(mock.calls.count[0]!.opts).toEqual({
      tags: ['env:prod', 'chainId:1', 'protocol:V3'],
    });
  });
});
