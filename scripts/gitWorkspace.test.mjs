import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const terminalTabs = read("../src/features/terminal/components/TerminalTabsView.tsx");
const terminalController = read("../src/features/terminal/hooks/useTerminalTabsController.tsx");
const terminalSidePanel = read("../src/features/terminal/components/TerminalSidePanel.tsx");
const footer = read("../src/features/projects/components/SidebarFooter.tsx");
const workspace = read("../src/features/git/api/GitWorkspace.tsx");
const changesPanel = read("../src/features/git/api/GitChangesPanel.tsx");
const details = read("../src/features/git/components/workspace/GitCommitDetails.tsx");

test("the terminal Git action owns the unified workspace entry", () => {
  assert.doesNotMatch(footer, /GitBranch|useGitWorkspaceStore|gitWorkspace/);
  assert.match(terminalController, /useGitWorkspaceStore/);
  assert.match(terminalController, /openGitWorkspace\(\)/);
  assert.match(terminalController, /const gitPanelActive = sidePanelMerged \? sidePanelOpen && sidePanelTab === "git" : gitOpen/);
  assert.match(terminalController, /const handleOpenGitChangesPanel = useCallback/);
  assert.match(terminalController, /setSidePanelTab\("git"\)/);
  assert.match(terminalTabs, /data-terminal-side-panel-visible=/);
  assert.match(terminalTabs, /display: historyActive \? "none" : "flex"/);
  assert.match(terminalTabs, /style=\{\{ height: gitWorkspaceHeight/);
  assert.match(terminalTabs, /<GitWorkspace/);
  assert.match(terminalTabs, /<GitChangesPanel/);
  assert.match(terminalTabs, /onOpenChanges=\{handleOpenGitChangesPanel\}/);
  assert.match(terminalSidePanel, /GitChangesPanel/);
});

test("the full workspace routes changes to the legacy side panel", () => {
  assert.match(workspace, /useGitTransportLease/);
  assert.match(workspace, /onOpenChanges: \(\) => void/);
  assert.match(workspace, /onOpenChanges\(\)/);
  assert.doesNotMatch(workspace, /GitChangesPanel/);
  assert.doesNotMatch(workspace, /workspaceMode/);
  assert.doesNotMatch(workspace, /justify-end overflow-hidden/);
  assert.match(changesPanel, /w-\[184px\]/);
  assert.doesNotMatch(changesPanel, /grid-cols-\[minmax\(0,1fr\)_minmax\(280px,34%\)\]/);
});

// 两种宿主必须双向切换；侧栏不能重新渲染旧版历史列表。
test("history leaves the sidebar and changes returns from the bottom workspace", () => {
  assert.doesNotMatch(changesPanel, /GitHistoryView|setViewMode/);
  assert.match(changesPanel, /if \(mode === "history"\) openGitWorkspace\(\)/);
  assert.match(terminalController, /if \(!gitWorkspaceOpen\) return;\s+closeHistory\(\);\s+setActiveWorkspaceTab\("terminal"\);\s+setGitOpen\(false\);\s+if \(sidePanelMerged && sidePanelTab === "git"\) setSidePanelOpen\(false\)/);
  assert.match(terminalController, /gitPanelActive: gitPanelActive \|\| gitWorkspaceOpen/);
  assert.match(terminalTabs, /onOpenChanges=\{handleOpenGitChangesPanel\}/);
  assert.match(terminalController, /const handleOpenGitChangesPanel = useCallback\([\s\S]*?closeGitWorkspace\(\);[\s\S]*?setSidePanelTab\("git"\);[\s\S]*?setGitOpen\(true\)/);
});

test("Git history workspace stays responsive and uses terminal scrollbar tokens", () => {
  assert.doesNotMatch(workspace, /min-w-\[760px\]/);
  assert.match(workspace, /className="h-full min-h-0 overflow-hidden"/);
  assert.match(workspace, /minmax\(0, 1fr\)/);
  assert.match(workspace, /"--ui-scrollbar-thumb": TERM\.border/);
  assert.match(workspace, /"--ui-scrollbar-track": TERM\.bg/);
});

test("Git workspace exposes draggable column and height handles", () => {
  assert.match(workspace, /GIT_WORKSPACE_RESIZE_HANDLE_WIDTH = 8/);
  assert.match(workspace, /setPointerCapture\(pointerId\)/);
  assert.match(workspace, /pointercancel/);
  assert.match(workspace, /className="group relative shrink-0 cursor-col-resize touch-none select-none"/);
  assert.match(workspace, /aria-valuenow=\{Math\.round\(leftWidth\)\}/);
  assert.match(workspace, /aria-valuenow=\{Math\.round\(rightWidth\)\}/);
  assert.match(terminalTabs, /cursor-row-resize touch-none select-none/);
});

test("commit file diffs remain read-only through the shared viewer", () => {
  assert.match(details, /<DiffViewerModal/);
  assert.match(details, /transport\s*\.\s*getCommitFileDiff/);
  assert.doesNotMatch(details, /revertHunk=|revertLines=|onRequestDiscard=/);
});
