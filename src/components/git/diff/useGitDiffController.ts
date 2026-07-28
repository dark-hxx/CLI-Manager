import { useCallback, useEffect, useMemo, useState } from "react";
import { getChangeKey } from "react-diff-view";
import { toast } from "sonner";
import {
  normalizeGitDiffPayload,
  shouldHighlightGitDiff,
  type GitDiffMetadata,
} from "../../../lib/gitDiffLimits";
import { useI18n } from "../../../lib/i18n";
import type {
  GitDiffController,
  GitDiffDataSource,
  GitDiffSelectedLine,
  GitDiffTarget,
  ParsedGitDiff,
} from "./types";
import type { GitDiffHunkPlacement } from "./reviewNavigation";
import type { GitDiffViewMode } from "../../../stores/settingsStore";
import { useGitDiffSelection } from "./gitDiffSelection";
import { useGitDiffParser } from "./useGitDiffParser";

interface UseGitDiffControllerOptions {
  target: GitDiffTarget;
  dataSource: GitDiffDataSource;
  onReverted?: () => void;
  initialHunkPlacement?: GitDiffHunkPlacement;
  viewMode: GitDiffViewMode;
}

function selectedLines(
  parsed: ParsedGitDiff | null,
  selectedKeys: ReadonlySet<string>,
): GitDiffSelectedLine[] {
  if (!parsed || selectedKeys.size === 0) return [];
  const lines: GitDiffSelectedLine[] = [];
  for (const hunk of parsed.file.hunks) {
    for (const change of hunk.changes) {
      if (change.type === "normal" || !selectedKeys.has(getChangeKey(change))) continue;
      lines.push({
        side: change.type === "insert" ? "new" : "old",
        lineNumber: change.lineNumber,
      });
    }
  }
  return lines;
}

