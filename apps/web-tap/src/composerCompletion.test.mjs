import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as completion from "./completion.ts";
import * as input from "./input.ts";
import * as i18n from "./i18n.ts";
import { deferred, hookHarness, loadModule, nodes } from "../tests/reactHarness.mjs";

function timers() {
  const pending = new Map(); let next = 0;
  return { setTimeout: (fn) => { pending.set(++next, fn); return next; }, clearTimeout: (id) => pending.delete(id),
    async tick() { const jobs = [...pending.values()]; pending.clear(); for (const fn of jobs) void fn(); await Promise.resolve(); },
  };
}
function setup({ source = "codex", run = async () => [], phone = false } = {}) {
  const h = hookHarness(), time = timers(), sent = [], commands = [], storage = new Map(), replacements = [];
  const { useComposerCompletion } = loadModule("useComposerCompletion.ts", { react: h.react, "./completion.ts": completion }, time);
  const { Composer } = loadModule("Composer.tsx", {
    react: h.react, "./Menu": { Menu: "Menu" }, "./i18n": i18n, "./input": input,
    "./completion": completion, "./useComposerCompletion": { useComposerCompletion }, "./ComposerCompletion": { ComposerCompletion: "Completion" },
  }, { localStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) } });
  const props = { storageKey: "account:device:session", disabled: false, phone, cli: source, modifiers: { ctrl: false, alt: false },
    clearModifiers() {}, onCharacter() {}, onSend: async (text) => { sent.push(text); return true; }, onInterrupt() {}, onDirect() {},
    onCommand: (prefix) => { commands.push(prefix); return true; }, // Regression trap: Composer must never hand off typing.
    onImage() {}, t: i18n.translator("zh-CN"),
    completion: { enabled: true, source, projectId: "project-a", worktreeId: "wt", sessionId: "pty-a",
      capabilities: ["file.management", "terminal.skills"], run },
  };
  const field = () => nodes(h.value).find((node) => node.type === "textarea");
  const menu = () => nodes(h.value).find((node) => node.type === "Completion").props.menu;
  h.mount(() => Composer(props));
  const element = { scrollHeight: 40, style: {}, focus() {}, setSelectionRange: (...values) => replacements.push(values) };
  field().props.ref.current = element;
  field().props.onFocus(); h.render();
  return { h, time, props, sent, commands, storage, replacements, field, menu,
    type(text, start = text.length, end = start) {
      field().props.onChange({ target: { value: text, selectionStart: start, selectionEnd: end } }); h.render();
    },
    key(key, extra = {}) {
      const event = { key, nativeEvent: {}, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...extra };
      field().props.onKeyDown(event); h.render(); return event;
    },
    async tick() { await time.tick(); await h.settle(); },
  };
}

test("slash opens local Skill completion and preserves the draft without PTY input on desktop and mobile", () => {
  for (const phone of [false, true]) {
    const f = setup({ phone });
    for (const prefix of ["/", "/", "/mcp", "/plugin:skill", "/"]) {
      f.type(prefix);
      assert.equal(f.field().props.value, prefix);
      assert.equal(f.menu().open, true);
      assert.equal(f.storage.get(f.props.storageKey), prefix);
    }
    assert.deepEqual(f.commands, []);
    assert.deepEqual(f.sent, []);
    f.h.dispose();
  }
});

test("missing Skill capability preserves the exact draft and makes no request", async () => {
  const calls = [], f = setup({ run: async (kind) => { calls.push(kind); return []; } });
  f.props.completion.capabilities = ["file.management"]; f.h.render(); f.type("/mcp"); await f.tick();
  assert.equal(f.field().props.value, "/mcp");
  assert.equal(f.storage.get(f.props.storageKey), "/mcp");
  assert.deepEqual(f.commands, []); assert.deepEqual(f.sent, []); assert.deepEqual(calls, []);
  assert.equal(f.menu().error, "completionSkillsUnavailable");
  f.h.dispose();
});

