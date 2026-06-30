import { useState, useEffect, useRef, memo } from "react";
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { TreeNode as TNode } from "../../lib/types";
import { useTreeActions } from "./TreeContext";
import { Folder, Terminal, Play, ChevronRight, AlertTriangle } from "../icons";
import { VendorIcon, inferVendor } from "../VendorIcon";
import { useI18n } from "../../lib/i18n";

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
      className="ui-tree-inline-input ui-focus-ring h-8 flex-1 px-2 text-xs text-on-surface outline-none"
      onClick={(e) => e.stopPropagation()}
    />
  );
}

interface TreeNodeItemProps {
  node: TNode;
  depth: number;
  density: "compact" | "comfortable";
  focusedNodeKey: string | null;
  onFocusNode: (key: string) => void;
  forceExpanded?: boolean;
  sortableEnabled?: boolean;
}

function TreeNodeItemImpl({
  node,
  depth,
  density,
  focusedNodeKey,
  onFocusNode,
  forceExpanded = false,
  sortableEnabled = true,
}: TreeNodeItemProps) {
  const { t } = useI18n();
  const actions = useTreeActions();
  const itemId = node.type === "project" ? node.project.id : node.group.id;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: itemId, disabled: !sortableEnabled });
  const sortableStyle = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 };
  const compact = density === "compact";
  const indentBase = compact ? 6 : 8;
  const indentStep = compact ? 14 : 16;
  const paddingLeft = indentBase + depth * indentStep;

  if (node.type === "project") {
    const p = node.project;
    const treeKey = `p:${p.id}`;
    const isSelected = actions.selectedId === p.id;
    const isMultiSelected = actions.selectedProjectIds.has(p.id);
    const status = actions.getProjectStatus(p.id);
    const pathInvalid = actions.isPathInvalid(p.id);
    const providerBadge = actions.providerBadges[p.id];
    const providerName = providerBadge?.providerName?.trim() || t("sidebar.tree.customProvider");
    const providerVendor = providerBadge
      ? inferVendor(providerBadge.vendorHint) ?? inferVendor(providerBadge.providerName)
      : null;
    const cliVendor = p.cli_tool ? inferVendor(p.cli_tool) : null;

    return (
      <div
        ref={setNodeRef}
        style={{ ...sortableStyle }}
        {...attributes}
        role="treeitem"
        data-tree-key={treeKey}
        aria-level={depth + 1}
        aria-selected={isSelected || isMultiSelected}
        tabIndex={focusedNodeKey === treeKey ? 0 : -1}
        onFocus={() => onFocusNode(treeKey)}
      >
        <div
          className={`ui-tree-node ui-tree-project ui-focus-ring flex items-center rounded-xl cursor-pointer group/item ${
            compact ? "gap-1.5 py-1 text-[12px]" : "gap-2 py-1.5 text-[13px]"
          }`}
          data-selected={isSelected || isMultiSelected ? "true" : "false"}
          data-status={status ?? "idle"}
          data-invalid={pathInvalid ? "true" : "false"}
          style={{ paddingLeft, paddingRight: compact ? 8 : 10 }}
          onClick={(e) => actions.onSelectProject(e, p)}
          onDoubleClick={() => actions.onOpenProject(p)}
          onContextMenu={(e) => actions.onContextMenuProject(e, p)}
          {...listeners}
        >
          <span className="ui-tree-leading-icon">
            {cliVendor ? (
              <VendorIcon vendor={cliVendor} size={14} />
            ) : (
              <Terminal size={14} strokeWidth={1.5} />
            )}
          </span>
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <span className="block truncate font-medium">{p.name}</span>
            {providerBadge && (
              <span
                className="ui-tree-meta-chip ui-tree-provider-chip inline-flex max-w-[104px] shrink-0 items-center gap-1 truncate rounded-full px-1.5 py-0.5 text-[10px] leading-none"
                title={t("sidebar.tree.providerBadge", { name: providerName })}
                aria-label={t("sidebar.tree.providerBadge", { name: providerName })}
              >
                {providerVendor && <VendorIcon vendor={providerVendor} size={10} />}
                <span className="truncate">{providerName}</span>
              </span>
            )}
            {pathInvalid && (
              <span
                className="ui-tree-warning-chip inline-flex shrink-0 items-center justify-center rounded-full"
                title={t("sidebar.tree.pathMissing")}
                aria-label={t("sidebar.tree.pathMissing")}
              >
                <AlertTriangle size={12} strokeWidth={1.5} />
              </span>
            )}
          </span>
          <span
            className="ui-tree-item-actions hidden shrink-0 items-center gap-0.5 group-hover/item:flex group-focus-within/item:flex"
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <button onClick={(e) => { e.stopPropagation(); actions.onOpenProject(p); }} className="icon-btn" style={{ color: "var(--success)", opacity: 0.7 }} title={t("sidebar.tree.openTerminal")}>
              <Play size={14} strokeWidth={1.5} />
            </button>
          </span>
        </div>
      </div>
    );
  }

  const g = node.group;
  const treeKey = `g:${g.id}`;
  const isOpen = forceExpanded || !actions.collapsedIds.has(g.id);
  const { setNodeRef: setIntoRef, isOver: isOverInto } = useDroppable({ id: `into:${g.id}` });

  if (actions.renamingGroupId === g.id) {
    return (
      <div
        ref={setNodeRef}
        style={{ ...sortableStyle }}
        {...attributes}
        role="treeitem"
        data-tree-key={treeKey}
        aria-level={depth + 1}
        aria-expanded="true"
        aria-selected={false}
        tabIndex={focusedNodeKey === treeKey ? 0 : -1}
        onFocus={() => onFocusNode(treeKey)}
      >
        <div className={`flex items-center px-2 ${compact ? "gap-1 py-1" : "gap-1.5 py-1.5"}`}>
          <ChevronRight size={12} strokeWidth={2} style={{ transform: "rotate(90deg)" }} />
          <InlineRename initial={g.name} onConfirm={(name) => actions.onRenameConfirm(g.id, name)} onCancel={actions.onCancelRename} />
        </div>
      </div>
    );
  }

  return (
    <div
      ref={setNodeRef}
      style={{ ...sortableStyle }}
      {...attributes}
      role="treeitem"
      data-tree-key={treeKey}
      aria-level={depth + 1}
      aria-expanded={isOpen}
      aria-selected={false}
      tabIndex={focusedNodeKey === treeKey ? 0 : -1}
      onFocus={() => onFocusNode(treeKey)}
    >
      <div className={`ui-tree-group-shell ${compact ? "my-0.5" : "my-1"}`} style={{ marginLeft: depth === 0 ? 0 : 2 }}>
        <div
          ref={setIntoRef}
          className={`ui-tree-node ui-tree-group ui-focus-ring flex items-center rounded-xl font-semibold cursor-pointer group/grp ${
            compact ? "gap-1.5 py-1 text-[11px]" : "gap-2 py-1.5 text-[12px]"
          }`}
          data-selected="false"
          data-open={isOpen ? "true" : "false"}
          data-drop-target={isOverInto ? "true" : "false"}
          style={{ paddingLeft, paddingRight: compact ? 8 : 10, color: "var(--text-secondary)" }}
          onClick={() => {
            if (!forceExpanded) actions.toggleCollapsed(g.id);
          }}
          onContextMenu={(e) => actions.onContextMenuGroup(e, g.id, g.name)}
          {...listeners}
        >
          <span className="ui-tree-chevron inline-flex items-center justify-center">
            <ChevronRight size={12} strokeWidth={2} style={{ transition: "transform 150ms", transform: isOpen ? "rotate(90deg)" : "rotate(0)" }} />
          </span>
          <span className="ui-tree-leading-icon"><Folder size={16} strokeWidth={1.5} /></span>
          <span className="flex-1 text-left truncate">{g.name}</span>
          <span className="ui-tree-item-actions hidden shrink-0 items-center gap-0.5 group-hover/grp:flex group-focus-within/grp:flex">
            <button onClick={(e) => { e.stopPropagation(); actions.onStartGroup(g.id); }} className="icon-btn" style={{ color: "var(--success)", opacity: 0.7 }} title={t("sidebar.tree.startDirectory")}><Play size={14} strokeWidth={1.5} /></button>
          </span>
        </div>

        {actions.newGroupParentId === g.id && (
          <div
            className={`flex items-center ${compact ? "gap-1.5 py-1" : "gap-2 py-1.5"}`}
            style={{ paddingLeft: paddingLeft + indentStep, paddingRight: compact ? 8 : 10 }}
          >
            <span className="ui-tree-leading-icon"><Folder size={16} strokeWidth={1.5} /></span>
            <InlineRename initial="" onConfirm={(name) => actions.onCreateGroup(g.id, name)} onCancel={actions.onCancelNewGroup} />
          </div>
        )}

        {isOpen && node.children.length > 0 && (
          <div className="tree-collapse" data-open="true">
            <div className="tree-collapse-inner" role="group">
              <SortableContext items={node.children.map((c) => c.type === "group" ? c.group.id : c.project.id)} strategy={verticalListSortingStrategy}>
                <div className={`${compact ? "ml-2 space-y-0.5 pb-0.5" : "ml-2.5 space-y-0.5 pb-1"}`}>
                  {node.children.map((child) => (
                    <TreeNodeItem
                      key={child.type === "group" ? `g:${child.group.id}` : `p:${child.project.id}`}
                      node={child}
                      depth={depth + 1}
                      density={density}
                      focusedNodeKey={focusedNodeKey}
                      onFocusNode={onFocusNode}
                      forceExpanded={forceExpanded}
                      sortableEnabled={sortableEnabled}
                    />
                  ))}
                </div>
              </SortableContext>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// 整树 memo 化：递归子节点是新 React element 但 type 指向同一 memo 组件，
// React 会按 props 浅比较跳过未变化分支的 render（绝大多数父组件刷新场景下 node 引用稳定）。
export const TreeNodeItem = memo(TreeNodeItemImpl);
