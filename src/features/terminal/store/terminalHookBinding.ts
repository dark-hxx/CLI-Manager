export type HookBindingSource = "claude" | "codex" | "kimi" | "pi" | "grok" | "opencode";

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
  if (/\bkimi(?:\.(?:cmd|exe|ps1))?\b/.test(lower)) return "kimi";
  if (/\bgrok\b/.test(lower)) return "grok";
  if (/\bopencode\b/.test(lower)) return "opencode";
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

  // 来源未知的普通 Shell Tab（用户手敲 CLI 命令）也可能是 Hook 的归属：CLI 经常驻守护进程
  // （如 Codex app-server）执行 Hook 时拿不到 CLI_MANAGER_TAB_ID，只能靠兜底匹配找回。
  const sourceCandidates = input.candidates.filter((candidate) => (
    (candidate.source === source || candidate.source === null)
    && environmentMatches(candidate)
  ));
  const boundOwner = input.sessionId?.trim()
    ? sourceCandidates.find((candidate) => candidate.cliSessionId === input.sessionId?.trim())
    : undefined;
  if (boundOwner) return { tabId: boundOwner.id, reason: "bound-session" };

  const pathCandidates = sourceCandidates.filter((candidate) => (
    pathMatches(input.cwd!, candidate.paths, input.wslDistroName)
  ));
  if (pathCandidates.length === 0) return { tabId: null, reason: "not-found" };

  // 刚有输出的 Tab 才是正在启动 CLI 的那个；先于「唯一同来源」判断，
  // 避免同路径下早已跑完 CLI 的旧 Tab 抢走新会话。
  const recent = pathCandidates.filter((candidate) => (
    typeof candidate.outputActivityAt === "number"
    && input.receivedAt - candidate.outputActivityAt >= 0
    && input.receivedAt - candidate.outputActivityAt <= RECENT_OUTPUT_WINDOW_MS
  ));
  if (recent.length === 1) return { tabId: recent[0].id, reason: "recent-output" };

  // 没有活动证据时只信任来源明确匹配的 Tab，来源未知的 Shell 不靠路径单独认领，
  // 防止 IDE 等外部 CLI 会话被吸附到同目录下的普通终端。
  const sourcePathCandidates = pathCandidates.filter((candidate) => candidate.source === source);
  if (sourcePathCandidates.length === 1) {
    return { tabId: sourcePathCandidates[0].id, reason: "unique-path" };
  }
  if (sourcePathCandidates.length === 0 && recent.length === 0) return { tabId: null, reason: "not-found" };
  return { tabId: null, reason: "ambiguous" };
}
