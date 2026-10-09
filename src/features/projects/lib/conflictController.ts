import { ConflictQueue } from "./conflictQueue";
import { conflictErrorText, isConflictTerminal } from "./conflictProtocol";
import type { ConflictChoice, ConflictContext, ConflictDetail, ConflictInvoke, ConflictPage, ConflictProbe, ConflictSide, ConflictSnapshot } from "./conflictProtocol";

export interface ConflictView {
  probe: ConflictProbe | null; snapshot: ConflictSnapshot | null; page: ConflictPage | null; cursor: number;
  detail: ConflictDetail | null; selectedId: string | null; dirty: boolean; busy: boolean; loading: boolean;
  error: string | null; needsRecheck: boolean; saving: boolean;
}

/** The sole owner of an editor's file buffers, CAS versions and in-flight IPC. No polling. */
export class ConflictController {
  private view: ConflictView = { probe: null, snapshot: null, page: null, cursor: 0, detail: null, selectedId: null, dirty: false, busy: false, loading: false, error: null, needsRecheck: false, saving: false };
  private listeners = new Set<() => void>();
  private queue = new ConflictQueue();
  private epoch = 0;
  private edits = 0;
  private alive = true;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pendingSave: { args: Record<string, unknown>; edits: number } | null = null;
  private refreshFlight: Promise<void> | null = null;
  private prepareId = crypto.randomUUID();
  private releaseId = crypto.randomUUID();

