import { useCallback, useEffect, useMemo } from "react";
import type { Project } from "../../../shared/types/index";
import { migratePinnedProjectIds, useSettingsStore } from "../../../shared/preferences/settingsStore";

// 置顶关系只保存项目 ID；渲染前过滤未知项目，避免删除、恢复或同步期间出现悬挂入口。
export function usePinnedProjects(projects: Project[], projectStoreLoaded: boolean) {
  const pinnedProjectIds = useSettingsStore((state) => state.pinnedProjectIds);
  const pinnedSectionCollapsed = useSettingsStore((state) => state.sidebarPinnedSectionCollapsed);
  const settingsLoaded = useSettingsStore((state) => state.loaded);
  const updateSetting = useSettingsStore((state) => state.update);
  const normalizedPinnedProjectIds = useMemo(
    () => migratePinnedProjectIds(pinnedProjectIds),
    [pinnedProjectIds]
  );

  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects]
  );
  const projectIds = useMemo(() => new Set(projectById.keys()), [projectById]);
  const validPinnedProjectIds = useMemo(
    () => normalizedPinnedProjectIds.filter((projectId) => projectIds.has(projectId)),
    [normalizedPinnedProjectIds, projectIds]
  );
  const pinnedProjectIdSet = useMemo(
    () => new Set(validPinnedProjectIds),
    [validPinnedProjectIds]
  );
  const pinnedProjects = useMemo(
    () => validPinnedProjectIds
      .map((projectId) => projectById.get(projectId))
      .filter((project): project is Project => project !== undefined),
    [projectById, validPinnedProjectIds]
  );

  useEffect(() => {
    const pinnedProjectIdsAreNormalized = Array.isArray(pinnedProjectIds)
      && normalizedPinnedProjectIds.length === pinnedProjectIds.length
      && normalizedPinnedProjectIds.every((projectId, index) => projectId === pinnedProjectIds[index]);
    const pinnedProjectsAreValid = pinnedProjectIdsAreNormalized
      && validPinnedProjectIds.length === normalizedPinnedProjectIds.length
      && validPinnedProjectIds.every((projectId, index) => projectId === normalizedPinnedProjectIds[index]);
    if (!projectStoreLoaded || !settingsLoaded || pinnedProjectsAreValid) return;
    const currentPinnedProjectIds = migratePinnedProjectIds(useSettingsStore.getState().pinnedProjectIds);
    const nextPinnedProjectIds = currentPinnedProjectIds.filter((projectId) => projectIds.has(projectId));
    if (
      nextPinnedProjectIds.length === currentPinnedProjectIds.length
      && nextPinnedProjectIds.every((projectId, index) => projectId === currentPinnedProjectIds[index])
    ) return;
    void updateSetting("pinnedProjectIds", nextPinnedProjectIds);
  }, [
    pinnedProjectIds,
    normalizedPinnedProjectIds,
    projectIds,
    projectStoreLoaded,
    settingsLoaded,
    updateSetting,
    validPinnedProjectIds,
  ]);

  const isProjectPinned = useCallback(
    (projectId: string) => pinnedProjectIdSet.has(projectId),
    [pinnedProjectIdSet]
  );

  const togglePinned = useCallback(async (projectId: string) => {
    const currentPinnedProjectIds = migratePinnedProjectIds(useSettingsStore.getState().pinnedProjectIds);
    const nextPinnedProjectIds = currentPinnedProjectIds.includes(projectId)
      ? currentPinnedProjectIds.filter((item) => item !== projectId)
      : [...currentPinnedProjectIds, projectId];
    await updateSetting("pinnedProjectIds", nextPinnedProjectIds);
  }, [updateSetting]);

  const togglePinnedSection = useCallback(async () => {
    const currentCollapsed = useSettingsStore.getState().sidebarPinnedSectionCollapsed;
    await updateSetting("sidebarPinnedSectionCollapsed", !currentCollapsed);
  }, [updateSetting]);

  return {
    pinnedProjectIds: normalizedPinnedProjectIds,
    pinnedProjects,
    pinnedSectionCollapsed,
    isProjectPinned,
    togglePinned,
    togglePinnedSection,
  };
}
