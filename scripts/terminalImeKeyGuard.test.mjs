import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-ime-key-guard-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

const outputPath = join(tempDir, "terminalImeKeyGuard.mjs");
writeFileSync(outputPath, ts.transpileModule(
  readFileSync(new URL("../src/features/terminal/lib/terminalImeKeyGuard.ts", import.meta.url), "utf8"),
  {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
    fileName: "terminalImeKeyGuard.ts",
  },
).outputText, "utf8");

const { shouldSwallowImeCompositionKeydown } = await import(pathToFileURL(outputPath).href);

const keyEvent = (overrides = {}) => ({
  type: "keydown",
  key: "Unidentified",
  ...overrides,
});

test("swallows the Unidentified keydown Doubao sends while polishing", () => {
  assert.equal(shouldSwallowImeCompositionKeydown(keyEvent(), true), true);
});

test("keeps the same keydown outside a composition", () => {
  assert.equal(shouldSwallowImeCompositionKeydown(keyEvent(), false), false);
});

test("does not swallow keyup or keypress events", () => {
  assert.equal(shouldSwallowImeCompositionKeydown(keyEvent({ type: "keyup" }), true), false);
  assert.equal(shouldSwallowImeCompositionKeydown(keyEvent({ type: "keypress" }), true), false);
});

test("keeps composition lifecycle keys and interrupt shortcuts", () => {
  for (const key of ["Process", "Alt", "Shift", "Control", "Enter", "Escape", "c", "a", "ArrowLeft"]) {
    assert.equal(shouldSwallowImeCompositionKeydown(keyEvent({ key }), true), false, key);
  }
});

test("the xterm key handler vetoes the event before its composition finalizer", () => {
  const controllerSource = readFileSync(
    new URL("../src/features/terminal/hooks/useXTermController.ts", import.meta.url),
    "utf8",
  );

  assert.match(controllerSource, /import \{ shouldSwallowImeCompositionKeydown \} from "\.\.\/lib\/terminalImeKeyGuard";/);
  assert.match(
    controllerSource,
    /terminal\.attachCustomKeyEventHandler\(keyRouting\.wrap\([\s\S]*shouldSwallowImeCompositionKeydown\(e, isComposingRef\.current\)/,
  );
  const routingSource = readFileSync(new URL("../src/shared/lib/terminalKeyRouting.ts", import.meta.url), "utf8");
  const guardIndex = routingSource.indexOf("if (imeGuard(event))");
  const heldIndex = routingSource.indexOf("let entry = held.get(id)");
  assert.ok(guardIndex >= 0 && heldIndex > guardIndex);
});