  constructor(private readonly invoke: ConflictInvoke, readonly context: ConflictContext) {}
  getSnapshot = (): ConflictView => this.view;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private patch(next: Partial<ConflictView>): void {
    if (!this.alive) return;
    this.view = { ...this.view, ...next };
    this.listeners.forEach((listener) => listener());
  }
  private sessionArgs(): Record<string, unknown> {
    if (!this.view.snapshot) throw new Error("session_missing");
    return { context: this.context, sessionId: this.view.snapshot.sessionId };
  }
  private async command<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    return this.invoke<T>(`git_worktree_${name}`, { ...this.sessionArgs(), ...args });
  }
  private run(work: () => Promise<void>, reconcileOnFailure = false): Promise<void> {
    return this.queue.run(async () => {
      if (!this.alive) return;
      this.patch({ busy: true, error: null });
      try { await work(); }
      catch (error) { this.patch({ error: conflictErrorText(error), ...(reconcileOnFailure ? { needsRecheck: true } : {}) }); throw error; }
      finally { this.patch({ busy: false }); }
    });
  }
  initialize(prepareWhenClean = false): Promise<void> {
    if (this.refreshFlight) return this.refreshFlight;
    const flight = this.run(async () => {
      const probe = await this.invoke<ConflictProbe>("git_worktree_probe_conflicts", { context: this.context });
      if (!this.alive) return;
      const snapshot = probe.kind === "managed" || probe.kind === "recovery" ? probe.snapshot : null;
      this.patch({ probe, snapshot, needsRecheck: probe.kind === "recovery", error: "error" in probe ? conflictErrorText(probe.error) : null });
      if (snapshot && !isConflictTerminal(snapshot) && probe.kind === "managed") await this.loadPage(0);
      else if (probe.kind === "none" && prepareWhenClean) await this.prepareSession(probe);
    }, prepareWhenClean);
    this.refreshFlight = flight;
    void flight.finally(() => { if (this.refreshFlight === flight) this.refreshFlight = null; }).catch(() => undefined);
    return flight;
  }
  prepare(): Promise<void> {
    return this.run(async () => {
      const probe = this.view.probe;
      if (probe?.kind !== "none") throw new Error("prepare_requires_clean_probe");
      await this.prepareSession(probe);
    }, true);
  }
  private async prepareSession(probe: Extract<ConflictProbe, { kind: "none" }>): Promise<void> {
    const snapshot = await this.invoke<ConflictSnapshot>("git_worktree_prepare_conflicts", { context: this.context, expectedHeadOid: probe.headOid, expectedBaseOid: probe.baseOid, operationId: this.prepareId });
    if (!this.alive) return;
    this.patch({ snapshot, probe: { kind: "managed", snapshot }, needsRecheck: false });
    await this.loadPage(0);
  }
  private async loadPage(cursor: number): Promise<void> {
    const epoch = this.epoch;
    const snapshot = this.view.snapshot;
    if (!snapshot || isConflictTerminal(snapshot)) return;
    const page = await this.command<ConflictPage>("conflict_status", { listSnapshotId: snapshot.listSnapshotId, cursor, limit: 200 });
    if (!this.alive || epoch !== this.epoch) return;
    this.patch({ page, snapshot: page.snapshot, cursor, detail: null, selectedId: null });
    const first = page.files.find((file) => !file.resolved);
    if (!first) return;
    // Stay within the current queue job: enqueueing select() here would deadlock.
    this.patch({ loading: true });
    try {
      const response = await this.command<{ requestEpoch: number; detail: ConflictDetail }>("conflict_file", { fileId: first.fileId, requestEpoch: epoch });
      if (epoch === this.epoch && response.requestEpoch === epoch) this.patch({ detail: response.detail, selectedId: first.fileId, dirty: false });
    } finally { if (epoch === this.epoch) this.patch({ loading: false }); }
  }
  page(cursor: number): Promise<void> {
    const epoch = ++this.epoch;
    return this.run(async () => {
      if (epoch !== this.epoch) return;
      try {
        await this.flushDraft();
        if (epoch === this.epoch) await this.loadPage(cursor);
      } finally { if (epoch === this.epoch) this.patch({ loading: false }); }
    });
  }
  select(fileId: string): Promise<void> {
    const epoch = ++this.epoch;
    this.patch({ loading: true });
    return this.run(async () => {
      if (epoch !== this.epoch) return;
      try {
        await this.flushDraft();
        if (epoch !== this.epoch) return;
        const response = await this.command<{ requestEpoch: number; detail: ConflictDetail }>("conflict_file", { fileId, requestEpoch: epoch });
        if (epoch === this.epoch && response.requestEpoch === epoch) this.patch({ detail: response.detail, selectedId: fileId, dirty: false });
      } finally { if (epoch === this.epoch) this.patch({ loading: false }); }
    });
  }
  choose(blockId: string, choice: ConflictChoice): void {
    const detail = this.view.detail;
    if (!detail || detail.capability !== "blocks" || this.view.loading || this.view.needsRecheck) return;
    if (!detail.blocks.some((block) => block.id === blockId)) return;
    this.edits++;
    this.patch({ dirty: true, detail: { ...detail, draft: { ...detail.draft, choices: { ...detail.draft.choices, [blockId]: choice } } } });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush().catch(() => undefined); }, 300);
  }
  /** Keep the exact operation id on uncertain save outcomes; a retry cannot double-apply. */
  private async flushDraft(): Promise<void> {
    clearTimeout(this.timer);
    while (this.view.dirty && this.alive) {
      const detail = this.view.detail;
      if (!detail) throw new Error("dirty_file_missing");
      this.pendingSave ??= { edits: this.edits, args: { fileId: detail.fileId, version: detail.version, draftRevision: detail.draft.revision, choices: detail.draft.choices, operationId: crypto.randomUUID() } };
      const save = this.pendingSave;
      await this.command("save_conflict_draft", save.args);
      if (!this.alive) return;
      const response = await this.command<{ requestEpoch: number; detail: ConflictDetail }>("conflict_file", { fileId: detail.fileId, requestEpoch: this.epoch });
      const dirty = this.edits !== save.edits;
      const fresh = response.detail;
      const choices = dirty ? this.view.detail!.draft.choices : fresh.draft.choices;
      this.pendingSave = null;
      this.patch({ detail: { ...fresh, draft: { ...fresh.draft, choices } }, dirty });
    }
  }
  // 自动保存不禁用编辑框，避免失焦；保存期间新增编辑由同一串行队列追写。
  flush(): Promise<void> { return this.run(async () => {
    this.patch({ saving: true });
    try { await this.flushDraft(); } finally { this.patch({ saving: false }); }
  }); }
  discardLocal(): Promise<void> {
    return this.run(async () => {
      clearTimeout(this.timer);
      this.pendingSave = null;
      this.patch({ dirty: false, detail: null, selectedId: null });
    });
  }
  resolve(side?: ConflictSide): Promise<void> {
    return this.run(async () => {
      await this.flushDraft();
      const { detail, snapshot, needsRecheck } = this.view;
      if (!detail || !snapshot || needsRecheck) throw new Error("resolution_not_ready");
      const args = { fileId: detail.fileId, version: detail.version, revision: snapshot.revision, operationId: crypto.randomUUID() };
      const next = side
        ? await this.command<ConflictSnapshot>("take_conflict_side", { ...args, side })
        : await this.command<ConflictSnapshot>("resolve_conflict_file", { ...args, draftRevision: detail.draft.revision });
      this.patch({ snapshot: next, detail: null, selectedId: null });
      await this.loadPage(this.view.cursor);
    }, true);
  }
  continueMerge(message: string): Promise<void> {
    return this.run(async () => {
      await this.flushDraft();
      const snapshot = await this.command<ConflictSnapshot>("continue_conflicts", { revision: this.view.snapshot!.revision, message, operationId: crypto.randomUUID() });
      this.patch({ snapshot, detail: null, selectedId: null });
    }, true);
  }
  abort(): Promise<void> {
    return this.run(async () => {
      await this.flushDraft();
      const snapshot = await this.command<ConflictSnapshot>("abort_conflicts", { revision: this.view.snapshot!.revision, operationId: crypto.randomUUID() });
      this.patch({ snapshot, detail: null, selectedId: null });
    }, true);
  }
  recheck(): Promise<void> {
    if (!this.view.snapshot) return this.initialize(true);
    if (this.refreshFlight) return this.refreshFlight;
    const flight = this.run(async () => {
      await this.flushDraft();
      const snapshot = await this.command<ConflictSnapshot>("recheck_conflicts");
      this.patch({ snapshot, needsRecheck: false, detail: null, selectedId: null, probe: { kind: "managed", snapshot } });
      await this.loadPage(this.view.cursor);
    }, true);
    this.refreshFlight = flight;
    void flight.finally(() => { if (this.refreshFlight === flight) this.refreshFlight = null; }).catch(() => undefined);
    return flight;
  }
  release(): Promise<void> {
    return this.run(async () => {
      await this.flushDraft();
      if (!isConflictTerminal(this.view.snapshot)) throw new Error("release_requires_terminal");
      await this.command("release_conflicts", { revision: this.view.snapshot!.revision, operationId: this.releaseId });
    }, true);
  }
  dispose(): void { this.alive = false; this.epoch++; clearTimeout(this.timer); this.listeners.clear(); }
}
