import { resolveProxyAgentId } from "./cliTools";
import type { Project, ProjectEnvironmentType } from "../types/index";

export type ProxyScopeMode = "inherit" | "custom" | "direct";
export type ProxyProtocol = "http" | "https" | "socks5" | "socks5h";

export const PROXY_PROTOCOL_OPTIONS: readonly { value: ProxyProtocol; label: string }[] = [
  { value: "http", label: "HTTP" },
  { value: "https", label: "HTTPS" },
  { value: "socks5", label: "SOCKS5" },
  { value: "socks5h", label: "SOCKS5H" },
];

export interface ProxyUrlParts {
  scheme: ProxyProtocol;
  host: string;
  port: string;
  username: string;
  password: string;
}

export const DEFAULT_PROXY_URL_PARTS: ProxyUrlParts = {
  scheme: "http",
  host: "",
  port: "",
  username: "",
  password: "",
};

export interface ProxyEndpointFields {
  url: string;
  noProxy: string;
}

export interface AgentProxyRule {
  mode: ProxyScopeMode;
  url: string;
  noProxy: string;
}

export interface ProxySettings {
  globalEnabled: boolean;
  globalUrl: string;
  globalNoProxy: string;
  agents: Record<string, AgentProxyRule>;
}

export interface ProjectProxyConfig {
  mode: ProxyScopeMode;
  url: string;
  noProxy: string;
}

export type ResolvedProxyPlan =
  | { kind: "none"; source: "none" }
  | { kind: "direct"; source: "project" | "agent"; agentId?: string }
  | {
      kind: "proxy";
      source: "project" | "agent" | "global";
      agentId?: string;
      url: string;
      noProxy: string;
    };

export interface ProxyTestConnectionResult {
  ok: boolean;
  latencyMs?: number | null;
  scheme?: string | null;
  host?: string | null;
  port?: number | null;
  errorCode?: string | null;
  detail?: string | null;
}

export type ProxyUrlValidationCode =
  | "proxy_url_empty"
  | "proxy_url_invalid"
  | "proxy_scheme_unsupported"
  | "proxy_host_missing"
  | "proxy_port_invalid";

export type ProxyUrlValidationResult =
  | { ok: true; normalized: string }
  | { ok: false; code: ProxyUrlValidationCode };

export const PROXY_ENV_KEYS_UPPER = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"] as const;
export const PROXY_ENV_KEYS_LOWER = ["http_proxy", "https_proxy", "all_proxy", "no_proxy"] as const;
export const LOCAL_LOOPBACK_NO_PROXY = ["localhost", "127.0.0.1", "::1"] as const;

const ALLOWED_PROXY_PROTOCOLS = new Set(["http:", "https:", "socks5:", "socks5h:"]);
// eslint-disable-next-line no-control-regex
const CONTROL_OR_WHITESPACE_PATTERN = /[\x00-\x1f\x7f\s]/;

export const DEFAULT_PROXY_SETTINGS: ProxySettings = {
  globalEnabled: false,
  globalUrl: "",
  globalNoProxy: "",
  agents: {},
};

export const DEFAULT_PROJECT_PROXY_CONFIG: ProjectProxyConfig = {
  mode: "inherit",
  url: "",
  noProxy: "",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeProxyScopeMode(value: unknown): ProxyScopeMode {
  return value === "custom" || value === "direct" ? value : "inherit";
}

function formatNormalizedUrl(parsed: URL): string {
  const normalized = parsed.toString();
  if (parsed.pathname === "/" && !parsed.search && !parsed.hash && normalized.endsWith("/")) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

/**
 * Validate a proxy URL (`http://`, `https://`, `socks5://`, `socks5h://`).
 * Rejects empty strings, whitespace, control characters, unsupported schemes, and missing hosts.
 */
export function validateProxyUrl(raw: string): ProxyUrlValidationResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, code: "proxy_url_empty" };
  }
  if (CONTROL_OR_WHITESPACE_PATTERN.test(trimmed)) {
    return { ok: false, code: "proxy_url_invalid" };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, code: "proxy_url_invalid" };
  }

  const protocol = parsed.protocol.toLowerCase();
  if (!ALLOWED_PROXY_PROTOCOLS.has(protocol)) {
    return { ok: false, code: "proxy_scheme_unsupported" };
  }
  if (!parsed.hostname) {
    return { ok: false, code: "proxy_host_missing" };
  }
  if (parsed.port) {
    const portNum = Number(parsed.port);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      return { ok: false, code: "proxy_url_invalid" };
    }
  }

  return { ok: true, normalized: formatNormalizedUrl(parsed) };
}

