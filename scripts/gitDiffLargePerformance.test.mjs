import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  GIT_DIFF_HIGHLIGHT_MAX_BYTES,
  GIT_DIFF_HIGHLIGHT_MAX_LINES,
  GIT_DIFF_MAX_BYTES,
  GIT_DIFF_MAX_LINES,
  GIT_DIFF_WORKER_THRESHOLD_BYTES,
  countGitDiffLines,
  normalizeGitDiffPayload,
  shouldHighlightGitDiff,
  shouldParseGitDiffInWorker,
} from "../src/lib/gitDiffLimits.ts";
import { parseGitDiffFile } from "../src/components/git/diff/gitDiffParser.ts";
import {
  countGitDiffRenderRows,
  estimateGitDiffHunkHeight,
} from "../src/components/git/diff/gitDiffVirtualization.ts";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("Git diff thresholds keep exact boundary values enabled", () => {
  assert.equal(shouldParseGitDiffInWorker(GIT_DIFF_WORKER_THRESHOLD_BYTES), false);
  assert.equal(shouldParseGitDiffInWorker(GIT_DIFF_WORKER_THRESHOLD_BYTES + 1), true);
  assert.equal(shouldHighlightGitDiff({
    byteLength: GIT_DIFF_HIGHLIGHT_MAX_BYTES,
    lineCount: GIT_DIFF_HIGHLIGHT_MAX_LINES,
  }), true);
  assert.equal(shouldHighlightGitDiff({
    byteLength: GIT_DIFF_HIGHLIGHT_MAX_BYTES + 1,
    lineCount: GIT_DIFF_HIGHLIGHT_MAX_LINES,
  }), false);
  assert.equal(shouldHighlightGitDiff({
    byteLength: GIT_DIFF_HIGHLIGHT_MAX_BYTES,
    lineCount: GIT_DIFF_HIGHLIGHT_MAX_LINES + 1,
  }), false);
});

test("legacy payload metadata is normalized with UTF-8 byte and Rust line semantics", () => {
  const payload = normalizeGitDiffPayload({
    content: "新增\nline\n",
    canRevertHunks: true,
  });
  assert.equal(payload.byteLength, 12);
  assert.equal(payload.lineCount, 2);
  assert.equal(countGitDiffLines(""), 0);
  assert.equal(countGitDiffLines("one"), 1);
  assert.equal(countGitDiffLines("one\n"), 1);

  assert.throws(() => normalizeGitDiffPayload({
    content: "a".repeat(GIT_DIFF_MAX_BYTES + 1),
    canRevertHunks: true,
  }), /git_diff_too_large/);
  assert.throws(() => normalizeGitDiffPayload({
    content: "x\n".repeat(GIT_DIFF_MAX_LINES + 1),
    canRevertHunks: true,
  }), /git_diff_too_large/);
});

test("transport normalization rejects byte and line values above the hard limits", () => {
  assert.doesNotThrow(() => normalizeGitDiffPayload({
    content: "a",
    canRevertHunks: false,
    byteLength: GIT_DIFF_MAX_BYTES,
    lineCount: GIT_DIFF_MAX_LINES,
  }));
  assert.throws(() => normalizeGitDiffPayload({
    content: "a",
    canRevertHunks: false,
    byteLength: GIT_DIFF_MAX_BYTES + 1,
    lineCount: 1,
  }), /git_diff_too_large/);
  assert.throws(() => normalizeGitDiffPayload({
    content: "a",
    canRevertHunks: false,
    byteLength: 1,
    lineCount: GIT_DIFF_MAX_LINES + 1,
  }), /git_diff_too_large/);
});

test("pure parser returns structured clone friendly file data", () => {
  const file = parseGitDiffFile([
    "diff --git a/a.txt b/a.txt",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1 +1 @@",
    "-old",
    "+new",
  ].join("\n"));
  assert.equal(file?.hunks.length, 1);
  assert.equal(file?.hunks[0].changes.length, 2);
  assert.doesNotThrow(() => structuredClone(file));
});

test("virtual height estimation matches unified and split row composition", () => {
  const changes = [
    { type: "delete" },
    { type: "insert" },
    { type: "normal" },
  ];
  assert.equal(countGitDiffRenderRows(changes, "unified"), 3);
  assert.equal(countGitDiffRenderRows(changes, "split"), 2);
  assert.equal(estimateGitDiffHunkHeight({ changes }, "split"), 76);
});

test("worker parsing and hunk virtualization keep cancellation and visible-only work", () => {
  const hook = read("../src/components/git/diff/useGitDiffParser.ts");
  const worker = read("../src/components/git/diff/gitDiffParser.worker.ts");
  const list = read("../src/components/git/diff/GitDiffHunkList.tsx");
  const block = read("../src/components/git/diff/GitDiffHunkBlock.tsx");
  const controller = read("../src/components/git/diff/useGitDiffController.ts");

  assert.match(hook, /new Worker\(new URL\("\.\/gitDiffParser\.worker\.ts"/);
  assert.match(hook, /let settled = false/);
  assert.match(hook, /settled = true;\s*worker\?\.terminate\(\)/);
  assert.match(hook, /worker\?\.terminate\(\)/);
  assert.match(hook, /generationRef\.current/);
  assert.match(worker, /generation/);
  assert.match(list, /useVirtualizer/);
  assert.match(list, /measureElement/);
  assert.match(list, /virtualizer\.measure\(\)/);
  assert.match(list, /wrapLines/);
  assert.match(list, /scrollToIndex/);
  assert.match(list, /pendingFocus\.file !== controller\.parsed\?\.file/);
  assert.match(block, /tokenize\(\[hunk\]/);
  assert.doesNotMatch(controller, /parseDiff|tokenize/);
  assert.match(
    controller,
    /syntaxHighlight: !parseResult\.workerFallback && shouldHighlightGitDiff\(metadata\)/,
  );
});

test("local and SSH transport normalize optional metadata at one boundary", () => {
  const transport = read("../src/lib/gitTransport.ts");
  const matches = transport.match(/normalizeGitDiffPayload/g) ?? [];
  assert.ok(matches.length >= 3);
  assert.match(transport, /value: normalizeGitDiffPayload\(result\.value\)/);
});

test("Desktop and Agent enforce the same final payload error contract", () => {
  const desktop = read("../src-tauri/src/commands/git_diff.rs");
  const agent = read("../src-tauri/ssh-agent/src/git_diff.rs");
  for (const source of [desktop, agent]) {
    assert.match(source, /MAX_DIFF_LINES: usize = 20_000/);
    assert.match(source, /byte_length/);
    assert.match(source, /line_count/);
    assert.match(source, /git_diff_too_large/);
  }
  assert.match(desktop, /MAX_DIFF_BYTES: usize = 768 \* 1024/);
});
