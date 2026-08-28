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

const colorSource = readFileSync(new URL("../src/lib/terminalColor.ts", import.meta.url), "utf8");
writeFileSync(join(tempDir, "terminalColor.mjs"), ts.transpileModule(colorSource, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "terminalColor.ts",
}).outputText, "utf8");

const source = readFileSync(new URL("../src/lib/terminalTuiDisplay.ts", import.meta.url), "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "terminalTuiDisplay.ts",
}).outputText
  .replace('from "./terminalTui"', 'from "./terminalTui.mjs"')
  .replace('from "./terminalColor"', 'from "./terminalColor.mjs"');
const modulePath = join(tempDir, "terminalTuiDisplay.mjs");
writeFileSync(modulePath, transpiled, "utf8");

const { hasCodexTuiViewport, normalizeTerminalTuiComposerBackground } = await import(pathToFileURL(modulePath).href);

const XTERM_BG_COLOR_MASK = 0x03ffffff;
const XTERM_INVERSE_FLAG = 0x04000000;

function createMutableTerminal(cellAttrs) {
  const cells = cellAttrs.map(({ fg = 0, bg = 0 }) => ({ fg, bg }));
  const probe = {
    fg: 0,
    bg: 0,
    getBgColorMode() {
      return this.bg & 0x03000000;
    },
    isInverse() {
      return (this.fg & XTERM_INVERSE_FLAG) === 0 ? 0 : 1;
    },
  };
  const loadCell = (index, target) => {
    target.fg = cells[index].fg;
    target.bg = cells[index].bg;
    return target;
  };
  const line = {
    length: cells.length,
    translateToString: () => "Claude Code",
    getCell: loadCell,
    _line: {
      length: cells.length,
      loadCell,
      setCell: (index, cell) => {
        cells[index] = { fg: cell.fg, bg: cell.bg };
      },
    },
  };
  const refreshes = [];
  return {
    cells,
    refreshes,
    terminal: {
      cols: cells.length,
      rows: 1,
      buffer: {
        active: {
          viewportY: 0,
          getNullCell: () => probe,
          getLine: () => line,
        },
      },
      refresh: (start, end) => refreshes.push([start, end]),
    },
  };
}

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

test("transparent Claude normalization preserves an isolated inverse software cursor", () => {
  const fixture = createMutableTerminal([
    { bg: 0x03010203 },
    { fg: XTERM_INVERSE_FLAG },
    {},
    {},
    {},
    {},
    {},
    {},
  ]);

  normalizeTerminalTuiComposerBackground(fixture.terminal, {
    shouldNormalize: true,
    isTransparent: true,
    isLightTheme: false,
    isCodexSession: false,
    isClaudeSession: true,
  });

  assert.equal(fixture.cells[0].bg & XTERM_BG_COLOR_MASK, 0);
  assert.equal(fixture.cells[1].fg & XTERM_INVERSE_FLAG, XTERM_INVERSE_FLAG);
  assert.deepEqual(fixture.refreshes, [[0, 0]]);
});

test("transparent TUI normalization still clears wide inverse backgrounds", () => {
  const fixture = createMutableTerminal([
    { fg: XTERM_INVERSE_FLAG },
    { fg: XTERM_INVERSE_FLAG },
    { fg: XTERM_INVERSE_FLAG },
    { fg: XTERM_INVERSE_FLAG },
    {},
    {},
    {},
    {},
  ]);

  normalizeTerminalTuiComposerBackground(fixture.terminal, {
    shouldNormalize: true,
    isTransparent: true,
    isLightTheme: false,
    isCodexSession: true,
    isClaudeSession: false,
  });

  assert.equal(fixture.cells.some((cell) => (cell.fg & XTERM_INVERSE_FLAG) !== 0), false);
  assert.deepEqual(fixture.refreshes, [[0, 0]]);
});

