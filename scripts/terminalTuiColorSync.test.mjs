import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-terminal-tui-color-sync-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

const originalWindow = globalThis.window;
const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
let nextAnimationFrameId = 1;
const animationFrames = new Map();

globalThis.window = globalThis;
globalThis.requestAnimationFrame = (callback) => {
  const frameId = nextAnimationFrameId++;
  animationFrames.set(frameId, callback);
  return frameId;
};
globalThis.cancelAnimationFrame = (frameId) => {
  animationFrames.delete(frameId);
};

function flushNextAnimationFrame() {
  const nextFrame = animationFrames.entries().next();
  assert.equal(nextFrame.done, false, "expected a scheduled animation frame");
  const [frameId, callback] = nextFrame.value;
  animationFrames.delete(frameId);
  callback(performance.now());
}

test.after(() => {
  animationFrames.clear();
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
  if (originalRequestAnimationFrame === undefined) delete globalThis.requestAnimationFrame;
  else globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  if (originalCancelAnimationFrame === undefined) delete globalThis.cancelAnimationFrame;
  else globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
});

writeFileSync(join(tempDir, "terminalTuiDisplay.mjs"), `
export let normalizeCalls = 0;
export let lastNormalizeOptions = null;
export let knownAiTuiViewport = false;
export function resetNormalizeCalls() { normalizeCalls = 0; lastNormalizeOptions = null; }
export function setKnownAiTuiViewport(value) { knownAiTuiViewport = value; }
export function hasCodexTuiViewport() { return false; }
export function hasKnownAiTuiViewport() { return knownAiTuiViewport; }
export function hasTuiComposerPromptViewport() { return false; }
export function normalizeTerminalTuiComposerBackground(terminal, options) {
  normalizeCalls += 1;
  lastNormalizeOptions = options;
}
`);
writeFileSync(join(tempDir, "TerminalCliContext.mjs"), `
export let claudeContext = false;
export let piContext = false;
export function setDetectedContexts({ claude = false, pi = false } = {}) {
  claudeContext = claude;
  piContext = pi;
}
export function isClaudeTerminalContext() { return claudeContext; }
export function isCodexTerminalContext() { return false; }
export function isPiTerminalContext() { return piContext; }
`);

const source = readFileSync(new URL("../src/lib/terminalTuiColorSync.ts", import.meta.url), "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "terminalTuiColorSync.ts",
}).outputText
  .replace('from "./terminalTuiDisplay"', 'from "./terminalTuiDisplay.mjs"')
  .replace('from "../terminal/browser/TerminalCliContext"', 'from "./TerminalCliContext.mjs"');
const modulePath = join(tempDir, "terminalTuiColorSync.mjs");
writeFileSync(modulePath, transpiled, "utf8");

const { createTerminalTuiColorSyncController } = await import(pathToFileURL(modulePath).href);
const tuiDisplayStub = await import(pathToFileURL(join(tempDir, "terminalTuiDisplay.mjs")).href);
const cliContextStub = await import(pathToFileURL(join(tempDir, "TerminalCliContext.mjs")).href);

function createOptions() {
  return {
    isVisible: false,
    isTransparent: false,
    isLightTheme: false,
    terminalTextColor: undefined,
    tuiUserColor: undefined,
    tuiAssistantColor: undefined,
    getContext: () => ({}),
  };
}

test("hidden terminal skips direct TUI color scanning until it becomes visible", (t) => {
  tuiDisplayStub.resetNormalizeCalls();
  const options = createOptions();
  const controller = createTerminalTuiColorSyncController(() => options);
  t.after(() => controller.dispose());

  controller.normalize({});
  assert.equal(tuiDisplayStub.normalizeCalls, 0);

  options.isVisible = true;
  controller.normalize({});
  assert.equal(tuiDisplayStub.normalizeCalls, 1);
});

test("hidden terminal skips scheduled TUI color scanning until it becomes visible", (t) => {
  tuiDisplayStub.resetNormalizeCalls();
  const options = {
    ...createOptions(),
  };
  const controller = createTerminalTuiColorSyncController(() => options);
  t.after(() => controller.dispose());

  controller.schedule({});
  flushNextAnimationFrame();
  assert.equal(tuiDisplayStub.normalizeCalls, 0);

  options.isVisible = true;
  controller.schedule({});
  flushNextAnimationFrame();
  assert.equal(tuiDisplayStub.normalizeCalls, 1);
});

test("light theme Claude and Pi sessions request dark block erasure without a TUI signature", (t) => {
  tuiDisplayStub.resetNormalizeCalls();
  cliContextStub.setDetectedContexts({ pi: true });
  t.after(() => cliContextStub.setDetectedContexts());
  const options = { ...createOptions(), isVisible: true, isLightTheme: true };
  const controller = createTerminalTuiColorSyncController(() => options);
  t.after(() => controller.dispose());

  controller.normalize({});
  assert.equal(tuiDisplayStub.lastNormalizeOptions.shouldEraseDarkBlocks, true);
  assert.equal(tuiDisplayStub.lastNormalizeOptions.shouldNormalize, true);
  assert.equal(tuiDisplayStub.lastNormalizeOptions.isClaudeSession, false);
  assert.equal(tuiDisplayStub.lastNormalizeOptions.isTuiSession, false);

  cliContextStub.setDetectedContexts({ claude: true });
  controller.normalize({});
  assert.equal(tuiDisplayStub.lastNormalizeOptions.shouldEraseDarkBlocks, true);
});

test("light theme plain shell erases dark blocks once an AI TUI signature is latched", (t) => {
  tuiDisplayStub.resetNormalizeCalls();
  tuiDisplayStub.setKnownAiTuiViewport(true);
  t.after(() => tuiDisplayStub.setKnownAiTuiViewport(false));
  const options = { ...createOptions(), isVisible: true, isLightTheme: true };
  const controller = createTerminalTuiColorSyncController(() => options);
  t.after(() => controller.dispose());

  controller.normalize({});
  assert.equal(tuiDisplayStub.lastNormalizeOptions.shouldEraseDarkBlocks, true);
  assert.equal(tuiDisplayStub.lastNormalizeOptions.isCodexSession, false);
  assert.equal(tuiDisplayStub.lastNormalizeOptions.isClaudeSession, false);
});

test("dark theme sessions keep normalization off for Claude and Pi", (t) => {
  tuiDisplayStub.resetNormalizeCalls();
  cliContextStub.setDetectedContexts({ pi: true });
  t.after(() => cliContextStub.setDetectedContexts());
  const options = { ...createOptions(), isVisible: true };
  const controller = createTerminalTuiColorSyncController(() => options);
  t.after(() => controller.dispose());

  controller.normalize({});
  assert.equal(tuiDisplayStub.lastNormalizeOptions.shouldEraseDarkBlocks, false);
  assert.equal(tuiDisplayStub.lastNormalizeOptions.shouldNormalize, false);
});
