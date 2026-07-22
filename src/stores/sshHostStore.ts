import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type Database from "@tauri-apps/plugin-sql";
import { getDb } from "../lib/db";
import type { CreateSshHostInput, SshHost, SshHostGroup, UpdateSshHostInput } from "../lib/types";

interface SshHostSchema {
  hasGroupId: boolean;
  hasGroupsTable: boolean;
}

interface SqliteSchemaRow {
  name: string;
}

interface SshHostStore {
  hosts: SshHost[];
  groups: SshHostGroup[];
  loaded: boolean;
  loadError: string | null;
  fetchHosts: () => Promise<void>;
  createHost: (input: CreateSshHostInput) => Promise<SshHost>;
  importConfigHosts: (input: ImportSshConfigHostsInput) => Promise<ImportSshConfigHostsResult>;
  updateHost: (id: string, input: UpdateSshHostInput) => Promise<void>;
  deleteHost: (id: string) => Promise<void>;
  createGroup: (name: string, parentId: string | null) => Promise<SshHostGroup>;
  deleteGroup: (id: string) => Promise<void>;
}

export interface ImportSshConfigHostsInput {
  aliases: string[];
  config_file: string;
  group_id: string | null;
}

export interface ImportSshConfigHostsResult {
  imported: number;
  skipped: number;
}

function normalizePort(value: number | undefined, fallback: number, allowZero = false): number {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isInteger(value) || value === undefined || value < minimum || value > 65535) return fallback;
  return value;
}

function buildSshHost(input: CreateSshHostInput): SshHost {
  const timestamp = Date.now().toString();
  const configAlias = input.config_alias?.trim() ?? "";
  const configManaged = Boolean(configAlias);
  const authMode = configManaged
    ? "ssh_config"
    : input.auth_mode === "ssh_config" || !input.auth_mode ? "credential_ref" : input.auth_mode;
  return {
    id: crypto.randomUUID(),
    name: input.name.trim(),
    group_name: input.group_name?.trim() ?? "",
    group_id: input.group_id ?? null,
    host: configManaged ? "" : input.host?.trim() ?? "",
    port: normalizePort(input.port, 22),
    username: configManaged ? "" : input.username?.trim() ?? "",
    config_alias: configAlias,
    config_file: configManaged ? input.config_file?.trim() ?? "" : "",
    auth_mode: authMode,
    identity_file: authMode === "identity_file" ? input.identity_file?.trim() ?? "" : "",
    credential_ref: authMode === "credential_ref" ? input.credential_ref?.trim() ?? "" : "",
    jump_mode: configManaged ? "none" : input.jump_mode ?? "none",
    jump_host_id: configManaged ? null : input.jump_host_id ?? null,
    proxy_type: configManaged ? "none" : input.proxy_type ?? "none",
    proxy_host: configManaged ? "" : input.proxy_host?.trim() ?? "",
    proxy_port: configManaged ? 0 : normalizePort(input.proxy_port, 0, true),
    proxy_command: !configManaged && input.proxy_type === "proxy_command" ? input.proxy_command?.trim() ?? "" : "",
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
  if (host.jump_mode !== "none" && !host.jump_host_id) {
    throw new Error("ssh_jump_host_required");
  }
  if (host.proxy_type === "proxy_command" && !host.proxy_command.trim()) {
    throw new Error("ssh_proxy_command_required");
  }
  if ((host.proxy_type === "http" || host.proxy_type === "socks5") && host.proxy_host.includes("@")) {
    throw new Error("ssh_proxy_credentials_forbidden");
  }
  if ((host.proxy_type === "http" || host.proxy_type === "socks5")
    && (!host.proxy_host.trim() || host.proxy_port < 1 || host.proxy_port > 65535)) {
    throw new Error("ssh_proxy_address_invalid");
  }
  if (host.auth_mode === "identity_file" && !host.identity_file.trim()) {
    throw new Error("ssh_identity_file_required");
  }
  if (/\w+:\/\/[^\s/@]+:[^\s/@]+@/i.test(host.proxy_command)) {
    throw new Error("ssh_proxy_credentials_forbidden");
  }
}

async function getSshHostSchema(db: Database): Promise<SshHostSchema> {
  const [columns, groupTables] = await Promise.all([
    db.select<SqliteSchemaRow[]>("PRAGMA table_info(ssh_hosts)"),
    db.select<SqliteSchemaRow[]>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ssh_host_groups'",
    ),
  ]);
  return {
    hasGroupId: columns.some((column) => column.name === "group_id"),
    hasGroupsTable: groupTables.length > 0,
  };
}

