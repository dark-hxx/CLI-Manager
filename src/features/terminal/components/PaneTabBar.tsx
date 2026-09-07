import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy } from "@dnd-kit/sortable";
import { type TabNotificationState } from "../../../stores/terminalStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import { useI18n } from "../../../lib/i18n";
import type { TerminalPaneLeaf, TerminalPaneSplitDirection } from "../../../stores/terminalPaneTree";
import { PULSING_TAB_STATES, TAB_NOTIFICATION_COLORS } from "../../../components/terminal/terminalTabVisuals";
import { X, Maximize2, Minimize2, ChevronDown, ChevronRight, Undo2 } from "../../../components/icons";
import { inferVendor } from "../../../components/VendorIcon";
import { canSaveSessionToSidebar } from "../../../lib/saveSessionToSidebar";
import type { Project, TerminalSession, WorktreeRecord } from "../../../lib/types";
import {
  ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubTrigger, ContextMenuSubContent,
} from "../../../components/ui/context-menu";
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/popover";
import { getTerminalTheme } from "../../../lib/terminalThemes";
import {
  normalizeTabMenuHex, tabMenuHexToRgba, PANE_DROP_PREFIX, type SplitPickerAnchor,
  buildTerminalTabHoverInfo, inferSessionVendor, inferSessionCliToolIcon,
} from "../lib/terminalTabsModel";
import { SortableTab } from "./SortableTerminalTabs";

export interface PaneTabBarProps {
  pane: TerminalPaneLeaf;
  sessions: TerminalSession[];
  visibleSessionIds?: Set<string> | null;
  projects: Project[];
  worktrees: WorktreeRecord[];
  allPanes: TerminalPaneLeaf[];
  activeSessionId: string | null;
  editingSessionId: string | null;
  tabNotifications: Record<string, TabNotificationState>;
  resolvedTheme: "dark" | "light";
  terminalThemeName: string;
  lightThemePalette: ReturnType<typeof useSettingsStore.getState>["lightThemePalette"];
  darkThemePalette: ReturnType<typeof useSettingsStore.getState>["darkThemePalette"];
  terminalBackgroundEnabled: boolean;
  terminalBackgroundImagePath: string | null;
  hiddenBackgroundSessionIds: Set<string>;
  isPaneFullscreen: boolean;
  onActivateSession: (sessionId: string) => void;
  onCloseSessions: (sessionIds: string[], anchor?: SplitPickerAnchor) => void;
  onStartEdit: (sessionId: string) => void;
  onSubmitEdit: (sessionId: string, title: string) => void;
  onCancelEdit: () => void;
  onNewTab: () => void;
  onDuplicateSession: (session: TerminalSession) => void;
  onSaveSessionToSidebar: (session: TerminalSession) => void;
  onOpenSplitPicker: (sessionId: string, direction: TerminalPaneSplitDirection, anchor?: SplitPickerAnchor) => void;
  onUnsplit: (sessionId: string) => void;
  onMoveToPane: (sessionId: string, paneId: string) => void;
  onHideBackground: (sessionId: string) => void;
  onShowBackground: (sessionId: string) => void;
  onTogglePaneFullscreen: (paneId: string) => void;
  onDetachSessionToWorkspan: (sessionId: string) => void;
  onOpenWorktreeChanges: (sessionId: string) => void;
  onOpenWorktreeHistory: (project: Project, worktree: WorktreeRecord) => void;
  onFinishWorktree: (project: Project, worktree: WorktreeRecord) => void;
  onInstallWorktreeDeps: (project: Project, worktree: WorktreeRecord) => void;
  onDiscardWorktree: (project: Project, worktree: WorktreeRecord) => void;
  onOpenWorktreeDirectory: (worktree: WorktreeRecord) => void;
  variant?: "global" | "pane";
}

