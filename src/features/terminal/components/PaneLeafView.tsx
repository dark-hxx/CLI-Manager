import { Suspense, memo, type CSSProperties } from "react";
import { useTerminalStore, type TabNotificationState } from "../state";
import { useSettingsStore } from "../../../shared/preferences/settingsStore";
import type { TerminalPaneLeaf, TerminalPaneSplitDirection } from "../api/terminalPaneTree";
import { XTermTerminal } from "./XTermTerminal";
import { RemoteHandoffOverlay } from "./RemoteHandoffOverlay";
import type { Project, TerminalSession, WorktreeRecord } from "../../../shared/types/index";
import { resolveTerminalPaneMarker, type TerminalPaneMarkerSettings } from "../../../shared/lib/terminalPaneMarker";
import { FileEditorPane, SubagentTranscriptView } from "./lazyTerminalPanels";
import { type SplitPickerAnchor, type PaneDropPreview } from "../lib/terminalTabsModel";
import { PaneTabBar } from "./PaneTabBar";
import { PaneContentDropZones } from "./PaneContentDropZones";

export interface PaneLeafViewProps {
  pane: TerminalPaneLeaf;
  sessions: TerminalSession[];
  visibleSessionIds?: Set<string> | null;
  projects: Project[];
  worktrees: WorktreeRecord[];
  allPanes: TerminalPaneLeaf[];
  activeSessionId: string | null;
  historyActive: boolean;
  editingSessionId: string | null;
  tabNotifications: Record<string, TabNotificationState>;
  hookNotifications: Record<string, TabNotificationState>;
  paneMarkerSettings: TerminalPaneMarkerSettings;
  isAppFocused: boolean;
  fontSize: number;
  fontFamily: string;
  resolvedTheme: "dark" | "light";
  terminalThemeName: string;
  terminalThemeBackground: string;
  lightThemePalette: ReturnType<typeof useSettingsStore.getState>["lightThemePalette"];
  darkThemePalette: ReturnType<typeof useSettingsStore.getState>["darkThemePalette"];
  terminalBackgroundEnabled: boolean;
  terminalBackgroundImagePath: string | null;
  hiddenBackgroundSessionIds: Set<string>;
  isPaneFullscreen: boolean;
  isLayoutVisible: boolean;
  activeDropPreview?: PaneDropPreview;
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
  hideTabBar?: boolean;
}

