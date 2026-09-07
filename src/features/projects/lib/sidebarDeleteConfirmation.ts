import type { Dispatch, SetStateAction } from "react";
import { useProjectStore } from "../../../stores/projectStore";
import { useTerminalStore } from "../../../stores/terminalStore";
import { useExternalSessionSyncStore } from "../../../stores/externalSessionSyncStore";
import type { Project, Group } from "../../../lib/types";
import { collectProjectIdsForGroup } from "../../../lib/terminalScope";
import { toast } from "sonner";
import { useI18n } from "../../../lib/i18n";
import { getSyncedSessionKeysForProject, type SidebarConfirmAction } from "./sidebarModel";

interface SidebarDeleteContext {
  confirmAction: SidebarConfirmAction;
  t: ReturnType<typeof useI18n>["t"];
  closeSession: ReturnType<typeof useTerminalStore.getState>["closeSession"];
  deleteProject: ReturnType<typeof useProjectStore.getState>["deleteProject"];
  removeSyncedSessions: ReturnType<typeof useExternalSessionSyncStore.getState>["removeSyncedSessions"];
  setConfirmAction: Dispatch<SetStateAction<SidebarConfirmAction>>;
  selectedId: string | null;
  setSelectedId: Dispatch<SetStateAction<string | null>>;
  setSelectedProjectIds: Dispatch<SetStateAction<Set<string>>>;
  groups: Group[];
  projects: Project[];
  deleteGroup: ReturnType<typeof useProjectStore.getState>["deleteGroup"];
  setSelectedGroupIds: Dispatch<SetStateAction<Set<string>>>;
}

