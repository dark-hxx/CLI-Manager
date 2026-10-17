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

const words = (value: string) => value.split(/[-_ ]+/).filter(Boolean)
  .map((part) => /^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1));

/** Turn raw model IDs into the names CLIs show, e.g. claude-opus-4-1 → Opus 4.1, gpt-5-codex → GPT-5 Codex. */
export function modelName(model: string | null | undefined): string {
  const raw = (model ?? "").trim();
  if (!raw) return "";
  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/i.exec(raw);
  if (claude) return `${words(claude[1]!)[0]} ${claude[2]}${claude[3] ? `.${claude[3]}` : ""}${claude[4] ? " 1M" : ""}`;
  const legacy = /^claude-(\d+)(?:-(\d))?-([a-z]+)(?:-\d{8})?$/i.exec(raw);
  if (legacy) return `${words(legacy[3]!)[0]} ${legacy[1]}${legacy[2] ? `.${legacy[2]}` : ""}`;
  const gpt = /^gpt-(\d+(?:\.\d+)?)(?:-(.+))?$/i.exec(raw);
  if (gpt) return [`GPT-${gpt[1]}`, ...words(gpt[2] ?? "")].join(" ");
  return raw;
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

/** 完整的 24 小時制時間（滑過收尾列的時刻時顯示），例如 2026-10-17 18:05:09；無效時為空字串。 */
export function fullTime(at: string | number | null | undefined): string {
  if (at === null || at === undefined || at === "") return "";
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Compact elapsed time: 41s, 2m 17s, 1h 5m. */
export function duration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
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
