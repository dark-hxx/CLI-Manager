import { useEffect, useState, useRef, type MouseEvent as ReactMouseEvent } from "react";
import { useTerminalStore } from "../stores/terminalStore";
import { useSettingsStore } from "../stores/settingsStore";
import { XTermTerminal } from "./XTermTerminal";
import { openWindowsTerminal } from "../lib/externalTerminal";

function IconTerminal() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <path d="M5 6.5L7 8L5 9.5" />
      <path d="M8.5 9.5H11" />
    </svg>
  );
}

function IconPlus() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 3V13M3 8H13" />
    </svg>
  );
}

export function TerminalTabs() {
  const { sessions, activeSessionId, setActive, closeSession, createSession } = useTerminalStore();
  const useExternalTerminal = useSettingsStore((s) => s.useExternalTerminal);
  const [contextMenu, setContextMenu] = useState<null | { sessionId: string; x: number; y: number }>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);

  const handleNewTab = async () => {
    if (useExternalTerminal) {
      await openWindowsTerminal([{ title: "Terminal" }]);
      return;
    }
    await createSession(undefined, undefined, "Terminal");
  };

  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e: Event) => {
      if (contextMenuRef.current && contextMenuRef.current.contains(e.target as Node)) return;
      setContextMenu(null);
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setContextMenu(null);
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("scroll", handler, true);
    window.addEventListener("resize", handler);
    window.addEventListener("keydown", keyHandler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("scroll", handler, true);
      window.removeEventListener("resize", handler);
      window.removeEventListener("keydown", keyHandler);
    };
  }, [contextMenu]);

  const handleContextMenu = (e: ReactMouseEvent, sessionId: string) => {
    e.preventDefault();
    setActive(sessionId);
    setContextMenu({ sessionId, x: e.clientX, y: e.clientY });
  };

  const handleCloseOthers = (sessionId: string) => {
    sessions.filter((s) => s.id !== sessionId).forEach((s) => closeSession(s.id));
  };

  const menuX = contextMenu ? Math.min(contextMenu.x, window.innerWidth - 180) : 0;
  const menuY = contextMenu ? Math.min(contextMenu.y, window.innerHeight - 200) : 0;

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <div
        className="flex items-center h-9 border-b overflow-x-auto"
        style={{ backgroundColor: "var(--bg-secondary)", borderColor: "var(--border)" }}
      >
        {sessions.map((s) => (
          <div
            key={s.id}
            className="flex items-center gap-2 px-3 h-full text-[11px] font-medium cursor-pointer border-r shrink-0"
            style={{
              borderColor: "var(--border)",
              backgroundColor: s.id === activeSessionId ? "var(--bg-primary)" : "transparent",
              color: s.id === activeSessionId ? "var(--text-primary)" : "var(--text-muted)",
            }}
            onClick={() => setActive(s.id)}
            onContextMenu={(e) => handleContextMenu(e, s.id)}
          >
            <span className="truncate max-w-[140px] tracking-wide">{s.title}</span>
            <button
              onClick={(e) => { e.stopPropagation(); closeSession(s.id); }}
              className="ml-1 inline-flex items-center justify-center w-4 h-4 rounded border opacity-60 hover:opacity-100 transition-opacity"
              style={{ color: "var(--text-muted)", borderColor: "var(--border)" }}
            >
              &times;
            </button>
          </div>
        ))}
        <button
          onClick={handleNewTab}
          className="ml-2 mr-2 flex items-center gap-1.5 px-2.5 h-6 rounded-md text-xs border hover:opacity-100 transition-opacity"
          style={{ color: "var(--text-muted)", borderColor: "var(--border)", backgroundColor: "var(--bg-tertiary)", opacity: 0.9 }}
          title="New terminal"
        >
          <IconPlus />
          <IconTerminal />
          <span>New</span>
        </button>
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div className="context-menu" style={{ left: menuX, top: menuY }} ref={contextMenuRef}>
          <button
            className="context-menu-item"
            onClick={() => { closeSession(contextMenu.sessionId); setContextMenu(null); }}
          >
            关闭终端
          </button>
          <button
            className="context-menu-item"
            onClick={() => { handleCloseOthers(contextMenu.sessionId); setContextMenu(null); }}
          >
            关闭其它终端
          </button>
          <button
            className="context-menu-item"
            onClick={() => { handleNewTab(); setContextMenu(null); }}
          >
            新建终端
          </button>
        </div>
      )}

      {/* Terminal panel */}
      <div className="flex-1 relative">
        {sessions.map((s) => (
          <div
            key={s.id}
            className="absolute inset-0"
            style={{ display: s.id === activeSessionId ? "block" : "none" }}
          >
            <XTermTerminal sessionId={s.id} />
          </div>
        ))}
        {sessions.length === 0 && !useExternalTerminal && (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <div className="flex items-center justify-center mb-2" style={{ color: "var(--text-muted)" }}>
                <IconTerminal />
              </div>
              <p className="text-sm mb-2" style={{ color: "var(--text-muted)" }}>No active terminals</p>
              <button
                onClick={handleNewTab}
                className="inline-flex items-center gap-2 text-sm px-3 py-1.5 rounded"
                style={{ backgroundColor: "var(--accent)", color: "#fff" }}
              >
                <IconTerminal />
                Open Terminal
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
