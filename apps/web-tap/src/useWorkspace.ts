import { useCallback, useEffect, useRef, useState } from "react";
import {
  api, ApiError, connectBrowserSocket, createTerminalStream,
  type AuthUser, type Device, type WorkspaceSnapshot, type JsonObject, type BrowserSocketConnection,
  type TerminalControlMode, type WorkspaceProject,
} from "./protocol";
import { createOperationRunner } from "./operations";
import { createTranscriptSignals } from "./transcriptSignals";

export type TerminalState = { status: string; controlMode: TerminalControlMode; cols?: number; rows?: number };
const EMPTY: WorkspaceSnapshot = { groups: [], projects: [], worktrees: [], terminals: [], updatedAt: 0 };

/** Scrub a single-use authorization from browser history before any network request. */
function takeMobileToken(): string | null {
  const token = new URLSearchParams(location.hash.slice(1)).get("mobileToken")
    ?? new URLSearchParams(location.search).get("mobileToken");
  if (token) history.replaceState(null, "", "/tap/");
  return token;
}

/** Links identify a session only; the authenticated inventory must authorize it. */
function linkedSession(): string | undefined {
  try {
    const match = /(?:#\/s\/|\/tap\/s\/)([^/?#]+)/.exec(location.href);
    const id = match ? decodeURIComponent(match[1]!) : "";
    return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id) ? id : undefined;
  } catch { return undefined; }
}

