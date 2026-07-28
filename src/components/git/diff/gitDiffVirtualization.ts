import type { ChangeData, HunkData } from "react-diff-view";
import type { GitDiffViewMode } from "../../../stores/settingsStore";

const HUNK_HEADER_HEIGHT = 28;
const DIFF_ROW_HEIGHT = 24;

export function countGitDiffRenderRows(
  changes: readonly ChangeData[],
  viewMode: GitDiffViewMode,
): number {
  if (viewMode === "unified") return changes.length;
  let rows = 0;
  for (let index = 0; index < changes.length; index += 1) {
    if (changes[index].type === "delete" && changes[index + 1]?.type === "insert") {
      index += 1;
    }
    rows += 1;
  }
  return rows;
}

export function estimateGitDiffHunkHeight(
  hunk: HunkData,
  viewMode: GitDiffViewMode,
): number {
  return HUNK_HEADER_HEIGHT + countGitDiffRenderRows(hunk.changes, viewMode) * DIFF_ROW_HEIGHT;
}
