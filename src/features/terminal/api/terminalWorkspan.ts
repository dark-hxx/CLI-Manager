import {
  addSessionToPaneTree,
  collectPaneLeaves,
  createPaneLeaf,
  findPaneLeaf,
  findPaneLeafBySession,
  normalizePaneTree,
  removeSessionFromPaneTree,
  setPaneActiveSession,
  type TerminalPaneDropEdge,
  type TerminalPaneNode,
} from "./terminalPaneTree";

export interface TerminalWorkspan {
  id: string;
  customTitle: string | null;
  paneTree: TerminalPaneNode | null;
  activePaneId: string | null;
  activeSessionId: string | null;
}

type IdFactory = () => string;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function migratePaneTree(value: unknown): TerminalPaneNode | null {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id) return null;

  if (value.type === "leaf") {
    const sessionIds = Array.isArray(value.sessionIds)
      ? Array.from(new Set(value.sessionIds.filter((item): item is string => typeof item === "string" && item.length > 0)))
      : [];
    if (sessionIds.length === 0) return null;
    const activeSessionId = typeof value.activeSessionId === "string" && sessionIds.includes(value.activeSessionId)
      ? value.activeSessionId
      : sessionIds[0] ?? null;
    return createPaneLeaf(value.id, sessionIds, activeSessionId);
  }

  if (value.type !== "split") return null;
  const first = migratePaneTree(value.first);
  const second = migratePaneTree(value.second);
  if (!first) return second;
  if (!second) return first;
  const ratio = typeof value.ratio === "number" && Number.isFinite(value.ratio)
    ? Math.max(0.2, Math.min(0.8, value.ratio))
    : 0.5;
  return {
    type: "split",
    id: value.id,
    direction: value.direction === "vertical" ? "vertical" : "horizontal",
    ratio,
    first,
    second,
  };
}

function resolveWorkspanLayout(workspan: TerminalWorkspan, paneTree: TerminalPaneNode): TerminalWorkspan {
  const leaves = collectPaneLeaves(paneTree);
  const requestedPane = workspan.activePaneId ? findPaneLeaf(paneTree, workspan.activePaneId) : null;
  const requestedSessionPane = workspan.activeSessionId
    ? findPaneLeafBySession(paneTree, workspan.activeSessionId)
    : null;
  const activePane = requestedPane ?? requestedSessionPane ?? leaves[0] ?? null;
  const activeSessionId = workspan.activeSessionId && findPaneLeafBySession(paneTree, workspan.activeSessionId)
    ? workspan.activeSessionId
    : activePane?.activeSessionId ?? activePane?.sessionIds[0] ?? null;
  return {
    ...workspan,
    paneTree,
    activePaneId: activeSessionId
      ? findPaneLeafBySession(paneTree, activeSessionId)?.id ?? activePane?.id ?? null
      : activePane?.id ?? null,
    activeSessionId,
  };
}

export function migrateTerminalWorkspans(value: unknown): TerminalWorkspan[] {
  if (!Array.isArray(value)) return [];
  const seenIds = new Set<string>();
  const workspans: TerminalWorkspan[] = [];

  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id || seenIds.has(item.id)) continue;
    const paneTree = migratePaneTree(item.paneTree);
    if (!paneTree) continue;
    seenIds.add(item.id);
    workspans.push(resolveWorkspanLayout({
      id: item.id,
      customTitle: typeof item.customTitle === "string" && item.customTitle.trim()
        ? item.customTitle.trim()
        : null,
      paneTree,
      activePaneId: typeof item.activePaneId === "string" ? item.activePaneId : null,
      activeSessionId: typeof item.activeSessionId === "string" ? item.activeSessionId : null,
    }, paneTree));
  }

  return workspans;
}

export function createTerminalWorkspan(id: string, paneId: string, sessionId: string): TerminalWorkspan {
  return {
    id,
    customTitle: null,
    paneTree: createPaneLeaf(paneId, [sessionId], sessionId),
    activePaneId: paneId,
    activeSessionId: sessionId,
  };
}

export function collectWorkspanSessionIds(workspan: TerminalWorkspan): string[] {
  return collectPaneLeaves(workspan.paneTree).flatMap((pane) => pane.sessionIds);
}

