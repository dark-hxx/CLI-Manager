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
  const statsDisabled = !onOpenStats;

  if (collapsed) {
    return (
      <div className="px-2 py-2">
        <div className="flex flex-col items-center gap-1.5">
          <button
            onClick={onOpenStats}
            className="ui-focus-ring ui-icon-action"
            title="分析看板"
            aria-label="打开分析看板"
            disabled={statsDisabled}
          >
            <BarChart3 size={14} strokeWidth={1.5} />
          </button>
          <button
            onClick={onOpenSettings}
            className="ui-focus-ring ui-icon-action"
            title="设置"
            aria-label="打开设置"
          >
            <Settings size={14} strokeWidth={1.5} />
          </button>
          <button
            onClick={onToggleExternalTerminal}
            className="ui-focus-ring ui-icon-action"
            data-active={useExternalTerminal ? "true" : "false"}
            title={useExternalTerminal ? "已启用外部终端" : "已禁用外部终端"}
            aria-label={useExternalTerminal ? "关闭外部终端" : "开启外部终端"}
            aria-pressed={useExternalTerminal}
          >
            <Terminal size={14} strokeWidth={1.5} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="px-3 py-2">
      <div className="flex items-center justify-between">
        <ThemeToggle />
        <div className="flex items-center gap-1.5">
          <button
            onClick={onOpenStats}
            className="ui-focus-ring ui-icon-action"
            title="分析看板"
            aria-label="打开分析看板"
            disabled={statsDisabled}
          >
            <BarChart3 size={14} strokeWidth={1.5} />
          </button>
          <button
            onClick={onOpenSettings}
            className="ui-focus-ring ui-icon-action"
            title="设置"
            aria-label="打开设置"
          >
            <Settings size={14} strokeWidth={1.5} />
          </button>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between">
        <span className="text-xs text-on-surface-variant">外部终端</span>
        <button
          className="switch ui-focus-ring"
          data-on={useExternalTerminal ? "true" : "false"}
          onClick={onToggleExternalTerminal}
          title="使用 Windows Terminal 打开"
          aria-label={useExternalTerminal ? "关闭外部终端" : "开启外部终端"}
          aria-pressed={useExternalTerminal}
        >
          <span className="switch-thumb" />
        </button>
      </div>
    </div>
  );
}
