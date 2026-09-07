import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-provider-detail-view-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

const source = readFileSync(
  new URL("../src/components/settings/providers/nativeProviderDetailView.ts", import.meta.url),
  "utf8",
);
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const modulePath = join(tempDir, "nativeProviderDetailView.mjs");
writeFileSync(modulePath, output, "utf8");

const detailView = await import(pathToFileURL(modulePath).href);

test("detail view defaults to basic information", () => {
  assert.equal(detailView.DEFAULT_NATIVE_PROVIDER_DETAIL_VIEW, "basic");
  assert.equal(detailView.resetNativeProviderDetailView(), "basic");
});

test("supported detail tabs survive controlled tab changes", () => {
  assert.equal(detailView.normalizeNativeProviderDetailView("effective"), "effective");
  assert.equal(detailView.normalizeNativeProviderDetailView("keys"), "keys");
  assert.equal(detailView.normalizeNativeProviderDetailView("documents"), "documents");
});

test("invalid or cleared tab values return to basic information", () => {
  assert.equal(detailView.normalizeNativeProviderDetailView("unknown"), "basic");
  assert.equal(detailView.normalizeNativeProviderDetailView(null), "basic");
  assert.equal(detailView.normalizeNativeProviderDetailView(undefined), "basic");
});
