import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleUserRound,
  Clock3,
  Folder,
  FolderTree,
  GitBranch,
  History,
  Languages,
  LoaderCircle,
  LogOut,
  MessageCircle,
  Monitor,
  Moon,
  Plus,
  PanelRightClose,
  PanelRightOpen,
  Radio,
  RefreshCw,
  Send,
  Settings,
  Shield,
  Sun,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import { FormEvent, ReactNode, useEffect, useRef, useState } from "react";
import type { Device, HistorySessionSummary, JsonObject, Operation, OperationStatus, PairingState, ProjectContext, TimelineItem } from "./domain";
import type { TranslationKey } from "./i18n";
import { deviceWallpaperUrl } from "./webClient";
import { isManagementOperation, ManagementPanel } from "./ManagementPanel";

type T = (key: TranslationKey) => string;

export function AppLogo() {
  return <div className="app-logo" aria-hidden="true"><ChevronRight size={29} strokeWidth={3.4} /><span /></div>;
}

export function LoadingPage({ t }: { t: T }) {
  return <main className="state-page" aria-busy="true"><AppLogo /><div className="skeleton title-skeleton" /><div className="skeleton body-skeleton" /><p>{t("loadingWorkspace")}</p></main>;
}

export function LoginPage({ t, error, onLogin }: { t: T; error: string; onLogin: (username: string, password: string) => Promise<void> }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    try { await onLogin(username, password); } finally { setSubmitting(false); }
  };
  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="login-title">
        <AppLogo />
        <h1 id="login-title">{t("loginTitle")}</h1>
        <p>{t("loginHint")}</p>
        <form onSubmit={submit}>
          <label htmlFor="username">{t("username")}</label>
          <input id="username" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required />
          <label htmlFor="password">{t("password")}</label>
          <input id="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
          {error && <p className="form-error" role="alert">{localizedError(t, error)}</p>}
          <button className="primary-button" type="submit" disabled={submitting || !username.trim() || !password}>
            {submitting && <LoaderCircle className="spin" size={18} />}{t(submitting ? "signingIn" : "signIn")}
          </button>
        </form>
      </section>
    </main>
  );
}

export function SessionExpiredPage({ t, onLogin }: { t: T; onLogin: () => void }) {
  return <main className="state-page"><AlertTriangle size={42} /><h1>{t("sessionExpired")}</h1><p>{t("sessionExpiredHint")}</p><button className="primary-button" type="button" onClick={onLogin}>{t("signInAgain")}</button></main>;
}

export function GlobalErrorPage({ t, error, onRetry }: { t: T; error: string; onRetry: () => void }) {
  return <main className="state-page"><AlertTriangle size={42} /><h1>{t("connectionError")}</h1><p>{error ? localizedError(t, error) : t("unknownError")}</p><button className="primary-button" type="button" onClick={onRetry}><RefreshCw size={18} />{t("retry")}</button></main>;
}

type HostHomeProps = {
  t: T;
  userName: string;
  devices: Device[];
  pairing: PairingState;
  socketState: "connecting" | "open" | "closed";
  resolvedTheme: "light" | "dark";
  onTheme: () => void;
  onLanguage: () => void;
  onLogout: () => void;
  onRefresh: () => void;
  onSelectDevice: (id: string) => void;
  onClaimPairing: (code: string) => Promise<void>;
  onResetPairing: () => void;
};

