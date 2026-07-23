import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-workspan-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

function transpile(sourcePath, outputName, transform = (code) => code) {
  const source = readFileSync(new URL(sourcePath, import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: sourcePath,
  }).outputText;
  writeFileSync(join(tempDir, outputName), transform(output), "utf8");
}

transpile("../src/stores/terminalPaneTree.ts", "terminalPaneTree.mjs");
transpile(
  "../src/stores/terminalWorkspan.ts",
  "terminalWorkspan.mjs",
  (code) => code.replace('from "./terminalPaneTree"', 'from "./terminalPaneTree.mjs"')
);

const {
  collectPaneLeaves,
  filterPaneTreeBySessionIds,
  resolvePaneDropEdgeFromPoint,
} = await import(pathToFileURL(join(tempDir, "terminalPaneTree.mjs")).href);

const {
  collapseTerminalWorkspansToLegacy,
  collectWorkspanSessionIds,
  createTerminalWorkspan,
  detachTerminalSessionToWorkspan,
  detachTerminalWorkspanSessions,
  getAdjacentWorkspanSessionId,
  mergeTerminalWorkspansAtPaneEdge,
  migrateTerminalWorkspans,
  removeSessionFromTerminalWorkspans,
  reorderTerminalWorkspans,
  restoreTerminalWorkspans,
  sanitizeTerminalWorkspans,
} = await import(pathToFileURL(join(tempDir, "terminalWorkspan.mjs")).href);

function idFactory(prefix = "generated") {
  let sequence = 0;
  return () => `${prefix}-${++sequence}`;
}

test("workspan pane drop keeps a neutral center and resolves outer directions", () => {
  const rect = { left: 100, top: 200, width: 200, height: 100 };
  const activationRatio = 0.08;

  assert.equal(resolvePaneDropEdgeFromPoint(140, 250, rect, activationRatio), "left");
  assert.equal(resolvePaneDropEdgeFromPoint(260, 250, rect, activationRatio), "right");
  assert.equal(resolvePaneDropEdgeFromPoint(200, 215, rect, activationRatio), "top");
  assert.equal(resolvePaneDropEdgeFromPoint(200, 285, rect, activationRatio), "bottom");
  assert.equal(resolvePaneDropEdgeFromPoint(200, 250, rect, activationRatio), null);
  assert.equal(resolvePaneDropEdgeFromPoint(150, 250, rect, activationRatio), "left");
  assert.equal(resolvePaneDropEdgeFromPoint(185, 250, rect, activationRatio), null);
});

test("detaching Workspan sessions creates one top-level Workspan per Tab", () => {
  const workspan = {
    id: "source",
    paneTree: {
      type: "split",
      id: "root",
      direction: "horizontal",
      ratio: 0.5,
      first: { type: "leaf", id: "first-pane", sessionIds: ["a", "b"], activeSessionId: "b" },
      second: { type: "leaf", id: "second-pane", sessionIds: ["c"], activeSessionId: "c" },
    },
    activePaneId: "second-pane",
    activeSessionId: "c",
  };
  const detached = detachTerminalWorkspanSessions(workspan, idFactory("workspan"), idFactory("pane"));
  assert.deepEqual(detached.map((item) => collectWorkspanSessionIds(item)), [["a"], ["b"], ["c"]]);
  assert.deepEqual(detached.map((item) => item.paneTree.id), ["pane-1", "pane-2", "pane-3"]);
});

test("detaching one session preserves the source and honors top-level insertion", () => {
  const first = createTerminalWorkspan("first", "first-pane", "first-session");
  const source = {
    id: "source",
    customTitle: null,
    paneTree: {
      type: "leaf",
      id: "source-pane",
      sessionIds: ["source-session", "detached-session"],
      activeSessionId: "detached-session",
    },
    activePaneId: "source-pane",
    activeSessionId: "detached-session",
  };
  const last = createTerminalWorkspan("last", "last-pane", "last-session");
  const workspans = [first, source, last];

  const adjacent = detachTerminalSessionToWorkspan(workspans, "detached-session", idFactory("workspan"), idFactory("pane"));
  assert.equal(adjacent.changed, true);
  assert.deepEqual(adjacent.workspans.map((item) => item.id), ["first", "source", "workspan-1", "last"]);
  assert.deepEqual(collectWorkspanSessionIds(adjacent.workspans[1]), ["source-session"]);
  assert.deepEqual(collectWorkspanSessionIds(adjacent.workspans[2]), ["detached-session"]);

  const atStart = detachTerminalSessionToWorkspan(workspans, "detached-session", idFactory("start"), idFactory("pane"), 0);
  assert.deepEqual(atStart.workspans.map((item) => item.id), ["start-1", "first", "source", "last"]);

  const atEnd = detachTerminalSessionToWorkspan(workspans, "detached-session", idFactory("end"), idFactory("pane"), workspans.length);
  assert.deepEqual(atEnd.workspans.map((item) => item.id), ["first", "source", "last", "end-1"]);

  const single = [createTerminalWorkspan("single", "single-pane", "single-session")];
  const unchanged = detachTerminalSessionToWorkspan(single, "single-session", idFactory("noop"), idFactory("pane"));
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.workspans, single);
});