async function repairSshGroupSchema(db: Database): Promise<SshHostSchema> {
  await invoke("ssh_db_ensure_group_schema");
  return getSshHostSchema(db);
}

async function ensureSshGroupSchema(db: Database): Promise<SshHostSchema> {
  const schema = await repairSshGroupSchema(db);
  if (!schema.hasGroupsTable || !schema.hasGroupId) throw new Error("ssh_group_schema_unavailable");
  return schema;
}

async function insertSshHost(db: Database, schema: SshHostSchema, host: SshHost): Promise<void> {
  if (schema.hasGroupId) {
    await db.execute(
      `INSERT INTO ssh_hosts (
         id, name, group_name, group_id, host, port, username, config_alias, config_file, auth_mode,
         identity_file, credential_ref, jump_mode, jump_host_id, proxy_type,
         proxy_host, proxy_port, proxy_command, connect_timeout_sec,
         server_alive_interval_sec, server_alive_count_max, terminal_encoding,
         startup_script, notes, sort_order, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
         $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27
       )`,
      [
        host.id, host.name, host.group_name, host.group_id, host.host, host.port, host.username,
        host.config_alias, host.config_file, host.auth_mode, host.identity_file, host.credential_ref,
        host.jump_mode, host.jump_host_id, host.proxy_type, host.proxy_host,
        host.proxy_port, host.proxy_command, host.connect_timeout_sec,
        host.server_alive_interval_sec, host.server_alive_count_max,
        host.terminal_encoding, host.startup_script, host.notes, host.sort_order,
        host.created_at, host.updated_at,
      ],
    );
    return;
  }
  await db.execute(
    `INSERT INTO ssh_hosts (
       id, name, group_name, host, port, username, config_alias, config_file, auth_mode,
       identity_file, credential_ref, jump_mode, jump_host_id, proxy_type,
       proxy_host, proxy_port, proxy_command, connect_timeout_sec,
       server_alive_interval_sec, server_alive_count_max, terminal_encoding,
       startup_script, notes, sort_order, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
       $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26
     )`,
    [
      host.id, host.name, host.group_name, host.host, host.port, host.username,
      host.config_alias, host.config_file, host.auth_mode, host.identity_file, host.credential_ref,
      host.jump_mode, host.jump_host_id, host.proxy_type, host.proxy_host,
      host.proxy_port, host.proxy_command, host.connect_timeout_sec,
      host.server_alive_interval_sec, host.server_alive_count_max,
      host.terminal_encoding, host.startup_script, host.notes, host.sort_order,
      host.created_at, host.updated_at,
    ],
  );
}