export function HostHome(props: HostHomeProps) {
  const [pairingOpen, setPairingOpen] = useState(false);
  const devices = [...props.devices].sort((left, right) => {
    if (left.status !== right.status) return left.status === "online" ? -1 : 1;
    return (serverTimestamp(right.lastSeenAt) ?? 0) - (serverTimestamp(left.lastSeenAt) ?? 0);
  });
  const closePairing = () => {
    setPairingOpen(false);
    props.onResetPairing();
  };

  return (
    <main className="host-home">
      <header className="host-home-header">
        <div className="host-brand"><AppLogo /><div><strong>CLI-Manager</strong><span>{props.t("hostsSubtitle")}</span></div></div>
        <div className="host-home-actions">
          <span className={`browser-status ${props.socketState}`}>{props.socketState === "open" ? <Wifi size={16} /> : <WifiOff size={16} />}{props.t(props.socketState === "open" ? "connected" : props.socketState === "connecting" ? "reconnecting" : "disconnected")}</span>
          <button className="icon-button" type="button" onClick={props.onRefresh} aria-label={props.t("refresh")}><RefreshCw size={19} /></button>
          <button className="icon-button" type="button" onClick={props.onLanguage} aria-label={props.t("language")}><Languages size={19} /></button>
          <button className="icon-button" type="button" onClick={props.onTheme} aria-label={props.t("theme")}>{props.resolvedTheme === "dark" ? <Moon size={19} /> : <Sun size={19} />}</button>
          <button className="host-account" type="button" onClick={props.onLogout} aria-label={props.t("logout")}><span className="avatar">{props.userName.slice(0, 1).toUpperCase()}</span><span>{props.userName}</span><LogOut size={16} /></button>
        </div>
      </header>

      <section className="host-home-content" aria-labelledby="hosts-title">
        <div className="host-home-title">
          <div><h1 id="hosts-title">{props.t("hostsTitle")}</h1><p>{props.t("hostsHint")}</p></div>
          <button className="secondary-button" type="button" onClick={() => setPairingOpen(true)}><Plus size={18} />{props.t("pairDevice")}</button>
        </div>

        {devices.length === 0 ? (
          <div className="host-empty"><Monitor size={42} /><h2>{props.t("noHostsTitle")}</h2><p>{props.t("noHostsHint")}</p><button className="primary-button" type="button" onClick={() => setPairingOpen(true)}><Plus size={18} />{props.t("pairDevice")}</button></div>
        ) : (
          <div className="host-list" aria-label={`${props.t("hostsTitle")} · ${devices.length}`}>
            {devices.map((device) => (
              <button className={`host-card ${device.status}${device.wallpaperRevision ? " has-wallpaper" : ""}`} type="button" key={device.id} onClick={() => props.onSelectDevice(device.id)} aria-label={`${props.t("openHost")} ${device.name}`}>
                {device.wallpaperRevision && <img className="host-card-wallpaper" src={deviceWallpaperUrl(device) ?? undefined} alt="" loading="lazy" />}
                <span className="host-card-shade" aria-hidden="true" />
                <span className="host-card-icon"><Monitor size={24} /></span>
                <span className="host-card-body">
                  <span className="host-card-heading"><strong>{device.name}</strong><span className={`host-status ${device.status}`}><span className={`status-dot ${device.status === "online" ? "" : "warning"}`} />{props.t(device.status === "online" ? "online" : "offline")}</span></span>
                  <span className="host-meta"><span>{device.hostInfo?.hostName || device.platform || props.t("unknown")}</span><span>{device.hostInfo?.osVersion || device.platform || props.t("unknown")}</span></span>
                  {device.hostInfo && <span className="host-specs">
                    <span title={device.hostInfo.cpuModel}>{props.t("cpu")}: {device.hostInfo.cpuModel} · {device.hostInfo.cpuArch}</span>
                    <span>{props.t("memory")}: {formatMemory(device.hostInfo.totalMemoryBytes)} · {props.t("display")}: {device.hostInfo.displayWidth}x{device.hostInfo.displayHeight}</span>
                  </span>}
                  <span className="host-heartbeat"><Clock3 size={15} />{props.t("lastHeartbeat")} <time dateTime={formatServerDateTime(device.lastSeenAt)}>{device.lastSeenAt === null ? props.t("noHeartbeat") : formatServerTime(device.lastSeenAt)}</time></span>
                </span>
                <ChevronRight className="host-card-arrow" size={20} />
              </button>
            ))}
          </div>
        )}
      </section>

      {pairingOpen && <OverlayPanel title={props.t("pairDevice")} closeLabel={props.t("close")} onClose={closePairing}><PairingForm t={props.t} state={props.pairing} onClaim={props.onClaimPairing} /></OverlayPanel>}
    </main>
  );
}

