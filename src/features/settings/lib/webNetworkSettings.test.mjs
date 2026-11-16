import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";
import { createWebDeviceStatusSource } from "../../../shared/lib/webDeviceStatus.ts";

const require = createRequire(import.meta.url);
const ts = require("typescript");

function load(relativePath, dependencies = {}) {
  const exports = {};
  const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  vm.runInNewContext(code, {
    exports, URL, window: dependencies.window, navigator: {},
    require: (id) => {
      if (id in dependencies) return dependencies[id];
      throw new Error(`Unexpected dependency: ${id}`);
    },
  });
  return exports;
}

const guidance = load("./webNetworkGuidance.ts");
const drafts = load("./webSettingsDraft.ts");
const zh = Object.values(load("../../../shared/i18n/messages/settings.zh-CN.ts"))[0];
const en = Object.values(load("../../../shared/i18n/messages/settings.en-US.ts"))[0];

test("listener guidance covers IPv4/IPv6, all interfaces, explicit trust and HTTPS", () => {
  for (const ip of ["127.0.0.1", "127.25.4.8", "::1", "0:0:0:0:0:0:0:1"]) {
    assert.equal(guidance.webBindScope(ip), "loopback");
    assert.equal(guidance.webServerNetworkRequirement(ip, "", false), null);
  }
  for (const ip of ["192.168.1.8", "100.64.0.2", "fd00::1", "::ffff:127.0.0.1"]) {
    assert.equal(guidance.webBindScope(ip), "network");
    assert.equal(guidance.webServerNetworkRequirement(ip, "", false), "settings.webServer.error.trustedNetworkRequired");
    assert.equal(guidance.webServerNetworkRequirement(ip, "", true), null);
    assert.equal(guidance.webServerNetworkRequirement(ip, "https://cli.example.com", false), null);
  }
  for (const ip of ["0.0.0.0", "::", "0:0:0:0:0:0:0:0"]) {
    assert.equal(guidance.webBindScope(ip), "all");
    assert.equal(guidance.webServerNetworkRequirement(ip, "", true), "settings.webServer.error.originRequired");
    assert.equal(guidance.webServerNetworkRequirement(ip, "http://192.168.1.8:8787", false), "settings.webServer.error.trustedNetworkRequired");
  }
  for (const ip of ["", "999.1.1.1", "192.168.01.1", "localhost", "[::1]", "::not-ip"]) {
    assert.equal(guidance.webBindScope(ip), "invalid");
  }
});

test("device and browser plaintext URLs each require explicit trust outside loopback", () => {
  for (const url of ["ws://192.168.1.8:8787/ws/device", "http://desktop.internal", "ws://[fd00::1]:8787"]) {
    assert.equal(guidance.webDeviceNeedsNetworkTrust(url, "https://cli.example.com", false), true);
    assert.equal(guidance.webDeviceNeedsNetworkTrust(url, "", true), false);
  }
  for (const url of ["ws://localhost:8787", "http://127.10.2.3:8787", "ws://[::1]:8787", "https://cli.example.com", "wss://cli.example.com", "", "invalid"]) {
    assert.equal(guidance.webDeviceNeedsNetworkTrust(url, "", false), false);
  }
  assert.equal(guidance.webDeviceNeedsNetworkTrust("ws://127.0.0.1:8787", "http://192.168.1.8:8787", false), true);
  assert.equal(guidance.webDeviceNeedsNetworkTrust("wss://cli.example.com", "http://desktop.internal", true), false);
});

test("initial status and delayed save cannot overwrite newer edits", () => {
  const { createWebSettingsDraft, webSettingsDraftReducer: reduce } = drafts;
  let state = createWebSettingsDraft({ bind: "127.0.0.1", trustedNetwork: false });
  state = reduce(state, { type: "edit", patch: { bind: "192.168.1.8" } });
  state = reduce(state, { type: "status", patch: { bind: "127.0.0.1" } });
  assert.equal(state.values.bind, "192.168.1.8");
  const revision = state.revision;
  state = reduce(state, { type: "edit", patch: { bind: "192.168.1.9" } });
  state = reduce(state, { type: "saved", revision, patch: { bind: "192.168.1.8", trustedNetwork: true } });
  assert.equal(state.values.bind, "192.168.1.9");
  assert.equal(state.values.trustedNetwork, false);
  state = reduce(state, { type: "saved", revision: state.revision, patch: { trustedNetwork: true } });
  state = reduce(state, { type: "status", patch: { bind: "127.0.0.1", trustedNetwork: false } });
  assert.equal(state.values.bind, "192.168.1.9");
  assert.equal(state.values.trustedNetwork, true);
});

