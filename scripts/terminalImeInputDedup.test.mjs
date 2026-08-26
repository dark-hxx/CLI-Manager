import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-ime-input-dedup-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

const outputPath = join(tempDir, "terminalImeInputDedup.mjs");
const output = ts.transpileModule(
  readFileSync(new URL("../src/lib/terminalImeInputDedup.ts", import.meta.url), "utf8"),
  {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
    fileName: "terminalImeInputDedup.ts",
  },
).outputText;
writeFileSync(outputPath, output, "utf8");

const { createTerminalImeInputDeduper } = await import(pathToFileURL(outputPath).href);

test("cross-source IME input is still forwarded once", () => {
  const deduper = createTerminalImeInputDeduper();

  assert.equal(deduper.shouldForward("你", "onData", 0), true);
  assert.equal(deduper.shouldForward("你", "nativeTextInput", 20), false);
  assert.equal(deduper.shouldForward("好", "nativeTextInput", 30), true);
  assert.equal(deduper.shouldForward("好", "onData", 50), false);
});

test("macOS process-key checkpoint drops a same-source CJK re-emission", () => {
  const deduper = createTerminalImeInputDeduper({
    shouldEnableSameSourceProcessKeyDedup: () => true,
  });

  assert.equal(deduper.shouldForward("你", "onData", 10), true);
  deduper.noteImeProcessKey(12);
  assert.equal(deduper.shouldForward("你", "onData", 15), false);
});

test("process-key checkpoint drops deferred combined CJK payloads", () => {
  const deduper = createTerminalImeInputDeduper({
    shouldEnableSameSourceProcessKeyDedup: () => true,
  });

  assert.equal(deduper.shouldForward("你", "onData", 10), true);
  deduper.noteImeProcessKey(12);
  assert.equal(deduper.shouldForward("好呀", "onData", 15), true);
  assert.equal(deduper.shouldForward("你好呀", "onData", 18), false);
});

test("a new composition permits an intentional repeated Chinese commit", () => {
  const deduper = createTerminalImeInputDeduper({
    shouldEnableSameSourceProcessKeyDedup: () => true,
  });

  assert.equal(deduper.shouldForward("你", "onData", 10), true);
  deduper.noteImeProcessKey(12);
  deduper.resetForComposition();
  assert.equal(deduper.shouldForward("你", "onData", 15), true);
});

test("same-source matching requires an enabled, recent process-key checkpoint", () => {
  const noCheckpointDeduper = createTerminalImeInputDeduper({
    shouldEnableSameSourceProcessKeyDedup: () => true,
  });
  assert.equal(noCheckpointDeduper.shouldForward("你", "onData", 10), true);
  assert.equal(noCheckpointDeduper.shouldForward("你", "onData", 15), true);

  const disabledDeduper = createTerminalImeInputDeduper();
  assert.equal(disabledDeduper.shouldForward("你", "onData", 10), true);
  disabledDeduper.noteImeProcessKey(12);
  assert.equal(disabledDeduper.shouldForward("你", "onData", 15), true);

  const expiredDeduper = createTerminalImeInputDeduper({
    shouldEnableSameSourceProcessKeyDedup: () => true,
  });
  assert.equal(expiredDeduper.shouldForward("你", "onData", 10), true);
  expiredDeduper.noteImeProcessKey(12);
  assert.equal(expiredDeduper.shouldForward("你", "onData", 413), true);
});

test("terminal IME lifecycle forwards the process-key and composition boundary", () => {
  const inputSource = readFileSync(new URL("../src/hooks/useTerminalInput.ts", import.meta.url), "utf8");
  const imeSource = readFileSync(new URL("../src/lib/terminalIme.ts", import.meta.url), "utf8");

  assert.match(inputSource, /onImeProcessKey: forwarding\.noteImeProcessKey,/);
  assert.match(inputSource, /onCompositionStarted: forwarding\.resetImeInputDedup,/);
  assert.match(imeSource, /onImeProcessKey\?\.\(now\);/);
  assert.match(imeSource, /onCompositionStarted\?\.\(\);/);
});
