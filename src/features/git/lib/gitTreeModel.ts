import type { GitFileChange, GitTreeNode } from "../../../shared/types/index";

export type GitStatusFilter = "all" | "M" | "A" | "D" | "U";
export type GitTreeGrouping = "directory" | "module";
export interface GitChangeTrees { tree: GitTreeNode[]; untrackedTree: GitTreeNode[] }
const BUILD_BATCH_SIZE = 1000;

export function isUntracked(status: string): boolean {
  return status === "U" || status === "??";
}

// 分块排序后归并，fallback 也能在排序期间让出主线程，避免一次全数组 sort。
function* sortItems<T>(changes: T[], compare: (a: T, b: T) => number): Generator<void, T[]> {
  let runs: T[][] = [];
  for (let i = 0; i < changes.length; i += BUILD_BATCH_SIZE) {
    runs.push(changes.slice(i, i + BUILD_BATCH_SIZE).sort(compare));
    yield;
  }
  while (runs.length > 1) {
    const merged: T[][] = [];
    for (let r = 0; r < runs.length; r += 2) {
      if (!runs[r + 1]) { merged.push(runs[r]); continue; }
      const a = runs[r], b = runs[r + 1], output: T[] = [];
      let i = 0, j = 0;
      while (i < a.length || j < b.length) {
        output.push(j === b.length || (i < a.length && compare(a[i], b[j]) <= 0) ? a[i++] : b[j++]);
        if (output.length % BUILD_BATCH_SIZE === 0) yield;
      }
      merged.push(output);
    }
    runs = merged;
  }
  return runs[0] ?? [];
}

// 所有执行环境共用同一个生成器，Worker 与分批 fallback 保持路径、排序和分组一致。
export function* buildGitChangeTrees(
  changes: GitFileChange[], filter: GitStatusFilter, groupBy: GitTreeGrouping,
): Generator<void, GitChangeTrees> {
  const sorted = yield* sortItems(changes, (a, b) => a.path.localeCompare(b.path));
  const result: GitChangeTrees = { tree: [], untrackedTree: [] };
  const directories = { tracked: new Map<string, GitTreeNode>(), untracked: new Map<string, GitTreeNode>() };
  for (let index = 0; index < sorted.length; index++) {
    if (index % BUILD_BATCH_SIZE === 0) yield;
    const change = sorted[index];
    const untracked = isUntracked(change.status);
    if (!untracked && filter !== "all" && filter !== "U" && change.status !== filter) continue;
    const dirMap = untracked ? directories.untracked : directories.tracked;
    let level = untracked ? result.untrackedTree : result.tree;
    let path = "";
    const parts = change.path.split(/[/\\]/);
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      path = path ? `${path}/${name}` : name;
      if (i === parts.length - 1) {
        level.push({ type: "file", name, path, change, ...(groupBy === "module" && i === 0 ? { isModuleRoot: true } : {}) });
      } else {
        let directory = dirMap.get(path);
        if (!directory) {
          directory = { type: "directory", name, path, children: [], ...(groupBy === "module" && i === 0 ? { isModuleRoot: true } : {}) };
          dirMap.set(path, directory);
          level.push(directory);
        }
        level = directory.children!;
      }
    }
  }
  // 模块根按模块名排序；目录模式保留原有按完整路径插入的顺序。
  if (groupBy === "module") {
    for (const key of ["tree", "untrackedTree"] as const) {
      const roots = yield* sortItems(result[key], (a, b) => a.name.localeCompare(b.name));
      const modules: GitTreeNode[] = [];
      for (let i = 0; i < roots.length; i++) {
        if (i % BUILD_BATCH_SIZE === 0) yield;
        const root = roots[i];
        // 文件/目录互换时，删除的旧后代与新文件可同名；沿用原模块容器，不能合并丢失条目。
        if (roots[i + 1]?.name === root.name) {
          const children = [root];
          while (roots[i + 1]?.name === root.name) children.push(roots[++i]);
          for (const child of children) delete child.isModuleRoot;
          modules.push({ type: "directory", name: root.name, path: root.path, children, isModuleRoot: true });
        } else modules.push(root);
      }
      result[key] = modules;
    }
  }
  return result;
}

