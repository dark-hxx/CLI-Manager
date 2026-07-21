import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-desktop-pet-size-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

const source = readFileSync(new URL("../src/lib/desktopPetSize.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "desktopPetSize.ts",
}).outputText;
const outputPath = join(tempDir, "desktopPetSize.mjs");
writeFileSync(outputPath, output, "utf8");
const size = await import(pathToFileURL(outputPath).href);

test("legacy desktop pet size presets migrate to percentages", () => {
  assert.equal(size.normalizeDesktopPetSizePercent("small"), 80);
  assert.equal(size.normalizeDesktopPetSizePercent("medium"), 100);
  assert.equal(size.normalizeDesktopPetSizePercent("large"), 125);
});

test("desktop pet size percentages clamp and snap to five percent steps", () => {
  assert.equal(size.normalizeDesktopPetSizePercent(5), 40);
  assert.equal(size.normalizeDesktopPetSizePercent(42), 40);
  assert.equal(size.normalizeDesktopPetSizePercent(43), 45);
  assert.equal(size.normalizeDesktopPetSizePercent(149), 150);
  assert.equal(size.normalizeDesktopPetSizePercent(500), 150);
  assert.equal(size.normalizeDesktopPetSizePercent(Number.NaN, 115), 115);
});

test("desktop pet percentages convert to native window scales", () => {
  assert.equal(size.desktopPetScaleFromPercent(40), 0.4);
  assert.equal(size.desktopPetScaleFromPercent(100), 1);
  assert.equal(size.desktopPetScaleFromPercent(150), 1.5);
});

test("desktop pet wheel steps use five percent increments and stay in bounds", () => {
  assert.equal(size.stepDesktopPetSizePercent(100, 1), 105);
  assert.equal(size.stepDesktopPetSizePercent(100, -1), 95);
  assert.equal(size.stepDesktopPetSizePercent(150, 1), 150);
  assert.equal(size.stepDesktopPetSizePercent(40, -1), 40);
  assert.equal(size.stepDesktopPetSizePercent(103, 0), 105);
  assert.equal(size.stepDesktopPetSizePercent(100, Number.NaN), 100);
});
