import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 按相对路径读取差异传输及界面源码。
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

// 验证本地与 SSH 传输共享可选差异参数契约并兼容旧请求。
test("local and SSH transports share the same optional Diff contract", () => {
  const transport = read("../src/features/git/lib/gitTransport.ts");
  const remote = read("../src/features/remote/api/sshRemoteGit.ts");

  assert.match(transport, /getFileDiff\([^)]*options\?: GitDiffOptions/);
  assert.match(transport, /git_get_file_diff[\s\S]*options,/);
  assert.match(remote, /useLegacyRequest = isDefaultGitDiffOptions\(options\)/);
  assert.match(remote, /useLegacyRequest\s*\? \{ repoPath, relativePath, status \}/);
  assert.match(remote, /: \{ repoPath, relativePath, status, options \}/);
});

// 验证审查与固定视图通过持久化差异选项加载。
test("review and pinned viewers load through persisted Diff options", () => {
  const review = read("../src/features/git/components/diff/GitDiffReviewDialog.tsx");
  const pinned = read("../src/features/git/api/GitDiffEditorHost.tsx");

  for (const source of [review, pinned]) {
    assert.match(source, /gitDiffWhitespaceMode/);
    assert.match(source, /gitDiffContextLines/);
    assert.match(source, /diffOptions/);
  }
});

// 验证文件装饰保持默认差异请求。
test("file decorations keep the default Diff request", () => {
  const decorations = read("../src/features/files/components/useGitFileDecorations.ts");
  assert.match(decorations, /getFileDiff\(repositoryId, filePath, change\.status\)/);
});

// 验证局部回退回调遵守后端返回的差异能力。
test("partial revert callbacks enforce the backend Diff capability", () => {
  const controller = read("../src/features/git/components/diff/useGitDiffController.ts");

  assert.match(controller, /if \(!canRevertHunks \|\| !mutations\?\.revertHunk\) return/);
  assert.match(controller, /if \(!canRevertLines \|\| !mutations\?\.revertLines\) return/);
});
