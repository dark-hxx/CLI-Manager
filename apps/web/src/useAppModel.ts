import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRequestId } from "./requestId";
import type {
  AuthUser,
  ConversationEvent,
  Device,
  HistorySessionSummary,
  JsonObject,
  LoadState,
  Operation,
  PairingState,
  ProjectContext,
  TerminalControlMode,
  TimelineItem,
  WebTerminalTab,
  WorkspaceSnapshot,
} from "./domain";
import { ApiError, connectBrowserSocket, webClient, type BrowserSocketConnection } from "./webClient";
import { establishedSessionId, validSelectedSessionId, visibleConversationTimeline, mergeConversationEvents } from "./conversation";
import { createHistoryRefresh } from "./historyRefresh";
import { createTerminalStream } from "./terminalStream";

const SEQUENCE_PREFIX = "cli-manager.web.browser-sequence";
const DRAFT_PREFIX = "cli-manager.web.draft";

type AuthPhase = "checking" | "login" | "authenticated" | "expired" | "error";

const OPERATION_STATUS_RANK: Record<Operation["status"], number> = {
  submitted: 0,
  waiting_device: 1,
  accepted: 2,
  running: 3,
  succeeded: 4,
  failed: 4,
  rejected: 4,
  timed_out: 4,
  canceled: 4,
};

function serverTime(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed < 10_000_000_000 ? parsed * 1000 : parsed;
}

function draftKey(deviceId: string | undefined, projectId: string | undefined, sessionId: string | undefined) {
  return `${DRAFT_PREFIX}:${deviceId ?? "none"}:${projectId ?? "none"}:${sessionId ?? "new"}`;
}

function sequenceKey(userId: string) {
  return `${SEQUENCE_PREFIX}:${userId}`;
}

function requestErrorCode(caught: unknown) {
  return caught instanceof ApiError ? caught.code : "request_failed";
}

function upsertOperation(items: TimelineItem[], operation: Operation): TimelineItem[] {
  const index = items.findIndex((item) => item.type === "operation" && item.operation.id === operation.id);
  const next: TimelineItem = { id: operation.id, type: "operation", operation };
  if (index < 0) return [...items, next];
  const currentItem = items[index]!;
  if (currentItem.type !== "operation") return items;
  const currentUpdatedAt = serverTime(currentItem.operation.updatedAt);
  const nextUpdatedAt = serverTime(operation.updatedAt);
  if (currentUpdatedAt !== null && nextUpdatedAt === null) return items;
  if (currentUpdatedAt !== null && nextUpdatedAt !== null) {
    if (nextUpdatedAt < currentUpdatedAt) return items;
    if (nextUpdatedAt > currentUpdatedAt) return items.map((item, itemIndex) => itemIndex === index ? next : item);
  }
  if (OPERATION_STATUS_RANK[operation.status] < OPERATION_STATUS_RANK[currentItem.operation.status]) return items;
  return items.map((item, itemIndex) => itemIndex === index ? next : item);
}

