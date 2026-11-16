import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

const ts = createRequire(import.meta.url)("typescript");
function load(file, dependencies = {}) {
  const exports = {};
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, { exports, require: (name) => {
    assert.ok(name in dependencies, name);
    return dependencies[name];
  } });
  return exports;
}
const status = (state) => ({ running: state !== "stopped", connected: state === "online", paired: true, lastError: null });

function fixture(invoke) {
  const channel = load("./webDeviceStatus.ts");
  const { webDeviceApi } = load("./webDevice.ts", {
    "@tauri-apps/api/core": { invoke }, "./webDeviceStatus": channel,
  });
  return { channel, api: webDeviceApi };
}

test("existing getStatus probes publish the full daemon snapshot to all settings listeners", async () => {
  let next = status("connecting");
  const { channel, api } = fixture(async () => next);
  const a = [], b = [];
  const unsubscribe = channel.subscribeWebDeviceStatus((value) => a.push(value));
  await api.start();
  channel.subscribeWebDeviceStatus((value) => b.push(value));
  next = { ...status("online"), pairingCode: null, pendingOperations: 2 };
  await api.getStatus();
  assert.equal(a.at(-1), next);
  assert.equal(b.at(-1), next);
  unsubscribe();
  next = status("stopped");
  await api.stop();
  assert.equal(a.length, 2);
  assert.equal(b.at(-1), next);
});

test("late pre-connect or pre-disconnect probes cannot overwrite a newer action result", async () => {
  const pending = [];
  const { channel, api } = fixture((command) => new Promise((resolve) => pending.push({ command, resolve })));
  const received = [];
  channel.subscribeWebDeviceStatus((value) => received.push(value));
  const oldProbe = api.getStatus();
  const connect = api.start();
  pending[1].resolve(status("online"));
  await connect;
  pending[0].resolve(status("stopped"));
  await oldProbe;
  assert.equal(received.length, 1);
  assert.equal(received[0].connected, true);
  const oldOnline = api.getStatus();
  const disconnect = api.stop();
  pending[3].resolve(status("stopped"));
  await disconnect;
  pending[2].resolve(status("online"));
  await oldOnline;
  assert.equal(received.at(-1).running, false);
  assert.equal(received.length, 2);
});

test("native events invalidate older IPC responses, failed requests do not publish fake success", async () => {
  let resolve;
  const { channel, api } = fixture(() => new Promise((done) => { resolve = done; }));
  const received = [];
  channel.subscribeWebDeviceStatus((value) => received.push(value));
  const request = api.getStatus();
  channel.publishWebDeviceStatus(status("online"));
  resolve(status("stopped"));
  await request;
  assert.equal(received.length, 1);
  const failed = fixture(async () => { throw new Error("IPC unavailable"); });
  failed.channel.subscribeWebDeviceStatus((value) => received.push(value));
  await assert.rejects(failed.api.getStatus(), /IPC unavailable/);
  assert.equal(received.length, 1);
});

test("a completed action supersedes a probe started while that action was pending", async () => {
  const pending = [];
  const { channel, api } = fixture(() => new Promise((resolve) => pending.push(resolve)));
  const received = [];
  channel.subscribeWebDeviceStatus((value) => received.push(value));
  const connect = api.start();
  const during = api.getStatus();
  pending[1](status("connecting"));
  await during;
  pending[0](status("online"));
  await connect;
  assert.equal(received.at(-1).connected, true);
});
