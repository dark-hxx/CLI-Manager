import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo, type MouseEvent as ReactMouseEvent } from "react";
import { useShallow } from "zustand/shallow";
import type { DragEndEvent } from "@dnd-kit/core";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { useProjectStore } from "../../stores/projectStore";
import { useTerminalStore, type SessionStatus, type SplitTerminalOptions } from "../../stores/terminalStore";
import { isProjectFileDirty, useFileExplorerStore } from "../../stores/fileExplorerStore";
import { useHistoryStore } from "../../stores/historyStore";
import { useSettingsStore } from "../../stores/settingsStore";
import {
  createDefaultWorktreeTaskName,
  sanitizeWorktreeTaskName,
  validateWorktreeTaskName,
  useWorktreeStore,
} from "../../stores/worktreeStore";
import { useExternalSessionSyncStore } from "../../stores/externalSessionSyncStore";
import type { TerminalPaneSplitDirection } from "../../stores/terminalPaneTree";
import type { HistorySourceFilter, Project, TreeNode as TNode, Group, WorktreeRecord } from "../../lib/types";
import { ConfigModal } from "../ConfigModal";
import { ConfirmDialog } from "../ConfirmDialog";
import { ProviderSwitchModal } from "../ProviderSwitchModal";
import { WorktreeFinishDialog } from "../worktree/WorktreeFinishDialog";
import { openWindowsTerminal } from "../../lib/externalTerminal";
import { resolveProjectStartupCommand } from "../../lib/projectStartupCommand";
import { shouldSidebarBootstrapProjects } from "../../lib/projectLoadPolicy";
import { getProviderSwitchAppType, parseProjectEnvVars } from "../../lib/providerSwitching";
import { isSameProjectFileContext, projectWithWorktreePath, projectWithWorktreeProviderOverrides } from "../../lib/terminalProject";
import { appendSyncedHistoryContextArg } from "../../lib/syncedHistoryContext";
import { TreeContext, worktreeListCollapseId, type TreeActions } from "./TreeContext";
import { Portal } from "../ui/Portal";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { toast } from "sonner";
import { logError } from "../../lib/logger";
import { SidebarHeader } from "./SidebarHeader";
import { ProjectTree } from "./ProjectTree";
import { SidebarFooter } from "./SidebarFooter";
import { groupSyncedExternalSessions } from "../../lib/externalSessionGrouping";
import { FileExplorerSidebar } from "../files/FileExplorerSidebar";
import {
  ArrowLeftRight,
  Check,
  Copy,
  FileCode,
  FolderOpen,
  FolderPlus,
  ListClockIcon,
  Pencil,
  Play,
  Plus,
  SquareSplitHorizontal,
  SquareSplitVertical,
  TerminalSquare,
  Trash2,
  X,
} from "../icons";
import type { SettingsTab } from "../SettingsModal";
import { useI18n } from "../../lib/i18n";
import { getOsPlatform } from "../../lib/shell";

interface SidebarProps {
  onOpenSettings: (tab?: SettingsTab) => void;
  onOpenStats: () => void;
  compactMode?: boolean;
  projectScopedTerminalViewEnabled?: boolean;
  terminalScopeProjectId?: string | null;
  onTerminalScopeChange?: (projectId: string | null) => void;
}

const SIDEBAR_COLLAPSED_WIDTH = 64;
const SIDEBAR_COLLAPSE_THRESHOLD = 140;
const SIDEBAR_MIN_WIDTH = 168;
const SIDEBAR_MAX_WIDTH = 500;
const SIDEBAR_AUTO_COLLAPSE_BREAKPOINT = 900;
const IN_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function preserveSidebarScrollAfterContextMenu(event: ReactMouseEvent, markInternalScroll?: (until: number) => void) {
  const target = event.currentTarget as HTMLElement | null;
  const scrollContainer = target?.closest<HTMLElement>(".ui-sidebar-combined-list") ?? null;
  const scrollTop = scrollContainer?.scrollTop ?? null;
  const treeItem = target?.closest<HTMLElement>("[data-tree-key]") ?? null;
  const activeElement = document.activeElement;
  if (activeElement instanceof HTMLElement && treeItem?.contains(activeElement)) {
    activeElement.blur();
  }
  if (!scrollContainer || scrollTop === null) return;
  markInternalScroll?.(Date.now() + 300);
  const restore = () => {
    if (scrollContainer.scrollTop !== scrollTop) {
      scrollContainer.scrollTop = scrollTop;
    }
  };
  window.setTimeout(restore, 0);
  window.requestAnimationFrame(() => {
    restore();
    window.requestAnimationFrame(restore);
  });
  window.setTimeout(restore, 50);
  window.setTimeout(restore, 150);
}

function isLikelyMacOs() {
  return typeof navigator !== "undefined" && /mac/i.test(navigator.platform);
}

function clampExpandedSidebarWidth(width: number): number {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, width));
}

function normalizePersistedSidebarWidth(width: number): number {
  if (width <= SIDEBAR_COLLAPSED_WIDTH) return SIDEBAR_COLLAPSED_WIDTH;
  return clampExpandedSidebarWidth(width === 280 ? 248 : width);
}

function resolveHistorySourceFilter(cliTool: string | null | undefined): HistorySourceFilter {
  const normalized = cliTool?.trim().toLowerCase();
  if (!normalized) return "all";
  if (normalized.includes("claude")) return "claude";
  if (normalized.includes("codex") || normalized === "code") return "codex";
  return "all";
}

function buildProjectSplitOptions(project: Project): SplitTerminalOptions {
  const title = project.cli_tool ? `${project.name} (${project.cli_tool})` : project.name;
  const envVars = parseProjectEnvVars(project);

  return {
    projectId: project.id,
    cwd: project.path,
    title,
    startupCmd: resolveProjectStartupCommand(project),
    envVars,
    shell: project.shell && project.shell !== "powershell" ? project.shell : undefined,
  };
}

function getSyncedSessionKeysForProject(
  project: Project,
  syncedSessions: ReturnType<typeof useExternalSessionSyncStore.getState>["syncedSessions"]
): string[] {
  return groupSyncedExternalSessions(syncedSessions, [project])
    .byProjectId.get(project.id)
    ?.flatMap((group) => group.sessions.map((session) => session.key)) ?? [];
}

function getSyncedHistoryGroupForProject(
  project: Project,
  syncedSessions: ReturnType<typeof useExternalSessionSyncStore.getState>["syncedSessions"]
) {
  const source = getProviderSwitchAppType(project);
  if (!source) return null;
  return groupSyncedExternalSessions(syncedSessions, [project])
    .byProjectId.get(project.id)
    ?.find((group) => group.sessions[0]?.source === source) ?? null;
}

async function buildSyncedAwareProjectSplitOptions(project: Project): Promise<SplitTerminalOptions> {
  const options = buildProjectSplitOptions(project);
  const source = getProviderSwitchAppType(project) ?? undefined;
  const syncedGroup = getSyncedHistoryGroupForProject(
    project,
    useExternalSessionSyncStore.getState().syncedSessions
  );
  return {
    ...options,
    startupCmd: await appendSyncedHistoryContextArg(source, options.startupCmd, syncedGroup, options.shell),
  };
}

function collectGroupProjectIds(groupId: string, groups: Group[], projects: Project[]): Set<string> {
  const groupIds = new Set<string>([groupId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const group of groups) {
      if (group.parent_id && groupIds.has(group.parent_id) && !groupIds.has(group.id)) {
        groupIds.add(group.id);
        changed = true;
      }
    }
  }
  return new Set(
    projects
      .filter((project) => project.group_id && groupIds.has(project.group_id))
      .map((project) => project.id)
  );
}