test("both locales translate existing backend errors without hiding unknown diagnostics", () => {
  for (const message of [
    "Enable trusted network HTTP explicitly, or configure an HTTPS browser origin",
    "Allowed Origin is required when listening on all network interfaces",
    "Allowed Origin must be a valid HTTP or HTTPS origin",
    "Allowed Origin must contain only an HTTP or HTTPS scheme, host, and optional port",
    "remote web device server must use TLS",
    "public access URL requires HTTPS or explicit trusted network mode",
  ]) {
    const key = guidance.webNetworkErrorKey(message);
    assert.ok(zh[key], key);
    assert.ok(en[key], key);
    assert.notEqual(zh[key], en[key]);
  }
  assert.equal(guidance.webNetworkErrorKey("connection refused"), null);
});

const listenerStatus = {
  configured: true, running: false, stopping: false, autoStart: false, bind: "127.0.0.1", port: 8787,
  allowedOrigin: null, trustedNetwork: false, interfaces: [["LAN", "192.168.1.8"]],
};
const deviceStatus = {
  configured: true, running: false, connected: false, paired: false,
  profile: { serverUrl: "ws://127.0.0.1:8787/ws/device", trustedNetwork: false, publicAccessUrl: "",
    name: "Desktop", autoStart: true, uploadWallpaper: true },
};

