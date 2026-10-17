import { invoke } from "@tauri-apps/api/core";
import { fetchBoundSessionSummary } from "../../history/index";
import { getHistoryPathArgs } from "../../history/api/historyPathArgs";
import { normalizeProjectPath } from "../api/terminalProject";
import { getProviderSwitchAppType } from "../../providers/api/providerSwitching";
import type { Project, TerminalSession } from "../../../shared/types/index";

/**
 * Web 對話頁的結構化轉錄（`terminal.transcript_events`）。
 *
 * 只讀已精確綁定的 CLI 會話紀錄：PTY、CLI 會話 ID、來源與 cwd 都要對上，不以同目錄或時間相近的
 * 紀錄代替。檔案路徑每個綁定只向歷史索引查一次並快取；之後依瀏覽器帶來的位元組游標增量讀取，
 * 由 Rust 的 transcript-core 解析成對話事件，不再每次整份重解析。
 */
export const TRANSCRIPT_EVENTS_KIND = "terminal.transcript_events";

/** 位元組位置上限（1 TiB），與伺服器端驗證一致。 */
const MAX_OFFSET = 2 ** 40;
/** 單次結果上限，低於橋接層 700 KiB 的總上限，留餘裕給外層欄位。 */
const MAX_RESULT_BYTES = 650 * 1024;
/** 找不到紀錄檔時，同一個綁定至少隔這麼久才再刷新索引，避免輪詢反覆掃描歷史目錄。 */
const MISS_RETRY_MS = 5_000;
/** 路徑快取的上限；超過時丟掉最早加入的綁定。 */
const MAX_CACHED_FILES = 64;

type Payload = Record<string, unknown>;
type TranscriptSource = "claude" | "codex";

export type TranscriptSession = { project: Project; rootPath: string; session: TerminalSession };

type TranscriptFile = {
  filePath: string;
  source: TranscriptSource;
  projectKey: string;
  cwd: string | null;
};

/** 與 transcript-core 的 `Transcript` 相同的欄位；事件內容原樣轉交瀏覽器。 */
export type TranscriptEventsResult = {
  parser?: number;
  available: boolean;
  reason?: string;
  agentSessionId?: string;
  start: number;
  cursor: number;
  size: number;
  reset?: boolean;
  more: boolean;
  events: unknown[];
};

/**
 * 找不到紀錄檔的兩種情況：`pending` 是索引裡還沒有（新會話尚未寫出第一行），前端當成空白的新對話；
 * `mismatch` 是找到了但來源或 cwd 對不上，前端提示暫時讀不到。
 */
type Miss = { until: number; kind: "pending" | "mismatch" };

const files = new Map<string, TranscriptFile>();
const misses = new Map<string, Miss>();

function transcriptError(code: string, message = code): never {
  throw { code, message };
}

function unavailable(reason: string, agentSessionId?: string): TranscriptEventsResult {
  return {
    available: false,
    reason,
    ...(agentSessionId ? { agentSessionId } : {}),
    start: 0,
    cursor: 0,
    size: 0,
    more: false,
    events: [],
  };
}

/** 讀取範圍：不帶游標取最新一段，`cursor` 為增量，`before` 為更早的一頁；兩者不可同時出現。 */
export function transcriptWindow(payload: Payload): { cursor?: number; before?: number } {
  const offset = (key: "cursor" | "before") => {
    const value = payload[key];
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_OFFSET) {
      transcriptError("invalid_operation_payload", "invalid transcript cursor");
    }
    return value;
  };
  const cursor = offset("cursor");
  const before = offset("before");
  if (cursor !== undefined && before !== undefined) {
    transcriptError("invalid_operation_payload", "invalid transcript cursor");
  }
  return { ...(cursor !== undefined ? { cursor } : {}), ...(before !== undefined ? { before } : {}) };
}

function sessionSource(resolved: TranscriptSession): string | null {
  return resolved.session.cliTool ?? getProviderSwitchAppType(resolved.project);
}

function cacheKey(ptySessionId: string, cliSessionId: string): string {
  return `${ptySessionId}\n${cliSessionId}`;
}

