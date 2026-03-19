declare module '@datastructures-js/priority-queue' {
  type Comparator<T> = (a: T, b: T) => number;

  class PriorityQueue<T> {
    constructor(compare: Comparator<T>);
    push(element: T): PriorityQueue<T>;
    pop(): T;
    dequeue(): T;
    front(): T;
    back(): T;
    size(): number;
    isEmpty(): boolean;
    toArray(): T[];
    clear(): void;
  }

  export {PriorityQueue};
}