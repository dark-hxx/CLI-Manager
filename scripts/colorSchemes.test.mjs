import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { loadColorSchemes, contrastRatio } from "./colorSchemePreview.mjs";

const { schemes, runtime } = await loadColorSchemes();
const ansiColors = ["red", "green", "yellow", "blue", "magenta", "cyan", "brightBlack",
  "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan"];

test("all six application palettes resolve to matching terminal presets and preserve independent choices", () => {
  assert.equal(schemes.length, 6);
  assert.equal(schemes.filter((scheme) => scheme.tone === "light").length, 3);
  for (const { id, tone, preset, tokens } of schemes) {
    assert.ok(runtime.isKnownTerminalThemePreset(preset.id), id);
    assert.equal(runtime.resolveAutoTerminalThemeId(tone, id, id), preset.id, id);
    const automatic = runtime.getTerminalTheme("auto", tone, id, id);
    assert.equal(automatic.background, tokens["bg-primary"], id);
    assert.equal(automatic.foreground, tokens["text-primary"], id);
    assert.equal(runtime.isLightTerminalTheme(automatic), tone === "light", id);
    assert.equal(runtime.getTerminalTheme(preset.id, tone === "light" ? "dark" : "light"), automatic, id);
  }
});

test("new palettes retain readable body, muted, status, selection and button colors", () => {
  for (const { id, preset, tokens } of schemes) {
    const term = preset.theme;
    for (const surface of ["bg-primary", "bg-secondary", "bg-tertiary"]) {
      for (const text of ["text-primary", "text-secondary", "text-muted"]) {
        assert.ok(contrastRatio(tokens[text], tokens[surface]) >= 4.5, `${id}: ${text}/${surface}`);
      }
    }
    for (const key of ansiColors) {
      assert.ok(contrastRatio(term[key], term.background) >= 4.5, `${id}: ANSI ${key}`);
    }
    assert.ok(contrastRatio(term.foreground, term.background) >= 7, `${id}: body`);
    assert.ok(contrastRatio(term.selectionForeground, term.selectionBackground) >= 4.5, `${id}: selection`);
    assert.ok(contrastRatio(tokens["on-primary"], tokens.accent) >= 4.5, `${id}: button`);
    assert.ok(contrastRatio(tokens["on-primary"], tokens["accent-hover"]) >= 4.5, `${id}: button hover`);
  }
});

