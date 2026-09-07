import type { GitCommitSummary } from "../../../lib/types";

export const GIT_GRAPH_LANE_WIDTH = 14;

export const GIT_GRAPH_COLORS = [
  "#5AC8E0",
  "#E5C453",
  "#C77DBB",
  "#3DD68C",
  "#F25E5E",
  "#5B8DEF",
] as const;

export interface GitGraphSegment {
  fromLane: number;
  toLane: number;
  colorLane: number;
  kind: "continuation" | "parent" | "truncated";
}

export interface GitGraphRow {
  commitId: string;
  lane: number;
  laneCount: number;
  segments: GitGraphSegment[];
  truncatedParentCount: number;
}

export interface GitGraphLayoutOptions {
  connectOnlyVisible?: boolean;
}

function unique(values: string[]): string[] {
  return values.filter(
    (value, index) => value.length > 0 && values.indexOf(value) === index,
  );
}

export function gitGraphColor(lane: number): string {
  return GIT_GRAPH_COLORS[Math.abs(lane) % GIT_GRAPH_COLORS.length];
}

export function layoutGitGraph(
  commits: GitCommitSummary[],
  options: GitGraphLayoutOptions = {},
): GitGraphRow[] {
  const visibleIds = new Set(commits.map((commit) => commit.id));
  let lanes: string[] = [];

  return commits.map((commit) => {
    if (!lanes.includes(commit.id)) lanes = [commit.id, ...lanes];

    const before = [...lanes];
    const lane = before.indexOf(commit.id);
    const allParents = unique(commit.parents);
    const parents = options.connectOnlyVisible
      ? allParents.filter((parent) => visibleIds.has(parent))
      : allParents;
    const truncatedParentCount = allParents.length - parents.length;
    const after = before.filter((id) => id !== commit.id);

    parents.forEach((parent, parentIndex) => {
      if (after.includes(parent)) return;
      after.splice(Math.min(lane + parentIndex, after.length), 0, parent);
    });

    const segments: GitGraphSegment[] = [];
    before.forEach((id, fromLane) => {
      if (id === commit.id) return;
      const toLane = after.indexOf(id);
      if (toLane >= 0) {
        segments.push({
          fromLane,
          toLane,
          colorLane: fromLane,
          kind: "continuation",
        });
      }
    });
    parents.forEach((parent) => {
      const toLane = after.indexOf(parent);
      if (toLane >= 0) {
        segments.push({
          fromLane: lane,
          toLane,
          colorLane: lane,
          kind: "parent",
        });
      }
    });
    if (truncatedParentCount > 0) {
      segments.push({
        fromLane: lane,
        toLane: lane,
        colorLane: lane,
        kind: "truncated",
      });
    }

    lanes = after;
    return {
      commitId: commit.id,
      lane,
      laneCount: Math.max(1, before.length, after.length),
      segments,
      truncatedParentCount,
    };
  });
}
