import { useState, useEffect, useRef, useCallback, type MouseEvent as ReactMouseEvent } from "react";
import { useProjectStore } from "../stores/projectStore";
import { useTerminalStore, type SessionStatus } from "../stores/terminalStore";
import { useSettingsStore } from "../stores/settingsStore";
import type { Project, TreeNode as TNode, Group } from "../lib/types";
import { ConfigModal } from "./ConfigModal";
import { ThemeToggle } from "./ThemeToggle";
import { ConfirmDialog } from "./ConfirmDialog";
import { SettingsModal } from "./SettingsModal";
import { openWindowsTerminal } from "../lib/externalTerminal";

const STATUS_COLORS: Record<SessionStatus, string> = {
  running: "#9ece6a",
  exited: "#ff9e64",
  error: "#f7768e",
};

// --- SVG Icons ---

function IconFolder() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 4.5C2 3.67 2.67 3 3.5 3H6l1.5 1.5H12.5C13.33 4.5 14 5.17 14 6V11.5C14 12.33 13.33 13 12.5 13H3.5C2.67 13 2 12.33 2 11.5V4.5Z" />
    </svg>
  );
}

function IconTerminal() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <path d="M5 6.5L7 8L5 9.5" />
      <path d="M8.5 9.5H11" />
    </svg>
  );
}

function IconFolderPlus() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 4.5C2 3.67 2.67 3 3.5 3H6l1.5 1.5H12.5C13.33 4.5 14 5.17 14 6V11.5C14 12.33 13.33 13 12.5 13H3.5C2.67 13 2 12.33 2 11.5V4.5Z" />
      <path d="M8 7.5V10.5M6.5 9H9.5" />
    </svg>
  );
}

function IconEdit() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11.5 1.5L14.5 4.5L5 14H2V11L11.5 1.5Z" />
    </svg>
  );
}

function IconTrash() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 4H13M6 4V3H10V4M5 4V13H11V4" />
    </svg>
  );
}

function IconPlay() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 3L13 8L5 13V3Z" />
    </svg>
  );
}

function IconChevron({ open }: { open: boolean }) {
  return (
    <svg
      width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      style={{ transition: "transform 150ms", transform: open ? "rotate(90deg)" : "rotate(0)" }}
    >
      <path d="M6 4L10 8L6 12" />
    </svg>
  );
}

function IconSearch() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" />
    </svg>
  );
}

function IconPlus() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 3V13M3 8H13" />
    </svg>
  );
}

function IconGear() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="2.5" />
      <path d="M8 1.5V3M8 13V14.5M1.5 8H3M13 8H14.5M3.05 3.05L4.1 4.1M11.9 11.9L12.95 12.95M12.95 3.05L11.9 4.1M4.1 11.9L3.05 12.95" />
    </svg>
  );
}

// --- Inline rename input ---

