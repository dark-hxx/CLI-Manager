import { ThemeToggle } from "../ThemeToggle";
import { BarChart3, Settings, Terminal } from "../icons";

interface SidebarFooterProps {
  collapsed: boolean;
  useExternalTerminal: boolean;
  onToggleExternalTerminal: () => void;
  onOpenStats?: () => void;
  onOpenSettings: () => void;
}

export function SidebarFooter({
  collapsed,
  useExternalTerminal,
  onToggleExternalTerminal,
  onOpenStats,
  onOpenSettings,
}: SidebarFooterProps) {
  if (collapsed) {
    return (
      <div className="border-t border-border px-2 py-2">
        <div className="flex flex-col items-center gap-1.5">
          <button
            onClick={onOpenStats}
            className="flex h-7 w-7 items-center justify-center rounded-md bg-bg-tertiary text-text-muted transition-opacity hover:opacity-80"
            title="分析看板"
          >
            <BarChart3 size={14} strokeWidth={1.5} />
          </button>
          <button
            onClick={onOpenSettings}
            className="flex h-7 w-7 items-center justify-center rounded-md bg-bg-tertiary text-text-muted transition-opacity hover:opacity-80"
            title="设置"
          >
            <Settings size={14} strokeWidth={1.5} />
          </button>
          <button
            onClick={onToggleExternalTerminal}
            className={`flex h-7 w-7 items-center justify-center rounded-md transition-opacity hover:opacity-80 ${
              useExternalTerminal
                ? "bg-accent text-white"
                : "bg-bg-tertiary text-text-muted"
            }`}
            title={useExternalTerminal ? "已启用外部终端" : "已禁用外部终端"}
          >
            <Terminal size={14} strokeWidth={1.5} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="border-t border-border px-3 py-2">
      <div className="flex items-center justify-between">
        <ThemeToggle />
        <div className="flex items-center gap-1.5">
          <button
            onClick={onOpenStats}
            className="flex h-7 w-7 items-center justify-center rounded-md bg-bg-tertiary text-text-muted transition-opacity hover:opacity-80"
            title="分析看板"
          >
            <BarChart3 size={14} strokeWidth={1.5} />
          </button>
          <button
            onClick={onOpenSettings}
            className="flex h-7 w-7 items-center justify-center rounded-md bg-bg-tertiary text-text-muted transition-opacity hover:opacity-80"
            title="设置"
          >
            <Settings size={14} strokeWidth={1.5} />
          </button>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between">
        <span className="text-xs text-text-muted">外部终端</span>
        <button
          className="switch"
          data-on={useExternalTerminal ? "true" : "false"}
          onClick={onToggleExternalTerminal}
          title="使用 Windows Terminal 打开"
        >
          <span className="switch-thumb" />
        </button>
      </div>
    </div>
  );
}