/** 找出綁定會話的紀錄檔；找不到時回傳原因，並在退避期間內不再刷新索引。 */
async function transcriptFile(
  ptySessionId: string,
  cliSessionId: string,
  source: TranscriptSource,
  rootPath: string,
): Promise<TranscriptFile | Miss["kind"]> {
  const key = cacheKey(ptySessionId, cliSessionId);
  const cached = files.get(key);
  // 快取也要對上目前的來源與專案根目錄：專案路徑被改過時，舊路徑的紀錄不能再用。
  if (cached?.source === source && normalizeProjectPath(cached.cwd ?? "") === normalizeProjectPath(rootPath)) return cached;
  if (cached) files.delete(key);
  const miss = misses.get(key);
  if (miss && miss.until > Date.now()) return miss.kind;
  let summary: Awaited<ReturnType<typeof fetchBoundSessionSummary>>;
  try {
    summary = await fetchBoundSessionSummary(rootPath, source, cliSessionId, {
      forceCatalogRefresh: true,
      waitForCatalogRefresh: true,
    });
  } catch (error) {
    // 查詢本身失敗（不是查不到）：回報失敗，前端保留手上的內容並重試，不當成還沒寫出的新對話。
    transcriptError("transcript_lookup_failed", String(error));
  }
  if (!summary
    || summary.session_id !== cliSessionId
    || summary.source !== source
    || normalizeProjectPath(summary.cwd ?? "") !== normalizeProjectPath(rootPath)) {
    const kind = summary ? "mismatch" : "pending";
    // 退避從查詢結束才開始算：刷新索引可能就要好幾秒，否則一查完就過期、每次輪詢都重刷。
    misses.set(key, { until: Date.now() + MISS_RETRY_MS, kind });
    return kind;
  }
  const file: TranscriptFile = {
    filePath: summary.file_path,
    source,
    projectKey: summary.project_key,
    cwd: summary.cwd ?? null,
  };
  misses.delete(key);
  files.set(key, file);
  while (files.size > MAX_CACHED_FILES) {
    const oldest = files.keys().next().value;
    if (oldest === undefined) break;
    files.delete(oldest);
  }
  return file;
}

function bounded(result: TranscriptEventsResult): TranscriptEventsResult {
  const bytes = new TextEncoder().encode(JSON.stringify(result)).byteLength;
  if (bytes > MAX_RESULT_BYTES) transcriptError("transcript_too_large", "transcript page is too large");
  return result;
}

/**
 * 執行一次讀取。`resolveSession` 由呼叫端提供（驗證專案、Worktree 與 PTY 的註冊上下文），
 * 讀檔前後各驗一次：讀檔期間會話可能已關閉或換了綁定，這時不發布內容。
 */
export async function executeTranscriptEvents(
  payload: Payload,
  resolveSession: (payload: Payload) => Promise<TranscriptSession>,
): Promise<TranscriptEventsResult> {
  const window = transcriptWindow(payload);
  const resolved = await resolveSession(payload);
  const cliSessionId = resolved.session.cliSessionId?.trim();
  if (!cliSessionId) return unavailable("unbound");
  const source = sessionSource(resolved);
  if (source !== "claude" && source !== "codex") return unavailable("unsupported", cliSessionId);
  const file = await transcriptFile(resolved.session.id, cliSessionId, source, resolved.rootPath);
  if (file === "pending") return unavailable("missing", cliSessionId);
  if (file === "mismatch") return unavailable("missing");

  let page: TranscriptEventsResult;
  try {
    page = await invoke<TranscriptEventsResult>("history_live_transcript_read", {
      request: {
        filePath: file.filePath,
        source,
        projectKey: file.projectKey,
        agentSessionId: cliSessionId,
        cwd: file.cwd,
        ...window,
        ...(await getHistoryPathArgs()),
      },
    });
  } catch (error) {
    // 檔案被移動或刪除時，下次重新向索引查路徑。
    files.delete(cacheKey(resolved.session.id, cliSessionId));
    transcriptError("transcript_read_failed", String(error));
  }
  if (!page.available) files.delete(cacheKey(resolved.session.id, cliSessionId));

  const current = await resolveSession(payload);
  const currentId = current.session.cliSessionId?.trim();
  if (currentId !== cliSessionId
    || sessionSource(current) !== source
    || normalizeProjectPath(current.rootPath) !== normalizeProjectPath(resolved.rootPath)) {
    return unavailable(currentId ? "missing" : "unbound", currentId);
  }
  return bounded(page);
}
