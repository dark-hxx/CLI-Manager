import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const index = ".trellis/tasks/09-07-split-rust-foundation/rust-index/target/debug/architecture-rust-index.exe";
const file = "src-tauri/src/lib.rs";
const source = readFileSync(file, "utf8").replaceAll("\r\n", "\n");
const lines = source.split("\n");
const items = JSON.parse(execFileSync(index, [file], { encoding: "utf8" }))[0].items;
const first = items.find((item) => item.name === "MIGRATION_CREATE_SESSION_FAVORITE_SNAPSHOTS_VERSION");
const last = items.find((item) => item.name === "migrations");
const selected = items.filter((item) => item.start >= first.start && item.end <= last.end);
const originalBlock = lines.slice(first.start - 1, last.end).join("\n");
assert.ok(!existsSync("src-tauri/src/app/migrations.rs"));
const remaining = lines.slice(0, first.start - 1).join("\n") + "\n" + lines.slice(last.end).join("\n");
const publicNames = selected.filter((item) => item.kind === "const" && item.visibility).map((item) => item.name);
const testNames = selected.filter((item) => item.kind === "const" && !item.visibility && new RegExp(`\\b${item.name}\\b`).test(remaining)).map((item) => item.name);
const moved = originalBlock.replace(/^const /gm, "pub(crate) const ").replace(/^fn migrations\(/m, "pub(crate) fn migrations(");
// Exclude visibility-only additions when asserting the moved implementation remains identical.
assert.equal(moved.replace(/^pub\(crate\) const /gm, "const ").replace(/^pub\(crate\) fn migrations/m, "fn migrations"), originalBlock.replace(/^pub\(crate\) const /gm, "const "));
mkdirSync("src-tauri/src/app", { recursive: true });
writeFileSync("src-tauri/src/app/mod.rs", "pub(crate) mod migrations;\n");
writeFileSync("src-tauri/src/app/migrations.rs", "use crate::provider;\nuse tauri_plugin_sql::{Migration, MigrationKind};\n\n" + moved + "\n");
const exports = `mod app;\npub(crate) use app::migrations::{\n    migrations,\n${publicNames.map((name) => `    ${name},`).join("\n")}\n};\n`
  + (testNames.length ? `#[cfg(test)]\nuse app::migrations::{\n${testNames.map((name) => `    ${name},`).join("\n")}\n};\n` : "");
writeFileSync(file, remaining.replace("pub mod app_paths;", exports + "\npub mod app_paths;").replace("use tauri_plugin_sql::{Builder as SqlBuilder, Migration, MigrationKind};", "use tauri_plugin_sql::Builder as SqlBuilder;"));

const statusFile = "src-tauri/src/statusline.rs";
const status = readFileSync(statusFile, "utf8").replaceAll("\r\n", "\n");
const start = status.indexOf("type PowerlinePalette =");
const end = status.indexOf("fn styled_segment(", start);
assert.ok(start > 0 && end > start);
const themes = status.slice(start, end);
assert.ok(!existsSync("src-tauri/src/statusline/themes.rs"));
mkdirSync("src-tauri/src/statusline", { recursive: true });
writeFileSync("src-tauri/src/statusline/themes.rs", themes.replace(/^type PowerlinePalette/m, "pub(super) type PowerlinePalette").replace(/^fn powerline_theme/m, "pub(super) fn powerline_theme"));
writeFileSync(statusFile, status.slice(0, start) + status.slice(end));
const reduced = readFileSync(statusFile, "utf8");
writeFileSync(statusFile, reduced.replace("use crate::app_paths;", "mod themes;\nuse themes::powerline_theme;\n\nuse crate::app_paths;"));
console.log("Extracted migration definitions/registration and Powerline palettes; original root exports preserved.");
