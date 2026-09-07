import type { CSSProperties, ReactNode, RefObject } from "react";
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy } from "@dnd-kit/sortable";
import type { CliToolIconKey } from "../../lib/cliTools";
import { WORKSPAN_DRAG_PREFIX } from "../../lib/dragInteraction";
import type { WorkspanTabBarPosition } from "../../lib/workspaceLayout";
import type { TerminalSession } from "../../lib/types";
import type { TabNotificationState } from "../../stores/terminalStore";
import type { TerminalWorkspan } from "../../stores/terminalWorkspan";
import { useI18n } from "../../lib/i18n";
import { PULSING_TAB_STATES, TAB_NOTIFICATION_COLORS } from "../terminal/terminalTabVisuals";
import { ChevronDown, Terminal, X } from "../icons";
import { VendorIcon, type VendorKey } from "../VendorIcon";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

export const WORKSPAN_TABBAR_END_DROP_ID = "workspan-tabbar:end";

export interface WorkspanTabModel {
  workspan: TerminalWorkspan;
  sessionIds: string[];
  closeSessionIds: string[];
  singleSession: TerminalSession | null;
  title: string;
  notification: TabNotificationState;
  vendor: VendorKey | null;
  cliToolIcon: CliToolIconKey | null;
}

export interface WorkspanTabOverflowState {
  isOverflowing: boolean;
  hiddenIds: string[];
}

interface WorkspanTabBarProps {
  position: WorkspanTabBarPosition;
  models: readonly WorkspanTabModel[];
  overflow: WorkspanTabOverflowState;
  listOpen: boolean;
  activeWorkspanId: string | null;
  hasScopedTerminalFilter: boolean;
  menuStyle: CSSProperties;
  tabBarRef: RefObject<HTMLDivElement | null>;
  tabScrollRef: RefObject<HTMLDivElement | null>;
  detachPreview: { left: number; visible: boolean };
  onToggleList: (open: boolean) => void;
  onActivate: (workspanId: string) => void;
  onClose: (model: WorkspanTabModel, anchor?: DOMRect) => void;
  renderTab: (model: WorkspanTabModel, index: number) => ReactNode;
}

function WorkspanTabbarEndDropTarget({ disabled }: { disabled: boolean }) {
  const { setNodeRef } = useDroppable({ id: WORKSPAN_TABBAR_END_DROP_ID, disabled });
  return <div ref={setNodeRef} className="h-full min-w-0 flex-1" aria-hidden="true" />;
}

export function WorkspanTabBar({
  position,
  models,
  overflow,
  listOpen,
  activeWorkspanId,
  hasScopedTerminalFilter,
  menuStyle,
  tabBarRef,
  tabScrollRef,
  detachPreview,
  onToggleList,
  onActivate,
  onClose,
  renderTab,
}: WorkspanTabBarProps) {
  const { t } = useI18n();
  const hiddenIds = new Set(overflow.hiddenIds);
  const hiddenModels = models.filter(({ workspan }) => hiddenIds.has(workspan.id));

  return (
    <div
      ref={tabBarRef}
      className="ui-terminal-pane-chrome ui-workspan-tabbar relative flex h-9 shrink-0 items-center px-1"
      data-workspan-tabbar-position={position}
    >
      <div
        className="ui-workspan-detach-insertion"
        data-visible={detachPreview.visible ? "true" : "false"}
        style={{ transform: `translate3d(${detachPreview.left}px, -50%, 0)` }}
        aria-hidden="true"
      />
      <div
        ref={tabScrollRef}
        className="ui-workspan-tab-scroll flex h-full min-w-0 flex-1 items-center overflow-x-auto"
        role="tablist"
        aria-label={t("terminal.workspan.tabList")}
        onWheel={(event) => {
          if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
          event.currentTarget.scrollLeft += event.deltaY;
          event.preventDefault();
        }}
      >
        <SortableContext
          items={models.map(({ workspan }) => `${WORKSPAN_DRAG_PREFIX}${workspan.id}`)}
          strategy={horizontalListSortingStrategy}
        >
          {models.map((model, index) => renderTab(model, index))}
        </SortableContext>
        <WorkspanTabbarEndDropTarget disabled={hasScopedTerminalFilter} />
      </div>
      {overflow.isOverflowing && (
        <Popover open={listOpen} onOpenChange={onToggleList}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="ui-terminal-tab-list-button"
              aria-label={t("terminal.workspan.openList")}
              aria-expanded={listOpen}
              title={t("terminal.workspan.list")}
            >
              <ChevronDown size={14} strokeWidth={1.8} aria-hidden="true" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            side={position === "bottom" ? "top" : "bottom"}
            align="end"
            collisionPadding={8}
            className="terminal-skin ui-terminal-tab-list-popover w-72 p-1.5"
            style={menuStyle}
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => event.preventDefault()}
          >
            <div className="ui-terminal-tab-list-title px-2 py-1 text-[11px] font-semibold">
              {t("terminal.workspan.tabs")}
            </div>
            <div className="max-h-72 overflow-y-auto">
              {hiddenModels.map((model) => (
                <div
                  key={model.workspan.id}
                  className="ui-interactive ui-terminal-tab-list-item flex w-full items-center gap-1 rounded-lg px-1 py-1 text-xs text-on-surface-variant"
                  data-selected={model.workspan.id === activeWorkspanId ? "true" : "false"}
                >
                  <button
                    type="button"
                    className="ui-focus-ring flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left"
                    onClick={() => {
                      onActivate(model.workspan.id);
                      onToggleList(false);
                    }}
                    title={model.title}
                  >
                    <span
                      className="ui-tab-runtime-dot h-2 w-2 shrink-0 rounded-full"
                      data-pulsing={PULSING_TAB_STATES.has(model.notification) ? "true" : "false"}
                      style={{ backgroundColor: TAB_NOTIFICATION_COLORS[model.notification], color: TAB_NOTIFICATION_COLORS[model.notification] }}
                      aria-hidden="true"
                    />
                    {model.vendor ? (
                      <span className="inline-flex shrink-0 items-center" aria-hidden="true">
                        <VendorIcon vendor={model.vendor} size={14} />
                      </span>
                    ) : (
                      <Terminal size={14} strokeWidth={1.8} className="shrink-0" aria-hidden="true" />
                    )}
                    <span className="min-w-0 flex-1 truncate">{model.title}</span>
                  </button>
                  <button
                    type="button"
                    className="ui-focus-ring ui-terminal-tab-close inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
                    onClick={(event) => {
                      event.stopPropagation();
                      onToggleList(false);
                      onClose(model, event.currentTarget.getBoundingClientRect());
                    }}
                    aria-label={t("terminal.workspan.close", { title: model.title })}
                    title={t("terminal.workspan.close", { title: model.title })}
                  >
                    <X size={13} strokeWidth={2} aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
