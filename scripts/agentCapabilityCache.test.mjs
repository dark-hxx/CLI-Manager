import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
const source = readFileSync(new URL("../src/features/agents/api/agentCapabilityCache.ts", import.meta.url), "utf8");
const exports = {};
runInNewContext(ts.transpileModule(source.replace(/^import type .*;\r?\n/m, ""), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports });

test("capability cache evicts least-recent scopes and retains each live baseline", () => {
  const cache = new exports.AgentCapabilityCache(2, 1000);
  cache.set("A", { configFingerprint: "original" });
  cache.set("B", { configFingerprint: "B" });
  cache.get("A");
  cache.set("C", { configFingerprint: "C" });
  assert.equal(cache.get("B"), undefined);
  assert.equal(cache.baseline("B"), null);
  cache.set("A", { configFingerprint: "changed" });
  assert.equal(cache.baseline("A"), "original");
});

test("oversize capability results are not cached", () => {
  const cache = new exports.AgentCapabilityCache(64, 100);
  cache.set("synthetic", { configFingerprint: "x".repeat(100) });
  assert.equal(cache.get("synthetic"), undefined);
});
