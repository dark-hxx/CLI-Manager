import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const facade = read("../src/features/git/api/DiffViewerModal.tsx");
const controller = read("../src/features/git/components/diff/useGitDiffController.ts");
const viewer = read("../src/features/git/components/diff/GitDiffViewer.tsx");
const types = read("../src/features/git/components/diff/types.ts");

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
    read("../src/features/git/components/diff/GitDiffContent.tsx"),
    read("../src/features/git/components/diff/GitDiffHeader.tsx"),
    read("../src/features/git/components/diff/GitDiffSelectionBar.tsx"),
    read("../src/features/git/components/diff/GitDiffToolbar.tsx"),
    read("../src/features/git/components/diff/GitDiffDialogFrame.tsx"),
    read("../src/features/git/components/diff/GitDiffReviewDialog.tsx"),
    read("../src/features/git/components/diff/reviewNavigation.ts"),
    read("../src/features/git/components/diff/gitDiffSelection.ts"),
    read("../src/features/git/components/diff/GitDiffGutter.tsx"),
    read("../src/features/git/components/diff/gitDiffParser.ts"),
    read("../src/features/git/components/diff/gitDiffParser.worker.ts"),
    read("../src/features/git/components/diff/useGitDiffParser.ts"),
    read("../src/features/git/components/diff/gitDiffVirtualization.ts"),
    read("../src/features/git/components/diff/GitDiffHunkBlock.tsx"),
    read("../src/features/git/components/diff/GitDiffHunkList.tsx"),
    read("../src/features/git/components/diff/useGitDiffOpenWorkflow.ts"),
    read("../src/features/git/components/diff/useGitDiffHorizontalScroll.ts"),
  ];
  for (const source of modules) {
    assert.ok(source.split(/\r?\n/).length <= 300);
  }
});
