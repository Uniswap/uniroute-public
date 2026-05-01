/**
 * Datadog-backed IMetric implementation that wraps ServerfulMetrics.
 *
 * Maps the SOR-ported putMetric(key, value, unit) calls to real Datadog StatsD
 * metrics via the shared @uniswap/lib-observability ServerfulMetrics class.
 *
 * Unit mapping:
 *   - Milliseconds/Seconds/Microseconds → timer (works in both Lambda and ECS)
 *   - Count/CountPerSecond              → count
 *   - Bytes/Megabytes/Percent/etc       → gauge
 *   - None / unspecified                → dist (distribution for general values)
 */

import type {IMetrics} from '@uniswap/lib-observability';
import {IMetric, MetricLoggerUnit} from './metric';

const LATENCY_UNITS = new Set<MetricLoggerUnit>([
  MetricLoggerUnit.Milliseconds,
  MetricLoggerUnit.Seconds,
  MetricLoggerUnit.Microseconds,
]);

const COUNT_UNITS = new Set<MetricLoggerUnit>([
  MetricLoggerUnit.Count,
  MetricLoggerUnit.CountPerSecond,
]);

const GAUGE_UNITS = new Set<MetricLoggerUnit>([
  MetricLoggerUnit.Bytes,
  MetricLoggerUnit.Kilobytes,
  MetricLoggerUnit.Megabytes,
  MetricLoggerUnit.Gigabytes,
  MetricLoggerUnit.Terabytes,
  MetricLoggerUnit.Bits,
  MetricLoggerUnit.Kilobits,
  MetricLoggerUnit.Megabits,
  MetricLoggerUnit.Gigabits,
  MetricLoggerUnit.Terabits,
  MetricLoggerUnit.Percent,
  MetricLoggerUnit.BytesPerSecond,
  MetricLoggerUnit.KilobytesPerSecond,
  MetricLoggerUnit.MegabytesPerSecond,
  MetricLoggerUnit.GigabytesPerSecond,
  MetricLoggerUnit.TerabytesPerSecond,
  MetricLoggerUnit.BitsPerSecond,
  MetricLoggerUnit.KilobitsPerSecond,
  MetricLoggerUnit.MegabitsPerSecond,
  MetricLoggerUnit.GigabitsPerSecond,
  MetricLoggerUnit.TerabitsPerSecond,
]);

export class DatadogPoolCachingMetric extends IMetric {
  private metrics: IMetrics;
  private dimensions: Record<string, string> = {};
  private properties: Record<string, string> = {};

  constructor(metrics: IMetrics) {
    super();
    this.metrics = metrics;
  }

  setProperty(key: string, value: unknown): void {
    this.properties[key] = String(value);
  }

  putDimensions(dimensions: Record<string, string>): void {
    Object.assign(this.dimensions, dimensions);
  }

  putMetric(
    key: string,
    value: number,
    unit?: MetricLoggerUnit,
    extraTags?: Record<string, string>
  ): void {
    // Normalize key for Datadog: replace dots with underscores in the metric-specific part
    // but keep the pool_caching prefix clean
    const metricName = `pool_caching.${key.replace(/\./g, '_')}`;

    const tags = [
      ...Object.entries(this.dimensions).map(([k, v]) => `${k}:${v}`),
      ...Object.entries(this.properties).map(([k, v]) => `${k}:${v}`),
      ...Object.entries(extraTags ?? {}).map(([k, v]) => `${k}:${v}`),
    ];
    const opts = tags.length > 0 ? {tags} : {};

    if (unit && LATENCY_UNITS.has(unit)) {
      // Convert to milliseconds for consistency
      let ms = value;
      if (unit === MetricLoggerUnit.Seconds) ms = value * 1000;
      if (unit === MetricLoggerUnit.Microseconds) ms = value / 1000;
      void this.metrics.dist(`${metricName}.dist`, ms, opts);
    } else if (unit && COUNT_UNITS.has(unit)) {
      void this.metrics.count(metricName, value, opts);
    } else if (unit && GAUGE_UNITS.has(unit)) {
      void this.metrics.gauge(metricName, value, opts);
    } else {
      // None, unspecified, or unknown → use distribution
      void this.metrics.dist(`${metricName}.dist`, value, opts);
    }
  }
}
