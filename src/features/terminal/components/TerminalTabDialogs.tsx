import { useCallback, useState, type CSSProperties, type ReactNode } from "react";
import { useI18n } from "../../../lib/i18n";
import { Terminal, X, ChevronRight, Folder, Check } from "../../../components/icons";
import { VendorIcon, inferVendor } from "../../../components/VendorIcon";
import type { Project, TreeNode } from "../../../lib/types";
import { Popover, PopoverAnchor, PopoverContent } from "../../../components/ui/popover";
import { Button } from "../../../components/ui/button";
import { type SplitPickerState, type TerminalCloseConfirmState } from "../lib/terminalTabsModel";

export interface SplitProjectPickerProps {
  picker: SplitPickerState;
  tree: TreeNode[];
  menuStyle: CSSProperties;
  onSelectEmpty: () => void;
  onSelectProject: (project: Project) => void;
  onClose: () => void;
  shouldIgnoreOutsideInteraction: () => boolean;
}

export function SplitProjectPicker({ picker, tree, menuStyle, onSelectEmpty, onSelectProject, onClose, shouldIgnoreOutsideInteraction }: SplitProjectPickerProps) {
  const { t } = useI18n();
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<Set<string>>(new Set());

  const toggleGroup = useCallback((groupId: string) => {
    setCollapsedGroupIds((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }, []);

  const renderTreeNode = useCallback((node: TreeNode, depth: number): ReactNode => {
    if (node.type === "project") {
      const project = node.project;
      const cliVendor = project.cli_tool ? inferVendor(project.cli_tool) : null;
      return (
        <button
          key={`p:${project.id}`}
          type="button"
          onClick={() => onSelectProject(project)}
          className="ui-tree-node ui-tree-project ui-split-project-picker-item ui-focus-ring flex w-full cursor-pointer items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-[13px]"
          style={{ paddingLeft: 10 + depth * 16 }}
          title={project.path}
        >
          <span className="ui-tree-leading-icon">
            {cliVendor ? (
              <VendorIcon vendor={cliVendor} size={14} />
            ) : (
              <Terminal size={14} strokeWidth={1.5} />
            )}
          </span>
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <span className="block min-w-0 truncate font-medium">{project.name}</span>
            {project.cli_tool && (
              <span className="ui-tree-meta-chip ui-split-project-picker-chip inline-flex max-w-24 shrink-0 items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-tight">
                <span className="min-w-0 truncate">{project.cli_tool}</span>
              </span>
            )}
          </span>
        </button>
      );
    }

    if (node.type === "worktree") {
      return null;
    }

    const group = node.group;
    const isOpen = !collapsedGroupIds.has(group.id);
    return (
      <div key={`g:${group.id}`}>
        <button
          type="button"
          onClick={() => toggleGroup(group.id)}
          className="ui-tree-node ui-tree-group ui-split-project-picker-item ui-focus-ring flex w-full cursor-pointer items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-[13px] font-semibold"
          style={{ paddingLeft: 10 + depth * 16 }}
        >
          <span className="ui-tree-chevron inline-flex items-center justify-center">
            <ChevronRight size={12} strokeWidth={2} style={{ transition: "transform 150ms", transform: isOpen ? "rotate(90deg)" : "rotate(0)" }} />
          </span>
          <span className="ui-tree-leading-icon"><Folder size={16} strokeWidth={1.5} /></span>
          <span className="flex-1 truncate">{group.name}</span>
        </button>
        {isOpen && node.children.length > 0 && (
          <div className="space-y-0.5">
            {node.children.map((child) => renderTreeNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  }, [collapsedGroupIds, onSelectProject, toggleGroup]);

  const anchorStyle: CSSProperties = picker
    ? { position: "fixed", left: picker.x, top: picker.y, width: 1, height: 1 }
    : { position: "fixed", left: 0, top: 0, width: 1, height: 1 };

  return (
    <Popover open={picker !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <PopoverAnchor asChild>
        <span className="pointer-events-none" style={anchorStyle} aria-hidden="true" />
      </PopoverAnchor>
      <PopoverContent
        align={picker?.align ?? "start"}
        className="ui-split-project-picker w-80 p-2"
        style={menuStyle}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onInteractOutside={(event) => {
          if (shouldIgnoreOutsideInteraction()) event.preventDefault();
        }}
      >
        <div className="ui-split-project-picker-title px-2 py-1 text-xs font-semibold">{t("terminal.split.selectTerminal")}</div>
        <button
          type="button"
          onClick={onSelectEmpty}
          className="ui-tree-node ui-tree-project ui-split-project-picker-item ui-focus-ring mt-1 flex w-full cursor-pointer items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-[13px]"
        >
          <span className="ui-tree-leading-icon"><Terminal size={14} strokeWidth={1.5} /></span>
          <span className="min-w-0 flex-1 truncate font-medium">{t("terminal.tab.emptyTerminal")}</span>
        </button>
        <div className="mt-1 max-h-72 space-y-0.5 overflow-y-auto">
          {tree.map((node) => renderTreeNode(node, 0))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function TerminalCloseConfirmBubble({
  confirm,
  menuStyle,
  onConfirm,
  onClose,
  shouldIgnoreOutsideInteraction,
}: {
  confirm: TerminalCloseConfirmState;
  menuStyle: CSSProperties;
  onConfirm: () => void;
  onClose: () => void;
  shouldIgnoreOutsideInteraction: () => boolean;
}) {
  const { t } = useI18n();
  const anchorStyle: CSSProperties = confirm
    ? { position: "fixed", left: confirm.x, top: confirm.y, width: 1, height: 1 }
    : { position: "fixed", left: 0, top: 0, width: 1, height: 1 };

  return (
    <Popover open={confirm !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <PopoverAnchor asChild>
        <span className="pointer-events-none" style={anchorStyle} aria-hidden="true" />
      </PopoverAnchor>
      <PopoverContent
        align={confirm?.align ?? "end"}
        collisionPadding={8}
        className="terminal-skin w-auto p-1.5"
        style={menuStyle}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onInteractOutside={(event) => {
          if (shouldIgnoreOutsideInteraction()) event.preventDefault();
        }}
      >
        <div className="flex items-center gap-1">
          <Button size="icon" variant="ghost" className="h-6 w-6" onClick={onClose} aria-label={t("terminal.close.cancel")} title={t("terminal.close.cancel")}>
            <X size={13} strokeWidth={2.2} aria-hidden="true" />
          </Button>
          <Button
            size="sm"
            variant="destructive"
            className="h-6 px-1.5 text-[11px]"
            onClick={onConfirm}
            aria-label={t("terminal.close.confirm")}
            title={t("terminal.close.confirm")}
          >
            <Check size={12} strokeWidth={2.2} aria-hidden="true" />
            <span>{t("common.close")}</span>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
