export type TerminalPaneSplitDirection = "horizontal" | "vertical";
export type TerminalPaneDropEdge = "left" | "right" | "top" | "bottom";

export interface TerminalPaneLeaf {
  type: "leaf";
  id: string;
  sessionIds: string[];
  activeSessionId: string | null;
}

export interface TerminalPaneSplit {
  type: "split";
  id: string;
  direction: TerminalPaneSplitDirection;
  ratio: number;
  first: TerminalPaneNode;
  second: TerminalPaneNode;
}

export type TerminalPaneNode = TerminalPaneLeaf | TerminalPaneSplit;
export type UnsplitBehavior = "merge" | "close";

type IdFactory = () => string;

const MIN_SPLIT_RATIO = 0.2;
const MAX_SPLIT_RATIO = 0.8;

export function clampSplitRatio(ratio: number): number {
  return Math.max(MIN_SPLIT_RATIO, Math.min(MAX_SPLIT_RATIO, ratio));
}

export function createPaneLeaf(id: string, sessionIds: string[] = [], activeSessionId: string | null = null): TerminalPaneLeaf {
  const active = activeSessionId && sessionIds.includes(activeSessionId) ? activeSessionId : sessionIds[0] ?? null;
  return { type: "leaf", id, sessionIds, activeSessionId: active };
}

export function createSinglePaneTree(sessionIds: string[], activeSessionId: string | null, createId: IdFactory): TerminalPaneLeaf {
  return createPaneLeaf(createId(), sessionIds, activeSessionId);
}

export function collectPaneLeaves(node: TerminalPaneNode | null): TerminalPaneLeaf[] {
  if (!node) return [];
  if (node.type === "leaf") return [node];
  return [...collectPaneLeaves(node.first), ...collectPaneLeaves(node.second)];
}

export function findPaneLeaf(node: TerminalPaneNode | null, paneId: string): TerminalPaneLeaf | null {
  if (!node) return null;
  if (node.type === "leaf") return node.id === paneId ? node : null;
  return findPaneLeaf(node.first, paneId) ?? findPaneLeaf(node.second, paneId);
}

export function findPaneLeafBySession(node: TerminalPaneNode | null, sessionId: string): TerminalPaneLeaf | null {
  if (!node) return null;
  if (node.type === "leaf") return node.sessionIds.includes(sessionId) ? node : null;
  return findPaneLeafBySession(node.first, sessionId) ?? findPaneLeafBySession(node.second, sessionId);
}

export function findFirstSessionId(node: TerminalPaneNode | null): string | null {
  return collectPaneLeaves(node).find((pane) => pane.activeSessionId)?.activeSessionId ?? null;
}

export function normalizePaneTree(node: TerminalPaneNode | null): TerminalPaneNode | null {
  if (!node) return null;
  if (node.type === "leaf") return node.sessionIds.length > 0 ? node : null;

  const first = normalizePaneTree(node.first);
  const second = normalizePaneTree(node.second);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}

export function filterPaneTreeBySessionIds(node: TerminalPaneNode | null, visibleSessionIds: Set<string>): TerminalPaneNode | null {
  if (!node) return null;
  if (node.type === "leaf") {
    const sessionIds = node.sessionIds.filter((id) => visibleSessionIds.has(id));
    return sessionIds.length > 0
      ? createPaneLeaf(node.id, sessionIds, node.activeSessionId)
      : null;
  }

  return normalizePaneTree({
    ...node,
    first: filterPaneTreeBySessionIds(node.first, visibleSessionIds) ?? createPaneLeaf("empty-first"),
    second: filterPaneTreeBySessionIds(node.second, visibleSessionIds) ?? createPaneLeaf("empty-second"),
  });
}

export function addSessionToPaneTree(
  tree: TerminalPaneNode | null,
  paneId: string | null,
  sessionId: string,
  createId: IdFactory
): { tree: TerminalPaneNode; activePaneId: string } {
  if (!tree) {
    const leaf = createPaneLeaf(createId(), [sessionId], sessionId);
    return { tree: leaf, activePaneId: leaf.id };
  }

  const targetPaneId = paneId && findPaneLeaf(tree, paneId) ? paneId : collectPaneLeaves(tree)[0]?.id ?? null;
  if (!targetPaneId) {
    const leaf = createPaneLeaf(createId(), [sessionId], sessionId);
    return { tree: leaf, activePaneId: leaf.id };
  }

  const update = (node: TerminalPaneNode): TerminalPaneNode => {
    if (node.type === "leaf") {
      if (node.id !== targetPaneId) return node;
      if (node.sessionIds.includes(sessionId)) return { ...node, activeSessionId: sessionId };
      return { ...node, sessionIds: [...node.sessionIds, sessionId], activeSessionId: sessionId };
    }
    return { ...node, first: update(node.first), second: update(node.second) };
  };

  return { tree: update(tree), activePaneId: targetPaneId };
}

