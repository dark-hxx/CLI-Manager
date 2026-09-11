import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const controls = new Proxy({}, { get: (_, name) => name });

// 执行真实组件及其事件回调，仅替换平台/UI 依赖；不启动桌面服务。
function loadComponent(file, overrides = {}) {
  const source = readFileSync(new URL(`../src/features/settings/components/providers/${file}`, import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  const mocks = {
    "@mantine/core": controls,
    "lucide-react": controls,
    "../../../../shared/i18n/index": { useI18n: () => ({ t: (key) => key }) },
    "./NativeProviderButton": { NativeProviderButton: "Button" },
    "./NativeProviderCodeEditor": { NativeProviderCodeEditor: "CodeEditor" },
    "./providerModelFetchError": {},
    ...overrides,
  };
  new Function("require", "exports", output)((name) => mocks[name] ?? require(name), exports);
  return exports;
}

function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== "object") return [];
  return [tree, ...nodes(tree.props?.children)];
}

test("mapping row identity survives typing, insertion and deletion", () => {
  const { NativeProviderAdvancedConfigSection: render } = loadComponent("NativeProviderAdvancedConfigSection.tsx");
  let value = {
    wireApi: "responses", headerOverride: "{}", bodyOverride: "{}",
    modelMappings: [{ rowId: "first", source: "", target: "target" }],
  };
  const tree = () => render({ appType: "codex", value, onChange: (next) => { value = next; } });
  const row = (key) => nodes(tree()).find((node) => node.key === key);
  for (const text of ["a", "ab", "abc", "abc/", "abc/s", "abc/sd", "abc/sdf", "abc/df"]) {
    const input = nodes(row("first")).find((node) => node.type === "TextInput");
    input.props.onChange({ currentTarget: { value: text } });
    assert.equal(row("first").key, "first", "React must reconcile the existing row instead of remounting it");
    assert.equal(nodes(row("first")).find((node) => node.type === "TextInput").props.value, text);
  }
  const add = nodes(tree()).find((node) => node.type === "Button" && node.props.children === "providerCatalog.compatibleAdvanced.addMapping");
  add.props.onClick();
  const secondId = value.modelMappings[1].rowId;
  assert.ok(secondId);
  assert.notEqual(secondId, "first");
  nodes(row("first")).find((node) => node.type === "Button").props.onClick();
  assert.equal(value.modelMappings.length, 1);
  assert.equal(row(secondId).key, secondId);
});

test("global preview hides fingerprints while applying the original snapshot", async () => {
  let applied;
  const { NativeProviderGlobalSection: render } = loadComponent("NativeProviderGlobalSection.tsx", {
    "../../../../shared/ui/useAppConfirm": { useAppConfirm: () => ({ confirm: async () => true, confirmDialog: null }) },
    "./nativeProviderGlobalView": { providerGlobalTargetRoot: () => "test-home" },
  });
  const preview = {
    fingerprint: "snapshot-secret-hash",
    targets: [{ target: "codex.config", path: "test/config.toml", liveFingerprint: "live-secret-hash", desiredFingerprint: "desired-secret-hash", ownedFields: ["model"], changed: true, action: "update" }],
  };
  const tree = render({ providerId: "test", state: { preview, applyGlobal: async (value) => { applied = value; return true; } } });
  const rendered = JSON.stringify(tree);
  for (const value of ["snapshot-secret-hash", "live-secret-hash", "desired-secret-hash", "previewFingerprint", "liveFingerprint", "desiredFingerprint"]) {
    assert.equal(rendered.includes(value), false);
  }
  assert.ok(rendered.includes("test/config.toml"));
  assert.ok(rendered.includes("providerCatalog.global.update"));
  await nodes(tree).find((node) => node.type === "Button" && node.props.children === "providerCatalog.global.apply").props.onClick();
  assert.equal(applied, preview);
});

test("effective editor and field origin display the projected slash model", () => {
  const configView = loadComponent("nativeProviderConfigView.ts", {
    "./nativeProviderAdvancedConfig": loadComponent("nativeProviderAdvancedConfig.ts"),
  });
  const { NativeProviderEditor: render } = loadComponent("NativeProviderEditor.tsx", {
    react: { useMemo: (compute) => compute(), useState: (initial) => [initial, () => {}] },
    "@tauri-apps/plugin-opener": {},
    sonner: {},
    "../../lib/sponsors": {},
    "./nativeProviderConfigView": configView,
  });
  const tree = render({ view: "effective", detail: {
    card: { id: "test", appType: "codex", model: "abc/sdf" },
    settingsConfig: JSON.stringify({ config: 'model = "old-model"\n', model: "abc/sdf" }),
    effectiveSettingsConfig: JSON.stringify({ config: 'model = "abc/sdf"\n', model: "abc/sdf" }),
  } });
  assert.equal(nodes(tree).find((node) => node.type === "CodeEditor").props.value, 'model = "abc/sdf"\n');
  const summary = nodes(tree).find((node) => node.type?.name === "FieldOriginSummary");
  const modelRow = nodes(summary.type(summary.props)).find((node) => node.key === "providerCatalog.model");
  assert.ok(JSON.stringify(modelRow).includes("abc/sdf"));
  assert.equal(JSON.stringify(modelRow).includes("old-model"), false);
});
