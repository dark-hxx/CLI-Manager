import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGitDiffReviewTargets,
  reconcileReviewTargetIndex,
  stepReviewNavigation,
} from "../src/components/git/diff/reviewNavigation.ts";

const file = (path, status, added = 1, deleted = 0) => ({
  type: "file",
  name: path.split("/").at(-1),
  path,
  change: { path, status, staged: false, added, deleted },
});

test("review targets follow the rendered tracked then untracked tree order", () => {
  const targets = buildGitDiffReviewTargets({
    tree: [
      { type: "directory", name: "src", path: "src", children: [
        file("src/a.ts", "M", 3, 1),
        file("src/b.ts", "A", 2, 0),
      ] },
    ],
    untrackedTree: [file("notes/new.md", "??")],
    statusFilter: "all",
    repositoryPath: "C:\\repo\\nested",
    repositoryRelativePath: "packages/nested",
  });

  assert.deepEqual(targets.map((target) => target.filePath), [
    "src/a.ts",
    "src/b.ts",
    "notes/new.md",
  ]);
  assert.equal(targets[0].sourcePath, "packages/nested/src/a.ts");
  assert.equal(targets[0].id, "C:/repo/nested\u0000src/a.ts");
  assert.deepEqual([targets[0].additions, targets[0].deletions], [3, 1]);
});

test("modified and deleted filters exclude untracked targets like the panel", () => {
  for (const statusFilter of ["M", "D"]) {
    const targets = buildGitDiffReviewTargets({
      tree: [file("tracked.ts", statusFilter)],
      untrackedTree: [file("untracked.ts", "??")],
      statusFilter,
      repositoryPath: "/repo",
    });
    assert.deepEqual(targets.map((target) => target.filePath), ["tracked.ts"]);
  }
});

test("repository-root identities remain distinct on POSIX and Windows", () => {
  const buildId = (repositoryPath) => buildGitDiffReviewTargets({
    tree: [file("a.ts", "M")],
    untrackedTree: [],
    statusFilter: "all",
    repositoryPath,
  })[0].id;

  assert.equal(buildId("/"), "/\u0000a.ts");
  assert.equal(buildId("C:\\"), "C:/\u0000a.ts");
});

test("target reconciliation preserves identity and otherwise selects the adjacent index", () => {
  const targets = buildGitDiffReviewTargets({
    tree: [file("a.ts", "M"), file("c.ts", "M")],
    untrackedTree: [],
    statusFilter: "all",
    repositoryPath: "/repo",
  });
  assert.equal(reconcileReviewTargetIndex(targets, targets[1].id, 0), 1);
  assert.equal(reconcileReviewTargetIndex(targets, "/repo\u0000b.ts", 1), 1);
  assert.equal(reconcileReviewTargetIndex(targets, "/repo\u0000z.ts", 8), 1);
  assert.equal(reconcileReviewTargetIndex([], targets[0].id, 0), -1);
});

test("navigation crosses hunk and file boundaries without wrapping", () => {
  assert.deepEqual(
    stepReviewNavigation("next", { targetIndex: 0, hunkIndex: 0 }, 2, 2),
    { targetIndex: 0, hunkIndex: 1 },
  );
  assert.deepEqual(
    stepReviewNavigation("next", { targetIndex: 0, hunkIndex: 1 }, 2, 2),
    { targetIndex: 1, hunkIndex: 0, placement: "first" },
  );
  assert.deepEqual(
    stepReviewNavigation("previous", { targetIndex: 1, hunkIndex: 0 }, 2, 3),
    { targetIndex: 0, hunkIndex: 0, placement: "last" },
  );
  assert.equal(stepReviewNavigation("previous", { targetIndex: 0, hunkIndex: 0 }, 2, 2), null);
  assert.equal(stepReviewNavigation("next", { targetIndex: 1, hunkIndex: 1 }, 2, 2), null);
});

test("fallback diffs with no hunks still participate in file navigation", () => {
  assert.deepEqual(
    stepReviewNavigation("next", { targetIndex: 0, hunkIndex: 0 }, 2, 0),
    { targetIndex: 1, hunkIndex: 0, placement: "first" },
  );
});
