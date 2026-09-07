import assert from "node:assert/strict";
import test from "node:test";
import { dependencyViolations } from "./architecture/core.mjs";
import { maskRustNonCode, rustFacadeRoutes, rustReferences } from "./architecture/rust.mjs";

test("Rust dependencies include grouped uses, direct paths and self imports", () => {
  assert.deepEqual(rustReferences("use crate::{commands::{history, ssh}, provider::{self, models::A}}; crate::app::run();"), [
    "crate::commands::history", "crate::commands::ssh", "crate::provider", "crate::provider::models::A", "crate::app::run",
  ]);
});

test("embedded scripts, raw strings, chars and nested comments do not invent crate paths", () => {
  const source = String.raw`// crate::features::fake
    /* nested /* crate::app::bad */ crate::app::bad */
    let a = r###"crate::features::fake \""###;
    let b = "crate::app::bad \\\"";
    let c = '\\'; let d = '\u{1F600}';
    fn real<'a>(v: &'a str) { crate::shared::check(v); }`;
  assert.deepEqual(rustReferences(source), ["crate::shared::check"]);
  assert.match(maskRustNonCode(source), /real<'a>/);
});

test("namespace-preserving registry routes still enforce physical layers", () => {
  const routes = rustFacadeRoutes("src-tauri/src/commands/mod.rs", '#[path = "../features/history/mod.rs"]\npub mod history;');
  assert.deepEqual(routes, [{ prefix: "crate::commands::history", target: "src-tauri/src/features/history/mod.rs" }]);
  assert.equal(dependencyViolations("src-tauri/src/shared/example.rs", ["crate::commands::history::load"], routes).length, 1);
  assert.deepEqual(dependencyViolations("src-tauri/src/features/files/example.rs", ["crate::commands::history::load"], routes), []);
  const appRoutes = rustFacadeRoutes("src-tauri/src/lib.rs", "mod app;");
  assert.equal(dependencyViolations("src-tauri/src/features/files/example.rs", ["crate::app::run"], appRoutes).length, 1);
});
