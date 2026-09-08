import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/features/git/store/gitStore.ts", import.meta.url), "utf8");
const terminalTabsSource = readFileSync(new URL("../src/features/terminal/hooks/useTerminalTabsController.tsx", import.meta.url), "utf8");
const gitPanelSource = readFileSync(new URL("../src/features/git/api/GitChangesPanel.tsx", import.meta.url), "utf8");
const fileStoreSource = readFileSync(new URL("../src/features/files/api/fileExplorerStore.ts", import.meta.url), "utf8");
const filePanelSource = readFileSync(new URL("../src/features/files/api/FileExplorerSidebar.tsx", import.meta.url), "utf8");
const terminalProjectSource = readFileSync(new URL("../src/features/terminal/api/terminalProject.ts", import.meta.url), "utf8");
const sshAgentManifestSource = readFileSync(new URL("../src-tauri/ssh-agent/Cargo.toml", import.meta.url), "utf8");

// 验证远程根仓库允许删除未跟踪文件。
test("remote root repository permits deleting untracked files", () => {
  const actionStart = source.indexOf("deleteUntrackedPaths: async");
  const actionEnd = source.indexOf("loadFileDiff: async", actionStart);
  assert.ok(actionStart >= 0 && actionEnd > actionStart);

  const action = source.slice(actionStart, actionEnd);
  assert.match(action, /repoPath === null/);
  assert.doesNotMatch(action, /!repoPath/);
});

// 验证 SSH 终端面板使用注册的远程项目根。
test("SSH terminal panels use the registered remote project root", () => {
  assert.match(
    terminalTabsSource,
    /panelProject\?\.environment_type === "ssh"\s*\? panelProject\.remote_path\.trim\(\) \|\| null/,
  );
});

// 验证 SSH 可见文件刷新不会降级调用本地文件命令。
test("SSH visible-file refresh never falls back to local file commands", () => {
  const refreshStart = fileStoreSource.indexOf("refreshVisibleStateOnce: async");
  const refreshEnd = fileStoreSource.indexOf("refreshGitChanges: async", refreshStart);
  assert.ok(refreshStart >= 0 && refreshEnd > refreshStart);

  const refresh = fileStoreSource.slice(refreshStart, refreshEnd);
  assert.match(refresh, /project\.environment_type === "ssh" && !remoteFileContext/);
  assert.match(refresh, /loadProjectFile\(project, latestEntry, remoteFileContext, options\)/);
});

// 验证远程项目初次加载上下文时显示加载状态。
test("remote project panels show loading during initial context fetch", () => {
  assert.match(gitPanelSource, /\(contextLoading \|\| loading\) && changes\.length === 0/);
  assert.match(filePanelSource, /loading && tree\.length === 0/);
  assert.match(filePanelSource, /t\("common\.loading"\)/);
});

// 验证 SSH 文件上下文身份包含主机及远程项目根。
test("SSH file context identity includes host and remote project root", () => {
  const comparisonStart = terminalProjectSource.indexOf("export function isSameProjectFileContext");
  const comparisonEnd = terminalProjectSource.indexOf("export function findWorktreeByPath", comparisonStart);
  assert.ok(comparisonStart >= 0 && comparisonEnd > comparisonStart);

  const comparison = terminalProjectSource.slice(comparisonStart, comparisonEnd);
  assert.match(comparison, /environment_type === "ssh"/);
  assert.match(comparison, /left\.ssh_host_id === right\.ssh_host_id/);
  assert.match(comparison, /normalizeRemoteProjectPath\(left\.remote_path\)/);

  const openProjectStart = fileStoreSource.indexOf("openProject: async");
  const openProjectEnd = fileStoreSource.indexOf("closeProject:", openProjectStart);
  const openProject = fileStoreSource.slice(openProjectStart, openProjectEnd);
  assert.match(openProject, /isSameProjectFileContext\(get\(\)\.project, project\)/);
  assert.match(terminalTabsSource, /filePanelProject\?\.ssh_host_id/);
  assert.match(terminalTabsSource, /filePanelProject\?\.remote_path/);
});

// 验证打开相同文件位置保留已加载的目录树。
test("opening the same file location preserves the loaded tree", () => {
  const locationStart = terminalProjectSource.indexOf("export function isSameProjectFileLocation");
  const locationEnd = terminalProjectSource.indexOf("export function findWorktreeByPath", locationStart);
  assert.ok(locationStart >= 0 && locationEnd > locationStart);

  const locationComparison = terminalProjectSource.slice(locationStart, locationEnd);
  assert.doesNotMatch(locationComparison, /left\.id !== right\.id/);
  assert.match(locationComparison, /left\.ssh_host_id === right\.ssh_host_id/);
  assert.match(locationComparison, /normalizeProjectPath\(left\.path\)/);

  const openProjectStart = fileStoreSource.indexOf("openProject: async");
  const openProjectEnd = fileStoreSource.indexOf("closeProject:", openProjectStart);
  const openProject = fileStoreSource.slice(openProjectStart, openProjectEnd);
  assert.match(openProject, /if \(isSameProjectFileLocation\(current, project\)\)/);
  assert.match(openProject, /if \(current !== project\) \{[\s\S]*?project,[\s\S]*?editorWorkspaces:/);
  assert.match(openProject, /}\s+return;\s+}/);
});

// 验证代理能力诊断使用指定的不可变发布版本。
test("Agent capability diagnostics have a new immutable release identity", () => {
  assert.match(sshAgentManifestSource, /^version = "0\.1\.14"$/m);
});
