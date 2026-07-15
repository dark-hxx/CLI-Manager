import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { getMaterialFileIcon, getMaterialFolderIcon } from "@baybreezy/file-extension-icon";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { copyAiText } from "../../lib/aiClipboard";
import { formatAiPathBlock, formatAiRootTree, formatAiTree, TERMINAL_FILE_PATH_MIME } from "../../lib/aiPathFormatter";
import { debugConsoleWarn } from "../../lib/debugConsole";
import { POINTER_DRAG_START_PX } from "../../lib/dragInteraction";
import { useI18n, type TranslationKey } from "../../lib/i18n";
import {
  beginTerminalFileDrag,
  commitTerminalFileDragDrop,
  endTerminalFileDrag,
  getTerminalFileDropZoneIdAtPoint,
  updateTerminalFileDragPointFromEvent,
} from "../../lib/terminalFileDrag";
import type { GitFileChange, ProjectFileContentMatch, ProjectFileEntry, ProjectFileSearchMode } from "../../lib/types";
import { isDefaultCollapsedDirectoryName, useFileExplorerStore } from "../../stores/fileExplorerStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { STATUS_CONFIG } from "../git/GitStatusIcon";
import { ConfirmDialog } from "../ConfirmDialog";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "../ui/dialog";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "../ui/context-menu";
import { Portal } from "../ui/Portal";
import { ChevronRight, Copy, EyeOff, File, FileCode, Folder, FolderOpen, FolderPlus, Pencil, RefreshCw, Search, Trash2, X } from "../icons";
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
  | { kind: "editing"; label: string; color: string; symbol: string }
  | { kind: "git"; label: string; color: string; symbol: string; status: GitFileChange["status"] };

type DraggedFileEntry = Pick<ProjectFileEntry, "kind" | "name" | "path">;
type Translate = ReturnType<typeof useI18n>["t"];

const FILE_EXPLORER_ENTRY_MIME = "application/x-cli-manager-file-entry";
const FILE_WATCH_REFRESH_DEBOUNCE_MS = 600;
interface AutoCollapseGroupState {
  expandedGroupPaths: Set<string>;
  ignoredPaths: Set<string>;
  toggleGroup: (parentPath: string) => void;
  ignorePath: (path: string) => void;
  unignorePath: (path: string) => void;
}

interface FilePointerDragState {
  pointerId: number;
  startX: number;
  startY: number;
  entry: ProjectFileEntry;
  preview: FileDragPreviewSource;
  dragging: boolean;
}

interface FileDragPreviewSource {
  className: string;
  html: string;
  offsetX: number;
  offsetY: number;
  paddingLeft: string;
  width: number;
}

