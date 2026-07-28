import { useMemo } from "react";
import type { GitFileDiffPayload } from "../../lib/gitTransport";
import { useI18n } from "../../lib/i18n";
import { GitDiffDialogFrame } from "./diff/GitDiffDialogFrame";
import { GitDiffViewer as StructuredGitDiffViewer } from "./diff/GitDiffViewer";
import type {
  GitDiffDataSource,
  GitDiffSelectedLine,
  GitDiffTarget,
} from "./diff/types";
import "react-diff-view/style/index.css";
import "./diffViewer.css";

interface LegacyGitDiffViewerProps {
  projectPath?: string;
  filePath: string;
  fileName: string;
  status: string;
  diffText?: string;
  loadDiff?: (filePath: string, status: string) => Promise<GitFileDiffPayload>;
  revertHunk?: (filePath: string, diffText: string, hunkIndex: number) => Promise<void>;
  revertLines?: (
    filePath: string,
    diffText: string,
    selectedLines: GitDiffSelectedLine[],
  ) => Promise<void>;
  onRequestDiscard?: (path: string, name: string, status: string) => void;
  onClose?: () => void;
  onReverted?: () => void;
  closeOnRevert?: boolean;
  useTerminalTheme?: boolean;
}

interface DiffViewerModalProps extends Omit<LegacyGitDiffViewerProps, "onClose"> {
  open: boolean;
  onClose: () => void;
  projectPath: string;
}

function missingLiveDataSource(): Promise<GitFileDiffPayload> {
  return Promise.reject(new Error("git_diff_live_source_missing"));
}

export function GitDiffViewer({
  projectPath,
  filePath,
  fileName,
  status,
  diffText,
  loadDiff,
  revertHunk,
  revertLines,
  onRequestDiscard,
  ...viewerProps
}: LegacyGitDiffViewerProps) {
  const target = useMemo<GitDiffTarget>(() => ({
    id: `${projectPath ?? "snapshot"}:${filePath}:${status}`,
    projectPath,
    filePath,
    fileName,
    status,
  }), [fileName, filePath, projectPath, status]);
  const dataSource = useMemo<GitDiffDataSource>(() => {
    if (diffText !== undefined) return { kind: "snapshot", content: diffText };
    return {
      kind: "live",
      load: loadDiff
        ? (currentTarget) => loadDiff(currentTarget.filePath, currentTarget.status)
        : missingLiveDataSource,
      mutations: {
        revertHunk: revertHunk
          ? (currentTarget, content, hunkIndex) => revertHunk(currentTarget.filePath, content, hunkIndex)
          : undefined,
        revertLines: revertLines
          ? (currentTarget, content, lines) => revertLines(currentTarget.filePath, content, lines)
          : undefined,
        requestDiscard: onRequestDiscard
          ? (currentTarget) => onRequestDiscard(currentTarget.filePath, currentTarget.fileName, currentTarget.status)
          : undefined,
      },
    };
  }, [diffText, loadDiff, onRequestDiscard, revertHunk, revertLines]);

  return <StructuredGitDiffViewer target={target} dataSource={dataSource} {...viewerProps} />;
}

export function DiffViewerModal({ open, onClose, ...viewerProps }: DiffViewerModalProps) {
  const { t } = useI18n();
  return (
    <GitDiffDialogFrame
      open={open}
      onClose={onClose}
      ariaLabel={t("git.diff.reviewDialogNamed", { fileName: viewerProps.fileName })}
    >
      <GitDiffViewer {...viewerProps} onClose={onClose} closeOnRevert />
    </GitDiffDialogFrame>
  );
}
