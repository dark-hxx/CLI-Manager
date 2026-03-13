import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useCommandHistoryStore } from "../stores/commandHistoryStore";
import { useTerminalStore } from "../stores/terminalStore";

function IconHistory() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5V8L10.5 9.5" />
    </svg>
  );
}

function IconSearch() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" />
    </svg>
  );
}

export function CommandHistoryPanel() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { entries, searchQuery, setSearchQuery, fetchAll } = useCommandHistoryStore();
  const activeSessionId = useTerminalStore((s) => s.activeSessionId);

  useEffect(() => {
    if (open) fetchAll();
  }, [open, fetchAll]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handleReplay = (command: string) => {
    if (!activeSessionId) return;
    invoke("pty_write", { sessionId: activeSessionId, data: command + "\r" }).catch(console.error);
    setOpen(false);
  };

  const handleSearchChange = (q: string) => {
    setSearchQuery(q);
    fetchAll();
  };

  const formatTime = (ts: string) => {
    const d = new Date(Number(ts));
    return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-2.5 h-6 rounded-md text-xs border hover:opacity-100 transition-opacity"
        style={{ color: "var(--text-muted)", borderColor: "var(--border)", backgroundColor: "var(--bg-tertiary)", opacity: 0.9 }}
        title="Command History"
      >
        <IconHistory />
        <span>History</span>
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-1 w-80 rounded-lg border shadow-lg z-50 overflow-hidden"
          style={{ backgroundColor: "var(--bg-secondary)", borderColor: "var(--border)" }}
        >
          <div className="p-2 border-b" style={{ borderColor: "var(--border)" }}>
            <div
              className="flex items-center gap-2 px-2 py-1 rounded border"
              style={{ backgroundColor: "var(--bg-tertiary)", borderColor: "var(--border)" }}
            >
              <IconSearch />
              <input
                type="text"
                placeholder="搜索命令..."
                value={searchQuery}
                onChange={(e) => handleSearchChange(e.target.value)}
                className="flex-1 bg-transparent text-xs outline-none"
                style={{ color: "var(--text-primary)" }}
                autoFocus
              />
            </div>
          </div>

          <div className="max-h-64 overflow-y-auto">
            {entries.length === 0 ? (
              <div className="px-3 py-4 text-center text-xs" style={{ color: "var(--text-muted)" }}>
                {searchQuery ? "无匹配命令" : "暂无命令历史"}
              </div>
            ) : (
              entries.map((entry) => (
                <button
                  key={entry.id}
                  onClick={() => handleReplay(entry.command)}
                  className="w-full text-left px-3 py-1.5 text-xs hover:opacity-80 transition-opacity flex items-start gap-2 border-b"
                  style={{ borderColor: "var(--border)", color: "var(--text-secondary)" }}
                  title="点击重放此命令"
                >
                  <code
                    className="flex-1 truncate font-mono"
                    style={{ color: "var(--text-primary)" }}
                  >
                    {entry.command}
                  </code>
                  <span className="shrink-0 text-[10px]" style={{ color: "var(--text-muted)" }}>
                    {formatTime(entry.executed_at)}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
