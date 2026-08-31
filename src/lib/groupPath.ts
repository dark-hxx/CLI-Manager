import type { Group, Project } from "./types";

/** 返回指定分组及其祖先链上最近的绑定路径。 */
export function resolveGroupBoundPath(groups: Group[], groupId: string | null | undefined): string {
  if (!groupId) return "";
  const byId = new Map(groups.map((group) => [group.id, group]));
  const visited = new Set<string>();
  let current = groupId;
  while (current && !visited.has(current)) {
    visited.add(current);
    const group = byId.get(current);
    if (!group) break;
    const bound = group.bound_path?.trim() ?? "";
    if (bound) return bound;
    current = group.parent_id ?? "";
  }
  return "";
}

/** 解析项目实际工作目录；继承模式下实时读取当前分组及祖先绑定。 */
export function resolveProjectPath(project: Project, groups: Group[]): string {
  if (project.path_mode === "inherit") {
    return resolveGroupBoundPath(groups, project.group_id) || project.path;
  }
  return project.path;
}

/** 返回指定分组及其全部后代分组，供选择和级联操作共用。 */
export function collectGroupSubtreeIds(groupId: string, groups: Group[]): Set<string> {
  const children = new Map<string, Group[]>();
  for (const group of groups) {
    const parentId = group.parent_id ?? "";
    children.set(parentId, [...(children.get(parentId) ?? []), group]);
  }

  const ids = new Set<string>([groupId]);
  const pending = [groupId];
  while (pending.length > 0) {
    const currentId = pending.pop()!;
    for (const child of children.get(currentId) ?? []) {
      if (ids.has(child.id)) continue;
      ids.add(child.id);
      pending.push(child.id);
    }
  }
  return ids;
}

export interface InheritedDescendantIds {
  groupIds: string[];
  projectIds: string[];
}

/** 找出实际依赖指定分组自身绑定路径的后代继承节点。 */
export function findInheritedDescendants(
  groupId: string,
  groups: Group[],
  projects: Project[],
): InheritedDescendantIds {
  const children = new Map<string, Group[]>();
  const projectsByGroup = new Map<string, Project[]>();
  for (const group of groups) {
    const parent = group.parent_id ?? "";
    children.set(parent, [...(children.get(parent) ?? []), group]);
  }
  for (const project of projects) {
    if (!project.group_id) continue;
    projectsByGroup.set(project.group_id, [...(projectsByGroup.get(project.group_id) ?? []), project]);
  }

  const groupIds: string[] = [];
  const projectIds: string[] = [];
  const visited = new Set<string>();
  const visit = (currentId: string, sourceId: string | null) => {
    if (visited.has(currentId)) return;
    visited.add(currentId);

    for (const project of projectsByGroup.get(currentId) ?? []) {
      if (project.path_mode === "inherit" && sourceId === groupId) projectIds.push(project.id);
    }

    for (const group of children.get(currentId) ?? []) {
      const bound = group.bound_path?.trim() ?? "";
      const nextSource = bound ? group.id : sourceId;
      if (!bound && sourceId === groupId) groupIds.push(group.id);
      visit(group.id, nextSource);
    }
  };

  const root = groups.find((group) => group.id === groupId);
  if (root?.bound_path?.trim()) visit(groupId, groupId);
  return { groupIds, projectIds };
}
