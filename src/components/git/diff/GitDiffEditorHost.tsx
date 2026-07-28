import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useGitTransportLease } from "../../../hooks/useGitTransportLease";
import { debugConsoleWarn } from "../../../lib/debugConsole";
import { GIT_BACKGROUND_REFRESH_INTERVAL_MS } from "../../../lib/gitRefreshPolicy";
import type { GitTransportLease } from "../../../lib/gitTransportLease";
import type { GitDiffOptions } from "../../../lib/gitDiffOptions";
import { useI18n } from "../../../lib/i18n";
import type { Project } from "../../../lib/types";
import { useFileExplorerStore } from "../../../stores/fileExplorerStore";
import {
  useGitDiffWorkspaceStore,
  type GitDiffWorkspaceContext,
  type GitDiffWorkspaceTab,
  type ProjectGitDiffWorkspace,
} from "../../../stores/gitDiffWorkspaceStore";
import { useGitStore } from "../../../stores/gitStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import { ConfirmDialog } from "../../ConfirmDialog";
import { X } from "../../icons";
import { GitDiffViewer } from "./GitDiffViewer";
import type { GitDiffDataSource } from "./types";
import type { GitDiffHunkPlacement } from "./reviewNavigation";

interface GitDiffEditorHostProps {
  project: Project;
  context: GitDiffWorkspaceContext;
  workspace: ProjectGitDiffWorkspace;
}

