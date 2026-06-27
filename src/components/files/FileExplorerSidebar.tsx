import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { getMaterialFileIcon, getMaterialFolderIcon } from "@baybreezy/file-extension-icon";
import { copyAiText } from "../../lib/aiClipboard";
import { formatAiPathBlock, formatAiRootTree, formatAiTree, formatTerminalDragPath, TERMINAL_FILE_PATH_MIME } from "../../lib/aiPathFormatter";
import { useI18n, type TranslationKey } from "../../lib/i18n";
import { beginTerminalFileDrag, endTerminalFileDrag } from "../../lib/terminalFileDrag";
import type { GitFileChange, ProjectFileContentMatch, ProjectFileEntry, ProjectFileSearchMode } from "../../lib/types";
import { isDefaultCollapsedDirectoryName, useFileExplorerStore } from "../../stores/fileExplorerStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { STATUS_CONFIG } from "../git/GitStatusIcon";
import { ConfirmDialog } from "../ConfirmDialog";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "../ui/dialog";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "../ui/context-menu";
import { ChevronRight, Copy, File, FileCode, Folder, FolderPlus, Pencil, RefreshCw, Search, Trash2, X } from "../icons";
import { TERM } from "../stats/termStatsUi";

interface FileExplorerSidebarProps {
  mode?: "sidebar" | "panel";
  onClosePanel?: () => void;
  onBackToProjects?: () => void;
}

type InputAction =
  | { kind: "create-file"; parentPath: string }
  | { kind: "create-dir"; parentPath: string }
  | { kind: "rename"; path: string; currentName: string };

type RenameAction = Extract<InputAction, { kind: "rename" }>;

type ConfirmAction =
  | { kind: "delete"; path: string; name: string }
  | { kind: "overwrite-create"; action: InputAction; value: string }
  | { kind: "overwrite-paste"; targetParentPath: string };

type FileDisplayStatus =
  | { kind: "editing"; label: string; color: string }
  | { kind: "git"; label: string; color: string };

type DraggedFileEntry = Pick<ProjectFileEntry, "kind" | "name" | "path">;
type Translate = ReturnType<typeof useI18n>["t"];

const FILE_EXPLORER_ENTRY_MIME = "application/x-cli-manager-file-entry";

interface AutoCollapseGroupState {
  expandedGroupPaths: Set<string>;
  ignoredPaths: Set<string>;
  toggleGroup: (parentPath: string) => void;
  ignorePath: (path: string) => void;
  unignorePath: (path: string) => void;
}

const GIT_STATUS_LABELS: Record<GitFileChange["status"], TranslationKey> = {
  M: "files.status.modified",
  A: "files.status.added",
  D: "files.status.deleted",
  R: "files.status.renamed",
  C: "files.status.conflict",
  U: "files.status.untracked",
  "??": "files.status.untracked",
};

const SEARCH_MODES: Array<{ value: ProjectFileSearchMode; labelKey: TranslationKey }> = [
  { value: "files", labelKey: "files.search.modeFiles" },
  { value: "content", labelKey: "files.search.modeCode" },
];

function makeGitDisplayStatus(change: GitFileChange, t: Translate): FileDisplayStatus {
  const config = STATUS_CONFIG[change.status] ?? STATUS_CONFIG.M;
  return {
    kind: "git",
    label: t(GIT_STATUS_LABELS[change.status]),
    color: config.color,
  };
}

function collectCompactDirectoryChain(entry: ProjectFileEntry): {
  suffixParts: string[];
  leaf: ProjectFileEntry;
  chainPaths: string[];
} {
  const suffixParts: string[] = [];
  let leaf = entry;
  const chainPaths = [entry.path];

  while (
    leaf.kind === "directory"
    && leaf.children?.length === 1
    && leaf.children[0].kind === "directory"
    && !isDefaultCollapsedDirectoryName(leaf.children[0].name)
  ) {
    const next = leaf.children[0];
    suffixParts.push(next.name);
    chainPaths.push(next.path);
    leaf = next;
  }

  return { suffixParts, leaf, chainPaths };
}

function splitAutoCollapsedEntries(entries: ProjectFileEntry[], ignoredPaths: Set<string>): {
  normalEntries: ProjectFileEntry[];
  collapsedEntries: ProjectFileEntry[];
} {
  const normalEntries: ProjectFileEntry[] = [];
  const collapsedEntries: ProjectFileEntry[] = [];

  for (const entry of entries) {
    if (entry.kind === "directory" && (isDefaultCollapsedDirectoryName(entry.name) || ignoredPaths.has(entry.path))) {
      collapsedEntries.push(entry);
    } else {
      normalEntries.push(entry);
    }
  }

  return { normalEntries, collapsedEntries };
}

function collectAutoCollapsedEntries(entries: ProjectFileEntry[], ignoredPaths: Set<string>): ProjectFileEntry[] {
  const result: ProjectFileEntry[] = [];

  const walk = (items: ProjectFileEntry[]) => {
    const { normalEntries, collapsedEntries } = splitAutoCollapsedEntries(items, ignoredPaths);
    result.push(...collapsedEntries);

    for (const entry of normalEntries) {
      if (entry.kind === "directory" && entry.children) {
        walk(entry.children);
      }
    }
  };

  walk(entries);
  return result;
}

function parentPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

function isSameOrChildPath(path: string, targetPath: string): boolean {
  if (!targetPath) return path === targetPath;
  return path === targetPath || path.startsWith(`${targetPath}/`);
}

function hasFileExplorerDrag(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(FILE_EXPLORER_ENTRY_MIME);
}