const XTERM_COLOR_MODE_RGB = 0x03000000;
const XTERM_COLOR_MODE_PALETTE_256 = 0x02000000;
const rgbBackground = (color) => XTERM_COLOR_MODE_RGB | color;
const paletteBackground = (index) => XTERM_COLOR_MODE_PALETTE_256 | index;

function createAttributeCell() {
  return {
    fg: 0,
    bg: 0,
    getBgColorMode() {
      return this.bg & XTERM_COLOR_MODE_RGB;
    },
    getFgColorMode() {
      return this.fg & XTERM_COLOR_MODE_RGB;
    },
    isBgRGB() {
      return (this.bg & XTERM_COLOR_MODE_RGB) === XTERM_COLOR_MODE_RGB;
    },
    getBgColor() {
      return this.bg & 0x00ffffff;
    },
    isInverse() {
      return (this.fg & XTERM_INVERSE_FLAG) === 0 ? 0 : 1;
    },
    isBold() {
      return 0;
    },
    isDim() {
      return 0;
    },
    getWidth() {
      return 1;
    },
    getChars() {
      return "x";
    },
  };
}

// Multi-row viewport fixture with a full cell-attribute probe, for the light-theme
// dark-block erase pass. `rows` is [{ text, cells: [{ fg, bg }] }].
function createViewportTerminal(rows, theme) {
  const rowCells = rows.map(({ cells }) => cells.map(({ fg = 0, bg = 0 }) => ({ fg, bg })));
  const probe = createAttributeCell();
  const lines = rows.map((row, index) => {
    const cells = rowCells[index];
    const loadCell = (x, target) => {
      target.fg = cells[x].fg;
      target.bg = cells[x].bg;
      return target;
    };
    return {
      length: cells.length,
      isWrapped: false,
      translateToString: () => row.text,
      getCell: loadCell,
      _line: {
        length: cells.length,
        loadCell,
        setCell: (x, cell) => {
          cells[x] = { fg: cell.fg, bg: cell.bg };
        },
      },
    };
  });
  const refreshes = [];
  return {
    rowCells,
    refreshes,
    terminal: {
      cols: Math.max(...rowCells.map((cells) => cells.length)),
      rows: lines.length,
      options: { theme },
      buffer: {
        active: {
          viewportY: 0,
          baseY: 0,
          cursorY: 0,
          getNullCell: () => probe,
          getLine: (row) => lines[row],
        },
      },
      refresh: (start, end) => refreshes.push([start, end]),
    },
  };
}

function eraseDarkBlocks(fixture, overrides = {}) {
  normalizeTerminalTuiComposerBackground(fixture.terminal, {
    shouldNormalize: true,
    isTransparent: false,
    isLightTheme: true,
    isTuiSession: false,
    isCodexSession: false,
    isClaudeSession: false,
    shouldEraseDarkBlocks: true,
    ...overrides,
  });
}

test("shared CLI context includes immutable session metadata for XTermTerminal", () => {
  const componentSource = readFileSync(new URL("../src/components/XTermTerminal.tsx", import.meta.url), "utf8");
  const contextSource = readFileSync(new URL("../src/terminal/browser/TerminalCliContext.ts", import.meta.url), "utf8");
  assert.match(componentSource, /createTerminalCliContext\(session, project\)/u);
  assert.match(contextSource, /sessionTool:\s*session\?\.cliTool/u);
  assert.match(contextSource, /sessionTool\s*===\s*"codex"/u);
  assert.match(componentSource, /isCodexSession\(getSessionToolContext\(\), terminal\)/u);
});

test("light theme erases a dark CLI message block and keeps light highlights", () => {
  const fixture = createViewportTerminal([{
    text: "> light terminal prompt",
    cells: [
      { bg: rgbBackground(0x1f1f1f) },
      { bg: rgbBackground(0x1f1f1f) },
      { bg: rgbBackground(0x1f1f1f) },
      { bg: rgbBackground(0x1f1f1f) },
      { bg: rgbBackground(0x1f1f1f) },
      { bg: rgbBackground(0x1f1f1f) },
      { bg: rgbBackground(0xe7eefc) },
      { bg: rgbBackground(0xe7eefc) },
    ],
  }]);

  eraseDarkBlocks(fixture);

  assert.deepEqual(fixture.rowCells[0].map((cell) => cell.bg), [
    0, 0, 0, 0, 0, 0,
    rgbBackground(0xe7eefc),
    rgbBackground(0xe7eefc),
  ]);
  assert.deepEqual(fixture.refreshes, [[0, 0]]);
});

