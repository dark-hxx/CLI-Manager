import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const task = ".trellis/tasks/09-07-architecture-convergence";
const root = "src-tauri/src/";
const commands = {
  agent_capabilities: "agents/commands.rs", app_data: "app-data/commands.rs", background: "terminal/background.rs",
  cc_connect: "remote/cc_connect/mod.rs", ccusage: "stats/ccusage.rs", command_suggestion: "terminal/suggestions.rs",
  db_repair: "app-data/repair/mod.rs", desktop_pet: "desktop-pet/commands.rs", fonts: "system/fonts.rs",
  fs: "files/commands.rs", git: "git/mod.rs", git_diff: "git/diff.rs", git_diff_display: "git/diff_display.rs",
  git_diff_tests: "git/diff_tests.rs", git_history: "git/history.rs", git_tools: "git/tools.rs",
  git_worktree: "projects/worktree.rs", history: "history/mod.rs", history_backup: "history/backup.rs",
  history_edit: "history/edit.rs", history_sources: "history/sources.rs", history_title: "history/title.rs",
  hook_settings: "hooks/settings/mod.rs", live_server: "files/live_server_commands.rs", logging: "system/logging.rs",
  model_pricing: "stats/model_pricing.rs", opencode_hook: "hooks/opencode.rs", project_groups: "projects/groups.rs",
  provider: "providers/commands.rs", routing: "providers/routing_commands.rs", shell: "terminal/shell_commands.rs",
  ssh: "remote/ssh/mod.rs", ssh_config: "remote/config.rs", ssh_db: "remote/database.rs",
  ssh_files: "files/ssh.rs", ssh_git: "git/ssh.rs", ssh_integration: "remote/integration.rs",
  subagent_transcript: "terminal/subagent_transcript.rs", sync: "sync/commands.rs",
  system_notification: "notifications/system.rs", system_resources: "system/resources.rs",
  terminal: "terminal/commands.rs", terminal_shell: "terminal/shell.rs",
  third_party_notification: "notifications/commands.rs", version: "system/version.rs",
};
const rootFiles = {
  app_paths: "infrastructure/storage/app_paths.rs", ccswitch_db: "features/providers/ccswitch_db.rs",
  claude_hook: "features/hooks/claude.rs", codex_app_server_proxy: "features/codex-proxy/mod.rs",
  codex_statusline: "features/statusline/codex.rs", conpty_sideload: "infrastructure/process/conpty_sideload.rs",
  crash_reporter: "infrastructure/diagnostics/crash_reporter.rs", credential_store: "infrastructure/storage/credential_store.rs",
  file_watcher: "infrastructure/files/file_watcher.rs", git_watcher: "features/git/watcher.rs",
  hook_client: "features/hooks/client.rs", linux_graphics: "infrastructure/system/linux_graphics.rs",
  log_rotation: "infrastructure/diagnostics/log_rotation.rs", process_job: "infrastructure/process/process_job.rs",
  runtime_diagnostics: "infrastructure/diagnostics/runtime.rs", shell_resolver: "infrastructure/process/shell_resolver.rs",
  ssh_agent_supply_chain: "infrastructure/ssh/agent_supply_chain.rs", ssh_askpass: "infrastructure/ssh/askpass.rs",
  ssh_launch: "infrastructure/ssh/launch.rs", ssh_proxy: "infrastructure/ssh/proxy.rs",
  ssh_transport: "infrastructure/ssh/transport.rs", statusline_profiles: "features/statusline/profiles.rs",
  statusline: "features/statusline/mod.rs", text_encoding: "shared/text_encoding.rs",
  usage_schema: "features/stats/usage_schema.rs", usage: "features/stats/usage.rs", wsl: "infrastructure/process/wsl.rs",
};
const rootDirectories = {
  daemon: "infrastructure/daemon", live_server: "features/files/live_server", provider: "features/providers/service",
  pty: "infrastructure/pty", sync: "features/sync/service", third_party_notification: "features/notifications/service",
  webdav: "infrastructure/webdav",
};
const files = execFileSync("git", ["ls-files", "-z", root], { encoding: "utf8" }).split("\0").filter(file => file.endsWith(".rs"));
const map = {}, routes = {};
for (const file of files) {
  const relative = file.slice(root.length);
  if (["lib.rs", "main.rs", "commands/mod.rs"].includes(relative) || relative.startsWith("bin/") || relative.startsWith("app/")) { map[file] = file; continue; }
  const command = relative.startsWith("commands/");
  const local = command ? relative.slice("commands/".length) : relative;
  const name = local.split("/")[0].replace(/\.rs$/, "");
  let destination;
  if (!command && rootDirectories[name]) destination = `${rootDirectories[name]}/${local.slice(name.length + 1)}`;
  else {
    const entry = command ? commands[name] && `features/${commands[name]}` : rootFiles[name];
    assert.ok(entry, `Unclassified Rust owner: ${file}`);
    destination = local.includes("/") ? `${entry.endsWith("/mod.rs") ? path.posix.dirname(entry) : entry.replace(/\.rs$/, "")}/${local.slice(name.length + 1)}` : entry;
  }
  map[file] = `${root}${destination}`;
}
assert.equal(new Set(Object.values(map)).size, files.length, "Rust destination collision");
for (const registry of [`${root}lib.rs`, `${root}commands/mod.rs`]) {
  for (const match of readFileSync(registry, "utf8").matchAll(/^(?:pub(?:\([^)]*\))?\s+)?mod (\w+);/gm)) {
    const base = `${path.posix.dirname(registry)}/${match[1]}`;
    const source = [`${base}.rs`, `${base}/mod.rs`].find(file => map[file]);
    assert.ok(source, `Unresolved registry module ${registry}: ${match[1]}`);
    if (source !== map[source]) routes[`${registry}:${match[1]}`] = { source, target: map[source] };
  }
}
writeFileSync(`${task}/rust-ownership-plan.json`, JSON.stringify({ map, routes }, null, 2) + "\n");
console.log(JSON.stringify({ files: files.length, moves: Object.entries(map).filter(([a,b]) => a !== b).length, facadeRoutes: Object.keys(routes).length }));
