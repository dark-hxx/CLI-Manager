import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-terminal-preview-theme-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

function transpile(relativePath, fileName, replacements = []) {
  const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
  let output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
    fileName,
  }).outputText;
  for (const [from, to] of replacements) output = output.replace(from, to);
  const modulePath = join(tempDir, fileName.replace(/\.ts$/u, ".mjs"));
  writeFileSync(modulePath, output, "utf8");
  return modulePath;
}

transpile("../src/shared/lib/terminalColor.ts", "terminalColor.ts");
const themesPath = transpile("../src/shared/lib/terminalThemes.ts", "terminalThemes.ts", [
  ['from "./terminalColor"', 'from "./terminalColor.mjs"'],
]);
const previewPath = transpile("../src/shared/lib/terminalPreviewTheme.ts", "terminalPreviewTheme.ts", [
  ['from "./terminalColor"', 'from "./terminalColor.mjs"'],
  ['from "./terminalThemes"', 'from "./terminalThemes.mjs"'],
]);

const { getTerminalTheme, isLightTerminalTheme } = await import(pathToFileURL(themesPath).href);
const {
  FOLLOW_TERMINAL_PREVIEW_THEME,
  buildTerminalPreviewAccentStyle,
  buildTerminalPreviewPanelStyle,
  isIndependentTerminalPreviewTheme,
  resolveTerminalPreviewTheme,
} = await import(pathToFileURL(previewPath).href);

const DARK_TERMINAL_THEME = "windowsTerminalCampbell";
const LIGHT_PREVIEW_THEME = "windowsTerminalOneHalfLight";

function baseInput(overrides = {}) {
  return {
    previewThemeName: FOLLOW_TERMINAL_PREVIEW_THEME,
    terminalThemeName: DARK_TERMINAL_THEME,
    resolvedTheme: "dark",
    lightThemePalette: "warm-paper",
    darkThemePalette: "night-indigo",
    ...overrides,
  };
}

test("following the terminal resolves the terminal theme itself", () => {
  const resolution = resolveTerminalPreviewTheme(baseInput());
  const terminalTheme = getTerminalTheme(DARK_TERMINAL_THEME, "dark", "warm-paper", "night-indigo");

  assert.equal(resolution.isIndependent, false);
  assert.equal(resolution.theme.background, terminalTheme.background);
  assert.equal(resolution.tone, isLightTerminalTheme(terminalTheme) ? "light" : "dark");
  assert.equal(resolution.tone, "dark");
});

test("an independent preset overrides the terminal theme and its brightness", () => {
  const resolution = resolveTerminalPreviewTheme(baseInput({ previewThemeName: LIGHT_PREVIEW_THEME }));
  const previewTheme = getTerminalTheme(LIGHT_PREVIEW_THEME, "dark", "warm-paper", "night-indigo");

  assert.equal(resolution.isIndependent, true);
  assert.equal(resolution.theme.background, previewTheme.background);
  assert.equal(resolution.tone, "light");
});

test("unknown, empty, and renamed preset ids fall back to following the terminal", () => {
  const terminalTheme = getTerminalTheme(DARK_TERMINAL_THEME, "dark", "warm-paper", "night-indigo");
  for (const previewThemeName of ["", "auto", "renamedAwayLight", "follow-terminal"]) {
    const resolution = resolveTerminalPreviewTheme(baseInput({ previewThemeName }));
    assert.equal(resolution.isIndependent, false, previewThemeName);
    assert.equal(resolution.theme.background, terminalTheme.background, previewThemeName);
  }
  assert.equal(isIndependentTerminalPreviewTheme(LIGHT_PREVIEW_THEME), true);
  assert.equal(isIndependentTerminalPreviewTheme(FOLLOW_TERMINAL_PREVIEW_THEME), false);
});

test("the terminal text-color override only applies while following the terminal", () => {
  const following = resolveTerminalPreviewTheme(baseInput({ terminalTextColor: "#123456" }));
  assert.equal(following.theme.foreground, "#123456");
  assert.equal(following.panelStyle["--terminal-theme-foreground"], "#123456");

  const independent = resolveTerminalPreviewTheme(baseInput({
    previewThemeName: LIGHT_PREVIEW_THEME,
    terminalTextColor: "#123456",
  }));
  const previewTheme = getTerminalTheme(LIGHT_PREVIEW_THEME, "dark", "warm-paper", "night-indigo");
  assert.equal(independent.theme.foreground, previewTheme.foreground);
});

