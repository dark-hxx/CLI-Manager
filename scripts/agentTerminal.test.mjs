import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-agent-terminal-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

const source = readFileSync(new URL("../src/lib/agentTerminal.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "agentTerminal.ts",
}).outputText;
const outputPath = join(tempDir, "agentTerminal.mjs");
writeFileSync(outputPath, output, "utf8");
const agentTerminal = await import(pathToFileURL(outputPath).href);

test("a configured CLI tool creates Agent terminal metadata", () => {
  assert.deepEqual(
    agentTerminal.createAgentTerminalMetadata({ cli_tool: " codex " }),
    { isAgentSession: true, cliTool: "codex" },
  );
  assert.deepEqual(
    agentTerminal.createAgentTerminalMetadata({ cli_tool: "custom-agent --flag" }),
    { isAgentSession: true, cliTool: "custom-agent --flag" },
  );
});

test("blank or missing CLI tools create regular terminal metadata", () => {
  assert.deepEqual(
    agentTerminal.createAgentTerminalMetadata({ cli_tool: "   " }),
    { isAgentSession: false, cliTool: undefined },
  );
  assert.deepEqual(
    agentTerminal.createAgentTerminalMetadata(undefined),
    { isAgentSession: false, cliTool: undefined },
  );
});

test("stored session classification wins over later project edits", () => {
  assert.deepEqual(
    agentTerminal.resolveAgentTerminalMetadata(
      { isAgentSession: false, cliTool: undefined },
      { cli_tool: "claude" },
    ),
    { isAgentSession: false, cliTool: undefined },
  );
  assert.deepEqual(
    agentTerminal.resolveAgentTerminalMetadata(
      { isAgentSession: true, cliTool: "codex" },
      { cli_tool: "" },
    ),
    { isAgentSession: true, cliTool: "codex" },
  );
});

test("legacy sessions fall back to the associated project CLI tool", () => {
  assert.deepEqual(
    agentTerminal.resolveAgentTerminalMetadata({}, { cli_tool: "opencode" }),
    { isAgentSession: true, cliTool: "opencode" },
  );
  assert.equal(agentTerminal.shouldIncludeAgentTerminal({}, { cli_tool: "" }, true), false);
  assert.equal(agentTerminal.shouldIncludeAgentTerminal({}, { cli_tool: "" }, false), true);
});
