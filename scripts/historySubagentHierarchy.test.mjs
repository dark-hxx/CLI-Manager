import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-history-subagent-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

const source = readFileSync(
  new URL("../src/lib/historySubagents.ts", import.meta.url),
  "utf8"
);
const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const outputPath = join(tempDir, "historySubagents.mjs");
writeFileSync(outputPath, output, "utf8");

const { inferSubagentParentSessionId } = await import(pathToFileURL(outputPath).href);

function session(overrides = {}) {
  return {
    session_id: "child",
    file_path: "C:/history/rollout-child.jsonl",
    ...overrides,
  };
}

test("uses Codex parent metadata for rollout sessions", () => {
  assert.equal(
    inferSubagentParentSessionId(session({ parent_session_id: "parent" })),
    "parent"
  );
});

test("keeps Claude path-based parent inference compatible", () => {
  assert.equal(
    inferSubagentParentSessionId(
      session({
        file_path: "C:/history/parent/subagents/agent-child.jsonl",
      })
    ),
    "parent"
  );
});

test("does not create self or missing-parent relationships", () => {
  assert.equal(
    inferSubagentParentSessionId(session({ parent_session_id: "child" })),
    null
  );
  assert.equal(inferSubagentParentSessionId(session()), null);
});