function readDraggedFileEntry(dataTransfer: DataTransfer): DraggedFileEntry | null {
  try {
    const raw = dataTransfer.getData(FILE_EXPLORER_ENTRY_MIME);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<DraggedFileEntry>;
    if (
      (value.kind === "file" || value.kind === "directory")
      && typeof value.name === "string"
      && typeof value.path === "string"
    ) {
      return { kind: value.kind, name: value.name, path: value.path };
    }
  } catch {
    return null;
  }
  return null;
}

function canMoveDraggedEntry(source: DraggedFileEntry, targetParentPath: string): boolean {
  if (parentPath(source.path) === targetParentPath) return false;
  if (source.kind === "directory" && isSameOrChildPath(targetParentPath, source.path)) return false;
  return true;
}

function InlineRenameInput({
  initialName,
  onSubmit,
  onCancel,
}: {
  initialName: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialName);
  const inputRef = useRef<HTMLInputElement>(null);
  const finishedRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const cancel = () => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    onCancel();
  };

  const submit = () => {
    if (finishedRef.current) return;
    const trimmed = value.trim();
    if (!trimmed || trimmed === initialName) {
      cancel();
      return;
    }
    finishedRef.current = true;
    onSubmit(trimmed);
  };

  return (
    <input
      ref={inputRef}
      value={value}
      className="ui-focus-ring h-6 min-w-0 flex-1 rounded border border-primary/60 bg-surface-container-lowest px-2 text-[12px] text-on-surface outline-none"
      onChange={(event) => setValue(event.currentTarget.value)}
      onBlur={submit}
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          submit();
        }
        if (event.key === "Escape") {
          event.preventDefault();
          cancel();
        }
      }}
    />
  );
}

function AutoCollapsedGroupRow({
  depth,
  count,
  isOpen,
  onToggle,
}: {
  depth: number;
  count: number;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className="ui-file-tree-row flex w-full items-center gap-1.5 rounded px-1 py-1 text-left text-[12px] text-text-muted"
      style={{ paddingLeft: 8 + depth * 14 }}
      title={isOpen ? t("files.autoCollapse.collapse") : t("files.autoCollapse.expand")}
      onClick={onToggle}
    >
      <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center">
        <ChevronRight size={12} style={{ transform: isOpen ? "rotate(90deg)" : "rotate(0deg)" }} />
      </span>
      <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center">
        <Folder size={14} />
      </span>
      <span className="min-w-0 flex-1 truncate">{t("files.autoCollapse.count", { count })}</span>
    </button>
  );
}

