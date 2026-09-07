import { useI18n } from "../../lib/i18n";
import type { ActiveProjectFile } from "../../stores/fileExplorerStore";
import {
  useGitDiffWorkspaceStore,
  type GitDiffWorkspaceContext,
  type GitDiffWorkspaceTab,
  type ProjectGitDiffWorkspace,
} from "../../stores/gitDiffWorkspaceStore";
import { X } from "../icons";
import { GitDiffEditorTabs } from "../git/diff/GitDiffEditorTabs";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "../ui/context-menu";

interface FileEditorTabsProps {
  files: ActiveProjectFile[];
  activeFilePath: string | null;
  activeDiff: GitDiffWorkspaceTab | null;
  diffContext: GitDiffWorkspaceContext | null;
  diffWorkspace: ProjectGitDiffWorkspace;
  onActivateFile: (path: string) => void;
  onCloseFiles: (paths: string[]) => void;
}

export function FileEditorTabs({
  files,
  activeFilePath,
  activeDiff,
  diffContext,
  diffWorkspace,
  onActivateFile,
  onCloseFiles,
}: FileEditorTabsProps) {
  const { t } = useI18n();
  const activateDiffTab = useGitDiffWorkspaceStore((state) => state.activateTab);
  if (files.length === 0 && diffWorkspace.tabs.length === 0) return null;

  return (
    <div className="ui-file-editor-tabs flex h-8 shrink-0 items-center overflow-x-auto border-b border-border bg-surface-container-lowest px-1">
      {files.map((file, index) => {
        const active = !activeDiff && file.path === activeFilePath;
        const dirty = file.content !== file.savedContent;
        const otherPaths = files.filter((item) => item.path !== file.path).map((item) => item.path);
        const leftPaths = files.slice(0, index).map((item) => item.path);
        const rightPaths = files.slice(index + 1).map((item) => item.path);
        return (
          <ContextMenu key={file.path}>
            <ContextMenuTrigger asChild>
              <div
                className="ui-file-editor-tab group flex h-7 max-w-[180px] shrink-0 items-center rounded-t text-[11px] text-on-surface-variant hover:bg-surface-container-high"
                data-active={active ? "true" : "false"}
                style={active ? { background: "var(--surface-container)", color: "var(--on-surface)" } : undefined}
                title={file.path}
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate px-2 text-left"
                  onClick={() => {
                    if (diffContext) activateDiffTab(diffContext.key, null);
                    onActivateFile(file.path);
                  }}
                >
                  {file.name}{dirty ? " *" : ""}
                </button>
                <button
                  type="button"
                  className="mr-1 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded opacity-70 hover:bg-surface-container-highest hover:opacity-100"
                  aria-label={t("files.editor.closeNamed", { name: file.name })}
                  onClick={(event) => {
                    event.stopPropagation();
                    onCloseFiles([file.path]);
                  }}
                >
                  <X size={11} />
                </button>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent className="terminal-skin ui-file-editor-tab-menu">
              <ContextMenuItem onSelect={() => onCloseFiles([file.path])}>{t("files.editor.closeCurrent")}</ContextMenuItem>
              <ContextMenuItem disabled={otherPaths.length === 0} onSelect={() => onCloseFiles(otherPaths)}>{t("files.editor.closeOthers")}</ContextMenuItem>
              <ContextMenuItem disabled={leftPaths.length === 0} onSelect={() => onCloseFiles(leftPaths)}>{t("files.editor.closeLeft")}</ContextMenuItem>
              <ContextMenuItem disabled={rightPaths.length === 0} onSelect={() => onCloseFiles(rightPaths)}>{t("files.editor.closeRight")}</ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        );
      })}
      {diffContext && (
        <GitDiffEditorTabs
          workspaceKey={diffContext.key}
          tabs={diffWorkspace.tabs}
          activeId={diffWorkspace.activeId}
        />
      )}
    </div>
  );
}
