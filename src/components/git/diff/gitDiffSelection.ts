import { useCallback, useEffect, useMemo, useState } from "react";
import { getChangeKey, type ChangeData, type HunkData } from "react-diff-view";
import type { GitDiffViewMode } from "../../../stores/settingsStore";
import type { GitDiffLineSide } from "./types";

export interface GitDiffSelectableChange {
  key: string;
  side: GitDiffLineSide;
  hunkIndex: number;
}

export interface GitDiffSelectionOrder {
  changes: readonly GitDiffSelectableChange[];
  indexByKey: ReadonlyMap<string, number>;
}

type GitDiffSelectionScope = GitDiffLineSide | "unified";

interface GitDiffSelectionAnchor extends GitDiffSelectableChange {}

export interface GitDiffSelectionState {
  selectedKeys: ReadonlySet<string>;
  anchors: Partial<Record<GitDiffSelectionScope, GitDiffSelectionAnchor>>;
}

interface ApplyGitDiffSelectionOptions {
  target: GitDiffSelectableChange;
  order: GitDiffSelectionOrder;
  scope: GitDiffSelectionScope;
  extend: boolean;
}

interface GitDiffSelectionOrders {
  old: GitDiffSelectionOrder;
  new: GitDiffSelectionOrder;
  unified: GitDiffSelectionOrder;
}

export function createGitDiffSelectionState(): GitDiffSelectionState {
  return { selectedKeys: new Set(), anchors: {} };
}

export function createGitDiffSelectionOrder(
  changes: readonly GitDiffSelectableChange[],
): GitDiffSelectionOrder {
  return {
    changes,
    indexByKey: new Map(changes.map((change, index) => [change.key, index])),
  };
}

export function gitDiffChangeSide(change: ChangeData): GitDiffLineSide | null {
  if (change.type === "insert") return "new";
  if (change.type === "delete") return "old";
  return null;
}

function withSelectionAnchor(
  state: GitDiffSelectionState,
  target: GitDiffSelectableChange,
  scope: GitDiffSelectionScope,
): GitDiffSelectionState {
  const selectedKeys = new Set(state.selectedKeys);
  selectedKeys.add(target.key);
  return {
    selectedKeys,
    anchors: { ...state.anchors, [scope]: target },
  };
}

export function applyGitDiffSelection(
  state: GitDiffSelectionState,
  options: ApplyGitDiffSelectionOptions,
): GitDiffSelectionState {
  const { target, order, scope, extend } = options;
  if (!extend) {
    const selectedKeys = new Set(state.selectedKeys);
    if (selectedKeys.has(target.key)) selectedKeys.delete(target.key);
    else selectedKeys.add(target.key);
    return {
      selectedKeys,
      anchors: { ...state.anchors, [scope]: target },
    };
  }

  const anchor = state.anchors[scope];
  if (!anchor || anchor.side !== target.side) {
    const selectedKeys = scope === "unified" ? new Set<string>() : new Set(state.selectedKeys);
    selectedKeys.add(target.key);
    return {
      selectedKeys,
      anchors: { ...state.anchors, [scope]: target },
    };
  }

  const anchorIndex = order.indexByKey.get(anchor.key);
  const targetIndex = order.indexByKey.get(target.key);
  if (anchorIndex === undefined || targetIndex === undefined) {
    return withSelectionAnchor(state, target, scope);
  }

  const selectedKeys = new Set(state.selectedKeys);
  const start = Math.min(anchorIndex, targetIndex);
  const end = Math.max(anchorIndex, targetIndex);
  for (let index = start; index <= end; index += 1) {
    const change = order.changes[index];
    if (change.side === target.side) selectedKeys.add(change.key);
  }
  return { selectedKeys, anchors: state.anchors };
}

export function findAdjacentGitDiffChange(
  order: GitDiffSelectionOrder,
  currentKey: string,
  side: GitDiffLineSide,
  direction: -1 | 1,
): GitDiffSelectableChange | null {
  const currentIndex = order.indexByKey.get(currentKey);
  if (currentIndex === undefined) return null;
  for (
    let index = currentIndex + direction;
    index >= 0 && index < order.changes.length;
    index += direction
  ) {
    if (order.changes[index].side === side) return order.changes[index];
  }
  return null;
}

function buildSelectionOrders(hunks: readonly HunkData[] | undefined): GitDiffSelectionOrders {
  const changes = { old: [], new: [], unified: [] } as Record<
    GitDiffSelectionScope,
    GitDiffSelectableChange[]
  >;
  for (const [hunkIndex, hunk] of (hunks ?? []).entries()) {
    for (const change of hunk.changes) {
      const side = gitDiffChangeSide(change);
      if (!side) continue;
      const selectable = { key: getChangeKey(change), side, hunkIndex };
      changes[side].push(selectable);
      changes.unified.push(selectable);
    }
  }
  return {
    old: createGitDiffSelectionOrder(changes.old),
    new: createGitDiffSelectionOrder(changes.new),
    unified: createGitDiffSelectionOrder(changes.unified),
  };
}

export function useGitDiffSelection(
  hunks: readonly HunkData[] | undefined,
  viewMode: GitDiffViewMode,
  resetKey: string,
) {
  const [state, setState] = useState<GitDiffSelectionState>(createGitDiffSelectionState);
  const orders = useMemo(() => buildSelectionOrders(hunks), [hunks]);
  const selectedKeys = useMemo(() => [...state.selectedKeys], [state.selectedKeys]);

  useEffect(() => {
    setState(createGitDiffSelectionState());
  }, [resetKey, viewMode]);

  const selectChange = useCallback((change: ChangeData | null, extend: boolean) => {
    if (!change) return;
    const side = gitDiffChangeSide(change);
    if (!side) return;
    const scope = viewMode === "split" ? side : "unified";
    const targetIndex = orders[scope].indexByKey.get(getChangeKey(change));
    if (targetIndex === undefined) return;
    const target = orders[scope].changes[targetIndex];
    setState((current) => applyGitDiffSelection(current, {
      target,
      order: orders[scope],
      scope,
      extend,
    }));
  }, [orders, viewMode]);

  const extendSelectionFromKeyboard = useCallback((
    change: ChangeData | null,
    direction: -1 | 1,
  ): GitDiffSelectableChange | null => {
    if (!change) return null;
    const side = gitDiffChangeSide(change);
    if (!side) return null;
    const scope = viewMode === "split" ? side : "unified";
    const currentIndex = orders[scope].indexByKey.get(getChangeKey(change));
    if (currentIndex === undefined) return null;
    const current = orders[scope].changes[currentIndex];
    const next = findAdjacentGitDiffChange(orders[scope], current.key, side, direction);
    if (!next) return null;
    setState((previous) => {
      const anchored = previous.anchors[scope]
        ? previous
        : withSelectionAnchor(previous, current, scope);
      return applyGitDiffSelection(anchored, {
        target: next,
        order: orders[scope],
        scope,
        extend: true,
      });
    });
    return next;
  }, [orders, viewMode]);

  const clearSelection = useCallback(() => setState(createGitDiffSelectionState()), []);

  return {
    selectedKeys,
    selectedKeySet: state.selectedKeys,
    selectChange,
    extendSelectionFromKeyboard,
    clearSelection,
  };
}
