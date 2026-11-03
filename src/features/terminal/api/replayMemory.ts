import type { ReplayEvent } from "./replayStore";

const EVENT_CACHE_BYTES = 16 * 1024 * 1024;
const EVENT_CACHE_SESSIONS = 12;
const eventSizes = new WeakMap<ReplayEvent, number>();

export class ReplayPatchCache {
  private cached = new Map<string, string>();
  private inFlight = new Map<string, Promise<string>>();
  private waiting: Array<() => void> = [];
  private active = 0;
  private bytes = 0;

  constructor(private read: (path: string) => Promise<string>, private budget = 8 * 1024 * 1024) {}

  load(path: string): Promise<string> {
    const cached = this.cached.get(path);
    if (cached !== undefined) {
      this.cached.delete(path);
      this.cached.set(path, cached);
      return Promise.resolve(cached);
    }
    const existing = this.inFlight.get(path);
    if (existing) return existing;
    if (this.inFlight.size >= 64) return Promise.reject(new Error("replay_patch_queue_full"));
    const operation = this.readBounded(path).finally(() => this.inFlight.delete(path));
    this.inFlight.set(path, operation);
    return operation;
  }

  private async readBounded(path: string): Promise<string> {
    if (this.active >= 2) await new Promise<void>(resolve => this.waiting.push(resolve));
    else this.active++;
    try {
      const text = await this.read(path);
      const bytes = text.length * 2;
      if (bytes <= this.budget) {
        while (this.bytes + bytes > this.budget && this.cached.size) {
          const key = this.cached.keys().next().value!;
          this.bytes -= this.cached.get(key)!.length * 2;
          this.cached.delete(key);
        }
        this.cached.set(path, text);
        this.bytes += bytes;
      }
      return text;
    } finally {
      // Hand the occupied slot directly to the next reader, avoiding a race.
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

function eventBytes(event: ReplayEvent): number {
  let bytes = eventSizes.get(event);
  if (bytes === undefined) {
    // Count UTF-16 residency conservatively rather than only UTF-8 file sizes.
    bytes = JSON.stringify(event).length * 2;
    eventSizes.set(event, bytes);
  }
  return bytes;
}

export function retainReplayEvents(
  cache: Record<string, ReplayEvent[]>, sessionKey: string, events: ReplayEvent[], selected: string | null,
): Record<string, ReplayEvent[]> {
  const result = { ...cache };
  delete result[sessionKey];
  result[sessionKey] = events;
  let bytes = Object.values(result).reduce((sum, entries) => sum + entries.reduce((n, event) => n + eventBytes(event), 0), 0);
  for (const key of Object.keys(result)) {
    if (Object.keys(result).length <= EVENT_CACHE_SESSIONS && bytes <= EVENT_CACHE_BYTES) break;
    if (key === selected) continue;
    bytes -= result[key].reduce((sum, event) => sum + eventBytes(event), 0);
    delete result[key];
  }
  // Persisted history is untouched; only the resident tail is bounded.
  if (selected && result[selected] && bytes > EVENT_CACHE_BYTES) {
    const entries = [...result[selected]];
    while (entries.length && bytes > EVENT_CACHE_BYTES) bytes -= eventBytes(entries.shift()!);
    result[selected] = entries;
  }
  return result;
}