export function useAppModel() {
  const [authPhase, setAuthPhase] = useState<AuthPhase>("checking");
  const [user, setUser] = useState<AuthUser | null>(null);
  const [deviceScope, setDeviceScope] = useState<string | null>(null);
  const [mobileToken, setMobileToken] = useState(() => {
    const token = new URLSearchParams(location.hash.slice(1)).get("mobileToken") ?? new URLSearchParams(location.search).get("mobileToken");
    if (token) window.history.replaceState(null, "", location.pathname);
    return token;
  });
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [error, setError] = useState("");
  const [devices, setDevices] = useState<Device[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>();
  const [history, setHistory] = useState<HistorySessionSummary[]>([]);
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string>();
  const [selectedProjectContextKey, setSelectedProjectContextKey] = useState<string>();
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [pairing, setPairing] = useState<PairingState>({ status: "idle" });
  const [socketState, setSocketState] = useState<"connecting" | "open" | "closed">("closed");
  const [draft, setDraft] = useState("");
  const [composerMessage, setComposerMessage] = useState("");
  const [terminalSessionId, setTerminalSessionId] = useState<string>();
  const [terminalTabs, setTerminalTabs] = useState<WebTerminalTab[]>([]);
  const [terminalStatus, setTerminalStatus] = useState("idle");
  const [terminalStream] = useState(createTerminalStream);
  const [terminalControlMode, setTerminalControlMode] = useState<TerminalControlMode>("desktop");
  const socketRef = useRef<BrowserSocketConnection | null>(null);
  const terminalSessionRef = useRef<string | undefined>(undefined);
  const terminalTabsRef = useRef<WebTerminalTab[]>([]);
  const selectedProjectContextKeyRef = useRef(selectedProjectContextKey);
  const terminalLaunchOperationRef = useRef<string | undefined>(undefined);
  const terminalLaunchingRef = useRef(false);
  const pendingCloseRef = useRef(new Map<string, string>());
  const sequenceRef = useRef(0);
  const [conversationEvents, setConversationEvents] = useState<Record<string, ConversationEvent[]>>({});
  const [detailState, setDetailState] = useState<LoadState>("idle");
  const viewGenerationRef = useRef(0);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const pendingRequestRef = useRef<{ signature: string; id: string } | null>(null);
  const activeOperationRef = useRef<string | undefined>(undefined);
  const earlyEventsRef = useRef<ConversationEvent[]>([]);
  const selectedDeviceRef = useRef(selectedDeviceId);
  const selectedSessionRef = useRef(selectedSessionId);
  const historyRef = useRef(history);
  historyRef.current = history;
  const historyImportsRef = useRef(new Set<string>());
  selectedDeviceRef.current = selectedDeviceId;
  selectedSessionRef.current = selectedSessionId;
  selectedProjectContextKeyRef.current = selectedProjectContextKey;
  terminalSessionRef.current = terminalSessionId;
  terminalTabsRef.current = terminalTabs;

  const detachTerminal = useCallback((deviceId = selectedDeviceRef.current) => {
    if (deviceId) {
      for (const tab of terminalTabsRef.current) {
        socketRef.current?.sendTerminal(deviceId, { type: "detach", sessionId: tab.sessionId });
      }
    }
    terminalSessionRef.current = undefined;
    terminalTabsRef.current = [];
    setTerminalSessionId(undefined);
    setTerminalTabs([]);
    terminalStream.clear();
    setTerminalStatus("idle");
    setTerminalControlMode("desktop");
  }, [terminalStream]);

  const closeTerminal = useCallback((requestedSessionId?: string) => {
    const deviceId = selectedDeviceRef.current;
    const sessionId = requestedSessionId ?? terminalSessionRef.current;
    if (!sessionId) return;
    if (deviceId && sessionId) {
      pendingCloseRef.current.set(sessionId, deviceId);
      socketRef.current?.sendTerminal(deviceId, { type: "close", sessionId });
    }
    const currentTabs = terminalTabsRef.current;
    const closedIndex = currentTabs.findIndex((tab) => tab.sessionId === sessionId);
    const nextTabs = currentTabs.filter((tab) => tab.sessionId !== sessionId);
    terminalTabsRef.current = nextTabs;
    setTerminalTabs(nextTabs);
    terminalStream.clear(sessionId);
    if (terminalSessionRef.current === sessionId) {
      const nextTab = nextTabs[Math.min(Math.max(closedIndex, 0), nextTabs.length - 1)];
      terminalSessionRef.current = nextTab?.sessionId;
      setTerminalSessionId(nextTab?.sessionId);
      if (nextTab) {
        selectedProjectContextKeyRef.current = nextTab.contextKey;
        setSelectedProjectContextKey(nextTab.contextKey);
        setSelectedSessionId(undefined);
        setTimeline([]);
      } else {
        setTerminalStatus("idle");
        setTerminalControlMode("desktop");
      }
    }
  }, [terminalStream]);

  const attachTerminal = useCallback((deviceId: string, sessionId: string, contextKey: string) => {
    const existing = terminalTabsRef.current.find((tab) => tab.sessionId === sessionId);
    if (!existing) {
      const nextTabs = [...terminalTabsRef.current, { sessionId, contextKey, status: "connecting", controlMode: "desktop" as const }];
      terminalTabsRef.current = nextTabs;
      setTerminalTabs(nextTabs);
      terminalStream.start(sessionId);
    }
    terminalSessionRef.current = sessionId;
    setTerminalSessionId(sessionId);
    setTerminalStatus("connecting");
    setTerminalControlMode("desktop");
    if (!existing) socketRef.current?.sendTerminal(deviceId, { type: "attach", sessionId });
  }, [terminalStream]);

  const attachFromOperation = useCallback((operation: Operation) => {
    if (operation.kind !== "project.start" || operation.status !== "succeeded" || operation.deviceId !== selectedDeviceRef.current) return;
    const payload = operation.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
    const targetType = payload.targetType;
    const targetId = payload.targetId;
    const targetKey = targetType === "project" && typeof targetId === "string"
      ? `project:${targetId}`
      : targetType === "worktree" && typeof targetId === "string"
        ? `worktree:${targetId}`
        : undefined;
    if (!targetKey || targetKey !== selectedProjectContextKeyRef.current) return;
    const result = operation.result;
    if (!result || typeof result !== "object" || Array.isArray(result)) return;
    const ids = (result as JsonObject).sessionIds;
    if (Array.isArray(ids) && typeof ids[0] === "string") attachTerminal(selectedDeviceRef.current, ids[0], targetKey);
  }, [attachTerminal]);

  const selectedDevice = devices.find((item) => item.id === selectedDeviceId);
  const selectedSession = history.find((item) => item.sessionId === selectedSessionId);
  const projectContexts = useMemo<ProjectContext[]>(() => {
    if (workspace) {
      const contexts: ProjectContext[] = [];
      const sessionByContext = new Map<string, HistorySessionSummary>();
      for (const session of history) {
        if (!session.projectId) continue;
        sessionByContext.set(`${session.projectId}:${session.worktreeId ?? "project"}`, session);
      }
      for (const project of workspace.projects) {
        if (!project.source || project.environmentType === "ssh") continue;
        const session = sessionByContext.get(`${project.id}:project`);
        contexts.push({
          key: `project:${project.id}`,
          source: project.source,
          projectKey: project.id,
          projectName: project.name,
          branch: session?.branch ?? null,
          title: project.name,
          freshness: "live",
          projectId: project.id,
        });
        for (const worktree of workspace.worktrees.filter((item) => item.projectId === project.id && item.status === "active")) {
          const worktreeSession = sessionByContext.get(`${project.id}:${worktree.id}`);
          contexts.push({
            key: `worktree:${worktree.id}`,
            source: project.source,
            projectKey: project.id,
            projectName: worktree.name,
            branch: worktree.branch,
            title: worktree.name,
            freshness: "live",
            projectId: project.id,
            worktreeId: worktree.id,
          });
        }
      }
      return contexts;
    }
    const contexts = new Map<string, ProjectContext>();
    for (const session of history) {
      if (!session.projectId) continue;
      const key = `${session.projectId}:${session.worktreeId ?? "project"}`;
      if (contexts.has(key)) continue;
      contexts.set(key, {
        key: session.worktreeId ? `worktree:${session.worktreeId}` : `project:${session.projectId}`,
        source: session.source,
        projectKey: session.projectKey,
        projectName: session.projectKey,
        branch: session.branch,
        title: session.title,
        freshness: session.freshness,
        projectId: session.projectId,
        worktreeId: session.worktreeId ?? undefined,
      });
    }
    return Array.from(contexts.values());
  }, [history, workspace]);
  // The project tree owns the active context. Selecting history synchronizes this key,
  // so a stale session must not silently replace or invalidate the tree selection.
  const selectedProjectContext = projectContexts.find((item) => item.key === selectedProjectContextKey);
  const currentDraftKey = useMemo(
    () => `${user?.id ?? "anonymous"}:${draftKey(selectedDeviceId, selectedProjectContext?.key, selectedSessionId)}`,
    [user?.id, selectedDeviceId, selectedProjectContext?.key, selectedSessionId],
  );

  useEffect(() => {
    if (selectedProjectContextKey && projectContexts.some((item) => item.key === selectedProjectContextKey)) return;
    const key = projectContexts[0]?.key;
    selectedProjectContextKeyRef.current = key;
    setSelectedProjectContextKey(key);
  }, [projectContexts, selectedProjectContextKey]);

  const expireSession = useCallback(() => {
    detachTerminal();
    setAuthPhase("expired");
    setUser(null);
    setSocketState("closed");
  }, [detachTerminal]);

  const handleError = useCallback((caught: unknown) => {
    if (caught instanceof ApiError && caught.status === 401) {
      expireSession();
      return true;
    }
    setError(requestErrorCode(caught));
    return false;
  }, [expireSession]);

  const historyRefresh = useMemo(() => createHistoryRefresh(async (deviceId, signal) => {
    try {
      const [result, conversations] = await Promise.all([webClient.history(deviceId, 50, 0, signal), webClient.conversations(deviceId, signal)]);
      if (signal.aborted || selectedDeviceRef.current !== deviceId) return;
      const sessions = new Map(result.items.map((session) => [session.sessionId, session]));
      for (const session of conversations.sessions) sessions.set(session.sessionId, session);
      setHistory([...sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt));
      setWorkspace(result.workspace);
      if (result.workspace?.terminals) {
        const inventory = result.workspace.terminals;
        const ids = new Set(inventory.map((item) => item.sessionId));
        for (const [id, owner] of pendingCloseRef.current) {
          if (owner === deviceId && !ids.has(id)) pendingCloseRef.current.delete(id);
        }
        for (const tab of terminalTabsRef.current) {
          if (!ids.has(tab.sessionId)) {
            socketRef.current?.sendTerminal(deviceId, { type: "detach", sessionId: tab.sessionId });
            terminalStream.clear(tab.sessionId);
          }
        }
        const previous = new Map(terminalTabsRef.current.map((tab) => [tab.sessionId, tab]));
        const tabs = inventory.filter((item) => !pendingCloseRef.current.has(item.sessionId)).map((item) => {
          const contextKey = item.worktreeId ? `worktree:${item.worktreeId}` : `project:${item.projectId}`;
          const existing = previous.get(item.sessionId);
          if (!existing) {
            terminalStream.start(item.sessionId);
            socketRef.current?.sendTerminal(deviceId, { type: "attach", sessionId: item.sessionId });
          }
          return existing ?? { sessionId: item.sessionId, contextKey, status: "connecting", controlMode: "desktop" as const };
        });
        terminalTabsRef.current = tabs;
        setTerminalTabs(tabs);
        if (!tabs.some((tab) => tab.sessionId === terminalSessionRef.current)) {
          const next = tabs[0];
          terminalSessionRef.current = next?.sessionId;
          setTerminalSessionId(next?.sessionId);
          if (next) {
            selectedProjectContextKeyRef.current = next.contextKey;
            setSelectedProjectContextKey(next.contextKey);
          } else setTerminalStatus("idle");
        }
      }
      const saved = sessionStorage.getItem(`cli-manager.web.selected:${deviceId}`);
      const restored = saved ? sessions.get(saved) : undefined;
      if (saved && !restored) sessionStorage.removeItem(`cli-manager.web.selected:${deviceId}`);
      const availableSessionIds = new Set(sessions.keys());
      setSelectedSessionId((current) => validSelectedSessionId(availableSessionIds, current, saved ?? undefined));
      if (restored) {
        if (restored.projectId) setSelectedProjectContextKey((current) => current ?? (restored.worktreeId ? `worktree:${restored.worktreeId}` : `project:${restored.projectId}`));
      }
    } catch (caught) {
      if (!signal.aborted) handleError(caught);
    }
  }), [handleError, terminalStream]);
  const loadHistory = historyRefresh.refresh;
  useEffect(() => () => historyRefresh.cancel(), [historyRefresh, authPhase]);

  const loadWorkspace = useCallback(async () => {
    setLoadState("loading");
    setError("");
    try {
      const result = await webClient.devices();
      setDevices(result.devices);
      const selected = result.devices.find((item) => item.id === selectedDeviceRef.current) ?? result.devices[0];
      selectedDeviceRef.current = selected?.id;
      setSelectedDeviceId(selected?.id);
      if (selected) await loadHistory(selected.id);
      setLoadState("ready");
    } catch (caught) {
      if (!handleError(caught)) setLoadState("error");
    }
  }, [handleError, loadHistory]);

  const checkAuth = useCallback(async () => {
    setAuthPhase("checking");
    setError("");
    try {
      const result = await webClient.authStatus();
      setUser(result.user);
      setDeviceScope(result.deviceScope ?? null);
      setAuthPhase(result.authenticated ? "authenticated" : "login");
    } catch (caught) {
      setError(requestErrorCode(caught));
      setAuthPhase("error");
    }
  }, []);

  useEffect(() => { if (!mobileToken) void checkAuth(); }, [checkAuth, mobileToken]);
  useEffect(() => {
    if (authPhase === "authenticated") void loadWorkspace();
  }, [authPhase, loadWorkspace]);

  useEffect(() => {
    if (authPhase !== "authenticated" || !user) return;
    const currentSequenceKey = sequenceKey(user.id);
    sequenceRef.current = Number(sessionStorage.getItem(currentSequenceKey) ?? 0);
    let replayHighWater = 0;
    const connection = connectBrowserSocket({
      afterSequence: () => sequenceRef.current,
      onState: (state) => {
        setSocketState(state);
        if (state !== "open" && terminalTabsRef.current.length) {
          const nextTabs = terminalTabsRef.current.map((tab) => ({ ...tab, status: "connecting" }));
          terminalTabsRef.current = nextTabs;
          setTerminalTabs(nextTabs);
          setTerminalStatus("connecting");
        }
      },
      onUnauthorized: expireSession,
      onMessage: (message) => {
        const selectedDeviceId = selectedDeviceRef.current;
        const selectedSessionId = selectedSessionRef.current;
        if (message.type === "error") {
          if (message.code === "unauthorized") expireSession();
          else setError(message.code);
          return;
        }
        if (message.type === "ready") {
          replayHighWater = message.latestSequence;
          if (selectedDeviceId) void loadHistory(selectedDeviceId);
          if (message.latestSequence < sequenceRef.current) {
            sequenceRef.current = message.latestSequence;
            sessionStorage.setItem(currentSequenceKey, String(message.latestSequence));
          }
          if (selectedDeviceId) {
            for (const tab of terminalTabsRef.current) {
              connection.sendTerminal(selectedDeviceId, {
                type: "attach",
                sessionId: tab.sessionId,
                afterSequence: terminalStream.renderedSequence(tab.sessionId),
              });
            }
          }
          for (const [sessionId, deviceId] of pendingCloseRef.current) {
            connection.sendTerminal(deviceId, { type: "close", sessionId });
          }
          return;
        }
        if (message.type === "terminal_output") {
          if (message.deviceId === selectedDeviceId && terminalTabsRef.current.some((tab) => tab.sessionId === message.sessionId)) {
            terminalStream.publish(message.sessionId, {
              sequence: message.sequence,
              frames: message.frames,
            });
          }
          return;
        }
        if (message.type === "terminal_status") {
          // A process exit may precede the authoritative window inventory.
          // Keep pending closes until that inventory confirms removal.
          if (message.deviceId === selectedDeviceId && terminalTabsRef.current.some((tab) => tab.sessionId === message.sessionId)) {
            const nextTabs = terminalTabsRef.current.map((tab) => tab.sessionId === message.sessionId ? {
              ...tab,
              status: tab.status === "error" && message.status === "running" ? tab.status : message.status,
              controlMode: message.controlMode ?? tab.controlMode,
            } : tab);
            terminalTabsRef.current = nextTabs;
            setTerminalTabs(nextTabs);
          }
          if (message.deviceId === selectedDeviceId && message.sessionId === terminalSessionRef.current) {
            setTerminalStatus((current) => current === "error" && message.status === "running" ? current : message.status);
            if (message.controlMode) setTerminalControlMode(message.controlMode);
          }
          return;
        }
        if (message.sequence <= sequenceRef.current) return;
        const payload = message.payload;
        if (payload.type === "device.updated") {
          setDevices((current) => {
            const found = current.some((device) => device.id === payload.device.id);
            return found
              ? current.map((device) => device.id === payload.device.id ? payload.device : device)
              : [...current, payload.device];
          });
          // Browser and device reconnect independently. Retry attach when the
          // device comes back after browser ready, never for replayed presence.
          if (message.sequence > replayHighWater && payload.device.id === selectedDeviceId) {
            if (terminalTabsRef.current.length && payload.device.status === "online") {
              const nextTabs = terminalTabsRef.current.map((tab) => ({ ...tab, status: "connecting" }));
              terminalTabsRef.current = nextTabs;
              setTerminalTabs(nextTabs);
              setTerminalStatus("connecting");
              for (const tab of nextTabs) {
                connection.sendTerminal(payload.device.id, {
                  type: "attach",
                  sessionId: tab.sessionId,
                  afterSequence: terminalStream.renderedSequence(tab.sessionId),
                });
              }
            }
          }
          if (message.sequence > replayHighWater && payload.device.status === "online") {
            for (const [sessionId, deviceId] of pendingCloseRef.current) {
              if (deviceId === payload.device.id) connection.sendTerminal(deviceId, { type: "close", sessionId });
            }
          }
        } else if (payload.type === "operation.updated" && payload.operation.deviceId === selectedDeviceId) {
          if (message.sequence > replayHighWater) attachFromOperation(payload.operation);
          if (payload.operation.kind === "project.start"
            && payload.operation.id === terminalLaunchOperationRef.current
            && OPERATION_STATUS_RANK[payload.operation.status] === 4) {
            terminalLaunchOperationRef.current = undefined;
            terminalLaunchingRef.current = false;
            setSending(false);
            if (payload.operation.status !== "succeeded") setTerminalStatus("error");
          }
          if (payload.operation.idempotencyKey === pendingRequestRef.current?.id) activeOperationRef.current = payload.operation.id;
          const historyImport = payload.operation.kind === "conversation.history" && typeof payload.operation.payload === "object" && payload.operation.payload !== null && !Array.isArray(payload.operation.payload) && payload.operation.payload.sessionId === selectedSessionId;
          if (!payload.operation.kind.startsWith("conversation.") || payload.operation.id === activeOperationRef.current || historyImport) {
            setTimeline((current) => upsertOperation(current, payload.operation));
          }
          if ((payload.operation.id === activeOperationRef.current || historyImport) && OPERATION_STATUS_RANK[payload.operation.status] === 4) {
            sendingRef.current = false; setSending(false);
          }
        } else if (payload.type === "conversation.updated" && payload.deviceId === selectedDeviceId) {
          const event = payload.event;
          earlyEventsRef.current = mergeConversationEvents(earlyEventsRef.current, [event]).slice(-2000);
          setConversationEvents((current) => ({ ...current, [event.sessionId]: mergeConversationEvents(current[event.sessionId] ?? [], [event]) }));
          if (event.operationId === activeOperationRef.current) {
            const sessionId = establishedSessionId([event]);
            if (sessionId) setSelectedSessionId(sessionId);
            if (event.kind === "user_message") setTimeline((current) => current.filter((item) => item.type !== "prompt"));
            if (event.kind === "turn_completed" || event.kind === "turn_failed") {
              sendingRef.current = false; setSending(false);
              void loadHistory(payload.deviceId);
            }
          }
        } else if (payload.type === "history.updated" && payload.deviceId === selectedDeviceId) {
          void loadHistory(payload.deviceId);
        }
        sequenceRef.current = message.sequence;
        sessionStorage.setItem(currentSequenceKey, String(message.sequence));
      },
    });
    socketRef.current = connection;
    return () => { if (socketRef.current === connection) socketRef.current = null; connection.close(); };
  }, [attachFromOperation, authPhase, expireSession, loadHistory, terminalStream, user]);

  const loadConversation = useCallback(async (deviceId: string, sessionId: string) => {
    const generation = viewGenerationRef.current;
    setDetailState("loading");
    try {
      const result = await webClient.conversation(deviceId, sessionId);
      if (selectedDeviceRef.current !== deviceId) return;
      setConversationEvents((current) => ({ ...current, [sessionId]: mergeConversationEvents(current[sessionId] ?? [], result.events) }));
      const session = historyRef.current.find((item) => item.sessionId === sessionId);
      const importKey = `${deviceId}:${sessionId}`;
      if (!result.events.length && session?.projectId && !historyImportsRef.current.has(importKey) && generation === viewGenerationRef.current) {
        historyImportsRef.current.add(importKey);
        sendingRef.current = true; setSending(true);
        try {
          const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(importKey));
          const idempotencyKey = `history-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
          const payload: JsonObject = { source: session.source, projectId: session.projectId, sessionId };
          if (session.worktreeId) payload.worktreeId = session.worktreeId;
          const imported = await webClient.createOperation({ deviceId, kind: "conversation.history", idempotencyKey, payload });
          if (generation === viewGenerationRef.current) setTimeline((current) => upsertOperation(current, imported.operation));
          if (generation === viewGenerationRef.current && OPERATION_STATUS_RANK[imported.operation.status] === 4) { sendingRef.current = false; setSending(false); }
        } catch (caught) {
          if (generation === viewGenerationRef.current) { sendingRef.current = false; setSending(false); }
          historyImportsRef.current.delete(importKey);
          throw caught;
        }
      }
      if (generation === viewGenerationRef.current) setDetailState("ready");
    } catch (caught) {
      if (generation === viewGenerationRef.current && !handleError(caught)) setDetailState("error");
    }
  }, [handleError]);

  useEffect(() => {
    setDraft(localStorage.getItem(currentDraftKey) ?? "");
    setComposerMessage("");
  }, [currentDraftKey]);

  useEffect(() => {
    if (selectedDeviceId && selectedSessionId) sessionStorage.setItem(`cli-manager.web.selected:${selectedDeviceId}`, selectedSessionId);
  }, [selectedDeviceId, selectedSessionId]);

  const login = async (username: string, password: string) => {
    setError("");
    try {
      const result = await webClient.login(username, password);
      setUser(result.user);
      setDeviceScope(result.deviceScope ?? null);
      setAuthPhase(result.authenticated ? "authenticated" : "login");
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "invalid_credentials") {
        setError(caught.code);
        setAuthPhase("login");
        return;
      }
      handleError(caught);
    }
  };

  const logout = async () => {
    detachTerminal();
    try { await webClient.logout(); } finally {
      setUser(null);
      setAuthPhase("login");
      setDevices([]);
      setHistory([]);
      setWorkspace(null);
      setSelectedProjectContextKey(undefined);
      setTimeline([]);
      setConversationEvents({});
      setSelectedSessionId(undefined); setSelectedDeviceId(undefined);
      pendingRequestRef.current = null; activeOperationRef.current = undefined;
      earlyEventsRef.current = []; sendingRef.current = false; setSending(false);
    }
  };

  const claimPairing = async (code: string) => {
    if (deviceScope) return;
    const input = code.trim();
    if (!input) return;
    setPairing({ status: "submitting", code: input });
    try {
      const result = await webClient.claimPairing(input);
      setDevices((current) => [...current.filter((item) => item.id !== result.device.id), result.device]);
      selectedDeviceRef.current = result.device.id;
      setSelectedDeviceId(result.device.id);
      setPairing({ status: "claimed", ...result });
      await loadHistory(result.device.id);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        expireSession();
        return;
      }
      const apiError = caught instanceof ApiError ? caught : null;
      setPairing({ status: "error", code: apiError?.code ?? "request_failed", message: caught instanceof Error ? caught.message : String(caught), input });
    }
  };

  const removeDevice = async (deviceId: string) => {
    if (deviceScope) return;
    await webClient.removeDevice(deviceId);
    setDevices((current) => current.filter((device) => device.id !== deviceId));
    if (selectedDeviceId === deviceId) {
      detachTerminal(deviceId);
      setSelectedDeviceId(undefined);
      setHistory([]);
      setWorkspace(null);
      setSelectedSessionId(undefined);
      setSelectedProjectContextKey(undefined);
      setTimeline([]);
    }
  };

  const selectDevice = (deviceId: string) => {
    if (deviceScope && deviceId !== deviceScope) return;
    detachTerminal(selectedDeviceRef.current);
    pendingRequestRef.current = null;
    viewGenerationRef.current++;
    setDetailState("idle");
    selectedDeviceRef.current = deviceId;
    activeOperationRef.current = undefined;
    sendingRef.current = false; setSending(false);
    setConversationEvents({});
    setSelectedDeviceId(deviceId);
    setHistory([]);
    setWorkspace(null);
    setSelectedSessionId(undefined);
    setSelectedProjectContextKey(undefined);
    setTimeline([]);
    void loadHistory(deviceId);
  };

  const selectSession = (sessionId?: string) => {
    pendingRequestRef.current = null;
    if (selectedDeviceId && !sessionId) sessionStorage.removeItem(`cli-manager.web.selected:${selectedDeviceId}`);
    viewGenerationRef.current++;
    setDetailState("idle");
    activeOperationRef.current = undefined;
    sendingRef.current = false; setSending(false);
    setSelectedSessionId(sessionId);
    const session = history.find((item) => item.sessionId === sessionId);
    if (session?.projectId) {
      const workspaceContext = projectContexts.find((context) => (
        context.projectId === session.projectId && context.worktreeId === (session.worktreeId ?? undefined)
      ));
      if (workspaceContext) setSelectedProjectContextKey(workspaceContext.key);
    }
    setTimeline([]);
  };

  const selectProjectContext = (key: string) => {
    pendingRequestRef.current = null;
    if (selectedDeviceId && key !== selectedProjectContextKey) sessionStorage.removeItem(`cli-manager.web.selected:${selectedDeviceId}`);
    viewGenerationRef.current++;
    setDetailState("idle");
    activeOperationRef.current = undefined;
    sendingRef.current = false; setSending(false);
    selectedProjectContextKeyRef.current = key;
    setSelectedProjectContextKey(key);
    if (key !== selectedProjectContextKey) setSelectedSessionId(undefined);
    const contextTab = terminalTabsRef.current.find((tab) => tab.contextKey === key);
    terminalSessionRef.current = contextTab?.sessionId;
    setTerminalSessionId(contextTab?.sessionId);
    if (!contextTab) {
      setTerminalStatus("idle");
      setTerminalControlMode("desktop");
    }
    if (selectedSession) {
      const context = projectContexts.find((item) => item.key === key);
      const sameContext = Boolean(context
        && context.source === selectedSession.source
        && context.projectId === selectedSession.projectId
        && context.worktreeId === (selectedSession.worktreeId ?? undefined));
      if (!sameContext) setSelectedSessionId(undefined);
    }
    setTimeline([]);
  };

  const selectTerminalTab = (sessionId: string) => {
    const tab = terminalTabsRef.current.find((item) => item.sessionId === sessionId);
    if (!tab) return;
    if (tab.contextKey !== selectedProjectContextKeyRef.current) {
      viewGenerationRef.current++;
      activeOperationRef.current = undefined;
      pendingRequestRef.current = null;
      setSelectedSessionId(undefined);
      setTimeline([]);
    }
    terminalSessionRef.current = sessionId;
    setTerminalSessionId(sessionId);
    selectedProjectContextKeyRef.current = tab.contextKey;
    setSelectedProjectContextKey(tab.contextKey);
  };

  const sendPrompt = async () => {
    if (sendingRef.current) return;
    const text = draft.trim();
    if (!user || !selectedDevice || selectedDevice.status !== "online" || !selectedProjectContext || !text) {
      if (!selectedProjectContext) setComposerMessage("project_context_required");
      return;
    }
    setComposerMessage("");
    const generation = viewGenerationRef.current;
    const signature = JSON.stringify([selectedDevice.id, selectedProjectContext.key, selectedSessionId, text]);
    const promptId = pendingRequestRef.current?.signature === signature ? pendingRequestRef.current.id : createRequestId();
    pendingRequestRef.current = { signature, id: promptId };
    sendingRef.current = true; setSending(true);
    setTimeline((current) => [...current, { id: promptId, type: "prompt", text, occurredAt: Date.now() }]);
    try {
      const payload: JsonObject = {
        prompt: text,
        source: selectedProjectContext.source,
        projectId: selectedProjectContext.projectId ?? "",
      };
      if (selectedProjectContext.worktreeId) payload.worktreeId = selectedProjectContext.worktreeId;
      if (selectedSessionId) {
        payload.sessionId = selectedSessionId;
      }
      const result = await webClient.createOperation({
        deviceId: selectedDevice.id,
        kind: selectedSessionId ? "conversation.prompt" : "conversation.start",
        idempotencyKey: promptId,
        payload,
      });
      if (generation !== viewGenerationRef.current) return;
      setTimeline((current) => upsertOperation(current, result.operation));
      activeOperationRef.current = result.operation.id;
      pendingRequestRef.current = null;
      const earlyEvents = earlyEventsRef.current.filter((event) => event.operationId === result.operation.id);
      const sessionId = establishedSessionId(earlyEvents);
      if (sessionId) {
        setSelectedSessionId(sessionId);
        if (earlyEvents.some((event) => event.kind === "user_message")) setTimeline((current) => current.filter((item) => item.type !== "prompt"));
      }
      if (OPERATION_STATUS_RANK[result.operation.status] === 4 || earlyEvents.some((event) => ["turn_completed", "turn_failed"].includes(event.kind))) {
        sendingRef.current = false; setSending(false);
      }
      setDraft("");
      localStorage.removeItem(currentDraftKey);
    } catch (caught) {
      if (generation !== viewGenerationRef.current) return;
      sendingRef.current = false; setSending(false);
      setTimeline((current) => current.filter((item) => item.id !== promptId));
      if (!handleError(caught)) setComposerMessage(requestErrorCode(caught));
    }
  };

  const submitManagementOperation = async (kind: string, payload: JsonObject): Promise<Operation> => {
    if (!selectedDevice || selectedDevice.status !== "online") {
      throw new ApiError("device_offline", "device is offline", 409);
    }
    const terminalLaunch = kind === "project.start";
    if (terminalLaunch && terminalLaunchingRef.current) {
      throw new ApiError("operation_in_progress", "terminal launch is already in progress", 409);
    }
    if (terminalLaunch) {
      terminalLaunchingRef.current = true;
      setSending(true);
      setTerminalStatus("connecting");
    }
    const idempotencyKey = createRequestId();
    const contextualPayload: JsonObject = { ...payload };
    if (!kind.startsWith("ssh.") && !kind.startsWith("hook.") && !kind.startsWith("project.")) {
      if (!selectedProjectContext) {
        throw new ApiError("project_context_required", "project context is required", 400);
      }
      contextualPayload.projectId = selectedProjectContext.projectId ?? "";
      if (selectedProjectContext.worktreeId) contextualPayload.worktreeId = selectedProjectContext.worktreeId;
    }
    try {
      const result = await webClient.createOperation({
        deviceId: selectedDevice.id,
        kind,
        idempotencyKey,
        payload: contextualPayload,
      });
      setTimeline((current) => upsertOperation(current, result.operation));
      attachFromOperation(result.operation);
      if (terminalLaunch) {
        if (OPERATION_STATUS_RANK[result.operation.status] === 4) {
          terminalLaunchingRef.current = false;
          setSending(false);
          if (result.operation.status !== "succeeded") setTerminalStatus("error");
        } else {
          terminalLaunchOperationRef.current = result.operation.id;
        }
      }
      return result.operation;
    } catch (caught) {
      if (terminalLaunch) {
        terminalLaunchingRef.current = false;
        terminalLaunchOperationRef.current = undefined;
        setSending(false);
        setTerminalStatus("error");
      }
      throw caught;
    }
  };

  const openTerminal = async () => {
    if (!selectedDevice || selectedDevice.status !== "online" || !selectedProjectContext) return;
    const existing = terminalTabsRef.current.find((tab) => tab.contextKey === selectedProjectContext.key);
    if (existing) { selectTerminalTab(existing.sessionId); return; }
    const payload: JsonObject = {
      targetType: selectedProjectContext.worktreeId ? "worktree" : "project",
      targetId: selectedProjectContext.worktreeId ?? selectedProjectContext.projectId ?? "",
      launchMode: "internal",
    };
    try {
      await submitManagementOperation("project.start", payload);
    } catch (caught) {
      handleError(caught);
    }
  };

  return {
    deviceScope, mobileToken, detailState, sending,
    redeemMobile: async (name: string) => {
      if (!mobileToken) return;
      const result = await webClient.redeemMobile(mobileToken, name);
      setMobileToken(null); setDeviceScope(result.deviceScope ?? null); setUser(result.user); setAuthPhase("authenticated");
    },
    cancelMobile: () => setMobileToken(null),
    authPhase, user, loadState, error, devices, selectedDevice, history, selectedSession,
    workspace, projectContexts, selectedProjectContext,
    terminalSessionId, terminalTabs,
    terminalStatus: terminalSessionId && socketState !== "open" ? "disconnected"
      : terminalSessionId && selectedDevice?.status !== "online" ? "offline"
        : terminalTabs.find((tab) => tab.sessionId === terminalSessionId)?.status ?? terminalStatus,
    terminalStream,
    terminalControlMode: terminalTabs.find((tab) => tab.sessionId === terminalSessionId)?.controlMode ?? terminalControlMode,
    timeline: visibleConversationTimeline(selectedSessionId ? conversationEvents[selectedSessionId] ?? [] : [], timeline), pairing, socketState, draft, composerMessage,
    latestSyncAt: serverTime(selectedDevice?.lastSeenAt),
    checkAuth, login, logout, loadWorkspace, claimPairing, removeDevice, setPairing,
    selectDevice, selectSession, selectProjectContext, selectTerminalTab,
    setDraft: (value: string) => { setDraft(value); localStorage.setItem(currentDraftKey, value); },
    sendPrompt, submitManagementOperation, openTerminal,
    closeTerminal,
    sendTerminalInput: (data: string, sessionId = terminalSessionRef.current) => Boolean(selectedDeviceId && sessionId && socketRef.current?.sendTerminal(selectedDeviceId, { type: "input", sessionId, data })),
    resizeTerminal: (cols: number, rows: number, sessionId = terminalSessionRef.current) => Boolean(selectedDeviceId && sessionId && socketRef.current?.sendTerminal(selectedDeviceId, { type: "resize", sessionId, cols, rows })),
  };
}
