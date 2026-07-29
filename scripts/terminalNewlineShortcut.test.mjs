import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-terminal-newline-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

writeFileSync(join(tempDir, "terminalTui.mjs"), `
export const TUI_BORDER_PREFIX_PATTERN = /^$/;
export const TUI_COMPOSER_PROMPT_PATTERN = /^$/;
`);

const source = readFileSync(new URL("../src/lib/terminalTuiDisplay.ts", import.meta.url), "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "terminalTuiDisplay.ts",
}).outputText.replace('from "./terminalTui"', 'from "./terminalTui.mjs"');
const modulePath = join(tempDir, "terminalTuiDisplay.mjs");
writeFileSync(modulePath, transpiled, "utf8");

const { hasCodexTuiViewport } = await import(pathToFileURL(modulePath).href);

function createTerminal(lines, viewportY = 0, rows = lines.length, type = "normal") {
  const bufferLines = lines.map((text) => ({
    translateToString: () => text,
  }));
  return {
    rows,
    buffer: {
      active: {
        type,
        viewportY,
        getLine: (row) => bufferLines[row],
      },
    },
  };
}

test("detects a manually launched Codex TUI from its visible viewport", () => {
  assert.equal(hasCodexTuiViewport(createTerminal(["OpenAI Codex", "› prompt"])), true);
  assert.equal(hasCodexTuiViewport(createTerminal(["› prompt", "/model to change"])), true);
  assert.equal(hasCodexTuiViewport(createTerminal(["OpenAI Codex", "› prompt"], 0, 2, "alternate")), true);
});

test("does not classify ordinary shells or Claude Code as Codex", () => {
  assert.equal(hasCodexTuiViewport(createTerminal(["PS F:\\\\github\\\\CLI-Manager>"])), false);
  assert.equal(hasCodexTuiViewport(createTerminal(["Claude Code", "› prompt"])), false);
});

test("only scans the current viewport", () => {
  const terminal = createTerminal(["OpenAI Codex", "PS F:\\\\github>", "ready"], 1, 2);
  assert.equal(hasCodexTuiViewport(terminal), false);
});

test("XTermTerminal includes immutable session CLI metadata in Codex detection", () => {
  const componentSource = readFileSync(new URL("../src/components/XTermTerminal.tsx", import.meta.url), "utf8");
  assert.match(componentSource, /sessionTool:\s*session\?\.cliTool/u);
  assert.match(componentSource, /context\.sessionTool\s*===\s*"codex"/u);
  assert.match(componentSource, /isCodexSession\(getSessionToolContext\(\), terminal\)/u);
});
