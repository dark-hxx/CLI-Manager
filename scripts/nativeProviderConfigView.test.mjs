import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-provider-config-view-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

const source = readFileSync(
  new URL("../src/components/settings/providers/nativeProviderConfigView.ts", import.meta.url),
  "utf8",
);
const advancedSource = readFileSync(
  new URL("../src/components/settings/providers/nativeProviderAdvancedConfig.ts", import.meta.url),
  "utf8",
);
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText.replace("./nativeProviderAdvancedConfig", "./nativeProviderAdvancedConfig.mjs");
const advancedOutput = ts.transpileModule(advancedSource, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const modulePath = join(tempDir, "nativeProviderConfigView.mjs");
writeFileSync(join(tempDir, "nativeProviderAdvancedConfig.mjs"), advancedOutput, "utf8");
writeFileSync(modulePath, output, "utf8");

const configView = await import(pathToFileURL(modulePath).href);
const advancedConfig = await import(pathToFileURL(join(tempDir, "nativeProviderAdvancedConfig.mjs")).href);

test("Codex and Grok display the stored config envelope as TOML", () => {
  const stored = JSON.stringify({ auth: { OPENAI_API_KEY: "***" }, config: "model = \"gpt-test\"\n" });
  assert.equal(configView.nativeProviderConfigFormat("codex"), "toml");
  assert.equal(configView.providerConfigDocumentFromSettings("codex", stored), "model = \"gpt-test\"\n");
  assert.equal(configView.providerConfigDocumentFromSettings("grokbuild", stored), "model = \"gpt-test\"\n");
});

test("editing a TOML document keeps the provider JSON envelope", () => {
  const stored = JSON.stringify({ auth: { OPENAI_API_KEY: "***" }, extra: true, config: "model = \"old\"\n" });
  const next = JSON.parse(configView.settingsConfigFromProviderDocument("codex", "model = \"new\"\n", stored));
  assert.equal(next.extra, true);
  assert.deepEqual(next.auth, { OPENAI_API_KEY: "***" });
  assert.equal(next.config, "model = \"new\"\n");
});

test("Claude provider documents remain JSON and reject arrays", () => {
  assert.equal(configView.nativeProviderConfigFormat("claude"), "json");
  assert.equal(configView.isValidProviderConfigDocument("claude", "{\"env\":{}}"), true);
  assert.equal(configView.isValidProviderConfigDocument("claude", "[]"), false);
});

test("editing a provider with an empty document generates CLI-specific config", () => {
  const seed = { baseUrl: "https://example.test/v1", model: "gpt-test", apiFormat: "responses" };
  const codex = configView.providerConfigDocumentFromSettings("codex", "{}", seed);
  const grok = configView.providerConfigDocumentFromSettings("grokbuild", "{}", seed);
  const malformed = configView.providerConfigDocumentFromSettings("codex", "not-json", seed);
  assert.match(codex, /model_provider = "custom"/);
  assert.match(codex, /base_url = "https:\/\/example\.test\/v1"/);
  assert.match(grok, /\[model\.custom\]/);
  assert.match(grok, /api_backend = "responses"/);
  assert.match(malformed, /model_provider = "custom"/);
});

test("advanced provider options round-trip in the existing JSON envelope", () => {
  const advanced = advancedConfig.defaultNativeProviderAdvancedConfig();
  advanced.wireApi = "chat_completions";
  advanced.modelMappings = [{ source: "gpt-4", target: "proxy-gpt-4" }];
  advanced.userAgent = "CLI-Manager test";
  const settings = JSON.parse(advancedConfig.settingsConfigWithAdvanced("{\"config\":\"model = \\\"gpt-4\\\"\\n\"}", advanced));
  assert.equal(settings.advanced.wireApi, "chat_completions");
  assert.deepEqual(settings.advanced.modelMappings, [{ source: "gpt-4", target: "proxy-gpt-4" }]);
  assert.equal(advancedConfig.nativeProviderAdvancedConfigFromSettings(JSON.stringify(settings)).userAgent, "CLI-Manager test");
});

test("advanced provider options reject invalid override documents and mappings", () => {
  const advanced = advancedConfig.defaultNativeProviderAdvancedConfig();
  assert.equal(advancedConfig.isValidNativeProviderAdvancedConfig(advanced), true);
  assert.equal(advancedConfig.isValidNativeProviderAdvancedConfig({
    ...advanced,
    headerOverride: "[]",
  }), false);
  assert.equal(advancedConfig.isValidNativeProviderAdvancedConfig({
    ...advanced,
    modelMappings: [{ source: "", target: "proxy" }],
  }), false);
});