/**
 * Split a pane leaf into two, creating a new empty leaf (no sessions).
 * Unlike splitPaneLeaf, this does not require a new session — the new leaf
 * starts empty, ready for sessions to be added via addSessionToPaneTree.
 */
export function splitPaneEmpty(
  tree: TerminalPaneNode,
  paneId: string,
  direction: TerminalPaneSplitDirection,
  createId: IdFactory
): { tree: TerminalPaneNode; activePaneId: string } {
  const newPane = createPaneLeaf(createId(), [], null);

  const update = (node: TerminalPaneNode): TerminalPaneNode => {
    if (node.type === "leaf") {
      if (node.id !== paneId) return node;
      return {
        type: "split",
        id: createId(),
        direction,
        ratio: 0.5,
        first: node,
        second: newPane,
      };
    }
    return { ...node, first: update(node.first), second: update(node.second) };
  };

  return { tree: update(tree), activePaneId: newPane.id };
}

export function splitPaneLeaf(
  tree: TerminalPaneNode,
  paneId: string,
  direction: TerminalPaneSplitDirection,
  newSessionId: string,
  createId: IdFactory
): { tree: TerminalPaneNode; activePaneId: string } {
  const newPane = createPaneLeaf(createId(), [newSessionId], newSessionId);

  const update = (node: TerminalPaneNode): TerminalPaneNode => {
    if (node.type === "leaf") {
      if (node.id !== paneId) return node;
      return {
        type: "split",
        id: createId(),
        direction,
        ratio: 0.5,
        first: node,
        second: newPane,
      };
    }
    return { ...node, first: update(node.first), second: update(node.second) };
  };

  return { tree: update(tree), activePaneId: newPane.id };
}

function directionFromDropEdge(edge: TerminalPaneDropEdge): TerminalPaneSplitDirection {
  return edge === "left" || edge === "right" ? "horizontal" : "vertical";
}

function shouldPlaceDroppedPaneFirst(edge: TerminalPaneDropEdge): boolean {
  return edge === "left" || edge === "top";
}

export function splitExistingSessionToPaneEdge(
  tree: TerminalPaneNode | null,
  sessionId: string,
  targetPaneId: string,
  edge: TerminalPaneDropEdge,
  createId: IdFactory
): { tree: TerminalPaneNode | null; activePaneId: string | null; activeSessionId: string | null; changed: boolean } {
  const sourcePane = findPaneLeafBySession(tree, sessionId);
  const targetPane = findPaneLeaf(tree, targetPaneId);
  if (!tree || !sourcePane || !targetPane) {
    return { tree, activePaneId: null, activeSessionId: null, changed: false };
  }

  const isSamePane = sourcePane.id === targetPane.id;
  if (isSamePane && sourcePane.sessionIds.length <= 1) {
    return { tree, activePaneId: sourcePane.id, activeSessionId: sourcePane.activeSessionId, changed: false };
  }

  const direction = directionFromDropEdge(edge);
  const droppedPane = createPaneLeaf(createId(), [sessionId], sessionId);
  const placeDroppedPaneFirst = shouldPlaceDroppedPaneFirst(edge);

  const removeSessionFromLeaf = (leaf: TerminalPaneLeaf): TerminalPaneLeaf => {
    const sessionIds = leaf.sessionIds.filter((id) => id !== sessionId);
    const activeSessionId = leaf.activeSessionId === sessionId ? sessionIds[sessionIds.length - 1] ?? null : leaf.activeSessionId;
    return createPaneLeaf(leaf.id, sessionIds, activeSessionId);
  };

  const splitTargetLeaf = (leaf: TerminalPaneLeaf): TerminalPaneSplit => {
    const target = isSamePane ? removeSessionFromLeaf(leaf) : leaf;
    return {
      type: "split",
      id: createId(),
      direction,
      ratio: 0.5,
      first: placeDroppedPaneFirst ? droppedPane : target,
      second: placeDroppedPaneFirst ? target : droppedPane,
    };
  };

  const update = (node: TerminalPaneNode): TerminalPaneNode | null => {
    if (node.type === "leaf") {
      if (node.id === targetPaneId) return splitTargetLeaf(node);
      if (node.id === sourcePane.id) return removeSessionFromLeaf(node);
      return node;
    }
    return normalizePaneTree({
      ...node,
      first: update(node.first) ?? createPaneLeaf("empty-first"),
      second: update(node.second) ?? createPaneLeaf("empty-second"),
    });
  };

  return {
    tree: normalizePaneTree(update(tree)),
    activePaneId: droppedPane.id,
    activeSessionId: sessionId,
    changed: true,
  };
}

