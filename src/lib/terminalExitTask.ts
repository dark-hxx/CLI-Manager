export type TerminalExitNotificationState =
  | "none"
  | "running"
  | "attention"
  | "done"
  | "failed";

export interface TerminalExitTaskCandidate {
  kind?: string | null;
  processStatus?: string | null;
  mergedStatus?: TerminalExitNotificationState | null;
  hookStatus?: TerminalExitNotificationState | null;
}

export interface DaemonExitTaskCandidate {
  alive: boolean;
  taskStatus?: string | null;
}

export function shouldIncludeTerminalExitTask(
  candidate: TerminalExitTaskCandidate,
  includeFinished = false
): boolean {
  if (candidate.kind && candidate.kind !== "pty") return false;

  if (candidate.processStatus === "running" && candidate.mergedStatus === "running") {
    return true;
  }

  if (!includeFinished) return false;

  return candidate.hookStatus === "done" || candidate.hookStatus === "failed";
}

export function shouldIncludeDaemonExitTask(
  candidate: DaemonExitTaskCandidate,
  includeFinished = false
): boolean {
  const taskStatus = candidate.taskStatus?.trim().toLowerCase();
  const finished = taskStatus === "done" || taskStatus === "failed" || taskStatus === "completed";
  if (finished) return includeFinished;
  return candidate.alive;
}