export function detachTerminalWorkspanSessions(
  workspan: TerminalWorkspan,
  createWorkspanId: IdFactory,
  createPaneId: IdFactory
): TerminalWorkspan[] {
  const seen = new Set<string>();
  return collectPaneLeaves(workspan.paneTree).flatMap((pane) => pane.sessionIds).flatMap((sessionId) => {
    if (seen.has(sessionId)) return [];
    seen.add(sessionId);
    return [createTerminalWorkspan(createWorkspanId(), createPaneId(), sessionId)];
  });
}

export function detachTerminalSessionToWorkspan(
  workspans: TerminalWorkspan[],
  sessionId: string,
  createWorkspanId: IdFactory,
  createPaneId: IdFactory,
  requestedInsertAt?: number
): { workspans: TerminalWorkspan[]; detachedWorkspanId: string | null; changed: boolean } {
  const owner = findWorkspanBySession(workspans, sessionId);
  if (!owner || collectWorkspanSessionIds(owner).length <= 1) {
    return { workspans, detachedWorkspanId: null, changed: false };
  }

  const sourceIndex = workspans.findIndex((workspan) => workspan.id === owner.id);
  const remaining = removeSessionFromTerminalWorkspans(workspans, sessionId);
  const detached = createTerminalWorkspan(createWorkspanId(), createPaneId(), sessionId);
  const defaultInsertAt = Math.min(remaining.length, sourceIndex + 1);
  const insertAt = requestedInsertAt === undefined
    ? defaultInsertAt
    : Math.max(0, Math.min(remaining.length, Math.trunc(requestedInsertAt)));

  return {
    workspans: [...remaining.slice(0, insertAt), detached, ...remaining.slice(insertAt)],
    detachedWorkspanId: detached.id,
    changed: true,
  };
}

export function collapseTerminalWorkspansToLegacy(
  workspans: TerminalWorkspan[],
  requestedActiveWorkspanId: string | null,
  createId: IdFactory
): TerminalWorkspan[] {
  const activeWorkspan = workspans.find((workspan) => workspan.id === requestedActiveWorkspanId && workspan.paneTree)
    ?? workspans.find((workspan) => workspan.paneTree)
    ?? null;
  if (!activeWorkspan?.paneTree) return [];

  const activePane = activeWorkspan.activePaneId
    ? findPaneLeaf(activeWorkspan.paneTree, activeWorkspan.activePaneId)
    : null;
  const requestedActiveSessionId = activeWorkspan.activeSessionId
    ?? activePane?.activeSessionId
    ?? collectWorkspanSessionIds(activeWorkspan)[0]
    ?? null;
  const targetPaneId = requestedActiveSessionId
    ? findPaneLeafBySession(activeWorkspan.paneTree, requestedActiveSessionId)?.id ?? activeWorkspan.activePaneId
    : activeWorkspan.activePaneId;
  let paneTree = activeWorkspan.paneTree;
  const assignedSessionIds = new Set(collectWorkspanSessionIds(activeWorkspan));

  for (const workspan of workspans) {
    if (workspan.id === activeWorkspan.id) continue;
    for (const sessionId of collectWorkspanSessionIds(workspan)) {
      if (assignedSessionIds.has(sessionId)) continue;
      paneTree = addSessionToPaneTree(paneTree, targetPaneId, sessionId, createId).tree;
      assignedSessionIds.add(sessionId);
    }
  }

  const activeResult = requestedActiveSessionId
    ? setPaneActiveSession(paneTree, requestedActiveSessionId)
    : { tree: paneTree, activePaneId: targetPaneId ?? null };
  const resolvedPaneTree = activeResult.tree ?? paneTree;
  return [resolveWorkspanLayout({
    ...activeWorkspan,
    paneTree: resolvedPaneTree,
    activePaneId: activeResult.activePaneId,
    activeSessionId: requestedActiveSessionId,
  }, resolvedPaneTree)];
}

export function findWorkspanBySession(workspans: TerminalWorkspan[], sessionId: string): TerminalWorkspan | null {
  return workspans.find((workspan) => Boolean(findPaneLeafBySession(workspan.paneTree, sessionId))) ?? null;
}

export function findWorkspanByPane(workspans: TerminalWorkspan[], paneId: string): TerminalWorkspan | null {
  return workspans.find((workspan) => Boolean(findPaneLeaf(workspan.paneTree, paneId))) ?? null;
}

