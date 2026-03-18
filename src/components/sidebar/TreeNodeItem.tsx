import { useState, useEffect, useRef } from "react";
import { DndContext, closestCenter, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { TreeNode as TNode } from "../../lib/types";
import type { SessionStatus } from "../../stores/terminalStore";
import { useTreeActions } from "./TreeContext";
import { Folder, FolderPlus, Terminal, Pencil, Trash2, Play, ChevronRight, Plus, AlertTriangle } from "lucide-react";

const STATUS_COLORS: Record<SessionStatus, string> = {
  running: "#9ece6a",
  exited: "#ff9e64",
  error: "#f7768e",
};

function InlineRename({ initial, onConfirm, onCancel }: { initial: string; onConfirm: (name: string) => void; onCancel: () => void }) {
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
      style={{ backgroundColor: "var(--bg-tertiary)", borderColor: "var(--accent)", color: "var(--text-primary)" }}
      onClick={(e) => e.stopPropagation()}
    />
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

export function TreeNodeItem({ node, depth }: { node: TNode; depth: number }) {
  const actions = useTreeActions();
  const itemId = node.type === "project" ? node.project.id : node.group.id;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: itemId });
  const sortableStyle = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 };
  const paddingLeft = 8 + depth * 16;

  if (node.type === "project") {
    const p = node.project;
    const isSelected = actions.selectedId === p.id;
    const isMultiSelected = actions.selectedProjectIds.has(p.id);
    const status = actions.getProjectStatus(p.id);
    const pathInvalid = actions.isPathInvalid(p.id);

    return (
      <div ref={setNodeRef} style={{ ...sortableStyle }} {...attributes} role="treeitem" aria-selected={isSelected || isMultiSelected}>
        <div
          className="flex items-center gap-2 py-1.5 rounded-md cursor-pointer text-sm group/item transition-colors"
          style={{
            paddingLeft, paddingRight: 8,
            backgroundColor: isSelected || isMultiSelected ? "var(--bg-tertiary)" : "transparent",
            color: isSelected || isMultiSelected ? "var(--text-primary)" : "var(--text-secondary)",
          }}
          onMouseEnter={(e) => { if (!isSelected && !isMultiSelected) e.currentTarget.style.backgroundColor = "var(--bg-tertiary)"; }}
          onMouseLeave={(e) => { if (!isSelected && !isMultiSelected) e.currentTarget.style.backgroundColor = "transparent"; }}
          onClick={(e) => actions.onSelectProject(e, p)}
          onDoubleClick={() => actions.onOpenProject(p)}
          onContextMenu={(e) => actions.onContextMenuProject(e, p)}
          {...listeners}
        >
          <span style={{ color: "var(--accent)", flexShrink: 0 }}>
            {status ? (
              <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ backgroundColor: STATUS_COLORS[status] }} role="status" aria-label={`Project ${status}`} title={status} />
            ) : (
              <Terminal size={14} strokeWidth={1.5} />
            )}
          </span>
          <span className="flex-1 min-w-0 flex items-center gap-1">
            <span className="block truncate">{p.name}</span>
            {p.cli_tool && (
              <span className="inline-flex text-[9px] leading-tight px-1.5 py-0.5 rounded-full border shrink-0" style={{ backgroundColor: "var(--bg-primary)", color: "var(--accent)", borderColor: "var(--border)" }}>
                {p.cli_tool}
              </span>
            )}
            {pathInvalid && (
              <span className="inline-flex shrink-0" style={{ color: "var(--danger)" }} title="路径不存在">
                <AlertTriangle size={12} strokeWidth={1.5} />
              </span>
            )}
          </span>
          <span className="hidden group-hover/item:flex items-center gap-0.5 shrink-0">
            <button onClick={(e) => { e.stopPropagation(); actions.onOpenProject(p); }} className="icon-btn" style={{ color: "var(--success)", opacity: 0.7 }} title="Open terminal">
              <Play size={14} strokeWidth={1.5} />
            </button>
            <button onClick={(e) => { e.stopPropagation(); actions.onEditProject(p); }} className="icon-btn" style={{ color: "var(--text-muted)", opacity: 0.7 }} title="Edit">
              <Pencil size={14} strokeWidth={1.5} />
            </button>
            <button onClick={(e) => { e.stopPropagation(); actions.onDeleteProject(p); }} className="icon-btn" style={{ color: "var(--danger)", opacity: 0.7 }} title="Delete">
              <Trash2 size={14} strokeWidth={1.5} />
            </button>
          </span>
        </div>
      </div>
    );
  }

  // Group node
  const g = node.group;
  const isOpen = !actions.collapsedIds.has(g.id);
  const childCount = countDescendants(node);

  // Renaming mode
  if (actions.renamingGroupId === g.id) {
    return (
      <div ref={setNodeRef} style={{ ...sortableStyle }} {...attributes}>
        <div className="flex items-center gap-1.5 px-2 py-1.5">
          <ChevronRight size={12} strokeWidth={2} style={{ transform: "rotate(90deg)" }} />
          <InlineRename initial={g.name} onConfirm={(name) => actions.onRenameConfirm(g.id, name)} onCancel={actions.onCancelRename} />
        </div>
      </div>
    );
  }

  return (
    <div ref={setNodeRef} style={{ ...sortableStyle }} {...attributes} role="group" aria-expanded={isOpen}>
      <div
        className="flex items-center gap-1.5 py-1.5 rounded-md text-xs font-semibold uppercase tracking-wider cursor-pointer group/grp transition-colors"
        style={{ paddingLeft, paddingRight: 8, color: "var(--text-muted)" }}
        onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "var(--bg-tertiary)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
        onClick={() => actions.toggleCollapsed(g.id)}
        onContextMenu={(e) => actions.onContextMenuGroup(e, g.id, g.name)}
        {...listeners}
      >
        <ChevronRight size={12} strokeWidth={2} style={{ transition: "transform 150ms", transform: isOpen ? "rotate(90deg)" : "rotate(0)" }} />
        <span style={{ color: "var(--accent)", flexShrink: 0 }}><Folder size={16} strokeWidth={1.5} /></span>
        <span className="flex-1 text-left truncate">{g.name}</span>
        <span className="text-[10px] font-normal px-1.5 rounded-full" style={{ backgroundColor: "var(--bg-tertiary)", color: "var(--text-muted)" }}>{childCount}</span>
        <span className="hidden group-hover/grp:flex items-center gap-0.5 shrink-0">
          <button onClick={(e) => { e.stopPropagation(); actions.onStartGroup(g.id); }} className="icon-btn" style={{ color: "var(--success)", opacity: 0.7 }} title="启动本目录"><Play size={14} strokeWidth={1.5} /></button>
          <button onClick={(e) => { e.stopPropagation(); actions.onAddSubGroup(g.id); }} className="icon-btn" style={{ color: "var(--text-muted)", opacity: 0.7 }} title="Add sub-group"><FolderPlus size={14} strokeWidth={1.5} /></button>
          <button onClick={(e) => { e.stopPropagation(); actions.onAddProjectToGroup(g.id); }} className="icon-btn" style={{ color: "var(--success)", opacity: 0.7 }} title="Add project"><Plus size={12} strokeWidth={2} /></button>
          <button onClick={(e) => { e.stopPropagation(); actions.onRenameGroup(g.id, g.name); }} className="icon-btn" style={{ color: "var(--text-muted)", opacity: 0.7 }} title="Rename"><Pencil size={14} strokeWidth={1.5} /></button>
          <button onClick={(e) => { e.stopPropagation(); actions.onDeleteGroup(g.id, g.name); }} className="icon-btn" style={{ color: "var(--danger)", opacity: 0.7 }} title="Delete group"><Trash2 size={14} strokeWidth={1.5} /></button>
        </span>
      </div>

      {actions.newGroupParentId === g.id && (
        <div className="flex items-center gap-1.5 py-1.5" style={{ paddingLeft: paddingLeft + 16, paddingRight: 8 }}>
          <span style={{ color: "var(--accent)", flexShrink: 0 }}><Folder size={16} strokeWidth={1.5} /></span>
          <InlineRename initial="" onConfirm={(name) => actions.onCreateGroup(g.id, name)} onCancel={actions.onCancelNewGroup} />
        </div>
      )}

      {isOpen && node.children.length > 0 && (
        <DndContext sensors={[]} collisionDetection={closestCenter} onDragEnd={(event: DragEndEvent) => actions.onDragEnd(g.id, event)}>
          <SortableContext items={node.children.map((c) => c.type === "group" ? c.group.id : c.project.id)} strategy={verticalListSortingStrategy}>
            <div className="border-l ml-3" style={{ borderColor: "var(--border)" }}>
              {node.children.map((child) => (
                <TreeNodeItem key={child.type === "group" ? `g:${child.group.id}` : `p:${child.project.id}`} node={child} depth={depth + 1} />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}
    </div>
  );
}
