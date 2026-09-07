import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import ClaudeColor from "@lobehub/icons/es/Claude/components/Color";
import OpenAI from "@lobehub/icons/es/OpenAI/components/Mono";
import {
  ChevronRight,
  CircleStop,
  ExternalLink,
  Files,
  Folder,
  FolderOpen,
  FolderPlus,
  History,
  Pencil,
  Play,
  Settings,
  SquareSplitHorizontal,
  SquareSplitVertical,
  Terminal,
  Trash2,
  UserPlus,
} from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode, type SVGProps } from "react";
import type { JsonObject, Operation, ProjectContext, WorkspaceGroup, WorkspaceProject, WorkspaceSnapshot, WorkspaceWorktree } from "./domain";
import type { TranslationKey } from "./i18n";

type T = (key: TranslationKey) => string;
type TreeNode =
  | { type: "group"; group: WorkspaceGroup; children: TreeNode[] }
  | { type: "project"; project: WorkspaceProject };

type Props = {
  t: T;
  workspace: WorkspaceSnapshot | null;
  projectContexts: ProjectContext[];
  selectedProjectContext?: ProjectContext;
  dragEnabled: boolean;
  managementEnabled: boolean;
  onSelectProjectContext: (key: string) => void;
  onSubmit: (kind: string, payload: JsonObject) => Promise<Operation>;
  onReload: () => void;
};

type ContextMenuState = {
  kind: "project" | "group" | "worktree";
  id: string;
  x: number;
  y: number;
};

type MenuEntry =
  | { kind: "separator"; key: string }
  | { kind: "item"; key: string; label: string; icon: ReactNode; danger?: boolean; disabled?: boolean; onClick: () => void };

const DND_TRANSITION = { duration: 100, easing: "cubic-bezier(0.2, 0, 0, 1)" };

function nodeId(node: TreeNode): string {
  return node.type === "group" ? node.group.id : node.project.id;
}

function buildTree(workspace: WorkspaceSnapshot): TreeNode[] {
  const groupIds = new Set(workspace.groups.map((group) => group.id));
  const groupsByParent = new Map<string | null, WorkspaceGroup[]>();
  const projectsByGroup = new Map<string | null, WorkspaceProject[]>();
  for (const group of workspace.groups) {
    const parentId = group.parentId && groupIds.has(group.parentId) ? group.parentId : null;
    groupsByParent.set(parentId, [...(groupsByParent.get(parentId) ?? []), group]);
  }
  for (const project of workspace.projects) {
    const groupId = project.groupId && groupIds.has(project.groupId) ? project.groupId : null;
    projectsByGroup.set(groupId, [...(projectsByGroup.get(groupId) ?? []), project]);
  }
  const buildLevel = (parentId: string | null, ancestors: Set<string>): TreeNode[] => {
    const groups = (groupsByParent.get(parentId) ?? []).flatMap((group): TreeNode[] => {
      if (ancestors.has(group.id)) return [];
      return [{ type: "group", group, children: buildLevel(group.id, new Set(ancestors).add(group.id)) }];
    });
    const projects = (projectsByGroup.get(parentId) ?? []).map((project): TreeNode => ({ type: "project", project }));
    return [...groups, ...projects].sort((left, right) => {
      const a = left.type === "group" ? left.group : left.project;
      const b = right.type === "group" ? right.group : right.project;
      return a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);
    });
  };
  return buildLevel(null, new Set());
}

function findLevel(nodes: TreeNode[], targetId: string, parentId: string | null = null): { parentId: string | null; nodes: TreeNode[] } | null {
  if (nodes.some((node) => nodeId(node) === targetId)) return { parentId, nodes };
  for (const node of nodes) {
    if (node.type !== "group") continue;
    const found = findLevel(node.children, targetId, node.group.id);
    if (found) return found;
  }
  return null;
}

