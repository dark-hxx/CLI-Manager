import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Compile the actual store actions, window listener and settings components; only their I/O is fake.
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const ast = path => ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true);
function compile(path, bindings = {}, extra = "") {
  const code = ast(path).statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText()).join("\n") + extra;
  return evaluate(code, bindings);
}
function evaluate(code, bindings) {
  const exports = {};
  runInNewContext(ts.transpileModule(code, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React,
  } }).outputText, { exports, ...bindings });
  return exports;
}
function findNode(node, predicate) {
  if (predicate(node)) return node;
  return ts.forEachChild(node, child => findNode(child, predicate));
}
const listener = findNode(ast("src/app/App.tsx"), n => ts.isCallExpression(n) && n.arguments[0]?.text === "claude-hook-notification").arguments[1].getText();
const term = "src/features/terminal/";
const cli = compile("src/shared/lib/cliTools.ts");
const pty = compile(term + "lib/antigravityPty.ts", cli);
const status = compile(term + "lib/terminalStatus.ts");
const model = compile(term + "lib/subagentTranscriptModel.ts");
const agyIdentity = compile("src/features/projects/api/agyStartupCommand.ts", cli);
const binding = compile(term + "store/antigravityHookBinding.ts", agyIdentity);
const tA = "1a000000-abcd-4000-b000-000000000001", tB = "2b000000-abcd-4000-b000-000000000002";
const tab = (id, props) => ({ id, projectId: "p", environmentType: "local", startupCmd: "agy", cwd: "D:/shared", ...props });
function harness(sessions, enabled = true) {
  const settings = { antigravityHookBridgeEnabled: enabled }, projects = [{ id: "p", path: "D:/shared", cli_tool: "agy", startup_cmd: "" }];
  let state = { sessions, splits: { left: { secondSessionId: "right" } }, sessionStatuses: {}, tabStatuses: {}, tabNotifications: {}, tabStatusDetails: {}, ptyOutputActivityAt: {}, statsPanelRefreshSeq: 0 };
  const store = { getState: () => state, setState: value => { state = { ...state, ...(typeof value === "function" ? value(state) : value) }; } };
  const saves = [], notices = [];
  const api = compile(term + "store/terminalRuntime.ts", {
    ...pty, ...status, ...model, ...binding,
    useSettingsStore: { getState: () => settings }, useProjectStore: { getState: () => ({ projects }) },
    useSessionStore: { getState: () => ({ saveSessions: async list => { saves.push(list); } }) },
    isShellRuntimeMonitoringEnabled: () => true, resolveAgentTerminalMetadata: () => ({ isAgentSession: true }),
    HOOK_RUNNING_TIMEOUT_MS: 1800000, setTimeout: () => 1, clearTimeout: () => {},
  });
  Object.assign(state, api.createTerminalRuntime(store.setState, store.getState, store).actions);
  const deliver = evaluate(`exports.callback = ${listener}`, {
    ...status, useTerminalStore: store, useReplayStore: { getState: () => ({ recordCliHookEvent: p => notices.push(`replay:${p.tabId}:${p.event}`) }) },
    claimCodexGoalNotification: () => true, sendTaskbarAttention: p => notices.push(`taskbar:${p.tabId}`),
    sendSystemNotification: (_p, id) => notices.push(`system:${id}`), showClaudeHookToast: (_p, id) => notices.push(`toast:${id}`), handleActivateHookNotificationTarget: () => {},
  }).callback;
  let tick = 0;
  const emit = (event, tabId, sessionId, props) => deliver({ payload: { event, tabId, source: "antigravity", sessionId, timestamp: new Date(1800000000000 + ++tick).toISOString(), ...props } });
  return { get: store.getState, emit, settings, projects, saves, notices };
}

test("same cwd, worktree and raw split: concurrent starts never target the primary or other window", async () => {
  const h = harness([tab("left"), tab("right", { worktreeId: "wt" })]);
  await Promise.all([Promise.resolve().then(() => h.emit("SessionStart", "left", tA)), Promise.resolve().then(() => h.emit("PreInvocation", "right", tB))]);
  assert.deepEqual(Array.from(h.get().sessions, x => x.cliSessionId), [tA, tB]);
  assert.equal(h.get().tabNotifications.right, "running");
  assert.equal(h.get().tabNotifications.left, "none");
  assert.deepEqual(h.notices, ["replay:left:SessionStart", "replay:right:PreInvocation"]);
  h.emit("PreInvocation", "right", tB); h.emit("Stop", "foreign", tB, { cwd: "D:/shared" });
  h.emit("StopFailure", "right", tA); h.emit("Stop", "right", tB); h.emit("Stop", "right", tB);
  assert.deepEqual(h.notices.slice(2), ["replay:right:Stop", "taskbar:right", "toast:right", "system:right"]);
  assert.equal(h.get().statsPanelRefreshSeq, 3);
  const foreign = harness([tab("another")]); foreign.emit("Stop", "right", tB, { cwd: "D:/shared" });
  assert.deepEqual(foreign.notices, []);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(h.saves.length, 2);
});

