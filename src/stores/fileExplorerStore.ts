import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { toast } from "sonner";
import type {
  GitFileChange,
  Project,
  ProjectFileContentMatch,
  ProjectFileEntry,
  ProjectFilePreviewKind,
  ProjectFileSearchMode,
  ProjectImageFilePayload,
  ProjectTextFilePayload,
} from "../lib/types";
import { logError, recordCrashActivity } from "../lib/logger";
import { translateCurrent } from "../lib/i18n";
import { isSameProjectFileContext, isSameProjectFileLocation } from "../lib/terminalProject";
import { projectSupportsCapability } from "../lib/projectCapabilities";
import { activateProjectFileSurface } from "./gitDiffWorkspaceStore";
import {
  buildSshRemoteFileContext,
  releaseSshRemoteFileContext,
  remoteEntryToSearchMatch,
  sshRemoteListDir,
  sshRemoteReadFile,
  sshRemoteSearch,
  type SshRemoteFileContext,
} from "../lib/sshRemoteFiles";

type ClipboardMode = "copy" | "move";
type FileEntryKind = "file" | "directory";
type DecodedProjectTextFilePayload = ProjectTextFilePayload & {
  encoding: string;
  hasBom: boolean;
  guessed: boolean;
};

interface FileClipboard {
  mode: ClipboardMode;
  path: string;
  name: string;
}

export interface ActiveProjectFile {
  path: string;
  name: string;
  previewKind: ProjectFilePreviewKind;
  content: string;
  savedContent: string;
  image: ProjectImageFilePayload | null;
  encoding: string | null;
  hasBom: boolean;
  sizeBytes: number;
  modifiedMs?: number | null;
}

function errorHasCode(error: unknown, code: string): boolean {
  return String(error).includes(code);
}

function fileReadErrorMessage(error: unknown): string {
  if (errorHasCode(error, "binary_file")) return translateCurrent("files.error.binaryFile");
  if (errorHasCode(error, "video_preview_unsupported")) return translateCurrent("files.error.videoUnsupported");
  if (errorHasCode(error, "image_dimensions_too_large")) return translateCurrent("files.error.imageDimensionsTooLarge");
  if (errorHasCode(error, "image_file_too_large")) return translateCurrent("files.error.imageTooLarge");
  if (errorHasCode(error, "remote_file_too_large")) return translateCurrent("files.error.tooLarge");
  if (errorHasCode(error, "file_too_large")) return translateCurrent("files.error.tooLarge");
  if (errorHasCode(error, "text_decode_failed") || errorHasCode(error, "text_encoding_unknown")) {
    return translateCurrent("files.error.encodingUnknown");
  }
  return translateCurrent("files.error.readFailed");
}

function fileSaveErrorMessage(error: unknown): string {
  if (errorHasCode(error, "text_encoding_unmappable")) {
    return translateCurrent("files.error.encodingUnmappable");
  }
  if (errorHasCode(error, "unsupported_text_encoding") || errorHasCode(error, "text_encode_failed")) {
    return translateCurrent("files.error.encodingUnsupported");
  }
  return translateCurrent("files.error.saveFailed");
}

interface FileSearchNavigationTarget {
  path: string;
  lineNumber: number;
  lineText?: string;
  columnNumber?: number;
  source: "search" | "terminal";
}

interface FileExplorerStore {
  project: Project | null;
  remoteFileContext: SshRemoteFileContext | null;
  tree: ProjectFileEntry[];
  searchMode: ProjectFileSearchMode;
  searchQuery: string;
  searchResults: ProjectFileEntry[];
  contentSearchResults: ProjectFileContentMatch[];
  searchLoading: boolean;
  expandedPaths: Set<string>;
  selectedTreePath: string | null;
  loading: boolean;
  openFiles: ActiveProjectFile[];
  activeFilePath: string | null;
  activeFile: ActiveProjectFile | null;
  searchNavigationTarget: FileSearchNavigationTarget | null;
  gitChanges: GitFileChange[];
  clipboard: FileClipboard | null;
  openProject: (project: Project) => Promise<void>;
  closeProject: () => void;
  refresh: () => Promise<void>;
  refreshVisibleState: (changedPaths?: string[]) => Promise<void>;
  refreshVisibleStateOnce: (changedPaths?: string[]) => Promise<void>;
  refreshGitChanges: () => Promise<void>;
  loadDir: (path: string) => Promise<void>;
  toggleDir: (path: string) => Promise<void>;
  expandCompactDirChain: (path: string) => Promise<void>;
  collapseDir: (path: string) => void;
  setSearchMode: (mode: ProjectFileSearchMode) => void;
  setSearchQuery: (query: string) => Promise<void>;
  openFile: (entry: ProjectFileEntry) => Promise<void>;
  openFileAtSearchMatch: (match: ProjectFileContentMatch) => Promise<void>;
  revealPath: (path: string, options?: { lineNumber?: number; columnNumber?: number }) => Promise<boolean>;
  clearSearchNavigationTarget: () => void;
  setActiveFilePath: (path: string) => void;
  closeFile: (path: string) => void;
  setActiveContent: (content: string) => void;
  saveFile: (path: string) => Promise<void>;
  saveActiveFile: () => Promise<void>;
  createEntry: (parentPath: string, name: string, kind: FileEntryKind, overwrite: boolean) => Promise<void>;
  renameEntry: (path: string, newName: string, overwrite: boolean) => Promise<void>;
  deleteEntry: (path: string) => Promise<void>;
  setClipboard: (clipboard: FileClipboard | null) => void;
  pasteInto: (targetParentPath: string, overwrite: boolean) => Promise<void>;
}