function FileNode({
  entry,
  depth,
  getDisplayStatus,
  onOpenFile,
  onInput,
  onConfirm,
  renamingPath,
  onRenameSubmit,
  onRenameCancel,
  onFileKeyDown,
  onFileDragStart,
  onFileDragEnd,
  onFileDragOver,
  onFileDrop,
  autoCollapseGroups,
}: {
  entry: ProjectFileEntry;
  depth: number;
  getDisplayStatus: (entry: ProjectFileEntry) => FileDisplayStatus | null;
  onOpenFile: (entry: ProjectFileEntry) => void;
  onInput: (action: InputAction) => void;
  onConfirm: (action: ConfirmAction) => void;
  renamingPath: string | null;
  onRenameSubmit: (action: RenameAction, value: string) => void;
  onRenameCancel: () => void;
  onFileKeyDown: (event: ReactKeyboardEvent<HTMLElement>, entry: ProjectFileEntry) => void;
  onFileDragStart: (event: ReactDragEvent<HTMLElement>, entry: ProjectFileEntry) => void;
  onFileDragEnd: () => void;
  onFileDragOver: (event: ReactDragEvent<HTMLElement>, targetEntry: ProjectFileEntry) => void;
  onFileDrop: (event: ReactDragEvent<HTMLElement>, targetEntry: ProjectFileEntry) => void;
  autoCollapseGroups: AutoCollapseGroupState;
}) {
  const { t } = useI18n();
  const project = useFileExplorerStore((s) => s.project);
  const expandedPaths = useFileExplorerStore((s) => s.expandedPaths);
  const toggleDir = useFileExplorerStore((s) => s.toggleDir);
  const expandCompactDirChain = useFileExplorerStore((s) => s.expandCompactDirChain);
  const collapseDir = useFileExplorerStore((s) => s.collapseDir);
  const setClipboard = useFileExplorerStore((s) => s.setClipboard);
  const pasteInto = useFileExplorerStore((s) => s.pasteInto);
  const clipboard = useFileExplorerStore((s) => s.clipboard);
  const activePath = useFileExplorerStore((s) => s.activeFile?.path ?? null);
  const isDir = entry.kind === "directory";
  const { suffixParts, leaf: displayEntry, chainPaths } = isDir
    ? collectCompactDirectoryChain(entry)
    : { suffixParts: [], leaf: entry, chainPaths: [entry.path] };
  const isOpen = isDir && expandedPaths.has(displayEntry.path);
  const isChainExpanded = isDir && chainPaths.some((path) => expandedPaths.has(path));
  const isManuallyIgnored = isDir && autoCollapseGroups.ignoredPaths.has(entry.path);
  const icon = isDir ? getMaterialFolderIcon(entry.name, isOpen) : getMaterialFileIcon(entry.name);
  const paddingLeft = 8 + depth * 14;
  const displayStatus = getDisplayStatus(displayEntry);
  const isRenaming = renamingPath === displayEntry.path;

  const paste = async () => {
    try {
      await pasteInto(displayEntry.path, false);
    } catch (err) {
      if (String(err).includes("target_exists")) {
        onConfirm({ kind: "overwrite-paste", targetParentPath: displayEntry.path });
        return;
      }
      throw err;
    }
  };

  const toggleDirectory = () => {
    if (!isDir) return;
    if (isOpen) {
      if (chainPaths.length > 1) {
        collapseDir(entry.path);
      } else {
        void toggleDir(displayEntry.path);
      }
      return;
    }
    void expandCompactDirChain(entry.path);
  };

  const childRows = isDir && isOpen && displayEntry.children ? (
    <FileTreeRows
      entries={displayEntry.children}
      parentPath={displayEntry.path}
      depth={depth + 1}
      getDisplayStatus={getDisplayStatus}
      onOpenFile={onOpenFile}
      onInput={onInput}
      onConfirm={onConfirm}
      renamingPath={renamingPath}
      onRenameSubmit={onRenameSubmit}
      onRenameCancel={onRenameCancel}
      onFileKeyDown={onFileKeyDown}
      onFileDragStart={onFileDragStart}
      onFileDragEnd={onFileDragEnd}
      onFileDragOver={onFileDragOver}
      onFileDrop={onFileDrop}
      autoCollapseGroups={autoCollapseGroups}
      renderAutoCollapsedGroup={false}
    />
  ) : null;

  if (isRenaming) {
    return (
      <div>
        <div
          className="ui-file-tree-row flex w-full items-center gap-1.5 rounded px-1 py-1 text-left text-[12px]"
          data-selected={activePath === displayEntry.path ? "true" : "false"}
          style={{ paddingLeft }}
          title={displayEntry.path}
        >
          <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-text-muted">
            {isDir ? (
              <ChevronRight size={12} style={{ transform: isOpen ? "rotate(90deg)" : "rotate(0deg)" }} />
            ) : null}
          </span>
          <img src={icon} alt="" width={16} height={16} className="shrink-0" />
          <InlineRenameInput
            initialName={displayEntry.name}
            onSubmit={(value) => onRenameSubmit({ kind: "rename", path: displayEntry.path, currentName: displayEntry.name }, value)}
            onCancel={onRenameCancel}
          />
        </div>
        {childRows}
      </div>
    );
  }

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            role="button"
            tabIndex={0}
            className="ui-file-tree-row flex w-full items-center gap-1.5 rounded px-1 py-1 text-left text-[12px]"
            data-selected={activePath === displayEntry.path ? "true" : "false"}
            draggable
            style={{ paddingLeft }}
            title={displayStatus ? `${displayEntry.path} · ${displayStatus.label}` : displayEntry.path}
            onContextMenu={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              onFileKeyDown(event, displayEntry);
              if (event.defaultPrevented) return;
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              if (isDir) toggleDirectory();
              else onOpenFile(displayEntry);
            }}
            onDragStart={(event) => onFileDragStart(event, displayEntry)}
            onDragEnd={onFileDragEnd}
            onDragOver={(event) => onFileDragOver(event, displayEntry)}
            onDrop={(event) => onFileDrop(event, displayEntry)}
            onClick={() => {
              if (isDir) toggleDirectory();
              else onOpenFile(displayEntry);
            }}
          >
            <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-text-muted">
              {isDir ? (
                <ChevronRight size={12} style={{ transform: isOpen ? "rotate(90deg)" : "rotate(0deg)" }} />
              ) : null}
            </span>
            <img src={icon} alt="" width={16} height={16} className="shrink-0" draggable={false} />
            <span
              className="flex min-w-0 flex-1 items-baseline gap-0.5 truncate"
              style={displayStatus ? { color: displayStatus.color } : undefined}
            >
              <span className="truncate">{entry.name}</span>
              {suffixParts.length > 0 && (
                <span className="truncate text-[11px] font-normal text-text-muted">
                  /{suffixParts.join("/")}
                </span>
              )}
            </span>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {isDir && (
            <>
              <ContextMenuItem onSelect={() => onInput({ kind: "create-file", parentPath: displayEntry.path })}>
                <File size={13} /> {t("files.menu.newFile")}
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => onInput({ kind: "create-dir", parentPath: displayEntry.path })}>
                <FolderPlus size={13} /> {t("files.menu.newFolder")}
              </ContextMenuItem>
              <ContextMenuItem disabled={!clipboard} onSelect={() => void paste()}>
                <Copy size={13} /> {t("files.menu.paste")}
              </ContextMenuItem>
              {isManuallyIgnored ? (
                <ContextMenuItem onSelect={() => autoCollapseGroups.unignorePath(entry.path)}>
                  <X size={13} /> {t("files.menu.unignore")}
                </ContextMenuItem>
              ) : (
                <ContextMenuItem onSelect={() => {
                  autoCollapseGroups.ignorePath(entry.path);
                  if (isChainExpanded) collapseDir(entry.path);
                }}>
                  <ChevronRight size={13} /> {t("files.menu.ignore")}
                </ContextMenuItem>
              )}
              <ContextMenuSeparator />
            </>
          )}
          <ContextMenuItem onSelect={() => onInput({ kind: "rename", path: displayEntry.path, currentName: displayEntry.name })}>
            <Pencil size={13} /> {t("files.menu.rename")}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => setClipboard({ mode: "copy", path: displayEntry.path, name: displayEntry.name })}>
            <Copy size={13} /> {t("files.menu.copy")}
          </ContextMenuItem>
          {project && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => void copyAiText(formatAiPathBlock(project, displayEntry.path, displayEntry.kind), t("files.toast.aiPathCopied"))}>
                <Copy size={13} /> {t("files.menu.copyAiPath")}
              </ContextMenuItem>
              {isDir && (
                <ContextMenuItem onSelect={() => void copyAiText(formatAiTree(project, displayEntry), t("files.toast.aiTreeCopied"))}>
                  <Folder size={13} /> {t("files.menu.copyAiTree")}
                </ContextMenuItem>
              )}
            </>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem danger onSelect={() => onConfirm({ kind: "delete", path: displayEntry.path, name: displayEntry.name })}>
            <Trash2 size={13} /> {t("files.menu.delete")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {childRows}
    </div>
  );
}

