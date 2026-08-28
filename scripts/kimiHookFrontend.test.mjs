import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-kimi-hook-frontend-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

const terminalStoreSource = readFileSync(
  new URL("../src/stores/terminalStore.ts", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");
const functionMatch = terminalStoreSource.match(/function mapCliHookEvent[\s\S]*?\n}\n\nfunction mapShellRuntimeEvent/);
assert.ok(functionMatch, "mapCliHookEvent should remain discoverable for focused lifecycle tests");
const functionSource = functionMatch[0].replace(/\n\nfunction mapShellRuntimeEvent$/, "");
const output = ts.transpileModule(`${functionSource}\nexport { mapCliHookEvent };`, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const modulePath = join(tempDir, "kimiHookLifecycle.mjs");
writeFileSync(modulePath, output, "utf8");
const { mapCliHookEvent } = await import(pathToFileURL(modulePath).href);

const hookErrorsSource = readFileSync(new URL("../src/lib/hookErrors.ts", import.meta.url), "utf8");
const hookErrorsOutput = ts.transpileModule(hookErrorsSource, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const hookErrorsModulePath = join(tempDir, "hookErrors.mjs");
writeFileSync(hookErrorsModulePath, hookErrorsOutput, "utf8");
const { getKimiHookErrorMessage } = await import(pathToFileURL(hookErrorsModulePath).href);

test("Kimi 审批结束与中断形成静默状态闭环", () => {
  assert.equal(mapCliHookEvent("PermissionRequest"), "attention");
  assert.equal(mapCliHookEvent("PermissionResult"), "running");
  assert.equal(mapCliHookEvent("Interrupt"), "none");
});

test("Kimi Subagent 不进入本地 transcript split 特殊分支", () => {
  const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(appSource, /event\.payload\.source !== "kimi"/);
  assert.match(appSource, /event\.payload\.event !== "PermissionResult"/);
  assert.match(appSource, /event\.payload\.event !== "Interrupt"/);
});

test("Kimi bridge 设置默认启用且配置目录保持本机私有", () => {
  const settingsSource = readFileSync(new URL("../src/stores/settingsStore.ts", import.meta.url), "utf8");
  const syncSource = readFileSync(new URL("../src/lib/syncSettings.ts", import.meta.url), "utf8");
  assert.match(settingsSource, /kimiHookBridgeEnabled: true/);
  assert.match(settingsSource, /kimiHookConfigDir: null/);
  assert.match(syncSource, /kimiHookBridgeEnabled: "excluded"/);
  assert.match(syncSource, /kimiHookConfigDir: "excluded"/);
});

test("Kimi 配置目录错误按当前语言翻译并保留系统错误细节", () => {
  const translate = (key) => `translated:${key}`;
  assert.equal(
    getKimiHookErrorMessage("kimi_config_dir_required", translate),
    "translated:settings.hooks.kimi.configDirRequired",
  );
  assert.equal(
    getKimiHookErrorMessage("kimi_config_dir_create_failed: access denied", translate),
    "translated:settings.hooks.kimi.configDirCreateFailed access denied",
  );
});
