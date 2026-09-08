import { useCallback, useEffect, type Dispatch, type SetStateAction } from "react";
import { toast } from "sonner";
import type { Group, Project, WorktreeRecord } from "../../../shared/types/index";
import type { TranslationKey } from "../../../shared/i18n/index";
import {
  registerWebDeviceActionHandler,
  type WebDeviceActionRequest,
} from "../../../shared/lib/webDeviceActionBus";
import { getSyncedSessionKeysForProject } from "../lib/sidebarModel";
import { useExternalSessionSyncStore } from "../../history/api/externalSessionSyncStore";
import { useTerminalStore } from "../../terminal/state";
import { collectProjectIdsForGroup } from "../../terminal/api/terminalScope";

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;
type Confirm = (options: {
  title: string;
  message: string;
  confirmText?: string;
  danger?: boolean;
}) => Promise<boolean>;
type ProviderSwitchTarget =
  | { kind: "project"; project: Project }
  | { kind: "worktree"; project: Project; worktree: WorktreeRecord }
  | null;

interface SidebarWebDeviceActionsOptions {
  confirm: Confirm;
  t: Translate;
  projects: Project[];
  worktrees: WorktreeRecord[];
  groups: Group[];
  selectedId: string | null;
  setSelectedId: Dispatch<SetStateAction<string | null>>;
  setSelectedProjectIds: Dispatch<SetStateAction<Set<string>>>;
  closeSession: (sessionId: string) => Promise<unknown>;
  deleteProject: (projectId: string) => Promise<unknown>;
  removeSyncedSessions: (keys: string[]) => Promise<unknown>;
  deleteGroup: (groupId: string) => Promise<unknown>;
  ensureSidebarExpanded: () => void;
  setEditingProject: Dispatch<SetStateAction<Project | null>>;
  setRenamingProjectId: Dispatch<SetStateAction<string | null>>;
  setProviderSwitchTarget: Dispatch<SetStateAction<ProviderSwitchTarget>>;
  setNewGroupParentId: Dispatch<SetStateAction<string | null>>;
  setBatchShellPreselected: Dispatch<SetStateAction<Set<string> | null>>;
  setFinishTarget: Dispatch<SetStateAction<{ project: Project; worktree: WorktreeRecord } | null>>;
  handleOpenProjectDirectory: (project: Project) => unknown;
  handleOpenProjectFiles: (project: Project) => unknown;
  handleOpenProjectHistory: (project: Project) => void;
  handleCloneProject: (project: Project) => void;
  handleAddProjectToGroup: (groupId: string) => void;
  handleStopGroup: (groupId: string) => unknown;
  handleSelectGroupScope: (groupId: string) => void;
  handleRenameGroup: (groupId: string, groupName: string) => void;
  handleOpenWorktreeDirectory: (worktree: WorktreeRecord) => unknown;
  handleOpenWorktreeFiles: (project: Project, worktree: WorktreeRecord) => unknown;
  handleOpenWorktreeHistory: (project: Project, worktree: WorktreeRecord) => void;
  handleInstallWorktreeDeps: (project: Project, worktree: WorktreeRecord) => void;
  rejectMissingWorktree: (worktree: WorktreeRecord) => boolean;
  removeWorktree: (worktree: WorktreeRecord, deleteBranch: boolean) => Promise<unknown>;
}

