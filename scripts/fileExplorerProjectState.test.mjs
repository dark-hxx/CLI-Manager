import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const fileStore = read("../src/stores/fileExplorerStore.ts");
const terminalStore = read("../src/stores/terminalStore.ts");
const terminalTabs = read("../src/components/TerminalTabs.tsx");
const sidebar = read("../src/components/sidebar/index.tsx");
const fileEditorPane = read("../src/components/files/FileEditorPane.tsx");

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `missing source range: ${startMarker}`);
  return source.slice(start, end);
}

test("project switches snapshot and restore editor files by file location", () => {
  const openProject = sliceBetween(fileStore, "openProject: async", "closeProject:");
  assert.match(openProject, /upsertEditorWorkspace/);
  assert.match(openProject, /findEditorWorkspace/);
  assert.match(openProject, /openFiles,\s*activeFilePath: activeFile\?\.path/);
  assert.doesNotMatch(openProject, /openFiles:\s*\[\]/);

  const workspaceHelpers = sliceBetween(
    fileStore,
    "function findEditorWorkspace",
    "function changedPathAffectsFile",
  );
  assert.match(workspaceHelpers, /isSameProjectFileLocation/);
});

test("closing a file panel snapshots state while closing the project editor clears all its locations", () => {
  const closeProject = sliceBetween(fileStore, "  closeProject: () => {", "  getProjectEditorWorkspaces:");
  const openEditor = sliceBetween(terminalStore, "  openFileEditorPane: (project) => {", "  openSyncedHistoryPane:");
  assert.match(closeProject, /upsertEditorWorkspace/);
  assert.match(fileStore, /clearProjectEditorWorkspaces: \(projectId\)/);
  assert.match(terminalStore, /clearProjectEditorWorkspacesIfUnused\(project, remaining\)/);
  assert.match(terminalStore, /for \(const closedSessionId of fileEditorClosedIds\)/);
  assert.doesNotMatch(openEditor, /clearProjectEditorWorkspaces/);
});

test("late file reads and saves stay with their originating project", () => {
  const openFile = sliceBetween(fileStore, "openFile: async", "openFileAtSearchMatch:");
  const saveFile = sliceBetween(fileStore, "saveFile: async", "saveActiveFile:");
  assert.match(openFile, /isSameProjectFileLocation\(state\.project, project\)/);
  assert.match(openFile, /findEditorWorkspace\(state\.editorWorkspaces, project\)/);
  assert.match(saveFile, /isSameProjectFileLocation\(state\.project, project\)/);
  assert.match(saveFile, /upsertEditorWorkspace/);
});

test("project switching no longer asks to discard files", () => {
  const syncPanel = sliceBetween(terminalTabs, "const syncFilePanelProject", "const closeFilesPanel");
  const openSidebarFiles = sliceBetween(sidebar, "const handleOpenProjectFiles", "const handleOpenWorktreeFiles");
  assert.doesNotMatch(syncPanel, /unsavedSwitchWithFiles|unsavedFileConfirm/);
  assert.doesNotMatch(openSidebarFiles, /unsavedSwitchWithFiles|unsavedFileConfirm/);
});

test("project synchronization effects read the latest store without subscribing to their own writes", () => {
  const syncPanel = sliceBetween(terminalTabs, "const syncFilePanelProject", "const closeFilesPanel");
  assert.match(syncPanel, /useFileExplorerStore\.getState\(\)\.project/);
  assert.doesNotMatch(syncPanel, /\[fileProject,/);
  assert.match(
    fileEditorPane,
    /isSameProjectFileContext\(useFileExplorerStore\.getState\(\)\.project, editorProject\)[\s\S]*?void openProject\(editorProject\);[\s\S]*?\[editorProject, isActive, openProject\]/,
  );
});

test("hidden Workspans do not activate their file editors", () => {
  const paneLeaf = sliceBetween(terminalTabs, "function PaneLeafView", "const MemoPaneLeafView");
  assert.match(
    paneLeaf,
    /<FileEditorPane[\s\S]*?isActive=\{!historyActive && isLayoutVisible && session\.id === activeSessionId\}/,
  );
});

test("closing editor tabs checks dirty files in every location owned by each project", () => {
  const closeGuard = sliceBetween(
    terminalTabs,
    "const closeSessionsWithDirtyGuard",
    "const handleCloseSessions",
  );
  assert.match(closeGuard, /getProjectEditorWorkspaces\(project\.id\)\.flatMap/);
  assert.match(closeGuard, /workspace\.openFiles/);
  assert.match(closeGuard, /unsavedCloseWithFiles/);
  assert.doesNotMatch(closeGuard, /closeFile\(/);
});
