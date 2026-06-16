import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { GitFileChange, GitTreeNode } from "../lib/types";

interface GitStore {
  changes: GitFileChange[];
  tree: GitTreeNode[];
  collapsedDirs: Set<string>;
  loading: boolean;
  error: string | null;
  currentProjectPath: string | null;

  fetchChanges: (projectPath: string) => Promise<void>;
  toggleDir: (path: string) => void;
  reset: () => void;
}

function buildTree(changes: GitFileChange[]): GitTreeNode[] {
  const root: GitTreeNode[] = [];
  const dirMap = new Map<string, GitTreeNode>();

  // 按路径排序
  const sorted = [...changes].sort((a, b) => a.path.localeCompare(b.path));

  for (const change of sorted) {
    const parts = change.path.split(/[/\\]/);
    let currentLevel = root;
    let currentPath = "";

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      currentPath = currentPath ? `${currentPath}/${part}` : part;

      if (i === parts.length - 1) {
        // 文件节点
        currentLevel.push({
          type: "file",
          name: part,
          path: currentPath,
          change,
        });
      } else {
        // 目录节点
        let dir = dirMap.get(currentPath);
        if (!dir) {
          dir = {
            type: "directory",
            name: part,
            path: currentPath,
            children: [],
          };
          dirMap.set(currentPath, dir);
          currentLevel.push(dir);
        }
        currentLevel = dir.children!;
      }
    }
  }

  return root;
}

export const useGitStore = create<GitStore>((set) => ({
  changes: [],
  tree: [],
  collapsedDirs: new Set(),
  loading: false,
  error: null,
  currentProjectPath: null,

  fetchChanges: async (projectPath: string) => {
    console.log(`[GitStore] 开始获取 Git 变更, projectPath: "${projectPath}"`);
    set({ loading: true, error: null, currentProjectPath: projectPath });

    try {
      console.log(`[GitStore] 调用后端命令 git_get_changes`);
      const changes = await invoke<GitFileChange[]>("git_get_changes", { projectPath });
      console.log(`[GitStore] 获取到 ${changes.length} 个变更文件`);
      const tree = buildTree(changes);
      console.log(`[GitStore] 构建树结构完成，根节点数: ${tree.length}`);
      set({ changes, tree, loading: false });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[GitStore] 获取 Git 变更失败:`, err);
      set({ error: errorMsg, loading: false, changes: [], tree: [] });
    }
  },

  toggleDir: (path: string) => {
    set((state) => {
      const newCollapsed = new Set(state.collapsedDirs);
      if (newCollapsed.has(path)) {
        newCollapsed.delete(path);
      } else {
        newCollapsed.add(path);
      }
      return { collapsedDirs: newCollapsed };
    });
  },

  reset: () => {
    set({
      changes: [],
      tree: [],
      collapsedDirs: new Set(),
      loading: false,
      error: null,
      currentProjectPath: null,
    });
  },
}));