function FileTreeRows({
  entries,
  parentPath,
  depth,
  getDisplayStatus,
  onOpenFile,
  onInput,
  onConfirm,
  renamingPath,
  onRenameSubmit,
  onRenameCancel,
  onFileKeyDown,
  onFileDragStart,
  onFileDragEnd,
  onFileDragOver,
  onFileDrop,
  autoCollapseGroups,
  renderAutoCollapsedGroup,
}: {
  entries: ProjectFileEntry[];
  parentPath: string;
  depth: number;
  getDisplayStatus: (entry: ProjectFileEntry) => FileDisplayStatus | null;
  onOpenFile: (entry: ProjectFileEntry) => void;
  onInput: (action: InputAction) => void;
  onConfirm: (action: ConfirmAction) => void;
  renamingPath: string | null;
  onRenameSubmit: (action: RenameAction, value: string) => void;
  onRenameCancel: () => void;
  onFileKeyDown: (event: ReactKeyboardEvent<HTMLElement>, entry: ProjectFileEntry) => void;
  onFileDragStart: (event: ReactDragEvent<HTMLElement>, entry: ProjectFileEntry) => void;
  onFileDragEnd: () => void;
  onFileDragOver: (event: ReactDragEvent<HTMLElement>, targetEntry: ProjectFileEntry) => void;
  onFileDrop: (event: ReactDragEvent<HTMLElement>, targetEntry: ProjectFileEntry) => void;
  autoCollapseGroups: AutoCollapseGroupState;
  renderAutoCollapsedGroup: boolean;
}) {
  const { normalEntries } = splitAutoCollapsedEntries(entries, autoCollapseGroups.ignoredPaths);
  const collapsedEntries = renderAutoCollapsedGroup
    ? collectAutoCollapsedEntries(entries, autoCollapseGroups.ignoredPaths)
    : [];
  const groupOpen = autoCollapseGroups.expandedGroupPaths.has(parentPath);

  return (
    <div>
      {normalEntries.map((entry) => (
        <FileNode
          key={entry.path}
          entry={entry}
          depth={depth}
          getDisplayStatus={getDisplayStatus}
          onOpenFile={onOpenFile}
          onInput={onInput}
          onConfirm={onConfirm}
          renamingPath={renamingPath}
          onRenameSubmit={onRenameSubmit}
          onRenameCancel={onRenameCancel}
          onFileKeyDown={onFileKeyDown}
          onFileDragStart={onFileDragStart}
          onFileDragEnd={onFileDragEnd}
          onFileDragOver={onFileDragOver}
          onFileDrop={onFileDrop}
          autoCollapseGroups={autoCollapseGroups}
        />
      ))}
      {collapsedEntries.length > 0 && (
        <>
          <AutoCollapsedGroupRow
            depth={depth}
            count={collapsedEntries.length}
            isOpen={groupOpen}
            onToggle={() => autoCollapseGroups.toggleGroup(parentPath)}
          />
          {groupOpen && collapsedEntries.map((entry) => (
            <FileNode
              key={entry.path}
              entry={entry}
              depth={depth + 1}
              getDisplayStatus={getDisplayStatus}
              onOpenFile={onOpenFile}
              onInput={onInput}
              onConfirm={onConfirm}
              renamingPath={renamingPath}
              onRenameSubmit={onRenameSubmit}
              onRenameCancel={onRenameCancel}
              onFileKeyDown={onFileKeyDown}
              onFileDragStart={onFileDragStart}
              onFileDragEnd={onFileDragEnd}
              onFileDragOver={onFileDragOver}
              onFileDrop={onFileDrop}
              autoCollapseGroups={autoCollapseGroups}
            />
          ))}
        </>
      )}
    </div>
  );
}

