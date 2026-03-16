declare module 'await-timeout' {
  export default class Timeout {
    set(delay: number): Promise<void>;
    clear(): void;
  }
}
