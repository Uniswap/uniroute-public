/**
 * Logger interface matching ServerfulLogger's string-first calling convention.
 * No global singleton — pass the logger explicitly wherever needed.
 */

export interface Logger {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  info(msg: string, ...extra: any[]): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  warn(msg: string, ...extra: any[]): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  error(msg: string, ...extra: any[]): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  debug(msg: string, ...extra: any[]): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fatal(msg: string, ...extra: any[]): void;
}
