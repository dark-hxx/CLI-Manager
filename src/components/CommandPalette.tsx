import { Fragment, useState, useEffect, useRef, useMemo } from "react";
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { useProjectStore } from "../stores/projectStore";
import { useTemplateStore } from "../stores/templateStore";
import { useTerminalStore } from "../stores/terminalStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useHistoryStore } from "../stores/historyStore";
import { toast } from "sonner";
import { logError } from "../lib/logger";

export const useCommandPaletteStore = create<{
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
}>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  toggle: () => set((s) => ({ isOpen: !s.isOpen })),
}));

interface PaletteItem {
  id: string;
  label: string;
  description?: string;
  category: string;
  action: () => void;
}

function fuzzyMatch(text: string, query: string): boolean {
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  let qi = 0;
  for (let i = 0; i < lower.length && qi < q.length; i++) {
    if (lower[i] === q[qi]) qi++;
  }
  return qi === q.length;
}

export function CommandPalette() {
  const { isOpen, close } = useCommandPaletteStore();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const projects = useProjectStore((s) => s.projects);
  const getTemplatesForContext = useTemplateStore((s) => s.getForContext);
  const fetchTemplates = useTemplateStore((s) => s.fetchTemplates);
  const sessions = useTerminalStore((s) => s.sessions);
  const createSession = useTerminalStore((s) => s.createSession);
  const activeSessionId = useTerminalStore((s) => s.activeSessionId);
  const splits = useTerminalStore((s) => s.splits);
  const splitTerminal = useTerminalStore((s) => s.splitTerminal);
  const unsplitTerminal = useTerminalStore((s) => s.unsplitTerminal);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const resolvedTheme = useSettingsStore((s) => s.resolvedTheme);

  const activeProjectId =
    sessions.find((item) => item.id === activeSessionId)?.projectId ?? null;
  const templates = getTemplatesForContext(activeProjectId, activeSessionId);

  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setSelectedIndex(0);
      fetchTemplates();
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [isOpen, fetchTemplates]);

  const items = useMemo<PaletteItem[]>(() => {
    const result: PaletteItem[] = [];

    result.push({
      id: "action:new-terminal",
      label: "新建终端",
      description: "打开新的终端标签",
      category: "操作",
      action: () => createSession(undefined, undefined, "Terminal"),
    });

    result.push({
      id: "action:open-history",
      label: "打开历史会话",
      description: "查看 Claude / Codex 会话历史",
      category: "操作",
      action: () => {
        void useHistoryStore.getState().openHistory();
        useHistoryStore.getState().triggerGlobalSearchFocus();
      },
    });

    if (activeSessionId) {
      const hasSplit = !!splits[activeSessionId];
      if (!hasSplit) {
        result.push({
          id: "action:split-h",
          label: "水平分屏",
          description: "将当前终端左右分割",
          category: "操作",
          action: () => {
            const session = useTerminalStore.getState().sessions.find((s) => s.id === activeSessionId);
            const project = session?.projectId
              ? useProjectStore.getState().projects.find((p) => p.id === session.projectId)
              : undefined;
            splitTerminal(activeSessionId, "horizontal", project?.path, project?.shell);
          },
        });
        result.push({
          id: "action:split-v",
          label: "垂直分屏",
          description: "将当前终端上下分割",
          category: "操作",
          action: () => {
            const session = useTerminalStore.getState().sessions.find((s) => s.id === activeSessionId);
            const project = session?.projectId
              ? useProjectStore.getState().projects.find((p) => p.id === session.projectId)
              : undefined;
            splitTerminal(activeSessionId, "vertical", project?.path, project?.shell);
          },
        });
      } else {
        result.push({
          id: "action:unsplit",
          label: "取消分屏",
          description: "关闭分屏的第二个终端",
          category: "操作",
          action: () => unsplitTerminal(activeSessionId),
        });
      }
    }

    result.push({
      id: "action:toggle-theme",
      label: resolvedTheme === "dark" ? "切换到亮色主题" : "切换到暗色主题",
      category: "操作",
      action: () => setTheme(resolvedTheme === "dark" ? "light" : "dark"),
    });

    for (const p of projects) {
      result.push({
        id: `project:${p.id}`,
        label: p.name,
        description: p.path,
        category: "项目",
        action: () => {
          const cmd = p.startup_cmd || p.cli_tool || undefined;
          const shell = p.shell && p.shell !== "powershell" ? p.shell : undefined;
          let envVars: Record<string, string> | undefined;
          try {
            const parsed = JSON.parse(p.env_vars || "{}");
            if (Object.keys(parsed).length > 0) envVars = parsed;
          } catch { /* ignore */ }
          createSession(
            p.id, p.path,
            p.cli_tool ? `${p.name} (${p.cli_tool})` : p.name,
            cmd, envVars, shell,
          );
        },
      });
    }

    for (const t of templates) {
      result.push({
        id: `template:${t.id}`,
        label: t.name,
        description: t.command,
        category: "命令模板",
        action: () => {
          const sid = useTerminalStore.getState().activeSessionId;
          if (sid) {
            invoke("pty_write", { sessionId: sid, data: t.command + "\r" }).catch((err) => {
              toast.error("执行模板命令失败", { description: String(err) });
              logError("CommandPalette failed to run template", {
                templateId: t.id,
                sessionId: sid,
                err,
              });
            });
          }
        },
      });
    }

    return result;
  }, [projects, templates, activeSessionId, splits, resolvedTheme, createSession, splitTerminal, unsplitTerminal, setTheme]);

  const filtered = useMemo(() => {
    if (!query.trim()) return items;
    return items.filter(
      (item) => fuzzyMatch(item.label, query) || (item.description && fuzzyMatch(item.description, query)),
    );
  }, [items, query]);

  useEffect(() => {
    if (selectedIndex >= filtered.length) setSelectedIndex(Math.max(0, filtered.length - 1));
  }, [filtered.length, selectedIndex]);

  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector(`[data-idx="${selectedIndex}"]`) as HTMLElement;
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = filtered[selectedIndex];
      if (item) { close(); item.action(); }
    } else if (e.key === "Escape") {
      close();
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]"
      style={{ backgroundColor: "rgba(0,0,0,0.4)", animation: "fade-in var(--animate-duration-fast) ease-out" }}
      onClick={(e) => { if (e.target === e.currentTarget) close(); }}
    >
      <div
        className="w-full max-w-lg rounded-lg border shadow-2xl overflow-hidden"
        style={{ backgroundColor: "var(--bg-secondary)", borderColor: "var(--border)", animation: "scale-in var(--animate-duration-normal) ease-out" }}
      >
        <div className="p-3 border-b" style={{ borderColor: "var(--border)" }}>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSelectedIndex(0); }}
            onKeyDown={handleKeyDown}
            placeholder="输入命令或搜索项目..."
            className="w-full bg-transparent text-sm outline-none"
            style={{ color: "var(--text-primary)" }}
          />
        </div>
        <div ref={listRef} className="max-h-80 overflow-y-auto p-1">
          {filtered.length === 0 && (
            <div className="px-3 py-6 text-center text-xs" style={{ color: "var(--text-muted)" }}>
              无匹配结果
            </div>
          )}
          {filtered.map((item, i) => {
            const showHeader = i === 0 || item.category !== filtered[i - 1].category;
            return (
              <Fragment key={item.id}>
                {showHeader && (
                  <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
                    {item.category}
                  </div>
                )}
                <div
                  data-idx={i}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-md cursor-pointer text-xs"
                  style={{
                    backgroundColor: i === selectedIndex ? "var(--bg-tertiary)" : "transparent",
                    color: i === selectedIndex ? "var(--text-primary)" : "var(--text-secondary)",
                  }}
                  onMouseEnter={() => setSelectedIndex(i)}
                  onClick={() => { close(); item.action(); }}
                >
                  <span className="truncate font-medium">{item.label}</span>
                  {item.description && (
                    <span className="truncate ml-auto text-[10px]" style={{ color: "var(--text-muted)" }}>
                      {item.description}
                    </span>
                  )}
                </div>
              </Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
}
