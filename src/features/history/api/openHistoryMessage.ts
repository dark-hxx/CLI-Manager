import type { HistorySessionSummary } from "../../../shared/types/index";
import { summarySessionKey } from "../lib/historyNormalization";
import { useHistoryStore } from "../store/historyStore";

export interface HistoryMessageTarget {
  session: HistorySessionSummary;
  messageIndex: number;
  projectPath: string | null;
  projectId: string | null;
}

const MAX_SESSION_LIST_PAGES = 6;

// 会话列表分页加载，目标不在已加载页时继续翻页；列表不再增长即停止。
async function ensureSessionListed(sessionKey: string): Promise<boolean> {
  const store = useHistoryStore.getState;
  for (let page = 0; page <= MAX_SESSION_LIST_PAGES; page += 1) {
    if (store().sessions.some((item) => item.sessionKey === sessionKey)) return true;
    if (page === MAX_SESSION_LIST_PAGES || !store().hasMoreSessions) return false;
    const before = store().sessions.length;
    await store().loadMoreSessions();
    if (store().sessions.length === before) return false;
  }
  return false;
}

// 打开历史工作区并定位到会话的指定消息。会话可能不在项目过滤范围内（cwd 与 project_key 口径不同），
// 本地会话再退回到全部项目查找；远程会话依赖项目上下文，不做退回。
export async function openHistoryMessage(target: HistoryMessageTarget): Promise<boolean> {
  const store = useHistoryStore.getState;
  const sessionKey = summarySessionKey(target.session);
  const currentSourceFilter = store().sourceFilter;
  const sourceFilter = currentSourceFilter === "all" || currentSourceFilter === target.session.source
    ? currentSourceFilter
    : target.session.source;
  const remote = target.session.session_ref?.transportKind === "ssh";
  const scopes = remote || (!target.projectPath && !target.projectId)
    ? [{ projectPath: target.projectPath, projectId: target.projectId }]
    : [{ projectPath: target.projectPath, projectId: target.projectId }, { projectPath: null, projectId: null }];

  for (const scope of scopes) {
    await store().openHistory({ sourceFilter, projectPath: scope.projectPath, projectId: scope.projectId });
    if (await ensureSessionListed(sessionKey)) {
      await store().openSessionAtMessage(sessionKey, target.messageIndex);
      return true;
    }
  }
  return false;
}
