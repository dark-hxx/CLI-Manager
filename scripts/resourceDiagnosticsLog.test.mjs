import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-resource-diagnostics-log-"));
// 退出时清理诊断日志测试的临时目录。
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

writeFileSync(join(tempDir, "tauriCore.mjs"), `
export const calls = [];
let tauri = true;
export function isTauri() { return tauri; }
export function setTauri(value) { tauri = value; }
export async function invoke(command, args) {
  calls.push({ command, args });
}
`);

const source = readFileSync(new URL("../src/shared/platform/resourceDiagnosticsLog.ts", import.meta.url), "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "resourceDiagnosticsLog.ts",
}).outputText.replace('from "@tauri-apps/api/core"', 'from "./tauriCore.mjs"');
const modulePath = join(tempDir, "resourceDiagnosticsLog.mjs");
writeFileSync(modulePath, transpiled, "utf8");

const { writeResourceDiagnostic } = await import(pathToFileURL(modulePath).href);
const tauriCoreStub = await import(pathToFileURL(join(tempDir, "tauriCore.mjs")).href);

// 验证资源诊断使用专用结构化 IPC 参数。
test("resource diagnostics use the dedicated structured IPC", () => {
  tauriCoreStub.calls.length = 0;
  writeResourceDiagnostic("info", "webview", "runtimeSnapshot", { sessions: 2 });

  assert.deepEqual(tauriCoreStub.calls, [{
    command: "resource_diagnostics_write",
    args: {
      entry: {
        level: "info",
        source: "webview",
        event: "runtimeSnapshot",
        payload: { sessions: 2 },
      },
    },
  }]);
});

// 验证非 Tauri 环境不发送诊断 IPC。
test("resource diagnostics skip IPC outside Tauri", () => {
  tauriCoreStub.calls.length = 0;
  tauriCoreStub.setTauri(false);

  writeResourceDiagnostic("info", "webview", "runtimeSnapshot", { sessions: 2 });

  assert.deepEqual(tauriCoreStub.calls, []);
  tauriCoreStub.setTauri(true);
});
