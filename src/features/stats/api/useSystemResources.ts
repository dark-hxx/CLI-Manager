import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface SystemResourceSnapshot {
  ipAddress: string | null;
  osName: string;
  hostName: string | null;
  uptimeSeconds: number;
  sampledAt: number;
  cpu: {
    usagePercent: number;
    physicalCoreCount: number;
    logicalProcessorCount: number;
  };
  cpuCores: Array<{
    index: number;
    usagePercent: number;
  }>;
  gpu: {
    usagePercent: number;
  } | null;
  memory: {
    totalBytes: number;
    usedBytes: number;
    availableBytes: number;
    cachedBytes: number;
    freeBytes: number;
  };
  network: {
    uploadBytesPerSec: number;
    downloadBytesPerSec: number;
    totalUploadedBytes: number;
    totalDownloadedBytes: number;
    todayUploadedBytes: number;
    todayDownloadedBytes: number;
  };
  disks: Array<{
    name: string;
    mountPoint: string;
    fileSystem: string;
    totalBytes: number;
    availableBytes: number;
    usedBytes: number;
    readBytesPerSec: number;
    writeBytesPerSec: number;
  }>;
  topProcesses: Array<{
    pid: string;
    name: string;
    command: string;
    displayName: string | null;
    iconDataUrl: string | null;
    cpuUsagePercent: number;
    memoryBytes: number;
    memoryUsagePercent: number;
  }>;
}

export interface SystemResourceSnapshotOptions {
  fullDetail?: boolean;
  system?: boolean;
  cpu?: boolean;
  memory?: boolean;
  network?: boolean;
  disk?: boolean;
  gpu?: boolean;
  processes?: boolean;
}

function defaultIntervalMs(options: boolean | SystemResourceSnapshotOptions): number {
  return typeof options === "boolean" && !options ? 3000 : 2500;
}

interface SystemResourceRuntimeCacheEntry {
  snapshot: SystemResourceSnapshot | null;
  history: SystemResourceSnapshot[];
}

const SYSTEM_RESOURCE_HISTORY_LIMIT = 48;
const systemResourceRuntimeCache = new Map<string, SystemResourceRuntimeCacheEntry>();

function appendHistory(
  history: SystemResourceSnapshot[],
  snapshot: SystemResourceSnapshot
): SystemResourceSnapshot[] {
  const next = [...history, snapshot];
  if (next.length <= SYSTEM_RESOURCE_HISTORY_LIMIT) return next;
  return next.slice(next.length - SYSTEM_RESOURCE_HISTORY_LIMIT);
}

export function useSystemResources(
  enabled: boolean,
  options: boolean | SystemResourceSnapshotOptions,
  intervalMs = defaultIntervalMs(options),
  runtimeCacheKey?: string
) {
  const cached = runtimeCacheKey ? systemResourceRuntimeCache.get(runtimeCacheKey) : undefined;
  const [snapshot, setSnapshot] = useState<SystemResourceSnapshot | null>(() => cached?.snapshot ?? null);
  const [history, setHistory] = useState<SystemResourceSnapshot[]>(() => cached?.history ?? []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);
  const historyRef = useRef(history);

  const refresh = useCallback(async (showLoading = false) => {
    if (!enabled || inFlightRef.current) return;
    inFlightRef.current = true;
    if (showLoading) setLoading(true);
    try {
      const payload = typeof options === "boolean" ? { fullDetail: options } : { options };
      const result = await invoke<SystemResourceSnapshot>("system_resources_get_snapshot", payload);
      const nextHistory = appendHistory(historyRef.current, result);
      historyRef.current = nextHistory;
      if (runtimeCacheKey) {
        systemResourceRuntimeCache.set(runtimeCacheKey, { snapshot: result, history: nextHistory });
      }
      setSnapshot(result);
      setHistory(nextHistory);
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      inFlightRef.current = false;
      if (showLoading) setLoading(false);
    }
  }, [enabled, options, runtimeCacheKey]);

  useEffect(() => {
    if (!enabled) {
      // 面板切走时只停止轮询，保留 snapshot/history，切回后继续追加
      setLoading(false);
      setError(null);
      return;
    }

    void refresh(true);
    const timer = window.setInterval(() => {
      void refresh(false);
    }, intervalMs);

    return () => window.clearInterval(timer);
  }, [enabled, intervalMs, refresh]);

  return { snapshot, history, loading, error, refresh };
}
