import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { localBuildOptions, portablePackagePlan, runLocalBuild } from "./tauri-build-local.mjs";

test("local build isolates cache and overrides costly inherited release settings", () => {
  const env = { PATH: "preserved", CARGO_INCREMENTAL: "0", CARGO_PROFILE_RELEASE_LTO: "fat" };
  const before = { ...env };
  const plan = localBuildOptions([], env);
  assert.equal(plan.options.env.PATH, "preserved");
  assert.equal(plan.options.env.CARGO_PROFILE_RELEASE_LTO, "off");
  assert.equal(plan.options.env.CARGO_PROFILE_RELEASE_OPT_LEVEL, "2");
  assert.equal(plan.options.env.CARGO_PROFILE_RELEASE_CODEGEN_UNITS, "16");
  assert.equal(plan.options.env.CARGO_PROFILE_RELEASE_INCREMENTAL, "true");
  assert.equal(plan.options.env.CARGO_INCREMENTAL, "1");
  assert.equal(plan.options.env.CARGO_TARGET_DIR, path.join(plan.options.cwd, "src-tauri/target/local"));
  assert.deepEqual(env, before);
});

test("arguments and paths with spaces survive without shell interpolation", () => {
  const args = ["--bundles", "nsis", "--config", "a path/custom.json", "--no-bundle"];
  const plan = localBuildOptions(args, { CARGO_TARGET_DIR: "cache with spaces" });
  assert.equal(plan.command, process.execPath);
  assert.deepEqual(plan.args.slice(1), ["build", "--config", "src-tauri/tauri.local.conf.json", ...args]);
  assert.equal(plan.options.shell, undefined);
  assert.equal(plan.options.env.CARGO_TARGET_DIR, path.join(plan.options.cwd, "cache with spaces/local"));
});

test("child receives plan and failures propagate", async () => {
  for (const code of [0, 7, null]) {
    const result = await runLocalBuild(["--no-bundle"], {}, (command, args, options) => {
      assert.equal(command, process.execPath);
      assert.equal(args.at(-1), "--no-bundle");
      assert.equal(options.stdio, "inherit");
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", code));
      return child;
    });
    assert.equal(result, code ?? 1);
  }
});

test("spawn errors fail the command instead of reporting success", async (t) => {
  t.mock.method(console, "error", () => {});
  const code = await runLocalBuild([], {}, () => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("error", new Error("spawn failed")));
    return child;
  });
  assert.equal(code, 1);
  assert.equal(console.error.mock.calls[0].arguments[0], "spawn failed");
});

test("local wiring preserves official release optimization and signed artifacts", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
  const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url)));
  // release profile 只在 workspace 根生效，迁移到根 Cargo.toml 后必须在此校验。
  const cargo = readFileSync(new URL("../Cargo.toml", import.meta.url), "utf8");
  assert.equal(pkg.scripts["tauri:build:local"], "node ./scripts/tauri-build-local.mjs");
  assert.equal(config.bundle.createUpdaterArtifacts, true);
  assert.match(cargo, /\[profile\.release\]\s+lto = "fat"\s+codegen-units = 1/);
});

test("Tap resources use a directory mapping that preserves nested assets and fonts", () => {
  const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url)));
  const tapResources = Object.entries(config.bundle.resources)
    .filter(([source]) => source.startsWith("../apps/web/dist/tap"));
  // Tauri flattens glob matches to file names; mapping the directory preserves its subtree.
  assert.deepEqual(tapResources, [["../apps/web/dist/tap", "apps/web/dist/tap"]]);
});

test("Windows bundle builds package a portable ZIP from the local release directory", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
  const plan = portablePackagePlan(["--bundles", "nsis"], { CARGO_TARGET_DIR: "cache with spaces" }, "win32");
  assert.equal(plan.command, "powershell.exe");
  assert.equal(plan.options.shell, undefined);
  const value = (flag) => plan.args[plan.args.indexOf(flag) + 1];
  assert.equal(value("-Version"), pkg.version);
  assert.equal(value("-SourceDir"), path.join(plan.options.cwd, "cache with spaces/local/release"));
  assert.equal(value("-OutputDir"), path.join(plan.options.cwd, "dist/portable"));
  assert.ok(value("-File").endsWith(path.join("scripts", "package-portable.ps1")));
});

test("portable packaging is skipped for --no-bundle and non-Windows hosts", () => {
  assert.equal(portablePackagePlan(["--no-bundle"], {}, "win32"), null);
  assert.equal(portablePackagePlan([], {}, "linux"), null);
  assert.equal(portablePackagePlan([], {}, "darwin"), null);
});

test("portable packaging runs only after a successful build and propagates its failure", async () => {
  for (const [buildCode, portableCode, expected, calls] of [[0, 0, 0, 2], [0, 5, 5, 2], [3, 0, 3, 1]]) {
    const commands = [];
    const result = await runLocalBuild([], {}, (command) => {
      commands.push(command);
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", commands.length === 1 ? buildCode : portableCode));
      return child;
    }, "win32");
    assert.equal(result, expected);
    assert.equal(commands.length, calls);
  }
});