// 执行真实组件的回调/副作用，替换宿主 IPC 和渲染器；不启动桌面应用或改变本机配置。
function componentHarness(kind) {
  const hooks = [];
  const effects = [];
  let cursor = 0;
  let tree;
  let listener;
  let poll;
  let language = zh;
  const toasts = [];
  const requests = [];
  let statusReads = 0;
  let currentStatus = kind === "server" ? listenerStatus : deviceStatus;
  const statusSource = createWebDeviceStatusSource();
  const failure = kind === "server"
    ? "Enable trusted network HTTP explicitly, or configure an HTTPS browser origin"
    : "remote web device server must use TLS";
  let saveAction = async () => { throw failure; };
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const react = {
    useState(initial) {
      const index = cursor++;
      hooks[index] ??= { value: initial, set: (next) => { hooks[index].value = typeof next === "function" ? next(hooks[index].value) : next; } };
      return [hooks[index].value, hooks[index].set];
    },
    useReducer(reducer, initial) {
      const [value, set] = react.useState(initial);
      return [value, (action) => set((previous) => reducer(previous, action))];
    },
    useCallback(callback, deps) {
      const index = cursor++;
      if (!same(hooks[index]?.deps, deps)) hooks[index] = { value: callback, deps };
      return hooks[index].value;
    },
    useEffect(callback, deps) {
      const index = cursor++;
      if (!same(hooks[index]?.deps, deps)) {
        hooks[index]?.cleanup?.();
        hooks[index] = { deps };
        effects.push(() => { hooks[index].cleanup = callback(); });
      }
    },
  };
  const api = {
    getStatus: async () => { statusReads++; return currentStatus; },
    saveConfig: async (request) => { requests.push(request); return saveAction(request); },
    saveProfile: async (request) => { requests.push(request); return saveAction(request); },
    start: async () => ({ ...currentStatus, running: true }),
    stop: async () => ({ ...currentStatus, running: false }),
  };
  const deviceApi = {
    ...api,
    getStatus: () => statusSource.refresh(api.getStatus),
    saveProfile: (request) => statusSource.request(() => api.saveProfile(request)),
    start: () => statusSource.request(api.start),
    stop: () => statusSource.request(api.stop),
  };
  const jsx = (type, props) => ({ type, props });
  const components = new Proxy({}, { get: (_, name) => name });
  const translate = (key) => language[key] ?? key;
  const dependencies = {
    react, "react/jsx-runtime": { jsx, jsxs: jsx }, "@mantine/core": components, "lucide-react": components,
    "@tauri-apps/api/event": { listen: async (_, handler) => { listener = handler; return () => {}; } },
    sonner: { toast: { error: (...args) => toasts.push(args), success: (...args) => toasts.push(args) } },
    "../../../shared/i18n/index": { useI18n: () => ({ t: translate }) },
    "../../../shared/lib/webServer": { webServerApi: api },
    "../../../shared/lib/webDevice": { webDeviceApi: deviceApi },
    "../../../shared/lib/webDeviceStatus": { webDeviceStatusSource: statusSource },
    "../../../shared/preferences/settingsStore": { useSettingsStore: () => 96 },
    "../../../shared/lib/webTerminalFrames": {}, "./WebMobileAccess": {}, "./SettingsIcons": components,
    "../lib/webPairingLifecycle": { pairingRefreshDelay: () => null },
    "../lib/webSettingsDraft": drafts, "../lib/webNetworkGuidance": guidance,
    window: { setInterval: (handler) => { poll = handler; return 1; }, clearInterval() {} },
  };
  const name = kind === "server" ? "WebServerSettingsSection" : "WebDeviceSettingsSection";
  const component = load(`../components/${name}.tsx`, dependencies)[name];
  const render = () => {
    cursor = 0;
    tree = component({});
    effects.splice(0).forEach((effect) => effect());
  };
  const flatten = (node) => !node || typeof node !== "object" ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(flatten)];
  const find = (type, key) => {
    const match = flatten(tree).find((node) => node.type === type && (!key || node.props.label === translate(key) || node.props.children === translate(key)));
    assert.ok(match, `${type} ${key ?? ""}`);
    return match.props;
  };
  const flush = async () => {
    // 异步 IPC、刷新及其状态更新可能跨多个微任务；不运行真实定时器。
    for (let i = 0; i < 4; i++) { await new Promise(setImmediate); render(); }
  };
  render();
  return {
    find, flush, toasts, requests,
    statusReads: () => statusReads,
    change(type, key, value) { find(type, key).onChange(type === "Select" ? value : { currentTarget: { value, checked: value } }); render(); },
    click(key) { find("Button", key).onClick(); },
    status(next) { currentStatus = next; listener({ payload: next }); render(); },
    event(payload) { listener({ payload }); render(); },
    poll: async (next) => {
      if (next) currentStatus = next;
      if (kind === "device") await deviceApi.getStatus();
      else await poll?.();
      render();
    },
    unmount() { for (const hook of hooks) hook?.cleanup?.(); },
    language(next) { language = next; render(); },
    saveWith(action) { saveAction = action; },
  };
}

test("device background snapshots update badges without saving or overwriting drafts", async () => {
  const h = componentHarness("device");
  await h.flush();
  h.change("TextInput", "settings.webDevice.serverUrl", "https://unsaved.example.com");
  for (const [running, connected, paired] of [
    [true, true, false], [true, true, true], [true, false, true], [false, false, false],
  ]) {
    await h.poll({ ...deviceStatus, running, connected, paired });
    await h.flush();
    assert.equal(h.find("TextInput", "settings.webDevice.serverUrl").value, "https://unsaved.example.com");
  }
  assert.equal(h.requests.length, 0, "observing daemon state never saves configuration");
  h.unmount();
});

test("unmounted device settings ignore native callbacks before async unlisten settles", async () => {
  const h = componentHarness("device");
  await h.flush();
  const reads = h.statusReads();
  h.unmount();
  h.event({ ...deviceStatus, running: true, connected: true, paired: true });
  await h.flush();
  assert.equal(h.statusReads(), reads);
  assert.equal(h.find("Badge").children, zh["settings.webDevice.state.stopped"]);
});

test("credential errors are localized without opening unrelated network settings", async () => {
  const h = componentHarness("server");
  await h.flush();
  h.saveWith(async () => { throw "Web server admin password cannot exceed 1024 bytes"; });
  for (const language of [zh, en]) {
    h.language(language);
    h.click("common.save");
    await h.flush();
    assert.equal(h.toasts.at(-1)[1].description, language["settings.webServer.error.adminPassword"]);
    assert.equal(h.find("Collapse").expanded, false);
  }
  h.unmount();
});

