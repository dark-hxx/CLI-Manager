import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-cli-args-history-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

const source = readFileSync(new URL("../src/lib/cliArgsHistory.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "cliArgsHistory.ts",
}).outputText;
const outputPath = join(tempDir, "cliArgsHistory.mjs");
writeFileSync(outputPath, output, "utf8");
const {
  getCliArgsHistorySuggestions,
  normalizeCliArgsHistory,
  recordCliArgsUsage,
} = await import(pathToFileURL(outputPath).href);

const syncSource = readFileSync(new URL("../src/lib/syncSettings.ts", import.meta.url), "utf8");
const syncOutput = ts.transpileModule(syncSource, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "syncSettings.ts",
}).outputText;
const syncOutputPath = join(tempDir, "syncSettings.mjs");
writeFileSync(syncOutputPath, syncOutput, "utf8");
const { pickSyncableSettings, SETTING_BACKUP_POLICY } = await import(pathToFileURL(syncOutputPath).href);

test("records CLI argument usage separately by CLI tool", () => {
  let history = recordCliArgsUsage([], " Codex ", " --full-auto ", 100);
  history = recordCliArgsUsage(history, "codex", "--full-auto", 200);
  history = recordCliArgsUsage(history, "claude", "--full-auto", 300);

  assert.deepEqual(getCliArgsHistorySuggestions(history, "CODEX"), [
    { cliTool: "codex", cliArgs: "--full-auto", count: 2, lastUsedAt: 200 },
  ]);
  assert.equal(getCliArgsHistorySuggestions(history, "claude")[0]?.count, 1);
});

test("sorts by count then recency and limits suggestions", () => {
  const history = Array.from({ length: 12 }, (_, index) => ({
    cliTool: "codex",
    cliArgs: `--option-${index}`,
    count: index < 2 ? 20 : 12 - index,
    lastUsedAt: index,
  }));

  const suggestions = getCliArgsHistorySuggestions(history, "codex");
  assert.equal(suggestions.length, 10);
  assert.equal(suggestions[0]?.cliArgs, "--option-1");
  assert.equal(suggestions[1]?.cliArgs, "--option-0");
  assert.equal(getCliArgsHistorySuggestions(history, "codex", 10, "--option").length, 10);
  assert.deepEqual(getCliArgsHistorySuggestions(history, "codex", 10, "--option-11").map((entry) => entry.cliArgs), ["--option-11"]);
});

test("drops invalid entries and merges duplicate persisted values", () => {
  assert.deepEqual(normalizeCliArgsHistory([
    { cliTool: "Codex", cliArgs: " --full-auto ", count: 2, lastUsedAt: 100 },
    { cliTool: "codex", cliArgs: "--full-auto", count: 3, lastUsedAt: 200 },
    { cliTool: "", cliArgs: "--bad", count: 1, lastUsedAt: 0 },
    { cliTool: "claude", cliArgs: "", count: 1, lastUsedAt: 0 },
  ]), [
    { cliTool: "codex", cliArgs: "--full-auto", count: 5, lastUsedAt: 200 },
  ]);
});

test("includes CLI argument history in preference snapshots", () => {
  const cliArgsHistory = [
    { cliTool: "codex", cliArgs: "--full-auto", count: 2, lastUsedAt: 200 },
  ];

  assert.equal(SETTING_BACKUP_POLICY.cliArgsHistory, "preferences");
  assert.deepEqual(pickSyncableSettings({ cliArgsHistory, debugMode: true }), { cliArgsHistory });
});

test("records non-clone CLI arguments after either create or edit succeeds", () => {
  const modalSource = readFileSync(new URL("../src/components/ConfigModal.tsx", import.meta.url), "utf8");
  const editBranchStart = modalSource.indexOf("if (isEdit && project) {");
  const sharedRecordStart = modalSource.indexOf("if (!isClone && trimmedCliArgs) {", editBranchStart);
  const closeAfterSave = modalSource.indexOf("onClose();", sharedRecordStart);

  assert.ok(editBranchStart >= 0);
  assert.ok(sharedRecordStart > editBranchStart);
  assert.ok(closeAfterSave > sharedRecordStart);
  assert.match(modalSource, /!isClone \? \([\s\S]*<CliArgsHistoryField/);
});
