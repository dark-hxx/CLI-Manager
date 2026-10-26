import assert from "node:assert/strict";
import { createTranscriptSignals } from "./transcriptSignals.ts";
import { test } from "node:test";
import { deferred, hookHarness, loadModule } from "../tests/reactHarness.mjs";

const device = (id, supported = false) => ({ id, status: "online", capabilities: supported ? ["terminal.transcript"] : [] });
class ApiError extends Error {
  constructor(status) { super(`HTTP ${status}`); this.status = status; }
}

async function workspaceFixture(deviceScope) {
  const h = hookHarness(), requests = [], sockets = [];
  const { useWorkspace } = loadModule("useWorkspace.ts", {
    "./transcriptSignals": { createTranscriptSignals },
    react: h.react,
    "./operations": { createOperationRunner: () => ({ cancel() {}, publish() {}, run: async () => null }) },
    "./protocol": {
      ApiError,
      api: {
        auth: async () => ({ authenticated: true, user: { id: "u" }, deviceScope }),
        devices: () => { const request = deferred(); requests.push(request); return request.promise; },
        logout: async () => {},
      },
      createTerminalStream: () => ({ clear() {}, start() {}, renderedSequence: () => 0 }),
      connectBrowserSocket: (options) => {
        const socket = { ...options, closed: false, close() { this.closed = true; }, sendTerminal: () => true };
        sockets.push(socket); return socket;
      },
    },
  }, {
    location: { hash: "", search: "", href: "https://test.invalid/tap/" }, history: { replaceState() {} },
    localStorage: { getItem: () => null }, window: { addEventListener() {}, removeEventListener() {} },
    setTimeout: () => 1, clearTimeout() {}, URLSearchParams,
  });
  h.mount(useWorkspace); await h.settle();
  assert.equal(requests.length, 1);
  requests[0].resolve({ devices: [device("a"), device("b")] }); await h.settle();
  assert.equal(sockets.length, 1);
  const ready = (sequence = 5) => sockets.at(-1).onMessage({ type: "ready", latestSequence: sequence });
  const update = (value, sequence = 6) => sockets.at(-1).onMessage({ type: "event", sequence,
    payload: { type: "device.updated", device: value } });
  return { h, requests, sockets, ready, update };
}

test("ready refreshes old capabilities even when device.updated is a replay; mobile scope stays restricted", async () => {
  const { h, requests, ready, update } = await workspaceFixture("a");
  ready(); await h.settle();
  assert.equal(requests.length, 2, "ready must re-read the capability snapshot");
  update(device("a", true), 4); await h.settle();
  assert.equal(h.value.device.capabilities.length, 0, "historical events remain excluded");
  requests[1].resolve({ devices: [device("a", true), device("b", true), device("new", true)] });
  await h.settle();
  assert.equal(h.value.device.capabilities[0], "terminal.transcript");
  assert.deepEqual([...h.value.devices].map((item) => item.id), ["a"]);
  assert.equal(h.value.link, "open");
  h.dispose();
});

test("new device events win over pending snapshots without blocking refreshes for other devices", async () => {
  const { h, requests, ready, update } = await workspaceFixture();
  ready(); await h.settle();
  update({ ...device("b", true), name: "new event" }); await h.settle();
  requests[1].resolve({ devices: [device("a", true), device("b")] }); await h.settle();
  assert.equal(h.value.device.capabilities[0], "terminal.transcript");
  assert.equal(h.value.devices.find((item) => item.id === "b").name, "new event");
  assert.equal(h.value.devices.find((item) => item.id === "b").capabilities[0], "terminal.transcript");
  h.dispose();
});

test("a delayed snapshot cannot restore revoked capability from a newer device event", async () => {
  const { h, requests, ready, update } = await workspaceFixture();
  ready(); await h.settle();
  update({ ...device("a"), name: "revoked" }); await h.settle();
  requests[1].resolve({ devices: [device("a", true), device("b", true)] }); await h.settle();
  assert.equal(h.value.device.name, "revoked");
  assert.equal(h.value.device.capabilities.length, 0);
  h.dispose();
});

test("device switch discards a delayed old response or 401", async () => {
  for (const error of [false, true]) {
    const { h, requests, ready, sockets } = await workspaceFixture();
    ready(); await h.settle();
    h.value.setDeviceId("b");
    // Settle the old flight before React has committed effect cleanup for the new device.
    if (error) requests[1].reject(new ApiError(401));
    else requests[1].resolve({ devices: [{ ...device("b", true), name: "stale" }] });
    await h.settle();
    assert.equal(sockets[0].closed, true);
    assert.equal(sockets.length, 2);
    assert.equal(h.value.user.id, "u");
    assert.equal(h.value.deviceId, "b");
    assert.equal(h.value.device.capabilities.length, 0);
    assert.equal(h.value.authError, "");
    h.dispose();
  }
});

test("logout prevents pending capability reads from restoring devices", async () => {
  const { h, requests, ready } = await workspaceFixture();
  ready(); await h.settle();
  await h.value.logout(); await h.settle();
  requests[1].resolve({ devices: [device("a", true)] }); await h.settle();
  assert.equal(h.value.user, null);
  assert.equal(h.value.devices.length, 0);
  h.dispose();
});

test("a later ready supersedes old success and error responses, while current authentication failures expire", async () => {
  for (const error of [false, true]) {
    const { h, requests, ready } = await workspaceFixture();
    ready(5); ready(8); await h.settle();
    assert.equal(requests.length, 3);
    requests[2].resolve({ devices: [device("a", true)] }); await h.settle();
    if (error) requests[1].reject(new ApiError(401));
    else requests[1].resolve({ devices: [device("a")] });
    await h.settle();
    assert.equal(h.value.device.capabilities[0], "terminal.transcript");
    assert.equal(h.value.user.id, "u");
    ready(9); await h.settle();
    requests[3].reject(new ApiError(401)); await h.settle();
    assert.equal(h.value.user, null);
    assert.equal(h.value.authError, "authExpired");
    h.dispose();
  }
});

test("reconnect discovers newly paired development devices without silently changing the current session", async () => {
  const { h, requests, ready, update } = await workspaceFixture();
  ready(); await h.settle();
  requests[1].resolve({ devices: [device("a"), device("b"), { ...device("dev", true), clientKind: "development" }] });
  await h.settle();
  assert.ok(h.value.devices.some((item) => item.id === "dev" && item.capabilities.includes("terminal.transcript")));
  assert.equal(h.value.deviceId, "a", "discovering another host must not move existing sessions");
  update({ ...device("live-dev", true), clientKind: "development" }, 6); await h.settle();
  assert.equal(h.value.devices.filter((item) => item.id === "live-dev").length, 1);
  update({ ...device("live-dev", true), name: "renamed" }, 7); await h.settle();
  assert.equal(h.value.devices.filter((item) => item.id === "live-dev").length, 1);
  h.value.setDeviceId("dev"); await h.settle();
  assert.equal(h.value.deviceId, "dev");
  assert.ok(h.value.device.capabilities.includes("terminal.transcript"));
  h.dispose();
});

test("mobile authorization excludes newly discovered devices from snapshots and live updates", async () => {
  const { h, requests, ready, update } = await workspaceFixture("a");
  ready(); await h.settle();
  update(device("dev", true)); await h.settle();
  requests[1].resolve({ devices: [device("a", true), device("dev", true)] }); await h.settle();
  assert.deepEqual([...h.value.devices].map((item) => item.id), ["a"]);
  h.value.setDeviceId("dev"); await h.settle();
  assert.equal(h.value.deviceId, "a");
  h.dispose();
});
