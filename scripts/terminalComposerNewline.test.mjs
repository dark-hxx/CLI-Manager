import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-composer-newline-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

function transpile(relativePath, outputName) {
  const output = ts.transpileModule(
    readFileSync(new URL(relativePath, import.meta.url), "utf8"),
    {
      compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
      fileName: outputName.replace(/\.mjs$/, ".ts"),
    },
  ).outputText;
  const outputPath = join(tempDir, outputName);
  writeFileSync(outputPath, output, "utf8");
  return outputPath;
}

const contextPath = transpile(
  "../src/terminal/browser/TerminalCliContext.ts",
  "TerminalCliContext.mjs",
);
const newlinePath = transpile(
  "../src/terminal/browser/TerminalNewlineShortcut.ts",
  "TerminalNewlineShortcut.mjs",
);

const {
  isGrokTerminalContext,
  isCodexTerminalContext,
  usesEscCrComposerNewline,
} = await import(pathToFileURL(contextPath).href);
const {
  resolveTerminalNewlineKeyEvent,
  ESC_CR_COMPOSER_NEWLINE,
  LF_NEWLINE,
} = await import(pathToFileURL(newlinePath).href);

const EMPTY = {
  projectTool: "",
  sessionTool: "",
  startupCmd: "",
  titleTool: "",
  outputHint: "",
};

const key = (overrides) => ({
  type: "keydown",
  key: "Enter",
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  ...overrides,
});

test("recognizes Grok from stable metadata and exact launch commands", () => {
  assert.equal(isGrokTerminalContext({ ...EMPTY, sessionTool: "grok" }), true);
  assert.equal(isGrokTerminalContext({ ...EMPTY, projectTool: "grokbuild" }), true);
  assert.equal(isGrokTerminalContext({ ...EMPTY, titleTool: "grok" }), true);
  assert.equal(isGrokTerminalContext({ ...EMPTY, startupCmd: "wsl grok --resume abc" }), true);
  assert.equal(isGrokTerminalContext({ ...EMPTY, startupCmd: "grok.exe" }), true);
  assert.equal(isGrokTerminalContext({ ...EMPTY, startupCmd: "'/opt/Grok Build/grok' --resume x" }), true);
  assert.equal(isGrokTerminalContext({ ...EMPTY, outputHint: "Welcome to Grok Build" }), false);
});

test("does not treat Kimi, Codex, or shell as Grok", () => {
  assert.equal(isGrokTerminalContext({ ...EMPTY, sessionTool: "kimi", startupCmd: "kimi --session 1" }), false);
  assert.equal(isCodexTerminalContext({ ...EMPTY, sessionTool: "codex" }), true);
  assert.equal(isGrokTerminalContext({ ...EMPTY, sessionTool: "codex", startupCmd: "codex" }), false);
  assert.equal(isGrokTerminalContext({ ...EMPTY, startupCmd: "pwsh" }), false);
});

test("Esc+CR composer newline is Codex or Grok only", () => {
  assert.equal(usesEscCrComposerNewline({ ...EMPTY, sessionTool: "grok" }), true);
  assert.equal(usesEscCrComposerNewline({ ...EMPTY, sessionTool: "codex" }), true);
  assert.equal(usesEscCrComposerNewline({ ...EMPTY, sessionTool: "kimi" }), false);
  assert.equal(usesEscCrComposerNewline(EMPTY), false);
});

test("Grok matched Shift+Enter writes Esc+CR", () => {
  assert.deepEqual(
    resolveTerminalNewlineKeyEvent(key({ shiftKey: true }), {
      shortcut: "Shift+Enter",
      usesEscCrComposerNewline: true,
    }),
    { action: "write", data: ESC_CR_COMPOSER_NEWLINE },
  );
});

test("Grok unmatched Alt+Enter is passed through", () => {
  assert.deepEqual(
    resolveTerminalNewlineKeyEvent(key({ altKey: true }), {
      shortcut: "Shift+Enter",
      usesEscCrComposerNewline: true,
    }),
    { action: "pass" },
  );
});

test("Grok matched Alt+Enter writes Esc+CR once", () => {
  assert.deepEqual(
    resolveTerminalNewlineKeyEvent(key({ altKey: true }), {
      shortcut: "Alt+Enter",
      usesEscCrComposerNewline: true,
    }),
    { action: "write", data: ESC_CR_COMPOSER_NEWLINE },
  );
});

test("Grok unmatched Shift+Enter is swallowed", () => {
  assert.deepEqual(
    resolveTerminalNewlineKeyEvent(key({ shiftKey: true }), {
      shortcut: "Alt+Enter",
      usesEscCrComposerNewline: true,
    }),
    { action: "swallow" },
  );
});

test("shell and Kimi keep LF and swallow unmatched Alt+Enter", () => {
  assert.deepEqual(
    resolveTerminalNewlineKeyEvent(key({ shiftKey: true }), {
      shortcut: "Shift+Enter",
      usesEscCrComposerNewline: false,
    }),
    { action: "write", data: LF_NEWLINE },
  );
  assert.deepEqual(
    resolveTerminalNewlineKeyEvent(key({ altKey: true }), {
      shortcut: "Shift+Enter",
      usesEscCrComposerNewline: false,
    }),
    { action: "swallow" },
  );
});

test("Alt+Shift+Enter is not a managed newline combo", () => {
  assert.deepEqual(
    resolveTerminalNewlineKeyEvent(key({ altKey: true, shiftKey: true }), {
      shortcut: "Shift+Enter",
      usesEscCrComposerNewline: true,
    }),
    { action: "none" },
  );
});

test("XTermTerminal uses the shared newline decision helper", () => {
  const componentSource = readFileSync(
    new URL("../src/components/XTermTerminal.tsx", import.meta.url),
    "utf8",
  );
  assert.match(componentSource, /resolveTerminalNewlineKeyEvent/);
  assert.match(componentSource, /isGrokSession\(/);
  assert.doesNotMatch(
    componentSource,
    /isCodexSession\([^)]*\) \? "\\x1b\\r" : "\\n"/,
  );
});