function formatMemory(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "-";
  return `${Math.round(bytes / 1024 ** 3)} GB`;
}

type WorkbenchProps = {
  t: T;
  userName: string;
  devices: Device[];
  selectedDevice?: Device;
  history: HistorySessionSummary[];
  selectedSession?: HistorySessionSummary;
  projectContexts: ProjectContext[];
  selectedProjectContext?: ProjectContext;
  timeline: TimelineItem[];
  pairing: PairingState;
  socketState: "connecting" | "open" | "closed";
  draft: string;
  composerMessage: string;
  latestSyncAt: number | null;
  resolvedTheme: "light" | "dark";
  onTheme: () => void;
  onLanguage: () => void;
  onLogout: () => void;
  onBackToHosts: () => void;
  onRefresh: () => void;
  onSelectDevice: (id: string) => void;
  onSelectSession: (id?: string) => void;
  onSelectProjectContext: (key: string) => void;
  onDraft: (value: string) => void;
  onSend: () => void;
  onClaimPairing: (code: string) => Promise<void>;
  onResetPairing: () => void;
  onSubmitManagement: (kind: string, payload: JsonObject) => Promise<Operation>;
};

export function Workbench(props: WorkbenchProps) {
  const { t, selectedDevice, selectedSession, selectedProjectContext } = props;
  const [historyOpen, setHistoryOpen] = useState(false);
  const [pairingOpen, setPairingOpen] = useState(false);
  const [managementOpen, setManagementOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const canSend = Boolean(props.draft.trim() && selectedDevice?.status === "online" && selectedProjectContext);
  const selectedFreshness = selectedSession?.freshness ?? selectedProjectContext?.freshness ?? "stale";
  const syncText = props.latestSyncAt === null ? t("unknown") : formatServerTime(props.latestSyncAt);
  return (
    <div className={`app-shell${detailsOpen ? " details-open" : ""}`}>
      <a className="skip-link" href="#conversation-main">{t("skipToContent")}</a>
      <ProjectSidebar {...props} onPair={() => setPairingOpen(true)} />
      <main className="main-panel" id="conversation-main">
        <header className="desktop-header">
          <div className="context-block">
            <div className="project-line">
              <label className="sr-only" htmlFor="project-context-select">{t("projectContext")}</label>
              <select
                id="project-context-select"
                className="project-context-select"
                value={selectedProjectContext?.key ?? ""}
                onChange={(event) => props.onSelectProjectContext(event.target.value)}
                disabled={props.projectContexts.length === 0}
              >
                {props.projectContexts.length === 0 && <option value="">{t("noProjectContext")}</option>}
                {props.projectContexts.map((context) => (
                  <option key={context.key} value={context.key}>{context.projectKey} · {context.source}</option>
                ))}
              </select>
              <span>/</span>{selectedSession?.branch ?? selectedProjectContext?.branch ?? t("unknown")}
            </div>
            <div className="device-context-row">
              <label className="sr-only" htmlFor="device-select">{t("devices")}</label>
              <select id="device-select" className="device-select" value={selectedDevice?.id ?? ""} onChange={(event) => props.onSelectDevice(event.target.value)} disabled={props.devices.length === 0}>
                {props.devices.length === 0 && <option value="">{t("noDevice")}</option>}
                {props.devices.map((device) => <option key={device.id} value={device.id}>{device.name}</option>)}
              </select>
              <DeviceLine device={selectedDevice} t={t} socketState={props.socketState} />
            </div>
            <div className="context-meta"><span>{t("worktree")}: {selectedProjectContext?.cwd ?? t("unknown")}</span><span>CLI: {selectedProjectContext?.source ?? capabilityValue(selectedDevice, "cli:")}</span><span>{t("model")}: {capabilityValue(selectedDevice, "model:")}</span><span>{t("reasoning")}: {capabilityValue(selectedDevice, "reasoning:")}</span><span>{t("permission")}: {capabilityValue(selectedDevice, "permission:")}</span></div>
          </div>
          <div className="header-actions">
            <button className="icon-button" type="button" onClick={props.onBackToHosts} aria-label={t("backToHosts")}><ArrowLeft size={20} /></button>
            <button
              className="icon-button details-toggle"
              type="button"
              onClick={() => setDetailsOpen((open) => !open)}
              aria-label={t("deviceDetails")}
              aria-expanded={detailsOpen}
              aria-controls="device-details-drawer"
            >
              {detailsOpen ? <PanelRightClose size={20} /> : <PanelRightOpen size={20} />}
            </button>
            <button className="icon-button" type="button" onClick={() => setManagementOpen(true)} aria-label={t("management")}><Settings size={20} /></button>
            <button className="icon-button" type="button" onClick={props.onRefresh} aria-label={t("refresh")}><RefreshCw size={20} /></button>
            <button className="icon-button" type="button" onClick={props.onLanguage} aria-label={t("language")}><Languages size={20} /></button>
            <button className="icon-button" type="button" onClick={props.onTheme} aria-label={t("theme")}>{props.resolvedTheme === "dark" ? <Moon size={20} /> : <Sun size={20} />}</button>
          </div>
        </header>
        <header className="mobile-header">
          <button className="icon-button" type="button" onClick={props.onBackToHosts} aria-label={t("backToHosts")}><ArrowLeft size={22} /></button>
          <div><strong>{selectedSession?.title ?? "CLI-Manager"}</strong><span className="mobile-device-line"><span className={`status-dot ${selectedDevice?.status === "online" ? "" : "warning"}`} role="img" aria-label={selectedDevice?.status === "online" ? t("online") : t("offline")} />{selectedDevice?.name ?? t("noDevice")}</span></div>
          <button className="icon-button" type="button" onClick={() => setManagementOpen(true)} aria-label={t("management")}><Settings size={22} /></button>
        </header>

        <section className="workspace-content conversation-workspace">
          <div className="source-banner" role="status" aria-live="polite">
            <span className={`source-badge ${selectedFreshness}`}>{t(selectedFreshness === "live" ? "liveData" : selectedFreshness === "cached" ? "cachedData" : "staleData")}</span>
            <span>{t("lastSync")} {syncText}</span>
            <span className="socket-state">{t("browserConnection")}: {t(props.socketState === "open" ? "connected" : props.socketState === "connecting" ? "reconnecting" : "disconnected")}</span>
          </div>
          {!selectedDevice ? (
            <EmptyDevice t={t} onPair={() => setPairingOpen(true)} />
          ) : props.timeline.length === 0 ? (
            <Welcome t={t} device={selectedDevice} onDraft={props.onDraft} />
          ) : (
            <ConversationTimeline t={t} items={props.timeline} />
          )}
        </section>

        <Composer t={t} value={props.draft} disabled={!canSend} offline={selectedDevice?.status !== "online"} message={props.composerMessage} onChange={props.onDraft} onSend={props.onSend} />
      </main>

      <aside id="device-details-drawer" className="action-panel" aria-label={t("deviceDetails")} aria-hidden={!detailsOpen}>
        <div className="action-title">
          <h2>{t("deviceDetails")}</h2>
          <button className="icon-button" type="button" onClick={() => setDetailsOpen(false)} aria-label={t("close")}><X size={18} /></button>
        </div>
        {selectedDevice ? <DeviceCard device={selectedDevice} t={t} syncText={syncText} /> : <p className="muted">{t("noDeviceHint")}</p>}
        <button className="secondary-button" type="button" onClick={() => setPairingOpen(true)}><Plus size={18} />{t("pairDevice")}</button>
        <button className="secondary-button" type="button" onClick={() => setManagementOpen(true)}><Settings size={18} />{t("management")}</button>
        <h2>{t("capabilities")}</h2>
        <div className="capability-list">{selectedDevice?.capabilities.length ? selectedDevice.capabilities.map((item) => <span key={item}>{item}</span>) : <span>{t("unknown")}</span>}</div>
      </aside>

      <nav className="bottom-nav" aria-label={t("workbench")}>
        <button className="active" type="button"><MessageCircle size={23} /><span>{t("workbench")}</span></button>
        <button type="button" onClick={() => setHistoryOpen(true)}><History size={23} /><span>{t("history")}</span></button>
        <button type="button" onClick={() => setPairingOpen(true)}><Monitor size={23} /><span>{t("devices")}</span></button>
        <button type="button" onClick={props.onLanguage}><Languages size={23} /><span>{t("language")}</span></button>
        <button type="button" onClick={props.onLogout}><CircleUserRound size={23} /><span>{t("logout")}</span></button>
      </nav>

      {historyOpen && <OverlayPanel title={t("history")} closeLabel={t("close")} onClose={() => setHistoryOpen(false)}><HistoryList t={t} items={props.history} selectedId={selectedSession?.sessionId} onSelect={(id) => { props.onSelectSession(id); setHistoryOpen(false); }} /></OverlayPanel>}
      {pairingOpen && <OverlayPanel title={t("pairDevice")} closeLabel={t("close")} onClose={() => { setPairingOpen(false); props.onResetPairing(); }}><PairingForm t={t} state={props.pairing} onClaim={props.onClaimPairing} /></OverlayPanel>}
      {managementOpen && <OverlayPanel title={t("management")} closeLabel={t("close")} onClose={() => setManagementOpen(false)}><ManagementPanel t={t} capabilities={selectedDevice?.capabilities ?? []} projectContext={selectedProjectContext} operations={props.timeline.filter((item): item is Extract<TimelineItem, { type: "operation" }> => item.type === "operation" && isManagementOperation(item.operation)).map((item) => item.operation)} onSubmit={props.onSubmitManagement} /></OverlayPanel>}
    </div>
  );
}

function ProjectSidebar(props: WorkbenchProps & { onPair: () => void }) {
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set());
  const projects = Array.from(
    props.projectContexts.reduce((groups, context) => {
      const contexts = groups.get(context.projectKey) ?? [];
      contexts.push(context);
      groups.set(context.projectKey, contexts);
      return groups;
    }, new Map<string, ProjectContext[]>()),
  );

  const toggleProject = (projectKey: string) => {
    setCollapsedProjects((current) => {
      const next = new Set(current);
      if (next.has(projectKey)) next.delete(projectKey);
      else next.add(projectKey);
      return next;
    });
  };

  return (
    <aside className="sidebar project-sidebar" aria-label={props.t("projects")}>
      <div className="sidebar-brand"><AppLogo /><strong>CLI-Manager</strong></div>
      <button className="new-chat-button" type="button" onClick={() => props.onSelectSession(undefined)}><Plus size={18} /><span>{props.t("newConversation")}</span></button>
      <div className="project-tree">
        <div className="side-section-title"><span>{props.t("projects")}</span><span className="count">{projects.length}</span></div>
        {projects.length === 0 ? <p className="empty-copy">{props.t("noProjectContext")}</p> : projects.map(([projectKey, contexts]) => {
          const collapsed = collapsedProjects.has(projectKey);
          const activeProject = props.selectedProjectContext?.projectKey === projectKey;
          return (
            <section className={`project-node${activeProject ? " active" : ""}`} key={projectKey}>
              <button className="project-node-header" type="button" onClick={() => toggleProject(projectKey)} aria-expanded={!collapsed}>
                {collapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
                <FolderTree size={17} />
                <strong>{projectKey}</strong>
                <span className="project-node-count">{contexts.length}</span>
              </button>
              {!collapsed && <div className="project-branches">{contexts.map((context) => {
                const selected = props.selectedProjectContext?.key === context.key;
                const sessions = props.history.filter((session) => session.source === context.source && session.projectKey === context.projectKey && normalizePath(session.cwd) === normalizePath(context.cwd));
                return (
                  <div className="project-context-node" key={context.key}>
                    <button className={`project-context-row${selected ? " active" : ""}`} type="button" onClick={() => props.onSelectProjectContext(context.key)} title={context.cwd}>
                      <Folder size={16} />
                      <span><strong>{pathLeaf(context.cwd) || context.projectKey}</strong><small><GitBranch size={11} />{context.branch ?? context.source}</small></span>
                      <span
                        className={`freshness-dot ${context.freshness}`}
                        role="img"
                        aria-label={props.t(context.freshness === "live" ? "liveData" : context.freshness === "cached" ? "cachedData" : "staleData")}
                      />
                    </button>
                    {sessions.length > 0 && <div className="project-sessions">{sessions.map((session) => (
                      <button className={`project-session-row${props.selectedSession?.sessionId === session.sessionId ? " active" : ""}`} type="button" key={session.sessionId} onClick={() => props.onSelectSession(session.sessionId)} title={session.title}>
                        <MessageCircle size={13} /><span>{session.title}</span>
                      </button>
                    ))}</div>}
                  </div>
                );
              })}</div>}
            </section>
          );
        })}
      </div>
      <div className="sidebar-footer"><button className="footer-row" type="button" onClick={props.onPair}><Monitor size={20} /><span>{props.t("pairDevice")}</span></button><button className="account-row" type="button" onClick={props.onLogout}><span className="avatar">{props.userName.slice(0, 1).toUpperCase()}</span><span>{props.userName}</span><LogOut size={16} /></button></div>
    </aside>
  );
}

function normalizePath(path: string | null | undefined) {
  return path?.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() ?? "";
}

function pathLeaf(path: string) {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() ?? path;
}

function HistoryList({ t, items, selectedId, onSelect }: { t: T; items: HistorySessionSummary[]; selectedId?: string; onSelect: (id: string) => void }) {
  return <div className="history-list"><div className="side-section-title"><span>{t("recent")}</span><span className="count">{items.length}</span></div>{items.length === 0 ? <p className="empty-copy">{t("noHistory")}</p> : items.map((session) => <button className={`history-row${selectedId === session.sessionId ? " active" : ""}`} type="button" key={session.sessionId} onClick={() => onSelect(session.sessionId)}><MessageCircle size={18} /><span><strong>{session.title}</strong><small>{session.projectKey} · {formatServerTime(session.updatedAt)}</small></span><span className={`freshness-dot ${session.freshness}`} title={t(session.freshness === "live" ? "liveData" : session.freshness === "cached" ? "cachedData" : "staleData")} /></button>)}</div>;
}

function OverlayPanel({ title, closeLabel, onClose, children }: { title: string; closeLabel: string; onClose: () => void; children: ReactNode }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    previousFocus.current = document.activeElement as HTMLElement;
    panelRef.current?.querySelector<HTMLElement>("button, input, [tabindex]")?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); document.body.style.overflow = previousOverflow; previousFocus.current?.focus(); };
  }, [onClose]);
  return <div className="overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="drawer" role="dialog" aria-modal="true" aria-label={title} ref={panelRef}><header><h2>{title}</h2><button className="icon-button" type="button" onClick={onClose} aria-label={closeLabel}><X size={22} /></button></header>{children}</div></div>;
}

