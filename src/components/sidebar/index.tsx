import { useState, useEffect, useRef, useCallback, useMemo, type MouseEvent as ReactMouseEvent } from "react";
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { useProjectStore } from "../../stores/projectStore";
import { useTerminalStore, type SessionStatus } from "../../stores/terminalStore";
import { useSettingsStore } from "../../stores/settingsStore";
import type { Project, TreeNode as TNode, Group } from "../../lib/types";
import { ConfigModal } from "../ConfigModal";
import { ThemeToggle } from "../ThemeToggle";
import { ConfirmDialog } from "../ConfirmDialog";
import { SettingsModal } from "../SettingsModal";
import { openWindowsTerminal } from "../../lib/externalTerminal";
import { TreeContext, type TreeActions } from "./TreeContext";
import { TreeNodeItem } from "./TreeNodeItem";
import { SidebarSkeleton } from "../ui/Skeleton";
import { Folder, FolderPlus, Search, Plus, Settings, Terminal } from "lucide-react";

export function Sidebar() {
  const { tree, projects, groups, searchQuery, setSearchQuery, fetchAll, deleteProject, createGroup, renameGroup, deleteGroup, projectHealth, reorderItems } = useProjectStore();
  const createSession = useTerminalStore((s) => s.createSession);
  const sessions = useTerminalStore((s) => s.sessions);
  const sessionStatuses = useTerminalStore((s) => s.sessionStatuses);
  const useExternalTerminal = useSettingsStore((s) => s.useExternalTerminal);
  const sidebarWidth = useSettingsStore((s) => s.sidebarWidth);
  const updateSetting = useSettingsStore((s) => s.update);
  const isResizing = useRef(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [addToGroupId, setAddToGroupId] = useState<string | null>(null);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedProjectIds, setSelectedProjectIds] = useState<Set<string>>(new Set());
  const [confirmAction, setConfirmAction] = useState<null | { kind: "delete-project"; project: Project } | { kind: "delete-group"; groupId: string; groupName: string }>(null);
  const [contextMenu, setContextMenu] = useState<null | { kind: "project"; project: Project; x: number; y: number } | { kind: "group"; groupId: string; groupName: string; x: number; y: number }>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  const [newGroupParentId, setNewGroupParentId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const startResize = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    const onMove = (ev: MouseEvent) => {
      if (!isResizing.current) return;
      const newWidth = Math.max(180, Math.min(500, ev.clientX));
      updateSetting("sidebarWidth", newWidth);
    };
    const onUp = () => {
      isResizing.current = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [updateSetting]);

  const handleDragEnd = useCallback((parentId: string | null, event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const findChildren = (pid: string | null): TNode[] => {
      if (pid === null) return tree;
      const findInTree = (nodes: TNode[]): TNode[] | null => {
        for (const n of nodes) {
          if (n.type === "group" && n.group.id === pid) return n.children;
          if (n.type === "group") { const found = findInTree(n.children); if (found) return found; }
        }
        return null;
      };
      return findInTree(tree) ?? [];
    };
    const children = findChildren(parentId);
    const ids = children.map((c) => c.type === "group" ? c.group.id : c.project.id);
    const oldIndex = ids.indexOf(active.id as string);
    const newIndex = ids.indexOf(over.id as string);
    if (oldIndex === -1 || newIndex === -1) return;
    const reordered = [...ids];
    reordered.splice(oldIndex, 1);
    reordered.splice(newIndex, 0, active.id as string);
    reorderItems(parentId, reordered);
  }, [tree, reorderItems]);

  useEffect(() => { fetchAll().then(() => setInitialLoading(false)); }, [fetchAll]);

  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e: Event) => { if (contextMenuRef.current && contextMenuRef.current.contains(e.target as Node)) return; setContextMenu(null); };
    const keyHandler = (e: KeyboardEvent) => { if (e.key === "Escape") setContextMenu(null); };
    document.addEventListener("mousedown", handler);
    document.addEventListener("scroll", handler, true);
    window.addEventListener("resize", handler);
    window.addEventListener("keydown", keyHandler);
    return () => { document.removeEventListener("mousedown", handler); document.removeEventListener("scroll", handler, true); window.removeEventListener("resize", handler); window.removeEventListener("keydown", keyHandler); };
  }, [contextMenu]);

  const getProjectStatus = useCallback((projectId: string): SessionStatus | null => {
    const projectSessions = sessions.filter((s) => s.projectId === projectId);
    if (projectSessions.length === 0) return null;
    for (const s of projectSessions) { if ((sessionStatuses[s.id] ?? "running") === "running") return "running"; }
    for (const s of projectSessions) { if (sessionStatuses[s.id] === "error") return "error"; }
    return "exited";
  }, [sessions, sessionStatuses]);

  const isPathInvalid = useCallback((projectId: string): boolean => projectHealth[projectId] === false, [projectHealth]);
  const toggleCollapsed = useCallback((id: string) => { setCollapsedIds((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; }); }, []);

  const openProjectInternal = async (p: Project) => {
    const title = p.cli_tool ? `${p.name} (${p.cli_tool})` : p.name;
    let envVars: Record<string, string> | undefined;
    try { const parsed = JSON.parse(p.env_vars); if (typeof parsed === "object" && parsed !== null && Object.keys(parsed).length > 0) envVars = parsed; } catch { /* ignore */ }
    const cmd = p.startup_cmd || p.cli_tool || undefined;
    const shell = p.shell && p.shell !== "powershell" ? p.shell : undefined;
    await createSession(p.id, p.path, title, cmd, envVars, shell);
  };

  const openProjects = async (items: Project[]) => {
    if (items.length === 0) return;
    if (useExternalTerminal) {
      await openWindowsTerminal(items.map((p) => ({ cwd: p.path, title: p.cli_tool ? `${p.name} (${p.cli_tool})` : p.name, startupCmd: p.startup_cmd || p.cli_tool || undefined, shell: p.shell || undefined })));
      return;
    }
    for (const p of items) await openProjectInternal(p);
  };

  const handleOpen = useCallback(async (p: Project) => { await openProjects([p]); }, [useExternalTerminal, createSession]);
  const handleRequestDeleteProject = useCallback((p: Project) => { setConfirmAction({ kind: "delete-project", project: p }); }, []);
  const handleRequestDeleteGroup = useCallback((groupId: string, groupName: string) => { setConfirmAction({ kind: "delete-group", groupId, groupName }); }, []);
  const handleSelectProject = useCallback((e: ReactMouseEvent, p: Project) => {
    setSelectedId(p.id);
    if (e.ctrlKey || e.metaKey) { setSelectedProjectIds((prev) => { const next = new Set(prev); if (next.has(p.id)) next.delete(p.id); else next.add(p.id); return next; }); return; }
    setSelectedProjectIds(new Set([p.id]));
  }, []);
  const handleToggleSelection = (p: Project) => { setSelectedProjectIds((prev) => { const next = new Set(prev); if (next.has(p.id)) next.delete(p.id); else next.add(p.id); return next; }); };
  const handleRenameGroup = useCallback((id: string, _name: string) => { setRenamingGroupId(id); }, []);
  const handleRenameConfirm = useCallback(async (id: string, newName: string) => { await renameGroup(id, newName); setRenamingGroupId(null); }, [renameGroup]);
  const handleCreateGroup = useCallback((parentId: string | null, name: string) => { createGroup({ name, parent_id: parentId }); setNewGroupParentId(null); }, [createGroup]);
  const handleCancelNewGroup = useCallback(() => { setNewGroupParentId(null); }, []);
  const handleAddProjectToGroup = useCallback((groupId: string) => { setAddToGroupId(groupId); setShowAdd(true); }, []);
  const handleContextMenuProject = useCallback((e: ReactMouseEvent, p: Project) => { e.preventDefault(); setSelectedId(p.id); setContextMenu({ kind: "project", project: p, x: e.clientX, y: e.clientY }); }, []);
  const handleContextMenuGroup = useCallback((e: ReactMouseEvent, groupId: string, groupName: string) => { e.preventDefault(); setContextMenu({ kind: "group", groupId, groupName, x: e.clientX, y: e.clientY }); }, []);

  const handleStartGroup = useCallback(async (groupId: string) => {
    const childMap = new Map<string | null, Group[]>();
    for (const g of groups) { const arr = childMap.get(g.parent_id) ?? []; arr.push(g); childMap.set(g.parent_id, arr); }
    const groupIds = new Set<string>();
    const walk = (id: string) => { if (groupIds.has(id)) return; groupIds.add(id); (childMap.get(id) ?? []).forEach((c) => walk(c.id)); };
    walk(groupId);
    await openProjects(projects.filter((p) => p.group_id && groupIds.has(p.group_id)));
  }, [groups, projects, useExternalTerminal, createSession]);

  const filteredProjects = searchQuery ? projects.filter((p) => p.name.toLowerCase().includes(searchQuery.toLowerCase()) || p.cli_tool.toLowerCase().includes(searchQuery.toLowerCase())) : [];
  const selectedProjects = projects.filter((p) => selectedProjectIds.has(p.id));

  const treeActions = useMemo<TreeActions>(() => ({
    selectedId, selectedProjectIds, newGroupParentId, collapsedIds, renamingGroupId,
    onSelectProject: handleSelectProject, onOpenProject: handleOpen, onEditProject: setEditingProject,
    onDeleteProject: handleRequestDeleteProject, onAddSubGroup: (id) => setNewGroupParentId(id),
    onAddProjectToGroup: handleAddProjectToGroup, onStartGroup: handleStartGroup,
    onRenameGroup: handleRenameGroup, onRenameConfirm: handleRenameConfirm, onCancelRename: () => setRenamingGroupId(null),
    onDeleteGroup: handleRequestDeleteGroup, onContextMenuProject: handleContextMenuProject,
    onContextMenuGroup: handleContextMenuGroup, onCreateGroup: handleCreateGroup,
    onCancelNewGroup: handleCancelNewGroup, toggleCollapsed, getProjectStatus, isPathInvalid, onDragEnd: handleDragEnd,
  }), [selectedId, selectedProjectIds, newGroupParentId, collapsedIds, renamingGroupId, handleSelectProject, handleOpen, handleRequestDeleteProject, handleAddProjectToGroup, handleStartGroup, handleRenameGroup, handleRenameConfirm, handleRequestDeleteGroup, handleContextMenuProject, handleContextMenuGroup, handleCreateGroup, handleCancelNewGroup, toggleCollapsed, getProjectStatus, isPathInvalid, handleDragEnd]);

  const confirmDialog = (() => {
    if (!confirmAction) return null;
    if (confirmAction.kind === "delete-project") {
      return { title: "确认删除终端？", message: `将删除 "${confirmAction.project.name}"。此操作不可撤销。`, confirmText: "删除", danger: true, onConfirm: () => { deleteProject(confirmAction.project.id); setConfirmAction(null); if (selectedId === confirmAction.project.id) setSelectedId(null); setSelectedProjectIds((prev) => { const next = new Set(prev); next.delete(confirmAction.project.id); return next; }); } };
    }
    return { title: "确认删除目录？", message: `将删除目录 "${confirmAction.groupName}"。`, confirmText: "删除", danger: true, onConfirm: () => { deleteGroup(confirmAction.groupId); setConfirmAction(null); } };
  })();

  const menuX = contextMenu ? Math.min(contextMenu.x, window.innerWidth - 200) : 0;
  const menuY = contextMenu ? Math.min(contextMenu.y, window.innerHeight - 220) : 0;

  return (
    <aside className="flex-shrink-0 flex flex-col border-r select-none relative" style={{ width: sidebarWidth, backgroundColor: "var(--bg-secondary)", borderColor: "var(--border)" }}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 pt-3 pb-1">
        <span className="text-xs font-bold uppercase tracking-widest" style={{ color: "var(--text-muted)" }}>Projects</span>
        <div className="flex items-center gap-1">
          <button onClick={() => setNewGroupParentId("__root__")} className="flex items-center gap-1 text-xs px-2 py-1 rounded-md hover:opacity-90 transition-opacity" style={{ color: "var(--text-muted)", backgroundColor: "var(--bg-tertiary)" }} title="New Group"><FolderPlus size={14} strokeWidth={1.5} /></button>
          <button onClick={() => { setAddToGroupId(null); setShowAdd(true); }} className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-md hover:opacity-90 transition-opacity" style={{ backgroundColor: "var(--accent)", color: "#fff" }}>+ New</button>
        </div>
      </div>

      {/* Search */}
      <div className="px-3 py-2">
        <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-md border" style={{ backgroundColor: "var(--bg-tertiary)", borderColor: "var(--border)" }}>
          <span style={{ color: "var(--text-muted)" }}><Search size={14} strokeWidth={1.5} /></span>
          <input type="text" placeholder="Search..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="flex-1 bg-transparent text-sm outline-none" style={{ color: "var(--text-primary)" }} />
        </div>
        <div className="flex items-center gap-2 mt-2">
          <button onClick={() => openProjects(filteredProjects)} disabled={filteredProjects.length === 0} className="mini-btn" title="启动筛选结果">启动筛选</button>
          <button onClick={() => openProjects(selectedProjects)} disabled={selectedProjects.length === 0} className="mini-btn" title="启动已选">启动已选 ({selectedProjects.length})</button>
          {selectedProjects.length > 0 && <button onClick={() => setSelectedProjectIds(new Set())} className="mini-btn" title="清空已选">清空</button>}
        </div>
      </div>

      {/* Tree */}
      <TreeContext.Provider value={treeActions}>
        <div className="flex-1 overflow-y-auto px-1.5 pb-2">
          {initialLoading ? <SidebarSkeleton /> : <>
          {newGroupParentId === "__root__" && (
            <div className="flex items-center gap-1.5 px-2 py-1.5">
              <span style={{ color: "var(--accent)", flexShrink: 0 }}><Folder size={16} strokeWidth={1.5} /></span>
              <input ref={(ref) => { ref?.focus(); }} className="flex-1 px-1 py-0.5 text-xs rounded border outline-none" style={{ backgroundColor: "var(--bg-tertiary)", borderColor: "var(--accent)", color: "var(--text-primary)" }} onBlur={(e) => { const v = e.currentTarget.value.trim(); if (v) handleCreateGroup(null, v); else handleCancelNewGroup(); }} onKeyDown={(e) => { if (e.key === "Enter") { const v = e.currentTarget.value.trim(); if (v) handleCreateGroup(null, v); else handleCancelNewGroup(); } if (e.key === "Escape") handleCancelNewGroup(); }} onClick={(e) => e.stopPropagation()} />
            </div>
          )}

          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(event) => handleDragEnd(null, event)}>
            <SortableContext items={tree.map((n) => n.type === "group" ? n.group.id : n.project.id)} strategy={verticalListSortingStrategy}>
              {tree.map((node) => (
                <TreeNodeItem key={node.type === "group" ? `g:${node.group.id}` : `p:${node.project.id}`} node={node} depth={0} />
              ))}
            </SortableContext>
          </DndContext>

          {tree.length === 0 && (
            <div className="flex flex-col items-center py-10 px-4 gap-3" style={{ color: "var(--text-muted)" }}>
              <Terminal size={40} strokeWidth={1} style={{ opacity: 0.4 }} />
              <p className="text-sm font-medium" style={{ color: "var(--text-secondary)" }}>欢迎使用 CLI-Manager</p>
              <p className="text-xs text-center leading-relaxed">集中管理你的开发项目终端。添加项目后即可快速启动 CLI 工具。</p>
              <button onClick={() => { setAddToGroupId(null); setShowAdd(true); }} className="mt-2 flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md" style={{ backgroundColor: "var(--accent)", color: "#fff" }}>
                <Plus size={12} strokeWidth={2} /> 快速添加项目
              </button>
              <div className="mt-3 text-[11px] text-left w-full space-y-1.5" style={{ color: "var(--text-muted)" }}>
                <p>提示：</p>
                <p>- 双击项目打开终端</p>
                <p>- Ctrl+Click 多选后批量启动</p>
                <p>- 右键项目可查看更多操作</p>
              </div>
            </div>
          )}
          </>}
        </div>
      </TreeContext.Provider>

      {/* Footer */}
      <div className="px-3 py-2 border-t" style={{ borderColor: "var(--border)" }}>
        <div className="flex items-center justify-between">
          <ThemeToggle />
          <button onClick={() => setShowSettings(true)} className="flex items-center justify-center w-7 h-7 rounded-md hover:opacity-80 transition-opacity" style={{ color: "var(--text-muted)", backgroundColor: "var(--bg-tertiary)" }} title="设置"><Settings size={14} strokeWidth={1.5} /></button>
        </div>
        <div className="flex items-center justify-between mt-3">
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>外部终端</span>
          <button className="switch" data-on={useExternalTerminal ? "true" : "false"} onClick={() => updateSetting("useExternalTerminal", !useExternalTerminal)} title="使用 Windows Terminal 打开"><span className="switch-thumb" /></button>
        </div>
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div className="context-menu" style={{ left: menuX, top: menuY }} ref={contextMenuRef} role="menu">
          {contextMenu.kind === "project" && (
            <>
              <button className="context-menu-item" role="menuitem" onClick={() => { handleOpen(contextMenu.project); setContextMenu(null); }}>打开终端</button>
              <button className="context-menu-item" role="menuitem" onClick={() => { handleToggleSelection(contextMenu.project); setContextMenu(null); }}>{selectedProjectIds.has(contextMenu.project.id) ? "取消选中" : "加入已选"}</button>
              <button className="context-menu-item" role="menuitem" onClick={() => { openProjects(selectedProjects); setContextMenu(null); }} disabled={selectedProjects.length === 0}>启动已选 ({selectedProjects.length})</button>
              <button className="context-menu-item" role="menuitem" onClick={() => { setEditingProject(contextMenu.project); setContextMenu(null); }}>修改</button>
              <button className="context-menu-item danger" onClick={() => { handleRequestDeleteProject(contextMenu.project); setContextMenu(null); }}>删除</button>
            </>
          )}
          {contextMenu.kind === "group" && (
            <>
              <button className="context-menu-item" role="menuitem" onClick={() => { handleStartGroup(contextMenu.groupId); setContextMenu(null); }}>启动本目录</button>
              <button className="context-menu-item" role="menuitem" onClick={() => { setNewGroupParentId(contextMenu.groupId); setContextMenu(null); }}>新增子目录</button>
              <button className="context-menu-item" role="menuitem" onClick={() => { handleAddProjectToGroup(contextMenu.groupId); setContextMenu(null); }}>新增终端</button>
              <button className="context-menu-item" role="menuitem" onClick={() => { handleRenameGroup(contextMenu.groupId, contextMenu.groupName); setContextMenu(null); }}>修改名称</button>
              <button className="context-menu-item danger" onClick={() => { handleRequestDeleteGroup(contextMenu.groupId, contextMenu.groupName); setContextMenu(null); }}>删除目录</button>
            </>
          )}
        </div>
      )}

      {/* Modals */}
      {showAdd && <ConfigModal defaultGroupId={addToGroupId} onClose={() => { setShowAdd(false); setAddToGroupId(null); }} />}
      {editingProject && <ConfigModal project={editingProject} onClose={() => setEditingProject(null)} />}
      {confirmDialog && <ConfirmDialog open={!!confirmDialog} title={confirmDialog.title} message={confirmDialog.message} confirmText={confirmDialog.confirmText} danger={confirmDialog.danger} onConfirm={confirmDialog.onConfirm} onClose={() => setConfirmAction(null)} />}
      <SettingsModal open={showSettings} onClose={() => setShowSettings(false)} />

      {/* Resize handle */}
      <div
        onMouseDown={startResize}
        className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize z-10 hover:bg-[var(--accent)] transition-colors"
        style={{ opacity: 0.4 }}
      />
    </aside>
  );
}