/** One authenticated scope owns its socket, operation flights and terminal subscriptions. */
export function useWorkspace() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [checking, setChecking] = useState(true);
  const [authError, setAuthError] = useState("");
  const [mobileToken, setMobileToken] = useState<string | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [deviceId, setDeviceId] = useState<string>();
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot>(EMPTY);
  const [activeId, setActiveId] = useState<string>();
  const [mounted, setMounted] = useState<string[]>([]);
  const [states, setStates] = useState<Record<string, TerminalState>>({});
  const [link, setLink] = useState<"connecting" | "open" | "closed">("closed");
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const [stream] = useState(createTerminalStream);
  const [transcripts] = useState(createTranscriptSignals);
  const [runner] = useState(() => createOperationRunner(api));
  const [socketVersion, setSocketVersion] = useState(0);
  const [requestedSession, setRequestedSession] = useState(linkedSession);
  const restoredScope = useRef("");
  const socket = useRef<BrowserSocketConnection | null>(null);
  const scope = useRef({ deviceId, user, mounted, activeId, link });
  scope.current = { deviceId, user, mounted, activeId, link };
  const refreshRef = useRef(() => {});
  const sequence = useRef(0);
  const startingRef = useRef(false);
  const account = useRef<string | null>(null);
  const accountDeviceScope = useRef<string | null>(null);
  const authGeneration = useRef(0);
  const generation = authGeneration.current;
  // Delayed callbacks retain their originating authority; never reinterpret them on a new device.
  const ownsScope = () => Boolean(user && deviceId && generation === authGeneration.current
    && deviceId === scope.current.deviceId && user.id === scope.current.user?.id);

  const expire = useCallback(() => {
    runner.cancel(); socket.current?.close(); stream.clear();
    sequence.current = 0;
    account.current = null; authGeneration.current++;
    accountDeviceScope.current = null;
    setUser(null); setDevices([]); setDeviceId(undefined); setWorkspace(EMPTY);
    setMounted([]); setActiveId(undefined); setStates({}); setError(""); setAuthError("authExpired");
  }, [runner, stream]);

  const loadDevices = useCallback(async (scopeId?: string | null) => {
    const requestedAccount = account.current;
    const requestedGeneration = authGeneration.current;
    if (scopeId !== undefined) accountDeviceScope.current = scopeId;
    const requestedScope = accountDeviceScope.current;
    const { devices: available } = await api.devices();
    if (account.current !== requestedAccount || requestedAccount === null || requestedGeneration !== authGeneration.current) return;
    const owned = requestedScope ? available.filter((device) => device.id === requestedScope) : available;
    setDevices(owned);
    setDeviceId((current) => owned.some((device) => device.id === current) ? current : owned[0]?.id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const generation = authGeneration.current;
    const authenticate = async () => {
      try {
        const token = takeMobileToken();
        if (token) setMobileToken(token);
        const result = await api.auth();
        if (cancelled || generation !== authGeneration.current) return;
        if (result.authenticated && result.user) {
          account.current = result.user.id;
          setUser(result.user);
          await loadDevices(result.deviceScope ?? null);
        }
      } catch { if (!cancelled) setAuthError("loginError"); }
      finally { if (!cancelled) setChecking(false); }
    };
    void authenticate();
    return () => { cancelled = true; };
  }, [loadDevices]);

  const login = async (username: string, password: string) => {
    const generation = ++authGeneration.current;
    setChecking(true); setAuthError("");
    try {
      const result = await api.login(username, password);
      if (generation !== authGeneration.current) return;
      if (!result.user) throw new Error("loginError");
      account.current = result.user.id;
      setUser(result.user); await loadDevices(result.deviceScope ?? null);
    } catch { setAuthError("loginError"); }
    finally { setChecking(false); }
  };
  const redeemMobile = async () => {
    if (!mobileToken) return;
    const generation = ++authGeneration.current;
    setChecking(true); setAuthError("");
    try {
      const result = await api.redeem(mobileToken);
      if (generation !== authGeneration.current || !result.user) return;
      runner.cancel(); socket.current?.close(); stream.clear();
      sequence.current = 0;
      setMounted([]); setActiveId(undefined); setStates({}); setLink("closed"); setDeviceId(undefined); setWorkspace(EMPTY);
      account.current = result.user.id; setUser(result.user);
      await loadDevices(result.deviceScope ?? null); setMobileToken(null);
    } catch { setAuthError("loginError"); }
    finally { setChecking(false); }
  };
  const logout = async () => {
    try { await api.logout(); expire(); setAuthError(""); }
    catch { setError("request_failed"); }
  };
  const cancelMobile = () => {
    if (checking) return;
    setMobileToken(null);
    // The authorization screen unmounts xterm; its old cursor cannot restore an empty renderer.
    setSocketVersion((value) => value + 1);
  };

  useEffect(() => {
    restoredScope.current = "";
    runner.cancel(); stream.clear(); setMounted([]); setActiveId(undefined); setStates({});
    setWorkspace(EMPTY); setError("");
    if (!user || !deviceId) return;
    let disposed = false;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let refreshFlight: AbortController | undefined;
    let again = false;
    let highWater = 0;
    let deviceRefreshVersion = 0;
    let pendingDeviceUpdates = new Set<string>();
    const ownsDeviceRefresh = () => !disposed && generation === authGeneration.current
      && user.id === account.current && deviceId === scope.current.deviceId;
    const refreshDevices = async () => {
      const version = ++deviceRefreshVersion;
      const updated = pendingDeviceUpdates = new Set<string>();
      try {
        const result = await api.devices();
        if (!ownsDeviceRefresh() || version !== deviceRefreshVersion) return;
        // The endpoint authorizes the inventory; also retain the explicit mobile-session scope.
        const available = result.devices.filter((device) => !accountDeviceScope.current || device.id === accountDeviceScope.current);
        setDevices((old) => {
          const next = new Map(old.map((device) => [device.id, device]));
          for (const device of available) {
            if (!updated.has(device.id) || !next.has(device.id)) next.set(device.id, device);
          }
          return [...next.values()];
        });
      } catch (caught) {
        if (!ownsDeviceRefresh() || version !== deviceRefreshVersion) return;
        if (caught instanceof ApiError && caught.status === 401) expire();
        else setError("request_failed");
      }
    };
    const refresh = () => {
      if (disposed) return;
      if (refreshFlight) { again = true; return; }
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(async () => {
        refreshFlight = new AbortController();
        try {
          const result = await api.workspace(deviceId, refreshFlight.signal);
          if (!disposed) setWorkspace((old) => result.workspace && result.workspace.updatedAt >= old.updatedAt ? result.workspace : old);
        } catch (caught) {
          // Aborting a response body can still surface its 401 headers; only its owning scope may expire.
          if (disposed) return;
          if (caught instanceof ApiError && caught.status === 401) expire();
          else setError("request_failed");
        } finally {
          refreshFlight = undefined;
          if (again) { again = false; refresh(); }
        }
      }, 150);
    };
    refreshRef.current = refresh;
    refresh();
    const connection = connectBrowserSocket({
      transcriptChanges: true,
      afterSequence: () => sequence.current,
      onUnauthorized: expire,
      onState: (state) => { if (state !== "open") setLink(state); },
      onMessage: (message) => {
        if (disposed) return;
        if (message.type === "ready") {
          highWater = message.latestSequence;
          setLink("open"); refresh();
          transcripts.publish();
          void refreshDevices();
          if (sequence.current > message.latestSequence) sequence.current = message.latestSequence;
          for (const id of scope.current.mounted) connection.sendTerminal(deviceId, {
            type: "attach", sessionId: id, afterSequence: stream.renderedSequence(id),
          });
        } else if (message.type === "transcript_changed" && message.deviceId === deviceId) {
          transcripts.publish(message.sessionId);
        } else if (message.type === "terminal_output" && message.deviceId === deviceId) {
          stream.publish(message.sessionId, { sequence: message.sequence, frames: message.frames });
        } else if (message.type === "terminal_status" && message.deviceId === deviceId) {
          setStates((current) => ({ ...current, [message.sessionId]: {
            status: message.status, controlMode: message.controlMode ?? current[message.sessionId]?.controlMode ?? "desktop",
            cols: message.cols ?? current[message.sessionId]?.cols, rows: message.rows ?? current[message.sessionId]?.rows,
          } }));
        } else if (message.type === "event") {
          if (message.sequence <= sequence.current) return;
          sequence.current = message.sequence;
          const payload = message.payload;
          if (payload.type === "operation.updated") runner.publish(payload.operation);
          if (payload.type === "workspace.updated" && payload.deviceId === deviceId && message.sequence > highWater)
            setWorkspace((old) => payload.workspace.updatedAt >= old.updatedAt ? payload.workspace : old);
          if (payload.type === "history.updated" && payload.deviceId === deviceId) refresh();
          if (payload.type === "device.updated" && message.sequence > highWater
            && (!accountDeviceScope.current || payload.device.id === accountDeviceScope.current)) {
            pendingDeviceUpdates.add(payload.device.id);
            setDevices((old) => old.some((item) => item.id === payload.device.id)
              ? old.map((item) => item.id === payload.device.id ? payload.device : item) : [...old, payload.device]);
          }
        } else if (message.type === "error") {
          if (message.code === "unauthorized") expire(); else setError(message.code);
        }
      },
    });
    socket.current = connection;
    return () => {
      disposed = true; clearTimeout(refreshTimer); refreshFlight?.abort();
      connection.close(); runner.cancel(); stream.clear();
      if (socket.current === connection) socket.current = null;
    };
  }, [user?.id, deviceId, socketVersion, expire, runner, stream, transcripts]);

  const attach = useCallback((id: string) => {
    const current = scope.current;
    if (!current.deviceId) return;
    const next = [...current.mounted.filter((key) => key !== id), id].slice(-3);
    for (const evicted of current.mounted.filter((key) => !next.includes(key))) {
      socket.current?.sendTerminal(current.deviceId, { type: "detach", sessionId: evicted }); stream.clear(evicted);
    }
    if (!current.mounted.includes(id)) {
      stream.start(id);
      socket.current?.sendTerminal(current.deviceId, { type: "attach", sessionId: id });
      setStates((old) => ({ ...old, [id]: { status: "connecting", controlMode: "desktop" } }));
    }
    scope.current = { ...current, mounted: next, activeId: id };
    setMounted(next); setActiveId(id);
    setRequestedSession(id);
    const key = JSON.stringify(["cli-manager.tap.selected", current.user?.id, current.deviceId]);
    try { localStorage.setItem(key, id); } catch { /* Optional selection persistence. */ }
    history.replaceState(null, "", `/tap/#/s/${encodeURIComponent(id)}`);
    restoredScope.current = `${current.user?.id}:${current.deviceId}`;
  }, [stream]);

  useEffect(() => {
    const change = () => {
      const token = takeMobileToken();
      if (token) { setMobileToken(token); return; }
      restoredScope.current = ""; setRequestedSession(linkedSession());
    };
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  useEffect(() => {
    if (!user || !deviceId || !workspace.updatedAt) return;
    const selectedScope = `${user.id}:${deviceId}`;
    if (restoredScope.current === selectedScope) return;
    restoredScope.current = selectedScope;
    let saved: string | null = null;
    try { saved = localStorage.getItem(JSON.stringify(["cli-manager.tap.selected", user.id, deviceId])); } catch { /* Optional storage. */ }
    const known = workspace.terminals?.find((item) => item.sessionId === requestedSession)
      ?? workspace.terminals?.find((item) => item.sessionId === saved);
    if (known) attach(known.sessionId);
  }, [user?.id, deviceId, workspace.updatedAt, requestedSession, attach]);

  const run = useCallback(async (kind: string, payload: JsonObject) => {
    const selected = deviceId;
    if (!selected || generation !== authGeneration.current || selected !== scope.current.deviceId || user?.id !== scope.current.user?.id)
      throw new DOMException("scope changed", "AbortError");
    try { return await runner.run(selected, kind, payload); }
    catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) expire();
      throw caught;
    }
  }, [runner, expire, deviceId, user?.id, generation]);

  const start = async (project: WorkspaceProject, worktreeId?: string) => {
    if (startingRef.current) return;
    startingRef.current = true; setStarting(true); setError("");
    const selected = scope.current.deviceId;
    try {
      const result = await run("project.start", {
        targetType: worktreeId ? "worktree" : "project", targetId: worktreeId ?? project.id, launchMode: "internal",
      });
      if (scope.current.deviceId !== selected) return;
      if (result && typeof result === "object" && !Array.isArray(result) && Array.isArray(result.sessionIds)) {
        const id = result.sessionIds.find((value) => typeof value === "string");
        if (typeof id === "string") {
          setWorkspace((old) => ({ ...old, terminals: [...(old.terminals ?? []).filter((item) => item.sessionId !== id), {
            sessionId: id, projectId: project.id, worktreeId: worktreeId ?? null, title: project.name,
          }] }));
          attach(id); refreshRef.current();
        }
      }
    } catch (caught) { if (scope.current.deviceId === selected && !(caught instanceof DOMException && caught.name === "AbortError")) setError("unknownDelivery"); }
    finally { startingRef.current = false; setStarting(false); }
  };

  const input = (id: string, data: string) => {
    const current = scope.current;
    return Boolean(ownsScope() && current.link === "open" && current.deviceId && current.activeId === id && current.mounted.includes(id)
      && socket.current?.sendTerminal(current.deviceId, { type: "input", sessionId: id, data }));
  };
  const reopen = (id: string) => {
    const current = scope.current;
    if (!ownsScope() || !current.deviceId || !current.mounted.includes(id)) return;
    socket.current?.sendTerminal(current.deviceId, { type: "detach", sessionId: id });
    stream.clear(id);
    const next = current.mounted.filter((key) => key !== id);
    // Keep the workspace branch and sibling xterms mounted while this renderer is replaced.
    scope.current = { ...current, mounted: next };
    setMounted(next);
    requestAnimationFrame(() => { if (ownsScope() && scope.current.deviceId === current.deviceId) attach(id); });
  };
  const resize = (id: string, cols: number, rows: number) => {
    if (ownsScope() && scope.current.deviceId && scope.current.activeId === id && scope.current.mounted.includes(id))
      socket.current?.sendTerminal(scope.current.deviceId, { type: "resize", sessionId: id, cols, rows });
  };
  const end = (id: string) => {
    if (!ownsScope()) return;
    if (!scope.current.deviceId || !socket.current?.sendTerminal(scope.current.deviceId, { type: "close", sessionId: id })) {
      setError("sendFailed"); return;
    }
    refreshRef.current();
  };
  const pair = async (code: string) => { await api.pair(code); await loadDevices(); };
  const selectDevice = (id: string) => {
    if (id === scope.current.deviceId || !devices.some((device) => device.id === id)) return;
    runner.cancel(); socket.current?.close(); stream.clear();
    scope.current = { ...scope.current, deviceId: id, mounted: [], activeId: undefined, link: "closed" };
    setMounted([]); setActiveId(undefined); setStates({}); setWorkspace(EMPTY); setLink("closed"); setDeviceId(id);
  };

  return { user, checking, authError, login, logout, mobileToken, redeemMobile, cancelMobile, devices, deviceId, setDeviceId: selectDevice,
    device: devices.find((item) => item.id === deviceId), workspace, activeId, mounted, states,
    link, error, setError, starting, stream, transcripts, attach, reopen, run, start, input, resize, end, pair,
    refresh: () => refreshRef.current(), reconnect: () => setSocketVersion((value) => value + 1) };
}
export type WorkspaceModel = ReturnType<typeof useWorkspace>;