test("fork rejects the retired UUID, duplicate terminal notifications, stale running and sub-ms replay", () => {
  const h = harness([tab("one", { cliSessionId: tA })]);
  const emit = (event, id, nanos) => h.emit(event, "one", id, { timestamp: `2026-01-01T01:00:00.123${nanos}Z` });
  emit("SessionStart", tA, "100000"); emit("PreInvocation", tA, "100001"); emit("SessionStart", tB, "100005");
  emit("StopFailure", tB, "100004"); emit("SessionStart", tA, "100008"); emit("Stop", tA, "100009");
  assert.equal(h.get().sessions[0].cliSessionId, tB); assert.equal(h.get().tabNotifications.one, "none");
  emit("StopFailure", tB, "100010"); emit("PreInvocation", tB, "100009"); emit("StopFailure", tB, "100011");
  assert.equal(h.get().tabNotifications.one, "failed"); assert.equal(h.notices.filter(n => n === "toast:one").length, 1);
  emit("PreInvocation", tB, "100012"); emit("Stop", tB, "100013"); assert.equal(h.notices.filter(n => n === "toast:one").length, 2);
});

test("explicit distro only, local ≠ WSL, cross-distro same UUID; no SSH, body matching, synthetic PTY or disabled bridge", () => {
  const h = harness([tab("native"), tab("u", { environmentType: "wsl", cwd: "\\\\wsl.localhost\\Ubuntu\\work" }),
    tab("d", { environmentType: "wsl", cwd: "\\\\wsl$\\Debian\\work" }), tab("default", { environmentType: "wsl", cwd: "/work" }),
    tab("ssh", { environmentType: "ssh" }), tab("editor", { kind: "file-editor" }), tab("cmd", { startupCmd: "echo agy" }),
    tab("shell", { startupCmd: "", cliTool: "agy" }), tab("missing", { startupCmd: undefined })], false);
  h.emit("PreInvocation", "native", tA); h.settings.antigravityHookBridgeEnabled = true;
  h.projects[0].path = "\\\\wsl$\\Ubuntu\\work";
  for (const [name, distro] of [["native", "Ubuntu"], ["u", null], ["u", "Debian"], ["default", "Ubuntu"],
    ["ssh", null], ["editor", null], ["cmd", null], ["shell", null], ["missing", null]]) {
    h.emit("Stop", name, tA, { wslDistroName: distro });
  }
  h.emit("Stop", "native", tA, { environmentType: "ssh" }); h.emit("Notification", "native", tA); h.emit("PermissionRequest", "native", tA);
  for (const bad of ["bad", "00000000-0000-0000-0000-000000000000", tA + "\n"]) h.emit("Stop", "native", bad);
  assert.deepEqual(h.notices, []);
  h.emit("SessionStart", "u", tA, { wslDistroName: "ubuntu" }); h.emit("SessionStart", "d", tA, { wslDistroName: "debian" });
  h.emit("PreInvocation", "u", tA, { wslDistroName: "Ubuntu" }); h.emit("Stop", "d", tA, { wslDistroName: "Debian" });
  assert.equal(h.get().tabNotifications.u, "running"); assert.equal(h.get().tabNotifications.d, "done");
  assert.equal(h.get().sessions.find(x => x.id === "d").wslDistroName, "Debian");
  h.settings.antigravityHookBridgeEnabled = false; h.emit("Stop", "u", tA, { wslDistroName: "Ubuntu" });
  assert.equal(h.get().tabNotifications.u, "running");
});

