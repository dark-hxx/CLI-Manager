import type { ProjectFileEntry } from "../../../shared/types/index";

export type FileOperationEntry = Pick<ProjectFileEntry, "path" | "name" | "kind"> & {
  isSymlink?: boolean;
};
export type FileOperationMode = "copy" | "move" | "delete";
export interface FileBatchResult {
  succeeded: FileOperationEntry[];
  skipped: FileOperationEntry[];
  conflicts: FileOperationEntry[];
  failures: Array<{ entry: FileOperationEntry; error: string }>;
}

export function filePathKey(path: string, ignoreCase = false): string {
  return ignoreCase ? path.toLowerCase() : path;
}

// Windows 路径不区分大小写；WSL UNC 保留 Linux 路径语义，不能整体转为小写。
export function fileOperationRootKey(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const wsl = /^\/\/wsl(?:\$|\.localhost)\//i.test(normalized);
  return !wsl && (/^[a-z]:\//i.test(normalized) || normalized.startsWith("//"))
    ? normalized.toLowerCase() : normalized;
}

export function filePathContains(parent: string, path: string, ignoreCase = false): boolean {
  const root = filePathKey(parent, ignoreCase);
  const child = filePathKey(path, ignoreCase);
  return root === child || (root !== "" && child.startsWith(`${root}/`));
}

export function selectFileEntries(
  selected: FileOperationEntry[], entry: FileOperationEntry, toggle: boolean,
): FileOperationEntry[] {
  if (!toggle) return [entry];
  return selected.some((item) => item.path === entry.path)
    ? selected.filter((item) => item.path !== entry.path)
    : [...selected, entry];
}

// 在已选中行打开菜单时操作整组；未选中行的菜单只操作该行。
export function fileActionEntries(selected: FileOperationEntry[], entry: FileOperationEntry): FileOperationEntry[] {
  return selected.some((item) => item.path === entry.path) ? selected : [entry];
}

// 保留选择顺序并去除重复项及已选目录的后代，避免同一对象被修改两次。
export function normalizeFileOperationEntries(entries: FileOperationEntry[], ignoreCase = false): FileOperationEntry[] {
  const unique = [...new Map(entries.map((entry) => [filePathKey(entry.path, ignoreCase), entry])).values()];
  return unique.filter((entry) => !unique.some((parent) => (
    parent !== entry && parent.kind === "directory" && filePathContains(parent.path, entry.path, ignoreCase)
  )));
}

// 文件快捷键不接管搜索、重命名或编辑器中的文本输入。
export function isFileActionInput(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && Boolean(target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox']"));
}

/** Sequential, non-transactional operations: never retry successes when a conflict is confirmed. */
export async function runFileOperationBatch(options: {
  entries: FileOperationEntry[];
  mode: FileOperationMode;
  targetParentPath?: string;
  ignoreCase?: boolean;
  shouldContinue: () => boolean;
  guard: (entry: FileOperationEntry, targetPath: string) => void;
  execute: (entry: FileOperationEntry) => Promise<void>;
  onSuccess: (entry: FileOperationEntry, targetPath: string) => void;
}): Promise<FileBatchResult> {
  const { mode, targetParentPath = "", ignoreCase = false } = options;
  const entries = normalizeFileOperationEntries(options.entries, ignoreCase);
  const result: FileBatchResult = { succeeded: [], skipped: [], conflicts: [], failures: [] };
  const targetCounts = new Map<string, number>();
  if (mode !== "delete") {
    for (const entry of entries) {
      const key = filePathKey(entry.name, ignoreCase);
      targetCounts.set(key, (targetCounts.get(key) ?? 0) + 1);
    }
  }
  for (const entry of entries) {
    const targetPath = targetParentPath ? `${targetParentPath}/${entry.name}` : entry.name;
    try {
      if (!options.shouldContinue()) throw new Error("file_operation_context_changed");
      if (!entry.path) throw new Error("cannot_modify_root");
      if (entry.isSymlink) throw new Error("path_is_symlink");
      if (mode !== "delete") {
        if ((targetCounts.get(filePathKey(entry.name, ignoreCase)) ?? 0) > 1) {
          throw new Error("batch_duplicate_target");
        }
        if (filePathKey(entry.path, ignoreCase) === filePathKey(targetPath, ignoreCase)) {
          if (mode === "copy") throw new Error("source_equals_target");
          result.skipped.push(entry);
          continue;
        }
        if (entry.kind === "directory" && filePathContains(entry.path, targetParentPath, ignoreCase)) {
          throw new Error("target_inside_source");
        }
        // Do not overwrite another selected source while it is still awaiting its turn.
        if (entries.some((source) => filePathContains(targetPath, source.path, ignoreCase))) {
          throw new Error("target_overlaps_selection");
        }
      }
      options.guard(entry, targetPath);
      await options.execute(entry);
      result.succeeded.push(entry);
      options.onSuccess(entry, targetPath);
    } catch (error) {
      const message = String(error);
      if (message.includes("target_exists")) result.conflicts.push(entry);
      else result.failures.push({ entry, error: message });
    }
  }
  return result;
}
