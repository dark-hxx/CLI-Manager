import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/components/git/workspace/GitPowerToolsDialog.tsx", import.meta.url), "utf8");

test("power tools reuse application dialogs without browser-native prompts", () => {
  assert.match(source, /<Modal opened=\{open\}/);
  assert.match(source, /useAppConfirm/);
  assert.match(source, /useAppPrompt/);
  assert.doesNotMatch(source, /window\.(confirm|prompt)\(/);
});

test("power tools gate stale reads and serialize confirmed mutations", () => {
  assert.match(source, /generation === readGeneration\.current/);
  assert.match(source, /if \(mutationBusy\.current \|\|/);
  assert.match(source, /mutationBusy\.current = true/);
  assert.match(source, /if \(context !== currentContext\.current\) return;\s+await operation\(\)/);
  assert.match(source, /catch \(reason\) \{\s+if \(context !== currentContext\.current\) return;/);
});
