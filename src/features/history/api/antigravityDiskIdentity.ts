import type { HistorySessionSummary } from "../../../shared/types/index";

function canonical(raw: string): string {
  const value = raw.trim().replace(/\\/g, "/").replace(/^\/\/\?\/UNC\//i, "//").replace(/^\/\/\?\/(?=[A-Za-z]:\/)/, "");
  return value === "/" || /^[a-z]:\/$/i.test(value) ? value : value.replace(/\/+$/, "");
}
const wsl = (value: string) => /^\/\/(?:wsl\.localhost|wsl\$)\/([^/]+)(\/.*)?$/i.exec(canonical(value));
export const antigravityDistro = (path?: string | null) => wsl(path ?? "")?.[1]?.toLowerCase() ?? null;
const unsafe = (path: string) => /[\x00-\x1f]/.test(path) || /(?:^|\/)\.{1,2}(?:\/|$)/.test(path);

export const isAgyDiskSessionId = (id: string) => /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(id) && !/^0{8}-(?:0{4}-){3}0{12}$/.test(id);

export function antigravityDiskIdentityMatches(
  session: Pick<HistorySessionSummary, "source" | "session_id" | "file_path" | "cwd">,
  id: string, projectPath: string, distro: string, configRoot?: string | null,
): boolean {
  if (session.source !== "antigravity" || session.session_id !== id || !session.cwd
    || !isAgyDiskSessionId(id)) return false;
  const expected = distro.toLowerCase();
  const key = (raw: string): string | null => {
    const path = canonical(raw);
    if (unsafe(path)) return null;
    const unc = wsl(path);
    if (unc) return unc[1].toLowerCase() === expected ? unc[2] || "/" : null;
    if (/^[a-z]:\//i.test(path)) return expected ? `/mnt/${path[0].toLowerCase()}${path.slice(2)}` : path.toLowerCase();
    return path.startsWith("/") && !path.startsWith("//") ? path : null;
  };
  const file = canonical(session.file_path);
  if ((antigravityDistro(file) ?? "") !== expected || key(file) === null) return false;
  const suffix = `/.gemini/antigravity-cli/brain/${id}/.system_generated/logs/transcript.jsonl`;
  if (!(/^[a-z]:\//i.test(file) ? file.toLowerCase().endsWith(suffix.toLowerCase()) : file.endsWith(suffix))) return false;
  if (configRoot && ((antigravityDistro(configRoot) ?? "") !== expected || key(file.slice(0, -suffix.length) + "/.gemini/antigravity-cli") !== key(configRoot))) return false;
  const cwd = key(session.cwd);
  return cwd !== null && cwd === key(projectPath);
}

export function agyPanelNotice(boundId: string, hasMatchingDiskRecord: boolean) {
  return !boundId ? "termStats.agyUnbound" : !hasMatchingDiskRecord ? "termStats.agyWaiting" : "termStats.agyUnmeasured";
}