const collisionDetection: CollisionDetection = (args) => {
  const collisions = closestCenter(args).filter((collision) => collision.id !== args.active.id);
  if (collisions.length === 0) return [];
  const pointer = args.pointerCoordinates;
  if (pointer) {
    const containingGroup = collisions.find((collision) => {
      if (typeof collision.id !== "string" || !collision.id.startsWith("into:")) return false;
      const rect = collision.data?.droppableContainer?.rect?.current;
      return Boolean(rect && pointer.x >= rect.left && pointer.x <= rect.right && pointer.y >= rect.top && pointer.y <= rect.bottom);
    });
    if (containingGroup) return [containingGroup];
  }
  const sibling = collisions.find((collision) => typeof collision.id !== "string" || !collision.id.startsWith("into:"));
  if (sibling && pointer) {
    const rect = sibling.data?.droppableContainer?.rect?.current;
    if (rect) {
      const ratio = (pointer.y - rect.top) / Math.max(1, rect.height);
      const intoId = `into:${String(sibling.id)}`;
      if (ratio >= 0.3 && ratio <= 0.7) {
        const into = collisions.find((collision) => collision.id === intoId);
        if (into) return [into];
      }
      return [sibling];
    }
  }
  return [collisions.find((collision) => typeof collision.id === "string" && collision.id.startsWith("into:")) ?? collisions[0]!];
};

function WorktreeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path d="M6.5 5.5v5.25A4.75 4.75 0 0 0 11.25 15.5H17M6.5 10.5h5.25A4.75 4.75 0 0 0 16.5 5.75V5.5M14.75 13.25 17 15.5l-2.25 2.25" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="6.5" cy="5.5" r="2" fill="var(--surface-raised)" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="16.5" cy="5.5" r="2" fill="var(--surface-raised)" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="17" cy="15.5" r="2" fill="var(--surface-raised)" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function ProjectIcon({ source }: { source: WorkspaceProject["source"] }) {
  if (source === "claude") return <ClaudeColor size={15} />;
  if (source === "codex") return <OpenAI size={15} />;
  return <Terminal size={15} strokeWidth={1.5} />;
}

type ItemProps = {
  node: TreeNode;
  depth: number;
  collapsed: Set<string>;
  contexts: ProjectContext[];
  worktrees: WorkspaceWorktree[];
  selected?: ProjectContext;
  selectedProjectIds: Set<string>;
  dragEnabled: boolean;
  managementEnabled: boolean;
  t: T;
  onToggle: (id: string) => void;
  onSelect: (key: string) => void;
  onQuickStart: (targetType: "project" | "group" | "worktree", targetId: string) => void;
  onContextMenu: (event: MouseEvent, target: { kind: "project" | "group" | "worktree"; id: string }) => void;
};

