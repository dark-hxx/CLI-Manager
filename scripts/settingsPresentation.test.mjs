import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// Render the actual presentation components without starting Vite, Tauri, or any
// desktop services. These checks cover theme isolation and semantic markup only.
const output = await mkdtemp(join(tmpdir(), 'cli-settings-presentation-'));
after(() => rm(output, { recursive: true, force: true }));
const file = join(output, 'render.mjs');
await build({
  stdin: {
    resolveDir: process.cwd(), loader: 'tsx', contents: `
      import { createElement } from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      import { MantineProvider, TextInput, Select, SegmentedControl, Modal } from '@mantine/core';
      import { Settings2 } from 'lucide-react';
      import { SettingsThemeProvider } from './src/features/settings/components/SettingsThemeProvider';
      import { SettingsSection, SettingsRow } from './src/features/settings/components/SettingsPrimitives';
      import { SettingsLayout } from './src/features/settings/components/SettingsLayout';

      export function renderControls(scoped) {
        const controls = <>
          <TextInput label="Name" error="Invalid" disabled />
          <Select label="Choice" data={['One', 'Two']} value="One" dropdownOpened comboboxProps={{ withinPortal: false }} />
          <SegmentedControl data={['One', 'Two']} value="One" />
          <Modal opened withinPortal={false} title="Editor" transitionProps={{ duration: 0 }} onClose={() => {}}>
            <TextInput label="Nested name" />
          </Modal>
        </>;
        return renderToStaticMarkup(<MantineProvider forceColorScheme="light" env="test">
          {scoped ? <SettingsThemeProvider>{controls}</SettingsThemeProvider> : controls}
        </MantineProvider>);
      }

      export function renderLayout() {
        return renderToStaticMarkup(<MantineProvider><SettingsThemeProvider>
          <SettingsLayout tabs={[{ id: 'general', label: 'General', icon: Settings2 }, { id: 'tools', label: 'Tools', icon: Settings2 }]}
            activeTab="tools" onTabChange={() => {}} title="Tools" description="Configure tools" contentWidth="wide"
            searchValue="" onSearchChange={() => {}} onClose={() => {}}>
            <SettingsSection title="Connection"><SettingsRow title="Host" description="Remote host">
              <TextInput aria-label="Host" />
            </SettingsRow></SettingsSection>
            <SettingsSection title="Advanced" open={false} onToggle={() => {}}><span>Hidden content</span></SettingsSection>
          </SettingsLayout>
        </SettingsThemeProvider></MantineProvider>);
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
  logLevel: 'silent',
});
const { renderControls, renderLayout } = await import(pathToFileURL(file).href);

test('settings theme reaches real inputs, menus and modal content without changing controls outside its provider', () => {
  const scoped = renderControls(true);
  const outside = renderControls(false);
  for (const className of ['settings-input', 'settings-field-label', 'settings-menu', 'settings-segmented', 'settings-modal']) {
    assert.ok(scoped.includes(className), `Missing ${className} on actual Mantine markup`);
    assert.ok(!outside.includes(className), `${className} leaked outside settings`);
  }
  assert.match(scoped, /aria-invalid="true"/);
  assert.match(scoped, /disabled/);
});

test('desktop and compact navigation expose the same selected category; sections retain labels and collapse semantics', () => {
  const html = renderLayout();
  assert.match(html, /settings-mobile-nav/);
  assert.match(html, /value="tools"/);
  assert.match(html, /data-selected="true"[^>]*aria-pressed="true"/);
  assert.match(html, /data-width="wide"/);
  assert.match(html, /aria-label="Host"/);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /Hidden content/);
  assert.match(html, /aria-label="settings.closeLabel"/);
});
