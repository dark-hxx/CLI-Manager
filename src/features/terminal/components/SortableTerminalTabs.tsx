import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { type TabNotificationState } from "../../../stores/terminalStore";
import { useI18n, type TranslationKey } from "../../../lib/i18n";
import { DND_SORTABLE_TRANSITION, WORKSPAN_DRAG_PREFIX } from "../../../lib/dragInteraction";
import { type TerminalWorkspan } from "../../../stores/terminalWorkspan";
import { PULSING_TAB_STATES, TAB_NOTIFICATION_COLORS } from "../../../components/terminal/terminalTabVisuals";
import { type CliToolIconKey } from "../../../lib/cliTools";
import { Terminal, X, Cloud } from "../../../components/icons";
import { WorktreeIcon } from "../../../components/WorktreeIcon";
import { VendorIcon, type VendorKey } from "../../../components/VendorIcon";
import { CliToolIcon } from "../../../components/CliToolIcon";
import type { TerminalSession, WorktreeRecord } from "../../../lib/types";
import { ContextMenu, ContextMenuTrigger, ContextMenuContent } from "../../../components/ui/context-menu";
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/popover";
import { Portal } from "../../../components/ui/Portal";
import {
  TAB_NOTIFICATION_LABELS, type SplitPickerAnchor, SSH_CONNECTION_STATE_COLORS,
  type TerminalTabHoverInfo,
} from "../lib/terminalTabsModel";
import { useTerminalTabHoverCard } from "../hooks/useTerminalTabHoverCard";
import { TerminalTabHoverCard } from "./TerminalTabHoverCard";

export interface SortableTabProps {
  id: string;
  paneId: string;
  title: string;
  sessionKind: TerminalSession["kind"];
  isActive: boolean;
  isEditing: boolean;
  notification: TabNotificationState;
  vendor?: VendorKey | null;
  cliToolIcon?: CliToolIconKey | null;
  worktree?: WorktreeRecord | null;
  worktreeMenuContent?: (closeMenu: () => void) => ReactNode;
  hoverInfo: TerminalTabHoverInfo;
  onActivate: () => void;
  onClose: (anchor?: SplitPickerAnchor) => void;
  onSubmitEdit: (title: string) => void;
  onCancelEdit: () => void;
  menuContent: (getAnchor: () => SplitPickerAnchor | undefined) => ReactNode;
  menuClassName?: string;
  menuStyle?: CSSProperties;
}

