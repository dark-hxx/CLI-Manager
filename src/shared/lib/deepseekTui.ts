import { normalizeShellKey } from "../platform/shell";
import { quoteDeepSeekPath } from "./deepseekHarness";

interface Token { raw: string; value: string }

/** Parse literal argument boundaries without evaluating shell expressions. */
function tokens(text: string): Token[] {
  const result: Token[] = [];
  let index = 0;
  while (index < text.length) {
    while (/\s/.test(text[index] ?? "") && index < text.length) {
      if (/[\r\n]/.test(text[index])) throw new Error("deepseek_tui_args_invalid");
      index++;
    }
    if (index === text.length) break;
    const start = index;
    let quote = "";
    let value = "";
    while (index < text.length) {
      const char = text[index++];
      if (quote) {
        if (char === quote) {
          if (text[index] === quote) { value += char; index++; }
          else quote = "";
        } else value += char;
      } else if (char === '"' || char === "'") quote = char;
      else if (/[\r\n]/.test(char)) throw new Error("deepseek_tui_args_invalid");
      else if (/\s/.test(char)) break;
      else if (/[;&|<>]/.test(char)) {
        // PowerShell's leading call operator is the only shell syntax we own.
        if (char === "&" && result.length === 0 && !value && start === 0
          && /\s/.test(text[index] ?? "")) value = char;
        else throw new Error("deepseek_tui_args_invalid");
      }
      else value += char;
    }
    if (quote) throw new Error("deepseek_tui_args_invalid");
    result.push({ raw: text.slice(start, index).trimEnd(), value });
  }
  return result;
}

const ALIAS = /^(?:dsh-tui|dst)(?:\.(?:cmd|exe|ps1))?$/i;
const HOST = /^dsh(?:\.(?:cmd|exe|ps1))?$/i;
const HOST_VALUES = new Set(["--profile", "--from-default-profile", "--patch"]);
const HOST_SWITCHES = new Set(["--dump-config", "--dump-default-config", "--dump-config-schema", "-V", "--version"]);

export function isDeepSeekTuiTool(value: string | null | undefined): boolean {
  const text = value?.trim() ?? "";
  return /^(?:deepseek-harness(?:-tui)?|dsh(?:\.(?:cmd|exe|ps1))?(?:\s+web)?)$/i.test(text) || ALIAS.test(text)
    || /^dsh(?:\.(?:cmd|exe|ps1))?\s+--profile(?:=|\s+)["']?dsh-tui["']?$/i.test(text);
}

export function isValidDeepSeekTuiSessionId(value: string | null | undefined): value is string {
  return Boolean(value && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value));
}

export function isDeepSeekTuiCommand(command: string | null | undefined): boolean {
  try {
    const parts = tokens(command?.trim() ?? "");
    if (parts[0]?.value === "&") parts.shift();
    if (ALIAS.test(parts[0]?.value ?? "")) return true;
    const host = HOST.test(parts[0]?.value ?? "")
      || (/^node(?:\.exe)?$/i.test(parts[0]?.value ?? "")
        && /apps[\\/]cli[\\/]lib[\\/]bin\.js$/i.test(parts[1]?.value ?? ""));
    if (!host) return false;
    for (let i = 1; i < parts.length && parts[i].value !== "--"; i++) {
      if (parts[i].value === "--profile") return parts[i + 1]?.value === "dsh-tui";
      if (parts[i].value.startsWith("--profile=")) return parts[i].value === "--profile=dsh-tui";
    }
    return false;
  } catch { return false; }
}

/** Native launchers own their dependencies and profile; never decorate their execution. */
export function isDeepSeekTuiLauncherCommand(command: string | null | undefined): boolean {
  try {
    const parts = tokens(command?.trim() ?? "");
    if (parts[0]?.value === "&") parts.shift();
    return ALIAS.test(parts[0]?.value ?? "");
  } catch { return false; }
}

