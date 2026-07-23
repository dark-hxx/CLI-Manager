import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/stores/gitStore.ts", import.meta.url), "utf8");
const terminalTabsSource = readFileSync(new URL("../src/components/TerminalTabs.tsx", import.meta.url), "utf8");
const gitPanelSource = readFileSync(new URL("../src/components/git/GitChangesPanel.tsx", import.meta.url), "utf8");
const fileStoreSource = readFileSync(new URL("../src/stores/fileExplorerStore.ts", import.meta.url), "utf8");
const filePanelSource = readFileSync(new URL("../src/components/files/FileExplorerSidebar.tsx", import.meta.url), "utf8");
const terminalProjectSource = readFileSync(new URL("../src/lib/terminalProject.ts", import.meta.url), "utf8");
const sshAgentManifestSource = readFileSync(new URL("../src-tauri/ssh-agent/Cargo.toml", import.meta.url), "utf8");

test("remote root repository permits deleting untracked files", () => {
  const actionStart = source.indexOf("deleteUntrackedPaths: async");
  const actionEnd = source.indexOf("loadFileDiff: async", actionStart);
  assert.ok(actionStart >= 0 && actionEnd > actionStart);

  const action = source.slice(actionStart, actionEnd);
  assert.match(action, /repoPath === null/);
  assert.doesNotMatch(action, /!repoPath/);
});

test("SSH terminal panels use the registered remote project root", () => {
  assert.match(
    terminalTabsSource,
    /panelProject\?\.environment_type === "ssh"\s*\? panelProject\.remote_path\.trim\(\) \|\| null/,
  );
});

test("SSH visible-file refresh never falls back to local file commands", () => {
  const refreshStart = fileStoreSource.indexOf("refreshVisibleStateOnce: async");
  const refreshEnd = fileStoreSource.indexOf("refreshGitChanges: async", refreshStart);
  assert.ok(refreshStart >= 0 && refreshEnd > refreshStart);

  const refresh = fileStoreSource.slice(refreshStart, refreshEnd);
  assert.match(refresh, /project\.environment_type === "ssh" && !remoteFileContext/);
  assert.match(refresh, /loadProjectFile\(project, latestEntry, remoteFileContext\)/);
});

test("remote project panels show loading during initial context fetch", () => {
  assert.match(gitPanelSource, /\(contextLoading \|\| loading\) && changes\.length === 0/);
  assert.match(filePanelSource, /loading && tree\.length === 0/);
  assert.match(filePanelSource, /t\("common\.loading"\)/);
});

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

test("gitFull Agent has a new immutable release identity", () => {
  assert.match(sshAgentManifestSource, /^version = "0\.1\.1"$/m);
});
