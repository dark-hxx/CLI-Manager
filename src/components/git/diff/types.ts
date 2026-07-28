import type { ChangeEventArgs, FileData } from "react-diff-view";
import type { GitFileDiffPayload } from "../../../lib/gitTransport";
import type { GitDiffHunkPlacement } from "./reviewNavigation";

export type GitDiffLineSide = "old" | "new";

export interface GitDiffSelectedLine {
  side: GitDiffLineSide;
  lineNumber: number;
}

export interface GitDiffTarget {
  id: string;
  projectPath?: string;
  filePath: string;
  fileName: string;
  status: string;
}

export interface GitDiffReviewContext {
  fileIndex: number;
  fileCount: number;
  additions: number;
  deletions: number;
  initialHunkPlacement: GitDiffHunkPlacement;
  canNavigateToPreviousFile: boolean;
  canNavigateToNextFile: boolean;
  onNavigateToPreviousFile: () => void;
  onNavigateToNextFile: () => void;
  onOpenSource: (lineNumber?: number) => void;
  onPin?: () => void;
  pinActive?: boolean;
}

export interface GitDiffMutationActions {
  revertHunk?: (
    target: GitDiffTarget,
    diffText: string,
    hunkIndex: number,
  ) => Promise<void>;
  revertLines?: (
    target: GitDiffTarget,
    diffText: string,
    selectedLines: GitDiffSelectedLine[],
  ) => Promise<void>;
  requestDiscard?: (target: GitDiffTarget) => void;
}

export interface GitDiffSnapshotDataSource {
  kind: "snapshot";
  content: string;
}

export interface GitDiffLiveDataSource {
  kind: "live";
  load: (target: GitDiffTarget) => Promise<GitFileDiffPayload>;
  mutations?: GitDiffMutationActions;
}

export type GitDiffDataSource = GitDiffSnapshotDataSource | GitDiffLiveDataSource;

export interface ParsedGitDiff {
  file: FileData;
  syntaxHighlight: boolean;
}

export interface GitDiffController {
  diffText: string;
  loading: boolean;
  reverting: boolean;
  error: string | null;
  parsed: ParsedGitDiff | null;
  selectedKeys: string[];
  selectedKeySet: ReadonlySet<string>;
  canDiscardFile: boolean;
  canRevertHunks: boolean;
  canRevertLines: boolean;
  partialRevertUnavailable: boolean;
  activeHunkIndex: number;
  hunkCount: number;
  activeHunkNewStart?: number;
  selectChange: (args: ChangeEventArgs, extend: boolean) => void;
  extendSelectionFromKeyboard: (
    args: ChangeEventArgs,
    direction: -1 | 1,
  ) => { key: string; hunkIndex: number } | null;
  clearSelection: () => void;
  goToHunk: (hunkIndex: number) => void;
  requestDiscard: () => void;
  revertHunk: (hunkIndex: number) => Promise<void>;
  revertSelectedLines: () => Promise<void>;
}
