export type ExitStage = "backup" | "snapshots" | "terminals" | "discard";
export type ExitOutcome = "completed" | "failed" | "timeout" | "pending";
export interface ExitStageResult<T> { outcome: ExitOutcome; value?: T; error?: unknown }
export interface ExitStageEvent { stage: ExitStage; outcome: ExitOutcome | "started"; elapsedMs: number }

// A deadline stops waiting, not an underlying disk/network operation. Retain its ownership until settled.
export function createExitStageRunner(report: (event: ExitStageEvent) => void = () => {}) {
  const pending = new Map<ExitStage, Promise<unknown>>();
  const emit = (event: ExitStageEvent) => { try { report(event); } catch { /* Diagnostics must not block exit. */ } };
  return {
    isPending: (stage: ExitStage) => pending.has(stage),
    waitFor: (stage: ExitStage) => Promise.resolve(pending.get(stage)).then(() => undefined, () => undefined),
    async run<T>(stage: ExitStage, work: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<ExitStageResult<T>> {
      if (pending.has(stage)) return { outcome: "pending" };
      const started = performance.now(), lifetime = new AbortController();
      emit({ stage, outcome: "started", elapsedMs: 0 });
      const operation = Promise.resolve().then(() => work(lifetime.signal));
      pending.set(stage, operation);
      const clear = () => { if (pending.get(stage) === operation) pending.delete(stage); };
      void operation.then(clear, clear);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<ExitStageResult<T>>(resolve => {
        timer = setTimeout(() => {
          lifetime.abort(new Error(`Exit stage ${stage} timed out`));
          resolve({ outcome: "timeout" });
        }, timeoutMs);
      });
      const result = await Promise.race([
        operation.then<ExitStageResult<T>, ExitStageResult<T>>(value => ({ outcome: "completed", value }), error => ({ outcome: "failed", error })),
        timeout,
      ]);
      clearTimeout(timer);
      emit({ stage, outcome: result.outcome, elapsedMs: Math.round(performance.now() - started) });
      return result;
    },
  };
}

export type ExitStageRunner = ReturnType<typeof createExitStageRunner>;

// Do not let delayed settings loading start a backup after its close attempt has expired.
export function runExitBackup<T>(runner: ExitStageRunner, dependencies: { load: () => Promise<void>; backup: () => Promise<T> }, timeoutMs = 8000) {
  return runner.run("backup", async signal => {
    await dependencies.load();
    if (signal.aborted) throw signal.reason;
    return dependencies.backup();
  }, timeoutMs);
}

// Failed required stages retain recovery data and the window; callers must not mistake timeout for success.
export async function requireExitStage<T>(runner: ExitStageRunner, stage: ExitStage, work: () => Promise<T>, timeoutMs: number): Promise<T> {
  const result = await runner.run(stage, work, timeoutMs);
  if (result.outcome !== "completed") throw Object.assign(new Error(`Exit stage ${stage}: ${result.outcome}`), { cause: result.error });
  return result.value as T;
}
