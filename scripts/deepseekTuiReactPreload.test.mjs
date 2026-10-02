import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const preload = fileURLToPath(new URL("../src-tauri/resources/deepseek-tui-react-preload.mjs", import.meta.url));
const packageName = "@deepseek-harness-tui/dsh-tui";
const roots = [];
process.on("exit", () => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));
function write(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
}
function react(root, owner) {
  write(join(root, "package.json"), {
    name: "react", version: "19.3.0", main: "index.cjs", exports: {
      ".": "./index.cjs", "./jsx-runtime": "./jsx-runtime.cjs",
      "./jsx-dev-runtime": "./jsx-dev-runtime.cjs", "./compiler-runtime": "./compiler-runtime.cjs",
    },
  });
  write(join(root, "index.cjs"), `module.exports={owner:${JSON.stringify(owner)},internals:{}};`);
  for (const name of ["jsx-runtime", "jsx-dev-runtime", "compiler-runtime"]) {
    write(join(root, `${name}.cjs`), "module.exports={react:require('./index.cjs')};");
  }
}
function fixture({ installedBundle = true, hostName = "@deepseek-ai/dsh", linked = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "cli-manager-dsh-react-"));
  roots.push(root);
  const host = join(root, "host");
  const home = join(root, "home");
  const profileTui = join(home, "profiles", "dsh-tui", "node_modules", ...packageName.split("/"));
  const hostTui = join(host, "node_modules", ...packageName.split("/"));
  write(join(host, "package.json"), { name: hostName, type: "module" });
  const tuiManifest = { name: packageName, version: "0.12.0", type: "module", exports: { "./package.json": "./package.json" } };
  write(join(profileTui, "package.json"), tuiManifest);
  react(join(profileTui, "node_modules", "react"), "profile");
  if (installedBundle) {
    write(join(hostTui, "package.json"), tuiManifest);
    react(join(hostTui, "node_modules", "react"), "host");
  }
  const selected = installedBundle && linked ? hostTui : profileTui;
  write(join(profileTui, "node_modules", "react-reconciler", "package.json"), { name: "react-reconciler", main: "index.cjs", peerDependencies: { react: "19.3.0" } });
  write(join(profileTui, "node_modules", "react-reconciler", "index.cjs"), "module.exports={react:require('react'),unchanged:require('unaffected')};");
  write(join(profileTui, "node_modules", "usehooks-test", "package.json"), { name: "usehooks-test", main: "index.cjs", peerDependencies: { react: "19.3.0" } });
  write(join(profileTui, "node_modules", "usehooks-test", "index.cjs"), "module.exports={react:require('react')};");
  write(join(profileTui, "node_modules", "unaffected", "package.json"), { name: "unaffected", main: "index.cjs" });
  write(join(profileTui, "node_modules", "unaffected", "index.cjs"), "module.exports='original-dependency';");
  const other = join(root, "other");
  write(join(other, "package.json"), { name: "unrelated-consumer", type: "module" });
  react(join(other, "node_modules", "react"), "unrelated");
  write(join(other, "consumer.mjs"), "import React from 'react'; export default React;");
  const plugin = join(profileTui, "lib", "types", "dsh-adapter", "plugin.js");
  write(plugin, `
    import React from "react";
    import jsx from "react/jsx-runtime";
    import jsxDev from "react/jsx-dev-runtime";
    import compiler from "react/compiler-runtime";
    import reconciler from "react-reconciler";
    import hooks from "usehooks-test";
    import other from ${JSON.stringify(pathToFileURL(join(other, "consumer.mjs")).href)};
    export default {
      sameReact: React === reconciler.react && React === hooks.react,
      sameExports: [jsx, jsxDev, compiler].every((entry) => entry.react === React),
      owner: React.owner, unrelatedOwner: other.owner, unchanged: reconciler.unchanged,
    };
  `);
  const entry = join(host, "lib", "bin.mjs");
  // Reproduce the SDK's later peer interception and its declarer anchor, without
  // modifying Node internals or the resource under test.
  write(entry, `
    import { registerHooks } from "node:module";
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier === "react" && /(?:react-reconciler|usehooks-test)/.test(context.parentURL ?? "")) {
        return { url: ${JSON.stringify(pathToFileURL(join(selected, "node_modules", "react", "index.cjs")).href)}, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    }});
    const plugin = await import(${JSON.stringify(pathToFileURL(plugin).href)});
    console.log(JSON.stringify(plugin.default));
  `);
  if (linked) {
    const target = join(root, "local-tui");
    renameSync(profileTui, target);
    symlinkSync(target, profileTui, "junction");
  }
  return { entry, home };
}
function run(fixture, { enabled = true, tab = "10000000-0000-4000-8000-000000000001", home = fixture.home, hostArgs = ["--profile", "dsh-tui"], preserveSymlinks = false } = {}) {
  const args = [...(preserveSymlinks ? ["--preserve-symlinks"] : []), ...(enabled ? ["--import", pathToFileURL(preload).href] : []), fixture.entry, ...hostArgs];
  const child = spawnSync(process.execPath, args, {
    encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "", DSH_HOME: home, CLI_MANAGER_TAB_ID: tab },
  });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout.trim());
}

