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
import { logError } from "../lib/logger";
import { translateCurrent } from "../lib/i18n";

type ClipboardMode = "copy" | "move";
type FileEntryKind = "file" | "directory";

interface FileClipboard {
  mode: ClipboardMode;
  path: string;
  name: string;
}

interface ActiveProjectFile {
  path: string;
  name: string;
  previewKind: ProjectFilePreviewKind;
  content: string;
  savedContent: string;
  image: ProjectImageFilePayload | null;
  sizeBytes: number;
  modifiedMs?: number | null;
}

interface FileSearchNavigationTarget {
  path: string;
  lineNumber: number;
  lineText: string;
}

interface FileExplorerStore {
  project: Project | null;
  tree: ProjectFileEntry[];
  searchMode: ProjectFileSearchMode;
  searchQuery: string;
  searchResults: ProjectFileEntry[];
  contentSearchResults: ProjectFileContentMatch[];
  searchLoading: boolean;
  expandedPaths: Set<string>;
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
  refreshVisibleState: () => Promise<void>;
  refreshGitChanges: () => Promise<void>;
  loadDir: (path: string) => Promise<void>;
  toggleDir: (path: string) => Promise<void>;
  expandCompactDirChain: (path: string) => Promise<void>;
  collapseDir: (path: string) => void;
  setSearchMode: (mode: ProjectFileSearchMode) => void;
  setSearchQuery: (query: string) => Promise<void>;
  openFile: (entry: ProjectFileEntry) => Promise<void>;
  openFileAtSearchMatch: (match: ProjectFileContentMatch) => Promise<void>;
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
] as const;

const DEFAULT_COLLAPSED_DIRECTORY_NAME_SET = new Set(
  DEFAULT_COLLAPSED_DIRECTORY_NAMES.map((name) => name.toLowerCase())
);

const SEARCH_DEBOUNCE_MS = 220;
let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let searchRequestSeq = 0;
const inFlightGitChangeRequests = new Map<string, Promise<GitFileChange[]>>();

export function isDefaultCollapsedDirectoryName(name: string): boolean {
  return DEFAULT_COLLAPSED_DIRECTORY_NAME_SET.has(name.toLowerCase());
}

function isDefaultCollapsedPath(path: string): boolean {
  if (!path) return false;
  return path
    .split("/")
    .some(isDefaultCollapsedDirectoryName);
}