test("paths, arguments, selections and unsupported or inactive contexts stay in the local draft", () => {
  const f = setup();
  for (const text of ["/src/app.ts", "/skill argument", "explain /mcp", "/mcp\n"]) {
    f.type(text); assert.equal(f.field().props.value, text);
  }
  f.type("/mcp", 0, 4); assert.deepEqual(f.commands, []);
  for (const change of [() => { f.props.disabled = true; }, () => { f.props.disabled = false; f.props.completion.enabled = false; },
    () => { f.props.completion.enabled = true; f.props.completion.source = "shell"; }]) {
    change(); f.h.render(); f.type("/"); assert.deepEqual(f.commands, []);
  }
  f.h.dispose();
});

test("IME and held Enter never hand off or submit; explicit modified Enter still sends", async () => {
  const f = setup();
  f.field().props.onCompositionStart(); f.h.render();
  f.type("/mo"); assert.deepEqual(f.commands, []);
  assert.equal(f.menu().open, false);
  f.key("Enter"); assert.deepEqual(f.sent, []);
  f.field().props.onCompositionEnd({ currentTarget: { selectionStart: 3, selectionEnd: 3 } }); f.h.render();
  f.key("Enter", { nativeEvent: { isComposing: true } });
  f.key("Enter", { keyCode: 229 });
  assert.equal(f.field().props.value, "/mo");
  assert.equal(f.key("Enter", { repeat: true }).prevented, true);
  f.key("Enter", { ctrlKey: true }); await f.h.settle();
  assert.deepEqual(f.sent, ["/mo"]);
  f.h.dispose();
});

test("file navigation uses registered worktree IDs and inserts a quoted reference at the caret", async () => {
  const calls = [];
  const f = setup({ run: async (kind, payload) => {
    calls.push({ kind, payload });
    return payload.path === "" ? [{ name: "my docs", path: "my docs", kind: "directory" }]
      : [{ name: "文件.md", path: "my docs/文件.md", kind: "file" }];
  } });
  f.type("check @"); await f.tick();
  assert.equal(calls[0].kind, "file.list");
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].payload)), { projectId: "project-a", worktreeId: "wt", path: "" });
  f.key("Enter"); await f.tick();
  assert.equal(f.field().props.value, 'check @"my docs/');
  assert.equal(calls[1].payload.path, "my docs");
  f.key("Tab");
  assert.equal(f.field().props.value, 'check @"my docs/文件.md" ');
  assert.deepEqual(f.sent, []);
  assert.equal(f.menu().open, false);
  assert.ok(f.replacements.length > 0);
  f.h.dispose();
});

test("file completion dismissal lasts only until input changes, including repeated identical mentions", async () => {
  const f = setup({ run: async () => [{ name: "one", path: "one", kind: "file" }, { name: "two", path: "two", kind: "file" }] });
  f.type("@"); await f.tick(); f.key("ArrowDown"); f.key("Enter");
  assert.equal(f.field().props.value, "@two "); assert.equal(f.menu().open, false);
  assert.equal(f.key("Enter", { repeat: true }).prevented, true); assert.deepEqual(f.sent, []);
  f.type(""); f.type("@"); await f.tick(); assert.equal(f.menu().open, true);
  f.key("Escape"); f.h.render(); assert.equal(f.menu().open, false);
  f.type("@o"); f.type("@"); await f.tick(); assert.equal(f.menu().open, true);
  f.key("Tab"); assert.equal(f.field().props.value, "@one ");
  f.h.dispose();
});

test("file operations require the host's aggregate capability, not operation names", async () => {
  const calls = [], f = setup({ run: async (kind) => { calls.push(kind); return []; } });
  f.type("@"); await f.tick(); f.type("@src"); await f.tick();
  assert.deepEqual(calls, ["file.list", "file.search"]);
  f.props.completion.capabilities = ["file.list", "file.search"];
  f.h.render(); f.type("@missing"); await f.tick();
  assert.equal(f.menu().error, "completionUnavailable"); assert.equal(calls.length, 2);
  f.h.dispose();
});