interface FileDragPreviewState {
  x: number;
  y: number;
  source: FileDragPreviewSource;
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
const GIT_DIRECTORY_STATUS_PRIORITY: GitFileChange["status"][] = ["C", "D", "M", "R", "A", "U", "??"];

const SEARCH_MODES: Array<{ value: ProjectFileSearchMode; labelKey: TranslationKey }> = [
  { value: "files", labelKey: "files.search.modeFiles" },
  { value: "content", labelKey: "files.search.modeCode" },
];
const FALLBACK_POLL_INTERVAL_MS = 15000;

function getDisplayPathName(path: string): string {
  const normalized = path.trim().replace(/[\\/]+$/g, "");
  return normalized.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function joinProjectPath(rootPath: string, relativePath: string): string {
  const root = rootPath.replace(/[\\/]+$/g, "");
  const relative = relativePath.trim().replace(/^[\\/]+/g, "");
  if (!relative) return root;
  const separator = root.includes("\\") ? "\\" : "/";
  return `${root}${separator}${relative.replace(/[\\/]/g, separator)}`;
}

async function openFileBrowserFolder(rootPath: string, relativePath: string, t: Translate) {
  try {
    await invoke("open_folder_in_explorer", { path: joinProjectPath(rootPath, relativePath) });
  } catch (err) {
    toast.error(t("files.toast.openFolderFailed"), { description: String(err) });
  }
}

function makeGitDisplayStatus(change: GitFileChange, t: Translate): FileDisplayStatus {
  const config = STATUS_CONFIG[change.status] ?? STATUS_CONFIG.M;
  return {
    kind: "git",
    label: t(GIT_STATUS_LABELS[change.status]),
    color: config.color,
    symbol: config.symbol,
    status: change.status,
  };
}

function getDirectoryGitChange(path: string, changes: GitFileChange[]): GitFileChange | null {
  const prefix = `${path}/`;
  const matches = changes.filter((change) => change.path.startsWith(prefix));
  if (matches.length === 0) return null;
  for (const status of GIT_DIRECTORY_STATUS_PRIORITY) {
    const match = matches.find((change) => change.status === status);
    if (match) return match;
  }
  return matches[0];
}

function statusBadgeStyle(status: FileDisplayStatus): CSSProperties {
  return {
    color: status.color,
    borderColor: `${status.color}66`,
    backgroundColor: `${status.color}18`,
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
      continue;
    }

    if (entry.kind === "directory" && entry.children) {
      const nested = splitAutoCollapsedEntries(entry.children, ignoredPaths);
      collapsedEntries.push(...nested.collapsedEntries);
      normalEntries.push(
        nested.collapsedEntries.length > 0
          ? { ...entry, children: nested.normalEntries }
          : entry
      );
      continue;
    }

    normalEntries.push(entry);
  }

  return { normalEntries, collapsedEntries };
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
      className="ui-file-tooltip ui-file-tree-row flex w-full items-center gap-1.5 rounded px-1 py-1 text-left text-[12px] text-text-muted"
      style={{ paddingLeft: 8 + depth * 14 }}
      data-tooltip={isOpen ? t("files.autoCollapse.collapse") : t("files.autoCollapse.expand")}
      onClick={onToggle}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
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
  getGitChange,
  onOpenFile,
  onOpenDiff,
  onInput,
  onConfirm,
  renamingPath,
  onRenameSubmit,
  onRenameCancel,
  onFileKeyDown,
  onFileDragStart,
  onFileDrag,
  onFileDragEnd,
  onFileDragOver,
  onFileDrop,
  onFilePointerDown,
  onFilePointerMove,
  onFilePointerUp,
  onFilePointerCancel,
  autoCollapseGroups,
  menuPortalContainer,
  showRelativePath = false,
}: {
  entry: ProjectFileEntry;
  depth: number;
  getDisplayStatus: (entry: ProjectFileEntry) => FileDisplayStatus | null;
  getGitChange: (path: string) => GitFileChange | null;
  onOpenFile: (entry: ProjectFileEntry) => void;
  onOpenDiff: (change: GitFileChange) => void;
  onInput: (action: InputAction) => void;
  onConfirm: (action: ConfirmAction) => void;
  renamingPath: string | null;
  onRenameSubmit: (action: RenameAction, value: string) => void;
  onRenameCancel: () => void;
  onFileKeyDown: (event: ReactKeyboardEvent<HTMLElement>, entry: ProjectFileEntry) => void;
  onFileDragStart: (event: ReactDragEvent<HTMLElement>, entry: ProjectFileEntry) => void;
  onFileDrag: (event: ReactDragEvent<HTMLElement>) => void;
  onFileDragEnd: (event: ReactDragEvent<HTMLElement>) => void;
  onFileDragOver: (event: ReactDragEvent<HTMLElement>, targetEntry: ProjectFileEntry) => void;
  onFileDrop: (event: ReactDragEvent<HTMLElement>, targetEntry: ProjectFileEntry) => void;
  onFilePointerDown: (event: ReactPointerEvent<HTMLElement>, entry: ProjectFileEntry) => void;
  onFilePointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onFilePointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onFilePointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  autoCollapseGroups: AutoCollapseGroupState;
  menuPortalContainer: HTMLDivElement | null;
  showRelativePath?: boolean;
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
  const gitChange = !isDir ? getGitChange(displayEntry.path) : null;
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
      getGitChange={getGitChange}
      onOpenFile={onOpenFile}
      onOpenDiff={onOpenDiff}
      onInput={onInput}
      onConfirm={onConfirm}
      renamingPath={renamingPath}
      onRenameSubmit={onRenameSubmit}
      onRenameCancel={onRenameCancel}
      onFileKeyDown={onFileKeyDown}
      onFileDragStart={onFileDragStart}
      onFileDrag={onFileDrag}
      onFileDragEnd={onFileDragEnd}
      onFileDragOver={onFileDragOver}
      onFileDrop={onFileDrop}
      onFilePointerDown={onFilePointerDown}
      onFilePointerMove={onFilePointerMove}
      onFilePointerUp={onFilePointerUp}
      onFilePointerCancel={onFilePointerCancel}
      autoCollapseGroups={autoCollapseGroups}
      menuPortalContainer={menuPortalContainer}
      renderAutoCollapsedGroup={false}
    />
  ) : null;