/** Resolve the source host actually selected by a saved/custom command, independent of project metadata. */
export function getDeepSeekTuiCommandSourceRoot(command: string | null | undefined): string {
  if (!isDeepSeekTuiCommand(command)) return "";
  const parts = tokens(command?.trim() ?? "");
  if (parts[0]?.value === "&") parts.shift();
  if (!/^node(?:\.exe)?$/i.test(parts[0]?.value ?? "")) return "";
  return (parts[1]?.value ?? "").replace(/[\\/]apps[\\/]cli[\\/]lib[\\/]bin\.js$/i, "");
}

/** Lift launcher resume options into a per-PTY environment value; never read resume.txt. */
function extractResume(parts: Token[], rejectImplicit: boolean): { kept: Token[]; sessionId: string | null } {
  const kept: Token[] = [];
  let sessionId: string | null = null;
  for (let i = 0; i < parts.length; i++) {
    const token = parts[i];
    if (token.value === "--") { kept.push(...parts.slice(i)); break; }
    const flag = token.value.split("=", 1)[0];
    if (HOST_VALUES.has(flag)) {
      kept.push(token);
      if (token.value === flag && parts[i + 1]) kept.push(parts[++i]);
    } else if (["--resume", "--continue", "-c"].includes(flag)) {
      let id = token.value.startsWith("--resume=") ? token.value.slice(9) : "";
      if (token.value === "--resume" && parts[i + 1] && !parts[i + 1].value.startsWith("-")) id = parts[++i].value;
      if (rejectImplicit && !isValidDeepSeekTuiSessionId(id)) throw new Error("deepseek_tui_resume_required");
      if (isValidDeepSeekTuiSessionId(id)) {
        if (rejectImplicit && sessionId && sessionId !== id) throw new Error("deepseek_tui_args_invalid");
        sessionId = id;
      }
    } else kept.push(token);
  }
  return { kept, sessionId };
}

/** Installed defaults use the TUI launcher; source debugging selects the official host directly. */
export function buildDeepSeekTuiCommand(
  tool: string, extraArgs: string, sourceRoot: string, shell?: string | null, environmentType?: string | null,
): string {
  if (!isDeepSeekTuiTool(tool)) throw new Error("deepseek_tui_args_invalid");
  if (sourceRoot && (environmentType === "ssh" || environmentType === "wsl" || normalizeShellKey(shell) === "wsl")) {
    throw new Error("deepseek_source_native_only");
  }
  const root = sourceRoot.trim().replace(/[\\/]+$/, "");
  if (root && !/^(?:[a-z]:[\\/]|\/)/i.test(root)) throw new Error("deepseek_source_invalid");
  const launcher = root ? `node ${quoteDeepSeekPath(`${root}/apps/cli/lib/bin.js`, shell)}` : "dsh-tui";
  // Former manager Web projects retain their identity, while known generated Web defaults migrate.
  const legacy = /^(?:deepseek-harness|dsh(?:\.(?:cmd|exe|ps1))?(?:\s+web)?)$/i.test(tool.trim());
  const parsed = tokens(extraArgs.trim());
  const original: Token[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const part = parsed[i];
    if (part.value === "--") { original.push(...parsed.slice(i)); break; }
    if (["--patch", "--from-default-profile", "--resume"].includes(part.value) && parsed[i + 1]) {
      original.push(part, parsed[++i]);
      continue;
    }
    if (legacy && original.length === 0 && part.value === "web") continue;
    if (legacy && part.value === "--no-open") continue;
    if (legacy && /^--port(?:=|$)/.test(part.value)) {
      const value = part.value === "--port" ? parsed[i + 1]?.value : part.value.slice(7);
      if (value === "0") { if (part.value === "--port") i++; continue; }
    }
    if (legacy && /^--profile(?:=|$)/.test(part.value)) {
      const value = part.value === "--profile" ? parsed[i + 1]?.value : part.value.slice(10);
      if (value === "web") {
        original.push({ raw: "--profile=dsh-tui", value: "--profile=dsh-tui" });
        if (part.value === "--profile") i++;
        continue;
      }
    }
    original.push(part);
  }
  extractResume(original, true);
  const host: string[] = [];
  const app: string[] = [];
  const resume: string[] = [];
  for (let i = 0; i < original.length; i++) {
    const part = original[i];
    if (part.value === "--") { app.push(...original.slice(i).map((item) => item.raw)); break; }
    const flag = part.value.split("=", 1)[0];
    if (["--port", "--no-open"].includes(flag)) throw new Error("deepseek_tui_web_args_unsupported");
    if (["--resume", "--continue", "-c"].includes(flag)) {
      resume.push(part.raw);
      if (part.value === "--resume" && original[i + 1]) resume.push(original[++i].raw);
    } else if (app.length === 0 && HOST_VALUES.has(flag)) {
      const value = part.value.includes("=") ? part.value.slice(flag.length + 1) : original[++i]?.value;
      if (!value) throw new Error("deepseek_tui_args_invalid");
      if (flag === "--profile") {
        if (value !== "dsh-tui") throw new Error("deepseek_tui_profile_required");
      } else {
        host.push(part.raw);
        if (!part.value.includes("=")) host.push(original[i].raw);
      }
    } else if (app.length === 0 && HOST_SWITCHES.has(part.value)) host.push(part.raw);
    else app.push(part.raw);
  }
  // The TUI launcher owns profile selection and inserts the host/app boundary itself.
  return [launcher, ...(root ? ["--profile dsh-tui"] : []), ...host, ...resume,
    ...(app.length ? [...(root ? ["--"] : []), ...app] : [])].join(" ");
}

