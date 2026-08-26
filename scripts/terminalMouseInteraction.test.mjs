import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-terminal-mouse-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

const source = readFileSync(
  new URL("../src/terminal/browser/TerminalMouseInteraction.ts", import.meta.url),
  "utf8",
);
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "TerminalMouseInteraction.ts",
}).outputText;
const modulePath = join(tempDir, "TerminalMouseInteraction.mjs");
writeFileSync(modulePath, transpiled, "utf8");

const { createTerminalMouseInteractionOptions } = await import(
  pathToFileURL(modulePath).href
);

test("mouse-aware TUIs receive unmodified click and drag reports", () => {
  assert.deepEqual(createTerminalMouseInteractionOptions(), {
    mouseEventsRequireAlt: false,
  });
});

test("XTermTerminal delegates mouse policy to the browser module", () => {
  const terminalComponentSource = readFileSync(
    new URL("../src/components/XTermTerminal.tsx", import.meta.url),
    "utf8",
  );

  assert.match(
    terminalComponentSource,
    /\.\.\.createTerminalMouseInteractionOptions\(\)/,
  );
  assert.doesNotMatch(terminalComponentSource, /mouseEventsRequireAlt/);
});
