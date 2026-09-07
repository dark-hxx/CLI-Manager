import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const terminalTabs = read("../src/features/terminal/components/TerminalTabsView.tsx");
const terminalController = read("../src/features/terminal/hooks/useTerminalTabsController.tsx");
const footer = read("../src/components/sidebar/SidebarFooter.tsx");
const workspace = read("../src/components/git/workspace/GitWorkspace.tsx");
const details = read("../src/components/git/workspace/GitCommitDetails.tsx");

test("the sidebar entry and terminal shell share one workspace store", () => {
  assert.match(footer, /useGitWorkspaceStore/);
  assert.match(terminalController, /useGitWorkspaceStore/);
  assert.match(terminalTabs, /data-terminal-side-panel-visible=/);
  assert.match(terminalTabs, /display: historyActive \? "none" : "flex"/);
  assert.match(terminalTabs, /style=\{\{ height: gitWorkspaceHeight/);
  assert.match(terminalTabs, /<GitWorkspace/);
});

test("the full workspace uses transport leases and the existing changes panel", () => {
  assert.match(workspace, /useGitTransportLease/);
  assert.match(workspace, /<GitChangesPanel/);
  assert.match(workspace, /workspaceMode/);
});

test("commit file diffs remain read-only through the shared viewer", () => {
  assert.match(details, /<DiffViewerModal/);
  assert.match(details, /transport\s*\.\s*getCommitFileDiff/);
  assert.doesNotMatch(details, /revertHunk=|revertLines=|onRequestDiscard=/);
});
