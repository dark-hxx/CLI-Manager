/** Split direct CLI arguments without evaluating a shell or losing Windows path separators. */
export function parseWebConversationLaunch(command: string, source: "claude" | "codex") {
  const tokens: string[] = [];
  let token = "";
  let quote = "";
  let started = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) quote = "";
      else if (char === "\\" && command[index + 1] === quote) token += command[++index];
      else token += char;
      started = true;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) tokens.push(token);
      token = "";
      started = false;
    } else {
      if (/[;&|<>`$]/.test(char)) throw new Error("web_cli_shell_command_unsupported");
      token += char;
      started = true;
    }
  }
  if (quote) throw new Error("web_cli_unclosed_quote");
  if (started) tokens.push(token);
  const launcher = tokens.shift() ?? "";
  const basename = launcher.replace(/\\/g, "/").split("/").pop() ?? "";
  if (!new RegExp(`^${source}(?:\\.(?:exe|cmd|ps1))?$`, "i").test(basename)) {
    throw new Error("web_cli_launcher_unsupported");
  }
  let model: string | undefined;
  const launcherArgs: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const arg = tokens[index];
    if (source === "codex" && arg === "resume") {
      const selector = tokens[index + 1];
      if (selector && (selector === "--last" || selector === "--all" || !selector.startsWith("-"))) index += 1;
    } else if (source === "claude" && (arg === "--resume" || arg === "-r")) {
      if (!tokens[++index]) throw new Error("web_cli_argument_missing");
    } else if (source === "claude" && arg.startsWith("--resume=")) {
      if (!arg.slice("--resume=".length)) throw new Error("web_cli_argument_missing");
    } else if (source === "claude" && (arg === "--continue" || arg === "-c")) {
      // The structured runtime selects the authorized session itself.
    } else if (arg === "--model" || arg === "-m") {
      model = tokens[++index];
      if (!model) throw new Error("web_cli_argument_missing");
    } else if (arg.startsWith("--model=")) {
      model = arg.slice(8);
    } else if (source === "codex" && arg === "--no-alt-screen") {
      // A structured process has no alternate terminal screen.
    } else {
      launcherArgs.push(arg);
    }
  }
  return { launcher, launcherArgs, model };
}
