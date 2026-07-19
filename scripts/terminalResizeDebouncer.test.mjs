import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-resize-debouncer-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

const source = readFileSync(
  new URL("../src/terminal/browser/TerminalResizeDebouncer.ts", import.meta.url),
  "utf8",
);
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "TerminalResizeDebouncer.ts",
}).outputText;
const modulePath = join(tempDir, "TerminalResizeDebouncer.mjs");
writeFileSync(modulePath, transpiled, "utf8");

const { TerminalResizeDebouncer } = await import(pathToFileURL(modulePath).href);

function createHarness() {
  let now = 0;
  let nextTimerId = 1;
  const timers = new Map();
  const calls = [];
  const terminal = { buffer: { normal: { length: 300 } } };
  const debouncer = new TerminalResizeDebouncer(
    () => true,
    () => terminal,
    (cols, rows) => calls.push(["both", cols, rows]),
    (cols) => calls.push(["cols", cols]),
    (rows) => calls.push(["rows", rows]),
    {
      now: () => now,
      requestTimer: (callback, delayMs) => {
        const handle = nextTimerId++;
        timers.set(handle, { callback, delayMs });
        return handle;
      },
      cancelTimer: (handle) => timers.delete(handle),
    },
  );
  return {
    debouncer,
    calls,
    timers,
    advanceTo(value) { now = value; },
  };
}

test("large visible terminals apply the first resize immediately", () => {
  const harness = createHarness();
  harness.debouncer.resize(100, 30);

  assert.deepEqual(harness.calls, [["both", 100, 30]]);
  assert.equal(harness.timers.size, 0);
});

test("continuous resize applies the latest columns on a frame-bounded cadence", () => {
  const harness = createHarness();
  harness.debouncer.resize(100, 30);
  harness.advanceTo(5);
  harness.debouncer.resize(96, 30);
  harness.advanceTo(12);
  harness.debouncer.resize(88, 30);

  assert.deepEqual(harness.calls, [
    ["both", 100, 30],
    ["rows", 30],
    ["rows", 30],
  ]);
  assert.equal(harness.timers.size, 1);
  const [{ callback, delayMs }] = harness.timers.values();
  assert.equal(delayMs, 29);

  harness.timers.clear();
  harness.advanceTo(34);
  callback();

  assert.deepEqual(harness.calls.at(-1), ["cols", 88]);
});

test("the final drag size is applied without waiting for a 100ms pause", () => {
  const harness = createHarness();
  harness.debouncer.resize(100, 30);
  harness.advanceTo(20);
  harness.debouncer.resize(72, 30);
  const [{ callback }] = harness.timers.values();

  harness.timers.clear();
  harness.advanceTo(34);
  callback();

  assert.deepEqual(harness.calls.at(-1), ["cols", 72]);
});
