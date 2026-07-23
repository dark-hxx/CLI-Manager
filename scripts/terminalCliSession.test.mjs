import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-session-rebind-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

const source = readFileSync(new URL("../src/stores/terminalCliSession.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const modulePath = join(tempDir, "terminalCliSession.mjs");
writeFileSync(modulePath, output, "utf8");
const { resolveCliSessionRebind } = await import(pathToFileURL(modulePath).href);

test("Codex /clear 后把同一 Tab 重新绑定到新会话 ID", () => {
  const initial = resolveCliSessionRebind(undefined, "old-session");
  assert.deepEqual(initial, { cliSessionId: "old-session", changed: true });

  const afterClear = resolveCliSessionRebind(initial.cliSessionId, " new-session ");
  assert.deepEqual(afterClear, { cliSessionId: "new-session", changed: true });

  const nextPrompt = resolveCliSessionRebind(afterClear.cliSessionId, "new-session");
  assert.deepEqual(nextPrompt, { cliSessionId: "new-session", changed: false });
});

test("空会话 ID 不覆盖当前绑定", () => {
  assert.deepEqual(resolveCliSessionRebind("current-session", "  "), {
    cliSessionId: "current-session",
    changed: false,
  });
});