test("scoped pane filtering collapses visible layout without mutating the mounted pane tree", () => {
  const firstLeaf = { type: "leaf", id: "first-pane", sessionIds: ["project-a"], activeSessionId: "project-a" };
  const secondLeaf = { type: "leaf", id: "second-pane", sessionIds: ["project-b"], activeSessionId: "project-b" };
  const mountedTree = {
    type: "split",
    id: "root",
    direction: "horizontal",
    ratio: 0.5,
    first: firstLeaf,
    second: secondLeaf,
  };

  const projectAView = filterPaneTreeBySessionIds(mountedTree, new Set(["project-a"]));
  const projectBView = filterPaneTreeBySessionIds(mountedTree, new Set(["project-b"]));

  assert.deepEqual(collectPaneLeaves(projectAView).map((leaf) => leaf.id), ["first-pane"]);
  assert.deepEqual(collectPaneLeaves(projectBView).map((leaf) => leaf.id), ["second-pane"]);
  assert.deepEqual(collectPaneLeaves(mountedTree).map((leaf) => leaf.id), ["first-pane", "second-pane"]);
  assert.equal(mountedTree.first, firstLeaf);
  assert.equal(mountedTree.second, secondLeaf);
});

test("legacy collapse preserves the active layout and appends other workspans as tabs", () => {
  const first = createTerminalWorkspan("first", "first-pane", "first-session");
  const active = {
    id: "active",
    paneTree: {
      type: "split",
      id: "active-root",
      direction: "horizontal",
      ratio: 0.4,
      first: { type: "leaf", id: "active-left", sessionIds: ["left-a", "left-b"], activeSessionId: "left-b" },
      second: { type: "leaf", id: "active-right", sessionIds: ["right-a"], activeSessionId: "right-a" },
    },
    activePaneId: "active-left",
    activeSessionId: "left-b",
  };
  const last = createTerminalWorkspan("last", "last-pane", "last-session");

  const collapsed = collapseTerminalWorkspansToLegacy([first, active, last], "active", idFactory("legacy"));

  assert.equal(collapsed.length, 1);
  assert.equal(collapsed[0].id, "active");
  assert.equal(collapsed[0].paneTree.id, "active-root");
  assert.equal(collapsed[0].paneTree.direction, "horizontal");
  assert.deepEqual(collapsed[0].paneTree.first.sessionIds, ["left-a", "left-b", "first-session", "last-session"]);
  assert.deepEqual(collapsed[0].paneTree.second.sessionIds, ["right-a"]);
  assert.equal(collapsed[0].paneTree.first.activeSessionId, "left-b");
  assert.equal(collapsed[0].activePaneId, "active-left");
  assert.equal(collapsed[0].activeSessionId, "left-b");
  assert.deepEqual(
    collectWorkspanSessionIds(collapsed[0]),
    ["left-a", "left-b", "first-session", "last-session", "right-a"]
  );
});

test("legacy collapse handles empty and single workspan layouts", () => {
  assert.deepEqual(collapseTerminalWorkspansToLegacy([], null, idFactory()), []);

  const single = createTerminalWorkspan("single", "single-pane", "single-session");
  const collapsed = collapseTerminalWorkspansToLegacy([single], "single", idFactory());
  assert.equal(collapsed.length, 1);
  assert.deepEqual(collectWorkspanSessionIds(collapsed[0]), ["single-session"]);
  assert.equal(collapsed[0].activeSessionId, "single-session");
});

