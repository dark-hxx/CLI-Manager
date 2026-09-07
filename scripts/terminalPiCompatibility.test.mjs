import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-pi-terminal-"));
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

const contextPath = transpile(
  "../src/terminal/browser/TerminalCliContext.ts",
  "TerminalCliContext.mjs",
);
const ansiPath = transpile(
  "../src/terminal/browser/TerminalPiAnsiTransform.ts",
  "TerminalPiAnsiTransform.mjs",
);
transpile("../src/lib/terminalTui.ts", "terminalTui.mjs");
transpile(
  "../src/terminal/browser/TerminalPiIme.ts",
  "TerminalPiIme.mjs",
  { "../../lib/terminalTui": "./terminalTui.mjs" },
);
transpile("../src/terminal/browser/TerminalPiDiagnostics.ts", "TerminalPiDiagnostics.mjs");
const compatibilityPath = transpile(
  "../src/terminal/browser/TerminalPiCompatibility.ts",
  "TerminalPiCompatibility.mjs",
  {
    "./TerminalCliContext": "./TerminalCliContext.mjs",
    "./TerminalPiAnsiTransform": "./TerminalPiAnsiTransform.mjs",
    "./TerminalPiDiagnostics": "./TerminalPiDiagnostics.mjs",
    "./TerminalPiIme": "./TerminalPiIme.mjs",
  },
);

const { isPiTerminalContext } = await import(pathToFileURL(contextPath).href);
const { createPiAnsiTransform, isPiToolBackgroundRgb } = await import(pathToFileURL(ansiPath).href);
const {
  createPiTerminalCompatibility,
  resolvePiImeCompositionAnchor,
  resolvePiImeTextareaAnchor,
} = await import(
  pathToFileURL(compatibilityPath).href
);

const PI_CONTEXT = {
  projectTool: "pi",
  sessionTool: "pi",
  startupCmd: "pi",
  titleTool: "",
  outputHint: "",
};

test("recognizes Pi from registered context without matching pip", () => {
  assert.equal(isPiTerminalContext(PI_CONTEXT), true);
  assert.equal(isPiTerminalContext({ ...PI_CONTEXT, projectTool: "", sessionTool: "", startupCmd: "pi.ps1 --model test" }), true);
  assert.equal(isPiTerminalContext({ ...PI_CONTEXT, projectTool: "", sessionTool: "", startupCmd: "pip install pi" }), false);
  assert.equal(isPiTerminalContext({
    ...PI_CONTEXT,
    projectTool: "codex",
    sessionTool: "",
    startupCmd: "powershell",
    outputHint: "\x1b[38;5;109;1mpi\x1b[38;5;241;22m v0.82.1",
  }), true);
});

test("diagnostics detect Pi across daemon frames but stay silent when disabled", () => {
  const events = [];
  const compatibility = createPiTerminalCompatibility("session-177", (_, payload) => events.push(payload), true);
  compatibility.updateContext({ ...PI_CONTEXT, projectTool: "codex", sessionTool: "", startupCmd: "powershell" });
  const frame = { kind: "output", sessionId: "session-177", cols: 80, rows: 24, data: new Uint8Array() };
  compatibility.onFrame({ ...frame, sequence: 1 }, "\x1b[38;5;109;1mpi v0.", "");
  compatibility.onFrame({ ...frame, sequence: 2 }, "82.1\r\n", "");
  assert.equal(events.length, 1);
  assert.equal(events[0].sequence, 2);

  const disabledEvents = [];
  const disabled = createPiTerminalCompatibility("session-177", (_, payload) => disabledEvents.push(payload), false);
  disabled.updateContext(PI_CONTEXT);
  disabled.onFrame({ ...frame, sequence: 3 }, "PI177-DISABLED", "PI177-DISABLED");
  assert.deepEqual(disabledEvents, []);
});

function terminalWithLines(lines, cursor = { x: 0, y: 0 }, inverseCells = [], viewportY = 0) {
  const visibleLines = lines.slice(viewportY);
  const cols = Math.max(1, ...visibleLines.map((line) => line.length), cursor.x + 1);
  const inverseKeys = new Set(inverseCells.map(({ x, y }) => `${x}:${y + viewportY}`));
  return {
    cols,
    rows: visibleLines.length,
    buffer: {
      active: {
        cursorX: cursor.x,
        cursorY: cursor.y,
        viewportY,
        getLine(row) {
          const text = lines[row];
          if (text === undefined) return undefined;
          return {
            length: cols,
            translateToString: () => text,
            getCell(x) {
              return {
                isInverse: () => inverseKeys.has(`${x}:${row}`) ? 1 : 0,
              };
            },
          };
        },
      },
    },
  };
}

