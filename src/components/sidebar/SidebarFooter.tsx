import { ThemeToggle } from "../ThemeToggle";
import { BarChart3, Settings, Terminal, TerminalSquare } from "../icons";
import { SyncStatusIndicator } from "./SyncStatusIndicator";

interface SidebarFooterProps {
  collapsed: boolean;
  useExternalTerminal: boolean;
  compactModeEnabled: boolean;
  onToggleExternalTerminal: () => void;
  onToggleCompactMode: () => void;
  onOpenStats?: () => void;
  onOpenSettings: () => void;
}

export function SidebarFooter({
  collapsed,
  useExternalTerminal,
  compactModeEnabled,
  onToggleExternalTerminal,
  onToggleCompactMode,
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
          <button
            onClick={onToggleCompactMode}
            className="ui-focus-ring ui-icon-action"
            data-active={compactModeEnabled ? "true" : "false"}
            title={compactModeEnabled ? "已启用精简模式" : "已禁用精简模式"}
            aria-label={compactModeEnabled ? "关闭精简模式" : "开启精简模式"}
            aria-pressed={compactModeEnabled}
          >
            <TerminalSquare size={14} strokeWidth={1.5} />
          </button>
          <SyncStatusIndicator collapsed onOpenSettings={onOpenSettings} />
        </div>
      </div>
    );
  }

  return (
    <div className={collapsed ? "px-2 py-2" : "px-2.5 py-2.5"}>
      <div className="flex items-center justify-between gap-2">
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
      <div className="ui-sidebar-footer-card mt-3 flex items-center justify-between gap-3 px-3 py-2.5">
        <div className="text-xs font-semibold text-on-surface">外部终端</div>
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
      <div className="ui-sidebar-footer-card mt-2 flex items-start justify-between gap-3 px-3 py-2.5">
        <div>
          <div className="flex items-center gap-2">
            <div className="text-xs font-semibold text-on-surface">精简模式</div>
            <span className="ui-primary-gradient rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-[0.08em]">
              NEW
            </span>
          </div>
        </div>
        <button
          className="switch ui-focus-ring mt-0.5"
          data-on={compactModeEnabled ? "true" : "false"}
          onClick={onToggleCompactMode}
          title="隐藏右侧内嵌终端，仅保留左侧启动器"
          aria-label={compactModeEnabled ? "关闭精简模式" : "开启精简模式"}
          aria-pressed={compactModeEnabled}
        >
          <span className="switch-thumb" />
        </button>
      </div>
      <div className="mt-2">
        <SyncStatusIndicator onOpenSettings={onOpenSettings} />
      </div>
    </div>
  );
}