test("without hooks only real OSC updates the exact agy PTY, not the chat turn; once bound the hook wins", () => {
  const h = harness([tab("left"), tab("right")]);
  const shell = (event, origin) => h.get().handleShellRuntimeEvent({ event, origin, sessionId: "right", exitCode: 0 });
  assert.equal(shell("command_started", "input"), null); assert.equal(shell("command_started", "osc"), "right");
  assert.equal(h.get().tabNotifications.right, "running"); assert.equal(h.get().tabNotifications.left, undefined);
  h.emit("PreInvocation", "right", tA); assert.equal(shell("command_finished", "osc"), null);
  h.emit("Stop", "right", tA); assert.equal(h.get().tabNotifications.right, "done");
  h.emit("PreInvocation", "right", tA); h.settings.antigravityHookBridgeEnabled = false;
  assert.equal(shell("command_finished", "input"), null); assert.equal(shell("command_finished", "osc"), "right");
  assert.equal(h.get().tabNotifications.right, "done"); assert.equal(h.get().tabStatuses.right.antigravityBinding.id, tA);
});

test("non-SSH stats entry bypasses legacy hook IPC only for exact agy commands", async () => {
  const callback = findNode(ast(term + "hooks/useTerminalTabsController.tsx"), n => ts.isVariableDeclaration(n) && n.name.getText() === "ensureStatsPanelAllowed").initializer.arguments[0];
  for (const cmd of ['& "C:\\Program Files\\agy.exe" --foo', 'agy', 'echo agy']) {
    const calls = [];
    const fn = evaluate(`exports.run = ${callback.getText()}`, { ...pty, panelSession: tab("x", { startupCmd: cmd }), projectById: new Map(),
      useSettingsStore: { getState: () => ({}) }, invoke: cmd => { calls.push(cmd); return { status: "missing" }; },
      resolveAgentRuntimeKind: () => "unknown", toast: { warning: () => {} }, t: k => k, logError: e => assert.fail(e),
    }).run;
    assert.equal(await fn(), !cmd.startsWith("echo")); assert.equal(calls.length, cmd.startsWith("echo") ? 2 : 0);
  }
});

