import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-hook-binding-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

const source = readFileSync(new URL("../src/stores/terminalHookBinding.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const modulePath = join(tempDir, "terminalHookBinding.mjs");
writeFileSync(modulePath, output, "utf8");
const { normalizeHookBindingPath, resolveCliHookTarget } = await import(pathToFileURL(modulePath).href);

const candidate = (id, overrides = {}) => ({
  id,
  source: "grok",
  paths: ["D:/work/project"],
  environmentType: "local",
  ...overrides,
});

test("精确 tabId 始终优先", () => {
  const result = resolveCliHookTarget({
    rawTabId: "tab-b",
    primaryTabId: "tab-a",
    source: "grok",
    cwd: "D:/work/project",
    receivedAt: 10_000,
    candidates: [candidate("tab-a"), candidate("tab-b")],
  });
  assert.deepEqual(result, { tabId: "tab-b", reason: "exact" });
});

test("外部 Hook 仅有一个路径候选时自动恢复", () => {
  const result = resolveCliHookTarget({
    rawTabId: "external:grok:session",
    primaryTabId: "external:grok:session",
    source: "grok",
    cwd: "D:/work/project/subdir",
    sessionId: "session",
    receivedAt: 10_000,
    candidates: [candidate("tab-a")],
  });
  assert.deepEqual(result, { tabId: "tab-a", reason: "unique-path" });
});

test("多个同路径分屏只绑定唯一近期有输出的终端", () => {
  const result = resolveCliHookTarget({
    rawTabId: "external:grok:session",
    primaryTabId: "external:grok:session",
    source: "grok",
    cwd: "D:/work/project",
    receivedAt: 10_000,
    candidates: [
      candidate("tab-a", { outputActivityAt: 1_000 }),
      candidate("tab-b", { outputActivityAt: 9_500 }),
    ],
  });
  assert.deepEqual(result, { tabId: "tab-b", reason: "recent-output" });
});

test("多个活跃候选时拒绝猜测", () => {
  const result = resolveCliHookTarget({
    rawTabId: "external:grok:session",
    primaryTabId: "external:grok:session",
    source: "grok",
    cwd: "D:/work/project",
    receivedAt: 10_000,
    candidates: [
      candidate("tab-a", { outputActivityAt: 9_000 }),
      candidate("tab-b", { outputActivityAt: 9_500 }),
    ],
  });
  assert.deepEqual(result, { tabId: null, reason: "ambiguous" });
});

test("Windows、WSL 挂载盘和 WSL UNC 路径使用一致口径", () => {
  assert.equal(normalizeHookBindingPath("C:\\repo"), normalizeHookBindingPath("/mnt/c/repo"));
  assert.equal(
    normalizeHookBindingPath("\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo"),
    normalizeHookBindingPath("/home/dev/repo", "Ubuntu"),
  );
});

test("磁盘根目录可匹配其子目录", () => {
  const result = resolveCliHookTarget({
    rawTabId: "external:codex",
    primaryTabId: "external:codex",
    source: "codex",
    cwd: "C:\\repo",
    receivedAt: 10_000,
    candidates: [candidate("root", { source: "codex", paths: ["C:\\"] })],
  });
  assert.deepEqual(result, { tabId: "root", reason: "unique-path" });
});

test("本地外部 Hook 可以匹配 WSL 终端但不会匹配 SSH", () => {
  const result = resolveCliHookTarget({
    rawTabId: "external:claude:session",
    primaryTabId: "external:claude:session",
    source: "claude",
    cwd: "/home/dev/repo",
    wslDistroName: "Ubuntu",
    receivedAt: 10_000,
    candidates: [
      candidate("wsl", {
        source: "claude",
        paths: ["\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo"],
        environmentType: "wsl",
      }),
      candidate("ssh", {
        source: "claude",
        paths: ["/home/dev/repo"],
        environmentType: "ssh",
      }),
    ],
  });
  assert.deepEqual(result, { tabId: "wsl", reason: "unique-path" });
});

test("本地 Hook 即使携带精确 ID 也不会绑定 SSH Tab", () => {
  const result = resolveCliHookTarget({
    rawTabId: "ssh",
    primaryTabId: "ssh",
    source: "claude",
    cwd: "/home/dev/repo",
    receivedAt: 10_000,
    candidates: [candidate("ssh", {
      source: "claude",
      paths: ["/home/dev/repo"],
      environmentType: "ssh",
    })],
  });
  assert.deepEqual(result, { tabId: null, reason: "not-found" });
});

test("SSH Hook 仍可按精确 ID 绑定 SSH Tab", () => {
  const result = resolveCliHookTarget({
    rawTabId: "ssh",
    primaryTabId: "ssh",
    source: "claude",
    cwd: "/home/dev/repo",
    environmentType: "ssh",
    receivedAt: 10_000,
    candidates: [candidate("ssh", {
      source: "claude",
      paths: ["/home/dev/repo"],
      environmentType: "ssh",
    })],
  });
  assert.deepEqual(result, { tabId: "ssh", reason: "exact" });
});
