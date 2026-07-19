import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-reflow-policy-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

const source = readFileSync(
  new URL("../src/terminal/browser/TerminalReflowPolicy.ts", import.meta.url),
  "utf8",
);
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "TerminalReflowPolicy.ts",
}).outputText;
const modulePath = join(tempDir, "TerminalReflowPolicy.mjs");
writeFileSync(modulePath, transpiled, "utf8");

const { shouldReflowTerminalCursorLine } = await import(pathToFileURL(modulePath).href);

test("macOS and Linux reflow the cursor line during live resize", () => {
  assert.equal(shouldReflowTerminalCursorLine({ os: "macos" }), true);
  assert.equal(shouldReflowTerminalCursorLine({ os: "linux" }), true);
});

test("direct Windows ConPTY keeps its compatibility reflow policy", () => {
  assert.equal(shouldReflowTerminalCursorLine({
    os: "windows",
    windowsPty: { backend: "conpty", usesConptyDll: false },
  }), false);
  assert.equal(shouldReflowTerminalCursorLine({
    os: "windows",
    windowsPty: { backend: "conpty", usesConptyDll: true },
  }), true);
});

test("unknown process traits do not opt into cursor-line reflow", () => {
  assert.equal(shouldReflowTerminalCursorLine(null), false);
  assert.equal(shouldReflowTerminalCursorLine({ os: "unknown" }), false);
});
