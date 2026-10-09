/** One queue owns all reads/writes for an open workspace; rejected work cannot poison it. */
export class ConflictQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work);
    this.tail = next.catch(() => undefined);
    return next;
  }
  idle(): Promise<unknown> { return this.tail; }
}