export function setPaneActiveSession(tree: TerminalPaneNode | null, sessionId: string): { tree: TerminalPaneNode | null; activePaneId: string | null } {
  const pane = findPaneLeafBySession(tree, sessionId);
  if (!tree || !pane) return { tree, activePaneId: null };

  const update = (node: TerminalPaneNode): TerminalPaneNode => {
    if (node.type === "leaf") {
      return node.id === pane.id ? { ...node, activeSessionId: sessionId } : node;
    }
    return { ...node, first: update(node.first), second: update(node.second) };
  };

  return { tree: update(tree), activePaneId: pane.id };
}

export function removeSessionFromPaneTree(tree: TerminalPaneNode | null, sessionId: string): TerminalPaneNode | null {
  if (!tree) return null;
  if (tree.type === "leaf") {
    if (!tree.sessionIds.includes(sessionId)) return tree;
    const sessionIds = tree.sessionIds.filter((id) => id !== sessionId);
    const activeSessionId = tree.activeSessionId === sessionId ? sessionIds[sessionIds.length - 1] ?? null : tree.activeSessionId;
    return normalizePaneTree({ ...tree, sessionIds, activeSessionId });
  }
  return normalizePaneTree({
    ...tree,
    first: removeSessionFromPaneTree(tree.first, sessionId) ?? createPaneLeaf("empty-first"),
    second: removeSessionFromPaneTree(tree.second, sessionId) ?? createPaneLeaf("empty-second"),
  });
}

function appendSessionsToFirstLeaf(node: TerminalPaneNode, sessionIds: string[], activeSessionId: string | null): TerminalPaneNode {
  if (node.type === "leaf") {
    const nextSessionIds = [...node.sessionIds, ...sessionIds.filter((id) => !node.sessionIds.includes(id))];
    return { ...node, sessionIds: nextSessionIds, activeSessionId: activeSessionId ?? node.activeSessionId ?? nextSessionIds[0] ?? null };
  }
  return { ...node, first: appendSessionsToFirstLeaf(node.first, sessionIds, activeSessionId) };
}

export function unsplitPaneLeaf(
  tree: TerminalPaneNode | null,
  paneId: string,
  behavior: UnsplitBehavior
): { tree: TerminalPaneNode | null; closedSessionIds: string[]; activePaneId: string | null; activeSessionId: string | null } {
  const target = findPaneLeaf(tree, paneId);
  if (!tree || !target) {
    return { tree, closedSessionIds: [], activePaneId: null, activeSessionId: findFirstSessionId(tree) };
  }

  const closedSessionIds = behavior === "close" ? target.sessionIds : [];

  const update = (node: TerminalPaneNode): TerminalPaneNode | null => {
    if (node.type === "leaf") return node.id === paneId ? null : node;

    const firstTarget = findPaneLeaf(node.first, paneId);
    const secondTarget = findPaneLeaf(node.second, paneId);
    if (firstTarget) {
      const sibling = behavior === "merge"
        ? appendSessionsToFirstLeaf(node.second, firstTarget.sessionIds, firstTarget.activeSessionId)
        : node.second;
      return normalizePaneTree(sibling);
    }
    if (secondTarget) {
      const sibling = behavior === "merge"
        ? appendSessionsToFirstLeaf(node.first, secondTarget.sessionIds, secondTarget.activeSessionId)
        : node.first;
      return normalizePaneTree(sibling);
    }

    return normalizePaneTree({ ...node, first: update(node.first) ?? createPaneLeaf("empty-first"), second: update(node.second) ?? createPaneLeaf("empty-second") });
  };

  const nextTree = normalizePaneTree(update(tree));
  const leaves = collectPaneLeaves(nextTree);
  const activePane = leaves.find((pane) => pane.activeSessionId) ?? leaves[0] ?? null;
  return {
    tree: nextTree,
    closedSessionIds,
    activePaneId: activePane?.id ?? null,
    activeSessionId: activePane?.activeSessionId ?? null,
  };
}

