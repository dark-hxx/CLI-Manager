import { useState, useEffect, useRef, memo, type PointerEvent as ReactPointerEvent } from "react";
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { TreeNode as TNode } from "../../lib/types";
import type { ProviderBadge } from "../../stores/projectStore";
import { useTreeActions, worktreeListCollapseId } from "./TreeContext";
import { Folder, Terminal, Play, ChevronRight, AlertTriangle } from "../icons";
import { VendorIcon, inferVendor } from "../VendorIcon";
import { WorktreeIcon } from "../WorktreeIcon";
import { useI18n } from "../../lib/i18n";

function preventSecondaryPointerFocus(event: ReactPointerEvent<HTMLElement>) {
  if (event.button !== 2) return;
  event.preventDefault();
  event.stopPropagation();
}

const MAX_PROVIDER_BADGE_LABEL_LENGTH = 10;

function compactProviderBadgeLabel(name: string) {
  const value = name.trim();
  const knownPrefix = value.match(/^(gpt-\d+(?:\.\d+)?|claude-\d+(?:\.\d+)?|claude-[a-z]+|deepseek|qwen\d*|gemini|kimi|doubao|openai|anthropic|azure)\b/i);
  if (knownPrefix) return knownPrefix[1];

  const separatorIndex = value.search(/[-_\s/]/);
  const token = separatorIndex > 0 ? value.slice(0, separatorIndex) : value;
  return token.length > MAX_PROVIDER_BADGE_LABEL_LENGTH
    ? token.slice(0, MAX_PROVIDER_BADGE_LABEL_LENGTH)
    : token;
}

