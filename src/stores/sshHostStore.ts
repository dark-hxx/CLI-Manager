import { create } from "zustand";
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

const SSH_HOST_GROUPS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS ssh_host_groups (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    parent_id  TEXT REFERENCES ssh_host_groups(id) ON DELETE SET NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )
`;

const SSH_HOST_GROUPS_PARENT_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_ssh_host_groups_parent
    ON ssh_host_groups(parent_id, sort_order, name)
`;

const SSH_HOSTS_GROUP_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_ssh_hosts_group_id
    ON ssh_hosts(group_id, sort_order, name)
`;

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

async function addSshHostGroupIdColumn(db: Database): Promise<void> {
  try {
    await db.execute("ALTER TABLE ssh_hosts ADD COLUMN group_id TEXT REFERENCES ssh_host_groups(id) ON DELETE SET NULL");
  } catch {
    const schema = await getSshHostSchema(db);
    if (schema.hasGroupId) return;
    await db.execute("ALTER TABLE ssh_hosts ADD COLUMN group_id TEXT");
  }
}

async function migrateLegacySshHostGroups(db: Database): Promise<void> {
  await db.execute(`
    INSERT INTO ssh_host_groups (id, name, parent_id, sort_order, created_at)
    SELECT lower(hex(randomblob(16))), h.group_name, NULL, 0, CAST(strftime('%s', 'now') AS TEXT)
    FROM ssh_hosts AS h
    WHERE trim(h.group_name) <> ''
      AND NOT EXISTS (
        SELECT 1 FROM ssh_host_groups AS g
        WHERE g.parent_id IS NULL AND g.name = h.group_name
      )
    GROUP BY h.group_name
  `);
  await db.execute(`
    UPDATE ssh_hosts
    SET group_id = (
      SELECT id FROM ssh_host_groups
      WHERE parent_id IS NULL AND name = ssh_hosts.group_name
      ORDER BY created_at, id LIMIT 1
    )
    WHERE trim(group_name) <> ''
      AND (group_id IS NULL OR trim(group_id) = '')
  `);
}

async function repairSshGroupSchema(db: Database): Promise<SshHostSchema> {
  let schema = await getSshHostSchema(db);
  if (!schema.hasGroupsTable) {
    await db.execute(SSH_HOST_GROUPS_TABLE_SQL);
  }
  await db.execute(SSH_HOST_GROUPS_PARENT_INDEX_SQL);

  schema = await getSshHostSchema(db);
  if (!schema.hasGroupId) {
    await addSshHostGroupIdColumn(db);
  }

  schema = await getSshHostSchema(db);
  if (schema.hasGroupId) {
    await db.execute(SSH_HOSTS_GROUP_INDEX_SQL);
    await migrateLegacySshHostGroups(db);
  }
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
    const schema = await ensureSshGroupSchema(db);
    await db.execute("BEGIN IMMEDIATE");
    try {
      let groupName = "";
      if (input.group_id) {
        const groups = await db.select<Array<{ name: string }>>(
          "SELECT name FROM ssh_host_groups WHERE id = $1",
          [input.group_id],
        );
        if (!groups[0]) throw new Error("ssh_group_parent_not_found");
        groupName = groups[0].name;
      }
      const existingRows = await db.select<Array<{ config_alias: string }>>(
        "SELECT config_alias FROM ssh_hosts WHERE trim(config_alias) <> ''",
      );
      const existing = new Set(existingRows.map((row) => row.config_alias.trim().toLowerCase()));
      const newAliases = aliases.filter((alias) => !existing.has(alias.toLowerCase()));
      for (const alias of newAliases) {
        const host = buildSshHost({
          name: alias,
          group_name: groupName,
          group_id: input.group_id,
          config_alias: alias,
          config_file: input.config_file,
          auth_mode: "ssh_config",
        });
        validateSshHost(host);
        await insertSshHost(db, schema, host);
      }
      await db.execute("COMMIT");
      await get().fetchHosts();
      return { imported: newAliases.length, skipped: aliases.length - newAliases.length };
    } catch (error) {
      await db.execute("ROLLBACK").catch(() => undefined);
      throw error;
    }
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
    const db = await getDb();
    const references = await db.select<Array<{ count: number }>>(
      "SELECT COUNT(*) AS count FROM projects WHERE ssh_host_id = $1",
      [id]
    );
    if ((references[0]?.count ?? 0) > 0) throw new Error("ssh_host_in_use");
    await db.execute("DELETE FROM ssh_hosts WHERE id = $1", [id]);
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
    const groups = await db.select<SshHostGroup[]>("SELECT * FROM ssh_host_groups ORDER BY sort_order, name");
    const group = groups.find((item) => item.id === id);
    if (!group) return;
    await db.execute("UPDATE ssh_host_groups SET parent_id = $1 WHERE parent_id = $2", [group.parent_id, id]);
    const parentName = group.parent_id ? groups.find((item) => item.id === group.parent_id)?.name ?? "" : "";
    await db.execute("UPDATE ssh_hosts SET group_id = $1, group_name = $2 WHERE group_id = $3", [group.parent_id, parentName, id]);
    await db.execute("DELETE FROM ssh_host_groups WHERE id = $1", [id]);
    await get().fetchHosts();
  },
}));
