// Invalidations describe current state, not work to repeat for every replayed event.
// A device has at most one request in flight and one delayed follow-up.
export function createHistoryRefresh(load: (deviceId: string, signal: AbortSignal) => Promise<void>, delay = 150) {
  const entries = new Map<string, {
    timer?: ReturnType<typeof setTimeout>;
    controller?: AbortController;
    pending?: { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void };
  }>();
  const schedule = (deviceId: string, entry: NonNullable<ReturnType<typeof entries.get>>) => {
    if (entry.timer || entry.controller) return;
    entry.timer = setTimeout(async () => {
      entry.timer = undefined;
      const pending = entry.pending!;
      entry.pending = undefined;
      const controller = new AbortController();
      entry.controller = controller;
      try {
        await load(deviceId, controller.signal);
        pending.resolve();
      } catch (error) {
        pending.reject(error);
      } finally {
        // If one request in the refresh failed, retire its unfinished siblings too.
        controller.abort();
        entry.controller = undefined;
        if (entries.get(deviceId) !== entry) return;
        if (entry.pending) schedule(deviceId, entry);
        else entries.delete(deviceId);
      }
    }, delay);
  };
  return {
    refresh(deviceId: string): Promise<void> {
      let entry = entries.get(deviceId);
      if (!entry) { entry = {}; entries.set(deviceId, entry); }
      if (!entry.pending) {
        let resolve!: () => void;
        let reject!: (error: unknown) => void;
        const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
        entry.pending = { promise, resolve, reject };
      }
      schedule(deviceId, entry);
      return entry.pending.promise;
    },
    cancel() {
      for (const entry of entries.values()) {
        if (entry.timer) clearTimeout(entry.timer);
        entry.controller?.abort();
        entry.pending?.resolve();
      }
      entries.clear();
    },
  };
}
