import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const settingsSource = readFileSync(
  new URL("../src/shared/preferences/settingsStore.ts", import.meta.url),
  "utf8",
);
const defaultsSource = settingsSource.match(/const DEFAULTS: Settings = \{([\s\S]*?)\n\};/u)?.[1];

test("fresh installs use the product default theme combination", () => {
  assert.ok(defaultsSource);
  assert.match(defaultsSource, /theme: "light"/u);
  assert.match(defaultsSource, /lightThemePalette: "apple-mono"/u);
  assert.match(defaultsSource, /terminalThemeMode: "independent"/u);
  assert.match(defaultsSource, /terminalThemeName: "windowsTerminalCampbell"/u);
  assert.match(defaultsSource, /terminalSidePanelSkin: "classic-terminal"/u);
  assert.match(defaultsSource, /terminalBackground: \{[\s\S]*?enabled: false/u);
});
