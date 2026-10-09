export interface WorktreeRecoveryStatus {
  blocked: boolean;
  hasJournal: boolean;
  canConfirm: boolean;
  stateToken: string | null;
  revision: number | null;
  phase: string | null;
  stashOid: string | null;
  reason: string | null;
}

export interface RecoveryGateSnapshot {
  key: string;
  phase: "loading" | "ready" | "blocked" | "error";
  status: WorktreeRecoveryStatus | null;
  error: string | null;
}

type Request = (command: string, args: Record<string, unknown>) => Promise<WorktreeRecoveryStatus>;

/** 单个弹窗仅允许一个 IPC 在途；关闭、切换和快速重检不会接纳过期响应。 */
export class WorktreeRecoveryGate {
  private request: Request;
  private generation = 0;
  private projectPath: string | null = null;
  private listeners = new Set<() => void>();
  private tail: Promise<WorktreeRecoveryStatus | null> = Promise.resolve(null);
  private pending: { generation: number; promise: Promise<WorktreeRecoveryStatus | null> } | null = null;
  private snapshot: RecoveryGateSnapshot = { key: "", phase: "loading", status: null, error: null };

  constructor(request: Request) { this.request = request; }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish(snapshot: RecoveryGateSnapshot) {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  start(projectPath: string, key: string) {
    this.generation++;
    this.projectPath = projectPath;
    this.publish({ key, phase: "loading", status: null, error: null });
    return this.refresh();
  }

  stop() {
    this.generation++;
    this.projectPath = null;
    this.publish({ key: "", phase: "loading", status: null, error: null });
  }

  /** confirmToken 必须取自确认框打开时，不能在确认点击后换成更新的状态。 */
  refresh(mode: "probe" | "recheck" | "confirm" = "probe", confirmToken?: string) {
    if (!this.projectPath) return Promise.resolve(null);
    const generation = this.generation;
    if (this.pending?.generation === generation) return this.pending.promise;
    const projectPath = this.projectPath;
    const stateToken = mode === "confirm" ? confirmToken : this.snapshot.status?.stateToken;
    const previous = this.tail;
    this.publish({ ...this.snapshot, phase: "loading", error: null });
    const promise = (async () => {
      await previous;
      if (generation !== this.generation) return null;
      try {
        const status = await this.request(
          mode === "probe" ? "git_worktree_recovery_probe" : "git_worktree_recovery_recheck",
          mode === "probe" ? { projectPath } : { projectPath, stateToken: stateToken ?? null, confirm: mode === "confirm" },
        );
        if (generation !== this.generation) return null;
        this.publish({ ...this.snapshot, status, error: null, phase: status.blocked ? "blocked" : "ready" });
        return status;
      } catch (error) {
        if (generation !== this.generation) return null;
        const detail = typeof error === "object" && error !== null
          ? JSON.stringify(error) : String(error);
        this.publish({ ...this.snapshot, phase: "error", error: detail });
        return null;
      } finally {
        if (this.pending?.generation === generation) this.pending = null;
      }
    })();
    this.pending = { generation, promise };
    this.tail = promise;
    return promise;
  }
}
