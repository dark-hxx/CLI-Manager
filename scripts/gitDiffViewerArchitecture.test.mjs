import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const facade = read("../src/components/git/DiffViewerModal.tsx");
const controller = read("../src/components/git/diff/useGitDiffController.ts");
const viewer = read("../src/components/git/diff/GitDiffViewer.tsx");
const types = read("../src/components/git/diff/types.ts");

test("Git diff view layer has no direct Tauri or SSH dependency", () => {
  for (const source of [facade, controller, viewer]) {
    assert.doesNotMatch(source, /@tauri-apps\/api\/core/);
    assert.doesNotMatch(source, /sshRemoteGit|environment_type/);
  }
});

test("snapshot source cannot contain mutation actions", () => {
  const snapshotStart = types.indexOf("export interface GitDiffSnapshotDataSource");
  const liveStart = types.indexOf("export interface GitDiffLiveDataSource");
  assert.ok(snapshotStart >= 0 && liveStart > snapshotStart);
  const snapshot = types.slice(snapshotStart, liveStart);
  assert.match(snapshot, /kind: "snapshot"/);
  assert.doesNotMatch(snapshot, /mutations|revert|discard/);
});

test("Git diff modules stay split by responsibility", () => {
  const modules = [
    facade,
    controller,
    viewer,
    read("../src/components/git/diff/GitDiffContent.tsx"),
    read("../src/components/git/diff/GitDiffHeader.tsx"),
    read("../src/components/git/diff/GitDiffSelectionBar.tsx"),
    read("../src/components/git/diff/GitDiffToolbar.tsx"),
    read("../src/components/git/diff/GitDiffDialogFrame.tsx"),
    read("../src/components/git/diff/GitDiffReviewDialog.tsx"),
    read("../src/components/git/diff/reviewNavigation.ts"),
    read("../src/components/git/diff/gitDiffSelection.ts"),
    read("../src/components/git/diff/GitDiffGutter.tsx"),
    read("../src/components/git/diff/gitDiffParser.ts"),
    read("../src/components/git/diff/gitDiffParser.worker.ts"),
    read("../src/components/git/diff/useGitDiffParser.ts"),
    read("../src/components/git/diff/gitDiffVirtualization.ts"),
    read("../src/components/git/diff/GitDiffHunkBlock.tsx"),
    read("../src/components/git/diff/GitDiffHunkList.tsx"),
    read("../src/components/git/diff/useGitDiffOpenWorkflow.ts"),
    read("../src/components/git/diff/useGitDiffHorizontalScroll.ts"),
  ];
  for (const source of modules) {
    assert.ok(source.split(/\r?\n/).length <= 300);
  }
});