test("actual DSH host's selected bundle owns the linked TUI, reconciler and external hooks React closure", () => {
  const state = fixture();
  assert.equal(run(state, { enabled: false }).sameReact, false, "fixture must reproduce duplicate React without preload");
  assert.deepEqual(run(state), {
    sameReact: true, sameExports: true, owner: "host", unrelatedOwner: "unrelated", unchanged: "original-dependency",
  });
});
test("source host without installation bundle falls back to the prepared profile React closure", () => {
  assert.deepEqual(run(fixture({ installedBundle: false })), {
    sameReact: true, sameExports: true, owner: "profile", unrelatedOwner: "unrelated", unchanged: "original-dependency",
  });
});

test("ordinary installed profile keeps its coherent React dispatcher including external hook packages", () => {
  const state = fixture({ linked: false });
  const baseline = run(state, { enabled: false });
  assert.equal(baseline.sameReact, true);
  assert.equal(baseline.owner, "profile");
  assert.deepEqual(run(state), baseline, "manager preload must not split the native renderer/hooks dispatcher");
  assert.deepEqual(run(state, { preserveSymlinks: true }), baseline);
});
test("unmanaged or malformed tab IDs leave Node resolution unchanged", () => {
  const state = fixture();
  for (const tab of ["", "not-a-UUID"]) {
    assert.equal(run(state, { tab, home: join(state.home, "missing") }).sameReact, false);
  }
});
test("other Node entry packages remain untouched even with a managed tab ID", () => {
  assert.equal(run(fixture({ hostName: "npm" }), { home: "Z:/nonexistent-dsh-home" }).sameReact, false);
  assert.equal(run(fixture({ hostName: packageName }), { home: "Z:/nonexistent-dsh-home" }).sameReact, false);
});

test("linked profile and preserve-symlinks retain one host-owned React closure", () => {
  assert.deepEqual(run(fixture({ linked: true }), { preserveSymlinks: true }), {
    sameReact: true, sameExports: true, owner: "host", unrelatedOwner: "unrelated", unchanged: "original-dependency",
  });
});
test("non-TUI profile, version and plugin host operations do not require a TUI installation", () => {
  const state = fixture();
  for (const hostArgs of [[], ["--profile", "rescue"], ["--", "--profile", "dsh-tui"], ["--version"], ["--profile", "dsh-tui", "-V"], ["plugin", "--profile", "dsh-tui"], ["--profile", "dsh-tui", "--dump-config"]]) {
    assert.equal(run(state, { hostArgs, home: join(state.home, "missing") }).sameReact, false);
  }
  assert.equal(run(state, { hostArgs: ["--profile=dsh-tui", "--patch", "--version"] }).sameReact, true, "host value literals must not disable TUI routing");
});
