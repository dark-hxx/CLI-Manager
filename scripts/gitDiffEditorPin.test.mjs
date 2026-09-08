import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const fileEditor = read("../src/features/files/hooks/useFileEditorController.ts");
const fileEditorView = read("../src/features/files/components/FileEditorPaneView.tsx");
const fileEditorContent = read("../src/features/files/components/FileEditorContent.tsx");
const editorHost = read("../src/features/git/api/GitDiffEditorHost.tsx");
const workspaceStore = read("../src/features/git/api/gitDiffWorkspaceStore.ts");
const fileStore = read("../src/features/files/api/fileExplorerStore.ts");
const gitStore = read("../src/features/git/store/gitStore.ts");
const gitPanel = read("../src/features/git/api/GitChangesPanel.tsx");
const openWorkflow = read("../src/features/git/components/diff/useGitDiffOpenWorkflow.ts");
const reviewDialog = read("../src/features/git/components/diff/GitDiffReviewDialog.tsx");
const sshGit = read("../src/features/remote/api/sshRemoteGit.ts");

test("file editor composes pinned Diff without owning Git transport or mutations", () => {
  assert.match(fileEditorView, /<FileEditorContent/);
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
    "../src/features/git/lib/gitTransportLeaseRegistry.ts",
    "../src/features/git/lib/gitTransportIdentity.ts",
    "../src/features/git/lib/gitTransportLease.ts",
    "../src/features/git/api/useGitTransportLease.ts",
    "../src/features/git/api/gitDiffWorkspaceStore.ts",
    "../src/features/git/api/GitDiffEditorHost.tsx",
    "../src/features/git/api/GitDiffEditorTabs.tsx",
    "../src/features/git/components/diff/useGitDiffOpenWorkflow.ts",
    "../src/features/files/components/FileEditorHeader.tsx",
    "../src/features/files/components/FileEditorTabs.tsx",
    "../src/features/files/components/FileEditorContent.tsx",
    "../src/features/files/components/useGitFileDecorations.ts",
    "../src/features/files/components/useFileEditorSearchNavigation.ts",
    "../src/features/files/components/useFileEditorShortcuts.ts",
    "../src/features/files/index.ts",
    "../src/features/files/components/FileEditorPane.tsx",
    "../src/features/files/components/FileEditorPaneView.tsx",
    "../src/features/files/hooks/useFileEditorController.ts",
    "../src/features/files/hooks/useFileEditorMarkdownNavigation.ts",
    "../src/features/files/types/fileEditorModel.ts",
    "../src/features/files/lib/fileEditorTheme.ts",
  ];
  for (const modulePath of modules) {
    assert.ok(read(modulePath).split(/\r?\n/).length <= 300, modulePath);
  }
});