test("legacy collapse keeps duplicate session ownership only once", () => {
  const active = createTerminalWorkspan("active", "active-pane", "shared-session");
  const duplicate = {
    id: "duplicate",
    paneTree: { type: "leaf", id: "duplicate-pane", sessionIds: ["shared-session", "new-session"], activeSessionId: "new-session" },
    activePaneId: "duplicate-pane",
    activeSessionId: "new-session",
  };

  const collapsed = collapseTerminalWorkspansToLegacy([active, duplicate], "active", idFactory());
  assert.deepEqual(collectWorkspanSessionIds(collapsed[0]), ["shared-session", "new-session"]);
});

test("mergeTerminalWorkspansAtPaneEdge preserves sessions and honors all four edges", () => {
  const cases = [
    ["left", "horizontal", "source-pane"],
    ["right", "horizontal", "target-pane"],
    ["top", "vertical", "source-pane"],
    ["bottom", "vertical", "target-pane"],
  ];

  for (const [edge, direction, firstPaneId] of cases) {
    const source = createTerminalWorkspan("source", "source-pane", "source-session");
    const target = createTerminalWorkspan("target", "target-pane", "target-session");
    const result = mergeTerminalWorkspansAtPaneEdge(
      [source, target],
      source.id,
      target.id,
      "target-pane",
      edge,
      idFactory(edge)
    );

    assert.equal(result.changed, true);
    assert.equal(result.activeWorkspanId, "target");
    assert.equal(result.workspans.length, 1);
    assert.deepEqual(new Set(collectWorkspanSessionIds(result.workspans[0])), new Set(["source-session", "target-session"]));
    assert.equal(result.workspans[0].paneTree.type, "split");
    assert.equal(result.workspans[0].paneTree.direction, direction);
    assert.equal(result.workspans[0].paneTree.first.id, firstPaneId);
    assert.equal(result.workspans[0].activeSessionId, "source-session");
  }
});

test("merge inserts a complete source layout beside the hovered nested pane", () => {
  const source = {
    id: "source",
    paneTree: {
      type: "split",
      id: "source-root",
      direction: "horizontal",
      ratio: 0.4,
      first: { type: "leaf", id: "source-a", sessionIds: ["a"], activeSessionId: "a" },
      second: { type: "leaf", id: "source-b", sessionIds: ["b"], activeSessionId: "b" },
    },
    activePaneId: "source-b",
    activeSessionId: "b",
  };
  const target = {
    id: "target",
    paneTree: {
      type: "split",
      id: "target-root",
      direction: "horizontal",
      ratio: 0.5,
      first: { type: "leaf", id: "target-a", sessionIds: ["c"], activeSessionId: "c" },
      second: { type: "leaf", id: "target-b", sessionIds: ["d"], activeSessionId: "d" },
    },
    activePaneId: "target-a",
    activeSessionId: "c",
  };

  const result = mergeTerminalWorkspansAtPaneEdge(
    [source, target],
    "source",
    "target",
    "target-b",
    "top",
    idFactory("nested")
  );

  assert.equal(result.changed, true);
  const tree = result.workspans[0].paneTree;
  assert.equal(tree.type, "split");
  assert.equal(tree.id, "target-root");
  assert.equal(tree.first.id, "target-a");
  assert.equal(tree.second.type, "split");
  assert.equal(tree.second.direction, "vertical");
  assert.equal(tree.second.first.id, "source-root");
  assert.equal(tree.second.second.id, "target-b");
});

test("merge rejects duplicate session ownership", () => {
  const source = createTerminalWorkspan("source", "source-pane", "same-session");
  const target = createTerminalWorkspan("target", "target-pane", "same-session");
  const result = mergeTerminalWorkspansAtPaneEdge(
    [source, target],
    "source",
    "target",
    "target-pane",
    "right",
    idFactory()
  );
  assert.equal(result.changed, false);
  assert.equal(result.workspans.length, 2);
});

test("migration validates compound workspan data", () => {
  const migrated = migrateTerminalWorkspans([
    {
      id: "valid",
      customTitle: "  Focus Mode  ",
      paneTree: {
        type: "split",
        id: "root",
        direction: "invalid-direction",
        ratio: 9,
        first: { type: "leaf", id: "left", sessionIds: ["a", "a"], activeSessionId: "missing" },
        second: { type: "leaf", id: "right", sessionIds: ["b"], activeSessionId: "b" },
      },
      activePaneId: "missing-pane",
      activeSessionId: "missing-session",
    },
    { id: "invalid", paneTree: null },
  ]);

  assert.equal(migrated.length, 1);
  assert.equal(migrated[0].paneTree.type, "split");
  assert.equal(migrated[0].paneTree.direction, "horizontal");
  assert.equal(migrated[0].paneTree.ratio, 0.8);
  assert.deepEqual(collectWorkspanSessionIds(migrated[0]), ["a", "b"]);
  assert.equal(migrated[0].activeSessionId, "a");
  assert.equal(migrated[0].customTitle, "Focus Mode");
});

