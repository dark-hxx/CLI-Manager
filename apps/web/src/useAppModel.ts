import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AuthUser,
  Device,
  HistorySessionSummary,
  JsonObject,
  LoadState,
  Operation,
  PairingState,
  ProjectContext,
  TimelineItem,
} from "./domain";
import { ApiError, connectBrowserSocket, webClient } from "./webClient";

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

function draftKey(deviceId: string | undefined, projectKey: string | undefined, sessionId: string | undefined) {
  return `${DRAFT_PREFIX}:${deviceId ?? "none"}:${projectKey ?? "none"}:${sessionId ?? "new"}`;
}

function sequenceKey(userId: string) {
  return `${SEQUENCE_PREFIX}:${userId}`;
}

function projectContextKey(source: string, projectKey: string, cwd: string) {
  return `${source}:${projectKey}:${cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()}`;
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
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [error, setError] = useState("");
  const [devices, setDevices] = useState<Device[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>();
  const [history, setHistory] = useState<HistorySessionSummary[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>();
  const [selectedProjectContextKey, setSelectedProjectContextKey] = useState<string>();
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [pairing, setPairing] = useState<PairingState>({ status: "idle" });
  const [socketState, setSocketState] = useState<"connecting" | "open" | "closed">("closed");
  const [draft, setDraft] = useState("");
  const [composerMessage, setComposerMessage] = useState("");
  const sequenceRef = useRef(0);

  const selectedDevice = devices.find((item) => item.id === selectedDeviceId);
  const selectedSession = history.find((item) => item.sessionId === selectedSessionId);
  const projectContexts = useMemo<ProjectContext[]>(() => {
    const contexts = new Map<string, ProjectContext>();
    for (const session of history) {
      const cwd = session.cwd?.trim();
      if (!cwd) continue;
      const key = projectContextKey(session.source, session.projectKey, cwd);
      if (contexts.has(key)) continue;
      contexts.set(key, {
        key,
        source: session.source,
        projectKey: session.projectKey,
        cwd,
        branch: session.branch,
        title: session.title,
        freshness: session.freshness,
      });
    }
    return Array.from(contexts.values());
  }, [history]);
  const selectedProjectContext = projectContexts.find((item) => item.key === selectedProjectContextKey);
  const currentDraftKey = useMemo(
    () => draftKey(selectedDeviceId, selectedProjectContext?.projectKey, selectedSessionId),
    [selectedDeviceId, selectedProjectContext?.projectKey, selectedSessionId],
  );

  useEffect(() => {
    if (selectedProjectContextKey && projectContexts.some((item) => item.key === selectedProjectContextKey)) return;
    setSelectedProjectContextKey(projectContexts[0]?.key);
  }, [projectContexts, selectedProjectContextKey]);

  const expireSession = useCallback(() => {
    setAuthPhase("expired");
    setUser(null);
    setSocketState("closed");
  }, []);

  const handleError = useCallback((caught: unknown) => {
    if (caught instanceof ApiError && caught.status === 401) {
      expireSession();
      return true;
    }
    setError(requestErrorCode(caught));
    return false;
  }, [expireSession]);

  const loadHistory = useCallback(async (deviceId: string) => {
    try {
      const result = await webClient.history(deviceId);
      setHistory(result.items);
    } catch (caught) {
      handleError(caught);
    }
  }, [handleError]);

  const loadWorkspace = useCallback(async () => {
    setLoadState("loading");
    setError("");
    try {
      const result = await webClient.devices();
      setDevices(result.devices);
      const selected = result.devices.find((item) => item.id === selectedDeviceId) ?? result.devices[0];
      setSelectedDeviceId(selected?.id);
      if (selected) await loadHistory(selected.id);
      setLoadState("ready");
    } catch (caught) {
      if (!handleError(caught)) setLoadState("error");
    }
  }, [handleError, loadHistory, selectedDeviceId]);

  const checkAuth = useCallback(async () => {
    setAuthPhase("checking");
    setError("");
    try {
      const result = await webClient.authStatus();
      setUser(result.user);
      setAuthPhase(result.authenticated ? "authenticated" : "login");
    } catch (caught) {
      setError(requestErrorCode(caught));
      setAuthPhase("error");
    }
  }, []);

  useEffect(() => { void checkAuth(); }, [checkAuth]);
  useEffect(() => {
    if (authPhase === "authenticated") void loadWorkspace();
  }, [authPhase, loadWorkspace]);

  useEffect(() => {
    if (authPhase !== "authenticated" || !user) return;
    const currentSequenceKey = sequenceKey(user.id);
    sequenceRef.current = Number(localStorage.getItem(currentSequenceKey) ?? 0);
    return connectBrowserSocket({
      afterSequence: () => sequenceRef.current,
      onState: setSocketState,
      onUnauthorized: expireSession,
      onMessage: (message) => {
        if (message.type === "error") {
          if (message.code === "unauthorized") expireSession();
          else setError(message.code);
          return;
        }
        if (message.type === "ready") {
          if (message.latestSequence < sequenceRef.current) {
            sequenceRef.current = message.latestSequence;
            localStorage.setItem(currentSequenceKey, String(message.latestSequence));
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
        } else if (payload.type === "operation.updated" && payload.operation.deviceId === selectedDeviceId) {
          setTimeline((current) => upsertOperation(current, payload.operation));
        } else if (payload.type === "history.updated" && payload.deviceId === selectedDeviceId) {
          void loadHistory(payload.deviceId);
        }
        sequenceRef.current = message.sequence;
        localStorage.setItem(currentSequenceKey, String(message.sequence));
      },
    });
  }, [authPhase, expireSession, loadHistory, selectedDeviceId, user]);

  useEffect(() => {
    setDraft(localStorage.getItem(currentDraftKey) ?? "");
    setComposerMessage("");
  }, [currentDraftKey]);

  useEffect(() => {
    localStorage.setItem(currentDraftKey, draft);
  }, [currentDraftKey, draft]);

  const login = async (username: string, password: string) => {
    setError("");
    try {
      const result = await webClient.login(username, password);
      setUser(result.user);
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
    try { await webClient.logout(); } finally {
      setUser(null);
      setAuthPhase("login");
      setDevices([]);
      setHistory([]);
      setSelectedProjectContextKey(undefined);
      setTimeline([]);
    }
  };

  const claimPairing = async (code: string) => {
    const input = code.trim();
    if (!input) return;
    setPairing({ status: "submitting", code: input });
    try {
      const result = await webClient.claimPairing(input);
      setDevices((current) => [...current.filter((item) => item.id !== result.device.id), result.device]);
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

  const selectDevice = (deviceId: string) => {
    setSelectedDeviceId(deviceId);
    setSelectedSessionId(undefined);
    setSelectedProjectContextKey(undefined);
    setTimeline([]);
    void loadHistory(deviceId);
  };

  const selectSession = (sessionId?: string) => {
    setSelectedSessionId(sessionId);
    const session = history.find((item) => item.sessionId === sessionId);
    const cwd = session?.cwd?.trim();
    if (session && cwd) {
      setSelectedProjectContextKey(projectContextKey(session.source, session.projectKey, cwd));
    }
    setTimeline([]);
  };

  const selectProjectContext = (key: string) => {
    setSelectedProjectContextKey(key);
    if (selectedSession) {
      const cwd = selectedSession.cwd?.trim();
      const sessionKey = cwd
        ? projectContextKey(selectedSession.source, selectedSession.projectKey, cwd)
        : "";
      if (sessionKey !== key) setSelectedSessionId(undefined);
    }
    setTimeline([]);
  };

  const sendPrompt = async () => {
    const text = draft.trim();
    if (!user || !selectedDevice || selectedDevice.status !== "online" || !selectedProjectContext || !text) {
      if (!selectedProjectContext) setComposerMessage("project_context_required");
      return;
    }
    setComposerMessage("");
    const promptId = crypto.randomUUID();
    setTimeline((current) => [...current, { id: promptId, type: "prompt", text, occurredAt: Date.now() }]);
    try {
      const payload: JsonObject = {
        prompt: text,
        source: selectedProjectContext.source,
        projectKey: selectedProjectContext.projectKey,
        cwd: selectedProjectContext.cwd,
      };
      if (selectedSession) {
        payload.sessionId = selectedSession.sessionId;
      }
      const result = await webClient.createOperation({
        deviceId: selectedDevice.id,
        kind: selectedSession ? "conversation.prompt" : "conversation.start",
        idempotencyKey: promptId,
        payload,
      });
      setTimeline((current) => upsertOperation(current, result.operation));
      setDraft("");
      localStorage.removeItem(currentDraftKey);
    } catch (caught) {
      setTimeline((current) => current.filter((item) => item.id !== promptId));
      if (!handleError(caught)) setComposerMessage(requestErrorCode(caught));
    }
  };

  const submitManagementOperation = async (kind: string, payload: JsonObject): Promise<Operation> => {
    if (!selectedDevice || selectedDevice.status !== "online") {
      throw new ApiError("device_offline", "device is offline", 409);
    }
    const idempotencyKey = crypto.randomUUID();
    const contextualPayload: JsonObject = { ...payload };
    if (!kind.startsWith("ssh.") && !kind.startsWith("hook.")) {
      if (!selectedProjectContext) {
        throw new ApiError("project_context_required", "project context is required", 400);
      }
      contextualPayload.projectKey = selectedProjectContext.projectKey;
      contextualPayload.cwd = selectedProjectContext.cwd;
    }
    const result = await webClient.createOperation({
      deviceId: selectedDevice.id,
      kind,
      idempotencyKey,
      payload: contextualPayload,
    });
    setTimeline((current) => upsertOperation(current, result.operation));
    return result.operation;
  };

  return {
    authPhase, user, loadState, error, devices, selectedDevice, history, selectedSession,
    projectContexts, selectedProjectContext,
    timeline, pairing, socketState, draft, composerMessage,
    latestSyncAt: serverTime(selectedDevice?.lastSeenAt),
    checkAuth, login, logout, loadWorkspace, claimPairing, setPairing,
    selectDevice, selectSession, selectProjectContext, setDraft, sendPrompt, submitManagementOperation,
  };
}
