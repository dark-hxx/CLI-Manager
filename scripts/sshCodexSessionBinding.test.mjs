import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-ssh-codex-binding-"));
// 退出时清理 SSH Codex 绑定测试的临时目录。
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

const source = readFileSync(new URL("../src/features/remote/lib/sshCodexSessionBinding.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "sshCodexSessionBinding.ts",
}).outputText;
const outputPath = join(tempDir, "sshCodexSessionBinding.mjs");
writeFileSync(outputPath, output, "utf8");
const binding = await import(pathToFileURL(outputPath).href);

const terminalStartedAtMs = 1_000_000;
const nowMs = 1_600_000;

// 构造具有远程身份及时间信息的 Codex 历史摘要。
function summary(overrides = {}) {
  return {
    session_id: "thread-1",
    source: "codex",
    project_key: "/srv/project",
    title: "Remote task",
    file_path: "/home/user/.codex/sessions/thread-1.jsonl",
    created_at: terminalStartedAtMs + 1_000,
    updated_at: nowMs - 1_000,
    message_count: 2,
    session_ref: {
      sourceId: "codex",
      sourceInstanceId: "remote-source-1",
      sourceSessionId: "thread-1",
      transportKind: "ssh",
      rawPointers: [],
    },
    ...overrides,
  };
}

// 以固定时间窗口和绑定集合调用唯一会话选择器。
function select(summaries, alreadyBoundSessionIds = new Set(), launchSelection = { kind: "new" }) {
  return binding.selectUniqueSshCodexSessionBinding({
    summaries,
    terminalStartedAtMs,
    terminalActivityAtMs: nowMs - 5_000,
    nowMs,
    alreadyBoundSessionIds,
    launchSelection,
  });
}

// 验证唯一近期 SSH Codex 会话可被绑定。
test("a single recent SSH Codex history session is selected", () => {
  assert.deepEqual(select([summary()]), {
    status: "resolved",
    sessionId: "thread-1",
    sourceInstanceId: "remote-source-1",
  });
});

// 验证过旧、空、本地及已绑定会话被排除。
test("old, empty, local, and already-bound sessions are rejected", () => {
  assert.deepEqual(select([summary({ created_at: terminalStartedAtMs - 60_001 })]), {
    status: "not_found",
  });
  assert.deepEqual(select([summary({ message_count: 0 })]), { status: "not_found" });
  assert.deepEqual(select([summary({
    session_ref: { ...summary().session_ref, transportKind: "local" },
  })]), { status: "not_found" });
  assert.deepEqual(select([summary()], new Set(["thread-1"])), { status: "not_found" });
});

// 验证显式恢复目标无需满足新建时间推断窗口。
test("an explicit resume target bypasses creation-time inference", () => {
  const resumed = summary({
    created_at: terminalStartedAtMs - 12 * 60 * 60 * 1_000,
    updated_at: terminalStartedAtMs - 5 * 60 * 1_000,
  });
  assert.deepEqual(select([resumed], new Set(), {
    kind: "explicit",
    sessionId: "thread-1",
  }), {
    status: "resolved",
    sessionId: "thread-1",
    sourceInstanceId: "remote-source-1",
  });
});

// 验证显式目标缺失时不会误绑定其他近期会话。
test("an explicit resume target fails closed instead of binding another recent session", () => {
  assert.deepEqual(select([summary()], new Set(), {
    kind: "explicit",
    sessionId: "thread-missing",
  }), {
    status: "not_found",
  });
});

// 验证恢复最近会话选择唯一最新目标而不依赖创建时间。
test("resume --last selects the uniquely latest SSH Codex session without creation-time inference", () => {
  const resumed = summary({
    created_at: terminalStartedAtMs - 12 * 60 * 60 * 1_000,
    updated_at: terminalStartedAtMs - 5 * 60 * 1_000,
  });
  const older = summary({
    session_id: "thread-2",
    created_at: terminalStartedAtMs - 24 * 60 * 60 * 1_000,
    updated_at: terminalStartedAtMs - 6 * 60 * 1_000,
    session_ref: { ...summary().session_ref, sourceSessionId: "thread-2" },
  });

  assert.deepEqual(select([older, resumed], new Set(), { kind: "last" }), {
    status: "resolved",
    sessionId: "thread-1",
    sourceInstanceId: "remote-source-1",
  });
});

// 验证最近会话并列或已绑定时保守拒绝绑定。
test("resume --last fails closed for a tied or already-bound latest session", () => {
  const tied = summary({
    session_id: "thread-2",
    session_ref: { ...summary().session_ref, sourceSessionId: "thread-2" },
  });
  assert.deepEqual(select([summary(), tied], new Set(), { kind: "last" }), {
    status: "ambiguous",
  });
  assert.deepEqual(select([summary()], new Set(["thread-1"]), { kind: "last" }), {
    status: "not_found",
  });
});

// 验证交互恢复缺少确定目标时不推断绑定。
test("interactive resume without a deterministic target fails closed", () => {
  assert.deepEqual(select([summary()], new Set(), { kind: "interactive" }), {
    status: "not_found",
  });
});

// 验证多个候选远程会话返回歧义状态。
test("multiple plausible remote sessions fail closed", () => {
  assert.deepEqual(select([
    summary(),
    summary({
      session_id: "thread-2",
      session_ref: { ...summary().session_ref, sourceSessionId: "thread-2" },
    }),
  ]), { status: "ambiguous" });
});
