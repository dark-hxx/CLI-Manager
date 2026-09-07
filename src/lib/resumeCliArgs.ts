interface CliArgToken {
  raw: string;
  normalized: string;
}

export type CodexLaunchSessionSelection =
  | { kind: "new" }
  | { kind: "explicit"; sessionId: string }
  | { kind: "last" }
  | { kind: "interactive" };

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

export function replaceGrokModelArg(command: string, model: string): string {
  const normalizedModel = model.trim();
  if (!/^[A-Za-z0-9._:/@+-]+$/.test(normalizedModel)) {
    throw new Error("provider_grok_model_invalid");
  }
  const tokens = tokenizeCliArgs(command);
  if (tokens.length === 0) return command.trim();
  const kept: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const name = optionName(token);
    if (name === "-m" || name === "--model") {
      if (!token.raw.includes("=") && tokens[index + 1]) index += 1;
      continue;
    }
    kept.push(token.raw);
  }

  kept.splice(1, 0, "--model", quoteCliArg(normalizedModel));
  return kept.join(" ");
}

function quoteCliArg(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
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

function unquoteCliArg(token: CliArgToken): string {
  const value = token.raw.trim();
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  return (first === "\"" && last === "\"") || (first === "'" && last === "'")
    ? value.slice(1, -1)
    : value;
}

function isCodexCommandToken(token: CliArgToken): boolean {
  const value = unquoteCliArg(token).replace(/\\/g, "/").toLowerCase();
  const executable = value.slice(value.lastIndexOf("/") + 1);
  return executable === "codex"
    || executable === "codex.exe"
    || executable === "codex.cmd"
    || executable === "codex.bat";
}

export function detectCodexLaunchSessionSelection(
  command: string | null | undefined,
): CodexLaunchSessionSelection {
  const tokens = tokenizeCliArgs(command ?? "");
  const resumeIndex = tokens.findIndex((token, index) => (
    token.normalized === "resume"
    && tokens.slice(0, index).some(isCodexCommandToken)
  ));
  if (resumeIndex < 0) return { kind: "new" };

  let selectsLast = false;

  for (let index = resumeIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.raw === "--") continue;

    const name = optionName(token);
    if (name === "--last") {
      selectsLast = true;
      continue;
    }
    if (CODEX_RESUME_SELECTION_OPTIONS.has(name)) continue;
    if (isOptionToken(token)) {
      if (takesSeparateOptionValue(token)) index += 1;
      continue;
    }

    const sessionId = unquoteCliArg(token);
    if (!sessionId || /[\s\0\r\n]/.test(sessionId) || selectsLast) {
      return { kind: "interactive" };
    }
    return { kind: "explicit", sessionId };
  }

  return selectsLast ? { kind: "last" } : { kind: "interactive" };
}

/**
 * Extract the explicit target from a `codex resume <session-id>` command.
 * Selector-only forms such as `resume --last` intentionally return null.
 */
export function extractCodexResumeSessionId(command: string | null | undefined): string | null {
  const selection = detectCodexLaunchSessionSelection(command);
  return selection.kind === "explicit" ? selection.sessionId : null;
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

const KIMI_RESUME_OPTIONS = new Set([
  "-c",
  "-C",
  "-r",
  "-S",
  "--continue",
  "--resume",
  "--session",
]);

const KIMI_RESUME_OPTIONS_WITH_VALUE = new Set([
  "-r",
  "-S",
  "--resume",
  "--session",
]);

export function isValidKimiSessionId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

export function isValidGrokSessionId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function kimiOptionName(token: CliArgToken): string {
  const equalsIndex = token.raw.indexOf("=");
  const name = equalsIndex < 0 ? token.raw : token.raw.slice(0, equalsIndex);
  return name.startsWith("--") ? name.toLowerCase() : name;
}

export function stripKimiResumeCliArgs(cliArgs: string | null | undefined): string {
  const tokens = tokenizeCliArgs(cliArgs ?? "");
  const kept: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const name = kimiOptionName(token);
    if (!KIMI_RESUME_OPTIONS.has(name)) {
      kept.push(token.raw);
      continue;
    }
    if (
      KIMI_RESUME_OPTIONS_WITH_VALUE.has(name)
      && !token.raw.includes("=")
      && tokens[index + 1]
      && !tokens[index + 1].raw.startsWith("-")
    ) {
      index += 1;
    }
  }
  return kept.join(" ").trim();
}
