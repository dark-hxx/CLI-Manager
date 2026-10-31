import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { localBuildOptions, runLocalBuild } from "./tauri-build-local.mjs";

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
  const cargo = readFileSync(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8");
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