function InlineRename({
  initial,
  onConfirm,
  onCancel,
}: {
  initial: string;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const submit = () => {
    const trimmed = value.trim();
    if (trimmed) onConfirm(trimmed);
    else onCancel();
  };

  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={submit}
      onKeyDown={(e) => {
        if (e.key === "Enter") submit();
        if (e.key === "Escape") onCancel();
      }}
      className="flex-1 px-1 py-0.5 text-xs rounded border outline-none"
      style={{
        backgroundColor: "var(--bg-tertiary)",
        borderColor: "var(--accent)",
        color: "var(--text-primary)",
      }}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

// --- Recursive tree node ---

function TreeNodeItem({
  node,
  depth,
  selectedId,
  selectedProjectIds,
  onSelectProject,
  onOpenProject,
  onEditProject,
  onDeleteProject,
  onAddSubGroup,
  onAddProjectToGroup,
  onStartGroup,
  onRenameGroup,
  onDeleteGroup,
  onContextMenuProject,
  onContextMenuGroup,
  newGroupParentId,
  onCreateGroup,
  onCancelNewGroup,
  collapsedIds,
  toggleCollapsed,
  getProjectStatus,
}: {
  node: TNode;
  depth: number;
  selectedId: string | null;
  selectedProjectIds: Set<string>;
  onSelectProject: (e: ReactMouseEvent, p: Project) => void;
  onOpenProject: (p: Project) => void;
  onEditProject: (p: Project) => void;
  onDeleteProject: (p: Project) => void;
  onAddSubGroup: (parentId: string) => void;
  onAddProjectToGroup: (groupId: string) => void;
  onStartGroup: (groupId: string) => void;
  onRenameGroup: (id: string, name: string) => void;
  onDeleteGroup: (id: string, name: string) => void;
  onContextMenuProject: (e: ReactMouseEvent, p: Project) => void;
  onContextMenuGroup: (e: ReactMouseEvent, groupId: string, groupName: string) => void;
  newGroupParentId: string | null;
  onCreateGroup: (parentId: string | null, name: string) => void;
  onCancelNewGroup: () => void;
  collapsedIds: Set<string>;
  toggleCollapsed: (id: string) => void;
  getProjectStatus: (projectId: string) => SessionStatus | null;
}) {
  const paddingLeft = 8 + depth * 16;

  if (node.type === "project") {
    const p = node.project;
    const isSelected = selectedId === p.id;
    const isMultiSelected = selectedProjectIds.has(p.id);
    const status = getProjectStatus(p.id);

    return (
      <div
        className="flex items-center gap-2 py-1.5 rounded-md cursor-pointer text-sm group/item transition-colors"
        style={{
          paddingLeft,
          paddingRight: 8,
          backgroundColor: isSelected || isMultiSelected ? "var(--bg-tertiary)" : "transparent",
          color: isSelected || isMultiSelected ? "var(--text-primary)" : "var(--text-secondary)",
        }}
        onMouseEnter={(e) => {
          if (!isSelected && !isMultiSelected) e.currentTarget.style.backgroundColor = "var(--bg-tertiary)";
        }}
        onMouseLeave={(e) => {
          if (!isSelected && !isMultiSelected) e.currentTarget.style.backgroundColor = "transparent";
        }}
        onClick={(e) => onSelectProject(e, p)}
        onDoubleClick={() => onOpenProject(p)}
        onContextMenu={(e) => onContextMenuProject(e, p)}
      >
        <span style={{ color: "var(--accent)", flexShrink: 0 }}>
          {status ? (
            <span
              className="inline-block w-2.5 h-2.5 rounded-full"
              style={{ backgroundColor: STATUS_COLORS[status] }}
              role="status"
              aria-label={`Project ${status}`}
              title={status}
            />
          ) : (
            <IconTerminal />
          )}
        </span>
        <span className="flex-1 min-w-0 flex items-center gap-1">
          <span className="block truncate">{p.name}</span>
          {p.cli_tool && (
            <span
              className="inline-flex text-[9px] leading-tight px-1.5 py-0.5 rounded-full border shrink-0"
              style={{ backgroundColor: "var(--bg-primary)", color: "var(--accent)", borderColor: "var(--border)" }}
            >
              {p.cli_tool}
            </span>
          )}
        </span>
        <span className="hidden group-hover/item:flex items-center gap-0.5 shrink-0">
          <button
            onClick={(e) => { e.stopPropagation(); onOpenProject(p); }}
            className="icon-btn"
            style={{ color: "var(--success)", opacity: 0.7 }}
            title="Open terminal"
          >
            <IconPlay />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onEditProject(p); }}
            className="icon-btn"
            style={{ color: "var(--text-muted)", opacity: 0.7 }}
            title="Edit"
          >
            <IconEdit />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onDeleteProject(p); }}
            className="icon-btn"
            style={{
              color: "var(--danger)",
              opacity: 0.7,
            }}
            title="Delete"
          >
            <IconTrash />
          </button>
        </span>
      </div>
    );
  }

  // Group node
  const g = node.group;
  const isOpen = !collapsedIds.has(g.id);
  const childCount = countDescendants(node);

  return (
    <div>
      <div
        className="flex items-center gap-1.5 py-1.5 rounded-md text-xs font-semibold uppercase tracking-wider cursor-pointer group/grp transition-colors"
        style={{ paddingLeft, paddingRight: 8, color: "var(--text-muted)" }}
        onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "var(--bg-tertiary)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
        onClick={() => toggleCollapsed(g.id)}
        onContextMenu={(e) => onContextMenuGroup(e, g.id, g.name)}
      >
        <IconChevron open={isOpen} />
        <span style={{ color: "var(--accent)", flexShrink: 0 }}>
          <IconFolder />
        </span>
        <span className="flex-1 text-left truncate">{g.name}</span>

        <span
          className="text-[10px] font-normal px-1.5 rounded-full"
          style={{ backgroundColor: "var(--bg-tertiary)", color: "var(--text-muted)" }}
        >
          {childCount}
        </span>

        <span className="hidden group-hover/grp:flex items-center gap-0.5 shrink-0">
          <button
            onClick={(e) => { e.stopPropagation(); onStartGroup(g.id); }}
            className="icon-btn"
            style={{ color: "var(--success)", opacity: 0.7 }}
            title="启动本目录"
          >
            <IconPlay />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onAddSubGroup(g.id); }}
            className="icon-btn"
            style={{ color: "var(--text-muted)", opacity: 0.7 }}
            title="Add sub-group"
          >
            <IconFolderPlus />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onAddProjectToGroup(g.id); }}
            className="icon-btn"
            style={{ color: "var(--success)", opacity: 0.7 }}
            title="Add project"
          >
            <IconPlus />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onRenameGroup(g.id, g.name); }}
            className="icon-btn"
            style={{ color: "var(--text-muted)", opacity: 0.7 }}
            title="Rename"
          >
            <IconEdit />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onDeleteGroup(g.id, g.name); }}
            className="icon-btn"
            style={{
              color: "var(--danger)",
              opacity: 0.7,
            }}
            title="Delete group"
          >
            <IconTrash />
          </button>
        </span>
      </div>

      {newGroupParentId === g.id && (
        <div
          className="flex items-center gap-1.5 py-1.5"
          style={{ paddingLeft: paddingLeft + 16, paddingRight: 8 }}
        >
          <span style={{ color: "var(--accent)", flexShrink: 0 }}>
            <IconFolder />
          </span>
          <InlineRename
            initial=""
            onConfirm={(name) => onCreateGroup(g.id, name)}
            onCancel={onCancelNewGroup}
          />
        </div>
      )}

      {isOpen && node.children.length > 0 && (
        <div className="border-l ml-3" style={{ borderColor: "var(--border)" }}>
          {node.children.map((child) => (
            <TreeNodeItem
              key={child.type === "group" ? `g:${child.group.id}` : `p:${child.project.id}`}
              node={child}
              depth={depth + 1}
              selectedId={selectedId}
              selectedProjectIds={selectedProjectIds}
              onSelectProject={onSelectProject}
              onOpenProject={onOpenProject}
              onEditProject={onEditProject}
              onDeleteProject={onDeleteProject}
              onAddSubGroup={onAddSubGroup}
              onAddProjectToGroup={onAddProjectToGroup}
              onStartGroup={onStartGroup}
              onRenameGroup={onRenameGroup}
              onDeleteGroup={onDeleteGroup}
              onContextMenuProject={onContextMenuProject}
              onContextMenuGroup={onContextMenuGroup}
              newGroupParentId={newGroupParentId}
              onCreateGroup={onCreateGroup}
              onCancelNewGroup={onCancelNewGroup}
              collapsedIds={collapsedIds}
              toggleCollapsed={toggleCollapsed}
              getProjectStatus={getProjectStatus}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function countDescendants(node: TNode): number {
  if (node.type === "project") return 1;
  let count = 0;
  for (const child of node.children) {
    count += child.type === "project" ? 1 : countDescendants(child);
  }
  return count;
}

// --- Main Sidebar ---

export function Sidebar() {
  const { tree, projects, groups, searchQuery, setSearchQuery, fetchAll, deleteProject, createGroup, renameGroup, deleteGroup } = useProjectStore();
  const createSession = useTerminalStore((s) => s.createSession);
  const sessions = useTerminalStore((s) => s.sessions);
  const sessionStatuses = useTerminalStore((s) => s.sessionStatuses);
  const useExternalTerminal = useSettingsStore((s) => s.useExternalTerminal);
  const updateSetting = useSettingsStore((s) => s.update);
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

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

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

  // Derive project status from active terminal sessions
  const getProjectStatus = useCallback((projectId: string): SessionStatus | null => {
    const projectSessions = sessions.filter((s) => s.projectId === projectId);
    if (projectSessions.length === 0) return null;
    for (const s of projectSessions) {
      if ((sessionStatuses[s.id] ?? "running") === "running") return "running";
    }
    for (const s of projectSessions) {
      if (sessionStatuses[s.id] === "error") return "error";
    }
    return "exited";
  }, [sessions, sessionStatuses]);

  const toggleCollapsed = (id: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const openProjectInternal = async (p: Project) => {
    const title = p.cli_tool ? `${p.name} (${p.cli_tool})` : p.name;
    let envVars: Record<string, string> | undefined;
    try {
      const parsed = JSON.parse(p.env_vars);
      if (typeof parsed === "object" && parsed !== null && Object.keys(parsed).length > 0) {
        envVars = parsed;
      }
    } catch { /* ignore */ }
    const cmd = p.startup_cmd || p.cli_tool || undefined;
    await createSession(p.id, p.path, title, cmd, envVars);
  };

  const openProjects = async (items: Project[]) => {
    if (items.length === 0) return;
    if (useExternalTerminal) {
      await openWindowsTerminal(items.map((p) => ({
        cwd: p.path,
        title: p.cli_tool ? `${p.name} (${p.cli_tool})` : p.name,
        startupCmd: p.startup_cmd || p.cli_tool || undefined,
      })));
      return;
    }
    for (const p of items) {
      await openProjectInternal(p);
    }
  };

  const handleOpen = async (p: Project) => {
    await openProjects([p]);
  };

  const handleRequestDeleteProject = (p: Project) => {
    setConfirmAction({ kind: "delete-project", project: p });
  };

  const handleRequestDeleteGroup = (groupId: string, groupName: string) => {
    setConfirmAction({ kind: "delete-group", groupId, groupName });
  };

  const handleSelectProject = (e: ReactMouseEvent, p: Project) => {
    setSelectedId(p.id);
    if (e.ctrlKey || e.metaKey) {
      setSelectedProjectIds((prev) => {
        const next = new Set(prev);
        if (next.has(p.id)) next.delete(p.id);
        else next.add(p.id);
        return next;
      });
      return;
    }
    setSelectedProjectIds(new Set([p.id]));
  };

  const handleClearSelection = () => {
    setSelectedProjectIds(new Set());
  };

  const handleToggleSelection = (p: Project) => {
    setSelectedProjectIds((prev) => {
      const next = new Set(prev);
      if (next.has(p.id)) next.delete(p.id);
      else next.add(p.id);
      return next;
    });
  };

  const handleAddSubGroup = (parentId: string) => {
    setNewGroupParentId(parentId);
  };

  const handleRenameGroup = (id: string, _name: string) => {
    setRenamingGroupId(id);
  };

  const handleRenameConfirm = async (id: string, newName: string) => {
    await renameGroup(id, newName);
    setRenamingGroupId(null);
  };

  const handleAddProjectToGroup = (groupId: string) => {
    setAddToGroupId(groupId);
    setShowAdd(true);
  };

  const handleCreateGroup = (parentId: string | null, name: string) => {
    createGroup({ name, parent_id: parentId });
    setNewGroupParentId(null);
  };

  const handleCancelNewGroup = () => {
    setNewGroupParentId(null);
  };

  const handleContextMenuProject = (e: ReactMouseEvent, p: Project) => {
    e.preventDefault();
    setSelectedId(p.id);
    setContextMenu({ kind: "project", project: p, x: e.clientX, y: e.clientY });
  };

  const handleContextMenuGroup = (e: ReactMouseEvent, groupId: string, groupName: string) => {
    e.preventDefault();
    setContextMenu({ kind: "group", groupId, groupName, x: e.clientX, y: e.clientY });
  };

  const filteredProjects = searchQuery
    ? projects.filter((p) => p.name.toLowerCase().includes(searchQuery.toLowerCase()) || p.cli_tool.toLowerCase().includes(searchQuery.toLowerCase()))
    : [];

  const selectedProjects = projects.filter((p) => selectedProjectIds.has(p.id));

  const handleStartFiltered = async () => {
    await openProjects(filteredProjects);
  };

  const handleStartSelected = async () => {
    await openProjects(selectedProjects);
  };

  const handleStartGroup = async (groupId: string) => {
    const childMap = new Map<string | null, Group[]>();
    for (const g of groups) {
      const key = g.parent_id;
      const arr = childMap.get(key) ?? [];
      arr.push(g);
      childMap.set(key, arr);
    }
    const groupIds = new Set<string>();
    const walk = (id: string) => {
      if (groupIds.has(id)) return;
      groupIds.add(id);
      const children = childMap.get(id) ?? [];
      children.forEach((c) => walk(c.id));
    };
    walk(groupId);
    const groupProjects = projects.filter((p) => p.group_id && groupIds.has(p.group_id));
    await openProjects(groupProjects);
  };

  const confirmDialog = (() => {
    if (!confirmAction) return null;
    if (confirmAction.kind === "delete-project") {
      return {
        title: "确认删除终端？",
        message: `将删除 “${confirmAction.project.name}”。此操作不可撤销。`,
        confirmText: "删除",
        danger: true,
        onConfirm: () => {
          deleteProject(confirmAction.project.id);
          setConfirmAction(null);
          if (selectedId === confirmAction.project.id) setSelectedId(null);
          setSelectedProjectIds((prev) => {
            const next = new Set(prev);
            next.delete(confirmAction.project.id);
            return next;
          });
        },
      };
    }
    return {
      title: "确认删除目录？",
      message: `将删除目录 “${confirmAction.groupName}”。`,
      confirmText: "删除",
      danger: true,
      onConfirm: () => {
        deleteGroup(confirmAction.groupId);
        setConfirmAction(null);
      },
    };
  })();

  const menuX = contextMenu ? Math.min(contextMenu.x, window.innerWidth - 200) : 0;
  const menuY = contextMenu ? Math.min(contextMenu.y, window.innerHeight - 220) : 0;

  return (
    <aside
      className="w-[280px] flex-shrink-0 flex flex-col border-r select-none"
      style={{ backgroundColor: "var(--bg-secondary)", borderColor: "var(--border)" }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 pt-3 pb-1">
        <span className="text-xs font-bold uppercase tracking-widest" style={{ color: "var(--text-muted)" }}>
          Projects
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => { setNewGroupParentId(null); setNewGroupParentId("__root__"); }}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded-md hover:opacity-90 transition-opacity"
            style={{ color: "var(--text-muted)", backgroundColor: "var(--bg-tertiary)" }}
            title="New Group"
          >
            <IconFolderPlus />
          </button>
          <button
            onClick={() => { setAddToGroupId(null); setShowAdd(true); }}
            className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-md hover:opacity-90 transition-opacity"
            style={{ backgroundColor: "var(--accent)", color: "#fff" }}
          >
            + New
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="px-3 py-2">
        <div
          className="flex items-center gap-2 px-2.5 py-1.5 rounded-md border"
          style={{ backgroundColor: "var(--bg-tertiary)", borderColor: "var(--border)" }}
        >
          <span style={{ color: "var(--text-muted)" }}><IconSearch /></span>
          <input
            type="text"
            placeholder="Search..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="flex-1 bg-transparent text-sm outline-none"
            style={{ color: "var(--text-primary)" }}
          />
        </div>
        <div className="flex items-center gap-2 mt-2">
          <button
            onClick={handleStartFiltered}
            disabled={filteredProjects.length === 0}
            className="mini-btn"
            title="启动筛选结果"
          >
            启动筛选
          </button>
          <button
            onClick={handleStartSelected}
            disabled={selectedProjects.length === 0}
            className="mini-btn"
            title="启动已选"
          >
            启动已选 ({selectedProjects.length})
          </button>
          {selectedProjects.length > 0 && (
            <button
              onClick={handleClearSelection}
              className="mini-btn"
              title="清空已选"
            >
              清空
            </button>
          )}
        </div>
      </div>

      {/* Tree */}
      <div className="flex-1 overflow-y-auto px-1.5 pb-2">
        {newGroupParentId === "__root__" && (
          <div className="flex items-center gap-1.5 px-2 py-1.5">
            <span style={{ color: "var(--accent)", flexShrink: 0 }}>
              <IconFolder />
            </span>
            <InlineRename
              initial=""
              onConfirm={(name) => handleCreateGroup(null, name)}
              onCancel={handleCancelNewGroup}
            />
          </div>
        )}

        {tree.map((node) => {
          // Intercept rename for groups
          if (node.type === "group" && renamingGroupId === node.group.id) {
            return (
              <div key={`g:${node.group.id}`} className="flex items-center gap-1.5 px-2 py-1.5">
                <IconChevron open={true} />
                <InlineRename
                  initial={node.group.name}
                  onConfirm={(name) => handleRenameConfirm(node.group.id, name)}
                  onCancel={() => setRenamingGroupId(null)}
                />
              </div>
            );
          }

          return (
            <TreeNodeItem
              key={node.type === "group" ? `g:${node.group.id}` : `p:${node.project.id}`}
              node={node}
              depth={0}
              selectedId={selectedId}
              selectedProjectIds={selectedProjectIds}
              onSelectProject={handleSelectProject}
              onOpenProject={handleOpen}
              onEditProject={setEditingProject}
              onDeleteProject={handleRequestDeleteProject}
              onAddSubGroup={handleAddSubGroup}
              onAddProjectToGroup={handleAddProjectToGroup}
              onStartGroup={handleStartGroup}
              onRenameGroup={handleRenameGroup}
              onDeleteGroup={handleRequestDeleteGroup}
              onContextMenuProject={handleContextMenuProject}
              onContextMenuGroup={handleContextMenuGroup}
              newGroupParentId={newGroupParentId}
              onCreateGroup={handleCreateGroup}
              onCancelNewGroup={handleCancelNewGroup}
              collapsedIds={collapsedIds}
              toggleCollapsed={toggleCollapsed}
              getProjectStatus={getProjectStatus}
            />
          );
        })}

        {tree.length === 0 && (
          <div className="flex flex-col items-center py-8 gap-2" style={{ color: "var(--text-muted)" }}>
            <IconFolder />
            <p className="text-xs">No projects found</p>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-3 py-2 border-t" style={{ borderColor: "var(--border)" }}>
        <div className="flex items-center justify-between">
          <ThemeToggle />
          <button
            onClick={() => setShowSettings(true)}
            className="flex items-center justify-center w-7 h-7 rounded-md hover:opacity-80 transition-opacity"
            style={{ color: "var(--text-muted)", backgroundColor: "var(--bg-tertiary)" }}
            title="设置"
          >
            <IconGear />
          </button>
        </div>
        <div className="flex items-center justify-between mt-3">
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>外部 PowerShell</span>
          <button
            className="switch"
            data-on={useExternalTerminal ? "true" : "false"}
            onClick={() => updateSetting("useExternalTerminal", !useExternalTerminal)}
            title="使用 Windows Terminal 打开"
          >
            <span className="switch-thumb" />
          </button>
        </div>
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          className="context-menu"
          style={{ left: menuX, top: menuY }}
          ref={contextMenuRef}
        >
          {contextMenu.kind === "project" && (
            <>
              <button
                className="context-menu-item"
                onClick={() => { handleOpen(contextMenu.project); setContextMenu(null); }}
              >
                打开终端
              </button>
              <button
                className="context-menu-item"
                onClick={() => { handleToggleSelection(contextMenu.project); setContextMenu(null); }}
              >
                {selectedProjectIds.has(contextMenu.project.id) ? "取消选中" : "加入已选"}
              </button>
              <button
                className="context-menu-item"
                onClick={() => { handleStartSelected(); setContextMenu(null); }}
                disabled={selectedProjects.length === 0}
              >
                启动已选 ({selectedProjects.length})
              </button>
              <button
                className="context-menu-item"
                onClick={() => { setEditingProject(contextMenu.project); setContextMenu(null); }}
              >
                修改
              </button>
              <button
                className="context-menu-item danger"
                onClick={() => { handleRequestDeleteProject(contextMenu.project); setContextMenu(null); }}
              >
                删除
              </button>
            </>
          )}
          {contextMenu.kind === "group" && (
            <>
              <button
                className="context-menu-item"
                onClick={() => { handleStartGroup(contextMenu.groupId); setContextMenu(null); }}
              >
                启动本目录
              </button>
              <button
                className="context-menu-item"
                onClick={() => { handleAddSubGroup(contextMenu.groupId); setContextMenu(null); }}
              >
                新增子目录
              </button>
              <button
                className="context-menu-item"
                onClick={() => { handleAddProjectToGroup(contextMenu.groupId); setContextMenu(null); }}
              >
                新增终端
              </button>
              <button
                className="context-menu-item"
                onClick={() => { handleRenameGroup(contextMenu.groupId, contextMenu.groupName); setContextMenu(null); }}
              >
                修改名称
              </button>
              <button
                className="context-menu-item danger"
                onClick={() => { handleRequestDeleteGroup(contextMenu.groupId, contextMenu.groupName); setContextMenu(null); }}
              >
                删除目录
              </button>
            </>
          )}
        </div>
      )}

      {/* Modals */}
      {showAdd && (
        <ConfigModal
          defaultGroupId={addToGroupId}
          onClose={() => { setShowAdd(false); setAddToGroupId(null); }}
        />
      )}
      {editingProject && (
        <ConfigModal project={editingProject} onClose={() => setEditingProject(null)} />
      )}
      {confirmDialog && (
        <ConfirmDialog
          open={!!confirmDialog}
          title={confirmDialog.title}
          message={confirmDialog.message}
          confirmText={confirmDialog.confirmText}
          danger={confirmDialog.danger}
          onConfirm={confirmDialog.onConfirm}
          onClose={() => setConfirmAction(null)}
        />
      )}
      <SettingsModal open={showSettings} onClose={() => setShowSettings(false)} />
    </aside>
  );
}