  if (isRenaming) {
    return (
      <div>
        <div
          className="ui-file-tooltip ui-file-tree-row flex w-full items-center gap-1.5 rounded px-1 py-1 text-left text-[12px]"
          data-selected={activePath === displayEntry.path ? "true" : "false"}
          style={{ paddingLeft }}
          data-tooltip={displayEntry.path}
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
            className="ui-file-tooltip ui-file-tree-row flex w-full items-center gap-1.5 rounded px-1 py-1 text-left text-[12px]"
            data-selected={activePath === displayEntry.path ? "true" : "false"}
            data-file-drop-target-path={displayEntry.kind === "directory" ? displayEntry.path : parentPath(displayEntry.path)}
            draggable={false}
            style={{ paddingLeft }}
            data-tooltip={displayStatus ? `${displayEntry.path} · ${displayStatus.label}` : displayEntry.path}
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
            onDrag={onFileDrag}
            onDragEnd={onFileDragEnd}
            onDragOver={(event) => onFileDragOver(event, displayEntry)}
            onDrop={(event) => onFileDrop(event, displayEntry)}
            onPointerDown={(event) => onFilePointerDown(event, displayEntry)}
            onPointerMove={onFilePointerMove}
            onPointerUp={onFilePointerUp}
            onPointerCancel={onFilePointerCancel}
            onClick={(event) => {
              if (event.currentTarget.dataset.pointerDragHandled === "true") return;
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
              <span className="truncate">{showRelativePath ? entry.path : entry.name}</span>
              {suffixParts.length > 0 && (
                <span className="truncate text-[11px] font-normal text-text-muted">
                  /{suffixParts.join("/")}
                </span>
              )}
            </span>
            {displayStatus && (
              <span
                className="ui-file-tree-status-badge"
                style={statusBadgeStyle(displayStatus)}
                aria-label={displayStatus.label}
              >
                {displayStatus.symbol}
              </span>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="file-explorer-menu" portalContainer={menuPortalContainer}>
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
          {gitChange && (
            <ContextMenuItem onSelect={() => onOpenDiff(gitChange)}>
              <FileCode size={13} /> {t("files.menu.openDiff")}
            </ContextMenuItem>
          )}
          <ContextMenuItem onSelect={() => onInput({ kind: "rename", path: displayEntry.path, currentName: displayEntry.name })}>
            <Pencil size={13} /> {t("files.menu.rename")}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => setClipboard({ mode: "copy", path: displayEntry.path, name: displayEntry.name })}>
            <Copy size={13} /> {t("files.menu.copy")}
          </ContextMenuItem>
          {project && (
            <>
              <ContextMenuItem onSelect={() => void openFileBrowserFolder(project.path, displayEntry.path, t)}>
                <FolderOpen size={13} /> {t("files.menu.openContainingFolder")}
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => void copyAiText(formatAiPathBlock(displayEntry.path, displayEntry.kind), t("files.toast.aiPathCopied"))}>
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
  getGitChange,
  onOpenFile,
  onOpenDiff,
  onInput,
  onConfirm,
  renamingPath,
  onRenameSubmit,
  onRenameCancel,
  onFileKeyDown,
  onFileDragStart,
  onFileDrag,
  onFileDragEnd,
  onFileDragOver,
  onFileDrop,
  onFilePointerDown,
  onFilePointerMove,
  onFilePointerUp,
  onFilePointerCancel,
  autoCollapseGroups,
  menuPortalContainer,
  renderAutoCollapsedGroup,
}: {
  entries: ProjectFileEntry[];
  parentPath: string;
  depth: number;
  getDisplayStatus: (entry: ProjectFileEntry) => FileDisplayStatus | null;
  getGitChange: (path: string) => GitFileChange | null;
  onOpenFile: (entry: ProjectFileEntry) => void;
  onOpenDiff: (change: GitFileChange) => void;
  onInput: (action: InputAction) => void;
  onConfirm: (action: ConfirmAction) => void;
  renamingPath: string | null;
  onRenameSubmit: (action: RenameAction, value: string) => void;
  onRenameCancel: () => void;
  onFileKeyDown: (event: ReactKeyboardEvent<HTMLElement>, entry: ProjectFileEntry) => void;
  onFileDragStart: (event: ReactDragEvent<HTMLElement>, entry: ProjectFileEntry) => void;
  onFileDrag: (event: ReactDragEvent<HTMLElement>) => void;
  onFileDragEnd: (event: ReactDragEvent<HTMLElement>) => void;
  onFileDragOver: (event: ReactDragEvent<HTMLElement>, targetEntry: ProjectFileEntry) => void;
  onFileDrop: (event: ReactDragEvent<HTMLElement>, targetEntry: ProjectFileEntry) => void;
  onFilePointerDown: (event: ReactPointerEvent<HTMLElement>, entry: ProjectFileEntry) => void;
  onFilePointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onFilePointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onFilePointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  autoCollapseGroups: AutoCollapseGroupState;
  menuPortalContainer: HTMLDivElement | null;
  renderAutoCollapsedGroup: boolean;
}) {
  const { normalEntries, collapsedEntries } = renderAutoCollapsedGroup
    ? splitAutoCollapsedEntries(entries, autoCollapseGroups.ignoredPaths)
    : { normalEntries: entries, collapsedEntries: [] };
  const groupOpen = autoCollapseGroups.expandedGroupPaths.has(parentPath);

  return (
    <div>
      {normalEntries.map((entry) => (
        <FileNode
          key={entry.path}
          entry={entry}
          depth={depth}
          getDisplayStatus={getDisplayStatus}
          getGitChange={getGitChange}
          onOpenFile={onOpenFile}
          onOpenDiff={onOpenDiff}
          onInput={onInput}
          onConfirm={onConfirm}
          renamingPath={renamingPath}
          onRenameSubmit={onRenameSubmit}
          onRenameCancel={onRenameCancel}
          onFileKeyDown={onFileKeyDown}
          onFileDragStart={onFileDragStart}
          onFileDrag={onFileDrag}
          onFileDragEnd={onFileDragEnd}
          onFileDragOver={onFileDragOver}
          onFileDrop={onFileDrop}
          onFilePointerDown={onFilePointerDown}
          onFilePointerMove={onFilePointerMove}
          onFilePointerUp={onFilePointerUp}
          onFilePointerCancel={onFilePointerCancel}
          autoCollapseGroups={autoCollapseGroups}
          menuPortalContainer={menuPortalContainer}
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
              getGitChange={getGitChange}
              onOpenFile={onOpenFile}
              onOpenDiff={onOpenDiff}
              onInput={onInput}
              onConfirm={onConfirm}
              renamingPath={renamingPath}
              onRenameSubmit={onRenameSubmit}
              onRenameCancel={onRenameCancel}
              onFileKeyDown={onFileKeyDown}
              onFileDragStart={onFileDragStart}
              onFileDrag={onFileDrag}
              onFileDragEnd={onFileDragEnd}
              onFileDragOver={onFileDragOver}
              onFileDrop={onFileDrop}
              onFilePointerDown={onFilePointerDown}
              onFilePointerMove={onFilePointerMove}
              onFilePointerUp={onFilePointerUp}
              onFilePointerCancel={onFilePointerCancel}
              autoCollapseGroups={autoCollapseGroups}
              menuPortalContainer={menuPortalContainer}
              showRelativePath
            />
          ))}
        </>
      )}
    </div>
  );
}

export function FileExplorerSidebar({ mode = "sidebar", onClosePanel, onBackToProjects }: FileExplorerSidebarProps) {
  const { t } = useI18n();
  const [menuPortalContainer, setMenuPortalContainer] = useState<HTMLDivElement | null>(null);
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
  const refreshVisibleState = useFileExplorerStore((s) => s.refreshVisibleState);
  const setSearchMode = useFileExplorerStore((s) => s.setSearchMode);
  const setSearchQuery = useFileExplorerStore((s) => s.setSearchQuery);
  const openFile = useFileExplorerStore((s) => s.openFile);
  const openDiff = useFileExplorerStore((s) => s.openDiff);
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
  const [searchControlsVisible, setSearchControlsVisible] = useState(false);
  const [dragPreview, setDragPreview] = useState<FileDragPreviewState | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const pointerDragRef = useRef<FilePointerDragState | null>(null);
  const dragPreviewElementRef = useRef<HTMLDivElement | null>(null);
  const dragPreviewFrameRef = useRef<number | null>(null);
  const pendingDragPreviewRef = useRef<{ source: FileDragPreviewSource; x: number; y: number } | null>(null);

  useEffect(() => () => {
    if (dragPreviewFrameRef.current !== null) {
      window.cancelAnimationFrame(dragPreviewFrameRef.current);
    }
    if (pointerDragRef.current?.dragging) endTerminalFileDrag();
    document.body.style.removeProperty("user-select");
  }, []);

  useEffect(() => {
    setExpandedAutoCollapseGroups(new Set());
    setSearchControlsVisible(false);
  }, [project?.id]);

  useEffect(() => {
    if (searchQuery.trim()) setSearchControlsVisible(true);
  }, [searchQuery]);

  useEffect(() => {
    if (!project?.path) return;

    let disposed = false;
    let unlisten: (() => void) | undefined;
    let fallbackTimer: number | undefined;
    let refreshTimer: number | undefined;
    let pendingChangedPaths: Set<string> | null | undefined;

    const isActive = () => document.visibilityState === "visible" && document.hasFocus();
    const refreshIfActive = (changedPaths?: string[]) => {
      if (isActive()) void refreshVisibleState(changedPaths);
    };
    const scheduleRefreshIfActive = (changedPaths?: string[]) => {
      if (!isActive()) return;
      if (!changedPaths?.length) {
        pendingChangedPaths = null;
      } else if (pendingChangedPaths !== null) {
        pendingChangedPaths ??= new Set<string>();
        for (const path of changedPaths) pendingChangedPaths.add(path);
      }
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        refreshTimer = undefined;
        const paths = pendingChangedPaths === null
          ? undefined
          : pendingChangedPaths
            ? Array.from(pendingChangedPaths)
            : undefined;
        pendingChangedPaths = undefined;
        refreshIfActive(paths);
      }, FILE_WATCH_REFRESH_DEBOUNCE_MS);
    };
    const startFallback = () => {
      if (fallbackTimer === undefined) {
        fallbackTimer = window.setInterval(refreshIfActive, FALLBACK_POLL_INTERVAL_MS);
      }
    };
    const stopFallback = () => {
      if (fallbackTimer !== undefined) {
        window.clearInterval(fallbackTimer);
        fallbackTimer = undefined;
      }
    };

    void listen<{ projectPath: string; changedPaths?: string[] }>("project-files-changed", (event) => {
      if (disposed) return;
      if (event.payload.projectPath === project.path) scheduleRefreshIfActive(event.payload.changedPaths);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });

    void invoke("file_watch_start", { projectPath: project.path }).catch((err) => {
      debugConsoleWarn("[FileExplorerSidebar] file_watch_start failed, falling back to polling:", err);
      if (!disposed) startFallback();
    });

    const onFocus = () => refreshIfActive();
    const onVisibility = () => {
      if (document.visibilityState === "visible") refreshIfActive();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      disposed = true;
      stopFallback();
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      if (unlisten) unlisten();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      void invoke("file_watch_stop", { projectPath: project.path }).catch(() => {});
    };
  }, [project?.path, refreshVisibleState]);

  const hasSearchQuery = Boolean(searchQuery.trim());
  const visibleRows = hasSearchQuery && searchMode === "files" ? searchResults : tree;
  const gitChangeByPath = useMemo(() => new Map(gitChanges.map((change) => [change.path, change])), [gitChanges]);
  const dirtyFilePathList = useMemo(
    () => openFiles.filter((file) => file.content !== file.savedContent).map((file) => file.path),
    [openFiles]
  );
  const dirtyFilePaths = useMemo(
    () => new Set(dirtyFilePathList),
    [dirtyFilePathList]
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
    if (dirtyFilePaths.has(entry.path)) {
      return { kind: "editing", label: t("files.status.editing"), color: "#7dcfff", symbol: "*" };
    }
    if (entry.kind === "directory" && dirtyFilePathList.some((path) => path.startsWith(`${entry.path}/`))) {
      return { kind: "editing", label: t("files.status.editing"), color: "#7dcfff", symbol: "*" };
    }
    const change = entry.kind === "file"
      ? gitChangeByPath.get(entry.path)
      : getDirectoryGitChange(entry.path, gitChanges);
    return change ? makeGitDisplayStatus(change, t) : null;
  }, [dirtyFilePathList, dirtyFilePaths, gitChangeByPath, gitChanges, t]);
  const getGitChange = useCallback((path: string): GitFileChange | null => gitChangeByPath.get(path) ?? null, [gitChangeByPath]);

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