export const DEFAULT_COLLAPSED_DIRECTORY_NAMES = [
  ".git",
  ".hg",
  ".svn",
  ".ace-tool",
  ".aider",
  ".augment",
  ".claude",
  ".cline",
  ".codex",
  ".continue",
  ".context",
  ".copilot",
  ".cody",
  ".cursor",
  ".devcontainer",
  ".devbox",
  ".devenv",
  ".direnv",
  ".eclipse",
  ".emacs.d",
  ".fleet",
  ".gemini",
  ".goose",
  ".helix",
  ".history",
  ".idea",
  ".idea_modules",
  ".ionide",
  ".jdtls",
  ".kiro",
  ".kdev4",
  ".lapce",
  ".lsp",
  ".metadata",
  ".netbeans",
  ".nvim",
  ".nova",
  ".openhands",
  ".opencode",
  ".omnisharp",
  ".projectile",
  ".qoder",
  ".ropeproject",
  ".roo",
  ".run",
  ".serena",
  ".settings",
  ".superpowers",
  ".tabnine",
  ".trae",
  ".trellis",
  ".vscode",
  ".vscode-insiders",
  ".vscode-test",
  ".vagrant",
  ".vim",
  ".windsurf",
  ".worktrees",
  ".zed",
  ".zed-server",
  "nbproject",
  "node_modules",
  "bower_components",
  ".yarn",
  ".pnpm-store",
  "vendor",
  "Pods",
  "Carthage",
  "deps",
  "dist",
  "build",
  "out",
  "output",
  ".output",
  "target",
  "bin",
  "obj",
  "Debug",
  "Release",
  "x64",
  "x86",
  "coverage",
  "htmlcov",
  "reports",
  "arthas-output",
  "BASE_HOME_IS_UNDEFINED",
  "nul",
  "artifacts",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".astro",
  ".remix",
  ".vite",
  ".turbo",
  ".parcel-cache",
  ".webpack",
  ".angular",
  ".expo",
  ".vercel",
  ".netlify",
  ".docusaurus",
  "storybook-static",
  ".cache",
  "cache",
  ".gradle",
  ".intellijPlatform",
  ".bloop",
  ".bsp",
  ".ccls-cache",
  ".clangd",
  ".metals",
  ".scala-build",
  ".dart_tool",
  ".bundle",
  ".terraform",
  ".serverless",
  ".aws-sam",
  ".build",
  ".vs",
  "xcuserdata",
  "_ReSharper.Caches",
  "DerivedData",
  "CMakeFiles",
  "cmake-build-debug",
  "cmake-build-release",
  "cmake-build-relwithdebinfo",
  "cmake-build-minsizerel",
  "generated",
  "generated-sources",
  "generated-test-sources",
  "classes",
  "TestResults",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".nox",
  ".tox",
  ".pyre",
  ".pytype",
  ".hypothesis",
  ".ipynb_checkpoints",
  ".venv",
  "venv",
  "env",
  ".env",
  "logs",
  "log",
  "tmp",
  "temp",
  ".sass-cache",
  ".nyc_output",
  "jspm_packages",
  "out-tsc",
  ".gradle-cache",
  ".kotlin",
  ".mtj.tmp",
  ".nx",
] as const;

const DEFAULT_COLLAPSED_DIRECTORY_NAME_SET = new Set(
  DEFAULT_COLLAPSED_DIRECTORY_NAMES.map((name) => name.toLowerCase())
);

const SEARCH_DEBOUNCE_MS = 220;
let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let searchRequestSeq = 0;
let openProjectRequestSeq = 0;
const inFlightGitChangeRequests = new Map<string, Promise<GitFileChange[]>>();
let refreshVisibleStateInFlight: Promise<void> | null = null;
let pendingRefreshChangedPaths: Set<string> | null | undefined;
const remoteFileContextReleases = new Map<string, Promise<void>>();

export function isDefaultCollapsedDirectoryName(name: string): boolean {
  return DEFAULT_COLLAPSED_DIRECTORY_NAME_SET.has(name.toLowerCase());
}

function collapsePath(paths: Set<string>, targetPath: string): Set<string> {
  if (!targetPath) return new Set([""]);
  return new Set(Array.from(paths).filter((path) => path !== targetPath && !path.startsWith(`${targetPath}/`)));
}

function normalizeEntry(entry: ProjectFileEntry): ProjectFileEntry {
  return {
    ...entry,
    kind: entry.kind === "directory" ? "directory" : "file",
    children: entry.children?.map(normalizeEntry),
  };
}

function replaceChildren(
  entries: ProjectFileEntry[],
  targetPath: string,
  children: ProjectFileEntry[]
): ProjectFileEntry[] {
  if (targetPath === "") return children;
  return entries.map((entry) => {
    if (entry.path === targetPath) return { ...entry, children };
    if (entry.children) return { ...entry, children: replaceChildren(entry.children, targetPath, children) };
    return entry;
  });
}

function getLoadedDirectoryChildren(
  entries: ProjectFileEntry[],
  targetPath: string
): ProjectFileEntry[] | undefined {
  if (targetPath === "") return entries;
  for (const entry of entries) {
    if (entry.path === targetPath) {
      return entry.kind === "directory" ? entry.children : undefined;
    }
    if (entry.children && targetPath.startsWith(`${entry.path}/`)) {
      const children = getLoadedDirectoryChildren(entry.children, targetPath);
      if (children !== undefined) return children;
    }
  }
  return undefined;
}

