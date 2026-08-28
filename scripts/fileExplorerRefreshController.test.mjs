import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const app = read("../src/App.tsx");
const controller = read("../src/components/files/ProjectFileRefreshController.tsx");
const sidebar = read("../src/components/files/FileExplorerSidebar.tsx");
const editorContent = read("../src/components/files/FileEditorContent.tsx");
const fileStore = read("../src/stores/fileExplorerStore.ts");
const remoteFiles = read("../src/lib/sshRemoteFiles.ts");
const componentStyles = read("../src/styles/components.css");

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `missing source range: ${startMarker}`);
  return source.slice(start, end);
}

test("file refresh lifecycle is App-mounted instead of being owned by the sidebar", () => {
  assert.match(app, /import \{ ProjectFileRefreshController \}/);
  assert.match(app, /<ProjectFileRefreshController\s*\/>/);
  assert.match(controller, /file_watch_start/);
  assert.match(controller, /file_watch_stop/);
  assert.match(controller, /project-files-changed/);
  assert.match(controller, /window\.addEventListener\("focus", onFocus\)/);
  assert.match(controller, /document\.addEventListener\("visibilitychange", onVisibility\)/);
  assert.match(controller, /window\.setInterval\(refreshIfActive, PROJECT_FILE_REFRESH_INTERVAL_MS\)/);
  assert.match(controller, /return null;/);
  assert.doesNotMatch(sidebar, /file_watch_start/);
  assert.doesNotMatch(sidebar, /file_watch_stop/);
});

test("automatic SSH refresh is quiet, context-bound, and never falls back to local files", () => {
  assert.match(controller, /const remoteProject = project\.environment_type === "ssh";/);
  assert.match(controller, /remoteProject && \(!remoteFileContext \|\| !hasOpenFiles\)/);
  assert.match(controller, /refreshVisibleState\(changedPaths, \{ silent: true \}\)/);
  assert.match(remoteFiles, /if \(options\?\.silent\) return action\(\);/);

  const refreshOnce = sliceBetween(fileStore, "  refreshVisibleStateOnce: async", "  refreshGitChanges:");
  assert.match(refreshOnce, /project\.environment_type === "ssh" && !remoteFileContext/);
  assert.match(refreshOnce, /sshRemoteListDir\(remoteFileContext, path, options\)/);
  assert.match(refreshOnce, /loadProjectFile\(project, latestEntry, remoteFileContext, options\)/);
});

test("automatic refresh preserves dirty drafts and only rereads changed clean files", () => {
  const refreshOnce = sliceBetween(fileStore, "  refreshVisibleStateOnce: async", "  refreshGitChanges:");
  assert.match(refreshOnce, /const dirty = file\.content !== file\.savedContent;/);
  assert.match(refreshOnce, /if \(dirty\) \{\s*nextOpenFiles\.push\(baseFile\);/);
  assert.match(refreshOnce, /const changed = file\.modifiedMs !== \(latestEntry\.modifiedMs \?\? null\)/);
});

test("file Markdown preview passes its wheel zoom size through the renderer root", () => {
  assert.match(editorContent, /"--markdown-preview-font-size": `\$\{fontSize\}px`/);
  assert.match(
    componentStyles,
    /\.ui-file-editor-markdown-preview \.ui-markdown-terminal \{[\s\S]*?font-size: var\(--markdown-preview-font-size, var\(--font-size-ui\)\);/,
  );
});
