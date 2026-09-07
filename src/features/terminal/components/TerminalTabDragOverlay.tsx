import { type CSSProperties } from "react";
import { DragOverlay, useDndContext } from "@dnd-kit/core";
import { type TabNotificationState } from "../../../stores/terminalStore";
import { PULSING_TAB_STATES, TAB_NOTIFICATION_COLORS } from "../../../components/terminal/terminalTabVisuals";
import { type CliToolIconKey } from "../../../lib/cliTools";
import { X } from "../../../components/icons";
import { VendorIcon, type VendorKey } from "../../../components/VendorIcon";
import { CliToolIcon } from "../../../components/CliToolIcon";
import { Portal } from "../../../components/ui/Portal";

export function DragOverlayTab({
  title,
  notification,
  vendor,
  cliToolIcon,
}: {
  title: string;
  notification: TabNotificationState;
  vendor?: VendorKey | null;
  cliToolIcon?: CliToolIconKey | null;
}) {
  const tabMinWidthClass = "min-w-[92px]";

  return (
    <div
      className={`ui-tab-trigger ui-terminal-tab-item ui-terminal-drag-overlay-tab mx-1 flex h-7 ${tabMinWidthClass} max-w-[180px] items-center gap-2 rounded-lg px-3 text-[12px] font-medium`}
      data-selected="true"
    >
      <span
        className="ui-tab-runtime-dot w-2 h-2 rounded-full shrink-0"
        data-pulsing={PULSING_TAB_STATES.has(notification) ? "true" : "false"}
        style={{ backgroundColor: TAB_NOTIFICATION_COLORS[notification], color: TAB_NOTIFICATION_COLORS[notification] }}
        aria-hidden="true"
      />
      {vendor ? (
        <span className="ui-terminal-tab-vendor inline-flex shrink-0 items-center" aria-hidden="true">
          <VendorIcon vendor={vendor} size={14} />
        </span>
      ) : cliToolIcon ? (
        <span className="ui-terminal-tab-vendor inline-flex shrink-0 items-center" aria-hidden="true">
          <CliToolIcon icon={cliToolIcon} size={14} className="text-current" />
        </span>
      ) : null}
      <span className="ui-terminal-tab-title min-w-0 flex-1 truncate tracking-[0.01em]">{title}</span>
      <span
        className="ui-terminal-tab-close ml-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-on-surface-variant"
        aria-hidden="true"
      >
        <X size={13} strokeWidth={2.2} />
      </span>
    </div>
  );
}

export interface TerminalDragOverlayData {
  type: "session" | "workspan";
  overlay: {
    title: string;
    notification: TabNotificationState;
    vendor?: VendorKey | null;
    cliToolIcon?: CliToolIconKey | null;
  };
}

export function TerminalTabDragOverlay({
  style,
  themeTone,
}: {
  style: CSSProperties;
  themeTone: "light" | "dark";
}) {
  const { active } = useDndContext();
  const dragData = active?.data.current as TerminalDragOverlayData | undefined;
  const overlay = dragData?.overlay;

  return (
    <Portal>
      <DragOverlay
        className="ui-terminal-drag-overlay"
        dropAnimation={null}
        style={style}
      >
        {overlay ? (
          <div className="ui-terminal-well ui-terminal-drag-overlay-theme" data-terminal-theme-tone={themeTone}>
            <div className="ui-terminal-pane-chrome ui-terminal-drag-overlay-chrome">
              <DragOverlayTab
                title={overlay.title}
                notification={overlay.notification}
                vendor={overlay.vendor}
                cliToolIcon={overlay.cliToolIcon}
              />
            </div>
          </div>
        ) : null}
      </DragOverlay>
    </Portal>
  );
}