function mergeLoadedSubtrees(
  entries: ProjectFileEntry[],
  previousEntries: ProjectFileEntry[]
): ProjectFileEntry[] {
  const previousByPath = new Map(previousEntries.map((entry) => [entry.path, entry]));
  return entries.map((entry) => {
    const previous = previousByPath.get(entry.path);
    if (!previous?.children || entry.children) return entry;
    return { ...entry, children: previous.children };
  });
}

function replaceChildrenKeepingLoadedSubtrees(
  entries: ProjectFileEntry[],
  targetPath: string,
  children: ProjectFileEntry[]
): ProjectFileEntry[] {
  if (targetPath === "") return mergeLoadedSubtrees(children, entries);
  return entries.map((entry) => {
    if (entry.path === targetPath) {
      return { ...entry, children: mergeLoadedSubtrees(children, entry.children ?? []) };
    }
    if (entry.children) {
      return { ...entry, children: replaceChildrenKeepingLoadedSubtrees(entry.children, targetPath, children) };
    }
    return entry;
  });
}

function pathDepth(path: string): number {
  return path ? path.split("/").length : 0;
}

function parentPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

function normalizeRelativeFilePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

function basename(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? path : path.slice(index + 1);
}

function extension(path: string): string {
  const name = basename(path);
  const index = name.lastIndexOf(".");
  return index === -1 ? "" : name.slice(index + 1).toLowerCase();
}

function isMarkdown(path: string): boolean {
  return ["md", "markdown", "mdown", "mkd"].includes(extension(path));
}

function isImage(path: string): boolean {
  return ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"].includes(extension(path));
}

const TEXT_PREVIEW_MAX_BYTES = 1024 * 1024;
const IMAGE_PREVIEW_MAX_BYTES = 5 * 1024 * 1024;
const VIDEO_EXTENSIONS = new Set([
  "3g2", "3gp", "avi", "flv", "m2ts", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "mts", "ogv", "ts", "webm", "wmv",
]);

function previewGuardError(path: string, sizeBytes: number): string | null {
  if (VIDEO_EXTENSIONS.has(extension(path))) return "video_preview_unsupported";
  if (sizeBytes <= 0) return null;
  if (isImage(path) && sizeBytes > IMAGE_PREVIEW_MAX_BYTES) return "image_file_too_large";
  if (!isImage(path) && sizeBytes > TEXT_PREVIEW_MAX_BYTES) return "file_too_large";
  return null;
}

async function listDir(rootPath: string, path: string): Promise<ProjectFileEntry[]> {
  const entries = await invoke<ProjectFileEntry[]>("file_list_dir", {
    rootPath,
    relativePath: path,
  });
  return entries.map(normalizeEntry);
}

async function loadProjectFile(
  project: Project,
  entry: Pick<ProjectFileEntry, "path" | "name" | "sizeBytes" | "modifiedMs">,
  remoteContext?: SshRemoteFileContext | null,
): Promise<{ file: ActiveProjectFile; errorMessage?: string }> {
  try {
    const guardError = previewGuardError(entry.path, entry.sizeBytes);
    if (guardError) throw new Error(guardError);
    if (remoteContext) {
      const remote = await sshRemoteReadFile(remoteContext, entry.path);
      if (remote.previewKind === "image") {
        const match = remote.content.match(/^data:([^;]+);base64,(.*)$/s);
        if (!match) throw new Error("remote_file_image_invalid");
        return { file: { path: entry.path, name: entry.name, previewKind: "image", content: "", savedContent: "", image: { dataBase64: match[2], mimeType: match[1], sizeBytes: remote.sizeBytes }, encoding: null, hasBom: false, sizeBytes: remote.sizeBytes, modifiedMs: remote.modifiedMs } };
      }
      return { file: { path: entry.path, name: entry.name, previewKind: isMarkdown(entry.path) ? "markdown" : "text", content: remote.content, savedContent: remote.content, image: null, encoding: "utf-8", hasBom: false, sizeBytes: remote.sizeBytes, modifiedMs: remote.modifiedMs } };
    }
    if (isImage(entry.path)) {
      const image = await invoke<ProjectImageFilePayload>("file_read_image", {
        rootPath: project.path,
        relativePath: entry.path,
      });
      return {
        file: {
          path: entry.path,
          name: entry.name,
          previewKind: "image",
          content: "",
          savedContent: "",
          image,
          encoding: null,
          hasBom: false,
          sizeBytes: image.sizeBytes,
          modifiedMs: entry.modifiedMs ?? null,
        },
      };
    }

    const text = await invoke<DecodedProjectTextFilePayload>("file_read_project_text", {
      rootPath: project.path,
      relativePath: entry.path,
    });
    return {
      file: {
        path: entry.path,
        name: entry.name,
        previewKind: isMarkdown(entry.path) ? "markdown" : "text",
        content: text.content,
        savedContent: text.content,
        image: null,
        encoding: text.encoding,
        hasBom: text.hasBom,
        sizeBytes: text.sizeBytes,
        modifiedMs: entry.modifiedMs ?? null,
      },
    };
  } catch (err) {
    return {
      file: {
        path: entry.path,
        name: entry.name,
        previewKind: "unsupported",
        content: "",
        savedContent: "",
        image: null,
        encoding: null,
        hasBom: false,
        sizeBytes: entry.sizeBytes,
        modifiedMs: entry.modifiedMs ?? null,
      },
      errorMessage: fileReadErrorMessage(err),
    };
  }
}

