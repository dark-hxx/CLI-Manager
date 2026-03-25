import { useState, useEffect, useRef, useCallback, useMemo, type MouseEvent as ReactMouseEvent } from "react";
import type { DragEndEvent } from "@dnd-kit/core";
import { useProjectStore } from "../../stores/projectStore";
import { useTerminalStore, type SessionStatus } from "../../stores/terminalStore";
import { useSettingsStore } from "../../stores/settingsStore";
import type { Project, TreeNode as TNode, Group } from "../../lib/types";
import { ConfigModal } from "../ConfigModal";
import { ConfirmDialog } from "../ConfirmDialog";
import { SettingsModal } from "../SettingsModal";
import { openWindowsTerminal } from "../../lib/externalTerminal";
import { TreeContext, type TreeActions } from "./TreeContext";
import { Portal } from "../ui/Portal";
import { toast } from "sonner";
import { logError } from "../../lib/logger";
import { SidebarHeader } from "./SidebarHeader";
import { SidebarSearch } from "./SidebarSearch";
import { ProjectTree } from "./ProjectTree";
import { SidebarFooter } from "./SidebarFooter";

interface SidebarProps {
  onOpenStats?: () => void;
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

export function Sidebar({ onOpenStats }: SidebarProps) {
  const {
    tree,
    projects,
    groups,
    searchQuery,
    setSearchQuery,
    fetchAll,
    deleteProject,
    createGroup,
    renameGroup,
    deleteGroup,
    projectHealth,
    reorderItems,
  } = useProjectStore();
  const createSession = useTerminalStore((s) => s.createSession);
  const sessions = useTerminalStore((s) => s.sessions);
  const sessionStatuses = useTerminalStore((s) => s.sessionStatuses);
  const useExternalTerminal = useSettingsStore((s) => s.useExternalTerminal);
  const persistedSidebarWidth = useSettingsStore((s) => s.sidebarWidth);
  const updateSetting = useSettingsStore((s) => s.update);

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
  const [showAdd, setShowAdd] = useState(false);
  const [addToGroupId, setAddToGroupId] = useState<string | null>(null);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedProjectIds, setSelectedProjectIds] = useState<Set<string>>(new Set());
  const [confirmAction, setConfirmAction] = useState<
    | null
    | { kind: "delete-project"; project: Project }
    | { kind: "delete-group"; groupId: string; groupName: string }
  >(null);
  const [contextMenu, setContextMenu] = useState<
    | null
    | { kind: "project"; project: Project; x: number; y: number }
    | { kind: "group"; groupId: string; groupName: string; x: number; y: number }
  >(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  const [newGroupParentId, setNewGroupParentId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (isResizingRef.current) return;
    const normalized = normalizePersistedSidebarWidth(persistedSidebarWidth);
    setSidebarWidth(normalized);
    setSidebarCollapsed(normalized <= SIDEBAR_COLLAPSED_WIDTH);
    liveSidebarWidthRef.current = normalized;
    if (normalized > SIDEBAR_COLLAPSED_WIDTH) {
      lastExpandedWidthRef.current = normalized;
    }
  }, [persistedSidebarWidth]);

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
  }, [sidebarCollapsed, collapseSidebar, expandSidebar]);

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
    (parentId: string | null, event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const findChildren = (pid: string | null): TNode[] => {
        if (pid === null) return tree;
        const findInTree = (nodes: TNode[]): TNode[] | null => {
          for (const node of nodes) {
            if (node.type === "group" && node.group.id === pid) return node.children;
            if (node.type === "group") {
              const found = findInTree(node.children);
              if (found) return found;
            }
          }
          return null;
        };
        return findInTree(tree) ?? [];
      };

      const children = findChildren(parentId);
      const ids = children.map((c) => (c.type === "group" ? c.group.id : c.project.id));
      const oldIndex = ids.indexOf(active.id as string);
      const newIndex = ids.indexOf(over.id as string);
      if (oldIndex === -1 || newIndex === -1) return;

      const reordered = [...ids];
      reordered.splice(oldIndex, 1);
      reordered.splice(newIndex, 0, active.id as string);
      void reorderItems(parentId, reordered);
    },
    [reorderItems, tree]
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

  const getProjectStatus = useCallback(
    (projectId: string): SessionStatus | null => {
      const projectSessions = sessions.filter((s) => s.projectId === projectId);
      if (projectSessions.length === 0) return null;
      for (const s of projectSessions) {
        if ((sessionStatuses[s.id] ?? "running") === "running") return "running";
      }
      for (const s of projectSessions) {
        if (sessionStatuses[s.id] === "error") return "error";
      }
      return "exited";
    },
    [sessionStatuses, sessions]
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

  const openProjectInternal = async (project: Project) => {
    const title = project.cli_tool ? `${project.name} (${project.cli_tool})` : project.name;
    let envVars: Record<string, string> | undefined;
    try {
      const parsed = JSON.parse(project.env_vars);
      if (typeof parsed === "object" && parsed !== null && Object.keys(parsed).length > 0) {
        envVars = parsed;
      }
    } catch {
      // ignore invalid env json
    }

    const cmd = project.startup_cmd || project.cli_tool || undefined;
    const shell = project.shell && project.shell !== "powershell" ? project.shell : undefined;
    await createSession(project.id, project.path, title, cmd, envVars, shell);
  };

  const openProjects = async (items: Project[]) => {
    if (items.length === 0) return;
    if (useExternalTerminal) {
      await openWindowsTerminal(
        items.map((project) => ({
          cwd: project.path,
          title: project.cli_tool ? `${project.name} (${project.cli_tool})` : project.name,
          startupCmd: project.startup_cmd || project.cli_tool || undefined,
          shell: project.shell || undefined,
        }))
      );
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
    [useExternalTerminal, createSession]
  );

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
  }, []);

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
    setSelectedId(project.id);
    setContextMenu({ kind: "project", project, x: e.clientX, y: e.clientY });
  }, []);

  const handleContextMenuGroup = useCallback((e: ReactMouseEvent, groupId: string, groupName: string) => {
    e.preventDefault();
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
    [groups, projects, useExternalTerminal, createSession]
  );

  const filteredProjects = searchQuery
    ? projects.filter(
        (project) =>
          project.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          project.cli_tool.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : [];
  const selectedProjects = projects.filter((p) => selectedProjectIds.has(p.id));

  const treeActions = useMemo<TreeActions>(
    () => ({
      selectedId,
      selectedProjectIds,
      newGroupParentId,
      collapsedIds,
      renamingGroupId,
      onSelectProject: handleSelectProject,
      onOpenProject: handleOpen,
      onEditProject: setEditingProject,
      onDeleteProject: handleRequestDeleteProject,
      onAddSubGroup: (id) => setNewGroupParentId(id),
      onAddProjectToGroup: handleAddProjectToGroup,
      onStartGroup: handleStartGroup,
      onRenameGroup: handleRenameGroup,
      onRenameConfirm: handleRenameConfirm,
      onCancelRename: () => setRenamingGroupId(null),
      onDeleteGroup: handleRequestDeleteGroup,
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
      handleOpen,
      handleRequestDeleteProject,
      handleAddProjectToGroup,
      handleStartGroup,
      handleRenameGroup,
      handleRenameConfirm,
      handleRequestDeleteGroup,
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
      className={`relative flex shrink-0 select-none flex-col border-r border-border bg-bg-secondary ${
        sidebarResizing ? "transition-none" : "transition-[width] duration-150"
      }`}
      style={{ width: sidebarWidth }}
    >
      <SidebarHeader
        collapsed={sidebarCollapsed}
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
        collapsed={sidebarCollapsed}
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

      <TreeContext.Provider value={treeActions}>
        <ProjectTree
          tree={tree}
          initialLoading={initialLoading}
          loadError={loadError}
          collapsed={sidebarCollapsed}
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

      <SidebarFooter
        collapsed={sidebarCollapsed}
        useExternalTerminal={useExternalTerminal}
        onToggleExternalTerminal={() => {
          void updateSetting("useExternalTerminal", !useExternalTerminal);
        }}
        onOpenStats={onOpenStats}
        onOpenSettings={() => setShowSettings(true)}
      />

      {contextMenu && (
        <Portal>
          <div className="context-menu" style={{ left: menuX, top: menuY }} ref={contextMenuRef} role="menu">
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
                  打开终端
                </button>
                <button
                  className="context-menu-item"
                  role="menuitem"
                  onClick={() => {
                    handleToggleSelection(contextMenu.project);
                    setContextMenu(null);
                  }}
                >
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
                  启动已选 ({selectedProjects.length})
                </button>
                <button
                  className="context-menu-item"
                  role="menuitem"
                  onClick={() => {
                    setEditingProject(contextMenu.project);
                    setContextMenu(null);
                  }}
                >
                  修改
                </button>
                <button
                  className="context-menu-item danger"
                  onClick={() => {
                    handleRequestDeleteProject(contextMenu.project);
                    setContextMenu(null);
                  }}
                >
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
                  启动本目录
                </button>
                <button
                  className="context-menu-item"
                  role="menuitem"
                  onClick={() => {
                    ensureSidebarExpanded();
                    setNewGroupParentId(contextMenu.groupId);
                    setContextMenu(null);
                  }}
                >
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
                  修改名称
                </button>
                <button
                  className="context-menu-item danger"
                  onClick={() => {
                    handleRequestDeleteGroup(contextMenu.groupId, contextMenu.groupName);
                    setContextMenu(null);
                  }}
                >
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
      <SettingsModal open={showSettings} onClose={() => setShowSettings(false)} />

      <div
        onMouseDown={startResize}
        className="absolute bottom-0 right-0 top-0 z-10 w-1 cursor-col-resize transition-colors hover:bg-accent"
        style={{ opacity: 0.4 }}
      />
    </aside>
  );
}