export function PaneLeafView({
  pane,
  sessions,
  visibleSessionIds,
  projects,
  worktrees,
  allPanes,
  activeSessionId,
  historyActive,
  editingSessionId,
  tabNotifications,
  hookNotifications,
  paneMarkerSettings,
  isAppFocused,
  fontSize,
  fontFamily,
  resolvedTheme,
  terminalThemeName,
  terminalThemeBackground,
  lightThemePalette,
  darkThemePalette,
  terminalBackgroundEnabled,
  terminalBackgroundImagePath,
  hiddenBackgroundSessionIds,
  isPaneFullscreen,
  isLayoutVisible,
  activeDropPreview,
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
  hideTabBar = false,
}: PaneLeafViewProps) {
  const paneSessions = pane.sessionIds
    .map((id) => sessions.find((session) => session.id === id))
    .filter((session): session is TerminalSession => Boolean(session));
  const visiblePaneSessionIds = visibleSessionIds
    ? pane.sessionIds.filter((id) => visibleSessionIds.has(id))
    : pane.sessionIds;
  const effectivePaneActiveSessionId =
    pane.activeSessionId && visiblePaneSessionIds.includes(pane.activeSessionId)
      ? pane.activeSessionId
      : visiblePaneSessionIds[0] ?? null;
  const activePaneSession = effectivePaneActiveSessionId
    ? paneSessions.find((session) => session.id === effectivePaneActiveSessionId) ?? null
    : null;
  const paneMarker = resolveTerminalPaneMarker({
    isLayoutVisible: isLayoutVisible && !historyActive,
    isSplitLayout: allPanes.length > 1,
    isAppFocused,
    isPaneFocused: effectivePaneActiveSessionId !== null && effectivePaneActiveSessionId === activeSessionId,
    isMainSession: (activePaneSession?.kind ?? "pty") === "pty",
    hookStatus: effectivePaneActiveSessionId ? hookNotifications[effectivePaneActiveSessionId] ?? "none" : "none",
    settings: paneMarkerSettings,
  });
  const paneMarkerStyle = paneMarkerSettings.style;

  return (
    <div className="ui-terminal-pane relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      {!hideTabBar && (
        <PaneTabBar
          pane={pane}
          sessions={sessions}
          visibleSessionIds={visibleSessionIds}
          projects={projects}
          worktrees={worktrees}
          allPanes={allPanes}
          activeSessionId={activeSessionId}
          editingSessionId={editingSessionId}
          tabNotifications={tabNotifications}
          terminalBackgroundEnabled={terminalBackgroundEnabled}
          terminalBackgroundImagePath={terminalBackgroundImagePath}
          hiddenBackgroundSessionIds={hiddenBackgroundSessionIds}
          isPaneFullscreen={isPaneFullscreen}
          onActivateSession={onActivateSession}
          onCloseSessions={onCloseSessions}
          onStartEdit={onStartEdit}
          onSubmitEdit={onSubmitEdit}
          onCancelEdit={onCancelEdit}
          onNewTab={onNewTab}
          onDuplicateSession={onDuplicateSession}
          onSaveSessionToSidebar={onSaveSessionToSidebar}
          onOpenSplitPicker={onOpenSplitPicker}
          onUnsplit={onUnsplit}
          onMoveToPane={onMoveToPane}
          onHideBackground={onHideBackground}
          onShowBackground={onShowBackground}
          onTogglePaneFullscreen={onTogglePaneFullscreen}
          onDetachSessionToWorkspan={onDetachSessionToWorkspan}
          onOpenWorktreeChanges={onOpenWorktreeChanges}
          onOpenWorktreeHistory={onOpenWorktreeHistory}
          onFinishWorktree={onFinishWorktree}
          onInstallWorktreeDeps={onInstallWorktreeDeps}
          onDiscardWorktree={onDiscardWorktree}
          onOpenWorktreeDirectory={onOpenWorktreeDirectory}
          resolvedTheme={resolvedTheme}
          terminalThemeName={terminalThemeName}
          lightThemePalette={lightThemePalette}
          darkThemePalette={darkThemePalette}
        />
      )}
      <div
        className="ui-terminal-pane-content relative min-h-0 flex-1 overflow-hidden"
        onPointerDownCapture={() => {
          if (effectivePaneActiveSessionId && effectivePaneActiveSessionId !== useTerminalStore.getState().activeSessionId) {
            onActivateSession(effectivePaneActiveSessionId);
          }
        }}
        onFocusCapture={() => {
          if (effectivePaneActiveSessionId && effectivePaneActiveSessionId !== activeSessionId) {
            onActivateSession(effectivePaneActiveSessionId);
          }
        }}
      >
        {paneSessions.map((session) => (
          <div
            key={session.id}
            className="absolute inset-0"
            style={{ display: session.id === effectivePaneActiveSessionId ? "block" : "none" }}
          >
            {session.kind === "file-editor" ? (
              <Suspense fallback={null}>
                <FileEditorPane
                  session={session}
                  isActive={!historyActive && isLayoutVisible && session.id === activeSessionId}
                  terminalThemeBackground={terminalThemeBackground}
                  onClose={() => onCloseSessions([session.id])}
                />
              </Suspense>
            ) : session.kind === "subagent-transcript" ? (
              <Suspense fallback={null}>
                <SubagentTranscriptView
                  sessionId={session.id}
                  title={session.title}
                  isVisible={!historyActive && isLayoutVisible && session.id === effectivePaneActiveSessionId}
                />
              </Suspense>
            ) : session.remoteHandoff ? (
              <RemoteHandoffOverlay session={session} />
            ) : (
              <XTermTerminal
                sessionId={session.id}
                isActive={!historyActive && session.id === activeSessionId}
                isVisible={!historyActive && isLayoutVisible && session.id === effectivePaneActiveSessionId}
                fontSize={fontSize}
                fontFamily={fontFamily}
                resolvedTheme={resolvedTheme}
                terminalThemeName={terminalThemeName}
                lightThemePalette={lightThemePalette}
                darkThemePalette={darkThemePalette}
                onNewTab={onNewTab}
                onCloseSession={() => onCloseSessions([session.id])}
                onCloseOthers={
                  visiblePaneSessionIds.length > 1
                    ? () => onCloseSessions(visiblePaneSessionIds.filter((id) => id !== session.id))
                    : undefined
                }
                onCloseToLeft={
                  visiblePaneSessionIds.indexOf(session.id) > 0
                    ? () => onCloseSessions(visiblePaneSessionIds.slice(0, visiblePaneSessionIds.indexOf(session.id)))
                    : undefined
                }
                onCloseToRight={
                  visiblePaneSessionIds.indexOf(session.id) < visiblePaneSessionIds.length - 1
                    ? () => onCloseSessions(visiblePaneSessionIds.slice(visiblePaneSessionIds.indexOf(session.id) + 1))
                    : undefined
                }
                onSplitRight={(point) => onOpenSplitPicker(session.id, "horizontal", point)}
                onSplitDown={(point) => onOpenSplitPicker(session.id, "vertical", point)}
              />
            )}
          </div>
        ))}
        <PaneContentDropZones
          paneId={pane.id}
          enabled={isLayoutVisible}
          activeDropPreview={activeDropPreview}
        />
        {paneMarker && (
          <div
            className="ui-terminal-pane-marker"
            data-marker-style={paneMarkerStyle}
            data-marker-status={paneMarker.status}
            style={{
              "--terminal-pane-marker-color": paneMarker.color,
              "--terminal-pane-marker-width": `${paneMarker.width}px`,
              "--terminal-pane-marker-opacity": paneMarker.opacity,
            } as CSSProperties}
            aria-hidden="true"
          >
            <span className="ui-terminal-pane-marker__top" />
            <span className="ui-terminal-pane-marker__right" />
            <span className="ui-terminal-pane-marker__bottom" />
            <span className="ui-terminal-pane-marker__left" />
          </div>
        )}
      </div>
    </div>
  );
}