  const getPointerDropTargetPath = useCallback((x: number, y: number): string | null => {
    const element = document.elementFromPoint(x, y);
    const target = element?.closest<HTMLElement>("[data-file-drop-target-path]");
    if (!target) return null;
    return target.dataset.fileDropTargetPath ?? "";
  }, []);

  const markPointerDragHandled = useCallback((element: HTMLElement) => {
    element.dataset.pointerDragHandled = "true";
    window.setTimeout(() => {
      delete element.dataset.pointerDragHandled;
    }, 0);
  }, []);

  const resetPointerDrag = useCallback(() => {
    pointerDragRef.current = null;
    pendingDragPreviewRef.current = null;
    if (dragPreviewFrameRef.current !== null) {
      window.cancelAnimationFrame(dragPreviewFrameRef.current);
      dragPreviewFrameRef.current = null;
    }
    setDragPreview(null);
    document.body.style.removeProperty("user-select");
  }, []);

  const updateDragPreview = useCallback((source: FileDragPreviewSource, x: number, y: number) => {
    pendingDragPreviewRef.current = { source, x, y };
    if (dragPreviewFrameRef.current !== null) return;

    dragPreviewFrameRef.current = window.requestAnimationFrame(() => {
      dragPreviewFrameRef.current = null;
      const pending = pendingDragPreviewRef.current;
      const element = dragPreviewElementRef.current;
      if (!pending || !element) return;

      const { source: pendingSource, x: nextX, y: nextY } = pending;
      element.style.transform = `translate3d(${nextX - pendingSource.offsetX}px, ${nextY - pendingSource.offsetY}px, 0)`;
      if (getTerminalFileDropZoneIdAtPoint(nextX, nextY)) {
        element.dataset.overTerminal = "true";
      } else {
        delete element.dataset.overTerminal;
      }
    });
  }, []);