export function prepareDeepSeekTuiCommand(command: string): { command: string; resumeSessionId: string | null } {
  if (!isDeepSeekTuiCommand(command)) throw new Error("deepseek_tui_args_invalid");
  const parts = tokens(command);
  for (let i = 0; i < parts.length && parts[i].value !== "--"; i++) {
    const part = parts[i];
    const flag = part.value.split("=", 1)[0];
    if (HOST_VALUES.has(flag)) {
      const value = part.value === flag ? parts[++i]?.value : part.value.slice(flag.length + 1);
      if (!value) throw new Error("deepseek_tui_args_invalid");
      if (flag === "--profile" && value !== "dsh-tui") throw new Error("deepseek_tui_profile_required");
    } else if (["--port", "--no-open"].includes(flag)) throw new Error("deepseek_tui_web_args_unsupported");
  }
  const { kept, sessionId } = extractResume(parts, true);
  return { command: kept.map((p) => p.raw).join(" "), resumeSessionId: sessionId };
}

export function buildDeepSeekTuiResumeCommand(command: string, savedId?: string | null, _shell?: string | null): string {
  if (!isDeepSeekTuiCommand(command)) throw new Error("deepseek_tui_args_invalid");
  const { kept } = extractResume(tokens(command), false);
  const barrier = kept.findIndex((part) => part.value === "--");
  const at = barrier < 0 ? kept.length : barrier;
  if (isValidDeepSeekTuiSessionId(savedId)) kept.splice(at, 0, { raw: `--resume ${savedId}`, value: `--resume=${savedId}` });
  return kept.map((part) => part.raw).join(" ");
}

