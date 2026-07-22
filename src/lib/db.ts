import { invoke } from "@tauri-apps/api/core";
import Database from "@tauri-apps/plugin-sql";
import { getCliManagerDataPaths } from "./appPaths";

let db: Database | null = null;
let dbLoadPromise: Promise<Database> | null = null;
let migrationRepairPromise: Promise<void> | null = null;
let pragmaApplied = false;

async function repairKnownMigrationDrift(): Promise<void> {
  if (!migrationRepairPromise) {
    migrationRepairPromise = invoke("db_repair_known_migration_drift")
      .then(() => undefined)
      .catch((err) => {
        migrationRepairPromise = null;
        throw err;
      });
  }
  await migrationRepairPromise;
}

async function loadDb(): Promise<Database> {
  const paths = await getCliManagerDataPaths();
  await repairKnownMigrationDrift();
  return Database.load(paths.dbUrl);
}

export async function getDb(): Promise<Database> {
  if (!db) {
    if (!dbLoadPromise) {
      dbLoadPromise = loadDb()
        .then((loaded) => {
          db = loaded;
          return loaded;
        })
        .finally(() => {
          dbLoadPromise = null;
        });
    }
    db = await dbLoadPromise;
  }
  // SQLite 默认是 DELETE journal + synchronous=FULL，每次写入都 fsync，对批量更新极不友好。
  // 切到 WAL + NORMAL，可显著降低同步、批量重排等场景的 fsync 频率。
  // PRAGMA 必须在事务外执行，因此放在 load 之后、首次访问时一次性应用。
  if (!pragmaApplied) {
    pragmaApplied = true;
    try {
      await db.execute("PRAGMA journal_mode=WAL");
      await db.execute("PRAGMA synchronous=NORMAL");
    } catch {
      // PRAGMA 失败不应阻塞应用启动
      pragmaApplied = false;
    }
  }
  return db;
}

/** SQLite 默认参数上限 32766，预留余量。 */
const MAX_PARAMS_PER_STMT = 30000;

export interface DatabaseStatement {
  sql: string;
  values: unknown[];
}

/**
 * 把 `UPDATE table SET sort_order = ? WHERE id = ?` 的 N 次循环合并成单条
 * `UPDATE table SET sort_order = CASE id WHEN ? THEN ? ... END WHERE id IN (...)`。
 *
 * 调用方需保证 `table` 是受信任的标识符（白名单）。
 */
export async function batchUpdateSortOrder(
  db: Database,
  table: "projects" | "groups",
  updates: Array<readonly [id: string, order: number]>,
): Promise<void> {
  if (updates.length === 0) return;
  // sort_order 是整数，可直接内嵌；id 仍走参数化避免 injection。
  const cases: string[] = [];
  const idParams: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  for (const [id, order] of updates) {
    const safeOrder = Math.trunc(order);
    cases.push(`WHEN $${idx} THEN ${safeOrder}`);
    idParams.push(`$${idx}`);
    values.push(id);
    idx++;
  }
  const sql = `UPDATE ${table} SET sort_order = CASE id ${cases.join(" ")} END WHERE id IN (${idParams.join(",")})`;
  await db.execute(sql, values);
}

/**
 * 把 N 次 `UPDATE projects SET shell = ? WHERE id = ?` 合并成单条
 * `UPDATE projects SET shell = $1, updated_at = $2 WHERE id IN (...)`，按参数上限分批。
 */
export async function batchUpdateProjectShell(
  db: Database,
  ids: readonly string[],
  shell: string,
  updatedAt: string,
): Promise<void> {
  if (ids.length === 0) return;
  const batchSize = MAX_PARAMS_PER_STMT - 2;
  for (let i = 0; i < ids.length; i += batchSize) {
    const chunk = ids.slice(i, i + batchSize);
    const idParams = chunk.map((_, n) => `$${n + 3}`);
    const sql = `UPDATE projects SET shell = $1, updated_at = $2 WHERE id IN (${idParams.join(",")})`;
    await db.execute(sql, [shell, updatedAt, ...chunk]);
  }
}

/**
 * 把 N 次 `INSERT INTO ... VALUES (...)` 合并成单条多值 INSERT，按参数上限分批。
 * `table` 与 `columns` 是受信任的常量（不接受用户输入）。
 */
export async function batchInsert<T>(
  db: Database,
  table: string,
  columns: readonly string[],
  rows: readonly T[],
  mapRow: (row: T) => readonly unknown[],
): Promise<void> {
  for (const statement of buildBatchInsertStatements(table, columns, rows, mapRow)) {
    await db.execute(statement.sql, statement.values);
  }
}

export function buildBatchInsertStatements<T>(
  table: string,
  columns: readonly string[],
  rows: readonly T[],
  mapRow: (row: T) => readonly unknown[],
): DatabaseStatement[] {
  if (rows.length === 0) return [];
  const colCount = columns.length;
  const batchSize = Math.max(1, Math.floor(MAX_PARAMS_PER_STMT / colCount));
  const colList = columns.join(",");
  const statements: DatabaseStatement[] = [];
  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    const valuesClause: string[] = [];
    const values: unknown[] = [];
    let paramIdx = 1;
    for (const row of chunk) {
      const placeholders: string[] = [];
      const mapped = mapRow(row);
      if (mapped.length !== colCount) {
        throw new Error(`batchInsert: mapRow returned ${mapped.length} values, expected ${colCount}`);
      }
      for (let c = 0; c < colCount; c++) {
        placeholders.push(`$${paramIdx++}`);
        values.push(mapped[c]);
      }
      valuesClause.push(`(${placeholders.join(",")})`);
    }
    statements.push({
      sql: `INSERT INTO ${table} (${colList}) VALUES ${valuesClause.join(",")}`,
      values,
    });
  }
  return statements;
}
