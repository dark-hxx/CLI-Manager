import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useCommandHistoryStore } from "../stores/commandHistoryStore";
import { useTerminalStore } from "../stores/terminalStore";
import { Clock, Search } from "./icons";
import { Portal } from "./ui/Portal";
import { EmptyState } from "./ui/EmptyState";
import { Skeleton } from "./ui/Skeleton";
import { toast } from "sonner";
import { logError } from "../lib/logger";

interface PanelPosition {
  left: number;
  top: number;
}

interface CommandHistoryPanelProps {
  compact?: boolean;
}

export function CommandHistoryPanel({ compact = false }: CommandHistoryPanelProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [panelLoading, setPanelLoading] = useState(false);
  const [panelPosition, setPanelPosition] = useState<PanelPosition>({ left: 0, top: 0 });
  const { entries, searchQuery, setSearchQuery, fetchAll } = useCommandHistoryStore();
  const activeSessionId = useTerminalStore((s) => s.activeSessionId);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const panelWidth = 320;
    const estimatedHeight = 320;
    const nextLeft = Math.max(8, Math.min(rect.right - panelWidth, window.innerWidth - panelWidth - 8));
    const preferredTop = rect.bottom + 6;
    const nextTop = preferredTop + estimatedHeight <= window.innerHeight - 8
      ? preferredTop
      : Math.max(8, rect.top - estimatedHeight - 6);

    setPanelPosition({ left: nextLeft, top: nextTop });
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPanelLoading(true);
    updatePosition();
    void Promise.all([
      fetchAll(),
      new Promise<void>((resolve) => {
        setTimeout(resolve, 180);
      }),
    ]).finally(() => {
      if (!cancelled) setPanelLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [open, fetchAll, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const reposition = () => updatePosition();
    document.addEventListener("mousedown", handler);
    document.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [open, updatePosition]);

  const handleReplay = async (command: string) => {
    if (!activeSessionId) {
      toast.error("当前无活跃终端");
      return;
    }
    try {
      await invoke("pty_write", { sessionId: activeSessionId, data: command + "\r" });
      setOpen(false);
    } catch (err) {
      toast.error("重放命令失败", { description: String(err) });
      logError("Failed to replay command history", {
        sessionId: activeSessionId,
        command,
        err,
      });
    }
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
    <>
      <button
        ref={triggerRef}
        onClick={() => setOpen((prev) => !prev)}
        className={compact ? "ui-focus-ring ui-icon-action" : "ui-flat-action text-xs"}
        data-active={open ? "true" : "false"}
        title="命令历史"
        aria-label={open ? "关闭命令历史面板" : "打开命令历史面板"}
        aria-controls="command-history-panel"
        aria-expanded={open}
      >
        <Clock size={14} strokeWidth={1.5} />
        {!compact && <span>命令历史</span>}
      </button>

      {open && (
        <Portal>
          <div
            ref={panelRef}
            id="command-history-panel"
            className="ui-glass ui-bloom-shadow fixed z-40 mt-1 w-80 overflow-hidden rounded-xl animate-slide-down"
            style={{ left: panelPosition.left, top: panelPosition.top }}
          >
            <div className="p-2">
              <div className="flex items-center gap-2 rounded-lg bg-surface-container-highest px-2 py-1">
                <Search size={12} strokeWidth={1.5} />
                <input
                  type="text"
                  placeholder="搜索命令..."
                  value={searchQuery}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  className="flex-1 bg-transparent text-xs text-text-primary outline-none"
                  aria-label="搜索命令历史"
                  autoFocus
                />
              </div>
            </div>

            <div className="max-h-64 overflow-y-auto">
              {panelLoading ? (
                <div className="space-y-2 px-3 py-3">
                  {[1, 2, 3, 4].map((item) => (
                    <div key={item} className="space-y-1 pb-2">
                      <Skeleton className="h-3 w-full" />
                      <Skeleton className="h-2.5 w-1/3" />
                    </div>
                  ))}
                </div>
              ) : entries.length === 0 ? (
                <EmptyState
                  icon={<Clock size={20} strokeWidth={1.5} />}
                  title={searchQuery ? "无匹配命令" : "暂无命令历史"}
                  description={searchQuery ? "尝试更短关键词重新搜索。" : "先在终端执行一条命令，历史会自动记录。"}
                  className="px-3 py-6"
                />
              ) : (
                entries.map((entry) => (
                  <button
                    key={entry.id}
                    onClick={() => {
                      void handleReplay(entry.command);
                    }}
                    className="ui-interactive flex w-full items-start gap-2 px-3 py-1.5 text-left text-xs text-on-surface-variant"
                    title="点击重放此命令"
                  >
                    <code className="flex-1 truncate font-mono text-text-primary">{entry.command}</code>
                    <span className="shrink-0 text-[10px] text-text-muted">{formatTime(entry.executed_at)}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        </Portal>
      )}
    </>
  );
}
