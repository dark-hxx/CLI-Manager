import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-provider-import-display-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

const source = readFileSync(
  new URL("../src/components/settings/providers/nativeProviderImportDisplay.ts", import.meta.url),
  "utf8",
);
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const modulePath = join(tempDir, "nativeProviderImportDisplay.mjs");
writeFileSync(modulePath, output, "utf8");

const { issueScopeLabel } = await import(pathToFileURL(modulePath).href);

const translate = (key, params = {}) => {
  const templates = {
    "providerCatalog.import.projectScope": "项目：{name}",
    "providerCatalog.import.worktreeScope": "Worktree：{project} / {name}",
    "providerCatalog.import.unknownProject": "未知项目（ID：{id}）",
    "providerCatalog.import.unknownScope": "{kind}（ID：{id}）",
  };
  return (templates[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ""));
};

const projects = [{ id: "project-1", name: "CLI Manager", path: "", group_name: "", group_id: null }];
const worktrees = [{
  id: "worktree-1",
  project_id: "project-1",
  name: "feature-ui",
  branch: "feature/ui",
}];

test("repair rows prefer the project display name over its UUID", () => {
  assert.equal(issueScopeLabel({ scopeKind: "project", scopeId: "project-1" }, projects, [], translate), "项目：CLI Manager");
});

test("repair rows include the parent project and Worktree name", () => {
  assert.equal(
    issueScopeLabel({ scopeKind: "worktree", scopeId: "worktree-1" }, projects, worktrees, translate),
    "Worktree：CLI Manager / feature-ui",
  );
});

test("unresolved references keep a localized ID fallback", () => {
  assert.equal(
    issueScopeLabel({ scopeKind: "project", scopeId: "missing-project" }, [], [], translate),
    "项目：未知项目（ID：missing-project）",
  );
});