export function createSidebarDeleteConfirmation({
  confirmAction,
  t,
  closeSession,
  deleteProject,
  removeSyncedSessions,
  setConfirmAction,
  selectedId,
  setSelectedId,
  setSelectedProjectIds,
  groups,
  projects,
  deleteGroup,
  setSelectedGroupIds,
}: SidebarDeleteContext) {
  return (() => {
    if (!confirmAction) return null;
    if (confirmAction.kind === "delete-project") {
      return {
        title: t("sidebar.confirm.deleteTerminalTitle"),
        message: t("sidebar.confirm.deleteTerminalMessage", { name: confirmAction.project.name }),
        confirmText: t("sidebar.menu.delete"),
        danger: true,
        onConfirm: async () => {
          try {
            const syncedKeys = getSyncedSessionKeysForProject(
              confirmAction.project,
              useExternalSessionSyncStore.getState().syncedSessions
            );
            const projectSessionIds = useTerminalStore
              .getState()
              .sessions
              .filter((session) =>
                session.projectId === confirmAction.project.id
                || session.fileEditor?.projectId === confirmAction.project.id
              )
              .map((session) => session.id);
            for (const sessionId of projectSessionIds) {
              await closeSession(sessionId);
            }
            await deleteProject(confirmAction.project.id);
            if (syncedKeys.length > 0) {
              await removeSyncedSessions(syncedKeys);
            }
            toast.success(t("sidebar.toast.terminalDeleteSuccess"));
            setConfirmAction(null);
            if (selectedId === confirmAction.project.id) setSelectedId(null);
            setSelectedProjectIds((prev) => {
              const next = new Set(prev);
              next.delete(confirmAction.project.id);
              return next;
            });
          } catch (err) {
            toast.error(t("sidebar.toast.terminalDeleteFailed"), { description: String(err) });
          }
        },
      };
    }

    if (confirmAction.kind === "delete-group") {
      return {
        title: t("sidebar.confirm.deleteGroupTitle"),
        message: t("sidebar.confirm.deleteGroupMessage", { name: confirmAction.groupName }),
        confirmText: t("sidebar.menu.delete"),
        danger: true,
        onConfirm: async () => {
          try {
            const projectIds = collectProjectIdsForGroup(groups, projects, confirmAction.groupId);
            const groupProjects = projects.filter((project) => projectIds.has(project.id));
            const syncedKeys = groupProjects.flatMap((project) =>
              getSyncedSessionKeysForProject(project, useExternalSessionSyncStore.getState().syncedSessions)
            );
            const sessionIds = useTerminalStore
              .getState()
              .sessions
              .filter((session) =>
                (session.projectId && projectIds.has(session.projectId))
                || (session.fileEditor?.projectId && projectIds.has(session.fileEditor.projectId))
              )
              .map((session) => session.id);
            for (const sessionId of sessionIds) {
              await closeSession(sessionId);
            }
            for (const project of groupProjects) {
              await deleteProject(project.id);
            }
            if (syncedKeys.length > 0) {
              await removeSyncedSessions(syncedKeys);
            }
            await deleteGroup(confirmAction.groupId);
            toast.success(t("sidebar.toast.groupDeleteSuccess"));
            setConfirmAction(null);
            if (selectedId && projectIds.has(selectedId)) setSelectedId(null);
            setSelectedProjectIds((prev) => {
              const next = new Set(prev);
              projectIds.forEach((id) => next.delete(id));
              return next;
            });
          } catch (err) {
            toast.error(t("sidebar.toast.groupDeleteFailed"), { description: String(err) });
          }
        },
      };
    }

    // kind === "delete-selection"：文件夹与终端的混合批量删除
    const selGroups = confirmAction.groups;
    const selProjects = confirmAction.projects;
    const totalCount = selGroups.length + selProjects.length;
    const title = selGroups.length === 0
      ? t("sidebar.confirm.deleteTerminalsTitle", { count: selProjects.length })
      : selProjects.length === 0
        ? t("sidebar.confirm.deleteGroupsTitle", { count: selGroups.length })
        : t("sidebar.confirm.deleteSelectionTitle", { count: totalCount });
    const message = selGroups.length === 0
      ? t("sidebar.confirm.deleteTerminalsMessage", { count: selProjects.length })
      : selProjects.length === 0
        ? t("sidebar.confirm.deleteGroupsMessage", { count: selGroups.length })
        : t("sidebar.confirm.deleteSelectionMessage", { groupCount: selGroups.length, terminalCount: selProjects.length });
    return {
      title,
      message,
      confirmText: t("sidebar.menu.delete"),
      danger: true,
      onConfirm: async () => {
        try {
          const groupIds = selGroups.map((g) => g.groupId);
          // 目录（含嵌套父子）与直接选中的终端取项目并集去重，避免重复删除
          const projectIds = new Set<string>(selProjects.map((project) => project.id));
          for (const groupId of groupIds) {
            collectProjectIdsForGroup(groups, projects, groupId).forEach((id) => projectIds.add(id));
          }
          const affectedProjects = projects.filter((project) => projectIds.has(project.id));
          const syncedKeys = affectedProjects.flatMap((project) =>
            getSyncedSessionKeysForProject(project, useExternalSessionSyncStore.getState().syncedSessions)
          );
          const sessionIds = useTerminalStore
            .getState()
            .sessions
            .filter((session) =>
              (session.projectId && projectIds.has(session.projectId))
              || (session.fileEditor?.projectId && projectIds.has(session.fileEditor.projectId))
            )
            .map((session) => session.id);
          for (const sessionId of sessionIds) {
            await closeSession(sessionId);
          }
          for (const project of affectedProjects) {
            await deleteProject(project.id);
          }
          if (syncedKeys.length > 0) {
            await removeSyncedSessions(syncedKeys);
          }
          // deleteGroup 会级联删除子分组，父级先删后子级 id 已不存在也是幂等无副作用
          for (const groupId of groupIds) {
            await deleteGroup(groupId);
          }
          if (selProjects.length === 0) {
            toast.success(t("sidebar.toast.groupsDeleteSuccess", { count: selGroups.length }));
          } else if (selGroups.length === 0) {
            toast.success(t("sidebar.toast.terminalsDeleteSuccess", { count: selProjects.length }));
          } else {
            toast.success(t("sidebar.toast.selectionDeleteSuccess", {
              groupCount: selGroups.length,
              terminalCount: selProjects.length,
            }));
          }
          setConfirmAction(null);
          if (selectedId && projectIds.has(selectedId)) setSelectedId(null);
          setSelectedProjectIds((prev) => {
            const next = new Set(prev);
            projectIds.forEach((id) => next.delete(id));
            return next;
          });
          setSelectedGroupIds(new Set());
        } catch (err) {
          toast.error(t("sidebar.toast.selectionDeleteFailed"), { description: String(err) });
        }
      },
    };
  })();
}