export function SortableTab({
  id,
  paneId,
  title,
  sessionKind,
  isActive,
  isEditing,
  notification,
  vendor,
  cliToolIcon,
  worktree,
  worktreeMenuContent,
  hoverInfo,
  onActivate,
  onClose,
  onSubmitEdit,
  onCancelEdit,
  menuContent,
  menuClassName,
  menuStyle,
}: SortableTabProps) {
  const { t } = useI18n();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    data: {
      type: "session",
      paneId,
      overlay: { title, notification, vendor, cliToolIcon },
    },
    transition: DND_SORTABLE_TRANSITION,
  });
  const tabElementRef = useRef<HTMLDivElement | null>(null);
  const contextMenuPointRef = useRef<SplitPickerAnchor | null>(null);
  const [editValue, setEditValue] = useState(title);
  const editInputRef = useRef<HTMLInputElement | null>(null);
  const skipNextBlurSubmitRef = useRef(false);
  const statusLabel = t(TAB_NOTIFICATION_LABELS[notification]);
  const tabMinWidthClass = "min-w-[92px]";
  const [worktreePopoverOpen, setWorktreePopoverOpen] = useState(false);
  const {
    enabled: terminalTabHoverInfoEnabled,
    hoverCardPosition,
    hideHoverCard,
    keepHoverCardOpen,
    scheduleHideHoverCard,
    scheduleHoverCard,
  } = useTerminalTabHoverCard(tabElementRef, isEditing || isDragging);

  const submitEdit = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed) onSubmitEdit(trimmed);
    else onCancelEdit();
  }, [editValue, onCancelEdit, onSubmitEdit]);

  const cancelEdit = useCallback(() => {
    onCancelEdit();
  }, [onCancelEdit]);

  useEffect(() => {
    if (!isEditing) return;
    setEditValue(title);
    skipNextBlurSubmitRef.current = false;
    window.requestAnimationFrame(() => {
      editInputRef.current?.focus();
      editInputRef.current?.select();
    });
  }, [isEditing, title]);

  const horizontalTransform = transform ? { ...transform, y: 0 } : transform;
  const style = {
    transform: isDragging ? undefined : CSS.Transform.toString(horizontalTransform),
    transition: isDragging ? undefined : transition,
    opacity: isDragging ? 0.45 : 1,
    zIndex: isDragging ? 10 : undefined,
  };

  const setTabNodeRef = useCallback((node: HTMLDivElement | null) => {
    tabElementRef.current = node;
    setNodeRef(node);
  }, [setNodeRef]);

  const getTabAnchor = useCallback(() => contextMenuPointRef.current ?? tabElementRef.current?.getBoundingClientRect(), []);
  const closeWorktreePopover = useCallback(() => setWorktreePopoverOpen(false), []);

  return (
    <>
      <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={setTabNodeRef}
          style={style}
          className={`ui-interactive ui-tab-trigger ui-terminal-tab-item mx-1 flex h-7 ${tabMinWidthClass} max-w-[180px] shrink-0 cursor-pointer items-center gap-2 rounded-lg px-3 text-[12px] font-medium`}
          data-terminal-tab-id={id}
          data-session-kind={sessionKind}
          data-selected={isActive ? "true" : "false"}
          onClick={() => {
            hideHoverCard();
            onActivate();
          }}
          onAuxClick={(event) => {
            if (event.button !== 1 || isEditing || isDragging) return;
            event.preventDefault();
            event.stopPropagation();
            hideHoverCard();
            onClose(event.currentTarget.getBoundingClientRect());
          }}
          onPointerEnter={scheduleHoverCard}
          onPointerLeave={scheduleHideHoverCard}
          onContextMenu={(event) => {
            hideHoverCard();
            contextMenuPointRef.current = { x: event.clientX, y: event.clientY };
          }}
          aria-selected={isActive}
          {...attributes}
          {...listeners}
        >
          <span
            className="ui-tab-runtime-dot w-2 h-2 rounded-full shrink-0"
            data-pulsing={PULSING_TAB_STATES.has(notification) ? "true" : "false"}
            style={{ backgroundColor: TAB_NOTIFICATION_COLORS[notification], color: TAB_NOTIFICATION_COLORS[notification] }}
            role="status"
            aria-label={statusLabel}
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
          {worktree && (
            <Popover open={worktreePopoverOpen} onOpenChange={setWorktreePopoverOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="ui-worktree-tab-badge inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none"
                  title={`${worktree.name}\n${worktree.branch}\n${worktree.path}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    hideHoverCard();
                  }}
                  onPointerDown={(event) => event.stopPropagation()}
                  onDoubleClick={(event) => event.stopPropagation()}
                >
                  <WorktreeIcon className="h-3 w-3" />
                  <span>WT</span>
                </button>
              </PopoverTrigger>
              {worktreeMenuContent && (
                <PopoverContent
                  className="terminal-skin context-menu min-w-[160px] p-1"
                  style={menuStyle}
                  onClick={(event) => event.stopPropagation()}
                  onDoubleClick={(event) => event.stopPropagation()}
                  onPointerDown={(event) => event.stopPropagation()}
                  onPointerMove={(event) => event.stopPropagation()}
                  onPointerUp={(event) => event.stopPropagation()}
                >
                  {worktreeMenuContent(closeWorktreePopover)}
                </PopoverContent>
              )}
            </Popover>
          )}
          {isEditing ? (
            <input
              ref={editInputRef}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              onPointerMove={(e) => e.stopPropagation()}
              onPointerUp={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              onContextMenu={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") {
                  e.preventDefault();
                  skipNextBlurSubmitRef.current = true;
                  submitEdit();
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  skipNextBlurSubmitRef.current = true;
                  cancelEdit();
                }
              }}
              onBlur={() => {
                if (skipNextBlurSubmitRef.current) {
                  skipNextBlurSubmitRef.current = false;
                  return;
                }
                submitEdit();
              }}
              className="ui-input h-5 min-w-0 flex-1 rounded-md px-1.5 py-0 text-[12px] text-on-surface outline-none"
              aria-label={t("terminal.tab.rename")}
            />
          ) : (
            <>
              {hoverInfo.connectionState && (
                <Cloud
                  size={12}
                  strokeWidth={2}
                  className="shrink-0"
                  style={{ color: SSH_CONNECTION_STATE_COLORS[hoverInfo.connectionState] }}
                  aria-label={t(`terminal.ssh.connection.${hoverInfo.connectionState}` as TranslationKey)}
                />
              )}
              <span className="ui-terminal-tab-title min-w-0 flex-1 truncate tracking-[0.01em]">{title}</span>
            </>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); hideHoverCard(); onClose(e.currentTarget.getBoundingClientRect()); }}
            onPointerEnter={hideHoverCard}
            onPointerDown={(e) => { e.stopPropagation(); hideHoverCard(); }}
            onDoubleClick={(e) => e.stopPropagation()}
            className="ui-terminal-tab-close ml-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-on-surface-variant transition-[background-color,color,opacity,box-shadow] hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]"
            aria-label={t("terminal.tab.close", { title })}
            title={t("terminal.tab.close", { title })}
          >
            <X size={13} strokeWidth={2.2} aria-hidden="true" />
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className={menuClassName} style={menuStyle}>{menuContent(getTabAnchor)}</ContextMenuContent>
      </ContextMenu>
      {terminalTabHoverInfoEnabled && hoverCardPosition && !isEditing && !isDragging && (
        <Portal>
          <TerminalTabHoverCard info={hoverInfo} position={hoverCardPosition} themeStyle={menuStyle} onPointerEnter={keepHoverCardOpen} onPointerLeave={scheduleHideHoverCard} />
        </Portal>
      )}
    </>
  );
}

export function SortableWorkspanTab({
  workspan,
  title,
  notification,
  vendor,
  cliToolIcon,
  hoverInfo,
  isActive,
  dragDisabled,
  renameDisabled,
  onActivate,
  onClose,
  onRename,
  menuContent,
  menuStyle,
}: {
  workspan: TerminalWorkspan;
  title: string;
  notification: TabNotificationState;
  vendor?: VendorKey | null;
  cliToolIcon?: CliToolIconKey | null;
  hoverInfo?: TerminalTabHoverInfo;
  isActive: boolean;
  dragDisabled: boolean;
  renameDisabled: boolean;
  onActivate: () => void;
  onClose: (anchor?: SplitPickerAnchor) => void;
  onRename: (title: string) => void;
  menuContent: (getAnchor: () => SplitPickerAnchor | undefined, startRename: () => void) => ReactNode;
  menuStyle?: CSSProperties;
}) {
  const { t } = useI18n();
  const sortableId = `${WORKSPAN_DRAG_PREFIX}${workspan.id}`;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: sortableId,
    disabled: dragDisabled,
    data: {
      type: "workspan",
      workspanId: workspan.id,
      overlay: { title, notification, vendor, cliToolIcon },
    },
    transition: DND_SORTABLE_TRANSITION,
  });
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(title);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const tabElementRef = useRef<HTMLDivElement | null>(null);
  const contextMenuPointRef = useRef<SplitPickerAnchor | null>(null);
  const {
    enabled: terminalTabHoverInfoEnabled,
    hoverCardPosition,
    hideHoverCard,
    keepHoverCardOpen,
    scheduleHideHoverCard,
    scheduleHoverCard,
  } = useTerminalTabHoverCard(tabElementRef, editing || isDragging || !hoverInfo);
  const horizontalTransform = transform ? { ...transform, y: 0 } : transform;
  const style: CSSProperties = {
    transform: isDragging ? undefined : CSS.Transform.toString(horizontalTransform),
    transition: isDragging ? undefined : transition,
    opacity: isDragging ? 0.45 : 1,
    zIndex: isDragging ? 10 : undefined,
  };
  const sortableAttributes = { ...attributes, role: "tab" as const, "aria-selected": isActive };

  useEffect(() => {
    if (!editing) return;
    setEditValue(title);
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [editing, title]);

  const submitRename = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== title) onRename(trimmed);
    setEditing(false);
  }, [editValue, onRename, title]);

  const startRename = useCallback(() => {
    if (!renameDisabled) setEditing(true);
  }, [renameDisabled]);
  const setTabNodeRef = useCallback((node: HTMLDivElement | null) => {
    tabElementRef.current = node;
    setNodeRef(node);
  }, [setNodeRef]);
  const getTabAnchor = useCallback(
    () => contextMenuPointRef.current ?? tabElementRef.current?.getBoundingClientRect(),
    []
  );
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={setTabNodeRef}
            style={style}
            className="ui-interactive ui-tab-trigger ui-terminal-tab-item ui-workspan-tab mx-1 flex h-7 min-w-[104px] max-w-[200px] shrink-0 cursor-pointer items-center gap-2 rounded-lg px-3 text-[12px] font-medium"
            data-workspan-id={workspan.id}
            data-selected={isActive ? "true" : "false"}
            onClick={() => {
              hideHoverCard();
              onActivate();
            }}
            onAuxClick={(event) => {
              if (event.button !== 1 || editing || isDragging) return;
              event.preventDefault();
              event.stopPropagation();
              hideHoverCard();
              onClose(event.currentTarget.getBoundingClientRect());
            }}
            onPointerEnter={scheduleHoverCard}
            onPointerLeave={scheduleHideHoverCard}
            onDoubleClick={(event) => {
              event.stopPropagation();
              startRename();
            }}
            onContextMenu={(event) => {
              hideHoverCard();
              contextMenuPointRef.current = { x: event.clientX, y: event.clientY };
            }}
            {...sortableAttributes}
            {...listeners}
          >
            <span
              className="ui-tab-runtime-dot h-2 w-2 shrink-0 rounded-full"
              data-pulsing={PULSING_TAB_STATES.has(notification) ? "true" : "false"}
              style={{ backgroundColor: TAB_NOTIFICATION_COLORS[notification], color: TAB_NOTIFICATION_COLORS[notification] }}
              aria-label={t(TAB_NOTIFICATION_LABELS[notification])}
              role="status"
            />
            {vendor ? (
              <span className="ui-terminal-tab-vendor inline-flex shrink-0 items-center" aria-hidden="true">
                <VendorIcon vendor={vendor} size={14} />
              </span>
            ) : cliToolIcon ? (
              <span className="ui-terminal-tab-vendor inline-flex shrink-0 items-center" aria-hidden="true">
                <CliToolIcon icon={cliToolIcon} size={14} className="text-current" />
              </span>
            ) : (
              <Terminal size={14} strokeWidth={1.8} aria-hidden="true" />
            )}
            {editing ? (
              <input
                ref={inputRef}
                value={editValue}
                onChange={(event) => setEditValue(event.target.value)}
                onClick={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                onContextMenu={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === "Enter") submitRename();
                  if (event.key === "Escape") setEditing(false);
                }}
                onBlur={submitRename}
                className="ui-input h-5 min-w-0 flex-1 rounded-md px-1.5 py-0 text-[12px] text-on-surface outline-none"
                aria-label={t("terminal.tab.rename")}
              />
            ) : (
              <span className="ui-terminal-tab-title min-w-0 flex-1 truncate tracking-[0.01em]">{title}</span>
            )}
            <button
              type="button"
              className="ui-terminal-tab-close ml-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-on-surface-variant transition-[background-color,color,opacity,box-shadow] hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]"
              onPointerEnter={hideHoverCard}
              onPointerDown={(event) => {
                event.stopPropagation();
                hideHoverCard();
              }}
              onClick={(event) => {
                event.stopPropagation();
                hideHoverCard();
                onClose(event.currentTarget.getBoundingClientRect());
              }}
              aria-label={t("terminal.workspan.close", { title })}
              title={t("terminal.workspan.close", { title })}
            >
              <X size={13} strokeWidth={2.2} aria-hidden="true" />
            </button>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="terminal-skin" style={menuStyle}>
          {menuContent(getTabAnchor, startRename)}
        </ContextMenuContent>
      </ContextMenu>
      {terminalTabHoverInfoEnabled && hoverInfo && hoverCardPosition && !editing && !isDragging && (
        <Portal>
          <TerminalTabHoverCard info={hoverInfo} position={hoverCardPosition} themeStyle={menuStyle} onPointerEnter={keepHoverCardOpen} onPointerLeave={scheduleHideHoverCard} />
        </Portal>
      )}
    </>
  );
}
