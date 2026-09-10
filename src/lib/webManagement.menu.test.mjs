import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const code = ts.transpileModule(readFileSync(new URL("./webManagement.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

function harness() {
  const calls = [];
  const store = {
    loaded: true,
    projects: [{ id: "p1", name: "Original", path: "F:/test", cli_tool: "codex", env_vars: "{}" }],
    groups: [{ id: "g1", name: "Group" }],
    updateProject: async (...args) => calls.push(["update", ...args]),
    renameGroup: async (...args) => calls.push(["renameGroup", ...args]),
    createProject: async (input) => { calls.push(["create", input]); return { ...input, id: "p2" }; },
  };
  const exports = {};
  vm.runInNewContext(code, { exports, TextEncoder, require: (id) => {
    if (id.endsWith("projectStore")) return { useProjectStore: { getState: () => store } };
    if (id.endsWith("webDeviceActionBus")) return { requestWebDeviceAction: async (request) => { calls.push(["desktop", request]); return request; } };
    return {};
  } });
  return { calls, run: (action, payload = {}) => exports.executeWebManagementOperation({ kind: "project.action", payload: { action, targetType: action.split(".")[0], targetId: action.startsWith("group.") ? "g1" : "p1", ...payload } }) };
}

test("remote rename and clone complete without opening desktop dialogs", async () => {
  const { run, calls } = harness();
  assert.equal((await run("project.rename", { name: "Renamed" })).renamed, true);
  assert.equal((await run("project.clone", { name: "Copy" })).projectId, "p2");
  assert.equal((await run("group.rename", { name: "New group" })).renamed, true);
  assert.deepEqual(calls.map(([kind]) => kind), ["update", "create", "renameGroup"]);
  assert.equal(calls[1][1].path, "F:/test");
  assert.equal(calls[1][1].cli_tool, "codex");
});

test("remote destructive operations require confirmation before desktop cleanup", async () => {
  const { run, calls } = harness();
  await assert.rejects(run("project.delete"), (error) => error.code === "operation_confirmation_required");
  assert.equal(calls.length, 0);
  assert.equal((await run("project.delete", { confirmed: true })).confirmed, true);
  assert.equal(calls[0][0], "desktop");
});

test("rename validates names and target existence before mutation", async () => {
  const { run, calls } = harness();
  await assert.rejects(run("project.rename", { name: "  " }), (error) => error.code === "invalid_operation_payload");
  await assert.rejects(run("project.rename", { name: "OK", targetId: "missing" }), (error) => error.code === "project_not_found");
  assert.equal(calls.length, 0);
});
