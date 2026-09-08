import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

// 读取并转译独立 TypeScript 模块，通过数据 URL 导入测试。
async function importTypeScript(path) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

const { createLocalGitTransportContextKey } = await importTypeScript("../src/features/git/lib/gitTransportIdentity.ts");
const { GitTransportLeaseRegistry } = await importTypeScript("../src/features/git/lib/gitTransportLeaseRegistry.ts");

// 创建可由测试手动放行的 Promise。
function deferred() {
  let resolve;
  // 保留 Promise 的完成入口供后续解除等待。
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// 验证本地路径身份按平台区分大小写及 WSL 环境。
test("local transport identity preserves case-sensitive paths and separates WSL", () => {
  // 为指定路径和环境构造本地 Git 传输身份。
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

// 验证并发消费者复用传输，仅最后一次释放执行清理。
test("concurrent consumers share one transport until the last release", async () => {
  const registry = new GitTransportLeaseRegistry();
  const ready = deferred();
  let createCount = 0;
  let disposeCount = 0;
  // 等待测试放行后创建传输替身并累计创建次数。
  const create = async () => {
    createCount += 1;
    await ready.promise;
    return {
      value: { id: "shared" },
      // 累计传输替身的释放次数。
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

// 验证上一代传输释放完成前不会创建下一代。
test("a new acquire waits for the previous context release", async () => {
  const registry = new GitTransportLeaseRegistry();
  const releaseGate = deferred();
  let generation = 0;
  // 构造第一代传输并为其设置延迟释放入口。
  const first = await registry.acquire("context", async () => ({
    value: { generation: ++generation },
    // 等待测试主动放行释放过程。
    dispose: async () => { await releaseGate.promise; },
  }));

  const releasePromise = first.release();
  let secondCreated = false;
  // 标记第二代传输已创建并增加代数。
  const secondPromise = registry.acquire("context", async () => {
    secondCreated = true;
    return {
      value: { generation: ++generation },
      // 提供无需清理资源的异步释放占位入口。
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
