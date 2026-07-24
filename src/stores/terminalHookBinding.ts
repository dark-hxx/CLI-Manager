export type HookBindingSource = "claude" | "codex" | "pi" | "grok";

export interface HookTargetCandidate {
  id: string;
  source: HookBindingSource | null;
  paths: string[];
  cliSessionId?: string;
  environmentType?: string;
  outputActivityAt?: number;
}

export interface HookTargetResolution {
  tabId: string | null;
  reason: "exact" | "legacy" | "bound-session" | "unique-path" | "recent-output" | "ambiguous" | "not-found";
}

const RECENT_OUTPUT_WINDOW_MS = 5_000;

export function inferHookBindingSource(value: string): HookBindingSource | null {
  const lower = value.toLowerCase();
  if (/\bcodex\b/.test(lower)) return "codex";
  if (/\bclaude\b/.test(lower)) return "claude";
  if (/\bgrok\b/.test(lower)) return "grok";
  if (/(?:^|\s)pi(?:\.(?:cmd|exe|ps1))?(?:\s|$)/i.test(value)) return "pi";
  return null;
}

export function normalizeHookBindingPath(path: string, wslDistroName?: string | null): string {
  const normalized = path.trim().replace(/\\/g, "/").replace(/\/+$/g, "").toLowerCase();
  if (!normalized) return "";

  const unc = normalized.match(/^\/{2}(?:wsl\.localhost|wsl\$)\/([^/]+)(\/.*)?$/);
  if (unc) return `wsl:${unc[1]}:${unc[2] || "/"}`;

  const drive = normalized.match(/^([a-z]):(?:\/(.*))?$/);
  if (drive) return `win:${drive[1]}:/${drive[2] || ""}`;

  const mountedDrive = normalized.match(/^\/mnt\/([a-z])(?:\/(.*))?$/);
  if (mountedDrive) return `win:${mountedDrive[1]}:/${mountedDrive[2] || ""}`;

  if (normalized.startsWith("/") && wslDistroName?.trim()) {
    return `wsl:${wslDistroName.trim().toLowerCase()}:${normalized}`;
  }
  return normalized;
}

function pathMatches(cwd: string, roots: string[], wslDistroName?: string | null): boolean {
  const normalizedCwd = normalizeHookBindingPath(cwd, wslDistroName);
  if (!normalizedCwd) return false;
  return roots.some((root) => {
    const normalizedRoot = normalizeHookBindingPath(root, wslDistroName);
    if (!normalizedRoot) return false;
    const boundary = normalizedRoot.endsWith("/") ? normalizedRoot : `${normalizedRoot}/`;
    return normalizedCwd === normalizedRoot || normalizedCwd.startsWith(boundary);
  });
}

export function resolveCliHookTarget(input: {
  rawTabId: string;
  primaryTabId: string;
  source?: HookBindingSource | null;
  cwd?: string | null;
  sessionId?: string | null;
  wslDistroName?: string | null;
  environmentType?: string | null;
  receivedAt: number;
  candidates: HookTargetCandidate[];
}): HookTargetResolution {
  const isSshEvent = input.environmentType === "ssh";
  const environmentMatches = (candidate: HookTargetCandidate) => (
    isSshEvent ? candidate.environmentType === "ssh" : candidate.environmentType !== "ssh"
  );
  if (input.candidates.some((candidate) => candidate.id === input.rawTabId && environmentMatches(candidate))) {
    return { tabId: input.rawTabId, reason: "exact" };
  }
  if (input.candidates.some((candidate) => candidate.id === input.primaryTabId && environmentMatches(candidate))) {
    return { tabId: input.primaryTabId, reason: "legacy" };
  }

  const source = input.source ?? null;
  if (!source || !input.cwd?.trim()) return { tabId: null, reason: "not-found" };

  const sourceCandidates = input.candidates.filter((candidate) => (
    candidate.source === source
    && environmentMatches(candidate)
  ));
  const boundOwner = input.sessionId?.trim()
    ? sourceCandidates.find((candidate) => candidate.cliSessionId === input.sessionId?.trim())
    : undefined;
  if (boundOwner) return { tabId: boundOwner.id, reason: "bound-session" };

  const pathCandidates = sourceCandidates.filter((candidate) => (
    pathMatches(input.cwd!, candidate.paths, input.wslDistroName)
  ));
  if (pathCandidates.length === 1) {
    return { tabId: pathCandidates[0].id, reason: "unique-path" };
  }
  if (pathCandidates.length === 0) return { tabId: null, reason: "not-found" };

  const recent = pathCandidates.filter((candidate) => (
    typeof candidate.outputActivityAt === "number"
    && input.receivedAt - candidate.outputActivityAt >= 0
    && input.receivedAt - candidate.outputActivityAt <= RECENT_OUTPUT_WINDOW_MS
  ));
  if (recent.length === 1) return { tabId: recent[0].id, reason: "recent-output" };
  return { tabId: null, reason: "ambiguous" };
}
