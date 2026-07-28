import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  applyGitDiffSelection,
  createGitDiffSelectionOrder,
  createGitDiffSelectionState,
  findAdjacentGitDiffChange,
} from "../src/components/git/diff/gitDiffSelection.ts";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const selected = (state) => [...state.selectedKeys].sort();

test("single selection toggles and records an anchor", () => {
  const order = createGitDiffSelectionOrder([{ key: "D1", side: "old", hunkIndex: 0 }]);
  const first = applyGitDiffSelection(createGitDiffSelectionState(), {
    target: order.changes[0],
    order,
    scope: "old",
    extend: false,
  });
  assert.deepEqual(selected(first), ["D1"]);
  assert.deepEqual(first.anchors.old, order.changes[0]);

  const second = applyGitDiffSelection(first, {
    target: order.changes[0],
    order,
    scope: "old",
    extend: false,
  });
  assert.deepEqual(selected(second), []);
});

test("split ranges keep old and new anchors independent", () => {
  const oldOrder = createGitDiffSelectionOrder([
    { key: "D1", side: "old", hunkIndex: 0 },
    { key: "D3", side: "old", hunkIndex: 1 },
    { key: "D5", side: "old", hunkIndex: 2 },
  ]);
  const newOrder = createGitDiffSelectionOrder([
    { key: "I2", side: "new", hunkIndex: 0 },
    { key: "I4", side: "new", hunkIndex: 1 },
  ]);
  let state = applyGitDiffSelection(createGitDiffSelectionState(), {
    target: newOrder.changes[0], order: newOrder, scope: "new", extend: false,
  });
  state = applyGitDiffSelection(state, {
    target: oldOrder.changes[0], order: oldOrder, scope: "old", extend: false,
  });
  state = applyGitDiffSelection(state, {
    target: oldOrder.changes[2], order: oldOrder, scope: "old", extend: true,
  });

  assert.deepEqual(selected(state), ["D1", "D3", "D5", "I2"]);
  assert.equal(state.anchors.new?.key, "I2");
  assert.equal(state.anchors.old?.key, "D1");
});

test("unified range skips the opposite side and resets on a cross-side anchor", () => {
  const order = createGitDiffSelectionOrder([
    { key: "D1", side: "old", hunkIndex: 0 },
    { key: "I1", side: "new", hunkIndex: 0 },
    { key: "D2", side: "old", hunkIndex: 1 },
  ]);
  let state = applyGitDiffSelection(createGitDiffSelectionState(), {
    target: order.changes[0], order, scope: "unified", extend: false,
  });
  state = applyGitDiffSelection(state, {
    target: order.changes[2], order, scope: "unified", extend: true,
  });
  assert.deepEqual(selected(state), ["D1", "D2"]);

  state = applyGitDiffSelection(state, {
    target: order.changes[1], order, scope: "unified", extend: true,
  });
  assert.deepEqual(selected(state), ["I1"]);
  assert.equal(state.anchors.unified?.side, "new");
});

test("keyboard adjacency follows visible order on the same side", () => {
  const order = createGitDiffSelectionOrder([
    { key: "D1", side: "old", hunkIndex: 0 },
    { key: "I1", side: "new", hunkIndex: 0 },
    { key: "D2", side: "old", hunkIndex: 1 },
  ]);
  assert.equal(findAdjacentGitDiffChange(order, "D1", "old", 1)?.key, "D2");
  assert.equal(findAdjacentGitDiffChange(order, "D2", "old", -1)?.key, "D1");
  assert.equal(findAdjacentGitDiffChange(order, "I1", "new", 1), null);
});

test("gutter and selection status expose keyboard and non-color semantics", () => {
  const gutter = read("../src/components/git/diff/GitDiffGutter.tsx");
  const hunkList = read("../src/components/git/diff/GitDiffHunkList.tsx");
  const selectionBar = read("../src/components/git/diff/GitDiffSelectionBar.tsx");

  assert.match(gutter, /aria-pressed=\{selected\}/);
  assert.match(gutter, /git-diff-gutter-marker/);
  assert.match(gutter, /<Check/);
  assert.match(hunkList, /event\.key === "Enter" \|\| event\.key === " "/);
  assert.match(hunkList, /"ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"/);
  assert.match(selectionBar, /role="status"/);
  assert.match(selectionBar, /aria-live="polite"/);
});

test("Diff dialog uses Radix focus management without a global Escape listener", () => {
  const frame = read("../src/components/git/diff/GitDiffDialogFrame.tsx");

  assert.match(frame, /<Dialog open=\{open\}/);
  assert.match(frame, /onOpenAutoFocus/);
  assert.match(frame, /onCloseAutoFocus/);
  assert.match(frame, /event\.isComposing/);
  assert.match(frame, /data-git-diff-toolbar/);
  assert.doesNotMatch(frame, /window\.addEventListener/);
});
