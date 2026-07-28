import test from "node:test";
import assert from "node:assert/strict";
import {
  createGitDiffTabId,
  createGitDiffWorkspaceContext,
  useGitDiffWorkspaceStore,
} from "../src/stores/gitDiffWorkspaceStore.ts";

const project = (overrides = {}) => ({
  id: "project-1",
  name: "Project",
  path: "C:\\Repo",
  group_name: "",
  group_id: null,
  sort_order: 0,
  cli_tool: "codex",
  cli_args: "",
  startup_cmd: "",
  env_vars: "",
  shell: "powershell",
  provider_overrides: "{}",
  worktree_strategy: "none",
  worktree_root: "",
  worktree_deps_prompt_enabled: 0,
  environment_type: "local",
  ssh_host_id: null,
  remote_path: "",
  cli_config_root: "",
  created_at: "",
  updated_at: "",
  ...overrides,
});

const tab = (overrides = {}) => ({
  repositoryId: "C:\\Repo",
  repositoryRelativePath: "",
  filePath: "src/a.ts",
  sourcePath: "src/a.ts",
  fileName: "a.ts",
  status: "M",
  additions: 2,
  deletions: 1,
  ...overrides,
});

test("workspace identity isolates project paths and preserves POSIX case", () => {
  const windows = createGitDiffWorkspaceContext(project());
  const sameWindows = createGitDiffWorkspaceContext(project({ path: "c:/repo/" }));
  const worktree = createGitDiffWorkspaceContext(project({ path: "C:\\Repo-worktree" }));
  const windowsRoot = createGitDiffWorkspaceContext(project({ path: "C:\\" }));
  const sameWindowsRoot = createGitDiffWorkspaceContext(project({ path: "c:/" }));
  const posixUpper = createGitDiffWorkspaceContext(project({ path: "/Work/Repo" }));
  const posixLower = createGitDiffWorkspaceContext(project({ path: "/work/repo" }));

  assert.equal(windows.key, sameWindows.key);
  assert.notEqual(windows.key, worktree.key);
  assert.equal(windowsRoot.key, sameWindowsRoot.key);
  assert.notEqual(posixUpper.key, posixLower.key);
});

test("root and nested repositories keep distinct tab identities", () => {
  const context = createGitDiffWorkspaceContext(project({
    environment_type: "ssh",
    ssh_host_id: "host-1",
    remote_path: "/srv/repo",
  }));
  assert.notEqual(
    createGitDiffTabId(context.key, "", "src/a.ts"),
    createGitDiffTabId(context.key, "packages/nested", "src/a.ts"),
  );
});

test("opening the same target activates and updates one tab", () => {
  const store = useGitDiffWorkspaceStore.getState();
  const context = createGitDiffWorkspaceContext(project());
  store.clearWorkspace(context.key);
  const firstId = store.openTab(context, tab());
  const secondId = store.openTab(context, tab({ additions: 9 }));
  const workspace = useGitDiffWorkspaceStore.getState().workspaces[context.key];

  assert.equal(firstId, secondId);
  assert.equal(workspace.tabs.length, 1);
  assert.equal(workspace.tabs[0].additions, 9);
  assert.equal(workspace.activeId, firstId);
  store.clearWorkspace(context.key);
});