function PairingForm({ t, state, onClaim }: { t: T; state: PairingState; onClaim: (code: string) => Promise<void> }) {
  const [code, setCode] = useState(state.status === "error" ? state.input : "");
  const submit = (event: FormEvent) => { event.preventDefault(); void onClaim(code); };
  if (state.status === "claimed") return <div className="pairing-result"><CheckCircle2 size={38} /><h3>{t("pairingClaimed")}</h3><p>{state.device.name}</p></div>;
  return <form className="pairing-form" onSubmit={submit}><p>{t("pairingHint")}</p><label htmlFor="pairing-code">{t("pairingCode")}</label><input id="pairing-code" value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} autoComplete="one-time-code" aria-describedby="pairing-help" /><small id="pairing-help">{t("pairingCodeHelp")}</small>{state.status === "error" && <p className="form-error" role="alert">{pairingError(t, state.code, state.message)}</p>}<button className="primary-button" type="submit" disabled={state.status === "submitting" || !code.trim()}>{state.status === "submitting" && <LoaderCircle className="spin" size={18} />}{t(state.status === "submitting" ? "pairingSubmitting" : "claimDevice")}</button></form>;
}

function DeviceLine({ device, t, socketState }: { device?: Device; t: T; socketState: "connecting" | "open" | "closed" }) {
  return <div className="device-line"><Monitor size={16} />{device?.name ?? t("noDevice")}<span className={`status-dot ${device?.status === "online" ? "" : "warning"}`} /><span>{t(device?.status === "online" ? "online" : "offline")}</span>{socketState === "open" ? <Wifi size={15} /> : <WifiOff size={15} />}</div>;
}

