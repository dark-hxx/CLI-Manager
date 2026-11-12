import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { logWarn } from "../../../shared/platform/logger";

const APP_MEMORY_POLL_INTERVAL_MS = 5000;
/** 两次优化之间的冷却时间：修剪后的页面会被逐步换回，过于频繁的优化只会增加缺页开销。 */
export const APP_MEMORY_OPTIMIZE_COOLDOWN_MS = 30_000;

export interface AppMemoryGroup {
  bytes: number;
  processCount: number;
}

export interface AppMemoryUsage {
  /** 主进程 + WebView2 + daemon 合计，不含终端子进程。 */
  totalBytes: number;
  main: AppMemoryGroup;
  webview: AppMemoryGroup;
  daemon: AppMemoryGroup;
  terminal: AppMemoryGroup;
  /** 可清理的孤儿进程（含后代），不计入合计，优化时一并结束。 */
  orphan: AppMemoryGroup;
  privateWorkingSet: boolean;
  sampledAt: number;
}

export interface AppMemoryOptimizeResult {
  before: AppMemoryUsage;
  after: AppMemoryUsage;
  freedBytes: number;
  webviewHintCount: number;
  trimmedProcessCount: number;
  orphanKilledCount: number;
  orphanFreedBytes: number;
}

export interface AppMemoryLastOptimization {
  freedBytes: number;
  beforeBytes: number;
  afterBytes: number;
  orphanKilledCount: number;
  finishedAt: number;
}

/** 应用自身内存占用：可见时按固定间隔轮询；优化完成后直接采用优化后的读数。 */
export function useAppMemory(enabled: boolean) {
  const [usage, setUsage] = useState<AppMemoryUsage | null>(null);
  const [optimizing, setOptimizing] = useState(false);
  const [lastOptimization, setLastOptimization] = useState<AppMemoryLastOptimization | null>(null);
  const inFlightRef = useRef(false);
  const optimizingRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const load = async () => {
      // 优化进行中的读数会被优化结果覆盖，跳过避免数值来回跳。
      if (inFlightRef.current || optimizingRef.current) return;
      inFlightRef.current = true;
      try {
        const result = await invoke<AppMemoryUsage>("app_memory_get_usage");
        if (!cancelled && !optimizingRef.current) setUsage(result);
      } catch (error) {
        logWarn(`[terminal-status-bar] load app memory failed: ${String(error)}`);
      } finally {
        inFlightRef.current = false;
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), APP_MEMORY_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled]);

  const optimize = useCallback(async (): Promise<AppMemoryOptimizeResult> => {
    optimizingRef.current = true;
    setOptimizing(true);
    try {
      const result = await invoke<AppMemoryOptimizeResult>("app_memory_optimize");
      setUsage(result.after);
      setLastOptimization({
        freedBytes: result.freedBytes,
        beforeBytes: result.before.totalBytes,
        afterBytes: result.after.totalBytes,
        orphanKilledCount: result.orphanKilledCount,
        finishedAt: Date.now(),
      });
      return result;
    } finally {
      optimizingRef.current = false;
      setOptimizing(false);
    }
  }, []);

  return { usage, optimizing, lastOptimization, optimize };
}