test("Pi IME resolves the editor input row before its textarea bottom border", () => {
  const terminal = terminalWithLines(
    ["hardware cursor", "────────", "  input", "", "────────", "status"],
    { x: 1, y: 0 },
    [{ x: 7, y: 2 }],
  );
  const fallback = { x: 1, y: 0 };
  const compositionAnchor = resolvePiImeCompositionAnchor(terminal, fallback);

  assert.deepEqual(compositionAnchor, { x: 7, y: 2 });
  assert.deepEqual(resolvePiImeTextareaAnchor(terminal, compositionAnchor), { x: 7, y: 4 });
});

test("Pi IME prefers the visible inverse cursor over a stale hardware cursor inside the editor", () => {
  const terminal = terminalWithLines(
    ["output", "────────", "  input", "", "────────", "status"],
    { x: 79, y: 2 },
    [{ x: 4, y: 2 }],
  );

  assert.deepEqual(resolvePiImeCompositionAnchor(terminal, { x: 0, y: 0 }), { x: 4, y: 2 });
});

test("Pi IME keeps the live cursor inside the editor when no software cursor is visible", () => {
  const terminal = terminalWithLines(
    ["output", "────────", "  input", "", "────────", "status"],
    { x: 4, y: 3 },
  );

  assert.deepEqual(resolvePiImeCompositionAnchor(terminal, { x: 0, y: 0 }), { x: 4, y: 3 });
});

test("Pi IME ignores a resized status cursor and inverse cells outside paired rules", () => {
  const terminal = terminalWithLines(
    ["────────", "old output", "────────", "────────", "  input", "────────", "inverse status"],
    { x: 30, y: 6 },
    [{ x: 5, y: 4 }, { x: 1, y: 6 }],
  );
  const compositionAnchor = resolvePiImeCompositionAnchor(terminal, { x: 30, y: 6 });

  assert.deepEqual(compositionAnchor, { x: 5, y: 4 });
  assert.deepEqual(resolvePiImeTextareaAnchor(terminal, compositionAnchor), { x: 5, y: 5 });
});

test("Pi IME chooses the bottom-most active pair over output separators", () => {
  const terminal = terminalWithLines(
    ["────────", "old output", "────────", "────────", " input", "────────", "status"],
    { x: 3, y: 1 },
    [{ x: 6, y: 4 }],
  );

  assert.deepEqual(resolvePiImeCompositionAnchor(terminal, { x: 3, y: 1 }), { x: 6, y: 4 });
});

test("Pi IME recognizes a scrolling rule inside the visible viewport", () => {
  const terminal = terminalWithLines(
    ["scrollback", "scrollback", "── 2 lines above ──", " input", "────────", "status"],
    { x: 1, y: 1 },
    [],
    2,
  );

  assert.deepEqual(resolvePiImeCompositionAnchor(terminal, { x: 0, y: 3 }), { x: 1, y: 1 });
  assert.deepEqual(resolvePiImeTextareaAnchor(terminal, { x: 1, y: 1 }), { x: 1, y: 2 });
});

test("Pi IME preserves fallback anchors without a valid editor", () => {
  const anchor = { x: 3, y: 1 };
  assert.deepEqual(
    resolvePiImeCompositionAnchor(terminalWithLines(["output", "status"], { x: 1, y: 0 }), anchor),
    anchor,
  );
  assert.deepEqual(resolvePiImeTextareaAnchor(terminalWithLines(["output", "status"]), anchor), anchor);

  const nonPi = createPiTerminalCompatibility("shell", () => {}, false);
  const editor = terminalWithLines(["────", " input", "────"], { x: 2, y: 1 });
  assert.deepEqual(nonPi.resolveImeCompositionAnchor(editor, anchor), anchor);
  assert.deepEqual(nonPi.resolveImeTextareaAnchor(editor, anchor), anchor);
});

test("matches all built-in Pi RGB tool backgrounds only", () => {
  for (const color of [0x282832, 0x283228, 0x3c2828, 0xe8e8f0, 0xe8f0e8, 0xf0e8e8]) {
    assert.equal(isPiToolBackgroundRgb(color), true);
  }
  assert.equal(isPiToolBackgroundRgb(0x343541), false);
  assert.equal(isPiToolBackgroundRgb(0xe8e8e8), false);
});