function DeviceCard({ device, t, syncText }: { device: Device; t: T; syncText: string }) {
  return <div className="device-card"><div><Monitor size={22} /><strong>{device.name}</strong></div><dl><dt>{t("status")}</dt><dd>{t(device.status === "online" ? "online" : "offline")}</dd><dt>{t("platform")}</dt><dd>{device.platform}</dd><dt>{t("appVersion")}</dt><dd>{device.appVersion}</dd><dt>{t("lastSync")}</dt><dd>{syncText}</dd></dl></div>;
}

function EmptyDevice({ t, onPair }: { t: T; onPair: () => void }) {
  return <div className="welcome-block"><Monitor size={48} /><h1>{t("noDevice")}</h1><p>{t("noDeviceHint")}</p><button className="primary-button" type="button" onClick={onPair}>{t("pairDevice")}</button></div>;
}

function Welcome({ t, device, onDraft }: { t: T; device: Device; onDraft: (value: string) => void }) {
  return <><div className="welcome-block"><AppLogo /><h1>{t("greeting")}</h1><p>{t("greetingQuestion")}</p></div><div className="suggestion-grid">{([["solveProject", "promptSolve", Folder], ["fixIssue", "promptFix", Shield], ["brainstorm", "promptBrainstorm", Bot]] as const).map(([label, prompt, Icon]) => <button className="suggestion-card" type="button" key={label} disabled={device.status !== "online"} onClick={() => onDraft(t(prompt))}><span className="feature-icon blue"><Icon size={24} /></span><span><strong>{t(label)}</strong><small>{device.status === "online" ? t("ready") : t("offlineDraftOnly")}</small></span></button>)}</div></>;
}