function SortableTreeItem(props: ItemProps) {
  const id = nodeId(props.node);
  const sortable = useSortable({ id, disabled: !props.dragEnabled, transition: DND_TRANSITION });
  const into = useDroppable({ id: `into:${id}`, disabled: !props.dragEnabled || props.node.type !== "group" });
  const style = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.isDragging ? undefined : sortable.transition,
    opacity: sortable.isDragging ? 0.45 : 1,
  };
  const paddingLeft = 8 + props.depth * 10;

  if (props.node.type === "project") {
    const project = props.node.project;
    const context = props.contexts.find((item) => item.projectId === project.id && !item.worktreeId);
    const worktrees = props.worktrees.filter((item) => item.projectId === project.id);
    const open = !props.collapsed.has(project.id);
    const selected = props.selected?.projectId === project.id;
    return (
      <div ref={sortable.setNodeRef} style={style} {...sortable.attributes} role="treeitem" aria-selected={selected} aria-expanded={worktrees.length ? open : undefined}>
        <div
          className={`web-tree-project${selected ? " active" : ""}`}
          style={{ paddingLeft }}
          {...sortable.listeners}
          onContextMenu={(event) => props.onContextMenu(event, { kind: "project", id: project.id })}
        >
          {worktrees.length ? <button className="web-tree-chevron" type="button" onPointerDown={(event) => event.stopPropagation()} onClick={() => props.onToggle(project.id)} aria-expanded={open}><ChevronRight size={12} /></button> : <span className="web-tree-chevron" />}
          <ProjectIcon source={project.source} />
          <button className="web-tree-label" type="button" disabled={!context} onClick={() => context && props.onSelect(context.key)} title={project.cwd ?? project.name}>
            <strong>{project.name}</strong>
          </button>
          {props.managementEnabled && <button className="web-tree-quick-action" type="button" onPointerDown={(event) => event.stopPropagation()} onClick={() => props.onQuickStart("project", project.id)} aria-label={`${props.t("quickStart")} ${project.name}`} title={props.t("quickStart")}><Play size={13} /></button>}
        </div>
        {open && worktrees.length > 0 && <div className="web-tree-worktrees" role="group">{worktrees.map((worktree) => {
          const worktreeContext = props.contexts.find((item) => item.worktreeId === worktree.id);
          return (
            <div className={`web-tree-worktree${props.selected?.worktreeId === worktree.id ? " active" : ""}`} style={{ paddingLeft: paddingLeft + 29 }} key={worktree.id} onContextMenu={(event) => props.onContextMenu(event, { kind: "worktree", id: worktree.id })}>
              <button className="web-tree-worktree-main" type="button" disabled={!worktreeContext} onClick={() => worktreeContext && props.onSelect(worktreeContext.key)} title={worktree.cwd}>
                <WorktreeIcon /><span><strong>{worktree.name}</strong><small>{worktree.branch}</small></span>
              </button>
              {props.managementEnabled && <button className="web-tree-quick-action" type="button" onClick={() => props.onQuickStart("worktree", worktree.id)} aria-label={`${props.t("quickStart")} ${worktree.name}`} title={props.t("quickStart")}><Play size={13} /></button>}
            </div>
          );
        })}</div>}
      </div>
    );
  }

  const group = props.node.group;
  const open = !props.collapsed.has(group.id);
  return (
    <div ref={sortable.setNodeRef} style={style} {...sortable.attributes} role="treeitem" aria-expanded={open}>
      <div ref={into.setNodeRef} className={`web-tree-group${into.isOver ? " drop-target" : ""}`} style={{ paddingLeft }} {...sortable.listeners} onContextMenu={(event) => props.onContextMenu(event, { kind: "group", id: group.id })}>
        <button className="web-tree-chevron" type="button" onPointerDown={(event) => event.stopPropagation()} onClick={() => props.onToggle(group.id)} aria-expanded={open}><ChevronRight size={12} /></button>
        <Folder size={16} strokeWidth={1.5} />
        <button className="web-tree-label" type="button" onClick={() => props.onToggle(group.id)}><strong>{group.name}</strong></button>
        {props.managementEnabled && <button className="web-tree-quick-action" type="button" onPointerDown={(event) => event.stopPropagation()} onClick={() => props.onQuickStart("group", group.id)} aria-label={`${props.t("quickStart")} ${group.name}`} title={props.t("quickStart")}><Play size={13} /></button>}
      </div>
      {open && <SortableContext items={props.node.children.map(nodeId)} strategy={verticalListSortingStrategy}>
        <div role="group">{props.node.children.map((child) => <SortableTreeItem key={`${child.type}:${nodeId(child)}`} {...props} node={child} depth={props.depth + 1} />)}</div>
      </SortableContext>}
    </div>
  );
}

function previewWorkspace(workspace: WorkspaceSnapshot, itemType: "group" | "project", itemId: string, targetParentId: string | null, orderedIds: string[]): WorkspaceSnapshot {
  const order = new Map(orderedIds.map((id, index) => [id, index]));
  return {
    ...workspace,
    groups: workspace.groups.map((group) => ({
      ...group,
      parentId: itemType === "group" && group.id === itemId ? targetParentId : group.parentId,
      sortOrder: order.get(group.id) ?? group.sortOrder,
    })),
    projects: workspace.projects.map((project) => ({
      ...project,
      groupId: itemType === "project" && project.id === itemId ? targetParentId : project.groupId,
      sortOrder: order.get(project.id) ?? project.sortOrder,
    })),
  };
}