function ProviderBadgeChip({ badge }: { badge: ProviderBadge }) {
  const { t } = useI18n();
  const providerName = badge.providerName?.trim() || t("sidebar.tree.customProvider");
  const providerBadgeLabel = compactProviderBadgeLabel(providerName);
  const providerVendor = inferVendor(badge.vendorHint) ?? inferVendor(badge.providerName);

  return (
    <span
      className="ui-tree-meta-chip ui-tree-provider-chip inline-flex max-w-[64px] shrink-0 items-center gap-0.5 truncate rounded-full px-1 py-0.5 text-[10px] leading-none"
      title={t("sidebar.tree.providerBadge", { name: providerName })}
      aria-label={t("sidebar.tree.providerBadge", { name: providerName })}
    >
      {providerVendor && <VendorIcon vendor={providerVendor} size={9} />}
      <span className="truncate">{providerBadgeLabel}</span>
    </span>
  );
}

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
      onPointerDown={(e) => e.stopPropagation()}
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
  const itemId = node.type === "group" ? node.group.id : node.type === "project" ? node.project.id : `wt:${node.worktree.id}`;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: itemId, disabled: !sortableEnabled || node.type === "worktree" });
  const sortableStyle = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 };
  const compact = density === "compact";
  const indentBase = compact ? 6 : 8;
  const indentStep = compact ? 14 : 16;
  const paddingLeft = indentBase + depth * indentStep;

  if (node.type === "worktree") {
    const { project, worktree } = node;
    const treeKey = `wt:${worktree.id}`;
    const isSelected = actions.selectedId === worktree.id;
    const providerBadge = actions.providerBadges[`wt:${worktree.id}`];

    return (
      <div
        ref={setNodeRef}
        style={{ ...sortableStyle }}
        {...attributes}
        role="treeitem"
        data-tree-key={treeKey}
        aria-level={depth + 1}
        aria-selected={isSelected}
        tabIndex={focusedNodeKey === treeKey ? 0 : -1}
        onFocus={() => onFocusNode(treeKey)}
      >
        <div
          className={`ui-tree-node ui-tree-project ui-focus-ring flex items-center rounded-xl cursor-pointer group/item ${
            compact ? "gap-1.5 py-1 text-[12px]" : "gap-2 py-1.5 text-[13px]"
          }`}
          data-selected={isSelected ? "true" : "false"}
          data-status="idle"
          data-invalid={worktree.status === "missing" ? "true" : "false"}
          style={{ paddingLeft, paddingRight: compact ? 8 : 10 }}
          onClick={() => actions.onSelectWorktree(worktree)}
          onDoubleClick={() => actions.onOpenWorktree(project, worktree)}
          onContextMenu={(e) => actions.onContextMenuWorktree(e, project, worktree)}
        >
          <span className="ui-tree-leading-icon ui-worktree-tree-icon" title={worktree.branch}>
            <WorktreeIcon className="h-4 w-4" />
          </span>
          <span className="flex min-w-0 flex-1 items-center gap-1.5" title={`${worktree.branch}\n${worktree.path}`}>
            <span className="block truncate font-medium">{worktree.name}</span>
            <span
              className="ui-worktree-short-chip inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[10px] leading-none"
              title={worktree.branch}
              aria-label={worktree.branch}
            >
              WT
            </span>
            {providerBadge && <ProviderBadgeChip badge={providerBadge} />}
          </span>
          {worktree.status === "missing" && (
            <span
              className="ui-tree-warning-chip inline-flex shrink-0 items-center justify-center rounded-full"
              title={t("worktree.status.missing")}
              aria-label={t("worktree.status.missing")}
            >
              <AlertTriangle size={12} strokeWidth={1.5} />
            </span>
          )}
          <span
            className="ui-tree-item-actions hidden shrink-0 items-center gap-0.5 group-hover/item:flex group-focus-within/item:flex"
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={(e) => {
                e.stopPropagation();
                actions.onOpenWorktree(project, worktree);
              }}
              className="icon-btn"
              style={{ color: "var(--success)", opacity: 0.7 }}
              title={t("worktree.menu.open")}
            >
              <Play size={14} strokeWidth={1.5} />
            </button>
          </span>
        </div>
      </div>
    );
  }

  if (node.type === "project") {
    const p = node.project;
    const treeKey = `p:${p.id}`;
    const isSelected = actions.selectedId === p.id;
    const isMultiSelected = actions.selectedProjectIds.has(p.id);
    const status = actions.getProjectStatus(p.id);
    const terminalCount = actions.getProjectTerminalCount(p.id);
    const pathInvalid = actions.isPathInvalid(p.id);
    const cliVendor = p.cli_tool ? inferVendor(p.cli_tool) : null;
    const projectWorktrees = node.worktrees ?? [];
    const hasWorktrees = projectWorktrees.length > 0;
    const providerBadge = actions.providerBadges[p.id];
    const worktreeCollapseKey = worktreeListCollapseId(p.id);
    const worktreesOpen = forceExpanded || !actions.collapsedIds.has(worktreeCollapseKey);

    if (actions.renamingProjectId === p.id) {
      return (
        <div
          ref={setNodeRef}
          style={{ ...sortableStyle }}
          {...attributes}
          role="treeitem"
          data-tree-key={treeKey}
          aria-level={depth + 1}
          aria-expanded={hasWorktrees ? worktreesOpen : undefined}
          aria-selected={isSelected || isMultiSelected}
          tabIndex={focusedNodeKey === treeKey ? 0 : -1}
          onFocus={() => onFocusNode(treeKey)}
        >
          <div
            className={`ui-tree-node ui-tree-project ui-focus-ring flex items-center rounded-xl ${
              compact ? "gap-1.5 py-1 text-[12px]" : "gap-2 py-1.5 text-[13px]"
            }`}
            data-selected={isSelected || isMultiSelected ? "true" : "false"}
            data-status={status ?? "idle"}
            data-invalid={pathInvalid ? "true" : "false"}
            style={{ paddingLeft, paddingRight: compact ? 8 : 10 }}
          >
            <span className="ui-tree-leading-icon">
              {cliVendor ? (
                <VendorIcon vendor={cliVendor} size={14} />
              ) : (
                <Terminal size={14} strokeWidth={1.5} />
              )}
            </span>
            <InlineRename initial={p.name} onConfirm={(name) => actions.onProjectRenameConfirm(p.id, name)} onCancel={actions.onCancelProjectRename} />
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
        aria-expanded={hasWorktrees ? worktreesOpen : undefined}
        aria-selected={isSelected || isMultiSelected}
        tabIndex={focusedNodeKey === treeKey ? 0 : -1}
        onPointerDownCapture={preventSecondaryPointerFocus}
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
          onMouseDown={(e) => {
            if (e.button === 2) e.preventDefault();
          }}
          onClick={(e) => actions.onSelectProject(e, p)}
          onDoubleClick={() => actions.onOpenProject(p)}
          onContextMenu={(e) => actions.onContextMenuProject(e, p)}
          {...listeners}
        >
          {hasWorktrees && (
            <button
              type="button"
              className="ui-tree-chevron inline-flex items-center justify-center"
              aria-label={worktreesOpen ? t("sidebar.tree.collapseWorktrees") : t("sidebar.tree.expandWorktrees")}
              title={worktreesOpen ? t("sidebar.tree.collapseWorktrees") : t("sidebar.tree.expandWorktrees")}
              onPointerDownCapture={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                if (!forceExpanded) actions.toggleCollapsed(worktreeCollapseKey);
              }}
            >
              <ChevronRight
                size={12}
                strokeWidth={2}
                style={{ transition: "transform 150ms", transform: worktreesOpen ? "rotate(90deg)" : "rotate(0)" }}
              />
            </button>
          )}
          <span className="ui-tree-leading-icon">
            {cliVendor ? (
              <VendorIcon vendor={cliVendor} size={14} />
            ) : (
              <Terminal size={14} strokeWidth={1.5} />
            )}
          </span>
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <span className="block truncate font-medium">{p.name}</span>
            {providerBadge && <ProviderBadgeChip badge={providerBadge} />}
            {terminalCount > 0 && (
              <span
                className="ui-tree-meta-chip inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[10px] leading-none"
                title={t("sidebar.tree.terminalCount", { count: terminalCount })}
                aria-label={t("sidebar.tree.terminalCount", { count: terminalCount })}
              >
                {terminalCount}
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
        {hasWorktrees && worktreesOpen && (
          <div className={`ui-worktree-children ${compact ? "space-y-0.5" : "space-y-0.5"}`} role="group">
            {projectWorktrees.map((worktree) => (
              <TreeNodeItem
                key={`wt:${worktree.id}`}
                node={{ type: "worktree", project: p, worktree }}
                depth={depth + 1}
                density={density}
                focusedNodeKey={focusedNodeKey}
                onFocusNode={onFocusNode}
                forceExpanded={forceExpanded}
                sortableEnabled={false}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  const g = node.group;
  const treeKey = `g:${g.id}`;
  const isOpen = forceExpanded || !actions.collapsedIds.has(g.id);
  const isSelected =
    actions.projectScopedTerminalViewEnabled &&
    actions.terminalScope.kind === "group" &&
    actions.terminalScope.groupId === g.id;
  const isMultiSelected = actions.selectedGroupIds.has(g.id);
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
      aria-selected={isSelected || isMultiSelected}
      tabIndex={focusedNodeKey === treeKey ? 0 : -1}
      onPointerDownCapture={preventSecondaryPointerFocus}
      onFocus={() => onFocusNode(treeKey)}
    >
      <div className={`ui-tree-group-shell ${compact ? "my-0.5" : "my-1"}`} style={{ marginLeft: depth === 0 ? 0 : 2 }}>
        <div
          ref={setIntoRef}
          className={`ui-tree-node ui-tree-group ui-focus-ring flex items-center rounded-xl font-semibold cursor-pointer group/grp ${
            compact ? "gap-1.5 py-1 text-[11px]" : "gap-2 py-1.5 text-[12px]"
          }`}
          data-selected={isSelected || isMultiSelected ? "true" : "false"}
          data-open={isOpen ? "true" : "false"}
          data-drop-target={isOverInto ? "true" : "false"}
          style={{ paddingLeft, paddingRight: compact ? 8 : 10, color: "var(--text-secondary)" }}
          onMouseDown={(e) => {
            if (e.button === 2) e.preventDefault();
          }}
          onClick={(e) => actions.onSelectGroup(e, g.id, forceExpanded)}
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
              <SortableContext items={node.children.map((c) => c.type === "group" ? c.group.id : c.type === "project" ? c.project.id : `wt:${c.worktree.id}`)} strategy={verticalListSortingStrategy}>
                <div className={`${compact ? "ml-2 space-y-0.5 pb-0.5" : "ml-2.5 space-y-0.5 pb-1"}`}>
                  {node.children.map((child) => (
                    <TreeNodeItem
                      key={child.type === "group" ? `g:${child.group.id}` : child.type === "project" ? `p:${child.project.id}` : `wt:${child.worktree.id}`}
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
