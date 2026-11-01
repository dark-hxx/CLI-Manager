import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { singleFlight } from "../src/shared/lib/singleFlight.ts";

const source = readFileSync(new URL("../src/features/terminal/api/sessionStore.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("sessionStore.ts", source, ts.ScriptTarget.Latest, true);
const body = ast.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(ast)).join("\n");
const compiled = ts.transpileModule(body, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

// Exercise the real store methods against delayed structured storage, without loading user data.
function harness(set) {
  const calls = [], values = new Map([["retiredRemoteHandoffSessions", ["retained"]]]), exports = {};
  runInNewContext(compiled, {
    exports, singleFlight,
    getCliManagerDataPaths: async () => ({ sessionsStorePath: "synthetic" }),
    Store: { load: async () => ({
      set: async (key, value) => { calls.push(key); await set(key, value, calls.length); values.set(key, value); },
    }) },
    create: initialize => {
      let state = initialize();
      const hook = () => state;
      hook.setState = update => { state = { ...state, ...update }; };
      hook.getState = () => state;
      return hook;
    },
  });
  return { store: exports.useSessionStore, calls, values };
}

test("discard waits for earlier snapshot writes so a late snapshot cannot restore cleared sessions", async () => {
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const h = harness(async (_, __, count) => { if (count === 1) await barrier; });
  const save = h.store.getState().saveSessions([{ id: "old", kind: "pty" }]);
  await settle();
  const clear = h.store.getState().clear();
  await settle();
  const premature = h.calls.length;
  release();
  await Promise.all([save, clear]);
  assert.equal(premature, 1, "clear must not interleave with a pending snapshot write");
  assert.equal(h.values.get("sessions").length, 0);
  assert.equal(h.store.getState().sessions.length, 0);
  assert.deepEqual(h.values.get("retiredRemoteHandoffSessions"), ["retained"]);
});

test("a failed write releases ownership and newer session creation remains ordered after discard", async () => {
  const h = harness(async (_, __, count) => { if (count === 1) throw new Error("disk failed"); });
  await assert.rejects(h.store.getState().saveSessions([{ id: "failed" }]), /disk failed/);
  const clear = h.store.getState().clear();
  const save = h.store.getState().saveSessions([{ id: "new", kind: "pty" }]);
  await Promise.all([clear, save]);
  assert.equal(h.values.get("sessions")[0].id, "new");
  assert.deepEqual(h.calls, ["sessions", "sessions", "splits", "activeSessionId", "workspans", "activeWorkspanId", "sessions"]);
});
