import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const fileEditor = read("../src/components/files/FileEditorPane.tsx");
const fileEditorContent = read("../src/components/files/FileEditorContent.tsx");
const editorHost = read("../src/components/git/diff/GitDiffEditorHost.tsx");
const workspaceStore = read("../src/stores/gitDiffWorkspaceStore.ts");
const fileStore = read("../src/stores/fileExplorerStore.ts");
const gitStore = read("../src/stores/gitStore.ts");
const gitPanel = read("../src/components/git/GitChangesPanel.tsx");
const openWorkflow = read("../src/components/git/diff/useGitDiffOpenWorkflow.ts");
const reviewDialog = read("../src/components/git/diff/GitDiffReviewDialog.tsx");
const sshGit = read("../src/lib/sshRemoteGit.ts");

test("file editor composes pinned Diff without owning Git transport or mutations", () => {
  assert.match(fileEditor, /<FileEditorContent/);
  assert.match(fileEditorContent, /<GitDiffEditorHost/);
  assert.doesNotMatch(fileEditor, /@tauri-apps\/api\/core/);
  assert.doesNotMatch(fileEditor, /git_get_file_diff|git_revert_hunk|git_revert_lines|git_discard_file/);
});

test("pinned tabs live only in the project-scoped Diff workspace store", () => {
  assert.match(workspaceStore, /repositoryId: string/);
  assert.match(workspaceStore, /createGitDiffTabId/);
  assert.doesNotMatch(fileStore, /openDiffs|activeDiffPath|openDiff:/);
});

test("Git panel injects a leased transport and pinned host writes through its own lease", () => {
  assert.match(gitPanel, /useGitTransportLease/);
  assert.match(gitPanel, /setTransport\(panelLease\.transport/);
  assert.match(editorHost, /lease\.transport\.revertHunk/);
  assert.match(editorHost, /lease\.transport\.revertLines/);
  assert.match(editorHost, /lease\.transport\.discardFile/);
  assert.match(editorHost, /refreshIfContext\(currentLease\.contextKey\)/);
  assert.doesNotMatch(gitStore, /createGitTransport/);
});

test("pinning selects the editor host and source reveal closes only after success", () => {
  assert.match(gitPanel, /diffOpenWorkflow\.openPreferredDiff\(filePath\)/);
  assert.match(openWorkflow, /gitDiffOpenMode !== "editor"/);
  assert.match(openWorkflow, /updateSetting\("gitDiffOpenMode", "editor"\)/);
  assert.match(editorHost, /gitDiffOpenMode === "editor" \? "dialog" : "editor"/);
  assert.match(editorHost, /pinActive: gitDiffOpenMode === "editor"/);
  assert.match(reviewDialog, /if \(await onOpenSource\(target, lineNumber\)\) onClose\(\)/);
  assert.match(reviewDialog, /if \(await onPin\(target\)\) onClose\(\)/);
});

test("SSH Git context identity and release cover configuration changes", () => {
  assert.match(sshGit, /installation\.installation_id/);
  assert.match(sshGit, /encodeURIComponent\(rootPath\)/);
  assert.match(sshGit, /export async function releaseSshRemoteGitContext/);
  assert.match(sshGit, /invoke\("history_remote_close"/);
});

test("new pinned editor modules stay split by responsibility", () => {
  const modules = [
    "../src/lib/gitTransportLeaseRegistry.ts",
    "../src/lib/gitTransportIdentity.ts",
    "../src/lib/gitTransportLease.ts",
    "../src/hooks/useGitTransportLease.ts",
    "../src/stores/gitDiffWorkspaceStore.ts",
    "../src/components/git/diff/GitDiffEditorHost.tsx",
    "../src/components/git/diff/GitDiffEditorTabs.tsx",
    "../src/components/git/diff/useGitDiffOpenWorkflow.ts",
    "../src/components/files/FileEditorHeader.tsx",
    "../src/components/files/FileEditorTabs.tsx",
    "../src/components/files/FileEditorContent.tsx",
    "../src/components/files/useGitFileDecorations.ts",
    "../src/components/files/useFileEditorSearchNavigation.ts",
    "../src/components/files/useFileEditorShortcuts.ts",
    "../src/components/files/FileEditorPane.tsx",
  ];
  for (const modulePath of modules) {
    assert.ok(read(modulePath).split(/\r?\n/).length <= 300, modulePath);
  }
});
