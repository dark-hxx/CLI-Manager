import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const css = read("../src/components/git/diffViewer.css");
const content = read("../src/components/git/diff/GitDiffContent.tsx");
const hunkList = read("../src/components/git/diff/GitDiffHunkList.tsx");
const toolbar = read("../src/components/git/diff/GitDiffToolbar.tsx");
const viewer = read("../src/components/git/diff/GitDiffViewer.tsx");
const theme = read("../src/components/git/diff/theme.ts");
const horizontalScroll = read("../src/components/git/diff/useGitDiffHorizontalScroll.ts");

test("terminal Diff tokens are isolated from the application light theme", () => {
  assert.match(viewer, /data-git-diff-theme=\{useTerminalTheme \? "terminal" : "application"\}/);
  assert.match(viewer, /isLightTerminalTheme/);
  assert.match(css, /\[data-git-diff-theme="application"\]\[data-theme-mode="light"\]/);
  assert.doesNotMatch(css, /\[data-theme="light"\] \.diff-viewer-container/);
  assert.match(theme, /"--text-secondary"/);
  assert.match(theme, /"--interactive-selected-bg"/);
  assert.match(theme, /"--danger"/);
});

test("toolbar commands expose visible hover, pressed, disabled, and terminal select states", () => {
  assert.match(css, /git-diff-toolbar-button:hover:not\(:disabled\)/);
  assert.match(css, /git-diff-toolbar-button\[aria-pressed="true"\]/);
  assert.match(css, /git-diff-toolbar-button:disabled/);
  assert.match(css, /git-diff-toolbar-select option/);
  assert.match(toolbar, /aria-pressed=\{wrapLines\}/);
  assert.match(toolbar, /aria-pressed=\{pinActive\}/);
});

test("nowrap mode keeps fixed columns and synchronizes one horizontal scrollbar", () => {
  assert.match(content, /git-diff-horizontal-scrollbar/);
  assert.match(content, /data-overflow=\{horizontalScroll\.hasOverflow\}/);
  assert.match(css, /\.diff-split \.diff-line-normal[\s\S]*grid-template-columns/);
  assert.match(css, /var\(--git-diff-gutter-width\)[\s\S]*minmax\(0, 1fr\)[\s\S]*var\(--git-diff-gutter-width\)[\s\S]*minmax\(0, 1fr\)/);
  assert.doesNotMatch(css, /\[data-git-diff-wrap="false"\][\s\S]{0,180}width: max-content/);
  assert.match(css, /\[data-git-diff-wrap="false"\][\s\S]*white-space: pre/);
  assert.match(horizontalScroll, /codeCell\.scrollLeft = scrollLeft/);
  assert.match(horizontalScroll, /MutationObserver/);
  assert.match(horizontalScroll, /ResizeObserver/);
  assert.match(horizontalScroll, /--git-diff-code-track-width/);
  assert.match(hunkList, /virtualizer\.measure\(\)/);
  assert.doesNotMatch(hunkList, /rounded-lg|shadow-sm|overflow-hidden|className="[^"]*border/);
});
