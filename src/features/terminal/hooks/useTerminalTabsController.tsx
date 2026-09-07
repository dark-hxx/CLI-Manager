import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useShallow } from "zustand/shallow";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import {
  PointerSensor, useSensor, useSensors, type DragEndEvent, type DragOverEvent, type DragStartEvent,
} from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import { useTerminalStore, type TabNotificationState } from "../../../stores/terminalStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import { updateWorkspaceLayout } from "../../../lib/workspaceLayout";
import { useWorktreeStore } from "../../../stores/worktreeStore";
import { useProjectStore } from "../../../stores/projectStore";
import { useFileExplorerStore } from "../../../stores/fileExplorerStore";
import { useI18n } from "../../../lib/i18n";
import { logError } from "../../../lib/logger";
import {
  DND_ACTIVATION_CONSTRAINT, parseWorkspanDragId, resolveWorkspanDragHoverTarget,
  WORKSPAN_DRAG_AUTO_ACTIVATE_MS,
} from "../../../lib/dragInteraction";
import type { TerminalPaneLeaf, TerminalPaneSplitDirection } from "../../../stores/terminalPaneTree";
import { collectPaneLeaves, filterPaneTreeBySessionIds, findFirstSessionId } from "../../../stores/terminalPaneTree";
import { collectWorkspanSessionIds } from "../../../stores/terminalWorkspan";
import { type BackgroundTaskMeta } from "../../../components/BackgroundTasksPanel";
import {
  TERMINAL_SIDE_PANEL_TAB_ORDER, type TerminalSidePanelTab,
} from "../../../components/terminal/TerminalSidePanel";
import { openWindowsTerminal } from "../../../lib/externalTerminal";
import { resolveProjectPath } from "../../../lib/groupPath";
import { normalizeDirectCodexStartupCommand } from "../../../lib/projectStartupCommand";
import {
  isSshGrokHistoryUnsupported, isSshHistorySourceUnsupported, projectSupportsCapability,
  resolveProjectCapabilities, type ProjectCapability,
} from "../../../lib/projectCapabilities";
import { resolveHistoryProjectPath } from "../../../lib/historyProjectPaths";
import { resolveAgentRuntimeKind } from "../../../lib/agentCapabilities";
import { resolveProviderSwitchAppType } from "../../../lib/providerSwitching";
import { inferVendor } from "../../../components/VendorIcon";
import { useAppPrompt } from "../../../components/ui/useAppPrompt";
import { useAppConfirm } from "../../../components/ui/useAppConfirm";
import { useHistoryStore } from "../../../stores/historyStore";
import { useGitWorkspaceStore } from "../../../stores/gitWorkspaceStore";
import { useSaveSessionToSidebar } from "../../../hooks/useSaveSessionToSidebar";
import {
  shouldConfirmTerminalTabClose, TERMINAL_TAB_CLOSE_REQUEST_EVENT, type TerminalTabCloseRequestDetail,
} from "../../../lib/terminalCloseConfirm";
import type { Project, TerminalSession, WorktreeRecord } from "../../../lib/types";
import type { NativeProviderAppType } from "../../../components/settings/providers/nativeProviderTypes";
import { getTerminalTheme, isLightTerminalTheme } from "../../../lib/terminalThemes";
import { getTerminalSidePanelSkinStyle } from "../../../components/stats/termStatsUi";
import {
  findWorktreeForSession, isSameProjectFileContext, projectWithWorktreeProviderOverrides,
  resolveProjectForSessionFileContext,
} from "../../../lib/terminalProject";
import {
  ALL_TERMINALS_SCOPE, collectProjectIdsForGroup, sessionMatchesTerminalScope,
} from "../../../lib/terminalScope";
import {
  TERMINAL_FILE_NAVIGATION_REQUEST_EVENT, type TerminalFileNavigationRequest,
} from "../../../lib/terminalFileNavigation";
import { consumeTerminalFileDragPanelSyncSuppression } from "../../../lib/terminalFileDrag";
import {
  WORKSPAN_TABBAR_END_DROP_ID, type WorkspanTabModel, type WorkspanTabOverflowState,
} from "../../../components/workspace/WorkspanTabBar";
import {
  normalizeTabMenuHex, TERMINAL_PANEL_SEMANTIC_COLORS, tabMenuHexToRgba,
  SPLIT_PICKER_OUTSIDE_GUARD_MS, type SplitPickerAnchor, type SplitPickerAlign, type SplitPickerState,
  type TerminalCloseConfirmState, type PaneDropPreview, getWorkspanNotification, parsePaneDropTarget,
  resolveWorkspanDropEdge, resolveHistorySourceFilter, inferSessionVendor, inferSessionCliToolIcon,
  buildProjectSplitOptions, type TerminalTabsProps,
} from "../lib/terminalTabsModel";
import { MemoPaneLeafView } from "../components/PaneLeafView";
import { useTerminalToolbarRenderer } from "./useTerminalToolbarRenderer";
import { useScopedTerminalEmptyState } from "./useScopedTerminalEmptyState";