function collectEntriesByPath(entries: ProjectFileEntry[], map: Map<string, ProjectFileEntry>): void {
  for (const entry of entries) {
    map.set(entry.path, entry);
    if (entry.children) collectEntriesByPath(entry.children, map);
  }
}

async function fetchGitChanges(projectPath: string): Promise<GitFileChange[]> {
  const existing = inFlightGitChangeRequests.get(projectPath);
  if (existing) return existing;

  const request = invoke<GitFileChange[]>("git_get_changes", { projectPath })
    .catch(() => [])
    .finally(() => {
      if (inFlightGitChangeRequests.get(projectPath) === request) {
        inFlightGitChangeRequests.delete(projectPath);
      }
    });
  inFlightGitChangeRequests.set(projectPath, request);
  return request;
}

function isSameOrChildPath(path: string, targetPath: string): boolean {
  return path === targetPath || path.startsWith(`${targetPath}/`);
}

function selectFallbackFile(files: ActiveProjectFile[], closedPath: string): ActiveProjectFile | null {
  if (files.length === 0) return null;
  const closedIndex = files.findIndex((file) => file.path === closedPath);
  if (closedIndex <= 0) return files[0];
  return files[Math.min(closedIndex - 1, files.length - 1)];
}

function changedPathAffectsFile(changedPath: string, filePath: string): boolean {
  return changedPath === "" || changedPath === filePath || filePath.startsWith(`${changedPath}/`);
}

function shouldRefreshOpenFile(filePath: string, changedPaths?: string[]): boolean {
  return !changedPaths?.length || changedPaths.some((path) => changedPathAffectsFile(path, filePath));
}

function addDirectoryPathWithAncestors(paths: Set<string>, path: string): void {
  paths.add("");
  if (!path) return;
  let current = "";
  for (const segment of path.split("/")) {
    if (!segment) continue;
    current = current ? `${current}/${segment}` : segment;
    paths.add(current);
  }
}

function collectRefreshPaths(
  expandedPaths: Set<string>,
  openFiles: ActiveProjectFile[],
  changedPaths?: string[]
): string[] {
  if (!changedPaths?.length) {
    const paths = new Set<string>();
    for (const path of expandedPaths) addDirectoryPathWithAncestors(paths, path);
    for (const file of openFiles) addDirectoryPathWithAncestors(paths, parentPath(file.path));
    return Array.from(paths).sort((a, b) => pathDepth(a) - pathDepth(b));
  }

  const paths = new Set<string>();
  for (const path of changedPaths) {
    if (path === "") {
      paths.add("");
      continue;
    }
    if (path === ".git" || path.startsWith(".git/")) continue;
    addDirectoryPathWithAncestors(paths, parentPath(path));
  }
  for (const file of openFiles) {
    if (shouldRefreshOpenFile(file.path, changedPaths)) {
      addDirectoryPathWithAncestors(paths, parentPath(file.path));
    }
  }
  return Array.from(paths).sort((a, b) => pathDepth(a) - pathDepth(b));
}

function mergePendingRefreshPaths(changedPaths?: string[]): void {
  if (!changedPaths?.length) {
    pendingRefreshChangedPaths = null;
    return;
  }
  if (pendingRefreshChangedPaths === null) return;
  pendingRefreshChangedPaths ??= new Set<string>();
  for (const path of changedPaths) pendingRefreshChangedPaths.add(path);
}

function remoteFileContextReleaseKey(context: SshRemoteFileContext): string {
  return `${context.launch.hostId}\0${context.consumerId}`;
}

function releaseRemoteFileContext(context: SshRemoteFileContext | null): Promise<void> {
  if (!context) return Promise.resolve();
  const key = remoteFileContextReleaseKey(context);
  const previousRelease = remoteFileContextReleases.get(key) ?? Promise.resolve();
  const release = previousRelease
    .catch(() => undefined)
    .then(() => releaseSshRemoteFileContext(context))
    .catch(() => undefined)
    .finally(() => {
      if (remoteFileContextReleases.get(key) === release) {
        remoteFileContextReleases.delete(key);
      }
    });
  remoteFileContextReleases.set(key, release);
  return release;
}

async function waitForRemoteFileContextRelease(context: SshRemoteFileContext): Promise<void> {
  await remoteFileContextReleases.get(remoteFileContextReleaseKey(context));
}

