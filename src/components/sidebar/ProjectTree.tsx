import { DndContext, PointerSensor, closestCenter, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { TreeNode as TNode } from "../../lib/types";
import { SidebarSkeleton } from "../ui/Skeleton";
import { EmptyState } from "../ui/EmptyState";
import { Folder, Plus, Terminal } from "../icons";
import { TreeNodeItem } from "./TreeNodeItem";
import { useTreeActions } from "./TreeContext";

interface ProjectTreeProps {
  tree: TNode[];
  initialLoading: boolean;
  loadError: string | null;
  collapsed: boolean;
  density: "compact" | "comfortable";
  newGroupParentId: string | null;
  onCreateRootGroup: (name: string) => void;
  onCancelRootGroup: () => void;
  onQuickAddProject: () => void;
  onRetry: () => void;
}

interface CompactItem {
  key: string;
  type: "group" | "project";
  id: string;
  label: string;
  node: TNode;
}

interface VisibleTreeNode {
  key: string;
  kind: "group" | "project";
  parentGroupKey: string | null;
  groupId?: string;
  projectId?: string;
  isOpen?: boolean;
  hasChildren?: boolean;
  firstChildKey?: string | null;
}

function nodeKey(node: TNode): string {
  return node.type === "group" ? `g:${node.group.id}` : `p:${node.project.id}`;
}

function flattenTree(nodes: TNode[], out: CompactItem[] = []): CompactItem[] {
  for (const node of nodes) {
    if (node.type === "group") {
      out.push({
        key: `g:${node.group.id}`,
        type: "group",
        id: node.group.id,
        label: node.group.name,
        node,
      });
      flattenTree(node.children, out);
    } else {
      out.push({
        key: `p:${node.project.id}`,
        type: "project",
        id: node.project.id,
        label: node.project.name,
        node,
      });
    }
  }
  return out;
}

function flattenVisibleTree(
  nodes: TNode[],
  collapsedIds: Set<string>,
  parentGroupKey: string | null = null,
  out: VisibleTreeNode[] = []
): VisibleTreeNode[] {
  for (const node of nodes) {
    if (node.type === "group") {
      const currentKey = `g:${node.group.id}`;
      const isOpen = !collapsedIds.has(node.group.id);
      const firstChildKey = node.children.length > 0 ? nodeKey(node.children[0]) : null;
      out.push({
        key: currentKey,
        kind: "group",
        parentGroupKey,
        groupId: node.group.id,
        isOpen,
        hasChildren: node.children.length > 0,
        firstChildKey,
      });
      if (isOpen) {
        flattenVisibleTree(node.children, collapsedIds, currentKey, out);
      }
      continue;
    }

    out.push({
      key: `p:${node.project.id}`,
      kind: "project",
      parentGroupKey,
      projectId: node.project.id,
    });
  }
  return out;
}

export function ProjectTree({
  tree,
  initialLoading,
  loadError,
  collapsed,
  density,
  newGroupParentId,
  onCreateRootGroup,
  onCancelRootGroup,
  onQuickAddProject,
  onRetry,
}: ProjectTreeProps) {
  const actions = useTreeActions();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  const [focusedNodeKey, setFocusedNodeKey] = useState<string | null>(null);
  const visibleNodes = useMemo(
    () => flattenVisibleTree(tree, actions.collapsedIds),
    [actions.collapsedIds, tree]
  );
  const visibleNodeIndex = useMemo(() => {
    const map = new Map<string, number>();
    visibleNodes.forEach((node, idx) => map.set(node.key, idx));
    return map;
  }, [visibleNodes]);
  const projectById = useMemo(() => {
    const map = new Map<string, TNode>();
    const walk = (nodes: TNode[]) => {
      for (const node of nodes) {
        if (node.type === "project") {
          map.set(node.project.id, node);
        } else {
          walk(node.children);
        }
      }
    };
    walk(tree);
    return map;
  }, [tree]);

  const focusTreeItem = useCallback((key: string) => {
    setFocusedNodeKey(key);
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-tree-key="${key}"]`);
      el?.focus();
    });
  }, []);

  useEffect(() => {
    if (visibleNodes.length === 0) {
      if (focusedNodeKey !== null) {
        setFocusedNodeKey(null);
      }
      return;
    }
    if (focusedNodeKey && visibleNodeIndex.has(focusedNodeKey)) return;
    const selectedProjectKey =
      actions.selectedId && visibleNodeIndex.has(`p:${actions.selectedId}`)
        ? `p:${actions.selectedId}`
        : visibleNodes[0].key;
    setFocusedNodeKey(selectedProjectKey);
  }, [actions.selectedId, focusedNodeKey, visibleNodeIndex, visibleNodes]);

  const handleTreeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    if (
      target?.tagName === "INPUT" ||
      target?.tagName === "TEXTAREA" ||
      target?.tagName === "SELECT" ||
      !!target?.closest("[contenteditable='true']")
    ) {
      return;
    }

    if (visibleNodes.length === 0) return;
    const currentKey = focusedNodeKey ?? visibleNodes[0].key;
    const index = visibleNodeIndex.get(currentKey) ?? 0;
    const current = visibleNodes[index];
    if (!current) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      const next = visibleNodes[Math.min(index + 1, visibleNodes.length - 1)];
      if (next) focusTreeItem(next.key);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      const prev = visibleNodes[Math.max(index - 1, 0)];
      if (prev) focusTreeItem(prev.key);
      return;
    }

    if (event.key === "ArrowRight" && current.kind === "group" && current.groupId) {
      event.preventDefault();
      if (current.hasChildren && !current.isOpen) {
        actions.toggleCollapsed(current.groupId);
        return;
      }
      if (current.hasChildren && current.firstChildKey) {
        focusTreeItem(current.firstChildKey);
      }
      return;
    }

    if (event.key === "ArrowLeft") {
      if (current.kind === "group" && current.groupId && current.hasChildren && current.isOpen) {
        event.preventDefault();
        actions.toggleCollapsed(current.groupId);
        return;
      }
      if (current.parentGroupKey) {
        event.preventDefault();
        focusTreeItem(current.parentGroupKey);
      }
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      if (current.kind === "group" && current.groupId) {
        actions.toggleCollapsed(current.groupId);
        return;
      }
      if (current.kind === "project" && current.projectId) {
        const projectNode = projectById.get(current.projectId);
        if (projectNode?.type === "project") {
          actions.onOpenProject(projectNode.project);
        }
      }
      return;
    }

    if (event.key === " " || event.key === "Spacebar") {
      event.preventDefault();
      if (current.kind === "project" && current.projectId) {
        const projectNode = projectById.get(current.projectId);
        if (projectNode?.type === "project") {
          actions.onSelectProjectByKeyboard(projectNode.project);
        }
      }
      if (current.kind === "group" && current.groupId) {
        actions.toggleCollapsed(current.groupId);
      }
      return;
    }

    if (event.key === "Home") {
      event.preventDefault();
      focusTreeItem(visibleNodes[0].key);
      return;
    }

    if (event.key === "End") {
      event.preventDefault();
      focusTreeItem(visibleNodes[visibleNodes.length - 1].key);
    }
  }, [actions, focusTreeItem, focusedNodeKey, projectById, visibleNodeIndex, visibleNodes]);

  if (initialLoading) {
    return (
      <div className="h-full overflow-y-auto px-1.5 pb-2 pt-1">
        <SidebarSkeleton />
      </div>
    );
  }

  if (collapsed) {
    const compactItems = flattenTree(tree);
    const collapsedButtonSize = density === "compact" ? "h-7 w-7" : "h-8 w-8";
    const compactTextSize = density === "compact" ? "text-[11px]" : "text-xs";
    return (
      <div className={`h-full overflow-y-auto ${density === "compact" ? "px-0.5 pb-1.5 pt-0.5" : "px-1 pb-2 pt-1"}`}>
        {compactItems.length === 0 && (
          <div className={`flex flex-col items-center text-text-muted ${density === "compact" ? "gap-1.5 py-2.5" : "gap-2 py-3"}`}>
            <Terminal size={20} strokeWidth={1.2} className="opacity-50" />
            <button
              onClick={onQuickAddProject}
              className={`ui-flat-action ui-primary-action px-0 ${collapsedButtonSize}`}
              title="快速添加项目"
              aria-label="快速添加项目"
            >
              <Plus size={12} strokeWidth={2} />
            </button>
          </div>
        )}
        {compactItems.map((item) => {
          if (item.type === "group") {
            const groupNode = item.node.type === "group" ? item.node : null;
            if (!groupNode) return null;
            return (
              <button
                key={item.key}
                className={`ui-flat-action ui-tree-collapsed-item mx-auto my-0.5 px-0 text-primary ${collapsedButtonSize}`}
                title={item.label}
                aria-label={`目录 ${item.label}`}
                onContextMenu={(e) => actions.onContextMenuGroup(e, groupNode.group.id, groupNode.group.name)}
              >
                <Folder size={16} strokeWidth={1.5} />
              </button>
            );
          }

          const projectNode = item.node.type === "project" ? item.node : null;
          if (!projectNode) return null;
          const project = projectNode.project;
          const projectInitial = project.name.trim().charAt(0).toUpperCase() || "P";
          const selected =
            actions.selectedId === project.id || actions.selectedProjectIds.has(project.id);
          return (
            <button
              key={item.key}
              className={`ui-tree-collapsed-item mx-auto my-0.5 flex ${collapsedButtonSize} items-center justify-center rounded-xl font-semibold transition-colors ${compactTextSize}`}
              data-selected={selected ? "true" : "false"}
              title={project.name}
              aria-label={`打开项目 ${project.name}`}
              onClick={() => actions.onOpenProject(project)}
              onContextMenu={(e) => actions.onContextMenuProject(e, project)}
            >
              {projectInitial}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className={`h-full overflow-y-auto ${density === "compact" ? "px-1 pb-1.5 pt-0.5" : "px-1.5 pb-2 pt-1"}`}>
      {newGroupParentId === "__root__" && (
        <div className={`flex items-center px-2 ${density === "compact" ? "gap-1 py-1" : "gap-1.5 py-1.5"}`}>
          <span className="shrink-0 text-accent">
            <Folder size={16} strokeWidth={1.5} />
          </span>
          <input
            ref={(ref) => {
              ref?.focus();
            }}
            className="ui-tree-inline-input ui-focus-ring h-8 flex-1 px-2 text-xs text-on-surface outline-none"
            onBlur={(e) => {
              const value = e.currentTarget.value.trim();
              if (value) onCreateRootGroup(value);
              else onCancelRootGroup();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const value = e.currentTarget.value.trim();
                if (value) onCreateRootGroup(value);
                else onCancelRootGroup();
              }
              if (e.key === "Escape") onCancelRootGroup();
            }}
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={(event) => actions.onDragEnd(null, event)}
      >
        <SortableContext
          items={tree.map((n) => (n.type === "group" ? n.group.id : n.project.id))}
          strategy={verticalListSortingStrategy}
        >
          <div
            role="tree"
            aria-label="项目树（上下键导航，回车打开，空格选中）"
            aria-multiselectable="true"
            onKeyDown={handleTreeKeyDown}
          >
            {tree.map((node) => (
              <TreeNodeItem
                key={node.type === "group" ? `g:${node.group.id}` : `p:${node.project.id}`}
                node={node}
                depth={0}
                density={density}
                focusedNodeKey={focusedNodeKey}
                onFocusNode={setFocusedNodeKey}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      {tree.length === 0 && loadError && (
        <EmptyState
          icon={<Terminal size={40} strokeWidth={1} />}
          title="项目加载失败"
          description={loadError}
          action={{ label: "重试", onClick: onRetry }}
        />
      )}

      {tree.length === 0 && !loadError && (
        <EmptyState
          icon={<Terminal size={40} strokeWidth={1} />}
          title="欢迎使用 CLI-Manager"
          description="集中管理你的开发项目终端。添加项目后即可快速启动 CLI 工具。"
          action={{ label: "快速添加项目", onClick: onQuickAddProject }}
        />
      )}
    </div>
  );
}
