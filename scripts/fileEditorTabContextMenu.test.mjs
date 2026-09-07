import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const tabs = read("../src/components/files/FileEditorTabs.tsx");
const pane = read("../src/components/files/FileEditorPane.tsx");
const diffTabs = read("../src/components/git/diff/GitDiffEditorTabs.tsx");
const i18n = read("../src/lib/i18n.ts");
const styles = read("../src/styles/components.css");

test("file editor tabs expose only ordered file-close context actions", () => {
  assert.match(tabs, /<ContextMenu key=\{file\.path\}>/);
  assert.match(tabs, /<ContextMenuContent className="terminal-skin ui-file-editor-tab-menu">/);
  assert.doesNotMatch(tabs, /<ContextMenuContent className="file-explorer-menu">/);
  assert.match(tabs, /const otherPaths = files\.filter/);
  assert.match(tabs, /const leftPaths = files\.slice\(0, index\)/);
  assert.match(tabs, /const rightPaths = files\.slice\(index \+ 1\)/);
  assert.match(tabs, /disabled=\{otherPaths\.length === 0\}/);
  assert.match(tabs, /disabled=\{leftPaths\.length === 0\}/);
  assert.match(tabs, /disabled=\{rightPaths\.length === 0\}/);
  for (const key of ["closeCurrent", "closeOthers", "closeLeft", "closeRight"]) {
    assert.match(tabs, new RegExp(`files\\.editor\\.${key}`));
  }
  assert.match(tabs, /onCloseFiles\(\[file\.path\]\)/);
  assert.doesNotMatch(tabs, /terminal\.(tab|toolbar|workspan)\./);
  assert.doesNotMatch(diffTabs, /ContextMenu/);
});

test("file tab menu reuses the terminal tab skin through root theme variables", () => {
  assert.match(styles, /\.context-menu\.terminal-skin\.ui-file-editor-tab-menu/);
  assert.match(styles, /--menu-fg: var\(--terminal-theme-foreground, #d8dee9\)/);
  assert.match(styles, /--menu-bg: var\(--terminal-theme-background, #0c0e10\)/);
  assert.match(styles, /--menu-border: color-mix\(in srgb, var\(--terminal-theme-foreground, #d8dee9\) 18%, transparent\)/);
  assert.match(styles, /--menu-hover: color-mix\(in srgb, var\(--terminal-theme-foreground, #d8dee9\) 12%, transparent\)/);
});

test("batch file closes wait for selected dirty files before mutating tabs", () => {
  assert.match(pane, /type PendingAction = \{ closePane: boolean; paths: string\[\]; dirtyPaths: string\[\] \} \| null/);
  assert.match(pane, /const requestCloseFiles = \(paths: string\[\]\) => \{[\s\S]*?const targetFiles = visibleFiles\.filter/);
  assert.match(pane, /const dirtyPaths = targetFiles\.filter\(\(file\) => file\.content !== file\.savedContent\)/);
  assert.match(pane, /setPendingAction\(\{ closePane: false, paths: targetPaths, dirtyPaths \}\)/);
  assert.match(pane, /for \(const path of dirtyPaths\) await saveFile\(path\);[\s\S]*?closeFiles\(paths\);/);
  assert.match(pane, /onCloseFiles=\{requestCloseFiles\}/);
});

test("file tab menu labels have Chinese and English translations", () => {
  for (const key of ["closeCurrent", "closeOthers", "closeLeft", "closeRight"]) {
    const matches = i18n.match(new RegExp(`"files\\.editor\\.${key}":`, "g")) ?? [];
    assert.equal(matches.length, 2, `expected zh/en translation for ${key}`);
  }
});
