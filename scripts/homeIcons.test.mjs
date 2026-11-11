import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const directory = await mkdtemp(join(tmpdir(), "cli-home-icons-"));
after(() => rm(directory, { recursive: true, force: true }));
const output = join(directory, "render.mjs");
await build({
  stdin: {
    resolveDir: process.cwd(), loader: "tsx", contents: `
      import { createElement } from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      import * as Home from './src/shared/ui/homeIcons';
      import * as Classic from './src/shared/ui/icons';
      import * as Lucide from 'lucide-react';
      import { SidebarHeader } from './src/features/projects/components/SidebarHeader';
      import { NodeAppearanceIcon } from './src/features/projects/api/NodeAppearanceIcon';
      import { CliToolIcon } from './src/shared/ui/CliToolIcon';
      import { VendorIcon } from './src/shared/ui/VendorIcon';
      import { useSettingsStore } from './src/shared/preferences/settingsStore';
      export const names = Object.keys(Home);
      export function icon(name, style, props = {}, original = false) {
        useSettingsStore.setState({ settingsIconStyle: style });
        return renderToStaticMarkup(createElement(original ? Classic[name] ?? Lucide[name] : Home[name], props));
      }
      export function node(style, props) {
        useSettingsStore.setState({ settingsIconStyle: style });
        return renderToStaticMarkup(createElement(NodeAppearanceIcon, { mark: '', fallback: 'folder', homeStyle: true, ...props }));
      }
      export function twice(name) {
        useSettingsStore.setState({ settingsIconStyle: 'refined' });
        const Icon = Home[name];
        return renderToStaticMarkup(<><Icon /><Icon /></>);
      }
      export function brand(style) {
        useSettingsStore.setState({ settingsIconStyle: style });
        return renderToStaticMarkup(<><CliToolIcon icon="codex" /><VendorIcon vendor="openai" /></>);
      }
      export function twoFolders() {
        useSettingsStore.setState({ settingsIconStyle: 'refined' });
        return renderToStaticMarkup(<><Home.Folder /><Home.Folder /></>);
      }
      export function header(style, collapsed, dockSide) {
        useSettingsStore.setState({ settingsIconStyle: style });
        return renderToStaticMarkup(<SidebarHeader
          collapsed={collapsed} dockSide={dockSide} density="compact"
          projectFilter="all" showProjectFilter totalProjectCount={1}
          openProjectCount={1} pinnedProjectCount={0}
          onToggleCollapse={() => {}} onProjectFilterChange={() => {}}
          onCreateGroup={() => {}} onCreateProject={() => {}}
        />);
      }
    `,
  },
  bundle: true, platform: "node", format: "esm", jsx: "automatic", outfile: output,
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  plugins: [{
    name: "i18n-fixture",
    setup(plugin) {
      // Server rendering must read the selected test snapshot, not Zustand's startup snapshot.
      plugin.onResolve({ filter: /preferences\/settingsStore$/ }, () => ({ path: "store", namespace: "store-fixture" }));
      plugin.onLoad({ filter: /.*/, namespace: "store-fixture" }, () => ({
        resolveDir: process.cwd(), loader: "js", contents: `
          import { useSyncExternalStore } from 'react';
          import { createStore } from 'zustand/vanilla';
          const store = createStore(() => ({ settingsIconStyle: 'refined' }));
          export const useSettingsStore = Object.assign(
            selector => useSyncExternalStore(store.subscribe,
              () => selector(store.getState()), () => selector(store.getState())), store);
        `,
      }));
      plugin.onResolve({ filter: /shared\/i18n\/index$/ }, () => ({ path: "i18n", namespace: "fixture" }));
      plugin.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
        contents: 'export const useI18n = () => ({ t: key => key });', loader: "js",
      }));
    },
  }],
});
const mod = await import(pathToFileURL(output).href);

test("classic mode exactly restores each original icon and SVG props", () => {
  for (const name of mod.names) {
    for (const props of [{}, { size: 16, strokeWidth: 1.5, className: "rotate-180", style: { color: "red" } }]) {
      assert.equal(mod.icon(name, "classic", props), mod.icon(name, "classic", props, true), name);
    }
  }
});

