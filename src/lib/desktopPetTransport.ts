import type { BackgroundPetTask, DesktopPetSnapshot } from "./desktopPet";

export function desktopPetSnapshotFingerprint(snapshot: DesktopPetSnapshot): string {
  return JSON.stringify({
    mood: snapshot.mood,
    sessionId: snapshot.sessionId,
    daemonOnly: snapshot.daemonOnly,
    sessionTitle: snapshot.sessionTitle,
    projectName: snapshot.projectName,
    runningCount: snapshot.runningCount,
    attentionCount: snapshot.attentionCount,
    // Only success uses updatedAt to control a visible timeout in the pet window.
    updatedAt: snapshot.mood === "success" ? snapshot.updatedAt : 0,
    targets: snapshot.targets.map((target) => ({
      sessionId: target.sessionId,
      daemonOnly: target.daemonOnly,
      sessionTitle: target.sessionTitle,
      projectName: target.projectName,
      status: target.status,
      active: target.active,
      handoffEligible: target.handoffEligible,
      handedOff: target.handedOff,
      handoffPhase: target.handoffPhase,
    })),
    handoff: snapshot.handoff,
    handoffPlatforms: snapshot.handoffPlatforms,
    handoffBusy: snapshot.handoffBusy,
  });
}

export function sameBackgroundPetTasks(
  current: BackgroundPetTask[],
  next: BackgroundPetTask[]
): boolean {
  if (current.length !== next.length) return false;
  return current.every((task, index) => {
    const candidate = next[index];
    return task.sessionId === candidate.sessionId
      && task.cwd === candidate.cwd
      && task.alive === candidate.alive
      && task.taskStatus === candidate.taskStatus
      && task.taskUpdatedAtMs === candidate.taskUpdatedAtMs
      && task.createdAtMs === candidate.createdAtMs;
  });
}
