import { useCallback } from "react";
import { toast } from "sonner";
import { useI18n } from "../../../lib/i18n";
import type { Project } from "../../../lib/types";
import { useFileExplorerStore } from "../../../stores/fileExplorerStore";
import {
  createGitDiffWorkspaceContext,
  useGitDiffWorkspaceStore,
} from "../../../stores/gitDiffWorkspaceStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import { useTerminalStore } from "../../../stores/terminalStore";
import type { GitDiffReviewTarget } from "./reviewNavigation";

interface GitChangeSummary {
  path: string;
  status: string;
  added: number;
  deleted: number;
}

interface GitDiffOpenWorkflowOptions {
  project: Project | null;
  projectPath: string | null;
  repositoryPath: string | null;
  repositoryRelativePath?: string;
  changes: readonly GitChangeSummary[];
}

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+|\/+$/gu, "");
}

export function useGitDiffOpenWorkflow({
  project,
  projectPath,
  repositoryPath,
  repositoryRelativePath = "",
  changes,
}: GitDiffOpenWorkflowOptions) {
  const { t } = useI18n();
  const openProject = useFileExplorerStore((state) => state.openProject);
  const revealPath = useFileExplorerStore((state) => state.revealPath);
  const openPinnedDiff = useGitDiffWorkspaceStore((state) => state.openTab);
  const openFileEditorPane = useTerminalStore((state) => state.openFileEditorPane);
  const gitDiffOpenMode = useSettingsStore((state) => state.gitDiffOpenMode);
  const updateSetting = useSettingsStore((state) => state.update);

  const sourcePathForFile = useCallback((filePath: string) => {
    const prefix = normalizeRelativePath(repositoryRelativePath);
    const normalizedFilePath = normalizeRelativePath(filePath);
    return prefix ? `${prefix}/${normalizedFilePath}` : normalizedFilePath;
  }, [repositoryRelativePath]);

  const openPinnedTarget = useCallback(async (
    target: GitDiffReviewTarget,
    persistAsDefault: boolean,
  ): Promise<boolean> => {
    if (!project) return false;
    const change = changes.find(
      (candidate) => normalizeRelativePath(candidate.path) === normalizeRelativePath(target.filePath),
    );
    if (!change) return false;
    try {
      await openProject(project);
      const context = createGitDiffWorkspaceContext(project);
      openPinnedDiff(context, {
        repositoryId: repositoryPath ?? (project.environment_type === "ssh" ? "" : projectPath ?? project.path),
        repositoryRelativePath,
        filePath: target.filePath,
        sourcePath: target.sourcePath,
        fileName: target.fileName,
        status: target.status,
        additions: change.added,
        deletions: change.deleted,
      });
      openFileEditorPane(project);
      if (persistAsDefault) await updateSetting("gitDiffOpenMode", "editor");
      return true;
    } catch (error) {
      toast.error(t("files.toast.openFileFailed"), { description: String(error) });
      return false;
    }
  }, [
    changes,
    openFileEditorPane,
    openPinnedDiff,
    openProject,
    project,
    projectPath,
    repositoryPath,
    repositoryRelativePath,
    t,
    updateSetting,
  ]);

  const openPreferredDiff = useCallback((filePath: string): boolean => {
    if (gitDiffOpenMode !== "editor") return false;
    const change = changes.find(
      (candidate) => normalizeRelativePath(candidate.path) === normalizeRelativePath(filePath),
    );
    if (!change) return false;
    const normalizedFilePath = normalizeRelativePath(filePath);
    const target: GitDiffReviewTarget = {
      id: `${repositoryPath ?? projectPath ?? ""}\u0000${normalizedFilePath}`,
      projectPath: repositoryPath ?? projectPath ?? undefined,
      filePath: normalizedFilePath,
      fileName: normalizedFilePath.split("/").pop() ?? normalizedFilePath,
      status: change.status,
      sourcePath: sourcePathForFile(normalizedFilePath),
      additions: change.added,
      deletions: change.deleted,
    };
    void openPinnedTarget(target, false);
    return true;
  }, [changes, gitDiffOpenMode, openPinnedTarget, projectPath, repositoryPath, sourcePathForFile]);

  const openSourcePath = useCallback(async (
    sourcePath: string,
    status: string,
    lineNumber?: number,
  ): Promise<boolean> => {
    if (!project || status === "D") return false;
    try {
      await openProject(project);
      const revealed = await revealPath(sourcePath, { lineNumber });
      if (!revealed) throw new Error("git_diff_source_not_found");
      openFileEditorPane(project);
      return true;
    } catch (error) {
      toast.error(t("files.toast.openFileFailed"), { description: String(error) });
      return false;
    }
  }, [openFileEditorPane, openProject, project, revealPath, t]);

  const pinDiff = useCallback(
    (target: GitDiffReviewTarget) => openPinnedTarget(target, true),
    [openPinnedTarget],
  );

  return {
    openPreferredDiff,
    openSourcePath,
    pinDiff,
    sourcePathForFile,
  };
}