export function useTerminalTabsController({
  fullscreen = false,
  onToggleFullscreen,
  projectScopedTerminalViewEnabled = false,
  terminalScope = ALL_TERMINALS_SCOPE,
  onOpenProviderSettings,
  onOpenHistorySettings,
}: TerminalTabsProps = {}) {
  const { t } = useI18n();
  const { prompt, promptDialog } = useAppPrompt();
  const { confirm, confirmDialog } = useAppConfirm();
  const { saveSession: saveSessionToSidebar, saveSessionDialog } = useSaveSessionToSidebar();
  const { sessions, activeSessionId, workspans, activeWorkspanId, tabNotifications, tabStatuses } = useTerminalStore(
    useShallow((s) => ({
      sessions: s.sessions,
      activeSessionId: s.activeSessionId,
      workspans: s.workspans,
      activeWorkspanId: s.activeWorkspanId,
      tabNotifications: s.tabNotifications,
      tabStatuses: s.tabStatuses,
    }))
  );
  const setActive = useTerminalStore((s) => s.setActive);
  const setActiveWorkspan = useTerminalStore((s) => s.setActiveWorkspan);
  const reorderWorkspans = useTerminalStore((s) => s.reorderWorkspans);
  const renameWorkspan = useTerminalStore((s) => s.renameWorkspan);
  const restoreWorkspanToSinglePane = useTerminalStore((s) => s.restoreWorkspanToSinglePane);
  const mergeWorkspanAtPaneEdge = useTerminalStore((s) => s.mergeWorkspanAtPaneEdge);
  const closeSession = useTerminalStore((s) => s.closeSession);
  const createSession = useTerminalStore((s) => s.createSession);
  const reorderSessions = useTerminalStore((s) => s.reorderSessions);
  const moveSessionToPane = useTerminalStore((s) => s.moveSessionToPane);
  const detachSessionToWorkspan = useTerminalStore((s) => s.detachSessionToWorkspan);
  const splitSessionToPaneEdge = useTerminalStore((s) => s.splitSessionToPaneEdge);
  const renameSession = useTerminalStore((s) => s.renameSession);
  const splitTerminal = useTerminalStore((s) => s.splitTerminal);
  const unsplitTerminal = useTerminalStore((s) => s.unsplitTerminal);
  const hiddenBackgroundSessionIds = useTerminalStore((s) => s.hiddenBackgroundSessionIds);
  const hideBackgroundForSession = useTerminalStore((s) => s.hideBackgroundForSession);
  const showBackgroundForSession = useTerminalStore((s) => s.showBackgroundForSession);
  const { groups, projects, tree: projectTree } = useProjectStore(
    useShallow((s) => ({
      groups: s.groups,
      projects: s.projects,
      tree: s.tree,
    }))
  );
  const worktrees = useWorktreeStore((s) => s.worktrees);
  const checkWorktreeDeps = useWorktreeStore((s) => s.checkDeps);
  const dismissWorktreeDepsPrompt = useWorktreeStore((s) => s.dismissDepsPrompt);
  const removeWorktree = useWorktreeStore((s) => s.removeWorktree);
  const useExternalTerminal = useSettingsStore((s) => s.useExternalTerminal);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const fontFamily = useSettingsStore((s) => s.fontFamily);
  const resolvedTheme = useSettingsStore((s) => s.resolvedTheme);
  const terminalThemeName = useSettingsStore((s) => s.terminalThemeName);
  const lightThemePalette = useSettingsStore((s) => s.lightThemePalette);
  const darkThemePalette = useSettingsStore((s) => s.darkThemePalette);
  const terminalBackgroundEnabled = useSettingsStore((s) => s.terminalBackground.enabled);
  const paneMarkerSettings = useSettingsStore((s) => s.terminalPaneMarker);
  const [isAppFocused, setIsAppFocused] = useState(() => document.visibilityState !== "hidden" && document.hasFocus());
  const hookNotifications = useMemo<Record<string, TabNotificationState>>(() => {
    const next: Record<string, TabNotificationState> = {};
    for (const [sessionId, status] of Object.entries(tabStatuses)) {
      next[sessionId] = status.hook ?? "none";
    }
    return next;
  }, [tabStatuses]);

  useEffect(() => {
    const updateFocusState = () => {
      setIsAppFocused(document.visibilityState !== "hidden" && document.hasFocus());
    };
    window.addEventListener("focus", updateFocusState);
    window.addEventListener("blur", updateFocusState);
    document.addEventListener("visibilitychange", updateFocusState);
    return () => {
      window.removeEventListener("focus", updateFocusState);
      window.removeEventListener("blur", updateFocusState);
      document.removeEventListener("visibilitychange", updateFocusState);
    };
  }, []);
  const terminalBackgroundImagePath = useSettingsStore((s) => s.terminalBackground.imagePath);
  const terminalSidePanelSide = useSettingsStore((s) => s.workspaceLayout.terminalSidePanelSide);
  const terminalSidePanelVisible = useSettingsStore((s) => s.workspaceLayout.terminalSidePanelVisible);
  const workspanTabBarPosition = useSettingsStore((s) => s.workspaceLayout.workspanTabBarPosition);
  const workspanTabBarVisible = useSettingsStore((s) => s.workspaceLayout.workspanTabBarVisible);
  const workspanEnabled = useSettingsStore((s) => s.workspanEnabled);
  const terminalToolbarVisibility = useSettingsStore((s) => s.terminalToolbarVisibility);
  const terminalToolbarOrder = useSettingsStore((s) => s.terminalToolbarOrder);
  const systemResourceMonitoringEnabled = useSettingsStore((s) => s.systemResourceMonitoringEnabled);
  const cpuResourceCardVisible = useSettingsStore((s) => s.systemResourceCardVisibility.cpu);
  const sidePanelMerged = useSettingsStore((s) => s.terminalSidePanelMerged);
  const terminalSidePanelSingleOpen = useSettingsStore((s) => s.terminalSidePanelSingleOpen);
  const terminalSidePanelSkin = useSettingsStore((s) => s.terminalSidePanelSkin);
  const updateSettings = useSettingsStore((s) => s.update);
  const ensureTerminalSidePanelVisible = useCallback(() => {
    const current = useSettingsStore.getState().workspaceLayout;
    if (current.terminalSidePanelVisible) return false;
    void updateSettings(
      "workspaceLayout",
      updateWorkspaceLayout(current, { terminalSidePanelVisible: true }),
    );
    return true;
  }, [updateSettings]);
  const openFileProject = useFileExplorerStore((s) => s.openProject);
  const revealFilePath = useFileExplorerStore((s) => s.revealPath);
  const openFileEditorPane = useTerminalStore((s) => s.openFileEditorPane);
  const sessionHistoryShortcut = useSettingsStore((s) => s.keyboardShortcuts.sessionHistory);
  const sessionHistoryShortcutHint = sessionHistoryShortcut.trim() || t("common.none");
  const historyOpen = useHistoryStore((s) => s.isOpen);
  const openHistory = useHistoryStore((s) => s.openHistory);
  const closeHistory = useHistoryStore((s) => s.closeHistory);
  const focusGlobalSearchSeq = useHistoryStore((s) => s.focusGlobalSearchSeq);
  const gitWorkspaceOpen = useGitWorkspaceStore((s) => s.isOpen);
  const closeGitWorkspace = useGitWorkspaceStore((s) => s.close);
  const [gitWorkspaceHeight, setGitWorkspaceHeight] = useState(420);
  const gitWorkspaceResizeCleanupRef = useRef<(() => void) | null>(null);
  const [activeWorkspaceTab, setActiveWorkspaceTab] = useState<"terminal" | "history">("terminal");
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [splitPicker, setSplitPicker] = useState<SplitPickerState>(null);
  const [closeConfirm, setCloseConfirm] = useState<TerminalCloseConfirmState>(null);
  const [daemonTasks, setDaemonTasks] = useState<BackgroundTaskMeta[]>([]);
  const [activeDropPreview, setActiveDropPreview] = useState<PaneDropPreview>(null);
  const [workspanDetachPreview, setWorkspanDetachPreview] = useState({
    left: 0,
    targetId: null as string | null,
    visible: false,
  });
  const [fullscreenPaneId, setFullscreenPaneId] = useState<string | null>(null);
  const [workspanTabListOpen, setWorkspanTabListOpen] = useState(false);
  const [workspanTabOverflow, setWorkspanTabOverflow] = useState<WorkspanTabOverflowState>({
    isOverflowing: false,
    hiddenIds: [],
  });
  const [sidePanelOpen, setSidePanelOpen] = useState(false);
  const [sidePanelTab, setSidePanelTab] = useState<TerminalSidePanelTab>("stats");
  // 非合并模式：实时统计与 Git 变更各自独立开关，可并排显示
  const [statsOpen, setStatsOpen] = useState(false);
  const [gitOpen, setGitOpen] = useState(false);
  const [replayOpen, setReplayOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [systemResourcesOpen, setSystemResourcesOpen] = useState(false);
  const [providersOpen, setProvidersOpen] = useState(false);
  const [finishTarget, setFinishTarget] = useState<{ project: Project; worktree: WorktreeRecord } | null>(null);
  const [discardTarget, setDiscardTarget] = useState<{ project: Project; worktree: WorktreeRecord } | null>(null);
  const [activeToolbarDragId, setActiveToolbarDragId] = useState<string | null>(null);
  const splitPickerOpenFrameRef = useRef<number | null>(null);
  const splitPickerOpenTimerRef = useRef<number | null>(null);
  const splitPickerOutsideGuardUntilRef = useRef(0);
  const closeConfirmOutsideGuardUntilRef = useRef(0);
  const workspanTabBarRef = useRef<HTMLDivElement | null>(null);
  const workspanTabScrollRef = useRef<HTMLDivElement | null>(null);
  const activeDragWorkspanIdRef = useRef<string | null>(null);
  const workspanDragOverflowFrameRef = useRef<number | null>(null);
  const workspanDragHoverTargetRef = useRef<string | null>(null);
  const workspanDragHoverTimerRef = useRef<number | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: DND_ACTIVATION_CONSTRAINT }));
  const toolbarSensors = useSensors(useSensor(PointerSensor, { activationConstraint: DND_ACTIVATION_CONSTRAINT }));

  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
  const worktreeById = useMemo(() => new Map(worktrees.map((worktree) => [worktree.id, worktree])), [worktrees]);
  const rejectUnsupportedCapability = useCallback((project: Project | null | undefined, capability: ProjectCapability) => {
    if (projectSupportsCapability(project, capability)) return false;
    const sshHistoryUnsupported = capability === "history" && isSshHistorySourceUnsupported(project);
    const title = sshHistoryUnsupported
      ? isSshGrokHistoryUnsupported(project)
        ? t("remoteCapabilities.grokHistoryUnsupportedTitle")
        : t("remoteCapabilities.sshHistoryUnsupportedTitle")
      : t("remoteCapabilities.unsupportedTitle");
    toast.info(title, {
      description: sshHistoryUnsupported
        ? t("remoteCapabilities.sshHistoryUnsupportedDescription")
        : t("remoteCapabilities.unsupportedDescription"),
    });
    return true;
  }, [t]);
  const terminalScopeValue = projectScopedTerminalViewEnabled ? terminalScope : ALL_TERMINALS_SCOPE;
  const scopedProjectId =
    terminalScopeValue.kind === "project" || terminalScopeValue.kind === "worktree"
      ? terminalScopeValue.projectId
      : null;
  const scopedProject = useMemo(
    () => (scopedProjectId ? projectById.get(scopedProjectId) ?? null : null),
    [projectById, scopedProjectId]
  );
  const scopedWorktree = useMemo(
    () => (terminalScopeValue.kind === "worktree" ? worktreeById.get(terminalScopeValue.worktreeId) ?? null : null),
    [terminalScopeValue, worktreeById]
  );
  const rejectMissingWorktree = useCallback((worktree: WorktreeRecord | null | undefined): boolean => {
    if (!worktree || worktree.status !== "missing") return false;
    toast.error(t("worktree.status.missing"), { description: worktree.path });
    return true;
  }, [t]);
  const rejectMissingSessionWorktree = useCallback((session: TerminalSession | null | undefined): boolean => {
    if (!session?.worktreeId) return false;
    return rejectMissingWorktree(worktreeById.get(session.worktreeId));
  }, [rejectMissingWorktree, worktreeById]);
  const scopedGroup = useMemo(
    () => (terminalScopeValue.kind === "group" ? groups.find((group) => group.id === terminalScopeValue.groupId) ?? null : null),
    [groups, terminalScopeValue]
  );
  const scopedGroupProjectIds = useMemo(
    () => (terminalScopeValue.kind === "group" ? collectProjectIdsForGroup(groups, projects, terminalScopeValue.groupId) : null),
    [groups, projects, terminalScopeValue]
  );
  const scopedSessionIds = useMemo(() => {
    if (!projectScopedTerminalViewEnabled || terminalScopeValue.kind === "all") return null;
    const next = new Set<string>();
    for (const session of sessions) {
      if (sessionMatchesTerminalScope(session, terminalScopeValue, sessions, projects, projectById, worktrees, scopedGroupProjectIds)) {
        next.add(session.id);
      }
    }
    return next;
  }, [projectById, projectScopedTerminalViewEnabled, projects, scopedGroupProjectIds, sessions, terminalScopeValue, worktrees]);
  // Keep the original Workspan trees mounted. The scoped tree is presentation-only;
  // moving a session into a separate hidden tree would recreate its xterm instance.
  const mountedWorkspanLayouts = useMemo(() => workspans.flatMap((workspan) => {
    if (!workspan.paneTree) return [];
    const visiblePaneTree = scopedSessionIds
      ? filterPaneTreeBySessionIds(workspan.paneTree, scopedSessionIds)
      : workspan.paneTree;
    const visiblePanes = collectPaneLeaves(visiblePaneTree);
    const visibleSessionIds = visiblePanes.flatMap((pane) => pane.sessionIds);
    return [{
      workspan,
      paneTree: workspan.paneTree,
      visiblePaneTree,
      visiblePanes,
      visiblePaneIds: new Set(visiblePanes.map((pane) => pane.id)),
      sessionIds: collectWorkspanSessionIds(workspan),
      closeSessionIds: visibleSessionIds,
    }];
  }), [scopedSessionIds, workspans]);
  const visibleWorkspanLayouts = useMemo(() => mountedWorkspanLayouts.flatMap((layout) => (
    layout.visiblePaneTree
      ? [{
          workspan: layout.workspan,
          paneTree: layout.visiblePaneTree,
          panes: layout.visiblePanes,
          sessionIds: layout.sessionIds,
          closeSessionIds: layout.closeSessionIds,
        }]
      : []
  )), [mountedWorkspanLayouts]);
  const effectiveActiveWorkspanId = visibleWorkspanLayouts.some(({ workspan }) => workspan.id === activeWorkspanId)
    ? activeWorkspanId
    : visibleWorkspanLayouts[0]?.workspan.id ?? null;
  const activeWorkspanLayout = visibleWorkspanLayouts.find(({ workspan }) => workspan.id === effectiveActiveWorkspanId) ?? null;
  const renderPaneTree = activeWorkspanLayout?.paneTree ?? null;
  const visibleSessions = useMemo(
    () => (scopedSessionIds ? sessions.filter((session) => scopedSessionIds.has(session.id)) : sessions),
    [scopedSessionIds, sessions]
  );
  const allPanes = activeWorkspanLayout?.panes ?? [];
  const activeFullscreenPaneId = useMemo(() => {
    if (!fullscreenPaneId) return null;
    const pane = allPanes.find((item) => item.id === fullscreenPaneId);
    if (!pane) return null;
    if (scopedSessionIds && !pane.sessionIds.some((sessionId) => scopedSessionIds.has(sessionId))) return null;
    return fullscreenPaneId;
  }, [allPanes, fullscreenPaneId, scopedSessionIds]);
  const preferredScopedSessionId = useMemo(() => {
    if (!scopedSessionIds) return null;
    if (activeSessionId && scopedSessionIds.has(activeSessionId)) return activeSessionId;
    return findFirstSessionId(renderPaneTree);
  }, [activeSessionId, renderPaneTree, scopedSessionIds]);
  const effectiveActiveSessionId = preferredScopedSessionId ?? activeSessionId;
  const activeSession = useMemo(
    () => {
      if (scopedSessionIds && !preferredScopedSessionId) return null;
      return effectiveActiveSessionId ? sessions.find((session) => session.id === effectiveActiveSessionId) ?? null : null;
    },
    [effectiveActiveSessionId, preferredScopedSessionId, scopedSessionIds, sessions]
  );
  // 子 Agent 转录伪会话没有自己的 CLI 会话/项目：实时统计与 Git 面板落到其父终端，
  // 避免聚焦转录 Tab 时面板被清空/错位。
  useEffect(() => {
    if (!projectScopedTerminalViewEnabled || terminalScopeValue.kind === "all") return;
    const currentActiveSessionId = useTerminalStore.getState().activeSessionId;
    if (currentActiveSessionId && scopedSessionIds?.has(currentActiveSessionId)) return;
    if (!preferredScopedSessionId || preferredScopedSessionId === currentActiveSessionId) return;
    setActive(preferredScopedSessionId);
  }, [preferredScopedSessionId, projectScopedTerminalViewEnabled, scopedSessionIds, setActive, terminalScopeValue]);

  const panelSession = useMemo(() => {
    if (activeSession?.kind === "subagent-transcript" && activeSession.subagent) {
      return sessions.find((session) => session.id === activeSession.subagent!.parentSessionId) ?? activeSession;
    }
    if (activeSession?.kind === "file-editor") {
      return null;
    }
    return activeSession;
  }, [activeSession, sessions]);
  const panelSessionId = panelSession?.id ?? null;
  const panelProject = panelSession?.projectId ? projectById.get(panelSession.projectId) ?? null : null;
  const panelProviderAppType: NativeProviderAppType = resolveProviderSwitchAppType(panelSession, panelProject) ?? "claude";
  const panelCapabilities = resolveProjectCapabilities(panelProject);
  const panelGitSupported = panelCapabilities.git || panelProject?.environment_type === "ssh";
  const activeWorktree = useMemo(
    () => findWorktreeForSession(activeSession, sessions, worktrees),
    [activeSession, sessions, worktrees]
  );
  const filePanelProject = useMemo(
    () => resolveProjectForSessionFileContext(activeSession, sessions, projects, projectById, worktrees),
    [activeSession, projectById, projects, sessions, worktrees]
  );
  const sidePanelProjectPath = panelProject?.environment_type === "ssh"
    ? panelProject.remote_path.trim() || null
    : panelSession?.cwd?.trim() || filePanelProject?.path.trim() || null;
  const gitWorkspaceProject = panelProject ?? scopedProject ?? filePanelProject;
  const gitWorkspaceProjectPath = sidePanelProjectPath
    ?? scopedWorktree?.path.trim()
    ?? (gitWorkspaceProject?.environment_type === "ssh"
      ? gitWorkspaceProject.remote_path.trim() || null
      : gitWorkspaceProject?.path.trim() || null);
  const workspanTabModels = useMemo<WorkspanTabModel[]>(() => visibleWorkspanLayouts.map(({ workspan, sessionIds, closeSessionIds }) => {
    const memberSessions = sessionIds
      .map((sessionId) => sessions.find((session) => session.id === sessionId))
      .filter((session): session is TerminalSession => Boolean(session));
    const singleSession = memberSessions.length === 1 ? memberSessions[0] : null;
    return {
      workspan,
      sessionIds,
      closeSessionIds,
      singleSession,
      title: workspan.customTitle ?? singleSession?.title ?? t("terminal.workspan.title", { count: memberSessions.length }),
      notification: getWorkspanNotification(sessionIds, tabNotifications),
      vendor: singleSession ? (inferVendor(projectById.get(singleSession.projectId!)?.cli_tool) ?? inferSessionVendor(singleSession)) : null,
      cliToolIcon: singleSession
        ? inferSessionCliToolIcon(singleSession, projectById.get(singleSession.projectId!))
        : null,
    };
  }), [projectById, sessions, t, tabNotifications, visibleWorkspanLayouts]);
  const workspanTabSignature = workspanTabModels
    .map(({ workspan, title, vendor, cliToolIcon }) => `${workspan.id}:${title}:${vendor ?? "none"}:${cliToolIcon ?? "none"}`)
    .join("|");
  const activateWorkspanTab = useCallback((workspanId: string) => {
    setActiveWorkspaceTab("terminal");
    setActiveWorkspan(workspanId);
  }, [setActiveWorkspan]);

  const clearWorkspanDragHoverActivation = useCallback(() => {
    if (workspanDragHoverTimerRef.current !== null) {
      window.clearTimeout(workspanDragHoverTimerRef.current);
      workspanDragHoverTimerRef.current = null;
    }
    workspanDragHoverTargetRef.current = null;
  }, []);

  const scheduleWorkspanDragHoverActivation = useCallback((targetWorkspanId: string) => {
    if (workspanDragHoverTargetRef.current === targetWorkspanId) return;
    clearWorkspanDragHoverActivation();
    workspanDragHoverTargetRef.current = targetWorkspanId;
    workspanDragHoverTimerRef.current = window.setTimeout(() => {
      workspanDragHoverTimerRef.current = null;
      if (workspanDragHoverTargetRef.current !== targetWorkspanId) return;
      activateWorkspanTab(targetWorkspanId);
    }, WORKSPAN_DRAG_AUTO_ACTIVATE_MS);
  }, [activateWorkspanTab, clearWorkspanDragHoverActivation]);

  useEffect(() => clearWorkspanDragHoverActivation, [clearWorkspanDragHoverActivation]);

  const updateWorkspanTabOverflow = useCallback(() => {
    if (activeDragWorkspanIdRef.current) return;
    const bar = workspanTabBarRef.current;
    const scroller = workspanTabScrollRef.current;
    if (!bar || !scroller) {
      setWorkspanTabOverflow((current) => {
        if (!current.isOverflowing && current.hiddenIds.length === 0) return current;
        return { isOverflowing: false, hiddenIds: [] };
      });
      return;
    }

    const barStyle = window.getComputedStyle(bar);
    const paddingLeft = Number.parseFloat(barStyle.paddingLeft) || 0;
    const paddingRight = Number.parseFloat(barStyle.paddingRight) || 0;
    const fullAvailableWidth = Math.max(0, bar.clientWidth - paddingLeft - paddingRight);
    const isOverflowing = scroller.scrollWidth > fullAvailableWidth + 1;
    const viewportRect = scroller.getBoundingClientRect();
    const hiddenIds = isOverflowing
      ? Array.from(scroller.querySelectorAll<HTMLElement>("[data-workspan-id]"))
          .filter((tab) => {
            const tabRect = tab.getBoundingClientRect();
            return tabRect.left < viewportRect.left + 1 || tabRect.right > viewportRect.right - 1;
          })
          .map((tab) => tab.dataset.workspanId)
          .filter((id): id is string => Boolean(id))
      : [];

    setWorkspanTabOverflow((current) => {
      const hiddenIdsUnchanged =
        current.hiddenIds.length === hiddenIds.length &&
        current.hiddenIds.every((id, index) => id === hiddenIds[index]);
      if (current.isOverflowing === isOverflowing && hiddenIdsUnchanged) return current;
      return { isOverflowing, hiddenIds };
    });
  }, []);

  useEffect(() => () => {
    if (workspanDragOverflowFrameRef.current !== null) {
      window.cancelAnimationFrame(workspanDragOverflowFrameRef.current);
    }
  }, []);

  useEffect(() => {
    const bar = workspanTabBarRef.current;
    const scroller = workspanTabScrollRef.current;
    let frameId: number | null = null;
    const scheduleUpdate = () => {
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        updateWorkspanTabOverflow();
      });
    };

    scheduleUpdate();
    if (!bar || !scroller) {
      return () => {
        if (frameId !== null) window.cancelAnimationFrame(frameId);
      };
    }

    scroller.addEventListener("scroll", scheduleUpdate, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleUpdate);
    observer?.observe(bar);
    observer?.observe(scroller);
    scroller.querySelectorAll<HTMLElement>("[data-workspan-id]").forEach((tab) => observer?.observe(tab));

    return () => {
      scroller.removeEventListener("scroll", scheduleUpdate);
      observer?.disconnect();
      if (frameId !== null) window.cancelAnimationFrame(frameId);
    };
  }, [updateWorkspanTabOverflow, workspanEnabled, workspanTabBarVisible, workspanTabSignature]);

  useEffect(() => {
    if (!workspanTabOverflow.isOverflowing || workspanTabOverflow.hiddenIds.length === 0) {
      setWorkspanTabListOpen(false);
    }
  }, [workspanTabOverflow.hiddenIds.length, workspanTabOverflow.isOverflowing]);

  useEffect(() => {
    if (!workspanTabBarVisible) setWorkspanTabListOpen(false);
  }, [workspanTabBarVisible]);

  useEffect(() => {
    if (!effectiveActiveWorkspanId) return;
    const frameId = window.requestAnimationFrame(() => {
      const tab = Array.from(workspanTabScrollRef.current?.querySelectorAll<HTMLElement>("[data-workspan-id]") ?? [])
        .find((node) => node.dataset.workspanId === effectiveActiveWorkspanId);
      tab?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [effectiveActiveWorkspanId, workspanEnabled, workspanTabModels.length]);
  const terminalTheme = useMemo(
    () => getTerminalTheme(terminalThemeName, resolvedTheme, lightThemePalette, darkThemePalette),
    [darkThemePalette, lightThemePalette, resolvedTheme, terminalThemeName]
  );
  const terminalThemeTone: "light" | "dark" = isLightTerminalTheme(terminalTheme) ? "light" : "dark";
  const terminalThemeBackground = terminalTheme.background ?? (resolvedTheme === "dark" ? "#0c0e10" : "#ffffff");
  const terminalThemeForeground = terminalTheme.foreground ?? (resolvedTheme === "dark" ? "#f8fafc" : "#1e293b");
  const terminalThemeAccent = terminalTheme.blue ?? terminalTheme.cursor ?? terminalThemeForeground;
  const terminalThemeMuted = terminalTheme.brightBlack ?? terminalTheme.white ?? terminalThemeForeground;
  const terminalThemeSelection = terminalTheme.selectionBackground ?? terminalThemeAccent;
  const terminalPanelSemanticColors = TERMINAL_PANEL_SEMANTIC_COLORS[terminalThemeTone];
  const splitPickerMenuForeground = normalizeTabMenuHex(terminalTheme.foreground, resolvedTheme === "dark" ? "#d8dee9" : "#1e293b");
  const splitPickerMenuBackground = normalizeTabMenuHex(terminalTheme.background, terminalThemeBackground);
  const splitPickerMenuStyle = {
    "--menu-fg": splitPickerMenuForeground,
    "--menu-bg": splitPickerMenuBackground,
    "--menu-border": tabMenuHexToRgba(splitPickerMenuForeground, 0.18, "rgba(255, 255, 255, 0.18)"),
    "--menu-hover": tabMenuHexToRgba(splitPickerMenuForeground, 0.12, "rgba(255, 255, 255, 0.12)"),
  } as CSSProperties;
  const terminalWellStyle = useMemo(() => ({
    "--terminal-bridge-color": terminalThemeBackground,
    "--terminal-theme-background": terminalThemeBackground,
    "--terminal-theme-foreground": terminalThemeForeground,
    "--terminal-theme-muted": terminalThemeMuted,
    "--terminal-theme-accent": terminalThemeAccent,
    "--terminal-theme-selection": terminalThemeSelection,
    "--term-panel-bg": "var(--terminal-theme-background, #0c0e10)",
    "--term-panel-card": "color-mix(in srgb, var(--terminal-theme-background, #0c0e10) 91%, var(--term-panel-fg, #ececec) 9%)",
    "--term-panel-card-inner": "color-mix(in srgb, var(--terminal-theme-background, #0c0e10) 87%, var(--term-panel-fg, #ececec) 13%)",
    "--term-panel-border": "color-mix(in srgb, var(--term-panel-fg, #ececec) 14%, transparent)",
    "--term-panel-fg": terminalPanelSemanticColors.fg,
    "--term-panel-dim": terminalPanelSemanticColors.dim,
    "--term-panel-green": terminalPanelSemanticColors.green,
    "--term-panel-yellow": terminalPanelSemanticColors.yellow,
    "--term-panel-red": terminalPanelSemanticColors.red,
    "--term-panel-magenta": terminalPanelSemanticColors.magenta,
    "--term-panel-cyan": terminalPanelSemanticColors.cyan,
    "--term-panel-blue": terminalPanelSemanticColors.blue,
    "--term-panel-track": "color-mix(in srgb, var(--terminal-theme-background, #0c0e10) 94%, var(--term-panel-fg, #ececec) 6%)",
  }) as CSSProperties, [
    terminalPanelSemanticColors,
    terminalThemeAccent,
    terminalThemeBackground,
    terminalThemeForeground,
    terminalThemeMuted,
    terminalThemeSelection,
  ]);
  const terminalActionSidebarStyle = useMemo(
    () => getTerminalSidePanelSkinStyle(terminalSidePanelSkin),
    [terminalSidePanelSkin]
  );
  const terminalPopoverStyle = useMemo(
    () => ({ ...terminalWellStyle, ...terminalActionSidebarStyle }),
    [terminalActionSidebarStyle, terminalWellStyle]
  );
  const visibleSidePanelTabs = useMemo(
    () => TERMINAL_SIDE_PANEL_TAB_ORDER.filter((tab) => {
      if (tab === "git") return terminalToolbarVisibility.gitChanges && panelGitSupported;
      if (tab === "stats") return terminalToolbarVisibility.stats && panelCapabilities.statistics;
      if (tab === "replay") return terminalToolbarVisibility.replay && panelCapabilities.history;
      if (tab === "files") return terminalToolbarVisibility.files && panelCapabilities.files;
      return terminalToolbarVisibility[tab];
    }),
    [panelCapabilities.files, panelCapabilities.history, panelCapabilities.statistics, panelGitSupported, terminalToolbarVisibility]
  );
  const historyActive = historyOpen && activeWorkspaceTab === "history";
  const fullWorkspaceActive = historyActive;
  const statsPanelActive = sidePanelMerged ? sidePanelOpen && sidePanelTab === "stats" : statsOpen;
  const replayPanelActive = sidePanelMerged ? sidePanelOpen && sidePanelTab === "replay" : replayOpen;
  const gitPanelActive = sidePanelMerged ? sidePanelOpen && sidePanelTab === "git" : gitOpen;
  const filesPanelActive = sidePanelMerged ? sidePanelOpen && sidePanelTab === "files" : filesOpen;
  const providersPanelActive = sidePanelMerged ? sidePanelOpen && sidePanelTab === "providers" : providersOpen;
  const systemResourcesPanelActive = sidePanelMerged
    ? sidePanelOpen && sidePanelTab === "systemResources"
    : systemResourcesOpen;

  useEffect(() => {
    if (!sidePanelMerged || !sidePanelOpen || visibleSidePanelTabs.includes(sidePanelTab)) return;
    const nextTab = visibleSidePanelTabs[0];
    if (nextTab) setSidePanelTab(nextTab);
    else setSidePanelOpen(false);
  }, [sidePanelMerged, sidePanelOpen, sidePanelTab, visibleSidePanelTabs]);

  useEffect(() => {
    if (!historyOpen && activeWorkspaceTab === "history") setActiveWorkspaceTab("terminal");
  }, [activeWorkspaceTab, historyOpen]);

  useEffect(() => {
    if (!gitWorkspaceOpen) return;
    closeHistory();
    setActiveWorkspaceTab("terminal");
    setGitOpen(false);
    if (sidePanelMerged && sidePanelTab === "git") setSidePanelOpen(false);
  }, [closeHistory, gitWorkspaceOpen, sidePanelMerged, sidePanelTab]);

  useEffect(() => () => gitWorkspaceResizeCleanupRef.current?.(), []);

  const beginGitWorkspaceResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    gitWorkspaceResizeCleanupRef.current?.();
    const startY = event.clientY;
    const startHeight = gitWorkspaceHeight;
    const onMove = (moveEvent: PointerEvent) => {
      const nextHeight = startHeight + startY - moveEvent.clientY;
      setGitWorkspaceHeight(Math.max(260, Math.min(720, nextHeight)));
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", cleanup);
      gitWorkspaceResizeCleanupRef.current = null;
    };
    gitWorkspaceResizeCleanupRef.current = cleanup;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", cleanup, { once: true });
  }, [gitWorkspaceHeight]);

  useEffect(() => {
    if (!terminalSidePanelSingleOpen || !historyOpen) return;
    setSidePanelOpen(false);
    setStatsOpen(false);
    setGitOpen(false);
    setReplayOpen(false);
    setFilesOpen(false);
    setSystemResourcesOpen(false);
    setProvidersOpen(false);
  }, [historyOpen, terminalSidePanelSingleOpen]);

  useEffect(() => {
    if (!historyOpen) return;
    setActiveWorkspaceTab("history");
  }, [focusGlobalSearchSeq, historyOpen]);

  useEffect(() => {
    if (!fullscreenPaneId || activeFullscreenPaneId) return;

    setFullscreenPaneId(null);
  }, [activeFullscreenPaneId, fullscreenPaneId]);

  const clearSplitPickerOpenSchedule = useCallback(() => {
    if (splitPickerOpenFrameRef.current !== null) {
      window.cancelAnimationFrame(splitPickerOpenFrameRef.current);
      splitPickerOpenFrameRef.current = null;
    }
    if (splitPickerOpenTimerRef.current !== null) {
      window.clearTimeout(splitPickerOpenTimerRef.current);
      splitPickerOpenTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearSplitPickerOpenSchedule, [clearSplitPickerOpenSchedule]);

  const handleCloseSplitPicker = useCallback(() => {
    clearSplitPickerOpenSchedule();
    splitPickerOutsideGuardUntilRef.current = 0;
    setSplitPicker(null);
  }, [clearSplitPickerOpenSchedule]);

  const shouldIgnoreSplitPickerOutsideInteraction = useCallback(() => {
    return Date.now() < splitPickerOutsideGuardUntilRef.current;
  }, []);

  const armCloseConfirmOutsideGuard = useCallback(() => {
    closeConfirmOutsideGuardUntilRef.current = Date.now() + 180;
  }, []);

  const shouldIgnoreCloseConfirmOutsideInteraction = useCallback(() => {
    return Date.now() < closeConfirmOutsideGuardUntilRef.current;
  }, []);

  const handleNewTab = useCallback(async () => {
    if (rejectMissingSessionWorktree(activeSession)) return;
    const newTerminalContext =
      activeSession?.kind === "subagent-transcript"
        ? { cwd: undefined, title: "Terminal" }
        : activeSession?.kind === "file-editor"
          ? { cwd: activeSession.fileEditor?.projectPath, title: "Terminal" }
          : { cwd: activeSession?.cwd, title: activeSession?.title ?? "Terminal" };
    const activeProject = activeSession?.projectId ? projectById.get(activeSession.projectId) : null;
    if (useExternalTerminal) {
      if (rejectUnsupportedCapability(activeProject, "externalTerminal")) return;
      await openWindowsTerminal([{ title: newTerminalContext.title, cwd: newTerminalContext.cwd ?? undefined }]);
      closeHistory();
      setActiveWorkspaceTab("terminal");
      return;
    }
    const isRemoteProject = activeProject?.environment_type === "ssh";
    await createSession(
      isRemoteProject ? activeProject.id : undefined,
      newTerminalContext.cwd ?? undefined,
      newTerminalContext.title,
      isRemoteProject ? "" : undefined,
    );
    closeHistory();
    setActiveWorkspaceTab("terminal");
  }, [activeSession, closeHistory, createSession, projectById, rejectMissingSessionWorktree, rejectUnsupportedCapability, useExternalTerminal]);

  const handleOpenScopedTerminal = useCallback(async () => {
    if (!scopedProject || useExternalTerminal) return;

    if (terminalScopeValue.kind === "worktree") {
      if (!scopedWorktree) return;
      if (rejectMissingWorktree(scopedWorktree)) return;
      const options = buildProjectSplitOptions(projectWithWorktreeProviderOverrides(scopedProject, scopedWorktree), groups);
      await createSession(
        options.projectId,
        scopedWorktree.path,
        scopedWorktree.name,
        options.startupCmd,
        options.envVars,
        options.shell,
        undefined,
        scopedWorktree.id
      );
      closeHistory();
      setActiveWorkspaceTab("terminal");
      return;
    }

    if (terminalScopeValue.kind !== "project") return;
    const options = buildProjectSplitOptions(scopedProject, groups);
    await createSession(options.projectId, options.cwd, options.title, options.startupCmd, options.envVars, options.shell);
    closeHistory();
    setActiveWorkspaceTab("terminal");
  }, [closeHistory, createSession, groups, rejectMissingWorktree, scopedProject, scopedWorktree, terminalScopeValue, useExternalTerminal]);

  const handleInstallWorktreeDeps = useCallback((project: Project, worktree: WorktreeRecord) => {
    if (rejectMissingWorktree(worktree)) return;
    void checkWorktreeDeps(worktree).then((deps) => {
      if (!deps.needsInstall || !deps.command) {
        toast.info(t("worktree.deps.notNeeded"));
        return;
      }
      const options = buildProjectSplitOptions(project, groups);
      void dismissWorktreeDepsPrompt(worktree.id);
      void createSession(
        options.projectId,
        worktree.path,
        t("worktree.deps.installTitle", { name: worktree.name }),
        deps.command,
        options.envVars,
        options.shell,
        undefined,
        worktree.id,
      );
    }).catch((err) => toast.error(t("worktree.deps.checkFailed"), { description: String(err) }));
  }, [checkWorktreeDeps, createSession, dismissWorktreeDepsPrompt, groups, rejectMissingWorktree, t]);

  const handleOpenWorktreeDirectory = useCallback((worktree: WorktreeRecord) => {
    if (rejectMissingWorktree(worktree)) return;
    void invoke("open_folder_in_explorer", { path: worktree.path }).catch((err) =>
      toast.error(t("sidebar.toast.openDirectoryFailed"), { description: String(err) }),
    );
  }, [rejectMissingWorktree, t]);

  const handleOpenGitWorkspaceWorktree = useCallback(async (worktree: WorktreeRecord) => {
    if (rejectMissingWorktree(worktree)) return;
    const project = projectById.get(worktree.project_id);
    if (!project) {
      toast.error(t("git.empty.noProject"));
      return;
    }
    if (useExternalTerminal) {
      handleOpenWorktreeDirectory(worktree);
      return;
    }
    const existing = sessions.find((session) => session.worktreeId === worktree.id && (session.kind ?? "pty") === "pty");
    if (existing) {
      closeGitWorkspace();
      closeHistory();
      setActiveWorkspaceTab("terminal");
      setActive(existing.id);
      return;
    }
    const scoped = projectWithWorktreeProviderOverrides(project, worktree);
    const options = buildProjectSplitOptions(scoped, groups);
    await createSession(
      options.projectId,
      worktree.path,
      worktree.name,
      options.startupCmd,
      options.envVars,
      options.shell,
      undefined,
      worktree.id,
    );
    closeGitWorkspace();
    closeHistory();
    setActiveWorkspaceTab("terminal");
  }, [buildProjectSplitOptions, closeGitWorkspace, closeHistory, createSession, groups, handleOpenWorktreeDirectory, projectById, rejectMissingWorktree, sessions, setActive, t, useExternalTerminal]);

  const handleOpenWorktreeChanges = useCallback((sessionId: string) => {
    const session = sessions.find((item) => item.id === sessionId);
    if (rejectMissingSessionWorktree(session)) return;
    closeHistory();
    setActiveWorkspaceTab("terminal");
    setActive(sessionId);
    ensureTerminalSidePanelVisible();
    if (sidePanelMerged) {
      setSidePanelTab("git");
      setSidePanelOpen(true);
      return;
    }
    setGitOpen(true);
  }, [closeHistory, ensureTerminalSidePanelVisible, rejectMissingSessionWorktree, sessions, setActive, sidePanelMerged]);

  const handleOpenWorktreeHistory = useCallback((project: Project, worktree: WorktreeRecord) => {
    if (rejectMissingWorktree(worktree)) return;
    if (terminalSidePanelSingleOpen) {
      setSidePanelOpen(false);
      setStatsOpen(false);
      setGitOpen(false);
      setReplayOpen(false);
      setFilesOpen(false);
      setSystemResourcesOpen(false);
    }
    setActiveWorkspaceTab("history");
    void openHistory({
      sourceFilter: resolveHistorySourceFilter(project.cli_tool),
      projectPath: resolveProjectPath(project, groups),
      projectId: project.id,
      scopedProjectPath: worktree.path,
    });
  }, [groups, openHistory, rejectMissingWorktree, terminalSidePanelSingleOpen]);

  const handleDuplicateSession = useCallback((session: TerminalSession) => {
    if (rejectMissingSessionWorktree(session)) return;
    void createSession(
      session.projectId,
      session.cwd,
      session.title,
      normalizeDirectCodexStartupCommand(session.startupCmd),
      session.envVars ? { ...session.envVars } : undefined,
      session.shell ?? undefined,
      undefined,
      session.worktreeId,
    ).then(() => {
      closeHistory();
      setActiveWorkspaceTab("terminal");
    }).catch(() => {});
  }, [closeHistory, createSession, rejectMissingSessionWorktree]);

  const handleSaveSessionToSidebar = useCallback((session: TerminalSession) => {
    const project = session.projectId ? projectById.get(session.projectId) ?? null : null;
    void saveSessionToSidebar(session, project);
  }, [projectById, saveSessionToSidebar]);

  const handleActivateSession = useCallback((sessionId: string) => {
    closeHistory();
    setActiveWorkspaceTab("terminal");
    setActive(sessionId);
  }, [closeHistory, setActive]);

  const handleTogglePaneFullscreen = useCallback((paneId: string) => {
    if (activeFullscreenPaneId === paneId) {
      setFullscreenPaneId(null);
      return;
    }

    const targetPane = allPanes.find((pane) => pane.id === paneId);
    if (!targetPane) return;

    if (targetPane.activeSessionId && targetPane.activeSessionId !== activeSessionId) {
      handleActivateSession(targetPane.activeSessionId);
    } else {
      closeHistory();
      setActiveWorkspaceTab("terminal");
    }

    setFullscreenPaneId(paneId);
  }, [activeFullscreenPaneId, activeSessionId, allPanes, closeHistory, handleActivateSession]);

  const handleRestoreWorkspanToSinglePane = useCallback((workspanId: string) => {
    if (workspanId === effectiveActiveWorkspanId && activeFullscreenPaneId) {
      handleTogglePaneFullscreen(activeFullscreenPaneId);
    }
    restoreWorkspanToSinglePane(workspanId);
  }, [activeFullscreenPaneId, effectiveActiveWorkspanId, handleTogglePaneFullscreen, restoreWorkspanToSinglePane]);

  const resolveCloseConfirmAnchor = useCallback((anchor?: SplitPickerAnchor) => {
    const rawX = anchor ? ("right" in anchor ? anchor.right : anchor.x) : window.innerWidth - 72;
    const rawY = anchor ? ("bottom" in anchor ? anchor.bottom : anchor.y) : 56;
    const align: SplitPickerAlign = anchor && "right" in anchor ? "end" : "start";

    return {
      x: Math.min(Math.max(rawX, 16), window.innerWidth - 16),
      y: Math.min(Math.max(rawY, 44), window.innerHeight - 16),
      align,
    };
  }, []);

  const findCloseConfirmAnchor = useCallback((sessionIds: string[]): SplitPickerAnchor | undefined => {
    const targetIds = new Set(sessionIds);
    const tab = Array.from(document.querySelectorAll<HTMLElement>("[data-terminal-tab-id]"))
      .find((node) => targetIds.has(node.dataset.terminalTabId ?? ""));
    return tab?.getBoundingClientRect();
  }, []);

  const closeSessionIds = useCallback((sessionIds: string[]) => {
    void (async () => {
      for (const sessionId of sessionIds) {
        try {
          await closeSession(sessionId);
        } catch (err) {
          logError("Failed to close terminal session", { sessionId, err });
        }
      }
    })();
  }, [closeSession]);

  const closeSessionsWithDirtyGuard = useCallback(async (sessionIds: string[]) => {
    const currentSessions = useTerminalStore.getState().sessions;
    const fileStore = useFileExplorerStore.getState();
    const fileProjects = currentSessions
      .filter((session) => sessionIds.includes(session.id) && session.kind === "file-editor")
      .map((session) => session.fileEditor?.project)
      .filter((project): project is Project => Boolean(project))
      .filter((project, index, projects) => (
        projects.findIndex((candidate) => candidate.id === project.id) === index
      ));
    const dirtyFiles = fileProjects.flatMap((project) => (
      fileStore.getProjectEditorWorkspaces(project.id).flatMap((workspace) => (
        workspace.openFiles
          .filter((file) => file.content !== file.savedContent)
          .map((file) => ({ project: workspace.project, file }))
      ))
    ));

    if (dirtyFiles.length > 0) {
      const confirmed = await confirm({
        title: t("files.editor.unsavedTitle"),
        message: t("files.editor.unsavedCloseWithFiles", {
          files: dirtyFiles.map(({ project, file }) => `${project.name}: ${file.path}`).join("\n"),
        }),
        confirmText: t("files.editor.discard"),
        danger: true,
      });
      if (!confirmed) return;
    }

    closeSessionIds(sessionIds);
  }, [closeSessionIds, confirm, t]);

  const handleCloseSessions = useCallback((sessionIds: string[], anchor?: SplitPickerAnchor) => {
    const uniqueSessionIds = Array.from(new Set(sessionIds)).filter((sessionId) => sessions.some((session) => session.id === sessionId));
    if (uniqueSessionIds.length === 0) return;

    const terminalSessionCount = uniqueSessionIds.filter((sessionId) => {
      const session = sessions.find((item) => item.id === sessionId);
      return session?.kind !== "file-editor";
    }).length;

    if (!shouldConfirmTerminalTabClose(terminalSessionCount)) {
      void closeSessionsWithDirtyGuard(uniqueSessionIds);
      return;
    }

    const position = resolveCloseConfirmAnchor(anchor ?? findCloseConfirmAnchor(uniqueSessionIds));
    armCloseConfirmOutsideGuard();
    setCloseConfirm({
      sessionIds: uniqueSessionIds,
      ...position,
    });
  }, [armCloseConfirmOutsideGuard, closeSessionsWithDirtyGuard, findCloseConfirmAnchor, resolveCloseConfirmAnchor, sessions]);

  const confirmCloseSessions = useCallback(() => {
    if (!closeConfirm) return;
    const sessionIds = closeConfirm.sessionIds;
    setCloseConfirm(null);
    void closeSessionsWithDirtyGuard(sessionIds);
  }, [closeConfirm, closeSessionsWithDirtyGuard]);

  const cancelCloseSessions = useCallback(() => {
    setCloseConfirm(null);
  }, []);

  useEffect(() => {
    const handleCloseRequest = (event: Event) => {
      const detail = (event as CustomEvent<TerminalTabCloseRequestDetail>).detail;
      const requestedSessionIds = detail?.sessionIds?.length
        ? detail.sessionIds
        : activeSessionId
          ? [activeSessionId]
          : [];
      if (requestedSessionIds.length === 0) return;
      handleCloseSessions(requestedSessionIds, findCloseConfirmAnchor(requestedSessionIds));
    };

    window.addEventListener(TERMINAL_TAB_CLOSE_REQUEST_EVENT, handleCloseRequest);
    return () => window.removeEventListener(TERMINAL_TAB_CLOSE_REQUEST_EVENT, handleCloseRequest);
  }, [activeSessionId, findCloseConfirmAnchor, handleCloseSessions]);

  const ensureStatsPanelAllowed = useCallback(async () => {
    try {
      const settings = useSettingsStore.getState();
      const [hookStatus, openCodeStatus] = await Promise.all([
        invoke<{
        claude: { status: string };
        codex: { status: string };
        kimi: { status: string };
        pi: { status: string };
        grok: { status: string };
        }>(
        "hook_settings_get_status",
        {
          selectedDir: settings.claudeHookConfigDir?.trim() || null,
          codexSelectedDir: settings.codexHookConfigDir?.trim() || null,
          kimiSelectedDir: settings.kimiHookConfigDir?.trim() || null,
          piSelectedDir: settings.piHookConfigDir?.trim() || null,
          grokSelectedDir: settings.grokHookConfigDir?.trim() || null,
          ccSwitchDbPath: settings.ccSwitchDbPath ?? undefined,
          autoRepair: settings.claudeHookBridgeEnabled && settings.claudeHookAutoRepairKnownInstalled,
        }
        ),
        invoke<{ status: string }>("opencode_hook_status"),
      ]);
      const hasEnabledInstalledHook =
        openCodeStatus.status === "installed" ||
        (settings.claudeHookBridgeEnabled && hookStatus.claude.status === "installed") ||
        (settings.codexHookBridgeEnabled && hookStatus.codex.status === "installed") ||
        (settings.kimiHookBridgeEnabled && hookStatus.kimi.status === "installed") ||
        (settings.piHookBridgeEnabled && hookStatus.pi.status === "installed") ||
        (settings.grokHookBridgeEnabled && hookStatus.grok.status === "installed");
      if (!hasEnabledInstalledHook) {
        const currentProject = panelSession?.projectId ? projectById.get(panelSession.projectId) : null;
        const currentAgent = resolveAgentRuntimeKind(
          `${panelSession?.cliTool ?? ""} ${panelSession?.startupCmd ?? ""} ${panelSession?.title ?? ""} ${currentProject?.cli_tool ?? ""}`
        );
        if (currentAgent === "opencode") return true;
        toast.warning(t("notifications.stats.needHook"), {
          description: t("notifications.stats.needHookDescription"),
        });
        return false;
      }
    } catch (err) {
      logError("Failed to check hook status before opening terminal stats panel", err);
    }
    return true;
  }, [panelSession, projectById, t]);

  const handleToggleStatsPanel = useCallback(async () => {
    if (statsPanelActive) {
      if (ensureTerminalSidePanelVisible()) return;
      if (sidePanelMerged) setSidePanelOpen(false);
      else setStatsOpen(false);
      return;
    }
    const project = panelSession?.projectId ? projectById.get(panelSession.projectId) : null;
    if (rejectUnsupportedCapability(project, "statistics")) return;
    const allowed = await ensureStatsPanelAllowed();
    if (!allowed) return;
    ensureTerminalSidePanelVisible();
    if (terminalSidePanelSingleOpen) {
      closeHistory();
      setActiveWorkspaceTab("terminal");
    }
    if (sidePanelMerged) {
      setSidePanelTab("stats");
      setSidePanelOpen(true);
    } else {
      if (terminalSidePanelSingleOpen || window.innerWidth < 1100) {
        setGitOpen(false);
        setReplayOpen(false);
        setFilesOpen(false);
        setSystemResourcesOpen(false);
        setProvidersOpen(false);
      }
      setStatsOpen(true);
    }
  }, [closeHistory, ensureStatsPanelAllowed, ensureTerminalSidePanelVisible, panelSession, projectById, rejectUnsupportedCapability, sidePanelMerged, statsPanelActive, terminalSidePanelSingleOpen]);

  const handleToggleSystemResourcesPanel = useCallback(() => {
    if (systemResourcesPanelActive) {
      if (ensureTerminalSidePanelVisible()) return;
      if (sidePanelMerged) setSidePanelOpen(false);
      else setSystemResourcesOpen(false);
      return;
    }
    if (terminalSidePanelSingleOpen) {
      closeHistory();
      setActiveWorkspaceTab("terminal");
    }
    ensureTerminalSidePanelVisible();
    if (sidePanelMerged) {
      setSidePanelTab("systemResources");
      setSidePanelOpen(true);
    } else {
      if (terminalSidePanelSingleOpen || window.innerWidth < 1100) {
        setStatsOpen(false);
        setGitOpen(false);
        setReplayOpen(false);
        setFilesOpen(false);
        setProvidersOpen(false);
      }
      setSystemResourcesOpen(true);
    }
  }, [closeHistory, ensureTerminalSidePanelVisible, sidePanelMerged, systemResourcesPanelActive, terminalSidePanelSingleOpen]);

  const handleToggleProviderPanel = useCallback(() => {
    if (providersPanelActive) {
      if (ensureTerminalSidePanelVisible()) return;
      if (sidePanelMerged) setSidePanelOpen(false);
      else setProvidersOpen(false);
      return;
    }
    if (terminalSidePanelSingleOpen) {
      closeHistory();
      setActiveWorkspaceTab("terminal");
    }
    ensureTerminalSidePanelVisible();
    if (sidePanelMerged) {
      setSidePanelTab("providers");
      setSidePanelOpen(true);
    } else {
      if (terminalSidePanelSingleOpen || window.innerWidth < 1100) {
        setStatsOpen(false);
        setGitOpen(false);
        setReplayOpen(false);
        setFilesOpen(false);
        setSystemResourcesOpen(false);
        setProvidersOpen(false);
      }
      setProvidersOpen(true);
    }
  }, [closeHistory, ensureTerminalSidePanelVisible, providersPanelActive, sidePanelMerged, terminalSidePanelSingleOpen]);

  const handleToggleGitChangesPanel = useCallback(() => {
    if (gitPanelActive) {
      if (ensureTerminalSidePanelVisible()) return;
      if (sidePanelMerged) setSidePanelOpen(false);
      else setGitOpen(false);
      return;
    }
    const project = panelSession?.projectId ? projectById.get(panelSession.projectId) : null;
    if (project?.environment_type !== "ssh" && rejectUnsupportedCapability(project, "git")) return;
    closeGitWorkspace();
    ensureTerminalSidePanelVisible();
    if (sidePanelMerged) {
      if (terminalSidePanelSingleOpen) {
        closeHistory();
        setActiveWorkspaceTab("terminal");
      }
      setSidePanelTab("git");
      setSidePanelOpen(true);
    } else {
      if (terminalSidePanelSingleOpen) {
        closeHistory();
        setActiveWorkspaceTab("terminal");
      }
      if (terminalSidePanelSingleOpen || window.innerWidth < 1100) {
        setStatsOpen(false);
        setReplayOpen(false);
        setFilesOpen(false);
        setSystemResourcesOpen(false);
        setProvidersOpen(false);
      }
      setGitOpen(true);
    }
  }, [closeGitWorkspace, closeHistory, ensureTerminalSidePanelVisible, gitPanelActive, panelSession, projectById, rejectUnsupportedCapability, sidePanelMerged, terminalSidePanelSingleOpen]);

  const handleToggleReplayPanel = useCallback(() => {
    if (replayPanelActive) {
      if (ensureTerminalSidePanelVisible()) return;
      if (sidePanelMerged) setSidePanelOpen(false);
      else setReplayOpen(false);
      return;
    }
    const project = panelSession?.projectId ? projectById.get(panelSession.projectId) : null;
    if (rejectUnsupportedCapability(project, "history")) return;
    ensureTerminalSidePanelVisible();
    if (sidePanelMerged) {
      if (terminalSidePanelSingleOpen) {
        closeHistory();
        setActiveWorkspaceTab("terminal");
      }
      setSidePanelTab("replay");
      setSidePanelOpen(true);
    } else {
      if (terminalSidePanelSingleOpen) {
        closeHistory();
        setActiveWorkspaceTab("terminal");
      }
      if (terminalSidePanelSingleOpen || window.innerWidth < 1100) {
        setStatsOpen(false);
        setGitOpen(false);
        setFilesOpen(false);
        setSystemResourcesOpen(false);
        setProvidersOpen(false);
      }
      setReplayOpen(true);
    }
  }, [closeHistory, ensureTerminalSidePanelVisible, panelSession, projectById, rejectUnsupportedCapability, replayPanelActive, sidePanelMerged, terminalSidePanelSingleOpen]);

  const syncFilePanelProject = useCallback(async (project: Project) => {
    const preserveCurrentFilePanel = consumeTerminalFileDragPanelSyncSuppression();
    if (rejectUnsupportedCapability(project, "files")) return false;
    if (preserveCurrentFilePanel) return true;
    try {
      const sameFileContext = isSameProjectFileContext(
        useFileExplorerStore.getState().project,
        project,
      );
      if (sameFileContext) return true;
      await openFileProject(project);
      return true;
    } catch (err) {
      logError("Failed to open terminal file panel project", err);
      toast.error(t("sidebar.toast.openProjectFilesFailed"), { description: String(err) });
      return false;
    }
  }, [openFileProject, rejectUnsupportedCapability, t]);

  const closeFilesPanel = useCallback(() => {
    if (sidePanelMerged) {
      if (sidePanelTab === "files") setSidePanelOpen(false);
      return;
    }
    setFilesOpen(false);
  }, [sidePanelMerged, sidePanelTab]);

  const openFilesPanelForProject = useCallback(async (project: Project): Promise<boolean> => {
    const allowed = await syncFilePanelProject(project);
    if (!allowed) return false;
    ensureTerminalSidePanelVisible();
    if (terminalSidePanelSingleOpen) {
      closeHistory();
      setActiveWorkspaceTab("terminal");
    }
    if (sidePanelMerged) {
      setSidePanelTab("files");
      setSidePanelOpen(true);
      return true;
    }
    if (terminalSidePanelSingleOpen || window.innerWidth < 1100) {
      setStatsOpen(false);
      setGitOpen(false);
      setReplayOpen(false);
      setSystemResourcesOpen(false);
      setProvidersOpen(false);
    }
    setFilesOpen(true);
    return true;
  }, [closeHistory, ensureTerminalSidePanelVisible, sidePanelMerged, syncFilePanelProject, terminalSidePanelSingleOpen]);

  const handleToggleFilesPanel = useCallback(async () => {
    if (filesPanelActive) {
      if (ensureTerminalSidePanelVisible()) return;
      closeFilesPanel();
      return;
    }
    if (!filePanelProject) return;
    void openFilesPanelForProject(filePanelProject);
  }, [closeFilesPanel, ensureTerminalSidePanelVisible, filePanelProject, filesPanelActive, openFilesPanelForProject]);

  useEffect(() => {
    const handleTerminalFileNavigation = (event: Event) => {
      const request = (event as CustomEvent<TerminalFileNavigationRequest>).detail;
      const sourceSession = sessions.find((session) => session.id === request.sessionId) ?? null;
      const project = resolveProjectForSessionFileContext(sourceSession, sessions, projects, projectById, worktrees);
      if (!project) return;
      void openFilesPanelForProject(project).then(async (opened) => {
        if (!opened) return;
        try {
          const revealed = await revealFilePath(request.path, {
            ...(request.lineNumber ? { lineNumber: request.lineNumber } : {}),
            ...(request.columnNumber ? { columnNumber: request.columnNumber } : {}),
          });
          if (revealed && request.kind === "file") openFileEditorPane(project);
        } catch (err) {
          logError("Failed to reveal terminal relative path", { request, err });
          toast.error(t("files.toast.openFileFailed"), { description: String(err) });
        }
      });
    };
    window.addEventListener(TERMINAL_FILE_NAVIGATION_REQUEST_EVENT, handleTerminalFileNavigation);
    return () => window.removeEventListener(TERMINAL_FILE_NAVIGATION_REQUEST_EVENT, handleTerminalFileNavigation);
  }, [openFileEditorPane, openFilesPanelForProject, projectById, projects, revealFilePath, sessions, t, worktrees]);

  const handleSidePanelTabChange = useCallback((tab: TerminalSidePanelTab) => {
    const project = panelSession?.projectId ? projectById.get(panelSession.projectId) : null;
    if (tab === "stats") {
      if (rejectUnsupportedCapability(project, "statistics")) return;
      void ensureStatsPanelAllowed().then((allowed) => {
        if (allowed) setSidePanelTab("stats");
      });
      return;
    }
    if (tab === "files") {
      if (!filePanelProject) return;
      if (rejectUnsupportedCapability(filePanelProject, "files")) return;
      void syncFilePanelProject(filePanelProject).then((allowed) => {
        if (allowed) setSidePanelTab("files");
      });
      return;
    }
    if (tab === "git" && project?.environment_type !== "ssh" && rejectUnsupportedCapability(project, "git")) return;
    if (tab === "replay" && rejectUnsupportedCapability(project, "history")) return;
    setSidePanelTab(tab);
  }, [ensureStatsPanelAllowed, filePanelProject, panelSession, projectById, rejectUnsupportedCapability, syncFilePanelProject]);

  // 响应式约束：非合并模式下两个面板各占固定宽度，窗口过窄时会挤压终端。
  // 窗口 < 1100px 时退化为单面板，并随窗口缩小持续生效。
  useEffect(() => {
    if (sidePanelMerged) return;
    const enforce = () => {
      if (!terminalSidePanelSingleOpen && window.innerWidth >= 1100) return;
      const openPanels = [statsOpen, gitOpen, replayOpen, filesOpen, providersOpen, systemResourcesOpen].filter(Boolean).length;
      if (openPanels <= 1) return;
      if (statsOpen) {
        setGitOpen(false);
        setReplayOpen(false);
        setFilesOpen(false);
        setSystemResourcesOpen(false);
        setProvidersOpen(false);
        return;
      }
      if (systemResourcesOpen) {
        setGitOpen(false);
        setReplayOpen(false);
        setFilesOpen(false);
        setProvidersOpen(false);
        return;
      }
      if (providersOpen) {
        setGitOpen(false);
        setReplayOpen(false);
        setFilesOpen(false);
        setSystemResourcesOpen(false);
        return;
      }
      if (gitOpen) {
        setReplayOpen(false);
        setFilesOpen(false);
        setSystemResourcesOpen(false);
        setProvidersOpen(false);
        return;
      }
      if (replayOpen) {
        setFilesOpen(false);
        setSystemResourcesOpen(false);
        setProvidersOpen(false);
      }
    };
    enforce();
    window.addEventListener("resize", enforce);
    return () => window.removeEventListener("resize", enforce);
  }, [filesOpen, gitOpen, providersOpen, replayOpen, sidePanelMerged, statsOpen, systemResourcesOpen, terminalSidePanelSingleOpen]);

  useEffect(() => {
    if (!filesPanelActive) return;
    if (!filePanelProject) {
      closeFilesPanel();
      return;
    }
    void syncFilePanelProject(filePanelProject);
  }, [
    closeFilesPanel,
    filePanelProject?.id,
    filePanelProject?.path,
    filePanelProject?.environment_type,
    filePanelProject?.ssh_host_id,
    filePanelProject?.remote_path,
    filesPanelActive,
    syncFilePanelProject,
  ]);

  const handleOpenHistoryTab = useCallback(() => {
    if (historyOpen) {
      closeHistory();
      return;
    }

    if (terminalSidePanelSingleOpen) {
      setSidePanelOpen(false);
      setStatsOpen(false);
      setGitOpen(false);
      setReplayOpen(false);
      setFilesOpen(false);
      setSystemResourcesOpen(false);
    }
    const project = activeSession?.projectId ? projects.find((item) => item.id === activeSession.projectId) : undefined;
    if (rejectUnsupportedCapability(project, "history")) return;
    closeGitWorkspace();
    setActiveWorkspaceTab("history");
    void openHistory({
      sourceFilter: resolveHistorySourceFilter(project?.cli_tool),
      projectPath: resolveHistoryProjectPath(project) || activeSession?.cwd || null,
      projectId: project?.id ?? null,
      scopedProjectPath: activeWorktree?.path ?? null,
    });
  }, [activeSession, activeWorktree?.path, closeGitWorkspace, closeHistory, historyOpen, openHistory, projects, rejectUnsupportedCapability, terminalSidePanelSingleOpen]);

  const handleOpenSplitPicker = useCallback((sessionId: string, direction: TerminalPaneSplitDirection, anchor?: SplitPickerAnchor) => {
    clearSplitPickerOpenSchedule();
    const rawX = anchor ? ("right" in anchor ? anchor.right : anchor.x) : window.innerWidth - 24;
    const rawY = anchor ? ("bottom" in anchor ? anchor.bottom : anchor.y) : 56;
    const x = Math.min(Math.max(rawX, 16), window.innerWidth - 16);
    const y = Math.min(Math.max(rawY, 44), window.innerHeight - 16);
    const align: SplitPickerAlign = anchor && "right" in anchor ? "end" : "start";
    splitPickerOpenFrameRef.current = window.requestAnimationFrame(() => {
      splitPickerOpenFrameRef.current = null;
      splitPickerOpenTimerRef.current = window.setTimeout(() => {
        splitPickerOpenTimerRef.current = null;
        splitPickerOutsideGuardUntilRef.current = Date.now() + SPLIT_PICKER_OUTSIDE_GUARD_MS;
        setSplitPicker({ sessionId, direction, x, y, align });
      }, 0);
    });
  }, [clearSplitPickerOpenSchedule]);

  const handleSplitEmpty = useCallback(() => {
    if (!splitPicker) return;
    void splitTerminal(splitPicker.sessionId, splitPicker.direction, { title: "Terminal" });
    handleCloseSplitPicker();
    closeHistory();
    setActiveWorkspaceTab("terminal");
  }, [closeHistory, handleCloseSplitPicker, splitPicker, splitTerminal]);

  const handleSplitProject = useCallback((project: Project) => {
    if (!splitPicker) return;
    void splitTerminal(splitPicker.sessionId, splitPicker.direction, buildProjectSplitOptions(project, groups));
    handleCloseSplitPicker();
    closeHistory();
    setActiveWorkspaceTab("terminal");
  }, [closeHistory, groups, handleCloseSplitPicker, splitPicker, splitTerminal]);

  const findPaneForSession = useCallback((sessionId: string) => {
    return allPanes.find((pane) => pane.sessionIds.includes(sessionId)) ?? null;
  }, [allPanes]);

  const canSplitSessionToPaneEdge = useCallback((sessionId: string, targetPaneId: string) => {
    const sourcePane = findPaneForSession(sessionId);
    const targetPane = allPanes.find((pane) => pane.id === targetPaneId) ?? null;
    if (!sourcePane || !targetPane) return false;
    return sourcePane.id !== targetPane.id || sourcePane.sessionIds.length > 1;
  }, [allPanes, findPaneForSession]);

  const updateActiveDropPreview = useCallback((next: PaneDropPreview) => {
    setActiveDropPreview((current) => {
      if (!current || !next) return current === next ? current : next;
      return current.paneId === next.paneId && current.edge === next.edge ? current : next;
    });
  }, []);

  const hideWorkspanDetachPreview = useCallback(() => {
    setWorkspanDetachPreview((current) => (
      current.visible ? { ...current, targetId: null, visible: false } : current
    ));
  }, []);

  const clearDragState = useCallback(() => {
    const wasDraggingWorkspan = activeDragWorkspanIdRef.current !== null;
    activeDragWorkspanIdRef.current = null;
    clearWorkspanDragHoverActivation();
    updateActiveDropPreview(null);
    hideWorkspanDetachPreview();
    if (wasDraggingWorkspan) {
      if (workspanDragOverflowFrameRef.current !== null) {
        window.cancelAnimationFrame(workspanDragOverflowFrameRef.current);
      }
      workspanDragOverflowFrameRef.current = window.requestAnimationFrame(() => {
        workspanDragOverflowFrameRef.current = null;
        updateWorkspanTabOverflow();
      });
    }
  }, [clearWorkspanDragHoverActivation, hideWorkspanDetachPreview, updateActiveDropPreview, updateWorkspanTabOverflow]);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    clearWorkspanDragHoverActivation();
    hideWorkspanDetachPreview();
    activeDragWorkspanIdRef.current = null;
    const dragId = String(event.active.id);
    const workspanId = parseWorkspanDragId(dragId);
    if (workspanId) {
      if (scopedSessionIds || !workspans.some((workspan) => workspan.id === workspanId)) return;
      activeDragWorkspanIdRef.current = workspanId;
      return;
    }
  }, [clearWorkspanDragHoverActivation, hideWorkspanDetachPreview, scopedSessionIds, workspans]);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    if (!event.over) {
      clearWorkspanDragHoverActivation();
      updateActiveDropPreview(null);
      hideWorkspanDetachPreview();
      return;
    }

    const activeId = String(event.active.id);
    const activeWorkspanId = parseWorkspanDragId(activeId);
    const overId = String(event.over.id);
    const dropTarget = parsePaneDropTarget(overId);
    if (activeWorkspanId) {
      hideWorkspanDetachPreview();
      const hoverTarget = resolveWorkspanDragHoverTarget(activeWorkspanId, overId);
      if (hoverTarget) {
        scheduleWorkspanDragHoverActivation(hoverTarget);
        updateActiveDropPreview(null);
        return;
      }
      clearWorkspanDragHoverActivation();
      const targetWorkspanId = activeWorkspanLayout?.workspan.id ?? null;
      const targetPaneExists = dropTarget
        && activeWorkspanLayout?.panes.some((pane) => pane.id === dropTarget.paneId);
      const edge = dropTarget ? resolveWorkspanDropEdge(event, dropTarget) : null;
      if (targetPaneExists && edge && targetWorkspanId && targetWorkspanId !== activeWorkspanId) {
        updateActiveDropPreview({ paneId: dropTarget.paneId, edge });
        return;
      }
      updateActiveDropPreview(null);
      return;
    }

    const targetWorkspanId = parseWorkspanDragId(overId);
    if (!scopedSessionIds && (targetWorkspanId || overId === WORKSPAN_TABBAR_END_DROP_ID)) {
      const tabBarRect = workspanTabBarRef.current?.getBoundingClientRect();
      if (tabBarRect) {
        const left = Math.max(4, Math.min(tabBarRect.width - 4, event.over.rect.left - tabBarRect.left));
        setWorkspanDetachPreview((current) => (
          current.visible && current.targetId === overId && Math.abs(current.left - left) < 0.5
            ? current
            : { left, targetId: overId, visible: true }
        ));
      }
      updateActiveDropPreview(null);
      return;
    }

    hideWorkspanDetachPreview();

    if (dropTarget?.type === "edge" && canSplitSessionToPaneEdge(activeId, dropTarget.paneId)) {
      updateActiveDropPreview({ paneId: dropTarget.paneId, edge: dropTarget.edge });
      return;
    }

    updateActiveDropPreview(null);
  }, [
    activeWorkspanLayout,
    canSplitSessionToPaneEdge,
    clearWorkspanDragHoverActivation,
    hideWorkspanDetachPreview,
    scheduleWorkspanDragHoverActivation,
    scopedSessionIds,
    updateActiveDropPreview,
  ]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    clearDragState();
    if (!over) return;

    const activeId = String(active.id);
    const overId = String(over.id);
    const sourceWorkspanId = parseWorkspanDragId(activeId);
    if (sourceWorkspanId) {
      const targetWorkspanId = parseWorkspanDragId(overId);
      if (targetWorkspanId) {
        if (sourceWorkspanId !== targetWorkspanId) reorderWorkspans(sourceWorkspanId, targetWorkspanId);
        return;
      }
      const dropTarget = parsePaneDropTarget(overId);
      const activeTargetWorkspanId = activeWorkspanLayout?.workspan.id ?? null;
      const edge = dropTarget ? resolveWorkspanDropEdge(event, dropTarget) : null;
      if (
        dropTarget
        && edge
        && activeTargetWorkspanId
        && activeTargetWorkspanId !== sourceWorkspanId
      ) {
        mergeWorkspanAtPaneEdge(
          sourceWorkspanId,
          activeTargetWorkspanId,
          dropTarget.paneId,
          edge
        );
        setActiveWorkspaceTab("terminal");
      }
      return;
    }
    if (active.id === over.id) return;
    const sourcePane = findPaneForSession(activeId);
    if (!sourcePane) return;

    const targetWorkspanId = parseWorkspanDragId(overId);
    if (targetWorkspanId || overId === WORKSPAN_TABBAR_END_DROP_ID) {
      if (scopedSessionIds) return;
      const insertAt = targetWorkspanId
        ? workspans.findIndex((workspan) => workspan.id === targetWorkspanId)
        : workspans.length;
      if (insertAt < 0) return;
      detachSessionToWorkspan(activeId, insertAt);
      setActiveWorkspaceTab("terminal");
      return;
    }

    const dropTarget = parsePaneDropTarget(overId);
    if (dropTarget?.type === "edge") {
      if (canSplitSessionToPaneEdge(activeId, dropTarget.paneId)) {
        splitSessionToPaneEdge(activeId, dropTarget.paneId, dropTarget.edge);
        setActiveWorkspaceTab("terminal");
      }
      return;
    }

    if (dropTarget?.type === "center") {
      if (dropTarget.paneId !== sourcePane.id) {
        moveSessionToPane(activeId, dropTarget.paneId);
        setActiveWorkspaceTab("terminal");
      }
      return;
    }

    const targetPane = findPaneForSession(overId);
    if (!targetPane) return;
    if (targetPane.id === sourcePane.id) {
      reorderSessions(activeId, overId);
      return;
    }
    moveSessionToPane(activeId, targetPane.id, overId);
    setActiveWorkspaceTab("terminal");
  }, [activeWorkspanLayout, canSplitSessionToPaneEdge, clearDragState, detachSessionToWorkspan, findPaneForSession, mergeWorkspanAtPaneEdge, moveSessionToPane, reorderSessions, reorderWorkspans, scopedSessionIds, splitSessionToPaneEdge, workspans]);

  const handleToolbarDragStart = useCallback((event: DragStartEvent) => {
    setActiveToolbarDragId(String(event.active.id));
  }, []);

  const handleToolbarDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    setActiveToolbarDragId(null);

    if (!over || active.id === over.id) return;

    const oldIndex = terminalToolbarOrder.indexOf(String(active.id));
    const newIndex = terminalToolbarOrder.indexOf(String(over.id));

    if (oldIndex !== -1 && newIndex !== -1) {
      const newOrder = arrayMove(terminalToolbarOrder, oldIndex, newIndex);
      void updateSettings("terminalToolbarOrder", newOrder);
    }
  }, [terminalToolbarOrder, updateSettings]);

  const handleToolbarDragCancel = useCallback(() => {
    setActiveToolbarDragId(null);
  }, []);

  const refreshBackgroundTasks = useCallback(async () => {
    try {
      const tasks = await invoke<BackgroundTaskMeta[]>("pty_daemon_sessions");
      setDaemonTasks(tasks);
    } catch {
      setDaemonTasks([]);
    }
  }, []);

  useEffect(() => {
    void refreshBackgroundTasks();
    const timer = window.setInterval(() => void refreshBackgroundTasks(), 3000);
    return () => window.clearInterval(timer);
  }, [refreshBackgroundTasks]);

  const backgroundTasks = useMemo(() => {
    const openIds = new Set(sessions.map((session) => session.id));
    return daemonTasks.filter((task) => !openIds.has(task.sessionId));
  }, [daemonTasks, sessions]);

  const handleToggleGlobalFullscreen = useCallback(() => {
    if (activeFullscreenPaneId) {
      setFullscreenPaneId(null);
    }
    onToggleFullscreen?.();
  }, [activeFullscreenPaneId, onToggleFullscreen]);

  const renderToolbarActions = useTerminalToolbarRenderer({
    t,
    fullscreen,
    sessionHistoryShortcutHint,
    replayPanelActive,
    gitPanelActive,
    filesPanelActive,
    filePanelProject,
    statsPanelActive,
    providersPanelActive,
    systemResourcesPanelActive,
    handleNewTab,
    terminalSidePanelSide,
    terminalActionSidebarStyle,
    onToggleFullscreen,
    handleToggleGlobalFullscreen,
    handleOpenHistoryTab,
    historyOpen,
    terminalToolbarVisibility,
    handleToggleReplayPanel,
    handleToggleGitChangesPanel,
    handleToggleFilesPanel,
    handleToggleStatsPanel,
    handleToggleProviderPanel,
    handleToggleSystemResourcesPanel,
    backgroundTasks,
    refreshBackgroundTasks,
    terminalPopoverStyle,
    terminalToolbarOrder,
    toolbarSensors,
    handleToolbarDragStart,
    handleToolbarDragEnd,
    handleToolbarDragCancel,
    activeToolbarDragId,
    systemResourceMonitoringEnabled,
    cpuResourceCardVisible,
    sidePanelMerged,
  });

  const handleSubmitTabEdit = useCallback(
    (sessionId: string, title: string) => {
      const trimmed = title.trim();
      const session = sessions.find((item) => item.id === sessionId);
      if (!session || !trimmed) {
        setEditingSessionId(null);
        return;
      }

      renameSession(sessionId, trimmed);
      setEditingSessionId(null);
    },
    [renameSession, sessions]
  );

  const handlePaneSubmitEdit = useCallback((sessionId: string, title: string) => {
    void handleSubmitTabEdit(sessionId, title);
  }, [handleSubmitTabEdit]);
  const handlePaneCancelEdit = useCallback(() => setEditingSessionId(null), []);
  const handlePaneNewTab = useCallback(() => {
    void handleNewTab();
  }, [handleNewTab]);
  const handlePaneUnsplit = useCallback((sessionId: string) => {
    void unsplitTerminal(sessionId);
  }, [unsplitTerminal]);
  const handlePaneFinishWorktree = useCallback((project: Project, worktree: WorktreeRecord) => {
    if (rejectMissingWorktree(worktree)) return;
    setFinishTarget({ project, worktree });
  }, [rejectMissingWorktree]);
  const handlePaneDiscardWorktree = useCallback((project: Project, worktree: WorktreeRecord) => {
    setDiscardTarget({ project, worktree });
  }, []);

  const renderWorkspanLeaf = useCallback((
    pane: TerminalPaneLeaf,
    layoutPanes: TerminalPaneLeaf[],
    layoutActiveSessionId: string | null,
    layoutVisible: boolean
  ) => {
    const visiblePaneSessionCount = scopedSessionIds
      ? pane.sessionIds.filter((sessionId) => scopedSessionIds.has(sessionId)).length
      : pane.sessionIds.length;
    return (
      <MemoPaneLeafView
        key={pane.id}
        pane={pane}
        sessions={sessions}
        visibleSessionIds={scopedSessionIds}
        projects={projects}
        worktrees={worktrees}
        allPanes={layoutPanes}
        activeSessionId={layoutActiveSessionId}
        historyActive={fullWorkspaceActive}
        editingSessionId={editingSessionId}
        tabNotifications={tabNotifications}
        hookNotifications={hookNotifications}
        paneMarkerSettings={paneMarkerSettings}
        isAppFocused={isAppFocused}
        fontSize={fontSize}
        fontFamily={fontFamily}
        resolvedTheme={resolvedTheme}
        terminalThemeName={terminalThemeName}
        terminalThemeBackground={terminalThemeBackground}
        lightThemePalette={lightThemePalette}
        darkThemePalette={darkThemePalette}
        terminalBackgroundEnabled={terminalBackgroundEnabled}
        terminalBackgroundImagePath={terminalBackgroundImagePath}
        hiddenBackgroundSessionIds={hiddenBackgroundSessionIds}
        isPaneFullscreen={layoutVisible && activeFullscreenPaneId === pane.id}
        isLayoutVisible={layoutVisible && (!activeFullscreenPaneId || activeFullscreenPaneId === pane.id)}
        activeDropPreview={layoutVisible ? activeDropPreview : null}
        onActivateSession={handleActivateSession}
        onCloseSessions={handleCloseSessions}
        onStartEdit={setEditingSessionId}
        onSubmitEdit={handlePaneSubmitEdit}
        onCancelEdit={handlePaneCancelEdit}
        onNewTab={handlePaneNewTab}
        onDuplicateSession={handleDuplicateSession}
        onSaveSessionToSidebar={handleSaveSessionToSidebar}
        onOpenSplitPicker={handleOpenSplitPicker}
        onUnsplit={handlePaneUnsplit}
        onMoveToPane={moveSessionToPane}
        onHideBackground={hideBackgroundForSession}
        onShowBackground={showBackgroundForSession}
        onTogglePaneFullscreen={handleTogglePaneFullscreen}
        onDetachSessionToWorkspan={detachSessionToWorkspan}
        onOpenWorktreeChanges={handleOpenWorktreeChanges}
        onOpenWorktreeHistory={handleOpenWorktreeHistory}
        onFinishWorktree={handlePaneFinishWorktree}
        onInstallWorktreeDeps={handleInstallWorktreeDeps}
        onDiscardWorktree={handlePaneDiscardWorktree}
        onOpenWorktreeDirectory={handleOpenWorktreeDirectory}
        hideTabBar={workspanEnabled && layoutPanes.length <= 1 && visiblePaneSessionCount <= 1}
      />
    );
  }, [
    activeFullscreenPaneId,
    activeDropPreview,
    darkThemePalette,
    editingSessionId,
    fontFamily,
    fontSize,
    handleActivateSession,
    handleCloseSessions,
    handlePaneCancelEdit,
    handlePaneDiscardWorktree,
    handlePaneFinishWorktree,
    handlePaneNewTab,
    handlePaneSubmitEdit,
    handlePaneUnsplit,
    handleDuplicateSession,
    handleSaveSessionToSidebar,
    handleOpenSplitPicker,
    handleOpenWorktreeChanges,
    handleOpenWorktreeHistory,
    handleOpenWorktreeDirectory,
    handleInstallWorktreeDeps,
    handleTogglePaneFullscreen,
    hiddenBackgroundSessionIds,
    hookNotifications,
    hideBackgroundForSession,
    fullWorkspaceActive,
    isAppFocused,
    lightThemePalette,
    moveSessionToPane,
    paneMarkerSettings,
    projects,
    resolvedTheme,
    detachSessionToWorkspan,
    scopedSessionIds,
    sessions,
    worktrees,
    workspanEnabled,
    showBackgroundForSession,
    tabNotifications,
    terminalThemeBackground,
    terminalBackgroundEnabled,
    terminalBackgroundImagePath,
    terminalThemeName,
  ]);

  const hasScopedTerminalFilter = projectScopedTerminalViewEnabled && terminalScopeValue.kind !== "all";
  const scopedEmptyState = useScopedTerminalEmptyState({
    hasScopedTerminalFilter,
    terminalScopeValue,
    scopedWorktree,
    scopedProject,
    t,
    handleOpenScopedTerminal,
    scopedGroup,
  });

  return {
    fullscreen,
    historyActive,
    terminalWellStyle,
    promptDialog,
    confirmDialog,
    saveSessionDialog,
    splitPicker,
    projectTree,
    splitPickerMenuStyle,
    handleSplitEmpty,
    handleSplitProject,
    handleCloseSplitPicker,
    shouldIgnoreSplitPickerOutsideInteraction,
    closeConfirm,
    confirmCloseSessions,
    cancelCloseSessions,
    shouldIgnoreCloseConfirmOutsideInteraction,
    finishTarget,
    setFinishTarget,
    discardTarget,
    t,
    removeWorktree,
    setDiscardTarget,
    historyOpen,
    onOpenHistorySettings,
    gitWorkspaceOpen,
    gitWorkspaceHeight,
    beginGitWorkspaceResize,
    gitWorkspaceProject,
    gitWorkspaceProjectPath,
    closeGitWorkspace,
    handleOpenGitWorkspaceWorktree,
    terminalThemeTone,
    terminalSidePanelVisible,
    terminalSidePanelSide,
    sidePanelMerged,
    sidePanelOpen,
    sidePanelTab,
    visibleSidePanelTabs,
    panelSessionId,
    sidePanelProjectPath,
    panelSession,
    filePanelProject,
    panelProviderAppType,
    closeFilesPanel,
    handleSidePanelTabChange,
    onOpenProviderSettings,
    statsOpen,
    panelCapabilities,
    gitOpen,
    panelGitSupported,
    replayOpen,
    filesOpen,
    systemResourcesOpen,
    providersOpen,
    renderToolbarActions,
    visibleWorkspanLayouts,
    sensors,
    handleDragStart,
    handleDragOver,
    clearDragState,
    handleDragEnd,
    workspanTabBarPosition,
    workspanTabBarVisible,
    workspanEnabled,
    workspanTabModels,
    workspanTabOverflow,
    workspanTabListOpen,
    effectiveActiveWorkspanId,
    hasScopedTerminalFilter,
    workspanTabBarRef,
    workspanTabScrollRef,
    workspanDetachPreview,
    setWorkspanTabListOpen,
    activateWorkspanTab,
    handleCloseSessions,
    projectById,
    handleSubmitTabEdit,
    prompt,
    renameWorkspan,
    scopedSessionIds,
    handleRestoreWorkspanToSinglePane,
    handleSaveSessionToSidebar,
    mountedWorkspanLayouts,
    effectiveActiveSessionId,
    renderWorkspanLeaf,
    activeFullscreenPaneId,
    visibleSessions,
    useExternalTerminal,
    scopedEmptyState,
    sessions,
    handleNewTab,
  };
}