export function resizePaneSplit(tree: TerminalPaneNode | null, splitId: string, ratio: number): TerminalPaneNode | null {
  if (!tree) return null;
  const clamped = clampSplitRatio(ratio);
  if (tree.type === "split" && tree.id === splitId) return { ...tree, ratio: clamped };
  if (tree.type === "leaf") return tree;
  return { ...tree, first: resizePaneSplit(tree.first, splitId, ratio) ?? tree.first, second: resizePaneSplit(tree.second, splitId, ratio) ?? tree.second };
}

export function reorderSessionInPane(tree: TerminalPaneNode | null, paneId: string, fromSessionId: string, toSessionId: string): TerminalPaneNode | null {
  if (!tree || fromSessionId === toSessionId) return tree;
  if (tree.type === "leaf") {
    if (tree.id !== paneId) return tree;
    const fromIndex = tree.sessionIds.indexOf(fromSessionId);
    const toIndex = tree.sessionIds.indexOf(toSessionId);
    if (fromIndex < 0 || toIndex < 0) return tree;
    const sessionIds = [...tree.sessionIds];
    const [moved] = sessionIds.splice(fromIndex, 1);
    sessionIds.splice(toIndex, 0, moved);
    return { ...tree, sessionIds, activeSessionId: fromSessionId };
  }
  return { ...tree, first: reorderSessionInPane(tree.first, paneId, fromSessionId, toSessionId) ?? tree.first, second: reorderSessionInPane(tree.second, paneId, fromSessionId, toSessionId) ?? tree.second };
}

export function moveSessionToPane(
  tree: TerminalPaneNode | null,
  sourcePaneId: string,
  targetPaneId: string,
  sessionId: string,
  beforeSessionId?: string
): { tree: TerminalPaneNode | null; activePaneId: string | null } {
  if (!tree || sourcePaneId === targetPaneId) return { tree, activePaneId: targetPaneId };

  const update = (node: TerminalPaneNode): TerminalPaneNode => {
    if (node.type === "leaf") {
      if (node.id === sourcePaneId) {
        const sessionIds = node.sessionIds.filter((id) => id !== sessionId);
        const activeSessionId = node.activeSessionId === sessionId ? sessionIds[sessionIds.length - 1] ?? null : node.activeSessionId;
        return { ...node, sessionIds, activeSessionId };
      }
      if (node.id === targetPaneId && !node.sessionIds.includes(sessionId)) {
        const sessionIds = [...node.sessionIds];
        const beforeIndex = beforeSessionId ? sessionIds.indexOf(beforeSessionId) : -1;
        if (beforeIndex >= 0) sessionIds.splice(beforeIndex, 0, sessionId);
        else sessionIds.push(sessionId);
        return { ...node, sessionIds, activeSessionId: sessionId };
      }
      return node;
    }
    return { ...node, first: update(node.first), second: update(node.second) };
  };

  return { tree: normalizePaneTree(update(tree)), activePaneId: targetPaneId };
}

export function getNextSessionIdForShortcut(tree: TerminalPaneNode | null, activePaneId: string | null, activeSessionId: string | null, delta: 1 | -1): string | null {
  const leaves = collectPaneLeaves(tree).filter((pane) => pane.sessionIds.length > 0);
  if (leaves.length === 0) return null;
  const activePane = activePaneId ? leaves.find((pane) => pane.id === activePaneId) : activeSessionId ? leaves.find((pane) => pane.sessionIds.includes(activeSessionId)) : null;

  if (activePane && activePane.sessionIds.length > 1) {
    const index = Math.max(0, activePane.sessionIds.indexOf(activeSessionId ?? activePane.activeSessionId ?? activePane.sessionIds[0]));
    return activePane.sessionIds[(index + delta + activePane.sessionIds.length) % activePane.sessionIds.length];
  }

  const paneIndex = Math.max(0, activePane ? leaves.findIndex((pane) => pane.id === activePane.id) : 0);
  const nextPane = leaves[(paneIndex + delta + leaves.length) % leaves.length];
  return nextPane.activeSessionId ?? nextPane.sessionIds[0] ?? null;
}
