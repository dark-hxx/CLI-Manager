import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-desktop-pet-rendered-bounds-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

const source = readFileSync(
  new URL("../src/lib/desktopPetRenderedBounds.ts", import.meta.url),
  "utf8"
);
const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "desktopPetRenderedBounds.ts",
}).outputText;
const outputPath = join(tempDir, "desktopPetRenderedBounds.mjs");
writeFileSync(outputPath, output, "utf8");
const bounds = await import(pathToFileURL(outputPath).href);

const base = {
  x: 900,
  y: 600,
  width: 190,
  height: 210,
};

test("grows upward when the rendered status bubble crosses the viewport top", () => {
  const result = bounds.calculateDesktopPetRenderedBounds({
    current: base,
    viewportWidth: 190,
    viewportHeight: 210,
    petScale: 1,
    scaleFactor: 1,
    contentRects: [
      { left: 23, top: -44, right: 167, bottom: 0 },
      { left: 23, top: 58, right: 167, bottom: 202 },
    ],
  });

  assert.equal(result.changed, true);
  assert.equal(result.bounds.width, 190);
  assert.equal(result.bounds.height, 262);
  assert.equal(result.bounds.x, 900);
  assert.equal(result.bounds.y, 548);
  assert.deepEqual(result.basePosition, { x: 900, y: 600 });
});

test("stays stable after the expanded viewport has been applied", () => {
  const result = bounds.calculateDesktopPetRenderedBounds({
    current: { x: 900, y: 548, width: 190, height: 262 },
    viewportWidth: 190,
    viewportHeight: 262,
    petScale: 1,
    scaleFactor: 1,
    contentRects: [
      { left: 23, top: 8, right: 167, bottom: 52 },
      { left: 23, top: 110, right: 167, bottom: 254 },
    ],
  });

  assert.equal(result.changed, false);
  assert.deepEqual(result.bounds, { x: 900, y: 548, width: 190, height: 262 });
});

test("shrinks back to the base window when the bubble content fits", () => {
  const result = bounds.calculateDesktopPetRenderedBounds({
    current: { x: 900, y: 548, width: 190, height: 262 },
    viewportWidth: 190,
    viewportHeight: 262,
    petScale: 1,
    scaleFactor: 1,
    contentRects: [
      { left: 23, top: 61, right: 167, bottom: 105 },
      { left: 23, top: 110, right: 167, bottom: 254 },
    ],
  });

  assert.equal(result.changed, true);
  assert.deepEqual(result.bounds, { x: 900, y: 600, width: 190, height: 210 });
  assert.deepEqual(result.basePosition, { x: 900, y: 600 });
});

test("accounts for monitor DPI and keeps the base anchor stable", () => {
  const result = bounds.calculateDesktopPetRenderedBounds({
    current: { x: 100, y: 200, width: 238, height: 263 },
    viewportWidth: 190,
    viewportHeight: 210,
    petScale: 1,
    scaleFactor: 1.25,
    contentRects: [
      { left: 23, top: -20, right: 167, bottom: 24 },
      { left: 23, top: 58, right: 167, bottom: 202 },
    ],
  });

  assert.equal(result.bounds.width, 238);
  assert.equal(result.bounds.height, 298);
  assert.deepEqual(result.basePosition, { x: 100, y: 200 });
});

test("clamps expanded bounds to a monitor work area", () => {
  const result = bounds.calculateDesktopPetRenderedBounds({
    current: { x: 10, y: 10, width: 190, height: 210 },
    viewportWidth: 190,
    viewportHeight: 210,
    petScale: 1,
    scaleFactor: 1,
    contentRects: [
      { left: 23, top: -44, right: 167, bottom: 0 },
      { left: 23, top: 58, right: 167, bottom: 202 },
    ],
    workArea: { x: 0, y: 0, width: 240, height: 300 },
  });

  assert.deepEqual(result.bounds, { x: 10, y: 0, width: 190, height: 262 });
  assert.ok(result.bounds.x >= 0);
  assert.ok(result.bounds.y >= 0);
  assert.ok(result.bounds.x + result.bounds.width <= 240);
  assert.ok(result.bounds.y + result.bounds.height <= 300);
});

test("grows horizontally when rendered content exceeds the base viewport", () => {
  const result = bounds.calculateDesktopPetRenderedBounds({
    current: base,
    viewportWidth: 190,
    viewportHeight: 210,
    petScale: 1,
    scaleFactor: 1,
    contentRects: [
      { left: -18, top: 58, right: 208, bottom: 202 },
    ],
  });

  assert.equal(result.bounds.width, 242);
  assert.equal(result.bounds.height, 210);
  assert.equal(result.bounds.x, 874);
  assert.equal(result.bounds.y, 600);
  assert.deepEqual(result.basePosition, { x: 900, y: 600 });
});
