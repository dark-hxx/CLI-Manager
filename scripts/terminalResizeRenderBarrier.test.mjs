import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-resize-render-barrier-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

const source = readFileSync(
  new URL("../src/terminal/browser/TerminalResizeRenderBarrier.ts", import.meta.url),
  "utf8",
);
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "TerminalResizeRenderBarrier.ts",
}).outputText;
const modulePath = join(tempDir, "TerminalResizeRenderBarrier.mjs");
writeFileSync(modulePath, transpiled, "utf8");

const {
  hasVisibleTerminalFrameContent,
  resolveTerminalResizeCaptureElements,
  TerminalResizeRenderBarrier,
} = await import(pathToFileURL(modulePath).href);

test("uniform WebGL background frames are rejected as empty", () => {
  assert.equal(hasVisibleTerminalFrameContent(new Uint8ClampedArray([
    20, 24, 32, 255,
    20, 24, 32, 255,
    20, 24, 32, 255,
  ])), false);
});

test("frames containing terminal glyph contrast are accepted", () => {
  assert.equal(hasVisibleTerminalFrameContent(new Uint8ClampedArray([
    20, 24, 32, 255,
    220, 224, 232, 255,
    20, 24, 32, 255,
  ])), true);
});

test("capture geometry uses the xterm screen while canvas lookup can fall back to the root", () => {
  const terminalCanvas = { classList: { contains: () => false } };
  const overviewRuler = {
    classList: { contains: (name) => name === "xterm-decoration-overview-ruler" },
  };
  const screen = { querySelectorAll: () => [] };
  const root = {
    querySelector: (selector) => selector === ".xterm-screen" ? screen : null,
    querySelectorAll: () => [terminalCanvas, overviewRuler],
  };

  assert.deepEqual(
    resolveTerminalResizeCaptureElements({ element: root }),
    { screen, canvases: [terminalCanvas] },
  );
});

test("the public xterm screen is preferred over the terminal root", () => {
  const screenCanvas = { classList: { contains: () => false } };
  const screen = { querySelectorAll: () => [screenCanvas] };
  const root = {
    querySelector: () => ({ querySelectorAll: () => [] }),
    querySelectorAll: () => [],
  };

  assert.deepEqual(
    resolveTerminalResizeCaptureElements({ element: root, screenElement: screen }),
    { screen, canvases: [screenCanvas] },
  );
});

function createHarness() {
  let nextFrameId = 1;
  const frames = new Map();
  const calls = [];
  const terminal = {};
  const container = {};
  const barrier = new TerminalResizeRenderBarrier({
    createFrame: () => ({
      syncBounds: () => calls.push("sync"),
      dispose: () => calls.push("dispose"),
    }),
    requestFrame: (callback) => {
      const id = nextFrameId++;
      frames.set(id, callback);
      return id;
    },
    cancelFrame: (id) => frames.delete(id),
  });
  const flushFrame = () => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(0));
  };
  return { barrier, terminal, container, frames, calls, flushFrame };
}

test("container resize clips one stable frame without delaying the live reveal", () => {
  const harness = createHarness();
  assert.equal(harness.barrier.begin(harness.terminal, harness.container), true);
  assert.deepEqual(harness.calls, ["sync"]);
  assert.equal(harness.frames.size, 1);

  harness.barrier.noteContainerResize();
  assert.deepEqual(harness.calls, ["sync", "sync"]);
  assert.equal(harness.frames.size, 1);
});

test("a newer terminal resize restarts the two-frame corruption guard", () => {
  const harness = createHarness();
  harness.barrier.begin(harness.terminal, harness.container);
  assert.equal(harness.frames.size, 1);

  harness.barrier.begin(harness.terminal, harness.container);
  assert.equal(harness.frames.size, 1);
  harness.flushFrame();
  assert.deepEqual(harness.calls, ["sync", "sync"]);
});

test("each guarded resize reveals the live terminal after two animation frames", () => {
  const harness = createHarness();
  harness.barrier.begin(harness.terminal, harness.container);

  harness.flushFrame();
  harness.flushFrame();
  assert.deepEqual(harness.calls, ["sync", "dispose"]);
});