export function useGitDiffController({
  target,
  dataSource,
  onReverted,
  initialHunkPlacement = "first",
  viewMode,
}: UseGitDiffControllerOptions): GitDiffController {
  const { t } = useI18n();
  const [diffText, setDiffText] = useState("");
  const [loading, setLoading] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeHunkIndex, setActiveHunkIndex] = useState(0);
  const [loadRevision, setLoadRevision] = useState(0);
  const [payloadAllowsPartialRevert, setPayloadAllowsPartialRevert] = useState(false);
  const [metadata, setMetadata] = useState<GitDiffMetadata>({ byteLength: 0, lineCount: 0 });
  const snapshotContent = dataSource.kind === "snapshot" ? dataSource.content : undefined;
  const liveLoader = dataSource.kind === "live" ? dataSource.load : undefined;
  const mutations = dataSource.kind === "live" ? dataSource.mutations : undefined;
  const stableTarget = useMemo<GitDiffTarget>(() => target, [
    target.fileName,
    target.filePath,
    target.id,
    target.projectPath,
    target.status,
  ]);
  const parseResult = useGitDiffParser(diffText, metadata.byteLength);
  const parsed = useMemo<ParsedGitDiff | null>(() => parseResult.file ? {
    file: parseResult.file,
    syntaxHighlight: !parseResult.workerFallback && shouldHighlightGitDiff(metadata),
  } : null, [metadata, parseResult.file, parseResult.workerFallback]);
  const selection = useGitDiffSelection(
    parsed?.file.hunks,
    viewMode,
    diffText,
  );

  useEffect(() => {
    selection.clearSelection();
    setError(null);
    setPayloadAllowsPartialRevert(false);
    setMetadata({ byteLength: 0, lineCount: 0 });

    if (snapshotContent !== undefined) {
      try {
        const payload = normalizeGitDiffPayload({
          content: snapshotContent,
          canRevertHunks: false,
        });
        setDiffText(payload.content);
        setMetadata({ byteLength: payload.byteLength, lineCount: payload.lineCount });
      } catch {
        setDiffText("");
        setError(t("git.diff.tooLarge"));
      }
      setLoading(false);
      return;
    }
    if (!liveLoader) {
      setDiffText("");
      setLoading(false);
      setError("git_diff_live_source_missing");
      return;
    }

    let cancelled = false;
    setDiffText("");
    setLoading(true);
    void liveLoader(stableTarget)
      .then((payload) => {
        if (cancelled) return;
        setDiffText(payload.content);
        setMetadata({ byteLength: payload.byteLength, lineCount: payload.lineCount });
        setPayloadAllowsPartialRevert(payload.canRevertHunks);
      })
      .catch((loadError) => {
        if (cancelled) return;
        const message = loadError instanceof Error ? loadError.message : String(loadError);
        if (message.includes("binary_file")) setError(t("files.error.binaryFile"));
        else if (message.includes("git_diff_too_large")) setError(t("git.diff.tooLarge"));
        else if (message.includes("ssh_agent_capability_missing:gitDiffOptions")) {
          setError(t("git.diff.sshAgentUpgradeRequired"));
        }
        else if (message.includes("text_decode_failed") || message.includes("text_encoding_unknown")) {
          setError(t("files.error.encodingUnknown"));
        } else setError(message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [liveLoader, loadRevision, selection.clearSelection, snapshotContent, stableTarget, t]);

  const hunkCount = parsed?.file.hunks.length ?? 0;
  const activeHunkNewStart = parsed?.file.hunks[activeHunkIndex]?.newStart;
  const trackedFile = target.status !== "U" && target.status !== "??";
  const canDiscardFile = trackedFile && Boolean(mutations?.requestDiscard);
  const canRevertHunks = canDiscardFile
    && payloadAllowsPartialRevert
    && Boolean(mutations?.revertHunk);
  const canRevertLines = canDiscardFile
    && payloadAllowsPartialRevert
    && Boolean(mutations?.revertLines);
  const partialRevertUnavailable = canDiscardFile
    && !payloadAllowsPartialRevert
    && parsed !== null;

  const goToHunk = useCallback((hunkIndex: number) => {
    if (hunkCount === 0) return;
    const nextIndex = Math.min(Math.max(hunkIndex, 0), hunkCount - 1);
    setActiveHunkIndex(nextIndex);
  }, [hunkCount]);
  const requestDiscard = useCallback(
    () => mutations?.requestDiscard?.(stableTarget),
    [mutations, stableTarget],
  );

  const revertHunk = useCallback(async (hunkIndex: number) => {
    if (!canRevertHunks || !mutations?.revertHunk) return;
    setReverting(true);
    try {
      await mutations.revertHunk(stableTarget, diffText, hunkIndex);
      setLoadRevision((revision) => revision + 1);
      onReverted?.();
    } catch {
      toast.error(t("git.diff.revertHunkFailed"));
    } finally {
      setReverting(false);
    }
  }, [canRevertHunks, diffText, mutations, onReverted, stableTarget, t]);

  const revertSelectedLines = useCallback(async () => {
    if (!canRevertLines || !mutations?.revertLines) return;
    const lines = selectedLines(parsed, selection.selectedKeySet);
    if (lines.length === 0) return;
    setReverting(true);
    try {
      await mutations.revertLines(stableTarget, diffText, lines);
      setLoadRevision((revision) => revision + 1);
      onReverted?.();
    } catch {
      toast.error(t("git.diff.revertLinesFailed"));
    } finally {
      setReverting(false);
    }
  }, [canRevertLines, diffText, mutations, onReverted, parsed, selection.selectedKeySet, stableTarget, t]);

  useEffect(() => {
    setActiveHunkIndex(initialHunkPlacement === "last" && hunkCount > 0 ? hunkCount - 1 : 0);
  }, [hunkCount, initialHunkPlacement, stableTarget.id]);

  return {
    diffText,
    loading: loading || parseResult.parsing,
    reverting,
    error,
    parsed,
    selectedKeys: selection.selectedKeys,
    selectedKeySet: selection.selectedKeySet,
    canDiscardFile,
    canRevertHunks,
    canRevertLines,
    partialRevertUnavailable,
    activeHunkIndex,
    hunkCount,
    activeHunkNewStart,
    selectChange: ({ change }, extend) => selection.selectChange(change, extend),
    extendSelectionFromKeyboard: ({ change }, direction) => (
      selection.extendSelectionFromKeyboard(change, direction)
    ),
    clearSelection: selection.clearSelection,
    goToHunk,
    requestDiscard,
    revertHunk,
    revertSelectedLines,
  };
}
