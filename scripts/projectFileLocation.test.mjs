import test from "node:test";
import assert from "node:assert/strict";
import { fileOperationRootKey } from "../src/features/files/lib/fileExplorerOperations.ts";
import { isSameProjectFileLocation, isSameProjectFileContext } from "../src/features/terminal/api/terminalProject.ts";

const project = (path, extra = {}) => ({ id: "synthetic", path, environment_type: "local", ssh_host_id: "", remote_path: "", ...extra });

test("Windows drive roots and ordinary UNC file locations ignore case", () => {
  for (const [left, right] of [["C:\\", "c:/"], ["C:\\Repo\\", "c:/repo"], ["\\\\SERVER\\Share\\Repo", "//server/share/repo/"]]) {
    assert.equal(fileOperationRootKey(left), fileOperationRootKey(right));
    assert.equal(isSameProjectFileLocation(project(left), project(right)), true);
  }
});

test("POSIX and WSL UNC file locations retain Linux path case", () => {
  for (const prefix of ["/home/user/", "//wsl$/Ubuntu/home/user/", "//wsl.localhost/Ubuntu/home/user/"]) {
    const left = project(`${prefix}Repo`, { environment_type: "wsl" });
    const right = project(`${prefix}repo`, { environment_type: "wsl" });
    assert.equal(isSameProjectFileLocation(left, right), false);
    assert.equal(isSameProjectFileContext(left, right), false);
    assert.equal(isSameProjectFileLocation(left, { ...left, path: `${left.path}/` }), true);
  }
});

test("SSH file identity remains host-specific and case-sensitive", () => {
  const left = project("C:/unrelated", { environment_type: "ssh", ssh_host_id: "host-a", remote_path: "/home/Repo/" });
  assert.equal(isSameProjectFileLocation(left, { ...left, path: "D:/other", remote_path: "/home/Repo" }), true);
  assert.equal(isSameProjectFileLocation(left, { ...left, remote_path: "/home/repo" }), false);
  assert.equal(isSameProjectFileLocation(left, { ...left, ssh_host_id: "host-b" }), false);
  assert.equal(isSameProjectFileLocation(left, project(left.path)), false);
  assert.equal(isSameProjectFileContext(left, { ...left, id: "another" }), false);
});
