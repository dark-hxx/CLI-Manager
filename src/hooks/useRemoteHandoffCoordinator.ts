import { useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { flushTerminalSnapshotsNow } from "../lib/sessionSnapshotPersistence";
import {
  getRemoteHandoffEligibility,
  getRemoteHandoffWorkDir,
  preflightRemoteHandoff,
  resolveRemoteHandoffAgent,
  REMOTE_HANDOFF_CANCEL_REQUEST_EVENT,
  REMOTE_HANDOFF_START_REQUEST_EVENT,
  type CcConnectHandoffInfo,
  type CcConnectPlatform,
  type CcConnectHandoffStatus,
} from "../lib/remoteHandoff";
import { findWorktreeForSession } from "../lib/terminalProject";
import { detectCodexLaunchSessionSelection } from "../lib/resumeCliArgs";
import { selectUniqueSshCodexSessionBinding } from "../lib/sshCodexSessionBinding";
import type { Project, RemoteHandoffSessionState, TerminalSession } from "../lib/types";
import { useI18n, type TranslationKey } from "../lib/i18n";
import { logWarn } from "../lib/logger";
import { useProjectStore } from "../stores/projectStore";
import { useRemoteHandoffStore } from "../stores/remoteHandoffStore";
import { useTerminalStore } from "../stores/terminalStore";
import { useWorktreeStore } from "../stores/worktreeStore";
import { useSshHostStore } from "../stores/sshHostStore";
import { fetchRemoteProjectSessionSummaries } from "../stores/historyStore";

const HANDOFF_STATUS_POLL_MS = 2000;

const ERROR_TRANSLATIONS: Array<[string, TranslationKey]> = [
  ["cc_connect_not_running", "remoteHandoff.error.ccConnectNotRunning"],
  ["handoff_agent_mismatch", "remoteHandoff.error.agentMismatch"],
  ["handoff_agent_unsupported", "remoteHandoff.error.agentUnsupported"],
  ["handoff_ssh_agent_unsupported", "remoteHandoff.error.sshAgentUnsupported"],
  ["handoff_agent_unavailable", "remoteHandoff.error.agentUnavailable"],
  ["handoff_project_not_registered", "remoteHandoff.error.projectMissing"],
  ["handoff_worktree_not_registered", "remoteHandoff.error.worktreeMissing"],
  ["handoff_worktree_missing", "remoteHandoff.error.worktreeMissing"],
  ["handoff_work_dir_missing", "remoteHandoff.error.pathMissing"],
  ["handoff_work_dir_outside_project", "remoteHandoff.error.pathInvalid"],
  ["handoff_work_dir_unsupported", "remoteHandoff.error.pathUnsupported"],
  ["handoff_ssh_worktree_unsupported", "remoteHandoff.error.sshWorktreeUnsupported"],
  ["handoff_ssh_host_missing", "remoteHandoff.error.sshHostMissing"],
  ["handoff_ssh_jump_host_missing", "remoteHandoff.error.sshJumpHostMissing"],
  ["ssh_host_not_found", "remoteHandoff.error.sshHostMissing"],
  ["ssh_credential_ref_required", "remoteHandoff.error.sshCredentialMissing"],
  ["ssh_credential_missing", "remoteHandoff.error.sshCredentialMissing"],
  ["ssh_config_file_not_found", "remoteHandoff.error.sshConfigurationChanged"],
  ["ssh_config_file_invalid", "remoteHandoff.error.sshConfigurationChanged"],
  ["handoff_ssh_interactive_auth_unsupported", "remoteHandoff.error.sshInteractiveAuthUnsupported"],
  ["handoff_codex_backend_unavailable", "remoteHandoff.error.remoteCodexUnavailable"],
  ["handoff_platform_session_missing", "remoteHandoff.error.platformSessionMissing"],
  ["handoff_platform_user_missing", "remoteHandoff.error.platformUserMissing"],
  ["handoff_platform_disabled", "remoteHandoff.error.platformDisabled"],
  ["handoff_credentials_missing", "remoteHandoff.error.platformCredentialsMissing"],
  ["handoff_weixin_context_token_missing", "remoteHandoff.error.platformSessionMissing"],
  ["cc_connect_version_unsupported", "remoteHandoff.error.versionUnsupported"],
  ["remote_handoff_project_missing", "remoteHandoff.error.projectMissing"],
  ["remote_handoff_worktree_missing", "remoteHandoff.error.worktreeMissing"],
  ["remote_handoff_provider_mismatch", "remoteHandoff.error.providerMismatch"],
  ["provider_not_found", "remoteHandoff.error.providerMismatch"],
  ["provider_snapshot_", "remoteHandoff.error.providerMismatch"],
  ["remote_handoff_ssh_project_mismatch", "remoteHandoff.error.sshConfigurationChanged"],
  ["remote_handoff_ssh_host_mismatch", "remoteHandoff.error.sshConfigurationChanged"],
  ["remote_handoff_ssh_path_mismatch", "remoteHandoff.error.sshConfigurationChanged"],
  ["ssh_agent_not_installed", "remoteHandoff.error.sshAgentRequired"],
  ["remote_handoff_ssh_session_not_found", "remoteHandoff.error.remoteSessionNotFound"],
  ["remote_handoff_ssh_session_ambiguous", "remoteHandoff.error.remoteSessionAmbiguous"],
  ["remote_handoff_terminal_start_missing", "remoteHandoff.error.terminalStartMissing"],
  ["remote_handoff_session_identity_changed", "remoteHandoff.error.sessionIdentityChanged"],
];

interface DaemonSessionIdentity {
  sessionId: string;
  createdAtMs?: number;
}

async function resolveSshHandoffSessionIdentity(
  session: TerminalSession,
  project: Project,
): Promise<TerminalSession> {
  let terminalStartedAtMs = session.createdAtMs ?? 0;
  if (!Number.isFinite(terminalStartedAtMs) || terminalStartedAtMs <= 0) {
    const daemonSession = (await invoke<DaemonSessionIdentity[]>("pty_daemon_sessions"))
      .find((candidate) => candidate.sessionId === session.id);
    terminalStartedAtMs = daemonSession?.createdAtMs ?? 0;
  }
  if (!Number.isFinite(terminalStartedAtMs) || terminalStartedAtMs <= 0) {
    throw new Error("remote_handoff_terminal_start_missing");
  }

  const { context, summaries } = await fetchRemoteProjectSessionSummaries(project);
  const terminalState = useTerminalStore.getState();
  const alreadyBoundSessionIds = new Set(
    terminalState.sessions
      .filter((candidate) => candidate.id !== session.id)
      .map((candidate) => candidate.cliSessionId?.trim())
      .filter((sessionId): sessionId is string => Boolean(sessionId)),
  );
  const selection = selectUniqueSshCodexSessionBinding({
    summaries,
    terminalStartedAtMs,
    terminalActivityAtMs: terminalState.ptyOutputActivityAt[session.id] ?? 0,
    nowMs: Date.now(),
    alreadyBoundSessionIds,
    launchSelection: detectCodexLaunchSessionSelection(session.startupCmd),
  });
  if (selection.status === "not_found") {
    throw new Error("remote_handoff_ssh_session_not_found");
  }
  if (selection.status === "ambiguous") {
    throw new Error("remote_handoff_ssh_session_ambiguous");
  }

  const bound = await useTerminalStore.getState().bindRemoteCliSessionIdentity(
    session.id,
    selection.sessionId,
    selection.sourceInstanceId || context.sourceInstanceId,
  );
  const resolved = useTerminalStore
    .getState()
    .sessions
    .find((candidate) => candidate.id === session.id);
  if (!bound || resolved?.cliSessionId !== selection.sessionId) {
    throw new Error("remote_handoff_session_identity_changed");
  }
  return resolved;
}

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
    agent: info.agent,
    cliSessionId: info.cliSessionId,
    projectName: info.projectName,
    workDir: info.workDir,
    providerId: info.providerId ?? undefined,
    providerName: info.providerName,
    platform: info.platform,
    startedAtMs: info.startedAtMs,
    transport: info.transport,
    sshHostId: info.sshHostId ?? undefined,
    remotePath: info.remotePath ?? undefined,
  };
}