test("device badge and buttons follow daemon snapshots without Tauri status events in both languages", async () => {
  const h = componentHarness("device");
  await h.flush();
  const prefix = "settings.webDevice";
  for (const language of [zh, en]) {
    h.language(language);
    for (const [running, connected, paired, state] of [
      [false, false, false, "stopped"], [true, false, false, "connecting"],
      [true, true, false, "waitingPairing"], [true, true, true, "online"],
      [true, false, false, "connecting"], [true, true, true, "online"],
    ]) {
      await h.poll({ ...deviceStatus, running, connected, paired });
      await h.flush();
      assert.equal(h.find("Badge").children, language[`${prefix}.state.${state}`]);
      assert.equal(h.find("Button", `${prefix}.start`).disabled, running);
      assert.equal(h.find("Button", `${prefix}.stop`).disabled, !running);
      assert.equal(h.find("Badge").color, connected && paired ? "green" : running ? "yellow" : "gray");
    }
  }
  h.unmount();
});

test("device native events refresh authority instead of applying another transport's payload", async () => {
  const h = componentHarness("device");
  await h.flush();
  await h.poll({ ...deviceStatus, running: true, connected: true, paired: true });
  h.event(deviceStatus);
  await h.flush();
  assert.equal(h.find("Badge").children, zh["settings.webDevice.state.online"]);
  h.unmount();
});

test("late save response updates only its submitted draft and cannot regress newer connection state", async () => {
  const h = componentHarness("device");
  await h.flush();
  let complete;
  h.saveWith(() => new Promise((resolve) => { complete = resolve; }));
  h.click("common.save");
  await h.poll({ ...deviceStatus, running: true, connected: true, paired: true });
  complete(deviceStatus);
  await h.flush();
  assert.equal(h.find("Badge").children, zh["settings.webDevice.state.online"]);
  h.unmount();
});

for (const kind of ["server", "device"]) {
  test(`${kind} component guides plaintext setup and preserves input after failure, events and language changes`, async () => {
    const h = componentHarness(kind);
    await h.flush();
    const prefix = kind === "server" ? "settings.webServer" : "settings.webDevice";
    const field = `${prefix}.${kind === "server" ? "bind" : "serverUrl"}`;
    const value = kind === "server" ? "192.168.1.8" : "ws://192.168.1.8:8787/ws/device";
    if (kind === "server") h.change("Select", `${prefix}.interface`, value);
    else h.change("TextInput", field, value);
    await h.flush();
    assert.equal(h.find("Collapse").expanded, true);
    assert.equal(h.find("Switch", `${prefix}.trustedNetwork`).checked, false);
    h.click("common.save");
    await h.flush();
    assert.equal(h.find("TextInput", field).value, value);
    assert.equal(h.toasts.at(-1)[1].description, zh[`${prefix}.error.trustedNetworkRequired`]);
    h.status(kind === "server" ? listenerStatus : deviceStatus);
    await h.poll();
    h.language(en);
    await h.flush();
    assert.equal(h.find("TextInput", field).value, value);
    assert.equal(h.find("Text", `${prefix}.error.trustedNetworkRequired`).role, "status");
    h.change("Switch", `${prefix}.trustedNetwork`, true);
    h.saveWith(async (request) => kind === "server"
      ? { ...listenerStatus, ...request }
      : { ...deviceStatus, profile: { ...deviceStatus.profile, ...request } });
    h.click("common.save");
    await h.flush();
    assert.equal(h.requests.at(-1).trustedNetwork, true);
    assert.equal(h.find("TextInput", field).value, value);
  });

  test(`${kind} component protects edits made while save is in flight`, async () => {
    const h = componentHarness(kind);
    await h.flush();
    const field = kind === "server" ? "settings.webServer.bind" : "settings.webDevice.serverUrl";
    let complete;
    h.saveWith(() => new Promise((resolve) => { complete = resolve; }));
    h.click("common.save");
    h.change("TextInput", field, kind === "server" ? "192.168.1.9" : "https://new.example.com");
    const edited = h.find("TextInput", field).value;
    complete(kind === "server" ? listenerStatus : deviceStatus);
    await h.flush();
    assert.equal(h.find("TextInput", field).value, edited);
  });
}