// 相同快照保留引用，避免 watcher/聚焦重复结果重建树。顺序改变仍按新结果处理。
export function sameGitChanges(left: GitFileChange[], right: GitFileChange[]): boolean {
  return left === right || (left.length === right.length && left.every((a, i) => {
    const b = right[i];
    return a.path === b.path && a.status === b.status && a.staged === b.staged && a.added === b.added && a.deleted === b.deleted;
  }));
}

// 压缩显示保持原目录行为：当前行展示自身及连续单子目录后缀，操作指向链尾。
export function collectCompactDirectoryChain(node: GitTreeNode): { suffixParts: string[]; leaf: GitTreeNode } {
  const suffixParts: string[] = [];
  let leaf = node;
  if (!node.isModuleRoot) {
    while (leaf.type === "directory" && leaf.children?.length === 1 && leaf.children[0].type === "directory") {
      leaf = leaf.children[0];
      suffixParts.push(leaf.name);
    }
  }
  return { suffixParts, leaf };
}

// 批量操作调用时才收集完整后代，虚拟可见范围不影响操作范围。
export function collectFileChanges(node: GitTreeNode): GitFileChange[] {
  const files: GitFileChange[] = [];
  const stack = [node];
  while (stack.length) {
    const current = stack.pop()!;
    if (current.change) files.push(current.change);
    else if (current.children) for (let i = current.children.length - 1; i >= 0; i--) stack.push(current.children[i]);
  }
  return files;
}

export interface GitDirectorySummary { total: number; untracked: number; checked: number }

// 每个节点只汇总一次，折叠/滚动不重算；不为每个目录分配一份后代文件数组。
export function summarizeGitDirectories(
  roots: GitTreeNode[], selected: Set<string>, deselected: Set<string>,
): Map<GitTreeNode, GitDirectorySummary> {
  const summaries = new Map<GitTreeNode, GitDirectorySummary>();
  const stack: Array<{ node: GitTreeNode; parent?: GitDirectorySummary }> = roots.map(node => ({ node }));
  const ordered: Array<{ summary: GitDirectorySummary; parent?: GitDirectorySummary }> = [];
  while (stack.length) {
    const { node, parent } = stack.pop()!;
    if (node.change) {
      if (parent) {
        const untracked = isUntracked(node.change.status);
        parent.total++;
        if (untracked) parent.untracked++;
        if (untracked ? selected.has(node.change.path) : node.change.status === "A" ? !deselected.has(node.change.path) : node.change.staged) parent.checked++;
      }
    } else {
      const summary = { total: 0, untracked: 0, checked: 0 };
      summaries.set(node, summary);
      ordered.push({ summary, parent });
      for (const child of node.children ?? []) stack.push({ node: child, parent: summary });
    }
  }
  for (let i = ordered.length - 1; i >= 0; i--) {
    const { summary, parent } = ordered[i];
    if (parent) { parent.total += summary.total; parent.untracked += summary.untracked; parent.checked += summary.checked; }
  }
  return summaries;
}

export type GitVisibleRow = { key: string; treeId: string } & (
  { kind: "section" } | { kind: "node"; node: GitTreeNode; depth: number }
);

// 标题与两棵树共用一个虚拟列表，避免第二分区偏移和嵌套滚动条。
export function flattenGitRows(tree: GitTreeNode[], untracked: GitTreeNode[], collapsed: Set<string>): GitVisibleRow[] {
  const rows: GitVisibleRow[] = [];
  for (const [treeId, roots] of [["tracked", tree], ["untracked", untracked]] as const) {
    if (!roots.length) continue;
    rows.push({ kind: "section", key: `${treeId}:section`, treeId });
    const stack = roots.map(node => ({ node, depth: 0 })).reverse();
    while (stack.length) {
      const { node, depth } = stack.pop()!;
      rows.push({ kind: "node", key: `${treeId}:node:${depth}:${node.type}:${node.path}`, treeId, node, depth });
      const { leaf } = collectCompactDirectoryChain(node);
      if (!collapsed.has(`${treeId}:${leaf.path}`)) {
        const children = leaf.children ?? [];
        for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i], depth: depth + 1 });
      }
    }
  }
  return rows;
}
