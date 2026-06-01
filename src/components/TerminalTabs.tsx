import { useCallback, type CSSProperties, type ReactNode } from "react";
import { useShallow } from "zustand/shallow";
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useTerminalStore, type TabNotificationState } from "../stores/terminalStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useProjectStore } from "../stores/projectStore";
import { SplitTerminalView } from "./SplitTerminalView";
import { CommandTemplatePanel } from "./CommandTemplatePanel";
import { CommandHistoryPanel } from "./CommandHistoryPanel";
import { HistoryWorkspace } from "./HistoryWorkspace";
import { openWindowsTerminal } from "../lib/externalTerminal";
import { Terminal, Plus, Search, X } from "./icons";
import { EmptyState } from "./ui/EmptyState";
import { useHistoryStore } from "../stores/historyStore";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "./ui/context-menu";
import { getTerminalBackground } from "../lib/terminalThemes";

const TAB_NOTIFICATION_COLORS: Record<TabNotificationState, string> = {
  none: "#565f89",
  attention: "#ff9e64",
  done: "#9ece6a",
  failed: "#f7768e",
};

const TAB_NOTIFICATION_LABELS: Record<TabNotificationState, string> = {
  none: "无 CLI 通知",
  attention: "CLI 需要处理",
  done: "CLI 任务已完成",
  failed: "CLI 执行异常",
};

interface SortableTabProps {
  id: string;
  title: string;
  isActive: boolean;
  notification: TabNotificationState;
  onActivate: () => void;
  onClose: () => void;
  menuContent: ReactNode;
}

function SortableTab({ id, title, isActive, notification, onActivate, onClose, menuContent }: SortableTabProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });

  const horizontalTransform = transform ? { ...transform, y: 0 } : transform;
  const style = {
    transform: CSS.Transform.toString(horizontalTransform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : undefined,
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={setNodeRef}
          style={style}
          className="ui-interactive ui-tab-trigger mx-1 flex h-7 shrink-0 cursor-pointer items-center gap-2 rounded-lg px-3 text-[12px] font-medium"
          data-selected={isActive ? "true" : "false"}
          onClick={onActivate}
          aria-selected={isActive}
          {...attributes}
          {...listeners}
        >
          <span
            className="w-2 h-2 rounded-full shrink-0"
            style={{ backgroundColor: TAB_NOTIFICATION_COLORS[notification] }}
            role="status"
            aria-label={TAB_NOTIFICATION_LABELS[notification]}
            title={TAB_NOTIFICATION_LABELS[notification]}
          />
          <span className="max-w-[140px] truncate tracking-[0.01em]">{title}</span>
          <button
            onClick={(e) => { e.stopPropagation(); onClose(); }}
            onPointerDown={(e) => e.stopPropagation()}
            className="ui-terminal-tab-close ml-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-on-surface-variant opacity-75 transition-[background-color,color,opacity,box-shadow] hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]"
            aria-label={`关闭终端 ${title}`}
            title={`关闭终端 ${title}`}
          >
            <X size={13} strokeWidth={2.2} aria-hidden="true" />
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>{menuContent}</ContextMenuContent>
    </ContextMenu>
  );
}

