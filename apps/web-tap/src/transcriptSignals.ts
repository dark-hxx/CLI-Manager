/** Invalidations are independent of terminal bytes, ACKs and renderer state. */
export function createTranscriptSignals() {
  const listeners = new Map<string, Set<() => void>>();
  return {
    subscribe(session: string, listener: () => void) {
      const set = listeners.get(session) ?? new Set();
      listeners.set(session, set); set.add(listener);
      return () => { set.delete(listener); if (!set.size) listeners.delete(session); };
    },
    publish(session?: string) {
      if (session) listeners.get(session)?.forEach((listener) => listener());
      else listeners.forEach((set) => set.forEach((listener) => listener()));
    },
  };
}