test("refined mode preserves dimensions, state color, transforms and accessible overrides", () => {
  for (const name of mod.names) {
    const html = mod.icon(name, "refined", {
      size: 18, strokeWidth: 1.5, className: "rotate-180", style: { color: "red" },
      "aria-hidden": false, "aria-label": "Action", role: "img",
    });
    assert.match(html, /width="18"/);
    assert.match(html, /stroke="currentColor"/);
    assert.match(html, /stroke-width="1.5"/);
    assert.match(html, /class="rotate-180"/);
    assert.match(html, /color:red/);
    assert.match(html, /aria-hidden="false"/);
    assert.match(html, /aria-label="Action"/);
    assert.notEqual(html, mod.icon(name, "classic", { size: 18 }), name);
  }
});

test("refined mode applies the Apple palette and keeps state icons inheriting color", () => {
  assert.match(mod.icon("Folder", "refined"), /style="color:var\(--node-accent, #4B95FB\)"/);
  assert.match(mod.icon("Folder", "refined"), /url\(#[^)]*folder-back\)/);
  assert.match(mod.icon("Terminal", "refined"), /style="color:#34C759"/);
  assert.match(mod.icon("Terminal", "refined"), /url\(#[^)]*home-terminal-body\)/);
  assert.match(mod.icon("Trash2", "refined"), /url\(#[^)]*-sheen\)/);
  assert.match(mod.icon("Command", "refined"), /style="color:#FF375F"/);
  assert.match(mod.icon("Trash2", "refined"), /style="color:#FF3B30"/);
  assert.match(mod.icon("Search", "refined"), /style="color:#7C8798"/);
  for (const name of ["AlertTriangle", "Check", "Cloud", "CircleStop", "Copy", "Filter", "Link2", "Minus", "Square", "X"]) {
    assert.doesNotMatch(mod.icon(name, "refined"), /style="color:/, name);
  }
});

test("each folder instance owns its gradient id so project accents do not leak", () => {
  const html = mod.twoFolders();
  const ids = [...html.matchAll(/id="([^"]*folder-back)"/g)].map((match) => match[1]);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
  for (const id of ids) assert.match(html, new RegExp(`url\\(#${id}\\)`));
});

test("sheen and terminal gradients are scoped per instance", () => {
  for (const name of ["Trash2", "Terminal", "FileCode"]) {
    const ids = [...mod.twice(name).matchAll(/ id="([^"]+)"/g)].map((match) => match[1]);
    assert.ok(ids.length >= 2, name);
    assert.equal(new Set(ids).size, ids.length, name);
  }
});

test("CLI logos are normalized into the same 18/24 safe area as function glyphs", () => {
  const logo = mod.node("refined", { size: 17, cliTool: "codex" });
  assert.match(logo, /^<svg width="17" height="17" viewBox="0 0 24 24"/);
  assert.match(logo, /<svg x="3" y="3" width="18" height="18">/);
  assert.match(mod.node("refined", { size: 17 }), /^<svg[^>]*width="17" height="17"/);
});

test("sidebar expanded/collapsed and left/right layouts follow both toggle directions", () => {
  for (const collapsed of [true, false]) {
    for (const side of ["left", "right"]) {
      const classic = mod.header("classic", collapsed, side);
      assert.doesNotMatch(classic, /data-home-icon/);
      assert.match(mod.header("refined", collapsed, side), /data-home-icon/);
      assert.equal(mod.header("classic", collapsed, side), classic);
    }
  }
});

test("only homepage fallback node icons change; custom and brand identities are isolated", () => {
  assert.notEqual(mod.node("classic", {}), mod.node("refined", {}));
  for (const props of [
    { mark: "🚀" }, { iconKey: "brand-feishu" }, { iconKey: "copilot" },
    { cliTool: "codex" }, { homeStyle: false },
  ]) {
    assert.equal(mod.node("classic", props), mod.node("refined", props));
  }
  assert.equal(mod.brand("classic"), mod.brand("refined"));
});