test("light theme keeps colored badges and short dark runs such as a block cursor", () => {
  const badge = rgbBackground(0xd70000);
  const cursor = rgbBackground(0x000000);
  const fixture = createViewportTerminal([
    {
      text: "ERROR badge",
      cells: [{ bg: badge }, { bg: badge }, { bg: badge }, { bg: badge }, {}, {}, {}, {}],
    },
    {
      text: "> typing",
      cells: [{}, {}, { bg: cursor }, { bg: cursor }, {}, {}, {}, {}],
    },
  ]);

  eraseDarkBlocks(fixture);

  assert.deepEqual(fixture.rowCells[0].map((cell) => cell.bg), [badge, badge, badge, badge, 0, 0, 0, 0]);
  assert.deepEqual(fixture.rowCells[1].map((cell) => cell.bg), [0, 0, cursor, cursor, 0, 0, 0, 0]);
  assert.deepEqual(fixture.refreshes, []);
});

test("light theme resolves 256-color and ANSI block backgrounds through the active theme", () => {
  const grayRamp = paletteBackground(235);
  const brightWhite = paletteBackground(15);
  const fixture = createViewportTerminal([{
    text: "> palette block",
    cells: [
      { bg: grayRamp },
      { bg: grayRamp },
      { bg: grayRamp },
      { bg: grayRamp },
      { bg: brightWhite },
      { bg: brightWhite },
      { bg: brightWhite },
      { bg: brightWhite },
    ],
  }], { black: "#000000", brightWhite: "#f5f5f5" });

  eraseDarkBlocks(fixture);

  assert.deepEqual(fixture.rowCells[0].map((cell) => cell.bg), [
    0, 0, 0, 0, brightWhite, brightWhite, brightWhite, brightWhite,
  ]);
});

test("light theme clears a wide inverse block but keeps an isolated inverse cursor", () => {
  const fixture = createViewportTerminal([
    {
      text: "> submitted message",
      cells: [
        { fg: XTERM_INVERSE_FLAG },
        { fg: XTERM_INVERSE_FLAG },
        { fg: XTERM_INVERSE_FLAG },
        { fg: XTERM_INVERSE_FLAG },
        {},
        {},
        {},
        {},
      ],
    },
    {
      text: "> typing",
      cells: [{}, { fg: XTERM_INVERSE_FLAG }, {}, {}, {}, {}, {}, {}],
    },
  ]);

  eraseDarkBlocks(fixture);

  assert.equal(fixture.rowCells[0].some((cell) => (cell.fg & XTERM_INVERSE_FLAG) !== 0), false);
  assert.equal(fixture.rowCells[1][1].fg & XTERM_INVERSE_FLAG, XTERM_INVERSE_FLAG);
  assert.deepEqual(fixture.refreshes, [[0, 0]]);
});

test("dark themes keep CLI block backgrounds untouched", () => {
  const block = rgbBackground(0x1f1f1f);
  const fixture = createViewportTerminal([{
    text: "> dark theme prompt",
    cells: [{ bg: block }, { bg: block }, { bg: block }, { bg: block }, {}, {}, {}, {}],
  }]);

  eraseDarkBlocks(fixture, {
    shouldNormalize: false,
    isLightTheme: false,
    shouldEraseDarkBlocks: false,
  });

  assert.deepEqual(fixture.rowCells[0].map((cell) => cell.bg), [block, block, block, block, 0, 0, 0, 0]);
  assert.deepEqual(fixture.refreshes, []);
});