function defaultPortForProtocol(scheme: ProxyProtocol): string {
  switch (scheme) {
    case "http":
      return "80";
    case "https":
      return "443";
    case "socks5":
    case "socks5h":
      return "1080";
  }
}

function safeDecodeComponent(value: string): string {
  if (!value) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeProxyProtocol(rawScheme: string): ProxyProtocol {
  const lower = rawScheme.replace(/:$/, "").toLowerCase();
  if (lower === "https" || lower === "socks5" || lower === "socks5h") {
    return lower;
  }
  return "http";
}

/**
 * Split a persisted proxy URL into structured fields (`scheme`, `host`, `port`, `username`, `password`).
 */
export function parseProxyUrlToParts(raw: string | null | undefined): ProxyUrlParts {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) {
    return { ...DEFAULT_PROXY_URL_PARTS };
  }
  try {
    const parsed = new URL(trimmed);
    const scheme = normalizeProxyProtocol(parsed.protocol);
    const rawHost = parsed.hostname.trim();
    const host =
      rawHost.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost;
    return {
      scheme,
      host,
      port: parsed.port || (host ? defaultPortForProtocol(scheme) : ""),
      username: safeDecodeComponent(parsed.username),
      password: safeDecodeComponent(parsed.password),
    };
  } catch {
    const schemeMatch = /^(https?|socks5h?):\/\//i.exec(trimmed);
    const scheme = schemeMatch ? normalizeProxyProtocol(schemeMatch[1]) : "http";
    const remainder = schemeMatch ? trimmed.slice(schemeMatch[0].length) : trimmed;
    const withoutAuth = remainder.includes("@") ? remainder.split("@").pop() ?? "" : remainder;
    const hostPortMatch = /^(\[[^\]]+\]|[^:/?#\s]+)(?::(\d+))?/.exec(withoutAuth);
    const rawHost = hostPortMatch?.[1] ?? "";
    const host =
      rawHost.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost;
    return {
      scheme,
      host,
      port: hostPortMatch?.[2] ?? "",
      username: "",
      password: "",
    };
  }
}

/**
 * Assemble and validate structured proxy fields into a canonical proxy URL string.
 */
export function buildProxyUrlFromParts(
  parts: ProxyUrlParts,
): { ok: true; url: string } | { ok: false; code: ProxyUrlValidationCode } {
  const host = parts.host.trim();
  const port = parts.port.trim();
  const username = parts.username;
  const password = parts.password;

  if (!host) {
    return { ok: false, code: "proxy_host_missing" };
  }
  if (CONTROL_OR_WHITESPACE_PATTERN.test(host) || /[/@?#\\]/.test(host)) {
    return { ok: false, code: "proxy_url_invalid" };
  }
  if (!/^\d+$/.test(port)) {
    return { ok: false, code: "proxy_port_invalid" };
  }
  const portNum = Number(port);
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    return { ok: false, code: "proxy_port_invalid" };
  }
  if (CONTROL_OR_WHITESPACE_PATTERN.test(username) || /[\x00-\x1f\x7f]/.test(password)) {
    return { ok: false, code: "proxy_url_invalid" };
  }

  const normalizedHost =
    host.includes(":") && !(host.startsWith("[") && host.endsWith("]")) ? `[${host}]` : host;
  let auth = "";
  if (username || password) {
    const encodedUser = encodeURIComponent(username);
    const encodedPass = encodeURIComponent(password);
    auth = password ? `${encodedUser}:${encodedPass}@` : `${encodedUser}@`;
  }

  const candidate = `${parts.scheme}://${auth}${normalizedHost}:${portNum}`;
  const validated = validateProxyUrl(candidate);
  if (!validated.ok) {
    return validated;
  }
  return { ok: true, url: validated.normalized };
}

/**
 * Parse a pasted full proxy URL (`http://...`, `socks5://...`) into structured fields, or return null.
 */
export function tryParsePastedProxyUrl(raw: string): ProxyUrlParts | null {
  const trimmed = raw.trim();
  if (!/^(?:https?|socks5h?):\/\//i.test(trimmed)) {
    return null;
  }
  const validated = validateProxyUrl(trimmed);
  if (!validated.ok) {
    return null;
  }
  return parseProxyUrlToParts(validated.normalized);
}

/**
 * Strip embedded `user:pass@` credentials from a proxy URL before backup export or display.
 */
export function stripProxyUrlCredentials(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed);
    if (!ALLOWED_PROXY_PROTOCOLS.has(parsed.protocol.toLowerCase()) || !parsed.hostname) {
      return trimmed.includes("@") ? "" : trimmed;
    }
    parsed.username = "";
    parsed.password = "";
    return formatNormalizedUrl(parsed);
  } catch {
    return trimmed.includes("@") ? "" : trimmed;
  }
}

