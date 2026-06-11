import { useState, useEffect, useRef, useCallback, useMemo, type MouseEvent as ReactMouseEvent } from "react";
import { useShallow } from "zustand/shallow";
import type { DragEndEvent } from "@dnd-kit/core";
import { useProjectStore } from "../../stores/projectStore";
import { useTerminalStore, type SessionStatus, type SplitTerminalOptions } from "../../stores/terminalStore";
import { useSettingsStore } from "../../stores/settingsStore";
import type { TerminalPaneSplitDirection } from "../../stores/terminalPaneTree";
import type { Project, TreeNode as TNode, Group } from "../../lib/types";
import { ConfigModal } from "../ConfigModal";
import { ConfirmDialog } from "../ConfirmDialog";
import { openWindowsTerminal } from "../../lib/externalTerminal";
import { TreeContext, type TreeActions } from "./TreeContext";
import { Portal } from "../ui/Portal";
import { toast } from "sonner";
import { logError } from "../../lib/logger";
import { SidebarHeader } from "./SidebarHeader";
import { SidebarSearch } from "./SidebarSearch";
import { ProjectTree } from "./ProjectTree";
import { SidebarFooter } from "./SidebarFooter";
import {
  Check,
  Copy,
  FolderOpen,
  FolderPlus,
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

interface SidebarProps {
  onOpenSettings: (tab?: SettingsTab) => void;
  onOpenStats: () => void;
  compactMode?: boolean;
}

const SIDEBAR_COLLAPSED_WIDTH = 60;
const SIDEBAR_COLLAPSE_THRESHOLD = 150;
const SIDEBAR_MIN_WIDTH = 180;
const SIDEBAR_MAX_WIDTH = 500;
const SIDEBAR_AUTO_COLLAPSE_BREAKPOINT = 900;

function clampExpandedSidebarWidth(width: number): number {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, width));
}

function normalizePersistedSidebarWidth(width: number): number {
  if (width <= SIDEBAR_COLLAPSED_WIDTH) return SIDEBAR_COLLAPSED_WIDTH;
  return clampExpandedSidebarWidth(width);
}

function buildProjectSplitOptions(project: Project): SplitTerminalOptions {
  const title = project.cli_tool ? `${project.name} (${project.cli_tool})` : project.name;
  let envVars: Record<string, string> | undefined;
  try {
    const parsed = JSON.parse(project.env_vars || "{}");
    if (typeof parsed === "object" && parsed !== null && Object.keys(parsed).length > 0) {
      envVars = parsed as Record<string, string>;
    }
  } catch {
    // ignore invalid env json
  }

  return {
    projectId: project.id,
    cwd: project.path,
    title,
    startupCmd: project.startup_cmd || project.cli_tool || undefined,
    envVars,
    shell: project.shell && project.shell !== "powershell" ? project.shell : undefined,
  };
}

