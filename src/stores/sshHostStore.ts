import { create } from "zustand";
import { getDb } from "../lib/db";
import type { CreateSshHostInput, SshHost, UpdateSshHostInput } from "../lib/types";

interface SshHostStore {
  hosts: SshHost[];
  loaded: boolean;
  fetchHosts: () => Promise<void>;
  createHost: (input: CreateSshHostInput) => Promise<SshHost>;
  updateHost: (id: string, input: UpdateSshHostInput) => Promise<void>;
  deleteHost: (id: string) => Promise<void>;
}

function normalizePort(value: number | undefined, fallback: number, allowZero = false): number {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isInteger(value) || value === undefined || value < minimum || value > 65535) return fallback;
  return value;
}

function buildSshHost(input: CreateSshHostInput): SshHost {
  const timestamp = Date.now().toString();
  return {
    id: crypto.randomUUID(),
    name: input.name.trim(),
    group_name: input.group_name?.trim() ?? "",
    host: input.host?.trim() ?? "",
    port: normalizePort(input.port, 22),
    username: input.username?.trim() ?? "",
    config_alias: input.config_alias?.trim() ?? "",
    auth_mode: input.auth_mode ?? "ssh_config",
    identity_file: input.identity_file?.trim() ?? "",
    credential_ref: input.credential_ref?.trim() ?? "",
    jump_mode: input.jump_mode ?? "none",
    jump_host_id: input.jump_host_id ?? null,
    proxy_type: input.proxy_type ?? "none",
    proxy_host: input.proxy_host?.trim() ?? "",
    proxy_port: normalizePort(input.proxy_port, 0, true),
    proxy_command: input.proxy_command?.trim() ?? "",
    connect_timeout_sec: Math.max(1, Math.trunc(input.connect_timeout_sec ?? 15)),
    server_alive_interval_sec: Math.max(0, Math.trunc(input.server_alive_interval_sec ?? 30)),
    server_alive_count_max: Math.max(1, Math.trunc(input.server_alive_count_max ?? 3)),
    terminal_encoding: input.terminal_encoding?.trim() || "UTF-8",
    startup_script: input.startup_script?.trim() ?? "",
    notes: input.notes?.trim() ?? "",
    sort_order: 0,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function validateSshHost(host: SshHost, currentId?: string): void {
  if (!host.name) throw new Error("ssh_host_name_required");
  if (!host.config_alias && !host.host) throw new Error("ssh_host_address_required");
  if (host.jump_host_id && host.jump_host_id === currentId) {
    throw new Error("ssh_host_jump_self_reference");
  }
  if (/\w+:\/\/[^\s/@]+:[^\s/@]+@/i.test(host.proxy_command)) {
    throw new Error("ssh_proxy_credentials_forbidden");
  }
}

export const useSshHostStore = create<SshHostStore>((set, get) => ({
  hosts: [],
  loaded: false,

  fetchHosts: async () => {
    const db = await getDb();
    const hosts = await db.select<SshHost[]>(
      "SELECT * FROM ssh_hosts ORDER BY group_name, sort_order, name"
    );
    set({ hosts, loaded: true });
  },

  createHost: async (input) => {
    const host = buildSshHost(input);
    validateSshHost(host);
    const db = await getDb();
    await db.execute(
      `INSERT INTO ssh_hosts (
         id, name, group_name, host, port, username, config_alias, auth_mode,
         identity_file, credential_ref, jump_mode, jump_host_id, proxy_type,
         proxy_host, proxy_port, proxy_command, connect_timeout_sec,
         server_alive_interval_sec, server_alive_count_max, terminal_encoding,
         startup_script, notes, sort_order, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
         $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25
       )`,
      [
        host.id, host.name, host.group_name, host.host, host.port, host.username,
        host.config_alias, host.auth_mode, host.identity_file, host.credential_ref,
        host.jump_mode, host.jump_host_id, host.proxy_type, host.proxy_host,
        host.proxy_port, host.proxy_command, host.connect_timeout_sec,
        host.server_alive_interval_sec, host.server_alive_count_max,
        host.terminal_encoding, host.startup_script, host.notes, host.sort_order,
        host.created_at, host.updated_at,
      ]
    );
    await get().fetchHosts();
    return host;
  },

  updateHost: async (id, input) => {
    const db = await getDb();
    const rows = await db.select<SshHost[]>("SELECT * FROM ssh_hosts WHERE id = $1", [id]);
    const current = rows[0];
    if (!current) throw new Error("ssh_host_not_found");
    const definedInput = Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined)
    ) as UpdateSshHostInput;
    const next = buildSshHost({ ...current, ...definedInput });
    next.id = current.id;
    next.sort_order = input.sort_order ?? current.sort_order;
    next.created_at = current.created_at;
    next.updated_at = Date.now().toString();
    validateSshHost(next, id);
    await db.execute(
      `UPDATE ssh_hosts SET
         name = $1, group_name = $2, host = $3, port = $4, username = $5,
         config_alias = $6, auth_mode = $7, identity_file = $8, credential_ref = $9,
         jump_mode = $10, jump_host_id = $11, proxy_type = $12, proxy_host = $13,
         proxy_port = $14, proxy_command = $15, connect_timeout_sec = $16,
         server_alive_interval_sec = $17, server_alive_count_max = $18,
         terminal_encoding = $19, startup_script = $20, notes = $21,
         sort_order = $22, updated_at = $23
       WHERE id = $24`,
      [
        next.name, next.group_name, next.host, next.port, next.username,
        next.config_alias, next.auth_mode, next.identity_file, next.credential_ref,
        next.jump_mode, next.jump_host_id, next.proxy_type, next.proxy_host,
        next.proxy_port, next.proxy_command, next.connect_timeout_sec,
        next.server_alive_interval_sec, next.server_alive_count_max,
        next.terminal_encoding, next.startup_script, next.notes, next.sort_order,
        next.updated_at, id,
      ]
    );
    await get().fetchHosts();
  },

  deleteHost: async (id) => {
    const db = await getDb();
    const references = await db.select<Array<{ count: number }>>(
      "SELECT COUNT(*) AS count FROM projects WHERE ssh_host_id = $1",
      [id]
    );
    if ((references[0]?.count ?? 0) > 0) throw new Error("ssh_host_in_use");
    await db.execute("DELETE FROM ssh_hosts WHERE id = $1", [id]);
    await get().fetchHosts();
  },
}));
