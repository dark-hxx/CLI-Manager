import type { MouseEventHandler, ReactNode } from "react";
import { TERM_PANEL, panelColorTint } from "../stats/termStatsUi";

interface TerminalPanelHeaderProps {
  icon: ReactNode;
  accent: string;
  title: ReactNode;
  subtitle?: ReactNode;
  subtitleTitle?: string;
  titleAccessory?: ReactNode;
  actions?: ReactNode;
  onTitleDoubleClick?: MouseEventHandler<HTMLDivElement>;
}

export function TerminalPanelHeader({
  icon,
  accent,
  title,
  subtitle,
  subtitleTitle,
  titleAccessory,
  actions,
  onTitleDoubleClick,
}: TerminalPanelHeaderProps) {
  return (
    <header
      className="ui-terminal-panel-header flex h-9 shrink-0 items-center justify-between gap-2 border-b px-2 font-mono"
      style={{ backgroundColor: TERM_PANEL.bg, borderColor: TERM_PANEL.border }}
    >
      <div className="flex min-w-0 items-center gap-2" onDoubleClick={onTitleDoubleClick}>
        <span
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border"
          style={{
            color: accent,
            borderColor: panelColorTint(accent, 30, TERM_PANEL.border),
            backgroundColor: panelColorTint(accent, 9, TERM_PANEL.bg),
          }}
        >
          {icon}
        </span>
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[12px] font-bold leading-4" style={{ color: TERM_PANEL.fg }}>
              {title}
            </span>
            {titleAccessory}
          </div>
          {subtitle ? (
            <div className="truncate text-[9px] leading-3" style={{ color: TERM_PANEL.dim }} title={subtitleTitle}>
              {subtitle}
            </div>
          ) : null}
        </div>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
    </header>
  );
}
