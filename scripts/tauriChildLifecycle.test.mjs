import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("./tauri-cli.mjs", import.meta.url), "utf8");
const ast = ts.createSourceFile("tauri-cli.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
let initializer;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "runTauri") initializer = node.initializer.getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(initializer, "test must exercise the production child runner");

function harness() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const errors = [];
  const exports = {};
  runInNewContext(`exports.run = (${initializer});`, {
    exports, spawn: () => child, tauriArgs: ["dev"], tauriRoot: "synthetic", devSpawnEnv: () => ({}),
    process: { platform: "win32", stdout: { write() {} }, stderr: { write() {} } },
    console: { error: message => errors.push(message) }, setTimeout, clearTimeout,
  });
  return { child, errors, run: exports.run, close: () => { child.stdout.destroy(); child.stderr.destroy(); } };
}

test("a departed Tauri child cannot wait forever for inherited Vite output pipes", async () => {
  const h = harness();
  let timeout;
  try {
    const pending = h.run();
    h.child.stderr.write("synthetic CLI startup failure\n");
    h.child.emit("exit", 23, null);
    const result = await Promise.race([pending, new Promise(resolve => { timeout = setTimeout(() => resolve(null), 1200); })]);
    assert.ok(result, "child exit must settle even when descendants retain both pipes");
    assert.equal(result.code, 23);
    assert.match(result.output, /synthetic CLI startup failure/);
    assert.equal(h.child.stdout.destroyed, true);
    assert.equal(h.child.stderr.destroyed, true);
  } finally {
    clearTimeout(timeout);
    h.close();
  }
});

test("normal close drains final error output before locked-binary recovery", async () => {
  const h = harness();
  try {
    const pending = h.run();
    h.child.emit("exit", 1, null);
    h.child.stderr.write("error: failed to remove file `synthetic/cli-manager.exe`\nCaused by: os error 5\n");
    h.child.emit("close", 1, null);
    const result = await pending;
    assert.equal(result.code, 1);
    assert.match(result.output, /os error 5/);
  } finally {
    h.close();
  }
});

test("a signaled child reports failure instead of looking like a healthy idle server", async () => {
  const h = harness();
  try {
    const pending = h.run();
    h.child.emit("exit", null, "SIGTERM");
    const result = await pending;
    assert.equal(result.code, 1);
    assert.ok(h.errors.some(message => message.includes("SIGTERM")));
  } finally {
    h.close();
  }
});

test("repeated rebuild output retains a bounded diagnostic tail", async () => {
  const h = harness();
  try {
    const pending = h.run();
    h.child.stdout.write("old build output\n".repeat(20000));
    h.child.stderr.write("latest synthetic startup error\n");
    h.child.emit("close", 1, null);
    const result = await pending;
    assert.equal(result.code, 1);
    assert.ok(result.output.length <= 64 * 1024);
    assert.match(result.output, /latest synthetic startup error/);
  } finally {
    h.close();
  }
});
