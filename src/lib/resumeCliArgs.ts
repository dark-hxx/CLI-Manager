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
      if (tokens[index + 1]?.normalized === "--no-alt-screen") index += 1;
      const target = tokens[index + 1];
      if (target?.normalized === "--last" || !isOptionToken(target)) index += 1;
      continue;
    }

    kept.push(token.raw);
  }

  return kept.join(" ").trim();
}
