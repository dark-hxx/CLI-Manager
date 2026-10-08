import { normalizeShellKey } from "../platform/shell";

/** Manager-owned source selection stored alongside existing project environment settings. */
export const DEEPSEEK_SOURCE_ENV = "CLI_MANAGER_DSH_SOURCE_ROOT";

/** Read source selection without changing an invalid environment editor document. */
export function getDeepSeekSourceRoot(envText: string | null | undefined): string {
  try {
    const env: unknown = JSON.parse(envText || "{}");
    if (!env || typeof env !== "object" || Array.isArray(env)) return "";
    const value = (env as Record<string, unknown>)[DEEPSEEK_SOURCE_ENV];
    return typeof value === "string" ? value.trim() : "";
  } catch {
    return "";
  }
}

/** Update only the source selection; malformed JSON remains an explicit form error. */
export function setDeepSeekSourceRoot(envText: string, root: string): string {
  const env: unknown = JSON.parse(envText || "{}");
  if (!env || typeof env !== "object" || Array.isArray(env)) throw new Error("deepseek_env_invalid");
  const next: Record<string, unknown> = { ...env };
  if (root.trim()) next[DEEPSEEK_SOURCE_ENV] = root.trim();
  else delete next[DEEPSEEK_SOURCE_ENV];
  return JSON.stringify(next, null, 2);
}

/** Quote one executable argument using the selected shell's literal rules. */
export function quoteDeepSeekPath(value: string, shell?: string | null): string {
  if (/[\r\n\0]/.test(value)) throw new Error("deepseek_source_invalid");
  const kind = normalizeShellKey(shell);
  if (shell?.trim() && !kind) throw new Error("deepseek_shell_unsupported");
  if (kind === "cmd") {
    if (/["%!^&|<>]/.test(value)) throw new Error("deepseek_source_invalid");
    return `"${value}"`;
  }
  if (kind === "powershell" || kind === "pwsh" || (!kind && /^[a-z]:/i.test(value))) {
    return `'${value.replace(/'/g, "''")}'`;
  }
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}
