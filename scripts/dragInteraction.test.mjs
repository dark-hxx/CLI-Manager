import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-drag-interaction-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

const source = readFileSync(new URL("../src/features/workspace/api/dragInteraction.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "dragInteraction.ts",
}).outputText;
const outputPath = join(tempDir, "dragInteraction.mjs");
writeFileSync(outputPath, output, "utf8");

const dragInteraction = await import(pathToFileURL(outputPath).href);

test("workspan drag hover activates only a different workspan tab", () => {
  assert.equal(dragInteraction.WORKSPAN_DRAG_AUTO_ACTIVATE_MS, 500);
  assert.equal(dragInteraction.resolveWorkspanDragHoverTarget("source", "workspan:target"), "target");
  assert.equal(dragInteraction.resolveWorkspanDragHoverTarget("source", "workspan:source"), null);
  assert.equal(dragInteraction.resolveWorkspanDragHoverTarget("source", "pane-edge:pane:right"), null);
});

test("workspan drag ids reject empty or unrelated values", () => {
  assert.equal(dragInteraction.parseWorkspanDragId("workspan:target"), "target");
  assert.equal(dragInteraction.parseWorkspanDragId("workspan:"), null);
  assert.equal(dragInteraction.parseWorkspanDragId("target"), null);
});
