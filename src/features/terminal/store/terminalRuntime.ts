import type { StoreApi } from "zustand";
import type { TerminalStore } from "../types/terminalStoreTypes";
import { invoke } from "@tauri-apps/api/core";
import type { SubagentTranscriptSource, TerminalSession } from "../../../lib/types";
import { resolveAgentTerminalMetadata } from "../../../lib/agentTerminal";
import { debugConsoleWarn } from "../../../lib/debugConsole";
import { logError, logInfo, logWarn } from "../../../lib/logger";
import { useSettingsStore } from "../../../stores/settingsStore";
import { useSessionStore } from "../../../stores/sessionStore";
import { normalizeShellKey } from "../../../lib/shell";
import { useProjectStore } from "../../../stores/projectStore";
import { resolveCliSessionRebind } from "../../../stores/terminalCliSession";
import { inferHookBindingSource, resolveCliHookTarget } from "../../../stores/terminalHookBinding";
import { findProjectByPath, findWorktreeByPath } from "../../../lib/terminalProject";
import {
  addSessionToPaneTree, findPaneLeafBySession, splitPaneLeaf, type TerminalPaneNode,
} from "../../../stores/terminalPaneTree";
import {
  findWorkspanBySession, syncTerminalWorkspanLayout, updateTerminalWorkspan,
} from "../../../stores/terminalWorkspan";
import {
  type TabStatusSources, type SubagentTranscriptSubscribeResult, type PtyStatusPayload,
} from "../types/terminalStoreTypes";
import { buildWorkspanMirror, persistWorkspanState, isPersistableSession } from "../lib/terminalStoreLayout";
import {
  hasCodexTerminalEvent, trimOptional, inferWslDistroFromCwd, resolveHookWslDistroName,
  isSameTranscriptPath, hashString, buildSubagentTitle, resolveSubagentTranscriptSource,
  mergeSubagentSource, shouldSubscribeSubagentSource, shouldAttemptDerivedChildTranscript,
  findSubagentSessionId,
} from "../lib/subagentTranscriptModel";
import { isShellRuntimeMonitoringEnabled, HOOK_RUNNING_TIMEOUT_MS } from "../lib/terminalLaunch";
import {
  SUBAGENT_TRANSCRIPT_MAX_CHARS, SUBAGENT_CLOSE_DELAY_MS, SUBAGENT_CHILD_JSONL_CLOSE_DELAY_MS,
  SUBAGENT_DISCOVERY_INTERVAL_MS, SUBAGENT_DISCOVERY_FAST_WINDOW_MS,
  SUBAGENT_DISCOVERY_SLOW_INTERVAL_MS, SUBAGENT_DIRECTORY_DISCOVERY_TTL_MS, mapCliHookEvent,
  mapShellRuntimeEvent, resolvePrimaryTabId, getTabStatusEntry, getTabStatusDetails,
  buildTabStatusUpdate,
} from "../lib/terminalStatus";

