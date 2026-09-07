import { invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { toast } from "sonner";
import type { TerminalSession } from "../../../shared/types/index";
import { sourceTool } from "../../history/api/externalSessionGrouping";
import { logError, logInfo, logWarn, recordCrashActivity } from "../../../shared/platform/logger";
import { normalizeDirectCodexStartupCommand } from "../../projects/api/projectStartupCommand";
import { useSettingsStore } from "../../../shared/preferences/settingsStore";
import { useSessionStore } from "../api/sessionStore";
import { getOsPlatform, normalizeShellKey } from "../../../shared/platform/shell";
import { parseProjectEnvVars } from "../../providers/api/providerSwitching";
import { useProjectStore } from "../../projects/api/projectStore";
import { createGitDiffWorkspaceContext, useGitDiffWorkspaceStore } from "../../git/api/gitDiffWorkspaceStore";
import { translateCurrent } from "../../../shared/i18n/index";
import { buildRemoteHandoffResumeCommand } from "../../history/api/historyResumeCommand";
import { terminalProcessManager } from "../api/TerminalProcessManager";
import { shouldIncludeTerminalExitTask } from "../api/terminalExitTask";
import {
  addSessionToPaneTree, findPaneLeaf, findPaneLeafBySession,
  getNextSessionIdForShortcut as resolveNextSessionIdForShortcut,
  moveSessionToPane as moveSessionToPaneTree, reorderSessionInPane, resizePaneSplit,
  setPaneActiveSession, splitPaneEmpty as splitPaneEmptyTree, splitPaneLeaf,
  splitExistingSessionToPaneEdge, unsplitPaneLeaf,
} from "../api/terminalPaneTree";
import {
  collapseTerminalWorkspansToLegacy, collectWorkspanSessionIds, createTerminalWorkspan,
  detachTerminalSessionToWorkspan, detachTerminalWorkspanSessions, findWorkspanByPane,
  findWorkspanBySession, getAdjacentWorkspanSessionId, mergeTerminalWorkspansAtPaneEdge,
  removeSessionFromTerminalWorkspans, reorderTerminalWorkspans, restoreTerminalWorkspans,
  sanitizeTerminalWorkspans, syncTerminalWorkspanLayout, updateTerminalWorkspan,
  type TerminalWorkspan,
} from "../api/terminalWorkspan";
import {
  type SessionStatus, type TabNotificationState, type DaemonSessionMeta, type TerminalStore,
  type WindowWithPtyOrphanTimer, type ResolvedPtyLaunch,
} from "../types/terminalStoreTypes";
import {
  buildWorkspanMirror, persistWorkspanState, createFileEditorSessionId,
  clearProjectEditorWorkspacesIfUnused, isPersistableSession, hasBackendPty, createSplitSessionTitle,
  releaseRemoteHistoryConsumer,
} from "../lib/terminalStoreLayout";
import { normalizeRemotePathForCompare } from "../lib/subagentTranscriptModel";
import {
  detectCliResumeKind, buildCliResumeStartupCommand, formatStartupInputForPty,
  getProjectAgentTerminalMetadata, getRestoredAgentTerminalMetadata, garbageCollectProviderSnapshots,
  releaseProviderSnapshot, resolvePtyLaunch, createDetachedPtyProcess,
} from "../lib/terminalLaunch";
import {
  PTY_OUTPUT_ACTIVITY_UPDATE_INTERVAL_MS, formatTerminalCreateError, resolveDaemonAttachTaskStatus,
  resolveDaemonAttachUpdatedAt, resolveAttachedDaemonSession, PTY_ORPHAN_RECONCILE_INTERVAL_MS,
  TERMINAL_STORE_IN_TAURI, summarizeStartupCmd, logTerminalExitStatus, buildTabStatusUpdate,
  applyPtyStatusToSessions, isCliManagerSyncArtifactText,
} from "../lib/terminalStatus";
import { create } from "zustand";
import { createTerminalRuntime } from "./terminalRuntime";

let restoreInProgress = false;

function startPtyOrphanReconcileHeartbeat() {
  if (!TERMINAL_STORE_IN_TAURI || typeof window === "undefined") return;
  const host = window as WindowWithPtyOrphanTimer;
  if (host.__CLI_MANAGER_PTY_ORPHAN_RECONCILE_TIMER__) return;
  host.__CLI_MANAGER_PTY_ORPHAN_RECONCILE_TIMER__ = setInterval(() => {
    const activeSessionIds = useTerminalStore
      .getState()
      .sessions
      .filter(hasBackendPty)
      .map((session) => session.id);
    if (activeSessionIds.length === 0) return;
    void invoke("pty_reconcile_active_sessions", { activeSessionIds }).catch((err) => {
      logError("pty_reconcile_active_sessions invoke failed", { activeSessionIds: activeSessionIds.length, err });
    });
  }, PTY_ORPHAN_RECONCILE_INTERVAL_MS);
}

export const useTerminalStore = create<TerminalStore>((set, get, api) => {
  const { actions: runtimeActions,
    queueSshSessionPersistence,
    clearHookRunningTimeout,
    persistSshConnectionStateAfterPtyStatus,
    createWorkspanId,
    createPaneId,
    subagentCloseTimers,
    stopSubagentTranscriptRetry,
    scheduleSaveActiveId,
  } = createTerminalRuntime(set, get, api);
  return {
    sessions: [],
    activeSessionId: null,
    paneTree: null,
    activePaneId: null,
    workspans: [],
    activeWorkspanId: null,
    sessionStatuses: {},
    statusListeners: {},
    tabNotifications: {},
    tabStatuses: {},
    tabStatusDetails: {},
    ptyOutputActivityAt: {},
    splits: {},
    hiddenBackgroundSessionIds: new Set<string>(),
    daemonAttachPendingSessionIds: new Set<string>(),
    subagentTranscripts: {},
    statsPanelRefreshSeq: 0,

    bumpStatsPanelRefresh: () => set((state) => ({
      statsPanelRefreshSeq: state.statsPanelRefreshSeq + 1,
    })),

    updateSessionCwd: (sessionId, cwd) => set((state) => ({
      sessions: state.sessions.map((session) => (
        session.id === sessionId ? { ...session, cwd } : session
      )),
    })),

    updateSshConnectionState: (sessionId, connectionState, disconnectReason) => {
      const current = get().sessions.find((session) => session.id === sessionId);
      if (!current || current.environmentType !== "ssh") return;
      const nextReason = connectionState === "disconnected" || connectionState === "failed"
        ? disconnectReason
        : undefined;
      if (current.connectionState === connectionState && current.disconnectReason === nextReason) return;
      set((state) => ({
        sessions: state.sessions.map((session) => (
          session.id === sessionId
            ? { ...session, connectionState, disconnectReason: nextReason }
            : session
        )),
      }));
      if (connectionState === "connected" || connectionState === "disconnected" || connectionState === "failed") {
        queueSshSessionPersistence(get().sessions);
      }
    },

    updateSessionTerminalSnapshot: (sessionId, initialTerminalOutput) => set((state) => ({
      sessions: state.sessions.map((session) => (
        session.id === sessionId && (session.kind ?? "pty") === "pty" && session.initialTerminalOutput !== initialTerminalOutput
          ? { ...session, initialTerminalOutput }
          : session
      )),
    })),

    suspendSessionForRemoteHandoff: async (sessionId, handoff) => {
      const state = get();
      const session = state.sessions.find((item) => item.id === sessionId);
      if (!session || (session.kind ?? "pty") !== "pty") {
        throw new Error("remote_handoff_session_missing");
      }
      if (session.remoteHandoff) {
        await get().updateSessionRemoteHandoff(sessionId, handoff);
        return;
      }

      set((current) => ({
        sessions: current.sessions.map((item) => (
          item.id === sessionId ? { ...item, remoteHandoff: handoff } : item
        )),
      }));
      try {
        await terminalProcessManager.close(sessionId);
      } catch (error) {
        set((current) => ({
          sessions: current.sessions.map((item) => (
            item.id === sessionId && item.remoteHandoff === handoff
              ? { ...item, remoteHandoff: undefined }
              : item
          )),
        }));
        throw error;
      }
      state.statusListeners[sessionId]?.();
      clearHookRunningTimeout(sessionId);

      const nextSessions = get().sessions;
      const sessionStatuses = { ...get().sessionStatuses, [sessionId]: "exited" as SessionStatus };
      const statusListeners = { ...get().statusListeners };
      const tabNotifications = { ...get().tabNotifications, [sessionId]: "none" as TabNotificationState };
      const tabStatuses = { ...get().tabStatuses };
      const tabStatusDetails = { ...get().tabStatusDetails };
      const ptyOutputActivityAt = { ...get().ptyOutputActivityAt };
      delete statusListeners[sessionId];
      delete tabStatuses[sessionId];
      delete tabStatusDetails[sessionId];
      delete ptyOutputActivityAt[sessionId];
      set({
        sessions: nextSessions,
        sessionStatuses,
        statusListeners,
        tabNotifications,
        tabStatuses,
        tabStatusDetails,
        ptyOutputActivityAt,
      });
      await useSessionStore.getState().saveSessions(nextSessions);
    },

    updateSessionRemoteHandoff: async (sessionId, handoff) => {
      const state = get();
      if (!state.sessions.some((session) => session.id === sessionId)) return;
      const sessions = state.sessions.map((session) => (
        session.id === sessionId ? { ...session, remoteHandoff: handoff } : session
      ));
      set({ sessions });
      await useSessionStore.getState().saveSessions(sessions);
    },

    resumeSessionFromRemoteHandoff: async (sessionId) => {
      const state = get();
      const lockedSession = state.sessions.find((session) => session.id === sessionId);
      if (!lockedSession?.remoteHandoff) {
        throw new Error("remote_handoff_session_missing");
      }
      const projectState = useProjectStore.getState();
      const project = lockedSession.projectId
        ? projectState.projects.find((item) => item.id === lockedSession.projectId)
        : undefined;
      if (!project) throw new Error("remote_handoff_project_missing");
      const sshHandoff = lockedSession.remoteHandoff.transport === "ssh"
        || project.environment_type === "ssh";
      if (
        lockedSession.worktreeId
        && !sshHandoff
        && !projectState.worktrees.some((worktree) => (
          worktree.id === lockedSession.worktreeId
          && worktree.project_id === project.id
          && worktree.status === "active"
        ))
      ) {
        throw new Error("remote_handoff_worktree_missing");
      }
      if (sshHandoff && lockedSession.worktreeId) {
        throw new Error("handoff_ssh_worktree_unsupported");
      }
      if (sshHandoff && project.environment_type !== "ssh") {
        throw new Error("remote_handoff_ssh_project_mismatch");
      }
      const recordedSshHostId = lockedSession.remoteHandoff.sshHostId?.trim()
        || lockedSession.sshHostId?.trim()
        || "";
      if (
        sshHandoff
        && (!recordedSshHostId || project.ssh_host_id?.trim() !== recordedSshHostId)
      ) {
        throw new Error("remote_handoff_ssh_host_mismatch");
      }
      const recordedRemotePath = lockedSession.remoteHandoff.remotePath?.trim()
        || lockedSession.remoteHandoff.workDir.trim()
        || lockedSession.remotePath?.trim()
        || "";
      if (
        sshHandoff
        && (
          !recordedRemotePath
          || normalizeRemotePathForCompare(project.remote_path)
          !== normalizeRemotePathForCompare(recordedRemotePath)
        )
      ) {
        throw new Error("remote_handoff_ssh_path_mismatch");
      }

      const os = await getOsPlatform();
      const resumeProject = project;
      const recordedProviderId = lockedSession.remoteHandoff.providerId?.trim() || null;
      // 与 restoreSessions 一致：不复用持久化快照（可能已 release/GC，也不反映当前覆盖状态），
      // 一律 release 后按当前 scope 重新解析；recordedProviderId 非空时作为显式恢复。
      const handoffAgent = lockedSession.remoteHandoff.agent ?? "codex";
      if (sshHandoff && handoffAgent !== "codex") {
        throw new Error("handoff_ssh_agent_unsupported");
      }
      const resumeCommand = buildRemoteHandoffResumeCommand(
        handoffAgent,
        lockedSession.remoteHandoff.cliSessionId || lockedSession.cliSessionId || "",
        resumeProject,
      );
      if (!resumeCommand) throw new Error("remote_handoff_session_id_invalid");
      const launch: ResolvedPtyLaunch = sshHandoff
        ? await resolvePtyLaunch({
          projectId: project.id,
          sshHostId: recordedSshHostId,
          cwd: recordedRemotePath,
          startupCmd: resumeCommand,
          envVars: lockedSession.envVars,
          shell: null,
        }, os)
        : await resolvePtyLaunch({
          projectId: project.id,
          worktreeId: lockedSession.worktreeId,
          cwd: lockedSession.remoteHandoff.workDir || lockedSession.cwd || null,
          startupCmd: resumeCommand,
          envVars: lockedSession.envVars,
          shell: lockedSession.shell,
          providerSnapshot: lockedSession.providerSnapshot,
          providerId: handoffAgent === "claude" || handoffAgent === "codex"
            ? recordedProviderId
            : null,
        }, os);
      const newSessionId = await terminalProcessManager.create(launch.invokeArgs);
      const replacement: TerminalSession = {
        ...lockedSession,
        id: newSessionId,
        createdAtMs: Date.now(),
        shell: launch.shell,
        environmentType: launch.environmentType ?? lockedSession.environmentType,
        sshHostId: launch.sshHostId ?? lockedSession.sshHostId,
        remotePath: launch.remotePath ?? lockedSession.remotePath,
        connectionState: sshHandoff ? "connecting" : lockedSession.connectionState,
        disconnectReason: undefined,
        // 不回退到旧快照：旧 snapshotId 可能已被 release/GC，且不反映当前覆盖状态。
        providerSnapshot: launch.providerSnapshot ?? undefined,
        remoteHandoff: undefined,
        initialTerminalOutput: undefined,
        deferStartupUntilInitialOutput: false,
      };
      const unlisten = await terminalProcessManager.subscribeStatus(newSessionId, (payload) => {
        const status = payload.status as SessionStatus;
        logTerminalExitStatus(replacement, payload);
        useTerminalStore.setState((current) => ({
          sessions: applyPtyStatusToSessions(current.sessions, newSessionId, payload),
          sessionStatuses: { ...current.sessionStatuses, [newSessionId]: status },
        }));
        persistSshConnectionStateAfterPtyStatus(newSessionId, payload);
        if (status === "exited" || status === "error") {
          releaseRemoteHistoryConsumer(replacement);
        }
      }).catch(async (err) => {
        await terminalProcessManager.close(newSessionId).catch(() => { });
        throw err;
      });

      const current = get();
      if (!current.sessions.some((session) => session.id === sessionId && session.remoteHandoff)) {
        unlisten();
        await terminalProcessManager.close(newSessionId).catch(() => { });
        throw new Error("remote_handoff_session_changed");
      }
      const sessions = current.sessions.map((session) => (
        session.id === sessionId ? replacement : session
      ));
      const sessionIdMap = Object.fromEntries(
        current.sessions.map((session) => [session.id, session.id === sessionId ? newSessionId : session.id])
      );
      const workspans = restoreTerminalWorkspans(current.workspans, sessionIdMap);
      const mirror = buildWorkspanMirror(workspans, current.activeWorkspanId);
      const sessionStatuses = { ...current.sessionStatuses };
      const statusListeners = { ...current.statusListeners };
      const tabNotifications = { ...current.tabNotifications };
      const tabStatuses = { ...current.tabStatuses };
      const tabStatusDetails = { ...current.tabStatusDetails };
      const ptyOutputActivityAt = { ...current.ptyOutputActivityAt };
      delete sessionStatuses[sessionId];
      delete statusListeners[sessionId];
      delete tabNotifications[sessionId];
      delete tabStatuses[sessionId];
      delete tabStatusDetails[sessionId];
      delete ptyOutputActivityAt[sessionId];
      sessionStatuses[newSessionId] = "running";
      statusListeners[newSessionId] = unlisten;
      set({
        sessions,
        ...mirror,
        sessionStatuses,
        statusListeners,
        tabNotifications,
        tabStatuses,
        tabStatusDetails,
        ptyOutputActivityAt,
      });
      try {
        await useSessionStore.getState().saveSessions(sessions);
        await useSessionStore.getState().saveActiveSessionId(mirror.activeSessionId);
        await useSessionStore.getState().saveWorkspans(workspans, mirror.activeWorkspanId, sessions);
      } catch (err) {
        logError("Failed to persist resumed remote handoff session", { sessionId, newSessionId, err });
      }

      if (launch.startupCmd && !launch.startupHandledByLaunch) {
        const shellKey = normalizeShellKey(launch.shell) ?? null;
        setTimeout(() => {
          terminalProcessManager.write(
            newSessionId,
            formatStartupInputForPty(launch.startupCmd as string, shellKey),
          ).catch((err) => {
            logError("Failed to resume remotely handed-off Agent session", {
              sessionId: newSessionId,
              agent: handoffAgent,
              err,
            });
          });
        }, 500);
      }
      return newSessionId;
    },

    restorePersistedRemoteHandoffSessions: () => {
      const persisted = useSessionStore
        .getState()
        .sessions
        .filter((session) => Boolean(session.remoteHandoff));
      if (persisted.length === 0) return;
      const state = get();
      const openIds = new Set(state.sessions.map((session) => session.id));
      const missing = persisted.filter((session) => !openIds.has(session.id));
      if (missing.length === 0) return;

      const sessions = [...state.sessions, ...missing];
      let workspans = [...state.workspans];
      for (const session of missing) {
        workspans.push(createTerminalWorkspan(createWorkspanId(), createPaneId(), session.id));
      }
      const activeWorkspanId = state.activeWorkspanId
        ?? workspans[workspans.length - 1]?.id
        ?? null;
      const mirror = buildWorkspanMirror(workspans, activeWorkspanId);
      const sessionStatuses = { ...state.sessionStatuses };
      for (const session of missing) sessionStatuses[session.id] = "exited";
      set({ sessions, ...mirror, sessionStatuses });
    },

    bindRemoteCliSessionIdentity: async (
      sessionId,
      cliSessionId,
      remoteHistorySourceInstanceId,
    ) => {
      const normalizedId = cliSessionId.trim();
      if (!normalizedId || /\s/.test(normalizedId)) return false;
      const state = get();
      const current = state.sessions.find((session) => session.id === sessionId);
      if (!current || current.environmentType !== "ssh") return false;
      if (current.cliSessionId && current.cliSessionId !== normalizedId) return false;
      if (state.sessions.some((session) => (
        session.id !== sessionId && session.cliSessionId?.trim() === normalizedId
      ))) return false;
      const normalizedSourceInstanceId = remoteHistorySourceInstanceId?.trim() || undefined;
      const sessions = get().sessions.map((session) => (
        session.id === sessionId
          ? {
            ...session,
            cliSessionId: normalizedId,
            ...(normalizedSourceInstanceId
              ? { remoteHistorySourceInstanceId: normalizedSourceInstanceId }
              : {}),
          }
          : session
      ));
      set({ sessions });
      await queueSshSessionPersistence(sessions);
      return true;
    },

    recordPtyOutputActivity: (sessionId) => {
      const now = Date.now();
      const previous = get().ptyOutputActivityAt[sessionId] ?? 0;
      if (now - previous < PTY_OUTPUT_ACTIVITY_UPDATE_INTERVAL_MS) return;
      set((state) => ({
        ptyOutputActivityAt: {
          ...state.ptyOutputActivityAt,
          [sessionId]: now,
        },
      }));
    },

    createSession: async (projectId, cwd, title, startupCmd, envVars, shell, paneId, worktreeId, sshHostId, cliSessionId, remoteHistoryConsumerId, remoteHistorySourceInstanceId) => {
      const os = await getOsPlatform();
      const createdAtMs = Date.now();
      let launch: ResolvedPtyLaunch;
      let sessionId: string;
      try {
        launch = await resolvePtyLaunch({ projectId, worktreeId, sshHostId, cwd, startupCmd, envVars, shell }, os);
        recordCrashActivity("terminal.session_create", {
          projectId: projectId ?? null,
          worktreeId: worktreeId ?? null,
          cwd: cwd ?? null,
          shell: launch.shell,
          paneId: paneId ?? null,
          startupCmdSummary: summarizeStartupCmd(launch.startupCmd),
        });
        sessionId = await terminalProcessManager.create(launch.invokeArgs);
      } catch (err) {
        const description = formatTerminalCreateError(err);
        toast.error(translateCurrent("terminal.toast.createFailed"), { description });
        logError("PtyHost create failed", {
          projectId: projectId ?? null,
          cwd: cwd ?? null,
          shell: shell ?? null,
          err,
        });
        throw err;
      }
      const resolvedShell = launch.shell;
      const launchStartupCmd = launch.startupCmd;
      const session: TerminalSession = {
        id: sessionId,
        createdAtMs,
        projectId,
        worktreeId,
        title: title ?? "Terminal",
        cwd,
        shell: resolvedShell,
        envVars,
        startupCmd: launch.startupHandledByLaunch ? launchStartupCmd : startupCmd,
        ...getProjectAgentTerminalMetadata(projectId),
        environmentType: launch.environmentType,
        sshHostId: launch.sshHostId,
        remotePath: launch.remotePath,
        connectionState: launch.environmentType === "ssh" ? "connecting" : undefined,
        providerSnapshot: launch.providerSnapshot ?? undefined,
        cliSessionId: cliSessionId?.trim() || undefined,
        remoteHistoryConsumerId: remoteHistoryConsumerId?.trim() || undefined,
        remoteHistorySourceInstanceId: remoteHistorySourceInstanceId?.trim() || undefined,
      };

      const unlisten = await terminalProcessManager.subscribeStatus(sessionId, (payload) => {
        const status = payload.status as SessionStatus;
        logTerminalExitStatus(session, payload);
        set((state) => ({
          sessions: applyPtyStatusToSessions(state.sessions, sessionId, payload),
          sessionStatuses: { ...state.sessionStatuses, [sessionId]: status },
        }));
        persistSshConnectionStateAfterPtyStatus(sessionId, payload);
        if (
          (status === "exited" || status === "error")
        ) {
          releaseRemoteHistoryConsumer(session);
        }
      });

      const state = get();
      const newSessions = [...state.sessions, session];
      let workspans: TerminalWorkspan[];
      let activeWorkspanId: string;
      const workspanEnabled = useSettingsStore.getState().workspanEnabled;
      const explicitTargetWorkspan = paneId ? findWorkspanByPane(state.workspans, paneId) : null;
      const targetWorkspan = explicitTargetWorkspan
        ?? (!workspanEnabled
          ? state.workspans.find((workspan) => workspan.id === state.activeWorkspanId) ?? state.workspans[0] ?? null
          : null);
      if (targetWorkspan) {
        const paneResult = addSessionToPaneTree(
          targetWorkspan.paneTree,
          explicitTargetWorkspan ? paneId ?? null : targetWorkspan.activePaneId,
          sessionId,
          createPaneId
        );
        workspans = updateTerminalWorkspan(state.workspans, targetWorkspan.id, (workspan) => (
          syncTerminalWorkspanLayout(workspan, paneResult.tree, paneResult.activePaneId, sessionId)
        ));
        activeWorkspanId = targetWorkspan.id;
      } else {
        const workspan = createTerminalWorkspan(createWorkspanId(), createPaneId(), sessionId);
        workspans = [...state.workspans, workspan];
        activeWorkspanId = workspan.id;
      }
      const mirror = buildWorkspanMirror(workspans, activeWorkspanId);
      set({
        sessions: newSessions,
        ...mirror,
        sessionStatuses: { ...state.sessionStatuses, [sessionId]: "running" },
        statusListeners: { ...state.statusListeners, [sessionId]: unlisten },
      });

      // 持久化到 sessionStore
      await useSessionStore.getState().saveSessions(newSessions);
      await useSessionStore.getState().saveActiveSessionId(sessionId);
      await useSessionStore.getState().saveWorkspans(workspans, activeWorkspanId, newSessions);

      if (launchStartupCmd && !launch.startupHandledByLaunch) {
        setTimeout(() => {
          terminalProcessManager.write(sessionId, formatStartupInputForPty(launchStartupCmd, normalizeShellKey(resolvedShell) ?? null)).catch((err) => {
            toast.error("启动命令写入失败", { description: String(err) });
            logError("Failed to write startup command", {
              sessionId,
              hasStartupCmd: true,
              startupCmdSummary: summarizeStartupCmd(launchStartupCmd),
              err,
            });
          });
        }, 500);
      }

      return sessionId;
    },

    closeSession: async (id) => {
      const state = get();
      const ptySessionIds = [id];
      const closingSession = state.sessions.find((s) => s.id === id);
      if (
        closingSession?.remoteHandoff
        && closingSession.remoteHandoff.phase !== "recovery_failed"
      ) {
        toast.warning(translateCurrent("remoteHandoff.toast.lockedSession"));
        return;
      }
      const isTranscript = closingSession?.kind === "subagent-transcript";
      const isFileEditor = closingSession?.kind === "file-editor";
      const closeTimer = subagentCloseTimers.get(id);
      if (closeTimer) {
        clearTimeout(closeTimer);
        subagentCloseTimers.delete(id);
      }
      stopSubagentTranscriptRetry(id, "session_closed");

      // 必须在 set sessions 之前记录原索引，否则后续 findIndex 永远返回 -1，
      // 导致 persistedSplits 永远清不掉（历史 bug）。
      const closedIndex = state.sessions.findIndex((s) => s.id === id);
      const remaining = state.sessions.filter((s) => s.id !== id);
      const newStatuses = { ...state.sessionStatuses };
      const newListeners = { ...state.statusListeners };
      const newNotifications = { ...state.tabNotifications };
      const newTabStatuses = { ...state.tabStatuses };
      const newTabStatusDetails = { ...state.tabStatusDetails };
      const newPtyOutputActivityAt = { ...state.ptyOutputActivityAt };
      const newSubagentTranscripts = { ...state.subagentTranscripts };
      delete newSubagentTranscripts[id];
      const owner = findWorkspanBySession(state.workspans, id);
      const ownerIndex = owner ? state.workspans.findIndex((workspan) => workspan.id === owner.id) : -1;
      const workspans = removeSessionFromTerminalWorkspans(state.workspans, id);
      const ownerStillExists = owner ? workspans.some((workspan) => workspan.id === owner.id) : false;
      let activeWorkspanId = state.activeWorkspanId;
      if (owner?.id === state.activeWorkspanId && !ownerStillExists) {
        activeWorkspanId = workspans[Math.min(Math.max(ownerIndex, 0), Math.max(workspans.length - 1, 0))]?.id ?? null;
      }
      const mirror = buildWorkspanMirror(workspans, activeWorkspanId);

      delete newStatuses[id];
      delete newListeners[id];
      delete newNotifications[id];
      delete newTabStatuses[id];
      delete newTabStatusDetails[id];
      delete newPtyOutputActivityAt[id];

      // Drop in-memory background overrides for closed sessions (R8).
      const prevHidden = state.hiddenBackgroundSessionIds;
      let newHidden = prevHidden;
      if (prevHidden.has(id)) {
        newHidden = new Set(prevHidden);
        newHidden.delete(id);
      }
      const newDaemonAttachPending = new Set(state.daemonAttachPendingSessionIds);
      newDaemonAttachPending.delete(id);

      state.statusListeners[id]?.();

      set({
        sessions: remaining,
        ...mirror,
        sessionStatuses: newStatuses,
        statusListeners: newListeners,
        tabNotifications: newNotifications,
        tabStatuses: newTabStatuses,
        tabStatusDetails: newTabStatusDetails,
        ptyOutputActivityAt: newPtyOutputActivityAt,
        subagentTranscripts: newSubagentTranscripts,
        splits: {},
        daemonAttachPendingSessionIds: newDaemonAttachPending,
        ...(newHidden !== prevHidden ? { hiddenBackgroundSessionIds: newHidden } : {}),
      });

      try {
        await useSessionStore.getState().saveSessions(remaining);
        const nextActiveSession = mirror.activeSessionId ? remaining.find((session) => session.id === mirror.activeSessionId) : undefined;
        await useSessionStore.getState().saveActiveSessionId(isPersistableSession(nextActiveSession) ? mirror.activeSessionId : null);
        await useSessionStore.getState().saveWorkspans(workspans, mirror.activeWorkspanId, remaining);

        // 更新 splits（移除已关闭主会话对应的 split），使用关闭前记录的索引
        if (closedIndex >= 0) {
          const persistedSplits = useSessionStore.getState().splits.filter(
            (s) => s.primarySessionIndex !== closedIndex
          );
          await useSessionStore.getState().saveSplits(persistedSplits);
        }
      } finally {
        releaseRemoteHistoryConsumer(closingSession);
        if (isFileEditor) {
          const project = closingSession?.fileEditor?.project;
          if (project) {
            useGitDiffWorkspaceStore.getState().clearWorkspace(
              createGitDiffWorkspaceContext(project).key,
            );
            clearProjectEditorWorkspacesIfUnused(project, remaining);
          }
          return;
        }
        if (isTranscript) {
          void invoke("subagent_transcript_unsubscribe", { key: id }).catch((err) => {
            logError("subagent_transcript_unsubscribe failed while closing tab", { key: id, err });
          });
        } else {
          for (const sessionId of ptySessionIds) {
            void terminalProcessManager.close(sessionId)
              .then(() => releaseProviderSnapshot(closingSession?.providerSnapshot))
              .catch((err) => {
                logError("PtyHost close failed while closing terminal tab", { sessionId, err });
              });
          }
        }
      }
    },

    setActive: (id) => {
      const state = get();
      const owner = findWorkspanBySession(state.workspans, id);
      if (!owner) return;
      const paneResult = setPaneActiveSession(owner.paneTree, id);
      const workspans = updateTerminalWorkspan(state.workspans, owner.id, (workspan) => (
        syncTerminalWorkspanLayout(workspan, paneResult.tree, paneResult.activePaneId ?? workspan.activePaneId, id)
      ));
      const mirror = buildWorkspanMirror(workspans, owner.id);
      set(mirror);
      scheduleSaveActiveId(id);
      persistWorkspanState(workspans, owner.id, state.sessions);
    },

    setWorkspanModeEnabled: (enabled) => {
      const state = get();
      const workspans = enabled
        ? state.workspans
        : collapseTerminalWorkspansToLegacy(state.workspans, state.activeWorkspanId, createPaneId);
      const activeWorkspanId = enabled
        ? state.activeWorkspanId
        : workspans[0]?.id ?? null;
      const mirror = buildWorkspanMirror(workspans, activeWorkspanId);
      set({ ...mirror, splits: {} });
      scheduleSaveActiveId(mirror.activeSessionId);
      persistWorkspanState(workspans, mirror.activeWorkspanId, state.sessions);
    },

    setActiveWorkspan: (id) => {
      const state = get();
      if (!state.workspans.some((workspan) => workspan.id === id)) return;
      const mirror = buildWorkspanMirror(state.workspans, id);
      set(mirror);
      scheduleSaveActiveId(mirror.activeSessionId);
      persistWorkspanState(state.workspans, id, state.sessions);
    },

    reorderWorkspans: (fromId, toId) => {
      const state = get();
      const workspans = reorderTerminalWorkspans(state.workspans, fromId, toId);
      if (workspans === state.workspans) return;
      set({ workspans });
      persistWorkspanState(workspans, state.activeWorkspanId, state.sessions);
    },

    renameWorkspan: (id, title) => {
      const state = get();
      const customTitle = title.trim() || null;
      const current = state.workspans.find((workspan) => workspan.id === id);
      if (!current || current.customTitle === customTitle) return;
      const workspans = updateTerminalWorkspan(state.workspans, id, (workspan) => ({ ...workspan, customTitle }));
      set({ workspans });
      persistWorkspanState(workspans, state.activeWorkspanId, state.sessions);
    },

    restoreWorkspanToSinglePane: (id) => {
      const state = get();
      const current = state.workspans.find((workspan) => workspan.id === id);
      if (!current) return;
      const detached = detachTerminalWorkspanSessions(current, createWorkspanId, createPaneId);
      if (detached.length <= 1) return;

      const workspans = state.workspans.flatMap((workspan) => (workspan.id === id ? detached : [workspan]));
      const requestedActiveWorkspanId = state.activeWorkspanId === id
        ? detached.find((workspan) => workspan.activeSessionId === current.activeSessionId)?.id ?? detached[0]?.id ?? null
        : state.activeWorkspanId;
      const mirror = buildWorkspanMirror(workspans, requestedActiveWorkspanId);
      set(state.activeWorkspanId === id ? mirror : { workspans });
      persistWorkspanState(workspans, mirror.activeWorkspanId, state.sessions);
    },

    mergeWorkspanAtPaneEdge: (sourceId, targetId, targetPaneId, edge) => {
      const state = get();
      const result = mergeTerminalWorkspansAtPaneEdge(
        state.workspans,
        sourceId,
        targetId,
        targetPaneId,
        edge,
        createPaneId
      );
      if (!result.changed) return;
      const mirror = buildWorkspanMirror(result.workspans, result.activeWorkspanId);
      set({ ...mirror, splits: {} });
      scheduleSaveActiveId(mirror.activeSessionId);
      persistWorkspanState(result.workspans, result.activeWorkspanId, state.sessions);
    },

    markAttentionInputHandled: runtimeActions.markAttentionInputHandled,

    handleCliHookEvent: runtimeActions.handleCliHookEvent,

    handleShellRuntimeEvent: runtimeActions.handleShellRuntimeEvent,

    reorderSessions: (fromId, toId) => {
      const state = get();
      const owner = findWorkspanBySession(state.workspans, fromId);
      const pane = owner ? findPaneLeafBySession(owner.paneTree, fromId) : null;
      if (!pane || !pane.sessionIds.includes(toId)) return;
      const nextTree = reorderSessionInPane(owner!.paneTree, pane.id, fromId, toId);
      const workspans = updateTerminalWorkspan(state.workspans, owner!.id, (workspan) => (
        syncTerminalWorkspanLayout(workspan, nextTree, pane.id, fromId)
      ));
      set(buildWorkspanMirror(workspans, owner!.id));
      scheduleSaveActiveId(fromId);
      persistWorkspanState(workspans, owner!.id, state.sessions);
    },

    moveSessionToPane: (sessionId, targetPaneId, beforeSessionId) => {
      const state = get();
      const owner = findWorkspanBySession(state.workspans, sessionId);
      const targetOwner = findWorkspanByPane(state.workspans, targetPaneId);
      if (!owner || owner.id !== targetOwner?.id) return;
      const sourcePane = findPaneLeafBySession(owner.paneTree, sessionId);
      const targetPane = findPaneLeaf(owner.paneTree, targetPaneId);
      if (!sourcePane || !targetPane || sourcePane.id === targetPane.id) return;
      const result = moveSessionToPaneTree(owner.paneTree, sourcePane.id, targetPane.id, sessionId, beforeSessionId);
      const workspans = updateTerminalWorkspan(state.workspans, owner.id, (workspan) => (
        syncTerminalWorkspanLayout(workspan, result.tree, result.activePaneId, sessionId)
      ));
      set(buildWorkspanMirror(workspans, owner.id));
      scheduleSaveActiveId(sessionId);
      persistWorkspanState(workspans, owner.id, state.sessions);
    },

    detachSessionToWorkspan: (sessionId, insertAt) => {
      const state = get();
      const result = detachTerminalSessionToWorkspan(
        state.workspans,
        sessionId,
        createWorkspanId,
        createPaneId,
        insertAt
      );
      if (!result.changed || !result.detachedWorkspanId) return;
      set(buildWorkspanMirror(result.workspans, result.detachedWorkspanId));
      scheduleSaveActiveId(sessionId);
      persistWorkspanState(result.workspans, result.detachedWorkspanId, state.sessions);
    },

    splitSessionToPaneEdge: (sessionId, targetPaneId, edge) => {
      const state = get();
      const owner = findWorkspanBySession(state.workspans, sessionId);
      if (!owner || owner.id !== findWorkspanByPane(state.workspans, targetPaneId)?.id) return;
      const result = splitExistingSessionToPaneEdge(owner.paneTree, sessionId, targetPaneId, edge, createPaneId);
      if (!result.changed) return;
      const workspans = updateTerminalWorkspan(state.workspans, owner.id, (workspan) => (
        syncTerminalWorkspanLayout(workspan, result.tree, result.activePaneId, result.activeSessionId)
      ));
      set({ ...buildWorkspanMirror(workspans, owner.id), splits: {} });
      scheduleSaveActiveId(result.activeSessionId);
      persistWorkspanState(workspans, owner.id, state.sessions);
    },

    renameSession: (id, title) => {
      const trimmed = title.trim();
      if (!trimmed) return;
      let changed = false;
      const nextSessions = get().sessions.map((session) => {
        if (session.id !== id) return session;
        if (session.title === trimmed) return session;
        changed = true;
        return { ...session, title: trimmed };
      });
      if (!changed) return;
      set({ sessions: nextSessions });
      useSessionStore.getState().saveSessions(nextSessions).catch(() => { });
    },

    splitPaneEmpty: (paneId, direction) => {
      const state = get();
      const owner = findWorkspanByPane(state.workspans, paneId);
      if (!owner?.paneTree) return;
      const result = splitPaneEmptyTree(owner.paneTree, paneId, direction, createPaneId);
      const workspans = updateTerminalWorkspan(state.workspans, owner.id, (workspan) => (
        syncTerminalWorkspanLayout(workspan, result.tree, result.activePaneId, workspan.activeSessionId)
      ));
      set(buildWorkspanMirror(workspans, owner.id));
    },

    splitTerminal: async (sessionId, direction, options) => {
      const initialState = get();
      const owner = findWorkspanBySession(initialState.workspans, sessionId);
      const targetPane = owner ? findPaneLeafBySession(owner.paneTree, sessionId) : null;
      if (!targetPane || !owner?.paneTree) return null;

      const os = await getOsPlatform();
      let launch: ResolvedPtyLaunch;
      let splitSessionId: string;
      try {
        launch = await resolvePtyLaunch({
          projectId: options?.projectId,
          worktreeId: options?.worktreeId,
          cwd: options?.cwd,
          startupCmd: options?.startupCmd,
          envVars: options?.envVars,
          shell: options?.shell,
        }, os);
        recordCrashActivity("terminal.split_create", {
          sourceSessionId: sessionId,
          direction,
          projectId: options?.projectId ?? null,
          worktreeId: options?.worktreeId ?? null,
          cwd: options?.cwd ?? null,
          shell: launch.shell,
          startupCmdSummary: summarizeStartupCmd(launch.startupCmd),
        });
        splitSessionId = await terminalProcessManager.create(launch.invokeArgs);
      } catch (err) {
        const description = formatTerminalCreateError(err);
        toast.error(translateCurrent("terminal.toast.splitCreateFailed"), { description });
        logError("PtyHost create failed for split terminal", {
          sessionId,
          cwd: options?.cwd ?? null,
          shell: options?.shell ?? null,
          err,
        });
        throw err;
      }
      const resolvedShell = launch.shell;
      const launchStartupCmd = launch.startupCmd;

      const splitSession: TerminalSession = {
        id: splitSessionId,
        createdAtMs: Date.now(),
        projectId: options?.projectId,
        worktreeId: options?.worktreeId,
        title: createSplitSessionTitle(options),
        cwd: options?.cwd,
        shell: resolvedShell,
        envVars: options?.envVars,
        startupCmd: launch.startupHandledByLaunch ? launchStartupCmd : options?.startupCmd,
        ...getProjectAgentTerminalMetadata(options?.projectId),
        environmentType: launch.environmentType,
        sshHostId: launch.sshHostId,
        remotePath: launch.remotePath,
        connectionState: launch.environmentType === "ssh" ? "connecting" : undefined,
        providerSnapshot: launch.providerSnapshot ?? undefined,
      };

      const unlisten = await terminalProcessManager.subscribeStatus(splitSessionId, (payload) => {
        const status = payload.status as SessionStatus;
        logTerminalExitStatus(splitSession, payload);
        set((state) => ({
          sessions: applyPtyStatusToSessions(state.sessions, splitSessionId, payload),
          sessionStatuses: { ...state.sessionStatuses, [splitSessionId]: status },
        }));
        persistSshConnectionStateAfterPtyStatus(splitSessionId, payload);
      });

      const currentState = get();
      const currentOwner = findWorkspanBySession(currentState.workspans, sessionId);
      const currentTargetPane = currentOwner ? findPaneLeafBySession(currentOwner.paneTree, sessionId) : null;
      if (!currentOwner?.paneTree || !currentTargetPane) {
        unlisten();
        await terminalProcessManager.close(splitSessionId).catch((err) => {
          logError("PtyHost close failed for abandoned split terminal", { sessionId: splitSessionId, err });
        });
        return null;
      }

      const paneResult = splitPaneLeaf(currentOwner.paneTree, currentTargetPane.id, direction, splitSessionId, createPaneId);
      const newSessions = [...currentState.sessions, splitSession];
      const workspans = updateTerminalWorkspan(currentState.workspans, currentOwner.id, (workspan) => (
        syncTerminalWorkspanLayout(workspan, paneResult.tree, paneResult.activePaneId, splitSessionId)
      ));
      set((state) => ({
        sessions: newSessions,
        ...buildWorkspanMirror(workspans, currentOwner.id),
        splits: {},
        sessionStatuses: { ...state.sessionStatuses, [splitSessionId]: "running" },
        statusListeners: { ...state.statusListeners, [splitSessionId]: unlisten },
      }));

      await useSessionStore.getState().saveSessions(newSessions);
      await useSessionStore.getState().saveActiveSessionId(splitSessionId);
      await useSessionStore.getState().saveSplits([]);
      await useSessionStore.getState().saveWorkspans(workspans, currentOwner.id, newSessions);

      if (launchStartupCmd && !launch.startupHandledByLaunch) {
        setTimeout(() => {
          terminalProcessManager.write(splitSessionId, formatStartupInputForPty(launchStartupCmd, normalizeShellKey(resolvedShell) ?? null)).catch((err) => {
            toast.error("启动命令写入失败", { description: String(err) });
            logError("Failed to write split startup command", {
              sessionId: splitSessionId,
              hasStartupCmd: true,
              startupCmdSummary: summarizeStartupCmd(launchStartupCmd),
              err,
            });
          });
        }, 500);
      }

      return splitSessionId;
    },

    openFileEditorPane: (project) => {
      const editorSessionId = createFileEditorSessionId(project.id);
      const existing = get().sessions.find((session) => session.id === editorSessionId);
      if (existing) {
        const previousProject = existing.fileEditor?.project;
        if (previousProject) {
          const previousContext = createGitDiffWorkspaceContext(previousProject);
          const nextContext = createGitDiffWorkspaceContext(project);
          if (previousContext.key !== nextContext.key) {
            useGitDiffWorkspaceStore.getState().clearWorkspace(previousContext.key);
          }
        }
        const sessions = get().sessions.map((session) => session.id === editorSessionId ? {
          ...session,
          projectId: project.id,
          title: `文件：${project.name}`,
          fileEditor: {
            projectId: project.id,
            projectPath: project.path,
            projectName: project.name,
            project,
          },
        } : session);
        set({ sessions });
        get().setActive(editorSessionId);
        return editorSessionId;
      }

      const editorSession: TerminalSession = {
        id: editorSessionId,
        projectId: project.id,
        title: `文件：${project.name}`,
        kind: "file-editor",
        fileEditor: {
          projectId: project.id,
          projectPath: project.path,
          projectName: project.name,
          project,
        },
      };
      const state = get();
      const sessions = [...state.sessions, editorSession];
      const workspanEnabled = useSettingsStore.getState().workspanEnabled;
      const targetWorkspan = !workspanEnabled
        ? state.workspans.find((workspan) => workspan.id === state.activeWorkspanId) ?? state.workspans[0] ?? null
        : null;
      let workspans: TerminalWorkspan[];
      let activeWorkspanId: string;
      if (targetWorkspan) {
        const paneResult = addSessionToPaneTree(targetWorkspan.paneTree, targetWorkspan.activePaneId, editorSessionId, createPaneId);
        workspans = updateTerminalWorkspan(state.workspans, targetWorkspan.id, (workspan) => (
          syncTerminalWorkspanLayout(workspan, paneResult.tree, paneResult.activePaneId, editorSessionId)
        ));
        activeWorkspanId = targetWorkspan.id;
      } else {
        const workspan = createTerminalWorkspan(createWorkspanId(), createPaneId(), editorSessionId);
        workspans = [...state.workspans, workspan];
        activeWorkspanId = workspan.id;
      }

      set({
        sessions,
        ...buildWorkspanMirror(workspans, activeWorkspanId),
        splits: {},
      });
      void useSessionStore.getState().saveSessions(sessions).catch(() => { });
      persistWorkspanState(workspans, activeWorkspanId, sessions);
      return editorSessionId;
    },

    openSyncedHistoryPane: async (group, project) => {
      const firstSession = group.sessions[0];
      if (!firstSession) {
        throw new Error("同步记录为空。");
      }
      const label = firstSession?.source === "codex" ? "Codex" : "Claude";
      const existing = get().sessions.find(
        (session) => session.kind === "synced-history" && session.syncedHistory?.key === group.key && get().sessionStatuses[session.id]
      );
      if (existing) {
        get().setActive(existing.id);
        return existing.id;
      }

      const sortedSessions = [...group.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
      const latestSession = sortedSessions[0];
      const cwd = latestSession?.cwd || group.cwd || project?.path;
      const shell = project?.shell && project.shell !== "powershell" ? project.shell : undefined;
      const startupCmd = sourceTool(firstSession.source);
      const envVars = project ? parseProjectEnvVars(project) : undefined;
      const launch = await createDetachedPtyProcess({
        projectId: project?.id,
        cwd,
        startupCmd,
        envVars,
        shell,
      });
      const historySession: TerminalSession = {
        id: launch.sessionId,
        projectId: project?.id,
        title: `${group.name} · ${label} 同步终端`,
        cwd,
        shell: launch.shell,
        envVars,
        startupCmd: launch.startupCmd ?? startupCmd,
        providerSnapshot: launch.providerSnapshot ?? undefined,
        kind: "synced-history",
        syncedHistory: {
          key: group.key,
          title: group.name,
          cwd: group.cwd || project?.path || "",
          sessions: group.sessions.map((session) => ({
            key: session.key,
            source: session.source,
            sessionId: session.sessionId,
            projectKey: session.projectKey,
            filePath: session.filePath,
            projectName: session.projectName,
            cwd: session.cwd,
            title: session.title,
            startupCmd: session.startupCmd,
            updatedAt: session.updatedAt,
          })),
        },
      };
      const unlisten = await terminalProcessManager.subscribeStatus(launch.sessionId, (payload) => {
        const status = payload.status as SessionStatus;
        logTerminalExitStatus(historySession, payload);
        set((state) => ({
          sessions: applyPtyStatusToSessions(state.sessions, launch.sessionId, payload),
          sessionStatuses: { ...state.sessionStatuses, [launch.sessionId]: status },
        }));
        persistSshConnectionStateAfterPtyStatus(launch.sessionId, payload);
      });
      const state = get();
      const sessions = [...state.sessions, historySession];
      const activeWorkspan = state.workspans.find((workspan) => workspan.id === state.activeWorkspanId) ?? null;
      let workspans: TerminalWorkspan[];
      let activeWorkspanId: string;
      if (activeWorkspan?.paneTree) {
        const paneResult = addSessionToPaneTree(activeWorkspan.paneTree, activeWorkspan.activePaneId, launch.sessionId, createPaneId);
        workspans = updateTerminalWorkspan(state.workspans, activeWorkspan.id, (workspan) => (
          syncTerminalWorkspanLayout(workspan, paneResult.tree, paneResult.activePaneId, launch.sessionId)
        ));
        activeWorkspanId = activeWorkspan.id;
      } else {
        const workspan = createTerminalWorkspan(createWorkspanId(), createPaneId(), launch.sessionId);
        workspans = [...state.workspans, workspan];
        activeWorkspanId = workspan.id;
      }

      set({
        sessions,
        ...buildWorkspanMirror(workspans, activeWorkspanId),
        sessionStatuses: { ...state.sessionStatuses, [launch.sessionId]: "running" },
        statusListeners: { ...state.statusListeners, [launch.sessionId]: unlisten },
        splits: {},
      });
      void useSessionStore.getState().saveSessions(sessions).catch(() => { });
      void useSessionStore.getState().saveActiveSessionId(null).catch(() => { });
      persistWorkspanState(workspans, activeWorkspanId, sessions);
      return launch.sessionId;
    },

    unsplitTerminal: async (sessionId) => {
      const state = get();
      const owner = findWorkspanBySession(state.workspans, sessionId);
      const pane = owner ? findPaneLeafBySession(owner.paneTree, sessionId) : null;
      if (!pane || !owner) return;
      const behavior = useSettingsStore.getState().unsplitBehavior;
      const result = unsplitPaneLeaf(owner.paneTree, pane.id, behavior);
      const closedSessionIds = result.closedSessionIds;
      if (
        closedSessionIds.some((closedSessionId) => (
          state.sessions.some((session) => (
            session.id === closedSessionId
            && Boolean(session.remoteHandoff)
            && session.remoteHandoff?.phase !== "recovery_failed"
          ))
        ))
      ) {
        toast.warning(translateCurrent("remoteHandoff.toast.lockedSession"));
        return;
      }
      const transcriptClosedIds = new Set(
        state.sessions
          .filter((s) => closedSessionIds.includes(s.id) && s.kind === "subagent-transcript")
          .map((s) => s.id)
      );
      const fileEditorClosedIds = new Set(
        state.sessions
          .filter((s) => closedSessionIds.includes(s.id) && s.kind === "file-editor")
          .map((s) => s.id)
      );
      for (const closedSessionId of closedSessionIds) {
        if (transcriptClosedIds.has(closedSessionId)) {
          stopSubagentTranscriptRetry(closedSessionId, "pane_unsplit");
        }
        state.statusListeners[closedSessionId]?.();
      }

      const newStatuses = { ...state.sessionStatuses };
      const newListeners = { ...state.statusListeners };
      const newNotifications = { ...state.tabNotifications };
      const newTabStatuses = { ...state.tabStatuses };
      const newTabStatusDetails = { ...state.tabStatusDetails };
      const newPtyOutputActivityAt = { ...state.ptyOutputActivityAt };
      const newSubagentTranscripts = { ...state.subagentTranscripts };
      const newHidden = new Set(state.hiddenBackgroundSessionIds);
      const newDaemonAttachPending = new Set(state.daemonAttachPendingSessionIds);
      for (const closedSessionId of closedSessionIds) {
        delete newStatuses[closedSessionId];
        delete newListeners[closedSessionId];
        delete newNotifications[closedSessionId];
        delete newTabStatuses[closedSessionId];
        delete newTabStatusDetails[closedSessionId];
        delete newPtyOutputActivityAt[closedSessionId];
        delete newSubagentTranscripts[closedSessionId];
        newHidden.delete(closedSessionId);
        newDaemonAttachPending.delete(closedSessionId);
      }

      const closedSet = new Set(closedSessionIds);
      const remaining = state.sessions.filter((session) => !closedSet.has(session.id));
      for (const closedSessionId of fileEditorClosedIds) {
        const project = state.sessions.find((session) => session.id === closedSessionId)?.fileEditor?.project;
        if (project) clearProjectEditorWorkspacesIfUnused(project, remaining);
      }
      const workspans = updateTerminalWorkspan(state.workspans, owner.id, (workspan) => (
        syncTerminalWorkspanLayout(workspan, result.tree, result.activePaneId, result.activeSessionId)
      ));
      const mirror = buildWorkspanMirror(workspans, owner.id);
      set({
        sessions: remaining,
        ...mirror,
        sessionStatuses: newStatuses,
        statusListeners: newListeners,
        tabNotifications: newNotifications,
        tabStatuses: newTabStatuses,
        tabStatusDetails: newTabStatusDetails,
        ptyOutputActivityAt: newPtyOutputActivityAt,
        splits: {},
        hiddenBackgroundSessionIds: newHidden,
        daemonAttachPendingSessionIds: newDaemonAttachPending,
        subagentTranscripts: newSubagentTranscripts,
      });

      await useSessionStore.getState().saveSessions(remaining);
      const nextActiveSession = mirror.activeSessionId
        ? remaining.find((session) => session.id === mirror.activeSessionId)
        : undefined;
      await useSessionStore.getState().saveActiveSessionId(
        isPersistableSession(nextActiveSession) ? mirror.activeSessionId : null
      );
      await useSessionStore.getState().saveSplits([]);
      await useSessionStore.getState().saveWorkspans(workspans, mirror.activeWorkspanId, remaining);

      for (const closedSessionId of closedSessionIds) {
        if (fileEditorClosedIds.has(closedSessionId)) {
          continue;
        }
        if (transcriptClosedIds.has(closedSessionId)) {
          void invoke("subagent_transcript_unsubscribe", { key: closedSessionId }).catch((err) => {
            logError("subagent_transcript_unsubscribe failed while unsplitting pane", { key: closedSessionId, err });
          });
        } else {
          void terminalProcessManager.close(closedSessionId).catch((err) => {
            logError("PtyHost close failed while unsplitting pane", { sessionId: closedSessionId, err });
          });
        }
      }
    },

    setSplitRatio: (splitId, ratio) => {
      const state = get();
      const activeWorkspan = state.workspans.find((workspan) => workspan.id === state.activeWorkspanId);
      if (!activeWorkspan) return;
      const paneTree = resizePaneSplit(activeWorkspan.paneTree, splitId, ratio);
      const workspans = updateTerminalWorkspan(state.workspans, activeWorkspan.id, (workspan) => (
        syncTerminalWorkspanLayout(workspan, paneTree, workspan.activePaneId, workspan.activeSessionId)
      ));
      set(buildWorkspanMirror(workspans, activeWorkspan.id));
      persistWorkspanState(workspans, activeWorkspan.id, state.sessions);
    },

    getNextSessionIdForShortcut: (delta) => {
      const state = get();
      const nextSessionId = resolveNextSessionIdForShortcut(
        state.paneTree,
        state.activePaneId,
        state.activeSessionId,
        delta
      );
      if (nextSessionId && nextSessionId !== state.activeSessionId) return nextSessionId;
      return getAdjacentWorkspanSessionId(state.workspans, state.activeWorkspanId, delta);
    },

    restoreSessions: async (projectMap, projectHealth) => {
      // 防止 StrictMode 双重调用
      if (restoreInProgress) return;
      restoreInProgress = true;

      try {
        const sessionStore = useSessionStore.getState();
        const persistedSessions = sessionStore.sessions;
        const persistedActiveId = sessionStore.activeSessionId;
        const persistedWorkspans = sessionStore.workspans;
        const persistedActiveWorkspanId = sessionStore.activeWorkspanId;

        await garbageCollectProviderSnapshots(persistedSessions);
        if (persistedSessions.length === 0) return;

        const restoredSessions: TerminalSession[] = [];
        const restoredStatuses: Record<string, SessionStatus> = {};
        const restoredListeners: Record<string, UnlistenFn> = {};
        const daemonAttachPendingSessionIds = new Set<string>();
        let restoredTabState: Pick<TerminalStore, "tabStatuses" | "tabNotifications" | "tabStatusDetails"> = {
          tabStatuses: {},
          tabNotifications: {},
          tabStatusDetails: {},
        };
        const skippedSessions: string[] = [];

        const newIdMap: Record<string, string> = {}; // oldId -> newId

        // Phase 2（Issue #123）：daemon 仍存活的会话优先 attach 续用——真后台续跑归来，
        // 不重建 PTY、不 resume。daemon 不可用/查询失败 → 空集合，全部走重建兜底。
        let daemonSessionsById = new Map<string, DaemonSessionMeta>();
        try {
          const daemonSessions = await invoke<DaemonSessionMeta[]>(
            "pty_daemon_sessions"
          );
          daemonSessionsById = new Map(
            daemonSessions.map((session) => [session.sessionId, session])
          );
        } catch (err) {
          logInfo("pty daemon sessions unavailable, restoring via recreate", { err });
        }

        const os = await getOsPlatform();
        for (let i = 0; i < persistedSessions.length; i++) {
          const ps = persistedSessions[i];
          if (isCliManagerSyncArtifactText(ps.title ?? "") || isCliManagerSyncArtifactText(ps.startupCmd ?? "")) {
            skippedSessions.push(ps.title ?? `会话 ${i + 1}`);
            continue;
          }

          if (ps.remoteHandoff) {
            if (ps.projectId && !projectMap.has(ps.projectId)) {
              skippedSessions.push(ps.title ?? ("会话 " + (i + 1)));
              continue;
            }
            newIdMap[ps.id] = ps.id;
            restoredSessions.push({
              ...ps,
              ...getRestoredAgentTerminalMetadata(ps, ps.projectId),
              kind: undefined,
              deferStartupUntilInitialOutput: false,
            });
            restoredStatuses[ps.id] = "exited";
            continue;
          }

          // daemon 会话仍存活时先恢复 UI 元数据。实际 attach 等 XTerm 输出监听就绪后执行。
          const daemonSession = daemonSessionsById.get(ps.id);
          if (daemonSession) {
            try {
              const taskStatus = resolveDaemonAttachTaskStatus(daemonSession);
              const taskUpdatedAt = resolveDaemonAttachUpdatedAt(daemonSession);
              const attachedMeta = resolveAttachedDaemonSession(ps, daemonSession);
              const attachedSession: TerminalSession = {
                id: ps.id,
                createdAtMs: daemonSession.createdAtMs ?? ps.createdAtMs,
                projectId: attachedMeta.projectId,
                worktreeId: attachedMeta.worktreeId,
                title: attachedMeta.title,
                cwd: attachedMeta.cwd,
                shell: attachedMeta.shell,
                environmentType: attachedMeta.environmentType,
                sshHostId: attachedMeta.sshHostId,
                remotePath: attachedMeta.remotePath,
                connectionState: attachedMeta.connectionState,
                disconnectReason: attachedMeta.disconnectReason,
                envVars: ps.envVars,
                providerSnapshot: ps.providerSnapshot,
                // 仅保留给 Tab 厂商识别；daemon attach 不会重新执行该命令。
                startupCmd: ps.startupCmd,
                ...getRestoredAgentTerminalMetadata(ps, attachedMeta.projectId),
                cliSessionId: ps.cliSessionId,
                remoteHistoryConsumerId: ps.remoteHistoryConsumerId,
                remoteHistorySourceInstanceId: ps.remoteHistorySourceInstanceId,
                deferStartupUntilInitialOutput: false,
              };
              const unlisten = await terminalProcessManager.subscribeStatus(ps.id, (payload) => {
                const status = payload.status as SessionStatus;
                logTerminalExitStatus(attachedSession, payload);
                if (status !== "running") releaseRemoteHistoryConsumer(attachedSession);
                useTerminalStore.setState((state) => {
                  const sessionStatuses = { ...state.sessionStatuses, [ps.id]: status };
                  if (status === "running") return { sessionStatuses };
                  return {
                    sessions: applyPtyStatusToSessions(state.sessions, ps.id, payload),
                    sessionStatuses,
                    ...buildTabStatusUpdate(
                      state,
                      ps.id,
                      "hook",
                      status === "error" ? "failed" : "done",
                      new Date().toISOString()
                    ),
                  };
                });
                persistSshConnectionStateAfterPtyStatus(ps.id, payload);
              });
              newIdMap[ps.id] = ps.id;
              restoredSessions.push(attachedSession);
              restoredStatuses[ps.id] = daemonSession.alive ? "running" : "exited";
              restoredListeners[ps.id] = unlisten;
              daemonAttachPendingSessionIds.add(ps.id);
              restoredTabState = buildTabStatusUpdate(restoredTabState, ps.id, "hook", taskStatus, taskUpdatedAt);
              if (!daemonSession.alive) releaseRemoteHistoryConsumer(attachedSession);
              continue;
            } catch (err) {
              logError("daemon attach failed, falling back to recreate", { sessionId: ps.id, err });
            }
          }

          // 检查项目是否存在
          if (ps.projectId) {
            const project = projectMap.get(ps.projectId);
            if (!project) {
              skippedSessions.push(ps.title ?? `会话 ${i + 1}`);
              continue;
            }
            // 检查路径是否有效
            if (project.environment_type !== "ssh" && projectHealth[ps.projectId] === false) {
              // 路径无效但仍创建终端，显示警告
              toast.warning(`项目路径无效: ${project.name}`, {
                description: `路径 ${project.path} 不存在，终端可能无法正常工作`,
              });
            }
          }

          // 重建 PTY
          const restoreProject = ps.projectId ? projectMap.get(ps.projectId) : undefined;
          const cliKind = detectCliResumeKind(ps.startupCmd, restoreProject);
          const restoredStartupCmd = cliKind
            ? buildCliResumeStartupCommand(
              cliKind,
              ps.cliSessionId,
              restoreProject,
              ps.providerSnapshot ? { includeProviderOverrides: false } : {},
            )
            : normalizeDirectCodexStartupCommand(ps.startupCmd);
          let launch: ResolvedPtyLaunch;
          try {
            launch = await resolvePtyLaunch({
              projectId: ps.projectId,
              worktreeId: ps.worktreeId,
              cwd: ps.cwd,
              startupCmd: restoredStartupCmd,
              envVars: ps.envVars,
              shell: ps.shell,
              providerSnapshot: ps.providerSnapshot,
            }, os);
          } catch (err) {
            logError("Failed to resolve restored session launch", { session: ps, err });
            skippedSessions.push(ps.title ?? `Session ${i + 1}`);
            continue;
          }
          const resolvedShell = launch.shell;

          let newSessionId: string;
          try {
            newSessionId = await terminalProcessManager.create(launch.invokeArgs);
          } catch (err) {
            logError("Failed to restore session", { session: ps, err });
            skippedSessions.push(ps.title ?? `会话 ${i + 1}`);
            continue;
          }

          newIdMap[ps.id] = newSessionId;

          const shellKey = normalizeShellKey(resolvedShell) ?? null;
          // 恢复按会话类型分流：CLI 会话（codex/claude）走原生 resume，普通 shell 会话静态贴回 scrollback。
          let launchStartupCmd: string | undefined;
          let initialTerminalOutput: string | undefined;
          let deferStartupUntilInitialOutput = false;

          if (cliKind) {
            // CLI 会话：不贴 initialTerminalOutput（TUI 绝对定位重绘会盖掉它，见
            // research/tui-startup-clear-sequences.md），改用 resume 让 CLI 自己重画上次对话并可继续。
            launchStartupCmd = launch.startupCmd;
          } else {
            // 普通 shell 会话：静态贴回历史滚动内容（shell 不清屏，历史可见），startupCmd 保持首轮行为。
            launchStartupCmd = launch.startupCmd;
            initialTerminalOutput = restoredStartupCmd && launch.startupHandledByLaunch
              ? undefined
              : ps.initialTerminalOutput;
            // 有历史画面时：先静态贴回 initialTerminalOutput，再由 XTermTerminal 在贴回完成后重放 startupCmd，
            // 避免"setTimeout 写入"与"贴回大段文本"竞态导致启动命令淹没在历史输出里。
            deferStartupUntilInitialOutput = !!ps.initialTerminalOutput && !!launchStartupCmd;
          }

          const hasInitialOutput = !!initialTerminalOutput;
          const restoredSession: TerminalSession = {
            id: newSessionId,
            createdAtMs: Date.now(),
            projectId: ps.projectId,
            worktreeId: ps.worktreeId,
            title: ps.title,
            cwd: ps.cwd,
            shell: resolvedShell,
            envVars: ps.envVars,
            startupCmd: launch.startupHandledByLaunch ? restoredStartupCmd : launchStartupCmd,
            ...getRestoredAgentTerminalMetadata(ps, ps.projectId),
            environmentType: launch.environmentType ?? ps.environmentType,
            sshHostId: launch.sshHostId ?? ps.sshHostId,
            remotePath: launch.remotePath ?? ps.remotePath,
            connectionState: (launch.environmentType ?? ps.environmentType) === "ssh" ? "connecting" : undefined,
            disconnectReason: undefined,
            // 不回退到旧快照：恢复已按当前覆盖状态重新解析，跟随全局时应为 undefined。
            providerSnapshot: launch.providerSnapshot ?? undefined,
            // 保留 cliSessionId：hook 上报会用它绑定实时统计；下次落盘也需要它继续 resume。
            cliSessionId: ps.cliSessionId,
            remoteHistoryConsumerId: ps.remoteHistoryConsumerId,
            remoteHistorySourceInstanceId: ps.remoteHistorySourceInstanceId,
            initialTerminalOutput,
            deferStartupUntilInitialOutput,
          };

          let unlisten: UnlistenFn;
          try {
            unlisten = await terminalProcessManager.subscribeStatus(newSessionId, (payload) => {
              const status = payload.status as SessionStatus;
              logTerminalExitStatus(restoredSession, payload);
              useTerminalStore.setState((state) => ({
                sessions: applyPtyStatusToSessions(state.sessions, newSessionId, payload),
                sessionStatuses: { ...state.sessionStatuses, [newSessionId]: status },
              }));
              persistSshConnectionStateAfterPtyStatus(newSessionId, payload);
              if (status === "exited" || status === "error") {
                releaseRemoteHistoryConsumer(restoredSession);
              }
            });
          } catch (err) {
            logError("Failed to register status listener", { sessionId: newSessionId, err });
            await terminalProcessManager.close(newSessionId).catch(() => { });
            skippedSessions.push(ps.title ?? `会话 ${i + 1}`);
            continue;
          }

          restoredSessions.push(restoredSession);
          restoredStatuses[newSessionId] = "running";
          restoredListeners[newSessionId] = unlisten;

          // 执行启动命令：CLI resume 命令 / 无历史画面的普通命令走这里直接写入；
          // 有历史画面时（仅 shell 分支）改由 XTermTerminal 在贴回完成后重放（deferStartupUntilInitialOutput），
          // 这里不再 setTimeout 写入，避免同一条 startupCmd 被执行两次。
          if (launchStartupCmd && !launch.startupHandledByLaunch && !hasInitialOutput) {
            setTimeout(() => {
              terminalProcessManager.write(newSessionId, formatStartupInputForPty(launchStartupCmd!, shellKey)).catch((err) => {
                logError("Failed to write startup command on restore", {
                  sessionId: newSessionId,
                  hasStartupCmd: true,
                  startupCmdSummary: summarizeStartupCmd(launchStartupCmd!),
                  err,
                });
              });
            }, 500);
          }
        }

        // 确定恢复后的 activeSessionId
        let newActiveId: string | null = null;
        if (persistedActiveId && newIdMap[persistedActiveId]) {
          newActiveId = newIdMap[persistedActiveId];
        } else if (restoredSessions.length > 0) {
          newActiveId = restoredSessions[restoredSessions.length - 1].id;
        }

        const restoredSessionIds = new Set(restoredSessions.map((session) => session.id));
        let workspans = sanitizeTerminalWorkspans(
          restoreTerminalWorkspans(persistedWorkspans, newIdMap),
          restoredSessionIds
        );
        const assignedSessionIds = new Set(workspans.flatMap(collectWorkspanSessionIds));
        for (const session of restoredSessions) {
          if (assignedSessionIds.has(session.id)) continue;
          workspans.push(createTerminalWorkspan(createWorkspanId(), createPaneId(), session.id));
          assignedSessionIds.add(session.id);
        }
        let activeWorkspanId = persistedActiveWorkspanId
          && workspans.some((workspan) => workspan.id === persistedActiveWorkspanId)
          ? persistedActiveWorkspanId
          : newActiveId
            ? findWorkspanBySession(workspans, newActiveId)?.id ?? workspans[workspans.length - 1]?.id ?? null
            : workspans[workspans.length - 1]?.id ?? null;
        if (!useSettingsStore.getState().workspanEnabled) {
          workspans = collapseTerminalWorkspansToLegacy(workspans, activeWorkspanId, createPaneId);
          activeWorkspanId = workspans[0]?.id ?? null;
        }
        const mirror = buildWorkspanMirror(workspans, activeWorkspanId);

        set({
          sessions: restoredSessions,
          ...mirror,
          sessionStatuses: restoredStatuses,
          statusListeners: restoredListeners,
          daemonAttachPendingSessionIds,
          ...restoredTabState,
          splits: {},
        });

        // 更新 sessionStore 的持久化数据（使用新 ID）
        const updatedPersistedSessions = restoredSessions.map((s) => ({
          ...s,
          id: s.id, // 已经是新 ID
        }));
        await sessionStore.saveSessions(updatedPersistedSessions);
        await sessionStore.saveSplits([]);
        await sessionStore.saveActiveSessionId(mirror.activeSessionId);
        await sessionStore.saveWorkspans(workspans, mirror.activeWorkspanId, updatedPersistedSessions);

        // 显示恢复结果提示
        if (skippedSessions.length > 0) {
          toast.info("部分终端会话未恢复", {
            description: `以下会话因项目不存在或创建失败而跳过: ${skippedSessions.join(", ")}`,
          });
        }
        if (restoredSessions.length > 0) {
          toast.success(`已恢复 ${restoredSessions.length} 个终端会话`);
        }
      } finally {
        restoreInProgress = false;
      }
    },

    attachDaemonSession: async (sessionId) => {
      const current = get();
      if (current.sessions.some((session) => session.id === sessionId)) {
        current.setActive(sessionId);
        return true;
      }

      const persisted = useSessionStore.getState().sessions.find((session) => session.id === sessionId);
      const daemonSession = (await invoke<DaemonSessionMeta[]>("pty_daemon_sessions"))
        .find((item) => item.sessionId === sessionId);
      if (!daemonSession) return false;

      const taskStatus = resolveDaemonAttachTaskStatus(daemonSession);
      const taskUpdatedAt = resolveDaemonAttachUpdatedAt(daemonSession);
      const attachedMeta = resolveAttachedDaemonSession(persisted, daemonSession);
      const session: TerminalSession = {
        id: sessionId,
        createdAtMs: daemonSession.createdAtMs ?? persisted?.createdAtMs,
        projectId: attachedMeta.projectId,
        worktreeId: attachedMeta.worktreeId,
        title: attachedMeta.title,
        cwd: attachedMeta.cwd,
        shell: attachedMeta.shell,
        environmentType: attachedMeta.environmentType,
        sshHostId: attachedMeta.sshHostId,
        remotePath: attachedMeta.remotePath,
        connectionState: attachedMeta.connectionState,
        disconnectReason: attachedMeta.disconnectReason,
        envVars: persisted?.envVars,
        providerSnapshot: persisted?.providerSnapshot,
        // 元数据用于 Tab 厂商识别；daemon attach 不会重新执行该命令。
        startupCmd: persisted?.startupCmd,
        ...getRestoredAgentTerminalMetadata(persisted, attachedMeta.projectId),
        cliSessionId: persisted?.cliSessionId,
        remoteHistoryConsumerId: persisted?.remoteHistoryConsumerId,
        remoteHistorySourceInstanceId: persisted?.remoteHistorySourceInstanceId,
        deferStartupUntilInitialOutput: false,
      };
      const unlisten = await terminalProcessManager.subscribeStatus(sessionId, (payload) => {
        const status = payload.status as SessionStatus;
        if (status !== "running") releaseRemoteHistoryConsumer(session);
        useTerminalStore.setState((state) => {
          const sessionStatuses = { ...state.sessionStatuses, [sessionId]: status };
          if (status === "running") return { sessionStatuses };
          return {
            sessions: applyPtyStatusToSessions(state.sessions, sessionId, payload),
            sessionStatuses,
            ...buildTabStatusUpdate(
              state,
              sessionId,
              "hook",
              status === "error" ? "failed" : "done",
              new Date().toISOString()
            ),
          };
        });
        persistSshConnectionStateAfterPtyStatus(sessionId, payload);
      });

      const nextSessions = [...current.sessions, session];
      const nextWorkspan = createTerminalWorkspan(createWorkspanId(), createPaneId(), sessionId);
      const workspans = [...current.workspans, nextWorkspan];
      const mirror = buildWorkspanMirror(workspans, nextWorkspan.id);
      const initialTabState = buildTabStatusUpdate(
        current,
        sessionId,
        "hook",
        taskStatus,
        taskUpdatedAt
      );
      if (!daemonSession.alive) releaseRemoteHistoryConsumer(session);
      set({
        sessions: nextSessions,
        ...mirror,
        sessionStatuses: {
          ...current.sessionStatuses,
          [sessionId]: daemonSession.alive ? "running" : "exited",
        },
        statusListeners: { ...current.statusListeners, [sessionId]: unlisten },
        daemonAttachPendingSessionIds: new Set([
          ...current.daemonAttachPendingSessionIds,
          sessionId,
        ]),
        ...initialTabState,
      });
      await useSessionStore.getState().saveSessions(nextSessions);
      await useSessionStore.getState().saveActiveSessionId(sessionId);
      await useSessionStore.getState().saveWorkspans(workspans, nextWorkspan.id, nextSessions);
      return true;
    },

    discardDaemonSession: async (sessionId) => {
      if (get().sessions.some((session) => session.id === sessionId)) {
        await get().closeSession(sessionId);
        return;
      }
      await terminalProcessManager.close(sessionId).catch((err) => {
        logWarn("daemon session was already unavailable while discarding", { sessionId, err });
      });
      const persisted = useSessionStore.getState();
      const sessions = persisted.sessions.filter((session) => session.id !== sessionId);
      const workspans = removeSessionFromTerminalWorkspans(persisted.workspans, sessionId);
      const activeWorkspanId = persisted.activeWorkspanId
        && workspans.some((workspan) => workspan.id === persisted.activeWorkspanId)
        ? persisted.activeWorkspanId
        : workspans[0]?.id ?? null;
      await persisted.saveSessions(sessions);
      await persisted.saveActiveSessionId(
        persisted.activeSessionId === sessionId ? null : persisted.activeSessionId
      );
      await persisted.saveWorkspans(workspans, activeWorkspanId, sessions);
    },

    getRunningTaskSessionIds: () => {
      const state = get();
      return state.sessions
        .filter((session) => shouldIncludeTerminalExitTask({
          kind: session.kind,
          processStatus: state.sessionStatuses[session.id],
          mergedStatus: state.tabNotifications[session.id],
          hookStatus: state.tabStatuses[session.id]?.hook,
        }))
        .map((session) => session.id);
    },

    getExitTaskSessionIds: (includeFinished = false) => {
      const state = get();
      return state.sessions
        .filter((session) => shouldIncludeTerminalExitTask({
          kind: session.kind,
          processStatus: state.sessionStatuses[session.id],
          mergedStatus: state.tabNotifications[session.id],
          hookStatus: state.tabStatuses[session.id]?.hook,
        }, includeFinished))
        .map((session) => session.id);
    },

    hideBackgroundForSession: (sessionId) => {
      const current = get().hiddenBackgroundSessionIds;
      if (current.has(sessionId)) return;
      const next = new Set(current);
      next.add(sessionId);
      set({ hiddenBackgroundSessionIds: next });
    },

    showBackgroundForSession: (sessionId) => {
      const current = get().hiddenBackgroundSessionIds;
      if (!current.has(sessionId)) return;
      const next = new Set(current);
      next.delete(sessionId);
      set({ hiddenBackgroundSessionIds: next });
    },

    openSubagentTranscript: runtimeActions.openSubagentTranscript,

    finishSubagentTranscript: runtimeActions.finishSubagentTranscript,

    appendSubagentTranscript: runtimeActions.appendSubagentTranscript,
  };
});

startPtyOrphanReconcileHeartbeat();