export function GitDiffEditorHost({
  project,
  context,
  workspace,
}: GitDiffEditorHostProps) {
  const { t } = useI18n();
  const activeIndex = workspace.tabs.findIndex((tab) => tab.id === workspace.activeId);
  const activeTab = activeIndex >= 0 ? workspace.tabs[activeIndex] : null;
  const { lease, loading, error } = useGitTransportLease(project, Boolean(activeTab));
  const leaseRef = useRef(lease);
  leaseRef.current = lease;
  const [discardTabId, setDiscardTabId] = useState<string | null>(null);
  const [initialHunkPlacement, setInitialHunkPlacement] = useState<GitDiffHunkPlacement>("first");
  const refreshInFlightRef = useRef(false);
  const activateTab = useGitDiffWorkspaceStore((state) => state.activateTab);
  const updateTab = useGitDiffWorkspaceStore((state) => state.updateTab);
  const closeTab = useGitDiffWorkspaceStore((state) => state.closeTab);
  const openProject = useFileExplorerStore((state) => state.openProject);
  const revealPath = useFileExplorerStore((state) => state.revealPath);
  const gitDiffViewMode = useSettingsStore((state) => state.gitDiffViewMode);
  const gitDiffOpenMode = useSettingsStore((state) => state.gitDiffOpenMode);
  const gitDiffWrapLines = useSettingsStore((state) => state.gitDiffWrapLines);
  const gitDiffWhitespaceMode = useSettingsStore((state) => state.gitDiffWhitespaceMode);
  const gitDiffContextLines = useSettingsStore((state) => state.gitDiffContextLines);
  const updateSettings = useSettingsStore((state) => state.update);
  const diffOptions = useMemo<GitDiffOptions>(() => ({
    whitespace: gitDiffWhitespaceMode,
    contextLines: gitDiffContextLines,
  }), [gitDiffContextLines, gitDiffWhitespaceMode]);

  const refreshTab = useCallback(async (
    tab: GitDiffWorkspaceTab,
    currentLease: GitTransportLease,
  ) => {
    try {
      const snapshot = await currentLease.transport.getChanges(tab.repositoryId);
      if (leaseRef.current?.contextKey !== currentLease.contextKey) return;
      const currentWorkspace = useGitDiffWorkspaceStore.getState().workspaces[context.key];
      const currentTab = currentWorkspace?.tabs.find((candidate) => candidate.id === tab.id);
      if (!currentTab) return;
      const change = snapshot.value.find((candidate) => candidate.path === tab.filePath);
      if (!change) {
        closeTab(context.key, tab.id);
        return;
      }
      updateTab(context.key, tab.id, {
        status: change.status,
        additions: change.added,
        deletions: change.deleted,
        revision: currentTab.revision + 1,
      });
    } catch (refreshError) {
      debugConsoleWarn("[GitDiffEditorHost] Failed to refresh pinned diff:", refreshError);
    }
  }, [closeTab, context.key, updateTab]);

  const runMutation = useCallback(async (
    tab: GitDiffWorkspaceTab,
    currentLease: GitTransportLease,
    mutation: () => Promise<void>,
  ) => {
    try {
      await mutation();
    } finally {
      await refreshTab(tab, currentLease);
      await useGitStore.getState().refreshIfContext(currentLease.contextKey).catch((refreshError) => {
        debugConsoleWarn("[GitDiffEditorHost] Failed to refresh active Git panel:", refreshError);
      });
    }
  }, [refreshTab]);

  useEffect(() => {
    if (!activeTab || !lease) return;
    const refresh = () => {
      if (refreshInFlightRef.current) return;
      if (document.visibilityState !== "visible" || !document.hasFocus()) return;
      refreshInFlightRef.current = true;
      void refreshTab(activeTab, lease).finally(() => {
        refreshInFlightRef.current = false;
      });
    };
    const timer = window.setInterval(refresh, GIT_BACKGROUND_REFRESH_INTERVAL_MS);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [activeTab, lease, refreshTab]);

  const dataSource = useMemo<GitDiffDataSource | null>(() => {
    if (!activeTab || !lease) return null;
    return {
      kind: "live",
      load: async (target) => (
        await lease.transport.getFileDiff(
          activeTab.repositoryId,
          target.filePath,
          target.status,
          diffOptions,
        )
      ).value,
      mutations: {
        revertHunk: (target, content, hunkIndex) => runMutation(
          activeTab,
          lease,
          () => lease.transport.revertHunk(
            activeTab.repositoryId,
            target.filePath,
            content,
            hunkIndex,
          ),
        ),
        revertLines: (target, content, lines) => runMutation(
          activeTab,
          lease,
          () => lease.transport.revertLines(
            activeTab.repositoryId,
            target.filePath,
            content,
            lines,
          ),
        ),
        requestDiscard: () => setDiscardTabId(activeTab.id),
      },
    };
  }, [activeTab, diffOptions, lease, runMutation]);

  const handleDiffOptionsChange = useCallback(async (options: GitDiffOptions) => {
    if (options.whitespace !== gitDiffWhitespaceMode) {
      await updateSettings("gitDiffWhitespaceMode", options.whitespace);
    }
    if (options.contextLines !== gitDiffContextLines) {
      await updateSettings("gitDiffContextLines", options.contextLines);
    }
  }, [gitDiffContextLines, gitDiffWhitespaceMode, updateSettings]);

  const selectAdjacentTab = useCallback((offset: -1 | 1) => {
    const nextTab = workspace.tabs[activeIndex + offset];
    if (!nextTab) return;
    setInitialHunkPlacement(offset < 0 ? "last" : "first");
    activateTab(context.key, nextTab.id);
  }, [activateTab, activeIndex, context.key, workspace.tabs]);

  const openSource = useCallback(async (lineNumber?: number) => {
    if (!activeTab || activeTab.status === "D") return;
    try {
      await openProject(project);
      const revealed = await revealPath(activeTab.sourcePath, { lineNumber });
      if (!revealed) throw new Error("git_diff_source_not_found");
      activateTab(context.key, null);
    } catch (openError) {
      toast.error(t("files.toast.openFileFailed"), { description: String(openError) });
    }
  }, [activateTab, activeTab, context.key, openProject, project, revealPath, t]);

  const confirmDiscard = useCallback(async () => {
    const tab = workspace.tabs.find((candidate) => candidate.id === discardTabId) ?? null;
    setDiscardTabId(null);
    if (!tab || !lease) return;
    try {
      await runMutation(
        tab,
        lease,
        () => lease.transport.discardFile(tab.repositoryId, tab.filePath, tab.status),
      );
    } catch {
      toast.error(t("git.diff.revertFileFailed"));
    }
  }, [discardTabId, lease, runMutation, t, workspace.tabs]);
  const discardTab = workspace.tabs.find((candidate) => candidate.id === discardTabId) ?? null;

  if (!activeTab) return null;
  if (error) {
    return (
      <div className="flex h-full items-center justify-center gap-3 text-sm text-text-muted">
        <span>{t("git.diff.transportFailed")}</span>
        <button
          type="button"
          className="ui-icon-action"
          title={t("files.editor.closeNamed", { name: activeTab.fileName })}
          aria-label={t("files.editor.closeNamed", { name: activeTab.fileName })}
          onClick={() => closeTab(context.key, activeTab.id)}
        >
          <X size={15} />
        </button>
      </div>
    );
  }
  if (loading || !dataSource) {
    return <div className="flex h-full items-center justify-center text-sm text-text-muted">{t("common.loading")}</div>;
  }

  return (
    <>
      <GitDiffViewer
        key={activeTab.id}
        target={{
          id: activeTab.id,
          projectPath: activeTab.repositoryId,
          filePath: activeTab.filePath,
          fileName: activeTab.fileName,
          status: activeTab.status,
        }}
        dataSource={dataSource}
        useTerminalTheme
        viewMode={gitDiffViewMode}
        wrapLines={gitDiffWrapLines}
        diffOptions={diffOptions}
        onViewModeChange={(mode) => void updateSettings("gitDiffViewMode", mode)}
        onWrapLinesChange={(wrapLines) => void updateSettings("gitDiffWrapLines", wrapLines)}
        onDiffOptionsChange={(options) => void handleDiffOptionsChange(options)}
        onClose={() => closeTab(context.key, activeTab.id)}
        review={{
          fileIndex: activeIndex,
          fileCount: workspace.tabs.length,
          additions: activeTab.additions,
          deletions: activeTab.deletions,
          initialHunkPlacement,
          canNavigateToPreviousFile: activeIndex > 0,
          canNavigateToNextFile: activeIndex + 1 < workspace.tabs.length,
          onNavigateToPreviousFile: () => selectAdjacentTab(-1),
          onNavigateToNextFile: () => selectAdjacentTab(1),
          onOpenSource: (lineNumber) => void openSource(lineNumber),
          onPin: () => void updateSettings(
            "gitDiffOpenMode",
            gitDiffOpenMode === "editor" ? "dialog" : "editor",
          ),
          pinActive: gitDiffOpenMode === "editor",
        }}
      />
      <ConfirmDialog
        open={discardTab !== null}
        title={t("git.confirm.revertTitle")}
        message={discardTab ? t("git.confirm.revertMessage", { name: discardTab.fileName }) : undefined}
        confirmText={t("git.confirm.revert")}
        cancelText={t("common.cancel")}
        danger
        onConfirm={() => void confirmDiscard()}
        onClose={() => setDiscardTabId(null)}
      />
    </>
  );
}