export function sanitizeProxyUrlForDisplay(raw: string): string {
  return stripProxyUrlCredentials(raw);
}

/**
 * Merge user `NO_PROXY` entries with mandatory local loopback exclusions (`localhost,127.0.0.1,::1`)
 * so local hook callbacks and routing listeners are never routed through external proxies.
 */
export function mergeNoProxy(userNoProxy?: string | null): string {
  const result: string[] = [];
  const seen = new Set<string>();
  const addEntry = (item: string) => {
    const trimmed = item.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    result.push(trimmed);
  };

  for (const host of LOCAL_LOOPBACK_NO_PROXY) {
    addEntry(host);
  }
  if (typeof userNoProxy === "string" && userNoProxy.trim()) {
    for (const part of userNoProxy.split(/[,;\s]+/)) {
      addEntry(part);
    }
  }
  return result.join(",");
}

export function normalizeAgentProxyRule(raw: unknown): AgentProxyRule {
  if (!isRecord(raw)) {
    return { mode: "inherit", url: "", noProxy: "" };
  }
  return {
    mode: normalizeProxyScopeMode(raw.mode),
    url: typeof raw.url === "string" ? raw.url.trim() : "",
    noProxy: typeof raw.noProxy === "string" ? raw.noProxy.trim() : "",
  };
}

export function normalizeProxySettings(raw: unknown): ProxySettings {
  if (!isRecord(raw)) {
    return { ...DEFAULT_PROXY_SETTINGS, agents: {} };
  }
  const agents: Record<string, AgentProxyRule> = {};
  if (isRecord(raw.agents)) {
    for (const [key, value] of Object.entries(raw.agents)) {
      const normalizedKey = key.trim().toLowerCase();
      if (!normalizedKey) continue;
      const rule = normalizeAgentProxyRule(value);
      if (rule.mode !== "inherit" || rule.url || rule.noProxy) {
        agents[normalizedKey] = rule;
      }
    }
  }
  return {
    globalEnabled: raw.globalEnabled === true,
    globalUrl: typeof raw.globalUrl === "string" ? raw.globalUrl.trim() : "",
    globalNoProxy: typeof raw.globalNoProxy === "string" ? raw.globalNoProxy.trim() : "",
    agents,
  };
}

export function parseProjectProxyConfig(raw: string | null | undefined): ProjectProxyConfig {
  if (typeof raw !== "string" || !raw.trim()) {
    return { ...DEFAULT_PROJECT_PROXY_CONFIG };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return { ...DEFAULT_PROJECT_PROXY_CONFIG };
    }
    return {
      mode: normalizeProxyScopeMode(parsed.mode),
      url: typeof parsed.url === "string" ? parsed.url.trim() : "",
      noProxy: typeof parsed.noProxy === "string" ? parsed.noProxy.trim() : "",
    };
  } catch {
    return { ...DEFAULT_PROJECT_PROXY_CONFIG };
  }
}

