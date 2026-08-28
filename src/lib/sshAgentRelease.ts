import type { SshAgentAvailableRelease } from "./types";

export function isSshAgentUpgradeAvailable(
  release: Pick<SshAgentAvailableRelease, "action"> | null | undefined,
): boolean {
  return release?.action === "upgrade";
}

export function shouldApplySshAgentReleaseResult(
  requestId: number,
  currentRequestId: number,
): boolean {
  return requestId === currentRequestId;
}

export function resolveCurrentSshAgentVersion(
  probe: { status: string; agentVersion: string } | null | undefined,
  installedVersion?: string,
): string {
  if (probe) {
    if (probe.status === "installed" || probe.status === "incompatible") {
      return probe.agentVersion.trim() || installedVersion?.trim() || "";
    }
    return "";
  }
  return installedVersion?.trim() || "";
}

function normalizeAgentVersion(value: string): string {
  return value.trim().replace(/^v/i, "");
}

export function sshAgentUpgradeNotice(
  release: SshAgentAvailableRelease | null | undefined,
  currentVersion?: string,
): { version: string; current: string } | null {
  if (!isSshAgentUpgradeAvailable(release) || !release) return null;
  const current = (currentVersion ?? release.currentVersion).trim();
  if (!current) return null;
  if (normalizeAgentVersion(current) === normalizeAgentVersion(release.version)) {
    return null;
  }
  return { version: release.version, current };
}
