import { buildGitChangeTrees } from "./gitTreeModel";
import type { GitFileChange } from "../../../shared/types/index";
import type { GitStatusFilter, GitTreeGrouping } from "./gitTreeModel";

// 单次 Worker 只处理一次构造，完成后由调用方终止并释放快照。
self.onmessage = (event: MessageEvent<{ changes: GitFileChange[]; filter: GitStatusFilter; groupBy: GitTreeGrouping }>) => {
  const { changes, filter, groupBy } = event.data;
  const builder = buildGitChangeTrees(changes, filter, groupBy);
  let result = builder.next();
  while (!result.done) result = builder.next();
  self.postMessage(result.value);
};