const uiPath = "src/features/settings/components/AntigravityHookSection.tsx";
function collectButtons(node, out = {}) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const item of node) collectButtons(item, out);
    return out;
  }
  if (node.type === "Button" && typeof node.children?.[0] === "string") {
    const key = node.children[0].split(".").pop();
    if (key === "check" || key === "install" || key === "remove") out[key] = node.props;
  }
  if (node.children) collectButtons(node.children, out);
  return out;
}
function installation(distro) {
  const slots = [], effects = [], requests = [];
  const components = ["Box", "Stack", "Text", "Group", "Button", "PathRow", "CliHookBridgeCard", "Check", "HelpCircle", "X"];
  let cursor = 0;
  const memo = (fn, deps) => { const i = cursor++; if (!slots[i] || !deps.every((v, j) => Object.is(v, slots[i].deps[j]))) slots[i] = { deps, value: fn() }; return slots[i].value; };
  const ui = compile(uiPath, { ...Object.fromEntries(components.map(k => [k, k])), useI18n: () => ({ t: key => key }),
    toast: { success: () => {}, error: () => {} },
    React: { createElement: (type, props, ...children) => ({ type, props, children }) },
    useState: initial => { const i = cursor++; slots[i] ??= { value: initial }; return [slots[i].value, value => { slots[i].value = value; }]; },
    useCallback: (fn, deps) => memo(() => fn, deps), useRef: initial => { const i = cursor++; slots[i] ??= { current: initial }; return slots[i]; },
    useEffect: (effect, deps) => memo(() => { effects.push(effect); }, deps),
    invoke: (command, args) => new Promise((resolve, reject) => requests.push({ command, args, resolve, reject })),
  }, "\nexports.view = EnvironmentInstallation;");
  const cleanups = [];
  function render(extraProps = {}) {
    cursor = 0; const root = ui.view({ distro, ...extraProps }); while (effects.length) cleanups.push(effects.shift()());
    return { ...collectButtons(root), card: root.props };
  }
  return { render, requests, unmount: () => cleanups.forEach(fn => fn?.()) };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
test("per-environment settings read first, conflict never enables writes; no double mutation or stale-scope writes", async () => {
  const local = installation(null), wsl = installation("Debian");
  local.render(); wsl.render(); assert.equal(local.requests[0].command, "hook_settings_get_status_antigravity");
  assert.equal(Object.keys(local.requests[0].args).length, 0); assert.equal(wsl.requests[0].args.wslDistro, "Debian");
  local.requests[0].resolve({ status: "notInstalled", configPath: "host" }); wsl.requests[0].resolve({ status: "conflict", configPath: "guest" }); await settle();
  const old = local.render(), conflict = wsl.render(); assert.equal(conflict.install.disabled, true); assert.equal(conflict.remove.disabled, true);
  conflict.install.onClick(); conflict.remove.onClick(); assert.equal(wsl.requests.length, 1);
  assert.equal(old.install.disabled, false); old.install.onClick(); old.install.onClick(); assert.equal(local.requests.length, 2);
  assert.equal(local.requests[1].command, "hook_settings_install_antigravity"); local.unmount(); old.install.onClick(); assert.equal(local.requests.length, 2);
  local.requests[1].resolve({ status: "installed", configPath: "host" }); conflict.check.onClick();
  wsl.requests[1].resolve({ status: "installed", configPath: "guest" }); await settle(); const next = wsl.render();
  assert.equal(next.install.disabled, true); assert.equal(next.remove.disabled, false); next.remove.onClick();
  assert.equal(wsl.requests[2].command, "hook_settings_uninstall_antigravity"); assert.equal(wsl.requests[2].args.wslDistro, "Debian");
  wsl.requests[2].reject(new Error("fixture permission denied")); await settle();
  const failed = wsl.render(); assert.equal(failed.install.disabled, true); assert.equal(failed.remove.disabled, true);
  next.remove.onClick(); assert.equal(wsl.requests.length, 3); failed.check.onClick();
  wsl.requests[3].resolve({ status: "partialInstalled", configPath: "guest" }); await settle();
  const partial = wsl.render(); assert.equal(partial.remove.disabled, false); assert.equal(partial.install.disabled, false); wsl.unmount();
});

test("collapsed antigravity card still inspects disk status and reacts to refreshNonce", async () => {
  const local = installation(null);
  const initial = local.render({ open: false, refreshNonce: 0 });
  assert.equal(initial.card.status, "pending");
  assert.equal(local.requests.length, 1);
  local.requests[0].resolve({ status: "installed", configPath: "host" }); await settle();
  const settled = local.render({ open: false, refreshNonce: 0 });
  assert.equal(settled.card.status, "installed");
  assert.equal(local.requests.length, 1);
  const refreshing = local.render({ open: false, refreshNonce: 1 });
  assert.equal(local.requests.length, 2);
  assert.equal(local.requests[1].command, "hook_settings_get_status_antigravity");
  local.requests[1].resolve({ status: "conflict", configPath: "host" }); await settle();
  assert.equal(local.render({ open: false, refreshNonce: 1 }).card.status, "conflict");
  assert.equal(refreshing.card.open, false);
  local.unmount();
});

function mountSection(windows = true) {
  const stores = new Map(), effects = [], requests = [];
  const components = ["Box", "Stack", "Text", "Group", "Select", "Button", "PathRow", "CliHookBridgeCard", "Check", "HelpCircle", "X"];
  let currentSlots = [], cursor = 0;
  const slot = init => { const i = cursor++; if (currentSlots.length <= i) currentSlots.push(init()); return currentSlots[i]; };
  const memo = (fn, deps) => { const entry = slot(() => ({ deps, value: fn() })); if (!deps.every((v, j) => Object.is(v, entry.deps[j]))) { entry.deps = deps; entry.value = fn(); } return entry.value; };
  const ui = compile(uiPath, {
    ...Object.fromEntries(components.map(k => [k, k])),
    useI18n: () => ({ t: key => key }), toast: { success: () => {}, error: () => {} },
    isWindowsPlatform: () => windows,
    useSettingsStore: sel => sel({ antigravityHookBridgeEnabled: false, update: () => {} }),
    React: { createElement: (type, props, ...children) => ({ type, props, children }) },
    useState: initial => { const entry = slot(() => ({ value: typeof initial === "function" ? initial() : initial })); return [entry.value, next => { entry.value = typeof next === "function" ? next(entry.value) : next; }]; },
    useCallback: (fn, deps) => memo(() => fn, deps),
    useRef: initial => slot(() => ({ current: initial })),
    useEffect: (effect, deps) => memo(() => { effects.push(effect); }, deps),
    invoke: (command, args) => new Promise((resolve, reject) => requests.push({ command, args, resolve, reject })),
  }, "\nexports.view = AntigravityHookSection;");
  const renderComponent = (fn, props) => {
    const key = fn.name || "anon";
    if (!stores.has(key)) stores.set(key, []);
    currentSlots = stores.get(key); cursor = 0;
    const node = fn(props);
    return node && typeof node.type === "function" ? renderComponent(node.type, node.props) : node;
  };
  const cleanups = [];
  function render(props = { open: true }) {
    const tree = renderComponent(ui.view, props);
    while (effects.length) cleanups.push(effects.shift()());
    return tree;
  }
  return { render, requests, unmount: () => cleanups.forEach(fn => fn?.()) };
}
function walkTree(node, visit) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const item of node) walkTree(item, visit); return; }
  visit(node);
  if (node.props?.environmentControl) walkTree(node.props.environmentControl, visit);
  if (node.children) walkTree(node.children, visit);
}
test("non-WSL Windows hides WSL warning and single-option environment selector; WSL distros show selector", async () => {
  const noWsl = mountSection(true);
  noWsl.render({ open: true, refreshNonce: 0 });
  const listReq = noWsl.requests.find(r => r.command === "provider_wsl_list_distros");
  const statusReq = noWsl.requests.find(r => r.command === "hook_settings_get_status_antigravity");
  assert.ok(listReq && statusReq);
  listReq.reject(new Error("provider_wsl_list_failed"));
  statusReq.resolve({ status: "partialInstalled", configPath: "C:\\Users\\1\\.gemini\\config\\hooks.json" });
  await settle();
  const treeWithoutWsl = noWsl.render({ open: true, refreshNonce: 0 });
  const foundWithoutWsl = { selects: [], texts: [] };
  walkTree(treeWithoutWsl, node => {
    if (node.type === "Select") foundWithoutWsl.selects.push(node.props);
    for (const child of node.children ?? []) if (typeof child === "string") foundWithoutWsl.texts.push(child);
  });
  assert.equal(foundWithoutWsl.selects.length, 0);
  assert.equal(foundWithoutWsl.texts.includes("settings.hooks.agy.distrosUnavailable"), false);
  assert.equal(foundWithoutWsl.texts.includes("settings.hooks.agy.partialInstalled"), false);
  noWsl.unmount();

  const withWsl = mountSection(true);
  withWsl.render({ open: true, refreshNonce: 0 });
  withWsl.requests.find(r => r.command === "provider_wsl_list_distros").resolve(["Ubuntu"]);
  withWsl.requests.find(r => r.command === "hook_settings_get_status_antigravity").resolve({ status: "installed", configPath: "C:\\Users\\1\\.gemini\\config\\hooks.json" });
  await settle();
  const treeWithWsl = withWsl.render({ open: true, refreshNonce: 0 });
  const selects = [];
  walkTree(treeWithWsl, node => { if (node.type === "Select") selects.push(node.props); });
  assert.equal(selects.length, 1);
  assert.deepEqual(Array.from(selects[0].data, item => item.value), ["local", "wsl:Ubuntu"]);
  withWsl.unmount();
});

