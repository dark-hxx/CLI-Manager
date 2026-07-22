import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  mergeFontFamilyOptions,
  normalizeFontFamilyStack,
  withFontFallback,
} from "../src/lib/systemFonts.ts";

const terminalNormalizer = (value) =>
  normalizeFontFamilyStack(value, '"Symbols Nerd Font Mono", monospace');

const themeSettingsSource = readFileSync(
  new URL("../src/components/settings/pages/ThemeSettingsPage.tsx", import.meta.url),
  "utf8"
);

test("terminal font options use the terminal-specific normalizer", () => {
  assert.match(
    themeSettingsSource,
    /TERMINAL_FONT_FALLBACK,\s*normalizeTerminalFontFamily,?\s*\)/
  );
});

for (const family of ["Maple Mono", "霞鹜文楷等宽", "ACME, Mono", "Mono.Name (Pro)"]) {
  test(`matches installed terminal font option: ${family}`, () => {
    const selectedValue = terminalNormalizer(withFontFallback(family, "monospace"));
    const options = mergeFontFamilyOptions(
      selectedValue,
      [],
      [{ family }],
      "monospace",
      terminalNormalizer
    );

    assert.equal(options[0]?.label, family);
    assert.equal(options.some((option) => option.label === "当前自定义（保留）"), false);
  });
}

test("serializes a comma-containing system font as one CSS family", () => {
  assert.equal(withFontFallback("ACME, Mono", "monospace"), '"ACME, Mono", monospace');
});

test("keeps a genuinely unavailable terminal font as current custom", () => {
  const selectedValue = terminalNormalizer(withFontFallback("Unavailable Mono", "monospace"));
  const options = mergeFontFamilyOptions(
    selectedValue,
    [],
    [{ family: "Maple Mono" }],
    "monospace",
    terminalNormalizer
  );

  assert.equal(options[0]?.label, "当前自定义（保留）");
});
