import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-ime-anchor-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

function transpile(relativePath, outputName, replacements = {}) {
  let output = ts.transpileModule(
    readFileSync(new URL(relativePath, import.meta.url), "utf8"),
    {
      compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
      fileName: outputName.replace(/\.mjs$/, ".ts"),
    },
  ).outputText;
  for (const [from, to] of Object.entries(replacements)) {
    output = output.replaceAll(`from "${from}"`, `from "${to}"`);
  }
  const outputPath = join(tempDir, outputName);
  writeFileSync(outputPath, output, "utf8");
  return outputPath;
}

transpile("../src/lib/terminalTui.ts", "terminalTui.mjs");
const anchorPath = transpile(
  "../src/lib/terminalImeAnchor.ts",
  "terminalImeAnchor.mjs",
  { "./terminalTui": "./terminalTui.mjs" },
);
const { resolveClaudeImeCompositionAnchor, resolveTerminalImeCompositionAnchor } = await import(pathToFileURL(anchorPath).href);

function terminalWithLines(lines, cursor, inverseCells = []) {
  const cols = Math.max(1, ...lines.map((line) => line.length), ...inverseCells.map(({ x }) => x + 1));
  const inverseKeys = new Set(inverseCells.map(({ x, y }) => `${x}:${y}`));
  return {
    cols,
    rows: lines.length,
    buffer: {
      active: {
        cursorX: cursor.x,
        cursorY: cursor.y,
        viewportY: 0,
        getLine(row) {
          const text = lines[row];
          if (text === undefined) return undefined;
          return {
            length: cols,
            translateToString: () => text,
            getCell(x) {
              const chars = text[x] ?? "";
              return {
                getChars: () => chars,
                getWidth: () => 1,
                isInverse: () => inverseKeys.has(`${x}:${row}`) ? 1 : 0,
              };
            },
          };
        },
      },
    },
  };
}

test("real cursor inside the composer wins over unrelated inverse cells", () => {
  const terminal = terminalWithLines(
    ["output", "> ", "                         ", "─────────────────────────", "status"],
    { x: 2, y: 1 },
    [{ x: 24, y: 2 }],
  );

  assert.deepEqual(resolveTerminalImeCompositionAnchor(terminal), { x: 2, y: 1 });
});

test("Claude IME follows its isolated software cursor after deleting text", () => {
  const terminal = terminalWithLines(
    ["output", "> 水电          ", "──────────────", "status"],
    { x: 13, y: 1 },
    [{ x: 5, y: 1 }],
  );

  const fallback = resolveTerminalImeCompositionAnchor(terminal);
  assert.deepEqual(fallback, { x: 13, y: 1 });
  assert.deepEqual(resolveClaudeImeCompositionAnchor(terminal, fallback), { x: 5, y: 1 });
});

test("Claude IME ignores inverse spans that are not a software cursor", () => {
  const terminal = terminalWithLines(
    ["output", "> hello", "menu", "────────", "status"],
    { x: 7, y: 1 },
    [{ x: 1, y: 2 }, { x: 2, y: 2 }],
  );

  assert.deepEqual(resolveClaudeImeCompositionAnchor(terminal, { x: 7, y: 1 }), { x: 7, y: 1 });
});

test("prompt fallback remains available when a TUI redraw moves the cursor outside", () => {
  const terminal = terminalWithLines(
    ["output", "> hello", "", "────────", "status"],
    { x: 3, y: 4 },
  );

  assert.deepEqual(resolveTerminalImeCompositionAnchor(terminal), { x: 7, y: 1 });
});

test("shell input without a recognized composer keeps the live cursor", () => {
  const terminal = terminalWithLines(["plain shell", ""], { x: 4, y: 1 });

  assert.deepEqual(resolveTerminalImeCompositionAnchor(terminal), { x: 4, y: 1 });
});
