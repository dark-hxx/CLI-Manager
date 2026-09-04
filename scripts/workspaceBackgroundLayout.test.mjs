import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const backgroundSource = readFileSync(
  new URL("../src/components/workspace/WorkspaceBackground.tsx", import.meta.url),
  "utf8",
);
const xtermSource = readFileSync(new URL("../src/components/XTermTerminal.tsx", import.meta.url), "utf8");
const sidePanelSource = readFileSync(new URL("../src/components/terminal/TerminalSidePanel.tsx", import.meta.url), "utf8");
const settingsModalSource = readFileSync(new URL("../src/components/SettingsModal.tsx", import.meta.url), "utf8");
const statsSource = readFileSync(new URL("../src/components/stats/StatsPanel.tsx", import.meta.url), "utf8");
const ccusageStatsSource = readFileSync(new URL("../src/components/stats/CcusageStatsPanel.tsx", import.meta.url), "utf8");
const settingsSource = readFileSync(new URL("../src/stores/settingsStore.ts", import.meta.url), "utf8");
const stylesSource = readFileSync(new URL("../src/styles/workspace-layout.css", import.meta.url), "utf8");

test("App mounts one shared workspace layout boundary", () => {
  assert.match(appSource, /import \{ WorkspaceLayoutShell \} from .*WorkspaceLayoutShell/);
  assert.equal((appSource.match(/<WorkspaceLayoutShell>/g) ?? []).length, 1);
  assert.match(backgroundSource, /<WorkspaceBackgroundContext\.Provider/);
  assert.equal((backgroundSource.match(/ui-workspace-background-layer/g) ?? []).length, 1);
});

test("workspace background resolves the asset once and keeps a safe fallback", () => {
  assert.match(backgroundSource, /backgroundAssetUrl\(background\.imagePath\)/);
  assert.match(backgroundSource, /setAssetUrl\(null\)/);
  assert.match(backgroundSource, /active: layerVisible/);
  assert.match(stylesSource, /\.ui-workspace-background-layer[\s\S]*pointer-events: none/);
});

test("fillWorkspace is migrated with a disabled-by-default contract", () => {
  assert.match(settingsSource, /fillWorkspace: boolean;/);
  assert.match(settingsSource, /fillWorkspace: false,/);
  assert.match(settingsSource, /typeof raw\.fillWorkspace === "boolean"/);
});

test("terminal-local and workspace background layers are mutually exclusive", () => {
  assert.match(xtermSource, /workspaceBackground\.requested/);
  assert.match(xtermSource, /!workspaceBackground\.requested && assetUrl !== null/);
  assert.match(xtermSource, /data-workspace-bg-enabled=\{showWorkspaceBackground/);
});

test("workspace background is decorative and exposes the shared image through surfaces", () => {
  assert.match(stylesSource, /\.ui-workspace-background-layer::before[\s\S]*pointer-events: none/);
  assert.match(stylesSource, /\.ui-workspace-background-layer::after[\s\S]*pointer-events: none/);
  assert.match(stylesSource, /data-workspace-bg-fit="contain"/);
  assert.match(stylesSource, /data-workspace-bg-position="bottom-right"/);
  assert.match(stylesSource, /\.ui-workspace-background-root\[data-workspace-background="true"\] \.ui-sidebar-shell/);
  assert.match(appSource, /<WorkspaceLayoutShell>\s*\{\(!terminalFullscreen \|\| viewMode === "compact"\) && <WindowTitleBar \/>\}/);
  const workspaceShellSource = appSource.match(/<WorkspaceLayoutShell>[\s\S]*?<\/WorkspaceLayoutShell>/)?.[0] ?? "";
  assert.match(workspaceShellSource, /<Suspense fallback=\{null\}>[\s\S]*?<SettingsModal/);
  assert.match(settingsModalSource, /useWorkspaceBackground/);
  assert.match(settingsModalSource, /data-workspace-background=\{workspaceBackgroundActive \? "true" : undefined\}/);
  assert.match(statsSource, /data-workspace-background=\{workspaceBackgroundActive \? "true" : undefined\}/);
  assert.match(ccusageStatsSource, /data-workspace-background=\{workspaceBackgroundActive \? "true" : undefined\}/);
  assert.match(stylesSource, /\.ui-workspace-settings-overlay\[data-workspace-background="true"\]/);
  assert.match(stylesSource, /\.ui-stats-panel\[data-workspace-background="true"\][\s\S]*?background-color: color-mix/);
  assert.match(stylesSource, /\.ui-workspace-background-root\[data-workspace-background="true"\] \.window-titlebar[\s\S]*?background: transparent !important;/);
  assert.match(stylesSource, /\.ui-workspace-background-root\[data-workspace-background="true"\] \{\n  background-color: transparent;/);
  assert.match(stylesSource, /\.ui-workspace-background-root\[data-workspace-background="true"\] \.ui-sidebar-shell,\n\.ui-workspace-background-root\[data-workspace-background="true"\] \.ui-sidebar-top,[\s\S]*?background: transparent !important;/);
  assert.match(stylesSource, /data-terminal-side-panel-content\] > \*/);
  assert.match(stylesSource, /\.ui-terminal-side-panel-frame,[\s\S]*?background: transparent !important;/);
  assert.match(stylesSource, /\.ui-terminal-side-panel-frame > :not\(\[role="separator"\]\)/);
  assert.match(sidePanelSource, /data-terminal-side-panel-content="true"/);
  assert.match(stylesSource, /\.ui-workspace-background-root\[data-workspace-background="true"\] \.ui-terminal-pane-chrome,[\s\S]*?background: transparent !important;/);
  assert.match(stylesSource, /\.ui-workspace-background-root\[data-workspace-background="true"\] \.ui-terminal-well \{\n  background-color: transparent !important;/);
  assert.match(stylesSource, /\.ui-terminal-bg-layer\[data-workspace-bg-enabled="true"\] \.xterm/);
});
