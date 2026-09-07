import { normalizeShellKey, type OsPlatform } from "../platform/shell";
import { getShellOptions, type ShellOption } from "../types/index";

export type TerminalShellProfileKind = "known" | "custom";

export interface TerminalShellProfile {
  id: string;
  label: string;
  platform: OsPlatform;
  kind: TerminalShellProfileKind;
  command: string;
  enabled: boolean;
  detected: boolean;
}

const VALID_PLATFORMS: readonly OsPlatform[] = ["windows", "macos", "linux", "unknown"];
const VALID_KINDS: readonly TerminalShellProfileKind[] = ["known", "custom"];

export function knownTerminalShellProfileId(command: string): string {
  return `known:${command.trim().toLowerCase()}`;
}

export function customTerminalShellProfileId(): string {
  const id =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `custom:${id}`;
}

function isOsPlatform(value: unknown): value is OsPlatform {
  return typeof value === "string" && VALID_PLATFORMS.includes(value as OsPlatform);
}

function isTerminalShellProfileKind(value: unknown): value is TerminalShellProfileKind {
  return typeof value === "string" && VALID_KINDS.includes(value as TerminalShellProfileKind);
}

function normalizeProfile(value: unknown): TerminalShellProfile | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const label = typeof raw.label === "string" ? raw.label.trim() : "";
  const command = typeof raw.command === "string" ? raw.command.trim() : "";
  if (!label || !command || !isOsPlatform(raw.platform) || !isTerminalShellProfileKind(raw.kind)) {
    return null;
  }
  const id =
    typeof raw.id === "string" && raw.id.trim()
      ? raw.id.trim()
      : raw.kind === "known"
      ? knownTerminalShellProfileId(command)
      : customTerminalShellProfileId();
  return {
    id,
    label,
    platform: raw.platform,
    kind: raw.kind,
    command,
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
    detected: typeof raw.detected === "boolean" ? raw.detected : raw.kind === "custom",
  };
}

export function migrateTerminalShellProfiles(value: unknown): TerminalShellProfile[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const profiles: TerminalShellProfile[] = [];
  for (const item of value) {
    const profile = normalizeProfile(item);
    if (!profile || seen.has(profile.id)) continue;
    seen.add(profile.id);
    profiles.push(profile);
  }
  return profiles;
}

export function mergeTerminalShellProfiles(
  current: readonly TerminalShellProfile[],
  scanned: readonly TerminalShellProfile[],
  platform: OsPlatform,
): TerminalShellProfile[] {
  const normalizedCurrent = migrateTerminalShellProfiles(current);
  const normalizedScanned = migrateTerminalShellProfiles(scanned).filter((profile) => profile.platform === platform);
  const byId = new Map<string, TerminalShellProfile>();

  for (const profile of normalizedCurrent) {
    byId.set(profile.id, {
      ...profile,
      detected: profile.platform === platform && profile.kind === "known" ? false : profile.detected,
    });
  }

  for (const profile of normalizedScanned) {
    const existing = byId.get(profile.id);
    byId.set(profile.id, {
      ...profile,
      enabled: existing?.enabled ?? true,
      detected: true,
    });
  }

  return Array.from(byId.values()).sort((a, b) => {
    if (a.platform !== b.platform) return a.platform.localeCompare(b.platform);
    if (a.kind !== b.kind) return a.kind === "known" ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
}

export function getEnabledTerminalShellOptions(
  os: OsPlatform,
  profiles: readonly TerminalShellProfile[],
): ShellOption[] {
  const platformProfiles = migrateTerminalShellProfiles(profiles).filter((profile) => profile.platform === os);
  if (platformProfiles.length === 0) return [...getShellOptions(os)];
  return platformProfiles
    .filter((profile) => profile.enabled && (profile.detected || profile.kind === "custom"))
    .map((profile) => ({ value: profile.command, label: profile.label }));
}

/**
 * 在启用的 Shell 选项中解析“默认 Shell”设置对应的选项值：
 * 先按 command 精确匹配，再按归一化 ShellKey 匹配，最后回退到第一个可用选项。
 */
export function resolvePreferredShellOption(
  os: OsPlatform,
  defaultShell: string,
  profiles: readonly TerminalShellProfile[],
): string {
  const enabledOptions = getEnabledTerminalShellOptions(os, profiles);
  const normalizedDefaultShell = normalizeShellKey(defaultShell);
  const preferred =
    enabledOptions.find((option) => option.value === defaultShell)?.value ??
    enabledOptions.find((option) => normalizeShellKey(option.value) === normalizedDefaultShell)?.value;
  return preferred ?? enabledOptions[0]?.value ?? "";
}

export function makeCustomTerminalShellProfile(
  platform: OsPlatform,
  label: string,
  command: string,
): TerminalShellProfile {
  const trimmedCommand = command.trim();
  const trimmedLabel = label.trim() || trimmedCommand.replace(/\\/g, "/").split("/").pop() || trimmedCommand;
  return {
    id: customTerminalShellProfileId(),
    label: trimmedLabel,
    platform,
    kind: "custom",
    command: trimmedCommand,
    enabled: true,
    detected: true,
  };
}