test("typing is debounced and serialized; old results cannot replace the latest query", async () => {
  const calls = [], first = deferred(), second = deferred();
  const f = setup({ run: (kind, payload) => { calls.push({ kind, payload }); return calls.length === 1 ? first.promise : second.promise; } });
  f.type("@a"); f.type("@ab"); await f.tick();
  assert.equal(calls.length, 1); assert.equal(calls[0].payload.query, "ab");
  f.type("@abc"); await f.tick(); f.type("@abcd"); await f.tick();
  assert.equal(calls.length, 1, "no queue behind the in-flight request");
  assert.equal(f.key("Enter").prevented, true); assert.deepEqual(f.sent, []);
  first.resolve([{ name: "old", path: "old", kind: "file" }]); await f.h.settle();
  assert.equal(calls.length, 2); assert.equal(calls[1].payload.query, "abcd");
  assert.equal(f.menu().items.length, 0);
  second.resolve([{ name: "abcd.ts", path: "abcd.ts", kind: "file" }]); await f.h.settle();
  assert.equal(f.menu().items[0].value, "abcd.ts");
  f.h.dispose();
});

test("closing, disconnecting and context changes hide stale results; unavailable capabilities make no request", async () => {
  const late = deferred(), calls = [];
  const f = setup({ run: (kind, payload) => { calls.push(payload); return late.promise; } });
  f.type("@"); await f.tick(); f.key("Escape");
  late.resolve([{ name: "private", path: "private", kind: "file" }]); await f.h.settle();
  assert.equal(f.menu().open, false);
  f.props.disabled = true; f.h.render(); f.type("@private"); await f.tick();
  assert.equal(calls.length, 1);
  f.props.disabled = false; f.props.completion.capabilities = []; f.h.render();
  assert.equal(f.menu().error, "completionUnavailable"); await f.tick(); assert.equal(calls.length, 1);
  f.props.completion.capabilities = ["file.management"]; f.props.completion.projectId = "project-b";
  f.props.storageKey = "other-account:other-device:other-session"; f.h.render();
  assert.equal(f.menu().items.length, 0);
  f.h.dispose();
});

test("file errors and empty matches consume Enter, and explicit retry reloads", async () => {
  let calls = 0;
  const f = setup({ run: async () => { if (++calls === 1) throw new Error("offline"); return []; } });
  f.type("@"); await f.tick();
  assert.equal(f.menu().error, "completionReadFailed");
  f.key("Enter"); assert.deepEqual(f.sent, []);
  f.menu().retry(); f.h.render(); await f.tick();
  assert.equal(calls, 2); assert.equal(f.menu().error, undefined); assert.equal(f.menu().items.length, 0);
  f.key("Enter"); assert.deepEqual(f.sent, []);
  f.h.dispose();
});

test("a stale file click cannot replace a changed draft or worktree", async () => {
  const f = setup({ run: async () => [{ name: "one", path: "one", kind: "file" }] });
  f.type("@"); await f.tick();
  const oldMenu = f.menu();
  f.type("new text");
  oldMenu.select(oldMenu.items[0]); f.h.render();
  assert.equal(f.field().props.value, "new text");
  f.type("@"); await f.tick();
  const oldContext = f.menu();
  f.props.completion.worktreeId = "different-worktree"; f.h.render();
  oldContext.select(oldContext.items[0]); f.h.render();
  assert.equal(f.field().props.value, "@");
  assert.equal(f.menu().items.length, 0);
  f.h.dispose();
});

test("Skill selection stays local, filters cached names, preserves arguments and sends only explicitly", async () => {
  for (const source of ["claude", "codex"]) for (const phone of [false, true]) {
    const calls = [], f = setup({ source, phone, run: async (kind, payload) => {
      calls.push({ kind, payload });
      return { available: true, source, skills: [{ name: "review", state: "available" }, { name: "test", state: "available" }] };
    } });
    f.type("/"); await f.tick();
    assert.equal(calls[0].kind, "terminal.skills");
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0].payload)), { projectId: "project-a", worktreeId: "wt", sessionId: "pty-a" });
    f.type("/re explain @src/app.ts", 3); await f.tick();
    assert.equal(calls.length, 1, "typing filters the memory-only Skill catalog");
    assert.equal(f.menu().items.length, 1);
    f.key("Enter");
    assert.equal(f.field().props.value, `${source === "codex" ? "$" : "/"}review explain @src/app.ts`);
    assert.deepEqual(f.commands, []); assert.deepEqual(f.sent, []); assert.equal(f.menu().open, false);
    f.key("Enter", { repeat: true }); assert.deepEqual(f.sent, []);
    f.key("Enter", { ctrlKey: true }); await f.h.settle();
    assert.deepEqual(f.sent, [`${source === "codex" ? "$" : "/"}review explain @src/app.ts`]);
    f.h.dispose();
  }
});