export function createTerminalRuntime(
  set: StoreApi<TerminalStore>["setState"],
  get: StoreApi<TerminalStore>["getState"],
  useTerminalStore: StoreApi<TerminalStore>,
) {
  let sshSessionPersistenceQueue = Promise.resolve();

  function queueSshSessionPersistence(sessions: TerminalSession[]): Promise<void> {
    const snapshot = sessions.map((session) => ({ ...session }));
    sshSessionPersistenceQueue = sshSessionPersistenceQueue
      .catch(() => { })
      .then(() => useSessionStore.getState().saveSessions(snapshot));
    return sshSessionPersistenceQueue;
  }

  let saveActiveIdTimer: ReturnType<typeof setTimeout> | null = null;

  let paneIdSeq = 0;

  let workspanIdSeq = 0;

  let subagentSeq = 0;

  const subagentCloseTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const subagentDiscoveryTimers = new Map<string, ReturnType<typeof setInterval>>();

  const subagentTranscriptRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const subagentTranscriptRetryDiagnostics = new Map<string, {
    startedAt: number;
    attemptCount: number;
    lastDelayMs: number;
  }>();

  function createPaneId() {
    paneIdSeq += 1;
    return `pane-${Date.now().toString(36)}-${paneIdSeq.toString(36)}`;
  }

  function createWorkspanId() {
    workspanIdSeq += 1;
    return `workspan-${Date.now().toString(36)}-${workspanIdSeq.toString(36)}`;
  }

  function scheduleSaveActiveId(id: string | null) {
    if (saveActiveIdTimer !== null) clearTimeout(saveActiveIdTimer);
    saveActiveIdTimer = setTimeout(() => {
      saveActiveIdTimer = null;
      const session = id ? useTerminalStore.getState().sessions.find((item) => item.id === id) : undefined;
      useSessionStore.getState().saveActiveSessionId(isPersistableSession(session) ? id : null).catch(() => { });
    }, 200);
  }

  function createSubagentPaneId(parentTabId: string, agentId: string | null, toolUseId: string | null, childTranscriptPath: string | null): string {
    if (agentId) return `subagent:${agentId}`;
    if (toolUseId) return `subagent:tool:${toolUseId}`;
    if (childTranscriptPath) return `subagent:path:${hashString(childTranscriptPath)}`;
    subagentSeq += 1;
    return `subagent:${parentTabId}:${Date.now().toString(36)}:${subagentSeq.toString(36)}`;
  }

  function stopSubagentTranscriptRetry(sessionId: string, reason: string) {
    const timer = subagentTranscriptRetryTimers.get(sessionId);
    const diagnostics = subagentTranscriptRetryDiagnostics.get(sessionId);
    if (!timer && !diagnostics) return;
    if (timer) clearTimeout(timer);
    subagentTranscriptRetryTimers.delete(sessionId);
    subagentTranscriptRetryDiagnostics.delete(sessionId);
    logInfo("[subagent_transcript] stopped transcript discovery retry", {
      sessionId,
      reason,
      attemptCount: diagnostics?.attemptCount ?? 0,
      elapsedMs: diagnostics ? Date.now() - diagnostics.startedAt : 0,
      lastDelayMs: diagnostics?.lastDelayMs ?? null,
    });
  }

  function startSubagentTranscriptRetry(sessionId: string, attempt: () => Promise<boolean>) {
    if (subagentTranscriptRetryTimers.has(sessionId)) return;

    const startedAt = Date.now();
    subagentTranscriptRetryDiagnostics.set(sessionId, {
      startedAt,
      attemptCount: 0,
      lastDelayMs: SUBAGENT_DISCOVERY_INTERVAL_MS,
    });
    const runAttempt = () => {
      const store = useTerminalStore.getState();
      const transcript = store.subagentTranscripts[sessionId];
      if (
        !store.sessions.some((session) => session.id === sessionId) ||
        transcript?.source.kind === "child-jsonl"
      ) {
        stopSubagentTranscriptRetry(sessionId, "inactive");
        return;
      }

      const diagnostics = subagentTranscriptRetryDiagnostics.get(sessionId);
      if (diagnostics) diagnostics.attemptCount += 1;

      void attempt()
        .then((subscribed) => {
          if (subscribed) {
            stopSubagentTranscriptRetry(sessionId, "subscribed");
            return;
          }
          if (!subagentTranscriptRetryTimers.has(sessionId)) return;
          const elapsed = Date.now() - startedAt;
          const delay = elapsed < SUBAGENT_DISCOVERY_FAST_WINDOW_MS ? SUBAGENT_DISCOVERY_INTERVAL_MS : SUBAGENT_DISCOVERY_SLOW_INTERVAL_MS;
          const currentDiagnostics = subagentTranscriptRetryDiagnostics.get(sessionId);
          if (currentDiagnostics) {
            currentDiagnostics.lastDelayMs = delay;
            const attemptCount = currentDiagnostics.attemptCount;
            if (attemptCount <= 3 || attemptCount === 5 || attemptCount % 12 === 0) {
              logInfo("[subagent_transcript] transcript discovery retry checkpoint", {
                sessionId,
                attemptCount,
                elapsedMs: elapsed,
                sourceKind: transcript?.source.kind ?? null,
                nextDelayMs: delay,
              });
            }
          }
          const timerId = setTimeout(runAttempt, delay);
          subagentTranscriptRetryTimers.set(sessionId, timerId);
        })
        .catch((err) => {
          if (!subagentTranscriptRetryTimers.has(sessionId)) return;
          const currentDiagnostics = subagentTranscriptRetryDiagnostics.get(sessionId);
          if (currentDiagnostics) {
            currentDiagnostics.lastDelayMs = SUBAGENT_DISCOVERY_SLOW_INTERVAL_MS;
          }
          logWarn("[subagent_transcript] transcript discovery retry failed", {
            sessionId,
            attemptCount: currentDiagnostics?.attemptCount ?? null,
            elapsedMs: currentDiagnostics ? Date.now() - currentDiagnostics.startedAt : null,
            nextDelayMs: SUBAGENT_DISCOVERY_SLOW_INTERVAL_MS,
            err,
          });
          const timerId = setTimeout(runAttempt, SUBAGENT_DISCOVERY_SLOW_INTERVAL_MS);
          subagentTranscriptRetryTimers.set(sessionId, timerId);
        });
    };

    const timerId = setTimeout(runAttempt, SUBAGENT_DISCOVERY_INTERVAL_MS);
    subagentTranscriptRetryTimers.set(sessionId, timerId);
    logInfo("[subagent_transcript] started transcript discovery retry", {
      sessionId,
      fastIntervalMs: SUBAGENT_DISCOVERY_INTERVAL_MS,
      slowIntervalMs: SUBAGENT_DISCOVERY_SLOW_INTERVAL_MS,
      fastWindowMs: SUBAGENT_DISCOVERY_FAST_WINDOW_MS,
      stopConditions: ["subscribed", "finished", "session_closed", "pane_unsplit"],
    });
  }

  function startSubagentDiscovery(
    parentTabId: string,
    parentSessionId: string | null,
    cwd: string | null,
    wslDistroName: string | null
  ) {
    if (!cwd || !parentSessionId) {
      logWarn("[subagent_discovery] skipped: missing cwd/sessionId", { parentTabId, cwd, parentSessionId, wslDistroName });
      return;
    }
    const key = `${parentTabId}:${parentSessionId}`;
    if (subagentDiscoveryTimers.has(key)) {
      logInfo("[subagent_discovery] already running", { parentTabId, parentSessionId, wslDistroName });
      return;
    }

    const startTime = Date.now();
    let knownAgents = new Set<string>();

    const intervalId = setInterval(() => {
      const elapsed = Date.now() - startTime;
      if (elapsed > SUBAGENT_DIRECTORY_DISCOVERY_TTL_MS) {
        clearInterval(intervalId);
        subagentDiscoveryTimers.delete(key);
        logInfo("[subagent_discovery] TTL expired", { parentTabId, elapsed });
        return;
      }

      logInfo("[subagent_discovery] scan tick", { parentTabId, cwd, sessionId: parentSessionId, wslDistroName, elapsed });
      void invoke<string[]>("subagent_transcript_discover", { cwd, sessionId: parentSessionId, wslDistroName })
        .then((files) => {
          logInfo("[subagent_discovery] scan result", { parentTabId, count: files.length, files });
          for (const filename of files) {
            if (knownAgents.has(filename)) continue;
            knownAgents.add(filename);

            const match = filename.match(/^agent-(.+)\.jsonl$/);
            if (!match) continue;
            const discoveredAgentId = match[1];

            logInfo("[subagent_discovery] found new child", { parentTabId, filename, discoveredAgentId });

            const store = useTerminalStore.getState();
            const existingSession = store.sessions.find(
              (s) =>
                s.kind === "subagent-transcript" &&
                s.subagent?.parentSessionId === parentTabId &&
                (s.subagent.agentId === discoveredAgentId || s.id === `subagent:${discoveredAgentId}`)
            );

            if (existingSession) {
              // 推导 child JSONL 路径并升级 pane
              logInfo("[subagent_discovery] subscribing discovered child", {
                parentTabId,
                existingSessionId: existingSession.id,
                cwd,
                sessionId: parentSessionId,
                discoveredAgentId,
                wslDistroName,
              });
              void invoke<SubagentTranscriptSubscribeResult>("subagent_transcript_subscribe", {
                key: existingSession.id,
                transcriptPath: null,
                cwd,
                sessionId: parentSessionId,
                agentId: discoveredAgentId,
                wslDistroName,
              })
                .then((result) => {
                  const childSource: SubagentTranscriptSource = {
                    kind: "child-jsonl",
                    transcriptPath: result.path,
                  };
                  useTerminalStore.setState((state) => ({
                    sessions: state.sessions.map((session) =>
                      session.id === existingSession.id && session.kind === "subagent-transcript" && session.subagent
                        ? { ...session, subagent: { ...session.subagent, agentId: discoveredAgentId, source: childSource } }
                        : session
                    ),
                    subagentTranscripts: {
                      ...state.subagentTranscripts,
                      [existingSession.id]: {
                        ...(state.subagentTranscripts[existingSession.id] ?? { content: "", ended: false, resetSeq: 0 }),
                        source: childSource,
                      },
                    },
                  }));
                  if (result.initialContent) {
                    useTerminalStore.getState().appendSubagentTranscript(existingSession.id, result.initialContent, true);
                  }
                  logInfo("[subagent_discovery] upgraded to child-jsonl", {
                    parentTabId,
                    agentId: discoveredAgentId,
                    derivedPath: result.path,
                    initialBytes: result.initialContent.length,
                  });
                })
                .catch((err) => logWarn("[subagent_discovery] subscribe failed", { parentTabId, agentId: discoveredAgentId, err }));
            }
          }

          if (knownAgents.size > 0) {
            clearInterval(intervalId);
            subagentDiscoveryTimers.delete(key);
            logInfo("[subagent_discovery] stopped after finding agents", { parentTabId, count: knownAgents.size });
          }
        })
        .catch((err) => {
          logWarn("[subagent_discovery] scan failed", { parentTabId, err });
        });
    }, SUBAGENT_DISCOVERY_INTERVAL_MS);

    subagentDiscoveryTimers.set(key, intervalId);
    logInfo("[subagent_discovery] started", { parentTabId, cwd, sessionId: parentSessionId, wslDistroName, ttlMs: SUBAGENT_DIRECTORY_DISCOVERY_TTL_MS });
  }

  function persistSshConnectionStateAfterPtyStatus(sessionId: string, payload: PtyStatusPayload): void {
    if (payload.status !== "exited" && payload.status !== "error") return;
    queueMicrotask(() => {
      const sessions = useTerminalStore.getState().sessions;
      if (!sessions.some((session) => session.id === sessionId && session.environmentType === "ssh")) return;
      queueSshSessionPersistence(sessions);
    });
  }

  const hookRunningTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

  function clearHookRunningTimeout(tabId: string) {
    const timer = hookRunningTimeouts.get(tabId);
    if (timer === undefined) return;
    clearTimeout(timer);
    hookRunningTimeouts.delete(tabId);
  }

  function scheduleHookRunningTimeout(tabId: string, updatedAt: string) {
    clearHookRunningTimeout(tabId);
    const timer = setTimeout(() => {
      hookRunningTimeouts.delete(tabId);
      const store = useTerminalStore.getState();
      if (!store.sessions.some((session) => session.id === tabId)) return;
      const current = store.tabStatuses[tabId];
      if (current?.hook !== "running" || current.hookUpdatedAt !== updatedAt) return;
      useTerminalStore.setState((state) => buildTabStatusUpdate(state, tabId, "hook", "none", new Date().toISOString()));
    }, HOOK_RUNNING_TIMEOUT_MS);
    hookRunningTimeouts.set(tabId, timer);
  }

  const actions: Pick<TerminalStore, "markAttentionInputHandled" | "handleCliHookEvent" | "handleShellRuntimeEvent" | "openSubagentTranscript" | "finishSubagentTranscript" | "appendSubagentTranscript"> = {
    markAttentionInputHandled: (sessionId) => {
      const tabId = resolvePrimaryTabId(sessionId, get().splits);
      if (get().tabStatuses[tabId]?.hook !== "attention") return;
      const updatedAt = new Date().toISOString();
      scheduleHookRunningTimeout(tabId, updatedAt);
      set((state) => buildTabStatusUpdate(state, tabId, "hook", "running", updatedAt));
    },

    handleCliHookEvent: (payload) => {
      const state = get();
      const rawTabId = payload.tabId;
      const primaryTabId = resolvePrimaryTabId(payload.tabId, state.splits);
      const projectState = useProjectStore.getState();
      const resolution = resolveCliHookTarget({
        rawTabId,
        primaryTabId,
        source: payload.source,
        cwd: payload.cwd,
        sessionId: payload.sessionId,
        wslDistroName: resolveHookWslDistroName(payload),
        environmentType: payload.environmentType,
        receivedAt: Date.now(),
        candidates: state.sessions
          .filter((session) => (session.kind ?? "pty") === "pty" && !session.remoteHandoff)
          .map((session) => {
            const project = session.projectId
              ? projectState.projects.find((item) => item.id === session.projectId) ?? null
              : findProjectByPath(projectState.projects, session.cwd);
            const worktree = session.worktreeId
              ? projectState.worktrees.find((item) => item.id === session.worktreeId) ?? null
              : findWorktreeByPath(projectState.worktrees, session.cwd);
            return {
              id: session.id,
              source: inferHookBindingSource(
                `${session.cliTool ?? ""} ${session.startupCmd ?? ""} ${session.title ?? ""} ${project?.cli_tool ?? ""}`
              ),
              paths: [session.cwd, worktree?.path, project?.path].filter((path): path is string => Boolean(path?.trim())),
              cliSessionId: session.cliSessionId,
              environmentType: session.environmentType,
              outputActivityAt: state.ptyOutputActivityAt[session.id],
            };
          }),
      });
      const tabId = resolution.tabId;
      if (!tabId) {
        logWarn("CLI hook target unresolved", {
          source: payload.source ?? null,
          event: payload.event,
          rawTabId,
          cwd: payload.cwd ?? null,
          reason: resolution.reason,
        });
        return null;
      }
      if (resolution.reason !== "exact" && resolution.reason !== "legacy") {
        logInfo("CLI hook target recovered", {
          source: payload.source ?? null,
          event: payload.event,
          rawTabId,
          tabId,
          reason: resolution.reason,
        });
      }
      const cliSessionId = payload.sessionId?.trim();
      const remoteTranscriptRef = payload.environmentType === "ssh" ? payload.remoteTranscriptRef?.trim() : undefined;
      const cliReasoningEffort = payload.reasoningEffort?.trim();
      let boundNewCliSessionId = false;
      if ((cliSessionId || remoteTranscriptRef || cliReasoningEffort) && get().sessions.some((session) => session.id === tabId)) {
        set((state) => ({
          sessions: state.sessions.map((session) => {
            if (session.id !== tabId) return session;
            const cliSessionRebind = resolveCliSessionRebind(session.cliSessionId, cliSessionId);
            if (cliSessionRebind.changed) {
              boundNewCliSessionId = true;
            }
            return {
              ...session,
              ...(cliSessionRebind.changed ? { cliSessionId: cliSessionRebind.cliSessionId } : {}),
              ...(remoteTranscriptRef && session.remoteTranscriptRef !== remoteTranscriptRef
                ? { remoteTranscriptRef }
                : {}),
              ...(cliReasoningEffort && session.cliReasoningEffort !== cliReasoningEffort
                ? { cliReasoningEffort }
                : {}),
            };
          }),
        }));
        const boundSession = get().sessions.find((session) => session.id === tabId);
        const persistedSession = useSessionStore.getState().sessions.find((session) => session.id === tabId);
        const persistedCliSessionRebind = resolveCliSessionRebind(persistedSession?.cliSessionId, cliSessionId);
        if (persistedCliSessionRebind.changed || boundSession?.environmentType === "ssh") {
          void queueSshSessionPersistence(get().sessions).catch((error) => {
            logWarn("Failed to persist CLI session identity", {
              sessionId: tabId,
              error,
            });
          });
        }
      }
      const updatedAt = payload.timestamp ?? new Date().toISOString();
      const status = mapCliHookEvent(payload.event);
      // SessionStart 绑定 id、回合结束/失败时立刻踢侧栏重拉用量，避免等 10s 轮询才「闪一下」出来。
      if (
        boundNewCliSessionId ||
        payload.event === "Stop" ||
        payload.event === "StopFailure" ||
        payload.event === "Interrupt" ||
        payload.event === "UserPromptSubmit"
      ) {
        set((state) => ({ statsPanelRefreshSeq: state.statsPanelRefreshSeq + 1 }));
      }
      if (!status) return tabId;
      // 乱序防御：各 hook 事件由独立进程上报，到达顺序不保证；丢弃比已记录
      // 状态更旧的事件（如 Stop 之后才迟到的 UserPromptSubmit）。
      const previousAt = get().tabStatuses[tabId]?.hookUpdatedAt;
      if (previousAt) {
        const incoming = Date.parse(updatedAt);
        const existing = Date.parse(previousAt);
        if (Number.isFinite(incoming) && Number.isFinite(existing) && incoming < existing) return tabId;
      }
      if (status === "running") {
        scheduleHookRunningTimeout(tabId, updatedAt);
      } else {
        clearHookRunningTimeout(tabId);
      }
      set((state) => {
        const next = buildTabStatusUpdate(state, tabId, "hook", status, updatedAt);
        const terminalOutputStopped = status === "done" || status === "failed";
        const ptyOutputActivityAt = terminalOutputStopped
          ? { ...state.ptyOutputActivityAt }
          : null;
        if (ptyOutputActivityAt) delete ptyOutputActivityAt[tabId];
        if (!terminalOutputStopped) return next;

        const tabStatus = next.tabStatuses[tabId];
        if (!tabStatus?.shell) return { ...next, ptyOutputActivityAt: ptyOutputActivityAt! };
        const resolved: TabStatusSources = { ...tabStatus };
        delete resolved.shell;
        delete resolved.shellUpdatedAt;
        return {
          tabStatuses: { ...next.tabStatuses, [tabId]: resolved },
          tabNotifications: { ...next.tabNotifications, [tabId]: getTabStatusEntry(resolved) },
          tabStatusDetails: { ...next.tabStatusDetails, [tabId]: getTabStatusDetails(resolved) },
          ptyOutputActivityAt: ptyOutputActivityAt!,
        };
      });
      return tabId;
    },

    handleShellRuntimeEvent: (payload) => {
      const tabId = resolvePrimaryTabId(payload.sessionId, get().splits);
      const session = get().sessions.find((item) => item.id === tabId);
      if (!session || !isShellRuntimeMonitoringEnabled()) return null;
      const project = session.projectId
        ? useProjectStore.getState().projects.find((item) => item.id === session.projectId)
        : undefined;
      // Agent processes such as Codex and SSH stay alive across many turns. Their
      // shell lifecycle cannot represent turn state; Hook events are authoritative.
      if (resolveAgentTerminalMetadata(session, project).isAgentSession) return null;
      // 回车猜测只对 cmd 生效：cmd 无法注入 C 序列，输入侧猜测是它唯一的
      // command_started 信号；其余 shell 由 OSC 133/633/777 驱动，猜测只会误判
      // （多行输入、TUI 内回车、历史命令均不可靠）。
      if (payload.origin === "input" && normalizeShellKey(session.shell) !== "cmd") return null;
      const updatedAt = payload.timestamp ?? new Date().toISOString();
      if (payload.event === "prompt_shown") {
        // prompt 重新出现 = 前一条命令已结束。仅在 shell 来源仍是 running 时收口
        // 为 done，覆盖拿不到 D;exit 的场景（Ctrl+C 中断、cmd 无 exit code）。
        if (get().tabStatuses[tabId]?.shell !== "running") return tabId;
        set((state) => buildTabStatusUpdate(state, tabId, "shell", "done", updatedAt));
        return tabId;
      }
      const status = mapShellRuntimeEvent(payload.event, payload.exitCode ?? null);
      if (status === "none") return tabId;
      set((state) => buildTabStatusUpdate(state, tabId, "shell", status, updatedAt));
      return tabId;
    },

    openSubagentTranscript: async (payload) => {
      const parentTabId = payload.tabId;
      const sessions = get().sessions;
      // 多窗口隔离：hook 事件广播到所有窗口，仅拥有该 Tab 的窗口处理。
      if (!sessions.some((session) => session.id === parentTabId)) {
        logInfo("[subagent_transcript] parent tab not found, skipping", {
          parentTabId,
          event: payload.event,
          agentId: payload.agentId,
          sessionCount: sessions.length,
          sessionIds: sessions.map((s) => s.id).slice(0, 5),
        });
        return;
      }

      const parentWorkspan = findWorkspanBySession(get().workspans, parentTabId);
      const tree = parentWorkspan?.paneTree ?? null;
      if (!tree || !parentWorkspan) return;

      const agentId = trimOptional(payload.agentId);
      const toolUseId = trimOptional(payload.toolUseId);
      const resolvedWslDistroName = resolveHookWslDistroName(payload);
      const resolvedSource = resolveSubagentTranscriptSource(payload);
      const existingSessionId = findSubagentSessionId(sessions, payload);
      const pseudoId = existingSessionId ?? createSubagentPaneId(parentTabId, agentId, toolUseId, resolvedSource.kind === "child-jsonl" ? resolvedSource.transcriptPath ?? null : null);
      const previousSource = get().subagentTranscripts[pseudoId]?.source;
      const source = mergeSubagentSource(previousSource, resolvedSource);
      const shouldSubscribe = shouldSubscribeSubagentSource(previousSource, source);
      const splitViewEnabled = useSettingsStore.getState().hookSubagentSplitViewEnabled;

      logInfo("[subagent_transcript] source resolved", {
        event: payload.event,
        pseudoId,
        agentId,
        toolUseId,
        sessionId: payload.sessionId ?? null,
        cwd: payload.cwd ?? null,
        wslDistroName: resolvedWslDistroName,
        payloadWslDistroName: trimOptional(payload.wslDistroName),
        inferredWslDistroName: inferWslDistroFromCwd(payload.cwd),
        sourceKind: source.kind,
        transcriptPath: source.transcriptPath ?? null,
        parentTranscriptPath: source.parentTranscriptPath ?? null,
        hasAgentTranscriptPath: Boolean(trimOptional(payload.agentTranscriptPath)),
        hasParentTranscriptPath: Boolean(trimOptional(payload.transcriptPath)),
        agentTranscriptPath: trimOptional(payload.agentTranscriptPath),
        payloadTranscriptPath: trimOptional(payload.transcriptPath),
        samePath: isSameTranscriptPath(trimOptional(payload.agentTranscriptPath), trimOptional(payload.transcriptPath)),
        reason: source.reason,
        shouldSubscribe,
      });

      const subscribeChild = async () => {
        if (source.kind !== "child-jsonl" || !source.transcriptPath) {
          logWarn("[subagent_transcript] skip full parent transcript tail", {
            event: payload.event,
            pseudoId,
            agentId,
            toolUseId,
            sourceKind: source.kind,
            reason: source.reason,
            wslDistroName: resolvedWslDistroName,
          });
          return false;
        }
        try {
          const result = await invoke<SubagentTranscriptSubscribeResult>("subagent_transcript_subscribe", {
            key: pseudoId,
            transcriptPath: source.transcriptPath,
            parentTranscriptPath: source.parentTranscriptPath ?? null,
            cwd: payload.cwd ?? null,
            sessionId: payload.sessionId ?? null,
            agentId,
            wslDistroName: resolvedWslDistroName,
          });
          if (result.initialContent) {
            useTerminalStore.getState().appendSubagentTranscript(pseudoId, result.initialContent, true);
          }
          stopSubagentTranscriptRetry(pseudoId, "explicit_child_subscribed");
          logInfo("[subagent_transcript] subscribed child transcript", {
            pseudoId,
            path: result.path,
            initialBytes: result.initialContent.length,
          });
          return true;
        } catch (err) {
          logError("subagent_transcript_subscribe failed", { pseudoId, err });
          return false;
        }
      };

      const subscribeDerivedChild = async () => {
        if (!shouldAttemptDerivedChildTranscript(payload, source)) {
          logInfo("[subagent_transcript] derived subscription not attempted", {
            event: payload.event,
            pseudoId,
            agentId,
            sourceKind: source.kind,
            wslDistroName: resolvedWslDistroName,
          });
          return false;
        }
        try {
          const result = await invoke<SubagentTranscriptSubscribeResult>("subagent_transcript_subscribe", {
            key: pseudoId,
            transcriptPath: null,
            parentTranscriptPath: source.parentTranscriptPath ?? null,
            cwd: payload.cwd ?? null,
            sessionId: payload.sessionId ?? null,
            agentId,
            wslDistroName: resolvedWslDistroName,
          });
          const childSource: SubagentTranscriptSource = {
            kind: "child-jsonl",
            transcriptPath: result.path,
            parentTranscriptPath: source.parentTranscriptPath,
          };
          useTerminalStore.setState((state) => ({
            sessions: state.sessions.map((session) =>
              session.id === pseudoId && session.kind === "subagent-transcript" && session.subagent
                ? { ...session, subagent: { ...session.subagent, source: childSource } }
                : session
            ),
            subagentTranscripts: {
              ...state.subagentTranscripts,
              [pseudoId]: {
                ...(state.subagentTranscripts[pseudoId] ?? { content: "", ended: false, resetSeq: 0 }),
                source: childSource,
              },
            },
          }));
          if (result.initialContent) {
            useTerminalStore.getState().appendSubagentTranscript(pseudoId, result.initialContent, true);
          }
          stopSubagentTranscriptRetry(pseudoId, "derived_child_subscribed");
          logInfo("[subagent_transcript] derived child transcript subscription", {
            pseudoId,
            agentId,
            derivedPath: result.path,
            initialBytes: result.initialContent.length,
          });
          return true;
        } catch (err) {
          logWarn("[subagent_transcript] derived child transcript unavailable", { pseudoId, agentId, err });
          return true;
        }
      };

      const subscribeCodexRolloutChild = async () => {
        if (payload.source !== "codex" || source.kind === "child-jsonl") {
          return false;
        }

        const parentSessionId = payload.sessionId?.trim();
        if (!agentId || !parentSessionId) {
          logInfo("[subagent_transcript] codex rollout discovery skipped: missing identity", {
            event: payload.event,
            pseudoId,
            agentId,
            sessionId: parentSessionId ?? null,
            wslDistroName: resolvedWslDistroName,
            parentTranscriptPath: source.parentTranscriptPath ?? null,
          });
          return false;
        }

        const retryDiagnostics = subagentTranscriptRetryDiagnostics.get(pseudoId);
        const retryAttemptCount = retryDiagnostics?.attemptCount ?? null;
        const shouldLogAttempt = retryAttemptCount === null
          || retryAttemptCount <= 3
          || retryAttemptCount === 5
          || retryAttemptCount % 12 === 0;

        try {
          const codexConfigDir = useSettingsStore.getState().codexHookConfigDir ?? undefined;
          if (shouldLogAttempt) {
            logInfo("[subagent_transcript] codex rollout discovery requested", {
              pseudoId,
              agentId,
              parentSessionId,
              retryAttemptCount,
              retryElapsedMs: retryDiagnostics ? Date.now() - retryDiagnostics.startedAt : null,
              codexConfigDir: codexConfigDir ?? null,
              cwd: payload.cwd ?? null,
              resolvedWslDistroName,
              sourceKind: source.kind,
              sourceReason: source.reason ?? null,
              parentTranscriptPath: source.parentTranscriptPath ?? null,
              payloadTranscriptPath: trimOptional(payload.transcriptPath),
              payloadAgentTranscriptPath: trimOptional(payload.agentTranscriptPath),
            });
          }
          const discoveredPath = await invoke<string | null>("codex_subagent_transcript_discover", {
            parentSessionId,
            agentId,
            codexConfigDir,
            wslDistroName: resolvedWslDistroName,
            parentTranscriptPath: source.parentTranscriptPath ?? null,
          });
          if (!discoveredPath) {
            if (shouldLogAttempt) {
              logInfo("[subagent_transcript] codex rollout transcript not found yet", {
                pseudoId,
                agentId,
                parentSessionId,
                retryAttemptCount,
                retryElapsedMs: retryDiagnostics ? Date.now() - retryDiagnostics.startedAt : null,
                codexConfigDir: codexConfigDir ?? null,
                sourceKind: source.kind,
                sourceReason: source.reason ?? null,
                parentTranscriptPath: source.parentTranscriptPath ?? null,
              });
            }
            return false;
          }

          logInfo("[subagent_transcript] codex rollout discovered path", {
            pseudoId,
            agentId,
            parentSessionId: payload.sessionId,
            discoveredPath,
            codexConfigDir: codexConfigDir ?? null,
          });
          const result = await invoke<SubagentTranscriptSubscribeResult>("subagent_transcript_subscribe", {
            key: pseudoId,
            transcriptPath: discoveredPath,
            parentTranscriptPath: source.parentTranscriptPath ?? null,
            cwd: payload.cwd ?? null,
            sessionId: payload.sessionId ?? null,
            agentId,
            wslDistroName: resolvedWslDistroName,
          });
          const childSource: SubagentTranscriptSource = {
            kind: "child-jsonl",
            transcriptPath: result.path,
            parentTranscriptPath: source.parentTranscriptPath,
          };
          useTerminalStore.setState((state) => ({
            sessions: state.sessions.map((session) =>
              session.id === pseudoId && session.kind === "subagent-transcript" && session.subagent
                ? { ...session, subagent: { ...session.subagent, source: childSource } }
                : session
            ),
            subagentTranscripts: {
              ...state.subagentTranscripts,
              [pseudoId]: {
                ...(state.subagentTranscripts[pseudoId] ?? { content: "", ended: false, resetSeq: 0 }),
                source: childSource,
              },
            },
          }));
          if (result.initialContent) {
            useTerminalStore.getState().appendSubagentTranscript(pseudoId, result.initialContent, true);
          }
          stopSubagentTranscriptRetry(pseudoId, "codex_rollout_subscribed");
          logInfo("[subagent_transcript] subscribed codex rollout transcript", {
            pseudoId,
            agentId,
            path: result.path,
            initialBytes: result.initialContent.length,
          });
          return true;
        } catch (err) {
          if (shouldLogAttempt) {
            logWarn("[subagent_transcript] codex rollout transcript subscribe failed", {
              pseudoId,
              agentId,
              parentSessionId,
              retryAttemptCount,
              retryElapsedMs: retryDiagnostics ? Date.now() - retryDiagnostics.startedAt : null,
              err,
            });
          }
          return false;
        }
      };

      const subscribeAvailableChild = async () => {
        if (shouldSubscribe) {
          await subscribeChild();
          return;
        }

        const codexSubscribed = await subscribeCodexRolloutChild();
        if (
          !codexSubscribed &&
          payload.source === "codex" &&
          payload.event === "SubagentStart" &&
          source.kind !== "child-jsonl" &&
          agentId &&
          payload.sessionId?.trim()
        ) {
          startSubagentTranscriptRetry(pseudoId, subscribeCodexRolloutChild);
        }
        if (!codexSubscribed && !(await subscribeDerivedChild()) && source.kind !== "child-jsonl") {
          await subscribeChild();
        }
      };

      // 去重：同一子 Agent 已有面板则更新 source；仅发现/切换 child JSONL 时订阅。
      if (sessions.some((session) => session.id === pseudoId)) {
        const agentType = payload.agentType?.trim() || null;
        const parentSession = sessions.find((session) => session.id === parentTabId);
        const existingSession = sessions.find((session) => session.id === pseudoId);

        // 如果这次更新带来了 agentType（通常是 SubagentStart 绑定到 AgentToolStart 创建的 placeholder），重建标题。
        const shouldUpdateTitle = agentType && existingSession && (!existingSession.subagent?.agentType);
        const newTitle = shouldUpdateTitle
          ? buildSubagentTitle(
            parentSession,
            agentType,
            sessions.filter((s) => s.kind === "subagent-transcript" && s.subagent?.parentSessionId === parentTabId && s.id !== pseudoId).length
          )
          : undefined;

        set((state) => ({
          sessions: state.sessions.map((session) =>
            session.id === pseudoId && session.kind === "subagent-transcript" && session.subagent
              ? {
                ...session,
                title: newTitle ?? session.title,
                subagent: {
                  ...session.subagent,
                  agentId: agentId ?? session.subagent.agentId,
                  toolUseId: toolUseId ?? session.subagent.toolUseId,
                  agentType: agentType ?? session.subagent.agentType,
                  source,
                },
              }
              : session
          ),
          subagentTranscripts: {
            ...state.subagentTranscripts,
            [pseudoId]: { ...(state.subagentTranscripts[pseudoId] ?? { content: "", ended: false, resetSeq: 0 }), ended: false, source },
          },
        }));
        await subscribeAvailableChild();
        return;
      }

      if (!splitViewEnabled) {
        logInfo("[subagent_transcript] split view disabled, skipping new pane", {
          event: payload.event,
          parentTabId,
          agentId,
          toolUseId,
        });
        return;
      }

      // AgentToolStart/AgentToolStop 在并发场景下无法可靠关联到 SubagentStart（前者只有 toolUseId，后者只有 agentId）。
      // 策略：这两个事件只触发 discovery，不创建 UI；SubagentStart 创建真实 Tab，discovery 负责升级内容源。
      // Claude 在部分 WSL 场景只发 ToolStart/ToolStop + agentId，因此这类事件允许创建降级 pane 并尝试派生订阅。
      if (payload.event === "AgentToolStart" || payload.event === "AgentToolStop") {
        if (!agentId && (resolvedSource.kind === "pending" || resolvedSource.kind === "lifecycle-only")) {
          startSubagentDiscovery(parentTabId, payload.sessionId ?? null, payload.cwd ?? null, resolvedWslDistroName);
        } else {
          logInfo("[subagent_discovery] not started for AgentTool event", {
            event: payload.event,
            parentTabId,
            agentId,
            resolvedSourceKind: resolvedSource.kind,
            wslDistroName: resolvedWslDistroName,
          });
        }
        return;
      }

      const agentType = payload.agentType?.trim() || null;
      const parentSession = sessions.find((session) => session.id === parentTabId);
      const existingSubagentCount = sessions.filter(
        (session) => session.kind === "subagent-transcript" && session.subagent?.parentSessionId === parentTabId
      ).length;
      const pseudoSession: TerminalSession = {
        id: pseudoId,
        title: buildSubagentTitle(parentSession, agentType, existingSubagentCount),
        kind: "subagent-transcript",
        subagent: {
          parentSessionId: parentTabId,
          agentId: agentId ?? undefined,
          toolUseId: toolUseId ?? undefined,
          agentType: agentType ?? undefined,
          source,
        },
      };

      // 并行多子 Agent：同父已有转录面板则作为该 pane 内的 Tab 追加，避免布局被多 pane 撑爆；
      // 否则从父 Tab 所在 pane 分屏出新面板。
      const existingTranscript = sessions.find(
        (session) => session.kind === "subagent-transcript" && session.subagent?.parentSessionId === parentTabId
      );
      const existingPane = existingTranscript ? findPaneLeafBySession(tree, existingTranscript.id) : null;
      let nextTree: TerminalPaneNode | null;
      if (existingPane) {
        nextTree = addSessionToPaneTree(tree, existingPane.id, pseudoId, createPaneId).tree;
      } else {
        const parentPane = findPaneLeafBySession(tree, parentTabId);
        if (!parentPane) return;
        nextTree = splitPaneLeaf(tree, parentPane.id, "horizontal", pseudoId, createPaneId).tree;
      }

      const newSessions = [...sessions, pseudoSession];
      // 不抢焦点：保留当前 activeSessionId（终端），转录在其分屏 pane 中即时可见。
      const state = get();
      const workspans = updateTerminalWorkspan(state.workspans, parentWorkspan.id, (workspan) => (
        syncTerminalWorkspanLayout(workspan, nextTree, workspan.activePaneId, workspan.activeSessionId)
      ));
      const workspanState = state.activeWorkspanId === parentWorkspan.id
        ? buildWorkspanMirror(workspans, parentWorkspan.id)
        : { workspans };
      set({
        sessions: newSessions,
        ...workspanState,
        subagentTranscripts: { ...state.subagentTranscripts, [pseudoId]: { content: "", ended: false, resetSeq: 0, source } },
      });

      // 持久化（sessionStore 会过滤掉转录伪会话）。
      void useSessionStore.getState().saveSessions(newSessions).catch(() => { });
      persistWorkspanState(workspans, state.activeWorkspanId, newSessions);

      await subscribeAvailableChild();
    },

    finishSubagentTranscript: (payload) => {
      const sessionId = findSubagentSessionId(get().sessions, payload);
      if (!sessionId) {
        const candidates = get().sessions.filter(
          (session) => session.kind === "subagent-transcript" && session.subagent?.parentSessionId === payload.tabId
        );
        logWarn("[subagent_transcript] stop target not resolved", {
          tabId: payload.tabId,
          agentId: trimOptional(payload.agentId),
          candidateCount: candidates.length,
        });
        return;
      }
      const currentTranscript = get().subagentTranscripts[sessionId];
      if (currentTranscript?.ended) return;
      logInfo("[subagent_transcript] stop target resolved", {
        sessionId,
        tabId: payload.tabId,
        event: payload.event,
        source: payload.source,
        agentId: trimOptional(payload.agentId),
        parentSessionId: trimOptional(payload.sessionId),
        wslDistroName: trimOptional(payload.wslDistroName),
        transcriptPath: trimOptional(payload.transcriptPath),
        agentTranscriptPath: trimOptional(payload.agentTranscriptPath),
        currentSourceKind: currentTranscript?.source.kind ?? null,
        currentTranscriptPath: currentTranscript?.source.transcriptPath ?? null,
        currentParentTranscriptPath: currentTranscript?.source.parentTranscriptPath ?? null,
      });
      stopSubagentTranscriptRetry(sessionId, "subagent_finished");

      // 停止对应的目录扫描（如果有）
      const parentSessionId = payload.sessionId ?? null;
      if (parentSessionId) {
        const discoveryKey = `${payload.tabId}:${parentSessionId}`;
        const discoveryTimer = subagentDiscoveryTimers.get(discoveryKey);
        if (discoveryTimer) {
          clearInterval(discoveryTimer);
          subagentDiscoveryTimers.delete(discoveryKey);
          logInfo("[subagent_discovery] stopped by finishSubagentTranscript", { discoveryKey });
        }
      }

      set((state) => {
        const prev = state.subagentTranscripts[sessionId];
        if (!prev) return state;
        return {
          subagentTranscripts: { ...state.subagentTranscripts, [sessionId]: { ...prev, ended: true } },
        };
      });

      const existingTimer = subagentCloseTimers.get(sessionId);
      if (existingTimer) clearTimeout(existingTimer);
      const settings = useSettingsStore.getState();
      const closeDelayMs =
        settings.hookPopupAutoCloseEnabled
          ? settings.hookPopupAutoCloseSeconds * 1000
          : currentTranscript?.source.kind === "child-jsonl" || payload.source === "codex"
            ? SUBAGENT_CHILD_JSONL_CLOSE_DELAY_MS
            : SUBAGENT_CLOSE_DELAY_MS;
      logInfo("[subagent_transcript] schedule transcript close", { sessionId, closeDelayMs, sourceKind: currentTranscript?.source.kind });
      const timer = setTimeout(() => {
        subagentCloseTimers.delete(sessionId);
        const store = useTerminalStore.getState();
        if (!store.sessions.some((session) => session.id === sessionId)) return;
        void store.closeSession(sessionId);
      }, closeDelayMs);
      subagentCloseTimers.set(sessionId, timer);
    },

    appendSubagentTranscript: (key, content, reset) => {
      const session = get().sessions.find((candidate) => candidate.id === key);
      const shouldFinish = Boolean(
        session?.kind === "subagent-transcript"
        && session.subagent
        && !get().subagentTranscripts[key]?.ended
        && hasCodexTerminalEvent(content),
      );
      set((state) => {
        const prev = state.subagentTranscripts[key];
        // 仅更新已存在的订阅（本窗口 openSubagentTranscript 预置）；未知 key 忽略（多窗口广播）。
        if (!prev) return state;
        let droppedChars = 0;
        let nextContent: string;
        if (content.length >= SUBAGENT_TRANSCRIPT_MAX_CHARS) {
          nextContent = content.slice(-SUBAGENT_TRANSCRIPT_MAX_CHARS);
          droppedChars = (reset ? 0 : prev.content.length) + content.length - nextContent.length;
        } else if (reset) {
          nextContent = content;
        } else {
          const maxPrevChars = SUBAGENT_TRANSCRIPT_MAX_CHARS - content.length;
          const prevTail = prev.content.length > maxPrevChars ? prev.content.slice(-maxPrevChars) : prev.content;
          droppedChars = prev.content.length - prevTail.length;
          nextContent = prevTail + content;
        }
        if (droppedChars > 0) {
          debugConsoleWarn("[oom-diagnostics:webview]", {
            area: "subagentTranscript",
            phase: "appendTrim",
            key,
            droppedChars,
            contentChars: content.length,
            retainedChars: nextContent.length,
            maxChars: SUBAGENT_TRANSCRIPT_MAX_CHARS,
            reset,
            thresholdExceeded: true,
          });
          logWarn("[oom-diagnostics:webview] subagent transcript trimmed", {
            area: "subagentTranscript",
            phase: "appendTrim",
            key,
            droppedChars,
            contentChars: content.length,
            retainedChars: nextContent.length,
            maxChars: SUBAGENT_TRANSCRIPT_MAX_CHARS,
            reset,
            thresholdExceeded: true,
          });
        }
        return {
          subagentTranscripts: {
            ...state.subagentTranscripts,
            [key]: {
              ...prev,
              content: nextContent,
              truncatedBytes: (reset ? 0 : prev.truncatedBytes ?? 0) + droppedChars,
              // reset 或前部裁剪都破坏"纯尾部追加"前提，自增序号通知消费方全量重解析。
              resetSeq: reset || droppedChars > 0 ? (prev.resetSeq ?? 0) + 1 : prev.resetSeq ?? 0,
            },
          },
        };
      });
      if (shouldFinish && session?.subagent) {
        const parentSessionId = session.subagent.parentSessionId;
        get().finishSubagentTranscript({
          tabId: parentSessionId,
          event: "SubagentStop",
          source: "codex",
          sessionId: parentSessionId,
          agentId: session.subagent.agentId ?? null,
        });
      }
    },
  };

  return {
    actions,
    queueSshSessionPersistence,
    clearHookRunningTimeout,
    persistSshConnectionStateAfterPtyStatus,
    createWorkspanId,
    createPaneId,
    subagentCloseTimers,
    stopSubagentTranscriptRetry,
    scheduleSaveActiveId,
  };
}
