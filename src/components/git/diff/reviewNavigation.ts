import type { GitTreeNode } from "../../../lib/types";
import type { GitDiffTarget } from "./types";

export type GitDiffReviewStatusFilter = "all" | "M" | "A" | "D" | "U";
export type GitDiffNavigationDirection = "previous" | "next";
export type GitDiffHunkPlacement = "first" | "last";

export interface GitDiffReviewTarget extends GitDiffTarget {
  sourcePath: string;
  additions: number;
  deletions: number;
}

interface BuildReviewTargetsOptions {
  tree: GitTreeNode[];
  untrackedTree: GitTreeNode[];
  statusFilter: GitDiffReviewStatusFilter;
  repositoryPath: string;
  repositoryRelativePath?: string;
}

export interface ReviewNavigationPosition {
  targetIndex: number;
  hunkIndex: number;
  placement?: GitDiffHunkPlacement;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+|\/+$/gu, "");
}

function normalizeRepositoryIdentity(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  if (normalized === "/" || /^[A-Za-z]:\/$/u.test(normalized)) return normalized;
  return normalized.replace(/\/+$/gu, "");
}

function appendFileTargets(
  targets: GitDiffReviewTarget[],
  nodes: GitTreeNode[],
  repositoryPath: string,
  repositoryRelativePath: string,
): void {
  for (const node of nodes) {
    if (node.type === "directory") {
      appendFileTargets(targets, node.children ?? [], repositoryPath, repositoryRelativePath);
      continue;
    }
    if (!node.change) continue;
    const filePath = normalizePath(node.change.path);
    const sourcePath = normalizePath(
      repositoryRelativePath ? `${repositoryRelativePath}/${filePath}` : filePath,
    );
    targets.push({
      id: `${normalizeRepositoryIdentity(repositoryPath)}\u0000${filePath}`,
      projectPath: repositoryPath,
      filePath,
      fileName: node.name,
      status: node.change.status,
      sourcePath,
      additions: node.change.added,
      deletions: node.change.deleted,
    });
  }
}

export function buildGitDiffReviewTargets({
  tree,
  untrackedTree,
  statusFilter,
  repositoryPath,
  repositoryRelativePath = "",
}: BuildReviewTargetsOptions): GitDiffReviewTarget[] {
  const targets: GitDiffReviewTarget[] = [];
  const normalizedRelativePath = normalizePath(repositoryRelativePath);
  appendFileTargets(targets, tree, repositoryPath, normalizedRelativePath);
  if (statusFilter !== "M" && statusFilter !== "D") {
    appendFileTargets(targets, untrackedTree, repositoryPath, normalizedRelativePath);
  }
  return targets;
}

export function reconcileReviewTargetIndex(
  targets: GitDiffReviewTarget[],
  currentTargetId: string | null,
  previousIndex: number,
): number {
  if (targets.length === 0) return -1;
  const matchingIndex = currentTargetId
    ? targets.findIndex((target) => target.id === currentTargetId)
    : -1;
  if (matchingIndex >= 0) return matchingIndex;
  return Math.min(Math.max(previousIndex, 0), targets.length - 1);
}

export function stepReviewNavigation(
  direction: GitDiffNavigationDirection,
  position: ReviewNavigationPosition,
  targetCount: number,
  hunkCount: number,
): ReviewNavigationPosition | null {
  if (direction === "next") {
    if (position.hunkIndex + 1 < hunkCount) {
      return { targetIndex: position.targetIndex, hunkIndex: position.hunkIndex + 1 };
    }
    if (position.targetIndex + 1 >= targetCount) return null;
    return { targetIndex: position.targetIndex + 1, hunkIndex: 0, placement: "first" };
  }

  if (position.hunkIndex > 0) {
    return { targetIndex: position.targetIndex, hunkIndex: position.hunkIndex - 1 };
  }
  if (position.targetIndex <= 0) return null;
  return { targetIndex: position.targetIndex - 1, hunkIndex: 0, placement: "last" };
}