export function serializeProjectProxyConfig(config: ProjectProxyConfig): string {
  const mode = normalizeProxyScopeMode(config.mode);
  if (mode === "inherit") return "";
  if (mode === "direct") {
    return JSON.stringify({ mode: "direct", url: "", noProxy: "" });
  }
  return JSON.stringify({
    mode: "custom",
    url: config.url.trim(),
    noProxy: config.noProxy.trim(),
  });
}

/**
 * Strip embedded proxy credentials from serialized project `proxy_config` before backup export/restore.
 */
export function sanitizeProjectProxyConfigForBackup(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) return "";
  const parsed = parseProjectProxyConfig(raw);
  if (parsed.mode === "inherit") return "";
  if (parsed.mode === "direct") return serializeProjectProxyConfig(parsed);
  const sanitizedUrl = stripProxyUrlCredentials(parsed.url);
  if (!sanitizedUrl) return "";
  return serializeProjectProxyConfig({
    mode: "custom",
    url: sanitizedUrl,
    noProxy: parsed.noProxy,
  });
}

export interface ResolveEffectiveProxyInput {
  project?: Pick<Project, "cli_tool" | "startup_cmd" | "environment_type" | "proxy_config"> | null;
  projectProxyConfig?: ProjectProxyConfig | null;
  cliTool?: string | null;
  startupCmd?: string | null;
  environmentType?: ProjectEnvironmentType | null;
  settings: ProxySettings;
}

/**
 * Resolve the effective proxy plan with priority: Project > Agent > Global.
 * SSH projects do not inherit local Agent or Global proxy settings; only explicit project-level config applies.
 */
export function resolveEffectiveProxy(input: ResolveEffectiveProxyInput): ResolvedProxyPlan {
  const projectConfig = input.projectProxyConfig ?? parseProjectProxyConfig(input.project?.proxy_config);
  const effectiveEnvironment = input.environmentType ?? input.project?.environment_type ?? "local";

  if (projectConfig.mode === "direct") {
    return { kind: "direct", source: "project" };
  }
  if (projectConfig.mode === "custom") {
    const validated = validateProxyUrl(projectConfig.url);
    if (validated.ok) {
      return {
        kind: "proxy",
        source: "project",
        url: validated.normalized,
        noProxy: mergeNoProxy(projectConfig.noProxy),
      };
    }
    return { kind: "none", source: "none" };
  }

  if (effectiveEnvironment === "ssh") {
    return { kind: "none", source: "none" };
  }

  const agentId = resolveProxyAgentId(
    input.cliTool ?? input.project?.cli_tool,
    input.startupCmd ?? input.project?.startup_cmd,
  );
  if (agentId) {
    const agentRule = input.settings.agents[agentId];
    if (agentRule) {
      if (agentRule.mode === "direct") {
        return { kind: "direct", source: "agent", agentId };
      }
      if (agentRule.mode === "custom") {
        const validated = validateProxyUrl(agentRule.url);
        if (validated.ok) {
          return {
            kind: "proxy",
            source: "agent",
            agentId,
            url: validated.normalized,
            noProxy: mergeNoProxy(agentRule.noProxy),
          };
        }
        return { kind: "none", source: "none" };
      }
    }
  }

  if (input.settings.globalEnabled) {
    const validated = validateProxyUrl(input.settings.globalUrl);
    if (validated.ok) {
      return {
        kind: "proxy",
        source: "global",
        url: validated.normalized,
        noProxy: mergeNoProxy(input.settings.globalNoProxy),
      };
    }
  }

  return { kind: "none", source: "none" };
}

/**
 * Apply resolved proxy plan to a base environment map without overwriting explicit project `env_vars`.
 * On `direct`, empty-string sentinel values signal the Rust PTY platform layer to unset inherited proxy vars.
 */