export function ProjectTree(props: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [preview, setPreview] = useState<WorkspaceSnapshot | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectedProjectIds, setSelectedProjectIds] = useState<Set<string>>(() => new Set());
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number } | null>(null);
  const [menuIndex, setMenuIndex] = useState(0);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const workspace = preview ?? props.workspace;
  const tree = useMemo(() => workspace ? buildTree(workspace) : [], [workspace]);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 3 } }));

  useEffect(() => setPreview(null), [props.workspace?.updatedAt]);
  useEffect(() => {
    const validIds = new Set(props.workspace?.projects.map((project) => project.id) ?? []);
    setSelectedProjectIds((current) => {
      const next = new Set([...current].filter((id) => validIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [props.workspace?.updatedAt, props.workspace?.projects]);
  useEffect(() => {
    if (!contextMenu) return;
    const close = (event: Event) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      setContextMenu(null);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setContextMenu(null);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", keydown);
    };
  }, [contextMenu]);

  const toggle = (id: string) => setCollapsed((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const submitStart = (targetType: "project" | "group" | "worktree", targetId: string, launchMode: "internal" | "external" | "split" = "internal", direction?: "horizontal" | "vertical") => {
    const payload: JsonObject = { targetType, targetId, launchMode };
    if (direction) payload.direction = direction;
    void props.onSubmit("project.start", payload).catch(() => undefined);
  };

  const submitAction = (action: string, targetType: "project" | "group" | "worktree", targetId: string, confirmed = false) => {
    const payload: JsonObject = { action, targetType, targetId };
    if (confirmed) payload.confirmed = true;
    void props.onSubmit("project.action", payload).catch(() => undefined);
  };

  const handleQuickStart = (targetType: "project" | "group" | "worktree", targetId: string) => submitStart(targetType, targetId);

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveId(null);
    if (!workspace || !event.over || event.active.id === event.over.id) return;
    const itemId = String(event.active.id);
    const itemType = workspace.groups.some((group) => group.id === itemId) ? "group" : workspace.projects.some((project) => project.id === itemId) ? "project" : null;
    if (!itemType) return;
    const overId = String(event.over.id);
    let targetParentId: string | null;
    let orderedIds: string[];
    if (overId.startsWith("into:")) {
      targetParentId = overId.slice(5);
      if (targetParentId === itemId) return;
      const target = findLevel(tree, targetParentId);
      const group = target?.nodes.find((node) => node.type === "group" && node.group.id === targetParentId);
      if (!group || group.type !== "group") return;
      orderedIds = [...group.children.map(nodeId).filter((id) => id !== itemId), itemId];
    } else {
      const level = findLevel(tree, overId);
      if (!level) return;
      targetParentId = level.parentId;
      orderedIds = level.nodes.map(nodeId).filter((id) => id !== itemId);
      const index = orderedIds.indexOf(overId);
      if (index < 0) return;
      orderedIds.splice(index, 0, itemId);
    }
    setPreview(previewWorkspace(workspace, itemType, itemId, targetParentId, orderedIds));
    void props.onSubmit("project.tree.reorder", { itemType, itemId, targetParentId, orderedIds }).then(
      () => props.onReload(),
      () => { setPreview(null); props.onReload(); },
    );
  };

  const openMenu = (event: MouseEvent, target: { kind: "project" | "group" | "worktree"; id: string }) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ ...target, x: event.clientX, y: event.clientY });
    setMenuIndex(0);
  };

  const menuEntries = useMemo<MenuEntry[]>(() => {
    if (!contextMenu || !workspace || !props.managementEnabled) return [];
    const close = () => setContextMenu(null);
    const item = (key: string, label: string, icon: ReactNode, onClick: () => void, options: { danger?: boolean; disabled?: boolean } = {}): MenuEntry => ({ kind: "item", key, label, icon, onClick: () => { close(); onClick(); }, ...options });
    const separator = (key: string): MenuEntry => ({ kind: "separator", key });
    if (contextMenu.kind === "project") {
      const project = workspace.projects.find((candidate) => candidate.id === contextMenu.id);
      if (!project) return [];
      const selected = selectedProjectIds.has(project.id);
      const selectedIds = [...selectedProjectIds];
      return [
        item("project-start", props.t("quickStart"), <Play size={14} />, () => submitStart("project", project.id)),
        item("project-external", props.t("launchExternal"), <ExternalLink size={14} />, () => submitStart("project", project.id, "external")),
        item("project-split-right", props.t("splitRight"), <SquareSplitHorizontal size={14} />, () => submitStart("project", project.id, "split", "horizontal")),
        item("project-split-down", props.t("splitDown"), <SquareSplitVertical size={14} />, () => submitStart("project", project.id, "split", "vertical")),
        separator("project-launch-separator"),
        item("project-clone", props.t("clone"), <Files size={14} />, () => submitAction("project.clone", "project", project.id)),
        item("project-selection", selected ? props.t("deselect") : props.t("addToSelection"), <UserPlus size={14} />, () => setSelectedProjectIds((current) => {
          const next = new Set(current);
          if (next.has(project.id)) next.delete(project.id); else next.add(project.id);
          return next;
        })),
        item("project-launch-selected", props.t("launchSelected"), <Terminal size={14} />, () => {
          if (selectedIds.length > 0) void props.onSubmit("project.start", { targetType: "selection", targetIds: selectedIds, launchMode: "internal" }).catch(() => undefined);
        }, { disabled: selectedIds.length === 0 }),
        separator("project-file-separator"),
        item("project-directory", props.t("openDirectory"), <FolderOpen size={14} />, () => submitAction("project.openDirectory", "project", project.id)),
        item("project-files", props.t("browseFiles"), <Files size={14} />, () => submitAction("project.openFiles", "project", project.id)),
        item("project-history", props.t("sessionHistory"), <History size={14} />, () => submitAction("project.history", "project", project.id)),
        item("project-provider", props.t("switchProvider"), <Settings size={14} />, () => submitAction("project.provider", "project", project.id)),
        item("project-rename", props.t("rename"), <Pencil size={14} />, () => submitAction("project.rename", "project", project.id)),
        item("project-edit", props.t("edit"), <Settings size={14} />, () => submitAction("project.edit", "project", project.id)),
        separator("project-danger-separator"),
        item("project-delete", props.t("deleteAction"), <Trash2 size={14} />, () => submitAction("project.delete", "project", project.id, true), { danger: true }),
      ];
    }
    if (contextMenu.kind === "worktree") {
      const worktree = workspace.worktrees.find((candidate) => candidate.id === contextMenu.id);
      if (!worktree) return [];
      return [
        item("worktree-start", props.t("quickStart"), <Play size={14} />, () => submitStart("worktree", worktree.id)),
        item("worktree-external", props.t("launchExternal"), <ExternalLink size={14} />, () => submitStart("worktree", worktree.id, "external")),
        item("worktree-finish", props.t("finishWorktree"), <FolderOpen size={14} />, () => submitAction("worktree.finish", "worktree", worktree.id, true)),
        item("worktree-history", props.t("sessionHistory"), <History size={14} />, () => submitAction("worktree.history", "worktree", worktree.id)),
        item("worktree-install", props.t("installDependencies"), <Terminal size={14} />, () => submitAction("worktree.installDeps", "worktree", worktree.id)),
        item("worktree-directory", props.t("openDirectory"), <FolderOpen size={14} />, () => submitAction("worktree.openDirectory", "worktree", worktree.id)),
        item("worktree-files", props.t("browseFiles"), <Files size={14} />, () => submitAction("worktree.openFiles", "worktree", worktree.id)),
        item("worktree-provider", props.t("switchProvider"), <Settings size={14} />, () => submitAction("worktree.provider", "worktree", worktree.id)),
        separator("worktree-danger-separator"),
        item("worktree-discard", props.t("discardWorktree"), <Trash2 size={14} />, () => submitAction("worktree.discard", "worktree", worktree.id, true), { danger: true }),
      ];
    }
    const group = workspace.groups.find((candidate) => candidate.id === contextMenu.id);
    if (!group) return [];
    return [
      item("group-start", props.t("quickStart"), <Play size={14} />, () => submitStart("group", group.id)),
      item("group-external", props.t("launchExternal"), <ExternalLink size={14} />, () => submitStart("group", group.id, "external")),
      item("group-stop", props.t("stopGroup"), <CircleStop size={14} />, () => submitAction("group.stop", "group", group.id, true), { danger: true }),
      separator("group-management-separator"),
      item("group-child", props.t("newChildGroup"), <FolderPlus size={14} />, () => submitAction("group.newChild", "group", group.id)),
      item("group-project", props.t("addProject"), <UserPlus size={14} />, () => submitAction("group.addProject", "group", group.id)),
      item("group-batch", props.t("batchShell"), <Terminal size={14} />, () => submitAction("group.batchShell", "group", group.id)),
      item("group-rename", props.t("rename"), <Pencil size={14} />, () => submitAction("group.rename", "group", group.id)),
      item("group-focus", props.t("focusGroup"), <Settings size={14} />, () => submitAction("group.focus", "group", group.id)),
      separator("group-danger-separator"),
      item("group-delete", props.t("deleteAction"), <Trash2 size={14} />, () => submitAction("group.delete", "group", group.id, true), { danger: true }),
    ];
  }, [contextMenu, props, selectedProjectIds, workspace]);

  useEffect(() => {
    if (!contextMenu || menuEntries.length === 0) return;
    const focusable = menuEntries.filter((entry): entry is Extract<MenuEntry, { kind: "item" }> => entry.kind === "item" && !entry.disabled);
    if (focusable.length === 0) return;
    const keydown = (event: KeyboardEvent) => {
      if (!menuRef.current?.contains(document.activeElement)) return;
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End" && event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      if (event.key === "Enter" || event.key === " ") {
        focusable[menuIndex % focusable.length]?.onClick();
        return;
      }
      if (event.key === "Home") {
        setMenuIndex(0);
        return;
      }
      if (event.key === "End") {
        setMenuIndex(focusable.length - 1);
        return;
      }
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setMenuIndex((current) => (current + delta + focusable.length) % focusable.length);
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [contextMenu, menuEntries, menuIndex]);

  useLayoutEffect(() => {
    if (!contextMenu || !menuRef.current) {
      setMenuPosition(null);
      return;
    }
    const rect = menuRef.current.getBoundingClientRect();
    const margin = 8;
    const left = Math.max(margin, Math.min(contextMenu.x, window.innerWidth - rect.width - margin));
    const top = Math.max(margin, Math.min(contextMenu.y, window.innerHeight - rect.height - margin));
    setMenuPosition({ left, top });
  }, [contextMenu, menuEntries.length]);

  useEffect(() => {
    if (!contextMenu || !menuRef.current) return;
    const focusable = Array.from(menuRef.current.querySelectorAll<HTMLButtonElement>("button:not([disabled])"));
    focusable[menuIndex]?.focus();
  }, [contextMenu, menuEntries, menuIndex]);

  const menu = contextMenu && menuEntries.length > 0 && typeof document !== "undefined"
    ? createPortal(
      <div ref={menuRef} className="web-context-menu" role="menu" style={{ left: menuPosition?.left ?? contextMenu.x, top: menuPosition?.top ?? contextMenu.y }}>
        {menuEntries.map((entry) => entry.kind === "separator"
          ? <div key={entry.key} className="web-context-menu-separator" role="separator" />
          : <button key={entry.key} className={`web-context-menu-item${entry.danger ? " danger" : ""}`} type="button" role="menuitem" disabled={entry.disabled} onMouseEnter={() => setMenuIndex(menuEntries.filter((candidate): candidate is Extract<MenuEntry, { kind: "item" }> => candidate.kind === "item" && !candidate.disabled).findIndex((candidate) => candidate.key === entry.key))} onClick={entry.onClick}>{entry.icon}<span>{entry.label}</span></button>
        )}
      </div>,
      document.body,
    )
    : null;

  if (!workspace || tree.length === 0) return <p className="empty-copy">{props.t("noProjectContext")}</p>;
  return (
    <>
      <DndContext sensors={sensors} collisionDetection={collisionDetection} onDragStart={(event) => setActiveId(String(event.active.id))} onDragCancel={() => setActiveId(null)} onDragEnd={handleDragEnd}>
        <SortableContext items={tree.map(nodeId)} strategy={verticalListSortingStrategy}>
          <div className="web-project-tree" role="tree" aria-label={props.t("projects")}>
            {tree.map((node) => <SortableTreeItem key={`${node.type}:${nodeId(node)}`} node={node} depth={0} collapsed={collapsed} contexts={props.projectContexts} worktrees={workspace.worktrees} selected={props.selectedProjectContext} selectedProjectIds={selectedProjectIds} dragEnabled={props.dragEnabled} managementEnabled={props.managementEnabled} t={props.t} onToggle={toggle} onSelect={props.onSelectProjectContext} onQuickStart={handleQuickStart} onContextMenu={openMenu} />)}
          </div>
        </SortableContext>
        <DragOverlay>{activeId ? <div className="web-tree-drag-overlay">{workspace.groups.find((group) => group.id === activeId)?.name ?? workspace.projects.find((project) => project.id === activeId)?.name}</div> : null}</DragOverlay>
      </DndContext>
      {menu}
    </>
  );
}