export function PaneTabBar({
  pane,
  sessions,
  visibleSessionIds,
  projects,
  worktrees,
  allPanes,
  activeSessionId,
  editingSessionId,
  tabNotifications,
  terminalBackgroundEnabled,
  terminalBackgroundImagePath,
  hiddenBackgroundSessionIds,
  isPaneFullscreen,
  onActivateSession,
  onCloseSessions,
  onStartEdit,
  onSubmitEdit,
  onCancelEdit,
  onNewTab,
  onDuplicateSession,
  onSaveSessionToSidebar,
  onOpenSplitPicker,
  onUnsplit,
  onMoveToPane,
  onHideBackground,
  onShowBackground,
  onTogglePaneFullscreen,
  onDetachSessionToWorkspan,
  onOpenWorktreeChanges,
  onOpenWorktreeHistory,
  onFinishWorktree,
  onInstallWorktreeDeps,
  onDiscardWorktree,
  onOpenWorktreeDirectory,
  variant = "pane",
  resolvedTheme,
  terminalThemeName,
  lightThemePalette,
  darkThemePalette,
}: PaneTabBarProps) {
  const { t } = useI18n();
  const workspanEnabled = useSettingsStore((s) => s.workspanEnabled);
  const { setNodeRef, isOver } = useDroppable({ id: `${PANE_DROP_PREFIX}${pane.id}` });
  const tabMenuTheme = getTerminalTheme(terminalThemeName, resolvedTheme, lightThemePalette, darkThemePalette);
  const tabMenuForeground = normalizeTabMenuHex(tabMenuTheme.foreground, resolvedTheme === "dark" ? "#d8dee9" : "#1e293b");
  const tabMenuBackground = normalizeTabMenuHex(tabMenuTheme.background, resolvedTheme === "dark" ? "#0c0e10" : "#ffffff");
  const tabMenuStyle: CSSProperties = {
    "--menu-fg": tabMenuForeground,
    "--menu-bg": tabMenuBackground,
    "--menu-border": tabMenuHexToRgba(tabMenuForeground, 0.18, "rgba(255, 255, 255, 0.18)"),
    "--menu-hover": tabMenuHexToRgba(tabMenuForeground, 0.12, "rgba(255, 255, 255, 0.12)"),
  } as CSSProperties;
  const tabScrollRef = useRef<HTMLDivElement | null>(null);
  const tabScrollUpdateTimeoutRef = useRef<number | null>(null);
  const isWorkspanSplit = workspanEnabled && variant === "pane" && allPanes.length > 1;
  const [tabListOpen, setTabListOpen] = useState(false);
  const [tabScrollState, setTabScrollState] = useState({
    isOverflowing: false,
    canScrollLeft: false,
    canScrollRight: false,
  });
  const projectById = useMemo(() => {
    const next = new Map<string, Project>();
    for (const project of projects) next.set(project.id, project);
    return next;
  }, [projects]);
  const worktreeById = useMemo(() => {
    const next = new Map<string, WorktreeRecord>();
    for (const worktree of worktrees) next.set(worktree.id, worktree);
    return next;
  }, [worktrees]);
  const paneSessions = pane.sessionIds
    .map((id) => sessions.find((session) => session.id === id))
    .filter((session) => !visibleSessionIds || (session && visibleSessionIds.has(session.id)))
    .filter((session): session is TerminalSession => Boolean(session));
  const paneSessionIds = paneSessions.map((session) => session.id);
  const activePaneTabId =
    activeSessionId && paneSessionIds.includes(activeSessionId)
      ? activeSessionId
      : paneSessionIds[0] ?? null;
  const activePaneSession = activePaneTabId
    ? paneSessions.find((session) => session.id === activePaneTabId) ?? null
    : null;
  const isSubagentTranscript = activePaneSession?.kind === "subagent-transcript";
  const otherPanes = allPanes.filter((item) => item.id !== pane.id && item.sessionIds.length > 0);
  const paneFullscreenLabel = isPaneFullscreen
    ? t("terminal.toolbar.exitTerminalFullscreen")
    : t("terminal.toolbar.enterTerminalFullscreen");
  const tabScrollSignature = paneSessions
    .map((session) => `${session.id}:${session.title}:${tabNotifications[session.id] ?? "none"}`)
    .join("|");

  const updateTabScrollState = useCallback(() => {
    const element = tabScrollRef.current;
    if (!element) {
      setTabScrollState((current) => {
        if (!current.isOverflowing && !current.canScrollLeft && !current.canScrollRight) return current;
        return { isOverflowing: false, canScrollLeft: false, canScrollRight: false };
      });
      return;
    }

    const maxScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth);
    const scrollLeft = Math.max(0, element.scrollLeft);
    const nextState = {
      isOverflowing: maxScrollLeft > 1,
      canScrollLeft: scrollLeft > 1,
      canScrollRight: scrollLeft < maxScrollLeft - 1,
    };

    setTabScrollState((current) => {
      if (
        current.isOverflowing === nextState.isOverflowing &&
        current.canScrollLeft === nextState.canScrollLeft &&
        current.canScrollRight === nextState.canScrollRight
      ) {
        return current;
      }
      return nextState;
    });
  }, []);

  const scrollPaneTabs = useCallback((direction: -1 | 1) => {
    const element = tabScrollRef.current;
    if (!element) return;
    const distance = Math.max(Math.floor(element.clientWidth * 0.72), 160);
    element.scrollBy({ left: distance * direction, behavior: "smooth" });
    window.requestAnimationFrame(updateTabScrollState);
    if (tabScrollUpdateTimeoutRef.current !== null) window.clearTimeout(tabScrollUpdateTimeoutRef.current);
    tabScrollUpdateTimeoutRef.current = window.setTimeout(() => {
      tabScrollUpdateTimeoutRef.current = null;
      updateTabScrollState();
    }, 220);
  }, [updateTabScrollState]);

  const scrollActivePaneTabIntoView = useCallback(() => {
    const element = tabScrollRef.current;
    if (!element || !activePaneTabId) {
      updateTabScrollState();
      return;
    }

    const activeTab = Array.from(element.querySelectorAll<HTMLElement>("[data-terminal-tab-id]"))
      .find((node) => node.dataset.terminalTabId === activePaneTabId);
    if (!activeTab) {
      updateTabScrollState();
      return;
    }

    const containerRect = element.getBoundingClientRect();
    const activeRect = activeTab.getBoundingClientRect();
    let nextScrollLeft = element.scrollLeft;

    if (activeRect.left < containerRect.left) {
      nextScrollLeft -= containerRect.left - activeRect.left;
    } else if (activeRect.right > containerRect.right) {
      nextScrollLeft += activeRect.right - containerRect.right;
    }

    const maxScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth);
    const isLastTab = paneSessionIds[paneSessionIds.length - 1] === activePaneTabId;
    // 末尾标签吸附到最右，避免容器 padding / 标签 margin 残留导致右滚按钮仍可点
    const clampedScrollLeft = isLastTab
      ? maxScrollLeft
      : Math.min(maxScrollLeft, Math.max(0, nextScrollLeft));
    if (Math.abs(clampedScrollLeft - element.scrollLeft) > 0.5) {
      element.scrollTo({ left: clampedScrollLeft, behavior: "smooth" });
    }

    window.requestAnimationFrame(updateTabScrollState);
    if (tabScrollUpdateTimeoutRef.current !== null) window.clearTimeout(tabScrollUpdateTimeoutRef.current);
    tabScrollUpdateTimeoutRef.current = window.setTimeout(() => {
      tabScrollUpdateTimeoutRef.current = null;
      updateTabScrollState();
    }, 220);
  }, [activePaneTabId, pane.id, paneSessionIds, updateTabScrollState]);

  const activatePaneSessionAt = useCallback((index: number) => {
    const session = paneSessions[index];
    if (!session) return;
    onActivateSession(session.id);
  }, [onActivateSession, paneSessions]);

  const closePaneSessions = useCallback((sessionIds: string[], anchor?: SplitPickerAnchor) => {
    onCloseSessions(sessionIds, anchor);
  }, [onCloseSessions]);

  const closeOtherPaneSessions = useCallback((sessionId: string, anchor?: SplitPickerAnchor) => {
    const index = paneSessionIds.indexOf(sessionId);
    if (index < 0) return;
    closePaneSessions(paneSessionIds.filter((id) => id !== sessionId), anchor);
  }, [closePaneSessions, paneSessionIds]);

  const closePaneSessionsToLeft = useCallback((sessionId: string, anchor?: SplitPickerAnchor) => {
    const index = paneSessionIds.indexOf(sessionId);
    if (index <= 0) return;
    closePaneSessions(paneSessionIds.slice(0, index), anchor);
  }, [closePaneSessions, paneSessionIds]);

  const closePaneSessionsToRight = useCallback((sessionId: string, anchor?: SplitPickerAnchor) => {
    const index = paneSessionIds.indexOf(sessionId);
    if (index < 0) return;
    closePaneSessions(paneSessionIds.slice(index + 1), anchor);
  }, [closePaneSessions, paneSessionIds]);

  useEffect(() => {
    setTabListOpen(false);
  }, [pane.id, pane.activeSessionId]);

  useEffect(() => {
    if (!tabScrollState.isOverflowing) setTabListOpen(false);
  }, [tabScrollState.isOverflowing]);

  useEffect(() => {
    const element = tabScrollRef.current;
    let frameId: number | null = null;
    const scheduleUpdate = () => {
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        updateTabScrollState();
      });
    };

    scheduleUpdate();
    if (!element) return () => {
      if (frameId !== null) window.cancelAnimationFrame(frameId);
    };

    const handleWheel = (wheelEvent: WheelEvent) => {
      const maxScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth);
      if (maxScrollLeft <= 0) return;
      // 取绝对值较大的轴：触控板横向滚动用 deltaX，鼠标滚轮用 deltaY
      const delta = Math.abs(wheelEvent.deltaX) >= Math.abs(wheelEvent.deltaY)
        ? wheelEvent.deltaX
        : wheelEvent.deltaY;
      if (delta === 0) return;
      wheelEvent.preventDefault();
      element.scrollLeft += delta;
      scheduleUpdate();
    };

    element.addEventListener("scroll", scheduleUpdate, { passive: true });
    element.addEventListener("wheel", handleWheel, { passive: false });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleUpdate);
    observer?.observe(element);

    return () => {
      element.removeEventListener("scroll", scheduleUpdate);
      element.removeEventListener("wheel", handleWheel);
      observer?.disconnect();
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      if (tabScrollUpdateTimeoutRef.current !== null) {
        window.clearTimeout(tabScrollUpdateTimeoutRef.current);
        tabScrollUpdateTimeoutRef.current = null;
      }
    };
  }, [tabScrollSignature, updateTabScrollState]);

  useEffect(() => {
    scrollActivePaneTabIntoView();
  }, [activePaneTabId, paneSessionIds.length, scrollActivePaneTabIntoView]);

  return (
    <div
      ref={setNodeRef}
      className={`ui-terminal-chrome ${variant === "global" ? "ui-terminal-global-chrome" : "ui-terminal-pane-chrome"} relative flex h-10 shrink-0 items-center`}
      data-drop-target={isOver ? "true" : "false"}
      data-chrome-variant={variant}
      data-terminal-split-pane={isWorkspanSplit ? "true" : undefined}
    >
      {variant === "pane" && tabScrollState.isOverflowing && (
        <button
          type="button"
          className="ui-terminal-tab-scroll-button ui-terminal-tab-scroll-button-left"
          onClick={() => scrollPaneTabs(-1)}
          disabled={!tabScrollState.canScrollLeft}
          aria-label={t("terminal.tab.scrollLeft")}
          title={t("terminal.tab.scrollLeft")}
        >
          <ChevronRight size={14} strokeWidth={1.8} className="rotate-180" aria-hidden="true" />
        </button>
      )}
      <div
        ref={tabScrollRef}
        className="ui-terminal-tab-scroll flex h-full min-w-0 flex-1 items-center overflow-x-auto px-1.5"
        data-can-scroll-left={tabScrollState.canScrollLeft ? "true" : "false"}
        data-can-scroll-right={tabScrollState.canScrollRight ? "true" : "false"}
      >
        <SortableContext items={paneSessionIds} strategy={horizontalListSortingStrategy}>
          {paneSessions.map((session) => (
            <SortableTab
              key={session.id}
              id={session.id}
              paneId={pane.id}
              title={session.title}
              sessionKind={session.kind}
              isActive={session.id === activeSessionId}
              isEditing={editingSessionId === session.id}
              notification={tabNotifications[session.id] ?? "none"}
              vendor={inferVendor(projectById.get(session.projectId!)?.cli_tool) ?? inferSessionVendor(session)}
              cliToolIcon={inferSessionCliToolIcon(session, projectById.get(session.projectId!))}
              worktree={session.worktreeId ? worktreeById.get(session.worktreeId) ?? null : null}
              worktreeMenuContent={session.worktreeId && worktreeById.get(session.worktreeId) && session.projectId && projectById.get(session.projectId) ? (closeMenu) => {
                const project = projectById.get(session.projectId!);
                const activeWorktree = worktreeById.get(session.worktreeId!);
                if (!project || !activeWorktree) return null;
                const runAndClose = (action: () => void) => {
                  closeMenu();
                  action();
                };
                return (
                  <>
                    <button type="button" className="context-menu-item w-full" onClick={() => runAndClose(() => onOpenWorktreeChanges(session.id))}>{t("worktree.menu.viewChanges")}</button>
                    <button type="button" className="context-menu-item w-full" onClick={() => runAndClose(() => onOpenWorktreeHistory(project, activeWorktree))}>{t("worktree.menu.viewHistory")}</button>
                    <button type="button" className="context-menu-item w-full" onClick={() => runAndClose(() => onFinishWorktree(project, activeWorktree))}>{t("worktree.menu.finish")}</button>
                    <button type="button" className="context-menu-item w-full" onClick={() => runAndClose(() => onInstallWorktreeDeps(project, activeWorktree))}>{t("worktree.menu.installDeps")}</button>
                    <button type="button" className="context-menu-item w-full" onClick={() => runAndClose(() => onOpenWorktreeDirectory(activeWorktree))}>{t("worktree.menu.openDirectory")}</button>
                    <button type="button" className="context-menu-item danger w-full" onClick={() => runAndClose(() => onDiscardWorktree(project, activeWorktree))}>{t("worktree.menu.discard")}</button>
                  </>
                );
              } : undefined}
              hoverInfo={buildTerminalTabHoverInfo(session, session.projectId ? projectById.get(session.projectId) : undefined)}
              onActivate={() => onActivateSession(session.id)}
              onClose={(anchor) => closePaneSessions([session.id], anchor)}
              onSubmitEdit={(title) => onSubmitEdit(session.id, title)}
              onCancelEdit={onCancelEdit}
              menuClassName="terminal-skin"
              menuStyle={tabMenuStyle}
              menuContent={(getAnchor) => (
                <>
                  <ContextMenuItem onSelect={() => closePaneSessions([session.id], getAnchor())}>{t("terminal.tab.closeCurrent")}</ContextMenuItem>
                  <ContextMenuItem
                    onSelect={() => {
                      // Radix 会在菜单关闭后恢复焦点；延后一拍进入编辑态，避免输入框刚挂载就被 blur 提交掉。
                      window.setTimeout(() => onStartEdit(session.id), 0);
                    }}
                  >
                    {t("terminal.tab.rename")}
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => closeOtherPaneSessions(session.id, getAnchor())}>{t("terminal.tab.closeOthers")}</ContextMenuItem>
                  <ContextMenuItem onSelect={() => closePaneSessionsToLeft(session.id, getAnchor())}>{t("terminal.tab.closeLeft")}</ContextMenuItem>
                  <ContextMenuItem onSelect={() => closePaneSessionsToRight(session.id, getAnchor())}>{t("terminal.tab.closeRight")}</ContextMenuItem>
                  {(() => {
                    const saveProject = session.projectId ? projectById.get(session.projectId) ?? null : null;
                    const canSave = canSaveSessionToSidebar(session, saveProject);
                    return (
                      <ContextMenuItem
                        disabled={!canSave}
                        onSelect={() => {
                          // Radix 会在菜单关闭后恢复焦点到触发器 tab；延后一拍再打开命名 Modal，
                          // 避免其 data-autofocus 输入框被 Radix 的 focus-restore 抢走焦点。
                          // 与相邻 rename 项(第 1380-1383 行)相同 pattern。
                          window.setTimeout(() => onSaveSessionToSidebar(session), 0);
                        }}
                        title={!canSave ? t("saveSession.noSessionId") : undefined}
                      >
                        {t("terminal.tab.saveSession")}
                      </ContextMenuItem>
                    );
                  })()}
                  <ContextMenuItem onSelect={onNewTab}>{t("terminal.toolbar.newTerminal")}</ContextMenuItem>
                  <ContextMenuItem onSelect={() => onDuplicateSession(session)}>{t("terminal.tab.duplicate")}</ContextMenuItem>
                  {terminalBackgroundEnabled && terminalBackgroundImagePath && (
                    hiddenBackgroundSessionIds.has(session.id) ? (
                      <ContextMenuItem onSelect={() => onShowBackground(session.id)}>{t("terminal.tab.showBackground")}</ContextMenuItem>
                    ) : (
                      <ContextMenuItem onSelect={() => onHideBackground(session.id)}>{t("terminal.tab.hideBackground")}</ContextMenuItem>
                    )
                  )}
                  {session.worktreeId && worktreeById.get(session.worktreeId) && session.projectId && projectById.get(session.projectId) && (
                    <>
                      <ContextMenuSeparator />
                      <ContextMenuItem onSelect={() => onOpenWorktreeChanges(session.id)}>{t("worktree.menu.viewChanges")}</ContextMenuItem>
                      <ContextMenuItem onSelect={() => onOpenWorktreeHistory(projectById.get(session.projectId!)!, worktreeById.get(session.worktreeId!)!)}>{t("worktree.menu.viewHistory")}</ContextMenuItem>
                      <ContextMenuItem onSelect={() => onFinishWorktree(projectById.get(session.projectId!)!, worktreeById.get(session.worktreeId!)!)}>{t("worktree.menu.finish")}</ContextMenuItem>
                      <ContextMenuItem onSelect={() => onInstallWorktreeDeps(projectById.get(session.projectId!)!, worktreeById.get(session.worktreeId!)!)}>{t("worktree.menu.installDeps")}</ContextMenuItem>
                      <ContextMenuItem onSelect={() => onOpenWorktreeDirectory(worktreeById.get(session.worktreeId!)!)}>{t("worktree.menu.openDirectory")}</ContextMenuItem>
                      <ContextMenuItem onSelect={() => onDiscardWorktree(projectById.get(session.projectId!)!, worktreeById.get(session.worktreeId!)!)}>{t("worktree.menu.discard")}</ContextMenuItem>
                    </>
                  )}
                  <ContextMenuSeparator />
                  <ContextMenuItem onSelect={() => onOpenSplitPicker(session.id, "horizontal", getAnchor())}>
                    {t("terminal.tab.splitRight")}
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => onOpenSplitPicker(session.id, "vertical", getAnchor())}>
                    {t("terminal.tab.splitDown")}
                  </ContextMenuItem>
                  {allPanes.length > 1 && <ContextMenuItem onSelect={() => onUnsplit(session.id)}>{t("terminal.tab.unsplit")}</ContextMenuItem>}
                  {otherPanes.length > 0 && (
                    <ContextMenuSub>
                      <ContextMenuSubTrigger>{t("terminal.tab.moveToPane")}</ContextMenuSubTrigger>
                      <ContextMenuSubContent className="terminal-skin" style={tabMenuStyle}>
                        {otherPanes.map((targetPane, index) => (
                          <ContextMenuItem key={targetPane.id} onSelect={() => onMoveToPane(session.id, targetPane.id)}>
                            {t("terminal.tab.paneName", { index: index + 1 })}
                          </ContextMenuItem>
                        ))}
                      </ContextMenuSubContent>
                    </ContextMenuSub>
                  )}
                </>
              )}
            />
          ))}
        </SortableContext>
      </div>
      {variant === "pane" && tabScrollState.isOverflowing && (
        <>
          <button
            type="button"
            className="ui-terminal-tab-scroll-button ui-terminal-tab-scroll-button-right"
            onClick={() => scrollPaneTabs(1)}
            disabled={!tabScrollState.canScrollRight}
            aria-label={t("terminal.tab.scrollRight")}
            title={t("terminal.tab.scrollRight")}
          >
            <ChevronRight size={14} strokeWidth={1.8} aria-hidden="true" />
          </button>
          <Popover open={tabListOpen && tabScrollState.isOverflowing} onOpenChange={setTabListOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="ui-terminal-tab-list-button"
                aria-label={t("terminal.tab.openList")}
                aria-expanded={tabListOpen && tabScrollState.isOverflowing}
                title={t("terminal.tab.list")}
              >
                <ChevronDown size={14} strokeWidth={1.8} aria-hidden="true" />
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="terminal-skin ui-terminal-tab-list-popover w-64 p-1.5"
              style={tabMenuStyle}
              onOpenAutoFocus={(event) => event.preventDefault()}
              onCloseAutoFocus={(event) => event.preventDefault()}
            >
              <div className="ui-terminal-tab-list-title px-2 py-1 text-[11px] font-semibold">{t("terminal.tab.tabs")}</div>
              <div className="max-h-72 overflow-y-auto">
                {paneSessions.map((session, index) => {
                  const notification = tabNotifications[session.id] ?? "none";
                  return (
                    <button
                      key={session.id}
                      type="button"
                      className="ui-interactive ui-terminal-tab-list-item flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-on-surface-variant"
                      data-selected={session.id === pane.activeSessionId ? "true" : "false"}
                      onClick={() => {
                        activatePaneSessionAt(index);
                        setTabListOpen(false);
                      }}
                      title={session.title}
                    >
                      <span
                        className="ui-tab-runtime-dot h-2 w-2 shrink-0 rounded-full"
                        data-pulsing={PULSING_TAB_STATES.has(notification) ? "true" : "false"}
                        style={{ backgroundColor: TAB_NOTIFICATION_COLORS[notification], color: TAB_NOTIFICATION_COLORS[notification] }}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 truncate">{session.title}</span>
                    </button>
                  );
                })}
              </div>
            </PopoverContent>
          </Popover>
        </>
      )}
      {variant === "pane" && (
        <div className="ui-terminal-actions flex shrink-0 items-center">
          {!isSubagentTranscript && isWorkspanSplit && activePaneTabId && (
            <button
              type="button"
              className="ui-focus-ring ui-icon-action"
              onClick={() => onDetachSessionToWorkspan(activePaneTabId)}
              title={t("terminal.tab.detachWorkspan")}
              aria-label={t("terminal.tab.detachWorkspan")}
            >
              <Undo2 size={14} strokeWidth={1.8} aria-hidden="true" />
            </button>
          )}
          {!isSubagentTranscript && (
            <button
              type="button"
              className="ui-focus-ring ui-icon-action ui-action-fullscreen"
              data-active={isPaneFullscreen ? "true" : "false"}
              onClick={() => onTogglePaneFullscreen(pane.id)}
              title={paneFullscreenLabel}
              aria-label={paneFullscreenLabel}
              aria-pressed={isPaneFullscreen}
            >
              {isPaneFullscreen ? <Minimize2 size={14} strokeWidth={1.8} /> : <Maximize2 size={14} strokeWidth={1.8} />}
            </button>
          )}
          {isWorkspanSplit && activePaneTabId && (
            <button
              type="button"
              className="ui-focus-ring ui-icon-action"
              onClick={(event) => closePaneSessions([activePaneTabId], event.currentTarget.getBoundingClientRect())}
              title={t("terminal.tab.closeCurrent")}
              aria-label={t("terminal.tab.closeCurrent")}
            >
              <X size={14} strokeWidth={2} aria-hidden="true" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
