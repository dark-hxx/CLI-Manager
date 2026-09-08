import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "./helpers/readComposedSource.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-pane-marker-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

const source = readFileSync(new URL("../src/shared/lib/terminalPaneMarker.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const modulePath = join(tempDir, "terminalPaneMarker.mjs");
writeFileSync(modulePath, output, "utf8");

const {
  DEFAULT_TERMINAL_PANE_MARKER_FOCUS_COLOR,
  DEFAULT_TERMINAL_PANE_MARKER_SETTINGS,
  resolveTerminalPaneMarker,
  sanitizeTerminalPaneMarkerSettings,
} = await import(pathToFileURL(modulePath).href);

const enabledSettings = {
  ...DEFAULT_TERMINAL_PANE_MARKER_SETTINGS,
  enabled: true,
};
const defaultFocusColor =
  "color-mix(in srgb, var(--terminal-theme-muted, #64748b) 60%, var(--terminal-theme-background, #0c0e10) 40%)";

const resolve = (overrides = {}) => resolveTerminalPaneMarker({
  isLayoutVisible: true,
  isSplitLayout: true,
  isAppFocused: true,
  isPaneFocused: true,
  isMainSession: true,
  hookStatus: "none",
  settings: enabledSettings,
  ...overrides,
});

test("missing settings migrate to disabled defaults", () => {
  assert.deepEqual(sanitizeTerminalPaneMarkerSettings(undefined), {
    enabled: false,
    style: "tab-top",
    doneColor: "#8FBF7F",
    failedColor: "#F7768E",
    attentionColor: "#FF9E64",
  });
});

test("explicit enabled state is preserved and invalid values fall back to disabled", () => {
  assert.equal(sanitizeTerminalPaneMarkerSettings({ enabled: true }).enabled, true);
  assert.equal(sanitizeTerminalPaneMarkerSettings({ enabled: "true" }).enabled, false);
  assert.equal(sanitizeTerminalPaneMarkerSettings({ style: "full" }).enabled, false);
});

test("Pane marker settings participate in preference sync", () => {
  const syncSettings = readFileSync(new URL("../src/features/sync/lib/syncSettings.ts", import.meta.url), "utf8");
  assert.match(syncSettings, /terminalPaneMarker:\s*"preferences"/);
});

test("Pane marker overlay is anchored inside terminal content instead of the Tab bar", () => {
  const terminalTabs = readFileSync(new URL("../src/features/terminal/components/PaneLeafView.tsx", import.meta.url), "utf8");
  assert.match(
    terminalTabs,
    /className="ui-terminal-pane-content[\s\S]*?<PaneContentDropZones[\s\S]*?\{paneMarker && \([\s\S]*?className="ui-terminal-pane-marker"[\s\S]*?<\/div>\s*\)\}\s*<\/div>\s*<\/div>\s*\);/,
  );
  assert.doesNotMatch(terminalTabs, /ui-terminal-pane-marker__tab-bottom/);
});

test("default focus color follows the terminal theme and settings reuse the production marker overlay", () => {
  const styles = readFileSync(new URL("../src/styles/components.css", import.meta.url), "utf8");
  const settingsPage = readFileSync(
    new URL("../src/features/settings/components/pages/ThemeSettingsPage.tsx", import.meta.url),
    "utf8",
  );
  assert.equal(DEFAULT_TERMINAL_PANE_MARKER_FOCUS_COLOR, defaultFocusColor);
  assert.match(styles, /\.ui-terminal-pane-marker__right,[\s\S]*?height:\s*var\(--terminal-pane-marker-side-height,\s*2%\);/);
  assert.match(settingsPage, /grid-cols-\[minmax\(0,0\.9fr\)_minmax\(0,1\.1fr\)\][\s\S]*?PowerShell[\s\S]*?Codex/);
  assert.match(settingsPage, /"--terminal-pane-marker-side-height": "8px"/);
  assert.match(settingsPage, /flex min-w-0 flex-col[\s\S]*?min-h-0 flex-1 overflow-hidden/);
  assert.doesNotMatch(settingsPage, /h-\[72px\]/);
  assert.match(settingsPage, /className="ui-terminal-pane-marker"[\s\S]*?data-marker-style=\{style\}/);
  assert.match(settingsPage, /"--terminal-pane-marker-color": markerColor/);
  assert.match(settingsPage, /ui-terminal-pane-marker__top[\s\S]*?ui-terminal-pane-marker__right[\s\S]*?ui-terminal-pane-marker__bottom[\s\S]*?ui-terminal-pane-marker__left/);
  assert.doesNotMatch(settingsPage, /full \? "calc\(100% - 1\.5rem\)"/);
  assert.match(settingsPage, /selected && <Check/);
  assert.match(settingsPage, /borderColor: "var\(--border\)"/);
  assert.match(settingsPage, /background: selected[\s\S]*?color-mix\(in srgb, var\(--primary\) 8%, var\(--surface-container-low\)\)/);
  assert.doesNotMatch(settingsPage, /pointer-events-none absolute inset-0 z-20 rounded-xl border-2/);
  assert.doesNotMatch(settingsPage, /boxShadow: selected/);
});

test("settings status color options drive both Pane marker previews", () => {
  const settingsPage = readFileSync(
    new URL("../src/features/settings/components/pages/ThemeSettingsPage.tsx", import.meta.url),
    "utf8",
  );
  assert.match(settingsPage, /type PaneMarkerPreviewColorKey = "doneColor" \| "failedColor" \| "attentionColor"/);
  assert.match(settingsPage, /useState<PaneMarkerPreviewColorKey>\("doneColor"\)/);
  assert.match(settingsPage, /const paneMarkerPreviewColor = terminalPaneMarker\[paneMarkerPreviewColorKey\]/);
  assert.match(settingsPage, /markerColor=\{paneMarkerPreviewColor\}/);
  assert.match(settingsPage, /onClick=\{\(\) => setPaneMarkerPreviewColorKey\(key\)\}[\s\S]*?aria-pressed=\{selected\}/);
  assert.match(settingsPage, /onPointerDown=\{\(\) => setPaneMarkerPreviewColorKey\(key\)\}/);
  assert.match(settingsPage, /onFocus=\{\(\) => setPaneMarkerPreviewColorKey\(key\)\}/);
});

test("removed tab-frame settings migrate to tab-top", () => {
  assert.equal(sanitizeTerminalPaneMarkerSettings({ style: "tab-frame" }).style, "tab-top");
});

test("settings use the Terminal Status Marker name and expose no tab-frame option", () => {
  const settingsPage = readFileSync(
    new URL("../src/features/settings/components/pages/ThemeSettingsPage.tsx", import.meta.url),
    "utf8",
  );
  const i18n = readFileSync(new URL("../src/shared/i18n/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(settingsPage, /\["tab-frame",/);
  assert.doesNotMatch(i18n, /paneMarker\.style\.tabFrame/);
  assert.match(i18n, /"settings\.terminal\.paneMarker\.title": "终端状态标记"/);
  assert.match(i18n, /"settings\.terminal\.paneMarker\.title": "Terminal Status Markers"/);
  assert.match(settingsPage, /checked=\{terminalPaneMarker\.enabled\}/);
  assert.match(settingsPage, /<fieldset[\s\S]*?disabled=\{!terminalPaneMarker\.enabled\}/);
  assert.match(i18n, /"settings\.terminal\.paneMarker\.enabled": "启用终端状态标记"/);
  assert.match(i18n, /"settings\.terminal\.paneMarker\.enabled": "Enable terminal status markers"/);
});

test("disabled Pane marker settings suppress focus and Hook markers", () => {
  const settings = DEFAULT_TERMINAL_PANE_MARKER_SETTINGS;
  assert.equal(resolve({ settings }), null);
  assert.equal(resolve({ settings, hookStatus: "done" }), null);
  assert.equal(resolve({ settings, hookStatus: "attention", isAppFocused: false }), null);
});

test("single-Pane layouts render no marker even with multiple Tabs or Hook status", () => {
  assert.equal(resolve({ isSplitLayout: false }), null);
  assert.equal(resolve({ isSplitLayout: false, hookStatus: "done" }), null);
});

test("invalid style and colors fall back independently", () => {
  assert.deepEqual(sanitizeTerminalPaneMarkerSettings({
    style: "shadow",
    doneColor: "#112233",
    failedColor: "red",
    attentionColor: "#abcdef",
  }), {
    enabled: false,
    style: "tab-top",
    doneColor: "#112233",
    failedColor: "#F7768E",
    attentionColor: "#ABCDEF",
  });
});

test("focused Pane uses the default focus color at 2px and full opacity", () => {
  assert.equal(DEFAULT_TERMINAL_PANE_MARKER_FOCUS_COLOR, defaultFocusColor);
  assert.deepEqual(resolve(), {
    status: "focus",
    color: defaultFocusColor,
    width: 2,
    opacity: 1,
  });
});

test("app blur removes focus emphasis but keeps background Hook states", () => {
  assert.equal(resolve({ isAppFocused: false }), null);
  assert.deepEqual(resolve({ isAppFocused: false, hookStatus: "done" }), {
    status: "done",
    color: "#8FBF7F",
    width: 1,
    opacity: 0.5,
  });
});

test("done, failed and attention override the focused Pane color", () => {
  assert.equal(resolve({ hookStatus: "done" }).color, "#8FBF7F");
  assert.equal(resolve({ hookStatus: "failed" }).color, "#F7768E");
  assert.equal(resolve({ hookStatus: "attention" }).color, "#FF9E64");
  assert.equal(resolve({ hookStatus: "attention" }).width, 2);
});

test("background running and non-main Pane Hook state do not render", () => {
  assert.equal(resolve({ isPaneFocused: false, hookStatus: "running" }), null);
  assert.equal(resolve({ isPaneFocused: false, hookStatus: "failed", isMainSession: false }), null);
});

test("only the visible Workspan active Tab participates", () => {
  assert.equal(resolve({ isLayoutVisible: false, hookStatus: "attention" }), null);
  assert.deepEqual(resolve({
    isPaneFocused: false,
    hookStatus: "done",
  }), {
    status: "done",
    color: "#8FBF7F",
    width: 1,
    opacity: 0.5,
  });
});
