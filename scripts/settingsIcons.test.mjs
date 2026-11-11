import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// Render the hand-drawn settings icon set without starting Vite or the desktop app.
const output = await mkdtemp(join(tmpdir(), 'cli-settings-icons-'));
after(() => rm(output, { recursive: true, force: true }));
const file = join(output, 'render.mjs');

await build({
  stdin: {
    resolveDir: process.cwd(), loader: 'tsx', contents: `
      import { createElement } from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      import { Settings2 } from 'lucide-react';
      import {
        SETTINGS_NAV_ICONS,
        SETTINGS_STRUCTURE_GLYPHS,
        SettingsGlyph,
      } from './src/features/settings/components/SettingsIcons';
      import { SettingsNav } from './src/features/settings/components/SettingsNav';
      import { useSettingsStore } from './src/shared/preferences/settingsStore';

      export const navIconNames = Object.keys(SETTINGS_NAV_ICONS);
      export const glyphNames = Object.keys(SETTINGS_STRUCTURE_GLYPHS);

      export function renderNavIcon(name) {
        const Icon = SETTINGS_NAV_ICONS[name];
        return renderToStaticMarkup(createElement(Icon, { size: 18 }));
      }

      export function renderGlyph(name) {
        const Glyph = SETTINGS_STRUCTURE_GLYPHS[name];
        return renderToStaticMarkup(createElement(Glyph, { size: 16 }));
      }

      export function renderStructurePair() {
        return renderToStaticMarkup(createElement(SettingsGlyph, {
          name: 'folder', classic: Settings2, size: 16,
        }));
      }

      export function renderNav(style) {
        useSettingsStore.setState({ settingsIconStyle: style });
        return renderToStaticMarkup(createElement(SettingsNav, {
          tabs: [
            { id: 'general', label: 'General', icon: Settings2 },
            { id: 'tools', label: 'Tools', icon: Settings2 },
          ],
          activeTab: 'tools',
          onChange: () => {},
        }));
      }

      export function defaultIconStyle() {
        return useSettingsStore.getInitialState().settingsIconStyle;
      }
    `,
  },
  bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', outfile: file,
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  plugins: [{
    name: 'settings-i18n-fixture',
    setup(plugin) {
      plugin.onResolve({ filter: /shared\/i18n\/index$/ }, () => ({ path: 'i18n', namespace: 'settings-fixture' }));
      plugin.onLoad({ filter: /.*/, namespace: 'settings-fixture' }, () => ({
        contents: 'export const useI18n = () => ({ t: key => key });', loader: 'js',
      }));
    },
  }],
});

const mod = await import(pathToFileURL(file).href);

test('every nav tile is a self-drawn rounded color tile with a glyph', () => {
  assert.equal(mod.navIconNames.length, 19);
  for (const name of mod.navIconNames) {
    const html = mod.renderNavIcon(name);
    assert.match(html, /<rect[^>]*rx="6"/, `${name} should own a rounded tile`);
    assert.match(html, /stroke="#fff"/, `${name} should not inherit currentColor`);
    assert.match(html, /aria-hidden="true"/, `${name} should be hidden from AT`);
    assert.ok(/<(path|circle|ellipse)/.test(html), `${name} should contain a glyph`);
  }
});

test('every structure glyph uses the shared 24px line style', () => {
  assert.ok(mod.glyphNames.length >= 20);
  for (const name of mod.glyphNames) {
    const html = mod.renderGlyph(name);
    assert.match(html, /viewBox="0 0 24 24"/, `${name} should share the 24px grid`);
    assert.match(html, /stroke="currentColor"/, `${name} should inherit text color`);
    assert.match(html, /stroke-width="1.7"/, `${name} should share the stroke weight`);
    assert.match(html, /aria-hidden="true"/);
  }
});

test('structure icons keep a classic lucide fallback', async () => {
  const source = await readFile(
    new URL('../src/features/settings/components/SettingsIcons.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /state\.settingsIconStyle === "refined"/);
  assert.match(source, /return <Classic \{\.\.\.props\} \/>/);

  // SSR cannot observe setState through useSyncExternalStore, so the refined
  // default is rendered and the fallback branch is verified from source.
  const refined = mod.renderStructurePair();
  assert.match(refined, /viewBox="0 0 24 24"[\s\S]*stroke-width="1.7"/);
});

test('nav switches size and icon-style marker with the preference', async () => {
  const refined = mod.renderNav('refined');
  assert.match(refined, /data-icon-style="refined"/);
  assert.match(refined, /width="18" height="18"/);

  const source = await readFile(
    new URL('../src/features/settings/components/SettingsNav.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /data-icon-style=\{iconStyle\}/);
  assert.match(source, /strokeWidth=\{1\.65\}/);
});

test('fresh installs default to refined icons', () => {
  assert.equal(mod.defaultIconStyle(), 'refined');
});
