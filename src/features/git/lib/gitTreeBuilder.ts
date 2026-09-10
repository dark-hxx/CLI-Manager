import { buildGitChangeTrees } from "./gitTreeModel";
import type { GitChangeTrees, GitStatusFilter, GitTreeGrouping } from "./gitTreeModel";
import type { GitFileChange } from "../../../shared/types/index";

export const GIT_TREE_WORKER_THRESHOLD = 5000;

// Worker 失败后继续执行同一生成器；每批给输入/绘制一个调度机会，取消不进入 fallback。
export async function buildGitTreesInBatches(
  changes: GitFileChange[], filter: GitStatusFilter, groupBy: GitTreeGrouping, signal: AbortSignal,
): Promise<GitChangeTrees> {
  const builder = buildGitChangeTrees(changes, filter, groupBy);
  for (;;) {
    signal.throwIfAborted();
    const result = builder.next();
    if (result.done) return result.value;
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
}

// 限制 Worker 生命周期；消息解码失败、构造失败和超时均终止后转分批构造。
export async function buildGitTreesAsync(
  changes: GitFileChange[], filter: GitStatusFilter, groupBy: GitTreeGrouping, signal: AbortSignal,
): Promise<GitChangeTrees> {
  signal.throwIfAborted();
  if (changes.length <= GIT_TREE_WORKER_THRESHOLD) {
    const builder = buildGitChangeTrees(changes, filter, groupBy);
    let result = builder.next();
    while (!result.done) result = builder.next();
    return result.value;
  }
  try {
    return await new Promise<GitChangeTrees>((resolve, reject) => {
      const worker = new Worker(new URL("./gitTreeBuilder.worker.ts", import.meta.url), { type: "module" });
      let settled = false;
      const finish = (result?: GitChangeTrees, error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        worker.terminate();
        if (result) resolve(result); else reject(error);
      };
      const abort = () => finish(undefined, signal.reason);
      const timer = setTimeout(() => finish(undefined, new Error("git_tree_worker_timeout")), 15000);
      signal.addEventListener("abort", abort, { once: true });
      worker.onmessage = (event: MessageEvent<GitChangeTrees>) => finish(event.data);
      worker.onerror = () => finish(undefined, new Error("git_tree_worker_failed"));
      worker.onmessageerror = () => finish(undefined, new Error("git_tree_worker_message_failed"));
      try { worker.postMessage({ changes, filter, groupBy }); } catch (error) { finish(undefined, error); }
    });
  } catch {
    signal.throwIfAborted();
    return buildGitTreesInBatches(changes, filter, groupBy, signal);
  }
}
