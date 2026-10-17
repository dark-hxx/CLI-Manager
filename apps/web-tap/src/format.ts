/** Display names for the CLI a project is configured to launch. */
export function agentName(source: string | null | undefined): string {
  if (source === "claude") return "Claude Code";
  if (source === "codex") return "Codex";
  return "CLI";
}

/** Short lowercase CLI label used in mono subtitles, e.g. `project · claude`. */
export function agentKey(source: string | null | undefined): string {
  return source === "claude" || source === "codex" ? source : "cli";
}

const pad = (value: number) => String(value).padStart(2, "0");

/** 24-hour clock; earlier days add the date so footers stay unambiguous. */
export function clock(at: string | number | null | undefined, now = new Date()): string {
  if (at === null || at === undefined || at === "") return "";
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return date.toDateString() === now.toDateString() ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}

/** 提示用的完整日期時間（24 小時制），例如 2026-10-16 09:05:07。 */
export function fullTime(at: string | number | null | undefined): string {
  if (at === null || at === undefined || at === "") return "";
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 精簡的用時：0.5s、41s、2m 17s、1h 5m；不到一秒時保留一位小數。 */
export function duration(milliseconds: number): string {
  if (milliseconds < 1000) return `${Math.max(0, Math.round(milliseconds / 100) / 10)}s`;
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Split a repository-relative path into its directory and file name. */
export function splitPath(path: string): { dir: string; name: string } {
  const index = path.replace(/\/+$/, "").lastIndexOf("/");
  return index < 0 ? { dir: "", name: path } : { dir: path.slice(0, index), name: path.slice(index + 1) };
}

/** Large counts stay short in chips: 1234 → 1.2k. */
export function count(value: number): string {
  return value >= 10_000 ? `${Math.round(value / 1000)}k` : value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

const RULE = /^[\s─━═┄┅┈┉╌╍╭╮╰╯┌┐└┘├┤┬┴┼│┃╴╶╵╷▔▁_\-=+|]+$/;
const BORDER_TAIL = /\s{2,}[│┃]\s*$/;

/**
 * Prepare desktop-width TUI lines for the narrow reading view: drawn rules are clipped instead of wrapping
 * into several broken lines, and padded right-hand box borders are trimmed.
 */
export function readerLines(lines: string[]): { text: string; rule: boolean }[] {
  return lines.map((line) => {
    const rule = line.trim().length > 3 && RULE.test(line);
    return { text: rule ? line.trimEnd() : line.replace(BORDER_TAIL, "").trimEnd(), rule };
  });
}
