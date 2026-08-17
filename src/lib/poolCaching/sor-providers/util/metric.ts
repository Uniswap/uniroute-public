/**
 * IMetric interface and MetricLoggerUnit enum for pool caching metrics.
 * No global singleton — pass the metric instance explicitly wherever needed.
 */

export enum MetricLoggerUnit {
  Seconds = 'Seconds',
  Microseconds = 'Microseconds',
  Milliseconds = 'Milliseconds',
  Bytes = 'Bytes',
  Kilobytes = 'Kilobytes',
  Megabytes = 'Megabytes',
  Gigabytes = 'Gigabytes',
  Terabytes = 'Terabytes',
  Bits = 'Bits',
  Kilobits = 'Kilobits',
  Megabits = 'Megabits',
  Gigabits = 'Gigabits',
  Terabits = 'Terabits',
  Percent = 'Percent',
  Count = 'Count',
  BytesPerSecond = 'Bytes/Second',
  KilobytesPerSecond = 'Kilobytes/Second',
  MegabytesPerSecond = 'Megabytes/Second',
  GigabytesPerSecond = 'Gigabytes/Second',
  TerabytesPerSecond = 'Terabytes/Second',
  BitsPerSecond = 'Bits/Second',
  KilobitsPerSecond = 'Kilobits/Second',
  MegabitsPerSecond = 'Megabits/Second',
  GigabitsPerSecond = 'Gigabits/Second',
  TerabitsPerSecond = 'Terabits/Second',
  CountPerSecond = 'Count/Second',
  None = 'None',
}

export abstract class IMetric {
  abstract setProperty(key: string, value: unknown): void;

  abstract putDimensions(dimensions: Record<string, string>): void;

  abstract putMetric(
    key: string,
    value: number,
    unit?: MetricLoggerUnit,
    tags?: Record<string, string>
  ): void;

  /**
   * Emit a point-in-time level (e.g. a block height) as a Datadog gauge.
   * putMetric can't express this: the ported MetricLoggerUnit set has no
   * unit for dimensionless levels, so unit-less values land as `.dist`
   * distributions, which are allowlist-gated. Default no-op so test fakes
   * and Noop implementations are unaffected.
   */
  putGauge(
    _key: string,
    _value: number,
    _tags?: Record<string, string>
  ): void {}
}