test("ANSI transform clears RGB tool backgrounds and preserves other attributes", () => {
  const transform = createPiAnsiTransform();
  const input = [
    "\x1b[1;38;2;1;2;3;48;2;40;40;50mPending",
    "\x1b[48;2;40;50;40mSuccess",
    "\x1b[48:2::60:40:40mError",
    "\x1b[48;2;52;53;65mUser",
    "\x1b[48;2;1;2;3mCustom",
  ].join("");
  assert.equal(
    transform.transform(input),
    [
      "\x1b[1;38;2;1;2;3;49mPending",
      "\x1b[49mSuccess",
      "\x1b[49mError",
      "\x1b[48;2;52;53;65mUser",
      "\x1b[48;2;1;2;3mCustom",
    ].join(""),
  );
});

test("ANSI transform applies only unambiguous 256-color fallback values", () => {
  const transform = createPiAnsiTransform();
  assert.equal(
    transform.transform("\x1b[48;5;22mA\x1b[48;5;52mB\x1b[48;5;255mC\x1b[48;5;17mD\x1b[48;5;254mE"),
    "\x1b[49mA\x1b[49mB\x1b[49mC\x1b[48;5;17mD\x1b[48;5;254mE",
  );
});

test("ANSI transform survives every CSI frame split and reset drops fragments", () => {
  const sequence = "\x1b[38;2;9;8;7;48;2;240;232;232mError";
  for (let split = 1; split < sequence.length; split += 1) {
    const transform = createPiAnsiTransform();
    assert.equal(transform.transform(sequence.slice(0, split)) + transform.transform(sequence.slice(split)), "\x1b[38;2;9;8;7;49mError");
  }

  const transform = createPiAnsiTransform();
  assert.equal(transform.transform("before\x1b[48;2;40"), "before");
  transform.reset();
  assert.equal(transform.transform(";50;40mafter"), ";50;40mafter");
});

test("Pi facade transforms active sessions and leaves non-Pi sessions byte-for-byte", () => {
  const pi = createPiTerminalCompatibility("pi", () => {}, false);
  pi.updateContext(PI_CONTEXT);
  assert.equal(pi.shouldRefreshImeCompositionAnchor(), true);
  assert.equal(pi.transformOutput("\x1b[48;2;40;50;40mtool"), "\x1b[49mtool");

  const shell = createPiTerminalCompatibility("shell", () => {}, false);
  assert.equal(shell.shouldRefreshImeCompositionAnchor(), false);
  const input = "\x1b[48;2;40;50;40mcustom";
  assert.equal(shell.transformOutput(input), input);
});

test("live, replay, reset, and serialized snapshot use the shared transform", () => {
  const displaySource = readFileSync(new URL("../src/hooks/useTerminalDisplay.ts", import.meta.url), "utf8");
  const componentSource = readFileSync(new URL("../src/components/XTermTerminal.tsx", import.meta.url), "utf8");
  assert.match(displaySource, /const transformed = transformOutputRef\.current\(combined\);/);
  assert.match(displaySource, /const transformed = transformOutputRef\.current\(text\);/);
  assert.match(displaySource, /if \(first\.reset\) \{\s*outputDiagnosticsRef\?\.current\?\.reset\(\);/);
  assert.match(componentSource, /const restoredOutput = displayTransformOutputRef\.current\(initialTerminalOutput\);[\s\S]*?terminal\.write\(`\$\{restoredOutput\}/);
  assert.match(componentSource, /displayTransformOutputRef\.current = \(text\) => processCodexCursorVisibility\(/);
  assert.match(componentSource, /const processCodexCursorVisibility = \(text: string\) =>/);
  assert.match(componentSource, /hideCodexRuntimeCursorRef\.current/);
  assert.match(componentSource, /codexSessionDetectedRef\.current = true/);
  assert.match(componentSource, /const focusTerminalWithCodexCursorPolicy = \(terminal: Terminal\) =>/);
  assert.doesNotMatch(componentSource, /stabilizeCodexCursorVisibility|codexVisualCursor|resolveStableTuiCursorAnchor/);
  assert.doesNotMatch(componentSource, /normalizeToolBackgrounds|toolPendingBg|toolSuccessBg|toolErrorBg/);
});