test("Skill loading, errors, empty and unbound results consume confirmation without submission", async () => {
  let count = 0;
  const f = setup({ run: async () => {
    if (++count === 1) throw new Error("offline");
    if (count === 2) return { available: false, reason: "unbound", skills: [] };
    return { available: true, source: "codex", skills: [] };
  } });
  f.type("/"); f.key("Enter"); assert.deepEqual(f.sent, []);
  await f.tick(); assert.equal(f.menu().error, "completionSkillsReadFailed");
  f.key("Enter"); f.menu().retry(); f.h.render(); await f.tick();
  assert.equal(f.menu().error, "completionSkillsUnbound");
  f.menu().retry(); f.h.render(); await f.tick();
  assert.equal(f.menu().error, undefined); f.key("Enter"); assert.deepEqual(f.sent, []);
  f.key("Escape"); assert.equal(f.menu().open, false); assert.equal(f.field().props.value, "/");
  f.h.dispose();
});

test("late Skill results and stale clicks cannot cross account/device/session/worktree context", async () => {
  const late = deferred(), calls = [];
  const f = setup({ run: (kind, payload) => { calls.push(payload); return late.promise; } });
  f.type("/"); await f.tick();
  f.props.storageKey = "new-account:new-device:new-session"; f.props.completion.sessionId = "pty-b"; f.h.render();
  late.resolve({ available: true, source: "codex", skills: [{ name: "private", state: "available" }] }); await f.h.settle();
  assert.equal(f.menu().items.length, 0); assert.deepEqual(f.sent, []);
  await f.tick(); const old = f.menu();
  f.props.completion.worktreeId = "different-worktree"; f.h.render(); old.select(old.items[0]); f.h.render();
  assert.equal(f.field().props.value, "/"); assert.equal(f.menu().items.length, 0);
  f.props.disabled = true; f.h.render(); await f.tick(); assert.equal(f.menu().open, false);
  f.h.dispose();
});

test("menu renders localized accessible options and escaped filenames without desktop services", () => {
  const { ComposerCompletion } = loadModule("ComposerCompletion.tsx");
  for (const language of ["zh-CN", "en-US"]) {
    const html = renderToStaticMarkup(React.createElement(ComposerCompletion, { t: i18n.translator(language), onTerminal() {}, menu: {
      id: "suggestions", open: true, token: { kind: "file" }, items: [{ id: "x", value: "x", label: "<script>.md", kind: "file" }],
      index: 0, loading: false, error: undefined, select() {}, dismiss() {},
    } }));
    assert.match(html, /role="listbox"/); assert.match(html, /aria-selected="true"/);
    assert.match(html, /&lt;script&gt;\.md/); assert.ok(html.includes(i18n.translator(language)("completionFiles")));
  }
});

test("Skill menu and hints render in both languages with escaped descriptions", () => {
  const { ComposerCompletion } = loadModule("ComposerCompletion.tsx");
  for (const language of ["zh-CN", "en-US"]) {
    const t = i18n.translator(language);
    const html = renderToStaticMarkup(React.createElement(ComposerCompletion, { t, menu: {
      id: "skills", open: true, token: { kind: "command" }, items: [{ id: "review", value: "$review", label: "/review",
        description: "<script>alert(1)</script>", kind: "skill" }], index: 0, loading: false, select() {}, dismiss() {},
    } }));
    assert.ok(html.includes(t("completionSkills"))); assert.ok(html.includes(t("completionSkillNote")));
    assert.match(html, /&lt;script&gt;/); assert.ok(t("completionHint").includes("Skill"));
  }
});
