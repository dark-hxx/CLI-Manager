import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GitFileDiffPayload } from "../../../lib/gitTransport";
import type { GitDiffOptions } from "../../../lib/gitDiffOptions";
import { useI18n } from "../../../lib/i18n";
import type { GitTreeNode } from "../../../lib/types";
import { useSettingsStore } from "../../../stores/settingsStore";
import { GitDiffViewer } from "./GitDiffViewer";
import { GitDiffDialogFrame } from "./GitDiffDialogFrame";
import {
  buildGitDiffReviewTargets,
  reconcileReviewTargetIndex,
  type GitDiffHunkPlacement,
  type GitDiffReviewStatusFilter,
  type GitDiffReviewTarget,
} from "./reviewNavigation";
import type { GitDiffDataSource, GitDiffSelectedLine } from "./types";

interface GitDiffReviewDialogProps {
  open: boolean;
  onClose: () => void;
  repositoryPath: string;
  repositoryRelativePath?: string;
  tree: GitTreeNode[];
  untrackedTree: GitTreeNode[];
  statusFilter: GitDiffReviewStatusFilter;
  initialFilePath: string;
  loadDiff: (filePath: string, status: string, options?: GitDiffOptions) => Promise<GitFileDiffPayload>;
  revertHunk: (filePath: string, diffText: string, hunkIndex: number) => Promise<void>;
  revertLines: (
    filePath: string,
    diffText: string,
    selectedLines: GitDiffSelectedLine[],
  ) => Promise<void>;
  onRequestDiscard: (path: string, name: string, status: string) => void;
  onOpenSource: (target: GitDiffReviewTarget, lineNumber?: number) => Promise<boolean>;
  onPin: (target: GitDiffReviewTarget) => Promise<boolean>;
}

export function GitDiffReviewDialog({
  open,
  onClose,
  repositoryPath,
  repositoryRelativePath,
  tree,
  untrackedTree,
  statusFilter,
  initialFilePath,
  loadDiff,
  revertHunk,
  revertLines,
  onRequestDiscard,
  onOpenSource,
  onPin,
}: GitDiffReviewDialogProps) {
  const { t } = useI18n();
  const gitDiffViewMode = useSettingsStore((state) => state.gitDiffViewMode);
  const gitDiffWrapLines = useSettingsStore((state) => state.gitDiffWrapLines);
  const gitDiffWhitespaceMode = useSettingsStore((state) => state.gitDiffWhitespaceMode);
  const gitDiffContextLines = useSettingsStore((state) => state.gitDiffContextLines);
  const updateSettings = useSettingsStore((state) => state.update);
  const diffOptions = useMemo<GitDiffOptions>(() => ({
    whitespace: gitDiffWhitespaceMode,
    contextLines: gitDiffContextLines,
  }), [gitDiffContextLines, gitDiffWhitespaceMode]);
  const targets = useMemo(() => buildGitDiffReviewTargets({
    tree,
    untrackedTree,
    statusFilter,
    repositoryPath,
    repositoryRelativePath,
  }), [repositoryPath, repositoryRelativePath, statusFilter, tree, untrackedTree]);
  const [activeTargetId, setActiveTargetId] = useState<string | null>(null);
  const [initialHunkPlacement, setInitialHunkPlacement] = useState<GitDiffHunkPlacement>("first");
  const previousIndexRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    const initialIndex = targets.findIndex((target) => target.filePath === initialFilePath);
    const nextIndex = initialIndex >= 0 ? initialIndex : 0;
    previousIndexRef.current = nextIndex;
    setInitialHunkPlacement("first");
    setActiveTargetId(targets[nextIndex]?.id ?? null);
  }, [initialFilePath, open, repositoryPath]);

  const activeIndex = reconcileReviewTargetIndex(
    targets,
    activeTargetId,
    previousIndexRef.current,
  );
  const activeTarget = activeIndex >= 0 ? targets[activeIndex] : null;

  useEffect(() => {
    if (!activeTarget) return;
    previousIndexRef.current = activeIndex;
    if (activeTarget.id !== activeTargetId) setActiveTargetId(activeTarget.id);
  }, [activeIndex, activeTarget, activeTargetId]);

  useEffect(() => {
    if (open && activeTargetId && targets.length === 0) onClose();
  }, [activeTargetId, onClose, open, targets.length]);

  const dataSource = useMemo<GitDiffDataSource>(() => ({
    kind: "live",
    load: (target) => loadDiff(target.filePath, target.status, diffOptions),
    mutations: {
      revertHunk: (target, content, hunkIndex) => (
        revertHunk(target.filePath, content, hunkIndex)
      ),
      revertLines: (target, content, lines) => revertLines(target.filePath, content, lines),
      requestDiscard: (target) => onRequestDiscard(
        target.filePath,
        target.fileName,
        target.status,
      ),
    },
  }), [diffOptions, loadDiff, onRequestDiscard, revertHunk, revertLines]);

  const handleDiffOptionsChange = useCallback(async (options: GitDiffOptions) => {
    if (options.whitespace !== gitDiffWhitespaceMode) {
      await updateSettings("gitDiffWhitespaceMode", options.whitespace);
    }
    if (options.contextLines !== gitDiffContextLines) {
      await updateSettings("gitDiffContextLines", options.contextLines);
    }
  }, [gitDiffContextLines, gitDiffWhitespaceMode, updateSettings]);

  const selectAdjacentFile = useCallback((offset: -1 | 1) => {
    const nextTarget = targets[activeIndex + offset];
    if (!nextTarget) return;
    previousIndexRef.current = activeIndex + offset;
    setInitialHunkPlacement(offset < 0 ? "last" : "first");
    setActiveTargetId(nextTarget.id);
  }, [activeIndex, targets]);

  const handleOpenSource = useCallback(async (
    target: GitDiffReviewTarget,
    lineNumber?: number,
  ) => {
    if (await onOpenSource(target, lineNumber)) onClose();
  }, [onClose, onOpenSource]);

  const handlePin = useCallback(async (target: GitDiffReviewTarget) => {
    if (await onPin(target)) onClose();
  }, [onClose, onPin]);

  return (
    <GitDiffDialogFrame
      open={open}
      onClose={onClose}
      useTerminalTheme
      ariaLabel={t("git.diff.reviewDialogNamed", {
        fileName: activeTarget?.fileName ?? initialFilePath,
      })}
    >
      {activeTarget && (
        <GitDiffViewer
          key={activeTarget.id}
          target={activeTarget}
          dataSource={dataSource}
          onClose={onClose}
          useTerminalTheme
          viewMode={gitDiffViewMode}
          wrapLines={gitDiffWrapLines}
          diffOptions={diffOptions}
          onViewModeChange={(mode) => void updateSettings("gitDiffViewMode", mode)}
          onWrapLinesChange={(wrapLines) => void updateSettings("gitDiffWrapLines", wrapLines)}
          onDiffOptionsChange={(options) => void handleDiffOptionsChange(options)}
          review={{
            fileIndex: activeIndex,
            fileCount: targets.length,
            additions: activeTarget.additions,
            deletions: activeTarget.deletions,
            initialHunkPlacement,
            canNavigateToPreviousFile: activeIndex > 0,
            canNavigateToNextFile: activeIndex + 1 < targets.length,
            onNavigateToPreviousFile: () => selectAdjacentFile(-1),
            onNavigateToNextFile: () => selectAdjacentFile(1),
            onOpenSource: (lineNumber) => void handleOpenSource(activeTarget, lineNumber),
            onPin: () => void handlePin(activeTarget),
          }}
        />
      )}
    </GitDiffDialogFrame>
  );
}
