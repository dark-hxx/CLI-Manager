import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const fileStore = read("../src/stores/fileExplorerStore.ts");
const gitCommands = read("../src-tauri/src/commands/git.rs");

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `missing source range: ${startMarker}`);
  return source.slice(start, end);
}

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

test("manual refresh clears the non-Git cache before refreshing", () => {
  const refresh = sliceBetween(fileStore, "  refresh: async () => {", "  refreshVisibleState:");

  assert.match(refresh, /nonGitProjectPaths\.delete\(normalizeGitProjectPath\(project\.path\)\)/);
  assert.match(refresh, /await get\(\)\.refreshVisibleState\(\)/);
});

test("late Git results cannot overwrite a different project", () => {
  const refreshGitChanges = sliceBetween(
    fileStore,
    "  refreshGitChanges: async () => {",
    "  loadDir:",
  );

  assert.match(refreshGitChanges, /isSameProjectFileLocation\(get\(\)\.project, project\)/);
  assert.match(refreshGitChanges, /set\(\{ gitChanges \}\)/);
});

test("WSL Git and realpath subprocesses use the bounded runner", () => {
  const runWslGit = sliceBetween(gitCommands, "pub(super) fn run_wsl_git", "pub(super) fn resolve_wsl_mnt");
  const resolveRealpath = sliceBetween(
    gitCommands,
    "fn resolve_wsl_linux_realpath",
    "fn build_wsl_git_command_args",
  );

  assert.match(runWslGit, /output_with_timeout\(cmd, WSL_GIT_COMMAND_TIMEOUT\)/);
  assert.match(runWslGit, /"wsl_git_timeout"/);
  assert.match(resolveRealpath, /output_with_timeout\(command, WSL_GIT_COMMAND_TIMEOUT\)/);
});