export function syncTerminalWorkspanLayout(
  workspan: TerminalWorkspan,
  paneTree: TerminalPaneNode | null,
  activePaneId: string | null,
  activeSessionId: string | null
): TerminalWorkspan {
  if (!paneTree) return { ...workspan, paneTree: null, activePaneId: null, activeSessionId: null };
  return resolveWorkspanLayout({ ...workspan, paneTree, activePaneId, activeSessionId }, paneTree);
}

export function updateTerminalWorkspan(
  workspans: TerminalWorkspan[],
  workspanId: string,
  update: (workspan: TerminalWorkspan) => TerminalWorkspan
): TerminalWorkspan[] {
  return workspans.map((workspan) => (workspan.id === workspanId ? update(workspan) : workspan));
}

export function reorderTerminalWorkspans(
  workspans: TerminalWorkspan[],
  fromWorkspanId: string,
  toWorkspanId: string
): TerminalWorkspan[] {
  if (fromWorkspanId === toWorkspanId) return workspans;
  const fromIndex = workspans.findIndex((workspan) => workspan.id === fromWorkspanId);
  const toIndex = workspans.findIndex((workspan) => workspan.id === toWorkspanId);
  if (fromIndex < 0 || toIndex < 0) return workspans;
  const next = [...workspans];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

export function getAdjacentWorkspanSessionId(
  workspans: TerminalWorkspan[],
  activeWorkspanId: string | null,
  delta: 1 | -1
): string | null {
  const navigable = workspans.flatMap((workspan) => {
    const sessionId = workspan.activeSessionId ?? collectWorkspanSessionIds(workspan)[0] ?? null;
    return sessionId ? [{ workspanId: workspan.id, sessionId }] : [];
  });
  if (navigable.length === 0) return null;
  const activeIndex = navigable.findIndex((item) => item.workspanId === activeWorkspanId);
  if (activeIndex < 0) return delta === 1 ? navigable[0].sessionId : navigable[navigable.length - 1].sessionId;
  return navigable[(activeIndex + delta + navigable.length) % navigable.length].sessionId;
}

export function removeSessionFromTerminalWorkspans(
  workspans: TerminalWorkspan[],
  sessionId: string
): TerminalWorkspan[] {
  return workspans.flatMap((workspan) => {
    if (!findPaneLeafBySession(workspan.paneTree, sessionId)) return [workspan];
    const paneTree = removeSessionFromPaneTree(workspan.paneTree, sessionId);
    if (!paneTree) return [];
    return [resolveWorkspanLayout({
      ...workspan,
      paneTree,
      activeSessionId: workspan.activeSessionId === sessionId ? null : workspan.activeSessionId,
    }, paneTree)];
  });
}

function insertPaneTreeAtEdge(
  node: TerminalPaneNode,
  targetPaneId: string,
  insertedTree: TerminalPaneNode,
  edge: TerminalPaneDropEdge,
  createId: IdFactory
): { tree: TerminalPaneNode; changed: boolean } {
  if (node.type === "leaf") {
    if (node.id !== targetPaneId) return { tree: node, changed: false };
    const insertFirst = edge === "left" || edge === "top";
    return {
      tree: {
        type: "split",
        id: createId(),
        direction: edge === "left" || edge === "right" ? "horizontal" : "vertical",
        ratio: 0.5,
        first: insertFirst ? insertedTree : node,
        second: insertFirst ? node : insertedTree,
      },
      changed: true,
    };
  }

  const first = insertPaneTreeAtEdge(node.first, targetPaneId, insertedTree, edge, createId);
  if (first.changed) return { tree: { ...node, first: first.tree }, changed: true };
  const second = insertPaneTreeAtEdge(node.second, targetPaneId, insertedTree, edge, createId);
  return second.changed
    ? { tree: { ...node, second: second.tree }, changed: true }
    : { tree: node, changed: false };
}

export function mergeTerminalWorkspansAtPaneEdge(
  workspans: TerminalWorkspan[],
  sourceWorkspanId: string,
  targetWorkspanId: string,
  targetPaneId: string,
  edge: TerminalPaneDropEdge,
  createId: IdFactory
): { workspans: TerminalWorkspan[]; activeWorkspanId: string; changed: boolean } {
  if (sourceWorkspanId === targetWorkspanId) {
    return { workspans, activeWorkspanId: targetWorkspanId, changed: false };
  }
  const source = workspans.find((workspan) => workspan.id === sourceWorkspanId);
  const target = workspans.find((workspan) => workspan.id === targetWorkspanId);
  if (!source?.paneTree || !target?.paneTree || !findPaneLeaf(target.paneTree, targetPaneId)) {
    return { workspans, activeWorkspanId: targetWorkspanId, changed: false };
  }

  const targetSessionIds = new Set(collectWorkspanSessionIds(target));
  if (collectWorkspanSessionIds(source).some((sessionId) => targetSessionIds.has(sessionId))) {
    return { workspans, activeWorkspanId: targetWorkspanId, changed: false };
  }

  const inserted = insertPaneTreeAtEdge(target.paneTree, targetPaneId, source.paneTree, edge, createId);
  if (!inserted.changed) return { workspans, activeWorkspanId: targetWorkspanId, changed: false };
  const activeSessionId = source.activeSessionId ?? collectWorkspanSessionIds(source)[0] ?? target.activeSessionId;
  const activePane = activeSessionId ? findPaneLeafBySession(inserted.tree, activeSessionId) : null;
  const merged = resolveWorkspanLayout({
    ...target,
    paneTree: inserted.tree,
    activePaneId: activePane?.id ?? target.activePaneId,
    activeSessionId,
  }, inserted.tree);

  return {
    workspans: workspans
      .filter((workspan) => workspan.id !== sourceWorkspanId)
      .map((workspan) => (workspan.id === targetWorkspanId ? merged : workspan)),
    activeWorkspanId: targetWorkspanId,
    changed: true,
  };
}

function remapPaneTreeSessionIds(
  node: TerminalPaneNode | null,
  sessionIdMap: Record<string, string>
): TerminalPaneNode | null {
  if (!node) return null;
  if (node.type === "leaf") {
    const sessionIds = node.sessionIds.map((id) => sessionIdMap[id]).filter((id): id is string => Boolean(id));
    const activeSessionId = node.activeSessionId ? sessionIdMap[node.activeSessionId] ?? null : null;
    return sessionIds.length > 0 ? createPaneLeaf(node.id, sessionIds, activeSessionId) : null;
  }
  const first = remapPaneTreeSessionIds(node.first, sessionIdMap);
  const second = remapPaneTreeSessionIds(node.second, sessionIdMap);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}

export function restoreTerminalWorkspans(
  persisted: TerminalWorkspan[],
  sessionIdMap: Record<string, string>
): TerminalWorkspan[] {
  return persisted.flatMap((workspan) => {
    const paneTree = remapPaneTreeSessionIds(workspan.paneTree, sessionIdMap);
    if (!paneTree) return [];
    return [resolveWorkspanLayout({
      ...workspan,
      paneTree,
      activeSessionId: workspan.activeSessionId ? sessionIdMap[workspan.activeSessionId] ?? null : null,
    }, paneTree)];
  });
}

export function sanitizeTerminalWorkspans(
  workspans: TerminalWorkspan[],
  validSessionIds: Set<string>
): TerminalWorkspan[] {
  const assignedSessionIds = new Set<string>();

  const filterUniqueSessions = (node: TerminalPaneNode | null): TerminalPaneNode | null => {
    if (!node) return null;
    if (node.type === "leaf") {
      const sessionIds = node.sessionIds.filter((sessionId) => {
        if (!validSessionIds.has(sessionId) || assignedSessionIds.has(sessionId)) return false;
        assignedSessionIds.add(sessionId);
        return true;
      });
      return sessionIds.length > 0 ? createPaneLeaf(node.id, sessionIds, node.activeSessionId) : null;
    }

    const first = filterUniqueSessions(node.first);
    const second = filterUniqueSessions(node.second);
    if (!first) return second;
    if (!second) return first;
    return normalizePaneTree({ ...node, first, second });
  };

  return workspans.flatMap((workspan) => {
    const paneTree = filterUniqueSessions(workspan.paneTree);
    if (!paneTree) return [];
    return [resolveWorkspanLayout({ ...workspan, paneTree }, paneTree)];
  });
}
