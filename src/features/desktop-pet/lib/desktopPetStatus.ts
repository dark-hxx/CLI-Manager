import type { TabNotificationState, TabStatusDetails } from "../../terminal/state";
import type { BackgroundPetTask } from "../api/desktopPet";

export const DESKTOP_PET_OUTPUT_ACTIVITY_TTL_MS = 6000;

function timestampFromDetails(details: TabStatusDetails | undefined): number {
  if (!details?.updatedAt) return 0;
  const parsed = Date.parse(details.updatedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function explicitDaemonTaskStatus(task: BackgroundPetTask | undefined): TabNotificationState | null {
  if (
    task?.taskStatus === "running"
    || task?.taskStatus === "attention"
    || task?.taskStatus === "done"
    || task?.taskStatus === "failed"
  ) {
    return task.taskStatus;
  }
  return null;
}

export function resolveDesktopPetOpenSessionStatus(input: {
  frontendStatus: TabNotificationState;
  frontendDetails?: TabStatusDetails;
  daemonTask?: BackgroundPetTask;
  outputActivityAt: number;
  now: number;
}): { status: TabNotificationState; updatedAt: number } {
  const frontendUpdatedAt = timestampFromDetails(input.frontendDetails);
  const daemonStatus = explicitDaemonTaskStatus(input.daemonTask);
  const daemonUpdatedAt = input.daemonTask?.taskUpdatedAtMs
    ?? input.daemonTask?.createdAtMs
    ?? 0;
  const resolved = daemonStatus && (frontendUpdatedAt === 0 || daemonUpdatedAt >= frontendUpdatedAt)
    ? { status: daemonStatus, updatedAt: daemonUpdatedAt }
    : { status: input.frontendStatus, updatedAt: frontendUpdatedAt };

  // PTY output is only an activity hint. Once Hook/daemon has supplied a task
  // lifecycle state, terminal repaint output must never reopen a finished turn.
  if (resolved.status !== "none") return resolved;
  const recentOutput = input.outputActivityAt > 0
    && input.now >= input.outputActivityAt
    && input.now - input.outputActivityAt <= DESKTOP_PET_OUTPUT_ACTIVITY_TTL_MS;
  return recentOutput
    ? { status: "running", updatedAt: input.outputActivityAt }
    : resolved;
}
