import test from "node:test";
import assert from "node:assert/strict";
import { createLocalGitTransportContextKey } from "../src/lib/gitTransportIdentity.ts";
import { GitTransportLeaseRegistry } from "../src/lib/gitTransportLeaseRegistry.ts";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("local transport identity preserves case-sensitive paths and separates WSL", () => {
  const contextKey = (path, environmentType = "local") => createLocalGitTransportContextKey({
    id: "project-1",
    path,
    environment_type: environmentType,
  });

  assert.equal(contextKey("C:\\Repo"), contextKey("c:/repo/"));
  assert.equal(contextKey("C:\\"), contextKey("c:/"));
  assert.notEqual(contextKey("/Work/Repo"), contextKey("/work/repo"));
  assert.notEqual(contextKey("//wsl.localhost/Ubuntu/home/User", "wsl"), contextKey("//wsl.localhost/Ubuntu/home/user", "wsl"));
  assert.notEqual(contextKey("C:\\Repo"), contextKey("C:\\Repo", "wsl"));
});

test("concurrent consumers share one transport until the last release", async () => {
  const registry = new GitTransportLeaseRegistry();
  const ready = deferred();
  let createCount = 0;
  let disposeCount = 0;
  const create = async () => {
    createCount += 1;
    await ready.promise;
    return {
      value: { id: "shared" },
      dispose: async () => { disposeCount += 1; },
    };
  };

  const firstPromise = registry.acquire("context", create);
  const secondPromise = registry.acquire("context", create);
  await Promise.resolve();
  assert.equal(createCount, 1);
  ready.resolve();
  const [first, second] = await Promise.all([firstPromise, secondPromise]);
  assert.equal(first.value, second.value);

  await first.release();
  assert.equal(disposeCount, 0);
  await first.release();
  assert.equal(disposeCount, 0);
  await second.release();
  assert.equal(disposeCount, 1);
});

test("a new acquire waits for the previous context release", async () => {
  const registry = new GitTransportLeaseRegistry();
  const releaseGate = deferred();
  let generation = 0;
  const first = await registry.acquire("context", async () => ({
    value: { generation: ++generation },
    dispose: async () => { await releaseGate.promise; },
  }));

  const releasePromise = first.release();
  let secondCreated = false;
  const secondPromise = registry.acquire("context", async () => {
    secondCreated = true;
    return {
      value: { generation: ++generation },
      dispose: async () => undefined,
    };
  });
  await Promise.resolve();
  assert.equal(secondCreated, false);

  releaseGate.resolve();
  await releasePromise;
  const second = await secondPromise;
  assert.equal(secondCreated, true);
  assert.equal(second.value.generation, 2);
  await second.release();
});
