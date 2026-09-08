import { useTerminalStore } from "../state";
import { useSessionStore } from "./sessionStore";
import { logError } from "../../../shared/platform/logger";

/**
 * 工作区终端 scrollback 的定时节流落盘。
 *
 * 为什么存在：`updateSessionTerminalSnapshot` 只在终端 dispose 时被调用，且只更内存
 * 不落盘（要等下一次 saveSessions）。崩溃 / 强杀时既不触发 dispose 也不触发正常关闭保存，
 * 快照就丢了。这里用一个 10s 定时器周期性把各活跃终端的当前画面序列化后落盘，
 * 把崩溃丢失窗口压到一个节流间隔以内。
 *
 * 设计要点（对应 PRD R2）：
 * - 脏检测：终端自上次落盘无新 PTY 输出则跳过序列化（serialize 不便宜）。
 * - 尾部限行：单终端只保留最后 SNAPSHOT_MAX_LINES 行，避免快照文件无限膨胀。
 * - 空转防护：仅当存在已注册的真实终端时才让定时器工作。
 */

const SNAPSHOT_THROTTLE_MS = 10_000;
// 单终端持久化的 scrollback 尾部行数上限（约 2000 行，符合"恢复最近画面"语义）。
const SNAPSHOT_MAX_LINES = 2000;

interface SnapshotSource {
  /** 返回当前终端画面的完整序列化文本（含 scrollback）。 */
  serialize: () => string | Promise<string>;
  checkpoint?: (serialized: string) => Promise<void>;
  /** 自上次落盘后是否收到过新 PTY 输出。 */
  dirty: boolean;
}

const sources = new Map<string, SnapshotSource>();
let timer: ReturnType<typeof setInterval> | null = null;

/** 只保留文本尾部最多 maxLines 行，避免快照无限增长。 */
function trimToTailLines(text: string, maxLines: number): string {
  if (!text) return text;
  let count = 0;
  // 从尾部往前数换行符，找到第 maxLines 个换行的位置后截断，避免 split 整段大文本。
  for (let i = text.length - 1; i >= 0; i--) {
    if (text.charCodeAt(i) === 10 /* \n */) {
      count++;
      if (count >= maxLines) {
        return text.slice(i + 1);
      }
    }
  }
  return text;
}

/**
 * 注册一个终端的快照来源。XTermTerminal 挂载时调用，dispose 时须调用返回的注销函数。
 * 注册后若定时器未运行则启动它。
 */
export function registerTerminalSnapshotSource(
  sessionId: string,
  serialize: () => string | Promise<string>,
  checkpoint?: (serialized: string) => Promise<void>,
): () => void {
  sources.set(sessionId, { serialize, checkpoint, dirty: false });
  ensureTimerRunning();
  return () => {
    sources.delete(sessionId);
    if (sources.size === 0) stopTimer();
  };
}

/** 标记某终端收到新输出（脏）。在 PTY 输出到达时调用，成本仅一次 Map 查找。 */
export function markTerminalSnapshotDirty(sessionId: string): void {
  const source = sources.get(sessionId);
  if (source) source.dirty = true;
}

function ensureTimerRunning(): void {
  if (timer !== null) return;
  if (sources.size === 0) return;
  timer = setInterval(() => {
    void flushDirtySnapshots();
  }, SNAPSHOT_THROTTLE_MS);
}

function stopTimer(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

/** 序列化所有脏终端、尾部限行、写回内存，然后统一落盘一次。 */
async function flushDirtySnapshots(): Promise<void> {
  await flushSnapshots(false);
}

/**
 * 退出前的强制落盘：忽略脏标记，序列化全部已注册终端后落盘。
 * 正常退出时组件尚未卸载（窗口 destroy 前不触发 React 卸载），此处能拿到关闭前的
 * 最终画面，让恢复精确对齐"关闭前"而非最多落后一个节流间隔的旧快照。
 */
export async function flushTerminalSnapshotsNow(): Promise<void> {
  await flushSnapshots(true);
}

/**
 * @param force true 时忽略 dirty 序列化全部来源（退出用）；false 时只序列化脏来源（节流用）。
 */
async function flushSnapshots(force: boolean): Promise<void> {
  const store = useTerminalStore.getState();
  let anyUpdated = false;

  for (const [sessionId, source] of sources) {
    if (!force && !source.dirty) continue;
    source.dirty = false;
    try {
      const serialized = await source.serialize();
      if (source.checkpoint) {
        try {
          await source.checkpoint(serialized);
        } catch (err) {
          source.dirty = true;
          logError("Failed to upload terminal checkpoint", { sessionId, err });
        }
      }
      const snapshot = trimToTailLines(serialized, SNAPSHOT_MAX_LINES);
      store.updateSessionTerminalSnapshot(sessionId, snapshot);
      anyUpdated = true;
    } catch (err) {
      // 单个终端序列化失败不应拖垮整轮落盘；标回脏，下轮重试。
      source.dirty = true;
      logError("Failed to serialize terminal snapshot for throttled persistence", { sessionId, err });
    }
  }

  if (!anyUpdated) return;

  try {
    // updateSessionTerminalSnapshot 只改内存，这里统一把最新 sessions 落盘。
    await useSessionStore.getState().saveSessions(useTerminalStore.getState().sessions);
  } catch (err) {
    logError("Failed to persist throttled terminal snapshots", { err });
  }
}
