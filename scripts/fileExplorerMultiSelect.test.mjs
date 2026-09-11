import test from "node:test";
import assert from "node:assert/strict";
import {
  selectFileEntries, fileActionEntries, filePathContains, fileOperationRootKey,
  normalizeFileOperationEntries, runFileOperationBatch,
} from "../src/features/files/lib/fileExplorerOperations.ts";

const file = (path, kind = "file") => ({ path, name: path.split("/").pop(), kind });
const a = file("a.txt"), b = file("b.txt"), c = file("c.txt");
async function batch(entries, overrides = {}) {
  const calls = [];
  const result = await runFileOperationBatch({
    entries, mode: "move", targetParentPath: "dest", shouldContinue: () => true,
    guard: () => {}, execute: async (entry) => { calls.push(entry.path); }, onSuccess: () => {}, ...overrides,
  });
  return { result, calls };
}

test("Ctrl selection toggles immutably; normal click replaces selection", () => {
  const selected = [a];
  assert.deepEqual(selectFileEntries(selected, b, true), [a, b]);
  assert.deepEqual(selected, [a]);
  assert.deepEqual(selectFileEntries([a, b], a, true), [b]);
  assert.deepEqual(selectFileEntries([a], a, true), []);
  assert.deepEqual(selectFileEntries([a, b], c, false), [c]);
});

test("right click / dragging a selected entry preserves the selection", () => {
  const selected = [a, b];
  assert.equal(fileActionEntries(selected, a), selected);
  assert.deepEqual(fileActionEntries(selected, c), [c]);
});

test("parent-child and duplicate selection normalization respects path boundaries and case", () => {
  const parent = file("src", "directory"), child = file("src/a.txt"), sibling = file("src-other/b.txt");
  assert.deepEqual(normalizeFileOperationEntries([child, parent, parent, sibling]), [parent, sibling]);
  assert.deepEqual(normalizeFileOperationEntries([file("SRC", "directory"), child], true), [file("SRC", "directory")]);
  assert.equal(normalizeFileOperationEntries([file("SRC", "directory"), child], false).length, 2);
  assert.equal(filePathContains("src", "src-other/a"), false);
});

test("operation root identity is case-insensitive only on native Windows/UNC", () => {
  assert.equal(fileOperationRootKey("E:\\Repo\\"), fileOperationRootKey("e:/repo"));
  assert.equal(fileOperationRootKey("\\\\server\\Share"), fileOperationRootKey("//SERVER/share/"));
  assert.notEqual(fileOperationRootKey("\\\\wsl.localhost\\Ubuntu\\repo\\A"), fileOperationRootKey("\\\\wsl.localhost\\Ubuntu\\repo\\a"));
  assert.notEqual(fileOperationRootKey("/home/A"), fileOperationRootKey("/home/a"));
});

test("a mixed batch records successes, conflicts and failures and continues", async () => {
  const { result } = await batch([a, b, c], { execute: async (entry) => {
    if (entry === b) throw new Error("target_exists");
    if (entry === c) throw new Error("access_denied");
  } });
  assert.deepEqual(result.succeeded, [a]);
  assert.deepEqual(result.conflicts, [b]);
  assert.equal(result.failures[0].entry, c);
});

test("same-parent move skips without IPC, while copy to itself never overwrites", async () => {
  const moved = await batch([a], { targetParentPath: "" });
  assert.deepEqual(moved.calls, []);
  assert.deepEqual(moved.result.skipped, [a]);
  const copied = await batch([a], { mode: "copy", targetParentPath: "" });
  assert.deepEqual(copied.calls, []);
  assert.match(copied.result.failures[0].error, /source_equals_target/);
});

test("root, link and self-descendant operations are rejected before IPC", async () => {
  for (const [entry, options, code] of [
    [file(""), { mode: "delete" }, "cannot_modify_root"],
    [{ ...a, isSymlink: true }, {}, "path_is_symlink"],
    [file("src", "directory"), { targetParentPath: "src/child" }, "target_inside_source"],
  ]) {
    const { calls, result } = await batch([entry], options);
    assert.equal(calls.length, 0);
    assert.ok(result.failures[0].error.includes(code));
  }
});

test("same named sources are all rejected; no source silently wins", async () => {
  const { result, calls } = await batch([file("one/a.txt"), file("two/a.txt")]);
  assert.equal(calls.length, 0);
  assert.equal(result.failures.length, 2);
  assert.ok(result.failures.every((failure) => failure.error.includes("batch_duplicate_target")));
});

test("batch targets cannot overwrite another pending source or an ancestor of the source", async () => {
  const { calls, result } = await batch([file("one/item"), file("dest/item/keep.txt")]);
  assert.deepEqual(calls, ["dest/item/keep.txt"]);
  assert.match(result.failures[0].error, /target_overlaps_selection/);
  const ancestor = await batch([file("nested/nested")], { targetParentPath: "" });
  assert.equal(ancestor.calls.length, 0);
});

test("switching context cancels every remaining entry", async () => {
  let current = true;
  const { result, calls } = await batch([a, b, c], {
    shouldContinue: () => current,
    onSuccess: () => { current = false; },
  });
  assert.deepEqual(calls, [a.path]);
  assert.equal(result.failures.length, 2);
  assert.ok(result.failures.every((failure) => failure.error.includes("context_changed")));
});

test("dirty guard runs for every item and does not execute protected entries", async () => {
  const { result, calls } = await batch([a, b], { guard: (entry) => {
    if (entry === a) throw new Error("file_operation_unsaved");
  } });
  assert.deepEqual(calls, [b.path]);
  assert.equal(result.failures.length, 1);
});

test("a conflict retry executes only the explicit conflict snapshot", async () => {
  const first = await batch([a, b], { execute: async (entry) => {
    if (entry === b) throw new Error("target_exists");
  } });
  const retry = await batch(first.result.conflicts);
  assert.deepEqual(retry.calls, [b.path]);
});
