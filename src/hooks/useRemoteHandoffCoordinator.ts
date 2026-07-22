import { useCallback, useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { flushTerminalSnapshotsNow } from "../lib/sessionSnapshotPersistence";
import {
  getRemoteHandoffEligibility,
  REMOTE_HANDOFF_CANCEL_REQUEST_EVENT,
  REMOTE_HANDOFF_START_REQUEST_EVENT,
  type CcConnectHandoffInfo,
  type CcConnectPlatform,
  type CcConnectHandoffStatus,
} from "../lib/remoteHandoff";
import { findWorktreeForSession } from "../lib/terminalProject";
import type { RemoteHandoffSessionState } from "../lib/types";
import { useI18n, type TranslationKey } from "../lib/i18n";
import { logWarn } from "../lib/logger";
import { useProjectStore } from "../stores/projectStore";
import { useRemoteHandoffStore } from "../stores/remoteHandoffStore";
import { useTerminalStore } from "../stores/terminalStore";
import { useWorktreeStore } from "../stores/worktreeStore";

const HANDOFF_STATUS_POLL_MS = 2000;

const ERROR_TRANSLATIONS: Array<[string, TranslationKey]> = [
  ["cc_connect_not_running", "remoteHandoff.error.ccConnectNotRunning"],
  ["handoff_codex_only", "remoteHandoff.error.codexOnly"],
  ["handoff_project_not_registered", "remoteHandoff.error.projectMissing"],
  ["handoff_worktree_not_registered", "remoteHandoff.error.worktreeMissing"],
  ["handoff_worktree_missing", "remoteHandoff.error.worktreeMissing"],
  ["handoff_work_dir_missing", "remoteHandoff.error.pathMissing"],
  ["handoff_work_dir_outside_project", "remoteHandoff.error.pathInvalid"],
  ["handoff_work_dir_unsupported", "remoteHandoff.error.pathUnsupported"],
  ["handoff_platform_session_missing", "remoteHandoff.error.platformSessionMissing"],
  ["handoff_platform_user_missing", "remoteHandoff.error.platformUserMissing"],
  ["handoff_platform_disabled", "remoteHandoff.error.platformDisabled"],
  ["handoff_credentials_missing", "remoteHandoff.error.platformCredentialsMissing"],
  ["handoff_weixin_context_token_missing", "remoteHandoff.error.platformSessionMissing"],
  ["cc_connect_version_unsupported", "remoteHandoff.error.versionUnsupported"],
  ["remote_handoff_project_missing", "remoteHandoff.error.projectMissing"],
  ["remote_handoff_worktree_missing", "remoteHandoff.error.worktreeMissing"],
  ["remote_handoff_provider_mismatch", "remoteHandoff.error.providerMismatch"],
];

function handoffErrorMessage(
  error: unknown,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string
): string {
  const message = error instanceof Error ? error.message : String(error);
  const match = ERROR_TRANSLATIONS.find(([code]) => message.includes(code));
  return match ? t(match[1]) : t("remoteHandoff.error.generic", { error: message });
}

function activeMetadata(info: CcConnectHandoffInfo): RemoteHandoffSessionState {
  return {
    phase: "active",
    cliSessionId: info.cliSessionId,
    projectName: info.projectName,
    workDir: info.workDir,
    providerId: info.providerId ?? undefined,
    providerName: info.providerName,
    platform: info.platform,
    startedAtMs: info.startedAtMs,
  };
}

function metadataMatches(
  current: RemoteHandoffSessionState | undefined,
  next: RemoteHandoffSessionState
): boolean {
  return current?.phase === next.phase
    && current.cliSessionId === next.cliSessionId
    && current.projectName === next.projectName
    && current.workDir === next.workDir
    && current.providerId === next.providerId
    && current.providerName === next.providerName
    && current.platform === next.platform
    && current.startedAtMs === next.startedAtMs;
}

async function markLocalRecoveryFailed(sessionId: string): Promise<void> {
  const session = useTerminalStore
    .getState()
    .sessions
    .find((item) => item.id === sessionId);
  if (!session?.remoteHandoff) return;
  await useTerminalStore.getState().updateSessionRemoteHandoff(sessionId, {
    ...session.remoteHandoff,
    phase: "recovery_failed",
  });
}

export function useRemoteHandoffCoordinator(appReady: boolean) {
  const { t } = useI18n();
  const status = useRemoteHandoffStore((state) => state.status);
  const loaded = useRemoteHandoffStore((state) => state.loaded);
  const busy = useRemoteHandoffStore((state) => state.busy);
  const operationRef = useRef<"start" | "cancel" | "reconcile" | null>(null);

  const startHandoff = useCallback(async (
    sessionId: string,
    platform: CcConnectPlatform
  ) => {
    const remoteStore = useRemoteHandoffStore.getState();
    if (remoteStore.busy || operationRef.current) return;
    operationRef.current = "start";
    remoteStore.setBusy(true);
    try {
      const terminal = useTerminalStore.getState();
      const session = terminal.sessions.find((item) => item.id === sessionId);
      if (!session) {
        toast.error(t("remoteHandoff.toast.startFailed"), {
          description: t("remoteHandoff.error.sessionMissing"),
        });
        return;
      }
      const project = session.projectId
        ? useProjectStore.getState().projects.find((item) => item.id === session.projectId)
        : undefined;
      const worktree = findWorktreeForSession(
        session,
        terminal.sessions,
        useWorktreeStore.getState().worktrees
      );
      const eligibility = getRemoteHandoffEligibility({
        session,
        project,
        worktree,
        notification: terminal.tabNotifications[session.id] ?? "none",
        processStatus: terminal.sessionStatuses[session.id],
        activeHandoff: useRemoteHandoffStore.getState().status.info,
      });
      if (!eligibility.eligible || !project || !session.cliSessionId || !session.cwd) {
        toast.warning(t("remoteHandoff.toast.unavailable"), {
          description: t(
            eligibility.reason === "task_running"
              ? "remoteHandoff.error.taskRunning"
              : eligibility.reason === "task_state_unknown"
                ? "remoteHandoff.error.taskStateUnknown"
              : eligibility.reason === "missing_cli_session_id"
                  ? "remoteHandoff.error.sessionIdMissing"
                  : eligibility.reason === "another_session_handed_off"
                    ? "remoteHandoff.error.singleSessionOnly"
                    : "remoteHandoff.error.unavailable"
          ),
        });
        return;
      }

      const pending: RemoteHandoffSessionState = {
        phase: "pending",
        cliSessionId: session.cliSessionId,
        projectName: project.name,
        workDir: session.cwd,
      };
      try {
        await flushTerminalSnapshotsNow();
        await useTerminalStore.getState().suspendSessionForRemoteHandoff(session.id, pending);
        const nextStatus = await useRemoteHandoffStore.getState().start({
          localSessionId: session.id,
          cliSessionId: session.cliSessionId,
          platform,
          projectId: project.id,
          worktreeId: worktree?.id ?? null,
          workDir: session.cwd,
          sessionTitle: session.title || null,
        });
        if (!nextStatus.active || !nextStatus.info) {
          throw new Error("remote_handoff_start_incomplete");
        }
        await useTerminalStore.getState().updateSessionRemoteHandoff(
          session.id,
          activeMetadata(nextStatus.info)
        );
        toast.success(t("remoteHandoff.toast.started"));
      } catch (error) {
        let authoritativeStatus: CcConnectHandoffStatus | null = null;
        try {
          authoritativeStatus = await useRemoteHandoffStore.getState().refresh();
        } catch (refreshError) {
          logWarn("Failed to confirm ownership after remote handoff start failure", refreshError);
        }
        const locked = useTerminalStore
          .getState()
          .sessions
          .find((item) => item.id === session.id)?.remoteHandoff;
        if (locked && authoritativeStatus?.active && authoritativeStatus.info) {
          await useTerminalStore
            .getState()
            .updateSessionRemoteHandoff(session.id, activeMetadata(authoritativeStatus.info))
            .catch((metadataError) => {
              logWarn("Failed to persist authoritative remote handoff metadata", metadataError);
            });
          toast.success(t("remoteHandoff.toast.started"));
          return;
        } else if (locked && authoritativeStatus && !authoritativeStatus.active) {
          try {
            await useTerminalStore.getState().resumeSessionFromRemoteHandoff(session.id);
          } catch (resumeError) {
            await markLocalRecoveryFailed(session.id).catch((metadataError) => {
              logWarn("Failed to persist local recovery failure", metadataError);
            });
            logWarn("Failed to restore local session after remote handoff start failure", resumeError);
          }
        }
        toast.error(t("remoteHandoff.toast.startFailed"), {
          description: handoffErrorMessage(error, t),
        });
      }
    } finally {
      if (operationRef.current === "start") operationRef.current = null;
      useRemoteHandoffStore.getState().setBusy(false);
    }
  }, [t]);

  const cancelHandoff = useCallback(async () => {
    const remoteStore = useRemoteHandoffStore.getState();
    if (remoteStore.busy || operationRef.current) return;
    operationRef.current = "cancel";
    remoteStore.setBusy(true);
    let backendReleased = false;
    let lockedSessionId: string | null = null;
    try {
      const terminal = useTerminalStore.getState();
      const backendInfo = useRemoteHandoffStore.getState().status.info;
      const lockedSession = (
        backendInfo
          ? terminal.sessions.find((session) => session.id === backendInfo.localSessionId)
          : undefined
      ) ?? terminal.sessions.find((session) => Boolean(session.remoteHandoff));
      if (!lockedSession?.remoteHandoff && !backendInfo) {
        toast.warning(t("remoteHandoff.toast.noActiveHandoff"));
        return;
      }
      if (lockedSession?.remoteHandoff) {
        lockedSessionId = lockedSession.id;
        await terminal.updateSessionRemoteHandoff(lockedSession.id, {
          ...lockedSession.remoteHandoff,
          phase: "cancelling",
        });
      }

      const nextStatus = await useRemoteHandoffStore.getState().cancel();
      if (nextStatus.active) throw new Error("remote_handoff_cancel_incomplete");
      backendReleased = true;
      if (lockedSessionId) {
        await useTerminalStore.getState().resumeSessionFromRemoteHandoff(lockedSessionId);
      }
      toast.success(t("remoteHandoff.toast.cancelled"), {
        description: nextStatus.warning ?? undefined,
      });
    } catch (error) {
      if (!backendReleased) {
        try {
          const authoritativeStatus = await useRemoteHandoffStore.getState().refresh();
          backendReleased = !authoritativeStatus.active;
        } catch (refreshError) {
          logWarn("Failed to confirm ownership after remote handoff cancellation failure", refreshError);
        }
      }

      if (backendReleased) {
        if (lockedSessionId) {
          try {
            await useTerminalStore.getState().resumeSessionFromRemoteHandoff(lockedSessionId);
            toast.success(t("remoteHandoff.toast.cancelled"));
            return;
          } catch (resumeError) {
            await markLocalRecoveryFailed(lockedSessionId).catch((metadataError) => {
              logWarn("Failed to persist local recovery failure", metadataError);
            });
            toast.error(t("remoteHandoff.toast.localRecoveryFailed"), {
              description: handoffErrorMessage(resumeError, t),
            });
            return;
          }
        }
        toast.success(t("remoteHandoff.toast.cancelled"));
        return;
      }

      if (lockedSessionId) {
        const current = useTerminalStore
          .getState()
          .sessions
          .find((session) => session.id === lockedSessionId);
        if (current?.remoteHandoff) {
          await useTerminalStore.getState().updateSessionRemoteHandoff(lockedSessionId, {
            ...current.remoteHandoff,
            phase: "active",
          });
        }
      }
      toast.error(t("remoteHandoff.toast.cancelFailed"), {
        description: handoffErrorMessage(error, t),
      });
    } finally {
      if (operationRef.current === "cancel") operationRef.current = null;
      useRemoteHandoffStore.getState().setBusy(false);
    }
  }, [t]);

  useEffect(() => {
    if (!appReady) return;
    let disposed = false;
    useTerminalStore.getState().restorePersistedRemoteHandoffSessions();
    const refresh = async () => {
      try {
        await useRemoteHandoffStore.getState().refresh();
      } catch (error) {
        if (!disposed) logWarn("Failed to refresh remote handoff status", error);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), HANDOFF_STATUS_POLL_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [appReady]);

  useEffect(() => {
    if (!loaded || operationRef.current) return;
    const info = status.info;
    if (status.active && info) {
      const session = useTerminalStore
        .getState()
        .sessions
        .find((item) => item.id === info.localSessionId);
      if (!session) return;
      const next = activeMetadata(info);
      if (metadataMatches(session.remoteHandoff, next)) return;
      operationRef.current = "reconcile";
      useRemoteHandoffStore.getState().setBusy(true);
      void (async () => {
        try {
          if (!session.remoteHandoff) {
            await flushTerminalSnapshotsNow();
            await useTerminalStore.getState().suspendSessionForRemoteHandoff(session.id, next);
          } else {
            await useTerminalStore.getState().updateSessionRemoteHandoff(session.id, next);
          }
        } catch (error) {
          logWarn("Failed to reconcile remote handoff session lock", error);
        } finally {
          if (operationRef.current === "reconcile") operationRef.current = null;
          useRemoteHandoffStore.getState().setBusy(false);
        }
      })();
      return;
    }

    if (status.active) return;
    const orphanedLock = useTerminalStore
      .getState()
      .sessions
      .find((session) => (
        Boolean(session.remoteHandoff)
        && session.remoteHandoff?.phase !== "recovery_failed"
      ));
    if (!orphanedLock) return;
    operationRef.current = "reconcile";
    useRemoteHandoffStore.getState().setBusy(true);
    void (async () => {
      try {
        await useTerminalStore.getState().resumeSessionFromRemoteHandoff(orphanedLock.id);
        toast.success(t("remoteHandoff.toast.localRestored"));
      } catch (error) {
        await markLocalRecoveryFailed(orphanedLock.id).catch((metadataError) => {
          logWarn("Failed to persist local recovery failure", metadataError);
        });
        toast.error(t("remoteHandoff.toast.localRecoveryFailed"), {
          description: handoffErrorMessage(error, t),
        });
      } finally {
        if (operationRef.current === "reconcile") operationRef.current = null;
        useRemoteHandoffStore.getState().setBusy(false);
      }
    })();
  }, [loaded, status, t]);

  useEffect(() => {
    const unlistenStart = listen<{ sessionId: string; platform: CcConnectPlatform }>(
      REMOTE_HANDOFF_START_REQUEST_EVENT,
      (event) => void startHandoff(event.payload.sessionId, event.payload.platform)
    );
    const unlistenCancel = listen(
      REMOTE_HANDOFF_CANCEL_REQUEST_EVENT,
      () => void cancelHandoff()
    );
    return () => {
      void unlistenStart.then((unlisten) => unlisten());
      void unlistenCancel.then((unlisten) => unlisten());
    };
  }, [cancelHandoff, startHandoff]);

  return { status, busy, startHandoff, cancelHandoff };
}
