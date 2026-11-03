export interface ResidentEditorModel {
  isDisposed(): boolean;
  getValueLength(): number;
  canUndo(): boolean;
  canRedo(): boolean;
  dispose(): void;
}

export function editorModelPath(root: string, path: string): string {
  // Monaco decodes URI escapes: a double-escaped root stays an opaque segment.
  return `cli-manager-file://workspace/${encodeURIComponent(encodeURIComponent(root))}/${path.split(/[\\/]/).map(encodeURIComponent).join("/")}`;
}

/** The renderer is disposable; open dirty/undo models are not a cache. */
export class EditorModelResidency {
  private entries = new Map<string, { model: ResidentEditorModel; leases: number; dirty: boolean; open: boolean }>();

  constructor(private maxBytes = 8 * 1024 * 1024, private maxModels = 12) {}

  acquire(key: string, model: ResidentEditorModel): () => void {
    const old = this.entries.get(key);
    const entry = old?.model === model ? old : { model, leases: 0, dirty: false, open: true };
    this.entries.delete(key);
    this.entries.set(key, entry);
    entry.leases++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.leases--;
      this.sweep();
    };
  }

  sync(open: Map<string, boolean>): void {
    for (const [key, entry] of this.entries) {
      entry.open = open.has(key);
      entry.dirty = open.get(key) ?? false;
    }
    this.sweep();
  }

  diagnostics() {
    return { models: this.entries.size, bytes: [...this.entries.values()].reduce((sum, e) =>
      sum + (e.model.isDisposed() ? 0 : e.model.getValueLength() * 2), 0) };
  }

  protected(key: string): boolean {
    const entry = this.entries.get(key);
    return Boolean(entry && !entry.model.isDisposed()
      && (entry.leases || entry.dirty || entry.model.canUndo() || entry.model.canRedo()));
  }

  private sweep(): void {
    let { bytes, models } = this.diagnostics();
    for (const [key, entry] of this.entries) {
      if (entry.leases) continue;
      const disposed = entry.model.isDisposed();
      if (!disposed && entry.open && (entry.dirty || entry.model.canUndo() || entry.model.canRedo())) continue;
      if (!disposed && entry.open && bytes <= this.maxBytes && models <= this.maxModels) continue;
      if (!disposed) { bytes -= entry.model.getValueLength() * 2; entry.model.dispose(); }
      this.entries.delete(key);
      models--;
    }
  }
}