/** Remove only bridge overlays in the current manager cache's reserved content-addressed directory. */
export function stripDeepSeekTuiManagerPatch(command: string, patchPath: string): string {
  if (!isDeepSeekTuiCommand(command)) return command;
  const parts = tokens(command);
  const current = patchPath.replace(/\\/g, "/");
  const currentReserved = /^(.*\/deepseek-tui\/)[0-9a-f]{64}\/bridge\.yml$/i.exec(current);
  const isOwnedPatch = (value: string) => {
    if (value === patchPath) return true;
    if (!currentReserved) return false;
    const candidate = /^(.*\/deepseek-tui\/)[0-9a-f]{64}\/bridge\.yml$/i.exec(value.replace(/\\/g, "/"));
    if (!candidate) return false;
    return /^[a-z]:/i.test(current)
      ? candidate[1].toLowerCase() === currentReserved[1].toLowerCase()
      : candidate[1] === currentReserved[1];
  };
  for (let i = 0; i < parts.length && parts[i].value !== "--"; i++) {
    const part = parts[i];
    if (part.value === "--patch") {
      if (parts[i + 1] && isOwnedPatch(parts[i + 1].value)) { parts.splice(i, 2); i--; }
      else i++;
    } else if (part.value.startsWith("--patch=") && isOwnedPatch(part.value.slice(8))) {
      parts.splice(i, 1); i--;
    } else if (HOST_VALUES.has(part.value)) i++;
  }
  return parts.map((part) => part.raw).join(" ");
}

/** Append the manager's plugin bridge after user patches, before the host/application separator. */
export function withDeepSeekTuiPatch(command: string, patchPath: string, shell?: string | null): string {
  if (!isDeepSeekTuiCommand(command)) {
    throw new Error("deepseek_tui_args_invalid");
  }
  const parts = tokens(stripDeepSeekTuiManagerPatch(command, patchPath));
  const barrier = parts.findIndex((part) => part.value === "--");
  let at = barrier < 0 ? parts.length : barrier;
  const launcherAt = parts[0]?.value === "&" ? 1 : 0;
  if (ALIAS.test(parts[launcherAt]?.value ?? "")) {
    // Upstream classifies only the leading host flags; insert before the first app token.
    at = launcherAt + 1;
    while (at < parts.length) {
      const flag = parts[at].value.split("=", 1)[0];
      if (HOST_VALUES.has(flag)) at += parts[at].value === flag ? 2 : 1;
      else if (HOST_SWITCHES.has(parts[at].value)) at++;
      else break;
    }
  }
  parts.splice(at, 0, {
    raw: `--patch ${quoteDeepSeekPath(patchPath, shell)}`, value: "--patch",
  });
  return parts.map((part) => part.raw).join(" ");
}

/** Append the preload to the actual shell environment for this execution only. */
export function withDeepSeekTuiPreload(command: string, preloadUrl: string, cmdPreloadPath: string, shell?: string | null): string {
  if (!preloadUrl.startsWith("file:") || /[\r\n\0]/.test(preloadUrl)) throw new Error("deepseek_tui_patch_failed");
  const kind = normalizeShellKey(shell);
  if (kind === "cmd") return `${quoteDeepSeekPath(cmdPreloadPath, shell)} ${command}`;
  const flag = quoteDeepSeekPath(`--import=${preloadUrl}`, shell);
  if (kind === "powershell" || kind === "pwsh") {
    return `& { $cliManagerDshHadNodeOptions = Test-Path Env:NODE_OPTIONS; $cliManagerDshNodeOptions = $env:NODE_OPTIONS; try { $env:NODE_OPTIONS = ($cliManagerDshNodeOptions + ' ' + ${flag}).Trim(); ${command} } finally { if ($cliManagerDshHadNodeOptions) { $env:NODE_OPTIONS = $cliManagerDshNodeOptions } else { $env:NODE_OPTIONS = $null } } }`;
  }
  if (kind === "fish") return `begin; set -lx NODE_OPTIONS (string join ' ' -- $NODE_OPTIONS ${flag}); ${command}; end`;
  if (["bash", "zsh", "sh", "gitbash"].includes(kind ?? "")) {
    return `( export NODE_OPTIONS="\${NODE_OPTIONS:+$NODE_OPTIONS }"${flag}; ${command} )`;
  }
  throw new Error("deepseek_shell_unsupported");
}
