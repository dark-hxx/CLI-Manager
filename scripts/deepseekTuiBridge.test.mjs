import test from "node:test";
import assert from "node:assert/strict";
import { attachDeepSeekTuiBridge } from "../src-tauri/resources/deepseek-tui-bridge.mjs";
const TAB = "11111111-1111-1111-1111-111111111111";
const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
function fixture(initial) {
  let registration = initial;
  const registrations = new Set();
  const output = [];
  const registry = {
    getTuiChannelRegistration: () => registration,
    onTuiChannelRegistration: (_ctx, listener) => {
      registrations.add(listener);
      return () => registrations.delete(listener);
    },
  };
  return {
    registry, output, registrations,
    set(value) { registration = value; for (const listener of registrations) listener(value); },
    attach(env = { CLI_MANAGER_TAB_ID: TAB }) {
      return attachDeepSeekTuiBridge({}, registry, env, value => output.push(value));
    },
  };
}
function channel(sessionId) {
  const listeners = new Set();
  const value = { sessionId, agentId: B, subscribe(listener) {
    listeners.add(listener); return () => listeners.delete(listener);
  } };
  return { value, listeners, update(id) {
    value.sessionId = id; for (const listener of listeners) listener();
  } };
}
test("initial and selected Session UUID are published instead of Agent UUID", () => {
  const ch = channel(A);
  const f = fixture({ token: {}, channel: ch.value });
  const dispose = f.attach();
  assert.equal(f.output[0], `\x1b]777;cli-manager-dsh-tui;${TAB};${A}\x07`);
  ch.update(A);
  assert.equal(f.output.length, 1);
  ch.update(B);
  assert.equal(f.output.at(-1), `\x1b]777;cli-manager-dsh-tui;${TAB};${B}\x07`);
  dispose(); dispose();
  assert.equal(ch.listeners.size, 0);
  assert.equal(f.registrations.size, 0);
});
test("registration replacement detaches old channel and ignores its queued events", () => {
  const old = channel(A), next = channel(B);
  const f = fixture({ token: {}, channel: old.value });
  const dispose = f.attach();
  const queued = [...old.listeners][0];
  f.set({ token: {}, channel: next.value });
  queued();
  assert.equal(old.listeners.size, 0);
  assert.equal(f.output.length, 2);
  f.set(undefined);
  assert.equal(next.listeners.size, 0);
  queued();
  assert.equal(f.output.length, 2);
  dispose();
});
test("invalid terminal and Session identifiers cannot publish or subscribe", () => {
  const ch = channel("agent-1");
  const f = fixture({ token: {}, channel: ch.value });
  f.attach({ CLI_MANAGER_TAB_ID: "wrong" })();
  assert.equal(f.registrations.size, 0);
  const dispose = f.attach();
  assert.equal(f.output.length, 0);
  ch.update(A);
  assert.equal(f.output.length, 1);
  dispose();
});
test("late registration captures initial UUID and disposed bridge remains quiet", () => {
  const f = fixture();
  const dispose = f.attach();
  const ch = channel(A);
  f.set({ token: {}, channel: ch.value });
  assert.equal(f.output.length, 1);
  dispose(); ch.update(B);
  f.set({ token: {}, channel: channel(B).value });
  assert.equal(f.output.length, 1);
});

test("A to B to A registrations report foreground identity with new token ownership", () => {
  const a = channel(A), b = channel(B);
  const f = fixture({ token: {}, channel: a.value });
  const dispose = f.attach();
  const stale = [...a.listeners][0];
  f.set({ token: {}, channel: b.value });
  f.set({ token: {}, channel: a.value });
  stale();
  assert.equal(f.output.length, 3);
  assert.equal(f.output.at(-1), `\x1b]777;cli-manager-dsh-tui;${TAB};${A}\x07`);
  dispose();
});