export const useSshHostStore = create<SshHostStore>((set, get) => ({
  hosts: [],
  groups: [],
  loaded: false,
  loadError: null,

  fetchHosts: async () => {
    const db = await getDb();
    try {
      let schema = await getSshHostSchema(db);
      let loadError: string | null = null;
      try {
        schema = await repairSshGroupSchema(db);
      } catch (error) {
        loadError = error instanceof Error ? error.message : String(error);
        schema = await getSshHostSchema(db);
      }
      const hosts = await db.select<SshHost[]>("SELECT * FROM ssh_hosts ORDER BY sort_order, name");
      let groups: SshHostGroup[] = [];
      if (schema.hasGroupsTable) {
        try {
          groups = await db.select<SshHostGroup[]>("SELECT * FROM ssh_host_groups ORDER BY sort_order, name");
        } catch (error) {
          loadError = error instanceof Error ? error.message : String(error);
        }
      }
      set({
        hosts: hosts.map((host) => ({
          ...host,
          group_id: schema.hasGroupId ? host.group_id ?? null : null,
        })),
        groups,
        loaded: true,
        loadError,
      });
    } catch (error) {
      set({
        hosts: [],
        groups: [],
        loaded: true,
        loadError: error instanceof Error ? error.message : String(error),
      });
    }
  },

  createHost: async (input) => {
    const host = buildSshHost(input);
    validateSshHost(host);
    const db = await getDb();
    let schema = await getSshHostSchema(db);
    try {
      schema = await repairSshGroupSchema(db);
    } catch {
      schema = await getSshHostSchema(db);
    }
    await insertSshHost(db, schema, host);
    await get().fetchHosts();
    return host;
  },

  importConfigHosts: async (input) => {
    const aliases = Array.from(new Map(
      input.aliases
        .map((alias) => alias.trim())
        .filter(Boolean)
        .map((alias) => [alias.toLowerCase(), alias] as const),
    ).values());
    if (aliases.length === 0) return { imported: 0, skipped: 0 };

    const db = await getDb();
    await ensureSshGroupSchema(db);
    const hosts = aliases.map((alias) => {
      const host = buildSshHost({
        name: alias,
        group_id: input.group_id,
        config_alias: alias,
        config_file: input.config_file,
        auth_mode: "ssh_config",
      });
      validateSshHost(host);
      return {
        id: host.id,
        name: host.name,
        config_alias: host.config_alias,
        config_file: host.config_file,
        created_at: host.created_at,
        updated_at: host.updated_at,
      };
    });
    const result = await invoke<ImportSshConfigHostsResult>("ssh_db_import_config_hosts", {
      hosts,
      groupId: input.group_id,
    });
    await get().fetchHosts();
    return result;
  },

  updateHost: async (id, input) => {
    const db = await getDb();
    let schema = await getSshHostSchema(db);
    try {
      schema = await repairSshGroupSchema(db);
    } catch {
      schema = await getSshHostSchema(db);
    }
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
    if (schema.hasGroupId) {
      await db.execute(
        `UPDATE ssh_hosts SET
           name = $1, group_name = $2, group_id = $3, host = $4, port = $5, username = $6,
           config_alias = $7, config_file = $8, auth_mode = $9, identity_file = $10, credential_ref = $11,
           jump_mode = $12, jump_host_id = $13, proxy_type = $14, proxy_host = $15,
           proxy_port = $16, proxy_command = $17, connect_timeout_sec = $18,
           server_alive_interval_sec = $19, server_alive_count_max = $20,
           terminal_encoding = $21, startup_script = $22, notes = $23,
           sort_order = $24, updated_at = $25
         WHERE id = $26`,
        [
          next.name, next.group_name, next.group_id, next.host, next.port, next.username,
          next.config_alias, next.config_file, next.auth_mode, next.identity_file, next.credential_ref,
          next.jump_mode, next.jump_host_id, next.proxy_type, next.proxy_host,
          next.proxy_port, next.proxy_command, next.connect_timeout_sec,
          next.server_alive_interval_sec, next.server_alive_count_max,
          next.terminal_encoding, next.startup_script, next.notes, next.sort_order,
          next.updated_at, id,
        ],
      );
    } else {
      await db.execute(
        `UPDATE ssh_hosts SET
           name = $1, group_name = $2, host = $3, port = $4, username = $5,
           config_alias = $6, config_file = $7, auth_mode = $8, identity_file = $9, credential_ref = $10,
           jump_mode = $11, jump_host_id = $12, proxy_type = $13, proxy_host = $14,
           proxy_port = $15, proxy_command = $16, connect_timeout_sec = $17,
           server_alive_interval_sec = $18, server_alive_count_max = $19,
           terminal_encoding = $20, startup_script = $21, notes = $22,
           sort_order = $23, updated_at = $24
         WHERE id = $25`,
        [
          next.name, next.group_name, next.host, next.port, next.username,
          next.config_alias, next.config_file, next.auth_mode, next.identity_file, next.credential_ref,
          next.jump_mode, next.jump_host_id, next.proxy_type, next.proxy_host,
          next.proxy_port, next.proxy_command, next.connect_timeout_sec,
          next.server_alive_interval_sec, next.server_alive_count_max,
          next.terminal_encoding, next.startup_script, next.notes, next.sort_order,
          next.updated_at, id,
        ],
      );
    }
    await get().fetchHosts();
  },

  deleteHost: async (id) => {
    await invoke("ssh_db_delete_host", { id });
    await get().fetchHosts();
  },

  createGroup: async (name, parentId) => {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("ssh_group_name_required");
    const db = await getDb();
    await ensureSshGroupSchema(db);
    const existingGroups = await db.select<SshHostGroup[]>("SELECT * FROM ssh_host_groups ORDER BY sort_order, name");
    const duplicate = existingGroups.some((group) => group.parent_id === parentId && group.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase());
    if (duplicate) throw new Error("ssh_group_name_duplicate");
    if (parentId && !existingGroups.some((group) => group.id === parentId)) throw new Error("ssh_group_parent_not_found");
    const group: SshHostGroup = { id: crypto.randomUUID(), name: trimmed, parent_id: parentId, sort_order: 0, created_at: Date.now().toString() };
    await db.execute(
      "INSERT INTO ssh_host_groups (id, name, parent_id, sort_order, created_at) VALUES ($1, $2, $3, $4, $5)",
      [group.id, group.name, group.parent_id, group.sort_order, group.created_at],
    );
    await get().fetchHosts();
    return group;
  },

  deleteGroup: async (id) => {
    const db = await getDb();
    await ensureSshGroupSchema(db);
    await invoke("ssh_db_delete_group", { id });
    await get().fetchHosts();
  },
}));
