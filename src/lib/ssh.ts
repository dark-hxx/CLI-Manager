import type { SshHost } from "./types";

export interface SshConnectionSpecPayload {
  host: string;
  port: number;
  username: string;
  configAlias: string;
  configFile: string;
  authMode: string;
  identityFile: string;
  credentialRef: string;
  jumpTarget: string;
  proxyType: string;
  proxyHost: string;
  proxyPort: number;
  proxyCommand: string;
  connectTimeoutSec: number;
  serverAliveIntervalSec: number;
  serverAliveCountMax: number;
}

function buildJumpTarget(host: SshHost | null | undefined): string {
  if (!host) return "";
  if (host.config_alias.trim()) return host.config_alias.trim();
  const address = host.host.trim();
  if (!address) return "";
  const normalizedAddress = address.includes(":") && !address.startsWith("[") ? `[${address}]` : address;
  const userPrefix = host.username.trim() ? `${host.username.trim()}@` : "";
  const portSuffix = host.port && host.port !== 22 ? `:${host.port}` : "";
  return `${userPrefix}${normalizedAddress}${portSuffix}`;
}

export function buildSshConnectionSpec(
  host: SshHost,
  allHosts: SshHost[]
): SshConnectionSpecPayload {
  const hasDirectProxy = host.proxy_type === "http" || host.proxy_type === "socks5" || host.proxy_type === "proxy_command";
  const jumpHost = !hasDirectProxy && host.jump_mode !== "none" && host.jump_host_id
    ? allHosts.find((candidate) => candidate.id === host.jump_host_id)
    : null;
  return {
    host: host.host,
    port: host.port,
    username: host.username,
    configAlias: host.config_alias,
    configFile: host.config_file,
    authMode: host.auth_mode,
    identityFile: host.auth_mode === "identity_file" ? host.identity_file : "",
    credentialRef: host.auth_mode === "credential_ref" ? host.credential_ref : "",
    jumpTarget: buildJumpTarget(jumpHost),
    proxyType: host.proxy_type,
    proxyHost: host.proxy_host,
    proxyPort: host.proxy_port,
    proxyCommand: host.proxy_type === "proxy_command" ? host.proxy_command : "",
    connectTimeoutSec: host.connect_timeout_sec,
    serverAliveIntervalSec: host.server_alive_interval_sec,
    serverAliveCountMax: host.server_alive_count_max,
  };
}