  const focusSearchInput = useCallback(() => {
    window.requestAnimationFrame(() => searchInputRef.current?.focus());
  }, []);

  const revealSearchControls = useCallback(() => {
    setSearchControlsVisible(true);
    focusSearchInput();
  }, [focusSearchInput]);

  const toggleSearchControls = useCallback(() => {
    if (searchControlsVisible) {
      setSearchControlsVisible(false);
      return;
    }
    revealSearchControls();
  }, [revealSearchControls, searchControlsVisible]);

  const handleSidebarKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "f") return;
    event.preventDefault();
    event.stopPropagation();
    revealSearchControls();
  }, [revealSearchControls]);

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
    const text = formatAiPathBlock(entry.path, entry.kind);
    beginTerminalFileDrag(text);
    updateTerminalFileDragPointFromEvent(event);
    event.dataTransfer.effectAllowed = "copyMove";
    event.dataTransfer.setData(FILE_EXPLORER_ENTRY_MIME, JSON.stringify({ kind: entry.kind, name: entry.name, path: entry.path }));
    event.dataTransfer.setData(TERMINAL_FILE_PATH_MIME, text);
    event.dataTransfer.setData("text/plain", text);
  }, [project]);

  const handleFileDrag = useCallback((event: ReactDragEvent<HTMLElement>) => {
    updateTerminalFileDragPointFromEvent(event);
  }, []);

  useEffect(() => {
    const updateDragPoint = (event: DragEvent) => {
      updateTerminalFileDragPointFromEvent(event);
    };
    window.addEventListener("dragover", updateDragPoint, true);
    window.addEventListener("drop", updateDragPoint, true);
    return () => {
      window.removeEventListener("dragover", updateDragPoint, true);
      window.removeEventListener("drop", updateDragPoint, true);
    };
  }, []);

  const handleFileDragEnd = useCallback((event: ReactDragEvent<HTMLElement>) => {
    updateTerminalFileDragPointFromEvent(event);
    if (commitTerminalFileDragDrop()) return;
    endTerminalFileDrag();
  }, []);

  const handleFilePointerDown = useCallback((event: ReactPointerEvent<HTMLElement>, entry: ProjectFileEntry) => {
    if (!project || event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.pointerType === "mouse" && event.buttons !== 1) return;
    const rect = event.currentTarget.getBoundingClientRect();
    pointerDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      entry,
      preview: {
        className: event.currentTarget.className,
        html: event.currentTarget.innerHTML,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
        paddingLeft: event.currentTarget.style.paddingLeft,
        width: rect.width,
      },
      dragging: false,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }, [project]);

  const handleFilePointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const state = pointerDragRef.current;
    if (!state || state.pointerId !== event.pointerId) return;

    if (!state.dragging) {
      const dx = event.clientX - state.startX;
      const dy = event.clientY - state.startY;
      if (Math.hypot(dx, dy) < POINTER_DRAG_START_PX) return;
      state.dragging = true;
      if (!project) {
        resetPointerDrag();
        return;
      }
      beginTerminalFileDrag(formatAiPathBlock(state.entry.path, state.entry.kind));
      setDragPreview({
        x: event.clientX - state.preview.offsetX,
        y: event.clientY - state.preview.offsetY,
        source: state.preview,
      });
      document.body.style.userSelect = "none";
    }

    updateTerminalFileDragPointFromEvent(event);
    updateDragPreview(state.preview, event.clientX, event.clientY);
    event.preventDefault();
    event.stopPropagation();
  }, [project, resetPointerDrag, updateDragPreview]);

  const handleFilePointerUp = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const state = pointerDragRef.current;
    if (!state || state.pointerId !== event.pointerId) return;

    if (!state.dragging) {
      resetPointerDrag();
      return;
    }

    markPointerDragHandled(event.currentTarget);
    updateTerminalFileDragPointFromEvent(event);
    if (!commitTerminalFileDragDrop()) {
      const targetPath = getPointerDropTargetPath(event.clientX, event.clientY);
      if (targetPath !== null) void moveDraggedEntry(state.entry, targetPath);
      endTerminalFileDrag();
    }

    event.currentTarget.releasePointerCapture?.(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
    resetPointerDrag();
  }, [getPointerDropTargetPath, markPointerDragHandled, moveDraggedEntry, resetPointerDrag]);

  const handleFilePointerCancel = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const state = pointerDragRef.current;
    if (!state || state.pointerId !== event.pointerId) return;
    endTerminalFileDrag();
    resetPointerDrag();
  }, [resetPointerDrag]);

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

  const requestOpenDiff = useCallback((change: GitFileChange) => {
    openDiff(change);
    if (project) openFileEditorPane(project);
  }, [openDiff, openFileEditorPane, project]);

  const renderContentSearchRow = useCallback((match: ProjectFileContentMatch) => {
    if (!project) return null;
    return (
      <ContextMenu key={`${match.path}:${match.lineNumber}`}>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            className="ui-file-tooltip ui-file-tree-row flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-[12px]"
            data-selected={activeFile?.path === match.path ? "true" : "false"}
            onContextMenu={(event) => event.stopPropagation()}
            onClick={() => {
              void openFileAtSearchMatch(match);
              openFileEditorPane(project);
            }}
            data-tooltip={`${match.path}:${match.lineNumber}`}
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
        </ContextMenuTrigger>
        <ContextMenuContent className="file-explorer-menu" portalContainer={menuPortalContainer}>
          <ContextMenuItem onSelect={() => void openFileBrowserFolder(project.path, match.path, t)}>
            <FolderOpen size={13} /> {t("files.menu.openContainingFolder")}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => void copyAiText(formatAiPathBlock(match.path, "file"), t("files.toast.aiPathCopied"))}>
            <Copy size={13} /> {t("files.menu.copyAiPath")}
          </ContextMenuItem>
          {(() => {
            const change = getGitChange(match.path);
            return change ? (
              <ContextMenuItem onSelect={() => requestOpenDiff(change)}>
                <FileCode size={13} /> {t("files.menu.openDiff")}
              </ContextMenuItem>
            ) : null;
          })()}
        </ContextMenuContent>
      </ContextMenu>
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFile?.path, getGitChange, menuPortalContainer, openFileAtSearchMatch, openFileEditorPane, project, requestOpenDiff, t]);

  const renderSearchRow = useCallback((entry: ProjectFileEntry) => {
    if (!project) return null;
    const displayStatus = getDisplayStatus(entry);
    const gitChange = entry.kind === "file" ? getGitChange(entry.path) : null;
    if (renamingAction?.path === entry.path) {
      return (
        <div
          key={entry.path}
          className="ui-file-tooltip ui-file-tree-row flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px]"
          data-selected={activeFile?.path === entry.path ? "true" : "false"}
          data-tooltip={entry.path}
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
            className="ui-file-tooltip ui-file-tree-row flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px]"
            data-selected={activeFile?.path === entry.path ? "true" : "false"}
            data-file-drop-target-path={getDropTargetPath(entry)}
            draggable={false}
            onClick={(event) => {
              if (event.currentTarget.dataset.pointerDragHandled === "true") return;
              if (entry.kind === "file") requestOpenFile(entry);
            }}
            onContextMenu={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              handleFileKeyDown(event, entry);
              if (event.defaultPrevented) return;
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              if (entry.kind === "file") requestOpenFile(entry);
            }}
            onDragStart={(event) => handleFileDragStart(event, entry)}
            onDrag={handleFileDrag}
            onDragEnd={handleFileDragEnd}
            onDragOver={(event) => handleFileDragOver(event, entry)}
            onDrop={(event) => handleFileDrop(event, entry)}
            onPointerDown={(event) => handleFilePointerDown(event, entry)}
            onPointerMove={handleFilePointerMove}
            onPointerUp={handleFilePointerUp}
            onPointerCancel={handleFilePointerCancel}
            data-tooltip={displayStatus ? `${entry.path} · ${displayStatus.label}` : entry.path}
          >
            <img src={entry.kind === "directory" ? getMaterialFolderIcon(entry.name, false) : getMaterialFileIcon(entry.name)} alt="" width={16} height={16} draggable={false} />
            <span
              className="min-w-0 flex-1 truncate"
              style={displayStatus ? { color: displayStatus.color } : undefined}
            >
              {entry.path}
            </span>
            {displayStatus && (
              <span
                className="ui-file-tree-status-badge"
                style={statusBadgeStyle(displayStatus)}
                aria-label={displayStatus.label}
              >
                {displayStatus.symbol}
              </span>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="file-explorer-menu" portalContainer={menuPortalContainer}>
          <ContextMenuItem onSelect={() => void openFileBrowserFolder(project.path, entry.path, t)}>
            <FolderOpen size={13} /> {t("files.menu.openContainingFolder")}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => void copyAiText(formatAiPathBlock(entry.path, entry.kind), t("files.toast.aiPathCopied"))}>
            <Copy size={13} /> {t("files.menu.copyAiPath")}
          </ContextMenuItem>
          {entry.kind === "directory" && (
            <ContextMenuItem onSelect={() => void copyAiText(formatAiTree(project, entry), t("files.toast.aiTreeCopied"))}>
              <Folder size={13} /> {t("files.menu.copyAiTree")}
            </ContextMenuItem>
          )}
          {gitChange && (
            <ContextMenuItem onSelect={() => requestOpenDiff(gitChange)}>
              <FileCode size={13} /> {t("files.menu.openDiff")}
            </ContextMenuItem>
          )}
        </ContextMenuContent>
      </ContextMenu>
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFile?.path, cancelRename, getDisplayStatus, getDropTargetPath, getGitChange, handleFileDragEnd, handleFileDragOver, handleFileDragStart, handleFileDrop, handleFileKeyDown, handleFilePointerCancel, handleFilePointerDown, handleFilePointerMove, handleFilePointerUp, menuPortalContainer, openFile, project, renamingAction?.path, requestOpenDiff, submitRename, t]);

  const copyRootAiPath = useCallback(() => {
    if (!project) return;
    void copyAiText(formatAiPathBlock("", "directory"), t("files.toast.aiPathCopied"));
  }, [project, t]);

  const copyRootAiTree = useCallback(() => {
    if (!project) return;
    void copyAiText(formatAiRootTree(project, tree), t("files.toast.aiTreeCopied"));
  }, [project, t, tree]);

  const openProjectRootFolder = useCallback(() => {
    if (!project) return;
    void openFileBrowserFolder(project.path, "", t);
  }, [project, t]);

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
        getGitChange={getGitChange}
        onOpenFile={requestOpenFile}
        onOpenDiff={requestOpenDiff}
        onInput={openInput}
        onConfirm={setConfirmAction}
        renamingPath={renamingAction?.path ?? null}
        onRenameSubmit={(action, value) => void submitRename(action, value)}
        onRenameCancel={cancelRename}
        onFileKeyDown={handleFileKeyDown}
        onFileDragStart={handleFileDragStart}
        onFileDrag={handleFileDrag}
        onFileDragEnd={handleFileDragEnd}
        onFileDragOver={handleFileDragOver}
        onFileDrop={handleFileDrop}
        onFilePointerDown={handleFilePointerDown}
        onFilePointerMove={handleFilePointerMove}
        onFilePointerUp={handleFilePointerUp}
        onFilePointerCancel={handleFilePointerCancel}
        autoCollapseGroups={autoCollapseGroups}
        menuPortalContainer={menuPortalContainer}
        renderAutoCollapsedGroup
      />
    ) : (
      <div className="px-3 py-8 text-center text-xs text-text-muted">{t("files.empty")}</div>
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasSearchQuery, searchLoading, searchMode, contentSearchResults, renderContentSearchRow, visibleRows, renderSearchRow, getDisplayStatus, getGitChange, requestOpenDiff, autoCollapseGroups, menuPortalContainer, handleFileKeyDown, handleFileDragStart, handleFileDrag, handleFileDragEnd, handleFileDragOver, handleFileDrop, handleFilePointerCancel, handleFilePointerDown, handleFilePointerMove, handleFilePointerUp, renamingAction?.path, submitRename, cancelRename, t]);

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
  const searchLabel = searchMode === "content" ? t("files.searchCodePlaceholder") : t("files.searchPlaceholder");
  const searchToggleLabel = searchControlsVisible ? t("files.hideSearch") : searchLabel;
  const displayPathName = getDisplayPathName(project.path);
  const panelStyle = mode === "panel"
    ? ({
        "--surface-container": TERM.card,
        "--surface-container-low": TERM.card,
        "--surface-container-lowest": TERM.cardInner,
        "--surface-container-high": TERM.cardInner,
        "--surface-container-highest": TERM.cardInner,
        "--surface": TERM.card,
        "--on-surface": TERM.fg,
        "--on-surface-variant": TERM.dim,
        "--text-primary": TERM.fg,
        "--text-secondary": TERM.dim,
        "--text-muted": TERM.dim,
        "--border": TERM.border,
        "--primary": TERM.cyan,
        "--interactive-hover-bg": "color-mix(in srgb, var(--term-panel-cyan, #5AC8E0) 12%, transparent)",
        "--ui-scrollbar-thumb": TERM.border,
        "--ui-scrollbar-track": TERM.bg,
        backgroundColor: TERM.bg,
        color: TERM.fg,
      } as CSSProperties)
    : undefined;

  return (
    <div ref={setMenuPortalContainer} className="ui-file-explorer-sidebar flex h-full min-h-0 flex-col" style={panelStyle} onKeyDown={handleSidebarKeyDown}>
      {dragPreview && (
        <Portal>
          <div
            ref={dragPreviewElementRef}
            className="ui-file-drag-preview"
            style={{
              width: dragPreview.source.width,
              transform: `translate3d(${dragPreview.x}px, ${dragPreview.y}px, 0)`,
            }}
            aria-hidden="true"
          >
            <div
              className={dragPreview.source.className}
              style={dragPreview.source.paddingLeft ? { paddingLeft: dragPreview.source.paddingLeft } : undefined}
              dangerouslySetInnerHTML={{ __html: dragPreview.source.html }}
            />
          </div>
        </Portal>
      )}
      <div className="shrink-0 border-b border-border px-2 py-2">
        <div className="mb-2 flex items-center gap-2">
          <span className="flex shrink-0 cursor-pointer" onDoubleClick={openProjectRootFolder}>
            <Folder size={15} className="ui-file-explorer-root-icon" />
          </span>
          <div className="ui-file-tooltip min-w-0 flex-1 cursor-pointer" data-tooltip={project.path} onDoubleClick={openProjectRootFolder}>
            <div className="ui-file-explorer-title truncate text-xs font-semibold">{project.name}</div>
            <div className="ui-file-explorer-subtitle truncate text-[10px]">{displayPathName}</div>
          </div>
          <button
            className="ui-file-tooltip ui-icon-action"
            data-tooltip={searchToggleLabel}
            aria-label={searchToggleLabel}
            aria-pressed={searchControlsVisible}
            onClick={toggleSearchControls}
          >
            {searchControlsVisible ? <EyeOff size={13} /> : <Search size={13} />}
          </button>
          <button className="ui-file-tooltip ui-icon-action" data-tooltip={t("common.refresh")} aria-label={t("files.refreshList")} onClick={() => void refresh()}>
            <RefreshCw size={13} />
          </button>
          <button className="ui-file-tooltip ui-icon-action" data-tooltip={closeLabel} aria-label={closeLabel} onClick={handleClose}>
            <X size={14} />
          </button>
        </div>
        {searchControlsVisible && (
          <>
            <div className="ui-file-search-input-shell flex items-center gap-1 rounded-md border border-border bg-surface-container-lowest px-1.5">
              <Search size={13} className="text-text-muted" />
              <input
                ref={searchInputRef}
                className="min-w-0 flex-1 bg-transparent py-1 text-xs text-on-surface outline-none"
                value={searchQuery}
                aria-label={searchLabel}
                placeholder={searchLabel}
                onChange={(event) => void setSearchQuery(event.currentTarget.value)}
              />
              <div className="ui-file-search-mode-inline flex shrink-0 items-center gap-0.5 rounded border border-border bg-surface-container-low p-0.5">
                {SEARCH_MODES.map((mode) => {
                  const active = searchMode === mode.value;
                  return (
                    <button
                      key={mode.value}
                      type="button"
                      className={[
                        "ui-file-search-mode-option rounded px-1.5 py-0.5 text-[10px] leading-4 transition-colors",
                        active ? "text-on-surface" : "text-text-muted hover:text-on-surface",
                      ].join(" ")}
                      data-selected={active ? "true" : "false"}
                      aria-pressed={active}
                      onClick={() => setSearchMode(mode.value)}
                    >
                      {t(mode.labelKey)}
                    </button>
                  );
                })}
              </div>
            </div>
          </>
        )}
        {clipboard && <div className="mt-1 truncate text-[10px] text-text-muted">{clipboard.mode === "copy" ? t("files.clipboard.copy") : t("files.clipboard.move")}：{clipboard.name}</div>}
      </div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className="min-h-0 flex-1 overflow-y-auto px-1 py-1 outline-none ui-thin-scroll"
            tabIndex={0}
            data-file-drop-target-path=""
            onKeyDown={handleRootKeyDown}
            onDragOver={handleRootDragOver}
            onDrop={handleRootDrop}
          >
            {renderRows}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="file-explorer-menu" portalContainer={menuPortalContainer}>
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
          <ContextMenuItem onSelect={openProjectRootFolder}>
            <FolderOpen size={13} /> {t("files.menu.openContainingFolder")}
          </ContextMenuItem>
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
