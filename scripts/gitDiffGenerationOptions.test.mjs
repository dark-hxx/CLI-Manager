import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("local and SSH transports share the same optional Diff contract", () => {
  const transport = read("../src/lib/gitTransport.ts");
  const remote = read("../src/lib/sshRemoteGit.ts");

  assert.match(transport, /getFileDiff\([^)]*options\?: GitDiffOptions/);
  assert.match(transport, /git_get_file_diff[\s\S]*options,/);
  assert.match(remote, /useLegacyRequest = isDefaultGitDiffOptions\(options\)/);
  assert.match(remote, /useLegacyRequest\s*\? \{ repoPath, relativePath, status \}/);
  assert.match(remote, /: \{ repoPath, relativePath, status, options \}/);
});

test("review and pinned viewers load through persisted Diff options", () => {
  const review = read("../src/components/git/diff/GitDiffReviewDialog.tsx");
  const pinned = read("../src/components/git/diff/GitDiffEditorHost.tsx");

  for (const source of [review, pinned]) {
    assert.match(source, /gitDiffWhitespaceMode/);
    assert.match(source, /gitDiffContextLines/);
    assert.match(source, /diffOptions/);
  }
});

test("file decorations keep the default Diff request", () => {
  const decorations = read("../src/components/files/useGitFileDecorations.ts");
  assert.match(decorations, /getFileDiff\(repositoryId, filePath, change\.status\)/);
});

test("partial revert callbacks enforce the backend Diff capability", () => {
  const controller = read("../src/components/git/diff/useGitDiffController.ts");

  assert.match(controller, /if \(!canRevertHunks \|\| !mutations\?\.revertHunk\) return/);
  assert.match(controller, /if \(!canRevertLines \|\| !mutations\?\.revertLines\) return/);
});
