interface CliArgToken {
  raw: string;
  normalized: string;
}

function tokenizeCliArgs(cliArgs: string): CliArgToken[] {
  const tokens: CliArgToken[] = [];
  let index = 0;

  while (index < cliArgs.length) {
    while (index < cliArgs.length && /\s/.test(cliArgs[index])) index += 1;
    if (index >= cliArgs.length) break;

    const start = index;
    let quote: "\"" | "'" | null = null;
    while (index < cliArgs.length) {
      const char = cliArgs[index];
      if (quote) {
        if (char === "\\" && index + 1 < cliArgs.length) {
          index += 2;
          continue;
        }
        if (char === quote) quote = null;
        index += 1;
        continue;
      }
      if (char === "\"" || char === "'") {
        quote = char;
        index += 1;
        continue;
      }
      if (/\s/.test(char)) break;
      index += 1;
    }

    const raw = cliArgs.slice(start, index);
    tokens.push({ raw, normalized: raw.toLowerCase() });
  }

  return tokens;
}

function isOptionToken(token: CliArgToken | undefined): boolean {
  return Boolean(token?.raw.startsWith("-"));
}

const CODEX_RESUME_SELECTION_OPTIONS = new Set([
  "--all",
  "--include-non-interactive",
  "--last",
  "--no-alt-screen",
]);

const CODEX_RESUME_VALUE_OPTIONS = new Set([
  "-a",
  "--add-dir",
  "--ask-for-approval",
  "-c",
  "--cd",
  "--config",
  "--disable",
  "--enable",
  "-i",
  "--image",
  "--local-provider",
  "-m",
  "--model",
  "-p",
  "--profile",
  "--remote",
  "--remote-auth-token-env",
  "-s",
  "--sandbox",
]);

function optionName(token: CliArgToken): string {
  const equalsIndex = token.normalized.indexOf("=");
  return equalsIndex < 0
    ? token.normalized
    : token.normalized.slice(0, equalsIndex);
}

function takesSeparateOptionValue(token: CliArgToken): boolean {
  if (token.raw.includes("=")) return false;
  if (
    token.raw.startsWith("-") &&
    !token.raw.startsWith("--") &&
    token.raw.length > 2
  ) {
    return false;
  }
  return CODEX_RESUME_VALUE_OPTIONS.has(optionName(token));
}

function stripCodexResumeTail(tokens: CliArgToken[], start: number): string[] {
  const kept: string[] = [];

  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.raw === "--") {
      continue;
    }

    const name = optionName(token);
    if (CODEX_RESUME_SELECTION_OPTIONS.has(name)) {
      continue;
    }
    if (!isOptionToken(token)) {
      // Positional arguments after resume are the old Session ID and prompt.
      continue;
    }

    kept.push(token.raw);
    if (takesSeparateOptionValue(token) && tokens[index + 1]) {
      index += 1;
      kept.push(tokens[index].raw);
    }
  }

  return kept;
}

/**
 * Remove session-selection fragments from project CLI arguments before a
 * fresh resume command is constructed. Saved-session projects intentionally
 * persist these fragments in cli_args, while history/workspace/remote resume
 * flows already provide their own target session id.
 */
export function stripResumeCliArgs(cliArgs: string | null | undefined): string {
  const tokens = tokenizeCliArgs(cliArgs ?? "");
  const kept: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token.normalized === "--continue" || token.normalized.startsWith("--continue=")) {
      continue;
    }

    if (token.normalized === "--resume") {
      if (!isOptionToken(tokens[index + 1])) index += 1;
      continue;
    }
    if (token.normalized.startsWith("--resume=")) {
      continue;
    }

    if (token.normalized === "resume") {
      kept.push(...stripCodexResumeTail(tokens, index + 1));
      break;
    }

    kept.push(token.raw);
  }

  return kept.join(" ").trim();
}