export function areSessionIdListsEqual(prevIds: string[], nextIds: string[]): boolean {
  if (prevIds.length !== nextIds.length) return false;
  for (let index = 0; index < prevIds.length; index += 1) {
    if (prevIds[index] !== nextIds[index]) return false;
  }
  return true;
}

export function findSessionById(sessions: TerminalSession[], sessionId: string): TerminalSession | undefined {
  return sessions.find((session) => session.id === sessionId);
}

export function findProjectById(projects: Project[], projectId: string | null | undefined): Project | undefined {
  if (!projectId) return undefined;
  return projects.find((project) => project.id === projectId);
}

export function paneContainsSessionId(pane: TerminalPaneLeaf, sessionId: string | null): boolean {
  return sessionId ? pane.sessionIds.includes(sessionId) : false;
}

export function didPaneSessionsChange(prevProps: PaneLeafViewProps, nextProps: PaneLeafViewProps): boolean {
  for (const sessionId of nextProps.pane.sessionIds) {
    if (findSessionById(prevProps.sessions, sessionId) !== findSessionById(nextProps.sessions, sessionId)) {
      return true;
    }
  }
  return false;
}

export function didPaneProjectsChange(prevProps: PaneLeafViewProps, nextProps: PaneLeafViewProps): boolean {
  for (const sessionId of nextProps.pane.sessionIds) {
    const nextSession = findSessionById(nextProps.sessions, sessionId);
    const projectId = nextSession?.projectId;
    if (findProjectById(prevProps.projects, projectId) !== findProjectById(nextProps.projects, projectId)) {
      return true;
    }
  }
  return false;
}

export function didPaneNotificationsChange(
  prevNotifications: Record<string, TabNotificationState>,
  nextNotifications: Record<string, TabNotificationState>,
  sessionIds: string[]
): boolean {
  for (const sessionId of sessionIds) {
    if ((prevNotifications[sessionId] ?? "none") !== (nextNotifications[sessionId] ?? "none")) {
      return true;
    }
  }
  return false;
}

export function didPaneHiddenBackgroundChange(prevHidden: Set<string>, nextHidden: Set<string>, sessionIds: string[]): boolean {
  for (const sessionId of sessionIds) {
    if (prevHidden.has(sessionId) !== nextHidden.has(sessionId)) {
      return true;
    }
  }
  return false;
}

export function areSessionIdSetsEqual(prev?: Set<string> | null, next?: Set<string> | null): boolean {
  if (prev === next) return true;
  if (!prev || !next) return false;
  if (prev.size !== next.size) return false;
  for (const id of prev) {
    if (!next.has(id)) return false;
  }
  return true;
}

export function getPaneSiblingsSignature(panes: TerminalPaneLeaf[]): string {
  return panes.map((pane) => `${pane.id}:${pane.sessionIds.length}`).join("|");
}

