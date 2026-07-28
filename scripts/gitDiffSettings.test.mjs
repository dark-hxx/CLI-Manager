import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("Git diff view mode defaults to split and validates persisted values", () => {
  const settings = read("../src/stores/settingsStore.ts");
  assert.match(settings, /gitDiffViewMode:\s*"split"/);
  assert.match(settings, /entries\.gitDiffViewMode === "split" \|\| entries\.gitDiffViewMode === "unified"/);
  assert.match(settings, /: DEFAULTS\.gitDiffViewMode/);
});

test("Git diff view mode participates in preference sync", () => {
  const syncSettings = read("../src/lib/syncSettings.ts");
  assert.match(syncSettings, /gitDiffViewMode:\s*"preferences"/);
});

test("Git diff host and wrapping preferences default safely and validate persisted values", () => {
  const settings = read("../src/stores/settingsStore.ts");
  assert.match(settings, /gitDiffOpenMode:\s*"dialog"/);
  assert.match(settings, /gitDiffWrapLines:\s*true/);
  assert.match(settings, /entries\.gitDiffOpenMode === "dialog" \|\| entries\.gitDiffOpenMode === "editor"/);
  assert.match(settings, /typeof entries\.gitDiffWrapLines === "boolean"/);
  assert.match(settings, /: DEFAULTS\.gitDiffOpenMode/);
  assert.match(settings, /: DEFAULTS\.gitDiffWrapLines/);
});

test("Git diff host and wrapping preferences participate in preference sync", () => {
  const syncSettings = read("../src/lib/syncSettings.ts");
  assert.match(syncSettings, /gitDiffOpenMode:\s*"preferences"/);
  assert.match(syncSettings, /gitDiffWrapLines:\s*"preferences"/);
});

test("Git diff generation options default safely and validate persisted values", () => {
  const settings = read("../src/stores/settingsStore.ts");
  assert.match(settings, /gitDiffWhitespaceMode:\s*"exact"/);
  assert.match(settings, /gitDiffContextLines:\s*3/);
  assert.match(settings, /entries\.gitDiffWhitespaceMode === "ignore-eol"/);
  assert.match(settings, /entries\.gitDiffWhitespaceMode === "ignore-all"/);
  assert.match(settings, /entries\.gitDiffContextLines === 10/);
  assert.match(settings, /entries\.gitDiffContextLines === 20/);
});

test("Git diff generation options participate in preference sync", () => {
  const syncSettings = read("../src/lib/syncSettings.ts");
  assert.match(syncSettings, /gitDiffWhitespaceMode:\s*"preferences"/);
  assert.match(syncSettings, /gitDiffContextLines:\s*"preferences"/);
});
