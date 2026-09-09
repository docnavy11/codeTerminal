/**
 * An AsyncIterable you can push into. The Agent SDK takes the conversation's
 * prompt as an AsyncIterable<SDKUserMessage>; keeping one open is what holds a
 * single session alive across turns (instead of re-resuming per message).
 */
export class Pushable<T> implements AsyncIterable<T> {
  #queue: T[] = [];
  #waiting: ((r: IteratorResult<T>) => void) | null = null;
  #done = false;

  push(value: T): void {
    if (this.#done) return;
    if (this.#waiting) {
      const resolve = this.#waiting;
      this.#waiting = null;
      resolve({ value, done: false });
    } else {
      this.#queue.push(value);
    }
  }

  end(): void {
    if (this.#done) return;
    this.#done = true;
    if (this.#waiting) {
      const resolve = this.#waiting;
      this.#waiting = null;
      resolve({ value: undefined as never, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.#queue.length > 0) {
        yield this.#queue.shift() as T;
        continue;
      }
      if (this.#done) return;
      const next = await new Promise<IteratorResult<T>>((resolve) => {
        this.#waiting = resolve;
      });
      if (next.done) return;
      yield next.value;
    }
  }
}

/** A promise whose resolve function is exposed, for the approval round-trip. */
export function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