test("agy-only sidebar opens the scope selector without claiming a missing installation or running repair", () => {
  const opened = [], calls = [];
  const ui = compile("src/features/projects/components/SidebarFooter.tsx", {
    React: { createElement: (type, props) => ({ type, props }) }, useState: value => [value, () => {}],
    useMemo: fn => fn(), useCallback: fn => fn, useEffect: fn => fn(), useI18n: () => ({ t: key => key }),
    useActiveCodexHookProfile: () => null, useSettingsStore: selector => selector({ antigravityHookBridgeEnabled: true }),
    useHookStatusRequest: () => ({ status: null, invokeStatus: async cmd => { calls.push(cmd); return null; } }),
  }, "\nexports.button = HookStatusLight;");
  const { props } = ui.button({ onOpenSettings: tab => opened.push(tab) });
  assert.equal(props.title, "settings.hooks.agy.manage"); assert.equal(props["data-hook-status"], undefined);
  props.onClick(); assert.deepEqual(opened, ["hooks"]); assert.deepEqual(calls, ["hook_settings_get_status"]);
});

test("both message catalogs cover statuses/errors and agy opt-in is local and off by default", () => {
  const dict = JSON.parse(read("src/shared/i18n/messages/antigravity-hook.json"));
  const keys = Object.keys(dict["zh-CN"]).sort(); assert.deepEqual(keys, Object.keys(dict["en-US"]).sort());
  for (const key of keys) assert.notEqual(dict["zh-CN"][key], dict["en-US"][key]);
  for (const lang of ["zh-CN", "en-US"]) assert.match(read(`src/shared/i18n/messages/agent-integrations.${lang}.ts`), new RegExp(`agyHookMessages\\["${lang}"\\]`));
  assert.match(read("src/shared/preferences/settingsStore.ts"), /antigravityHookBridgeEnabled: false/);
  assert.match(read("src/features/sync/lib/syncSettings.ts"), /antigravityHookBridgeEnabled: "excluded"/);
  assert.equal(status.resolveCliHookStatus({ source: "antigravity", event: "PreInvocation" }).status, "running");
  assert.equal(status.resolveCliHookStatus({ source: "claude", event: "PreInvocation" }).status, null);
});