export function applyProxyToEnvVars(
  baseEnv: Record<string, string> | null | undefined,
  plan: ResolvedProxyPlan,
  options: { caseSensitivePlatform: boolean },
): Record<string, string> {
  const next: Record<string, string> = { ...(baseEnv ?? {}) };
  if (plan.kind === "none") return next;

  const existingUpperKeys = new Set(Object.keys(next).map((key) => key.toUpperCase()));
  const assignIfAbsent = (key: string, value: string) => {
    if (existingUpperKeys.has(key.toUpperCase())) return;
    next[key] = value;
  };

  if (plan.kind === "direct") {
    for (const key of PROXY_ENV_KEYS_UPPER) {
      assignIfAbsent(key, "");
    }
    if (options.caseSensitivePlatform) {
      for (const key of PROXY_ENV_KEYS_LOWER) {
        assignIfAbsent(key, "");
      }
    }
    return next;
  }

  assignIfAbsent("HTTP_PROXY", plan.url);
  assignIfAbsent("HTTPS_PROXY", plan.url);
  assignIfAbsent("ALL_PROXY", plan.url);
  assignIfAbsent("NO_PROXY", plan.noProxy);

  if (options.caseSensitivePlatform) {
    assignIfAbsent("http_proxy", plan.url);
    assignIfAbsent("https_proxy", plan.url);
    assignIfAbsent("all_proxy", plan.url);
    assignIfAbsent("no_proxy", plan.noProxy);
  }

  return next;
}

export interface ProxyCopySource {
  id: string;
  kind: "global" | "agent";
  label: string;
  command?: string;
  url: string;
  displayUrl: string;
  hasAuth: boolean;
  parts: ProxyUrlParts;
  noProxy: string;
}

export interface CollectProxyCopySourcesInput {
  settings: ProxySettings;
  agents: readonly { id: string; label: string; command?: string }[];
  globalLabel: string;
  excludeId?: string;
  globalDraft?: { parts: ProxyUrlParts; noProxy: string } | null;
  agentDrafts?: Record<string, { mode: ProxyScopeMode; parts: ProxyUrlParts; noProxy: string }>;
}

/**
 * Collect valid, non-excluded proxy configurations (Global and custom Agent rules)
 * so the user can one-click copy server/auth/`NO_PROXY` into another rule.
 */
export function collectProxyCopySources(input: CollectProxyCopySourcesInput): ProxyCopySource[] {
  const sources: ProxyCopySource[] = [];

  if (input.excludeId !== "global") {
    const rawParts = input.globalDraft?.parts ?? parseProxyUrlToParts(input.settings.globalUrl);
    const rawNoProxy = input.globalDraft?.noProxy ?? input.settings.globalNoProxy;
    const built = buildProxyUrlFromParts(rawParts);
    if (built.ok) {
      const parsed = parseProxyUrlToParts(built.url);
      sources.push({
        id: "global",
        kind: "global",
        label: input.globalLabel,
        url: built.url,
        displayUrl: sanitizeProxyUrlForDisplay(built.url),
        hasAuth: Boolean(parsed.username || parsed.password),
        parts: { ...parsed },
        noProxy: rawNoProxy.trim(),
      });
    }
  }

  for (const agent of input.agents) {
    if (agent.id === input.excludeId) continue;
    const draft = input.agentDrafts?.[agent.id];
    const mode = draft ? draft.mode : normalizeAgentProxyRule(input.settings.agents[agent.id]).mode;
    if (mode !== "custom") continue;
    const rawParts = draft
      ? draft.parts
      : parseProxyUrlToParts(normalizeAgentProxyRule(input.settings.agents[agent.id]).url);
    const rawNoProxy = draft
      ? draft.noProxy
      : normalizeAgentProxyRule(input.settings.agents[agent.id]).noProxy;
    const built = buildProxyUrlFromParts(rawParts);
    if (!built.ok) continue;
    const parsed = parseProxyUrlToParts(built.url);
    sources.push({
      id: agent.id,
      kind: "agent",
      label: agent.label,
      command: agent.command,
      url: built.url,
      displayUrl: sanitizeProxyUrlForDisplay(built.url),
      hasAuth: Boolean(parsed.username || parsed.password),
      parts: { ...parsed },
      noProxy: rawNoProxy.trim(),
    });
  }

  return sources;
}