export function Sidebar({
  onOpenSettings,
  onOpenStats,
  compactMode = false,
  projectScopedTerminalViewEnabled = true,
  terminalScopeProjectId = null,
  onTerminalScopeChange,
}: SidebarProps) {
  const { t } = useI18n();
  const {
    tree,
    projects,
    groups,
    projectStoreLoaded,
    projectHealth,
    providerBadges,
  } = useProjectStore(
    useShallow((s) => ({
      tree: s.tree,
      projects: s.projects,
      groups: s.groups,
      projectStoreLoaded: s.loaded,
      projectHealth: s.projectHealth,
      providerBadges: s.providerBadges,
    }))
  );
  const fetchAll = useProjectStore((s) => s.fetchAll);
  const deleteProject = useProjectStore((s) => s.deleteProject);
  const createGroup = useProjectStore((s) => s.createGroup);
  const renameGroup = useProjectStore((s) => s.renameGroup);
  const deleteGroup = useProjectStore((s) => s.deleteGroup);
  const reorderItems = useProjectStore((s) => s.reorderItems);
  const moveGroupToParent = useProjectStore((s) => s.moveGroupToParent);
  const moveProjectToGroup = useProjectStore((s) => s.moveProjectToGroup);
  const updateProject = useProjectStore((s) => s.updateProject);
  const createSession = useTerminalStore((s) => s.createSession);
  const splitTerminal = useTerminalStore((s) => s.splitTerminal);
  const closeSession = useTerminalStore((s) => s.closeSession);
  const sessions = useTerminalStore((s) => s.sessions);
  const activeSessionId = useTerminalStore((s) => s.activeSessionId);
  const setActiveSession = useTerminalStore((s) => s.setActive);
  const sessionStatuses = useTerminalStore((s) => s.sessionStatuses);
  const createWorktreeForProject = useWorktreeStore((s) => s.createWorktreeForProject);
  const shouldIsolateNewSession = useWorktreeStore((s) => s.shouldIsolateNewSession);
  const validateProjectGit = useWorktreeStore((s) => s.validateProjectGit);
  const checkWorktreeDeps = useWorktreeStore((s) => s.checkDeps);
  const dismissWorktreeDepsPrompt = useWorktreeStore((s) => s.dismissDepsPrompt);
  const removeWorktree = useWorktreeStore((s) => s.removeWorktree);
  const useExternalTerminal = useSettingsStore((s) => s.useExternalTerminal);
  const sidebarDensity = useSettingsStore((s) => s.sidebarDensity);
  const sidebarToolbarVisibility = useSettingsStore((s) => s.sidebarToolbarVisibility);
  const updateSetting = useSettingsStore((s) => s.update);
  const persistedSidebarWidth = useSettingsStore((s) => s.sidebarWidth);
  const openFileProject = useFileExplorerStore((s) => s.openProject);
  const fileProject = useFileExplorerStore((s) => s.project);
  const closeHistory = useHistoryStore((s) => s.closeHistory);
  const openHistory = useHistoryStore((s) => s.openHistory);
  const triggerGlobalSearchFocus = useHistoryStore((s) => s.triggerGlobalSearchFocus);
  const removeSyncedSessions = useExternalSessionSyncStore((s) => s.removeSyncedSessions);

  const initialSidebarWidth = normalizePersistedSidebarWidth(persistedSidebarWidth);
  const [sidebarWidth, setSidebarWidth] = useState(initialSidebarWidth);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    initialSidebarWidth <= SIDEBAR_COLLAPSED_WIDTH
  );
  const [showFileExplorer, setShowFileExplorer] = useState(false);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [isMacOs, setIsMacOs] = useState(isLikelyMacOs);

  const liveSidebarWidthRef = useRef(initialSidebarWidth);
  const isResizingRef = useRef(false);
  const resizeFrameRef = useRef<number | null>(null);
  const autoCollapsedByViewportRef = useRef(false);
  const lastExpandedWidthRef = useRef(
    initialSidebarWidth <= SIDEBAR_COLLAPSED_WIDTH
      ? 248
      : clampExpandedSidebarWidth(initialSidebarWidth)
  );

  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [cloningProject, setCloningProject] = useState<Project | null>(null);
  const [providerSwitchTarget, setProviderSwitchTarget] = useState<
    | { kind: "project"; project: Project }
    | { kind: "worktree"; project: Project; worktree: WorktreeRecord }
    | null
  >(null);
  const [showAdd, setShowAdd] = useState(false);
  const [addToGroupId, setAddToGroupId] = useState<string | null>(null);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(
    () => new Set(useSettingsStore.getState().collapsedGroupIds)
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedProjectIds, setSelectedProjectIds] = useState<Set<string>>(new Set());
  // Shift 连续多选的锚点（最近一次非 Shift 的选中项），用于按可见顺序取区间
  const selectionAnchorRef = useRef<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<
    | null
    | { kind: "delete-project"; project: Project }
    | { kind: "delete-group"; groupId: string; groupName: string }
  >(null);
  const [worktreePrompt, setWorktreePrompt] = useState<{
    project: Project;
    targetPaneId?: string;
    direction?: TerminalPaneSplitDirection;
    taskName: string;
  } | null>(null);
  const [depsPrompt, setDepsPrompt] = useState<{
    project: Project;
    worktree: WorktreeRecord;
    command: string;
  } | null>(null);
  const depsPromptingWorktreeIdsRef = useRef(new Set<string>());
  const [finishTarget, setFinishTarget] = useState<{ project: Project; worktree: WorktreeRecord } | null>(null);
  const [discardTarget, setDiscardTarget] = useState<{ project: Project; worktree: WorktreeRecord } | null>(null);

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) ?? null,
    [activeSessionId, sessions]
  );
  const activeSessionProjectId = activeSession?.projectId ?? null;
  const activeSessionWorktreeId = activeSession?.worktreeId ?? null;

  useEffect(() => {
    if (projectScopedTerminalViewEnabled) return;
    if (!activeSessionProjectId) return;
    setSelectedId(activeSessionWorktreeId ?? activeSessionProjectId);
    setSelectedProjectIds((prev) => {
      if (activeSessionWorktreeId) return prev.size === 0 ? prev : new Set();
      if (prev.size === 1 && prev.has(activeSessionProjectId)) return prev;
      return new Set([activeSessionProjectId]);
    });
  }, [activeSessionProjectId, activeSessionWorktreeId, projectScopedTerminalViewEnabled]);

  useEffect(() => {
    if (!projectScopedTerminalViewEnabled) return;
    const activeSessionInScope =
      activeSessionProjectId !== null &&
      (terminalScopeProjectId === null || activeSessionProjectId === terminalScopeProjectId);
    const scopedWorktreeId = activeSessionInScope ? activeSessionWorktreeId : null;
    const scopedProjectId = activeSessionInScope ? activeSessionProjectId : terminalScopeProjectId;
    const nextSelectedId = activeSessionInScope
      ? scopedWorktreeId ?? scopedProjectId
      : terminalScopeProjectId;
    setSelectedId(nextSelectedId);
    selectionAnchorRef.current = scopedWorktreeId ? scopedProjectId : terminalScopeProjectId;
    setSelectedProjectIds((prev) => {
      if (scopedWorktreeId) return prev.size === 0 ? prev : new Set();
      if (!scopedProjectId) return prev.size === 0 ? prev : new Set();
      if (prev.size === 1 && prev.has(scopedProjectId)) return prev;
      return new Set([scopedProjectId]);
    });
  }, [activeSessionProjectId, activeSessionWorktreeId, projectScopedTerminalViewEnabled, terminalScopeProjectId]);

  useEffect(() => {
    if (!activeSessionProjectId || !activeSessionWorktreeId) return;
    const collapseKey = worktreeListCollapseId(activeSessionProjectId);
    setCollapsedIds((prev) => {
      if (!prev.has(collapseKey)) return prev;
      const next = new Set(prev);
      next.delete(collapseKey);
      return next;
    });
  }, [activeSessionProjectId, activeSessionWorktreeId]);

  useEffect(() => {
    if (!projectScopedTerminalViewEnabled) return;
    if (!terminalScopeProjectId) return;
    if (projects.some((project) => project.id === terminalScopeProjectId)) return;
    onTerminalScopeChange?.(null);
  }, [onTerminalScopeChange, projectScopedTerminalViewEnabled, projects, terminalScopeProjectId]);

  useEffect(() => {
    if (!fileProject) setShowFileExplorer(false);
  }, [fileProject]);

  // 可见项目的扁平顺序（跳过已折叠分组的子项），供 Shift 范围多选取区间
  const visibleProjectIds = useMemo(() => {
    const ids: string[] = [];
    const walk = (nodes: TNode[]) => {
      for (const node of nodes) {
        if (node.type === "group") {
          if (!collapsedIds.has(node.group.id)) walk(node.children);
        } else if (node.type === "project") {
          ids.push(node.project.id);
        }
      }
    };
    walk(tree);
    return ids;
  }, [tree, collapsedIds]);

  const activateFirstProjectSession = useCallback(
    (projectId: string): boolean => {
      const session = sessions.find((item) => item.projectId === projectId);
      if (!session) return false;
      if (session.id !== activeSessionId) {
        setActiveSession(session.id);
      }
      return true;
    },
    [activeSessionId, sessions, setActiveSession]
  );

  const activateFirstWorktreeSession = useCallback(
    (worktreeId: string): boolean => {
      const session = sessions.find((item) => item.worktreeId === worktreeId && (item.kind ?? "pty") === "pty");
      if (!session) return false;
      if (session.id !== activeSessionId) {
        setActiveSession(session.id);
      }
      return true;
    },
    [activeSessionId, sessions, setActiveSession]
  );

  const [contextMenu, setContextMenu] = useState<
    | null
    | { kind: "project"; project: Project; x: number; y: number }
    | { kind: "worktree"; project: Project; worktree: WorktreeRecord; x: number; y: number }
    | { kind: "group"; groupId: string; groupName: string; x: number; y: number }
  >(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const contextMenuOpenedAtRef = useRef(0);
  const contextMenuInternalScrollUntilRef = useRef(0);
  // 菜单真实位置：渲染后按实测尺寸做翻转/钳制，避免写死高度导致溢出遮挡。
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null);
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  const [newGroupParentId, setNewGroupParentId] = useState<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!IN_TAURI) return;
    void getOsPlatform()
      .then((platform) => setIsMacOs(platform === "macos"))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (compactMode) {
      setSidebarCollapsed(false);
      return;
    }
    if (isResizingRef.current) return;
    const normalized = normalizePersistedSidebarWidth(persistedSidebarWidth);
    setSidebarWidth(normalized);
    setSidebarCollapsed(normalized <= SIDEBAR_COLLAPSED_WIDTH);
    liveSidebarWidthRef.current = normalized;
    if (normalized > SIDEBAR_COLLAPSED_WIDTH) {
      lastExpandedWidthRef.current = normalized;
    }
  }, [compactMode, persistedSidebarWidth]);

  useEffect(() => {
    return () => {
      if (resizeFrameRef.current !== null) {
        cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
    };
  }, []);

  const persistSidebarWidth = useCallback(
    (nextWidth: number) => {
      void updateSetting("sidebarWidth", nextWidth);
    },
    [updateSetting]
  );

  const previewSidebarWidth = useCallback((rawWidth: number) => {
    const clampedRaw = Math.max(SIDEBAR_COLLAPSED_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, rawWidth));
    const shouldCollapse = clampedRaw < SIDEBAR_COLLAPSE_THRESHOLD;
    const nextWidth = shouldCollapse
      ? SIDEBAR_COLLAPSED_WIDTH
      : clampExpandedSidebarWidth(clampedRaw);

    setSidebarCollapsed(shouldCollapse);
    setSidebarWidth(nextWidth);
    liveSidebarWidthRef.current = nextWidth;
    if (!shouldCollapse) {
      lastExpandedWidthRef.current = nextWidth;
    }
  }, []);

  const collapseSidebar = useCallback((persist = true) => {
    setSidebarCollapsed(true);
    setSidebarWidth(SIDEBAR_COLLAPSED_WIDTH);
    liveSidebarWidthRef.current = SIDEBAR_COLLAPSED_WIDTH;
    if (persist) {
      persistSidebarWidth(SIDEBAR_COLLAPSED_WIDTH);
    }
  }, [persistSidebarWidth]);

  const expandSidebar = useCallback((persist = true) => {
    const fallbackWidth = lastExpandedWidthRef.current;
    const nextWidth = clampExpandedSidebarWidth(fallbackWidth);
    setSidebarCollapsed(false);
    setSidebarWidth(nextWidth);
    liveSidebarWidthRef.current = nextWidth;
    lastExpandedWidthRef.current = nextWidth;
    if (persist) {
      persistSidebarWidth(nextWidth);
    }
  }, [persistSidebarWidth]);

  const toggleSidebarCollapsed = useCallback(() => {
    if (sidebarCollapsed) {
      expandSidebar();
    } else {
      collapseSidebar();
    }
  }, [sidebarCollapsed, expandSidebar, collapseSidebar]);

  const ensureSidebarExpanded = useCallback(() => {
    if (sidebarCollapsed) {
      expandSidebar();
    }
  }, [sidebarCollapsed, expandSidebar]);

  useEffect(() => {
    if (compactMode || isMacOs) return;
    const syncViewportCollapse = () => {
      if (window.innerWidth < SIDEBAR_AUTO_COLLAPSE_BREAKPOINT) {
        if (!sidebarCollapsed) {
          autoCollapsedByViewportRef.current = true;
          collapseSidebar(false);
        }
        return;
      }

      if (autoCollapsedByViewportRef.current) {
        autoCollapsedByViewportRef.current = false;
        if (sidebarCollapsed) {
          expandSidebar(false);
        }
      }
    };

    syncViewportCollapse();
    window.addEventListener("resize", syncViewportCollapse);
    return () => {
      window.removeEventListener("resize", syncViewportCollapse);
    };
  }, [compactMode, isMacOs, sidebarCollapsed, collapseSidebar, expandSidebar]);

  const startResize = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      isResizingRef.current = true;
      setSidebarResizing(true);

      let latestX = e.clientX;
      const flush = () => {
        resizeFrameRef.current = null;
        previewSidebarWidth(latestX);
      };

      const onMove = (ev: MouseEvent) => {
        latestX = ev.clientX;
        if (resizeFrameRef.current === null) {
          resizeFrameRef.current = requestAnimationFrame(flush);
        }
      };

      const onUp = () => {
        if (resizeFrameRef.current !== null) {
          cancelAnimationFrame(resizeFrameRef.current);
          resizeFrameRef.current = null;
        }
        previewSidebarWidth(latestX);
        isResizingRef.current = false;
        setSidebarResizing(false);
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        persistSidebarWidth(liveSidebarWidthRef.current);
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [persistSidebarWidth, previewSidebarWidth]
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const activeId = active.id as string;
      const overId = over.id as string;
      const isGroup = (id: string) => groups.some((g) => g.id === id);
      const isProject = (id: string) => projects.some((p) => p.id === id);

      // 1) 拖入指定分组
      if (overId.startsWith("into:")) {
        const targetGroupId = overId.slice("into:".length);
        if (activeId === targetGroupId) return;
        if (isGroup(activeId)) void moveGroupToParent(activeId, targetGroupId);
        else if (isProject(activeId)) void moveProjectToGroup(activeId, targetGroupId);
        return;
      }

      // 3) 拖到 sibling 节点：先定位 over 所在父级与同级列表
      const findParentChildren = (
        nodes: TNode[],
        targetId: string,
        parentId: string | null
      ): { parentId: string | null; nodes: TNode[] } | null => {
        const here = nodes.some((n) =>
          n.type === "group" ? n.group.id === targetId : n.project.id === targetId
        );
        if (here) return { parentId, nodes };
        for (const n of nodes) {
          if (n.type === "group") {
            const r = findParentChildren(n.children, targetId, n.group.id);
            if (r) return r;
          }
        }
        return null;
      };

      const overContext = findParentChildren(tree, overId, null);
      if (!overContext) return;

      const ids = overContext.nodes.map((c) => (c.type === "group" ? c.group.id : c.project.id));
      const oldIndex = ids.indexOf(activeId);
      const newIndex = ids.indexOf(overId);
      if (newIndex === -1) return;

      // active 不在同层 → 跨层移到 over 所在父级
      if (oldIndex === -1) {
        const targetParent = overContext.parentId;
        if (isGroup(activeId)) void moveGroupToParent(activeId, targetParent);
        else if (isProject(activeId)) void moveProjectToGroup(activeId, targetParent);
        return;
      }

      // 同层 reorder
      const reordered = [...ids];
      reordered.splice(oldIndex, 1);
      reordered.splice(newIndex, 0, activeId);
      void reorderItems(overContext.parentId, reordered);
    },
    [groups, projects, tree, reorderItems, moveGroupToParent, moveProjectToGroup]
  );

  const loadProjects = useCallback(async () => {
    try {
      setLoadError(null);
      if (shouldSidebarBootstrapProjects(projectStoreLoaded)) {
        await fetchAll();
      }
    } catch (err) {
      const description = t("sidebar.tree.loadFailedDescription");
      setLoadError(description);
      toast.error(t("sidebar.toast.projectLoadFailed"), { description });
      logError(`Failed to fetch sidebar projects. Visible message: ${description}`, err);
    } finally {
      setInitialLoading(false);
    }
  }, [fetchAll, projectStoreLoaded, t]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e: Event) => {
      if (Date.now() - contextMenuOpenedAtRef.current < 120) return;
      if (e.type === "scroll" && Date.now() < contextMenuInternalScrollUntilRef.current) return;
      if (contextMenuRef.current && contextMenuRef.current.contains(e.target as Node)) return;
      setContextMenu(null);
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setContextMenu(null);
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("scroll", handler, true);
    window.addEventListener("resize", handler);
    window.addEventListener("keydown", keyHandler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("scroll", handler, true);
      window.removeEventListener("resize", handler);
      window.removeEventListener("keydown", keyHandler);
    };
  }, [contextMenu]);

  // 智能菜单定位：测量真实尺寸后翻转/钳制，不依赖魔法数字，避免底部溢出被遮挡。
  useLayoutEffect(() => {
    if (!contextMenu || !contextMenuRef.current) {
      setMenuPos(null);
      return;
    }
    const menu = contextMenuRef.current;
    const rect = menu.getBoundingClientRect();
    const { x: clickX, y: clickY } = contextMenu;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 8; // 视口边距

    // 水平：右侧空间不足则翻到左侧
    let left = clickX;
    if (clickX + rect.width + margin > vw) {
      left = Math.max(margin, clickX - rect.width);
    }
    left = Math.max(margin, Math.min(left, vw - rect.width - margin));

    // 垂直：下方空间不足则翻到上方
    let top = clickY;
    if (clickY + rect.height + margin > vh) {
      top = Math.max(margin, clickY - rect.height);
    }
    top = Math.max(margin, Math.min(top, vh - rect.height - margin));

    setMenuPos({ left, top });
  }, [contextMenu]);

  // 把 sessions × statuses 预聚合成 Map<projectId, status>，从每节点 O(N) filter
  // 变成 O(1) lookup。原方案在 TreeNodeItem 中每行调用一次，叠加项目树 + 状态变化
  // 会触发 O(N·M) 全表扫描。
  const projectStatusMap = useMemo(() => {
    const map = new Map<string, SessionStatus>();
    for (const session of sessions) {
      const projectId = session.projectId;
      if (!projectId) continue;
      const status = (sessionStatuses[session.id] ?? "running") as SessionStatus;
      const current = map.get(projectId);
      // running 优先级最高，其次 error，最后 exited
      if (status === "running") {
        map.set(projectId, "running");
        continue;
      }
      if (current === "running") continue;
      if (status === "error") {
        map.set(projectId, "error");
        continue;
      }
      if (current === "error") continue;
      map.set(projectId, "exited");
    }
    return map;
  }, [sessions, sessionStatuses]);

  const getProjectStatus = useCallback(
    (projectId: string): SessionStatus | null => projectStatusMap.get(projectId) ?? null,
    [projectStatusMap]
  );

  const projectTerminalCountMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const session of sessions) {
      if (!session.projectId || (session.kind && session.kind !== "pty")) continue;
      map.set(session.projectId, (map.get(session.projectId) ?? 0) + 1);
    }
    return map;
  }, [sessions]);

  const getProjectTerminalCount = useCallback(
    (projectId: string): number => projectTerminalCountMap.get(projectId) ?? 0,
    [projectTerminalCountMap]
  );

  const isPathInvalid = useCallback(
    (projectId: string): boolean => projectHealth[projectId] === false,
    [projectHealth]
  );

  const toggleCollapsed = useCallback((id: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // 折叠状态持久化：跳过首次（初始值本就来自 settings），之后任何变化都写回。
  const collapsedHydratedRef = useRef(false);
  useEffect(() => {
    if (!collapsedHydratedRef.current) {
      collapsedHydratedRef.current = true;
      return;
    }
    void updateSetting("collapsedGroupIds", Array.from(collapsedIds));
  }, [collapsedIds, updateSetting]);

  // 自愈清理：分组/项目被删除或同步覆盖后，移除已不存在节点的折叠记录。
  // groups/projects 都为空可能是尚未加载完成，此时不清理，避免误清全部记录。
  useEffect(() => {
    if (groups.length === 0 && projects.length === 0) return;
    const valid = new Set([
      ...groups.map((g) => g.id),
      ...projects.map((project) => worktreeListCollapseId(project.id)),
    ]);
    setCollapsedIds((prev) => {
      const next = new Set([...prev].filter((id) => valid.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [groups, projects]);

  const openProjectExternally = useCallback(async (items: Project[]) => {
    if (items.length === 0) return;
    const launchItems = await Promise.all(items.map(async (project) => {
      const source = getProviderSwitchAppType(project) ?? undefined;
      const startupCmd = await appendSyncedHistoryContextArg(
        source,
        resolveProjectStartupCommand(project, { includeCodexProviderProfile: false }),
        getSyncedHistoryGroupForProject(project, useExternalSessionSyncStore.getState().syncedSessions),
        project.shell || undefined
      );
      return {
        cwd: project.path,
        title: project.cli_tool ? `${project.name} (${project.cli_tool})` : project.name,
        startupCmd,
        shell: project.shell || undefined,
      };
    }));
    await openWindowsTerminal(
      launchItems
    );
    closeHistory();
  }, [closeHistory]);

  const openProjectDirect = async (project: Project, targetPaneId?: string) => {
    const options = await buildSyncedAwareProjectSplitOptions(project);
    await createSession(
      options.projectId,
      options.cwd,
      options.title,
      options.startupCmd,
      options.envVars,
      options.shell,
      targetPaneId
    );
    closeHistory();
  };

  const openWorktreeSession = async (project: Project, worktree: WorktreeRecord, targetPaneId?: string, startupCmd?: string, title?: string) => {
    const projectOptions = projectWithWorktreeProviderOverrides(project, worktree);
    const options = await buildSyncedAwareProjectSplitOptions(projectOptions);
    await createSession(
      options.projectId,
      worktree.path,
      title ?? `${project.name} · ${worktree.name}`,
      startupCmd ?? options.startupCmd,
      options.envVars,
      options.shell,
      targetPaneId,
      worktree.id,
    );
    closeHistory();
  };

  const maybePromptWorktreeDeps = async (project: Project, worktree: WorktreeRecord) => {
    if (!project.worktree_deps_prompt_enabled) return;
    if (worktree.deps_prompt_dismissed || depsPromptingWorktreeIdsRef.current.has(worktree.id)) return;
    depsPromptingWorktreeIdsRef.current.add(worktree.id);
    try {
      const deps = await checkWorktreeDeps(worktree);
      if (deps.needsInstall && deps.command) {
        setDepsPrompt({ project, worktree, command: deps.command });
        return;
      }
      depsPromptingWorktreeIdsRef.current.delete(worktree.id);
    } catch (err) {
      depsPromptingWorktreeIdsRef.current.delete(worktree.id);
      logError("Failed to check worktree dependencies", err);
    }
  };

  const handleInstallWorktreeDeps = (project: Project, worktree: WorktreeRecord) => {
    void checkWorktreeDeps(worktree)
      .then((deps) => {
        if (!deps.needsInstall || !deps.command) {
          toast.info(t("worktree.deps.notNeeded"));
          return;
        }
        const options = buildProjectSplitOptions(project);
        void dismissWorktreeDepsPrompt(worktree.id);
        return createSession(
          options.projectId,
          worktree.path,
          t("worktree.deps.installTitle", { name: worktree.name }),
          deps.command,
          options.envVars,
          options.shell,
          undefined,
          worktree.id,
        ).then(() => closeHistory());
      })
      .catch((err) => toast.error(t("worktree.deps.checkFailed"), { description: String(err) }));
  };

  const createAndOpenWorktree = async (project: Project, targetPaneId?: string, taskName?: string) => {
    const worktree = await createWorktreeForProject(project, taskName);
    await openWorktreeSession(project, worktree, targetPaneId);
    toast.success(t("worktree.toast.created"), { description: worktree.path });
    void maybePromptWorktreeDeps(project, worktree);
  };

  const createAndSplitWorktree = async (project: Project, direction: TerminalPaneSplitDirection, taskName?: string) => {
    if (!activeSessionId) return;
    const worktree = await createWorktreeForProject(project, taskName);
    const options = await buildSyncedAwareProjectSplitOptions(project);
    await splitTerminal(activeSessionId, direction, {
      ...options,
      cwd: worktree.path,
      title: `${project.name} · ${worktree.name}`,
      worktreeId: worktree.id,
    });
    closeHistory();
    toast.success(t("worktree.toast.created"), { description: worktree.path });
    void maybePromptWorktreeDeps(project, worktree);
  };

  const openProjectInternal = async (project: Project, targetPaneId?: string) => {
    const decision = shouldIsolateNewSession(project, sessions);
    if (decision === "none") {
      await openProjectDirect(project, targetPaneId);
      return;
    }

    const validGitProject = await validateProjectGit(project);
    if (!validGitProject) {
      await openProjectDirect(project, targetPaneId);
      return;
    }
    if (decision === "auto") {
      await createAndOpenWorktree(project, targetPaneId);
      return;
    }
    setWorktreePrompt({
      project,
      targetPaneId,
      taskName: createDefaultWorktreeTaskName(project.id),
    });
  };

  const openProjects = async (items: Project[]) => {
    if (items.length === 0) return;
    if (compactMode || useExternalTerminal) {
      await openProjectExternally(items);
      return;
    }

    for (const project of items) {
      await openProjectInternal(project);
    }
  };

  const handleOpen = useCallback(
    async (project: Project) => {
      await openProjects([project]);
    },
    [openProjects]
  );

  const handleSplitProject = useCallback(
    async (project: Project, direction: TerminalPaneSplitDirection) => {
      if (!activeSessionId || compactMode || useExternalTerminal) return;
      const splitDirect = async () => {
        await splitTerminal(activeSessionId, direction, await buildSyncedAwareProjectSplitOptions(project));
        closeHistory();
      };

      const decision = shouldIsolateNewSession(project, sessions);
      if (decision === "none") {
        await splitDirect();
        return;
      }

      const validGitProject = await validateProjectGit(project);
      if (!validGitProject) {
        await splitDirect();
        return;
      }
      if (decision === "auto") {
        await createAndSplitWorktree(project, direction);
        return;
      }
      setWorktreePrompt({
        project,
        direction,
        taskName: createDefaultWorktreeTaskName(project.id),
      });
    },
    [
      activeSessionId,
      closeHistory,
      compactMode,
      createAndSplitWorktree,
      sessions,
      shouldIsolateNewSession,
      splitTerminal,
      useExternalTerminal,
      validateProjectGit,
    ]
  );

  const handleCloneProject = useCallback((project: Project) => {
    setCloningProject(project);
  }, []);

  const handleOpenProjectDirectory = useCallback(async (project: Project) => {
    try {
      await invoke("open_folder_in_explorer", { path: project.path });
    } catch (err) {
      logError("Failed to open project directory", err);
      toast.error(t("sidebar.toast.openDirectoryFailed"), { description: String(err) });
    }
  }, [t]);

  const handleOpenWorktreeDirectory = useCallback(async (worktree: WorktreeRecord) => {
    try {
      await openPath(worktree.path);
    } catch (err) {
      logError("Failed to open worktree directory", err);
      toast.error(t("sidebar.toast.openDirectoryFailed"), { description: String(err) });
    }
  }, [t]);

  const handleSelectWorktree = useCallback((worktree: WorktreeRecord) => {
    setSelectedId(worktree.id);
    setSelectedProjectIds(new Set());
    selectionAnchorRef.current = worktree.project_id;
    if (projectScopedTerminalViewEnabled) {
      onTerminalScopeChange?.(worktree.project_id);
    }
    if (activateFirstWorktreeSession(worktree.id)) {
      closeHistory();
    }
  }, [activateFirstWorktreeSession, closeHistory, onTerminalScopeChange, projectScopedTerminalViewEnabled]);

  const handleOpenWorktree = useCallback((project: Project, worktree: WorktreeRecord) => {
    void openWorktreeSession(project, worktree).then(() => maybePromptWorktreeDeps(project, worktree));
  }, []);

  const handleOpenProjectFiles = useCallback(async (project: Project) => {
    try {
      if (!isSameProjectFileContext(fileProject, project) && isProjectFileDirty()) {
        const confirmed = window.confirm(t("sidebar.toast.unsavedFileConfirm"));
        if (!confirmed) return;
      }
      await openFileProject(project);
      setShowFileExplorer(true);
      closeHistory();
    } catch (err) {
      logError("Failed to open project file browser", err);
      toast.error(t("sidebar.toast.openProjectFilesFailed"), { description: String(err) });
    }
  }, [closeHistory, fileProject, openFileProject, t]);

  const handleOpenWorktreeFiles = useCallback(async (project: Project, worktree: WorktreeRecord) => {
    await handleOpenProjectFiles(projectWithWorktreePath(project, worktree));
  }, [handleOpenProjectFiles]);

  const handleBackToProjectTree = useCallback(() => {
    setShowFileExplorer(false);
  }, []);

  const handleOpenProjectHistory = useCallback(
    (project: Project) => {
      void openHistory({
        sourceFilter: resolveHistorySourceFilter(project.cli_tool),
        projectPath: project.path,
      }).then(() => {
        triggerGlobalSearchFocus();
      }).catch((err) => {
        toast.error("打开会话历史失败", { description: String(err) });
      });
    },
    [openHistory, triggerGlobalSearchFocus]
  );
  const handleOpenWorktreeHistory = useCallback(
    (project: Project, worktree: WorktreeRecord) => {
      void openHistory({
        sourceFilter: resolveHistorySourceFilter(project.cli_tool),
        projectPath: project.path,
        scopedProjectPath: worktree.path,
      }).then(() => {
        triggerGlobalSearchFocus();
      }).catch((err) => {
        toast.error(t("sidebar.toast.openHistoryFailed"), { description: String(err) });
      });
    },
    [openHistory, t, triggerGlobalSearchFocus]
  );
  const handleRequestDeleteProject = useCallback((project: Project) => {
    setConfirmAction({ kind: "delete-project", project });
  }, []);

  const handleRequestDeleteGroup = useCallback((groupId: string, groupName: string) => {
    setConfirmAction({ kind: "delete-group", groupId, groupName });
  }, []);

  const handleSelectProject = useCallback((e: ReactMouseEvent, project: Project) => {
    setSelectedId(project.id);
    if (projectScopedTerminalViewEnabled) {
      onTerminalScopeChange?.(project.id);
    }

    const additive = e.ctrlKey || e.metaKey; // Ctrl(Win/Linux) / Cmd(Mac) 切换单项
    const rangeSelect = e.shiftKey;          // Shift 连续范围选择（Windows 风格）
    const anchorId = selectionAnchorRef.current;

    // Shift 范围选择：从锚点到当前项，按可见顺序取区间
    if (rangeSelect && anchorId && anchorId !== project.id) {
      const order = visibleProjectIds;
      const from = order.indexOf(anchorId);
      const to = order.indexOf(project.id);
      if (from !== -1 && to !== -1) {
        const [lo, hi] = from <= to ? [from, to] : [to, from];
        const range = order.slice(lo, hi + 1);
        setSelectedProjectIds((prev) => {
          // Ctrl/Cmd+Shift 在已有选择上叠加区间；纯 Shift 替换为区间
          const next = additive ? new Set(prev) : new Set<string>();
          range.forEach((id) => next.add(id));
          return next;
        });
        return; // 锚点保持不变，便于以同一锚点继续扩展区间
      }
    }

    if (additive) {
      setSelectedProjectIds((prev) => {
        const next = new Set(prev);
        if (next.has(project.id)) next.delete(project.id);
        else next.add(project.id);
        return next;
      });
      selectionAnchorRef.current = project.id;
      return;
    }

    setSelectedProjectIds(new Set([project.id]));
    selectionAnchorRef.current = project.id;
    if (activateFirstProjectSession(project.id)) {
      closeHistory();
    }
  }, [activateFirstProjectSession, closeHistory, onTerminalScopeChange, projectScopedTerminalViewEnabled, visibleProjectIds]);

  const handleSelectProjectByKeyboard = useCallback((project: Project) => {
    setSelectedId(project.id);
    setSelectedProjectIds(new Set([project.id]));
    selectionAnchorRef.current = project.id;
    if (projectScopedTerminalViewEnabled) {
      onTerminalScopeChange?.(project.id);
    }
    if (activateFirstProjectSession(project.id)) {
      closeHistory();
    }
  }, [activateFirstProjectSession, closeHistory, onTerminalScopeChange, projectScopedTerminalViewEnabled]);

  const handleSelectAllTerminalScope = useCallback(() => {
    setSelectedId(null);
    setSelectedProjectIds(new Set());
    selectionAnchorRef.current = null;
    onTerminalScopeChange?.(null);
  }, [onTerminalScopeChange]);

  const handleToggleSelection = useCallback((project: Project) => {
    setSelectedProjectIds((prev) => {
      const next = new Set(prev);
      if (next.has(project.id)) next.delete(project.id);
      else next.add(project.id);
      return next;
    });
  }, []);

  const handleRenameGroup = useCallback((id: string, _name: string) => {
    setRenamingGroupId(id);
  }, []);

  const handleRenameConfirm = useCallback(
    async (id: string, newName: string) => {
      await renameGroup(id, newName);
      setRenamingGroupId(null);
    },
    [renameGroup]
  );

  const handleCreateGroup = useCallback(
    (parentId: string | null, name: string) => {
      void createGroup({ name, parent_id: parentId });
      setNewGroupParentId(null);
    },
    [createGroup]
  );

  const handleCancelNewGroup = useCallback(() => {
    setNewGroupParentId(null);
  }, []);

  const handleAddProjectToGroup = useCallback((groupId: string) => {
    setAddToGroupId(groupId);
    setShowAdd(true);
  }, []);

  const handleContextMenuProject = useCallback((e: ReactMouseEvent, project: Project) => {
    e.preventDefault();
    e.stopPropagation();
    preserveSidebarScrollAfterContextMenu(e, (until) => {
      contextMenuInternalScrollUntilRef.current = until;
    });
    contextMenuOpenedAtRef.current = Date.now();
    setContextMenu({ kind: "project", project, x: e.clientX, y: e.clientY });
  }, []);

  const handleContextMenuWorktree = useCallback((e: ReactMouseEvent, project: Project, worktree: WorktreeRecord) => {
    e.preventDefault();
    e.stopPropagation();
    contextMenuOpenedAtRef.current = Date.now();
    setSelectedId(worktree.id);
    setContextMenu({ kind: "worktree", project, worktree, x: e.clientX, y: e.clientY });
  }, []);

  const handleContextMenuGroup = useCallback((e: ReactMouseEvent, groupId: string, groupName: string) => {
    e.preventDefault();
    e.stopPropagation();
    preserveSidebarScrollAfterContextMenu(e, (until) => {
      contextMenuInternalScrollUntilRef.current = until;
    });
    contextMenuOpenedAtRef.current = Date.now();
    setContextMenu({ kind: "group", groupId, groupName, x: e.clientX, y: e.clientY });
  }, []);

  const handleStartGroup = useCallback(
    async (groupId: string) => {
      const childMap = new Map<string | null, Group[]>();
      for (const group of groups) {
        const arr = childMap.get(group.parent_id) ?? [];
        arr.push(group);
        childMap.set(group.parent_id, arr);
      }
      const groupIds = new Set<string>();
      const walk = (id: string) => {
        if (groupIds.has(id)) return;
        groupIds.add(id);
        (childMap.get(id) ?? []).forEach((child) => walk(child.id));
      };
      walk(groupId);
      const matchedProjects = projects.filter((p) => p.group_id && groupIds.has(p.group_id));

      const batchMode = useSettingsStore.getState().batchLaunchGroupInPane;
      if (!batchMode) {
        await openProjects(matchedProjects);
        return;
      }

      // Batch mode: each group click creates a new pane
      // Split the current active pane to create a new empty pane,
      // then launch all projects under this group into that new pane (multi-tab).
      const currentPaneId = useTerminalStore.getState().activePaneId;
      let targetPaneId: string | undefined;
      if (currentPaneId) {
        useTerminalStore.getState().splitPaneEmpty(currentPaneId, useSettingsStore.getState().batchLaunchPaneDirection);
        const newPaneId = useTerminalStore.getState().activePaneId;
        if (newPaneId) targetPaneId = newPaneId;
      }

      // Launch all projects into the same target pane (multi-tab)
      for (const project of matchedProjects) {
        await openProjectInternal(project, targetPaneId);
      }
    },
    // 依赖只列函数体真正读取的值，避免无关 selector 变化引起整树重建。
    [groups, projects]  // eslint-disable-line react-hooks/exhaustive-deps
  );

  const selectedProjects = useMemo(
    () => projects.filter((p) => selectedProjectIds.has(p.id)),
    [projects, selectedProjectIds]
  );

  const treeActions = useMemo<TreeActions>(
    () => ({
      selectedId,
      selectedProjectIds,
      newGroupParentId,
      collapsedIds,
      renamingGroupId,
      providerBadges,
      onSelectProject: handleSelectProject,
      onSelectProjectByKeyboard: handleSelectProjectByKeyboard,
      onOpenProject: handleOpen,
      onStartGroup: handleStartGroup,
      onRequestDeleteProject: handleRequestDeleteProject,
      onRequestDeleteGroup: handleRequestDeleteGroup,
      onRenameConfirm: handleRenameConfirm,
      onCancelRename: () => setRenamingGroupId(null),
      onContextMenuProject: handleContextMenuProject,
      onSelectWorktree: handleSelectWorktree,
      onOpenWorktree: handleOpenWorktree,
      onContextMenuWorktree: handleContextMenuWorktree,
      onContextMenuGroup: handleContextMenuGroup,
      onCreateGroup: handleCreateGroup,
      onCancelNewGroup: handleCancelNewGroup,
      toggleCollapsed,
      getProjectStatus,
      getProjectTerminalCount,
      isPathInvalid,
      onDragEnd: handleDragEnd,
    }),
    [
      selectedId,
      selectedProjectIds,
      newGroupParentId,
      collapsedIds,
      renamingGroupId,
      providerBadges,
      handleSelectProject,
      handleSelectProjectByKeyboard,
      handleOpen,
      handleStartGroup,
      handleRequestDeleteProject,
      handleRequestDeleteGroup,
      handleRenameConfirm,
      handleContextMenuProject,
      handleSelectWorktree,
      handleOpenWorktree,
      handleContextMenuWorktree,
      handleContextMenuGroup,
      handleCreateGroup,
      handleCancelNewGroup,
      toggleCollapsed,
      getProjectStatus,
      getProjectTerminalCount,
      isPathInvalid,
      handleDragEnd,
    ]
  );

  const confirmDialog = (() => {
    if (!confirmAction) return null;
    if (confirmAction.kind === "delete-project") {
      return {
        title: t("sidebar.confirm.deleteTerminalTitle"),
        message: t("sidebar.confirm.deleteTerminalMessage", { name: confirmAction.project.name }),
        confirmText: t("sidebar.menu.delete"),
        danger: true,
        onConfirm: async () => {
          try {
            const syncedKeys = getSyncedSessionKeysForProject(
              confirmAction.project,
              useExternalSessionSyncStore.getState().syncedSessions
            );
            const projectSessionIds = useTerminalStore
              .getState()
              .sessions
              .filter((session) =>
                session.projectId === confirmAction.project.id
                || session.fileEditor?.projectId === confirmAction.project.id
              )
              .map((session) => session.id);
            for (const sessionId of projectSessionIds) {
              await closeSession(sessionId);
            }
            await deleteProject(confirmAction.project.id);
            if (syncedKeys.length > 0) {
              await removeSyncedSessions(syncedKeys);
            }
            toast.success(t("sidebar.toast.terminalDeleteSuccess"));
            setConfirmAction(null);
            if (selectedId === confirmAction.project.id) setSelectedId(null);
            setSelectedProjectIds((prev) => {
              const next = new Set(prev);
              next.delete(confirmAction.project.id);
              return next;
            });
          } catch (err) {
            toast.error(t("sidebar.toast.terminalDeleteFailed"), { description: String(err) });
          }
        },
      };
    }

    return {
      title: t("sidebar.confirm.deleteGroupTitle"),
      message: t("sidebar.confirm.deleteGroupMessage", { name: confirmAction.groupName }),
      confirmText: t("sidebar.menu.delete"),
      danger: true,
      onConfirm: async () => {
        try {
          const projectIds = collectGroupProjectIds(confirmAction.groupId, groups, projects);
          const groupProjects = projects.filter((project) => projectIds.has(project.id));
          const syncedKeys = groupProjects.flatMap((project) =>
            getSyncedSessionKeysForProject(project, useExternalSessionSyncStore.getState().syncedSessions)
          );
          const sessionIds = useTerminalStore
            .getState()
            .sessions
            .filter((session) =>
              (session.projectId && projectIds.has(session.projectId))
              || (session.fileEditor?.projectId && projectIds.has(session.fileEditor.projectId))
            )
            .map((session) => session.id);
          for (const sessionId of sessionIds) {
            await closeSession(sessionId);
          }
          for (const project of groupProjects) {
            await deleteProject(project.id);
          }
          if (syncedKeys.length > 0) {
            await removeSyncedSessions(syncedKeys);
          }
          await deleteGroup(confirmAction.groupId);
          toast.success(t("sidebar.toast.groupDeleteSuccess"));
          setConfirmAction(null);
          if (selectedId && projectIds.has(selectedId)) setSelectedId(null);
          setSelectedProjectIds((prev) => {
            const next = new Set(prev);
            projectIds.forEach((id) => next.delete(id));
            return next;
          });
        } catch (err) {
          toast.error(t("sidebar.toast.groupDeleteFailed"), { description: String(err) });
        }
      },
    };
  })();
  return (
    <aside
      className={`ui-sidebar-shell relative flex select-none flex-col overflow-hidden ${
        compactMode ? "min-w-0 flex-1" : "shrink-0"
      } ${sidebarResizing ? "transition-none" : "transition-[width] duration-150"}`}
      data-sidebar-density={sidebarDensity}
      style={{ width: compactMode ? "100%" : sidebarWidth }}
    >
      <div className="ui-sidebar-top">
        <SidebarHeader
          collapsed={compactMode ? false : sidebarCollapsed}
          density={sidebarDensity}
          onToggleCollapse={toggleSidebarCollapsed}
          onCreateGroup={() => {
            ensureSidebarExpanded();
            setNewGroupParentId("__root__");
          }}
          onCreateProject={() => {
            ensureSidebarExpanded();
            setAddToGroupId(null);
            setShowAdd(true);
          }}
        />
      </div>

      <div className={`${compactMode ? "min-h-[220px]" : "min-h-0"} flex-1 overflow-hidden`}>
        {showFileExplorer && fileProject && !sidebarCollapsed ? (
          <FileExplorerSidebar onBackToProjects={handleBackToProjectTree} />
        ) : (
          <TreeContext.Provider value={treeActions}>
            <div className="ui-sidebar-combined-list h-full min-h-0 overflow-y-auto overflow-x-hidden">
              <ProjectTree
                tree={tree}
                initialLoading={initialLoading}
                loadError={loadError}
                collapsed={compactMode ? false : sidebarCollapsed}
                density={sidebarDensity}
                newGroupParentId={newGroupParentId}
                projectScopedTerminalViewEnabled={projectScopedTerminalViewEnabled}
                terminalScopeProjectId={terminalScopeProjectId}
                onSelectAllTerminalScope={handleSelectAllTerminalScope}
                onCreateRootGroup={(name) => handleCreateGroup(null, name)}
                onCancelRootGroup={handleCancelNewGroup}
                onQuickAddProject={() => {
                  ensureSidebarExpanded();
                  setAddToGroupId(null);
                  setShowAdd(true);
                }}
                onRetry={() => {
                  setInitialLoading(true);
                  void loadProjects();
                }}
                onExpandSidebar={expandSidebar}
              />
            </div>
          </TreeContext.Provider>
        )}
      </div>

      <div className="ui-sidebar-footer shrink-0">
        <SidebarFooter
          collapsed={compactMode ? false : sidebarCollapsed}
          onOpenSettings={onOpenSettings}
          onOpenStats={onOpenStats}
          toolbarVisibility={sidebarToolbarVisibility}
        />
      </div>

      {contextMenu && (
        <Portal>
          <div
            className="context-menu"
            style={{
              left: menuPos?.left ?? 0,
              top: menuPos?.top ?? 0,
              visibility: menuPos ? "visible" : "hidden",
            }}
            ref={contextMenuRef}
            role="menu"
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
          >
            {contextMenu.kind === "project" && (
              <>
                <button
                  className="context-menu-item"
                  role="menuitem"
                  onClick={() => {
                    void handleOpen(contextMenu.project);
                    setContextMenu(null);
                  }}
                >
                  <Play size={14} strokeWidth={1.5} />
                  {compactMode ? t("sidebar.menu.openExternalTerminal") : t("sidebar.menu.openTerminal")}
                </button>
                <button
                  className="context-menu-item"
                  role="menuitem"
                  disabled={compactMode || useExternalTerminal || !activeSessionId}
                  onClick={() => {
                    void handleSplitProject(contextMenu.project, "horizontal");
                    setContextMenu(null);
                  }}
                >
                  <SquareSplitHorizontal size={14} strokeWidth={1.5} />
                  {t("sidebar.menu.splitRight")}
                </button>
                <button
                  className="context-menu-item"
                  role="menuitem"
                  disabled={compactMode || useExternalTerminal || !activeSessionId}
                  onClick={() => {
                    void handleSplitProject(contextMenu.project, "vertical");
                    setContextMenu(null);
                  }}
                >
                  <SquareSplitVertical size={14} strokeWidth={1.5} />
                  {t("sidebar.menu.splitDown")}
                </button>
                <div className="context-menu-separator" role="separator" />
                <button
                  className="context-menu-item"
                  role="menuitem"
                  onClick={() => {
                    handleCloneProject(contextMenu.project);
                    setContextMenu(null);
                  }}
                >
                  <Copy size={14} strokeWidth={1.5} />
                  {t("sidebar.menu.clone")}
                </button>
                <button
                  className="context-menu-item"
                  role="menuitem"
                  onClick={() => {
                    handleToggleSelection(contextMenu.project);
                    setContextMenu(null);
                  }}
                >
                  <Check size={14} strokeWidth={1.5} />
                  {selectedProjectIds.has(contextMenu.project.id) ? t("sidebar.menu.deselect") : t("sidebar.menu.addToSelection")}
                </button>
                <button
                  className="context-menu-item"
                  role="menuitem"
                  onClick={() => {
                    void openProjects(selectedProjects);
                    setContextMenu(null);
                  }}
                  disabled={selectedProjects.length === 0}
                >
                  <TerminalSquare size={14} strokeWidth={1.5} />
                  {t("sidebar.menu.launchSelected", { count: selectedProjects.length })}
                </button>
                <button
                  className="context-menu-item"
                  role="menuitem"
                  onClick={() => {
                    void handleOpenProjectDirectory(contextMenu.project);
                    setContextMenu(null);
                  }}
                >
                  <FolderOpen size={14} strokeWidth={1.5} />
                  {t("sidebar.menu.openDirectory")}
                </button>
                <button
                  className="context-menu-item"
                  role="menuitem"
                  onClick={() => {
                    void handleOpenProjectFiles(contextMenu.project);
                    setContextMenu(null);
                  }}
                >
                  <FileCode size={14} strokeWidth={1.5} />
                  {t("sidebar.menu.browseFiles")}
                </button>
                <button
                  className="context-menu-item"
                  role="menuitem"
                  onClick={() => {
                    handleOpenProjectHistory(contextMenu.project);
                    setContextMenu(null);
                  }}
                >
                  <ListClockIcon size={14} />
                  {t("sidebar.menu.sessionHistory")}
                </button>
                {getProviderSwitchAppType(contextMenu.project) && (
                  <button
                    className="context-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setProviderSwitchTarget({ kind: "project", project: contextMenu.project });
                      setContextMenu(null);
                    }}
                  >
                    <ArrowLeftRight size={14} strokeWidth={1.5} />
                    {t("sidebar.menu.switchProvider")}
                  </button>
                )}
                <button
                  className="context-menu-item"
                  role="menuitem"
                  onClick={() => {
                    setEditingProject(contextMenu.project);
                    setContextMenu(null);
                  }}
                >
                  <Pencil size={14} strokeWidth={1.5} />
                  {t("sidebar.menu.edit")}
                </button>
                <div className="context-menu-separator" role="separator" />
                <button
                  className="context-menu-item danger"
                  onClick={() => {
                    handleRequestDeleteProject(contextMenu.project);
                    setContextMenu(null);
                  }}
                >
                  <Trash2 size={14} strokeWidth={1.5} />
                  {t("sidebar.menu.delete")}
                </button>
              </>
            )}
            {contextMenu.kind === "worktree" && (
              <>
                <button
                  className="context-menu-item"
                  role="menuitem"
                  onClick={() => {
                    handleOpenWorktree(contextMenu.project, contextMenu.worktree);
                    setContextMenu(null);
                  }}
                >
                  <Play size={14} strokeWidth={1.5} />
                  {t("worktree.menu.open")}
                </button>
                <button
                  className="context-menu-item"
                  role="menuitem"
                  onClick={() => {
                    setFinishTarget({ project: contextMenu.project, worktree: contextMenu.worktree });
                    setContextMenu(null);
                  }}
                >
                  <Check size={14} strokeWidth={1.5} />
                  {t("worktree.menu.finish")}
                </button>
                <button
                  className="context-menu-item"
                  role="menuitem"
                  onClick={() => {
                    handleOpenWorktreeHistory(contextMenu.project, contextMenu.worktree);
                    setContextMenu(null);
                  }}
                >
                  <ListClockIcon size={14} />
                  {t("worktree.menu.viewHistory")}
                </button>
                <button
                  className="context-menu-item"
                  role="menuitem"
                  onClick={() => {
                    handleInstallWorktreeDeps(contextMenu.project, contextMenu.worktree);
                    setContextMenu(null);
                  }}
                >
                  <TerminalSquare size={14} strokeWidth={1.5} />
                  {t("worktree.menu.installDeps")}
                </button>
                <button
                  className="context-menu-item"
                  role="menuitem"
                  onClick={() => {
                    void handleOpenWorktreeDirectory(contextMenu.worktree);
                    setContextMenu(null);
                  }}
                >
                  <FolderOpen size={14} strokeWidth={1.5} />
                  {t("worktree.menu.openDirectory")}
                </button>
                <button
                  className="context-menu-item"
                  role="menuitem"
                  onClick={() => {
                    void handleOpenWorktreeFiles(contextMenu.project, contextMenu.worktree);
                    setContextMenu(null);
                  }}
                >
                  <FileCode size={14} strokeWidth={1.5} />
                  {t("sidebar.menu.browseFiles")}
                </button>
                {getProviderSwitchAppType(contextMenu.project) && (
                  <button
                    className="context-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setProviderSwitchTarget({
                        kind: "worktree",
                        project: contextMenu.project,
                        worktree: contextMenu.worktree,
                      });
                      setContextMenu(null);
                    }}
                  >
                    <ArrowLeftRight size={14} strokeWidth={1.5} />
                    {t("sidebar.menu.switchProvider")}
                  </button>
                )}
                <div className="context-menu-separator" role="separator" />
                <button
                  className="context-menu-item danger"
                  role="menuitem"
                  onClick={() => {
                    setDiscardTarget({ project: contextMenu.project, worktree: contextMenu.worktree });
                    setContextMenu(null);
                  }}
                >
                  <Trash2 size={14} strokeWidth={1.5} />
                  {t("worktree.menu.discard")}
                </button>
              </>
            )}
            {contextMenu.kind === "group" && (
              <>
                <button
                  className="context-menu-item"
                  role="menuitem"
                  onClick={() => {
                    void handleStartGroup(contextMenu.groupId);
                    setContextMenu(null);
                  }}
                >
                  <Play size={14} strokeWidth={1.5} />
                  {compactMode ? t("sidebar.menu.openGroupExternal") : t("sidebar.menu.startGroup")}
                </button>
                <div className="context-menu-separator" role="separator" />
                <button
                  className="context-menu-item"
                  role="menuitem"
                  onClick={() => {
                    ensureSidebarExpanded();
                    setNewGroupParentId(contextMenu.groupId);
                    setContextMenu(null);
                  }}
                >
                  <FolderPlus size={14} strokeWidth={1.5} />
                  {t("sidebar.menu.newChildGroup")}
                </button>
                <button
                  className="context-menu-item"
                  role="menuitem"
                  onClick={() => {
                    ensureSidebarExpanded();
                    handleAddProjectToGroup(contextMenu.groupId);
                    setContextMenu(null);
                  }}
                >
                  <Plus size={14} strokeWidth={1.5} />
                  {t("sidebar.menu.newTerminal")}
                </button>
                <button
                  className="context-menu-item"
                  role="menuitem"
                  onClick={() => {
                    ensureSidebarExpanded();
                    handleRenameGroup(contextMenu.groupId, contextMenu.groupName);
                    setContextMenu(null);
                  }}
                >
                  <Pencil size={14} strokeWidth={1.5} />
                  {t("sidebar.menu.rename")}
                </button>
                <div className="context-menu-separator" role="separator" />
                <button
                  className="context-menu-item danger"
                  onClick={() => {
                    handleRequestDeleteGroup(contextMenu.groupId, contextMenu.groupName);
                    setContextMenu(null);
                  }}
                >
                  <Trash2 size={14} strokeWidth={1.5} />
                  {t("sidebar.menu.delete")}
                </button>
              </>
            )}
          </div>
        </Portal>
      )}

      <Dialog open={!!worktreePrompt} onOpenChange={(next) => { if (!next) setWorktreePrompt(null); }}>
        <DialogContent className="ui-worktree-prompt-dialog max-w-[440px]" showCloseButton={false}>
          <button
            type="button"
            className="ui-worktree-prompt-close"
            aria-label={t("common.close")}
            onClick={() => setWorktreePrompt(null)}
          >
            <X size={15} strokeWidth={2} />
          </button>
          <div className="pr-10">
            <DialogTitle>{t("worktree.prompt.title")}</DialogTitle>
            <DialogDescription className="mt-2">
              {worktreePrompt ? t("worktree.prompt.description", { name: worktreePrompt.project.name }) : ""}
            </DialogDescription>
          </div>
          <div className="mt-4">
            <label className="mb-1 block text-xs text-text-muted">{t("worktree.prompt.taskName")}</label>
            <Input
              value={worktreePrompt?.taskName ?? ""}
              onChange={(event) => setWorktreePrompt((current) => current ? { ...current, taskName: sanitizeWorktreeTaskName(event.currentTarget.value) } : current)}
              className="text-sm"
            />
            {worktreePrompt && !validateWorktreeTaskName(worktreePrompt.taskName) && (
              <p className="mt-1 text-[11px] text-danger">{t("worktree.prompt.invalidName")}</p>
            )}
          </div>
          <DialogFooter className="ui-worktree-prompt-footer">
            <Button
              variant="outline"
              className="ui-worktree-prompt-action ui-worktree-prompt-action-neutral"
              onClick={() => {
                if (worktreePrompt?.direction && activeSessionId) {
                  void buildSyncedAwareProjectSplitOptions(worktreePrompt.project)
                    .then((options) => splitTerminal(activeSessionId, worktreePrompt.direction!, options))
                    .then(() => closeHistory());
                } else if (worktreePrompt) {
                  void openProjectDirect(worktreePrompt.project, worktreePrompt.targetPaneId);
                }
                setWorktreePrompt(null);
              }}
            >
              {t("worktree.prompt.direct")}
            </Button>
            <Button
              variant="outline"
              className="ui-worktree-prompt-action ui-worktree-prompt-action-accent"
              onClick={() => {
                if (worktreePrompt) {
                  void updateProject(worktreePrompt.project.id, { worktree_strategy: "autoParallel" }).then(() => {
                    if (worktreePrompt.direction) {
                      return createAndSplitWorktree(worktreePrompt.project, worktreePrompt.direction, worktreePrompt.taskName);
                    }
                    return createAndOpenWorktree(worktreePrompt.project, worktreePrompt.targetPaneId, worktreePrompt.taskName);
                  });
                }
                setWorktreePrompt(null);
              }}
              disabled={!worktreePrompt || !validateWorktreeTaskName(worktreePrompt.taskName)}
            >
              {t("worktree.prompt.autoParallel")}
            </Button>
            <Button
              className="ui-worktree-prompt-action ui-worktree-prompt-action-primary"
              onClick={() => {
                if (worktreePrompt?.direction) {
                  void createAndSplitWorktree(worktreePrompt.project, worktreePrompt.direction, worktreePrompt.taskName);
                } else if (worktreePrompt) {
                  void createAndOpenWorktree(worktreePrompt.project, worktreePrompt.targetPaneId, worktreePrompt.taskName);
                }
                setWorktreePrompt(null);
              }}
              disabled={!worktreePrompt || !validateWorktreeTaskName(worktreePrompt.taskName)}
            >
              {t("worktree.prompt.isolate")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!depsPrompt}
        onOpenChange={(next) => {
          if (next) return;
          if (depsPrompt) {
            depsPromptingWorktreeIdsRef.current.delete(depsPrompt.worktree.id);
            void dismissWorktreeDepsPrompt(depsPrompt.worktree.id);
          }
          setDepsPrompt(null);
        }}
      >
        <DialogContent className="max-w-[420px]" showCloseButton={false}>
          <DialogTitle>{t("worktree.deps.title")}</DialogTitle>
          <DialogDescription className="mt-2">
            {depsPrompt ? t("worktree.deps.description", { name: depsPrompt.worktree.name, command: depsPrompt.command }) : ""}
          </DialogDescription>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                if (depsPrompt) {
                  depsPromptingWorktreeIdsRef.current.delete(depsPrompt.worktree.id);
                  void dismissWorktreeDepsPrompt(depsPrompt.worktree.id);
                }
                setDepsPrompt(null);
              }}
            >
              {t("worktree.deps.skip")}
            </Button>
            <Button
              onClick={() => {
                if (depsPrompt) {
                  depsPromptingWorktreeIdsRef.current.delete(depsPrompt.worktree.id);
                  void dismissWorktreeDepsPrompt(depsPrompt.worktree.id);
                  void openWorktreeSession(
                    depsPrompt.project,
                    depsPrompt.worktree,
                    undefined,
                    depsPrompt.command,
                    t("worktree.deps.installTitle", { name: depsPrompt.worktree.name }),
                  );
                }
                setDepsPrompt(null);
              }}
            >
              {t("worktree.deps.install")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <WorktreeFinishDialog
        open={!!finishTarget}
        project={finishTarget?.project ?? null}
        worktree={finishTarget?.worktree ?? null}
        onClose={() => setFinishTarget(null)}
      />

      <ConfirmDialog
        open={!!discardTarget}
        title={t("worktree.discard.title", { name: discardTarget?.worktree.name ?? "" })}
        message={t("worktree.discard.message", { branch: discardTarget?.worktree.branch ?? "" })}
        confirmText={t("worktree.discard.confirm")}
        cancelText={t("common.cancel")}
        danger
        onConfirm={() => {
          if (discardTarget) {
            void removeWorktree(discardTarget.worktree, true).catch((err) => {
              toast.error(t("worktree.toast.discardFailed"), { description: String(err) });
            });
          }
          setDiscardTarget(null);
        }}
        onClose={() => setDiscardTarget(null)}
      />

      {showAdd && (
        <ConfigModal
          defaultGroupId={addToGroupId}
          onClose={() => {
            setShowAdd(false);
            setAddToGroupId(null);
          }}
        />
      )}
      {cloningProject && (
        <ConfigModal
          cloneFrom={cloningProject}
          onClose={() => setCloningProject(null)}
        />
      )}
      {editingProject && <ConfigModal project={editingProject} onClose={() => setEditingProject(null)} />}
      {providerSwitchTarget && (
        <ProviderSwitchModal
          project={providerSwitchTarget.project}
          worktree={providerSwitchTarget.kind === "worktree" ? providerSwitchTarget.worktree : undefined}
          onClose={() => setProviderSwitchTarget(null)}
        />
      )}
      <ConfirmDialog
        open={!!confirmDialog}
        title={confirmDialog?.title ?? ""}
        message={confirmDialog?.message}
        confirmText={confirmDialog?.confirmText ?? "删除"}
        danger={confirmDialog?.danger ?? false}
        onConfirm={confirmDialog?.onConfirm ?? (() => {})}
        onClose={() => setConfirmAction(null)}
      />

      {!compactMode && (
        <div
          onMouseDown={startResize}
          className="ui-sidebar-resize-handle absolute bottom-0 right-0 top-0 z-10 w-1.5 cursor-col-resize transition-colors"
          style={{ opacity: 0.8 }}
        />
      )}
    </aside>
  );
}
