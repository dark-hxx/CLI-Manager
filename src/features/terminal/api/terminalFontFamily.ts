import { toCssFontFamilyName } from "../../../shared/platform/systemFonts";

const POWERLINE_FALLBACK_STACK = [
  "\"Symbols Nerd Font Mono\"",
  "\"DejaVu Sans Mono for Powerline\"",
  "\"Droid Sans Mono for Powerline\"",
  "\"Source Code Pro for Powerline\"",
  "\"Roboto Mono for Powerline\"",
  "\"Cascadia Code PL\"",
  "\"CaskaydiaCove Nerd Font\"",
  "\"CaskaydiaCove Nerd Font Mono\"",
  "\"MesloLGS NF\"",
  "\"Meslo LG S for Powerline\"",
  "\"FiraCode Nerd Font\"",
  "\"Fira Code Nerd Font\"",
] as const;
const DEFAULT_MONOSPACE_STACK = ["\"Cascadia Code\"", "Consolas", ...POWERLINE_FALLBACK_STACK, "monospace"] as const;
const GENERIC_MONOSPACE_TOKENS = new Set(["monospace", "ui-monospace"]);

const normalizeFamilyToken = (token: string) => token.trim().replace(/^['"]|['"]$/g, "");

const isGenericMonospaceToken = (token: string) =>
  GENERIC_MONOSPACE_TOKENS.has(normalizeFamilyToken(token).toLowerCase());

const dedupeTokens = (tokens: string[]) => {
  const seen = new Set<string>();
  return tokens.filter((token) => {
    const normalized = normalizeFamilyToken(token).toLowerCase();
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
};

export function normalizeTerminalFontFamily(fontFamily: string) {
  const tokens = fontFamily
    .split(",")
    .map(toCssFontFamilyName)
    .filter(Boolean);

  if (tokens.length === 0) {
    return DEFAULT_MONOSPACE_STACK.join(", ");
  }

  const dedupedTokens = dedupeTokens(tokens);
  const genericMonospaceTokens = dedupedTokens.filter(isGenericMonospaceToken);
  const concreteTokens = dedupedTokens.filter((token) => !isGenericMonospaceToken(token));
  const orderedTokens = concreteTokens.length > 0
    ? [...concreteTokens, ...POWERLINE_FALLBACK_STACK, ...genericMonospaceTokens]
    : [...POWERLINE_FALLBACK_STACK, ...dedupedTokens];

  return dedupeTokens([...orderedTokens, "monospace"]).join(", ");
}
