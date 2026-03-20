declare module 'async-retry' {
  interface Options {
    retries?: number;
    factor?: number;
    minTimeout?: number;
    maxTimeout?: number;
    randomize?: boolean;
    onRetry?: (error: Error, attempt: number) => void;
  }

  function retry<T>(
    fn: (bail: (error: Error) => void, attempt: number) => Promise<T>,
    opts?: Options
  ): Promise<T>;

  export = retry;
}