export function FileExplorerSidebar({ mode = "sidebar", onClosePanel, onBackToProjects }: FileExplorerSidebarProps) {
  const { t } = useI18n();
  const project = useFileExplorerStore((s) => s.project);
  const tree = useFileExplorerStore((s) => s.tree);
  const searchMode = useFileExplorerStore((s) => s.searchMode);
  const searchQuery = useFileExplorerStore((s) => s.searchQuery);
  const searchResults = useFileExplorerStore((s) => s.searchResults);
  const contentSearchResults = useFileExplorerStore((s) => s.contentSearchResults);
  const searchLoading = useFileExplorerStore((s) => s.searchLoading);
  const activeFile = useFileExplorerStore((s) => s.activeFile);
  const openFiles = useFileExplorerStore((s) => s.openFiles);
  const gitChanges = useFileExplorerStore((s) => s.gitChanges);
  const clipboard = useFileExplorerStore((s) => s.clipboard);
  const closeProject = useFileExplorerStore((s) => s.closeProject);
  const refresh = useFileExplorerStore((s) => s.refresh);
  const setSearchMode = useFileExplorerStore((s) => s.setSearchMode);
  const setSearchQuery = useFileExplorerStore((s) => s.setSearchQuery);
  const openFile = useFileExplorerStore((s) => s.openFile);
  const openFileAtSearchMatch = useFileExplorerStore((s) => s.openFileAtSearchMatch);
  const openFileEditorPane = useTerminalStore((s) => s.openFileEditorPane);
  const createEntry = useFileExplorerStore((s) => s.createEntry);
  const renameEntry = useFileExplorerStore((s) => s.renameEntry);
  const deleteEntry = useFileExplorerStore((s) => s.deleteEntry);
  const pasteInto = useFileExplorerStore((s) => s.pasteInto);
  const setClipboard = useFileExplorerStore((s) => s.setClipboard);
  const fileExplorerIgnoredPaths = useSettingsStore((s) => s.fileExplorerIgnoredPaths);
  const updateSetting = useSettingsStore((s) => s.update);
  const [inputAction, setInputAction] = useState<InputAction | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [renamingAction, setRenamingAction] = useState<RenameAction | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [expandedAutoCollapseGroups, setExpandedAutoCollapseGroups] = useState<Set<string>>(new Set());

  useEffect(() => {
    setExpandedAutoCollapseGroups(new Set());
  }, [project?.id]);

  const hasSearchQuery = Boolean(searchQuery.trim());
  const visibleRows = hasSearchQuery && searchMode === "files" ? searchResults : tree;
  const gitChangeByPath = useMemo(() => new Map(gitChanges.map((change) => [change.path, change])), [gitChanges]);
  const dirtyFilePaths = useMemo(
    () => new Set(openFiles.filter((file) => file.content !== file.savedContent).map((file) => file.path)),
    [openFiles]
  );
  const ignoredPaths = useMemo(
    () => new Set(project ? fileExplorerIgnoredPaths[project.id] ?? [] : []),
    [fileExplorerIgnoredPaths, project]
  );

  const toggleAutoCollapseGroup = useCallback((parentPath: string) => {
    setExpandedAutoCollapseGroups((current) => {
      const next = new Set(current);
      if (next.has(parentPath)) {
        next.delete(parentPath);
      } else {
        next.add(parentPath);
      }
      return next;
    });
  }, []);

  const ignorePath = useCallback((path: string) => {
    if (!project) return;
    const current = useSettingsStore.getState().fileExplorerIgnoredPaths;
    const projectPaths = current[project.id] ?? [];
    if (projectPaths.includes(path)) return;
    void updateSetting("fileExplorerIgnoredPaths", {
      ...current,
      [project.id]: [...projectPaths, path],
    });
  }, [project, updateSetting]);

  const unignorePath = useCallback((path: string) => {
    if (!project) return;
    const current = useSettingsStore.getState().fileExplorerIgnoredPaths;
    const projectPaths = current[project.id] ?? [];
    if (!projectPaths.includes(path)) return;
    const nextPaths = projectPaths.filter((item) => item !== path);
    const next = { ...current };
    if (nextPaths.length > 0) {
      next[project.id] = nextPaths;
    } else {
      delete next[project.id];
    }
    void updateSetting("fileExplorerIgnoredPaths", next);
  }, [project, updateSetting]);

  const autoCollapseGroups = useMemo<AutoCollapseGroupState>(() => ({
    expandedGroupPaths: expandedAutoCollapseGroups,
    ignoredPaths,
    toggleGroup: toggleAutoCollapseGroup,
    ignorePath,
    unignorePath,
  }), [expandedAutoCollapseGroups, ignoredPaths, toggleAutoCollapseGroup, ignorePath, unignorePath]);

  const getDisplayStatus = useCallback((entry: ProjectFileEntry): FileDisplayStatus | null => {
    if (entry.kind !== "file") return null;
    if (dirtyFilePaths.has(entry.path)) {
      return { kind: "editing", label: t("files.status.editing"), color: "#7dcfff" };
    }
    const change = gitChangeByPath.get(entry.path);
    return change ? makeGitDisplayStatus(change, t) : null;
  }, [dirtyFilePaths, gitChangeByPath, t]);

  const openInput = (action: InputAction) => {
    if (action.kind === "rename") {
      setInputAction(null);
      setRenamingAction(action);
      return;
    }
    setInputAction(action);
    setInputValue("");
  };

  const cancelRename = useCallback(() => {
    setRenamingAction(null);
  }, []);

  const submitRename = useCallback(async (action: RenameAction, rawValue: string, overwrite = false) => {
    const value = rawValue.trim();
    if (!value || value === action.currentName) {
      setRenamingAction(null);
      return;
    }
    try {
      await renameEntry(action.path, value, overwrite);
      setRenamingAction(null);
    } catch (err) {
      if (String(err).includes("target_exists")) {
        setRenamingAction(null);
        setConfirmAction({ kind: "overwrite-create", action, value });
        return;
      }
      throw err;
    }
  }, [renameEntry]);

  const performInputAction = useCallback(async (action: InputAction, rawValue: string, overwrite = false) => {
    const value = rawValue.trim();
    if (!value) return;
    try {
      if (action.kind === "create-file") {
        await createEntry(action.parentPath, value, "file", overwrite);
      } else if (action.kind === "create-dir") {
        await createEntry(action.parentPath, value, "directory", overwrite);
      } else {
        await renameEntry(action.path, value, overwrite);
      }
      setInputAction(null);
      setInputValue("");
    } catch (err) {
      if (String(err).includes("target_exists")) {
        setConfirmAction({ kind: "overwrite-create", action, value });
        return;
      }
      throw err;
    }
  }, [createEntry, renameEntry]);

  const submitInput = useCallback(async (overwrite = false) => {
    if (!inputAction) return;
    await performInputAction(inputAction, inputValue, overwrite);
  }, [inputAction, inputValue, performInputAction]);

  const pasteIntoTarget = useCallback(async (targetParentPath: string) => {
    try {
      await pasteInto(targetParentPath, false);
    } catch (err) {
      if (String(err).includes("target_exists")) {
        setConfirmAction({ kind: "overwrite-paste", targetParentPath });
        return;
      }
      throw err;
    }
  }, [pasteInto]);

  const getPasteTargetPath = useCallback((entry: ProjectFileEntry) => (
    entry.kind === "directory" ? entry.path : parentPath(entry.path)
  ), []);

  const moveDraggedEntry = useCallback(async (source: DraggedFileEntry, targetParentPath: string) => {
    if (!canMoveDraggedEntry(source, targetParentPath)) return;
    setClipboard({ mode: "move", path: source.path, name: source.name });
    await pasteIntoTarget(targetParentPath);
  }, [pasteIntoTarget, setClipboard]);

  const getDropTargetPath = useCallback((entry: ProjectFileEntry) => (
    entry.kind === "directory" ? entry.path : parentPath(entry.path)
  ), []);

  const handleFileKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>, entry: ProjectFileEntry) => {
    if (event.key === "F2" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      openInput({ kind: "rename", path: entry.path, currentName: entry.name });
      return;
    }

    if (event.key === "Delete" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      setConfirmAction({ kind: "delete", path: entry.path, name: entry.name });
      return;
    }

    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
    const key = event.key.toLowerCase();
    if (key !== "c" && key !== "x" && key !== "v") return;

    event.preventDefault();
    event.stopPropagation();
    if (key === "v") {
      void pasteIntoTarget(getPasteTargetPath(entry));
      return;
    }
    setClipboard({ mode: key === "c" ? "copy" : "move", path: entry.path, name: entry.name });
  }, [getPasteTargetPath, pasteIntoTarget, setClipboard]);

  const handleRootKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "v") return;
    event.preventDefault();
    event.stopPropagation();
    void pasteIntoTarget("");
  }, [pasteIntoTarget]);

  const handleFileDragStart = useCallback((event: ReactDragEvent<HTMLElement>, entry: ProjectFileEntry) => {
    if (!project) return;
    const text = formatTerminalDragPath(project, entry.path, entry.kind);
    beginTerminalFileDrag(text);
    event.dataTransfer.effectAllowed = "copyMove";
    event.dataTransfer.setData(FILE_EXPLORER_ENTRY_MIME, JSON.stringify({ kind: entry.kind, name: entry.name, path: entry.path }));
    event.dataTransfer.setData(TERMINAL_FILE_PATH_MIME, text);
    event.dataTransfer.setData("text/plain", text);
  }, [project]);

  const handleFileDragEnd = useCallback(() => {
    endTerminalFileDrag();
  }, []);

  const handleFileDragOver = useCallback((event: ReactDragEvent<HTMLElement>, _targetEntry: ProjectFileEntry) => {
    if (!hasFileExplorerDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
  }, []);

  const handleFileDrop = useCallback((event: ReactDragEvent<HTMLElement>, targetEntry: ProjectFileEntry) => {
    if (!hasFileExplorerDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    const source = readDraggedFileEntry(event.dataTransfer);
    if (!source) return;
    void moveDraggedEntry(source, getDropTargetPath(targetEntry));
  }, [getDropTargetPath, moveDraggedEntry]);

  const handleRootDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!hasFileExplorerDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
  }, []);

  const handleRootDrop = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!hasFileExplorerDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    const source = readDraggedFileEntry(event.dataTransfer);
    if (!source) return;
    void moveDraggedEntry(source, "");
  }, [moveDraggedEntry]);

  const requestOpenFile = (entry: ProjectFileEntry) => {
    void openFile(entry);
    if (project) openFileEditorPane(project);
  };

  const renderContentSearchRow = useCallback((match: ProjectFileContentMatch) => {
    return (
      <button
        key={`${match.path}:${match.lineNumber}`}
        type="button"
        className="ui-file-tree-row flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-[12px]"
        data-selected={activeFile?.path === match.path ? "true" : "false"}
        onClick={() => {
          void openFileAtSearchMatch(match);
          if (project) openFileEditorPane(project);
        }}
        title={`${match.path}:${match.lineNumber}`}
      >
        <FileCode size={15} className="mt-0.5 shrink-0 text-text-muted" />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1">
            <span className="truncate text-on-surface">{match.path}</span>
            <span className="shrink-0 text-[10px] text-text-muted">{t("files.search.line", { line: match.lineNumber })}</span>
          </span>
          {match.before.map((line, index) => (
            <span key={`before-${index}`} className="block truncate font-mono text-[11px] text-text-muted">{line}</span>
          ))}
          <span className="block truncate font-mono text-[11px] text-on-surface">{match.lineText}</span>
          {match.after.map((line, index) => (
            <span key={`after-${index}`} className="block truncate font-mono text-[11px] text-text-muted">{line}</span>
          ))}
        </span>
      </button>
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFile?.path, openFileAtSearchMatch, openFileEditorPane, project, t]);

  const renderSearchRow = useCallback((entry: ProjectFileEntry) => {
    if (!project) return null;
    const displayStatus = getDisplayStatus(entry);
    if (renamingAction?.path === entry.path) {
      return (
        <div
          key={entry.path}
          className="ui-file-tree-row flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px]"
          data-selected={activeFile?.path === entry.path ? "true" : "false"}
          title={entry.path}
        >
          <img src={entry.kind === "directory" ? getMaterialFolderIcon(entry.name, false) : getMaterialFileIcon(entry.name)} alt="" width={16} height={16} />
          <InlineRenameInput
            initialName={entry.name}
            onSubmit={(value) => void submitRename({ kind: "rename", path: entry.path, currentName: entry.name }, value)}
            onCancel={cancelRename}
          />
        </div>
      );
    }
    return (
      <ContextMenu key={entry.path}>
        <ContextMenuTrigger asChild>
          <div
            role="button"
            tabIndex={0}
            className="ui-file-tree-row flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px]"
            data-selected={activeFile?.path === entry.path ? "true" : "false"}
            draggable
            onClick={() => entry.kind === "file" ? requestOpenFile(entry) : undefined}
            onContextMenu={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              handleFileKeyDown(event, entry);
              if (event.defaultPrevented) return;
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              if (entry.kind === "file") requestOpenFile(entry);
            }}
            onDragStart={(event) => handleFileDragStart(event, entry)}
            onDragEnd={handleFileDragEnd}
            onDragOver={(event) => handleFileDragOver(event, entry)}
            onDrop={(event) => handleFileDrop(event, entry)}
            title={displayStatus ? `${entry.path} · ${displayStatus.label}` : entry.path}
          >
            <img src={entry.kind === "directory" ? getMaterialFolderIcon(entry.name, false) : getMaterialFileIcon(entry.name)} alt="" width={16} height={16} draggable={false} />
            <span
              className="min-w-0 flex-1 truncate"
              style={displayStatus ? { color: displayStatus.color } : undefined}
            >
              {entry.path}
            </span>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => void copyAiText(formatAiPathBlock(project, entry.path, entry.kind), t("files.toast.aiPathCopied"))}>
            <Copy size={13} /> {t("files.menu.copyAiPath")}
          </ContextMenuItem>
          {entry.kind === "directory" && (
            <ContextMenuItem onSelect={() => void copyAiText(formatAiTree(project, entry), t("files.toast.aiTreeCopied"))}>
              <Folder size={13} /> {t("files.menu.copyAiTree")}
            </ContextMenuItem>
          )}
        </ContextMenuContent>
      </ContextMenu>
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFile?.path, cancelRename, getDisplayStatus, handleFileDragEnd, handleFileDragOver, handleFileDragStart, handleFileDrop, handleFileKeyDown, openFile, project, renamingAction?.path, submitRename, t]);

  const copyRootAiPath = useCallback(() => {
    if (!project) return;
    void copyAiText(formatAiPathBlock(project, "", "directory"), t("files.toast.aiPathCopied"));
  }, [project, t]);

  const copyRootAiTree = useCallback(() => {
    if (!project) return;
    void copyAiText(formatAiRootTree(project, tree), t("files.toast.aiTreeCopied"));
  }, [project, t, tree]);

  const renderRows = useMemo(() => {
    if (hasSearchQuery && searchLoading) {
      return <div className="px-3 py-8 text-center text-xs text-text-muted">{t("files.searching")}</div>;
    }

    if (hasSearchQuery && searchMode === "content") {
      return contentSearchResults.length > 0
        ? contentSearchResults.map((match) => renderContentSearchRow(match))
        : <div className="px-3 py-8 text-center text-xs text-text-muted">{t("files.emptySearch")}</div>;
    }

    if (hasSearchQuery) {
      return visibleRows.length > 0
        ? visibleRows.map((entry) => renderSearchRow(entry))
        : <div className="px-3 py-8 text-center text-xs text-text-muted">{t("files.emptySearch")}</div>;
    }

    return visibleRows.length > 0 ? (
      <FileTreeRows
        entries={visibleRows}
        parentPath=""
        depth={0}
        getDisplayStatus={getDisplayStatus}
        onOpenFile={requestOpenFile}
        onInput={openInput}
        onConfirm={setConfirmAction}
        renamingPath={renamingAction?.path ?? null}
        onRenameSubmit={(action, value) => void submitRename(action, value)}
        onRenameCancel={cancelRename}
        onFileKeyDown={handleFileKeyDown}
        onFileDragStart={handleFileDragStart}
        onFileDragEnd={handleFileDragEnd}
        onFileDragOver={handleFileDragOver}
        onFileDrop={handleFileDrop}
        autoCollapseGroups={autoCollapseGroups}
        renderAutoCollapsedGroup
      />
    ) : (
      <div className="px-3 py-8 text-center text-xs text-text-muted">{t("files.empty")}</div>
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasSearchQuery, searchLoading, searchMode, contentSearchResults, renderContentSearchRow, visibleRows, renderSearchRow, getDisplayStatus, autoCollapseGroups, handleFileKeyDown, handleFileDragStart, handleFileDragEnd, renamingAction?.path, submitRename, cancelRename, t]);

  if (!project) return null;

  const handleClose = () => {
    if (mode === "panel") {
      onClosePanel?.();
      return;
    }
    if (onBackToProjects) {
      onBackToProjects();
      return;
    }
    closeProject();
  };

  const closeLabel = mode === "panel" ? t("files.closePanel") : t("files.backToProjects");
  const panelStyle = mode === "panel"
    ? ({
        "--surface-container": TERM.card,
        "--surface-container-low": TERM.card,
        "--surface-container-lowest": TERM.cardInner,
        "--on-surface": TERM.fg,
        "--on-surface-variant": TERM.dim,
        "--text-muted": TERM.dim,
        "--border": TERM.border,
        "--primary": TERM.cyan,
        "--ui-scrollbar-thumb": TERM.border,
        "--ui-scrollbar-track": TERM.bg,
        backgroundColor: TERM.bg,
        color: TERM.fg,
      } as CSSProperties)
    : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col" style={panelStyle}>
      <div className="shrink-0 border-b border-border px-2 py-2">
        <div className="mb-2 flex items-center gap-2">
          <Folder size={15} className="text-on-surface-variant" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-semibold text-on-surface">{project.name}</div>
            <div className="truncate text-[10px] text-text-muted">{project.path}</div>
          </div>
          <button className="ui-icon-action" title={t("common.refresh")} aria-label={t("files.refreshList")} onClick={() => void refresh()}>
            <RefreshCw size={13} />
          </button>
          <button className="ui-icon-action" title={closeLabel} aria-label={closeLabel} onClick={handleClose}>
            <X size={14} />
          </button>
        </div>
        <div className="flex items-center gap-1 rounded-md border border-border bg-surface-container-lowest px-2">
          <Search size={13} className="text-text-muted" />
          <input
            className="min-w-0 flex-1 bg-transparent py-1.5 text-xs text-on-surface outline-none"
            value={searchQuery}
            aria-label={searchMode === "content" ? t("files.searchCodePlaceholder") : t("files.searchPlaceholder")}
            placeholder={searchMode === "content" ? t("files.searchCodePlaceholder") : t("files.searchPlaceholder")}
            onChange={(event) => void setSearchQuery(event.currentTarget.value)}
          />
        </div>
        <div className="mt-1 grid grid-cols-2 rounded-md border border-border bg-surface-container-lowest p-0.5">
          {SEARCH_MODES.map((mode) => {
            const active = searchMode === mode.value;
            return (
              <button
                key={mode.value}
                type="button"
                className={[
                  "rounded px-2 py-1 text-[11px] transition-colors",
                  active ? "bg-surface-container text-on-surface" : "text-text-muted hover:text-on-surface",
                ].join(" ")}
                aria-pressed={active}
                onClick={() => setSearchMode(mode.value)}
              >
                {t(mode.labelKey)}
              </button>
            );
          })}
        </div>
        {clipboard && <div className="mt-1 truncate text-[10px] text-text-muted">{clipboard.mode === "copy" ? t("files.clipboard.copy") : t("files.clipboard.move")}：{clipboard.name}</div>}
      </div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className="min-h-0 flex-1 overflow-y-auto px-1 py-1 outline-none ui-thin-scroll"
            tabIndex={0}
            onKeyDown={handleRootKeyDown}
            onDragOver={handleRootDragOver}
            onDrop={handleRootDrop}
          >
            {renderRows}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => openInput({ kind: "create-file", parentPath: "" })}>
            <File size={13} /> {t("files.menu.newFile")}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => openInput({ kind: "create-dir", parentPath: "" })}>
            <FolderPlus size={13} /> {t("files.menu.newFolder")}
          </ContextMenuItem>
          <ContextMenuItem disabled={!clipboard} onSelect={() => void pasteIntoTarget("")}>
            <Copy size={13} /> {t("files.menu.paste")}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={copyRootAiPath}>
            <Copy size={13} /> {t("files.menu.copyAiPath")}
          </ContextMenuItem>
          <ContextMenuItem onSelect={copyRootAiTree}>
            <Folder size={13} /> {t("files.menu.copyAiTree")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <Dialog open={inputAction !== null} onOpenChange={(open) => { if (!open) setInputAction(null); }}>
        <DialogContent className="max-w-[360px]">
          <DialogTitle>{inputAction?.kind === "create-dir" ? t("files.dialog.newFolder") : t("files.dialog.newFile")}</DialogTitle>
          <input
            className="ui-focus-ring mt-3 rounded-md border border-border bg-surface-container-lowest px-3 py-2 text-sm text-on-surface outline-none"
            value={inputValue}
            autoFocus
            onChange={(event) => setInputValue(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submitInput(false);
              if (event.key === "Escape") setInputAction(null);
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setInputAction(null)}>{t("common.cancel")}</Button>
            <Button onClick={() => void submitInput(false)}>{t("common.confirm")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmAction?.kind === "delete"}
        title={t("files.confirm.deleteTitle")}
        message={confirmAction?.kind === "delete" ? t("files.confirm.deleteMessage", { name: confirmAction.name }) : undefined}
        confirmText={t("common.delete")}
        danger
        onClose={() => setConfirmAction(null)}
        onConfirm={() => {
          const action = confirmAction;
          setConfirmAction(null);
          if (action?.kind === "delete") void deleteEntry(action.path);
        }}
      />
      <ConfirmDialog
        open={confirmAction?.kind === "overwrite-create" || confirmAction?.kind === "overwrite-paste"}
        title={t("files.confirm.targetExistsTitle")}
        message={t("files.confirm.overwriteMessage")}
        confirmText={t("files.confirm.overwrite")}
        danger
        onClose={() => setConfirmAction(null)}
        onConfirm={() => {
          const action = confirmAction;
          setConfirmAction(null);
          if (action?.kind === "overwrite-create") {
            void performInputAction(action.action, action.value, true);
          }
          if (action?.kind === "overwrite-paste") {
            void pasteInto(action.targetParentPath, true);
          }
        }}
      />
    </div>
  );
}
