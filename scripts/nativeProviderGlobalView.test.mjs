import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-provider-global-view-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

const source = readFileSync(
  new URL("../src/components/settings/providers/nativeProviderGlobalView.ts", import.meta.url),
  "utf8",
);
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const modulePath = join(tempDir, "nativeProviderGlobalView.mjs");
writeFileSync(modulePath, output, "utf8");

const globalView = await import(pathToFileURL(modulePath).href);

function preview(appType) {
  return {
    appType,
    home: {
      targets: {
        claudeConfigDir: "C:\\Users\\1\\.claude",
        codexConfigDir: "C:\\Users\\1\\.codex",
        grokConfigDir: "C:\\Users\\1\\.grok",
      },
    },
  };
}

test("global confirmation uses the CLI config directory instead of the Home parent", () => {
  assert.equal(globalView.providerGlobalTargetRoot(preview("claude")), "C:\\Users\\1\\.claude");
  assert.equal(globalView.providerGlobalTargetRoot(preview("codex")), "C:\\Users\\1\\.codex");
  assert.equal(globalView.providerGlobalTargetRoot(preview("grokbuild")), "C:\\Users\\1\\.grok");
});
