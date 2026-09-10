import type { GitFileChange } from "../../../shared/types/index";
import { isUntracked } from "./gitTreeModel";

// 一次遍历提供标题统计和全选路径；调用方按快照/取消选择集合 memo，不随输入或分支刷新重算。
export function summarizeGitChanges(changes: GitFileChange[], deselected: Set<string>) {
  const summary = {
    allCount: changes.length, modifiedCount: 0, addedCount: 0, deletedCount: 0, trackableCount: 0,
    totalAdded: 0, totalDeleted: 0, stagedCount: 0, deselectedAddedCount: 0, hasConflicts: false,
    allUntrackedPaths: [] as string[], addedPaths: [] as string[], trackedModPaths: [] as string[],
  };
  for (const change of changes) {
    const untracked = isUntracked(change.status);
    if (change.status === "M") summary.modifiedCount++;
    if (change.status === "A" || untracked) summary.addedCount++;
    if (change.status === "D") summary.deletedCount++;
    if (!untracked) summary.trackableCount++;
    summary.totalAdded += change.added || 0;
    summary.totalDeleted += change.deleted || 0;
    if (change.staged) summary.stagedCount++;
    if (change.status === "C") summary.hasConflicts = true;
    if (untracked) summary.allUntrackedPaths.push(change.path);
    else if (change.status === "A") {
      summary.addedPaths.push(change.path);
      if (deselected.has(change.path)) summary.deselectedAddedCount++;
    } else summary.trackedModPaths.push(change.path);
  }
  return summary;
}