export function arePaneLeafViewPropsEqual(prevProps: PaneLeafViewProps, nextProps: PaneLeafViewProps): boolean {
  if (prevProps.pane.id !== nextProps.pane.id) return false;
  if (!areSessionIdListsEqual(prevProps.pane.sessionIds, nextProps.pane.sessionIds)) return false;
  if (prevProps.pane.activeSessionId !== nextProps.pane.activeSessionId) return false;
  if (prevProps.historyActive !== nextProps.historyActive) return false;
  if (prevProps.isPaneFullscreen !== nextProps.isPaneFullscreen) return false;
  if (prevProps.isLayoutVisible !== nextProps.isLayoutVisible) return false;
  if (prevProps.fontSize !== nextProps.fontSize || prevProps.fontFamily !== nextProps.fontFamily) return false;
  if (prevProps.resolvedTheme !== nextProps.resolvedTheme) return false;
  if (prevProps.terminalThemeName !== nextProps.terminalThemeName) return false;
  if (prevProps.terminalThemeBackground !== nextProps.terminalThemeBackground) return false;
  if (prevProps.lightThemePalette !== nextProps.lightThemePalette) return false;
  if (prevProps.darkThemePalette !== nextProps.darkThemePalette) return false;
  if (prevProps.terminalBackgroundEnabled !== nextProps.terminalBackgroundEnabled) return false;
  if (prevProps.terminalBackgroundImagePath !== nextProps.terminalBackgroundImagePath) return false;
  if (prevProps.hideTabBar !== nextProps.hideTabBar) return false;
  if (prevProps.paneMarkerSettings !== nextProps.paneMarkerSettings) return false;
  if (prevProps.isAppFocused !== nextProps.isAppFocused) return false;
  if (!areSessionIdSetsEqual(prevProps.visibleSessionIds, nextProps.visibleSessionIds)) return false;
  if (getPaneSiblingsSignature(prevProps.allPanes) !== getPaneSiblingsSignature(nextProps.allPanes)) return false;
  if ((prevProps.activeDropPreview?.paneId ?? null) !== (nextProps.activeDropPreview?.paneId ?? null)) return false;
  if ((prevProps.activeDropPreview?.edge ?? null) !== (nextProps.activeDropPreview?.edge ?? null)) return false;

  const wasEditingThisPane = paneContainsSessionId(prevProps.pane, prevProps.editingSessionId);
  const isEditingThisPane = paneContainsSessionId(nextProps.pane, nextProps.editingSessionId);
  if (wasEditingThisPane !== isEditingThisPane) return false;
  if (wasEditingThisPane && prevProps.editingSessionId !== nextProps.editingSessionId) return false;

  const wasActiveInThisPane = paneContainsSessionId(prevProps.pane, prevProps.activeSessionId);
  const isActiveInThisPane = paneContainsSessionId(nextProps.pane, nextProps.activeSessionId);
  if (wasActiveInThisPane !== isActiveInThisPane) return false;
  if (wasActiveInThisPane && prevProps.activeSessionId !== nextProps.activeSessionId) return false;

  if (didPaneSessionsChange(prevProps, nextProps)) return false;
  if (didPaneProjectsChange(prevProps, nextProps)) return false;
  if (prevProps.worktrees !== nextProps.worktrees) return false;
  if (didPaneNotificationsChange(prevProps.tabNotifications, nextProps.tabNotifications, nextProps.pane.sessionIds)) return false;
  if (didPaneNotificationsChange(prevProps.hookNotifications, nextProps.hookNotifications, nextProps.pane.sessionIds)) return false;
  if (didPaneHiddenBackgroundChange(prevProps.hiddenBackgroundSessionIds, nextProps.hiddenBackgroundSessionIds, nextProps.pane.sessionIds)) return false;

  return (
    prevProps.onActivateSession === nextProps.onActivateSession &&
    prevProps.onCloseSessions === nextProps.onCloseSessions &&
    prevProps.onStartEdit === nextProps.onStartEdit &&
    prevProps.onSubmitEdit === nextProps.onSubmitEdit &&
    prevProps.onCancelEdit === nextProps.onCancelEdit &&
    prevProps.onNewTab === nextProps.onNewTab &&
    prevProps.onDuplicateSession === nextProps.onDuplicateSession &&
    prevProps.onSaveSessionToSidebar === nextProps.onSaveSessionToSidebar &&
    prevProps.onOpenSplitPicker === nextProps.onOpenSplitPicker &&
    prevProps.onUnsplit === nextProps.onUnsplit &&
    prevProps.onMoveToPane === nextProps.onMoveToPane &&
    prevProps.onHideBackground === nextProps.onHideBackground &&
    prevProps.onShowBackground === nextProps.onShowBackground &&
    prevProps.onTogglePaneFullscreen === nextProps.onTogglePaneFullscreen &&
    prevProps.onDetachSessionToWorkspan === nextProps.onDetachSessionToWorkspan &&
    prevProps.onOpenWorktreeChanges === nextProps.onOpenWorktreeChanges &&
    prevProps.onOpenWorktreeHistory === nextProps.onOpenWorktreeHistory &&
    prevProps.onFinishWorktree === nextProps.onFinishWorktree &&
    prevProps.onInstallWorktreeDeps === nextProps.onInstallWorktreeDeps &&
    prevProps.onDiscardWorktree === nextProps.onDiscardWorktree &&
    prevProps.onOpenWorktreeDirectory === nextProps.onOpenWorktreeDirectory
  );
}

export const MemoPaneLeafView = memo(PaneLeafView, arePaneLeafViewPropsEqual);