function ConversationTimeline({ t, items }: { t: T; items: TimelineItem[] }) {
  return <section className="timeline" aria-label={t("conversationTimeline")} aria-live="polite">{items.map((item) => item.type === "prompt" ? <article className="timeline-item prompt-item" key={item.id}><header><MessageCircle size={18} /><strong>{t("you")}</strong><time>{formatServerTime(item.occurredAt)}</time></header><p>{item.text}</p></article> : <OperationCard key={item.id} t={t} item={item} />)}</section>;
}

function OperationCard({ t, item }: { t: T; item: Extract<TimelineItem, { type: "operation" }> }) {
  const operation = item.operation;
  const terminal = ["succeeded", "failed", "rejected", "timed_out", "canceled"].includes(operation.status);
  return <article className={`timeline-item operation-item ${operation.status}`}><header>{operation.status === "succeeded" ? <CheckCircle2 size={18} /> : terminal ? <AlertTriangle size={18} /> : <LoaderCircle className="spin" size={18} />}<strong>{t("operation")}</strong><code>{operation.id}</code></header><div className="operation-grid"><span>{t("operationKind")}</span><strong>{operation.kind}</strong><span>{t("operationStatus")}</span><strong>{operationStatusLabel(t, operation.status)}</strong></div>{operation.error && <p className="form-error" role="alert">{operation.error.message}</p>}<small>{t("updatedAt")} {formatServerTime(operation.updatedAt)}</small></article>;
}

