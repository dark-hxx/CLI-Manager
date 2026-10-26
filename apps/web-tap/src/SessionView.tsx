import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Terminal, type TerminalHandle, type TerminalInfo } from "./Terminal";
import { Composer } from "./Composer";
import { KeyBar } from "./KeyBar";
import { SessionHeader, type SessionStatus } from "./SessionHeader";
import { DockStatus } from "./Dock";
import { gitKey, useGit } from "./git";
import { agentKey, agentName } from "./format";
import { prepareWebImage } from "../../../src/shared/lib/webImageUpload";
import { resolved, TERMINAL_SIZES, type Preferences, type ViewMode } from "./preferences";
import type { WorkspaceModel } from "./useWorkspace";
import type { Translate } from "./i18n";
import type { Modifiers } from "./input";

const Conversation = lazy(() => import("./Conversation").then((module) => ({ default: module.Conversation })));
export type PanelTab = "details" | "changes" | "files";

/** A mounted session retains terminal state and its own composer while other sessions are selected. */
export function SessionView({ id, active, model, prefs, setPrefs, phone, panelOpen, onDrawer, onPanel, onNewSession, onSettings,
  onInfo, t }: {
  id: string; active: boolean; model: WorkspaceModel; prefs: Preferences; setPrefs: (prefs: Preferences) => void; phone: boolean;
  panelOpen: boolean; onDrawer: () => void; onPanel: (tab?: PanelTab) => void; onNewSession: () => void; onSettings: () => void;
  onInfo: (id: string, info: TerminalInfo) => void; t: Translate;
}) {
  const terminal = useRef<TerminalHandle>(null);
  const defaults = resolved(prefs);
  const [chosen, setChosen] = useState<ViewMode>();
  const [nativeScope, setNativeScope] = useState("");
  const composer = useRef<HTMLDivElement>(null);
  const [chatOpened, setChatOpened] = useState(false);
  const [modifiers, setModifiers] = useState<Modifiers>({ ctrl: false, alt: false });
  const [info, setInfo] = useState<TerminalInfo>({ size: "", direct: false });
  const [writing, setWriting] = useState(false);
  const session = model.workspace.terminals?.find((item) => item.sessionId === id);
  const project = model.workspace.projects.find((item) => item.id === session?.projectId);
  const worktree = model.workspace.worktrees.find((item) => item.id === session?.worktreeId);
  const state = model.states[id] ?? { status: "connecting", controlMode: "desktop" as const };
  const linkOk = model.link === "open";
  const online = model.device?.status === "online";
  const ended = ["exited", "closed"].includes(state.status);
  const running = ["running", "attached"].includes(state.status);
  const disabled = !active || !linkOk || !online || !running;
  const status: SessionStatus = ended ? "ended" : !online ? "offline" : !linkOk || !running ? "connecting" : "running";
  const supported = Boolean(model.device?.capabilities.includes("terminal.transcript"));
  const view: ViewMode = chosen ?? defaults.view;
  const inputScope = JSON.stringify([model.user?.id, model.deviceId, id, session?.projectId, session?.worktreeId]);
  const nativeOpen = view === "chat" && nativeScope === inputScope;
  const terminalVisible = view === "terminal" || nativeOpen;
  const currentView = useRef({ active, view, scope: inputScope, disabled, nativeOpen });
  currentView.current = { active, view, scope: inputScope, disabled, nativeOpen };
  const viewMounted = useRef(true);
  const context = { projectId: session?.projectId ?? "", ...(session?.worktreeId ? { worktreeId: session.worktreeId } : {}) };
  const git = useGit(session ? gitKey(model.user?.id, model.deviceId, session.projectId, session.worktreeId) : undefined, context, model.run, active);
  const clearModifiers = () => setModifiers({ ctrl: false, alt: false });
  const latched = modifiers.ctrl || modifiers.alt;
  const showKeys = nativeOpen || (defaults.keys && !disabled && view === "terminal" && (info.direct || latched || !writing));
  if (view === "chat" && !chatOpened) setChatOpened(true);
  const choose = (next: ViewMode) => {
    setNativeScope("");
    setChosen(next);
    if (next !== defaults.view || prefs.view) setPrefs({ ...prefs, view: next });
  };
  const report = useRef(onInfo);
  report.current = onInfo;
  const receive = useCallback((next: TerminalInfo) => { setInfo(next); report.current(id, next); }, [id]);
  // Re-read the branch and +N −M a little after each message; the CLI usually edits files in response.
  const later = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    viewMounted.current = true;
    return () => { clearTimeout(later.current); viewMounted.current = false; };
  }, []);
  useEffect(() => { setNativeScope(""); }, [inputScope]);
  const currentChat = () => viewMounted.current && currentView.current.scope === inputScope
    && !currentView.current.disabled && currentView.current.active && currentView.current.view === "chat";
  const openCommand = (prefix: string) => {
    if (!currentChat() || currentView.current.nativeOpen || !["claude", "codex"].includes(project?.source ?? "")) return false;
    // Use the actual CLI's menu and installed skills; never submit a guessed command or replay failed input.
    if (!terminal.current?.command(prefix)) return false;
    flushSync(() => setNativeScope(inputScope));
    terminal.current.focus();
    return true;
  };
  const returnToChat = () => {
    // The user finishes/cancels inside the CLI. Hiding its view must not inject control bytes.
    terminal.current?.leaveDirect(); clearModifiers();
    flushSync(() => setNativeScope(""));
    composer.current?.querySelector("textarea")?.focus();
    git.refresh();
  };
  const agent = agentName(project?.source);
  const title = session?.title || project?.name || t("app");
  const blocked = ended ? t("blockedEnded") : !online ? t("blockedOffline") : !linkOk || !running ? t("blockedConnecting") : undefined;
  return <section className={`tap-session${active ? " is-visible" : ""} is-${view}`} aria-hidden={!active}>
    <SessionHeader sessionId={id} active={active} title={title} project={worktree ? `${project?.name ?? ""} · ${worktree.name}` : project?.name ?? ""}
      agent={agentKey(project?.source)} status={status} linkOk={linkOk && online} view={view} size={info.size}
      phone={phone} panelOpen={panelOpen} git={git.summary} fontSize={defaults.fontSize}
      onFontSize={(size) => setPrefs({ ...prefs, fontSize: Math.min(TERMINAL_SIZES.max, Math.max(TERMINAL_SIZES.min, size)) })}
      onView={choose} onDrawer={onDrawer} onPanel={() => onPanel(phone ? undefined : "changes")} onNewSession={onNewSession}
      onSettings={onSettings} onEnd={() => model.end(id)} t={t} />
    <div className={`tap-session-content${nativeOpen ? " has-native-command" : ""}`}>
      <div id={`terminal-${id}`} className="tap-terminal-panel" role={nativeOpen ? "region" : "tabpanel"}
        aria-labelledby={nativeOpen ? `native-command-${id}` : `terminal-tab-${id}`} hidden={!terminalVisible}>
        {nativeOpen && <div className="tap-native-command-heading">
          <div><b id={`native-command-${id}`}>{t("nativeCommandTitle")}</b><p>{blocked ?? t("nativeCommandHint")}</p></div>
          <button type="button" disabled={disabled} onClick={() => terminal.current?.focus()}>{t("nativeCommandKeyboard")}</button>
          <button type="button" onClick={returnToChat}>{t("nativeCommandReturn")}</button>
        </div>}
        <Terminal key={id} ref={terminal} sessionId={id} stream={model.stream} active={active} visible={terminalVisible} nativeMenu={nativeOpen}
          connected={!disabled} state={state} fontSize={defaults.fontSize} t={t} onInfo={receive}
          onInput={(text) => model.input(id, text)} onResize={(cols, rows) => model.resize(id, cols, rows)}
          onError={(code) => { if (!code.startsWith("terminal_")) model.setError(code); }} onRetry={() => model.reopen(id)} />
      </div>
      <div id={`chat-${id}`} className="tap-chat-panel" role="tabpanel" aria-labelledby={`chat-tab-${id}`} hidden={view !== "chat"}>
        {chatOpened && <Suspense fallback={<p className="tap-chat-empty" role="status">{t("loading")}</p>}>
          <Conversation sessionId={id} stream={model.stream} context={context} run={model.run} chatSize={defaults.chatSize}
            scope={`${model.user?.id}:${model.deviceId}`} changes={model.transcripts}
            incremental={model.device?.capabilities.includes("terminal.transcript.incremental") ?? false}
            active={active && view === "chat"} supported={supported} onTerminal={() => choose("terminal")} onReconnect={model.reconnect} t={t} />
        </Suspense>}
      </div>
    </div>
    <div className="tap-dock">
      {showKeys && <KeyBar key={id} disabled={disabled} modifiers={modifiers} onModifiers={setModifiers} t={t} onKey={(key) => {
        if (terminal.current?.key(key, modifiers)) clearModifiers();
      }} />}
      <div ref={composer} hidden={nativeOpen}>
      <Composer key={`${model.user?.id}:${model.deviceId}:${id}`} storageKey={JSON.stringify(["cli-manager.tap.draft", model.user?.id, model.deviceId, id])}
        disabled={disabled || nativeOpen} blocked={blocked} phone={phone} cli={agent} modifiers={modifiers} clearModifiers={clearModifiers}
        completion={{ enabled: view === "chat" && !nativeOpen && (project?.source === "claude" || project?.source === "codex"),
          source: project?.source ?? "", ...context, capabilities: model.device?.capabilities ?? [], run: model.run }}
        onPresence={(focused, drafting) => setWriting(focused && drafting)}
        onCharacter={(text) => model.input(id, text)}
        onCommand={openCommand}
        onSend={async (text) => {
          if (!viewMounted.current || currentView.current.scope !== inputScope || currentView.current.disabled || currentView.current.nativeOpen) return false;
          // The terminal stays mounted in chat mode, so paste still reads the real CLI modes.
          const accepted = await (terminal.current?.message(text) ?? Promise.resolve(false));
          if (accepted) { clearTimeout(later.current); later.current = setTimeout(git.refresh, 8000); }
          if (accepted && currentChat() && /^\s*\/(?:[a-z][\w:-]*)?(?:\s|$)/i.test(text)) {
            // Keep native interactive results in the conversation page and preserve the saved view.
            flushSync(() => setNativeScope(inputScope));
            terminal.current?.focus();
          }
          return accepted;
        }}
        onInterrupt={() => model.input(id, project?.source === "claude" || project?.source === "codex" ? "\x1b" : "\x03")}
        onDirect={() => { flushSync(() => choose("terminal")); terminal.current?.focus(); }}
        onImage={async (file) => {
          const upload = await prepareWebImage(file);
          const result = await model.run("terminal.attach_image", { sessionId: id, ...upload });
          if (!result || typeof result !== "object" || Array.isArray(result)
            || result.delivery !== "browser_paste" || result.sessionId !== id || typeof result.pasteText !== "string") throw new Error("image_bridge_upgrade_required");
          return result.pasteText;
        }} t={t} />
      </div>
      <DockStatus linkOk={linkOk} size={terminalVisible ? info.size : undefined} project={project?.name ?? ""} git={git} phone={phone}
        onReconnect={model.reconnect} onFiles={() => onPanel("files")} onChanges={() => onPanel("changes")} t={t} />
    </div>
  </section>;
}
