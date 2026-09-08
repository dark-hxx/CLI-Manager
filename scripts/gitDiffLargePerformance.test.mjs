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
} from "../src/shared/lib/gitDiffLimits.ts";
import { parseGitDiffFile } from "../src/features/git/components/diff/gitDiffParser.ts";
import {
  countGitDiffRenderRows,
  estimateGitDiffHunkHeight,
} from "../src/features/git/components/diff/gitDiffVirtualization.ts";

// 按相对路径读取被测源码。
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

// 验证差异处理阈值在精确边界仍启用对应能力。
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

// 验证旧差异载荷按 UTF-8 字节与 Rust 行语义补齐元数据。
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

  // 验证实际内容字节数超限被拒绝。
  assert.throws(() => normalizeGitDiffPayload({
    content: "a".repeat(GIT_DIFF_MAX_BYTES + 1),
    canRevertHunks: true,
  }), /git_diff_too_large/);
  // 验证实际内容行数超限被拒绝。
  assert.throws(() => normalizeGitDiffPayload({
    content: "x\n".repeat(GIT_DIFF_MAX_LINES + 1),
    canRevertHunks: true,
  }), /git_diff_too_large/);
});

// 验证传输元数据不能超过硬性字节和行数上限。
test("transport normalization rejects byte and line values above the hard limits", () => {
  // 验证元数据等于硬上限时仍被接受。
  assert.doesNotThrow(() => normalizeGitDiffPayload({
    content: "a",
    canRevertHunks: false,
    byteLength: GIT_DIFF_MAX_BYTES,
    lineCount: GIT_DIFF_MAX_LINES,
  }));
  // 验证声明字节数超过硬上限时被拒绝。
  assert.throws(() => normalizeGitDiffPayload({
    content: "a",
    canRevertHunks: false,
    byteLength: GIT_DIFF_MAX_BYTES + 1,
    lineCount: 1,
  }), /git_diff_too_large/);
  // 验证声明行数超过硬上限时被拒绝。
  assert.throws(() => normalizeGitDiffPayload({
    content: "a",
    canRevertHunks: false,
    byteLength: 1,
    lineCount: GIT_DIFF_MAX_LINES + 1,
  }), /git_diff_too_large/);
});

// 验证纯解析器返回可结构化克隆的数据。
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
  // 验证解析结果不含阻止结构化克隆的值。
  assert.doesNotThrow(() => structuredClone(file));
});

// 验证统一与分栏视图的行数及高度估算。
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

// 验证 Worker 取消与虚拟化仅处理可见内容的源码契约。
test("worker parsing and hunk virtualization keep cancellation and visible-only work", () => {
  const hook = read("../src/features/git/components/diff/useGitDiffParser.ts");
  const worker = read("../src/features/git/components/diff/gitDiffParser.worker.ts");
  const list = read("../src/features/git/components/diff/GitDiffHunkList.tsx");
  const block = read("../src/features/git/components/diff/GitDiffHunkBlock.tsx");
  const controller = read("../src/features/git/components/diff/useGitDiffController.ts");

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

// 验证本地和 SSH 传输在统一边界归一化可选元数据。
test("local and SSH transport normalize optional metadata at one boundary", () => {
  const transport = read("../src/features/git/lib/gitTransport.ts");
  const matches = transport.match(/normalizeGitDiffPayload/g) ?? [];
  assert.ok(matches.length >= 3);
  assert.match(transport, /value: normalizeGitDiffPayload\(result\.value\)/);
});

// 验证桌面与代理遵守同一差异载荷错误契约。
test("Desktop and Agent enforce the same final payload error contract", () => {
  const desktop = read("../src-tauri/src/features/git/diff.rs");
  const agent = read("../src-tauri/ssh-agent/src/git_diff.rs");
  for (const source of [desktop, agent]) {
    assert.match(source, /MAX_DIFF_LINES: usize = 20_000/);
    assert.match(source, /byte_length/);
    assert.match(source, /line_count/);
    assert.match(source, /git_diff_too_large/);
  }
  assert.match(desktop, /MAX_DIFF_BYTES: usize = 768 \* 1024/);
});
