/** Only transcript reads may bypass the ordered management lane. Pending IDs remain replay-safe. */
export function createWebOperationLanes<T extends { id: string; kind: string }>(execute: (item: T) => Promise<void>, onError: (error: unknown) => void) {
  const known = new Set<string>();
  const reads: T[] = [], ordered: T[] = [];
  let reading = 0, writing = false;
  const start = (item: T, read: boolean) => {
    if (read) reading++; else writing = true;
    void Promise.resolve().then(() => execute(item)).catch(onError).finally(() => {
      known.delete(item.id);
      if (read) reading--; else writing = false;
      drain();
    });
  };
  const drain = () => {
    while (reading < 2 && reads.length) start(reads.shift()!, true);
    if (!writing && ordered.length) start(ordered.shift()!, false);
  };
  return {
    enqueue(items: T[]) {
      for (const item of items) {
        if (known.has(item.id) || known.size >= 128) continue;
        known.add(item.id);
        (item.kind === "terminal.transcript" ? reads : ordered).push(item);
      }
      drain();
    },
  };
}
