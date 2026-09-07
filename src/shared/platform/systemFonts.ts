import { invoke } from "@tauri-apps/api/core";

export interface SystemFontFamily {
  family: string;
}

export interface FontFamilyOption {
  value: string;
  label: string;
}

const CSS_GENERIC_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "emoji",
  "math",
  "fangsong",
]);

export async function listSystemFonts(): Promise<SystemFontFamily[]> {
  return invoke<SystemFontFamily[]>("list_system_fonts");
}

export function toCssFontFamilyName(family: string) {
  const trimmed = family.trim();
  if (!trimmed) return "";
  if (CSS_GENERIC_FAMILIES.has(trimmed.toLowerCase())) return trimmed;
  if (/^var\(.+\)$/.test(trimmed)) return trimmed;
  if (/^".*"$|^'.*'$/.test(trimmed)) return trimmed;
  if (/^-?[a-zA-Z_][a-zA-Z0-9_-]*$/.test(trimmed)) return trimmed;
  return JSON.stringify(trimmed);
}

function splitFontFamilyStack(stack: string) {
  const tokens: string[] = [];
  let current = "";
  let quote: "\"" | "'" | null = null;
  let escaped = false;
  let parenDepth = 0;

  for (const char of stack) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      current += char;
      escaped = true;
      continue;
    }

    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }

    if (char === "\"" || char === "'") {
      quote = char;
      current += char;
      continue;
    }

    if (char === "(") {
      parenDepth += 1;
      current += char;
      continue;
    }

    if (char === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      current += char;
      continue;
    }

    if (char === "," && parenDepth === 0) {
      const token = current.trim();
      if (token) tokens.push(token);
      current = "";
      continue;
    }

    current += char;
  }

  const token = current.trim();
  if (token) tokens.push(token);
  return tokens;
}

function normalizeFontFamilyKey(fontFamily: string) {
  return splitFontFamilyStack(fontFamily)
    .map((token) => toCssFontFamilyName(token).trim().replace(/^['"]|['"]$/g, "").toLowerCase())
    .filter(Boolean)
    .join(",");
}

export function withFontFallback(family: string, fallback: string) {
  return normalizeFontFamilyStack(toCssFontFamilyName(family), fallback);
}

export function normalizeFontFamilyStack(fontFamily: string, fallback = "") {
  const seen = new Set<string>();
  const tokens = [fontFamily, fallback]
    .flatMap(splitFontFamilyStack)
    .map(toCssFontFamilyName)
    .filter(Boolean);

  return tokens
    .filter((token) => {
      const normalized = normalizeFontFamilyKey(token);
      if (!normalized || seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    })
    .join(", ");
}

export function mergeFontFamilyOptions(
  currentValue: string,
  builtinOptions: readonly FontFamilyOption[],
  systemFonts: readonly SystemFontFamily[],
  fallback: string,
  normalizeValue: (value: string) => string = normalizeFontFamilyStack,
): FontFamilyOption[] {
  const options: FontFamilyOption[] = [];
  const seen = new Set<string>();
  const normalizedCurrentValue = normalizeValue(currentValue);
  const builtinFontOptions = builtinOptions.map((option) => ({
    ...option,
    value: normalizeValue(option.value),
  }));
  const systemOptions = systemFonts
    .map((font) => font.family.trim())
    .filter(Boolean)
    .map((family) => ({ value: normalizeValue(withFontFallback(family, fallback)), label: family }));
  const availableValues = new Set(
    [...builtinFontOptions, ...systemOptions].map((option) => normalizeFontFamilyKey(option.value))
  );

  const add = (option: FontFamilyOption) => {
    const optionKey = normalizeFontFamilyKey(option.value);
    if (!option.value || seen.has(optionKey)) return;
    seen.add(optionKey);
    options.push(option);
  };

  if (normalizedCurrentValue && !availableValues.has(normalizeFontFamilyKey(normalizedCurrentValue))) {
    add({ value: normalizedCurrentValue, label: "当前自定义（保留）" });
  }

  builtinFontOptions.forEach(add);
  systemOptions.forEach(add);

  return options;
}