test("panel style scopes the terminal panel variables the preview panels read", () => {
  const style = buildTerminalPreviewPanelStyle({ background: "#ffffff", foreground: "#101010" });

  assert.equal(style["--term-panel-bg"], "#ffffff");
  assert.equal(style["--term-panel-fg"], "#101010");
  assert.equal(style["--terminal-theme-background"], "#ffffff");
  for (const variable of ["--term-panel-card", "--term-panel-border", "--ui-scrollbar-thumb"]) {
    assert.ok(typeof style[variable] === "string" && style[variable].length > 0, variable);
  }
});

test("accent style lifts unreadable ANSI accents on dark cards and keeps legible ones", async () => {
  const { getContrastRatio, hexToRgb } = await import(pathToFileURL(join(tempDir, "terminalColor.mjs")).href);
  const campbell = getTerminalTheme(DARK_TERMINAL_THEME, "dark", "warm-paper", "night-indigo");
  const card = hexToRgb(campbell.background).map((channel, index) => channel * 0.91 + hexToRgb(campbell.foreground)[index] * 0.09);
  const style = buildTerminalPreviewAccentStyle(campbell);

  // Campbell 的蓝/红在深色卡片上低于 3:1，提亮后达到 4:1 且仍是蓝/红色相。
  for (const key of ["blue", "red", "magenta"]) {
    const value = hexToRgb(style[`--term-panel-${key}`]);
    assert.ok(getContrastRatio(value, card) >= 4, key);
  }
  const [r, g, b] = hexToRgb(style["--term-panel-blue"]);
  assert.ok(b > r && b > g);
  // 已经可读的颜色原样保留。
  assert.equal(style["--term-panel-green"], campbell.green.toUpperCase());

  const light = buildTerminalPreviewAccentStyle({ background: "#ffffff", foreground: "#101010", yellow: "#C19C00" });
  const lightCard = [255 * 0.91 + 16 * 0.09, 255 * 0.91 + 16 * 0.09, 255 * 0.91 + 16 * 0.09];
  assert.ok(getContrastRatio(hexToRgb(light["--term-panel-yellow"]), lightCard) >= 4);
  assert.equal(light["--term-panel-blue"], undefined);
});

test("preview panels resolve their theme through the shared hook only", () => {
  const panels = [
    "../src/features/terminal/components/TerminalMarkdownPreview.tsx",
    "../src/features/terminal/components/SubagentTranscriptView.tsx",
    "../src/features/terminal/components/SessionReplayPanel.tsx",
    "../src/features/git/components/diff/GitDiffViewer.tsx",
  ];
  for (const panel of panels) {
    const source = readFileSync(new URL(panel, import.meta.url), "utf8");
    assert.match(source, /useTerminalPreviewTheme/u, panel);
    assert.doesNotMatch(source, /isLightTerminalTheme/u, panel);
  }

  const replaySource = readFileSync(new URL(panels[2], import.meta.url), "utf8");
  const linkBehaviorPins = replaySource.match(/linkBehavior="preview"/gu) ?? [];
  const terminalVariants = replaySource.match(/variant="terminal"/gu) ?? [];
  assert.equal(linkBehaviorPins.length, terminalVariants.length);
  assert.ok(terminalVariants.length >= 2);
});

test("the preview theme setting is persisted, defaulted, and synced like the terminal theme", () => {
  const settingsSource = readFileSync(new URL("../src/shared/preferences/settingsStore.ts", import.meta.url), "utf8");
  const syncSource = readFileSync(new URL("../src/features/sync/lib/syncSettings.ts", import.meta.url), "utf8");

  assert.match(settingsSource, /terminalPreviewThemeName: string;/u);
  assert.match(settingsSource, /terminalPreviewThemeName: FOLLOW_TERMINAL_PREVIEW_THEME/u);
  assert.match(settingsSource, /isKnownTerminalThemePreset\(storedTerminalPreviewThemeName\)/u);
  assert.match(syncSource, /terminalPreviewThemeName: "preferences"/u);
});