export function TerminalTabs() {
  const { sessions, activeSessionId, tabNotifications, splits } = useTerminalStore(
    useShallow((s) => ({
      sessions: s.sessions,
      activeSessionId: s.activeSessionId,
      tabNotifications: s.tabNotifications,
      splits: s.splits,
    }))
  );
  const setActive = useTerminalStore((s) => s.setActive);
  const closeSession = useTerminalStore((s) => s.closeSession);
  const createSession = useTerminalStore((s) => s.createSession);
  const reorderSessions = useTerminalStore((s) => s.reorderSessions);
  const splitTerminal = useTerminalStore((s) => s.splitTerminal);
  const unsplitTerminal = useTerminalStore((s) => s.unsplitTerminal);
  const hiddenBackgroundSessionIds = useTerminalStore((s) => s.hiddenBackgroundSessionIds);
  const hideBackgroundForSession = useTerminalStore((s) => s.hideBackgroundForSession);
  const showBackgroundForSession = useTerminalStore((s) => s.showBackgroundForSession);
  const projects = useProjectStore((s) => s.projects);
  const useExternalTerminal = useSettingsStore((s) => s.useExternalTerminal);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const fontFamily = useSettingsStore((s) => s.fontFamily);
  const resolvedTheme = useSettingsStore((s) => s.resolvedTheme);
  const terminalThemeMode = useSettingsStore((s) => s.terminalThemeMode);
  const terminalThemeName = useSettingsStore((s) => s.terminalThemeName);
  const lightThemePalette = useSettingsStore((s) => s.lightThemePalette);
  const darkThemePalette = useSettingsStore((s) => s.darkThemePalette);
  const terminalBackgroundEnabled = useSettingsStore((s) => s.terminalBackground.enabled);
  const terminalBackgroundImagePath = useSettingsStore((s) => s.terminalBackground.imagePath);
  const historyOpen = useHistoryStore((s) => s.isOpen);
  const toggleHistory = useHistoryStore((s) => s.toggleHistory);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      reorderSessions(active.id as string, over.id as string);
    }
  }, [reorderSessions]);

  const handleNewTab = useCallback(async () => {
    if (useExternalTerminal) {
      await openWindowsTerminal([{ title: "Terminal" }]);
      return;
    }
    await createSession(undefined, undefined, "Terminal");
  }, [useExternalTerminal, createSession]);

  const handleCloseOthers = useCallback(
    (sessionId: string) => {
      sessions.filter((s) => s.id !== sessionId).forEach((s) => closeSession(s.id));
    },
    [sessions, closeSession]
  );

  const handleSplit = useCallback(
    (sessionId: string, direction: "horizontal" | "vertical") => {
      const session = sessions.find((s) => s.id === sessionId);
      const project = session?.projectId ? projects.find((p) => p.id === session.projectId) : undefined;
      splitTerminal(sessionId, direction, project?.path, project?.shell);
    },
    [sessions, projects, splitTerminal]
  );

  const sessionIds = sessions.map((s) => s.id);
  const effectiveTerminalThemeName = terminalThemeMode === "follow-app" ? "auto" : terminalThemeName;
  const terminalBridgeColor = getTerminalBackground(
    effectiveTerminalThemeName,
    resolvedTheme,
    lightThemePalette,
    darkThemePalette
  );
  const terminalWellStyle: CSSProperties = {
    "--terminal-bridge-color": terminalBridgeColor,
  } as CSSProperties;

  return (
    <div className="ui-terminal-tabs-shell flex h-full min-h-0 flex-col">
      <div className="ui-terminal-chrome">
        <div className="ui-terminal-tab-scroll flex h-full min-w-0 flex-1 items-center overflow-x-auto px-1.5">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={sessionIds} strategy={horizontalListSortingStrategy}>
              {sessions.map((s) => {
                const isSplit = !!splits[s.id];
                return (
                  <SortableTab
                    key={s.id}
                    id={s.id}
                    title={s.title}
                    isActive={s.id === activeSessionId}
                    notification={tabNotifications[s.id] ?? "none"}
                    onActivate={() => setActive(s.id)}
                    onClose={() => closeSession(s.id)}
                    menuContent={
                      <>
                        <ContextMenuItem
                          onSelect={() => {
                            setActive(s.id);
                            closeSession(s.id);
                          }}
                        >
                          关闭终端
                        </ContextMenuItem>
                        <ContextMenuItem
                          onSelect={() => {
                            setActive(s.id);
                            handleCloseOthers(s.id);
                          }}
                        >
                          关闭其它终端
                        </ContextMenuItem>
                        <ContextMenuItem onSelect={() => void handleNewTab()}>
                          新建终端
                        </ContextMenuItem>
                        {terminalBackgroundEnabled && terminalBackgroundImagePath && (
                          hiddenBackgroundSessionIds.has(s.id) ? (
                            <ContextMenuItem onSelect={() => showBackgroundForSession(s.id)}>
                              显示背景图
                            </ContextMenuItem>
                          ) : (
                            <ContextMenuItem onSelect={() => hideBackgroundForSession(s.id)}>
                              隐藏背景图
                            </ContextMenuItem>
                          )
                        )}
                        <ContextMenuSeparator />
                        {isSplit ? (
                          <ContextMenuItem onSelect={() => unsplitTerminal(s.id)}>
                            取消分屏
                          </ContextMenuItem>
                        ) : (
                          <>
                            <ContextMenuItem onSelect={() => handleSplit(s.id, "horizontal")}>
                              水平分屏
                            </ContextMenuItem>
                            <ContextMenuItem onSelect={() => handleSplit(s.id, "vertical")}>
                              垂直分屏
                            </ContextMenuItem>
                          </>
                        )}
                      </>
                    }
                  />
                );
              })}
            </SortableContext>
          </DndContext>
        </div>
        <div className="ui-terminal-actions flex h-full shrink-0 items-center gap-2 px-2.5">
          <button
            onClick={handleNewTab}
            className="ui-flat-action ui-toolbar-button ui-primary-action"
            title="新建终端"
            aria-label="新建终端"
          >
            <Plus size={12} strokeWidth={2} />
            <Terminal size={14} strokeWidth={1.5} />
            <span>新建</span>
          </button>
          <CommandTemplatePanel />
          <CommandHistoryPanel compact />
          <button
            onClick={() => {
              void toggleHistory();
            }}
            className={`ui-flat-action ui-toolbar-button ${historyOpen ? "ui-primary-action" : "ui-history-primary"}`}
            title="历史会话（Ctrl+K）"
            aria-label={historyOpen ? "关闭历史会话面板" : "打开历史会话面板"}
            aria-controls="history-workspace"
            aria-expanded={historyOpen}
          >
            <Search size={13} strokeWidth={1.8} />
            <span>会话历史</span>
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden px-3 pb-3 pt-3">
        {historyOpen ? (
          <div className="ui-surface-card h-full min-h-0 overflow-hidden">
            <HistoryWorkspace />
          </div>
        ) : (
          <div
            className="ui-terminal-well relative h-full min-h-0"
            data-terminal-mode={terminalThemeMode}
            style={terminalWellStyle}
          >
            {sessions.map((s) => (
              <div
                key={s.id}
                className="absolute inset-0"
                style={{ display: s.id === activeSessionId ? "block" : "none" }}
              >
                <SplitTerminalView
                  sessionId={s.id}
                  split={splits[s.id]}
                  isActive={s.id === activeSessionId}
                  fontSize={fontSize}
                  fontFamily={fontFamily}
                  resolvedTheme={resolvedTheme}
                  terminalThemeName={effectiveTerminalThemeName}
                  lightThemePalette={lightThemePalette}
                  darkThemePalette={darkThemePalette}
                />
              </div>
            ))}
            {sessions.length === 0 && !useExternalTerminal && (
              <div className="flex h-full items-center justify-center">
                <EmptyState
                  icon={<Terminal size={40} strokeWidth={1} />}
                  title="无活跃终端"
                  description="Ctrl+Shift+T 新建终端，或从左侧项目列表双击启动"
                  tone="inverse"
                  action={{ label: "打开终端", onClick: handleNewTab }}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
