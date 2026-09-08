import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
const directory = mkdtempSync(join(tmpdir(), "stats-screenshot-test-"));
process.on("exit", () => rmSync(directory, {recursive: true, force: true}));
const compile = async (name, source) => {
  const output = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022}}).outputText;
  const path = join(directory, name + ".mjs");
  writeFileSync(path, output);
  return import(pathToFileURL(path).href);
};
const source = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const {screenshotPixelRatio} = await compile("capture", source("src/features/stats/api/statsScreenshot.ts"));
test("ordinary panels render at high density and long panels stay within the pixel budget", () => {
  assert.equal(screenshotPixelRatio(480, 2000, 1), 2);
  assert.equal(screenshotPixelRatio(480, 2000, 1.5), 2);
  assert.equal(screenshotPixelRatio(188, 3000, 2), 2);
  assert.equal(screenshotPixelRatio(188, 3000, 3), 3);
  assert.equal(screenshotPixelRatio(188, 20000, 2), 16384 / 20000);
  const ratio = screenshotPixelRatio(4000, 4000, 3);
  assert.equal(ratio, 1);
  assert.throws(() => screenshotPixelRatio(0, 300, 1), /unavailable/);
  assert.throws(() => screenshotPixelRatio(188, 40000, 1), /too_large/);
});
writeFileSync(join(directory, "native.mjs"), `
export const calls = [];
export const state = {fail: false};
export const Image = {new: async (rgba, width, height) => {
  calls.push(["create", [...rgba], width, height]);
  return {close: async () => {calls.push(["close"]);}};
}};
export const writeImage = async () => {calls.push(["write"]); if (state.fail) throw new Error("clipboard busy");};
`);
const native = await import(pathToFileURL(join(directory, "native.mjs")).href);
const {copyStatsImage} = await compile("clipboard", source("src/features/stats/api/statsScreenshotClipboard.ts")
  .replace('"@tauri-apps/api/image"', '"./native.mjs"').replace('"@tauri-apps/plugin-clipboard-manager"', '"./native.mjs"'));
const canvas = {width: 1, height: 1, getContext: () => ({getImageData: () => ({data: new Uint8ClampedArray([1, 2, 3, 255])})})};
test("native clipboard receives RGBA with dimensions and releases the image", async () => {
  native.calls.length = 0;
  await copyStatsImage(canvas);
  assert.deepEqual(native.calls, [["create", [1, 2, 3, 255], 1, 1], ["write"], ["close"]]);
});
test("clipboard failure still releases resources and remains retryable", async () => {
  native.calls.length = 0;
  native.state.fail = true;
  await assert.rejects(copyStatsImage(canvas), /clipboard busy/);
  assert.deepEqual(native.calls.map(call => call[0]), ["create", "write", "close"]);
  native.state.fail = false;
  await copyStatsImage(canvas);
  await assert.rejects(copyStatsImage({...canvas, width: 0}), /unavailable/);
});
test("capture is scoped and uses only native write-image permission", () => {
  const permissions = JSON.parse(source("src-tauri/capabilities/default.json")).permissions;
  assert.ok(permissions.includes("clipboard-manager:allow-write-image"));
  const button = source("src/features/terminal/components/StatsScreenshotButton.tsx");
  assert.match(button, /if \(inFlight.current/);
  assert.match(button, /disabled=\{busy\}/);
  for (const language of ["zh-CN", "en-US"]) {
    const dictionary = source(`src/shared/i18n/messages/terminal.${language}.ts`);
    for (const key of ["screenshot", "screenshotBusy", "screenshotCopied", "screenshotFailed", "screenshotTooLarge"]) {
      assert.ok(dictionary.includes(`"termStats.${key}"`));
    }
  }
});
