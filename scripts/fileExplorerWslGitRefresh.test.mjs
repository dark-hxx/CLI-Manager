import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 按测试文件相对路径读取源码供静态契约断言使用。
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const fileStore = read("../src/features/files/api/fileExplorerStore.ts");
const gitCommands = read("../src-tauri/src/features/git/wsl.rs");

// 断言起止标记存在并提取两者之间的源码片段。
function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `missing source range: ${startMarker}`);
  return source.slice(start, end);
}

// 验证自动刷新停止轮询已确认的非 Git 项目。
test("automatic refresh stops polling a confirmed non-Git project", () => {
  const fetchGitChanges = sliceBetween(
    fileStore,
    "async function fetchGitChanges",
    "function isSameOrChildPath",
  );

  assert.match(fetchGitChanges, /nonGitProjectPaths\.has\(projectKey\)/);
  assert.match(fetchGitChanges, /errorHasCode\(error, "not_git_repository"\)/);
  assert.match(fetchGitChanges, /nonGitProjectPaths\.add\(projectKey\)/);
});

// 验证手动刷新先清除非 Git 缓存再加载可见状态。
test("manual refresh clears the non-Git cache before refreshing", () => {
  const refresh = sliceBetween(fileStore, "  refresh: async () => {", "  refreshVisibleState:");

  assert.match(refresh, /nonGitProjectPaths\.delete\(normalizeGitProjectPath\(project\.path\)\)/);
  assert.match(refresh, /await get\(\)\.refreshVisibleState\(\)/);
});

// 验证迟到的 Git 结果不能覆盖已切换的项目。
test("late Git results cannot overwrite a different project", () => {
  const refreshGitChanges = sliceBetween(
    fileStore,
    "  refreshGitChanges: async () => {",
    "  loadDir:",
  );

  assert.match(refreshGitChanges, /isSameProjectFileLocation\(get\(\)\.project, project\)/);
  assert.match(refreshGitChanges, /set\(\{ gitChanges \}\)/);
});

// 验证 WSL Git 及 realpath 子进程使用有时限的执行器。
test("WSL Git and realpath subprocesses use the bounded runner", () => {
  const runWslGit = sliceBetween(gitCommands, "fn run_wsl_git", "fn resolve_wsl_mnt");
  const resolveRealpath = sliceBetween(
    gitCommands,
    "fn resolve_wsl_linux_realpath",
    "fn build_wsl_git_command_args",
  );

  assert.match(runWslGit, /output_with_timeout\(cmd, WSL_GIT_COMMAND_TIMEOUT\)/);
  assert.match(runWslGit, /"wsl_git_timeout"/);
  assert.match(resolveRealpath, /output_with_timeout\(command, WSL_GIT_COMMAND_TIMEOUT\)/);
});