function pruneDefaultCollapsedPaths(paths: Set<string>): Set<string> {
  return new Set(Array.from(paths).filter((path) => path === "" || !isDefaultCollapsedPath(path)));
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

async function listDir(rootPath: string, path: string): Promise<ProjectFileEntry[]> {
  const entries = await invoke<ProjectFileEntry[]>("file_list_dir", {
    rootPath,
    relativePath: path,
  });
  return entries.map(normalizeEntry);
}

async function loadProjectFile(
  project: Project,
  entry: Pick<ProjectFileEntry, "path" | "name" | "sizeBytes" | "modifiedMs">
): Promise<{ file: ActiveProjectFile; errorMessage?: string }> {
  try {
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
          sizeBytes: image.sizeBytes,
          modifiedMs: entry.modifiedMs ?? null,
        },
      };
    }

    const text = await invoke<ProjectTextFilePayload>("file_read_text", {
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
        sizeBytes: entry.sizeBytes,
        modifiedMs: entry.modifiedMs ?? null,
      },
      errorMessage: String(err),
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

export const useFileExplorerStore = create<FileExplorerStore>((set, get) => ({
  project: null,
  tree: [],
  searchMode: "files",
  searchQuery: "",
  searchResults: [],
  contentSearchResults: [],
  searchLoading: false,
  expandedPaths: new Set([""]),
  loading: false,
  openFiles: [],
  activeFilePath: null,
  activeFile: null,
  searchNavigationTarget: null,
  gitChanges: [],
  clipboard: null,

  openProject: async (project) => {
    const current = get().project;
    const keepCurrentProject = current?.id === project.id;
    set({
      project,
      loading: true,
      searchMode: "files",
      searchQuery: "",
      searchResults: [],
      contentSearchResults: [],
      searchLoading: false,
      expandedPaths: keepCurrentProject ? pruneDefaultCollapsedPaths(get().expandedPaths) : new Set([""]),
      openFiles: keepCurrentProject ? get().openFiles : [],
      activeFilePath: keepCurrentProject ? get().activeFilePath : null,
      activeFile: keepCurrentProject ? get().activeFile : null,
      searchNavigationTarget: keepCurrentProject ? get().searchNavigationTarget : null,
      gitChanges: keepCurrentProject ? get().gitChanges : [],
      clipboard: keepCurrentProject ? get().clipboard : null,
    });
    try {
      const [tree, gitChanges] = await Promise.all([
        listDir(project.path, ""),
        fetchGitChanges(project.path),
      ]);
      set({ tree, gitChanges, loading: false });
    } catch (err) {
      logError("Failed to open project files", err);
      toast.error("文件列表加载失败", { description: String(err) });
      set({ tree: [], gitChanges: [], loading: false });
    }
  },

  closeProject: () => {
    set({
      project: null,
      tree: [],
      searchMode: "files",
      searchQuery: "",
      searchResults: [],
      contentSearchResults: [],
      searchLoading: false,
      expandedPaths: new Set([""]),
      openFiles: [],
      activeFilePath: null,
      activeFile: null,
      searchNavigationTarget: null,
      gitChanges: [],
      clipboard: null,
    });
  },

  refresh: async () => {
    const project = get().project;
    if (!project) return;
    await get().openProject(project);
    if (get().searchQuery.trim()) await get().setSearchQuery(get().searchQuery);
  },

  refreshVisibleState: async () => {
    const project = get().project;
    if (!project) return;

    const expandedPaths = Array.from(get().expandedPaths);
    const openFiles = get().openFiles;
    const refreshPaths = Array.from(new Set([
      "",
      ...expandedPaths,
      ...openFiles.map((file) => parentPath(file.path)),
    ])).sort((a, b) => pathDepth(a) - pathDepth(b));

    try {
      const refreshedDirs = (await Promise.all(refreshPaths.map(async (path) => {
        try {
          return {
            path,
            children: await listDir(project.path, path),
          };
        } catch (err) {
          if (path === "") throw err;
          logError(`Failed to refresh project file dir: ${path}`, err);
          return null;
        }
      }))).filter((item): item is { path: string; children: ProjectFileEntry[] } => item !== null);

      const nextTree = refreshedDirs.reduce(
        (tree, dir) => replaceChildrenKeepingLoadedSubtrees(tree, dir.path, dir.children),
        get().tree
      );
      const entryByPath = new Map<string, ProjectFileEntry>();
      collectEntriesByPath(nextTree, entryByPath);

      const nextOpenFiles: ActiveProjectFile[] = [];
      for (const file of openFiles) {
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

        const { file: refreshedFile } = await loadProjectFile(project, latestEntry);
        nextOpenFiles.push(refreshedFile);
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
    if (!project) return;
    const gitChanges = await fetchGitChanges(project.path);
    set({ gitChanges });
  },

  loadDir: async (path) => {
    const project = get().project;
    if (!project) return;
    const children = await listDir(project.path, path);
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
    await get().loadDir(path);
  },

  expandCompactDirChain: async (path) => {
    const project = get().project;
    if (!project) return;

    const loadedDirs: Array<{ path: string; children: ProjectFileEntry[] }> = [];
    let currentPath = path;

    while (true) {
      const children = await listDir(project.path, currentPath);
      loadedDirs.push({ path: currentPath, children });

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
      expandedPaths: new Set([...state.expandedPaths, ...loadedDirs.map((dir) => dir.path)]),
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
            const results = await invoke<ProjectFileEntry[]>("file_search", {
              rootPath: project.path,
              query,
            });
            if (!isLatest()) return;
            set({ searchResults: results.map(normalizeEntry), searchLoading: false });
            return;
          }

          const results = await invoke<ProjectFileContentMatch[]>("file_search_content", {
            rootPath: project.path,
            query,
          });
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
    const existing = get().openFiles.find((file) => file.path === entry.path);
    if (existing) {
      set({ activeFilePath: existing.path, activeFile: existing });
      return;
    }

    set({ loading: true });
    try {
      const { file, errorMessage } = await loadProjectFile(project, entry);
      set({
        loading: false,
        openFiles: [...get().openFiles, file],
        activeFilePath: file.path,
        activeFile: file,
      });
      if (errorMessage) {
        toast.warning("无法预览此文件", { description: errorMessage });
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
      },
    });
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
    const file = get().openFiles.find((item) => item.path === path);
    if (!project || !file || file.previewKind === "image") return;
    await invoke("file_write_text", {
      rootPath: project.path,
      relativePath: file.path,
      content: file.content,
    });
    const saved = { ...file, savedContent: file.content };
    set({
      openFiles: get().openFiles.map((file) => file.path === saved.path ? saved : file),
      activeFile: get().activeFilePath === saved.path ? saved : get().activeFile,
    });
    await get().refreshGitChanges();
    toast.success("文件已保存");
  },

  saveActiveFile: async () => {
    const activeFile = get().activeFile;
    if (!activeFile) return;
    await get().saveFile(activeFile.path);
  },

  createEntry: async (parent, name, kind, overwrite) => {
    const project = get().project;
    if (!project) return;
    const command = kind === "directory" ? "file_create_dir" : "file_create_file";
    await invoke(command, { rootPath: project.path, parentPath: parent, name, overwrite });
    await get().loadDir(parent);
    await get().refreshGitChanges();
    if (get().searchQuery.trim()) await get().setSearchQuery(get().searchQuery);
  },

  renameEntry: async (path, newName, overwrite) => {
    const project = get().project;
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