test("terminal previews, custom text and background-image contrast work with every new palette", () => {
  for (const { id, tone, preset } of schemes) {
    const input = {
      previewThemeName: runtime.FOLLOW_TERMINAL_PREVIEW_THEME,
      terminalThemeName: "auto", resolvedTheme: tone, lightThemePalette: id, darkThemePalette: id,
    };
    const following = runtime.resolveTerminalPreviewTheme(input);
    assert.equal(following.theme, preset.theme);
    assert.equal(following.tone, tone);
    assert.equal(following.panelStyle["--term-panel-bg"], preset.theme.background);
    assert.equal(runtime.resolveTerminalPreviewTheme({ ...input, terminalTextColor: "#abcdef" }).theme.foreground, "#abcdef");
    const independent = runtime.resolveTerminalPreviewTheme({
      ...input, previewThemeName: preset.id, terminalThemeName: "githubDark", terminalTextColor: "#abcdef",
    });
    assert.equal(independent.theme.foreground, preset.theme.foreground);
    assert.equal(independent.isIndependent, true);
    assert.ok(runtime.getTerminalMinimumContrastRatio(preset.theme, true) >= 6);
    assert.match(runtime.applyTransparency(preset.theme, 50).background, /^rgba\(/u);
    assert.equal(runtime.getTerminalTheme(preset.id, tone).background, preset.theme.background);
  }
});

// Render actual providers and picker markup with only the persisted store replaced by a read-only fixture.
const directory = await mkdtemp(join(tmpdir(), "cli-color-schemes-"));
after(() => rm(directory, { recursive: true, force: true }));
const output = join(directory, "render.mjs");
await build({
  stdin: { resolveDir: process.cwd(), loader: "tsx", contents: `
    import { renderToStaticMarkup } from "react-dom/server";
    import { useMantineTheme, Button } from "@mantine/core";
    import { AppMantineThemeProvider } from "./src/shared/ui/MantineThemeProvider";
    import { TerminalThemePresetGrid } from "./src/features/settings/components/pages/TerminalThemePresetGrid";
    import { TerminalAppearancePreview } from "./src/features/settings/components/pages/TerminalAppearancePreview";
    import { state } from "virtual:palette-state";
    let resolved;
    function Probe() {
      const theme = useMantineTheme();
      const filled = theme.variantColorResolver({ color: "cliPrimary", variant: "filled", theme });
      resolved = {
        accent: theme.colors.cliPrimary[6], autoContrast: theme.autoContrast,
        buttonText: filled.color.includes("-black") ? theme.black : theme.white,
      };
      return <Button>Action</Button>;
    }
    export function renderPalette(tone, id, language, preset) {
      Object.assign(state, { resolvedTheme: tone, lightThemePalette: id, darkThemePalette: id, language });
      const markup = renderToStaticMarkup(<AppMantineThemeProvider>
        <Probe /><TerminalThemePresetGrid groups={[{ id: preset.group, presets: [preset] }]}
          isSelected={() => true} onSelect={() => {}} />
      </AppMantineThemeProvider>);
      return { ...resolved, markup };
    }
    export function renderAppearance(language, theme, textColor = "", fontSize = 14) {
      state.language = language;
      return renderToStaticMarkup(<TerminalAppearancePreview theme={theme} themeName="Preview"
        fontFamily="Cascadia Code, monospace" fontSize={fontSize} textColor={textColor} />);
    }
  ` },
  bundle: true, platform: "node", format: "esm", jsx: "automatic", outfile: output,
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  plugins: [{ name: "palette-state-fixture", setup(plugin) {
    plugin.onResolve({ filter: /settingsStore$|^virtual:palette-state$/ }, () => ({ path: "state", namespace: "palette" }));
    plugin.onResolve({ filter: /shared\/i18n\/index$/ }, () => ({ path: "i18n", namespace: "palette" }));
    plugin.onLoad({ filter: /.*/, namespace: "palette" }, ({ path }) => ({
      resolveDir: process.cwd(), loader: "js",
      contents: path === "state"
        ? 'export const state = { uiFontFamily: "Segoe UI", uiFontSize: 13 }; export const useSettingsStore = fn => fn(state);'
        : `import { state } from "virtual:palette-state";
           import { zh } from "./src/shared/i18n/messages/settings.zh-CN";
           import { en } from "./src/shared/i18n/messages/settings.en-US";
           export const pickByLanguage = (lang, zh, en) => lang === "zh-CN" ? zh : en;
           export const useI18n = () => ({ language: state.language, t: key => (state.language === "zh-CN" ? zh : en)[key] ?? key });`,
    }));
  } }], logLevel: "silent",
});
const { renderPalette, renderAppearance } = await import(pathToFileURL(output).href);

test("appearance preview keeps terminal background, text, selection and ANSI colors together in both languages", () => {
  for (const { id, preset } of schemes) {
    for (const language of ["zh-CN", "en-US"]) {
      const markup = renderAppearance(language, preset.theme);
      assert.ok(markup.includes(`--appearance-background:${preset.theme.background}`), id);
      assert.ok(markup.includes(`--appearance-foreground:${preset.theme.foreground}`), id);
      assert.ok(markup.includes(`--appearance-selection:${preset.theme.selectionBackground}`), id);
      assert.equal((markup.match(/class="terminal-appearance-swatch"/gu) ?? []).length, 16, id);
      assert.match(markup, /role="region"[^>]*tabindex="0"/u);
      assert.ok(markup.includes((language === "zh-CN" ? runtime.zh : runtime.en)["settings.terminalPreview.success"]), id);
      assert.doesNotMatch(markup, /settings\.terminalPreview\./u);
      assert.match(markup, /git diff/u);
    }
    const custom = renderAppearance("en-US", preset.theme, "#abcdef", 24);
    assert.ok(custom.includes("--appearance-foreground:#abcdef"), id);
    assert.ok(custom.includes(`--appearance-background:${preset.theme.background}`), id);
    assert.ok(custom.includes("font-family:Cascadia Code, monospace;font-size:24px"), id);
    assert.match(custom, /24px<\/span>/u);
  }
});

test("real Mantine controls use palette accents and readable filled labels; picker names translate", () => {
  for (const scheme of schemes) {
    for (const language of ["zh-CN", "en-US"]) {
      const result = renderPalette(scheme.tone, scheme.id, language, scheme.preset);
      assert.equal(result.accent, scheme.tokens.accent, scheme.id);
      assert.equal(result.autoContrast, true);
      assert.ok(contrastRatio(result.buttonText, result.accent) >= 4.5, `${scheme.id}: Mantine label`);
      assert.ok(result.markup.includes(language === "zh-CN" ? scheme.zh : scheme.en), scheme.id);
      assert.match(result.markup, /aria-pressed="true"/u);
    }
  }
  const legacy = renderPalette("light", "apple-mono", "en-US", schemes[0].preset);
  assert.equal(legacy.autoContrast, false);
  assert.equal(legacy.accent, "#3a3a3c");
});
