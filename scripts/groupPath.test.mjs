import test from "node:test";
import assert from "node:assert/strict";
import {
  collectGroupSubtreeIds,
  findInheritedDescendants,
  resolveGroupBoundPath,
  resolveProjectPath,
} from "../src/lib/groupPath.ts";

const groups = [
  { id: "root", parent_id: null, bound_path: "D:/root" },
  { id: "child", parent_id: "root", bound_path: "" },
  { id: "deep", parent_id: "child", bound_path: "" },
  { id: "boundary", parent_id: "child", bound_path: "D:/other" },
  { id: "boundary-child", parent_id: "boundary", bound_path: "" },
  { id: "unrelated", parent_id: null, bound_path: "D:/unrelated" },
];

const project = (id, group_id, path_mode = "inherit", path = "D:/stale") => ({
  id,
  group_id,
  path_mode,
  path,
});

test("resolves inherited projects from the nearest bound ancestor", () => {
  assert.equal(resolveGroupBoundPath(groups, "deep"), "D:/root");
  assert.equal(resolveGroupBoundPath(groups, "boundary-child"), "D:/other");
  assert.equal(resolveProjectPath(project("p", "deep"), groups), "D:/root");
  assert.equal(resolveProjectPath(project("p", "boundary-child"), groups), "D:/other");
  assert.equal(resolveProjectPath(project("p", "deep", "custom", "D:/custom"), groups), "D:/custom");
});

test("collects only the selected group subtree", () => {
  assert.deepEqual(
    [...collectGroupSubtreeIds("root", groups)].sort(),
    ["boundary", "boundary-child", "child", "deep", "root"],
  );
});

test("finds direct projects and stops at explicit descendant bindings", () => {
  const descendants = findInheritedDescendants("root", groups, [
    project("direct", "root"),
    project("child-project", "child"),
    project("deep-project", "deep"),
    project("boundary-project", "boundary"),
    project("boundary-child-project", "boundary-child"),
    project("custom-project", "child", "custom", "D:/custom"),
    project("ungrouped", null),
  ]);

  assert.deepEqual(descendants.groupIds.sort(), ["child", "deep"]);
  assert.deepEqual(descendants.projectIds.sort(), ["child-project", "deep-project", "direct"]);
});