export function Sidebar({ onOpenSettings, onOpenStats, compactMode = false }: SidebarProps) {
  const {
    tree,
    projects,
    groups,
    searchQuery,
    projectHealth,
  } = useProjectStore(
    useShallow((s) => ({
      tree: s.tree,
      projects: s.projects,
      groups: s.groups,
      searchQuery: s.searchQuery,
      projectHealth: s.projectHealth,
    }))
  );
  const setSearchQuery = useProjectStore((s) => s.setSearchQuery);
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
  const updateSetting = useSettingsStore((s) => s.update);
  const persistedSidebarWidth = useSettingsStore((s) => s.sidebarWidth);

  const initialSidebarWidth = normalizePersistedSidebarWidth(persistedSidebarWidth);
  const [sidebarWidth, setSidebarWidth] = useState(initialSidebarWidth);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    initialSidebarWidth <= SIDEBAR_COLLAPSED_WIDTH
  );
  const [sidebarResizing, setSidebarResizing] = useState(false);

  const liveSidebarWidthRef = useRef(initialSidebarWidth);
  const isResizingRef = useRef(false);
  const resizeFrameRef = useRef<number | null>(null);
  const autoCollapsedByViewportRef = useRef(false);
  const lastExpandedWidthRef = useRef(
    initialSidebarWidth <= SIDEBAR_COLLAPSED_WIDTH
      ? 280
      : clampExpandedSidebarWidth(initialSidebarWidth)
  );

  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [cloningProject, setCloningProject] = useState<Project | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [addToGroupId, setAddToGroupId] = useState<string | null>(null);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(
    () => new Set(useSettingsStore.getState().collapsedGroupIds)
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedProjectIds, setSelectedProjectIds] = useState<Set<string>>(new Set());
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
    if (!activeSessionProjectId) return;
    setSelectedId(activeSessionProjectId);
    setSelectedProjectIds((prev) => {
      if (prev.size === 1 && prev.has(activeSessionProjectId)) return prev;
      return new Set([activeSessionProjectId]);
    });
  }, [activeSessionProjectId]);

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
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  const [newGroupParentId, setNewGroupParentId] = useState<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

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
    if (compactMode) return;
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
  }, [compactMode, sidebarCollapsed, collapseSidebar, expandSidebar]);

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
      toast.error("项目加载失败", { description });
      logError("Failed to fetch sidebar projects", err);
    } finally {
      setInitialLoading(false);
    }
  }, [fetchAll]);

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
        startupCmd: project.startup_cmd || project.cli_tool || undefined,
        shell: project.shell || undefined,
      }))
    );
  }, []);

  const openProjectInternal = async (project: Project) => {
    const options = buildProjectSplitOptions(project);
    await createSession(options.projectId, options.cwd, options.title, options.startupCmd, options.envVars, options.shell);
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
    },
    [activeSessionId, compactMode, splitTerminal, useExternalTerminal]
  );

  const handleCloneProject = useCallback((project: Project) => {
    setCloningProject(project);
  }, []);

  const handleOpenProjectDirectory = useCallback(async (project: Project) => {
    try {
      await openPath(project.path);
    } catch (err) {
      logError("Failed to open project directory", err);
      toast.error("打开目录失败", { description: String(err) });
    }
  }, []);

  const handleRequestDeleteProject = useCallback((project: Project) => {
    setConfirmAction({ kind: "delete-project", project });
  }, []);

  const handleRequestDeleteGroup = useCallback((groupId: string, groupName: string) => {
    setConfirmAction({ kind: "delete-group", groupId, groupName });
  }, []);

  const handleSelectProject = useCallback((e: ReactMouseEvent, project: Project) => {
    setSelectedId(project.id);
    if (e.ctrlKey || e.metaKey) {
      setSelectedProjectIds((prev) => {
        const next = new Set(prev);
        if (next.has(project.id)) next.delete(project.id);
        else next.add(project.id);
        return next;
      });
      return;
    }
    setSelectedProjectIds(new Set([project.id]));
    activateFirstProjectSession(project.id);
  }, [activateFirstProjectSession]);

  const handleSelectProjectByKeyboard = useCallback((project: Project) => {
    setSelectedId(project.id);
    setSelectedProjectIds(new Set([project.id]));
    activateFirstProjectSession(project.id);
  }, [activateFirstProjectSession]);

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
      await openProjects(projects.filter((p) => p.group_id && groupIds.has(p.group_id)));
    },
    // 依赖只列函数体真正读取的值，避免无关 selector 变化引起整树重建。
    [groups, projects]  // eslint-disable-line react-hooks/exhaustive-deps
  );

  const filteredProjects = useMemo(() => {
    if (!searchQuery) return [];
    const lower = searchQuery.toLowerCase();
    return projects.filter(
      (project) =>
        project.name.toLowerCase().includes(lower) ||
        project.cli_tool.toLowerCase().includes(lower)
    );
  }, [projects, searchQuery]);

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
      onSelectProject: handleSelectProject,
      onSelectProjectByKeyboard: handleSelectProjectByKeyboard,
      onOpenProject: handleOpen,
      onStartGroup: handleStartGroup,
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
      handleSelectProject,
      handleSelectProjectByKeyboard,
      handleOpen,
      handleStartGroup,
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
        title: "确认删除终端？",
        message: `将删除 "${confirmAction.project.name}"。此操作不可撤销。`,
        confirmText: "删除",
        danger: true,
        onConfirm: async () => {
          try {
            await deleteProject(confirmAction.project.id);
            toast.success("终端删除成功");
            setConfirmAction(null);
            if (selectedId === confirmAction.project.id) setSelectedId(null);
            setSelectedProjectIds((prev) => {
              const next = new Set(prev);
              next.delete(confirmAction.project.id);
              return next;
            });
          } catch (err) {
            toast.error("终端删除失败", { description: String(err) });
          }
        },
      };
    }

    return {
      title: "确认删除目录？",
      message: `将删除目录 "${confirmAction.groupName}"。`,
      confirmText: "删除",
      danger: true,
      onConfirm: async () => {
        try {
          await deleteGroup(confirmAction.groupId);
          toast.success("目录删除成功");
          setConfirmAction(null);
        } catch (err) {
          toast.error("目录删除失败", { description: String(err) });
        }
      },
    };
  })();

  const menuX = contextMenu ? Math.min(contextMenu.x, window.innerWidth - 200) : 0;
  const menuY = contextMenu ? Math.min(contextMenu.y, window.innerHeight - 220) : 0;

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

        <SidebarSearch
          collapsed={compactMode ? false : sidebarCollapsed}
          density={sidebarDensity}
          searchQuery={searchQuery}
          selectedCount={selectedProjects.length}
          filteredCount={filteredProjects.length}
          onSearchChange={setSearchQuery}
          onStartFiltered={() => {
            void openProjects(filteredProjects);
          }}
          onStartSelected={() => {
            void openProjects(selectedProjects);
          }}
          onClearSelected={() => setSelectedProjectIds(new Set())}
          onExpandSidebar={expandSidebar}
        />
      </div>

      <div className={`${compactMode ? "min-h-[220px]" : "min-h-0"} flex-1 overflow-hidden`}>
        <TreeContext.Provider value={treeActions}>
          <ProjectTree
            tree={tree}
            initialLoading={initialLoading}
            loadError={loadError}
            collapsed={compactMode ? false : sidebarCollapsed}
            density={sidebarDensity}
            newGroupParentId={newGroupParentId}
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
          />
        </TreeContext.Provider>
      </div>

      <div className="ui-sidebar-footer shrink-0">
        <SidebarFooter
          collapsed={compactMode ? false : sidebarCollapsed}
          onOpenSettings={onOpenSettings}
          onOpenStats={onOpenStats}
        />
      </div>

      {contextMenu && (
        <Portal>
          <div
            className="context-menu"
            style={{ left: menuX, top: menuY }}
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
                  {compactMode ? "打开外部终端" : "打开终端"}
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
                  向右分屏
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
                  向下分屏
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
                  克隆
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
                  {selectedProjectIds.has(contextMenu.project.id) ? "取消选中" : "加入已选"}
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
                  启动已选 ({selectedProjects.length})
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
                  打开所在目录
                </button>
                <button
                  className="context-menu-item"
                  role="menuitem"
                  onClick={() => {
                    setEditingProject(contextMenu.project);
                    setContextMenu(null);
                  }}
                >
                  <Pencil size={14} strokeWidth={1.5} />
                  修改
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
                  删除
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
                  {compactMode ? "打开本目录到外部终端" : "启动本目录"}
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
                  新增子目录
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
                  新增终端
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
                  修改名称
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
                  删除目录
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
