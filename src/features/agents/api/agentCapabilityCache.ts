import type { AgentCapabilitySnapshot } from "./agentCapabilities";

export class AgentCapabilityCache {
  private entries = new Map<string, { snapshot: AgentCapabilitySnapshot; baseline: string; bytes: number }>();
  private bytes = 0;

  constructor(private maxEntries = 64, private maxBytes = 4 * 1024 * 1024) {}

  get(key: string): AgentCapabilitySnapshot | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.snapshot;
  }

  baseline(key: string): string | null { return this.entries.get(key)?.baseline ?? null; }

  set(key: string, snapshot: AgentCapabilitySnapshot): void {
    const old = this.entries.get(key);
    const baseline = old?.baseline ?? snapshot.configFingerprint;
    if (old) { this.bytes -= old.bytes; this.entries.delete(key); }
    const bytes = (JSON.stringify(snapshot).length + key.length + baseline.length) * 2;
    // Oversize results remain available in the active hook, but are not retained globally.
    if (bytes > this.maxBytes) return;
    while (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.bytes -= this.entries.get(oldest)!.bytes;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { snapshot, baseline, bytes });
    this.bytes += bytes;
  }
}
