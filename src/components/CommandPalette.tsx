import { useState, useEffect, useRef, useMemo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { create } from "zustand";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useProjectStore } from "../stores/projectStore";
import { useTemplateStore } from "../stores/templateStore";
import { useTerminalStore } from "../stores/terminalStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useHistoryStore } from "../stores/historyStore";
import { Dialog, DialogOverlay } from "./ui/dialog";
import { Input } from "./ui/input";
import { toast } from "sonner";
import { logError } from "../lib/logger";
import { openWindowsTerminal } from "../lib/externalTerminal";

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

type PaletteRow =
  | { type: "header"; id: string; category: string }
  | { type: "item"; id: string; item: PaletteItem; itemIndex: number };

function fuzzyMatch(text: string, queryLower: string): boolean {
  const lower = text.toLowerCase();
  let qi = 0;
  for (let i = 0; i < lower.length && qi < queryLower.length; i++) {
    if (lower[i] === queryLower[qi]) qi++;
  }
  return qi === queryLower.length;
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
  const viewMode = useSettingsStore((s) => s.viewMode);

  const activeProjectId =
    sessions.find((item) => item.id === activeSessionId)?.projectId ?? null;
  const templates = getTemplatesForContext(activeProjectId, activeSessionId);

  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setSelectedIndex(0);
      fetchTemplates();
    }
  }, [isOpen, fetchTemplates]);

  const items = useMemo<PaletteItem[]>(() => {
    const result: PaletteItem[] = [];

    if (viewMode !== "compact") {
      result.push({
        id: "action:new-terminal",
        label: "新建终端",
        description: "打开新的终端标签",
        category: "操作",
        action: () => createSession(undefined, undefined, "Terminal"),
      });
    }

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

    if (viewMode !== "compact" && activeSessionId) {
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
          if (viewMode === "compact") {
            void openWindowsTerminal([{
              cwd: p.path,
              title: p.cli_tool ? `${p.name} (${p.cli_tool})` : p.name,
              startupCmd: cmd,
              shell: p.shell || undefined,
            }]);
            return;
          }
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

    if (viewMode !== "compact") {
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
    }

    return result;
  }, [projects, templates, activeSessionId, splits, resolvedTheme, createSession, splitTerminal, unsplitTerminal, setTheme, viewMode]);

  const queryLower = useMemo(() => query.trim().toLowerCase(), [query]);

  const filtered = useMemo(() => {
    if (!queryLower) return items;
    return items.filter(
      (item) => fuzzyMatch(item.label, queryLower) || (item.description && fuzzyMatch(item.description, queryLower)),
    );
  }, [items, queryLower]);

  const paletteRows = useMemo<PaletteRow[]>(() => {
    const rows: PaletteRow[] = [];
    let lastCategory = "";
    filtered.forEach((item, itemIndex) => {
      if (item.category !== lastCategory) {
        rows.push({ type: "header", id: `header:${item.category}:${itemIndex}`, category: item.category });
        lastCategory = item.category;
      }
      rows.push({ type: "item", id: item.id, item, itemIndex });
    });
    return rows;
  }, [filtered]);

  const selectedRowIndex = useMemo(
    () => paletteRows.findIndex((row) => row.type === "item" && row.itemIndex === selectedIndex),
    [paletteRows, selectedIndex]
  );

  const rowVirtualizer = useVirtualizer({
    count: paletteRows.length,
    getScrollElement: () => listRef.current,
    estimateSize: (index) => (paletteRows[index]?.type === "header" ? 36 : 40),
    overscan: 8,
    getItemKey: (index) => paletteRows[index]?.id ?? index,
  });

  useEffect(() => {
    if (selectedIndex >= filtered.length) setSelectedIndex(Math.max(0, filtered.length - 1));
  }, [filtered.length, selectedIndex]);

  useEffect(() => {
    if (selectedRowIndex >= 0) rowVirtualizer.scrollToIndex(selectedRowIndex, { align: "auto" });
  }, [rowVirtualizer, selectedRowIndex]);

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
    }
  };

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogOverlay />
        <DialogPrimitive.Content
          className="ui-surface-card fixed inset-x-4 top-[15vh] z-50 mx-auto w-auto max-w-lg overflow-hidden p-0 outline-none data-[state=open]:animate-scale-in data-[state=closed]:animate-scale-out"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            requestAnimationFrame(() => inputRef.current?.focus());
          }}
        >
          <DialogPrimitive.Title className="sr-only">命令面板</DialogPrimitive.Title>
          <div className="border-b border-border p-3">
            <Input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => { setQuery(e.target.value); setSelectedIndex(0); }}
              onKeyDown={handleKeyDown}
              placeholder="输入命令或搜索项目..."
              className="h-9 text-sm"
            />
          </div>
          <div ref={listRef} className="max-h-80 overflow-y-auto p-2">
            {filtered.length === 0 && (
              <div className="px-3 py-8 text-center text-xs text-on-surface-variant">
                无匹配结果
              </div>
            )}
            {filtered.length > 0 && (
              <div className="relative w-full" style={{ height: rowVirtualizer.getTotalSize() }}>
                {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                  const row = paletteRows[virtualRow.index];
                  if (!row) return null;
                  return (
                    <div
                      key={virtualRow.key}
                      className="absolute left-0 top-0 w-full"
                      style={{
                        height: virtualRow.size,
                        transform: `translateY(${virtualRow.start}px)`,
                      }}
                    >
                      {row.type === "header" ? (
                        <div className="rounded-md border border-border/60 bg-surface-container-high px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-on-surface">
                          {row.category}
                        </div>
                      ) : (
                        <div
                          data-idx={row.itemIndex}
                          data-selected={row.itemIndex === selectedIndex}
                          className="ui-interactive flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-xs text-on-surface-variant"
                          onMouseEnter={() => setSelectedIndex(row.itemIndex)}
                          onClick={() => { close(); row.item.action(); }}
                        >
                          <span className="min-w-0 flex-1 truncate font-medium text-on-surface">{row.item.label}</span>
                          {row.item.description && (
                            <span className="ml-auto max-w-[45%] truncate text-[10px] text-on-surface-variant">
                              {row.item.description}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </Dialog>
  );
}