function Composer({ t, value, disabled, offline, message, onChange, onSend }: { t: T; value: string; disabled: boolean; offline: boolean; message: string; onChange: (value: string) => void; onSend: () => void }) {
  const submit = (event: FormEvent) => { event.preventDefault(); onSend(); };
  return <form className="composer" onSubmit={submit}><label className="sr-only" htmlFor="task-composer">{t("composerLabel")}</label><textarea id="task-composer" value={value} onChange={(event) => onChange(event.target.value)} placeholder={offline ? t("offlineComposerPlaceholder") : t("composerPlaceholder")} rows={3} /><div className="composer-toolbar"><span className={`composer-state ${offline ? "offline" : "online"}`}>{offline ? <WifiOff size={17} /> : <Radio size={17} />}{t(offline ? "offlineDraftOnly" : "ready")}</span><button className="send-button" type="submit" aria-label={t("send")} disabled={disabled}><Send size={20} /></button></div>{message && <p className="composer-feedback" role="alert">{localizedError(t, message)}</p>}</form>;
}

function capabilityValue(device: Device | undefined, prefix: string) {
  return device?.capabilities.find((item) => item.startsWith(prefix))?.slice(prefix.length) || "—";
}

function operationStatusLabel(t: T, status: OperationStatus): string {
  const key: Record<OperationStatus, TranslationKey> = { submitted: "submitted", waiting_device: "waitingDevice", accepted: "accepted", running: "running", succeeded: "succeeded", failed: "failed", rejected: "rejected", timed_out: "timedOut", canceled: "canceled" };
  return t(key[status]);
}

