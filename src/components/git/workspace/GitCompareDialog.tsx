import { useMemo } from "react";
import { useI18n } from "../../../lib/i18n";
import { GitDiffDialogFrame } from "../diff/GitDiffDialogFrame";
import { GitDiffViewer } from "../diff/GitDiffViewer";
import type { GitDiffDataSource, GitDiffTarget } from "../diff/types";

interface GitCompareDialogProps {
  open: boolean;
  title: string;
  projectPath: string;
  content: string;
  onClose: () => void;
}

export function GitCompareDialog({
  open,
  title,
  projectPath,
  content,
  onClose,
}: GitCompareDialogProps) {
  const { t } = useI18n();
  const target = useMemo<GitDiffTarget>(() => ({
    id: `git-compare:${projectPath}:${title}`,
    projectPath,
    filePath: title,
    fileName: title,
    status: "M",
  }), [projectPath, title]);
  const dataSource = useMemo<GitDiffDataSource>(() => ({
    kind: "snapshot",
    content,
  }), [content]);
  return (
    <GitDiffDialogFrame
      open={open}
      onClose={onClose}
      useTerminalTheme
      ariaLabel={t("git.workspace.compareTitle", { title })}
    >
      <GitDiffViewer
        target={target}
        dataSource={dataSource}
        useTerminalTheme
        onClose={onClose}
      />
    </GitDiffDialogFrame>
  );
}