export function useSidebarWebDeviceActions({
  confirm, t, projects, worktrees, groups, selectedId, setSelectedId,
  setSelectedProjectIds, closeSession, deleteProject, removeSyncedSessions, deleteGroup,
  ensureSidebarExpanded, setEditingProject, setRenamingProjectId, setProviderSwitchTarget,
  setNewGroupParentId, setBatchShellPreselected, setFinishTarget, handleOpenProjectDirectory,
  handleOpenProjectFiles, handleOpenProjectHistory, handleCloneProject, handleAddProjectToGroup,
  handleStopGroup, handleSelectGroupScope, handleRenameGroup, handleOpenWorktreeDirectory,
  handleOpenWorktreeFiles, handleOpenWorktreeHistory, handleInstallWorktreeDeps,
  rejectMissingWorktree, removeWorktree,
}: SidebarWebDeviceActionsOptions) {
  const deleteProjectDirect = useCallback(async (project: Project) => {
    const confirmed = await confirm({
      title: t("sidebar.confirm.deleteTerminalTitle"),
      message: t("sidebar.confirm.deleteTerminalMessage", { name: project.name }),
      confirmText: t("sidebar.menu.delete"),
      danger: true,
    });
    if (!confirmed) return { canceled: true };
    const syncedKeys = getSyncedSessionKeysForProject(
      project,
      useExternalSessionSyncStore.getState().syncedSessions,
    );
    const sessionIds = useTerminalStore.getState().sessions
      .filter((session) => session.projectId === project.id || session.fileEditor?.projectId === project.id)
      .map((session) => session.id);
    for (const sessionId of sessionIds) await closeSession(sessionId);
    await deleteProject(project.id);
    if (syncedKeys.length > 0) await removeSyncedSessions(syncedKeys);
    if (selectedId === project.id) setSelectedId(null);
    setSelectedProjectIds((previous) => {
      const next = new Set(previous);
      next.delete(project.id);
      return next;
    });
    toast.success(t("sidebar.toast.terminalDeleteSuccess"));
    return { deleted: true, projectId: project.id };
  }, [closeSession, confirm, deleteProject, removeSyncedSessions, selectedId, setSelectedId, setSelectedProjectIds, t]);

  const deleteGroupDirect = useCallback(async (groupId: string, groupName: string) => {
    const confirmed = await confirm({
      title: t("sidebar.confirm.deleteGroupTitle"),
      message: t("sidebar.confirm.deleteGroupMessage", { name: groupName }),
      confirmText: t("sidebar.menu.delete"),
      danger: true,
    });
    if (!confirmed) return { canceled: true };
    const projectIds = collectProjectIdsForGroup(groups, projects, groupId);
    const groupProjects = projects.filter((project) => projectIds.has(project.id));
    const syncedKeys = groupProjects.flatMap((project) =>
      getSyncedSessionKeysForProject(project, useExternalSessionSyncStore.getState().syncedSessions),
    );
    const sessionIds = useTerminalStore.getState().sessions
      .filter((session) => (
        (session.projectId && projectIds.has(session.projectId))
        || (session.fileEditor?.projectId && projectIds.has(session.fileEditor.projectId))
      ))
      .map((session) => session.id);
    for (const sessionId of sessionIds) await closeSession(sessionId);
    for (const project of groupProjects) await deleteProject(project.id);
    if (syncedKeys.length > 0) await removeSyncedSessions(syncedKeys);
    await deleteGroup(groupId);
    if (selectedId && projectIds.has(selectedId)) setSelectedId(null);
    setSelectedProjectIds((previous) => {
      const next = new Set(previous);
      projectIds.forEach((id) => next.delete(id));
      return next;
    });
    toast.success(t("sidebar.toast.groupDeleteSuccess"));
    return { deleted: true, groupId };
  }, [closeSession, confirm, deleteGroup, deleteProject, groups, projects, removeSyncedSessions, selectedId, setSelectedId, setSelectedProjectIds, t]);

  const handleWebDeviceAction = useCallback(async (request: WebDeviceActionRequest) => {
    if (request.targetType === "selection") {
      throw { code: "unsupported_operation_action", message: "selection actions are not supported by the desktop bridge" };
    }
    const targetId = request.targetId?.trim() ?? "";
    if (!targetId) throw { code: "invalid_operation_payload", message: "targetId is required" };
    const worktree = request.targetType === "worktree"
      ? worktrees.find((item) => item.id === targetId) ?? null
      : null;
    const project = request.targetType === "project"
      ? projects.find((item) => item.id === targetId) ?? null
      : request.targetType === "worktree"
        ? projects.find((item) => item.id === worktree?.project_id) ?? null
        : null;
    const group = request.targetType === "group"
      ? groups.find((item) => item.id === targetId) ?? null
      : null;
    if (request.targetType === "project" && !project) throw { code: "project_not_found", message: "project was not found" };
    if (request.targetType === "worktree" && (!worktree || !project)) throw { code: "worktree_not_found", message: "Worktree was not found" };
    if (request.targetType === "group" && !group) throw { code: "group_not_found", message: "group was not found" };

    switch (request.action) {
      case "project.openDirectory": return handleOpenProjectDirectory(project!);
      case "project.openFiles": return handleOpenProjectFiles(project!);
      case "project.history": handleOpenProjectHistory(project!); return { opened: true };
      case "project.clone": handleCloneProject(project!); return { opened: true };
      case "project.edit": setEditingProject(project!); return { opened: true };
      case "project.rename": ensureSidebarExpanded(); setRenamingProjectId(project!.id); return { opened: true };
      case "project.provider": setProviderSwitchTarget({ kind: "project", project: project! }); return { opened: true };
      case "project.delete": return deleteProjectDirect(project!);
      case "group.newChild": ensureSidebarExpanded(); setNewGroupParentId(group!.id); return { opened: true };
      case "group.addProject": ensureSidebarExpanded(); handleAddProjectToGroup(group!.id); return { opened: true };
      case "group.batchShell": setBatchShellPreselected(collectProjectIdsForGroup(groups, projects, group!.id)); return { opened: true };
      case "group.stop": return handleStopGroup(group!.id);
      case "group.focus": handleSelectGroupScope(group!.id); return { focused: true };
      case "group.rename": ensureSidebarExpanded(); handleRenameGroup(group!.id, group!.name); return { opened: true };
      case "group.delete": return deleteGroupDirect(group!.id, group!.name);
      case "worktree.openDirectory": return handleOpenWorktreeDirectory(worktree!);
      case "worktree.openFiles": return handleOpenWorktreeFiles(project!, worktree!);
      case "worktree.history": handleOpenWorktreeHistory(project!, worktree!); return { opened: true };
      case "worktree.provider": setProviderSwitchTarget({ kind: "worktree", project: project!, worktree: worktree! }); return { opened: true };
      case "worktree.installDeps": handleInstallWorktreeDeps(project!, worktree!); return { opened: true };
      case "worktree.finish": if (rejectMissingWorktree(worktree!)) return { opened: false }; setFinishTarget({ project: project!, worktree: worktree! }); return { opened: true };
      case "worktree.discard": {
        const confirmed = await confirm({
          title: t("worktree.discard.title", { name: worktree!.name }),
          message: t("worktree.discard.message", { branch: worktree!.branch }),
          confirmText: t("worktree.discard.confirm"),
          danger: true,
        });
        if (!confirmed) return { canceled: true };
        await removeWorktree(worktree!, true);
        return { deleted: true, worktreeId: worktree!.id };
      }
      default:
        throw { code: "unsupported_operation_action", message: `unsupported desktop action: ${request.action}` };
    }
  }, [
    confirm, deleteGroupDirect, deleteProjectDirect, ensureSidebarExpanded, groups,
    handleAddProjectToGroup, handleCloneProject, handleInstallWorktreeDeps,
    handleOpenProjectDirectory, handleOpenProjectFiles, handleOpenProjectHistory,
    handleOpenWorktreeDirectory, handleOpenWorktreeFiles, handleOpenWorktreeHistory,
    handleRenameGroup, handleSelectGroupScope, handleStopGroup, projects,
    rejectMissingWorktree, removeWorktree, setBatchShellPreselected, setEditingProject,
    setFinishTarget, setNewGroupParentId, setProviderSwitchTarget, setRenamingProjectId,
    t, worktrees,
  ]);

  useEffect(() => registerWebDeviceActionHandler(handleWebDeviceAction), [handleWebDeviceAction]);
}
