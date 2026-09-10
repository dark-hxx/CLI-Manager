import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleUserRound,
  Clock3,
  Trash2,
  Folder,
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
  Search,
  Send,
  Settings,
  Shield,
  SquareTerminal,
  Sun,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import { FormEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { Device, HistorySessionSummary, JsonObject, Operation, OperationStatus, PairingState, ProjectContext, TerminalChunk, TerminalControlMode, TimelineItem, WorkspaceSnapshot } from "./domain";
import type { TranslationKey } from "./i18n";
import { deviceWallpaperUrl } from "./webClient";
import { WebTerminal } from "./WebTerminal";
import { isManagementOperation, ManagementPanel } from "./ManagementPanel";
import { ProjectTree } from "./ProjectTree";
import { BrowserAccess, MobileQr } from "./BrowserAccess";

type T = (key: TranslationKey) => string;

function clientKindLabel(device: Device, t: T) {
  if (device.clientKind === "development") return t("clientDevelopment");
  if (device.clientKind === "release") return t("clientRelease");
  return "";
}

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
  restricted: boolean;
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
  onRemoveDevice: (id: string) => Promise<void>;
  onClaimPairing: (code: string) => Promise<void>;
  onResetPairing: () => void;
};

export function HostHome(props: HostHomeProps) {
  const [mobileDeviceId, setMobileDeviceId] = useState<string>();
  const [pairingOpen, setPairingOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | Device["status"]>("all");
  const [removingDeviceId, setRemovingDeviceId] = useState<string>();
  const [pendingRemoval, setPendingRemoval] = useState<Device>();
  const devices = [...props.devices].sort((left, right) => {
    if (left.status !== right.status) return left.status === "online" ? -1 : 1;
    return (serverTimestamp(right.lastSeenAt) ?? 0) - (serverTimestamp(left.lastSeenAt) ?? 0);
  });
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleDevices = devices.filter((device) => {
    if (statusFilter !== "all" && device.status !== statusFilter) return false;
    if (!normalizedQuery) return true;
    return [device.name, device.clientId, clientKindLabel(device, props.t), device.platform, device.hostInfo?.hostName, device.hostInfo?.osVersion]
      .some((value) => value?.toLocaleLowerCase().includes(normalizedQuery));
  });
  const closePairing = () => {
    setPairingOpen(false);
    props.onResetPairing();
  };
  const clearFilters = () => {
    setQuery("");
    setStatusFilter("all");
  };
  const removeDevice = async (device: Device) => {
    if (removingDeviceId) return;
    if (!window.confirm(props.t("removeDeviceConfirmation").replace("{name}", device.name))) return;
    setRemovingDeviceId(device.id);
    try { await props.onRemoveDevice(device.id); } finally { setRemovingDeviceId(undefined); }
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

      <section className="host-home-content" aria-label={props.t("hostsTitle")}>
        {devices.length === 0 ? (
          <div className="host-empty"><Monitor size={42} /><h2>{props.t("noHostsTitle")}</h2><p>{props.t("noHostsHint")}</p><button className="primary-button" type="button" onClick={() => setPairingOpen(true)}><Plus size={18} />{props.t("pairDevice")}</button></div>
        ) : (
          <>
            <section className="host-inventory" aria-labelledby="device-inventory-title">
              <div className="host-inventory-toolbar">
                <h2 id="device-inventory-title">{props.t("deviceInventory")}</h2>
                <div className="host-inventory-controls">
                  <div className="host-search">
                    <label className="sr-only" htmlFor="host-device-search">{props.t("searchDevices")}</label>
                    <Search size={17} />
                    <input id="host-device-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={props.t("searchDevices")} />
                    {query && <button type="button" onClick={() => setQuery("")} aria-label={props.t("clearSearch")}><X size={15} /></button>}
                  </div>
                  {!props.restricted && <button className="secondary-button host-pair-button" type="button" onClick={() => setPairingOpen(true)}><Plus size={17} />{props.t("pairDevice")}</button>}
                  <div className="host-filter" aria-label={props.t("filterByStatus")}>
                    {(["all", "online", "offline"] as const).map((status) => (
                      <button className={statusFilter === status ? "active" : ""} type="button" key={status} onClick={() => setStatusFilter(status)} aria-pressed={statusFilter === status}>
                        {props.t(status === "all" ? "allDevices" : status)}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {visibleDevices.length === 0 ? (
                <div className="host-filter-empty"><Search size={32} /><h3>{props.t("noMatchingDevices")}</h3><p>{props.t("noMatchingDevicesHint")}</p><button className="secondary-button" type="button" onClick={clearFilters}>{props.t("clearFilters")}</button></div>
              ) : (
                <div className="host-list" aria-label={`${props.t("hostsTitle")} · ${visibleDevices.length}`}>
                  {visibleDevices.map((device) => (
                    <div className="host-card-wrap" key={device.id}>
                      <button className={`host-card ${device.status}`} type="button" onClick={() => props.onSelectDevice(device.id)} aria-label={`${props.t("openHost")} ${device.name}`}>
                        <span className={`host-card-visual${device.wallpaperRevision ? " has-wallpaper" : ""}`}>
                          {device.wallpaperRevision && <img className="host-card-wallpaper" src={deviceWallpaperUrl(device) ?? undefined} alt="" loading="lazy" />}
                          <span className="host-card-shade" aria-hidden="true" />
                          <Monitor size={25} />
                        </span>
                        <span className="host-card-body">
                          <span className="host-card-heading">
                            <strong className="host-card-name">{device.name}{clientKindLabel(device, props.t) ? ` · ${clientKindLabel(device, props.t)}` : ""}</strong>
                            <span className={`host-status ${device.status}`}><span className={`status-dot ${device.status === "online" ? "" : "warning"}`} />{props.t(device.status === "online" ? "online" : "offline")}</span>
                          </span>
                          <span className="host-facts">
                            <span className="host-fact"><span>{props.t("hostName")}</span><strong>{device.hostInfo?.hostName || props.t("unknown")}</strong></span>
                            <span className="host-fact"><span>{props.t("system")}</span><strong>{device.hostInfo?.osVersion || props.t("unknown")}</strong></span>
                            <span className="host-fact"><span>{props.t("platform")}</span><strong>{device.platform || props.t("unknown")}</strong></span>
                            <span className="host-fact"><span>{props.t("appVersion")}</span><strong className="host-version-badge">{device.appVersion ? `v${device.appVersion}` : props.t("unknown")}</strong></span>
                          </span>
                        </span>
                        <span className="host-card-side">
                          <span className="host-heartbeat"><Clock3 size={14} /><span>{props.t("lastHeartbeat")}</span><time dateTime={formatServerDateTime(device.lastSeenAt)}>{device.lastSeenAt === null ? props.t("noHeartbeat") : formatServerTime(device.lastSeenAt)}</time></span>
                          <span className="host-card-open">{props.t("openHost")}<ChevronRight size={17} /></span>
                        </span>
                      </button>
                      {!props.restricted && <span className="host-card-actions">
                        <button className="host-card-remove" type="button" aria-label={props.t("mobileQr")} onClick={() => setMobileDeviceId(device.id)}><Wifi size={17} /></button>
                        <button
                          className="host-card-remove"
                          type="button"
                          disabled={removingDeviceId === device.id}
                          aria-label={`${props.t("removeDevice")} ${device.name}`}
                          onClick={(event) => { event.preventDefault(); event.stopPropagation(); setPendingRemoval(device); }}
                        >
                          <Trash2 size={17} aria-hidden="true" />
                        </button>
                      </span>}
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </section>

      {!props.restricted && <BrowserAccess t={props.t} />}
      {pendingRemoval && <div className="overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !removingDeviceId) setPendingRemoval(undefined); }}><div className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="remove-device-title"><div className="confirm-dialog-icon"><Trash2 size={22} /></div><h2 id="remove-device-title">{props.t("removeDevice")}</h2><p>{props.t("removeDeviceConfirmation").replace("{name}", pendingRemoval.name)}</p><div className="confirm-dialog-actions"><button className="secondary-button" type="button" onClick={() => setPendingRemoval(undefined)} disabled={Boolean(removingDeviceId)}>{props.t("cancel")}</button><button className="danger-button" type="button" onClick={() => { const device = pendingRemoval; setPendingRemoval(undefined); void removeDevice(device); }} disabled={Boolean(removingDeviceId)}>{removingDeviceId && <LoaderCircle className="spin" size={16} />}{props.t("removeDevice")}</button></div></div></div>}
      {mobileDeviceId && <OverlayPanel title={props.t("mobileQr")} closeLabel={props.t("close")} onClose={() => setMobileDeviceId(undefined)}><MobileQr t={props.t} deviceId={mobileDeviceId} /></OverlayPanel>}
      {pairingOpen && <OverlayPanel title={props.t("pairDevice")} closeLabel={props.t("close")} onClose={closePairing}><PairingForm t={props.t} state={props.pairing} onClaim={props.onClaimPairing} /></OverlayPanel>}
    </main>
  );
}

type WorkbenchProps = {
  restricted: boolean;
  sending: boolean;
  detailState: "idle" | "loading" | "ready" | "error";
  t: T;
  userName: string;
  devices: Device[];
  selectedDevice?: Device;
  history: HistorySessionSummary[];
  workspace: WorkspaceSnapshot | null;
  selectedSession?: HistorySessionSummary;
  projectContexts: ProjectContext[];
  selectedProjectContext?: ProjectContext;
  terminalSessionId?: string;
  terminalStatus: string;
  terminalChunks: TerminalChunk[];
  terminalControlMode: TerminalControlMode;
  timeline: TimelineItem[];
  pairing: PairingState;
  socketState: "connecting" | "open" | "closed";
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
  onOpenTerminal: () => void;
  onTerminalInput: (data: string) => boolean;
  onTerminalResize: (cols: number, rows: number) => boolean;
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
  const canOpenTerminal = Boolean(!props.sending && selectedDevice?.status === "online" && selectedProjectContext);
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
              <strong>{selectedProjectContext ? `${selectedProjectContext.projectName} · ${selectedProjectContext.source}` : t("noProjectContext")}</strong>
              <span>/</span>{selectedSession?.branch ?? selectedProjectContext?.branch ?? t("unknown")}
            </div>
            <div className="device-context-row">
              <label className="sr-only" htmlFor="device-select">{t("devices")}</label>
              <select id="device-select" className="device-select" value={selectedDevice?.id ?? ""} onChange={(event) => props.onSelectDevice(event.target.value)} disabled={props.devices.length === 0}>
                {props.devices.length === 0 && <option value="">{t("noDevice")}</option>}
                {props.devices.map((device) => <option key={device.id} value={device.id}>{device.name}{clientKindLabel(device, props.t) ? ` · ${clientKindLabel(device, props.t)}` : ""}</option>)}
              </select>
              <DeviceLine device={selectedDevice} t={t} socketState={props.socketState} />
            </div>
            <div className="context-meta"><span>{t("worktree")}: {selectedProjectContext?.projectName ?? t("unknown")}</span><span>CLI: {selectedProjectContext?.source ?? capabilityValue(selectedDevice, "cli:")}</span><span>{t("terminal")}: {terminalStatusLabel(t, props.terminalStatus)}</span></div>
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

        <section className="workspace-content terminal-workspace">
          <div className="source-banner" role="status" aria-live="polite">
            <span className={`source-badge ${props.terminalStatus === "running" ? "live" : selectedFreshness}`}>{terminalStatusLabel(t, props.terminalStatus)}</span>
            <span>{props.terminalSessionId ? `${t("terminalSession")}: ${props.terminalSessionId}` : t("terminalNotStarted")}</span>
            {props.terminalSessionId && <span>{t(props.terminalControlMode === "web" ? "terminalControlWeb" : "terminalControlDesktop")}</span>}
            <span className="socket-state">{t("browserConnection")}: {t(props.socketState === "open" ? "connected" : props.socketState === "connecting" ? "reconnecting" : "disconnected")}</span>
          </div>
          {!selectedDevice ? (
            <EmptyDevice t={t} onPair={() => setPairingOpen(true)} />
          ) : !selectedProjectContext ? (
            <TerminalEmpty t={t} canOpen={false} onOpen={props.onOpenTerminal} />
          ) : props.terminalSessionId ? (
            <WebTerminal sessionId={props.terminalSessionId} status={props.terminalStatus} chunks={props.terminalChunks} controlMode={props.terminalControlMode} theme={props.resolvedTheme} onInput={props.onTerminalInput} onResize={props.onTerminalResize} />
          ) : (
            <TerminalEmpty t={t} canOpen={canOpenTerminal} onOpen={props.onOpenTerminal} />
          )}
        </section>
      </main>

      <aside id="device-details-drawer" className="action-panel" aria-label={t("deviceDetails")} aria-hidden={!detailsOpen}>
        <div className="action-title">
          <h2>{t("deviceDetails")}</h2>
          <button className="icon-button" type="button" onClick={() => setDetailsOpen(false)} aria-label={t("close")}><X size={18} /></button>
        </div>
        {selectedDevice ? <DeviceCard device={selectedDevice} t={t} syncText={syncText} /> : <p className="muted">{t("noDeviceHint")}</p>}
        {!props.restricted && <button className="secondary-button" type="button" onClick={() => setPairingOpen(true)}><Plus size={18} />{t("pairDevice")}</button>}
        <button className="secondary-button" type="button" onClick={() => setManagementOpen(true)}><Settings size={18} />{t("management")}</button>
        <h2>{t("capabilities")}</h2>
        <div className="capability-list">{selectedDevice?.capabilities.length ? selectedDevice.capabilities.map((item) => <span key={item}>{item}</span>) : <span>{t("unknown")}</span>}</div>
      </aside>

      <nav className="bottom-nav" aria-label={t("workbench")}>
        <button className="active" type="button"><SquareTerminal size={23} /><span>{t("terminal")}</span></button>
        <button type="button" onClick={() => setHistoryOpen(true)}><History size={23} /><span>{t("history")}</span></button>
        <button type="button" onClick={props.restricted ? props.onBackToHosts : () => setPairingOpen(true)}><Monitor size={23} /><span>{t("devices")}</span></button>
        <button type="button" onClick={props.onLanguage}><Languages size={23} /><span>{t("language")}</span></button>
        <button type="button" onClick={props.onLogout}><CircleUserRound size={23} /><span>{t("logout")}</span></button>
      </nav>

      {historyOpen && <OverlayPanel title={t("history")} closeLabel={t("close")} onClose={() => setHistoryOpen(false)}><HistoryList t={t} items={props.history} selectedId={selectedSession?.sessionId} onSelect={(id) => { props.onSelectSession(id); setHistoryOpen(false); }} /></OverlayPanel>}
      {!props.restricted && pairingOpen && <OverlayPanel title={t("pairDevice")} closeLabel={t("close")} onClose={() => { setPairingOpen(false); props.onResetPairing(); }}><PairingForm t={t} state={props.pairing} onClaim={props.onClaimPairing} /></OverlayPanel>}
      {managementOpen && <OverlayPanel title={t("management")} closeLabel={t("close")} onClose={() => setManagementOpen(false)}><ManagementPanel t={t} capabilities={selectedDevice?.capabilities ?? []} projectContext={selectedProjectContext} operations={props.timeline.filter((item): item is Extract<TimelineItem, { type: "operation" }> => item.type === "operation" && isManagementOperation(item.operation)).map((item) => item.operation)} onSubmit={props.onSubmitManagement} /></OverlayPanel>}
    </div>
  );
}

function ProjectSidebar(props: WorkbenchProps & { onPair: () => void }) {
  return (
    <aside className="sidebar project-sidebar" aria-label={props.t("projects")}>
      <div className="sidebar-brand"><AppLogo /><strong>CLI-Manager</strong></div>
      <button className="new-chat-button" type="button" onClick={props.onOpenTerminal} disabled={!props.selectedProjectContext || props.selectedDevice?.status !== "online"}><Plus size={18} /><span>{props.t("newTerminal")}</span></button>
      <div className="project-tree">
        <div className="side-section-title"><span>{props.t("projects")}</span><span className="count">{props.workspace?.projects.length ?? 0}</span></div>
        <ProjectTree t={props.t} workspace={props.workspace} projectContexts={props.projectContexts} selectedProjectContext={props.selectedProjectContext} dragEnabled={Boolean(props.selectedDevice?.status === "online" && props.selectedDevice.capabilities.includes("project.management"))} managementEnabled={Boolean(props.selectedDevice?.status === "online" && props.selectedDevice.capabilities.includes("project.management"))} onSelectProjectContext={props.onSelectProjectContext} onSubmit={props.onSubmitManagement} onReload={props.onRefresh} />
      </div>
      <div className="sidebar-footer">{!props.restricted && <button className="footer-row" type="button" onClick={props.onPair}><Monitor size={20} /><span>{props.t("pairDevice")}</span></button>}<button className="account-row" type="button" onClick={props.onLogout}><span className="avatar">{props.userName.slice(0, 1).toUpperCase()}</span><span>{props.userName}</span><LogOut size={16} /></button></div>
    </aside>
  );
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
  return <div className="device-line"><Monitor size={16} />{device?.name ?? t("noDevice")}{device && clientKindLabel(device, t) && <span>{clientKindLabel(device, t)}</span>}<span className={`status-dot ${device?.status === "online" ? "" : "warning"}`} /><span>{t(device?.status === "online" ? "online" : "offline")}</span>{socketState === "open" ? <Wifi size={15} /> : <WifiOff size={15} />}</div>;
}

function DeviceCard({ device, t, syncText }: { device: Device; t: T; syncText: string }) {
  return <div className="device-card"><div><Monitor size={22} /><strong>{device.name}</strong></div><dl><dt>{t("status")}</dt><dd>{t(device.status === "online" ? "online" : "offline")}</dd><dt>{t("platform")}</dt><dd>{device.platform}</dd><dt>{t("appVersion")}</dt><dd>{clientKindLabel(device, t) || t("unknown")} · {device.appVersion}</dd><dt>{t("softwareId")}</dt><dd>{device.clientId}</dd><dt>{t("lastSync")}</dt><dd>{syncText}</dd></dl></div>;
}

function EmptyDevice({ t, onPair }: { t: T; onPair: () => void }) {
  return <div className="welcome-block"><Monitor size={48} /><h1>{t("noDevice")}</h1><p>{t("noDeviceHint")}</p><button className="primary-button" type="button" onClick={onPair}>{t("pairDevice")}</button></div>;
}

function TerminalEmpty({ t, canOpen, onOpen }: { t: T; canOpen: boolean; onOpen: () => void }) {
  return <div className="terminal-empty"><SquareTerminal size={46} /><h1>{t("terminalEmpty")}</h1><p>{canOpen ? t("terminalEmptyHint") : t("selectProjectFirst")}</p><button className="primary-button" type="button" onClick={onOpen} disabled={!canOpen}><SquareTerminal size={18} />{t("openTerminal")}</button></div>;
}

function terminalStatusLabel(t: T, status: string): string {
  const keys: Record<string, TranslationKey> = { idle: "terminalIdle", connecting: "terminalConnecting", running: "terminalRunning", exited: "terminalExited", error: "terminalError" };
  return t(keys[status] ?? "terminalIdle");
}

function Welcome({ t, device, onDraft }: { t: T; device: Device; onDraft: (value: string) => void }) {
  return <><div className="welcome-block"><AppLogo /><h1>{t("greeting")}</h1><p>{t("greetingQuestion")}</p></div><div className="suggestion-grid">{([["solveProject", "promptSolve", Folder], ["fixIssue", "promptFix", Shield], ["brainstorm", "promptBrainstorm", Bot]] as const).map(([label, prompt, Icon]) => <button className="suggestion-card" type="button" key={label} disabled={device.status !== "online"} onClick={() => onDraft(t(prompt))}><span className="feature-icon blue"><Icon size={24} /></span><span><strong>{t(label)}</strong><small>{device.status === "online" ? t("ready") : t("offlineDraftOnly")}</small></span></button>)}</div></>;
}

function ConversationTimeline({ t, items }: { t: T; items: TimelineItem[] }) {
  return <section className="timeline" aria-label={t("conversationTimeline")} aria-live="polite">{items.map((item) => item.type === "operation" ? <OperationCard key={item.id} t={t} item={item} /> : <article className={`timeline-item ${item.type}-item`} key={item.id}><header>{item.type === "prompt" ? <MessageCircle size={18} /> : <Bot size={18} />}<strong>{t(item.type === "prompt" ? "you" : item.type === "assistant" ? "assistant" : "conversationActivity")}</strong><time>{formatServerTime(item.occurredAt)}</time></header><p>{item.text}</p>{item.type === "assistant" && item.streaming && <small>{t("assistantStreaming")}</small>}</article>)}</section>;
}

function OperationCard({ t, item }: { t: T; item: Extract<TimelineItem, { type: "operation" }> }) {
  const operation = item.operation;
  const terminal = ["succeeded", "failed", "rejected", "timed_out", "canceled"].includes(operation.status);
  const runtimeErrors: Record<string, TranslationKey> = { conversation_owned_by_terminal: "runtimeOwned", history_context_not_found: "runtimeContext", unsupported_web_approval_override: "runtimeApprovalOverride", cli_timeout: "runtimeTimeout", cli_spawn_failed: "runtimeSpawn", cli_approval_denied: "runtimeDenied", cli_turn_failed: "runtimeFailed", cli_exited: "runtimeExited", cli_rpc_failed: "runtimeRpc" };
  const errorKey = operation.error && (runtimeErrors[operation.error.code] ?? runtimeErrors[operation.error.message.split(":")[0].trim()]);
  return <article className={`timeline-item operation-item ${operation.status}`}><header>{operation.status === "succeeded" ? <CheckCircle2 size={18} /> : terminal ? <AlertTriangle size={18} /> : <LoaderCircle className="spin" size={18} />}<strong>{t("operation")}</strong><code>{operation.id}</code></header><div className="operation-grid"><span>{t("operationKind")}</span><strong>{operation.kind}</strong><span>{t("operationStatus")}</span><strong>{operationStatusLabel(t, operation.status)}</strong></div>{operation.error && <><p className="form-error" role="alert">{errorKey ? t(errorKey) : localizedError(t, operation.error.code)}</p><details><summary>{t("runtimeDiagnostics")}</summary><p>{operation.error.message}</p></details></>}<small>{t("updatedAt")} {formatServerTime(operation.updatedAt)}</small></article>;
}

function Composer({ t, value, disabled, offline, message, onChange, onSend }: { t: T; value: string; disabled: boolean; offline: boolean; message: string; onChange: (value: string) => void; onSend: () => void }) {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => document.documentElement.style.setProperty("--keyboard-height", `${Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)}px`);
    viewport.addEventListener("resize", update); viewport.addEventListener("scroll", update); update();
    return () => { viewport.removeEventListener("resize", update); viewport.removeEventListener("scroll", update); document.documentElement.style.removeProperty("--keyboard-height"); };
  }, []);
  const submit = (event: FormEvent) => { event.preventDefault(); if (!disabled) onSend(); };
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
