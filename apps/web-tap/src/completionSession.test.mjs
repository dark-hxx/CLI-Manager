import assert from "node:assert/strict";
import { test } from "node:test";
import { translator } from "./i18n.ts";
import * as format from "./format.ts";
import { deferred, hookHarness, loadModule, nodes } from "../tests/reactHarness.mjs";

function setup(strictEffects = false) {
  const h = hookHarness(), sent = [], prefixes = [], keys = [], preferences = [], pending = deferred(); let focused = 0, blurred = 0;
  const { SessionView } = loadModule("SessionView.tsx", {
    react: { ...h.react, lazy: () => "Conversation", useEffect: (effect, deps) => h.react.useEffect(() => {
      if (strictEffects) effect()?.();
      return effect();
    }, deps) }, "react-dom": { flushSync: (run) => run() },
    "./Terminal": { Terminal: "Terminal" }, "./Composer": { Composer: "Composer" }, "./KeyBar": { KeyBar: "KeyBar" },
    "./SessionHeader": { SessionHeader: "Header" }, "./Dock": { DockStatus: "Dock" },
    "./git": { gitKey: () => "git", useGit: () => ({ summary: null, refresh() {} }) }, "./format": format,
    "../../../src/shared/lib/webImageUpload": {},
    "./preferences": { resolved: (prefs) => ({ view: "chat", fontSize: 13, chatSize: 15, keys: true, ...prefs }), TERMINAL_SIZES: { min: 9, max: 22 } },
  }, { setTimeout: () => 1, clearTimeout() {} });
  const model = { workspace: {
    terminals: [{ sessionId: "pty-a", projectId: "p", worktreeId: "wt" }],
    projects: [{ id: "p", name: "Project", source: "codex" }], worktrees: [{ id: "wt", name: "Branch" }],
  }, states: { "pty-a": { status: "running" } }, link: "open", device: { status: "online", capabilities: ["terminal.transcript", "file.management"] },
  user: { id: "u" }, deviceId: "host", reconnect() {}, run() {} };
  const props = { id: "pty-a", active: true, model, prefs: { view: "chat" }, setPrefs: (value) => preferences.push(value), t: translator("zh-CN") };
  h.mount(() => SessionView(props));
  const terminal = nodes(h.value).find((node) => node.type === "Terminal");
  const handle = { message: (text) => { sent.push(text); return pending.promise; }, focus: () => focused++, leaveDirect: () => blurred++,
    command: (text) => { prefixes.push(text); return true; }, key: (key) => { keys.push(key); return true; } };
  terminal.props.ref.current = handle;
  return { h, props, model, sent, prefixes, keys, handle, pending, preferences, get focused() { return focused; }, get blurred() { return blurred; },
    composer: () => nodes(h.value).find((node) => node.type === "Composer").props,
    terminal: () => nodes(h.value).find((node) => node.type === "Terminal"),
    back: () => nodes(h.value).find((node) => node.type === "button" && node.props.children === props.t("nativeCommandReturn")),
  };
}

test("slash and Skill delivery keep the conversation visible without focusing the native terminal", async () => {
  const f = setup(), context = f.composer().completion;
  assert.equal(context.source, "codex"); assert.equal(context.projectId, "p"); assert.equal(context.worktreeId, "wt");
  assert.equal(context.run, f.model.run); assert.equal(context.enabled, true);
  const send = f.composer().onSend("/model ");
  assert.match(f.h.value.props.className, /is-chat/);
  f.pending.resolve(true); await send; f.h.render();
  assert.match(f.h.value.props.className, /is-chat/);
  assert.equal(context.sessionId, "pty-a"); assert.equal(f.composer().onCommand, undefined);
  assert.equal(f.terminal().props.visible, false);
  assert.equal(f.back(), undefined);
  assert.equal(f.focused, 0); assert.deepEqual(f.sent, ["/model "]); assert.deepEqual(f.preferences, []);
  f.h.dispose();
});

test("ordinary messages and failed command delivery stay in conversation", async () => {
  for (const [text, accepted] of [["please explain @src/app.ts", true], ["/review", true], ["$review", true], ["/model", false]]) {
    const f = setup(); const send = f.composer().onSend(text); f.pending.resolve(accepted); await send; f.h.render();
    assert.match(f.h.value.props.className, /is-chat/); assert.equal(f.focused, 0);
    f.h.dispose();
  }
});

test("StrictMode effect cleanup and setup do not leave a live session marked unmounted", async () => {
  const f = setup(true), send = f.composer().onSend("/model");
  f.pending.resolve(true); await send; f.h.render();
  assert.deepEqual(f.sent, ["/model"]); assert.equal(f.focused, 0);
  assert.match(f.h.value.props.className, /is-chat/); assert.equal(f.back(), undefined);
  f.h.dispose();
});

test("native terminal remains available through explicit view selection and direct input", () => {
  const f = setup();
  f.composer().onDirect(); f.h.render();
  assert.equal(f.terminal().props.visible, true); assert.equal(f.focused, 1);
  assert.equal(nodes(f.h.value).filter((node) => node.type === "Terminal").length, 1);
  assert.equal(f.composer().completion.enabled, false);
  nodes(f.h.value).find((node) => node.type === "Header").props.onView("chat"); f.h.render();
  assert.equal(f.terminal().props.visible, false); assert.equal(f.composer().completion.enabled, true);
  assert.deepEqual(f.prefixes, []); assert.deepEqual(f.sent, []);
  f.h.dispose();
});

test("disabled and stale session callbacks cannot send Skill input", async () => {
  const f = setup();
  for (const change of [() => { f.model.link = "closed"; }, () => { f.model.link = "open"; f.props.active = false; },
    () => { f.props.active = true; f.model.deviceId = "new-device"; }]) {
    const oldSend = f.composer().onSend;
    change(); f.h.render(); assert.equal(await oldSend("$review"), false);
  }
  assert.deepEqual(f.sent, []); assert.equal(f.terminal().props.visible, false);
  f.h.dispose();
});

test("late delivery cannot steal focus after session, account or worktree switches or unmount", async () => {
  for (const change of [
    (f) => { f.props.active = false; },
    (f) => { f.model.deviceId = "another-device"; },
    (f) => { f.model.user = { id: "another-user" }; },
    (f) => { f.model.workspace.terminals[0].worktreeId = "another-worktree"; },
    (f) => { f.h.dispose(); return false; },
  ]) {
    const f = setup(); const send = f.composer().onSend("/permissions");
    const mounted = change(f) !== false;
    if (mounted) f.h.render();
    f.pending.resolve(true); await send; if (mounted) f.h.render();
    assert.equal(f.focused, 0); assert.match(f.h.value.props.className, /is-chat/);
    f.h.dispose();
  }
});

test("viewport publishes actual keyboard-reduced height without changing its existing root pan policy", () => {
  const h = hookHarness(), vars = new Map();
  const root = { style: { top: "", setProperty: (key, value) => vars.set(key, value) } };
  const win = { innerHeight: 800, visualViewport: { height: 400, offsetTop: 0, scale: 1 } };
  const { useViewportBox, paintViewport } = loadModule("viewport.ts", { react: h.react }, {
    window: win, document: { documentElement: { dataset: {} } },
  }, ["paintViewport"]);
  h.mount(() => useViewportBox({ current: root }));
  assert.equal(vars.get("--vv-height"), "400px"); assert.equal(root.style.top, "-400px");
  win.visualViewport.height = 800; paintViewport();
  assert.equal(vars.get("--vv-height"), "800px"); assert.equal(root.style.top, "");
  h.dispose();
});
