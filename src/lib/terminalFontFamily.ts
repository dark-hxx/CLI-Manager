const DEFAULT_MONOSPACE_STACK = ["\"Cascadia Code\"", "Consolas", "monospace"] as const;
const MONOSPACE_FAMILY_TOKENS = [
  "cascadia code",
  "consolas",
  "jetbrains mono",
  "fira code",
  "courier new",
  "monospace",
] as const;

const normalizeFamilyToken = (token: string) => token.trim().replace(/^['"]|['"]$/g, "");

const isMonospaceToken = (token: string) => {
  const normalized = normalizeFamilyToken(token).toLowerCase();
  return MONOSPACE_FAMILY_TOKENS.some((item) => normalized === item);
};

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
    .map((token) => token.trim())
    .filter(Boolean);

  if (tokens.length === 0) {
    return DEFAULT_MONOSPACE_STACK.join(", ");
  }

  if (isMonospaceToken(tokens[0])) {
    return dedupeTokens([...tokens, "monospace"]).join(", ");
  }

  const monospaceTokens = tokens.filter(isMonospaceToken);
  const nonMonospaceTokens = tokens.filter((token) => !isMonospaceToken(token));
  const safeMonospaceTokens = monospaceTokens.length > 0
    ? monospaceTokens
    : [...DEFAULT_MONOSPACE_STACK];

  return dedupeTokens([...safeMonospaceTokens, ...nonMonospaceTokens, "monospace"]).join(", ");
}
