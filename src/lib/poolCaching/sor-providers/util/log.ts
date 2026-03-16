/**
 * Logger interface matching ServerfulLogger's string-first calling convention.
 * No global singleton — pass the logger explicitly wherever needed.
 */

export interface Logger {
  info(msg: string, ...extra: any[]): void;
  warn(msg: string, ...extra: any[]): void;
  error(msg: string, ...extra: any[]): void;
  debug(msg: string, ...extra: any[]): void;
  fatal(msg: string, ...extra: any[]): void;
}
