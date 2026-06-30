import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo, type MouseEvent as ReactMouseEvent } from "react";
import { useShallow } from "zustand/shallow";
import type { DragEndEvent } from "@dnd-kit/core";
import { useProjectStore } from "../../stores/projectStore";
import { useTerminalStore, type SessionStatus, type SplitTerminalOptions } from "../../stores/terminalStore";
import { isProjectFileDirty, useFileExplorerStore } from "../../stores/fileExplorerStore";
import { useHistoryStore } from "../../stores/historyStore";
import { useSettingsStore } from "../../stores/settingsStore";
import type { TerminalPaneSplitDirection } from "../../stores/terminalPaneTree";
import type { HistorySourceFilter, Project, TreeNode as TNode, Group } from "../../lib/types";
import { ConfigModal } from "../ConfigModal";
import { ConfirmDialog } from "../ConfirmDialog";
import { ProviderSwitchModal } from "../ProviderSwitchModal";
import { openWindowsTerminal } from "../../lib/externalTerminal";
import { resolveProjectStartupCommand } from "../../lib/projectStartupCommand";
import { getProviderSwitchAppType, parseProjectEnvVars } from "../../lib/providerSwitching";
import { TreeContext, type TreeActions } from "./TreeContext";
import { Portal } from "../ui/Portal";
import { toast } from "sonner";
import { logError } from "../../lib/logger";
import { SidebarHeader } from "./SidebarHeader";
import { ProjectTree } from "./ProjectTree";
import { SidebarFooter } from "./SidebarFooter";
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
} from "../icons";
import { openPath } from "@tauri-apps/plugin-opener";
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

export function Sidebar({
  onOpenSettings,
  onOpenStats,
  compactMode = false,
  projectScopedTerminalViewEnabled = false,
  terminalScopeProjectId = null,
  onTerminalScopeChange,
}: SidebarProps) {
  const { t } = useI18n();
  const {
    tree,
    projects,
    groups,
    projectHealth,
    providerBadges,
  } = useProjectStore(
    useShallow((s) => ({
      tree: s.tree,
      projects: s.projects,
      groups: s.groups,
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
  const createSession = useTerminalStore((s) => s.createSession);
  const splitTerminal = useTerminalStore((s) => s.splitTerminal);
  const sessions = useTerminalStore((s) => s.sessions);
  const activeSessionId = useTerminalStore((s) => s.activeSessionId);
  const setActiveSession = useTerminalStore((s) => s.setActive);
  const sessionStatuses = useTerminalStore((s) => s.sessionStatuses);
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
  const [switchingProviderProject, setSwitchingProviderProject] = useState<Project | null>(null);
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

  const activeSessionProjectId = useMemo(
    () => sessions.find((session) => session.id === activeSessionId)?.projectId ?? null,
    [activeSessionId, sessions]
  );

  useEffect(() => {
    if (projectScopedTerminalViewEnabled) return;
    if (!activeSessionProjectId) return;
    setSelectedId(activeSessionProjectId);
    setSelectedProjectIds((prev) => {
      if (prev.size === 1 && prev.has(activeSessionProjectId)) return prev;
      return new Set([activeSessionProjectId]);
    });
  }, [activeSessionProjectId, projectScopedTerminalViewEnabled]);

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
        } else {
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

  const [contextMenu, setContextMenu] = useState<
    | null
    | { kind: "project"; project: Project; x: number; y: number }
    | { kind: "group"; groupId: string; groupName: string; x: number; y: number }
  >(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const contextMenuOpenedAtRef = useRef(0);
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
      await fetchAll();
    } catch (err) {
      const description = String(err);
      setLoadError(description);
      toast.error(t("sidebar.toast.projectLoadFailed"), { description });
      logError("Failed to fetch sidebar projects", err);
    } finally {
      setInitialLoading(false);
    }
  }, [fetchAll, t]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e: Event) => {
      if (Date.now() - contextMenuOpenedAtRef.current < 120) return;
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

  // 自愈清理：分组被删除（含级联）或同步覆盖后，移除已不存在分组的折叠记录。
  // groups 为空可能是尚未加载完成，此时不清理，避免误清全部记录。
  useEffect(() => {
    if (groups.length === 0) return;
    const valid = new Set(groups.map((g) => g.id));
    setCollapsedIds((prev) => {
      const next = new Set([...prev].filter((id) => valid.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [groups]);

  const openProjectExternally = useCallback(async (items: Project[]) => {
    if (items.length === 0) return;
    await openWindowsTerminal(
      items.map((project) => ({
        cwd: project.path,
        title: project.cli_tool ? `${project.name} (${project.cli_tool})` : project.name,
        startupCmd: resolveProjectStartupCommand(project, { includeCodexProviderProfile: false }),
        shell: project.shell || undefined,
      }))
    );
    closeHistory();
  }, [closeHistory]);

  const openProjectInternal = async (project: Project, targetPaneId?: string) => {
    const options = buildProjectSplitOptions(project);
    await createSession(options.projectId, options.cwd, options.title, options.startupCmd, options.envVars, options.shell, targetPaneId);
    closeHistory();
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
      await splitTerminal(activeSessionId, direction, buildProjectSplitOptions(project));
      closeHistory();
    },
    [activeSessionId, closeHistory, compactMode, splitTerminal, useExternalTerminal]
  );

  const handleCloneProject = useCallback((project: Project) => {
    setCloningProject(project);
  }, []);

  const handleOpenProjectDirectory = useCallback(async (project: Project) => {
    try {
      await openPath(project.path);
    } catch (err) {
      logError("Failed to open project directory", err);
      toast.error(t("sidebar.toast.openDirectoryFailed"), { description: String(err) });
    }
  }, [t]);

  const handleOpenProjectFiles = useCallback(async (project: Project) => {
    try {
      if (fileProject?.id !== project.id && isProjectFileDirty()) {
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
  }, [closeHistory, fileProject?.id, openFileProject, t]);

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
    contextMenuOpenedAtRef.current = Date.now();
    setSelectedId(project.id);
    setContextMenu({ kind: "project", project, x: e.clientX, y: e.clientY });
  }, []);

  const handleContextMenuGroup = useCallback((e: ReactMouseEvent, groupId: string, groupName: string) => {
    e.preventDefault();
    e.stopPropagation();
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
      onContextMenuGroup: handleContextMenuGroup,
      onCreateGroup: handleCreateGroup,
      onCancelNewGroup: handleCancelNewGroup,
      toggleCollapsed,
      getProjectStatus,
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
      handleContextMenuGroup,
      handleCreateGroup,
      handleCancelNewGroup,
      toggleCollapsed,
      getProjectStatus,
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
            await deleteProject(confirmAction.project.id);
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
          await deleteGroup(confirmAction.groupId);
          toast.success(t("sidebar.toast.groupDeleteSuccess"));
          setConfirmAction(null);
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
                      setSwitchingProviderProject(contextMenu.project);
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
      {switchingProviderProject && (
        <ProviderSwitchModal
          project={switchingProviderProject}
          onClose={() => setSwitchingProviderProject(null)}
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