function metadataMatches(
  current: RemoteHandoffSessionState | undefined,
  next: RemoteHandoffSessionState
): boolean {
  return current?.phase === next.phase
    && current.agent === next.agent
    && current.cliSessionId === next.cliSessionId
    && current.projectName === next.projectName
    && current.workDir === next.workDir
    && current.providerId === next.providerId
    && current.providerName === next.providerName
    && current.platform === next.platform
    && current.startedAtMs === next.startedAtMs
    && current.transport === next.transport
    && current.sshHostId === next.sshHostId
    && current.remotePath === next.remotePath;
}

function eligibilityTranslation(reason: ReturnType<typeof getRemoteHandoffEligibility>["reason"]): TranslationKey {
  switch (reason) {
    case "task_running": return "remoteHandoff.error.taskRunning";
    case "task_state_unknown": return "remoteHandoff.error.taskStateUnknown";
    case "missing_cli_session_id": return "remoteHandoff.error.sessionIdMissing";
    case "another_session_handed_off": return "remoteHandoff.error.singleSessionOnly";
    case "ssh_worktree_unsupported": return "remoteHandoff.error.sshWorktreeUnsupported";
    case "ssh_host_missing": return "remoteHandoff.error.sshHostMissing";
    case "ssh_interactive_auth_unsupported": return "remoteHandoff.error.sshInteractiveAuthUnsupported";
    case "unsupported_agent": return "remoteHandoff.error.agentUnsupported";
    case "agent_mismatch": return "remoteHandoff.error.agentMismatch";
    case "ssh_agent_unsupported": return "remoteHandoff.error.sshAgentUnsupported";
    case "path_unsupported": return "remoteHandoff.error.pathUnsupported";
    default: return "remoteHandoff.error.unavailable";
  }
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
      let session = terminal.sessions.find((item) => item.id === sessionId);
      if (!session) {
        toast.error(t("remoteHandoff.toast.startFailed"), {
          description: t("remoteHandoff.error.sessionMissing"),
        });
        return;
      }
      const sessionProjectId = session.projectId;
      const project = sessionProjectId
        ? useProjectStore.getState().projects.find((item) => item.id === sessionProjectId)
        : undefined;
      const worktree = findWorktreeForSession(
        session,
        terminal.sessions,
        useWorktreeStore.getState().worktrees
      );
      if (project?.environment_type === "ssh" && !useSshHostStore.getState().loaded) {
        try {
          await useSshHostStore.getState().fetchHosts();
        } catch (error) {
          logWarn("Failed to load SSH hosts for remote handoff", error);
          toast.error(t("remoteHandoff.toast.startFailed"), {
            description: handoffErrorMessage(error, t),
          });
          return;
        }
      }
      const sshHost = project?.ssh_host_id
        ? useSshHostStore.getState().hosts.find((host) => host.id === project.ssh_host_id)
        : undefined;
      let eligibility = getRemoteHandoffEligibility({
        session,
        project,
        sshHost,
        worktree,
        notification: terminal.tabNotifications[session.id] ?? "none",
        processStatus: terminal.sessionStatuses[session.id],
        activeHandoff: useRemoteHandoffStore.getState().status.info,
      });
      if (
        !eligibility.eligible
        && eligibility.reason === "missing_cli_session_id"
        && project?.environment_type === "ssh"
      ) {
        try {
          session = await resolveSshHandoffSessionIdentity(session, project);
          const currentTerminal = useTerminalStore.getState();
          eligibility = getRemoteHandoffEligibility({
            session,
            project,
            sshHost,
            worktree,
            notification: currentTerminal.tabNotifications[session.id] ?? "none",
            processStatus: currentTerminal.sessionStatuses[session.id],
            activeHandoff: useRemoteHandoffStore.getState().status.info,
          });
        } catch (error) {
          logWarn("Failed to resolve SSH Codex session identity for remote handoff", error);
          toast.error(t("remoteHandoff.toast.startFailed"), {
            description: handoffErrorMessage(error, t),
          });
          return;
        }
      }
      const workDir = getRemoteHandoffWorkDir(session, project);
      const agent = resolveRemoteHandoffAgent(session, project).agent;
      if (!eligibility.eligible || !project || !session.cliSessionId || !workDir || !agent) {
        toast.warning(t("remoteHandoff.toast.unavailable"), {
          description: t(eligibilityTranslation(eligibility.reason)),
        });
        return;
      }

      const request = {
        agent,
        localSessionId: session.id,
        cliSessionId: session.cliSessionId,
        platform,
        projectId: project.id,
        worktreeId: worktree?.id ?? null,
        workDir,
        sessionTitle: session.title || null,
      };
      const pending: RemoteHandoffSessionState = {
        phase: "pending",
        agent,
        cliSessionId: session.cliSessionId,
        projectName: project.name,
        workDir,
        transport: project.environment_type === "ssh" ? "ssh" : "local",
        sshHostId: project.ssh_host_id ?? undefined,
        remotePath: project.environment_type === "ssh" ? workDir : undefined,
      };
      try {
        await preflightRemoteHandoff(request);
        await flushTerminalSnapshotsNow();
        await useTerminalStore.getState().suspendSessionForRemoteHandoff(session.id, pending);
        const nextStatus = await useRemoteHandoffStore.getState().start(request);
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