test("workspan titles default to null and blank persisted titles are cleared", () => {
  assert.equal(createTerminalWorkspan("new", "pane", "session").customTitle, null);

  const [migrated] = migrateTerminalWorkspans([{
    id: "blank-title",
    customTitle: "   ",
    paneTree: { type: "leaf", id: "pane", sessionIds: ["session"], activeSessionId: "session" },
    activePaneId: "pane",
    activeSessionId: "session",
  }]);

  assert.equal(migrated.customTitle, null);
});

test("sanitize and restore remove invalid or duplicate membership", () => {
  const workspans = [
    createTerminalWorkspan("first", "first-pane", "old-a"),
    {
      id: "second",
      customTitle: "Restored",
      paneTree: { type: "leaf", id: "second-pane", sessionIds: ["old-a", "old-b"], activeSessionId: "old-b" },
      activePaneId: "second-pane",
      activeSessionId: "old-b",
    },
  ];
  const restored = restoreTerminalWorkspans(workspans, { "old-a": "new-a", "old-b": "new-b" });
  const sanitized = sanitizeTerminalWorkspans(restored, new Set(["new-a", "new-b"]));

  assert.deepEqual(collectWorkspanSessionIds(sanitized[0]), ["new-a"]);
  assert.deepEqual(collectWorkspanSessionIds(sanitized[1]), ["new-b"]);
  assert.equal(sanitized[1].activeSessionId, "new-b");
  assert.equal(sanitized[1].customTitle, "Restored");
});

test("sanitize keeps each session in only one pane", () => {
  const workspans = [{
    id: "duplicate-layout",
    paneTree: {
      type: "split",
      id: "root",
      direction: "horizontal",
      ratio: 0.5,
      first: { type: "leaf", id: "first-pane", sessionIds: ["a", "b"], activeSessionId: "b" },
      second: { type: "leaf", id: "second-pane", sessionIds: ["b", "c"], activeSessionId: "b" },
    },
    activePaneId: "second-pane",
    activeSessionId: "b",
  }];

  const sanitized = sanitizeTerminalWorkspans(workspans, new Set(["a", "b", "c"]));

  assert.deepEqual(collectWorkspanSessionIds(sanitized[0]), ["a", "b", "c"]);
  assert.deepEqual(sanitized[0].paneTree.second.sessionIds, ["c"]);
  assert.equal(sanitized[0].activeSessionId, "b");
  assert.equal(sanitized[0].activePaneId, "first-pane");
});

test("remove and reorder keep top-level workspan behavior deterministic", () => {
  const first = createTerminalWorkspan("first", "first-pane", "first-session");
  const second = createTerminalWorkspan("second", "second-pane", "second-session");
  const reordered = reorderTerminalWorkspans([first, second], "second", "first");
  assert.deepEqual(reordered.map((workspan) => workspan.id), ["second", "first"]);
  assert.deepEqual(removeSessionFromTerminalWorkspans(reordered, "second-session").map((workspan) => workspan.id), ["first"]);
});

test("side-button navigation falls back to adjacent workspans", () => {
  const workspans = [
    createTerminalWorkspan("first", "first-pane", "first-session"),
    createTerminalWorkspan("second", "second-pane", "second-session"),
    createTerminalWorkspan("third", "third-pane", "third-session"),
  ];

  assert.equal(getAdjacentWorkspanSessionId(workspans, "second", 1), "third-session");
  assert.equal(getAdjacentWorkspanSessionId(workspans, "second", -1), "first-session");
  assert.equal(getAdjacentWorkspanSessionId(workspans, "first", -1), "third-session");
  assert.equal(getAdjacentWorkspanSessionId(workspans, "third", 1), "first-session");
  assert.equal(getAdjacentWorkspanSessionId(workspans, "missing", 1), "first-session");
  assert.equal(getAdjacentWorkspanSessionId(workspans, "missing", -1), "third-session");
});