function pairingError(t: T, code: string, fallback: string) {
  if (code === "invalid_pairing_code") return t("invalidPairingCode");
  if (code === "pairing_code_expired") return t("pairingCodeExpired");
  if (code === "pairing_code_used") return t("pairingCodeUsed");
  if (code === "device_disconnected") return t("deviceDisconnectedError");
  return localizedError(t, fallback || code);
}

function localizedError(t: T, code: string) {
  const keys: Record<string, TranslationKey> = {
    invalid_credentials: "invalidCredentials",
    request_failed: "requestFailed",
    device_offline: "deviceOfflineError",
    device_disconnected: "deviceDisconnectedError",
    replay_required: "replayRequired",
    idempotency_conflict: "idempotencyConflict",
    unsupported_operation_kind: "unsupportedOperation",
    invalid_operation_payload: "invalidOperationPayload",
    project_context_required: "projectContextRequired",
    unauthorized: "sessionExpired",
  };
  return t(keys[code] ?? "requestFailed");
}

function formatServerTime(value: number | string) {
  const timestamp = serverTimestamp(value);
  if (timestamp === null) return "—";
  return new Intl.DateTimeFormat(undefined, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(timestamp);
}

function formatServerDateTime(value: number | string | null) {
  const timestamp = serverTimestamp(value);
  return timestamp === null ? undefined : new Date(timestamp).toISOString();
}

function serverTimestamp(value: number | string | null): number | null {
  if (value === null) return null;
  const timestamp = typeof value === "number" && value < 10_000_000_000 ? value * 1000 : new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}
