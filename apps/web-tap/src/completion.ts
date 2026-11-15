export type CompletionToken = { kind: "command" | "file"; start: number; end: number; query: string };
export type CompletionItem = { id: string; label: string; value: string; kind: "file" | "directory" | "skill"; description?: string };
export const COMPLETION_LIMIT = 80;
export const DRAFT_LIMIT = 16_000;

/** Raw native menu input: no whitespace, controls, arguments, paste wrapper or submission key. */
export function nativeCommandPrefix(text: string): boolean {
  return text.length <= 128 && /^\/[a-z\d:_-]*$/i.test(text);
}

/** Only a collapsed caret at a command/mention boundary opens completion. Never rewrite the whole draft. */
export function completionToken(text: string, start: number, end = start): CompletionToken | null {
  if (start !== end || start < 0 || start > text.length) return null;
  const before = text.slice(0, start);
  const command = /^[ \t]*(\/[a-z\d:_-]*)$/i.exec(before);
  if (command) {
    const from = before.indexOf("/");
    const rest = /^[a-z\d:_-]*/i.exec(text.slice(start))![0];
    // A second slash/dot is a path, not a command menu.
    if (/^[/.\\]/.test(text.slice(start + rest.length))) return null;
    return { kind: "command", start: from, end: start + rest.length, query: command[1]! };
  }
  const at = before.lastIndexOf("@");
  if (at < 0 || (at > 0 && !/\s/.test(before[at - 1]!))) return null;
  const raw = before.slice(at + 1);
  if (/[\x00-\x1f\x7f]/.test(raw)) return null;
  if (raw.startsWith('"')) {
    if (!/^"(?:[^"\\\r\n]|\\["\\])*$/.test(raw)) return null;
    const whole = /^@"(?:[^"\\\r\n]|\\["\\])*"?/.exec(text.slice(at))![0];
    return { kind: "file", start: at, end: at + whole.length, query: JSON.parse(`${raw}"`) as string };
  }
  if (/[\s@"'`]/.test(raw)) return null;
  const whole = /^@[^\s@"'`]*/.exec(text.slice(at))![0];
  return { kind: "file", start: at, end: at + whole.length, query: raw };
}

/** Browser requests remain relative to host-resolved registered project/worktree IDs. */
export function fileRequest(query: string): { kind: "file.list" | "file.search"; value: string } | null {
  if (query.length > 512 || /[\x00-\x1f\x7f\\:]/.test(query) || query.startsWith("/")) return null;
  const segments = query.replace(/\/$/, "").split("/");
  if (segments.some((part) => part === "." || part === ".." || part === ".git")) return null;
  return !query || query.endsWith("/")
    ? { kind: "file.list", value: query.replace(/\/$/, "") } : { kind: "file.search", value: query };
}

export function fileItems(result: unknown): { items: CompletionItem[]; limited: boolean } {
  if (!Array.isArray(result)) throw new Error("invalid_file_result");
  const unique = new Map<string, CompletionItem>();
  for (const entry of result) {
    if (!entry || typeof entry !== "object" || typeof entry.path !== "string" || typeof entry.name !== "string"
      || !["file", "directory"].includes(entry.kind) || !entry.path || entry.path.length > 4096
      || /[\x00-\x1f\x7f\\:]/.test(entry.path) || entry.path.startsWith("/")
      || entry.path.split("/").some((part: string) => !part || [".", "..", ".git"].includes(part))) continue;
    unique.set(entry.path, { id: entry.path, label: entry.path, value: entry.path, kind: entry.kind });
  }
  const items = [...unique.values()].sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory")
    || a.label.localeCompare(b.label));
  return { items: items.slice(0, COMPLETION_LIMIT), limited: items.length > COMPLETION_LIMIT };
}

export function fileReference(path: string, directory = false): string {
  const value = path + (directory && !path.endsWith("/") ? "/" : "");
  const quoted = /[\s"'`]/.test(value) ? JSON.stringify(value) : value;
  // Keep the quote open while descending through a folder with spaces.
  return `@${directory && quoted.startsWith('"') ? quoted.slice(0, -1) : quoted}`;
}

/** The host owns discovery/policy. Only available Skills become invocations, never CLI built-ins. */
export function skillItems(result: unknown, source: string, query: string): { items: CompletionItem[]; limited: boolean } {
  if (!result || typeof result !== "object" || !("available" in result) || result.available !== true
    || !("source" in result) || result.source !== source || !("skills" in result) || !Array.isArray(result.skills))
    throw new Error("invalid_skill_result");
  const unique = new Map<string, CompletionItem>();
  for (const entry of result.skills) {
    if (!entry || typeof entry !== "object" || entry.state !== "available" || typeof entry.name !== "string"
      || entry.name.length > 128 || !/^[a-z\d][a-z\d:_-]*$/i.test(entry.name)) continue;
    if (!entry.name.toLowerCase().includes(query.replace(/^\//, "").toLowerCase())) continue;
    unique.set(entry.name, { id: entry.name, label: `/${entry.name}`, kind: "skill",
      value: `${source === "codex" ? "$" : "/"}${entry.name}`,
      ...(typeof entry.description === "string" ? { description: entry.description.slice(0, 512) } : {}) });
  }
  const items = [...unique.values()].sort((a, b) => a.label.localeCompare(b.label));
  return { items: items.slice(0, COMPLETION_LIMIT), limited: items.length > COMPLETION_LIMIT };
}

export function replaceCompletion(text: string, token: CompletionToken, value: string, directory = false) {
  const suffix = text.slice(token.end);
  const separator = directory ? "" : /^\s/.test(suffix) ? "" : " ";
  const inserted = value + separator;
  const next = text.slice(0, token.start) + inserted + suffix;
  if (next.length > DRAFT_LIMIT) return null;
  return { text: next, caret: token.start + inserted.length + (!directory && /^[ \t]/.test(suffix) ? 1 : 0) };
}
