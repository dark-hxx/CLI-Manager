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

function createHarness() {
  let nextTimerId = 1;
  let nextFrameId = 1;
  const timers = new Map();
  const frames = new Map();
  const calls = [];
  const terminal = {};
  const container = {};
  const barrier = new TerminalResizeRenderBarrier({
    createFrame: () => ({
      syncBounds: () => calls.push("sync"),
      refresh: () => calls.push("refresh"),
      dispose: () => calls.push("dispose"),
    }),
    requestTimer: (callback, delayMs) => {
      const id = nextTimerId++;
      timers.set(id, { callback, delayMs });
      return id;
    },
    cancelTimer: (id) => timers.delete(id),
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
  return { barrier, terminal, container, timers, frames, calls, flushFrame };
}

test("continuous container resize keeps one stable frame and resets settle timing", () => {
  const harness = createHarness();
  assert.equal(harness.barrier.begin(harness.terminal, harness.container), true);
  assert.deepEqual(harness.calls, ["sync"]);
  assert.equal(harness.timers.size, 1);

  harness.barrier.noteContainerResize();
  assert.deepEqual(harness.calls, ["sync", "sync"]);
  assert.equal(harness.timers.size, 1);
});

test("PTY writes refresh the visible snapshot without revealing the corrupt frame", () => {
  const harness = createHarness();
  harness.barrier.begin(harness.terminal, harness.container);
  harness.barrier.handleWriteCommitted(harness.terminal);

  harness.flushFrame();
  harness.flushFrame();
  assert.deepEqual(harness.calls, ["sync", "refresh"]);
});

test("settled resize refreshes once more before revealing the terminal", () => {
  const harness = createHarness();
  harness.barrier.begin(harness.terminal, harness.container);
  const [{ callback, delayMs }] = harness.timers.values();
  assert.equal(delayMs, 72);
  harness.timers.clear();
  callback();

  harness.flushFrame();
  harness.flushFrame();
  assert.deepEqual(harness.calls, ["sync", "refresh", "dispose"]);
});