export const useFileExplorerStore = create<FileExplorerStore>((set, get) => ({
  project: null,
  remoteFileContext: null,
  tree: [],
  searchMode: "files",
  searchQuery: "",
  searchResults: [],
  contentSearchResults: [],
  searchLoading: false,
  expandedPaths: new Set([""]),
  selectedTreePath: null,
  loading: false,
  openFiles: [],
  activeFilePath: null,
  activeFile: null,
  searchNavigationTarget: null,
  gitChanges: [],
  clipboard: null,

  openProject: async (project) => {
    if (!projectSupportsCapability(project, "files")) {
      throw new Error("remote_project_capability_unsupported:files");
    }
    const current = get().project;
    if (isSameProjectFileLocation(current, project)) {
      if (current !== project) set({ project });
      return;
    }

    const requestSeq = ++openProjectRequestSeq;
    const previousRemoteFileContext = get().remoteFileContext;
    set({
      project,
      remoteFileContext: null,
      tree: [],
      loading: true,
      searchMode: "files",
      searchQuery: "",
      searchResults: [],
      contentSearchResults: [],
      searchLoading: false,
      expandedPaths: new Set([""]),
      selectedTreePath: null,
      openFiles: [],
      activeFilePath: null,
      activeFile: null,
      searchNavigationTarget: null,
      gitChanges: [],
      clipboard: null,
    });
    void releaseRemoteFileContext(previousRemoteFileContext);
    let remoteContext: SshRemoteFileContext | null = null;
    try {
      remoteContext = project.environment_type === "ssh" ? await buildSshRemoteFileContext(project) : null;
      if (remoteContext) await waitForRemoteFileContextRelease(remoteContext);
      if (requestSeq !== openProjectRequestSeq || !isSameProjectFileContext(get().project, project)) return;
      set({ remoteFileContext: remoteContext });
      const [tree, gitChanges] = await Promise.all([
        remoteContext ? sshRemoteListDir(remoteContext) : listDir(project.path, ""),
        remoteContext ? Promise.resolve([]) : fetchGitChanges(project.path),
      ]);
      if (
        requestSeq !== openProjectRequestSeq
        || !isSameProjectFileContext(get().project, project)
        || get().remoteFileContext !== remoteContext
      ) {
        return;
      }
      set({ tree, gitChanges, loading: false });
    } catch (err) {
      if (requestSeq !== openProjectRequestSeq || !isSameProjectFileContext(get().project, project)) return;
      if (get().remoteFileContext === remoteContext) {
        set({ remoteFileContext: null });
        void releaseRemoteFileContext(remoteContext);
      }
      logError("Failed to open project files", err);
      toast.error("文件列表加载失败", { description: String(err) });
      set({ tree: [], gitChanges: [], loading: false });
    }
  },

  closeProject: () => {
    openProjectRequestSeq += 1;
    const remoteFileContext = get().remoteFileContext;
    set({
      project: null,
      remoteFileContext: null,
      tree: [],
      searchMode: "files",
      searchQuery: "",
      searchResults: [],
      contentSearchResults: [],
      searchLoading: false,
      expandedPaths: new Set([""]),
      selectedTreePath: null,
      openFiles: [],
      activeFilePath: null,
      activeFile: null,
      searchNavigationTarget: null,
      gitChanges: [],
      clipboard: null,
    });
    void releaseRemoteFileContext(remoteFileContext);
  },

  refresh: async () => {
    const project = get().project;
    if (!project) return;
    await get().refreshVisibleState();
  },

  refreshVisibleState: async (changedPaths) => {
    const normalizedChangedPaths = changedPaths
      ?.map(normalizeRelativeFilePath)
      .filter((path, index, paths) => paths.indexOf(path) === index);

    if (refreshVisibleStateInFlight) {
      mergePendingRefreshPaths(normalizedChangedPaths);
      await refreshVisibleStateInFlight;
      return;
    }

    refreshVisibleStateInFlight = (async () => {
      let nextChangedPaths = normalizedChangedPaths;
      while (true) {
        await get().refreshVisibleStateOnce(nextChangedPaths);
        if (pendingRefreshChangedPaths === undefined) break;
        const pending = pendingRefreshChangedPaths;
        pendingRefreshChangedPaths = undefined;
        nextChangedPaths = pending === null ? undefined : Array.from(pending);
      }
    })().finally(() => {
      refreshVisibleStateInFlight = null;
    });

    await refreshVisibleStateInFlight;
  },

  refreshVisibleStateOnce: async (changedPaths) => {
    const state = get();
    const project = state.project;
    if (!project) return;

    const remoteFileContext = state.remoteFileContext;
    // SSH 项目的本地 path 为空。远程上下文尚未建立或已经失败时，绝不能
    // 回落到本地 file_* command，否则会把空根路径送进 canonical_root。
    if (project.environment_type === "ssh" && !remoteFileContext) return;

    const expandedPaths = state.expandedPaths;
    const openFiles = state.openFiles;
    const refreshPaths = collectRefreshPaths(expandedPaths, openFiles, changedPaths);

    try {
      const refreshedDirs = (await Promise.all(refreshPaths.map(async (path) => {
        try {
          return {
            path,
            children: remoteFileContext
              ? await sshRemoteListDir(remoteFileContext, path)
              : await listDir(project.path, path),
          };
        } catch (err) {
          if (path === "") throw err;
          logError(`Failed to refresh project file dir: ${path}`, err);
          return null;
        }
      }))).filter((item): item is { path: string; children: ProjectFileEntry[] } => item !== null);

      const nextTree = refreshedDirs.length > 0
        ? refreshedDirs.reduce(
          (tree, dir) => replaceChildrenKeepingLoadedSubtrees(tree, dir.path, dir.children),
          get().tree
        )
        : get().tree;
      const entryByPath = new Map<string, ProjectFileEntry>();
      collectEntriesByPath(nextTree, entryByPath);

      const nextOpenFiles: ActiveProjectFile[] = [];
      for (const file of openFiles) {
        if (!shouldRefreshOpenFile(file.path, changedPaths)) {
          nextOpenFiles.push(file);
          continue;
        }

        const latestEntry = entryByPath.get(file.path);
        const dirty = file.content !== file.savedContent;

        if (!latestEntry) {
          if (dirty) nextOpenFiles.push(file);
          continue;
        }

        const baseFile = {
          ...file,
          name: latestEntry.name,
          sizeBytes: latestEntry.sizeBytes,
          modifiedMs: latestEntry.modifiedMs ?? null,
        };

        if (dirty) {
          nextOpenFiles.push(baseFile);
          continue;
        }

        const changed = file.modifiedMs !== (latestEntry.modifiedMs ?? null)
          || file.sizeBytes !== latestEntry.sizeBytes;
        if (!changed) {
          nextOpenFiles.push(baseFile);
          continue;
        }

        const { file: refreshedFile } = await loadProjectFile(project, latestEntry, remoteFileContext);
        nextOpenFiles.push(refreshedFile);
      }

      const currentState = get();
      if (
        !isSameProjectFileContext(currentState.project, project)
        || currentState.remoteFileContext?.consumerId !== remoteFileContext?.consumerId
      ) {
        return;
      }

      const activeFile = nextOpenFiles.find((file) => file.path === get().activeFilePath) ?? nextOpenFiles[0] ?? null;
      set({
        tree: nextTree,
        openFiles: nextOpenFiles,
        activeFilePath: activeFile?.path ?? null,
        activeFile,
      });
    } catch (err) {
      logError("Failed to refresh visible project files", err);
    }

    await get().refreshGitChanges();
    const query = get().searchQuery.trim();
    if (query) await get().setSearchQuery(get().searchQuery);
  },

  refreshGitChanges: async () => {
    const project = get().project;
    if (!project || project.environment_type === "ssh") {
      if (project?.environment_type === "ssh") {
        set({ gitChanges: [] });
      }
      return;
    }
    const gitChanges = await fetchGitChanges(project.path);
    set({ gitChanges });
  },

  loadDir: async (path) => {
    const project = get().project;
    if (!project) return;
    const children = get().remoteFileContext
      ? await sshRemoteListDir(get().remoteFileContext!, path)
      : await listDir(project.path, path);
    set((state) => ({ tree: replaceChildren(state.tree, path, children) }));
  },

  toggleDir: async (path) => {
    const expanded = new Set(get().expandedPaths);
    if (expanded.has(path)) {
      expanded.delete(path);
      set({ expandedPaths: expanded });
      return;
    }
    expanded.add(path);
    set({ expandedPaths: expanded });
    const remoteFileContext = get().remoteFileContext;
    if (remoteFileContext && getLoadedDirectoryChildren(get().tree, path) !== undefined) {
      return;
    }
    await get().loadDir(path);
  },

  expandCompactDirChain: async (path) => {
    const project = get().project;
    if (!project) return;

    const remoteFileContext = get().remoteFileContext;
    const currentTree = get().tree;
    const loadedDirs: Array<{ path: string; children: ProjectFileEntry[] }> = [];
    const expandedDirectoryPaths: string[] = [];
    let currentPath = path;

    while (true) {
      const cachedChildren = remoteFileContext
        ? getLoadedDirectoryChildren(currentTree, currentPath)
        : undefined;
      const children = cachedChildren ?? (remoteFileContext
        ? await sshRemoteListDir(remoteFileContext, currentPath)
        : await listDir(project.path, currentPath));
      if (cachedChildren === undefined) loadedDirs.push({ path: currentPath, children });
      expandedDirectoryPaths.push(currentPath);

      if (
        children.length !== 1
        || children[0].kind !== "directory"
        || isDefaultCollapsedDirectoryName(children[0].name)
      ) {
        break;
      }

      currentPath = children[0].path;
    }

    set((state) => ({
      expandedPaths: new Set([...state.expandedPaths, ...expandedDirectoryPaths]),
      tree: loadedDirs.reduce(
        (tree, dir) => replaceChildrenKeepingLoadedSubtrees(tree, dir.path, dir.children),
        state.tree
      ),
    }));
  },

  collapseDir: (path) => {
    set((state) => ({ expandedPaths: collapsePath(state.expandedPaths, path) }));
  },

  setSearchMode: (mode) => {
    if (searchDebounceTimer) {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = null;
    }
    searchRequestSeq += 1;
    set({
      searchMode: mode,
      searchResults: [],
      contentSearchResults: [],
      searchLoading: false,
    });
    const query = get().searchQuery;
    if (query.trim()) void get().setSearchQuery(query);
  },

  setSearchQuery: async (query) => {
    const project = get().project;
    const mode = get().searchMode;
    const requestSeq = searchRequestSeq + 1;
    searchRequestSeq = requestSeq;

    if (searchDebounceTimer) {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = null;
    }

    if (!project || !query.trim()) {
      set({
        searchQuery: query,
        searchResults: [],
        contentSearchResults: [],
        searchLoading: false,
      });
      return;
    }

    set({
      searchQuery: query,
      searchLoading: true,
      ...(mode === "files" ? { contentSearchResults: [] } : { searchResults: [] }),
    });

    searchDebounceTimer = setTimeout(() => {
      searchDebounceTimer = null;
      void (async () => {
        const isLatest = () => (
          requestSeq === searchRequestSeq
          && get().project?.id === project.id
          && get().searchMode === mode
          && get().searchQuery === query
        );

        try {
          if (mode === "files") {
            const results = get().remoteFileContext
              ? await sshRemoteSearch(get().remoteFileContext!, query)
              : await invoke<ProjectFileEntry[]>("file_search", { rootPath: project.path, query });
            if (!isLatest()) return;
            set({ searchResults: results.map(normalizeEntry), searchLoading: false });
            return;
          }

          const results = get().remoteFileContext
            ? (await sshRemoteSearch(get().remoteFileContext!, query, true)).map(remoteEntryToSearchMatch)
            : await invoke<ProjectFileContentMatch[]>("file_search_content", { rootPath: project.path, query });
          if (!isLatest()) return;
          set({ contentSearchResults: results, searchLoading: false });
        } catch (err) {
          if (!isLatest()) return;
          logError(mode === "files" ? "File search failed" : "File content search failed", err);
          set({ searchLoading: false });
          toast.error(
            translateCurrent(mode === "files" ? "files.toast.searchFailed" : "files.toast.contentSearchFailed"),
            { description: String(err) }
          );
        }
      })();
    }, SEARCH_DEBOUNCE_MS);
  },

  openFile: async (entry) => {
    const project = get().project;
    if (!project || entry.kind !== "file") return;
    activateProjectFileSurface(project);
    recordCrashActivity("file.preview_open", {
      projectId: project.id,
      projectPath: project.path,
      filePath: entry.path,
      sizeBytes: entry.sizeBytes,
      extension: extension(entry.path),
      previewKind: isImage(entry.path) ? "image" : isMarkdown(entry.path) ? "markdown" : "text",
    });
    const existing = get().openFiles.find((file) => file.path === entry.path);
    if (existing) {
      set({ activeFilePath: existing.path, activeFile: existing });
      return;
    }

    set({ loading: true });
    try {
      const { file, errorMessage } = await loadProjectFile(project, entry, get().remoteFileContext);
      set({
        loading: false,
        openFiles: [...get().openFiles, file],
        activeFilePath: file.path,
        activeFile: file,
      });
      if (errorMessage) {
        toast.warning(translateCurrent("files.toast.previewFailed"), { description: errorMessage });
      }
    } catch (err) {
      set({ loading: false });
      throw err;
    }
  },

  openFileAtSearchMatch: async (match) => {
    await get().openFile({
      name: match.name,
      path: match.path,
      kind: "file",
      sizeBytes: 0,
    });
    set({
      searchNavigationTarget: {
        path: match.path,
        lineNumber: match.lineNumber,
        lineText: match.lineText,
        source: "search",
      },
    });
  },

  revealPath: async (path, options) => {
    const project = get().project;
    if (!project) return false;
    const normalizedPath = path.replace(/\\/g, "/").replace(/^\/+|\/+$/gu, "");
    if (!normalizedPath || normalizedPath.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
      return false;
    }

    const loadedDirs: Array<{ path: string; children: ProjectFileEntry[] }> = [];
    const directoryPathsToExpand = new Set<string>();
    const remoteFileContext = get().remoteFileContext;
    const currentTree = get().tree;
    const fetchedChildren = new Map<string, ProjectFileEntry[]>();
    const resolveChildren = async (directoryPath: string): Promise<ProjectFileEntry[]> => {
      const fetched = fetchedChildren.get(directoryPath);
      if (fetched) return fetched;
      const cached = remoteFileContext
        ? getLoadedDirectoryChildren(currentTree, directoryPath)
        : undefined;
      if (cached !== undefined) return cached;
      const children = remoteFileContext
        ? await sshRemoteListDir(remoteFileContext, directoryPath)
        : await listDir(project.path, directoryPath);
      fetchedChildren.set(directoryPath, children);
      loadedDirs.push({ path: directoryPath, children });
      return children;
    };
    let parentPath = "";
    let target: ProjectFileEntry | null = null;
    for (const segment of normalizedPath.split("/")) {
      directoryPathsToExpand.add(parentPath);
      const children = await resolveChildren(parentPath);
      const currentPath = parentPath ? `${parentPath}/${segment}` : segment;
      target = children.find((entry) => entry.path === currentPath) ?? null;
      if (!target) return false;
      parentPath = currentPath;
    }
    if (!target) return false;

    if (target.kind === "directory") {
      directoryPathsToExpand.add(target.path);
      await resolveChildren(target.path);
    }

    set((state) => ({
      tree: loadedDirs.reduce(
        (tree, dir) => replaceChildrenKeepingLoadedSubtrees(tree, dir.path, dir.children),
        state.tree
      ),
      expandedPaths: new Set([
        ...state.expandedPaths,
        ...directoryPathsToExpand,
      ]),
      selectedTreePath: target.path,
      searchQuery: "",
      searchResults: [],
      contentSearchResults: [],
      searchLoading: false,
    }));

    if (target.kind === "directory") return true;
    await get().openFile(target);
    if (options?.lineNumber) {
      set({
        searchNavigationTarget: {
          path: target.path,
          lineNumber: options.lineNumber,
          ...(options.columnNumber ? { columnNumber: options.columnNumber } : {}),
          source: "terminal",
        },
      });
    }
    return true;
  },

  clearSearchNavigationTarget: () => {
    set({ searchNavigationTarget: null });
  },

  setActiveFilePath: (path) => {
    const file = get().openFiles.find((item) => item.path === path) ?? null;
    if (!file) return;
    set({ activeFilePath: file.path, activeFile: file });
  },

  closeFile: (path) => {
    const files = get().openFiles;
    const remaining = files.filter((file) => file.path !== path);
    const fallback = get().activeFilePath === path ? selectFallbackFile(remaining, path) : get().activeFile;
    set({
      openFiles: remaining,
      activeFilePath: fallback?.path ?? null,
      activeFile: fallback,
    });
  },

  setActiveContent: (content) => {
    const activePath = get().activeFilePath;
    if (!activePath) return;
    const files = get().openFiles.map((file) => (
      file.path === activePath ? { ...file, content } : file
    ));
    const activeFile = files.find((file) => file.path === activePath) ?? null;
    set({ openFiles: files, activeFile });
  },

  saveFile: async (path) => {
    const project = get().project;
    if (project?.environment_type === "ssh") throw new Error("remote_project_read_only");
    const file = get().openFiles.find((item) => item.path === path);
    if (!project || !file || file.previewKind === "image" || !file.encoding) return;
    try {
      await invoke("file_write_project_text", {
        rootPath: project.path,
        relativePath: file.path,
        content: file.content,
        encoding: file.encoding,
        hasBom: file.hasBom,
      });
    } catch (err) {
      logError("Failed to save project file", err);
      toast.error(translateCurrent("files.toast.saveFailed"), {
        description: fileSaveErrorMessage(err),
      });
      throw err;
    }
    const saved = { ...file, savedContent: file.content };
    set({
      openFiles: get().openFiles.map((file) => file.path === saved.path ? saved : file),
      activeFile: get().activeFilePath === saved.path ? saved : get().activeFile,
    });
    try {
      await get().refreshGitChanges();
    } catch (err) {
      logError("Failed to refresh Git changes after saving project file", err);
    }
    toast.success(translateCurrent("files.toast.saved"));
  },

  saveActiveFile: async () => {
    const activeFile = get().activeFile;
    if (!activeFile) return;
    await get().saveFile(activeFile.path);
  },

  createEntry: async (parent, name, kind, overwrite) => {
    const project = get().project;
    if (project?.environment_type === "ssh") throw new Error("remote_project_read_only");
    if (!project) return;
    const command = kind === "directory" ? "file_create_dir" : "file_create_file";
    await invoke(command, { rootPath: project.path, parentPath: parent, name, overwrite });
    await get().loadDir(parent);
    await get().refreshGitChanges();
    if (get().searchQuery.trim()) await get().setSearchQuery(get().searchQuery);
  },

  renameEntry: async (path, newName, overwrite) => {
    const project = get().project;
    if (project?.environment_type === "ssh") throw new Error("remote_project_read_only");
    if (!project) return;
    await invoke("file_rename", {
      rootPath: project.path,
      relativePath: path,
      newName,
      overwrite,
    });
    await get().loadDir(parentPath(path));
    await get().refreshGitChanges();
    const openFiles = get().openFiles.filter((file) => !isSameOrChildPath(file.path, path));
    const activeFile = openFiles.find((file) => file.path === get().activeFilePath) ?? null;
    set({ openFiles, activeFilePath: activeFile?.path ?? null, activeFile });
    if (get().searchQuery.trim()) await get().setSearchQuery(get().searchQuery);
  },

  deleteEntry: async (path) => {
    const project = get().project;
    if (project?.environment_type === "ssh") throw new Error("remote_project_read_only");
    if (!project) return;
    await invoke("file_delete", { rootPath: project.path, relativePath: path });
    await get().loadDir(parentPath(path));
    await get().refreshGitChanges();
    const openFiles = get().openFiles.filter((file) => !isSameOrChildPath(file.path, path));
    const activeFile = openFiles.find((file) => file.path === get().activeFilePath) ?? openFiles[0] ?? null;
    set({ openFiles, activeFilePath: activeFile?.path ?? null, activeFile });
    if (get().searchQuery.trim()) await get().setSearchQuery(get().searchQuery);
  },

  setClipboard: (clipboard) => set({ clipboard }),

  pasteInto: async (targetParentPath, overwrite) => {
    const project = get().project;
    if (project?.environment_type === "ssh") throw new Error("remote_project_read_only");
    const clipboard = get().clipboard;
    if (!project || !clipboard) return;
    const command = clipboard.mode === "copy" ? "file_copy" : "file_move";
    await invoke(command, {
      rootPath: project.path,
      sourcePath: clipboard.path,
      targetParentPath,
      name: clipboard.name,
      overwrite,
    });
    const refreshPaths = clipboard.mode === "move"
      ? [targetParentPath, parentPath(clipboard.path)]
      : [targetParentPath];
    const uniqueRefreshPaths = Array.from(new Set(refreshPaths)).sort((a, b) => pathDepth(a) - pathDepth(b));
    const refreshedDirs = await Promise.all(uniqueRefreshPaths.map(async (path) => ({
      path,
      children: await listDir(project.path, path),
    })));
    set((state) => ({
      tree: refreshedDirs.reduce(
        (tree, dir) => replaceChildrenKeepingLoadedSubtrees(tree, dir.path, dir.children),
        state.tree
      ),
    }));
    await get().refreshGitChanges();
    if (clipboard.mode === "move") {
      const openFiles = get().openFiles.filter((file) => !isSameOrChildPath(file.path, clipboard.path));
      const activeFile = openFiles.find((file) => file.path === get().activeFilePath) ?? openFiles[0] ?? null;
      set({ openFiles, activeFilePath: activeFile?.path ?? null, activeFile });
      set({ clipboard: null });
    }
    if (get().searchQuery.trim()) await get().setSearchQuery(get().searchQuery);
  },
}));

export function isProjectFileDirty(): boolean {
  return useFileExplorerStore.getState().openFiles.some((file) => file.content !== file.savedContent);
}
