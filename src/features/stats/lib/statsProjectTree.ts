import type { Group, Project } from "../../../shared/types/index";
import { resolveHistoryProjectPath } from "../../history/api/historyProjectPaths";

export type StatsProjectTreeNode =
  | { type: "group"; group: Group; children: StatsProjectTreeNode[] }
  | { type: "project"; project: Project };

export function buildStatsProjectTree(groups: Group[], projects: Project[]): StatsProjectTreeNode[] {
  const childGroups = new Map<string | null, Group[]>();
  const groupProjects = new Map<string | null, Project[]>();

  for (const group of groups) {
    const list = childGroups.get(group.parent_id) ?? [];
    list.push(group);
    childGroups.set(group.parent_id, list);
  }

  for (const project of projects) {
    const list = groupProjects.get(project.group_id) ?? [];
    list.push(project);
    groupProjects.set(project.group_id, list);
  }

  const buildLevel = (parentId: string | null): StatsProjectTreeNode[] => {
    const nodes: StatsProjectTreeNode[] = [];
    const sortedGroups = [...(childGroups.get(parentId) ?? [])].sort(
      (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)
    );
    const sortedProjects = [...(groupProjects.get(parentId) ?? [])].sort(
      (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)
    );

    for (const group of sortedGroups) {
      nodes.push({ type: "group", group, children: buildLevel(group.id) });
    }
    for (const project of sortedProjects) {
      nodes.push({ type: "project", project });
    }
    return nodes;
  };

  return buildLevel(null);
}

export function countStatsProjects(node: StatsProjectTreeNode): number {
  if (node.type === "project") return 1;
  return node.children.reduce((sum, child) => sum + countStatsProjects(child), 0);
}

export function collectStatsGroupIds(nodes: StatsProjectTreeNode[], out: string[] = []): string[] {
  for (const node of nodes) {
    if (node.type !== "group") continue;
    out.push(node.group.id);
    collectStatsGroupIds(node.children, out);
  }
  return out;
}

export function normalizeProjectSearch(value: string): string {
  return value.trim().toLowerCase();
}

function statsProjectMatchesSearch(project: Project, query: string): boolean {
  if (!query) return true;
  return (
    project.name.toLowerCase().includes(query) ||
    resolveHistoryProjectPath(project).toLowerCase().includes(query) ||
    project.cli_tool.toLowerCase().includes(query)
  );
}

export function filterStatsProjectTree(nodes: StatsProjectTreeNode[], query: string): StatsProjectTreeNode[] {
  if (!query) return nodes;

  const result: StatsProjectTreeNode[] = [];
  for (const node of nodes) {
    if (node.type === "project") {
      if (statsProjectMatchesSearch(node.project, query)) result.push(node);
      continue;
    }

    const groupMatches = node.group.name.toLowerCase().includes(query);
    const children = groupMatches ? node.children : filterStatsProjectTree(node.children, query);
    if (groupMatches || children.length > 0) {
      result.push({ ...node, children });
    }
  }
  return result;
}
