import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { startWebBridgePolling } from "./webBridgePolling.ts";
import { createWebDeviceStatusSource } from "./webDeviceStatus.ts";

const stopped = {
  configured: true, running: false, connected: false, paired: false,
  profile: null, pairingCode: null, pairingExpiresAt: null, pendingOperations: 0, lastError: null,
};
const connecting = { ...stopped, running: true };
const online = { ...connecting, connected: true, paired: true };
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("existing global polling publishes daemon connect/pair/disconnect/reconnect without native events", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const source = createWebDeviceStatusSource();
  const observed = [];
  source.subscribe((status) => observed.push(status));
  let status = connecting;
  let connections = 0;
  const polling = startWebBridgePolling({
    getStatus: () => source.refresh(async () => status),
    drainTerminalCommands: async () => {}, drainOperations: async () => {},
    onConnected: () => { connections++; }, onError: assert.fail,
  });
  t.after(() => polling.stop());
  await settle();
  for (const next of [{ ...online, paired: false }, online, connecting, online, stopped]) {
    status = next;
    t.mock.timers.tick(3_000);
    await settle();
    assert.deepEqual(observed.at(-1), next);
  }
  assert.equal(connections, 2);
});

test("late read cannot overwrite a newer stop receipt or return obsolete connection state", async () => {
  const source = createWebDeviceStatusSource();
  const observed = [];
  source.subscribe((status) => observed.push(status));
  const pending = deferred();
  const read = source.refresh(() => pending.promise);
  await source.request(async () => stopped);
  pending.resolve(online);
  assert.deepEqual(await read, stopped);
  assert.deepEqual(observed, [stopped]);
});

test("late start receipt preserves original result but cannot regress a newer online snapshot", async () => {
  const source = createWebDeviceStatusSource();
  const observed = [];
  source.subscribe((status) => observed.push(status));
  const pending = deferred();
  const start = source.request(() => pending.promise);
  await source.refresh(async () => online);
  pending.resolve(connecting);
  assert.deepEqual(await start, connecting);
  assert.deepEqual(observed, [online]);
});

test("equal newer snapshots still supersede old receipts and do not rerender subscribers", async () => {
  const source = createWebDeviceStatusSource();
  const observed = [];
  source.subscribe((status) => observed.push(status));
  await source.refresh(async () => online);
  const pending = deferred();
  const earlier = source.request(() => pending.promise);
  await source.refresh(async () => ({ ...online }));
  pending.resolve(connecting);
  await earlier;
  assert.deepEqual(observed, [online]);
});

test("unmounted pages receive no late result; reopening replays the latest known snapshot", async () => {
  const source = createWebDeviceStatusSource();
  const observed = [];
  const unsubscribe = source.subscribe((status) => observed.push(status));
  await source.refresh(async () => connecting);
  const pending = deferred();
  const read = source.refresh(() => pending.promise);
  unsubscribe();
  pending.resolve(online);
  await read;
  assert.deepEqual(observed, [connecting]);
  const reopened = [];
  source.subscribe((status) => reopened.push(status));
  assert.deepEqual(reopened, [online]);
});

test("overlapping reads share one IPC request; errors preserve snapshot and allow recovery", async () => {
  const source = createWebDeviceStatusSource();
  const observed = [];
  source.subscribe((status) => observed.push(status));
  await source.refresh(async () => connecting);
  const pending = deferred();
  let reads = 0;
  const load = () => { reads++; return pending.promise; };
  const first = source.refresh(load);
  const second = source.refresh(load);
  assert.equal(reads, 1);
  pending.resolve(online);
  await Promise.all([first, second]);
  await assert.rejects(source.refresh(async () => { throw new Error("daemon unavailable"); }), /daemon unavailable/);
  assert.deepEqual(observed.at(-1), online);
  await source.refresh(async () => connecting);
  assert.deepEqual(observed.at(-1), connecting);
});

// 执行真实 IPC 入口，替换宿主 invoke；验证全局查询和每个状态命令都接入同一来源。
test("real Web device API publishes get/save/start/stop/restart/clear receipts and coalesces reads", async () => {
  const source = createWebDeviceStatusSource();
  const observed = [];
  source.subscribe((status) => observed.push(status));
  const calls = [];
  const receipts = {
    web_device_get_status: online,
    web_device_save_profile: { ...online, pendingOperations: 1 },
    web_device_start: connecting,
    web_device_stop: stopped,
    web_device_restart: { ...connecting, pendingOperations: 2 },
    web_device_clear_pairing: { ...online, paired: false },
  };
  const require = createRequire(import.meta.url);
  const ts = require("typescript");
  const exports = {};
  const code = ts.transpileModule(readFileSync(new URL("./webDevice.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, {
    exports,
    require: (id) => {
      if (id === "./webDeviceStatus") return { webDeviceStatusSource: source };
      if (id === "@tauri-apps/api/core") return { invoke: async (command, args) => {
        calls.push({ command, args });
        return receipts[command];
      } };
      throw new Error(`Unexpected dependency: ${id}`);
    },
  });
  const api = exports.webDeviceApi;
  await Promise.all([api.getStatus(), api.getStatus()]);
  assert.equal(calls.length, 1);
  for (const [method, args, command] of [
    ["saveProfile", [{ name: "Desktop" }], "web_device_save_profile"],
    ["start", [], "web_device_start"], ["stop", [], "web_device_stop"],
    ["restart", [], "web_device_restart"], ["clearPairing", [], "web_device_clear_pairing"],
  ]) {
    assert.equal(await api[method](...args), receipts[command]);
    assert.equal(observed.at(-1), receipts[command]);
    assert.equal(calls.at(-1).command, command);
  }
  assert.equal(calls[1].args.request.name, "Desktop");
});
