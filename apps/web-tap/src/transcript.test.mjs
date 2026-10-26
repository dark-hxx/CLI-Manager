import assert from "node:assert/strict";
import { test } from "node:test";
import { performance } from "node:perf_hooks";
import { stableTurns, mergeTranscript, groupTurns } from "./turns.ts";
import { createTranscriptSignals } from "./transcriptSignals.ts";
import { hookHarness, loadModule, nodes, deferred } from "../tests/reactHarness.mjs";

function fixture(respond, incremental = true) {
  const h = hookHarness(), calls = [], timers = new Map(), output = new Set(), visibility = new Set();
  const changes = createTranscriptSignals();
  let now = 0, nextId = 0, props;
  const document = { visibilityState: "visible", addEventListener: (_, f) => visibility.add(f), removeEventListener: (_, f) => visibility.delete(f) };
  const { Conversation } = loadModule("Conversation.tsx", {
    react: h.react, "react-markdown": {}, "remark-gfm": {}, "./i18n": {},
    "./turns": { stableTurns, mergeTranscript }, "./format": {}, "./ConversationCodeBlock": {},
    "./ConversationActivity": {}, "./ConversationStep": {}, "./ConversationTurnRail": {}, "./chatScroll": {},
    "./chatFind": {}, "./tools": {}, "./rail": { railPrompts: () => [] },
    "./ChatSearch": { SearchProvider: "SearchProvider", useChatSearch: () => ({ hits: null }) },
  }, { document, setTimeout: (f, delay) => { const id = ++nextId; timers.set(id, { at: now + delay, f }); return id; }, clearTimeout: (id) => timers.delete(id) });
  props = { sessionId: "pty", scope: "user:device", context: { projectId: "project" },
    active: true, supported: true, incremental, changes, chatSize: 15, t: (key) => key,
    stream: { subscribe: (_, f) => { output.add(f); return () => output.delete(f); } },
    run: async (kind, payload) => { calls.push({ kind, payload, at: now }); return respond(payload, calls.length); } };
  h.mount(() => Conversation(props));
  return { h, calls, props, changes, document, timers, output,
    outputNow: () => output.forEach((f) => f()),
    visible: (value) => { document.visibilityState = value; visibility.forEach((f) => f()); },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const first = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!first) break;
        now = first[1].at; timers.delete(first[0]); first[1].f(); await h.settle();
      }
      now = end; await h.settle();
    },
    turn: () => nodes(h.value).find((node) => node.type?.type?.name === "TurnView")?.props.turn,
  };
}
const page = (text = "Answer", revision = "epoch:2") => ({ available: true, cliSessionId: "cli", epoch: "epoch", revision,
  start: 0, total: 2, messages: [{ id: "cli:0", role: "user", text: "Question" }, { id: "cli:1", role: "assistant", text }] });

test("active incremental chat coalesces at 400ms, retains unchanged turns and loads late final log hints", async () => {
  let latest = page();
  const f = fixture((payload) => payload.revision === latest.revision ? { ...latest, unchanged: true, messages: [] } : latest);
  await f.h.settle();
  const first = f.turn();
  for (let i = 0; i < 40; i++) f.outputNow();
  await f.advance(399); assert.equal(f.calls.length, 1);
  await f.advance(1); assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].payload.revision, "epoch:2");
  assert.equal(f.turn(), first, "unchanged result must not rebuild turn or Markdown props");
  latest = page("Final delayed disk write", "epoch:3");
  f.changes.publish("other-session"); await f.advance(400); assert.equal(f.calls.length, 2);
  f.changes.publish("pty"); await f.advance(400);
  assert.equal(f.turn().answer.text, "Final delayed disk write");
  assert.equal(f.calls.at(-1).at, 1200);
  f.h.dispose(); assert.equal(f.output.size, 0); assert.equal(f.timers.size, 0);
});

test("single-flight trailing refresh handles notifications during a slow request; hidden/old hosts do not poll", async () => {
  const first = deferred();
  let inFlight = 0, peak = 0;
  const f = fixture(async (_, n) => { inFlight++; peak = Math.max(peak, inFlight); const result = n === 1 ? await first.promise : page(); inFlight--; return result; });
  f.changes.publish("pty"); f.outputNow(); await f.advance(900);
  assert.equal(f.calls.length, 1);
  first.resolve(page()); await f.h.settle(); await f.advance(0);
  assert.equal(f.calls.length, 2); assert.equal(peak, 1);
  f.visible("hidden"); f.outputNow(); f.changes.publish("pty"); await f.advance(20_000);
  assert.equal(f.calls.length, 2);
  f.visible("visible"); await f.h.settle(); assert.equal(f.calls.length, 3);
  f.props.active = false; f.h.render(); await f.advance(20_000); assert.equal(f.calls.length, 3);
  f.h.dispose();
  const old = fixture(() => page(), false); await old.h.settle(); await old.advance(20_000);
  assert.equal(old.calls.length, 1, "legacy full-file hosts must not gain continuous polling"); old.h.dispose();
});

test("account/device generation isolates old in-flight responses even when PTY ID is reused", async () => {
  const first = deferred(), second = deferred();
  const f = fixture((_, n) => n === 1 ? first.promise : second.promise);
  f.props.scope = "other-user:other-device"; f.h.render();
  second.resolve(page("New device")); await f.h.settle();
  first.resolve(page("Old private response")); await f.h.settle();
  assert.equal(f.turn().answer.text, "New device");
  f.h.dispose();
});

test("reconciliation preserves old pages, and stable grouping skips all unchanged tool derivation", () => {
  const messages = Array.from({ length: 2000 }, (_, i) => ({ id: `cli:${i}`, role: i % 2 ? "assistant" : "user", text: `message ${i}` }));
  const turns = stableTurns(messages, []);
  assert.deepEqual(turns, groupTurns(messages));
  const snapshot = mergeTranscript(messages, { messages: structuredClone(messages.slice(-40)), total: messages.length }, false);
  assert.equal(snapshot, messages);
  const changed = mergeTranscript(messages, { messages: [{ ...messages.at(-1), text: "Updated" }], total: messages.length }, false);
  const start = performance.now();
  for (let i = 0; i < 100; i++) groupTurns(changed);
  const fullMs = performance.now() - start;
  const at = performance.now();
  let next;
  for (let i = 0; i < 100; i++) next = stableTurns(changed, turns);
  const stableMs = performance.now() - at;
  assert.equal(next.length, 1000);
  assert.equal(next[998], turns[998]); assert.notEqual(next[999], turns[999]);
  console.log(`TAP_RENDER_BENCH turns=1000 runs=100 full_group_ms=${fullMs.toFixed(2)} stable_group_ms=${stableMs.toFixed(2)} reused=999/1000`);
});
